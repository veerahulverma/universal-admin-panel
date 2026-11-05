import { z } from 'zod';
import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { DAY } from '../../core/clock.js';
import { writeAudit } from '../../core/audit.js';
import { addInterval, computeTax, licensedAmount, monthsIn, unusedValue, usageAmount, type Interval, type PriceLike } from './money.js';
import { discountAmount, redeemCoupon, type CouponRow } from '../catalog/coupons.js';
import { adapterFor, gatewayContext, type GatewayRow } from './gateways/registry.js';
import { resolveEntitlements, type Subject } from '../catalog/entitlements.js';
import { commitSale, releaseSale, reserveSale } from '../catalog/purchases.js';

export const billingSettingsSchema = z.object({
  invoicePrefix: z.string().regex(/^[A-Z0-9-]{1,10}$/),
  creditNotePrefix: z.string().regex(/^[A-Z0-9-]{1,10}$/),
  orderPrefix: z.string().regex(/^[A-Z0-9-]{1,10}$/),
  sellerName: z.string().max(200),
  sellerAddress: z.string().max(1000),
  sellerEmail: z.string().max(200),
  sellerTaxId: z.string().max(50),
  sellerCountry: z.string().max(2),
  taxEnabled: z.boolean(),
  invoiceDueDays: z.number().int().min(0).max(120),
  dunningRetryDays: z.array(z.number().int().min(1).max(60)).max(10),
  dunningFinalAction: z.enum(['cancel', 'unpaid']),
  refundApprovalThreshold: z.number().int().min(0),
  checkoutExpiryHours: z.number().int().min(1).max(720),
  downgradeTiming: z.enum(['period_end', 'immediate']),
  prorate: z.boolean(),
  suspendOnChargeback: z.boolean(),
  trialReminderDays: z.number().int().min(0).max(30),
  baseCurrency: z.string().length(3),
  /** Warn customers this many days before a saved card that pays a subscription expires (0 turns warnings off). */
  cardExpiryWarningDays: z.number().int().min(0).max(90),
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

export const billingDefaults: BillingSettings = {
  invoicePrefix: 'INV',
  creditNotePrefix: 'CN',
  orderPrefix: 'ORD',
  sellerName: '',
  sellerAddress: '',
  sellerEmail: '',
  sellerTaxId: '',
  sellerCountry: '',
  taxEnabled: false,
  invoiceDueDays: 7,
  dunningRetryDays: [1, 3, 5],
  dunningFinalAction: 'cancel',
  refundApprovalThreshold: 50_000,
  checkoutExpiryHours: 24,
  downgradeTiming: 'period_end',
  prorate: true,
  suspendOnChargeback: false,
  trialReminderDays: 3,
  baseCurrency: 'USD',
  cardExpiryWarningDays: 30,
};

export const settingsOf = (app: App) => app.settings.get<BillingSettings>('billing');

export function scopeOfSubject(s: Subject): { userId?: string; orgId?: string } {
  return s.type === 'user' ? { userId: s.id } : { orgId: s.id };
}

/** Gapless, per-year document numbers (INV-2026-000042). Must run inside the creating transaction. */
export async function nextNumber(db: Db, prefix: string, at: Date): Promise<string> {
  const year = at.getUTCFullYear();
  const row = await db.one<{ last_number: number }>(sql`
    INSERT INTO document_sequences (prefix, year, last_number) VALUES (${prefix}, ${year}, 1)
    ON CONFLICT (prefix, year) DO UPDATE SET last_number = document_sequences.last_number + 1 RETURNING last_number
  `);
  return `${prefix}-${year}-${String(row.last_number).padStart(6, '0')}`;
}

// ---- Customers, taxes and balances ---------------------------------------------------

export async function billingProfile(db: Db, subject: Subject): Promise<any | null> {
  return db.maybe(sql`SELECT * FROM billing_profiles WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}`);
}

export async function customerDetails(db: Db, subject: Subject): Promise<Record<string, unknown>> {
  const profile = await billingProfile(db, subject);
  if (subject.type === 'user') {
    const u = await db.maybe<{ email: string; name: string | null }>(sql`SELECT email, name FROM users WHERE id = ${subject.id}`);
    return { name: profile?.name ?? u?.name ?? null, email: profile?.email ?? u?.email ?? null, company: profile?.company ?? null, address: profile?.address ?? {}, taxId: profile?.tax_id ?? null };
  }
  const o = await db.maybe<{ name: string; billing_email: string | null }>(sql`SELECT name, billing_email FROM organizations WHERE id = ${subject.id}`);
  return { name: profile?.name ?? o?.name ?? null, email: profile?.email ?? o?.billing_email ?? null, company: profile?.company ?? o?.name ?? null, address: profile?.address ?? {}, taxId: profile?.tax_id ?? null };
}

export interface TaxDecision {
  rateBps: number;
  name: string | null;
  note: string | null;
}

/**
 * Pick the tax rate for a customer: exempt customers pay none; B2B reverse
 * charge applies when the rate allows it, the buyer has a tax ID and is in a
 * different country than the seller; otherwise the most specific active rate
 * for country (+ region) applies.
 */
export async function taxFor(db: Db, app: App, subject: Subject): Promise<TaxDecision> {
  const s = settingsOf(app);
  if (!s.taxEnabled) return { rateBps: 0, name: null, note: null };
  const profile = await billingProfile(db, subject);
  if (!profile?.country) return { rateBps: 0, name: null, note: null };
  if (profile.tax_exempt) return { rateBps: 0, name: null, note: 'Customer is tax exempt' };
  const rate = await db.maybe<{ name: string; rate_bps: number; reverse_charge_b2b: boolean }>(sql`
    SELECT name, rate_bps, reverse_charge_b2b FROM tax_rates
    WHERE active AND country = ${profile.country} AND (region IS NULL OR region = ${profile.region ?? null})
    ORDER BY region NULLS LAST LIMIT 1
  `);
  if (!rate) return { rateBps: 0, name: null, note: null };
  if (rate.reverse_charge_b2b && profile.tax_id && s.sellerCountry && profile.country !== s.sellerCountry) {
    return { rateBps: 0, name: rate.name, note: 'Reverse charge: VAT to be accounted for by the recipient' };
  }
  return { rateBps: rate.rate_bps, name: rate.name, note: null };
}

export async function adjustBalance(db: Db, app: App, subject: Subject, currency: string, amount: number, reason: string, invoiceId: string | null = null): Promise<number> {
  const now = app.clock.now();
  await db.exec(sql`
    INSERT INTO customer_balances (subject_type, subject_id, currency, balance, updated_at) VALUES (${subject.type}, ${subject.id}, ${currency}, 0, ${now})
    ON CONFLICT DO NOTHING
  `);
  const row = await db.one<{ balance: number }>(sql`
    UPDATE customer_balances SET balance = GREATEST(0, balance + ${amount}), updated_at = ${now}
    WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND currency = ${currency} RETURNING balance
  `);
  await db.exec(sql.insert('customer_balance_transactions', { id: newId('cbt'), subject_type: subject.type, subject_id: subject.id, currency, amount, balance_after: row.balance, reason, invoice_id: invoiceId, created_at: now }, ''));
  return row.balance;
}

// ---- Invoices ----------------------------------------------------------------------------

export interface LineInput {
  type: 'subscription' | 'one_time' | 'usage' | 'overage' | 'proration' | 'manual';
  description: string;
  productId?: string | null;
  priceId?: string | null;
  quantity: number;
  unitAmount: number;
  amount: number;
  discountAmount?: number;
  taxInclusive?: boolean;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

export interface InvoiceInput {
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  currency: string;
  billingReason: 'checkout' | 'subscription_cycle' | 'subscription_update' | 'manual';
  lines: LineInput[];
  subscriptionId?: string | null;
  orderId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  dueAt?: Date | null;
  notes?: string | null;
  applyBalance?: boolean;
  /** Draft invoices get no number and can still be edited/voided freely. */
  finalize?: boolean;
}

export async function createInvoice(db: Db, app: App, input: InvoiceInput): Promise<any> {
  const now = app.clock.now();
  const s = settingsOf(app);
  const tax = await taxFor(db, app, input.subject);
  const id = newId('inv');
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let exclusiveTax = 0;
  const lines = input.lines.map((l, position) => {
    const discount = Math.min(Math.max(0, l.discountAmount ?? 0), Math.max(0, l.amount));
    const taxable = l.amount - discount;
    const t = computeTax(Math.max(0, taxable), tax.rateBps, Boolean(l.taxInclusive));
    subtotal += l.amount;
    discountTotal += discount;
    taxTotal += t.tax;
    if (!l.taxInclusive) exclusiveTax += t.tax;
    return {
      id: newId('ili'),
      invoice_id: id,
      type: l.type,
      description: l.description,
      product_id: l.productId ?? null,
      price_id: l.priceId ?? null,
      quantity: l.quantity,
      unit_amount: l.unitAmount,
      amount: l.amount,
      discount_amount: discount,
      tax_rate_bps: tax.rateBps,
      tax_amount: t.tax,
      tax_inclusive: Boolean(l.taxInclusive),
      period_start: l.periodStart ?? null,
      period_end: l.periodEnd ?? null,
      position,
    };
  });
  const total = Math.max(0, subtotal - discountTotal + exclusiveTax);

  let balanceApplied = 0;
  if (input.applyBalance !== false && total > 0) {
    const bal = await db.maybe<{ balance: number }>(sql`
      SELECT balance FROM customer_balances WHERE subject_type = ${input.subject.type} AND subject_id = ${input.subject.id} AND currency = ${input.currency} FOR UPDATE
    `);
    balanceApplied = Math.min(bal?.balance ?? 0, total);
    if (balanceApplied > 0) await adjustBalance(db, app, input.subject, input.currency, -balanceApplied, 'Applied to invoice', id);
  }
  const amountDue = total - balanceApplied;
  const finalize = input.finalize !== false;
  const number = finalize ? await nextNumber(db, s.invoicePrefix, now) : null;
  const status = !finalize ? 'draft' : amountDue === 0 ? 'paid' : 'open';
  await db.exec(sql.insert('invoices', {
    id,
    number,
    subject_type: input.subject.type,
    subject_id: input.subject.id,
    user_id: input.userId,
    org_id: input.orgId,
    subscription_id: input.subscriptionId ?? null,
    order_id: input.orderId ?? null,
    status,
    billing_reason: input.billingReason,
    currency: input.currency,
    subtotal,
    discount_total: discountTotal,
    tax_total: taxTotal,
    total,
    balance_applied: balanceApplied,
    amount_due: amountDue,
    amount_paid: 0,
    period_start: input.periodStart ?? null,
    period_end: input.periodEnd ?? null,
    due_at: input.dueAt ?? (finalize ? new Date(now.getTime() + s.invoiceDueDays * DAY) : null),
    issued_at: finalize ? now : null,
    paid_at: status === 'paid' ? now : null,
    customer_details: await customerDetails(db, input.subject),
    seller_details: { name: s.sellerName, address: s.sellerAddress, email: s.sellerEmail, taxId: s.sellerTaxId, country: s.sellerCountry },
    tax_note: tax.note,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  }, ''));
  if (lines.length) await db.exec(sql.insertMany('invoice_lines', lines, ''));
  const invoice = await db.one(sql`SELECT * FROM invoices WHERE id = ${id}`);
  if (finalize) {
    await app.events.emit(db, 'invoice.created', { invoiceId: id, number, total, amountDue, currency: input.currency, subscriptionId: input.subscriptionId ?? null }, scopeOfSubject(input.subject));
    if (status === 'paid') await app.events.emit(db, 'invoice.paid', { invoiceId: id, number, amountPaid: 0, currency: input.currency, subscriptionId: input.subscriptionId ?? null }, scopeOfSubject(input.subject));
  }
  // Nothing to collect (discounts or account credit cover it): the period is paid as it is billed.
  if (status === 'paid' && input.subscriptionId && billsPeriod(input.billingReason)) await recordInstallmentPaid(db, app, input.subscriptionId);
  return invoice;
}

/** Invoices that charge a subscription period (not proration adjustments). */
function billsPeriod(reason: InvoiceInput['billingReason']): boolean {
  return reason !== 'subscription_update';
}

export async function finalizeInvoice(db: Db, app: App, id: string): Promise<any> {
  const inv = await db.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${id} FOR UPDATE`);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'draft') throw conflict('Only draft invoices can be finalized', 'invoice_not_draft');
  const now = app.clock.now();
  const number = await nextNumber(db, settingsOf(app).invoicePrefix, now);
  const status = inv.amount_due === 0 ? 'paid' : 'open';
  await db.exec(sql`
    UPDATE invoices SET number = ${number}, status = ${status}, issued_at = ${now}, paid_at = ${status === 'paid' ? now : null},
      due_at = coalesce(due_at, ${new Date(now.getTime() + settingsOf(app).invoiceDueDays * DAY)}), updated_at = ${now} WHERE id = ${id}
  `);
  const subject: Subject = { type: inv.subject_type, id: inv.subject_id };
  await app.events.emit(db, 'invoice.created', { invoiceId: id, number, total: inv.total, amountDue: inv.amount_due, currency: inv.currency }, scopeOfSubject(subject));
  return db.one(sql`SELECT * FROM invoices WHERE id = ${id}`);
}

export async function voidInvoice(db: Db, app: App, id: string, actor: Actor): Promise<any> {
  const inv = await db.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${id} FOR UPDATE`);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'open' && inv.status !== 'draft') throw conflict(`A ${inv.status} invoice cannot be voided`, 'invoice_not_voidable');
  if (inv.amount_paid > 0) throw conflict('Refund the payments before voiding this invoice', 'invoice_has_payments');
  const subject: Subject = { type: inv.subject_type, id: inv.subject_id };
  if (inv.balance_applied > 0) await adjustBalance(db, app, subject, inv.currency, inv.balance_applied, 'Returned from voided invoice', inv.id);
  await db.exec(sql`UPDATE invoices SET status = 'void', voided_at = ${app.clock.now()}, next_attempt_at = NULL, updated_at = ${app.clock.now()} WHERE id = ${id}`);
  if (inv.order_id) {
    await db.exec(sql`UPDATE orders SET status = 'canceled' WHERE id = ${inv.order_id} AND status = 'pending'`);
    await releaseSale(db, app, { type: 'order', id: inv.order_id });
  }
  await writeAudit(db, app, { actor, action: 'invoice.void', targetType: 'invoice', targetId: id });
  await app.events.emit(db, 'invoice.voided', { invoiceId: id, number: inv.number }, scopeOfSubject(subject));
  return db.one(sql`SELECT * FROM invoices WHERE id = ${id}`);
}

// ---- Payments --------------------------------------------------------------------------------

export interface PaymentInput {
  invoiceId: string | null;
  orderId?: string | null;
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  gatewayId: string | null;
  gatewayPaymentId: string | null;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed' | 'pending';
  method?: { type: string; brand?: string | null; last4?: string | null } | null;
  fee?: number | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  manualReference?: string | null;
  recordedBy?: string | null;
}

/** Record a payment. Idempotent per (gateway, gateway payment id): replays return the existing row. */
export async function recordPayment(db: Db, app: App, p: PaymentInput): Promise<{ payment: any; created: boolean }> {
  if (p.gatewayId && p.gatewayPaymentId) {
    const existing = await db.maybe(sql`SELECT * FROM payments WHERE gateway_id = ${p.gatewayId} AND gateway_payment_id = ${p.gatewayPaymentId}`);
    if (existing) return { payment: existing, created: false };
  }
  const now = app.clock.now();
  const payment = await db.one(sql.insert('payments', {
    id: newId('pay'),
    subject_type: p.subject.type,
    subject_id: p.subject.id,
    user_id: p.userId,
    org_id: p.orgId,
    invoice_id: p.invoiceId,
    order_id: p.orderId ?? null,
    gateway_id: p.gatewayId,
    gateway_payment_id: p.gatewayPaymentId,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    method_type: p.method?.type ?? null,
    method_details: p.method ?? {},
    fee_amount: p.fee ?? null,
    failure_code: p.failureCode ?? null,
    failure_message: p.failureMessage ?? null,
    manual_reference: p.manualReference ?? null,
    recorded_by: p.recordedBy ?? null,
    created_at: now,
    succeeded_at: p.status === 'succeeded' ? now : null,
  }));
  const scope = scopeOfSubject(p.subject);
  if (p.status === 'succeeded') {
    await app.events.emit(db, 'payment.succeeded', { paymentId: payment.id, invoiceId: p.invoiceId, orderId: p.orderId ?? null, amount: p.amount, currency: p.currency, gatewayId: p.gatewayId }, scope);
    await addLifetimeRevenue(db, app, p.subject, p.userId, p.amount, p.currency);
  } else if (p.status === 'failed') {
    await app.events.emit(db, 'payment.failed', { paymentId: payment.id, invoiceId: p.invoiceId, amount: p.amount, currency: p.currency, failureCode: p.failureCode ?? null, failureMessage: p.failureMessage ?? null }, scope);
  }
  return { payment, created: true };
}

/** Convert an amount between currencies using the admin-maintained rate table (null if no rate). */
export async function convert(db: Db, amount: number, from: string, to: string): Promise<number | null> {
  if (from === to) return amount;
  const direct = await db.maybe<{ rate: number }>(sql`SELECT rate FROM exchange_rates WHERE base = ${from} AND quote = ${to}`);
  if (direct) return Math.round(amount * direct.rate);
  const inverse = await db.maybe<{ rate: number }>(sql`SELECT rate FROM exchange_rates WHERE base = ${to} AND quote = ${from}`);
  return inverse ? Math.round(amount / inverse.rate) : null;
}

async function addLifetimeRevenue(db: Db, app: App, subject: Subject, userId: string | null, amount: number, currency: string): Promise<void> {
  const base = settingsOf(app).baseCurrency;
  const converted = (await convert(db, amount, currency, base)) ?? amount;
  const userIds = subject.type === 'user' ? [subject.id] : userId ? [userId] : [];
  for (const id of userIds) await db.exec(sql`UPDATE users SET lifetime_revenue = lifetime_revenue + ${converted} WHERE id = ${id}`);
}

/** Apply a successful payment to its invoice and everything that hangs off it (order, subscription). */
export async function settleInvoice(db: Db, app: App, invoiceId: string, amount: number): Promise<any> {
  const inv = await db.one<any>(sql`SELECT * FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);
  const now = app.clock.now();
  const paid = inv.amount_paid + amount;
  const fullyPaid = paid >= inv.amount_due;
  await db.exec(sql`
    UPDATE invoices SET amount_paid = ${paid}, status = ${fullyPaid ? 'paid' : inv.status}, paid_at = ${fullyPaid ? now : null},
      next_attempt_at = ${fullyPaid ? null : inv.next_attempt_at}, updated_at = ${now} WHERE id = ${invoiceId}
  `);
  if (!fullyPaid || inv.status === 'paid') return inv;
  const subject: Subject = { type: inv.subject_type, id: inv.subject_id };
  await app.events.emit(db, 'invoice.paid', { invoiceId, number: inv.number, amountPaid: paid, currency: inv.currency, subscriptionId: inv.subscription_id }, scopeOfSubject(subject));
  if (inv.order_id) await fulfilPendingOrder(db, app, invoiceId, inv.order_id);
  if (inv.subscription_id) {
    const sub = await db.maybe<any>(sql`SELECT * FROM subscriptions WHERE id = ${inv.subscription_id} FOR UPDATE`);
    if (sub && (sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'incomplete')) {
      await db.exec(sql`UPDATE subscriptions SET status = 'active', grace_until = NULL, next_payment_attempt_at = NULL, payment_attempts = 0, updated_at = ${now} WHERE id = ${sub.id}`);
      await app.events.emit(db, 'subscription.updated', { subscriptionId: sub.id, status: 'active', previousStatus: sub.status }, scopeOfSubject(subject));
    }
    if (sub && billsPeriod(inv.billing_reason)) await recordInstallmentPaid(db, app, sub.id);
  }
  return inv;
}

/**
 * When fixed-term access to a product starts: when the subject's current access to it ends, so
 * buying again extends it, or now.
 */
export async function accessStartsAt(db: Db, app: App, subject: Subject, productId: string): Promise<Date> {
  const now = app.clock.now();
  const current = await db.one<{ ends_at: Date | null }>(sql`
    SELECT max(ends_at) AS ends_at FROM entitlement_grants
    WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND product_id = ${productId} AND revoked_at IS NULL AND ends_at > ${now}
  `);
  return current.ends_at && current.ends_at > now ? current.ends_at : now;
}

/**
 * Access bought once: lifetime plans and one-time products are granted for good, or for
 * `accessDays` from the end of the access the subject already has; credit packs top up credits.
 */
export async function grantOneTimePurchase(db: Db, app: App, subject: Subject, product: any, quantity: number, orderId: string, accessDays: number | null = null): Promise<void> {
  const now = app.clock.now();
  const scope = scopeOfSubject(subject);
  if (product.kind === 'credit_pack') {
    await app.events.emit(db, 'billing.credits_due', {
      subjectType: subject.type,
      subjectId: subject.id,
      creditType: product.credit_type,
      amount: product.credit_amount * quantity,
      expiresAt: product.credits_expire_days ? new Date(now.getTime() + product.credits_expire_days * 86_400_000) : null,
      reference: `order:${orderId}`,
      reason: `Purchased ${product.name}`,
    }, scope);
    return;
  }
  const startsAt = accessDays ? await accessStartsAt(db, app, subject, product.id) : now;
  await db.exec(sql.insert('entitlement_grants', {
    id: newId('grt'),
    subject_type: subject.type,
    subject_id: subject.id,
    product_id: product.id,
    quantity,
    source: 'purchase',
    source_ref: orderId,
    reason: accessDays ? `Order ${orderId}: ${accessDays} days of access` : `Order ${orderId}`,
    starts_at: startsAt,
    ends_at: accessDays ? new Date(startsAt.getTime() + accessDays * DAY) : null,
    created_at: now,
  }, ''));
  await app.events.emit(db, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'purchase' }, scope);
}

/**
 * Marks an invoice's pending order paid. Orders raised by an admin product invoice
 * (`metadata.fulfil = 'on_payment'`) only grant their plans and products at this point,
 * whichever way the invoice was paid: a gateway checkout, the pay link, or a recorded payment.
 */
export async function fulfilPendingOrder(db: Db, app: App, invoiceId: string, orderId: string): Promise<void> {
  const order = await db.maybe<any>(sql`SELECT * FROM orders WHERE id = ${orderId} FOR UPDATE`);
  if (!order || order.status !== 'pending') return;
  const now = app.clock.now();
  const subject: Subject = { type: order.subject_type, id: order.subject_id };
  const firstPurchase = !(await db.maybe(sql`
    SELECT 1 FROM orders WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND status IN ('paid', 'partially_refunded') AND id <> ${orderId} LIMIT 1
  `));
  await db.exec(sql`UPDATE orders SET status = 'paid', paid_at = ${now} WHERE id = ${orderId}`);
  await commitSale(db, app, { type: 'order', id: orderId }, orderId);
  if (order.metadata?.fulfil !== 'on_payment') return;

  const coupon = order.coupon_id ? await db.maybe<CouponRow>(sql`SELECT * FROM coupons WHERE id = ${order.coupon_id}`) : null;
  const items = await db.many<any>(sql`SELECT * FROM order_items WHERE order_id = ${orderId} ORDER BY id`);
  let subscriptionId: string | null = null;
  for (const item of items) {
    const { price, product } = await loadPrice(db, item.price_id);
    if (price.type !== 'recurring') {
      await grantOneTimePurchase(db, app, subject, product, item.quantity, orderId, price.access_days);
      continue;
    }
    const sub = await startSubscription(db, app, {
      subject,
      userId: order.user_id,
      orgId: order.org_id,
      price,
      product,
      quantity: item.quantity,
      coupon: coupon && (!coupon.applies_to.length || coupon.applies_to.includes(product.id)) ? coupon : null,
      trialDays: 0,
      collectionMethod: 'send_invoice',
      firstInvoicePaid: true,
      metadata: { orderId },
    });
    const renewalDiscount = Number(order.metadata.renewalDiscount ?? 0);
    if (renewalDiscount > 0) await db.exec(sql`UPDATE subscriptions SET renewal_discount = ${renewalDiscount} WHERE id = ${sub.id}`);
    subscriptionId = sub.id;
    await db.exec(sql`UPDATE orders SET subscription_id = ${sub.id} WHERE id = ${orderId}`);
    await db.exec(sql`UPDATE invoices SET subscription_id = ${sub.id}, period_start = ${sub.current_period_start}, period_end = ${sub.current_period_end} WHERE id = ${invoiceId}`);
  }
  if (coupon) {
    try {
      await db.tx((inner) => redeemCoupon(inner, app, coupon.id, { userId: order.user_id, orgId: order.org_id, orderId, discount: Number(order.metadata.couponDiscount ?? 0), currency: order.currency }));
    } catch (err) {
      app.log.warn({ err, couponId: coupon.id }, 'coupon exhausted before the invoice was paid; honouring the invoiced discount');
    }
  }
  await app.events.emit(db, 'order.paid', { orderId, invoiceId, total: order.total, currency: order.currency, productId: items[0]?.product_id ?? null, couponId: order.coupon_id, subscriptionId, firstPurchase }, scopeOfSubject(subject));
}

// ---- Subscriptions -----------------------------------------------------------------------------

export interface PriceRow extends PriceLike {
  id: string;
  product_id: string;
  currency: string;
  type: 'recurring' | 'one_time';
  interval: Interval | null;
  interval_count: number;
  tax_behavior: 'inclusive' | 'exclusive';
  intro_amount: number | null;
  intro_cycles: number | null;
  min_quantity: number;
  max_quantity: number | null;
  active: boolean;
  nickname: string | null;
  /** Installments: the subscription ends after this many paid periods (null = renews until cancelled). */
  payment_count: number | null;
  after_last_payment: 'end_access' | 'keep_access';
  /** One-time prices: access lasts this many days (null = for good). */
  access_days: number | null;
  stock_limit: number | null;
}

export async function loadPrice(db: Db, id: string): Promise<{ price: PriceRow; product: any }> {
  const price = await db.maybe<PriceRow>(sql`SELECT * FROM prices WHERE id = ${id}`);
  if (!price) throw notFound('Price');
  const product = await db.one(sql`SELECT * FROM products WHERE id = ${price.product_id}`);
  return { price, product };
}

/** Amount for one period, honouring introductory pricing. */
export function periodAmount(price: PriceRow, quantity: number, introRemaining: number | null): number {
  if (introRemaining && introRemaining > 0 && price.intro_amount !== null) {
    return price.pricing_model === 'per_seat' ? price.intro_amount * quantity : price.intro_amount;
  }
  return licensedAmount(price, quantity);
}

export function couponDiscount(coupon: CouponRow | null, amount: number, cyclesRemaining: number | null): number {
  if (!coupon) return 0;
  if (coupon.duration !== 'forever' && (cyclesRemaining ?? 0) <= 0) return 0;
  return discountAmount(coupon, amount);
}

export function describePrice(product: any, price: PriceRow, quantity: number): string {
  const every = price.interval ? `${price.interval_count > 1 ? `${price.interval_count} ` : ''}${price.interval}${price.interval_count > 1 ? 's' : ''}` : '';
  const term = price.access_days ? ` (${price.access_days} days of access)` : '';
  return `${product.name}${price.pricing_model === 'per_seat' ? ` × ${quantity} seats` : quantity > 1 ? ` × ${quantity}` : ''}${every ? ` (every ${every})` : ''}${term}`;
}

/** " — installment 2 of 3" on invoice lines of prices paid in installments. */
export function installmentLabel(price: Pick<PriceRow, 'payment_count'>, number: number): string {
  return price.payment_count ? ` — installment ${Math.min(number, price.payment_count)} of ${price.payment_count}` : '';
}

/**
 * One more period of a subscription is paid. When that was the last installment of a price that
 * lets the customer keep the product, the product is granted for good from the end of that period,
 * when the subscription stops conferring it.
 */
export async function recordInstallmentPaid(db: Db, app: App, subscriptionId: string): Promise<void> {
  const sub = await db.one<any>(sql`
    UPDATE subscriptions SET installments_paid = installments_paid + 1, updated_at = ${app.clock.now()} WHERE id = ${subscriptionId} RETURNING *
  `);
  await grantPaidInstallments(db, app, sub);
}

async function grantPaidInstallments(db: Db, app: App, sub: any): Promise<void> {
  const price = await db.one<PriceRow>(sql`SELECT * FROM prices WHERE id = ${sub.price_id}`);
  if (price.payment_count === null || price.after_last_payment !== 'keep_access' || sub.installments_paid < price.payment_count) return;
  if (await db.maybe(sql`SELECT 1 FROM entitlement_grants WHERE source = 'purchase' AND source_ref = ${sub.id}`)) return;
  const now = app.clock.now();
  await db.exec(sql.insert('entitlement_grants', {
    id: newId('grt'),
    subject_type: sub.subject_type,
    subject_id: sub.subject_id,
    product_id: sub.product_id,
    quantity: sub.quantity,
    source: 'purchase',
    source_ref: sub.id,
    reason: `Paid in ${price.payment_count} installments (subscription ${sub.id})`,
    starts_at: sub.current_period_end,
    created_at: now,
  }, ''));
}

export async function hadTrial(db: Db, subject: Subject, productId: string): Promise<boolean> {
  return Boolean(await db.maybe(sql`SELECT 1 FROM subscriptions WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND product_id = ${productId} AND trial_start IS NOT NULL`));
}

export interface StartSubscriptionInput {
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  price: PriceRow;
  product: any;
  quantity: number;
  coupon: CouponRow | null;
  trialDays: number;
  collectionMethod: 'charge_automatically' | 'send_invoice' | 'complimentary';
  gatewayId?: string | null;
  paymentMethodId?: string | null;
  checkoutId?: string | null;
  /** The first period's invoice already exists (checkout) — don't bill again. */
  firstInvoicePaid?: boolean;
  metadata?: Record<string, unknown>;
  /** Id to create the subscription with (lets callers record the sale under it first). */
  id?: string;
}

export async function startSubscription(db: Db, app: App, input: StartSubscriptionInput): Promise<any> {
  const { price, product } = input;
  if (price.type !== 'recurring' || !price.interval) throw validationError([{ path: ['priceId'], message: 'This price is not recurring' }]);
  const now = app.clock.now();
  const trialing = input.trialDays > 0;
  const periodEnd = trialing ? new Date(now.getTime() + input.trialDays * DAY) : addInterval(now, price.interval, price.interval_count);
  const id = input.id ?? newId('sub');
  const discountCycles = input.coupon ? (input.coupon.duration === 'once' ? 1 : input.coupon.duration === 'repeating' ? input.coupon.duration_cycles : null) : null;
  // The checkout invoice consumed one discount/intro cycle already.
  const consumed = input.firstInvoicePaid ? 1 : 0;
  // Installments count what is charged: a paid checkout is the first payment (even before a trial
  // that required a payment method), a free trial bills nothing yet, and a complimentary period is paid.
  const firstPeriodPaid = Boolean(input.firstInvoicePaid) || (!trialing && input.collectionMethod === 'complimentary');
  await db.exec(sql.insert('subscriptions', {
    id,
    subject_type: input.subject.type,
    subject_id: input.subject.id,
    user_id: input.userId,
    org_id: input.orgId,
    product_id: product.id,
    price_id: price.id,
    status: trialing ? 'trialing' : 'active',
    quantity: input.quantity,
    currency: price.currency,
    collection_method: input.collectionMethod,
    gateway_id: input.gatewayId ?? null,
    payment_method_id: input.paymentMethodId ?? null,
    current_period_start: now,
    current_period_end: periodEnd,
    trial_start: trialing ? now : null,
    trial_end: trialing ? periodEnd : null,
    coupon_id: input.coupon?.id ?? null,
    discount_cycles_remaining: discountCycles === null ? null : Math.max(0, discountCycles - (trialing ? 0 : consumed)),
    intro_cycles_remaining: price.intro_cycles ? Math.max(0, price.intro_cycles - (trialing ? 0 : consumed)) : null,
    installments_billed: trialing && !firstPeriodPaid ? 0 : 1,
    installments_paid: firstPeriodPaid ? 1 : 0,
    checkout_id: input.checkoutId ?? null,
    metadata: input.metadata ?? {},
    created_at: now,
    updated_at: now,
  }, ''));
  const scope = scopeOfSubject(input.subject);
  await app.events.emit(db, 'subscription.created', { subscriptionId: id, productId: product.id, priceId: price.id, status: trialing ? 'trialing' : 'active', quantity: input.quantity, trialEnd: trialing ? periodEnd : null, paymentCount: price.payment_count }, scope);
  await app.events.emit(db, 'entitlements.updated', { subjectType: input.subject.type, subjectId: input.subject.id, reason: 'subscription' }, scope);
  if (!trialing) await grantPeriodCredits(db, app, input.subject, product, id, now, periodEnd);
  const sub = await db.one(sql`SELECT * FROM subscriptions WHERE id = ${id}`);
  // A single-installment price is paid in full by its first payment.
  if (firstPeriodPaid) await grantPaidInstallments(db, app, sub);
  return sub;
}

async function grantPeriodCredits(db: Db, app: App, subject: Subject, product: any, subscriptionId: string, periodStart: Date, periodEnd: Date): Promise<void> {
  if (!product.credit_type || !product.credit_amount) return;
  const expiresAt = product.credits_expire_days ? new Date(periodStart.getTime() + product.credits_expire_days * DAY) : periodEnd;
  await app.events.emit(db, 'billing.credits_due', {
    subjectType: subject.type,
    subjectId: subject.id,
    creditType: product.credit_type,
    amount: product.credit_amount,
    expiresAt,
    reference: `sub:${subscriptionId}:${periodStart.toISOString()}`,
    reason: `${product.name} plan credits`,
  }, scopeOfSubject(subject));
}

/** Arrears lines for a finished period: metered prices and quota overage. */
async function arrearsLines(db: Db, app: App, sub: any, price: PriceRow, product: any, periodStart: Date, periodEnd: Date): Promise<LineInput[]> {
  if (!app.modules.isEnabled('usage')) return [];
  const subject: Subject = { type: sub.subject_type, id: sub.subject_id };
  const lines: LineInput[] = [];
  if (price.meter_key && (price.pricing_model === 'usage' || price.pricing_model === 'tiered')) {
    const row = await db.one<{ units: number }>(sql`
      SELECT coalesce(sum(quantity), 0) AS units FROM usage_events
      WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND meter_key = ${price.meter_key}
        AND created_at >= ${periodStart} AND created_at < ${periodEnd}
    `);
    const amount = usageAmount(price, row.units);
    lines.push({ type: 'usage', description: `${product.name}: ${row.units} ${price.meter_key} (${price.included_units} included)`, productId: product.id, priceId: price.id, quantity: row.units, unitAmount: price.unit_amount, amount, taxInclusive: price.tax_behavior === 'inclusive', periodStart, periodEnd });
  }
  const ent = await resolveEntitlements(db, app, subject);
  const counters = await db.many<{ id: string; meter_key: string; overage: number }>(sql`
    SELECT id, meter_key, overage FROM usage_counters
    WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND overage > 0 AND billed_at IS NULL
      AND period_end IS NOT NULL AND period_end <= ${periodEnd}
    FOR UPDATE
  `);
  for (const c of counters) {
    const feature = Object.values(ent.features).find((f) => f.meterKey === c.meter_key);
    const unit = feature?.overageUnitAmount ?? 0;
    await db.exec(sql`UPDATE usage_counters SET billed_at = ${app.clock.now()} WHERE id = ${c.id}`);
    if (!unit) continue;
    lines.push({ type: 'overage', description: `Overage: ${c.overage} ${c.meter_key} beyond plan limit`, quantity: c.overage, unitAmount: unit, amount: c.overage * unit, periodStart, periodEnd });
  }
  return lines;
}

export interface ChargeOutcome {
  status: 'paid' | 'failed' | 'awaiting_payment' | 'requires_action';
  message?: string;
}

/** Try to collect an open invoice: off-session charge with the saved method when the gateway supports it. */
export async function collectInvoice(db: Db, app: App, invoiceId: string, sub: any | null): Promise<ChargeOutcome> {
  const inv = await db.one<any>(sql`SELECT * FROM invoices WHERE id = ${invoiceId}`);
  if (inv.status === 'paid') return { status: 'paid' };
  if (inv.amount_due <= 0) {
    await settleInvoice(db, app, inv.id, 0);
    return { status: 'paid' };
  }
  if (!sub || sub.collection_method !== 'charge_automatically' || !sub.payment_method_id) return { status: 'awaiting_payment' };
  const pm = await db.maybe<any>(sql`SELECT * FROM payment_methods WHERE id = ${sub.payment_method_id} AND detached_at IS NULL`);
  const gw = pm ? await db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${pm.gateway_id} AND enabled`) : null;
  if (!pm || !gw) return { status: 'awaiting_payment' };
  const adapter = adapterFor(app, gw.adapter);
  if (!adapter.capabilities.offSessionCharge || !adapter.chargeSaved) return { status: 'awaiting_payment' };
  const subject: Subject = { type: inv.subject_type, id: inv.subject_id };
  const attempt = inv.attempt_count + 1;
  const result = await adapter.chargeSaved(await gatewayContext(db, app, gw), {
    invoiceId: inv.id,
    amount: inv.amount_due,
    currency: inv.currency,
    customerRef: pm.customer_ref,
    paymentMethodRef: pm.gateway_ref,
    description: `Invoice ${inv.number}`,
    idempotencyKey: `${inv.id}:attempt:${attempt}`,
  });
  await db.exec(sql`UPDATE invoices SET attempt_count = ${attempt}, updated_at = ${app.clock.now()} WHERE id = ${inv.id}`);
  if (result.status === 'succeeded') {
    // Card networks renew expiry dates behind the scenes; keep the saved card current for expiry warnings.
    if (result.method?.expMonth && result.method.expYear) {
      await db.exec(sql`UPDATE payment_methods SET exp_month = ${result.method.expMonth}, exp_year = ${result.method.expYear} WHERE id = ${pm.id}`);
    }
    await recordPayment(db, app, {
      invoiceId: inv.id,
      subject,
      userId: inv.user_id,
      orgId: inv.org_id,
      gatewayId: gw.id,
      gatewayPaymentId: result.gatewayPaymentId,
      amount: inv.amount_due,
      currency: inv.currency,
      status: 'succeeded',
      method: { type: pm.type, brand: pm.brand, last4: pm.last4 },
      fee: result.fee ?? null,
    });
    await settleInvoice(db, app, inv.id, inv.amount_due);
    return { status: 'paid' };
  }
  if (result.status === 'requires_action') return { status: 'requires_action', message: 'The customer must confirm the payment' };
  await recordPayment(db, app, {
    invoiceId: inv.id,
    subject,
    userId: inv.user_id,
    orgId: inv.org_id,
    gatewayId: gw.id,
    gatewayPaymentId: result.gatewayPaymentId ?? `failed:${inv.id}:${attempt}`,
    amount: inv.amount_due,
    currency: inv.currency,
    status: 'failed',
    method: { type: pm.type, brand: pm.brand, last4: pm.last4 },
    failureCode: result.failureCode,
    failureMessage: result.failureMessage,
  });
  return { status: 'failed', message: result.failureMessage };
}

/** Enter dunning after a failed renewal: past_due + grace period + scheduled retry. */
async function markPastDue(db: Db, app: App, sub: any, invoiceId: string, product: any, message?: string): Promise<void> {
  const s = settingsOf(app);
  const now = app.clock.now();
  const inv = await db.one<{ attempt_count: number; number: string; amount_due: number; currency: string }>(sql`SELECT attempt_count, number, amount_due, currency FROM invoices WHERE id = ${invoiceId}`);
  const retryDays = s.dunningRetryDays[inv.attempt_count - 1];
  const nextAttempt = retryDays ? new Date(now.getTime() + retryDays * DAY) : null;
  await db.exec(sql`UPDATE invoices SET next_attempt_at = ${nextAttempt} WHERE id = ${invoiceId}`);
  const graceUntil = sub.grace_until ?? new Date(now.getTime() + (product.grace_days ?? 0) * DAY);
  await db.exec(sql`UPDATE subscriptions SET status = 'past_due', grace_until = ${graceUntil}, next_payment_attempt_at = ${nextAttempt}, payment_attempts = ${inv.attempt_count}, updated_at = ${now} WHERE id = ${sub.id}`);
  const scope = scopeOfSubject({ type: sub.subject_type, id: sub.subject_id });
  await app.events.emit(db, 'invoice.payment_failed', { invoiceId, number: inv.number, amountDue: inv.amount_due, currency: inv.currency, attempt: inv.attempt_count, nextAttemptAt: nextAttempt, message: message ?? null, subscriptionId: sub.id }, scope);
  if (sub.status !== 'past_due') await app.events.emit(db, 'subscription.past_due', { subscriptionId: sub.id, graceUntil }, scope);
}

/**
 * The last installment's period is over: the subscription ends. Access ends with it, unless the
 * price lets the customer keep the product, which the grant made at the last payment now confers.
 */
async function completeInstallments(db: Db, app: App, sub: any, price: PriceRow): Promise<{ action: string }> {
  const now = app.clock.now();
  const scope = scopeOfSubject({ type: sub.subject_type, id: sub.subject_id });
  await db.exec(sql`
    UPDATE subscriptions SET status = 'canceled', ended_at = ${sub.current_period_end}, cancel_reason = 'installments_completed', updated_at = ${now} WHERE id = ${sub.id}
  `);
  const grant = await db.maybe<{ id: string }>(sql`SELECT id FROM entitlement_grants WHERE source = 'purchase' AND source_ref = ${sub.id} AND revoked_at IS NULL`);
  await app.events.emit(db, 'subscription.installments_completed', {
    subscriptionId: sub.id,
    productId: sub.product_id,
    payments: sub.installments_paid,
    access: price.after_last_payment,
    grantId: grant?.id ?? null,
  }, scope);
  await app.events.emit(db, 'subscription.canceled', { subscriptionId: sub.id, reason: 'installments_completed', endedAt: sub.current_period_end }, scope);
  await app.events.emit(db, 'entitlements.updated', { subjectType: sub.subject_type, subjectId: sub.subject_id, reason: 'installments_completed' }, scope);
  return { action: 'completed' };
}

/**
 * Roll a subscription into its next period: apply scheduled changes, end
 * cancelled subscriptions and completed installment plans, convert trials,
 * invoice (licensed fees in advance, usage and overage in arrears) and try to collect.
 */
/** Whether the checkout that started a subscription's trial was paid, and the payment not refunded in full. */
async function checkoutPrepaid(db: Db, subscriptionId: string): Promise<boolean> {
  const row = await db.maybe(sql`
    SELECT 1 FROM invoices i JOIN payments p ON p.invoice_id = i.id
    WHERE i.subscription_id = ${subscriptionId} AND i.billing_reason = 'checkout' AND i.status = 'paid' AND p.status IN ('succeeded', 'partially_refunded')
    LIMIT 1
  `);
  return row !== null;
}

export async function renewSubscription(db: Db, app: App, subscriptionId: string): Promise<{ action: string; invoiceId?: string; outcome?: ChargeOutcome }> {
  return db.tx(async (tx) => {
    let sub = await tx.maybe<any>(sql`SELECT * FROM subscriptions WHERE id = ${subscriptionId} FOR UPDATE`);
    const now = app.clock.now();
    if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status) || sub.current_period_end > now) return { action: 'skipped' };
    const subject: Subject = { type: sub.subject_type, id: sub.subject_id };
    const scope = scopeOfSubject(subject);

    // A trial that required a payment method was charged at checkout for the first period after it,
    // so the trial rolls into that period without billing it again (even when set to cancel: it was paid).
    if (sub.status === 'trialing' && (await checkoutPrepaid(tx, sub.id))) {
      const { price, product } = await loadPrice(tx, sub.price_id);
      const start: Date = sub.current_period_end;
      const end = addInterval(start, price.interval!, price.interval_count);
      await tx.exec(sql`
        UPDATE subscriptions SET current_period_start = ${start}, current_period_end = ${end}, status = 'active',
          intro_cycles_remaining = CASE WHEN intro_cycles_remaining > 0 THEN intro_cycles_remaining - 1 ELSE intro_cycles_remaining END,
          discount_cycles_remaining = CASE WHEN discount_cycles_remaining > 0 THEN discount_cycles_remaining - 1 ELSE discount_cycles_remaining END,
          updated_at = ${now}
        WHERE id = ${sub.id}
      `);
      await app.events.emit(tx, 'subscription.renewed', { subscriptionId: sub.id, periodStart: start, periodEnd: end, fromTrial: true, prepaid: true }, scope);
      await grantPeriodCredits(tx, app, subject, product, sub.id, start, end);
      return { action: 'renewed' };
    }

    if (sub.cancel_at_period_end) {
      await tx.exec(sql`UPDATE subscriptions SET status = 'canceled', ended_at = ${sub.current_period_end}, updated_at = ${now} WHERE id = ${sub.id}`);
      await app.events.emit(tx, 'subscription.canceled', { subscriptionId: sub.id, reason: sub.cancel_reason, endedAt: sub.current_period_end }, scope);
      await app.events.emit(tx, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'subscription_ended' }, scope);
      return { action: 'ended' };
    }

    if (sub.scheduled_change) {
      const ch = sub.scheduled_change as { priceId: string; quantity: number };
      const { price: newPrice } = await loadPrice(tx, ch.priceId);
      await tx.exec(sql`UPDATE subscriptions SET price_id = ${newPrice.id}, product_id = ${newPrice.product_id}, quantity = ${ch.quantity}, scheduled_change = NULL, intro_cycles_remaining = NULL WHERE id = ${sub.id}`);
      await app.events.emit(tx, 'subscription.updated', { subscriptionId: sub.id, change: 'scheduled_change_applied', priceId: newPrice.id, quantity: ch.quantity }, scope);
      sub = await tx.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
    }

    const { price, product } = await loadPrice(tx, sub.price_id);
    if (price.payment_count !== null && sub.installments_billed >= price.payment_count) {
      // Every installment is billed: nothing renews. While the last one is unpaid, dunning decides.
      if (sub.installments_paid < price.payment_count) return { action: 'skipped' };
      return completeInstallments(tx, app, sub, price);
    }
    const prevStart: Date = sub.current_period_start;
    const prevEnd: Date = sub.current_period_end;
    const nextEnd = addInterval(prevEnd, price.interval!, price.interval_count);
    const wasTrial = sub.status === 'trialing';
    const coupon = sub.coupon_id ? await tx.maybe<CouponRow>(sql`SELECT * FROM coupons WHERE id = ${sub.coupon_id}`) : null;

    const lines: LineInput[] = [];
    if (sub.collection_method !== 'complimentary') {
      const base = periodAmount(price, sub.quantity, sub.intro_cycles_remaining);
      const couponOff = couponDiscount(coupon, base, sub.discount_cycles_remaining);
      // A fixed amount off every renewal, agreed when an admin invoiced the subscription.
      const discount = couponOff + Math.min(Number(sub.renewal_discount ?? 0), base - couponOff);
      lines.push({
        type: 'subscription',
        description: describePrice(product, price, sub.quantity) + (sub.intro_cycles_remaining > 0 ? ' — introductory price' : '') + installmentLabel(price, sub.installments_billed + 1),
        productId: product.id,
        priceId: price.id,
        quantity: sub.quantity,
        unitAmount: price.pricing_model === 'per_seat' ? Math.round(base / sub.quantity) : base,
        amount: base,
        discountAmount: discount,
        taxInclusive: price.tax_behavior === 'inclusive',
        periodStart: prevEnd,
        periodEnd: nextEnd,
      });
      if (!wasTrial) lines.push(...(await arrearsLines(tx, app, sub, price, product, prevStart, prevEnd)));
    }

    await tx.exec(sql`
      UPDATE subscriptions SET current_period_start = ${prevEnd}, current_period_end = ${nextEnd},
        status = CASE WHEN status = 'trialing' THEN 'active' ELSE status END,
        intro_cycles_remaining = CASE WHEN intro_cycles_remaining > 0 THEN intro_cycles_remaining - 1 ELSE intro_cycles_remaining END,
        discount_cycles_remaining = CASE WHEN discount_cycles_remaining > 0 THEN discount_cycles_remaining - 1 ELSE discount_cycles_remaining END,
        installments_billed = installments_billed + 1,
        updated_at = ${now}
      WHERE id = ${sub.id}
    `);
    await app.events.emit(tx, 'subscription.renewed', { subscriptionId: sub.id, periodStart: prevEnd, periodEnd: nextEnd, fromTrial: wasTrial }, scope);
    await grantPeriodCredits(tx, app, subject, product, sub.id, prevEnd, nextEnd);

    if (!lines.length) {
      // Complimentary periods cost nothing, so each one counts as paid.
      await recordInstallmentPaid(tx, app, sub.id);
      return { action: 'renewed' };
    }
    const invoice = await createInvoice(tx, app, {
      subject,
      userId: sub.user_id,
      orgId: sub.org_id,
      currency: sub.currency,
      billingReason: 'subscription_cycle',
      lines,
      subscriptionId: sub.id,
      periodStart: prevEnd,
      periodEnd: nextEnd,
    });
    const fresh = await tx.one<any>(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
    const outcome = await collectInvoice(tx, app, invoice.id, fresh);
    if (outcome.status === 'failed') await markPastDue(tx, app, fresh, invoice.id, product, outcome.message);
    return { action: 'renewed', invoiceId: invoice.id, outcome };
  });
}

/** Dunning: retry failed renewal invoices on schedule; give up per policy when retries or grace run out. */
export async function runDunning(app: App): Promise<number> {
  const now = app.clock.now();
  const s = settingsOf(app);
  // Invoiced subscriptions (no automatic payment) go past due once their invoice is overdue.
  const overdue = await app.db.many<{ invoice_id: string; subscription_id: string }>(sql`
    SELECT i.id AS invoice_id, su.id AS subscription_id FROM invoices i JOIN subscriptions su ON su.id = i.subscription_id
    WHERE i.status = 'open' AND i.due_at < ${now} AND su.status = 'active' LIMIT 200
  `);
  for (const o of overdue) {
    await app.db.tx(async (tx) => {
      const sub = await tx.one<any>(sql`SELECT * FROM subscriptions WHERE id = ${o.subscription_id} FOR UPDATE`);
      if (sub.status !== 'active') return;
      const product = await tx.one<any>(sql`SELECT grace_days FROM products WHERE id = ${sub.product_id}`);
      const graceUntil = new Date(now.getTime() + product.grace_days * DAY);
      await tx.exec(sql`UPDATE subscriptions SET status = 'past_due', grace_until = ${graceUntil}, updated_at = ${now} WHERE id = ${sub.id}`);
      await tx.exec(sql`UPDATE invoices SET next_attempt_at = NULL WHERE id = ${o.invoice_id}`);
      await app.events.emit(tx, 'subscription.past_due', { subscriptionId: sub.id, graceUntil, reason: 'invoice_overdue', invoiceId: o.invoice_id }, scopeOfSubject({ type: sub.subject_type, id: sub.subject_id }));
    });
  }
  const due = await app.db.many<{ id: string; subscription_id: string }>(sql`
    SELECT i.id, i.subscription_id FROM invoices i JOIN subscriptions su ON su.id = i.subscription_id
    WHERE i.status = 'open' AND su.status = 'past_due' AND
      ((i.next_attempt_at IS NOT NULL AND i.next_attempt_at <= ${now}) OR (i.next_attempt_at IS NULL AND su.grace_until <= ${now}))
    LIMIT 200
  `);
  for (const row of due) {
    await app.db.tx(async (tx) => {
      const sub = await tx.one<any>(sql`SELECT * FROM subscriptions WHERE id = ${row.subscription_id} FOR UPDATE`);
      if (sub.status !== 'past_due') return;
      const product = await tx.one(sql`SELECT * FROM products WHERE id = ${sub.product_id}`);
      const inv = await tx.one<any>(sql`SELECT * FROM invoices WHERE id = ${row.id} FOR UPDATE`);
      if (inv.next_attempt_at && inv.next_attempt_at <= now) {
        const outcome = await collectInvoice(tx, app, inv.id, sub);
        if (outcome.status === 'paid') return;
        if (outcome.status === 'failed') {
          // Schedules the next retry, or none once the retry schedule is exhausted.
          await markPastDue(tx, app, sub, inv.id, product, outcome.message);
          return;
        }
        // No automatic payment method: stop retrying and wait for the customer until grace ends.
        await tx.exec(sql`UPDATE invoices SET next_attempt_at = NULL WHERE id = ${inv.id}`);
        return;
      }
      if (sub.grace_until && sub.grace_until > now) return;
      // Retries exhausted and grace period over: apply the final action.
      const scope = scopeOfSubject({ type: sub.subject_type, id: sub.subject_id });
      if (s.dunningFinalAction === 'cancel') {
        await tx.exec(sql`UPDATE subscriptions SET status = 'canceled', canceled_at = ${now}, ended_at = ${now}, cancel_reason = 'payment_failed', updated_at = ${now} WHERE id = ${sub.id}`);
        await tx.exec(sql`UPDATE invoices SET status = 'uncollectible', next_attempt_at = NULL, updated_at = ${now} WHERE id = ${inv.id}`);
        await app.events.emit(tx, 'subscription.canceled', { subscriptionId: sub.id, reason: 'payment_failed', endedAt: now }, scope);
      } else {
        await tx.exec(sql`UPDATE subscriptions SET status = 'unpaid', updated_at = ${now} WHERE id = ${sub.id}`);
        await tx.exec(sql`UPDATE invoices SET next_attempt_at = NULL WHERE id = ${inv.id}`);
        await app.events.emit(tx, 'subscription.updated', { subscriptionId: sub.id, status: 'unpaid', previousStatus: 'past_due' }, scope);
      }
      await app.events.emit(tx, 'entitlements.updated', { subjectType: sub.subject_type, subjectId: sub.subject_id, reason: 'dunning' }, scope);
    });
  }
  return due.length;
}

export async function lockSubscription(db: Db, id: string, scope: string[] | null): Promise<any> {
  const sub = await db.maybe(sql`
    SELECT * FROM subscriptions s WHERE s.id = ${id}
    ${scope ? sql`AND (s.org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = s.user_id AND m.org_id IN ${sql.in(scope)}))` : sql.empty}
    FOR UPDATE
  `);
  if (!sub) throw notFound('Subscription');
  return sub;
}

/**
 * Change plan, price or seat count. Upgrades apply immediately with proration
 * (unused value of the old price is credited against the new price for the
 * rest of the period); downgrades wait for the period end unless asked
 * otherwise. Changing the billing interval restarts the period now.
 */
export async function changeSubscription(
  db: Db,
  app: App,
  input: { subscriptionId: string; priceId?: string; quantity?: number; timing?: 'immediate' | 'period_end' | 'auto'; prorate?: boolean; actor: Actor; scope: string[] | null },
): Promise<{ subscription: any; invoice: any | null; scheduled: boolean }> {
  const sub = await lockSubscription(db, input.subscriptionId, input.scope);
  if (!['active', 'trialing', 'past_due'].includes(sub.status)) throw conflict(`A ${sub.status} subscription cannot be changed`, 'subscription_not_changeable');
  const now = app.clock.now();
  const { price: oldPrice } = await loadPrice(db, sub.price_id);
  const { price: newPrice, product: newProduct } = await loadPrice(db, input.priceId ?? sub.price_id);
  const quantity = input.quantity ?? sub.quantity;
  if (!newPrice.active) throw validationError([{ path: ['priceId'], message: 'This price is no longer available' }]);
  if (newPrice.type !== 'recurring') throw validationError([{ path: ['priceId'], message: 'Choose a recurring price' }]);
  if (newPrice.currency !== sub.currency) throw validationError([{ path: ['priceId'], message: 'Changing currency requires a new subscription' }]);
  if (quantity < newPrice.min_quantity || (newPrice.max_quantity && quantity > newPrice.max_quantity)) throw validationError([{ path: ['quantity'], message: 'Quantity out of range for this price' }]);
  if (newPrice.id === oldPrice.id && quantity === sub.quantity) throw conflict('Nothing to change', 'no_change');
  if (oldPrice.payment_count !== null || newPrice.payment_count !== null) {
    throw conflict('Installment plans keep their price and quantity until the last payment; cancel this subscription and start a new one instead', 'installment_plan');
  }
  const subject: Subject = { type: sub.subject_type, id: sub.subject_id };
  const scope = scopeOfSubject(subject);
  const s = settingsOf(app);
  // Moving to another product is a sale of that product: its purchase rules and stock apply.
  if (newPrice.product_id !== sub.product_id) {
    await reserveSale(db, app, {
      subject,
      userId: sub.user_id,
      orgId: sub.org_id,
      items: [{ product: newProduct, price: newPrice, quantity }],
      source: { type: 'subscription', id: sub.id },
      status: 'sold',
      replaces: [sub.product_id],
    });
  }

  const oldAmount = licensedAmount(oldPrice, sub.quantity);
  const newAmount = licensedAmount(newPrice, quantity);
  const oldMonths = monthsIn(oldPrice.interval!, oldPrice.interval_count);
  const newMonths = monthsIn(newPrice.interval!, newPrice.interval_count);
  const intervalChange = oldMonths !== newMonths;
  // Longer commitments are upgrades; moving to a shorter interval waits for the prepaid period to end.
  const isUpgrade = intervalChange ? newMonths > oldMonths : newAmount / newMonths >= oldAmount / oldMonths;
  const timing = input.timing && input.timing !== 'auto' ? input.timing : isUpgrade || s.downgradeTiming === 'immediate' ? 'immediate' : 'period_end';

  if (timing === 'period_end' || sub.status === 'trialing') {
    if (sub.status === 'trialing') {
      await db.exec(sql`UPDATE subscriptions SET price_id = ${newPrice.id}, product_id = ${newPrice.product_id}, quantity = ${quantity}, updated_at = ${now} WHERE id = ${sub.id}`);
    } else {
      await db.exec(sql`UPDATE subscriptions SET scheduled_change = ${sql.json({ priceId: newPrice.id, quantity, requestedAt: now })}, updated_at = ${now} WHERE id = ${sub.id}`);
    }
    await writeAudit(db, app, { actor: input.actor, action: 'subscription.change', targetType: 'subscription', targetId: sub.id, metadata: { priceId: newPrice.id, quantity, timing: sub.status === 'trialing' ? 'immediate' : 'period_end' } });
    await app.events.emit(db, 'subscription.updated', { subscriptionId: sub.id, change: sub.status === 'trialing' ? 'plan_changed' : 'change_scheduled', priceId: newPrice.id, quantity, effectiveAt: sub.status === 'trialing' ? now : sub.current_period_end }, scope);
    if (sub.status === 'trialing') await app.events.emit(db, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'plan_change' }, scope);
    return { subscription: await db.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`), invoice: null, scheduled: sub.status !== 'trialing' };
  }

  const prorate = input.prorate ?? s.prorate;
  const lines: LineInput[] = [];
  let periodStart: Date = sub.current_period_start;
  let periodEnd: Date = sub.current_period_end;
  const credit = prorate ? unusedValue(oldAmount, sub.current_period_start, sub.current_period_end, now) : 0;
  if (intervalChange) {
    periodStart = now;
    periodEnd = addInterval(now, newPrice.interval!, newPrice.interval_count);
    lines.push({ type: 'subscription', description: describePrice(newProduct, newPrice, quantity), productId: newProduct.id, priceId: newPrice.id, quantity, unitAmount: newAmount, amount: newAmount, taxInclusive: newPrice.tax_behavior === 'inclusive', periodStart, periodEnd });
  } else if (prorate) {
    const charge = unusedValue(newAmount, sub.current_period_start, sub.current_period_end, now);
    lines.push({ type: 'proration', description: `Remaining time on ${describePrice(newProduct, newPrice, quantity)}`, productId: newProduct.id, priceId: newPrice.id, quantity: 1, unitAmount: charge, amount: charge, taxInclusive: newPrice.tax_behavior === 'inclusive', periodStart: now, periodEnd });
  }
  if (credit > 0) {
    lines.push({ type: 'proration', description: 'Unused time on previous plan', quantity: 1, unitAmount: -credit, amount: -credit, periodStart: now, periodEnd: sub.current_period_end });
  }
  await db.exec(sql`
    UPDATE subscriptions SET price_id = ${newPrice.id}, product_id = ${newPrice.product_id}, quantity = ${quantity}, scheduled_change = NULL,
      current_period_start = ${periodStart}, current_period_end = ${periodEnd}, intro_cycles_remaining = NULL, updated_at = ${now}
    WHERE id = ${sub.id}
  `);
  let invoice: any = null;
  const net = lines.reduce((sum, l) => sum + l.amount, 0);
  if (lines.length && net > 0) {
    invoice = await createInvoice(db, app, { subject, userId: sub.user_id, orgId: sub.org_id, currency: sub.currency, billingReason: 'subscription_update', lines, subscriptionId: sub.id, periodStart: now, periodEnd });
    const fresh = await db.one<any>(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
    const outcome = await collectInvoice(db, app, invoice.id, fresh);
    if (outcome.status === 'failed') await markPastDue(db, app, fresh, invoice.id, newProduct, outcome.message);
    invoice = await db.one(sql`SELECT * FROM invoices WHERE id = ${invoice.id}`);
  } else if (net < 0) {
    await adjustBalance(db, app, subject, sub.currency, -net, `Proration credit from plan change on ${sub.id}`);
  }
  await writeAudit(db, app, { actor: input.actor, action: 'subscription.change', targetType: 'subscription', targetId: sub.id, metadata: { from: { priceId: oldPrice.id, quantity: sub.quantity }, to: { priceId: newPrice.id, quantity }, prorated: prorate, net } });
  await app.events.emit(db, 'subscription.updated', { subscriptionId: sub.id, change: 'plan_changed', priceId: newPrice.id, quantity, net }, scope);
  await app.events.emit(db, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'plan_change' }, scope);
  return { subscription: await db.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`), invoice, scheduled: false };
}

export async function cancelSubscription(
  db: Db,
  app: App,
  input: { subscriptionId: string; atPeriodEnd: boolean; reason?: string | null; creditUnused?: boolean; actor: Actor; scope: string[] | null },
): Promise<any> {
  const sub = await lockSubscription(db, input.subscriptionId, input.scope);
  if (sub.status === 'canceled') return sub;
  const now = app.clock.now();
  const subject: Subject = { type: sub.subject_type, id: sub.subject_id };
  const scope = scopeOfSubject(subject);
  if (input.atPeriodEnd && sub.status !== 'paused') {
    await db.exec(sql`UPDATE subscriptions SET cancel_at_period_end = TRUE, canceled_at = ${now}, cancel_reason = ${input.reason ?? null}, updated_at = ${now} WHERE id = ${sub.id}`);
    await app.events.emit(db, 'subscription.updated', { subscriptionId: sub.id, change: 'cancel_scheduled', endsAt: sub.current_period_end, reason: input.reason ?? null }, scope);
  } else {
    if (input.creditUnused && sub.status === 'active') {
      const { price } = await loadPrice(db, sub.price_id);
      const credit = unusedValue(licensedAmount(price, sub.quantity), sub.current_period_start, sub.current_period_end, now);
      if (credit > 0) await adjustBalance(db, app, subject, sub.currency, credit, `Unused time on cancelled subscription ${sub.id}`);
    }
    await db.exec(sql`UPDATE subscriptions SET status = 'canceled', canceled_at = ${now}, ended_at = ${now}, cancel_reason = ${input.reason ?? null}, updated_at = ${now} WHERE id = ${sub.id}`);
    await db.exec(sql`UPDATE invoices SET status = 'void', voided_at = ${now}, next_attempt_at = NULL WHERE subscription_id = ${sub.id} AND status = 'open' AND amount_paid = 0`);
    await app.events.emit(db, 'subscription.canceled', { subscriptionId: sub.id, reason: input.reason ?? null, endedAt: now }, scope);
    await app.events.emit(db, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'subscription_canceled' }, scope);
  }
  await writeAudit(db, app, { actor: input.actor, action: input.atPeriodEnd ? 'subscription.cancel_at_period_end' : 'subscription.cancel', targetType: 'subscription', targetId: sub.id, metadata: { reason: input.reason ?? null } });
  return db.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
}

export async function reactivateSubscription(db: Db, app: App, id: string, actor: Actor, scope: string[] | null): Promise<any> {
  const sub = await lockSubscription(db, id, scope);
  if (!sub.cancel_at_period_end || sub.status === 'canceled') throw conflict('Only subscriptions scheduled to cancel can be reactivated; start a new checkout instead', 'not_reactivatable');
  await db.exec(sql`UPDATE subscriptions SET cancel_at_period_end = FALSE, canceled_at = NULL, cancel_reason = NULL, updated_at = ${app.clock.now()} WHERE id = ${sub.id}`);
  await writeAudit(db, app, { actor, action: 'subscription.reactivate', targetType: 'subscription', targetId: sub.id });
  await app.events.emit(db, 'subscription.reactivated', { subscriptionId: sub.id }, scopeOfSubject({ type: sub.subject_type, id: sub.subject_id }));
  return db.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
}

/** Pause: access stops and billing stops. Resume starts a fresh period (charged now). */
export async function pauseSubscription(db: Db, app: App, id: string, input: { resumeAt?: Date | null; actor: Actor; scope: string[] | null }): Promise<any> {
  const sub = await lockSubscription(db, id, input.scope);
  if (sub.status !== 'active') throw conflict('Only active subscriptions can be paused', 'not_pausable');
  const { price } = await loadPrice(db, sub.price_id);
  if (price.payment_count !== null) throw conflict('Installment plans cannot be paused; they end after the last payment', 'installment_plan');
  const now = app.clock.now();
  await db.exec(sql`UPDATE subscriptions SET status = 'paused', paused_at = ${now}, resume_at = ${input.resumeAt ?? null}, updated_at = ${now} WHERE id = ${sub.id}`);
  const scope = scopeOfSubject({ type: sub.subject_type, id: sub.subject_id });
  await writeAudit(db, app, { actor: input.actor, action: 'subscription.pause', targetType: 'subscription', targetId: sub.id, metadata: { resumeAt: input.resumeAt ?? null } });
  await app.events.emit(db, 'subscription.paused', { subscriptionId: sub.id, resumeAt: input.resumeAt ?? null }, scope);
  await app.events.emit(db, 'entitlements.updated', { subjectType: sub.subject_type, subjectId: sub.subject_id, reason: 'paused' }, scope);
  return db.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
}

export async function resumeSubscription(db: Db, app: App, id: string, actor: Actor, scope: string[] | null): Promise<{ subscription: any; invoice: any | null }> {
  const sub = await lockSubscription(db, id, scope);
  if (sub.status !== 'paused') throw conflict('This subscription is not paused', 'not_paused');
  const now = app.clock.now();
  const { price, product } = await loadPrice(db, sub.price_id);
  const periodEnd = addInterval(now, price.interval!, price.interval_count);
  await db.exec(sql`
    UPDATE subscriptions SET status = 'active', paused_at = NULL, resume_at = NULL, current_period_start = ${now}, current_period_end = ${periodEnd},
      installments_billed = installments_billed + 1, updated_at = ${now} WHERE id = ${sub.id}
  `);
  const subject: Subject = { type: sub.subject_type, id: sub.subject_id };
  let invoice: any = null;
  if (sub.collection_method !== 'complimentary') {
    const amount = licensedAmount(price, sub.quantity);
    invoice = await createInvoice(db, app, {
      subject,
      userId: sub.user_id,
      orgId: sub.org_id,
      currency: sub.currency,
      billingReason: 'subscription_cycle',
      subscriptionId: sub.id,
      periodStart: now,
      periodEnd,
      lines: [{ type: 'subscription', description: describePrice(product, price, sub.quantity) + installmentLabel(price, sub.installments_billed + 1), productId: product.id, priceId: price.id, quantity: sub.quantity, unitAmount: amount, amount, taxInclusive: price.tax_behavior === 'inclusive', periodStart: now, periodEnd }],
    });
    const fresh = await db.one<any>(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
    const outcome = await collectInvoice(db, app, invoice.id, fresh);
    if (outcome.status === 'failed') await markPastDue(db, app, fresh, invoice.id, product, outcome.message);
    invoice = await db.one(sql`SELECT * FROM invoices WHERE id = ${invoice.id}`);
  } else {
    await recordInstallmentPaid(db, app, sub.id);
  }
  const scopeEv = scopeOfSubject(subject);
  await writeAudit(db, app, { actor, action: 'subscription.resume', targetType: 'subscription', targetId: sub.id });
  await app.events.emit(db, 'subscription.resumed', { subscriptionId: sub.id }, scopeEv);
  await app.events.emit(db, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'resumed' }, scopeEv);
  return { subscription: await db.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`), invoice };
}

export function assertSubjectMatchesProduct(product: any, subject: Subject): void {
  if (product.subscriber_type === 'organization' && subject.type !== 'organization') {
    throw new AppError(422, 'organization_required', `${product.name} is purchased by an organization; pass orgId`);
  }
}
