import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { HOUR } from '../../core/clock.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import { addInterval, computeTax } from './money.js';
import { discountAmount, redeemCoupon, validateCoupon, type CouponRow } from '../catalog/coupons.js';
import { applyRefundFromGateway } from './refunds.js';
import { adapterFor, gatewayContext, pickGateway } from './gateways/registry.js';
import type { GatewayEvent, PaymentMethodInfo } from './gateways/types.js';
import type { Subject } from '../catalog/entitlements.js';
import {
  assertSubjectMatchesProduct,
  createInvoice,
  customerDetails,
  grantOneTimePurchase,
  hadTrial,
  installmentLabel,
  loadPrice,
  nextNumber,
  periodAmount,
  recordPayment,
  scopeOfSubject,
  settingsOf,
  settleInvoice,
  startSubscription,
  taxFor,
  voidInvoice,
} from './engine.js';
import { commitSale, releaseSale, reserveSale } from '../catalog/purchases.js';
import { notifyAdmins } from '../iam/notify.js';
import { writeAudit } from '../../core/audit.js';

/** Unguessable token for public pay pages (prevents enumerating checkout/invoice ids). */
export function payToken(app: App, id: string): string {
  return hmacSha256(app.config.encryptionKeys, `pay:${id}`).slice(0, 32);
}

export function verifyPayToken(app: App, id: string, token: string | undefined): boolean {
  return Boolean(token) && safeEqual(token!, payToken(app, id));
}

export interface CheckoutInput {
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  priceId: string;
  quantity: number;
  couponCode?: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  gatewayId?: string | null;
  actor: Actor;
  metadata?: Record<string, string>;
}

export interface CheckoutResponse {
  id: string;
  status: 'open' | 'completed';
  url: string | null;
  amount: { subtotal: number; discount: number; tax: number; total: number; currency: string };
  subscriptionId?: string | null;
  orderId?: string | null;
  invoiceId?: string | null;
  trialDays?: number;
}

async function isFirstPurchase(db: Db, subject: Subject): Promise<boolean> {
  return !(await db.maybe(sql`SELECT 1 FROM orders WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND status IN ('paid', 'partially_refunded') LIMIT 1`));
}

export async function createCheckout(db: Db, app: App, input: CheckoutInput): Promise<CheckoutResponse> {
  const { price, product } = await loadPrice(db, input.priceId);
  if (!price.active || product.status !== 'active') throw validationError([{ path: ['priceId'], message: 'This plan is not available' }]);
  assertSubjectMatchesProduct(product, input.subject);
  const perSeat = price.pricing_model === 'per_seat';
  const quantity = perSeat || price.type === 'one_time' ? input.quantity : 1;
  if (quantity < price.min_quantity || (price.max_quantity && quantity > price.max_quantity)) {
    throw validationError([{ path: ['quantity'], message: `Quantity must be between ${price.min_quantity} and ${price.max_quantity ?? 'unlimited'}` }]);
  }
  if (price.type === 'recurring' && product.kind === 'plan') {
    const existing = await db.maybe(sql`
      SELECT s.id FROM subscriptions s JOIN products p ON p.id = s.product_id
      WHERE s.subject_type = ${input.subject.type} AND s.subject_id = ${input.subject.id} AND p.kind = 'plan'
        AND s.status IN ('active', 'trialing', 'past_due', 'paused')
    `);
    if (existing) throw conflict('Already subscribed to a plan; change the existing subscription instead', 'already_subscribed', { subscriptionId: (existing as any).id });
  }
  const id = newId('chk');
  // Held for this checkout until it is paid (sold) or expires (released).
  await reserveSale(db, app, { subject: input.subject, userId: input.userId, orgId: input.orgId, items: [{ product, price, quantity }], source: { type: 'checkout', id }, status: 'reserved' });

  const trialDays = price.type === 'recurring' && product.trial_days > 0 && !(await hadTrial(db, input.subject, product.id)) ? product.trial_days : 0;
  const amount = price.type === 'recurring' ? periodAmount(price, quantity, price.intro_cycles) : price.pricing_model === 'flat' ? price.unit_amount * quantity : periodAmount(price, quantity, null);
  let coupon: CouponRow | null = null;
  if (input.couponCode) {
    coupon = await validateCoupon(db, app, input.couponCode, {
      productId: product.id,
      amount,
      currency: price.currency,
      userId: input.userId,
      orgId: input.orgId,
      isFirstPurchase: await isFirstPurchase(db, input.subject),
    });
  }
  const discount = coupon ? discountAmount(coupon, amount) : 0;
  const tax = await taxFor(db, app, input.subject);
  const taxed = computeTax(amount - discount, tax.rateBps, price.tax_behavior === 'inclusive');
  const now = app.clock.now();
  const totals = { subtotal: amount, discount, tax: taxed.tax, total: taxed.total, currency: price.currency };
  const base = {
    id,
    subject_type: input.subject.type,
    subject_id: input.subject.id,
    user_id: input.userId,
    org_id: input.orgId,
    kind: 'purchase',
    price_id: price.id,
    product_id: product.id,
    quantity,
    coupon_id: coupon?.id ?? null,
    subtotal: amount,
    discount,
    tax: taxed.tax,
    total: taxed.total,
    currency: price.currency,
    trial_days: trialDays,
    success_url: input.successUrl ?? null,
    cancel_url: input.cancelUrl ?? null,
    expires_at: new Date(now.getTime() + settingsOf(app).checkoutExpiryHours * HOUR),
    metadata: input.metadata ?? {},
    created_at: now,
  };

  // Trials without a payment method and free purchases complete immediately.
  if ((trialDays > 0 && !product.trial_requires_payment_method) || taxed.total === 0) {
    await db.exec(sql.insert('checkout_sessions', { ...base, status: 'open' }, ''));
    const result = await fulfillCheckout(db, app, id, null);
    const row = await db.one<any>(sql`SELECT * FROM checkout_sessions WHERE id = ${id}`);
    return { id, status: 'completed', url: input.successUrl ?? null, amount: totals, subscriptionId: result.subscriptionId, orderId: row.order_id, invoiceId: row.invoice_id, trialDays };
  }

  const gateway = await pickGateway(db, app, price.currency, input.gatewayId);
  const adapter = adapterFor(app, gateway.adapter);
  await db.exec(sql.insert('checkout_sessions', { ...base, status: 'open', gateway_id: gateway.id }, ''));
  const details = await customerDetails(db, input.subject);
  const profile = await db.maybe<{ gateway_customers: Record<string, string> }>(sql`SELECT gateway_customers FROM billing_profiles WHERE subject_type = ${input.subject.type} AND subject_id = ${input.subject.id}`);
  const fallbackUrl = `${app.config.appUrl}/pay/complete/${id}?token=${payToken(app, id)}`;
  const session = await adapter.createCheckout(await gatewayContext(db, app, gateway), {
    checkoutId: id,
    amount: taxed.total,
    currency: price.currency,
    description: product.name + (trialDays ? ` (${trialDays}-day trial, then the first period paid now)` : '') + installmentLabel(price, 1),
    lineItems: [{ description: product.name, amount: taxed.total, quantity: 1 }],
    customer: { id: input.subject.id, email: (details.email as string) ?? null, name: (details.name as string) ?? null, gatewayCustomerRef: profile?.gateway_customers?.[gateway.id] ?? null },
    successUrl: input.successUrl ?? fallbackUrl,
    cancelUrl: input.cancelUrl ?? fallbackUrl,
    savePaymentMethod: price.type === 'recurring' && adapter.capabilities.savePaymentMethod,
    metadata: { checkout_id: id, subject: `${input.subject.type}:${input.subject.id}` },
  });
  await db.exec(sql`UPDATE checkout_sessions SET url = ${session.url}, gateway_session_id = ${session.gatewaySessionId} WHERE id = ${id}`);
  await app.events.emit(db, 'checkout.created', { checkoutId: id, priceId: price.id, total: taxed.total, currency: price.currency }, scopeOfSubject(input.subject));
  return { id, status: 'open', url: session.url, amount: totals, trialDays };
}

/** Pay an existing open invoice through a gateway (renewal invoices, manual invoices, pay links). */
export async function createInvoiceCheckout(db: Db, app: App, invoiceId: string, opts: { gatewayId?: string | null; successUrl?: string | null; cancelUrl?: string | null }): Promise<{ id: string; url: string }> {
  const inv = await db.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${invoiceId}`);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'open') throw conflict(`This invoice is ${inv.status}`, 'invoice_not_payable');
  const gateway = await pickGateway(db, app, inv.currency, opts.gatewayId);
  const adapter = adapterFor(app, gateway.adapter);
  const now = app.clock.now();
  const id = newId('chk');
  const due = inv.amount_due - inv.amount_paid;
  // Invoices that start or renew a subscription keep the card for its renewals.
  const recurring = Boolean(inv.subscription_id) || Boolean(await db.maybe(sql`SELECT 1 FROM invoice_lines WHERE invoice_id = ${inv.id} AND type = 'subscription' LIMIT 1`));
  await db.exec(sql.insert('checkout_sessions', {
    id,
    subject_type: inv.subject_type,
    subject_id: inv.subject_id,
    user_id: inv.user_id,
    org_id: inv.org_id,
    kind: 'invoice',
    status: 'open',
    invoice_id: inv.id,
    subtotal: due,
    total: due,
    currency: inv.currency,
    gateway_id: gateway.id,
    success_url: opts.successUrl ?? null,
    cancel_url: opts.cancelUrl ?? null,
    expires_at: new Date(now.getTime() + settingsOf(app).checkoutExpiryHours * HOUR),
    created_at: now,
  }, ''));
  const subject: Subject = { type: inv.subject_type, id: inv.subject_id };
  const details = await customerDetails(db, subject);
  const fallbackUrl = `${app.config.appUrl}/pay/complete/${id}?token=${payToken(app, id)}`;
  const session = await adapter.createCheckout(await gatewayContext(db, app, gateway), {
    checkoutId: id,
    amount: due,
    currency: inv.currency,
    description: `Invoice ${inv.number}`,
    lineItems: [{ description: `Invoice ${inv.number}`, amount: due, quantity: 1 }],
    customer: { id: subject.id, email: (details.email as string) ?? null, name: (details.name as string) ?? null, gatewayCustomerRef: null },
    successUrl: opts.successUrl ?? fallbackUrl,
    cancelUrl: opts.cancelUrl ?? fallbackUrl,
    savePaymentMethod: recurring && adapter.capabilities.savePaymentMethod,
    metadata: { checkout_id: id, invoice_id: inv.id },
  });
  await db.exec(sql`UPDATE checkout_sessions SET url = ${session.url}, gateway_session_id = ${session.gatewaySessionId} WHERE id = ${id}`);
  return { id, url: session.url };
}

export interface PaymentDetails {
  gatewayId: string;
  gatewayPaymentId: string;
  amount: number;
  currency: string;
  method?: PaymentMethodInfo | null;
  customerRef?: string | null;
  paymentMethodRef?: string | null;
  fee?: number | null;
}

async function savePaymentMethod(db: Db, app: App, subject: Subject, p: PaymentDetails): Promise<string | null> {
  if (p.customerRef) {
    await db.exec(sql`
      INSERT INTO billing_profiles (id, subject_type, subject_id, gateway_customers, created_at, updated_at)
      VALUES (${newId('bpr')}, ${subject.type}, ${subject.id}, ${sql.json({ [p.gatewayId]: p.customerRef })}, ${app.clock.now()}, ${app.clock.now()})
      ON CONFLICT (subject_type, subject_id) DO UPDATE SET gateway_customers = billing_profiles.gateway_customers || EXCLUDED.gateway_customers, updated_at = EXCLUDED.updated_at
    `);
  }
  if (!p.paymentMethodRef) return null;
  await db.exec(sql`UPDATE payment_methods SET is_default = FALSE WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}`);
  const row = await db.one<{ id: string }>(sql`
    INSERT INTO payment_methods (id, subject_type, subject_id, gateway_id, gateway_ref, customer_ref, type, brand, last4, exp_month, exp_year, is_default, created_at)
    VALUES (${newId('pm')}, ${subject.type}, ${subject.id}, ${p.gatewayId}, ${p.paymentMethodRef}, ${p.customerRef ?? null}, ${p.method?.type ?? 'card'},
            ${p.method?.brand ?? null}, ${p.method?.last4 ?? null}, ${p.method?.expMonth ?? null}, ${p.method?.expYear ?? null}, TRUE, ${app.clock.now()})
    ON CONFLICT (gateway_id, gateway_ref) DO UPDATE SET is_default = TRUE, detached_at = NULL,
      brand = coalesce(EXCLUDED.brand, payment_methods.brand), last4 = coalesce(EXCLUDED.last4, payment_methods.last4),
      exp_month = coalesce(EXCLUDED.exp_month, payment_methods.exp_month), exp_year = coalesce(EXCLUDED.exp_year, payment_methods.exp_year)
    RETURNING id
  `);
  return row.id;
}

/**
 * Turn a paid (or free) checkout into an order, a paid invoice and either a
 * subscription or a lifetime entitlement. Idempotent: gateways retry webhooks
 * and customers return to success pages, so a completed checkout is a no-op.
 */
export async function fulfillCheckout(db: Db, app: App, checkoutId: string, payment: PaymentDetails | null): Promise<{ fulfilled: boolean; duplicate?: boolean; subscriptionId?: string | null }> {
  return db.tx(async (tx) => {
    const chk = await tx.maybe<any>(sql`SELECT * FROM checkout_sessions WHERE id = ${checkoutId} FOR UPDATE`);
    if (!chk) throw notFound('Checkout session');
    if (chk.status === 'completed') return { fulfilled: false, duplicate: true };
    const subject: Subject = { type: chk.subject_type, id: chk.subject_id };
    const scope = scopeOfSubject(subject);
    const now = app.clock.now();

    if (payment && (payment.amount < chk.total || payment.currency !== chk.currency)) {
      await recordPayment(tx, app, { invoiceId: chk.invoice_id, subject, userId: chk.user_id, orgId: chk.org_id, gatewayId: payment.gatewayId, gatewayPaymentId: payment.gatewayPaymentId, amount: payment.amount, currency: payment.currency, status: 'succeeded', method: payment.method });
      await tx.exec(sql`UPDATE checkout_sessions SET status = 'failed', failure_message = 'amount_mismatch' WHERE id = ${chk.id}`);
      await releaseSale(tx, app, { type: 'checkout', id: chk.id });
      await notifyAdmins(tx, app, { permission: 'billing.payments.view', type: 'billing.amount_mismatch', title: 'Payment amount mismatch', body: `Checkout ${chk.id} expected ${chk.total} ${chk.currency}, received ${payment.amount} ${payment.currency}. Review before fulfilling.`, severity: 'critical', link: '/revenue/payments' });
      return { fulfilled: false };
    }

    if (chk.kind === 'invoice') {
      if (payment) {
        await recordPayment(tx, app, { invoiceId: chk.invoice_id, subject, userId: chk.user_id, orgId: chk.org_id, gatewayId: payment.gatewayId, gatewayPaymentId: payment.gatewayPaymentId, amount: payment.amount, currency: payment.currency, status: 'succeeded', method: payment.method, fee: payment.fee });
        const pmId = await savePaymentMethod(tx, app, subject, payment);
        await settleInvoice(tx, app, chk.invoice_id, payment.amount);
        const inv = await tx.one<{ subscription_id: string | null }>(sql`SELECT subscription_id FROM invoices WHERE id = ${chk.invoice_id}`);
        if (pmId && inv.subscription_id) await tx.exec(sql`UPDATE subscriptions SET payment_method_id = ${pmId}, collection_method = 'charge_automatically' WHERE id = ${inv.subscription_id}`);
      }
      await tx.exec(sql`UPDATE checkout_sessions SET status = 'completed', completed_at = ${now} WHERE id = ${chk.id}`);
      await app.events.emit(tx, 'checkout.completed', { checkoutId: chk.id, invoiceId: chk.invoice_id, kind: 'invoice' }, scope);
      return { fulfilled: true };
    }

    const { price, product } = await loadPrice(tx, chk.price_id);
    const coupon = chk.coupon_id ? await tx.maybe<CouponRow>(sql`SELECT * FROM coupons WHERE id = ${chk.coupon_id}`) : null;
    const trialing = chk.trial_days > 0 && !payment;
    const s = settingsOf(app);

    const orderId = newId('ord');
    await tx.exec(sql.insert('orders', {
      id: orderId,
      number: await nextNumber(tx, s.orderPrefix, now),
      subject_type: subject.type,
      subject_id: subject.id,
      user_id: chk.user_id,
      org_id: chk.org_id,
      type: price.type === 'recurring' ? 'subscription' : 'one_time',
      status: 'paid',
      currency: chk.currency,
      subtotal: chk.subtotal,
      discount_total: chk.discount,
      tax_total: chk.tax,
      total: chk.total,
      coupon_id: chk.coupon_id,
      checkout_id: chk.id,
      metadata: chk.metadata,
      created_at: now,
      paid_at: now,
    }, ''));
    await tx.exec(sql.insert('order_items', { id: newId('oit'), order_id: orderId, product_id: product.id, price_id: price.id, description: product.name, quantity: chk.quantity, unit_amount: chk.subtotal, amount: chk.subtotal, discount_amount: chk.discount, tax_amount: chk.tax }, ''));
    await commitSale(tx, app, { type: 'checkout', id: chk.id }, orderId);

    let invoiceId: string | null = null;
    if (!trialing) {
      const invoice = await createInvoice(tx, app, {
        subject,
        userId: chk.user_id,
        orgId: chk.org_id,
        currency: chk.currency,
        billingReason: 'checkout',
        orderId,
        applyBalance: false,
        lines: [{
          type: price.type === 'recurring' ? 'subscription' : 'one_time',
          description: product.name + (chk.quantity > 1 ? ` × ${chk.quantity}` : '') + (price.access_days ? ` (${price.access_days} days of access)` : '') + installmentLabel(price, 1),
          productId: product.id,
          priceId: price.id,
          quantity: chk.quantity,
          unitAmount: chk.subtotal,
          amount: chk.subtotal,
          discountAmount: chk.discount,
          taxInclusive: price.tax_behavior === 'inclusive',
        }],
      });
      invoiceId = invoice.id as string;
      if (payment) {
        await recordPayment(tx, app, { invoiceId, orderId, subject, userId: chk.user_id, orgId: chk.org_id, gatewayId: payment.gatewayId, gatewayPaymentId: payment.gatewayPaymentId, amount: payment.amount, currency: payment.currency, status: 'succeeded', method: payment.method, fee: payment.fee });
        await settleInvoice(tx, app, invoice.id, payment.amount);
      }
      await tx.exec(sql`UPDATE orders SET invoice_id = ${invoiceId} WHERE id = ${orderId}`);
    }
    if (coupon) {
      try {
        await tx.tx((inner) => redeemCoupon(inner, app, coupon.id, { userId: chk.user_id, orgId: chk.org_id, orderId, discount: chk.discount, currency: chk.currency }));
      } catch (err) {
        app.log.warn({ err, couponId: coupon.id }, 'coupon exhausted after payment; honouring the paid discount');
      }
    }
    const pmId = payment ? await savePaymentMethod(tx, app, subject, payment) : null;

    let subscriptionId: string | null = null;
    if (price.type === 'recurring') {
      const adapter = payment ? adapterFor(app, (await tx.one<{ adapter: string }>(sql`SELECT adapter FROM payment_gateways WHERE id = ${payment.gatewayId}`)).adapter) : null;
      const sub = await startSubscription(tx, app, {
        subject,
        userId: chk.user_id,
        orgId: chk.org_id,
        price,
        product,
        quantity: chk.quantity,
        coupon,
        trialDays: chk.trial_days,
        collectionMethod: pmId && adapter?.capabilities.offSessionCharge ? 'charge_automatically' : 'send_invoice',
        gatewayId: payment?.gatewayId ?? null,
        paymentMethodId: pmId,
        checkoutId: chk.id,
        firstInvoicePaid: !trialing,
      });
      subscriptionId = sub.id;
      await tx.exec(sql`UPDATE orders SET subscription_id = ${sub.id} WHERE id = ${orderId}`);
      if (invoiceId) {
        // Paid before a trial (one that required a payment method), it pays for the first period after the trial.
        const start: Date = sub.status === 'trialing' ? sub.current_period_end : sub.current_period_start;
        const end: Date = sub.status === 'trialing' ? addInterval(start, price.interval!, price.interval_count) : sub.current_period_end;
        await tx.exec(sql`UPDATE invoices SET subscription_id = ${sub.id}, period_start = ${start}, period_end = ${end} WHERE id = ${invoiceId}`);
      }
    } else {
      await grantOneTimePurchase(tx, app, subject, product, chk.quantity, orderId, price.access_days);
    }

    await tx.exec(sql`UPDATE checkout_sessions SET status = 'completed', completed_at = ${now}, order_id = ${orderId}, invoice_id = ${invoiceId} WHERE id = ${chk.id}`);
    await app.events.emit(tx, 'order.paid', { orderId, checkoutId: chk.id, total: chk.total, currency: chk.currency, productId: product.id, couponId: chk.coupon_id, subscriptionId, firstPurchase: true }, scope);
    await app.events.emit(tx, 'checkout.completed', { checkoutId: chk.id, orderId, subscriptionId, invoiceId, kind: 'purchase' }, scope);
    return { fulfilled: true, subscriptionId };
  });
}

/**
 * Process normalized gateway events exactly once each. The inbox table makes
 * webhook retries idempotent; failures are recorded and can be reprocessed.
 */
export async function processGatewayEvents(app: App, gatewayId: string, events: GatewayEvent[]): Promise<{ processed: number; duplicates: number }> {
  let processed = 0;
  let duplicates = 0;
  for (const event of events) {
    const now = app.clock.now();
    const inserted = await app.db.maybe<{ id: string }>(sql`
      INSERT INTO gateway_events (id, gateway_id, event_id, type, payload, status, received_at)
      VALUES (${newId('gev')}, ${gatewayId}, ${event.eventId}, ${event.type}, ${sql.json(event)}, 'received', ${now})
      ON CONFLICT (gateway_id, event_id) DO NOTHING RETURNING id
    `);
    let rowId = inserted?.id;
    if (!rowId) {
      const existing = await app.db.one<{ id: string; status: string }>(sql`SELECT id, status FROM gateway_events WHERE gateway_id = ${gatewayId} AND event_id = ${event.eventId}`);
      if (existing.status === 'processed' || existing.status === 'ignored') {
        duplicates++;
        continue;
      }
      rowId = existing.id;
    }
    try {
      const status = await app.db.tx((tx) => applyGatewayEvent(tx, app, gatewayId, event));
      await app.db.exec(sql`UPDATE gateway_events SET status = ${status}, attempts = attempts + 1, error = NULL, processed_at = ${app.clock.now()} WHERE id = ${rowId}`);
      processed++;
    } catch (err) {
      await app.db.exec(sql`UPDATE gateway_events SET status = 'failed', attempts = attempts + 1, error = ${(err as Error).message.slice(0, 2000)} WHERE id = ${rowId}`);
      throw err;
    }
  }
  return { processed, duplicates };
}

async function applyGatewayEvent(tx: Db, app: App, gatewayId: string, event: GatewayEvent): Promise<'processed' | 'ignored'> {
  switch (event.type) {
    case 'payment.succeeded': {
      const payment: PaymentDetails = { gatewayId, gatewayPaymentId: event.gatewayPaymentId, amount: event.amount, currency: event.currency, method: event.method, customerRef: event.customerRef, paymentMethodRef: event.paymentMethodRef, fee: event.fee };
      if (event.checkoutId) {
        await fulfillCheckout(tx, app, event.checkoutId, payment);
        return 'processed';
      }
      if (event.invoiceId) {
        const inv = await tx.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${event.invoiceId}`);
        if (!inv) return 'ignored';
        const { created } = await recordPayment(tx, app, { invoiceId: inv.id, subject: { type: inv.subject_type, id: inv.subject_id }, userId: inv.user_id, orgId: inv.org_id, gatewayId, gatewayPaymentId: event.gatewayPaymentId, amount: event.amount, currency: event.currency, status: 'succeeded', method: event.method, fee: event.fee });
        if (created) await settleInvoice(tx, app, inv.id, event.amount);
        return 'processed';
      }
      return 'ignored';
    }
    case 'payment.failed': {
      if (event.checkoutId) {
        await tx.exec(sql`UPDATE checkout_sessions SET failure_message = ${event.failureMessage} WHERE id = ${event.checkoutId} AND status = 'open'`);
        const chk = await tx.maybe<any>(sql`SELECT subject_type, subject_id FROM checkout_sessions WHERE id = ${event.checkoutId}`);
        if (chk) await app.events.emit(tx, 'checkout.payment_failed', { checkoutId: event.checkoutId, failureCode: event.failureCode, message: event.failureMessage }, scopeOfSubject({ type: chk.subject_type, id: chk.subject_id }));
        return 'processed';
      }
      return 'ignored';
    }
    case 'refund.succeeded': {
      const payment = await tx.maybe<any>(sql`SELECT * FROM payments WHERE gateway_id = ${gatewayId} AND gateway_payment_id = ${event.gatewayPaymentId}`);
      if (!payment) return 'ignored';
      await applyRefundFromGateway(tx, app, payment, event.gatewayRefundId, event.amount);
      return 'processed';
    }
    case 'refund.failed': {
      await tx.exec(sql`UPDATE refunds SET status = 'failed', failure_message = ${event.failureMessage}, processed_at = ${app.clock.now()} WHERE gateway_refund_id = ${event.gatewayRefundId} AND status = 'pending'`);
      return 'processed';
    }
    case 'dispute.created': {
      const payment = await tx.maybe<any>(sql`SELECT * FROM payments WHERE gateway_id = ${gatewayId} AND gateway_payment_id = ${event.gatewayPaymentId}`);
      const row = await tx.maybe<{ id: string }>(sql`
        INSERT INTO disputes (id, payment_id, gateway_id, gateway_dispute_id, amount, currency, reason, status, evidence_due_by, created_at)
        VALUES (${newId('dsp')}, ${payment?.id ?? null}, ${gatewayId}, ${event.gatewayDisputeId}, ${event.amount}, ${event.currency}, ${event.reason}, 'needs_response', ${event.evidenceDueBy ?? null}, ${app.clock.now()})
        ON CONFLICT (gateway_id, gateway_dispute_id) DO NOTHING RETURNING id
      `);
      if (!row) return 'processed';
      if (payment) {
        await tx.exec(sql`UPDATE payments SET status = 'disputed' WHERE id = ${payment.id}`);
        const scope = scopeOfSubject({ type: payment.subject_type, id: payment.subject_id });
        await app.events.emit(tx, 'dispute.created', { disputeId: row.id, paymentId: payment.id, amount: event.amount, currency: event.currency, reason: event.reason }, scope);
        if (settingsOf(app).suspendOnChargeback && payment.user_id) {
          await tx.exec(sql`UPDATE users SET status = 'suspended', status_reason = 'Chargeback opened', updated_at = ${app.clock.now()} WHERE id = ${payment.user_id} AND status = 'active'`);
          await writeAudit(tx, app, { actor: { type: 'system', id: null, label: 'Chargeback policy' }, action: 'user.suspend', targetType: 'user', targetId: payment.user_id, metadata: { reason: 'chargeback', disputeId: row.id } });
        }
      }
      await notifyAdmins(tx, app, { permission: 'billing.payments.view', type: 'dispute.created', title: 'New chargeback', body: `${event.amount} ${event.currency} disputed (${event.reason ?? 'no reason given'})`, link: '/revenue/disputes', severity: 'critical' });
      return 'processed';
    }
    case 'dispute.closed': {
      const d = await tx.maybe<any>(sql`
        UPDATE disputes SET status = ${event.outcome}, closed_at = ${app.clock.now()} WHERE gateway_id = ${gatewayId} AND gateway_dispute_id = ${event.gatewayDisputeId} RETURNING *
      `);
      if (!d) return 'ignored';
      if (d.payment_id) {
        const payment = await tx.one<any>(sql`SELECT * FROM payments WHERE id = ${d.payment_id}`);
        if (event.outcome === 'won') await tx.exec(sql`UPDATE payments SET status = CASE WHEN amount_refunded > 0 THEN 'partially_refunded' ELSE 'succeeded' END WHERE id = ${d.payment_id}`);
        await app.events.emit(tx, event.outcome === 'won' ? 'dispute.won' : 'dispute.lost', { disputeId: d.id, paymentId: d.payment_id, amount: d.amount, currency: d.currency }, scopeOfSubject({ type: payment.subject_type, id: payment.subject_id }));
      }
      return 'processed';
    }
    case 'ignored':
      return 'ignored';
  }
}

/**
 * Abandoned checkouts expire: what they held in stock is released, and a cart whose checkout
 * expired unpaid is voided (unless another checkout for it is still open).
 */
export async function expireCheckouts(app: App): Promise<number> {
  let expired = 0;
  for (;;) {
    const due = await app.db.many<{ id: string }>(sql`SELECT id FROM checkout_sessions WHERE status = 'open' AND expires_at <= ${app.clock.now()} ORDER BY expires_at LIMIT 200`);
    for (const { id } of due) {
      await app.db.tx(async (tx) => {
        const chk = await tx.maybe<{ id: string; kind: string; invoice_id: string | null; subject_type: Subject['type']; subject_id: string }>(sql`
          UPDATE checkout_sessions SET status = 'expired' WHERE id = ${id} AND status = 'open' RETURNING id, kind, invoice_id, subject_type, subject_id
        `);
        if (!chk) return;
        expired++;
        await app.events.emit(tx, 'checkout.expired', { checkoutId: chk.id }, scopeOfSubject({ type: chk.subject_type, id: chk.subject_id }));
        if (chk.kind === 'purchase') await releaseSale(tx, app, { type: 'checkout', id: chk.id });
        else if (chk.invoice_id) await abandonCart(tx, app, chk.invoice_id);
      });
    }
    if (due.length < 200) return expired;
  }
}

async function abandonCart(db: Db, app: App, invoiceId: string): Promise<void> {
  const inv = await db.maybe<{ status: string; amount_paid: number }>(sql`
    SELECT i.status, i.amount_paid FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.id = ${invoiceId} AND o.metadata->>'source' = 'cart'
  `);
  if (!inv || inv.status !== 'open' || inv.amount_paid > 0) return;
  if (await db.maybe(sql`SELECT 1 FROM checkout_sessions WHERE invoice_id = ${invoiceId} AND status = 'open' LIMIT 1`)) return;
  await voidInvoice(db, app, invoiceId, { type: 'system', id: null, label: 'Abandoned cart' });
}

export function assertCheckoutReturnable(chk: any): void {
  if (!chk) throw new AppError(404, 'not_found', 'Checkout not found');
}
