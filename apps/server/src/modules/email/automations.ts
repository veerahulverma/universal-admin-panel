import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { DomainEvent } from '../../core/events.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';
import { formatMoney } from '../billing/money.js';
import { payToken } from '../billing/checkout.js';
import { couponDiscount, periodAmount, type PriceRow } from '../billing/engine.js';
import type { CouponRow } from '../catalog/coupons.js';
import { recipientForSubject, sendOnce, settingsOf, type QueueResult } from './service.js';
import type { EmailSettings } from './settings.js';

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** Cancel reason billing uses when the last installment of a plan paid in installments has run its course. */
export const INSTALLMENTS_COMPLETED = 'installments_completed';

/**
 * Whether a new user signed up (welcome email, signup autoresponders). Users created by a CSV
 * import never count, so an import cannot mass-mail every row; other sources can be excluded
 * in the email settings (users created from support email are by default).
 */
export function isSignup(app: App, source: string | null | undefined): boolean {
  if (!source) return true;
  return source !== 'import' && !settingsOf(app).signupExcludedSources.includes(source);
}

/** SQL (subscription `s`, price `pr`): an installment plan whose last payment is already billed, so it will not renew. */
export const FINAL_INSTALLMENT_BILLED = sql`(pr.payment_count IS NOT NULL AND s.installments_billed >= pr.payment_count)`;

function appLink(app: App): string {
  const general = app.settings.get<{ appUrl: string }>('general');
  return general.appUrl || app.config.appUrl;
}

/**
 * Abandoned-checkout reminder, sent at most once per checkout (shared by the
 * checkout.expired automation and the marketing module's delayed scan).
 * Marketing category: only people who consented receive it.
 */
export async function sendCheckoutRecovery(db: Db, app: App, checkoutId: string): Promise<QueueResult | null> {
  const chk = await db.maybe<any>(sql`
    SELECT ch.*, p.name AS product_name FROM checkout_sessions ch LEFT JOIN products p ON p.id = ch.product_id WHERE ch.id = ${checkoutId}
  `);
  if (!chk || chk.kind !== 'purchase' || chk.status === 'completed') return null;
  const purchasedSince = await db.maybe(sql`
    SELECT 1 FROM checkout_sessions WHERE subject_type = ${chk.subject_type} AND subject_id = ${chk.subject_id}
      AND product_id = ${chk.product_id} AND status = 'completed' AND created_at >= ${chk.created_at} LIMIT 1
  `);
  if (purchasedSince) return null;
  const recipient = chk.user_id ? await recipientForSubject(db, { type: 'user', id: chk.user_id }) : await recipientForSubject(db, { type: chk.subject_type, id: chk.subject_id });
  if (!recipient) return null;
  const url = settingsOf(app).checkoutRecoveryUrl || appLink(app);
  const result = await sendOnce(db, app, `checkout_recovery:${chk.id}`, {
    to: recipient.email,
    userId: recipient.userId,
    orgId: chk.org_id,
    templateKey: 'checkout.recovery',
    category: 'marketing',
    locale: recipient.locale,
    data: { productName: chk.product_name ?? 'your purchase', amount: chk.total ? formatMoney(chk.total, chk.currency) : '', checkoutUrl: url },
    metadata: { checkoutId: chk.id, automation: 'checkout_recovery' },
  });
  if (result) await db.exec(sql`UPDATE checkout_sessions SET recovery_email_sent_at = ${app.clock.now()} WHERE id = ${chk.id}`);
  return result;
}

function subjectOf(event: DomainEvent): { type: 'user' | 'organization'; id: string } | null {
  const d = event.data as Record<string, any>;
  if (d.subjectType && d.subjectId) return { type: d.subjectType, id: d.subjectId };
  if (event.orgId) return { type: 'organization', id: event.orgId };
  if (event.userId) return { type: 'user', id: event.userId };
  return null;
}

/**
 * Lifecycle emails driven by domain events. Each send is keyed by the event id,
 * so handler retries never duplicate an email; each automation can be switched
 * off in the email settings.
 */
export function registerAutomations(app: App): void {
  const on = (id: string, pattern: string, setting: keyof EmailSettings, fn: (event: DomainEvent, tx: Db) => Promise<unknown>) =>
    app.events.subscribe(
      `email.auto.${id}`,
      pattern,
      async (event) => {
        if (!settingsOf(app)[setting]) return;
        await app.db.tx((tx) => fn(event, tx));
      },
      { module: 'email' },
    );

  on('receipt', 'invoice.paid', 'autoReceipts', async (event, tx) => {
    const inv = await tx.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${event.data.invoiceId}`);
    if (!inv || inv.amount_paid <= 0 || !inv.customer_details?.email) return;
    await sendOnce(tx, app, `${event.id}:billing.receipt`, {
      to: inv.customer_details.email,
      userId: inv.user_id ?? (inv.subject_type === 'user' ? inv.subject_id : null),
      orgId: inv.org_id,
      templateKey: 'billing.receipt',
      data: { number: inv.number, amount: formatMoney(inv.amount_paid, inv.currency), paidAt: day(inv.paid_at) },
      metadata: { invoiceId: inv.id, automation: 'receipt' },
    });
  });

  on('payment-failed', 'invoice.payment_failed', 'autoPaymentFailed', async (event, tx) => {
    const inv = await tx.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${event.data.invoiceId}`);
    if (!inv || !inv.customer_details?.email) return;
    await sendOnce(tx, app, `${event.id}:billing.payment_failed`, {
      to: inv.customer_details.email,
      userId: inv.user_id ?? (inv.subject_type === 'user' ? inv.subject_id : null),
      orgId: inv.org_id,
      templateKey: 'billing.payment_failed',
      data: {
        number: inv.number,
        amount: formatMoney(inv.amount_due - inv.amount_paid, inv.currency),
        payUrl: `${app.config.appUrl}/pay/invoice/${inv.id}?token=${payToken(app, inv.id)}`,
        nextAttemptAt: day(event.data.nextAttemptAt),
        reason: event.data.message ?? '',
      },
      metadata: { invoiceId: inv.id, automation: 'payment_failed' },
    });
  });

  const subscriptionEmail = async (event: DomainEvent, tx: Db, template: string, extra: (sub: any) => Record<string, unknown>) => {
    const sub = await tx.maybe<any>(sql`SELECT s.*, p.name AS product_name FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.id = ${event.data.subscriptionId}`);
    if (!sub) return;
    const recipient = await recipientForSubject(tx, { type: sub.subject_type, id: sub.subject_id });
    if (!recipient) return;
    await sendOnce(tx, app, `${event.id}:${template}`, {
      to: recipient.email,
      userId: recipient.userId,
      orgId: sub.org_id,
      locale: recipient.locale,
      templateKey: template,
      data: { productName: sub.product_name, ...extra(sub) },
      metadata: { subscriptionId: sub.id, automation: template },
    });
  };

  on('trial-ending', 'subscription.trial_will_end', 'autoTrialEnding', (event, tx) =>
    subscriptionEmail(event, tx, 'subscription.trial_will_end', (sub) => ({ trialEnd: day(sub.trial_end) })),
  );
  on('canceled', 'subscription.canceled', 'autoSubscriptionCanceled', async (event, tx) => {
    // The last installment of a plan paid in installments is a completed purchase, not a cancellation.
    if (event.data.reason === INSTALLMENTS_COMPLETED) return;
    await subscriptionEmail(event, tx, 'subscription.canceled', (sub) => ({ endedAt: day(sub.ended_at ?? event.data.endedAt) }));
  });
  // ...but when that plan's access ends with it, customers who chose expiry notices hear about it.
  on('installments-access-ended', 'subscription.installments_completed', 'autoExpiryNotices', async (event, tx) => {
    if (event.data.access !== 'end_access') return;
    await subscriptionEmail(event, tx, 'access.expired', (sub) => ({ endedAt: day(sub.ended_at ?? sub.current_period_end) }));
  });

  const usageEmail = async (event: DomainEvent, tx: Db, template: string) => {
    const subject = subjectOf(event);
    if (!subject) return;
    const recipient = await recipientForSubject(tx, subject);
    if (!recipient) return;
    const d = event.data as Record<string, any>;
    const feature = await tx.maybe<{ name: string }>(sql`SELECT name FROM features WHERE key = ${d.feature ?? ''}`);
    await sendOnce(tx, app, `${event.id}:${template}`, {
      to: recipient.email,
      userId: recipient.userId,
      orgId: subject.type === 'organization' ? subject.id : null,
      locale: recipient.locale,
      templateKey: template,
      data: { featureName: feature?.name ?? d.meter, used: d.used, limit: d.limit, percent: d.percent ?? (d.limit ? Math.floor((d.used / d.limit) * 100) : 100), resetsAt: day(d.periodEnd) },
      metadata: { meter: d.meter, automation: template },
    });
  };
  on('usage-warning', 'usage.limit_warning', 'autoUsageAlerts', (event, tx) => usageEmail(event, tx, 'usage.limit_warning'));
  on('usage-reached', 'usage.limit_reached', 'autoUsageAlerts', (event, tx) => usageEmail(event, tx, 'usage.limit_reached'));

  on('checkout-recovery', 'checkout.expired', 'autoCheckoutRecovery', (event, tx) => sendCheckoutRecovery(tx, app, event.data.checkoutId));

  on('welcome', 'user.created', 'autoWelcome', async (event, tx) => {
    if (!isSignup(app, event.data.source as string | null)) return;
    const user = await tx.maybe<{ email: string; name: string | null; locale: string | null }>(sql`SELECT email, name, locale FROM users WHERE id = ${event.data.userId} AND deleted_at IS NULL`);
    if (!user) return;
    await sendOnce(tx, app, `welcome:${event.data.userId}`, {
      to: user.email,
      userId: event.data.userId,
      locale: user.locale,
      templateKey: 'account.welcome',
      data: { name: user.name ?? '' },
      metadata: { automation: 'welcome' },
    });
  });
}

// ---- Scheduled lifecycle emails -------------------------------------------------------------------

/** Once-key of a time-based notice: the thing it is about plus the date it concerns (as epoch seconds). */
const noticeKey = (kind: string, id: string, at: Date) => `${kind}:${id}:${Math.floor(at.getTime() / 1000)}`;
const noticeKeySql = (kind: string, idColumn: string, atColumn: string) =>
  sql`${`${kind}:`} || ${sql.raw(idColumn)} || ':' || floor(extract(epoch FROM ${sql.raw(atColumn)}))::bigint`;

/**
 * Renewal reminders for paid subscriptions whose next renewal is within the window. Nothing is
 * announced for subscriptions that will not renew: cancelled at period end, or an installment plan
 * whose last payment is already billed.
 */
async function renewalReminders(app: App, days: number): Promise<number> {
  const now = app.clock.now();
  const subs = await app.db.many<any>(sql`
    SELECT s.*, p.name AS product_name FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id
    WHERE s.status = 'active' AND NOT s.cancel_at_period_end AND s.collection_method <> 'complimentary' AND NOT ${FINAL_INSTALLMENT_BILLED}
      AND s.current_period_end > ${now} AND s.current_period_end <= ${new Date(now.getTime() + days * DAY)}
      AND NOT EXISTS (SELECT 1 FROM email_automation_log l WHERE l.key = ${noticeKeySql('renewal_reminder', 's.id', 's.current_period_end')})
    ORDER BY s.current_period_end LIMIT 500
  `);
  let sent = 0;
  for (const sub of subs) {
    const result = await app.db.tx(async (tx) => {
      const recipient = await recipientForSubject(tx, { type: sub.subject_type, id: sub.subject_id });
      if (!recipient) return null;
      const price = await tx.one<PriceRow>(sql`SELECT * FROM prices WHERE id = ${sub.price_id}`);
      const coupon = sub.coupon_id ? await tx.maybe<CouponRow>(sql`SELECT * FROM coupons WHERE id = ${sub.coupon_id}`) : null;
      // Metered prices are billed on usage, so there is no amount to announce.
      let amount = '';
      if (price.pricing_model === 'flat' || price.pricing_model === 'per_seat') {
        const base = periodAmount(price, sub.quantity, sub.intro_cycles_remaining);
        const off = couponDiscount(coupon, base, sub.discount_cycles_remaining);
        amount = formatMoney(base - off - Math.min(Number(sub.renewal_discount ?? 0), base - off), sub.currency);
      }
      return sendOnce(tx, app, noticeKey('renewal_reminder', sub.id, sub.current_period_end), {
        to: recipient.email,
        userId: recipient.userId,
        orgId: sub.org_id,
        locale: recipient.locale,
        templateKey: 'subscription.renewal_reminder',
        data: { productName: sub.product_name, renewsAt: day(sub.current_period_end), amount },
        metadata: { subscriptionId: sub.id, automation: 'renewal_reminder' },
      });
    });
    if (result) sent++;
  }
  return sent;
}

/**
 * "Access ending soon" for subscriptions whose access ends with the current period: cancelled at
 * period end, or an installment plan in its last period whose access does not outlive it.
 */
async function endingSubscriptions(app: App, days: number): Promise<number> {
  const now = app.clock.now();
  const subs = await app.db.many<any>(sql`
    SELECT s.id, s.subject_type, s.subject_id, s.org_id, s.product_id, s.current_period_end, p.name AS product_name
    FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id
    WHERE s.status IN ('active', 'trialing', 'past_due') AND (s.cancel_at_period_end OR (${FINAL_INSTALLMENT_BILLED} AND pr.after_last_payment = 'end_access'))
      AND s.current_period_end > ${now} AND s.current_period_end <= ${new Date(now.getTime() + days * DAY)}
      AND NOT EXISTS (SELECT 1 FROM email_automation_log l WHERE l.key = ${noticeKeySql('access_expiring:subscription', 's.id', 's.current_period_end')})
    ORDER BY s.current_period_end LIMIT 500
  `);
  let sent = 0;
  for (const sub of subs) {
    const result = await app.db.tx(async (tx) => {
      const recipient = await recipientForSubject(tx, { type: sub.subject_type, id: sub.subject_id });
      if (!recipient) return null;
      return sendOnce(tx, app, noticeKey('access_expiring:subscription', sub.id, sub.current_period_end), {
        to: recipient.email,
        userId: recipient.userId,
        orgId: sub.org_id,
        locale: recipient.locale,
        templateKey: 'access.expiring',
        data: { productName: sub.product_name, endsAt: day(sub.current_period_end) },
        metadata: { subscriptionId: sub.id, automation: 'access_expiring' },
      });
    });
    if (result) sent++;
  }
  return sent;
}

/** Whether a subject keeps a product after `at` through another grant or an auto-renewing subscription. */
async function keepsProduct(db: Db, grant: { id: string; subject_type: string; subject_id: string; product_id: string }, at: Date): Promise<boolean> {
  const other = await db.maybe(sql`
    SELECT 1 FROM entitlement_grants g WHERE g.subject_type = ${grant.subject_type} AND g.subject_id = ${grant.subject_id} AND g.product_id = ${grant.product_id}
      AND g.id <> ${grant.id} AND g.revoked_at IS NULL AND g.starts_at <= ${at} AND (g.ends_at IS NULL OR g.ends_at > ${at})
    UNION ALL
    SELECT 1 FROM subscriptions s WHERE s.subject_type = ${grant.subject_type} AND s.subject_id = ${grant.subject_id} AND s.product_id = ${grant.product_id}
      AND s.status IN ('active', 'trialing', 'past_due') AND (NOT s.cancel_at_period_end OR s.current_period_end > ${at})
    LIMIT 1
  `);
  return Boolean(other);
}

/** Time-limited grants (fixed-term purchases, temporary access): a notice before they end and one when they have ended. */
async function grantNotices(app: App, phase: 'expiring' | 'expired', days: number): Promise<number> {
  const now = app.clock.now();
  // Grants that ended up to three days ago still get their notice after an outage of the scheduler.
  const window = phase === 'expiring' ? sql`g.ends_at > ${now} AND g.ends_at <= ${new Date(now.getTime() + days * DAY)}` : sql`g.ends_at <= ${now} AND g.ends_at > ${new Date(now.getTime() - 3 * DAY)}`;
  const kind = phase === 'expiring' ? 'access_expiring:grant' : 'access_expired:grant';
  const grants = await app.db.many<any>(sql`
    SELECT g.id, g.subject_type, g.subject_id, g.product_id, g.ends_at, p.name AS product_name
    FROM entitlement_grants g JOIN products p ON p.id = g.product_id
    WHERE g.revoked_at IS NULL AND g.ends_at IS NOT NULL AND ${window}
      AND NOT EXISTS (SELECT 1 FROM email_automation_log l WHERE l.key = ${noticeKeySql(kind, 'g.id', 'g.ends_at')})
    ORDER BY g.ends_at LIMIT 500
  `);
  let sent = 0;
  for (const grant of grants) {
    const result = await app.db.tx(async (tx) => {
      if (await keepsProduct(tx, grant, grant.ends_at)) return null;
      const recipient = await recipientForSubject(tx, { type: grant.subject_type, id: grant.subject_id });
      if (!recipient) return null;
      return sendOnce(tx, app, noticeKey(kind, grant.id, grant.ends_at), {
        to: recipient.email,
        userId: recipient.userId,
        orgId: grant.subject_type === 'organization' ? grant.subject_id : null,
        locale: recipient.locale,
        templateKey: phase === 'expiring' ? 'access.expiring' : 'access.expired',
        data: phase === 'expiring' ? { productName: grant.product_name, endsAt: day(grant.ends_at) } : { productName: grant.product_name, endedAt: day(grant.ends_at) },
        metadata: { grantId: grant.id, automation: phase === 'expiring' ? 'access_expiring' : 'access_expired' },
      });
    });
    if (result) sent++;
  }
  return sent;
}

/**
 * Hourly run of the time-based lifecycle emails. Each is switched on in the email settings and
 * sent at most once per subscription period or grant. Card expiry warnings are billing's own job
 * (`billing.card_expiry`), so customers are warned once.
 */
export async function runLifecycleEmails(app: App): Promise<{ renewalReminders: number; expiring: number; expired: number }> {
  const s = settingsOf(app);
  const out = { renewalReminders: 0, expiring: 0, expired: 0 };
  if (app.modules.isEnabled('billing')) {
    if (s.autoRenewalReminder) out.renewalReminders = await renewalReminders(app, s.renewalReminderDays);
    if (s.autoExpiryNotices && s.expiryReminderDays > 0) out.expiring += await endingSubscriptions(app, s.expiryReminderDays);
  }
  if (app.modules.isEnabled('catalog') && s.autoExpiryNotices) {
    if (s.expiryReminderDays > 0) out.expiring += await grantNotices(app, 'expiring', s.expiryReminderDays);
    out.expired = await grantNotices(app, 'expired', 0);
  }
  return out;
}
