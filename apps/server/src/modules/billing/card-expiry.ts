import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';
import { sendSystemEmail, type SystemEmail } from '../core/mail.js';
import type { Subject } from '../catalog/entitlements.js';
import { customerDetails, scopeOfSubject, settingsOf } from './engine.js';

/** A card works through the last day of its expiry month: it stops at the start of the next one. */
export function cardExpiresAt(expMonth: number, expYear: number): Date {
  return new Date(Date.UTC(expYear, expMonth, 1));
}

const BRANDS: Record<string, string> = { amex: 'American Express', diners: 'Diners Club', jcb: 'JCB', mastercard: 'Mastercard', unionpay: 'UnionPay', visa: 'Visa' };

function brandName(brand: string | null): string {
  if (!brand) return 'payment';
  return BRANDS[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}

function listOf(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length <= 1 ? unique[0] ?? 'your subscription' : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** Where billing emails go: the billing profile's address, else the user's, else the organization owner's. */
async function billingEmail(db: Db, subject: Subject): Promise<string | null> {
  const details = await customerDetails(db, subject);
  if (details.email) return details.email as string;
  if (subject.type !== 'organization') return null;
  const owner = await db.maybe<{ email: string }>(sql`
    SELECT u.email FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ${subject.id} AND u.deleted_at IS NULL
  `);
  return owner?.email ?? null;
}

/** Best effort: the warning is recorded and the event emitted even when email is off or the template is missing. */
async function notify(app: App, db: Db, email: SystemEmail): Promise<void> {
  try {
    await db.tx((inner) => sendSystemEmail(app, inner, email));
  } catch (err) {
    app.log.warn({ err, template: email.template }, 'card expiry email could not be queued');
  }
}

const RENEWING = sql`s.collection_method = 'charge_automatically' AND s.status IN ('active', 'trialing', 'past_due') AND NOT s.cancel_at_period_end`;

/**
 * Warn customers whose saved card pays an automatically charged subscription and expires within
 * the configured number of days (billing setting `cardExpiryWarningDays`). Each card expiry is
 * warned about once; a card the gateway reports with a new expiry is watched again.
 */
export async function warnExpiringCards(app: App): Promise<number> {
  const days = settingsOf(app).cardExpiryWarningDays;
  if (!days) return 0;
  const now = app.clock.now();
  const due = await app.db.many<{ id: string }>(sql`
    SELECT pm.id FROM payment_methods pm
    WHERE pm.detached_at IS NULL
      -- When the card stops working (start of the month after its expiry month); CASE keeps bad data out of make_timestamptz.
      AND (CASE WHEN pm.exp_month BETWEEN 1 AND 12 AND pm.exp_year BETWEEN 2000 AND 9999
                THEN make_timestamptz(CASE WHEN pm.exp_month = 12 THEN pm.exp_year + 1 ELSE pm.exp_year END, pm.exp_month % 12 + 1, 1, 0, 0, 0, 'UTC') END)
          BETWEEN ${now} AND ${new Date(now.getTime() + days * DAY)}
      AND pm.expiry_warned_for IS DISTINCT FROM (pm.exp_year::text || '-' || lpad(pm.exp_month::text, 2, '0'))
      AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.payment_method_id = pm.id AND ${RENEWING})
    ORDER BY pm.id LIMIT 1000
  `);
  let warned = 0;
  for (const { id } of due) {
    await app.db.tx(async (tx) => {
      const pm = await tx.maybe<any>(sql`SELECT * FROM payment_methods WHERE id = ${id} FOR UPDATE`);
      if (!pm) return;
      const expiry = `${pm.exp_year}-${String(pm.exp_month).padStart(2, '0')}`;
      if (pm.expiry_warned_for === expiry) return;
      const subs = await tx.many<{ id: string; product_name: string }>(sql`
        SELECT s.id, p.name AS product_name FROM subscriptions s JOIN products p ON p.id = s.product_id
        WHERE s.payment_method_id = ${pm.id} AND ${RENEWING} ORDER BY s.created_at
      `);
      if (!subs.length) return;
      await tx.exec(sql`UPDATE payment_methods SET expiry_warned_for = ${expiry}, expiry_warned_at = ${now} WHERE id = ${pm.id}`);
      const subject: Subject = { type: pm.subject_type, id: pm.subject_id };
      await app.events.emit(tx, 'payment_method.expiring', {
        paymentMethodId: pm.id,
        brand: pm.brand,
        last4: pm.last4,
        expMonth: pm.exp_month,
        expYear: pm.exp_year,
        expiresAt: cardExpiresAt(pm.exp_month, pm.exp_year),
        subscriptionIds: subs.map((s) => s.id),
      }, scopeOfSubject(subject));
      const to = await billingEmail(tx, subject);
      if (to) {
        await notify(app, tx, {
          to,
          template: 'billing.card_expiring',
          category: 'billing',
          userId: subject.type === 'user' ? subject.id : null,
          orgId: subject.type === 'organization' ? subject.id : null,
          data: { brand: brandName(pm.brand), last4: pm.last4 ?? '', expiry: `${String(pm.exp_month).padStart(2, '0')}/${pm.exp_year}`, subscriptions: listOf(subs.map((s) => s.product_name)) },
        });
      }
      warned++;
    });
  }
  return warned;
}
