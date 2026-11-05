import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { adapterFor, gatewayContext, type GatewayRow } from './gateways/registry.js';
import { cancelSubscription, convert, nextNumber, scopeOfSubject, settingsOf } from './engine.js';
import { requestApproval } from '../iam/approvals.js';
import type { Subject } from '../catalog/entitlements.js';
import { releaseOrder } from '../catalog/purchases.js';

export interface RefundInput {
  paymentId: string;
  amount: number;
  reason: string | null;
  revokeAccess: boolean;
  actor: Actor;
  scope: string[] | null;
}

async function lockPayment(db: Db, id: string, scope: string[] | null): Promise<any> {
  const p = await db.maybe(sql`
    SELECT * FROM payments p WHERE p.id = ${id}
    ${scope ? sql`AND (p.org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p.user_id AND m.org_id IN ${sql.in(scope)}))` : sql.empty}
    FOR UPDATE
  `);
  if (!p) throw notFound('Payment');
  return p;
}

function assertRefundable(payment: any, amount: number): void {
  if (!['succeeded', 'partially_refunded', 'disputed'].includes(payment.status)) throw conflict(`A ${payment.status} payment cannot be refunded`, 'not_refundable');
  const remaining = payment.amount - payment.amount_refunded;
  if (amount <= 0 || amount > remaining) throw validationError([{ path: ['amount'], message: `Refund between 1 and ${remaining} (${payment.currency} minor units)` }]);
}

/**
 * Entry point for admin refunds. Amounts at or above the approval threshold are
 * parked for a second administrator (separation of duties); smaller ones run now.
 */
export async function requestRefund(db: Db, app: App, input: RefundInput & { adminId: string }): Promise<{ status: 'requires_approval'; approvalId: string } | { status: string; refund: any }> {
  const payment = await lockPayment(db, input.paymentId, input.scope);
  assertRefundable(payment, input.amount);
  const threshold = settingsOf(app).refundApprovalThreshold;
  if (threshold > 0 && input.amount >= threshold) {
    const { id } = await requestApproval(db, app, {
      action: 'billing.refund',
      requestedBy: input.adminId,
      summary: `Refund ${input.amount} ${payment.currency} on payment ${payment.id}${input.reason ? ` — ${input.reason}` : ''}`,
      payload: { paymentId: payment.id, amount: input.amount, reason: input.reason, revokeAccess: input.revokeAccess },
      targetType: 'payment',
      targetId: payment.id,
      amount: input.amount,
      currency: payment.currency,
      reason: input.reason ?? undefined,
    });
    await writeAudit(db, app, { actor: input.actor, action: 'refund.requested', targetType: 'payment', targetId: payment.id, metadata: { amount: input.amount, approvalId: id } });
    return { status: 'requires_approval', approvalId: id };
  }
  const refund = await executeRefund(db, app, input);
  return { status: refund.status, refund };
}

export async function executeRefund(db: Db, app: App, input: RefundInput & { approvalId?: string | null }): Promise<any> {
  const payment = await lockPayment(db, input.paymentId, input.scope);
  assertRefundable(payment, input.amount);
  const now = app.clock.now();
  const refundId = newId('ref');
  await db.exec(sql.insert('refunds', {
    id: refundId,
    payment_id: payment.id,
    amount: input.amount,
    currency: payment.currency,
    reason: input.reason,
    status: 'pending',
    requested_by: input.actor.id,
    approval_id: input.approvalId ?? null,
    revoke_access: input.revokeAccess,
    created_at: now,
  }, ''));

  if (payment.gateway_id) {
    const gw = await db.one<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${payment.gateway_id}`);
    const adapter = adapterFor(app, gw.adapter);
    if (!adapter.capabilities.refunds || !adapter.refund) throw new AppError(422, 'refunds_unsupported', `${adapter.name} does not support refunds through the platform`);
    if (input.amount < payment.amount - payment.amount_refunded && !adapter.capabilities.partialRefunds) throw new AppError(422, 'partial_refunds_unsupported', `${adapter.name} does not support partial refunds`);
    const result = await adapter.refund(await gatewayContext(db, app, gw), {
      gatewayPaymentId: payment.gateway_payment_id,
      amount: input.amount,
      currency: payment.currency,
      reason: input.reason,
      idempotencyKey: refundId,
    });
    if (result.status === 'failed') {
      await db.exec(sql`UPDATE refunds SET status = 'failed', failure_message = ${result.failureMessage}, processed_at = ${now} WHERE id = ${refundId}`);
      await writeAudit(db, app, { actor: input.actor, action: 'refund.failed', targetType: 'payment', targetId: payment.id, metadata: { refundId, error: result.failureMessage } });
      return db.one(sql`SELECT * FROM refunds WHERE id = ${refundId}`);
    }
    await db.exec(sql`UPDATE refunds SET gateway_refund_id = ${result.gatewayRefundId} WHERE id = ${refundId}`);
    if (result.status === 'pending') {
      await writeAudit(db, app, { actor: input.actor, action: 'refund.create', targetType: 'payment', targetId: payment.id, metadata: { refundId, amount: input.amount, pending: true } });
      return db.one(sql`SELECT * FROM refunds WHERE id = ${refundId}`);
    }
  }
  await completeRefund(db, app, refundId);
  await writeAudit(db, app, { actor: input.actor, action: 'refund.create', targetType: 'payment', targetId: payment.id, metadata: { refundId, amount: input.amount, reason: input.reason } });
  return db.one(sql`SELECT * FROM refunds WHERE id = ${refundId}`);
}

/** Book a successful refund: payment/invoice/order totals, credit note, revenue, access revocation, events. */
export async function completeRefund(db: Db, app: App, refundId: string): Promise<void> {
  const refund = await db.one<any>(sql`SELECT * FROM refunds WHERE id = ${refundId} FOR UPDATE`);
  if (refund.status === 'succeeded') return;
  const payment = await db.one<any>(sql`SELECT * FROM payments WHERE id = ${refund.payment_id} FOR UPDATE`);
  const now = app.clock.now();
  const refunded = payment.amount_refunded + refund.amount;
  const full = refunded >= payment.amount;
  await db.exec(sql`UPDATE payments SET amount_refunded = ${refunded}, status = ${full ? 'refunded' : 'partially_refunded'} WHERE id = ${payment.id}`);
  const subject: Subject = { type: payment.subject_type, id: payment.subject_id };
  const creditNoteId = newId('cn');
  await db.exec(sql.insert('credit_notes', {
    id: creditNoteId,
    number: await nextNumber(db, settingsOf(app).creditNotePrefix, now),
    invoice_id: payment.invoice_id,
    refund_id: refund.id,
    subject_type: subject.type,
    subject_id: subject.id,
    amount: refund.amount,
    currency: refund.currency,
    reason: refund.reason,
    created_at: now,
  }, ''));
  await db.exec(sql`UPDATE refunds SET status = 'succeeded', credit_note_id = ${creditNoteId}, processed_at = ${now} WHERE id = ${refund.id}`);
  if (payment.invoice_id) await db.exec(sql`UPDATE invoices SET amount_refunded = amount_refunded + ${refund.amount}, updated_at = ${now} WHERE id = ${payment.invoice_id}`);
  const inv = payment.invoice_id ? await db.maybe<{ subscription_id: string | null; order_id: string | null }>(sql`SELECT subscription_id, order_id FROM invoices WHERE id = ${payment.invoice_id}`) : null;
  // Payments made through an invoice's pay link carry the invoice, not its order.
  const orderId: string | null = payment.order_id ?? inv?.order_id ?? null;
  if (orderId) await db.exec(sql`UPDATE orders SET status = ${full ? 'refunded' : 'partially_refunded'} WHERE id = ${orderId}`);
  const base = settingsOf(app).baseCurrency;
  const converted = (await convert(db, refund.amount, refund.currency, base)) ?? refund.amount;
  if (payment.user_id) await db.exec(sql`UPDATE users SET lifetime_revenue = GREATEST(0, lifetime_revenue - ${converted}) WHERE id = ${payment.user_id}`);

  const scope = scopeOfSubject(subject);
  await app.events.emit(db, 'refund.succeeded', { refundId: refund.id, paymentId: payment.id, amount: refund.amount, currency: refund.currency, full, orderId: payment.order_id, invoiceId: payment.invoice_id, creditNoteId }, scope);

  if (refund.revoke_access && full) {
    const actor: Actor = { type: 'system', id: null, label: 'Refund' };
    if (inv?.subscription_id) await cancelSubscription(db, app, { subscriptionId: inv.subscription_id, atPeriodEnd: false, reason: 'refunded', actor, scope: null });
    // What the order granted, and a product kept for good after a subscription's last installment.
    const refs = [orderId, inv?.subscription_id].filter((ref): ref is string => Boolean(ref));
    if (refs.length) {
      const n = await db.exec(sql`UPDATE entitlement_grants SET revoked_at = ${now} WHERE source = 'purchase' AND source_ref IN ${sql.in(refs)} AND revoked_at IS NULL`);
      if (n) await app.events.emit(db, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'refund' }, scope);
    }
    // The sale is undone: its units return to stock and no longer count against the customer's limit.
    if (orderId) await releaseOrder(db, app, orderId);
  }
}

/** Refunds initiated in the gateway dashboard (or confirmations of pending ones) arrive via webhook. */
export async function applyRefundFromGateway(db: Db, app: App, payment: any, gatewayRefundId: string, amount: number): Promise<void> {
  const existing = await db.maybe<{ id: string; status: string }>(sql`SELECT id, status FROM refunds WHERE payment_id = ${payment.id} AND gateway_refund_id = ${gatewayRefundId}`);
  if (existing) {
    if (existing.status !== 'succeeded') await completeRefund(db, app, existing.id);
    return;
  }
  const remaining = payment.amount - payment.amount_refunded;
  const id = newId('ref');
  await db.exec(sql.insert('refunds', {
    id,
    payment_id: payment.id,
    amount: Math.min(amount, remaining),
    currency: payment.currency,
    reason: 'Refunded in gateway dashboard',
    status: 'pending',
    gateway_refund_id: gatewayRefundId,
    created_at: app.clock.now(),
  }, ''));
  await completeRefund(db, app, id);
}
