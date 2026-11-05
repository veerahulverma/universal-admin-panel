import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { currencyCode, email as emailSchema, likePattern, pageQuery, paginate, qDate } from '../../core/validation.js';
import { DAY } from '../../core/clock.js';
import { getUser } from '../customers/service.js';
import {
  affiliateStats,
  assertCodeFree,
  attributeReferral,
  cancelPayout,
  cleanSubId,
  createAffiliate,
  findApprovedByCode,
  getAffiliate,
  ipHash,
  landingUrl,
  markPayoutPaid,
  networkSummary,
  payableBalance,
  recordClick,
  recruiterFor,
  requestPayout,
  setAffiliateParent,
  setAffiliateSecrets,
  setAffiliateStatus,
  settingsOf,
  subIdReport,
  subIdSchema,
  termsFor,
  uplineChain,
  winningClick,
  type AffiliateRow,
} from './service.js';
import { assertNotTargeted } from './materials.js';

export const VISITOR_COOKIE = 'stw_aff_vid';
const MATERIAL_ID_RE = /^amat_[0-9a-z]{26}$/;

/** Report period from `from`/`to` query values (default: the last 30 days). */
function period(query: { from?: Date; to?: Date }, now: Date): { from: Date; to: Date } {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - 30 * DAY);
  if (from > to) throw validationError([{ path: ['from'], message: 'from must be before to' }]);
  return { from, to };
}

/** The signed-in customer's affiliate account. */
export async function ownAffiliate(app: App, userId: string): Promise<AffiliateRow> {
  const aff = await app.db.maybe<AffiliateRow>(sql`SELECT * FROM affiliates WHERE user_id = ${userId}`);
  if (!aff) throw notFound('Affiliate account');
  return aff;
}

/** Upline levels and rates as shown to affiliates and administrators. */
function uplineLevels(app: App): { level: number; ratePercent: number }[] {
  return settingsOf(app).uplineRatesBps.map((bps, i) => ({ level: i + 2, ratePercent: bps / 100 }));
}

export async function assertGroup(db: Db, id: string): Promise<void> {
  if (!(await db.maybe(sql`SELECT 1 FROM affiliate_groups WHERE id = ${id}`))) throw validationError([{ path: ['groupId'], message: 'Choose an existing affiliate group' }]);
}

const commissionOverrides = {
  commissionType: z.enum(['percent', 'fixed']).nullable().optional(),
  ratePercent: z.number().min(0).max(100).nullable().optional(),
  fixedAmount: z.number().int().min(0).nullable().optional(),
  recurring: z.boolean().nullable().optional(),
  recurringMonths: z.number().int().min(0).max(120).nullable().optional(),
};

function presentAffiliate(a: any) {
  return {
    id: a.id,
    userId: a.user_id,
    email: a.email,
    name: a.name,
    code: a.code,
    status: a.status,
    statusReason: a.status_reason,
    commissionType: a.commission_type,
    ratePercent: a.rate_bps === null ? null : a.rate_bps / 100,
    fixedAmount: a.fixed_amount,
    recurring: a.recurring,
    recurringMonths: a.recurring_months,
    tierId: a.tier_id,
    groupId: a.group_id,
    parentId: a.parent_id,
    parentSource: a.parent_source,
    website: a.website,
    promotionMethod: a.promotion_method,
    payoutMethod: a.payout_method,
    notes: a.notes,
    termsAcceptedAt: a.terms_accepted_at,
    approvedAt: a.approved_at,
    createdAt: a.created_at,
  };
}

export function registerAffiliateRoutes(r: Router, app: App): void {
  // ---- Public tracking link -------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/r/:code',
    auth: 'public',
    summary: 'Affiliate tracking link: records the click and redirects to your app',
    description:
      'Appends `ref` (winning affiliate code), `click` (click id) and, when the winning click carried one, `sub` (the affiliate\'s sub-ID) to the landing URL. Pass `click` to POST /api/v1/referrals at signup. `to` may only be a same-site path or an allowlisted host. `sub` labels the affiliate\'s own campaign (letters, numbers, dots, dashes, underscores; anything else is ignored) and `m` is set by marketing-material links.',
    tags: ['Affiliates'],
    params: z.object({ code: z.string().max(64) }),
    // Lenient on purpose: a malformed sub-ID or material id is dropped, never a reason to fail a click.
    query: z.object({ to: z.string().max(2000).optional(), sub: z.unknown().optional(), m: z.unknown().optional() }),
    rateLimit: { max: 120, windowSec: 60, key: 'affiliate-click' },
    handler: async (c) => {
      const aff = await findApprovedByCode(app.db, c.params.code);
      if (!aff) return c.reply.redirect(landingUrl(app, c.query.to, {}), 302);
      let visitorId = c.req.cookies?.[VISITOR_COOKIE];
      if (!visitorId || !/^v_[A-Za-z0-9]{24}$/.test(visitorId)) visitorId = `v_${randomBase62(24)}`;
      const referrer = c.req.headers.referer;
      const subId = cleanSubId(c.query.sub);
      const material = typeof c.query.m === 'string' && MATERIAL_ID_RE.test(c.query.m) ? await app.db.maybe<{ id: string }>(sql`SELECT id FROM affiliate_materials WHERE id = ${c.query.m}`) : null;
      const clickId = await recordClick(app.db, app, {
        affiliateId: aff.id,
        visitorId,
        ip: c.ip,
        userAgent: c.userAgent,
        landingPath: c.query.to ?? null,
        referrer: typeof referrer === 'string' ? referrer : null,
        subId,
        materialId: material?.id ?? null,
      });
      const winner = (await winningClick(app.db, app, visitorId)) ?? { id: clickId, code: aff.code, sub_id: subId };
      c.reply.setCookie(VISITOR_COOKIE, visitorId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: app.config.cookieSecure,
        maxAge: settingsOf(app).cookieDays * 86_400,
      });
      return c.reply.redirect(landingUrl(app, c.query.to, { ref: winner.code, click: winner.id, ...(winner.sub_id ? { sub: winner.sub_id } : {}) }), 302);
    },
  });

  // ---- Integration API ----------------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/v1/referrals',
    auth: 'api',
    scope: 'affiliates:write',
    summary: 'Attribute a new customer to an affiliate (by click id or referral code)',
    description:
      'Call at signup with the `click` value from the landing URL (preferred: honours first/last-click settings and the attribution window) or a referral `code`. Pass `subId` when the visitor arrived with the affiliate\'s sub-ID (for example `?ref=CODE&sub=spring-campaign`); a tracked click\'s own sub-ID takes precedence. A customer is only ever referred once.',
    tags: ['Affiliates'],
    body: z
      .object({ userId: z.string(), clickId: z.string().optional(), code: z.string().max(64).optional(), subId: subIdSchema.optional(), ip: z.string().max(64).optional() })
      .refine((b) => b.clickId || b.code, 'clickId or code is required'),
    handler: async (c) => {
      await getUser(app.db, c.body.userId, c.orgScope());
      const result = await app.db.tx((tx) => attributeReferral(tx, app, { userId: c.body.userId, clickId: c.body.clickId, code: c.body.code, subId: c.body.subId, ip: c.body.ip }, c.actor));
      return {
        attributed: result.attributed,
        reason: result.reason ?? null,
        referral: result.referral
          ? { id: result.referral.id, affiliateId: result.referral.affiliate_id, attribution: result.referral.attribution, status: result.referral.status, subId: result.referral.sub_id ?? null }
          : null,
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/referrals/:userId',
    auth: 'api',
    scope: 'affiliates:read',
    summary: 'Which affiliate referred a customer',
    tags: ['Affiliates'],
    params: z.object({ userId: z.string() }),
    handler: async (c) => {
      await getUser(app.db, c.params.userId, c.orgScope());
      const ref = await app.db.maybe<any>(sql`
        SELECT r.id, r.attribution, r.status, r.sub_id, r.converted_at, r.created_at, a.code, a.id AS affiliate_id FROM referrals r JOIN affiliates a ON a.id = r.affiliate_id WHERE r.user_id = ${c.params.userId}
      `);
      if (!ref) throw notFound('Referral');
      return { id: ref.id, affiliateId: ref.affiliate_id, code: ref.code, attribution: ref.attribution, status: ref.status, subId: ref.sub_id, convertedAt: ref.converted_at, createdAt: ref.created_at };
    },
  });

  // ---- Client API (affiliate portal) -------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/client/affiliate',
    auth: 'client',
    summary: "The signed-in customer's affiliate account, link, stats and commissions",
    tags: ['Client'],
    handler: async (c) => {
      const p = c.customer();
      const s = settingsOf(app);
      const aff = await app.db.maybe<any>(sql`SELECT * FROM affiliates WHERE user_id = ${p.userId}`);
      const program = {
        termsUrl: s.termsUrl || null,
        commissionType: s.commissionType,
        ratePercent: s.defaultRateBps / 100,
        recurring: s.recurring,
        cookieDays: s.cookieDays,
        uplineLevels: uplineLevels(app),
      };
      if (!aff) return { affiliate: null, program };
      const [stats, network, commissions, payouts] = await Promise.all([
        affiliateStats(app.db, aff.id),
        networkSummary(app.db, aff.id),
        app.db.many(sql`
          SELECT id, kind, level, amount, reversed_amount, currency, status, sub_id, hold_until, created_at FROM affiliate_commissions
          WHERE affiliate_id = ${aff.id} ORDER BY created_at DESC LIMIT 50
        `),
        app.db.many(sql`SELECT id, amount, currency, status, paid_at, created_at FROM affiliate_payouts WHERE affiliate_id = ${aff.id} ORDER BY created_at DESC LIMIT 20`),
      ]);
      return {
        affiliate: { id: aff.id, code: aff.code, status: aff.status, link: `${app.config.appUrl}/r/${aff.code}`, createdAt: aff.created_at },
        program,
        stats,
        network,
        commissions,
        payouts,
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/affiliate/apply',
    auth: 'client',
    summary: 'Apply to the affiliate program',
    description:
      'The affiliate who referred the applicant becomes their upline for multi-level commissions: pass `referredBy` (a referral code or the `click` id from a tracking link), otherwise the affiliate who referred the customer is used.',
    tags: ['Client'],
    rateLimit: { max: 5, windowSec: 3600, by: 'principal' },
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      website: z.string().url().max(500).optional(),
      promotionMethod: z.string().max(1000).optional(),
      acceptTerms: z.literal(true),
      payoutDetails: z.string().max(2000).optional(),
      taxInfo: z.string().max(2000).optional(),
      referredBy: z.string().trim().max(64).optional(),
    }),
    handler: async (c) => {
      const p = c.customer();
      const user = await getUser(app.db, p.userId, null);
      const aff = await app.db.tx(async (tx) => {
        const created = await createAffiliate(tx, app, {
          email: user.email,
          name: c.body.name ?? user.name ?? user.email,
          userId: user.id,
          status: settingsOf(app).autoApprove ? 'approved' : 'pending',
          website: c.body.website,
          promotionMethod: c.body.promotionMethod,
          termsAccepted: true,
          ip: c.ip,
          payoutDetails: c.body.payoutDetails,
          taxInfo: c.body.taxInfo,
        }, c.actor);
        const recruiter = await recruiterFor(tx, app, { userId: user.id, referredBy: c.body.referredBy });
        return recruiter ? setAffiliateParent(tx, app, created.id, recruiter.id, 'referral', c.actor) : created;
      });
      return { affiliate: { id: aff.id, code: aff.code, status: aff.status, link: `${app.config.appUrl}/r/${aff.code}` } };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/affiliate/sub-ids',
    auth: 'client',
    summary: "Your clicks, signups, conversions and commissions per sub-ID (default: the last 30 days)",
    tags: ['Client'],
    query: z.object({ from: qDate.optional(), to: qDate.optional() }),
    handler: async (c) => {
      const aff = await ownAffiliate(app, c.customer().userId);
      const range = period(c.query, app.clock.now());
      return { ...range, data: await subIdReport(app.db, aff.id, range) };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/client/affiliate/payout-details',
    auth: 'client',
    summary: 'Update your payout and tax details (stored encrypted)',
    tags: ['Client'],
    body: z.object({ payoutDetails: z.string().max(2000).optional(), taxInfo: z.string().max(2000).optional(), payoutMethod: z.string().max(50).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const aff = await tx.maybe<{ id: string }>(sql`SELECT id FROM affiliates WHERE user_id = ${c.customer().userId}`);
        if (!aff) throw notFound('Affiliate account');
        await setAffiliateSecrets(tx, app, aff.id, c.body);
        if (c.body.payoutMethod) await tx.exec(sql`UPDATE affiliates SET payout_method = ${c.body.payoutMethod}, updated_at = ${app.clock.now()} WHERE id = ${aff.id}`);
        await c.audit(tx, 'affiliate.payout_details_update', { type: 'affiliate', id: aff.id });
        return { ok: true };
      }),
  });

  // ---- Admin: affiliates ---------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/affiliates',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Affiliates with lifetime performance',
    tags: ['Affiliates'],
    query: z.object({
      ...pageQuery,
      status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(),
      q: z.string().max(100).optional(),
      groupId: z.string().max(60).optional(),
      /** Affiliates recruited by this affiliate (their direct downline). */
      parentId: z.string().max(60).optional(),
    }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`a.*, g.name AS group_name, p.name AS parent_name, p.code AS parent_code,
          (SELECT count(*)::int FROM affiliates d WHERE d.parent_id = a.id) AS recruits,
          (SELECT count(*)::int FROM affiliate_clicks k WHERE k.affiliate_id = a.id) AS clicks,
          (SELECT count(*)::int FROM referrals r WHERE r.affiliate_id = a.id) AS referrals,
          (SELECT count(*)::int FROM referrals r WHERE r.affiliate_id = a.id AND r.status = 'converted') AS conversions,
          (SELECT count(*)::int FROM referrals r WHERE r.affiliate_id = a.id AND jsonb_array_length(r.fraud_flags) > 0 AND r.reviewed_at IS NULL) AS flagged_referrals,
          (SELECT coalesce(jsonb_object_agg(x.currency, x.total), '{}'::jsonb) FROM (
            SELECT currency, sum(amount - reversed_amount)::bigint AS total FROM affiliate_commissions ac
            WHERE ac.affiliate_id = a.id AND ac.status IN ('pending', 'approved', 'paid') GROUP BY currency) x) AS earnings`,
        from: sql`affiliates a LEFT JOIN affiliate_groups g ON g.id = a.group_id LEFT JOIN affiliates p ON p.id = a.parent_id`,
        where: sql.where([
          c.query.status && sql`a.status = ${c.query.status}`,
          c.query.q && sql`(a.name ILIKE ${likePattern(c.query.q)} OR a.email ILIKE ${likePattern(c.query.q)} OR a.code ILIKE ${likePattern(c.query.q)})`,
          c.query.groupId && sql`a.group_id = ${c.query.groupId}`,
          c.query.parentId && sql`a.parent_id = ${c.query.parentId}`,
        ]),
        orderBy: sql`ORDER BY a.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliates',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Add an affiliate (approved immediately)',
    tags: ['Affiliates'],
    body: z.object({
      email: emailSchema,
      name: z.string().trim().min(1).max(120),
      userId: z.string().optional(),
      code: z.string().max(32).optional(),
      website: z.string().max(500).optional(),
      notes: z.string().max(2000).optional(),
      payoutMethod: z.string().max(50).optional(),
      groupId: z.string().max(60).nullable().optional(),
      /** The affiliate who recruited this one (their upline for multi-level commissions). */
      parentId: z.string().max(60).nullable().optional(),
      ...commissionOverrides,
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        if (c.body.userId) await getUser(tx, c.body.userId, c.orgScope());
        if (c.body.groupId) await assertGroup(tx, c.body.groupId);
        let aff = await createAffiliate(tx, app, {
          ...c.body,
          rateBps: c.body.ratePercent === undefined || c.body.ratePercent === null ? c.body.ratePercent : Math.round(c.body.ratePercent * 100),
          status: 'approved',
        }, c.actor);
        if (c.body.groupId) await tx.exec(sql`UPDATE affiliates SET group_id = ${c.body.groupId} WHERE id = ${aff.id}`);
        if (c.body.parentId) aff = await setAffiliateParent(tx, app, aff.id, c.body.parentId, 'admin', c.actor);
        return presentAffiliate(await getAffiliate(tx, aff.id));
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/affiliates/:id',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Affiliate details, effective commission terms, stats and balances',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const aff = await getAffiliate(app.db, c.params.id);
      const levels = uplineLevels(app);
      const [stats, terms, payable, secrets, tier, group, upline, network] = await Promise.all([
        affiliateStats(app.db, aff.id),
        termsFor(app.db, app, aff),
        payableBalance(app.db, aff.id),
        app.secrets.describe(app.db, 'affiliate', aff.id),
        aff.tier_id ? app.db.maybe(sql`SELECT id, name, rate_bps FROM affiliate_tiers WHERE id = ${aff.tier_id}`) : null,
        aff.group_id ? app.db.maybe(sql`SELECT id, name FROM affiliate_groups WHERE id = ${aff.group_id}`) : null,
        // At least the recruiter, even when multi-level commissions are off.
        uplineChain(app.db, aff.id, Math.max(1, levels.length)),
        networkSummary(app.db, aff.id),
      ]);
      return {
        ...presentAffiliate(aff),
        stats,
        terms: { ...terms, ratePercent: terms.rateBps / 100 },
        tier,
        group,
        // Who earns on this affiliate's sales, and at what rate (null: not paid at that depth).
        upline: upline.map((u) => ({ ...u, ratePercent: levels.find((l) => l.level === u.level)?.ratePercent ?? null })),
        network,
        payable,
        // Only masked hints of sensitive payout/tax data are ever returned.
        sensitive: secrets.map((s) => ({ name: s.name, last4: s.last4, updatedAt: s.updatedAt })),
      };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/affiliates/:id',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Edit an affiliate (code, group, upline, commission overrides, notes)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      code: z.string().max(32).optional(),
      website: z.string().max(500).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      payoutMethod: z.string().max(50).nullable().optional(),
      groupId: z.string().max(60).nullable().optional(),
      /** The affiliate who recruited this one; null removes the upline. Loops are refused. */
      parentId: z.string().max(60).nullable().optional(),
      ...commissionOverrides,
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await getAffiliate(tx, c.params.id, { lock: true });
        if (c.body.code && c.body.code.toLowerCase() !== before.code.toLowerCase()) await assertCodeFree(tx, c.body.code, before.id);
        if (c.body.groupId) await assertGroup(tx, c.body.groupId);
        const patch = {
          name: c.body.name,
          code: c.body.code,
          website: c.body.website,
          notes: c.body.notes,
          payout_method: c.body.payoutMethod,
          group_id: c.body.groupId,
          commission_type: c.body.commissionType,
          rate_bps: c.body.ratePercent === undefined ? undefined : c.body.ratePercent === null ? null : Math.round(c.body.ratePercent * 100),
          fixed_amount: c.body.fixedAmount,
          recurring: c.body.recurring,
          recurring_months: c.body.recurringMonths,
        };
        await tx.exec(sql`UPDATE affiliates SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${before.id}`);
        if (c.body.parentId !== undefined) await setAffiliateParent(tx, app, before.id, c.body.parentId, 'admin', c.actor);
        await c.audit(tx, 'affiliate.update', { type: 'affiliate', id: before.id }, c.body);
        return presentAffiliate(await getAffiliate(tx, before.id));
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/affiliates/:id/sub-ids',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: "An affiliate's clicks, signups, conversions and commissions per sub-ID (default: the last 30 days)",
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    query: z.object({ from: qDate.optional(), to: qDate.optional() }),
    handler: async (c) => {
      const aff = await getAffiliate(app.db, c.params.id);
      const range = period(c.query, app.clock.now());
      return { ...range, data: await subIdReport(app.db, aff.id, range) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliates/:id/status',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Approve, reject, suspend or reactivate an affiliate',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: z.object({ action: z.enum(['approve', 'reject', 'suspend', 'reactivate']), reason: z.string().max(1000).optional() }),
    handler: async (c) => presentAffiliate(await app.db.tx((tx) => setAffiliateStatus(tx, app, c.params.id, c.body.action, c.body.reason ?? null, c.actor))),
  });

  r.route({
    method: 'PUT',
    url: '/api/admin/affiliates/:id/payout-details',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    sensitive: true,
    summary: 'Replace payout or tax details (write-only; stored encrypted)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: z.object({ payoutDetails: z.string().max(2000).optional(), taxInfo: z.string().max(2000).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const aff = await getAffiliate(tx, c.params.id);
        await setAffiliateSecrets(tx, app, aff.id, c.body);
        await c.audit(tx, 'affiliate.payout_details_update', { type: 'affiliate', id: aff.id }, { fields: Object.keys(c.body) });
        return { sensitive: (await app.secrets.describe(tx, 'affiliate', aff.id)).map((s) => ({ name: s.name, last4: s.last4 })) };
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliates/:id/adjustments',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    sensitive: true,
    summary: 'Manual commission adjustment (positive or negative), approved immediately',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: z.object({ amount: z.number().int().refine((n) => n !== 0, 'Amount cannot be zero'), currency: currencyCode, reason: z.string().trim().min(3).max(500) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const aff = await getAffiliate(tx, c.params.id);
        const now = app.clock.now();
        const row = await tx.one(sql.insert('affiliate_commissions', {
          id: newId('com'),
          affiliate_id: aff.id,
          kind: 'adjustment',
          amount: c.body.amount,
          currency: c.body.currency,
          status: 'approved',
          reason: c.body.reason,
          created_by: c.admin().adminId,
          approved_at: now,
          created_at: now,
        }));
        await c.audit(tx, 'affiliate.commission_adjust', { type: 'affiliate', id: aff.id }, c.body);
        return row;
      }),
  });

  // ---- Admin: commissions & referrals ------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/affiliate-commissions',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Commissions across affiliates',
    tags: ['Affiliates'],
    query: z.object({
      ...pageQuery,
      affiliateId: z.string().optional(),
      status: z.enum(['pending', 'approved', 'paid', 'reversed', 'rejected']).optional(),
      flagged: z.enum(['true', 'false']).optional(),
      kind: z.enum(['sale', 'upline', 'adjustment', 'clawback']).optional(),
      subId: z.string().max(64).optional(),
    }),
    handler: (c) =>
      paginate(app.db, {
        // Upline commissions name the affiliate whose sale earned them.
        select: sql`c.*, a.name AS affiliate_name, a.code AS affiliate_code, i.number AS invoice_number,
                    sa.id AS source_affiliate_id, sa.name AS source_affiliate_name, sa.code AS source_affiliate_code`,
        from: sql`affiliate_commissions c JOIN affiliates a ON a.id = c.affiliate_id LEFT JOIN invoices i ON i.id = c.invoice_id
                  LEFT JOIN affiliate_commissions sc ON sc.id = c.source_commission_id LEFT JOIN affiliates sa ON sa.id = sc.affiliate_id`,
        where: sql.where([
          c.query.affiliateId && sql`c.affiliate_id = ${c.query.affiliateId}`,
          c.query.status && sql`c.status = ${c.query.status}`,
          c.query.flagged && sql`c.flagged = ${c.query.flagged === 'true'}`,
          c.query.kind && sql`c.kind = ${c.query.kind}`,
          c.query.subId && sql`c.sub_id = ${c.query.subId}`,
        ]),
        orderBy: sql`ORDER BY c.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliate-commissions/:id/:action',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Approve (including flagged) or reject a commission',
    tags: ['Affiliates'],
    params: z.object({ id: z.string(), action: z.enum(['approve', 'reject']) }),
    body: z.object({ reason: z.string().max(500).optional() }).default({}),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const com = await tx.maybe<any>(sql`SELECT * FROM affiliate_commissions WHERE id = ${c.params.id} FOR UPDATE`);
        if (!com) throw notFound('Commission');
        if (com.payout_id || com.status === 'paid') throw conflict('This commission is already part of a payout', 'commission_in_payout');
        const allowed = c.params.action === 'approve' ? ['pending'] : ['pending', 'approved'];
        if (!allowed.includes(com.status)) throw conflict(`Cannot ${c.params.action} a ${com.status} commission`, 'invalid_transition');
        const now = app.clock.now();
        await tx.exec(sql`
          UPDATE affiliate_commissions SET status = ${c.params.action === 'approve' ? 'approved' : 'rejected'}, flagged = FALSE,
            approved_at = ${c.params.action === 'approve' ? now : null}, reason = coalesce(${c.body.reason ?? null}, reason) WHERE id = ${com.id}
        `);
        await c.audit(tx, `affiliate.commission_${c.params.action}`, { type: 'affiliate', id: com.affiliate_id }, { commissionId: com.id, reason: c.body.reason });
        if (c.params.action === 'approve') await app.events.emit(tx, 'commission.approved', { commissionId: com.id, affiliateId: com.affiliate_id, amount: com.amount, currency: com.currency });
        return tx.one(sql`SELECT * FROM affiliate_commissions WHERE id = ${com.id}`);
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/referrals',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Referred customers with attribution and fraud signals',
    tags: ['Affiliates'],
    query: z.object({ ...pageQuery, affiliateId: z.string().optional(), status: z.enum(['pending', 'converted', 'rejected']).optional(), flagged: z.enum(['true', 'false']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`r.id, r.affiliate_id, r.user_id, r.click_id, r.attribution, r.status, r.fraud_flags, r.sub_id, r.reviewed_at, r.converted_at, r.created_at,
                    a.name AS affiliate_name, a.code AS affiliate_code, u.email AS user_email`,
        from: sql`referrals r JOIN affiliates a ON a.id = r.affiliate_id JOIN users u ON u.id = r.user_id`,
        where: sql.where([
          c.query.affiliateId && sql`r.affiliate_id = ${c.query.affiliateId}`,
          c.query.status && sql`r.status = ${c.query.status}`,
          c.query.flagged === 'true' && sql`jsonb_array_length(r.fraud_flags) > 0 AND r.reviewed_at IS NULL`,
          c.query.flagged === 'false' && sql`(jsonb_array_length(r.fraud_flags) = 0 OR r.reviewed_at IS NOT NULL)`,
        ]),
        orderBy: sql`ORDER BY r.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/referrals',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Manually credit a customer to an affiliate',
    tags: ['Affiliates'],
    body: z.object({ userId: z.string(), affiliateId: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getUser(tx, c.body.userId, c.orgScope());
        const result = await attributeReferral(tx, app, { userId: c.body.userId, affiliateId: c.body.affiliateId, attribution: 'manual' }, c.actor);
        if (!result.attributed) throw conflict(`Not attributed: ${result.reason}`, result.reason ?? 'not_attributed');
        return result.referral;
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/referrals/:id/:action',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Mark a flagged referral as reviewed, or reject it (and its unpaid commissions)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string(), action: z.enum(['clear-flags', 'reject']) }),
    body: z.object({ note: z.string().max(1000).optional() }).default({}),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const ref = await tx.maybe<any>(sql`SELECT * FROM referrals WHERE id = ${c.params.id} FOR UPDATE`);
        if (!ref) throw notFound('Referral');
        const now = app.clock.now();
        if (c.params.action === 'clear-flags') {
          await tx.exec(sql`UPDATE referrals SET reviewed_at = ${now}, reviewed_by = ${c.admin().adminId} WHERE id = ${ref.id}`);
          await tx.exec(sql`UPDATE affiliate_commissions SET flagged = FALSE WHERE referral_id = ${ref.id} AND status = 'pending'`);
        } else {
          await tx.exec(sql`UPDATE referrals SET status = 'rejected', reviewed_at = ${now}, reviewed_by = ${c.admin().adminId} WHERE id = ${ref.id}`);
          await tx.exec(sql`UPDATE affiliate_commissions SET status = 'rejected', flagged = FALSE WHERE referral_id = ${ref.id} AND status IN ('pending', 'approved') AND payout_id IS NULL`);
        }
        await c.audit(tx, `referral.${c.params.action === 'reject' ? 'reject' : 'review'}`, { type: 'user', id: ref.user_id }, { referralId: ref.id, note: c.body.note });
        return tx.one(sql`SELECT * FROM referrals WHERE id = ${ref.id}`);
      }),
  });

  // ---- Admin: tiers -------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/affiliate-tiers',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Commission tiers',
    tags: ['Affiliates'],
    handler: async () => ({ data: await app.db.many(sql`SELECT * FROM affiliate_tiers ORDER BY metric, threshold`) }),
  });

  const tierBody = z.object({ name: z.string().trim().min(1).max(80), metric: z.enum(['revenue', 'conversions']), threshold: z.number().int().min(0), ratePercent: z.number().min(0).max(100) });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliate-tiers',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Create a tier (rate applies once an affiliate reaches the threshold)',
    tags: ['Affiliates'],
    body: tierBody,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.one(sql.insert('affiliate_tiers', { id: newId('atr'), name: c.body.name, metric: c.body.metric, threshold: c.body.threshold, rate_bps: Math.round(c.body.ratePercent * 100), created_at: app.clock.now() }));
        await c.audit(tx, 'affiliate.tier_create', { type: 'affiliate_tier', id: row.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/affiliate-tiers/:id',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Update a tier',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: tierBody.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.maybe(sql`
          UPDATE affiliate_tiers SET ${sql.set({ name: c.body.name, metric: c.body.metric, threshold: c.body.threshold, rate_bps: c.body.ratePercent === undefined ? undefined : Math.round(c.body.ratePercent * 100) })}
          WHERE id = ${c.params.id} RETURNING *
        `);
        if (!row) throw notFound('Tier');
        await c.audit(tx, 'affiliate.tier_update', { type: 'affiliate_tier', id: c.params.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/affiliate-tiers/:id',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Delete a tier (not while marketing materials are limited to it)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        await assertNotTargeted(tx, 'tier_ids', c.params.id);
        const n = await tx.exec(sql`DELETE FROM affiliate_tiers WHERE id = ${c.params.id}`);
        if (!n) throw notFound('Tier');
        await c.audit(tx, 'affiliate.tier_delete', { type: 'affiliate_tier', id: c.params.id });
      });
    },
  });

  // ---- Admin: payouts -----------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/affiliate-payouts',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Affiliate payouts',
    tags: ['Affiliates'],
    query: z.object({ ...pageQuery, affiliateId: z.string().optional(), status: z.enum(['pending', 'paid', 'canceled']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`p.*, a.name AS affiliate_name, a.code AS affiliate_code`,
        from: sql`affiliate_payouts p JOIN affiliates a ON a.id = p.affiliate_id`,
        where: sql.where([c.query.affiliateId && sql`p.affiliate_id = ${c.query.affiliateId}`, c.query.status && sql`p.status = ${c.query.status}`]),
        orderBy: sql`ORDER BY p.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliates/:id/payouts',
    auth: 'admin',
    permission: 'affiliates.payouts.manage',
    sensitive: true,
    summary: 'Pay out the approved balance in a currency (large payouts need a second approver)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: z.object({ currency: currencyCode }),
    handler: async (c) => app.db.tx((tx) => requestPayout(tx, app, { affiliateId: c.params.id, currency: c.body.currency, actor: c.actor, adminId: c.admin().adminId })),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliate-payouts/:id/:action',
    auth: 'admin',
    permission: 'affiliates.payouts.manage',
    sensitive: true,
    summary: 'Mark a payout as paid (with the transfer reference) or cancel it',
    tags: ['Affiliates'],
    params: z.object({ id: z.string(), action: z.enum(['mark-paid', 'cancel']) }),
    body: z.object({ reference: z.string().max(200).optional(), method: z.string().max(50).optional() }).default({}),
    handler: async (c) =>
      app.db.tx((tx) =>
        c.params.action === 'mark-paid'
          ? markPayoutPaid(tx, app, c.params.id, { reference: c.body.reference ?? null, method: c.body.method ?? null }, c.actor)
          : cancelPayout(tx, app, c.params.id, c.actor),
      ),
  });

  // ---- Admin: reports -----------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/affiliate-report',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Clicks, signups, conversions, revenue and commissions by affiliate for a period',
    tags: ['Affiliates'],
    query: z.object({ from: qDate.optional(), to: qDate.optional() }),
    handler: async (c) => {
      const to = c.query.to ?? app.clock.now();
      const from = c.query.from ?? new Date(to.getTime() - 30 * DAY);
      if (from > to) throw validationError([{ path: ['from'], message: 'from must be before to' }]);
      const [byAffiliate, money, daily] = await Promise.all([
        app.db.many(sql`
          SELECT a.id, a.name, a.code,
            (SELECT count(*)::int FROM affiliate_clicks k WHERE k.affiliate_id = a.id AND k.created_at BETWEEN ${from} AND ${to}) AS clicks,
            (SELECT count(*)::int FROM referrals r WHERE r.affiliate_id = a.id AND r.created_at BETWEEN ${from} AND ${to}) AS signups,
            (SELECT count(*)::int FROM referrals r WHERE r.affiliate_id = a.id AND r.converted_at BETWEEN ${from} AND ${to}) AS conversions
          FROM affiliates a WHERE a.status IN ('approved', 'suspended') ORDER BY signups DESC, clicks DESC
        `),
        app.db.many(sql`
          SELECT affiliate_id, currency, coalesce(sum(base_amount) FILTER (WHERE kind = 'sale'), 0)::bigint AS revenue,
                 coalesce(sum(amount - reversed_amount) FILTER (WHERE status <> 'rejected'), 0)::bigint AS commissions
          FROM affiliate_commissions WHERE created_at BETWEEN ${from} AND ${to} GROUP BY affiliate_id, currency
        `),
        app.db.many(sql`
          SELECT d::date AS day,
            (SELECT count(*)::int FROM affiliate_clicks k WHERE k.created_at >= d AND k.created_at < d + interval '1 day') AS clicks,
            (SELECT count(*)::int FROM referrals r WHERE r.created_at >= d AND r.created_at < d + interval '1 day') AS signups,
            (SELECT count(*)::int FROM referrals r WHERE r.converted_at >= d AND r.converted_at < d + interval '1 day') AS conversions
          FROM generate_series(date_trunc('day', ${from}::timestamptz), date_trunc('day', ${to}::timestamptz), interval '1 day') d ORDER BY d
        `),
      ]);
      const moneyBy = new Map<string, any[]>();
      for (const m of money as any[]) moneyBy.set(m.affiliate_id, [...(moneyBy.get(m.affiliate_id) ?? []), { currency: m.currency, revenue: m.revenue, commissions: m.commissions }]);
      const rows = (byAffiliate as any[]).map((a) => ({ ...a, conversionRate: a.clicks ? a.conversions / a.clicks : null, money: moneyBy.get(a.id) ?? [] }));
      const totals = rows.reduce((t, r) => ({ clicks: t.clicks + r.clicks, signups: t.signups + r.signups, conversions: t.conversions + r.conversions }), { clicks: 0, signups: 0, conversions: 0 });
      return { from, to, totals, affiliates: rows, daily };
    },
  });
}

export { ipHash };
