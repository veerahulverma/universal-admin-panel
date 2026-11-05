import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { DAY } from '../../core/clock.js';
import { notFound, validationError } from '../../core/errors.js';
import { likePattern, paginate, type Page } from '../../core/validation.js';
import { resolveEntitlements, subjectFor, type Subject } from '../catalog/entitlements.js';
import { userScopeSql } from '../customers/service.js';

// ---- Settings ------------------------------------------------------------------------------

export const LIMIT_PERIODS = ['day', 'week', 'month', 'year', 'lifetime'] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

export const accessSettingsSchema = z.object({
  /** Largest protected download an administrator may upload. */
  maxFileBytes: z.number().int().min(1024).max(512 * 1024 * 1024),
  /** How long a signed download link stays valid. */
  linkTtlMinutes: z.number().int().min(1).max(24 * 60),
  /** Per-customer download limit given to newly uploaded files; null means unlimited. */
  defaultDownloadLimit: z.number().int().min(1).max(100_000).nullable(),
  defaultLimitPeriod: z.enum(LIMIT_PERIODS),
  /** Access log entries older than this are deleted. */
  logRetentionDays: z.number().int().min(7).max(3650),
});
export type AccessSettings = z.infer<typeof accessSettingsSchema>;

export const accessDefaults: AccessSettings = {
  maxFileBytes: 100 * 1024 * 1024,
  linkTtlMinutes: 15,
  defaultDownloadLimit: 10,
  defaultLimitPeriod: 'day',
  logRetentionDays: 180,
};

export const settingsOf = (app: App) => app.settings.get<AccessSettings>('access');

// ---- Paths ---------------------------------------------------------------------------------

/**
 * Canonical form of a path for matching: query and fragment removed, percent
 * escapes decoded, "." and ".." resolved, duplicate and trailing slashes
 * dropped. Matching canonical forms means "/members/../members/x",
 * "/members//x/" and "/%6Dembers/x" are all covered by a "/members" folder.
 * Returns null for anything that is not an absolute path or http(s) URL.
 */
export function normalizePath(input: string): string | null {
  let path = input.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/[?#][\s\S]*$/, '').replace(/\\/g, '/');
  if (!path.startsWith('/')) return null;
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // An encoded slash still separates segments here, so it cannot hide a path from its folder.
    for (const part of decoded.split(/[\\/]/)) {
      if (part === '' || part === '.') continue;
      if (part === '..') segments.pop();
      else segments.push(part);
    }
  }
  const out = `/${segments.join('/')}`;
  return out.length > 2000 || /[\u0000-\u001f\u007f]/.test(out) ? null : out;
}

/** A path and every folder above it: "/a/b" -> ["/a/b", "/a", "/"]. */
export function pathPrefixes(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const out = ['/'];
  for (let i = 1; i <= parts.length; i++) out.push(`/${parts.slice(0, i).join('/')}`);
  return out.reverse();
}

// ---- User groups ---------------------------------------------------------------------------

/**
 * Products users hold right now through an active subscription or grant, held
 * personally or by an organization they are an active member of. These are the
 * conditions the entitlement engine applies (subscriptions count while billing
 * is enabled, past-due ones until their grace period ends), expressed in SQL so
 * that automatic group membership can be listed and counted, not just checked.
 */
function holdingsSql(app: App, now: Date, opts: { userId?: string; productIds?: readonly string[] }): Sql {
  const forUser = (column: string) => (opts.userId ? sql`AND ${sql.raw(column)} = ${opts.userId}` : sql.empty);
  const forProducts = (column: string) => (opts.productIds ? sql`AND ${sql.raw(column)} IN ${sql.in(opts.productIds)}` : sql.empty);
  // Members of a live organization inherit what the organization holds.
  const members = (subject: string) => sql`
    JOIN memberships m ON m.org_id = ${sql.raw(subject)} AND m.status = 'active'
    JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL`;
  const activeGrant = sql`g.revoked_at IS NULL AND g.starts_at <= ${now} AND (g.ends_at IS NULL OR g.ends_at > ${now})`;
  const parts = [
    sql`SELECT g.subject_id AS user_id, g.product_id, g.starts_at AS since FROM entitlement_grants g
        WHERE g.subject_type = 'user' AND ${activeGrant} ${forUser('g.subject_id')} ${forProducts('g.product_id')}`,
    sql`SELECT m.user_id, g.product_id, g.starts_at AS since FROM entitlement_grants g ${members('g.subject_id')}
        WHERE g.subject_type = 'organization' AND ${activeGrant} ${forUser('m.user_id')} ${forProducts('g.product_id')}`,
  ];
  if (app.modules.isEnabled('billing')) {
    const activeSub = sql`(s.status IN ('active', 'trialing') OR (s.status = 'past_due' AND (s.grace_until IS NULL OR s.grace_until > ${now})))`;
    parts.push(
      sql`SELECT s.subject_id AS user_id, s.product_id, s.created_at AS since FROM subscriptions s
          WHERE s.subject_type = 'user' AND ${activeSub} ${forUser('s.subject_id')} ${forProducts('s.product_id')}`,
      sql`SELECT m.user_id, s.product_id, s.created_at AS since FROM subscriptions s ${members('s.subject_id')}
          WHERE s.subject_type = 'organization' AND ${activeSub} ${forUser('m.user_id')} ${forProducts('s.product_id')}`,
    );
  }
  return sql.join(parts, ' UNION ALL ');
}

export interface GroupMembership {
  id: string;
  name: string;
  /** Added by hand or through the API. */
  manual: boolean;
  /** Holds one of the group's products right now. */
  automatic: boolean;
  /** When membership began: added to the group, or started holding the product. */
  since: Date;
}

const earliest = (...dates: (Date | null)[]): Date => new Date(Math.min(...dates.filter((d): d is Date => d !== null).map((d) => d.getTime())));

/** The groups a user belongs to right now, by hand or automatically. */
export async function groupsOfUser(db: Db, app: App, userId: string): Promise<GroupMembership[]> {
  const rows = await db.many<{ id: string; name: string; manual_since: Date | null; auto_since: Date | null }>(sql`
    WITH held AS (${holdingsSql(app, app.clock.now(), { userId })}),
    auto AS (SELECT gp.group_id, min(h.since) AS since FROM user_group_products gp JOIN held h ON h.product_id = gp.product_id GROUP BY gp.group_id)
    SELECT g.id, g.name, gm.created_at AS manual_since, a.since AS auto_since
    FROM user_groups g
    LEFT JOIN user_group_members gm ON gm.group_id = g.id AND gm.user_id = ${userId}
    LEFT JOIN auto a ON a.group_id = g.id
    WHERE gm.user_id IS NOT NULL OR a.group_id IS NOT NULL
    ORDER BY lower(g.name)
  `);
  return rows.map((r) => ({ id: r.id, name: r.name, manual: r.manual_since !== null, automatic: r.auto_since !== null, since: earliest(r.manual_since, r.auto_since) }));
}

/** FROM clause over a group's members (manual and automatic) joined to users as `u`. */
async function membersFrom(db: Db, app: App, groupId: string): Promise<Sql> {
  const products = (await db.many<{ product_id: string }>(sql`SELECT product_id FROM user_group_products WHERE group_id = ${groupId}`)).map((r) => r.product_id);
  const auto = products.length
    ? sql`(SELECT h.user_id, min(h.since) AS since FROM (${holdingsSql(app, app.clock.now(), { productIds: products })}) h GROUP BY h.user_id)`
    : sql`(SELECT NULL::text AS user_id, NULL::timestamptz AS since WHERE false)`;
  return sql`(SELECT user_id FROM user_group_members WHERE group_id = ${groupId} UNION SELECT user_id FROM ${auto} x) ids
    JOIN users u ON u.id = ids.user_id
    LEFT JOIN user_group_members gm ON gm.group_id = ${groupId} AND gm.user_id = u.id
    LEFT JOIN ${auto} a ON a.user_id = u.id`;
}

export interface GroupMemberRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  added_at: Date | null;
  auto_since: Date | null;
}

export async function listGroupMembers(
  db: Db,
  app: App,
  groupId: string,
  opts: { scope: string[] | null; q?: string; source: 'all' | 'manual' | 'automatic'; page: number; pageSize: number },
): Promise<Page<GroupMemberRow>> {
  return paginate<GroupMemberRow>(db, {
    select: sql`u.id, u.email, u.name, u.status, gm.created_at AS added_at, a.since AS auto_since`,
    from: await membersFrom(db, app, groupId),
    where: sql.where([
      sql`u.deleted_at IS NULL`,
      opts.source === 'manual' && sql`gm.user_id IS NOT NULL`,
      opts.source === 'automatic' && sql`a.user_id IS NOT NULL`,
      opts.q && sql`(u.email ILIKE ${likePattern(opts.q)} OR u.name ILIKE ${likePattern(opts.q)} OR u.id = ${opts.q})`,
      userScopeSql(opts.scope, 'u'),
    ]),
    orderBy: sql`ORDER BY coalesce(gm.created_at, a.since) DESC, u.id`,
    page: opts.page,
    pageSize: opts.pageSize,
  });
}

export async function countGroupMembers(db: Db, app: App, groupId: string, scope: string[] | null): Promise<{ total: number; manual: number; automatic: number }> {
  return db.one(sql`
    SELECT count(*)::int AS total, count(gm.user_id)::int AS manual, count(a.user_id)::int AS automatic
    FROM ${await membersFrom(db, app, groupId)}
    ${sql.where([sql`u.deleted_at IS NULL`, userScopeSql(scope, 'u')])}
  `);
}

// ---- Access profiles ---------------------------------------------------------------------------

/** Who is asking: a user, an organization, or a user acting inside an organization. */
export interface Viewer {
  userId: string | null;
  orgId: string | null;
}

export interface AccessProfile {
  viewer: Viewer;
  /** The account may not use content at all (suspended, banned, unverified or deleted). */
  inactive: boolean;
  /** When the customer account was created ("any signed-in customer" rules count from here). */
  since: Date;
  /** Product id -> when the current, uninterrupted access to it began. */
  products: Map<string, Date>;
  /** Group id -> when membership began. */
  groups: Map<string, Date>;
}

/** Validate a viewer for a caller limited to `scope` (org-scoped admins and API keys). */
export async function viewerFor(db: Db, input: { userId?: string | null; orgId?: string | null }, scope: string[] | null): Promise<Viewer> {
  if (!input.userId && !input.orgId) throw validationError([{ path: ['userId'], message: 'userId or orgId is required' }]);
  await subjectFor(db, { userId: input.userId ?? null, orgId: input.orgId ?? null }, scope);
  return { userId: input.userId ?? null, orgId: input.orgId ?? null };
}

/**
 * Products a subject holds according to the entitlement engine (active
 * subscriptions, unexpired grants and the default plan), each with the moment
 * its access started: the grant start, the subscription start, or the
 * account's creation for the default plan.
 */
async function heldProducts(db: Db, app: App, subject: Subject, accountSince: Date): Promise<Map<string, Date>> {
  const ent = await resolveEntitlements(db, app, subject);
  const ids = (origin: string) => ent.plans.filter((p) => p.origin === origin && p.originId).map((p) => p.originId!);
  const grantIds = ids('grant');
  const subscriptionIds = ids('subscription');
  const started = new Map<string, Date>();
  if (grantIds.length) {
    for (const g of await db.many<{ id: string; starts_at: Date }>(sql`SELECT id, starts_at FROM entitlement_grants WHERE id IN ${sql.in(grantIds)}`)) started.set(g.id, g.starts_at);
  }
  if (subscriptionIds.length) {
    // Subscription sources only exist while billing (and so its table) is installed.
    for (const s of await db.many<{ id: string; created_at: Date }>(sql`SELECT id, created_at FROM subscriptions WHERE id IN ${sql.in(subscriptionIds)}`)) started.set(s.id, s.created_at);
  }
  const out = new Map<string, Date>();
  for (const p of ent.plans) {
    const at = (p.originId ? started.get(p.originId) : undefined) ?? accountSince;
    const prev = out.get(p.productId);
    if (!prev || at < prev) out.set(p.productId, at);
  }
  return out;
}

/** Everything access decisions need about a viewer, evaluated against current entitlements. */
export async function loadProfile(db: Db, app: App, viewer: Viewer): Promise<AccessProfile> {
  const now = app.clock.now();
  const products = new Map<string, Date>();
  const hold = (held: Map<string, Date>) => {
    for (const [id, at] of held) {
      const prev = products.get(id);
      if (!prev || at < prev) products.set(id, at);
    }
  };
  let since = now;
  let inactive = false;
  if (viewer.userId) {
    const user = await db.maybe<{ status: string; suspended_until: Date | null; deleted_at: Date | null; created_at: Date }>(sql`
      SELECT status, suspended_until, deleted_at, created_at FROM users WHERE id = ${viewer.userId}
    `);
    if (!user) throw notFound('User');
    since = user.created_at;
    const suspended = user.status === 'suspended' && (!user.suspended_until || user.suspended_until > now);
    inactive = Boolean(user.deleted_at) || user.status === 'banned' || user.status === 'pending' || suspended;
    hold(await heldProducts(db, app, { type: 'user', id: viewer.userId }, user.created_at));
  }
  if (viewer.orgId) {
    const org = await db.maybe<{ created_at: Date; deleted_at: Date | null }>(sql`SELECT created_at, deleted_at FROM organizations WHERE id = ${viewer.orgId}`);
    if (!org) throw notFound('Organization');
    if (!viewer.userId) {
      since = org.created_at;
      inactive = Boolean(org.deleted_at);
    }
    if (!org.deleted_at) hold(await heldProducts(db, app, { type: 'organization', id: viewer.orgId }, org.created_at));
  }
  const groups = new Map<string, Date>();
  if (viewer.userId) for (const g of await groupsOfUser(db, app, viewer.userId)) groups.set(g.id, g.since);
  return { viewer, inactive, since, products, groups };
}

// ---- Resources -------------------------------------------------------------------------------

export const RESOURCE_KINDS = ['url', 'folder', 'page', 'link', 'file'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_ID = /^res_[0-9a-z]{26}$/;

export interface RuleRow {
  kind: 'product' | 'group' | 'any_customer';
  product_id: string | null;
  product_key: string | null;
  product_name: string | null;
  product_kind: string | null;
  group_id: string | null;
  group_name: string | null;
}

export interface ResourceRow {
  id: string;
  kind: ResourceKind;
  title: string;
  description: string;
  path: string | null;
  url: string | null;
  /** Only loaded on request (pages can be large). */
  body?: string | null;
  status: 'active' | 'disabled';
  show_locked: boolean;
  release_mode: 'immediate' | 'days' | 'date';
  release_days: number | null;
  release_at: Date | null;
  window_days: number | null;
  position: number;
  created_at: Date;
  updated_at: Date;
  rules: RuleRow[];
  file_count: number;
}

export const RESOURCE_COLUMNS = sql`r.id, r.kind, r.title, r.description, r.path, r.url, r.status, r.show_locked, r.release_mode, r.release_days, r.release_at, r.window_days, r.position, r.created_at, r.updated_at,
  (SELECT count(*)::int FROM access_resource_files rf WHERE rf.resource_id = r.id) AS file_count`;

export async function attachRules(db: Db, rows: Omit<ResourceRow, 'rules'>[]): Promise<ResourceRow[]> {
  if (!rows.length) return [];
  const rules = await db.many<RuleRow & { resource_id: string }>(sql`
    SELECT ru.resource_id, ru.kind, ru.product_id, p.key AS product_key, p.name AS product_name, p.kind AS product_kind, ru.group_id, g.name AS group_name
    FROM access_rules ru LEFT JOIN products p ON p.id = ru.product_id LEFT JOIN user_groups g ON g.id = ru.group_id
    WHERE ru.resource_id IN ${sql.in(rows.map((r) => r.id))} ORDER BY ru.created_at, ru.id
  `);
  const byResource = new Map<string, RuleRow[]>();
  for (const { resource_id, ...rule } of rules) byResource.set(resource_id, [...(byResource.get(resource_id) ?? []), rule]);
  return rows.map((r) => ({ ...r, rules: byResource.get(r.id) ?? [] }));
}

export async function loadResources(db: Db, filter: Sql | null, opts: { withBody?: boolean } = {}): Promise<ResourceRow[]> {
  const rows = await db.many<Omit<ResourceRow, 'rules'>>(sql`
    SELECT ${RESOURCE_COLUMNS} ${opts.withBody ? sql`, r.body` : sql.empty} FROM access_resources r
    ${sql.where([filter])} ORDER BY r.position, lower(r.title), r.id
  `);
  return attachRules(db, rows);
}

export async function getResource(db: Db, id: string, opts: { withBody?: boolean } = {}): Promise<ResourceRow> {
  const [row] = await loadResources(db, sql`r.id = ${id}`, opts);
  if (!row) throw notFound('Resource');
  return row;
}

/**
 * The resource a check refers to: an id, or the protection that covers a path.
 * An exact URL beats a folder, and a deeper folder beats a shallower one, so a
 * sub-path can be given a different audience than the folder around it.
 */
export async function findTarget(db: Db, ref: string): Promise<{ resource: ResourceRow | null; path: string | null }> {
  const value = ref.trim();
  if (RESOURCE_ID.test(value)) return { resource: await getResource(db, value), path: null };
  const path = normalizePath(value);
  if (!path) throw validationError([{ path: ['resource'], message: 'Use a resource ID, a path starting with "/" or an http(s) URL' }]);
  const candidates = await loadResources(db, sql`(r.kind = 'url' AND r.path = ${path}) OR (r.kind = 'folder' AND r.path IN ${sql.in(pathPrefixes(path))})`);
  const exact = candidates.find((r) => r.kind === 'url');
  const folder = candidates.filter((r) => r.kind === 'folder').sort((a, b) => b.path!.length - a.path!.length)[0];
  return { resource: exact ?? folder ?? null, path };
}

// ---- Decisions -------------------------------------------------------------------------------

export type DecisionState = 'available' | 'scheduled' | 'ended' | 'locked' | 'disabled' | 'inactive';

export interface MatchedBy {
  type: 'plan' | 'product' | 'group' | 'any_customer';
  id: string | null;
  name: string;
}

export interface Decision {
  allowed: boolean;
  state: DecisionState;
  /** What granted access (plan, product, group, any_customer), or why it was refused. */
  reason: string;
  /** When a scheduled (drip) resource opens for this customer. */
  availableAt: Date | null;
  /** When access through the release window ends (or ended). */
  availableUntil: Date | null;
  matchedBy: MatchedBy | null;
}

interface Window {
  match: MatchedBy;
  opensAt: Date;
  closesAt: Date | null;
}

function windowFor(resource: ResourceRow, match: MatchedBy, since: Date): Window {
  const opensAt =
    resource.release_mode === 'date' && resource.release_at
      ? new Date(resource.release_at)
      : resource.release_mode === 'days'
        ? new Date(since.getTime() + (resource.release_days ?? 0) * DAY)
        : since;
  const closesAt = resource.window_days ? new Date(opensAt.getTime() + resource.window_days * DAY) : null;
  return { match, opensAt, closesAt };
}

/**
 * Decide whether a profile may open a resource right now. Every rule the
 * customer matches is judged on its own release window (drip counts from the
 * start of that product or group membership), and the most generous result
 * wins: open beats scheduled beats ended.
 */
export function evaluate(resource: ResourceRow, profile: AccessProfile, now: Date): Decision {
  const closed = { availableAt: null, availableUntil: null, matchedBy: null };
  if (resource.status !== 'active') return { allowed: false, state: 'disabled', reason: 'resource_disabled', ...closed };
  if (profile.inactive) return { allowed: false, state: 'inactive', reason: 'account_inactive', ...closed };

  const windows: Window[] = [];
  for (const rule of resource.rules) {
    if (rule.kind === 'any_customer') {
      windows.push(windowFor(resource, { type: 'any_customer', id: null, name: 'Any signed-in customer' }, profile.since));
    } else if (rule.kind === 'product' && rule.product_id && profile.products.has(rule.product_id)) {
      const match: MatchedBy = { type: rule.product_kind === 'plan' ? 'plan' : 'product', id: rule.product_id, name: rule.product_name ?? rule.product_id };
      windows.push(windowFor(resource, match, profile.products.get(rule.product_id)!));
    } else if (rule.kind === 'group' && rule.group_id && profile.groups.has(rule.group_id)) {
      windows.push(windowFor(resource, { type: 'group', id: rule.group_id, name: rule.group_name ?? rule.group_id }, profile.groups.get(rule.group_id)!));
    }
  }
  if (!windows.length) return { allowed: false, state: 'locked', reason: 'no_access', ...closed };

  const t = now.getTime();
  const open = windows.filter((w) => w.opensAt.getTime() <= t && (!w.closesAt || w.closesAt.getTime() > t));
  if (open.length) {
    const best = open.reduce((a, b) => (!a.closesAt ? a : !b.closesAt || b.closesAt > a.closesAt ? b : a));
    return { allowed: true, state: 'available', reason: best.match.type, availableAt: null, availableUntil: best.closesAt, matchedBy: best.match };
  }
  const upcoming = windows.filter((w) => w.opensAt.getTime() > t);
  if (upcoming.length) {
    const next = upcoming.reduce((a, b) => (b.opensAt < a.opensAt ? b : a));
    return { allowed: false, state: 'scheduled', reason: 'not_yet_available', availableAt: next.opensAt, availableUntil: next.closesAt, matchedBy: next.match };
  }
  const last = windows.reduce((a, b) => (b.closesAt! > a.closesAt! ? b : a));
  return { allowed: false, state: 'ended', reason: 'access_ended', availableAt: null, availableUntil: last.closesAt, matchedBy: last.match };
}

/** A path no protection covers is open to everyone. */
export const UNPROTECTED: Decision = { allowed: true, state: 'available', reason: 'unprotected', availableAt: null, availableUntil: null, matchedBy: null };

/** Customers see what they can open, what will open for them, and locked teasers the admin chose to show. */
export function visibleToCustomer(resource: ResourceRow, decision: Decision): boolean {
  if (resource.status !== 'active' || decision.state === 'inactive') return false;
  return decision.state !== 'locked' || resource.show_locked;
}

export function presentDecision(d: Decision) {
  return { allowed: d.allowed, state: d.state, reason: d.reason, availableAt: d.availableAt, availableUntil: d.availableUntil, matchedBy: d.matchedBy };
}

// ---- Access log ------------------------------------------------------------------------------

export interface AccessLogEntry {
  event: 'check' | 'view' | 'link' | 'download';
  source: 'api' | 'client' | 'public';
  resource?: { id: string; title: string } | null;
  fileId?: string | null;
  path?: string | null;
  userId?: string | null;
  orgId?: string | null;
  allowed: boolean;
  reason: string;
  ip?: string | null;
}

export async function logAccess(db: Db, app: App, e: AccessLogEntry): Promise<void> {
  await db.exec(sql.insert('access_log', {
    id: newId('alog'),
    event: e.event,
    source: e.source,
    resource_id: e.resource?.id ?? null,
    resource_title: e.resource?.title ?? null,
    file_id: e.fileId ?? null,
    path: e.path ?? null,
    user_id: e.userId ?? null,
    org_id: e.orgId ?? null,
    allowed: e.allowed,
    reason: e.reason,
    ip: e.ip ?? null,
    created_at: app.clock.now(),
  }, ''));
}

/** Org-scoped callers only see log rows of their organizations' customers. */
export function tenantScopeSql(scope: string[] | null, alias: string): Sql | null {
  if (!scope) return null;
  const a = sql.raw(alias);
  return sql`(${a}.org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${a}.user_id AND m.org_id IN ${sql.in(scope)}))`;
}
