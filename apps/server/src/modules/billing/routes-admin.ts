import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { currencyCode, likePattern, pageQuery, paginate, qDate } from '../../core/validation.js';
import { DAY } from '../../core/clock.js';
import { toCsv } from '../../core/csv.js';
import { subjectFor, type Subject } from '../catalog/entitlements.js';
import { validateCoupon } from '../catalog/coupons.js';
import { releaseSale, reserveSale } from '../catalog/purchases.js';
import { adapterFor, adapters, gatewayContext, type GatewayRow } from './gateways/registry.js';
import {
  adjustBalance,
  cancelSubscription,
  changeSubscription,
  createInvoice,
  finalizeInvoice,
  installmentLabel,
  loadPrice,
  pauseSubscription,
  reactivateSubscription,
  recordPayment,
  renewSubscription,
  resumeSubscription,
  scopeOfSubject,
  settleInvoice,
  startSubscription,
  voidInvoice,
} from './engine.js';
import { createInvoiceCheckout, payToken } from './checkout.js';
import { createProductInvoice, productInvoiceOptions } from './product-invoices.js';
import { requestRefund } from './refunds.js';
import { renderInvoicePdf } from './pdf.js';
import { validatedTaxId } from './tax-ids.js';
import { sendSystemEmail } from '../core/mail.js';
import { formatMoney, licensedAmount } from './money.js';

/** Visibility of billing rows for org-scoped admins. */
export function billingScopeSql(scope: string[] | null, alias: string): Sql | null {
  if (!scope) return null;
  const a = sql.raw(alias);
  return sql`(${a}.org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${a}.user_id AND m.org_id IN ${sql.in(scope)}))`;
}

const subjectFields = { userId: z.string().optional(), orgId: z.string().optional() };

async function adminSubject(app: App, db: Db, q: { userId?: string; orgId?: string }, scope: string[] | null): Promise<Subject> {
  if (!q.userId && !q.orgId) throw validationError([{ path: ['userId'], message: 'userId or orgId is required' }]);
  return subjectFor(db, { userId: q.orgId ? null : q.userId, orgId: q.orgId }, scope);
}

export async function invoicePdf(app: App, invoiceId: string): Promise<{ filename: string; data: Buffer }> {
  const inv = await app.db.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${invoiceId}`);
  if (!inv) throw notFound('Invoice');
  const lines = await app.db.many(sql`SELECT * FROM invoice_lines WHERE invoice_id = ${inv.id} ORDER BY position`);
  const data = await renderInvoicePdf(inv, lines, { appName: app.settings.get('general').appName });
  return { filename: `${inv.number ?? inv.id}.pdf`, data };
}

function presentGateway(app: App, row: GatewayRow & Record<string, any>, secrets: { name: string; last4: string | null }[]) {
  const entry = adapters(app).get(row.adapter);
  return {
    ...row,
    adapterName: entry?.adapter.name ?? row.adapter,
    available: Boolean(entry),
    capabilities: entry?.adapter.capabilities ?? null,
    secrets: secrets.map((s) => ({ name: s.name, last4: s.last4 })),
    webhookUrl: `${app.config.appUrl}/api/public/gateways/${row.id}/webhook`,
  };
}

export function registerAdminBillingRoutes(r: Router, app: App): void {
  // ---- Gateways ---------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/gateways',
    auth: 'admin',
    permission: 'billing.gateways.view',
    summary: 'Configured payment gateways and installed gateway plugins',
    tags: ['Gateways'],
    handler: async () => {
      const rows = await app.db.many<GatewayRow & Record<string, any>>(sql`SELECT * FROM payment_gateways ORDER BY is_default DESC, priority DESC, created_at`);
      const configured = [];
      for (const row of rows) configured.push(presentGateway(app, row, await app.secrets.describe(app.db, 'gateway', row.id)));
      const available = [...adapters(app).values()].map(({ adapter, owner }) => ({
        key: adapter.key,
        name: adapter.name,
        description: adapter.description,
        owner,
        capabilities: adapter.capabilities,
        secretFields: adapter.secretFields,
        configSchema: adapter.configSchema ? z.toJSONSchema(adapter.configSchema, { io: 'input', unrepresentable: 'any' }) : null,
      }));
      return { data: configured, available };
    },
  });

  const gatewayBody = z.object({
    adapter: z.string(),
    name: z.string().trim().min(1).max(100),
    mode: z.enum(['test', 'live']),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.string().max(5000)).default({}),
    currencies: z.array(currencyCode).max(200).nullable().optional(),
    isDefault: z.boolean().default(false),
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
  });

  async function saveGateway(tx: Db, id: string, adapterKey: string, config: Record<string, unknown> | undefined, secrets: Record<string, string> | undefined) {
    const adapter = adapterFor(app, adapterKey);
    if (config && adapter.configSchema) {
      const parsed = adapter.configSchema.safeParse(config);
      if (!parsed.success) throw validationError(parsed.error.issues.map((i) => ({ path: ['config', ...i.path.map(String)], message: i.message })));
      await tx.exec(sql`UPDATE payment_gateways SET config = ${sql.json(parsed.data)} WHERE id = ${id}`);
    }
    for (const [key, value] of Object.entries(secrets ?? {})) {
      if (!adapter.secretFields.some((f) => f.key === key)) throw validationError([{ path: ['secrets', key], message: 'Unknown credential' }]);
      if (value) await app.secrets.set(tx, 'gateway', id, key, value);
    }
  }

  r.route({
    method: 'POST',
    url: '/api/admin/gateways',
    auth: 'admin',
    permission: 'billing.gateways.manage',
    sensitive: true,
    summary: 'Connect a payment gateway (credentials are encrypted at rest)',
    tags: ['Gateways'],
    body: gatewayBody,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const adapter = adapterFor(app, c.body.adapter);
        if (adapter.key === 'sandbox' && c.body.mode === 'live') throw validationError([{ path: ['mode'], message: 'The sandbox gateway can only run in test mode' }]);
        const missing = adapter.secretFields.filter((f) => f.required && !c.body.secrets[f.key]).map((f) => f.label);
        if (missing.length) throw validationError([{ path: ['secrets'], message: `Required: ${missing.join(', ')}` }]);
        const now = app.clock.now();
        const id = newId('gw');
        if (c.body.isDefault) await tx.exec(sql`UPDATE payment_gateways SET is_default = FALSE`);
        await tx.exec(sql.insert('payment_gateways', {
          id,
          adapter: adapter.key,
          name: c.body.name,
          mode: c.body.mode,
          enabled: c.body.enabled,
          is_default: c.body.isDefault,
          priority: c.body.priority,
          config: {},
          currencies: c.body.currencies ?? null,
          created_at: now,
          updated_at: now,
        }, ''));
        await saveGateway(tx, id, adapter.key, c.body.config, c.body.secrets);
        await c.audit(tx, 'gateway.create', { type: 'payment_gateway', id }, { adapter: adapter.key, mode: c.body.mode, credentials: Object.keys(c.body.secrets) });
        const row = await tx.one<any>(sql`SELECT * FROM payment_gateways WHERE id = ${id}`);
        return presentGateway(app, row, await app.secrets.describe(tx, 'gateway', id));
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/gateways/:id',
    auth: 'admin',
    permission: 'billing.gateways.manage',
    sensitive: true,
    summary: 'Update gateway settings or rotate credentials',
    tags: ['Gateways'],
    params: z.object({ id: z.string() }),
    body: gatewayBody.omit({ adapter: true }).partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${c.params.id} FOR UPDATE`);
        if (!row) throw notFound('Payment gateway');
        if (row.adapter === 'sandbox' && c.body.mode === 'live') throw validationError([{ path: ['mode'], message: 'The sandbox gateway can only run in test mode' }]);
        if (c.body.isDefault) await tx.exec(sql`UPDATE payment_gateways SET is_default = FALSE`);
        await tx.exec(sql`
          UPDATE payment_gateways SET ${sql.set({
            name: c.body.name,
            mode: c.body.mode,
            enabled: c.body.enabled,
            is_default: c.body.isDefault,
            priority: c.body.priority,
            currencies: c.body.currencies,
            updated_at: app.clock.now(),
          })} WHERE id = ${row.id}
        `);
        await saveGateway(tx, row.id, row.adapter, c.body.config, c.body.secrets);
        await c.audit(tx, 'gateway.update', { type: 'payment_gateway', id: row.id }, { ...c.body, secrets: Object.keys(c.body.secrets ?? {}) });
        const updated = await tx.one<any>(sql`SELECT * FROM payment_gateways WHERE id = ${row.id}`);
        return presentGateway(app, updated, await app.secrets.describe(tx, 'gateway', row.id));
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/gateways/:id/test',
    auth: 'admin',
    permission: 'billing.gateways.manage',
    summary: 'Test the gateway connection with the stored credentials',
    tags: ['Gateways'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${c.params.id}`);
      if (!row) throw notFound('Payment gateway');
      const adapter = adapterFor(app, row.adapter);
      let result: { ok: boolean; message: string };
      try {
        result = await adapter.testConnection(await gatewayContext(app.db, app, row));
      } catch (err) {
        result = { ok: false, message: (err as Error).message };
      }
      await app.db.exec(sql`UPDATE payment_gateways SET last_test_at = ${app.clock.now()}, last_test_ok = ${result.ok}, last_test_message = ${result.message} WHERE id = ${row.id}`);
      return result;
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/gateways/:id',
    auth: 'admin',
    permission: 'billing.gateways.manage',
    sensitive: true,
    summary: 'Remove a gateway (only if it never processed payments; otherwise disable it)',
    tags: ['Gateways'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const used = await tx.maybe(sql`SELECT 1 FROM payments WHERE gateway_id = ${c.params.id} LIMIT 1`);
        if (used) throw conflict('This gateway has payment history; disable it instead', 'gateway_in_use');
        await tx.exec(sql`DELETE FROM payment_methods WHERE gateway_id = ${c.params.id}`);
        const n = await tx.exec(sql`DELETE FROM payment_gateways WHERE id = ${c.params.id}`);
        if (!n) throw notFound('Payment gateway');
        await app.secrets.delete(tx, 'gateway', c.params.id);
        await c.audit(tx, 'gateway.delete', { type: 'payment_gateway', id: c.params.id });
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/gateway-events',
    auth: 'admin',
    permission: 'billing.gateways.view',
    summary: 'Webhook inbox from payment gateways',
    tags: ['Gateways'],
    query: z.object({ ...pageQuery, gatewayId: z.string().optional(), status: z.enum(['received', 'processed', 'failed', 'ignored']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`*`,
        from: sql`gateway_events`,
        where: sql.where([c.query.gatewayId && sql`gateway_id = ${c.query.gatewayId}`, c.query.status && sql`status = ${c.query.status}`]),
        orderBy: sql`ORDER BY received_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  // ---- Subscriptions ------------------------------------------------------------------
  const subListQuery = z.object({
    ...pageQuery,
    status: z.string().optional(),
    productId: z.string().optional(),
    ...subjectFields,
    q: z.string().max(200).optional(),
    renewingBefore: qDate.optional(),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/subscriptions',
    auth: 'admin',
    permission: 'billing.subscriptions.view',
    summary: 'List subscriptions',
    tags: ['Subscriptions'],
    query: subListQuery,
    handler: (c) =>
      paginate(app.db, {
        select: sql`s.*, p.name AS product_name, p.key AS product_key, pr.unit_amount, pr.interval, pr.interval_count, pr.pricing_model, pr.payment_count,
                    coalesce(u.email, o.name) AS customer_label`,
        from: sql`subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id
                  LEFT JOIN users u ON s.subject_type = 'user' AND u.id = s.subject_id
                  LEFT JOIN organizations o ON s.subject_type = 'organization' AND o.id = s.subject_id`,
        where: sql.where([
          c.query.status && sql`s.status IN ${sql.in(c.query.status.split(','))}`,
          c.query.productId && sql`s.product_id = ${c.query.productId}`,
          c.query.userId && sql`(s.user_id = ${c.query.userId} OR (s.subject_type = 'user' AND s.subject_id = ${c.query.userId}))`,
          c.query.orgId && sql`s.org_id = ${c.query.orgId}`,
          c.query.q && sql`(u.email ILIKE ${likePattern(c.query.q)} OR o.name ILIKE ${likePattern(c.query.q)} OR s.id = ${c.query.q})`,
          c.query.renewingBefore && sql`s.current_period_end <= ${c.query.renewingBefore} AND s.status IN ('active', 'trialing')`,
          billingScopeSql(c.orgScope(), 's'),
        ]),
        orderBy: sql`ORDER BY s.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/subscriptions/:id',
    auth: 'admin',
    permission: 'billing.subscriptions.view',
    summary: 'Subscription with invoices and history',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const sub = await app.db.maybe<any>(sql`
        SELECT s.*, p.name AS product_name, pr.unit_amount, pr.interval, pr.interval_count, pr.pricing_model, pr.currency AS price_currency,
               pr.payment_count, pr.after_last_payment, pm.brand AS pm_brand, pm.last4 AS pm_last4, pm.exp_month AS pm_exp_month, pm.exp_year AS pm_exp_year, c.code AS coupon_code
        FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id
        LEFT JOIN payment_methods pm ON pm.id = s.payment_method_id LEFT JOIN coupons c ON c.id = s.coupon_id
        ${sql.where([sql`s.id = ${c.params.id}`, billingScopeSql(c.orgScope(), 's')])}
      `);
      if (!sub) throw notFound('Subscription');
      const [invoices, history] = await Promise.all([
        app.db.many(sql`SELECT id, number, status, total, amount_due, amount_paid, currency, period_start, period_end, created_at FROM invoices WHERE subscription_id = ${sub.id} ORDER BY created_at DESC`),
        app.db.many(sql`SELECT id, type, data, created_at FROM events WHERE type LIKE 'subscription.%' AND data->>'subscriptionId' = ${sub.id} ORDER BY created_at DESC LIMIT 50`),
      ]);
      return { ...sub, invoices, history };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Create a subscription directly (complimentary or invoiced)',
    tags: ['Subscriptions'],
    body: z.object({
      ...subjectFields,
      priceId: z.string(),
      quantity: z.number().int().min(1).default(1),
      collectionMethod: z.enum(['complimentary', 'send_invoice']).default('complimentary'),
      trialDays: z.number().int().min(0).max(365).default(0),
      couponCode: z.string().optional(),
      reason: z.string().max(500).optional(),
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const subject = await adminSubject(app, tx, c.body, c.orgScope());
        const { price, product } = await loadPrice(tx, c.body.priceId);
        const coupon = c.body.couponCode
          ? await validateCoupon(tx, app, c.body.couponCode, { productId: product.id, amount: price.unit_amount, currency: price.currency, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, isFirstPurchase: true })
          : null;
        // The subscription starts now, so it counts as sold at once.
        const id = newId('sub');
        await reserveSale(tx, app, { subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, items: [{ product, price, quantity: c.body.quantity }], source: { type: 'subscription', id }, status: 'sold' });
        const sub = await startSubscription(tx, app, {
          id,
          subject,
          userId: c.body.userId ?? null,
          orgId: c.body.orgId ?? null,
          price,
          product,
          quantity: c.body.quantity,
          coupon,
          trialDays: c.body.trialDays,
          collectionMethod: c.body.collectionMethod,
          metadata: { createdByAdmin: c.admin().adminId, reason: c.body.reason ?? null },
        });
        if (c.body.collectionMethod === 'send_invoice' && !c.body.trialDays) {
          const amount = licensedAmount(price, c.body.quantity);
          await createInvoice(tx, app, {
            subject,
            userId: c.body.userId ?? null,
            orgId: c.body.orgId ?? null,
            currency: price.currency,
            billingReason: 'manual',
            subscriptionId: sub.id,
            periodStart: sub.current_period_start,
            periodEnd: sub.current_period_end,
            lines: [{ type: 'subscription', description: product.name + installmentLabel(price, 1), productId: product.id, priceId: price.id, quantity: c.body.quantity, unitAmount: amount, amount, periodStart: sub.current_period_start, periodEnd: sub.current_period_end }],
          });
        }
        await c.audit(tx, 'subscription.create', { type: 'subscription', id: sub.id }, { priceId: price.id, collectionMethod: c.body.collectionMethod, reason: c.body.reason });
        return sub;
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions/:id/change',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Upgrade, downgrade or change seats (with proration)',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    body: z.object({ priceId: z.string().optional(), quantity: z.number().int().min(1).optional(), timing: z.enum(['immediate', 'period_end', 'auto']).default('auto'), prorate: z.boolean().optional() }),
    handler: async (c) => app.db.tx((tx) => changeSubscription(tx, app, { subscriptionId: c.params.id, ...c.body, actor: c.actor, scope: c.orgScope() })),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions/:id/cancel',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Cancel now or at the end of the period',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    body: z.object({ atPeriodEnd: z.boolean().default(true), reason: z.string().max(500).optional(), creditUnused: z.boolean().default(false) }),
    handler: async (c) => app.db.tx((tx) => cancelSubscription(tx, app, { subscriptionId: c.params.id, ...c.body, actor: c.actor, scope: c.orgScope() })),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions/:id/reactivate',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Undo a scheduled cancellation',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    handler: async (c) => app.db.tx((tx) => reactivateSubscription(tx, app, c.params.id, c.actor, c.orgScope())),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions/:id/pause',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Pause billing and access',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    body: z.object({ resumeAt: z.coerce.date().optional() }),
    handler: async (c) => app.db.tx((tx) => pauseSubscription(tx, app, c.params.id, { resumeAt: c.body.resumeAt, actor: c.actor, scope: c.orgScope() })),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions/:id/resume',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Resume a paused subscription (starts a new period)',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    handler: async (c) => app.db.tx((tx) => resumeSubscription(tx, app, c.params.id, c.actor, c.orgScope())),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions/:id/extend',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Extend the current period or trial by a number of days (free time)',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    body: z.object({ days: z.number().int().min(1).max(3650), reason: z.string().trim().min(3).max(500) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const sub = await tx.maybe<any>(sql`SELECT * FROM subscriptions s ${sql.where([sql`s.id = ${c.params.id}`, billingScopeSql(c.orgScope(), 's')])} FOR UPDATE`);
        if (!sub) throw notFound('Subscription');
        if (!['active', 'trialing', 'past_due'].includes(sub.status)) throw conflict(`A ${sub.status} subscription cannot be extended`, 'not_extendable');
        const end = new Date(sub.current_period_end.getTime() + c.body.days * DAY);
        await tx.exec(sql`
          UPDATE subscriptions SET current_period_end = ${end}, trial_end = CASE WHEN status = 'trialing' THEN ${end}::timestamptz ELSE trial_end END, updated_at = ${app.clock.now()} WHERE id = ${sub.id}
        `);
        await c.audit(tx, 'subscription.extend', { type: 'subscription', id: sub.id }, { days: c.body.days, reason: c.body.reason, newPeriodEnd: end });
        await app.events.emit(tx, 'subscription.updated', { subscriptionId: sub.id, change: 'extended', periodEnd: end }, scopeOfSubject({ type: sub.subject_type, id: sub.subject_id }));
        return tx.one(sql`SELECT * FROM subscriptions WHERE id = ${sub.id}`);
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/subscriptions/:id/renew-now',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Run renewal now if the period has ended (support tool)',
    tags: ['Subscriptions'],
    params: z.object({ id: z.string() }),
    handler: (c) => renewSubscription(app.db, app, c.params.id),
  });

  // ---- Invoices ------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/invoices',
    auth: 'admin',
    permission: 'billing.invoices.view',
    summary: 'List invoices',
    tags: ['Invoices'],
    query: z.object({ ...pageQuery, status: z.string().optional(), ...subjectFields, subscriptionId: z.string().optional(), q: z.string().max(100).optional(), overdue: z.enum(['true', 'false']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`i.id, i.number, i.status, i.billing_reason, i.currency, i.total, i.amount_due, i.amount_paid, i.amount_refunded, i.due_at, i.issued_at, i.paid_at,
                    i.subject_type, i.subject_id, i.user_id, i.org_id, i.subscription_id, i.customer_details->>'email' AS customer_email, i.customer_details->>'name' AS customer_name, i.created_at`,
        from: sql`invoices i`,
        where: sql.where([
          c.query.status && sql`i.status IN ${sql.in(c.query.status.split(','))}`,
          c.query.userId && sql`(i.user_id = ${c.query.userId} OR (i.subject_type = 'user' AND i.subject_id = ${c.query.userId}))`,
          c.query.orgId && sql`i.org_id = ${c.query.orgId}`,
          c.query.subscriptionId && sql`i.subscription_id = ${c.query.subscriptionId}`,
          c.query.q && sql`(i.number ILIKE ${likePattern(c.query.q)} OR i.customer_details->>'email' ILIKE ${likePattern(c.query.q)})`,
          c.query.overdue === 'true' && sql`i.status = 'open' AND i.due_at < ${app.clock.now()}`,
          billingScopeSql(c.orgScope(), 'i'),
        ]),
        orderBy: sql`ORDER BY i.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/invoices/:id',
    auth: 'admin',
    permission: 'billing.invoices.view',
    summary: 'Invoice with lines, payments and credit notes',
    tags: ['Invoices'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const inv = await app.db.maybe<any>(sql`SELECT * FROM invoices i ${sql.where([sql`(i.id = ${c.params.id} OR i.number = ${c.params.id})`, billingScopeSql(c.orgScope(), 'i')])}`);
      if (!inv) throw notFound('Invoice');
      const [lines, payments, creditNotes] = await Promise.all([
        app.db.many(sql`SELECT * FROM invoice_lines WHERE invoice_id = ${inv.id} ORDER BY position`),
        app.db.many(sql`SELECT * FROM payments WHERE invoice_id = ${inv.id} ORDER BY created_at`),
        app.db.many(sql`SELECT * FROM credit_notes WHERE invoice_id = ${inv.id} ORDER BY created_at`),
      ]);
      return { ...inv, lines, payments, creditNotes, payUrl: inv.status === 'open' ? `${app.config.appUrl}/pay/invoice/${inv.id}?token=${payToken(app, inv.id)}` : null };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/invoices/:id/pdf',
    auth: 'admin',
    permission: 'billing.invoices.view',
    summary: 'Download an invoice as PDF',
    tags: ['Invoices'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const inv = await app.db.maybe(sql`SELECT i.id FROM invoices i ${sql.where([sql`i.id = ${c.params.id}`, billingScopeSql(c.orgScope(), 'i')])}`);
      if (!inv) throw notFound('Invoice');
      const { filename, data } = await invoicePdf(app, c.params.id);
      return c.reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${filename}"`).send(data);
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/invoices',
    auth: 'admin',
    permission: 'billing.invoices.manage',
    summary: 'Create a manual invoice',
    tags: ['Invoices'],
    body: z.object({
      ...subjectFields,
      currency: currencyCode,
      lines: z.array(z.object({ description: z.string().trim().min(1).max(500), quantity: z.number().int().min(1).default(1), unitAmount: z.number().int(), taxInclusive: z.boolean().default(false) })).min(1).max(100),
      dueDays: z.number().int().min(0).max(365).default(14),
      notes: z.string().max(2000).optional(),
      draft: z.boolean().default(false),
      sendEmail: z.boolean().default(false),
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const subject = await adminSubject(app, tx, c.body, c.orgScope());
        const invoice = await createInvoice(tx, app, {
          subject,
          userId: c.body.userId ?? null,
          orgId: c.body.orgId ?? null,
          currency: c.body.currency,
          billingReason: 'manual',
          lines: c.body.lines.map((l) => ({ type: 'manual' as const, description: l.description, quantity: l.quantity, unitAmount: l.unitAmount, amount: l.unitAmount * l.quantity, taxInclusive: l.taxInclusive })),
          dueAt: new Date(app.clock.now().getTime() + c.body.dueDays * DAY),
          notes: c.body.notes ?? null,
          finalize: !c.body.draft,
        });
        await c.audit(tx, 'invoice.create', { type: 'invoice', id: invoice.id }, { total: invoice.total, currency: invoice.currency });
        if (c.body.sendEmail && invoice.status === 'open') await emailInvoice(app, tx, invoice);
        return invoice;
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/invoices/product-options',
    auth: 'admin',
    permission: 'billing.invoices.manage',
    summary: 'Products, prices and coupons available for a product invoice',
    tags: ['Invoices'],
    handler: () => productInvoiceOptions(app.db, app),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/invoices/products',
    auth: 'admin',
    permission: 'billing.invoices.manage',
    summary: 'Invoice catalog products; the plans and products are granted when the invoice is paid',
    tags: ['Invoices'],
    body: z.object({
      ...subjectFields,
      items: z.array(z.object({ priceId: z.string(), quantity: z.number().int().min(1).max(100_000).optional() })).min(1).max(20),
      couponCode: z.string().trim().max(64).optional(),
      discount: z.object({ first: z.number().int().min(0).default(0), renewal: z.number().int().min(0).default(0) }).default({ first: 0, renewal: 0 }),
      dueDays: z.number().int().min(0).max(365).default(14),
      notes: z.string().max(2000).optional(),
      sendEmail: z.boolean().default(false),
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const subject = await adminSubject(app, tx, c.body, c.orgScope());
        const invoice = await createProductInvoice(tx, app, {
          subject,
          userId: c.body.userId ?? null,
          orgId: c.body.orgId ?? null,
          items: c.body.items,
          couponCode: c.body.couponCode || null,
          firstDiscount: c.body.discount.first,
          renewalDiscount: c.body.discount.renewal,
          dueDays: c.body.dueDays,
          notes: c.body.notes ?? null,
        });
        await c.audit(tx, 'invoice.create', { type: 'invoice', id: invoice.id }, { total: invoice.total, currency: invoice.currency, orderId: invoice.order_id, coupon: c.body.couponCode ?? null, discount: c.body.discount });
        if (c.body.sendEmail && invoice.status === 'open') await emailInvoice(app, tx, invoice);
        return invoice;
      }),
  });

  async function emailInvoice(app: App, db: Db, invoice: any): Promise<boolean> {
    const to = invoice.customer_details?.email;
    if (!to) return false;
    return sendSystemEmail(app, db, {
      to,
      template: 'billing.invoice',
      category: 'billing',
      userId: invoice.user_id,
      orgId: invoice.org_id,
      data: { number: invoice.number, amount: formatMoney(invoice.amount_due - invoice.amount_paid, invoice.currency), dueDate: invoice.due_at?.toISOString().slice(0, 10), payUrl: `${app.config.appUrl}/pay/invoice/${invoice.id}?token=${payToken(app, invoice.id)}` },
    });
  }

  r.route({
    method: 'POST',
    url: '/api/admin/invoices/:id/:action',
    auth: 'admin',
    permission: 'billing.invoices.manage',
    summary: 'Finalize, void, send, mark uncollectible, or record an offline payment',
    tags: ['Invoices'],
    params: z.object({ id: z.string(), action: z.enum(['finalize', 'void', 'send', 'mark-uncollectible', 'mark-paid', 'pay-link']) }),
    body: z.object({ method: z.enum(['bank_transfer', 'cash', 'check', 'other']).optional(), reference: z.string().max(200).optional(), amount: z.number().int().min(1).optional() }).default({}),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const inv = await tx.maybe<any>(sql`SELECT * FROM invoices i ${sql.where([sql`i.id = ${c.params.id}`, billingScopeSql(c.orgScope(), 'i')])}`);
        if (!inv) throw notFound('Invoice');
        switch (c.params.action) {
          case 'finalize': {
            const done = await finalizeInvoice(tx, app, inv.id);
            await c.audit(tx, 'invoice.finalize', { type: 'invoice', id: inv.id });
            return done;
          }
          case 'void':
            return voidInvoice(tx, app, inv.id, c.actor);
          case 'send':
            if (inv.status !== 'open') throw conflict('Only open invoices can be sent', 'invoice_not_open');
            await c.audit(tx, 'invoice.send', { type: 'invoice', id: inv.id });
            return { emailed: await emailInvoice(app, tx, inv) };
          case 'mark-uncollectible':
            if (inv.status !== 'open') throw conflict('Only open invoices can be marked uncollectible', 'invoice_not_open');
            await tx.exec(sql`UPDATE invoices SET status = 'uncollectible', next_attempt_at = NULL, updated_at = ${app.clock.now()} WHERE id = ${inv.id}`);
            // An unpaid product invoice's order will not be fulfilled: what it held in stock is released.
            if (inv.order_id && (await tx.exec(sql`UPDATE orders SET status = 'failed' WHERE id = ${inv.order_id} AND status = 'pending'`))) {
              await releaseSale(tx, app, { type: 'order', id: inv.order_id });
            }
            await c.audit(tx, 'invoice.uncollectible', { type: 'invoice', id: inv.id });
            return tx.one(sql`SELECT * FROM invoices WHERE id = ${inv.id}`);
          case 'pay-link':
            if (inv.status !== 'open') throw conflict('Only open invoices can be paid', 'invoice_not_open');
            return { url: `${app.config.appUrl}/pay/invoice/${inv.id}?token=${payToken(app, inv.id)}` };
          case 'mark-paid': {
            if (inv.status !== 'open') throw conflict('Only open invoices can be marked paid', 'invoice_not_open');
            const manual = await tx.maybe<{ id: string }>(sql`SELECT id FROM payment_gateways WHERE adapter = 'manual' ORDER BY created_at LIMIT 1`);
            const amount = c.body.amount ?? inv.amount_due - inv.amount_paid;
            await recordPayment(tx, app, {
              invoiceId: inv.id,
              orderId: inv.order_id,
              subject: { type: inv.subject_type, id: inv.subject_id },
              userId: inv.user_id,
              orgId: inv.org_id,
              gatewayId: manual?.id ?? null,
              gatewayPaymentId: `manual:${newId('mp')}`,
              amount,
              currency: inv.currency,
              status: 'succeeded',
              method: { type: c.body.method ?? 'bank_transfer' },
              manualReference: c.body.reference ?? null,
              recordedBy: c.admin().adminId,
            });
            await settleInvoice(tx, app, inv.id, amount);
            await c.audit(tx, 'invoice.mark_paid', { type: 'invoice', id: inv.id }, { amount, method: c.body.method, reference: c.body.reference });
            return tx.one(sql`SELECT * FROM invoices WHERE id = ${inv.id}`);
          }
        }
      }),
  });

  // ---- Payments, refunds, orders, disputes ----------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/payments',
    auth: 'admin',
    permission: 'billing.payments.view',
    summary: 'List payments',
    tags: ['Payments'],
    query: z.object({ ...pageQuery, status: z.string().optional(), ...subjectFields, gatewayId: z.string().optional(), q: z.string().max(200).optional(), from: qDate.optional(), to: qDate.optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`p.*, g.name AS gateway_name, i.number AS invoice_number, coalesce(u.email, o.name) AS customer_label`,
        from: sql`payments p LEFT JOIN payment_gateways g ON g.id = p.gateway_id LEFT JOIN invoices i ON i.id = p.invoice_id
                  LEFT JOIN users u ON p.subject_type = 'user' AND u.id = p.subject_id LEFT JOIN organizations o ON p.subject_type = 'organization' AND o.id = p.subject_id`,
        where: sql.where([
          c.query.status && sql`p.status IN ${sql.in(c.query.status.split(','))}`,
          c.query.userId && sql`(p.user_id = ${c.query.userId} OR (p.subject_type = 'user' AND p.subject_id = ${c.query.userId}))`,
          c.query.orgId && sql`p.org_id = ${c.query.orgId}`,
          c.query.gatewayId && sql`p.gateway_id = ${c.query.gatewayId}`,
          c.query.q && sql`(p.id = ${c.query.q} OR p.gateway_payment_id = ${c.query.q} OR u.email ILIKE ${likePattern(c.query.q)} OR i.number ILIKE ${likePattern(c.query.q)})`,
          c.query.from && sql`p.created_at >= ${c.query.from}`,
          c.query.to && sql`p.created_at <= ${c.query.to}`,
          billingScopeSql(c.orgScope(), 'p'),
        ]),
        orderBy: sql`ORDER BY p.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/payments/export.csv',
    auth: 'admin',
    permission: 'billing.payments.export',
    summary: 'Export payments as CSV (financial export)',
    tags: ['Payments'],
    query: z.object({ from: qDate.optional(), to: qDate.optional() }),
    handler: async (c) => {
      const rows = await app.db.many<any>(sql`
        SELECT p.*, i.number AS invoice_number, g.adapter FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN payment_gateways g ON g.id = p.gateway_id
        ${sql.where([c.query.from && sql`p.created_at >= ${c.query.from}`, c.query.to && sql`p.created_at <= ${c.query.to}`, billingScopeSql(c.orgScope(), 'p')])}
        ORDER BY p.created_at LIMIT 100000
      `);
      await c.audit(app.db, 'payment.export_csv', undefined, { count: rows.length, from: c.query.from, to: c.query.to });
      const csv = toCsv(rows, [
        { header: 'payment_id', value: (r) => r.id },
        { header: 'created_at', value: (r) => r.created_at },
        { header: 'status', value: (r) => r.status },
        { header: 'amount_minor', value: (r) => r.amount },
        { header: 'refunded_minor', value: (r) => r.amount_refunded },
        { header: 'fee_minor', value: (r) => r.fee_amount },
        { header: 'currency', value: (r) => r.currency },
        { header: 'gateway', value: (r) => r.adapter },
        { header: 'gateway_payment_id', value: (r) => r.gateway_payment_id },
        { header: 'invoice', value: (r) => r.invoice_number },
        { header: 'subject', value: (r) => `${r.subject_type}:${r.subject_id}` },
      ]);
      return c.reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="payments.csv"').send(csv);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/payments/:id',
    auth: 'admin',
    permission: 'billing.payments.view',
    summary: 'Payment with refunds and disputes',
    tags: ['Payments'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const p = await app.db.maybe<any>(sql`SELECT p.*, g.name AS gateway_name, g.adapter FROM payments p LEFT JOIN payment_gateways g ON g.id = p.gateway_id ${sql.where([sql`p.id = ${c.params.id}`, billingScopeSql(c.orgScope(), 'p')])}`);
      if (!p) throw notFound('Payment');
      const [refunds, disputes] = await Promise.all([
        app.db.many(sql`SELECT * FROM refunds WHERE payment_id = ${p.id} ORDER BY created_at`),
        app.db.many(sql`SELECT * FROM disputes WHERE payment_id = ${p.id} ORDER BY created_at`),
      ]);
      const adapter = p.adapter ? adapters(app).get(p.adapter)?.adapter : undefined;
      return { ...p, refunds, disputes, refundable: Boolean(adapter?.capabilities.refunds), partialRefunds: Boolean(adapter?.capabilities.partialRefunds) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/payments/:id/refunds',
    auth: 'admin',
    permission: 'billing.refunds.create',
    sensitive: true,
    summary: 'Refund a payment (large refunds need a second approver)',
    tags: ['Payments'],
    params: z.object({ id: z.string() }),
    body: z.object({ amount: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(500), revokeAccess: z.boolean().default(false) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const p = await tx.maybe<any>(sql`SELECT amount, amount_refunded FROM payments WHERE id = ${c.params.id}`);
        if (!p) throw notFound('Payment');
        return requestRefund(tx, app, { paymentId: c.params.id, amount: c.body.amount ?? p.amount - p.amount_refunded, reason: c.body.reason, revokeAccess: c.body.revokeAccess, actor: c.actor, scope: c.orgScope(), adminId: c.admin().adminId });
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/refunds',
    auth: 'admin',
    permission: 'billing.payments.view',
    summary: 'List refunds',
    tags: ['Payments'],
    query: z.object({ ...pageQuery, status: z.string().optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`r.*, p.gateway_payment_id, p.subject_type, p.subject_id, cn.number AS credit_note_number`,
        from: sql`refunds r JOIN payments p ON p.id = r.payment_id LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id`,
        where: sql.where([c.query.status && sql`r.status = ${c.query.status}`, billingScopeSql(c.orgScope(), 'p')]),
        orderBy: sql`ORDER BY r.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/orders',
    auth: 'admin',
    permission: 'billing.payments.view',
    summary: 'List orders',
    tags: ['Payments'],
    query: z.object({ ...pageQuery, status: z.string().optional(), ...subjectFields, q: z.string().max(100).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`o.*, coalesce(u.email, org.name) AS customer_label, (SELECT string_agg(description, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS items`,
        from: sql`orders o LEFT JOIN users u ON o.subject_type = 'user' AND u.id = o.subject_id LEFT JOIN organizations org ON o.subject_type = 'organization' AND org.id = o.subject_id`,
        where: sql.where([
          c.query.status && sql`o.status = ${c.query.status}`,
          c.query.userId && sql`(o.user_id = ${c.query.userId} OR (o.subject_type = 'user' AND o.subject_id = ${c.query.userId}))`,
          c.query.orgId && sql`o.org_id = ${c.query.orgId}`,
          c.query.q && sql`(o.number ILIKE ${likePattern(c.query.q)} OR u.email ILIKE ${likePattern(c.query.q)} OR o.id = ${c.query.q})`,
          billingScopeSql(c.orgScope(), 'o'),
        ]),
        orderBy: sql`ORDER BY o.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/disputes',
    auth: 'admin',
    permission: 'billing.payments.view',
    summary: 'Chargebacks and disputes',
    tags: ['Payments'],
    query: z.object({ ...pageQuery, status: z.enum(['needs_response', 'won', 'lost']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`d.*, p.subject_type, p.subject_id, p.user_id, g.name AS gateway_name`,
        from: sql`disputes d LEFT JOIN payments p ON p.id = d.payment_id LEFT JOIN payment_gateways g ON g.id = d.gateway_id`,
        where: sql.where([c.query.status && sql`d.status = ${c.query.status}`]),
        orderBy: sql`ORDER BY d.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/checkouts',
    auth: 'admin',
    permission: 'billing.payments.view',
    summary: 'Checkout sessions (including abandoned ones)',
    tags: ['Payments'],
    query: z.object({ ...pageQuery, status: z.enum(['open', 'completed', 'expired', 'canceled', 'failed']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`ch.*, p.name AS product_name, coalesce(u.email, o.name) AS customer_label`,
        from: sql`checkout_sessions ch LEFT JOIN products p ON p.id = ch.product_id LEFT JOIN users u ON ch.subject_type = 'user' AND u.id = ch.subject_id LEFT JOIN organizations o ON ch.subject_type = 'organization' AND o.id = ch.subject_id`,
        where: sql.where([c.query.status && sql`ch.status = ${c.query.status}`, billingScopeSql(c.orgScope(), 'ch')]),
        orderBy: sql`ORDER BY ch.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  // ---- Taxes, profiles, balances, exchange rates -------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/tax-rates',
    auth: 'admin',
    permission: 'billing.taxes.view',
    summary: 'Tax rates (VAT, GST, sales tax)',
    tags: ['Taxes'],
    handler: async () => ({ data: await app.db.many(sql`SELECT * FROM tax_rates ORDER BY country, region NULLS FIRST, name`) }),
  });

  const taxBody = z.object({
    name: z.string().trim().min(1).max(100),
    country: z.string().length(2).transform((s) => s.toUpperCase()),
    region: z.string().max(50).nullable().optional(),
    ratePercent: z.number().min(0).max(100),
    taxType: z.enum(['vat', 'gst', 'sales_tax', 'other']).default('vat'),
    reverseChargeB2b: z.boolean().default(false),
    active: z.boolean().default(true),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/tax-rates',
    auth: 'admin',
    permission: 'billing.taxes.manage',
    summary: 'Add a tax rate',
    tags: ['Taxes'],
    body: taxBody,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.one(sql.insert('tax_rates', {
          id: newId('txr'),
          name: c.body.name,
          country: c.body.country,
          region: c.body.region ?? null,
          rate_bps: Math.round(c.body.ratePercent * 100),
          tax_type: c.body.taxType,
          reverse_charge_b2b: c.body.reverseChargeB2b,
          active: c.body.active,
          created_at: app.clock.now(),
        }));
        await c.audit(tx, 'tax_rate.create', { type: 'tax_rate', id: row.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/tax-rates/:id',
    auth: 'admin',
    permission: 'billing.taxes.manage',
    summary: 'Update or deactivate a tax rate',
    tags: ['Taxes'],
    params: z.object({ id: z.string() }),
    body: taxBody.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.maybe(sql`
          UPDATE tax_rates SET ${sql.set({
            name: c.body.name,
            country: c.body.country,
            region: c.body.region,
            rate_bps: c.body.ratePercent === undefined ? undefined : Math.round(c.body.ratePercent * 100),
            tax_type: c.body.taxType,
            reverse_charge_b2b: c.body.reverseChargeB2b,
            active: c.body.active,
          })} WHERE id = ${c.params.id} RETURNING *
        `);
        if (!row) throw notFound('Tax rate');
        await c.audit(tx, 'tax_rate.update', { type: 'tax_rate', id: c.params.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/billing-profile',
    auth: 'admin',
    permission: 'billing.subscriptions.view',
    summary: 'Billing profile, payment methods and account credit of a customer',
    tags: ['Billing profiles'],
    query: z.object(subjectFields),
    handler: async (c) => {
      const subject = await adminSubject(app, app.db, c.query, c.orgScope());
      const [profile, methods, balances] = await Promise.all([
        app.db.maybe(sql`SELECT * FROM billing_profiles WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}`),
        app.db.many(sql`SELECT id, gateway_id, type, brand, last4, exp_month, exp_year, is_default, created_at FROM payment_methods WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND detached_at IS NULL`),
        app.db.many(sql`SELECT currency, balance FROM customer_balances WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}`),
      ]);
      return { subject, profile, paymentMethods: methods, balances };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/admin/billing-profile',
    auth: 'admin',
    permission: 'billing.subscriptions.manage',
    summary: 'Update a billing profile (address, tax ID, exemption)',
    tags: ['Billing profiles'],
    body: z.object({ ...subjectFields }).and(billingProfileBody),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const subject = await adminSubject(app, tx, c.body, c.orgScope());
        const row = await upsertBillingProfile(tx, app, subject, c.body);
        await c.audit(tx, 'billing_profile.update', { type: subject.type, id: subject.id });
        return row;
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/customer-balance',
    auth: 'admin',
    permission: 'billing.refunds.create',
    summary: 'Add or remove account credit (applied to future invoices)',
    tags: ['Billing profiles'],
    body: z.object({ ...subjectFields, currency: currencyCode, amount: z.number().int().refine((n) => n !== 0), reason: z.string().trim().min(3).max(500) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const subject = await adminSubject(app, tx, c.body, c.orgScope());
        const balance = await adjustBalance(tx, app, subject, c.body.currency, c.body.amount, c.body.reason);
        await c.audit(tx, 'customer_balance.adjust', { type: subject.type, id: subject.id }, { amount: c.body.amount, currency: c.body.currency, reason: c.body.reason });
        return { balance };
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/exchange-rates',
    auth: 'admin',
    permission: 'billing.taxes.view',
    summary: 'Exchange rates used for reporting and revenue in the base currency',
    tags: ['Taxes'],
    handler: async () => ({ data: await app.db.many(sql`SELECT * FROM exchange_rates ORDER BY base, quote`) }),
  });

  r.route({
    method: 'PUT',
    url: '/api/admin/exchange-rates',
    auth: 'admin',
    permission: 'billing.taxes.manage',
    summary: 'Set exchange rates',
    tags: ['Taxes'],
    body: z.object({ rates: z.array(z.object({ base: currencyCode, quote: currencyCode, rate: z.number().positive() })).min(1).max(500) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        for (const r of c.body.rates) {
          await tx.exec(sql`
            INSERT INTO exchange_rates (base, quote, rate, source, updated_at) VALUES (${r.base}, ${r.quote}, ${r.rate}, 'manual', ${app.clock.now()})
            ON CONFLICT (base, quote) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
          `);
        }
        await c.audit(tx, 'exchange_rates.update', undefined, { count: c.body.rates.length });
        return { ok: true };
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/invoices/:id/checkout',
    auth: 'admin',
    permission: 'billing.invoices.manage',
    summary: 'Create a gateway checkout for an open invoice',
    tags: ['Invoices'],
    params: z.object({ id: z.string() }),
    body: z.object({ gatewayId: z.string().optional() }),
    handler: (c) => app.db.tx((tx) => createInvoiceCheckout(tx, app, c.params.id, { gatewayId: c.body.gatewayId })),
  });
}

export const billingProfileBody = z.object({
  name: z.string().max(200).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  address: z.object({ line1: z.string().max(200).optional(), line2: z.string().max(200).optional(), city: z.string().max(100).optional(), state: z.string().max(100).optional(), postalCode: z.string().max(20).optional(), country: z.string().length(2).optional() }).optional(),
  taxId: z.string().max(50).nullable().optional(),
  taxIdType: z.string().max(20).nullable().optional(),
  taxExempt: z.boolean().optional(),
  preferredCurrency: currencyCode.optional(),
});

export async function upsertBillingProfile(db: Db, app: App, subject: Subject, b: z.infer<typeof billingProfileBody>): Promise<any> {
  const now = app.clock.now();
  const country = b.address?.country?.toUpperCase();
  await db.exec(sql`
    INSERT INTO billing_profiles (id, subject_type, subject_id, created_at, updated_at) VALUES (${newId('bpr')}, ${subject.type}, ${subject.id}, ${now}, ${now})
    ON CONFLICT (subject_type, subject_id) DO NOTHING
  `);
  let taxId = b.taxId;
  if (taxId) {
    // EU VAT numbers are checked for format (not against VIES) and stored in a standard form.
    const current = await db.one<{ country: string | null; tax_id_type: string | null }>(sql`
      SELECT country, tax_id_type FROM billing_profiles WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}
    `);
    taxId = await validatedTaxId(app, taxId, { country: country ?? current.country, type: b.taxIdType !== undefined ? b.taxIdType : current.tax_id_type });
  }
  return db.one(sql`
    UPDATE billing_profiles SET ${sql.set({
      name: b.name,
      company: b.company,
      email: b.email,
      address: b.address ? { ...b.address, country } : undefined,
      country,
      region: b.address?.state,
      tax_id: taxId,
      tax_id_type: b.taxIdType,
      tax_exempt: b.taxExempt,
      preferred_currency: b.preferredCurrency,
      updated_at: now,
    })}
    WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} RETURNING *
  `);
}
