import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound } from '../../core/errors.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import { DAY, MINUTE } from '../../core/clock.js';
import { resolveEntitlements } from '../catalog/entitlements.js';
import { queueEmail, type DeliveryDecision, type ListBridge } from '../email/service.js';

/**
 * Mailing lists: named audiences people join and leave themselves (with a
 * consent record, optionally confirmed by email), that administrators manage,
 * and that rules keep in step with product access ("everyone who has Pro").
 * Campaigns can be sent to a list; list email is marketing and follows the
 * list's consent rules (see BLOCK_REASON).
 */
export interface ListRow {
  id: string;
  key: string;
  name: string;
  description: string;
  visibility: 'public' | 'hidden';
  double_opt_in: boolean;
  auto_product_ids: string[];
  external_provider: string | null;
  external_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export type MemberStatus = 'pending' | 'subscribed' | 'unsubscribed';

export interface MemberRow {
  list_id: string;
  user_id: string;
  status: MemberStatus;
  source: string;
  consented_at: Date | null;
  confirmation_sent_at: Date | null;
  subscribed_at: Date | null;
  unsubscribed_at: Date | null;
}

/** Where a change came from, kept with the consent record. */
export interface Evidence {
  source: string;
  ip?: string | null;
  userAgent?: string | null;
  actor?: string | null;
}

export interface ListUser {
  id: string;
  email: string;
  locale?: string | null;
}

export const listInput = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,63}$/, 'Use lowercase letters, digits, dashes and underscores; start with a letter').optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  visibility: z.enum(['public', 'hidden']).default('public'),
  doubleOptIn: z.boolean().default(false),
  /** Rule: people who have one of these products join automatically and leave when access ends. */
  autoProductIds: z.array(z.string().max(100)).max(50).default([]),
  externalProvider: z.string().trim().max(60).nullable().optional(),
  externalRef: z.string().trim().max(200).nullable().optional(),
});
export type ListInput = z.infer<typeof listInput>;

export async function getList(db: Db, idOrKey: string, opts: { lock?: boolean } = {}): Promise<ListRow> {
  const row = await db.maybe<ListRow>(sql`SELECT * FROM mailing_lists WHERE id = ${idOrKey} OR key = ${idOrKey} ${opts.lock ? sql`FOR UPDATE` : sql.empty}`);
  if (!row) throw notFound('Mailing list');
  return row;
}

// ---- Consent records and events -------------------------------------------------------------------

async function record(db: Db, app: App, list: ListRow, user: ListUser, action: 'requested' | 'subscribed' | 'unsubscribed', ev: Evidence): Promise<void> {
  await db.exec(sql.insert('mailing_list_consents', {
    id: newId('lcr'),
    list_id: list.id,
    user_id: user.id,
    email: user.email.toLowerCase(),
    action,
    source: ev.source,
    ip: ev.ip ?? null,
    user_agent: ev.userAgent?.slice(0, 300) ?? null,
    actor: ev.actor ?? null,
    created_at: app.clock.now(),
  }, ''));
}

/** Plugins that sync lists with an external newsletter service (Mailchimp and others) listen to these events. */
async function announce(db: Db, app: App, list: ListRow, user: ListUser, type: 'list.member_subscribed' | 'list.member_unsubscribed', source: string): Promise<void> {
  await app.events.emit(db, type, {
    listId: list.id,
    listKey: list.key,
    userId: user.id,
    email: user.email.toLowerCase(),
    source,
    external: list.external_provider ? { provider: list.external_provider, ref: list.external_ref } : null,
  }, { userId: user.id });
}

async function upsertMember(db: Db, app: App, list: ListRow, userId: string, values: { status: MemberStatus; source: string; consented_at: Date | null; confirmation_sent_at?: Date | null }): Promise<void> {
  const now = app.clock.now();
  await db.exec(sql`
    INSERT INTO mailing_list_members (list_id, user_id, status, source, consented_at, confirmation_sent_at, subscribed_at, unsubscribed_at, created_at, updated_at)
    VALUES (${list.id}, ${userId}, ${values.status}, ${values.source}, ${values.consented_at}, ${values.confirmation_sent_at ?? null},
            ${values.status === 'subscribed' ? now : null}, NULL, ${now}, ${now})
    ON CONFLICT (list_id, user_id) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, consented_at = EXCLUDED.consented_at,
      confirmation_sent_at = coalesce(EXCLUDED.confirmation_sent_at, mailing_list_members.confirmation_sent_at),
      subscribed_at = EXCLUDED.subscribed_at, unsubscribed_at = NULL, updated_at = EXCLUDED.updated_at
  `);
}

// ---- Double opt-in -------------------------------------------------------------------------------------

const CONFIRM_TTL_DAYS = 7;

/** Signed confirmation link payload (list, person, issue time); nothing is stored per request. */
export function confirmationToken(app: App, listId: string, userId: string, issuedAt: Date): string {
  const payload = Buffer.from(JSON.stringify({ l: listId, u: userId, t: Math.floor(issuedAt.getTime() / 1000) })).toString('base64url');
  return `${payload}.${hmacSha256(app.config.encryptionKeys, `listconfirm:${payload}`).slice(0, 32)}`;
}

export function readConfirmationToken(app: App, token: string): { listId: string; userId: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmacSha256(app.config.encryptionKeys, `listconfirm:${payload}`).slice(0, 32))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { l?: string; u?: string; t?: number };
    if (!p.l || !p.u || !p.t || app.clock.now().getTime() - p.t * 1000 > CONFIRM_TTL_DAYS * DAY) return null;
    return { listId: p.l, userId: p.u };
  } catch {
    return null;
  }
}

async function sendConfirmation(db: Db, app: App, list: ListRow, user: ListUser): Promise<void> {
  const token = confirmationToken(app, list.id, user.id, app.clock.now());
  // Transactional: the request itself must reach people who have not consented to marketing yet.
  await queueEmail(db, app, {
    to: user.email,
    userId: user.id,
    locale: user.locale ?? null,
    templateKey: 'lists.confirm',
    category: 'transactional',
    data: { listName: list.name, confirmUrl: `${app.config.appUrl}/lists/confirm/${token}` },
    metadata: { mailingListId: list.id, automation: 'list_confirmation' },
  });
}

// ---- Joining and leaving -------------------------------------------------------------------------------

/**
 * How a subscription is backed: `given` is the person's own opt-in (recorded,
 * and enough for list email to reach them); `request` asks for it with a
 * confirmation email and keeps them pending until they click; `none` (added by
 * an administrator or a rule) also needs their general marketing consent.
 */
export type ConsentBasis = 'given' | 'request' | 'none';

/**
 * Add someone to a list. Only the person themselves (`byPerson`) can come back
 * after unsubscribing: administrators can neither re-add them nor send them
 * another confirmation request.
 */
export async function subscribe(db: Db, app: App, list: ListRow, user: ListUser, opts: { consent: ConsentBasis; byPerson: boolean; evidence: Evidence }): Promise<MemberStatus> {
  const now = app.clock.now();
  const row = await db.maybe<MemberRow>(sql`SELECT * FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${user.id} FOR UPDATE`);
  if (row?.status === 'unsubscribed' && !opts.byPerson) throw conflict('This person unsubscribed from the list; only they can subscribe again', 'member_unsubscribed');
  if (row?.status === 'subscribed') {
    if (opts.consent === 'given' && !row.consented_at) {
      await db.exec(sql`UPDATE mailing_list_members SET consented_at = ${now}, source = ${opts.evidence.source}, updated_at = ${now} WHERE list_id = ${list.id} AND user_id = ${user.id}`);
      await record(db, app, list, user, 'subscribed', opts.evidence);
    }
    return 'subscribed';
  }
  if (opts.consent === 'request') {
    // Re-requests within ten minutes do not send another email.
    const resend = row?.status !== 'pending' || !row.confirmation_sent_at || now.getTime() - row.confirmation_sent_at.getTime() > 10 * MINUTE;
    await upsertMember(db, app, list, user.id, { status: 'pending', source: opts.evidence.source, consented_at: null, confirmation_sent_at: resend ? now : null });
    await record(db, app, list, user, 'requested', opts.evidence);
    if (resend) await sendConfirmation(db, app, list, user);
    return 'pending';
  }
  await upsertMember(db, app, list, user.id, { status: 'subscribed', source: opts.evidence.source, consented_at: opts.consent === 'given' ? now : null });
  await record(db, app, list, user, 'subscribed', opts.evidence);
  await announce(db, app, list, user, 'list.member_subscribed', opts.evidence.source);
  return 'subscribed';
}

/** Confirm a double opt-in request from the link in the confirmation email. */
export async function confirmSubscription(db: Db, app: App, token: string, evidence: Omit<Evidence, 'source'>): Promise<{ list: ListRow; result: 'confirmed' | 'already' } | null> {
  const parsed = readConfirmationToken(app, token);
  if (!parsed) return null;
  const list = await db.maybe<ListRow>(sql`SELECT * FROM mailing_lists WHERE id = ${parsed.listId}`);
  const user = await db.maybe<ListUser & { deleted_at: Date | null }>(sql`SELECT id, email, locale, deleted_at FROM users WHERE id = ${parsed.userId}`);
  if (!list || !user || user.deleted_at) return null;
  const row = await db.maybe<MemberRow>(sql`SELECT * FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${user.id} FOR UPDATE`);
  if (row?.status === 'subscribed') return { list, result: 'already' };
  // Unsubscribing after asking cancels the request: an old link cannot sign them back up.
  if (row?.status !== 'pending') return null;
  await upsertMember(db, app, list, user.id, { status: 'subscribed', source: row.source, consented_at: app.clock.now() });
  await record(db, app, list, user, 'subscribed', { ...evidence, source: 'double_opt_in' });
  await announce(db, app, list, user, 'list.member_subscribed', 'double_opt_in');
  return { list, result: 'confirmed' };
}

export async function unsubscribe(db: Db, app: App, list: ListRow, user: ListUser, evidence: Evidence): Promise<boolean> {
  const row = await db.maybe<MemberRow>(sql`SELECT * FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${user.id} FOR UPDATE`);
  if (!row || row.status === 'unsubscribed') return false;
  const now = app.clock.now();
  await db.exec(sql`UPDATE mailing_list_members SET status = 'unsubscribed', unsubscribed_at = ${now}, updated_at = ${now} WHERE list_id = ${list.id} AND user_id = ${user.id}`);
  await record(db, app, list, user, 'unsubscribed', evidence);
  if (row.status === 'subscribed') await announce(db, app, list, user, 'list.member_unsubscribed', evidence.source);
  return true;
}

// ---- Product rules -------------------------------------------------------------------------------------

/** Products a person can use now: their own, and those of organizations they are an active member of. */
export async function userProductIds(db: Db, app: App, userId: string): Promise<Set<string>> {
  const orgs = await db.many<{ org_id: string }>(sql`SELECT org_id FROM memberships WHERE user_id = ${userId} AND status = 'active'`);
  const ids = new Set<string>();
  for (const subject of [{ type: 'user' as const, id: userId }, ...orgs.map((o) => ({ type: 'organization' as const, id: o.org_id }))]) {
    for (const plan of (await resolveEntitlements(db, app, subject)).plans) ids.add(plan.productId);
  }
  return ids;
}

/**
 * Apply every list's product rule to one person: join while they have one of
 * the products, leave when access ends. Only memberships the rule created are
 * removed; people who unsubscribed are never added back.
 */
export async function syncUserLists(db: Db, app: App, userId: string): Promise<{ joined: string[]; left: string[] }> {
  const out = { joined: [] as string[], left: [] as string[] };
  const lists = await db.many<ListRow>(sql`SELECT * FROM mailing_lists WHERE jsonb_array_length(auto_product_ids) > 0 ORDER BY created_at`);
  if (!lists.length) return out;
  const user = await db.maybe<ListUser & { deleted_at: Date | null }>(sql`SELECT id, email, locale, deleted_at FROM users WHERE id = ${userId}`);
  if (!user) return out;
  const products = user.deleted_at ? new Set<string>() : await userProductIds(db, app, userId);
  const evidence: Evidence = { source: 'rule' };
  for (const list of lists) {
    const qualifies = list.auto_product_ids.some((p) => products.has(p));
    const row = await db.maybe<MemberRow>(sql`SELECT * FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${userId} FOR UPDATE`);
    if (qualifies && !row) {
      await upsertMember(db, app, list, userId, { status: 'subscribed', source: 'rule', consented_at: null });
      await record(db, app, list, user, 'subscribed', evidence);
      await announce(db, app, list, user, 'list.member_subscribed', 'rule');
      out.joined.push(list.id);
    } else if (!qualifies && row?.source === 'rule' && row.status !== 'unsubscribed') {
      await db.exec(sql`DELETE FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${userId}`);
      await record(db, app, list, user, 'unsubscribed', evidence);
      if (row.status === 'subscribed') await announce(db, app, list, user, 'list.member_unsubscribed', 'rule');
      out.left.push(list.id);
    }
  }
  return out;
}

/** SQL: user `u` holds one of the products through a subscription or grant, directly or through an organization. */
function holdsAny(productIds: string[], now: Date): Sql {
  const ids = sql.in(productIds);
  const subject = (alias: string) => sql`((${sql.raw(alias)}.subject_type = 'user' AND ${sql.raw(alias)}.subject_id = u.id) OR (${sql.raw(alias)}.subject_type = 'organization'
    AND ${sql.raw(alias)}.subject_id IN (SELECT org_id FROM memberships WHERE user_id = u.id AND status = 'active')))`;
  return sql`(
    EXISTS (SELECT 1 FROM subscriptions s WHERE s.product_id IN ${ids} AND ${subject('s')}
      AND (s.status IN ('active', 'trialing') OR (s.status = 'past_due' AND (s.grace_until IS NULL OR s.grace_until > ${now}))))
    OR EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.product_id IN ${ids} AND ${subject('g')}
      AND g.revoked_at IS NULL AND g.starts_at <= ${now} AND (g.ends_at IS NULL OR g.ends_at > ${now}))
  )`;
}

/**
 * Re-apply one list's rule to everyone it may concern: product holders who
 * are not members yet, and rule members who seem to have lost access. Each is
 * confirmed against the resolved entitlements before anything changes.
 */
export async function syncList(app: App, listId: string): Promise<{ joined: number; left: number }> {
  const list = await app.db.maybe<ListRow>(sql`SELECT * FROM mailing_lists WHERE id = ${listId}`);
  const result = { joined: 0, left: 0 };
  if (!list) return result;
  const now = app.clock.now();
  const candidates = list.auto_product_ids.length
    ? await app.db.many<{ user_id: string }>(sql`
        SELECT u.id AS user_id FROM users u
        WHERE u.deleted_at IS NULL AND ${holdsAny(list.auto_product_ids, now)}
          AND NOT EXISTS (SELECT 1 FROM mailing_list_members m WHERE m.list_id = ${list.id} AND m.user_id = u.id)
        UNION
        SELECT m.user_id FROM mailing_list_members m JOIN users u ON u.id = m.user_id
        WHERE m.list_id = ${list.id} AND m.source = 'rule' AND m.status <> 'unsubscribed' AND (u.deleted_at IS NOT NULL OR NOT ${holdsAny(list.auto_product_ids, now)})
        LIMIT 5000
      `)
    : // The rule was removed: everyone it added leaves.
      await app.db.many<{ user_id: string }>(sql`SELECT user_id FROM mailing_list_members WHERE list_id = ${list.id} AND source = 'rule' AND status <> 'unsubscribed' LIMIT 5000`);
  for (const c of candidates) {
    if (!list.auto_product_ids.length) {
      const removed = await app.db.tx(async (tx) => {
        const user = await tx.one<ListUser>(sql`SELECT id, email FROM users WHERE id = ${c.user_id}`);
        const row = await tx.maybe<MemberRow>(sql`DELETE FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${c.user_id} AND source = 'rule' RETURNING *`);
        if (!row) return false;
        await record(tx, app, list, user, 'unsubscribed', { source: 'rule' });
        if (row.status === 'subscribed') await announce(tx, app, list, user, 'list.member_unsubscribed', 'rule');
        return true;
      });
      if (removed) result.left++;
      continue;
    }
    const change = await app.db.tx((tx) => syncUserLists(tx, app, c.user_id));
    if (change.joined.includes(list.id)) result.joined++;
    if (change.left.includes(list.id)) result.left++;
  }
  return result;
}

// ---- Delivery ---------------------------------------------------------------------------------------------

/**
 * Why a member (`m`, joined with `u`) cannot receive the list's email, or NULL
 * when they can. Explicit list consent is enough unless the person opted out
 * of marketing after giving it; members added by a rule or an administrator
 * also need general marketing consent.
 */
export const BLOCK_REASON = sql`CASE
  WHEN m.status IS DISTINCT FROM 'subscribed' THEN 'not_subscribed'
  WHEN u.deleted_at IS NOT NULL OR u.status = 'banned' THEN 'inactive_recipient'
  WHEN EXISTS (SELECT 1 FROM email_suppressions es WHERE es.email = lower(u.email) AND es.scope = 'all') THEN (SELECT es.reason FROM email_suppressions es WHERE es.email = lower(u.email))
  WHEN m.consented_at IS NULL AND NOT u.marketing_consent THEN 'no_consent'
  WHEN EXISTS (SELECT 1 FROM email_suppressions es WHERE es.email = lower(u.email) AND es.scope = 'marketing' AND (m.consented_at IS NULL OR es.created_at > m.consented_at)) THEN 'unsubscribe'
  WHEN EXISTS (SELECT 1 FROM email_preferences ep WHERE ep.user_id = u.id AND ep.category = 'marketing' AND NOT ep.subscribed AND (m.consented_at IS NULL OR ep.updated_at > m.consented_at)) THEN 'unsubscribed'
  ELSE NULL END`;

export async function listDeliverable(db: Db, input: { listId: string; userId: string | null }): Promise<DeliveryDecision> {
  if (!input.userId) return { allowed: false, reason: 'not_subscribed' };
  const row = await db.maybe<{ reason: string | null }>(sql`
    SELECT ${BLOCK_REASON} AS reason FROM users u LEFT JOIN mailing_list_members m ON m.list_id = ${input.listId} AND m.user_id = u.id WHERE u.id = ${input.userId}
  `);
  if (!row) return { allowed: false, reason: 'inactive_recipient' };
  return row.reason ? { allowed: false, reason: row.reason } : { allowed: true, reason: null };
}

/** What the email module needs to send list email and honour list unsubscribe links. */
export function listBridgeFor(app: App): ListBridge {
  return {
    deliverable: (db, input) => listDeliverable(db, input),
    name: async (db, listId) => (await db.maybe<{ name: string }>(sql`SELECT name FROM mailing_lists WHERE id = ${listId}`))?.name ?? null,
    unsubscribe: async (db, input) => {
      const list = await db.maybe<ListRow>(sql`SELECT * FROM mailing_lists WHERE id = ${input.listId}`);
      const user = await db.maybe<ListUser>(sql`SELECT id, email FROM users WHERE lower(email) = ${input.email.toLowerCase()} AND deleted_at IS NULL`);
      return list && user ? unsubscribe(db, app, list, user, { source: input.source }) : false;
    },
  };
}

export async function listCounts(db: Db, listId: string): Promise<{ subscribed: number; pending: number; unsubscribed: number; reachable: number }> {
  return db.one(sql`
    SELECT count(*) FILTER (WHERE m.status = 'subscribed')::int AS subscribed, count(*) FILTER (WHERE m.status = 'pending')::int AS pending,
      count(*) FILTER (WHERE m.status = 'unsubscribed')::int AS unsubscribed, count(*) FILTER (WHERE (${BLOCK_REASON}) IS NULL)::int AS reachable
    FROM mailing_list_members m JOIN users u ON u.id = m.user_id WHERE m.list_id = ${listId}
  `);
}

// ---- External newsletter services ----------------------------------------------------------------------

/**
 * A newsletter service a plugin keeps in sync with mailing lists. Plugins
 * report themselves through the `marketing.list_providers` filter and sync by
 * listening to `list.member_subscribed` / `list.member_unsubscribed`. Nothing
 * is connected unless a plugin provides it.
 */
export interface ListProvider {
  id: string;
  name: string;
  connected: boolean;
  detail?: string | null;
}

export async function listProviders(app: App): Promise<ListProvider[]> {
  const providers = await app.hooks.apply<ListProvider[], { app: App }>('marketing.list_providers', [], { app });
  return (Array.isArray(providers) ? providers : []).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string');
}
