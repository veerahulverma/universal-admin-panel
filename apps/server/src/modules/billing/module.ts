import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { DAY, HOUR } from '../../core/clock.js';
import { likePattern } from '../../core/validation.js';
import { billingMigrations } from './migrations.js';
import { billingDefaults, billingSettingsSchema, renewSubscription, resumeSubscription, runDunning, scopeOfSubject, settingsOf } from './engine.js';
import { registerGatewayAdapter, adapters } from './gateways/registry.js';
import { sandboxGateway } from './gateways/sandbox.js';
import { manualGateway } from './gateways/manual.js';
import { stripeGateway } from './gateways/stripe.js';
import { razorpayGateway } from './gateways/razorpay.js';
import { paypalGateway } from './gateways/paypal.js';
import { expireCheckouts } from './checkout.js';
import { executeRefund } from './refunds.js';
import { registerAdminBillingRoutes } from './routes-admin.js';
import { registerApiBillingRoutes } from './routes-api.js';
import { registerPublicBillingRoutes } from './routes-public.js';
import { registerVoucherRoutes } from './vouchers.js';
import { warnExpiringCards } from './card-expiry.js';
import { BILLING_TEMPLATES } from './templates.js';
import { upsertSystemTemplates } from '../email/templates.js';
import { registerApprovalExecutor } from '../iam/approvals.js';
import { registerApiScopes } from '../developers/keys.js';
import { addSearchProvider } from '../core/routes.js';
import type { EntitlementSource, SourcesContext } from '../catalog/entitlements.js';
import type { UserEnrichContext, UserListFilterContext } from '../customers/routes-users.js';

export const billingModule: ModuleDefinition = {
  id: 'billing',
  name: 'Billing & subscriptions',
  description: 'Checkout, subscriptions, invoices, payments, refunds, taxes, dunning and payment gateway plugins.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers', 'developers', 'catalog'],
  migrations: billingMigrations,
  permissions: [
    { key: 'billing.subscriptions.view', label: 'View subscriptions' },
    { key: 'billing.subscriptions.manage', label: 'Create, change, cancel and extend subscriptions' },
    { key: 'billing.invoices.view', label: 'View invoices' },
    { key: 'billing.invoices.manage', label: 'Create, void and record payments on invoices' },
    { key: 'billing.payments.view', label: 'View payments, orders, refunds and disputes' },
    { key: 'billing.payments.export', label: 'Export financial data' },
    { key: 'billing.refunds.create', label: 'Issue refunds and account credit', dangerous: true },
    { key: 'billing.refunds.approve', label: 'Approve large refunds (second approver)', dangerous: true },
    { key: 'billing.gateways.view', label: 'View payment gateways' },
    { key: 'billing.gateways.manage', label: 'Connect and configure payment gateways', dangerous: true },
    { key: 'billing.taxes.view', label: 'View tax rates and exchange rates' },
    { key: 'billing.taxes.manage', label: 'Manage tax rates and exchange rates' },
    { key: 'billing.vouchers.view', label: 'View gift vouchers and who redeemed them' },
    { key: 'billing.vouchers.manage', label: 'Issue, export and disable gift vouchers (products and account credit)', dangerous: true },
  ],
  nav: [
    { id: 'subscriptions', label: 'Subscriptions', path: '/revenue/subscriptions', icon: 'repeat', section: 'catalog', permission: 'billing.subscriptions.view', order: 20 },
    { id: 'invoices', label: 'Invoices', path: '/revenue/invoices', icon: 'file-text', section: 'revenue', permission: 'billing.invoices.view', order: 10 },
    { id: 'payments', label: 'Payments', path: '/revenue/payments', icon: 'credit-card', section: 'revenue', permission: 'billing.payments.view', order: 20 },
    { id: 'orders', label: 'Orders', path: '/revenue/orders', icon: 'shopping-bag', section: 'revenue', permission: 'billing.payments.view', order: 30 },
    { id: 'disputes', label: 'Disputes', path: '/revenue/disputes', icon: 'shield-x', section: 'revenue', permission: 'billing.payments.view', order: 40 },
    { id: 'taxes', label: 'Taxes & currencies', path: '/revenue/taxes', icon: 'landmark', section: 'revenue', permission: 'billing.taxes.view', order: 60 },
    { id: 'gateways', label: 'Payment gateways', path: '/platform/gateways', icon: 'wallet', section: 'revenue', permission: 'billing.gateways.view', order: 70 },
    { id: 'vouchers', label: 'Gift vouchers', path: '/growth/vouchers', icon: 'gift', section: 'growth', permission: 'billing.vouchers.view', order: 35 },
  ],
  events: [
    { type: 'checkout.created', description: 'A checkout session was started' },
    { type: 'checkout.completed', description: 'A checkout was paid (or completed without payment)' },
    { type: 'checkout.payment_failed', description: 'A payment attempt during checkout failed' },
    { type: 'checkout.expired', description: 'A checkout was abandoned and expired' },
    { type: 'order.paid', description: 'An order was paid' },
    { type: 'invoice.created', description: 'An invoice was issued' },
    { type: 'invoice.paid', description: 'An invoice was paid in full' },
    { type: 'invoice.payment_failed', description: 'Collecting an invoice failed (dunning started)' },
    { type: 'invoice.voided', description: 'An invoice was voided' },
    { type: 'payment.succeeded', description: 'A payment succeeded' },
    { type: 'payment.failed', description: 'A payment failed' },
    { type: 'refund.succeeded', description: 'A refund was completed' },
    { type: 'dispute.created', description: 'A chargeback was opened' },
    { type: 'dispute.won', description: 'A chargeback was won' },
    { type: 'dispute.lost', description: 'A chargeback was lost' },
    { type: 'subscription.created', description: 'A subscription started (including trials)' },
    { type: 'subscription.updated', description: 'A subscription changed (plan, seats, status, scheduled change)' },
    { type: 'subscription.renewed', description: 'A subscription entered a new period' },
    { type: 'subscription.trial_will_end', description: 'A trial ends soon' },
    { type: 'subscription.past_due', description: 'Renewal payment failed; the grace period started' },
    { type: 'subscription.paused', description: 'A subscription was paused' },
    { type: 'subscription.resumed', description: 'A subscription was resumed' },
    { type: 'subscription.reactivated', description: 'A scheduled cancellation was undone' },
    { type: 'subscription.canceled', description: 'A subscription ended' },
    { type: 'subscription.installments_completed', description: 'A subscription paid in installments received its last payment and ended (access ends, or the product is kept)' },
    { type: 'voucher.redeemed', description: 'A gift voucher was redeemed for a product or account credit' },
    { type: 'payment_method.expiring', description: 'A saved card that pays a subscription expires soon' },
  ],
  setup(app) {
    // Lets "reset to default" in the template editor restore the shipped copy.
    app.services['email.extraTemplates'] = [...((app.services['email.extraTemplates'] as unknown[]) ?? []), ...BILLING_TEMPLATES];
    app.settings.define({
      key: 'billing',
      module: 'billing',
      label: 'Billing',
      description: 'Invoice numbering, seller details, tax, dunning, refund approvals, plan-change policy and card expiry warnings.',
      schema: billingSettingsSchema,
      defaults: billingDefaults,
      permission: 'billing.gateways.manage',
    });
    for (const adapter of [sandboxGateway, manualGateway, stripeGateway, razorpayGateway, paypalGateway]) registerGatewayAdapter(app, adapter, 'billing');
    registerApiScopes(app, 'billing', [
      { scope: 'checkout:write', description: 'Create checkout sessions' },
      { scope: 'billing:read', description: 'Read subscriptions and invoices' },
      { scope: 'billing:write', description: 'Change and cancel subscriptions; set billing details' },
    ]);

    // Active subscriptions confer their product; past-due ones only until the grace period ends.
    app.hooks.addFilter<EntitlementSource[], SourcesContext>('entitlements.sources', 'billing', async (sources, { db, subject }) => {
      if (!app.modules.isEnabled('billing')) return sources;
      const subs = await db.many<any>(sql`
        SELECT id, product_id, quantity, status, current_period_start, current_period_end FROM subscriptions
        WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}
          AND (status IN ('active', 'trialing') OR (status = 'past_due' AND (grace_until IS NULL OR grace_until > ${app.clock.now()})))
      `);
      return [
        ...sources,
        ...subs.map((s) => ({ productId: s.product_id, quantity: s.quantity, origin: 'subscription' as const, originId: s.id, status: s.status, periodStart: s.current_period_start, periodEnd: s.current_period_end })),
      ];
    });

    app.hooks.addFilter<Record<string, Record<string, unknown>>, UserEnrichContext>('customers.users.enrich', 'billing', async (acc, { ids }) => {
      if (!app.modules.isEnabled('billing') || !ids.length) return acc;
      const rows = await app.db.many<{ subject_id: string; name: string; key: string; status: string }>(sql`
        SELECT DISTINCT ON (s.subject_id) s.subject_id, p.name, p.key, s.status FROM subscriptions s JOIN products p ON p.id = s.product_id
        WHERE s.subject_type = 'user' AND s.subject_id IN ${sql.in(ids)} AND p.kind = 'plan' AND s.status NOT IN ('canceled')
        ORDER BY s.subject_id, s.created_at DESC
      `);
      const out = { ...acc };
      for (const r of rows) out[r.subject_id] = { ...(out[r.subject_id] ?? {}), plan: { name: r.name, key: r.key, status: r.status } };
      return out;
    });

    app.hooks.addFilter<Sql[], UserListFilterContext>('customers.users.filters', 'billing', async (conds, { query }) => {
      if (!app.modules.isEnabled('billing')) return conds;
      const extra: Sql[] = [];
      if (query.plan) {
        extra.push(sql`EXISTS (SELECT 1 FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.subject_type = 'user' AND s.subject_id = u.id AND p.key = ${query.plan} AND s.status IN ('active', 'trialing', 'past_due'))`);
      }
      if (query.subscriptionStatus) {
        extra.push(sql`EXISTS (SELECT 1 FROM subscriptions s WHERE s.subject_type = 'user' AND s.subject_id = u.id AND s.status = ${query.subscriptionStatus})`);
      }
      return [...conds, ...extra];
    });

    app.hooks.addFilter('customers.user.profile', 'billing', async (panels: Record<string, unknown>, ctx: { user: { id: string } }) => {
      if (!app.modules.isEnabled('billing')) return panels;
      const id = ctx.user.id;
      const [subscriptions, invoices, payments, totals] = await Promise.all([
        app.db.many(sql`SELECT s.id, s.status, s.quantity, s.currency, s.current_period_end, s.cancel_at_period_end, p.name AS product_name, pr.unit_amount, pr.interval FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id WHERE s.subject_type = 'user' AND s.subject_id = ${id} ORDER BY s.created_at DESC LIMIT 20`),
        app.db.many(sql`SELECT id, number, status, total, amount_due, amount_paid, currency, created_at FROM invoices WHERE user_id = ${id} OR (subject_type = 'user' AND subject_id = ${id}) ORDER BY created_at DESC LIMIT 20`),
        app.db.many(sql`SELECT id, status, amount, amount_refunded, currency, method_type, method_details, created_at FROM payments WHERE user_id = ${id} OR (subject_type = 'user' AND subject_id = ${id}) ORDER BY created_at DESC LIMIT 20`),
        app.db.many(sql`SELECT currency, sum(amount - amount_refunded)::bigint AS net FROM payments WHERE (user_id = ${id} OR (subject_type = 'user' AND subject_id = ${id})) AND status IN ('succeeded', 'partially_refunded', 'refunded') GROUP BY currency`),
      ]);
      return { ...panels, billing: { subscriptions, invoices, payments, revenueByCurrency: totals } };
    });

    app.hooks.addFilter('customers.organization.profile', 'billing', async (panels: Record<string, unknown>, ctx: { org: { id: string } }) => {
      if (!app.modules.isEnabled('billing')) return panels;
      const subscriptions = await app.db.many(sql`SELECT s.id, s.status, s.quantity, s.current_period_end, p.name AS product_name FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.subject_type = 'organization' AND s.subject_id = ${ctx.org.id} ORDER BY s.created_at DESC`);
      return { ...panels, billing: { subscriptions } };
    });

    app.hooks.addFilter('catalog.products.stats', 'billing', async (acc: Record<string, Record<string, unknown>>, ctx: { ids: string[] }) => {
      if (!app.modules.isEnabled('billing') || !ctx.ids.length) return acc;
      const rows = await app.db.many<{ product_id: string; active: number }>(sql`SELECT product_id, count(*)::int AS active FROM subscriptions WHERE product_id IN ${sql.in(ctx.ids)} AND status IN ('active', 'trialing', 'past_due') GROUP BY product_id`);
      const out = { ...acc };
      for (const r of rows) out[r.product_id] = { ...(out[r.product_id] ?? {}), active_subscriptions: r.active };
      return out;
    });

    addSearchProvider(app, 'billing', 'billing.invoices.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; number: string; status: string; total: number; currency: string }>(sql`
        SELECT id, number, status, total, currency FROM invoices WHERE number ILIKE ${likePattern(q)} OR id = ${q} LIMIT 5
      `);
      return rows.map((i) => ({ type: 'invoice', id: i.id, title: i.number ?? i.id, subtitle: `${i.status} · ${(i.total / 100).toFixed(2)} ${i.currency}`, url: `/revenue/invoices/${i.id}` }));
    });

    app.hooks.addFilter('privacy.export', 'billing', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      billing: {
        subscriptions: await ctx.db.many(sql`SELECT id, status, product_id, price_id, current_period_start, current_period_end, created_at FROM subscriptions WHERE subject_type = 'user' AND subject_id = ${ctx.userId}`),
        invoices: await ctx.db.many(sql`SELECT number, status, total, currency, created_at FROM invoices WHERE user_id = ${ctx.userId} OR (subject_type = 'user' AND subject_id = ${ctx.userId})`),
        payments: await ctx.db.many(sql`SELECT amount, currency, status, method_type, created_at FROM payments WHERE user_id = ${ctx.userId}`),
        profile: await ctx.db.maybe(sql`SELECT name, company, email, address, tax_id FROM billing_profiles WHERE subject_type = 'user' AND subject_id = ${ctx.userId}`),
      },
    }));

    // Invoices are retained for tax law; personal profile data is erased.
    app.hooks.addFilter('privacy.anonymize', 'billing', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      await ctx.db.exec(sql`UPDATE billing_profiles SET name = NULL, company = NULL, email = NULL, address = jsonb_build_object('country', address->>'country'), tax_id = NULL WHERE subject_type = 'user' AND subject_id = ${ctx.userId}`);
      await ctx.db.exec(sql`UPDATE payment_methods SET detached_at = coalesce(detached_at, ${app.clock.now()}) WHERE subject_type = 'user' AND subject_id = ${ctx.userId}`);
      return null;
    });

    registerApprovalExecutor(app, 'billing.refund', {
      approvePermission: 'billing.refunds.approve',
      async execute(tx, app, payload, approver) {
        const refund = await executeRefund(tx, app, { paymentId: payload.paymentId, amount: payload.amount, reason: payload.reason, revokeAccess: payload.revokeAccess, actor: approver, scope: null });
        return { refundId: refund.id, status: refund.status };
      },
    });

    app.hooks.addFilter('system.health', 'billing', async (checks: any[]) => {
      if (!app.modules.isEnabled('billing')) return checks;
      const gateways = await app.db.many<{ name: string; adapter: string; enabled: boolean; last_test_ok: boolean | null; last_test_message: string | null }>(sql`SELECT name, adapter, enabled, last_test_ok, last_test_message FROM payment_gateways WHERE enabled`);
      const failedEvents = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM gateway_events WHERE status = 'failed'`);
      const out = [...checks];
      for (const g of gateways) {
        out.push({ name: `Gateway: ${g.name}`, status: !adapters(app).has(g.adapter) ? 'down' : g.last_test_ok === false ? 'degraded' : g.last_test_ok ? 'ok' : 'unconfigured', detail: !adapters(app).has(g.adapter) ? 'Gateway plugin not active' : g.last_test_message ?? 'Connection not tested yet' });
      }
      if (!gateways.length) out.push({ name: 'Payment gateways', status: 'unconfigured', detail: 'No gateway connected yet' });
      out.push({ name: 'Gateway webhooks', status: failedEvents.count ? 'degraded' : 'ok', detail: `${failedEvents.count} failed webhook events` });
      return out;
    });

    // ---- Jobs --------------------------------------------------------------------------
    app.jobs.register('billing.renewals', async (_p, { app }) => {
      // Installment plans whose last payment is still due wait for dunning, not for renewal.
      const due = await app.db.many<{ id: string }>(sql`
        SELECT s.id FROM subscriptions s JOIN prices pr ON pr.id = s.price_id
        WHERE s.status IN ('active', 'trialing', 'past_due') AND s.current_period_end <= ${app.clock.now()}
          AND NOT (pr.payment_count IS NOT NULL AND s.installments_billed >= pr.payment_count AND s.installments_paid < pr.payment_count)
        ORDER BY s.current_period_end LIMIT 500
      `);
      for (const s of due) {
        try {
          await renewSubscription(app.db, app, s.id);
        } catch (err) {
          app.log.error({ err, subscriptionId: s.id }, 'renewal failed');
        }
      }
    }, { module: 'billing', timeoutMs: 15 * 60_000 });
    app.jobs.schedule({ key: 'billing.renewals', jobType: 'billing.renewals', intervalSeconds: 300, description: 'Renew subscriptions whose period ended (invoice + charge)', module: 'billing' });

    app.jobs.register('billing.dunning', async (_p, { app }) => {
      await runDunning(app);
    }, { module: 'billing' });
    app.jobs.schedule({ key: 'billing.dunning', jobType: 'billing.dunning', intervalSeconds: 3600, description: 'Retry failed payments and apply the dunning policy', module: 'billing' });

    app.jobs.register('billing.maintenance', async (_p, { app }) => {
      await expireCheckouts(app);
      const now = app.clock.now();
      const resume = await app.db.many<{ id: string }>(sql`SELECT id FROM subscriptions WHERE status = 'paused' AND resume_at IS NOT NULL AND resume_at <= ${now}`);
      for (const s of resume) await app.db.tx((tx) => resumeSubscription(tx, app, s.id, { type: 'system', id: null, label: 'Scheduled resume' }, null));
      const reminderDays = settingsOf(app).trialReminderDays;
      if (reminderDays > 0) {
        const soon = await app.db.many<any>(sql`
          SELECT id, subject_type, subject_id, trial_end FROM subscriptions
          WHERE status = 'trialing' AND trial_end <= ${new Date(now.getTime() + reminderDays * DAY)} AND trial_end > ${now}
            AND NOT (metadata ? 'trialReminderSent')
        `);
        for (const s of soon) {
          await app.db.tx(async (tx) => {
            await tx.exec(sql`UPDATE subscriptions SET metadata = metadata || '{"trialReminderSent": true}'::jsonb WHERE id = ${s.id}`);
            await app.events.emit(tx, 'subscription.trial_will_end', { subscriptionId: s.id, trialEnd: s.trial_end }, scopeOfSubject({ type: s.subject_type, id: s.subject_id }));
          });
        }
      }
    }, { module: 'billing' });
    app.jobs.schedule({ key: 'billing.maintenance', jobType: 'billing.maintenance', intervalSeconds: HOUR / 1000, description: 'Expire checkouts and abandoned carts, resume paused subscriptions, send trial reminders', module: 'billing' });

    app.jobs.register('billing.card_expiry', async (_p, { app }) => {
      await warnExpiringCards(app);
    }, { module: 'billing' });
    app.jobs.schedule({ key: 'billing.card_expiry', jobType: 'billing.card_expiry', intervalSeconds: DAY / 1000, description: 'Warn customers whose saved card for a subscription expires soon', module: 'billing' });
  },
  async start(app) {
    // Billing emails need editable templates; the table exists only when the email module is installed.
    if (app.modules.defs.some((m) => m.id === 'email')) await upsertSystemTemplates(app.db, app, BILLING_TEMPLATES);
  },
  routes(r, app) {
    registerAdminBillingRoutes(r, app);
    registerApiBillingRoutes(r, app);
    registerPublicBillingRoutes(r, app);
    registerVoucherRoutes(r, app);
  },
};

export type { App };
