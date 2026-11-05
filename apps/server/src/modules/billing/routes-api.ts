import { z } from 'zod';
import type { Router, RouteContext } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { forbidden, notFound } from '../../core/errors.js';
import { pageQuery } from '../../core/validation.js';
import { subjectFor, type Subject } from '../catalog/entitlements.js';
import { cancelSubscription, changeSubscription, reactivateSubscription, pauseSubscription, resumeSubscription } from './engine.js';
import { createCheckout, createInvoiceCheckout, payToken } from './checkout.js';
import { checkoutCart } from './cart.js';
import { billingProfileBody, invoicePdf, upsertBillingProfile } from './routes-admin.js';

export function presentSubscription(s: any) {
  return {
    id: s.id,
    status: s.status,
    productId: s.product_id,
    productKey: s.product_key ?? undefined,
    productName: s.product_name ?? undefined,
    priceId: s.price_id,
    quantity: s.quantity,
    currency: s.currency,
    unitAmount: s.unit_amount ?? undefined,
    interval: s.interval ?? undefined,
    intervalCount: s.interval_count ?? undefined,
    currentPeriodStart: s.current_period_start,
    currentPeriodEnd: s.current_period_end,
    trialEnd: s.trial_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    canceledAt: s.canceled_at,
    endedAt: s.ended_at,
    pausedAt: s.paused_at,
    scheduledChange: s.scheduled_change,
    collectionMethod: s.collection_method,
    /** Prices paid in installments: how many payments in all, and how many are paid. */
    installments: typeof s.payment_count === 'number' ? { total: s.payment_count, paid: s.installments_paid, afterLastPayment: s.after_last_payment } : null,
    createdAt: s.created_at,
  };
}

export function presentInvoice(app: App, i: any) {
  return {
    id: i.id,
    number: i.number,
    status: i.status,
    currency: i.currency,
    subtotal: i.subtotal,
    discount: i.discount_total,
    tax: i.tax_total,
    total: i.total,
    amountDue: i.amount_due,
    amountPaid: i.amount_paid,
    amountRefunded: i.amount_refunded,
    periodStart: i.period_start,
    periodEnd: i.period_end,
    dueAt: i.due_at,
    paidAt: i.paid_at,
    subscriptionId: i.subscription_id,
    payUrl: i.status === 'open' ? `${app.config.appUrl}/pay/invoice/${i.id}?token=${payToken(app, i.id)}` : null,
    createdAt: i.created_at,
  };
}

async function subscriptionsFor(app: App, subject: Subject) {
  const rows = await app.db.many(sql`
    SELECT s.*, p.key AS product_key, p.name AS product_name, pr.unit_amount, pr.interval, pr.interval_count, pr.payment_count, pr.after_last_payment
    FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id
    WHERE s.subject_type = ${subject.type} AND s.subject_id = ${subject.id} ORDER BY s.created_at DESC
  `);
  return rows.map(presentSubscription);
}

async function invoicesFor(app: App, subject: Subject, page: number, pageSize: number) {
  const rows = await app.db.many(sql`
    SELECT * FROM invoices WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND status <> 'draft'
    ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `);
  return rows.map((i) => presentInvoice(app, i));
}

/** Customers may only manage subscriptions that belong to their own subject. */
async function ownSubscription(app: App, c: RouteContext, id: string): Promise<void> {
  const p = c.customer();
  const subject = p.orgId ? { type: 'organization', id: p.orgId } : { type: 'user', id: p.userId };
  const row = await app.db.maybe(sql`SELECT 1 FROM subscriptions WHERE id = ${id} AND subject_type = ${subject.type} AND subject_id = ${subject.id}`);
  if (!row) throw notFound('Subscription');
  if (p.orgId) {
    const member = await app.db.maybe<{ role: string }>(sql`SELECT role FROM memberships WHERE org_id = ${p.orgId} AND user_id = ${p.userId}`);
    if (!member || !['owner', 'admin', 'billing'].includes(member.role)) throw forbidden('Only organization owners and admins can manage billing', 'billing_role_required');
  }
}

const subjectFields = { userId: z.string().optional(), orgId: z.string().optional() };
const cartBody = z.object({
  items: z.array(z.object({ priceId: z.string(), quantity: z.number().int().min(1).max(100_000).optional() })).min(1).max(20),
  couponCode: z.string().trim().max(64).optional(),
  gatewayId: z.string().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
const checkoutBody = z.object({
  priceId: z.string(),
  quantity: z.number().int().min(1).max(100_000).default(1),
  couponCode: z.string().max(40).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  gateway: z.string().optional(),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
});

export function registerApiBillingRoutes(r: Router, app: App): void {
  // ---- Integration API --------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/v1/checkout/sessions',
    auth: 'api',
    scope: 'checkout:write',
    summary: 'Start a checkout for a plan, add-on, product or credit pack',
    description: 'Returns a `url` to redirect the customer to. Trials without payment and free purchases complete immediately (`status: completed`).',
    tags: ['Checkout'],
    body: checkoutBody.extend(subjectFields).refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
    handler: async (c) => {
      const subject = await subjectFor(app.db, c.body, c.orgScope());
      return app.db.tx((tx) =>
        createCheckout(tx, app, {
          subject,
          userId: c.body.userId ?? null,
          orgId: c.body.orgId ?? null,
          priceId: c.body.priceId,
          quantity: c.body.quantity,
          couponCode: c.body.couponCode,
          successUrl: c.body.successUrl,
          cancelUrl: c.body.cancelUrl,
          gatewayId: c.body.gateway,
          actor: c.actor,
          metadata: c.body.metadata,
        }),
      );
    },
  });

  r.route({
    method: 'POST',
    url: '/api/v1/checkout/cart',
    auth: 'api',
    scope: 'checkout:write',
    summary: 'Check out several products in one purchase',
    description:
      'Builds one invoice for the items and returns a `url` to pay it through a gateway. Plans start and products are granted when it is paid; ' +
      'a cart covered by discounts or account credit completes at once (`status: completed`). An unpaid cart is voided when its checkout expires.',
    tags: ['Checkout'],
    body: cartBody.extend(subjectFields).refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
    handler: async (c) => {
      const subject = await subjectFor(app.db, c.body, c.orgScope());
      return app.db.tx((tx) =>
        checkoutCart(tx, app, {
          subject,
          userId: c.body.userId ?? null,
          orgId: c.body.orgId ?? null,
          items: c.body.items,
          couponCode: c.body.couponCode,
          gatewayId: c.body.gatewayId,
          successUrl: c.body.successUrl,
          cancelUrl: c.body.cancelUrl,
        }),
      );
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/checkout/sessions/:id',
    auth: 'api',
    scope: 'checkout:write',
    summary: 'Check the status of a checkout',
    tags: ['Checkout'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const scope = c.orgScope();
      const chk = await app.db.maybe<any>(sql`
        SELECT * FROM checkout_sessions ch WHERE ch.id = ${c.params.id}
        ${scope ? sql`AND (ch.org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ch.user_id AND m.org_id IN ${sql.in(scope)}))` : sql.empty}
      `);
      if (!chk) throw notFound('Checkout session');
      return { id: chk.id, status: chk.status, url: chk.url, total: chk.total, currency: chk.currency, orderId: chk.order_id, invoiceId: chk.invoice_id, failureMessage: chk.failure_message, expiresAt: chk.expires_at };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/subscriptions',
    auth: 'api',
    scope: 'billing:read',
    summary: "A customer's subscriptions",
    tags: ['Subscriptions'],
    query: z.object(subjectFields).refine((q) => q.userId || q.orgId, 'userId or orgId is required'),
    handler: async (c) => ({ data: await subscriptionsFor(app, await subjectFor(app.db, c.query, c.orgScope())) }),
  });

  r.route({
    method: 'POST',
    url: '/api/v1/subscriptions/:id/:action',
    auth: 'api',
    scope: 'billing:write',
    summary: 'Change, cancel, reactivate, pause or resume a subscription',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string(), action: z.enum(['change', 'cancel', 'reactivate', 'pause', 'resume']) }),
    body: z
      .object({
        priceId: z.string().optional(),
        quantity: z.number().int().min(1).optional(),
        timing: z.enum(['immediate', 'period_end', 'auto']).optional(),
        prorate: z.boolean().optional(),
        atPeriodEnd: z.boolean().default(true),
        reason: z.string().max(500).optional(),
        resumeAt: z.coerce.date().optional(),
      })
      .default({ atPeriodEnd: true }),
    handler: (c) => subscriptionAction(app, c, c.params.action, c.params.id, c.body),
  });

  r.route({
    method: 'GET',
    url: '/api/v1/invoices',
    auth: 'api',
    scope: 'billing:read',
    summary: "A customer's invoices",
    tags: ['Invoices'],
    query: z.object({ ...subjectFields, ...pageQuery }).refine((q) => q.userId || q.orgId, 'userId or orgId is required'),
    handler: async (c) => ({ data: await invoicesFor(app, await subjectFor(app.db, c.query, c.orgScope()), c.query.page, c.query.pageSize) }),
  });

  r.route({
    method: 'GET',
    url: '/api/v1/invoices/:id/pdf',
    auth: 'api',
    scope: 'billing:read',
    summary: 'Invoice PDF',
    tags: ['Invoices'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const scope = c.orgScope();
      const inv = await app.db.maybe(sql`
        SELECT i.id FROM invoices i WHERE i.id = ${c.params.id} AND i.status <> 'draft'
        ${scope ? sql`AND (i.org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = i.user_id AND m.org_id IN ${sql.in(scope)}))` : sql.empty}
      `);
      if (!inv) throw notFound('Invoice');
      const { filename, data } = await invoicePdf(app, c.params.id);
      return c.reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${filename}"`).send(data);
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/v1/billing-profile',
    auth: 'api',
    scope: 'billing:write',
    summary: "Set a customer's billing details (address and tax ID drive tax calculation)",
    tags: ['Billing profiles'],
    body: z.object(subjectFields).and(billingProfileBody),
    handler: async (c) => {
      const subject = await subjectFor(app.db, { userId: c.body.orgId ? null : c.body.userId, orgId: c.body.orgId }, c.orgScope());
      return app.db.tx((tx) => upsertBillingProfile(tx, app, subject, c.body));
    },
  });

  // ---- Client API (browser SDK) ------------------------------------------------------------
  const clientSubject = (c: RouteContext): Subject => {
    const p = c.customer();
    return p.orgId ? { type: 'organization', id: p.orgId } : { type: 'user', id: p.userId };
  };

  r.route({
    method: 'POST',
    url: '/api/client/checkout',
    auth: 'client',
    summary: 'Start a checkout for the signed-in customer',
    tags: ['Client'],
    body: checkoutBody.omit({ metadata: true }),
    handler: async (c) => {
      const p = c.customer();
      return app.db.tx((tx) =>
        createCheckout(tx, app, {
          subject: clientSubject(c),
          userId: p.userId,
          orgId: p.orgId,
          priceId: c.body.priceId,
          quantity: c.body.quantity,
          couponCode: c.body.couponCode,
          successUrl: c.body.successUrl,
          cancelUrl: c.body.cancelUrl,
          gatewayId: c.body.gateway,
          actor: c.actor,
        }),
      );
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/cart/checkout',
    auth: 'client',
    summary: 'Buy several products in one checkout',
    tags: ['Client'],
    body: cartBody,
    handler: async (c) => {
      const p = c.customer();
      return app.db.tx((tx) =>
        checkoutCart(tx, app, {
          subject: clientSubject(c),
          userId: p.userId,
          orgId: p.orgId,
          items: c.body.items,
          couponCode: c.body.couponCode,
          gatewayId: c.body.gatewayId,
          successUrl: c.body.successUrl,
          cancelUrl: c.body.cancelUrl,
        }),
      );
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/subscriptions',
    auth: 'client',
    summary: "The signed-in customer's subscriptions",
    tags: ['Client'],
    handler: async (c) => ({ data: await subscriptionsFor(app, clientSubject(c)) }),
  });

  r.route({
    method: 'POST',
    url: '/api/client/subscriptions/:id/:action',
    auth: 'client',
    summary: 'Self-service: change plan, cancel or reactivate',
    tags: ['Client'],
    params: z.object({ id: z.string(), action: z.enum(['change', 'cancel', 'reactivate']) }),
    body: z.object({ priceId: z.string().optional(), quantity: z.number().int().min(1).optional(), reason: z.string().max(500).optional() }).default({}),
    handler: async (c) => {
      await ownSubscription(app, c, c.params.id);
      // Customers always cancel at period end; immediate cancellation is an admin action.
      return subscriptionAction(app, c, c.params.action, c.params.id, { ...c.body, atPeriodEnd: true, timing: 'auto' });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/invoices',
    auth: 'client',
    summary: "The signed-in customer's invoices",
    tags: ['Client'],
    query: z.object(pageQuery),
    handler: async (c) => ({ data: await invoicesFor(app, clientSubject(c), c.query.page, c.query.pageSize) }),
  });

  r.route({
    method: 'GET',
    url: '/api/client/invoices/:id/pdf',
    auth: 'client',
    summary: 'Download one of your invoices',
    tags: ['Client'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const s = clientSubject(c);
      const inv = await app.db.maybe(sql`SELECT id FROM invoices WHERE id = ${c.params.id} AND subject_type = ${s.type} AND subject_id = ${s.id} AND status <> 'draft'`);
      if (!inv) throw notFound('Invoice');
      const { filename, data } = await invoicePdf(app, c.params.id);
      return c.reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${filename}"`).send(data);
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/invoices/:id/pay',
    auth: 'client',
    summary: 'Pay an open invoice',
    tags: ['Client'],
    params: z.object({ id: z.string() }),
    body: z.object({ gateway: z.string().optional(), successUrl: z.string().url().optional(), cancelUrl: z.string().url().optional() }).default({}),
    handler: async (c) => {
      const s = clientSubject(c);
      const inv = await app.db.maybe(sql`SELECT id FROM invoices WHERE id = ${c.params.id} AND subject_type = ${s.type} AND subject_id = ${s.id}`);
      if (!inv) throw notFound('Invoice');
      return app.db.tx((tx) => createInvoiceCheckout(tx, app, c.params.id, { gatewayId: c.body.gateway, successUrl: c.body.successUrl, cancelUrl: c.body.cancelUrl }));
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/billing-profile',
    auth: 'client',
    summary: 'Your billing details',
    tags: ['Client'],
    handler: async (c) => {
      const s = clientSubject(c);
      const profile = await app.db.maybe<any>(sql`SELECT name, company, email, address, tax_id, tax_exempt FROM billing_profiles WHERE subject_type = ${s.type} AND subject_id = ${s.id}`);
      const methods = await app.db.many(sql`SELECT id, type, brand, last4, exp_month, exp_year, is_default FROM payment_methods WHERE subject_type = ${s.type} AND subject_id = ${s.id} AND detached_at IS NULL`);
      return { profile, paymentMethods: methods };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/client/billing-profile',
    auth: 'client',
    summary: 'Update your billing details',
    tags: ['Client'],
    body: billingProfileBody.omit({ taxExempt: true }),
    handler: async (c) => app.db.tx((tx) => upsertBillingProfile(tx, app, clientSubject(c), c.body)),
  });
}

async function subscriptionAction(app: App, c: RouteContext, action: string, id: string, body: any) {
  const scope = c.principal.kind === 'customer' ? null : c.orgScope();
  return app.db.tx(async (tx) => {
    switch (action) {
      case 'change': {
        const result = await changeSubscription(tx, app, { subscriptionId: id, priceId: body.priceId, quantity: body.quantity, timing: body.timing, prorate: body.prorate, actor: c.actor, scope });
        return { subscription: presentSubscription(result.subscription), invoice: result.invoice ? presentInvoice(app, result.invoice) : null, scheduled: result.scheduled };
      }
      case 'cancel':
        return { subscription: presentSubscription(await cancelSubscription(tx, app, { subscriptionId: id, atPeriodEnd: body.atPeriodEnd ?? true, reason: body.reason, actor: c.actor, scope })) };
      case 'reactivate':
        return { subscription: presentSubscription(await reactivateSubscription(tx, app, id, c.actor, scope)) };
      case 'pause':
        return { subscription: presentSubscription(await pauseSubscription(tx, app, id, { resumeAt: body.resumeAt, actor: c.actor, scope })) };
      default: {
        const r = await resumeSubscription(tx, app, id, c.actor, scope);
        return { subscription: presentSubscription(r.subscription), invoice: r.invoice ? presentInvoice(app, r.invoice) : null };
      }
    }
  });
}
