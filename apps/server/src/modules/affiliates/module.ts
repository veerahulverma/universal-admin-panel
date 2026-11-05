import type { ModuleDefinition } from '../../core/modules.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { likePattern } from '../../core/validation.js';
import { registerApiScopes } from '../developers/keys.js';
import { addSearchProvider } from '../core/routes.js';
import { registerApprovalExecutor } from '../iam/approvals.js';
import { upsertSystemTemplates } from '../email/templates.js';
import { affiliateMigrations } from './migrations.js';
import { registerAffiliateRoutes } from './routes.js';
import { registerMaterialRoutes } from './routes-materials.js';
import {
  AFFILIATE_TEMPLATES,
  affiliateDefaults,
  affiliateSettingsSchema,
  affiliateStats,
  approveDueCommissions,
  attributeReferral,
  commissionForInvoice,
  createPayout,
  handleOrderPaid,
  reverseForPayment,
  settingsOf,
  SYSTEM,
} from './service.js';

export const affiliatesModule: ModuleDefinition = {
  id: 'affiliates',
  name: 'Affiliates & referrals',
  description: 'Referral links, click attribution, sub-IDs, commissions (one-time or recurring, multi-level), tiers, marketing materials, fraud signals and payouts.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers', 'developers', 'catalog', 'billing'],
  migrations: affiliateMigrations,
  permissions: [
    { key: 'affiliates.program.view', label: 'View affiliates, referrals, commissions and reports' },
    { key: 'affiliates.program.manage', label: 'Approve affiliates, edit terms, groups and uplines, review referrals and adjust commissions' },
    { key: 'affiliates.materials.manage', label: 'Create and upload affiliate marketing materials (banners, text links, files)' },
    { key: 'affiliates.payouts.manage', label: 'Create and record affiliate payouts', dangerous: true },
    { key: 'affiliates.payouts.approve', label: 'Approve large affiliate payouts (second approver)', dangerous: true },
  ],
  nav: [{ id: 'affiliates', label: 'Affiliates', path: '/growth/affiliates', icon: 'handshake', section: 'growth', permission: 'affiliates.program.view', order: 20 }],
  events: [
    { type: 'affiliate.applied', description: 'Someone applied to the affiliate program' },
    { type: 'affiliate.approved', description: 'An affiliate was approved' },
    { type: 'affiliate.rejected', description: 'An affiliate application was rejected' },
    { type: 'affiliate.suspended', description: 'An affiliate was suspended' },
    { type: 'affiliate.upline_changed', description: "An affiliate's recruiter (upline for multi-level commissions) was set or changed" },
    { type: 'referral.created', description: 'A customer was attributed to an affiliate (with the sub-ID, if any)' },
    { type: 'referral.converted', description: 'A referred customer made their first payment' },
    { type: 'commission.created', description: 'A commission was earned (level 1 for the referring affiliate, 2 and up for their upline)' },
    { type: 'commission.approved', description: 'A commission cleared its hold period and became payable' },
    { type: 'commission.reversed', description: 'A commission was reduced or reversed after a refund or chargeback' },
    { type: 'affiliate.payout_created', description: 'An affiliate payout was created' },
    { type: 'affiliate.payout_paid', description: 'An affiliate payout was sent' },
    { type: 'affiliate_material.created', description: 'A marketing material (banner, text link or file) was added for affiliates' },
    { type: 'affiliate_material.updated', description: 'A marketing material was changed, archived or given a new file' },
    { type: 'affiliate_material.deleted', description: 'A marketing material was deleted' },
  ],
  setup(app) {
    app.settings.define({
      key: 'affiliates',
      module: 'affiliates',
      label: 'Affiliate program',
      description: 'Attribution window and model, commission terms, hold period, payouts and fraud thresholds.',
      schema: affiliateSettingsSchema,
      defaults: affiliateDefaults,
      permission: 'affiliates.program.manage',
    });
    registerApiScopes(app, 'affiliates', [
      { scope: 'affiliates:read', description: 'Read referral attribution' },
      { scope: 'affiliates:write', description: 'Attribute customers to affiliates' },
    ]);
    // Lets "reset to default" in the template editor restore the shipped copy.
    app.services['email.extraTemplates'] = [...((app.services['email.extraTemplates'] as unknown[]) ?? []), ...AFFILIATE_TEMPLATES];

    // Attribution from the signup payload (`referralCode` may be a code or a click id).
    app.events.subscribe('affiliates.user-created', 'user.created', async (event, app) => {
      const code = event.data.referralCode as string | null;
      if (!code || !event.data.userId) return;
      await app.db.tx((tx) =>
        attributeReferral(tx, app, code.startsWith('clk_') ? { userId: event.data.userId, clickId: code } : { userId: event.data.userId, code }, SYSTEM),
      );
    }, { module: 'affiliates' });

    app.events.subscribe('affiliates.invoice-paid', 'invoice.paid', async (event, app) => {
      await commissionForInvoice(app, event.data.invoiceId);
    }, { module: 'affiliates' });

    app.events.subscribe('affiliates.order-paid', 'order.paid', async (event, app) => {
      if (event.data.couponId) await handleOrderPaid(app, event.data.orderId);
    }, { module: 'affiliates' });

    app.events.subscribe('affiliates.refund', 'refund.succeeded', async (event, app) => {
      await reverseForPayment(app, { paymentId: event.data.paymentId, amount: event.data.full ? 'full' : event.data.amount, reason: 'refund' });
    }, { module: 'affiliates' });

    app.events.subscribe('affiliates.chargeback', 'dispute.lost', async (event, app) => {
      await reverseForPayment(app, { paymentId: event.data.paymentId, amount: 'full', reason: 'chargeback lost' });
    }, { module: 'affiliates' });

    app.jobs.register('affiliates.approve_commissions', async (_p, { app }) => {
      await approveDueCommissions(app);
    }, { module: 'affiliates' });
    app.jobs.schedule({ key: 'affiliates.approve_commissions', jobType: 'affiliates.approve_commissions', intervalSeconds: 3600, description: 'Approve affiliate commissions whose hold period has passed', module: 'affiliates' });

    registerApprovalExecutor(app, 'affiliates.payout', {
      approvePermission: 'affiliates.payouts.approve',
      async execute(tx, app, payload, approver) {
        const payout = await createPayout(tx, app, { affiliateId: payload.affiliateId, currency: payload.currency, actor: approver });
        return { payoutId: payout.id, amount: payout.amount, currency: payout.currency };
      },
    });

    addSearchProvider(app, 'affiliates', 'affiliates.program.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; name: string; code: string; status: string }>(sql`
        SELECT id, name, code, status FROM affiliates WHERE name ILIKE ${likePattern(q)} OR email ILIKE ${likePattern(q)} OR code ILIKE ${likePattern(q)} LIMIT 5
      `);
      return rows.map((a) => ({ type: 'affiliate', id: a.id, title: a.name, subtitle: `${a.code} · ${a.status}`, url: `/growth/affiliates/${a.id}` }));
    });

    app.hooks.addFilter('customers.user.profile', 'affiliates', async (panels: Record<string, unknown>, ctx: { user: { id: string } }) => {
      if (!app.modules.isEnabled('affiliates')) return panels;
      const referredBy = await app.db.maybe(sql`
        SELECT r.id, r.attribution, r.status, r.fraud_flags, r.sub_id, r.converted_at, r.created_at, a.id AS affiliate_id, a.name AS affiliate_name, a.code AS affiliate_code
        FROM referrals r JOIN affiliates a ON a.id = r.affiliate_id WHERE r.user_id = ${ctx.user.id}
      `);
      const own = await app.db.maybe<{ id: string; code: string; status: string }>(sql`SELECT id, code, status FROM affiliates WHERE user_id = ${ctx.user.id}`);
      return { ...panels, affiliates: { referredBy, affiliate: own ? { ...own, stats: await affiliateStats(app.db, own.id) } : null } };
    });

    app.hooks.addFilter('privacy.export', 'affiliates', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      affiliate: await ctx.db.maybe(sql`SELECT code, name, email, status, website, terms_accepted_at, created_at FROM affiliates WHERE user_id = ${ctx.userId}`),
      referral: await ctx.db.maybe(sql`SELECT r.attribution, r.status, r.created_at, a.code AS affiliate_code FROM referrals r JOIN affiliates a ON a.id = r.affiliate_id WHERE r.user_id = ${ctx.userId}`),
    }));

    // Commission and payout records stay for accounting; identity and payout/tax details go.
    app.hooks.addFilter('privacy.anonymize', 'affiliates', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      const aff = await ctx.db.maybe<{ id: string }>(sql`SELECT id FROM affiliates WHERE user_id = ${ctx.userId}`);
      if (aff) {
        await ctx.db.exec(sql`
          UPDATE affiliates SET name = 'Deleted affiliate', email = ${`deleted+${aff.id}@anonymized.invalid`}, website = NULL, notes = NULL,
            promotion_method = NULL, application_ip_hash = NULL, status = CASE WHEN status = 'approved' THEN 'suspended' ELSE status END,
            status_reason = 'anonymized', updated_at = ${app.clock.now()}
          WHERE id = ${aff.id}
        `);
        await app.secrets.delete(ctx.db, 'affiliate', aff.id);
      }
      await ctx.db.exec(sql`UPDATE referrals SET ip_hash = NULL WHERE user_id = ${ctx.userId}`);
      return null;
    });

    app.hooks.addFilter('system.retention', 'affiliates', async (_v: unknown, ctx: { before: (days: number) => Date }) => {
      if (!app.modules.isEnabled('affiliates')) return null;
      await app.db.exec(sql`DELETE FROM affiliate_clicks WHERE created_at < ${ctx.before(settingsOf(app).clickRetentionDays)}`);
      return null;
    });
  },
  async start(app) {
    // Affiliate emails (approval, payout sent) need editable templates; the table exists only when the email module is installed.
    if (app.modules.defs.some((m) => m.id === 'email')) await upsertSystemTemplates(app.db, app, AFFILIATE_TEMPLATES);
  },
  routes(r, app) {
    registerAffiliateRoutes(r, app);
    registerMaterialRoutes(r, app);
  },
};
