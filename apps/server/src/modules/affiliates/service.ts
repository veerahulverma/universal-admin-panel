import { z } from 'zod';
import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { hmacSha256 } from '../../core/crypto.js';
import { DAY, HOUR } from '../../core/clock.js';
import { writeAudit } from '../../core/audit.js';
import { addInterval, formatMoney } from '../billing/money.js';
import { convert, settingsOf as billingSettingsOf } from '../billing/engine.js';
import { notifyAdmins } from '../iam/notify.js';
import { requestApproval } from '../iam/approvals.js';
import { sendSystemEmail, type SystemEmail } from '../core/mail.js';
import type { TemplateDefinition } from '../email/templates.js';

const button = (urlVar: string, label: string) =>
  `<p style="margin:28px 0"><a href="{{${urlVar}}}" style="background:{{brandColor}};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">${label}</a></p>`;

/** Emails this module sends; registered with the email module so administrators can edit them. */
export const AFFILIATE_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'affiliates.approved',
    name: 'Affiliate approved',
    description: 'Sent when an affiliate application is approved.',
    category: 'transactional',
    subject: "You're in: the {{appName}} affiliate program",
    html: `<p>Hi {{name}},</p><p>Your affiliate application was approved. Share your personal link to start earning commissions:</p><p style="font-family:monospace;font-size:15px;background:#f3f4f6;padding:10px 14px;border-radius:6px;word-break:break-all">{{link}}</p><p>Your referral code is <strong>{{code}}</strong>.</p>${button('link', 'Open your link')}`,
    variables: ['name', 'code', 'link'],
    sampleData: { name: 'Sam', code: 'sam24', link: 'https://app.example.com/r/sam24' },
  },
  {
    key: 'affiliates.payout_paid',
    name: 'Affiliate payout sent',
    description: 'Confirms an affiliate payout was sent.',
    category: 'transactional',
    subject: 'Your {{appName}} affiliate payout of {{amount}} is on its way',
    html: `<p>Hi {{name}},</p><p>We sent your affiliate payout of <strong>{{amount}}</strong>.{{#if reference}} Transfer reference: <strong>{{reference}}</strong>.{{/if}}</p><p>Thank you for recommending {{appName}}.</p>`,
    variables: ['name', 'amount', 'reference'],
    sampleData: { name: 'Sam', amount: '$125.00', reference: 'WIRE-2026-0042' },
  },
];

/** Upline levels that can earn on a sale (levels 2 to 6); deeper chains are not paid. */
export const MAX_UPLINE_LEVELS = 5;

export const affiliateSettingsSchema = z.object({
  /** Approve applications automatically instead of reviewing them. */
  autoApprove: z.boolean(),
  /** Attribution window: how long a click can still earn a referral. */
  cookieDays: z.number().int().min(1).max(365),
  attribution: z.enum(['first_click', 'last_click']),
  commissionType: z.enum(['percent', 'fixed']),
  defaultRateBps: z.number().int().min(0).max(10_000),
  /** Fixed commission per paid invoice, in `fixedCurrency` minor units. */
  defaultFixedAmount: z.number().int().min(0),
  fixedCurrency: z.string().length(3),
  recurring: z.boolean(),
  /** How long recurring commissions last after the first conversion; 0 = for the customer's lifetime. */
  recurringMonths: z.number().int().min(0).max(120),
  holdDays: z.number().int().min(0).max(365),
  minPayout: z.number().int().min(0),
  /** Payouts at or above this amount need a second approver; 0 disables. */
  payoutApprovalThreshold: z.number().int().min(0),
  /** Where tracking links land (defaults to the general app URL). */
  landingUrl: z.string().max(500),
  allowedRedirectHosts: z.array(z.string().max(253)).max(50),
  signupVelocityThreshold: z.number().int().min(2).max(10_000),
  conversionVelocityPerHour: z.number().int().min(2).max(10_000),
  clickRetentionDays: z.number().int().min(30).max(3650),
  termsUrl: z.string().max(500),
  /**
   * Multi-level commissions: the share of each sale paid to the referring affiliate's upline, by level
   * ([level 2, level 3, …]) in basis points of the same base as the direct commission. Empty = off.
   */
  uplineRatesBps: z.array(z.number().int().min(0).max(10_000)).max(MAX_UPLINE_LEVELS),
  /** Commissions on an affiliate's own purchases (at any level): held for review, or never created. */
  ownPurchases: z.enum(['review', 'never']),
});
export type AffiliateSettings = z.infer<typeof affiliateSettingsSchema>;

export const affiliateDefaults: AffiliateSettings = {
  autoApprove: false,
  cookieDays: 30,
  attribution: 'last_click',
  commissionType: 'percent',
  defaultRateBps: 2000,
  defaultFixedAmount: 0,
  fixedCurrency: 'USD',
  recurring: true,
  recurringMonths: 12,
  holdDays: 30,
  minPayout: 5000,
  payoutApprovalThreshold: 50_000,
  landingUrl: '',
  allowedRedirectHosts: [],
  signupVelocityThreshold: 5,
  conversionVelocityPerHour: 10,
  clickRetentionDays: 365,
  termsUrl: '',
  uplineRatesBps: [],
  ownPurchases: 'review',
};

export const settingsOf = (app: App) => app.settings.get<AffiliateSettings>('affiliates');

export const SYSTEM: Actor = { type: 'system', id: null, label: 'Affiliate program' };

export interface AffiliateRow {
  id: string;
  user_id: string | null;
  email: string;
  name: string;
  code: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  commission_type: 'percent' | 'fixed' | null;
  rate_bps: number | null;
  fixed_amount: number | null;
  recurring: boolean | null;
  recurring_months: number | null;
  tier_id: string | null;
  group_id: string | null;
  parent_id: string | null;
  application_ip_hash: string | null;
}

export interface FraudFlag {
  type: 'self_referral' | 'same_email_domain' | 'same_ip_as_affiliate' | 'signup_velocity' | 'conversion_velocity';
  detail: string;
  at: Date;
}

const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** Sub-IDs are the affiliate's own campaign labels (`/r/CODE?sub=spring-campaign`). */
export const SUB_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const subIdSchema = z.string().trim().regex(SUB_ID_RE, 'Use up to 64 letters, numbers, dots, dashes or underscores');

/** A sub-ID from a tracking link; anything malformed is dropped rather than failing the click. */
export function cleanSubId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return SUB_ID_RE.test(v) ? v : null;
}

/** Clicks and referrals keep a keyed hash of the IP, never the IP itself. */
export function ipHash(app: App, ip: string | null | undefined): string | null {
  if (!ip) return null;
  return hmacSha256(app.config.encryptionKeys, `affiliate-ip:${ip}`).slice(0, 32);
}

/** Best-effort email: affiliate workflows must never fail because a template or provider is missing. */
export async function notify(app: App, db: Db, email: SystemEmail): Promise<void> {
  try {
    await db.tx((inner) => sendSystemEmail(app, inner, email));
  } catch (err) {
    app.log.warn({ err, template: email.template }, 'affiliate email could not be queued');
  }
}

async function uniqueCode(db: Db, seed: string): Promise<string> {
  const base = seed.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 10) || 'ref';
  for (let i = 0; i < 20; i++) {
    const code = `${base}${randomBase62(4).toLowerCase()}`;
    if (!(await db.maybe(sql`SELECT 1 FROM affiliates WHERE lower(code) = ${code}`))) return code;
  }
  return randomBase62(14).toLowerCase();
}

export async function assertCodeFree(db: Db, code: string, exceptId?: string): Promise<void> {
  if (!CODE_RE.test(code)) throw validationError([{ path: ['code'], message: 'Use 3-32 letters, numbers, dashes or underscores' }]);
  const clash = await db.maybe(sql`SELECT 1 FROM affiliates WHERE lower(code) = ${code.toLowerCase()} ${exceptId ? sql`AND id <> ${exceptId}` : sql.empty}`);
  if (clash) throw conflict('This referral code is already taken', 'code_taken');
}

export interface AffiliateInput {
  email: string;
  name: string;
  userId?: string | null;
  code?: string | null;
  status: 'pending' | 'approved';
  commissionType?: 'percent' | 'fixed' | null;
  rateBps?: number | null;
  fixedAmount?: number | null;
  recurring?: boolean | null;
  recurringMonths?: number | null;
  website?: string | null;
  promotionMethod?: string | null;
  payoutMethod?: string | null;
  notes?: string | null;
  termsAccepted?: boolean;
  ip?: string | null;
  payoutDetails?: string | null;
  taxInfo?: string | null;
}

export async function getAffiliate(db: Db, id: string, opts: { lock?: boolean } = {}): Promise<AffiliateRow & Record<string, any>> {
  const row = await db.maybe<AffiliateRow & Record<string, any>>(sql`SELECT * FROM affiliates WHERE id = ${id} ${opts.lock ? sql`FOR UPDATE` : sql.empty}`);
  if (!row) throw notFound('Affiliate');
  return row;
}

export async function setAffiliateSecrets(db: Db, app: App, affiliateId: string, input: { payoutDetails?: string | null; taxInfo?: string | null }): Promise<void> {
  if (input.payoutDetails) await app.secrets.set(db, 'affiliate', affiliateId, 'payout_details', input.payoutDetails);
  if (input.taxInfo) await app.secrets.set(db, 'affiliate', affiliateId, 'tax_info', input.taxInfo);
}

export async function createAffiliate(db: Db, app: App, input: AffiliateInput, actor: Actor): Promise<AffiliateRow> {
  const email = input.email.trim().toLowerCase();
  if (await db.maybe(sql`SELECT 1 FROM affiliates WHERE lower(email) = ${email}`)) throw conflict('An affiliate with this email already exists', 'affiliate_exists');
  if (input.userId && (await db.maybe(sql`SELECT 1 FROM affiliates WHERE user_id = ${input.userId}`))) throw conflict('This user is already an affiliate', 'affiliate_exists');
  let code = input.code?.trim();
  if (code) await assertCodeFree(db, code);
  else code = await uniqueCode(db, input.name || email.split('@')[0]);
  const now = app.clock.now();
  const id = newId('aff');
  await db.exec(sql.insert('affiliates', {
    id,
    user_id: input.userId ?? null,
    email,
    name: input.name,
    code,
    status: input.status,
    commission_type: input.commissionType ?? null,
    rate_bps: input.rateBps ?? null,
    fixed_amount: input.fixedAmount ?? null,
    recurring: input.recurring ?? null,
    recurring_months: input.recurringMonths ?? null,
    website: input.website ?? null,
    promotion_method: input.promotionMethod ?? null,
    payout_method: input.payoutMethod ?? null,
    notes: input.notes ?? null,
    application_ip_hash: ipHash(app, input.ip),
    terms_accepted_at: input.termsAccepted ? now : null,
    approved_at: input.status === 'approved' ? now : null,
    approved_by: input.status === 'approved' ? actor.id : null,
    created_at: now,
    updated_at: now,
  }, ''));
  await setAffiliateSecrets(db, app, id, input);
  await writeAudit(db, app, { actor, action: 'affiliate.create', targetType: 'affiliate', targetId: id, metadata: { email, status: input.status, code } });
  await app.events.emit(db, input.status === 'approved' ? 'affiliate.approved' : 'affiliate.applied', { affiliateId: id, email, code }, input.userId ? { userId: input.userId } : {});
  if (input.status === 'pending') {
    await notifyAdmins(db, app, { permission: 'affiliates.program.manage', type: 'affiliate.applied', title: 'New affiliate application', body: `${input.name} <${email}>`, link: '/growth/affiliates', severity: 'info' });
  }
  return getAffiliate(db, id);
}

const TRANSITIONS: Record<string, { from: AffiliateRow['status'][]; to: AffiliateRow['status'] }> = {
  approve: { from: ['pending', 'rejected'], to: 'approved' },
  reject: { from: ['pending'], to: 'rejected' },
  suspend: { from: ['approved'], to: 'suspended' },
  reactivate: { from: ['suspended'], to: 'approved' },
};

export async function setAffiliateStatus(db: Db, app: App, id: string, action: keyof typeof TRANSITIONS, reason: string | null, actor: Actor): Promise<AffiliateRow> {
  const aff = await getAffiliate(db, id, { lock: true });
  const t = TRANSITIONS[action];
  if (!t.from.includes(aff.status)) throw conflict(`Cannot ${action} an affiliate that is ${aff.status}`, 'invalid_transition');
  const now = app.clock.now();
  await db.exec(sql`
    UPDATE affiliates SET status = ${t.to}, status_reason = ${reason}, updated_at = ${now},
      approved_at = ${t.to === 'approved' && !aff.approved_at ? now : aff.approved_at}, approved_by = ${t.to === 'approved' ? actor.id : aff.approved_by}
    WHERE id = ${id}
  `);
  await writeAudit(db, app, { actor, action: `affiliate.${action}`, targetType: 'affiliate', targetId: id, metadata: { reason, previous: aff.status } });
  await app.events.emit(db, `affiliate.${t.to}`, { affiliateId: id, reason }, aff.user_id ? { userId: aff.user_id } : {});
  if (action === 'approve') {
    await notify(app, db, { to: aff.email, template: 'affiliates.approved', data: { name: aff.name, code: aff.code, link: `${app.config.appUrl}/r/${aff.code}` }, userId: aff.user_id });
  }
  return getAffiliate(db, id);
}

// ---- Terms & tiers ------------------------------------------------------------------

export interface CommissionTerms {
  type: 'percent' | 'fixed';
  rateBps: number;
  fixedAmount: number;
  fixedCurrency: string;
  recurring: boolean;
  recurringMonths: number;
  tierId: string | null;
}

export async function affiliateMetrics(db: Db, app: App, affiliateId: string): Promise<{ revenue: number; conversions: number }> {
  const base = billingSettingsOf(app).baseCurrency;
  const rows = await db.many<{ currency: string; total: number }>(sql`
    SELECT currency, coalesce(sum(base_amount), 0) AS total FROM affiliate_commissions
    WHERE affiliate_id = ${affiliateId} AND kind = 'sale' AND status NOT IN ('rejected', 'reversed') GROUP BY currency
  `);
  let revenue = 0;
  for (const r of rows) revenue += (await convert(db, r.total, r.currency, base)) ?? r.total;
  const conv = await db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM referrals WHERE affiliate_id = ${affiliateId} AND status = 'converted'`);
  return { revenue, conversions: conv.count };
}

/** The best tier an affiliate qualifies for (highest rate among tiers whose threshold is met). */
export async function currentTier(db: Db, app: App, affiliateId: string): Promise<{ id: string; name: string; rate_bps: number } | null> {
  const tiers = await db.many<{ id: string; name: string; metric: 'revenue' | 'conversions'; threshold: number; rate_bps: number }>(sql`SELECT * FROM affiliate_tiers`);
  if (!tiers.length) return null;
  const m = await affiliateMetrics(db, app, affiliateId);
  const qualifying = tiers.filter((t) => (t.metric === 'revenue' ? m.revenue : m.conversions) >= t.threshold).sort((a, b) => b.rate_bps - a.rate_bps);
  return qualifying[0] ?? null;
}

/** Effective terms: affiliate-specific overrides beat the tier, the tier beats program defaults. */
export async function termsFor(db: Db, app: App, aff: AffiliateRow): Promise<CommissionTerms> {
  const s = settingsOf(app);
  const tier = await currentTier(db, app, aff.id);
  return {
    type: aff.commission_type ?? s.commissionType,
    rateBps: aff.rate_bps ?? tier?.rate_bps ?? s.defaultRateBps,
    fixedAmount: aff.fixed_amount ?? s.defaultFixedAmount,
    fixedCurrency: s.fixedCurrency,
    recurring: aff.recurring ?? s.recurring,
    recurringMonths: aff.recurring_months ?? s.recurringMonths,
    tierId: tier?.id ?? null,
  };
}

async function refreshTier(db: Db, app: App, affiliateId: string): Promise<void> {
  const tier = await currentTier(db, app, affiliateId);
  await db.exec(sql`UPDATE affiliates SET tier_id = ${tier?.id ?? null} WHERE id = ${affiliateId} AND tier_id IS DISTINCT FROM ${tier?.id ?? null}`);
}

// ---- Upline (multi-level) ----------------------------------------------------------------

/** Advisory lock serializing upline changes, so two concurrent edits can never close a loop between them. */
const UPLINE_LOCK = 72_710_101;
/** Bound on upline walks; real chains are far shorter, so this only stops a corrupted one. */
const MAX_CHAIN_DEPTH = 100;

/**
 * Record who recruited an affiliate (their upline). Refuses self-references and any parent that is
 * already in the affiliate's downline, so the upline graph stays a tree.
 */
export async function setAffiliateParent(
  db: Db,
  app: App,
  affiliateId: string,
  parentId: string | null,
  source: 'referral' | 'admin',
  actor: Actor,
): Promise<AffiliateRow> {
  await db.query(sql`SELECT pg_advisory_xact_lock(${UPLINE_LOCK})`);
  const aff = await getAffiliate(db, affiliateId, { lock: true });
  if (aff.parent_id === parentId) return aff;
  if (parentId) {
    if (parentId === aff.id) throw conflict('An affiliate cannot be their own upline', 'affiliate_loop');
    const parent = await db.maybe<{ name: string }>(sql`SELECT name FROM affiliates WHERE id = ${parentId}`);
    if (!parent) throw validationError([{ path: ['parentId'], message: 'Choose an existing affiliate' }]);
    const loop = await db.maybe(sql`
      WITH RECURSIVE chain (id, parent_id, depth) AS (
        SELECT id, parent_id, 1 FROM affiliates WHERE id = ${parentId}
        UNION ALL
        SELECT a.id, a.parent_id, c.depth + 1 FROM affiliates a JOIN chain c ON a.id = c.parent_id WHERE c.depth < ${MAX_CHAIN_DEPTH}
      )
      SELECT 1 FROM chain WHERE id = ${aff.id} LIMIT 1
    `);
    if (loop) throw conflict(`${parent.name} was recruited through ${aff.name}, so they cannot also be ${aff.name}'s upline`, 'affiliate_loop');
  }
  await db.exec(sql`UPDATE affiliates SET parent_id = ${parentId}, parent_source = ${parentId ? source : null}, updated_at = ${app.clock.now()} WHERE id = ${aff.id}`);
  await writeAudit(db, app, { actor, action: 'affiliate.upline_change', targetType: 'affiliate', targetId: aff.id, metadata: { parentId, previousParentId: aff.parent_id, source } });
  await app.events.emit(db, 'affiliate.upline_changed', { affiliateId: aff.id, parentId, previousParentId: aff.parent_id, source }, aff.user_id ? { userId: aff.user_id } : {});
  return getAffiliate(db, aff.id);
}

/**
 * Who recruited a new affiliate: the referral code or click id passed with the application, else the
 * affiliate who referred them as a customer.
 */
export async function recruiterFor(db: Db, app: App, input: { userId: string; referredBy?: string | null }): Promise<AffiliateRow | null> {
  if (input.referredBy) {
    let recruiter: AffiliateRow | null = null;
    if (input.referredBy.startsWith('clk_')) {
      const click = await db.maybe<{ visitor_id: string }>(sql`SELECT visitor_id FROM affiliate_clicks WHERE id = ${input.referredBy}`);
      const winner = click ? await winningClick(db, app, click.visitor_id) : null;
      if (winner) recruiter = await db.maybe<AffiliateRow>(sql`SELECT * FROM affiliates WHERE id = ${winner.affiliate_id}`);
    } else {
      recruiter = await findApprovedByCode(db, input.referredBy);
    }
    if (recruiter) return recruiter;
  }
  return db.maybe<AffiliateRow>(sql`
    SELECT a.* FROM referrals r JOIN affiliates a ON a.id = r.affiliate_id WHERE r.user_id = ${input.userId} AND r.status <> 'rejected'
  `);
}

export interface UplineMember {
  level: number;
  id: string;
  name: string;
  code: string;
  status: AffiliateRow['status'];
}

/** The affiliates above this one, nearest first: level 2 is the recruiter, level 3 their recruiter, … */
export async function uplineChain(db: Db, affiliateId: string, levels: number): Promise<UplineMember[]> {
  if (levels <= 0) return [];
  return db.many<UplineMember>(sql`
    WITH RECURSIVE chain (id, parent_id, level, path) AS (
      SELECT p.id, p.parent_id, 2, ARRAY[a.id, p.id] FROM affiliates a JOIN affiliates p ON p.id = a.parent_id WHERE a.id = ${affiliateId}
      UNION ALL
      SELECT p.id, p.parent_id, c.level + 1, c.path || p.id FROM affiliates p JOIN chain c ON p.id = c.parent_id
      WHERE c.level < ${levels + 1} AND NOT p.id = ANY (c.path)
    )
    SELECT c.level, a.id, a.name, a.code, a.status FROM chain c JOIN affiliates a ON a.id = c.id ORDER BY c.level
  `);
}

/** Size of an affiliate's own network and what it earned them, by level. */
export async function networkSummary(db: Db, affiliateId: string): Promise<{ recruits: number; earnings: { level: number; currency: string; amount: number }[] }> {
  const [recruits, earnings] = await Promise.all([
    db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM affiliates WHERE parent_id = ${affiliateId}`),
    db.many<{ level: number; currency: string; amount: number }>(sql`
      SELECT level, currency, coalesce(sum(amount - reversed_amount), 0)::bigint AS amount FROM affiliate_commissions
      WHERE affiliate_id = ${affiliateId} AND kind = 'upline' AND status NOT IN ('rejected', 'reversed')
      GROUP BY level, currency ORDER BY level, currency
    `),
  ]);
  return { recruits: recruits.count, earnings };
}

// ---- Clicks & attribution --------------------------------------------------------------

export interface ClickRow {
  id: string;
  affiliate_id: string;
  visitor_id: string;
  ip_hash: string | null;
  sub_id: string | null;
  created_at: Date;
  code: string;
}

export async function findApprovedByCode(db: Db, code: string): Promise<AffiliateRow | null> {
  return db.maybe<AffiliateRow>(sql`SELECT * FROM affiliates WHERE lower(code) = ${code.toLowerCase()} AND status = 'approved'`);
}

export async function recordClick(
  db: Db,
  app: App,
  input: {
    affiliateId: string;
    visitorId: string;
    ip: string;
    userAgent: string;
    landingPath: string | null;
    referrer: string | null;
    subId?: string | null;
    materialId?: string | null;
  },
): Promise<string> {
  const id = newId('clk');
  await db.exec(sql.insert('affiliate_clicks', {
    id,
    affiliate_id: input.affiliateId,
    visitor_id: input.visitorId,
    ip_hash: ipHash(app, input.ip),
    user_agent: input.userAgent.slice(0, 300),
    landing_path: input.landingPath?.slice(0, 500) ?? null,
    referrer: input.referrer?.slice(0, 500) ?? null,
    sub_id: input.subId ?? null,
    material_id: input.materialId ?? null,
    created_at: app.clock.now(),
  }, ''));
  return id;
}

/** The click that wins attribution for a visitor: first or last approved-affiliate click inside the window. */
export async function winningClick(db: Db, app: App, visitorId: string): Promise<ClickRow | null> {
  const s = settingsOf(app);
  const windowStart = new Date(app.clock.now().getTime() - s.cookieDays * DAY);
  const clicks = await db.many<ClickRow>(sql`
    SELECT c.id, c.affiliate_id, c.visitor_id, c.ip_hash, c.sub_id, c.created_at, a.code FROM affiliate_clicks c JOIN affiliates a ON a.id = c.affiliate_id
    WHERE c.visitor_id = ${visitorId} AND c.created_at >= ${windowStart} AND a.status = 'approved'
    ORDER BY c.created_at ASC, c.id ASC
  `);
  if (!clicks.length) return null;
  return s.attribution === 'first_click' ? clicks[0] : clicks[clicks.length - 1];
}

/**
 * Landing URL for a tracking link. Only same-origin relative paths or hosts on
 * the allowlist are honoured, so /r/:code can never be used as an open redirect.
 */
export function landingUrl(app: App, to: string | undefined, params: Record<string, string>): string {
  const s = settingsOf(app);
  const general = app.settings.get<{ appUrl: string }>('general');
  const base = new URL(s.landingUrl || general.appUrl || app.config.appUrl);
  let target = new URL(base.toString());
  if (to) {
    if (to.startsWith('/') && !to.startsWith('//') && !to.includes('\\')) {
      const candidate = new URL(to, base);
      if (candidate.origin === base.origin) target = candidate;
    } else {
      try {
        const abs = new URL(to);
        const allowed = s.allowedRedirectHosts.map((h) => h.toLowerCase());
        if ((abs.protocol === 'https:' || abs.protocol === 'http:') && allowed.includes(abs.hostname.toLowerCase())) target = abs;
      } catch {
        /* not a URL: fall back to the landing page */
      }
    }
  }
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return target.toString();
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com', 'example.com',
]);

/**
 * Signals worth a human look. They never block or ban anyone: flagged referrals
 * still exist, but their commissions wait for manual review instead of being
 * auto-approved.
 */
async function fraudSignals(db: Db, app: App, aff: AffiliateRow, user: { id: string; email: string }, hash: string | null): Promise<FraudFlag[]> {
  const now = app.clock.now();
  const flags: FraudFlag[] = [];
  const affEmail = aff.email.toLowerCase();
  const userEmail = user.email.toLowerCase();
  if (aff.user_id === user.id || affEmail === userEmail) {
    flags.push({ type: 'self_referral', detail: 'The referred account belongs to the affiliate', at: now });
  } else {
    const d1 = affEmail.split('@')[1];
    const d2 = userEmail.split('@')[1];
    if (d1 && d1 === d2 && !FREE_MAIL.has(d1)) flags.push({ type: 'same_email_domain', detail: `Affiliate and customer both use @${d1}`, at: now });
  }
  if (hash) {
    const own = new Set<string>();
    if (aff.application_ip_hash) own.add(aff.application_ip_hash);
    if (aff.user_id) {
      const ips = await db.many<{ ip: string }>(sql`SELECT DISTINCT ip FROM login_events WHERE subject_type = 'user' AND subject_id = ${aff.user_id} AND ip IS NOT NULL LIMIT 200`);
      for (const r of ips) own.add(ipHash(app, r.ip)!);
    }
    if (own.has(hash)) flags.push({ type: 'same_ip_as_affiliate', detail: "Signed up from the affiliate's own network", at: now });
    const recent = await db.one<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM referrals WHERE affiliate_id = ${aff.id} AND ip_hash = ${hash} AND created_at >= ${new Date(now.getTime() - DAY)}
    `);
    if (recent.count + 1 >= settingsOf(app).signupVelocityThreshold) {
      flags.push({ type: 'signup_velocity', detail: `${recent.count + 1} referred signups from one network in 24 hours`, at: now });
    }
  }
  return flags;
}

export interface AttributionInput {
  userId: string;
  code?: string | null;
  clickId?: string | null;
  affiliateId?: string | null;
  attribution?: 'code' | 'coupon' | 'manual';
  ip?: string | null;
  /** The affiliate's campaign label; a winning click's own sub-ID takes precedence. */
  subId?: string | null;
}

export interface AttributionResult {
  attributed: boolean;
  reason?: 'already_referred' | 'click_not_found' | 'attribution_window_expired' | 'unknown_code' | 'affiliate_inactive' | 'user_not_found';
  referral?: any;
}

/** Credit a customer to an affiliate. A customer can only ever be referred once. */
export async function attributeReferral(db: Db, app: App, input: AttributionInput, actor: Actor): Promise<AttributionResult> {
  const user = await db.maybe<{ id: string; email: string }>(sql`SELECT id, email FROM users WHERE id = ${input.userId} AND deleted_at IS NULL`);
  if (!user) return { attributed: false, reason: 'user_not_found' };
  const existing = await db.maybe(sql`SELECT * FROM referrals WHERE user_id = ${user.id}`);
  if (existing) return { attributed: false, reason: 'already_referred', referral: existing };

  let affiliate: AffiliateRow | null = null;
  let attribution: string;
  let clickId: string | null = null;
  let subId = input.subId ?? null;
  let hash = ipHash(app, input.ip);
  if (input.clickId) {
    const click = await db.maybe<{ visitor_id: string }>(sql`SELECT visitor_id FROM affiliate_clicks WHERE id = ${input.clickId}`);
    if (!click) return { attributed: false, reason: 'click_not_found' };
    const winner = await winningClick(db, app, click.visitor_id);
    if (!winner) return { attributed: false, reason: 'attribution_window_expired' };
    affiliate = await db.one<AffiliateRow>(sql`SELECT * FROM affiliates WHERE id = ${winner.affiliate_id}`);
    attribution = settingsOf(app).attribution;
    clickId = winner.id;
    subId = winner.sub_id ?? subId;
    hash = hash ?? winner.ip_hash;
  } else if (input.code) {
    affiliate = await findApprovedByCode(db, input.code);
    if (!affiliate) return { attributed: false, reason: 'unknown_code' };
    attribution = 'code';
  } else if (input.affiliateId) {
    affiliate = await db.maybe<AffiliateRow>(sql`SELECT * FROM affiliates WHERE id = ${input.affiliateId}`);
    if (!affiliate || affiliate.status !== 'approved') return { attributed: false, reason: 'affiliate_inactive' };
    attribution = input.attribution ?? 'manual';
  } else {
    throw validationError([{ path: ['code'], message: 'Provide a referral code, click id or affiliate' }]);
  }

  const flags = await fraudSignals(db, app, affiliate, user, hash);
  const now = app.clock.now();
  const referral = await db.maybe<any>(sql`
    INSERT INTO referrals (id, affiliate_id, user_id, click_id, attribution, status, ip_hash, fraud_flags, sub_id, created_at)
    VALUES (${newId('rfl')}, ${affiliate.id}, ${user.id}, ${clickId}, ${attribution}, 'pending', ${hash}, ${sql.json(flags)}, ${subId}, ${now})
    ON CONFLICT (user_id) DO NOTHING RETURNING *
  `);
  if (!referral) return { attributed: false, reason: 'already_referred', referral: await db.maybe(sql`SELECT * FROM referrals WHERE user_id = ${user.id}`) };
  await writeAudit(db, app, { actor, action: 'referral.create', targetType: 'user', targetId: user.id, metadata: { affiliateId: affiliate.id, attribution, subId, flags: flags.map((f) => f.type) } });
  await app.events.emit(db, 'referral.created', { referralId: referral.id, affiliateId: affiliate.id, userId: user.id, attribution, subId, flagged: flags.length > 0 }, { userId: user.id });
  if (flags.length) await flagAlert(db, app, referral.id, affiliate, flags);
  return { attributed: true, referral };
}

async function flagAlert(db: Db, app: App, referralId: string, aff: AffiliateRow, flags: FraudFlag[]): Promise<void> {
  await notifyAdmins(db, app, {
    permission: 'affiliates.program.manage',
    type: 'affiliate.fraud_flag',
    title: `Referral needs review (${aff.code})`,
    body: flags.map((f) => f.detail).join('; '),
    link: '/growth/affiliates',
    severity: 'warning',
    data: { referralId, affiliateId: aff.id },
  });
}

// ---- Commissions -------------------------------------------------------------------------

async function purchaserOf(db: Db, row: { user_id: string | null; subject_type: string; subject_id: string }): Promise<string | null> {
  if (row.user_id) return row.user_id;
  if (row.subject_type === 'user') return row.subject_id;
  const org = await db.maybe<{ owner_user_id: string | null }>(sql`SELECT owner_user_id FROM organizations WHERE id = ${row.subject_id}`);
  return org?.owner_user_id ?? null;
}

/** A purchase by the affiliate: through their linked customer account, or from their own address. */
function isOwnPurchase(aff: Pick<AffiliateRow, 'user_id' | 'email'>, purchaser: { id: string; email: string }): boolean {
  return aff.user_id === purchaser.id || aff.email.toLowerCase() === purchaser.email.toLowerCase();
}

export interface CommissionOutcome {
  created: boolean;
  reason?: string;
  commissionId?: string;
  /** Commissions for the referring affiliate's upline on the same invoice, nearest level first. */
  uplineCommissionIds?: string[];
}

/**
 * Create the commission for a paid invoice of a referred customer. Idempotent:
 * a unique index allows one sale commission per invoice, so repeated or
 * concurrent events (invoice.paid and order.paid) never double-pay.
 */
export async function commissionForInvoice(app: App, invoiceId: string): Promise<CommissionOutcome> {
  return app.db.tx(async (tx) => {
    const inv = await tx.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${invoiceId}`);
    if (!inv || inv.status !== 'paid') return { created: false, reason: 'not_paid' };
    const existing = await tx.maybe<{ id: string }>(sql`SELECT id FROM affiliate_commissions WHERE invoice_id = ${invoiceId} AND kind = 'sale'`);
    if (existing) return { created: false, reason: 'exists', commissionId: existing.id };
    const userId = await purchaserOf(tx, inv);
    if (!userId) return { created: false, reason: 'no_customer' };

    let referral = await tx.maybe<any>(sql`SELECT * FROM referrals WHERE user_id = ${userId} FOR UPDATE`);
    if (!referral && inv.order_id) {
      const coupon = await tx.maybe<{ affiliate_id: string }>(sql`
        SELECT c.affiliate_id FROM orders o JOIN coupons c ON c.id = o.coupon_id WHERE o.id = ${inv.order_id} AND c.affiliate_id IS NOT NULL
      `);
      if (coupon) {
        await attributeReferral(tx, app, { userId, affiliateId: coupon.affiliate_id, attribution: 'coupon' }, SYSTEM);
        referral = await tx.maybe<any>(sql`SELECT * FROM referrals WHERE user_id = ${userId} FOR UPDATE`);
      }
    }
    if (!referral || referral.status === 'rejected') return { created: false, reason: 'not_referred' };
    const aff = await tx.one<AffiliateRow>(sql`SELECT * FROM affiliates WHERE id = ${referral.affiliate_id}`);
    if (aff.status !== 'approved') return { created: false, reason: 'affiliate_inactive' };
    const purchaser = await tx.maybe<{ id: string; email: string }>(sql`SELECT id, email FROM users WHERE id = ${userId}`);
    // Own purchases wait for review like other flagged referrals, unless the program pays nothing on them.
    const ownPurchase = purchaser !== null && isOwnPurchase(aff, purchaser);
    if (ownPurchase && settingsOf(app).ownPurchases === 'never') return { created: false, reason: 'own_purchase' };

    const terms = await termsFor(tx, app, aff);
    const now = app.clock.now();
    const paidAt: Date = inv.paid_at ?? now;
    if (referral.status === 'converted') {
      if (!terms.recurring) return { created: false, reason: 'one_time_commission_already_earned' };
      if (terms.recurringMonths > 0 && paidAt >= addInterval(referral.converted_at, 'month', terms.recurringMonths)) {
        return { created: false, reason: 'recurring_window_ended' };
      }
    }
    // Commission on what the customer actually paid, net of tax.
    const base = Math.max(0, Math.min(inv.amount_paid, inv.total - inv.tax_total));
    if (base <= 0) return { created: false, reason: 'nothing_paid' };
    const amount = terms.type === 'percent' ? Math.round((base * terms.rateBps) / 10_000) : terms.fixedAmount;
    const currency = terms.type === 'percent' ? inv.currency : terms.fixedCurrency;
    if (amount <= 0) return { created: false, reason: 'zero_commission' };

    let flags: FraudFlag[] = referral.fraud_flags ?? [];
    if (referral.status !== 'converted') {
      const recent = await tx.one<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM referrals WHERE affiliate_id = ${aff.id} AND converted_at >= ${new Date(now.getTime() - HOUR)}
      `);
      if (recent.count + 1 >= settingsOf(app).conversionVelocityPerHour) {
        flags = [...flags, { type: 'conversion_velocity', detail: `${recent.count + 1} conversions within an hour`, at: now }];
        await flagAlert(tx, app, referral.id, aff, flags.slice(-1));
      }
      await tx.exec(sql`UPDATE referrals SET status = 'converted', converted_at = ${paidAt}, fraud_flags = ${sql.json(flags)} WHERE id = ${referral.id}`);
      await app.events.emit(tx, 'referral.converted', { referralId: referral.id, affiliateId: aff.id, userId }, { userId });
    }
    const flagged = (flags.length > 0 || ownPurchase) && !referral.reviewed_at;
    const payment = await tx.maybe<{ id: string }>(sql`SELECT id FROM payments WHERE invoice_id = ${inv.id} AND status <> 'failed' ORDER BY created_at LIMIT 1`);
    const holdUntil = new Date(paidAt.getTime() + settingsOf(app).holdDays * DAY);
    const id = newId('com');
    const row = await tx.maybe<{ id: string }>(sql`
      INSERT INTO affiliate_commissions (id, affiliate_id, referral_id, kind, invoice_id, payment_id, order_id, base_amount, rate_bps, amount, currency, status, flagged, hold_until, sub_id, created_at)
      VALUES (${id}, ${aff.id}, ${referral.id}, 'sale', ${inv.id}, ${payment?.id ?? null}, ${inv.order_id}, ${base}, ${terms.type === 'percent' ? terms.rateBps : null},
              ${amount}, ${currency}, 'pending', ${flagged}, ${holdUntil}, ${referral.sub_id ?? null}, ${now})
      ON CONFLICT (invoice_id) WHERE kind = 'sale' AND invoice_id IS NOT NULL DO NOTHING RETURNING id
    `);
    if (!row) return { created: false, reason: 'exists' };
    await refreshTier(tx, app, aff.id);
    await app.events.emit(tx, 'commission.created', { commissionId: id, affiliateId: aff.id, amount, currency, invoiceId: inv.id, flagged, level: 1, subId: referral.sub_id ?? null }, aff.user_id ? { userId: aff.user_id } : {});
    const uplineCommissionIds = await createUplineCommissions(tx, app, {
      sourceId: id,
      affiliate: aff,
      referralId: referral.id,
      invoice: { id: inv.id, orderId: inv.order_id, currency: inv.currency },
      paymentId: payment?.id ?? null,
      base,
      flagged,
      holdUntil,
      purchaser,
    });
    return { created: true, commissionId: id, uplineCommissionIds };
  });
}

/**
 * Multi-level commissions: the referring affiliate's upline earns a share of the same sale, one level per
 * recruiter up the chain, with the direct commission's hold and review state (and its referral, so reviewing
 * or rejecting the referral covers every level). Inactive uplines are skipped without shifting levels, an upline's
 * own purchase follows the `ownPurchases` setting, and the walk stops at an affiliate it has already visited.
 */
async function createUplineCommissions(
  tx: Db,
  app: App,
  input: {
    sourceId: string;
    affiliate: AffiliateRow;
    referralId: string;
    invoice: { id: string; orderId: string | null; currency: string };
    paymentId: string | null;
    base: number;
    flagged: boolean;
    holdUntil: Date;
    purchaser: { id: string; email: string } | null;
  },
): Promise<string[]> {
  const { uplineRatesBps: rates, ownPurchases } = settingsOf(app);
  const created: string[] = [];
  const visited = new Set([input.affiliate.id]);
  let parentId = input.affiliate.parent_id;
  for (let i = 0; i < rates.length && parentId && !visited.has(parentId); i++) {
    const upline = await tx.maybe<AffiliateRow>(sql`SELECT * FROM affiliates WHERE id = ${parentId}`);
    if (!upline) break;
    visited.add(upline.id);
    parentId = upline.parent_id;
    const level = i + 2;
    const amount = Math.round((input.base * rates[i]) / 10_000);
    const own = input.purchaser !== null && isOwnPurchase(upline, input.purchaser);
    if (amount <= 0 || upline.status !== 'approved' || (own && ownPurchases === 'never')) continue;
    const flagged = input.flagged || own;
    const id = newId('com');
    const row = await tx.maybe<{ id: string }>(sql`
      INSERT INTO affiliate_commissions (id, affiliate_id, referral_id, kind, level, source_commission_id, invoice_id, payment_id, order_id, base_amount, rate_bps, amount, currency, status, flagged, hold_until, created_at)
      VALUES (${id}, ${upline.id}, ${input.referralId}, 'upline', ${level}, ${input.sourceId}, ${input.invoice.id}, ${input.paymentId}, ${input.invoice.orderId}, ${input.base}, ${rates[i]},
              ${amount}, ${input.invoice.currency}, 'pending', ${flagged}, ${input.holdUntil}, ${app.clock.now()})
      ON CONFLICT (invoice_id, level) WHERE kind = 'upline' AND invoice_id IS NOT NULL DO NOTHING RETURNING id
    `);
    if (!row) continue;
    created.push(id);
    await app.events.emit(
      tx,
      'commission.created',
      { commissionId: id, affiliateId: upline.id, amount, currency: input.invoice.currency, invoiceId: input.invoice.id, flagged, level, sourceCommissionId: input.sourceId },
      upline.user_id ? { userId: upline.user_id } : {},
    );
  }
  return created;
}

/** Coupon-based attribution when an order is paid with an affiliate's coupon. */
export async function handleOrderPaid(app: App, orderId: string): Promise<void> {
  const order = await app.db.maybe<any>(sql`
    SELECT o.*, c.affiliate_id FROM orders o LEFT JOIN coupons c ON c.id = o.coupon_id WHERE o.id = ${orderId}
  `);
  if (!order?.affiliate_id) return;
  const userId = await purchaserOf(app.db, order);
  if (!userId) return;
  await app.db.tx((tx) => attributeReferral(tx, app, { userId, affiliateId: order.affiliate_id, attribution: 'coupon' }, SYSTEM));
  if (order.invoice_id) await commissionForInvoice(app, order.invoice_id);
}

/** Release held commissions once the hold period passes (refund window). Flagged ones wait for review. */
export async function approveDueCommissions(app: App): Promise<number> {
  const now = app.clock.now();
  return app.db.tx(async (tx) => {
    const rows = await tx.many<{ id: string; affiliate_id: string; amount: number; currency: string }>(sql`
      UPDATE affiliate_commissions c SET status = 'approved', approved_at = ${now}
      WHERE c.status = 'pending' AND NOT c.flagged AND c.hold_until <= ${now}
        AND EXISTS (SELECT 1 FROM affiliates a WHERE a.id = c.affiliate_id AND a.status = 'approved')
      RETURNING id, affiliate_id, amount, currency
    `);
    for (const r of rows) await app.events.emit(tx, 'commission.approved', { commissionId: r.id, affiliateId: r.affiliate_id, amount: r.amount, currency: r.currency });
    return rows.length;
  });
}

/**
 * Reverse commissions for a refunded or charged-back payment, proportionally for
 * partial refunds, at every level (the direct sale and its upline commissions).
 * Unpaid commissions shrink; commissions already paid out get a clawback that is
 * deducted from the next payout.
 */
export async function reverseForPayment(app: App, input: { paymentId: string; amount: number | 'full'; reason: string }): Promise<number> {
  return app.db.tx(async (tx) => {
    const payment = await tx.maybe<{ id: string; amount: number; invoice_id: string | null }>(sql`SELECT id, amount, invoice_id FROM payments WHERE id = ${input.paymentId}`);
    if (!payment?.invoice_id) return 0;
    const commissions = await tx.many<any>(sql`
      SELECT * FROM affiliate_commissions WHERE invoice_id = ${payment.invoice_id} AND kind IN ('sale', 'upline') AND status NOT IN ('rejected', 'reversed')
      ORDER BY level, created_at FOR UPDATE
    `);
    let reversed = 0;
    for (const c of commissions) {
      const remaining = c.amount - c.reversed_amount;
      if (remaining <= 0) continue;
      const portion = input.amount === 'full' ? remaining : Math.min(remaining, Math.round((c.amount * input.amount) / Math.max(1, payment.amount)));
      if (portion <= 0) continue;
      const now = app.clock.now();
      if (c.status === 'paid') {
        await tx.exec(sql.insert('affiliate_commissions', {
          id: newId('com'),
          affiliate_id: c.affiliate_id,
          referral_id: c.referral_id,
          kind: 'clawback',
          level: c.level,
          invoice_id: c.invoice_id,
          payment_id: payment.id,
          amount: -portion,
          currency: c.currency,
          status: 'approved',
          reverses_id: c.id,
          reason: input.reason,
          sub_id: c.sub_id,
          approved_at: now,
          created_at: now,
        }, ''));
        await tx.exec(sql`UPDATE affiliate_commissions SET reversed_amount = reversed_amount + ${portion} WHERE id = ${c.id}`);
      } else {
        const total = c.reversed_amount + portion;
        await tx.exec(sql`
          UPDATE affiliate_commissions SET reversed_amount = ${total}, status = ${total >= c.amount ? 'reversed' : c.status} WHERE id = ${c.id}
        `);
      }
      await writeAudit(tx, app, { actor: SYSTEM, action: 'commission.reverse', targetType: 'affiliate_commission', targetId: c.id, metadata: { amount: portion, reason: input.reason, paymentId: payment.id, level: c.level } });
      await app.events.emit(tx, 'commission.reversed', { commissionId: c.id, affiliateId: c.affiliate_id, amount: portion, currency: c.currency, reason: input.reason, level: c.level });
      reversed += portion;
    }
    return reversed;
  });
}

// ---- Payouts ---------------------------------------------------------------------------

export async function payableBalance(db: Db, affiliateId: string): Promise<{ currency: string; payable: number }[]> {
  return db.many(sql`
    SELECT currency, sum(amount - reversed_amount)::bigint AS payable FROM affiliate_commissions
    WHERE affiliate_id = ${affiliateId} AND status = 'approved' AND payout_id IS NULL GROUP BY currency ORDER BY currency
  `);
}

export async function createPayout(db: Db, app: App, input: { affiliateId: string; currency: string; actor: Actor; approvalId?: string | null }): Promise<any> {
  const aff = await getAffiliate(db, input.affiliateId, { lock: true });
  if (aff.status !== 'approved') throw conflict('Payouts are only made to approved affiliates', 'affiliate_inactive');
  const rows = await db.many<{ id: string; amount: number; reversed_amount: number }>(sql`
    SELECT id, amount, reversed_amount FROM affiliate_commissions
    WHERE affiliate_id = ${aff.id} AND currency = ${input.currency} AND status = 'approved' AND payout_id IS NULL FOR UPDATE
  `);
  const total = rows.reduce((sum, r) => sum + r.amount - r.reversed_amount, 0);
  const min = Math.max(1, settingsOf(app).minPayout);
  if (total < min) throw conflict(`The payable balance (${total}) is below the minimum payout (${min})`, 'below_minimum_payout');
  const id = newId('apo');
  const now = app.clock.now();
  await db.exec(sql.insert('affiliate_payouts', {
    id,
    affiliate_id: aff.id,
    amount: total,
    currency: input.currency,
    status: 'pending',
    method: aff.payout_method,
    approval_id: input.approvalId ?? null,
    created_by: input.actor.id,
    created_at: now,
  }, ''));
  await db.exec(sql`UPDATE affiliate_commissions SET payout_id = ${id} WHERE id IN ${sql.in(rows.map((r) => r.id))}`);
  await writeAudit(db, app, { actor: input.actor, action: 'affiliate.payout_create', targetType: 'affiliate', targetId: aff.id, metadata: { payoutId: id, amount: total, currency: input.currency, approvalId: input.approvalId ?? null } });
  await app.events.emit(db, 'affiliate.payout_created', { payoutId: id, affiliateId: aff.id, amount: total, currency: input.currency });
  return db.one(sql`SELECT * FROM affiliate_payouts WHERE id = ${id}`);
}

/** Large payouts are parked for a second administrator (separation of duties). */
export async function requestPayout(
  db: Db,
  app: App,
  input: { affiliateId: string; currency: string; actor: Actor; adminId: string },
): Promise<{ status: 'requires_approval'; approvalId: string } | { status: 'created'; payout: any }> {
  const aff = await getAffiliate(db, input.affiliateId);
  const balance = (await payableBalance(db, aff.id)).find((b) => b.currency === input.currency)?.payable ?? 0;
  const threshold = settingsOf(app).payoutApprovalThreshold;
  if (threshold > 0 && balance >= threshold) {
    const { id } = await requestApproval(db, app, {
      action: 'affiliates.payout',
      requestedBy: input.adminId,
      summary: `Affiliate payout of ${balance} ${input.currency} to ${aff.name} (${aff.code})`,
      payload: { affiliateId: aff.id, currency: input.currency },
      targetType: 'affiliate',
      targetId: aff.id,
      amount: balance,
      currency: input.currency,
    });
    return { status: 'requires_approval', approvalId: id };
  }
  return { status: 'created', payout: await createPayout(db, app, input) };
}

export async function markPayoutPaid(db: Db, app: App, payoutId: string, input: { reference: string | null; method: string | null }, actor: Actor): Promise<any> {
  const payout = await db.maybe<any>(sql`SELECT * FROM affiliate_payouts WHERE id = ${payoutId} FOR UPDATE`);
  if (!payout) throw notFound('Payout');
  if (payout.status !== 'pending') throw conflict(`This payout is ${payout.status}`, 'payout_not_pending');
  const now = app.clock.now();
  await db.exec(sql`
    UPDATE affiliate_payouts SET status = 'paid', paid_at = ${now}, paid_by = ${actor.id}, reference = ${input.reference},
      method = coalesce(${input.method}, method) WHERE id = ${payoutId}
  `);
  await db.exec(sql`UPDATE affiliate_commissions SET status = 'paid', paid_at = ${now} WHERE payout_id = ${payoutId}`);
  await writeAudit(db, app, { actor, action: 'affiliate.payout_paid', targetType: 'affiliate', targetId: payout.affiliate_id, metadata: { payoutId, amount: payout.amount, currency: payout.currency, reference: input.reference } });
  await app.events.emit(db, 'affiliate.payout_paid', { payoutId, affiliateId: payout.affiliate_id, amount: payout.amount, currency: payout.currency });
  const aff = await getAffiliate(db, payout.affiliate_id);
  await notify(app, db, { to: aff.email, template: 'affiliates.payout_paid', data: { name: aff.name, amount: formatMoney(payout.amount, payout.currency), currency: payout.currency, reference: input.reference }, userId: aff.user_id });
  return db.one(sql`SELECT * FROM affiliate_payouts WHERE id = ${payoutId}`);
}

export async function cancelPayout(db: Db, app: App, payoutId: string, actor: Actor): Promise<any> {
  const payout = await db.maybe<any>(sql`SELECT * FROM affiliate_payouts WHERE id = ${payoutId} FOR UPDATE`);
  if (!payout) throw notFound('Payout');
  if (payout.status !== 'pending') throw conflict(`This payout is ${payout.status}`, 'payout_not_pending');
  await db.exec(sql`UPDATE affiliate_payouts SET status = 'canceled' WHERE id = ${payoutId}`);
  await db.exec(sql`UPDATE affiliate_commissions SET payout_id = NULL WHERE payout_id = ${payoutId}`);
  await writeAudit(db, app, { actor, action: 'affiliate.payout_cancel', targetType: 'affiliate', targetId: payout.affiliate_id, metadata: { payoutId } });
  return db.one(sql`SELECT * FROM affiliate_payouts WHERE id = ${payoutId}`);
}

export async function affiliateStats(db: Db, affiliateId: string): Promise<Record<string, unknown>> {
  const [clicks, referrals, money] = await Promise.all([
    db.one<{ total: number; visitors: number }>(sql`SELECT count(*)::int AS total, count(DISTINCT visitor_id)::int AS visitors FROM affiliate_clicks WHERE affiliate_id = ${affiliateId}`),
    db.one<{ signups: number; conversions: number; flagged: number }>(sql`
      SELECT count(*)::int AS signups, count(*) FILTER (WHERE status = 'converted')::int AS conversions,
             count(*) FILTER (WHERE jsonb_array_length(fraud_flags) > 0 AND reviewed_at IS NULL)::int AS flagged
      FROM referrals WHERE affiliate_id = ${affiliateId}
    `),
    db.many<{ currency: string; pending: number; approved: number; paid: number }>(sql`
      SELECT currency,
        coalesce(sum(amount - reversed_amount) FILTER (WHERE status = 'pending'), 0)::bigint AS pending,
        coalesce(sum(amount - reversed_amount) FILTER (WHERE status = 'approved' AND payout_id IS NULL), 0)::bigint AS approved,
        coalesce(sum(amount - reversed_amount) FILTER (WHERE status = 'paid'), 0)::bigint AS paid
      FROM affiliate_commissions WHERE affiliate_id = ${affiliateId} GROUP BY currency ORDER BY currency
    `),
  ]);
  return { clicks: clicks.total, uniqueVisitors: clicks.visitors, ...referrals, earnings: money };
}

export interface SubIdRow {
  /** null groups the traffic that carried no sub-ID. */
  subId: string | null;
  clicks: number;
  signups: number;
  conversions: number;
  conversionRate: number | null;
  /** Direct sale commissions net of refunds, per currency. */
  commissions: { currency: string; amount: number }[];
}

/** Clicks, signups, conversions and commissions per sub-ID for one affiliate in a period (busiest first). */
export async function subIdReport(db: Db, affiliateId: string, range: { from: Date; to: Date }, limit = 200): Promise<SubIdRow[]> {
  const { from, to } = range;
  const [clicks, signups, conversions, money] = await Promise.all([
    db.many<{ sub_id: string | null; n: number }>(sql`
      SELECT sub_id, count(*)::int AS n FROM affiliate_clicks WHERE affiliate_id = ${affiliateId} AND created_at BETWEEN ${from} AND ${to} GROUP BY sub_id
    `),
    db.many<{ sub_id: string | null; n: number }>(sql`
      SELECT sub_id, count(*)::int AS n FROM referrals WHERE affiliate_id = ${affiliateId} AND created_at BETWEEN ${from} AND ${to} GROUP BY sub_id
    `),
    db.many<{ sub_id: string | null; n: number }>(sql`
      SELECT sub_id, count(*)::int AS n FROM referrals WHERE affiliate_id = ${affiliateId} AND converted_at BETWEEN ${from} AND ${to} GROUP BY sub_id
    `),
    db.many<{ sub_id: string | null; currency: string; amount: number }>(sql`
      SELECT sub_id, currency, sum(amount - reversed_amount)::bigint AS amount FROM affiliate_commissions
      WHERE affiliate_id = ${affiliateId} AND kind = 'sale' AND status <> 'rejected' AND created_at BETWEEN ${from} AND ${to}
      GROUP BY sub_id, currency ORDER BY currency
    `),
  ]);
  const rows = new Map<string | null, SubIdRow>();
  const row = (subId: string | null) => {
    let r = rows.get(subId);
    if (!r) rows.set(subId, (r = { subId, clicks: 0, signups: 0, conversions: 0, conversionRate: null, commissions: [] }));
    return r;
  };
  for (const c of clicks) row(c.sub_id).clicks = c.n;
  for (const s of signups) row(s.sub_id).signups = s.n;
  for (const c of conversions) row(c.sub_id).conversions = c.n;
  for (const m of money) row(m.sub_id).commissions.push({ currency: m.currency, amount: m.amount });
  return [...rows.values()]
    .map((r) => ({ ...r, conversionRate: r.clicks ? r.conversions / r.clicks : null }))
    .sort((a, b) => b.clicks - a.clicks || b.signups - a.signups || b.conversions - a.conversions || String(a.subId).localeCompare(String(b.subId)))
    .slice(0, limit);
}
