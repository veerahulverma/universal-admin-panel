import { isIP } from 'node:net';
import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { SYSTEM_ACTOR } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound } from '../../core/errors.js';
import { ipMatches, isValidCidr, normalizeIp } from '../../core/net.js';
import { pageQuery, paginate } from '../../core/validation.js';
import { writeAudit } from '../../core/audit.js';
import { HOUR, MINUTE } from '../../core/clock.js';
import { getUser, revokeUserSessions, userScopeSql } from '../customers/service.js';
import { raiseSecurityEvent } from './alerts.js';

/**
 * Account sharing detection. Every place a customer shows up with an IP
 * address (built-in sign-in, session checks, logins your app reports, the
 * browser client API) records it; when an account uses more distinct
 * addresses within a window than the policy allows, it is flagged for review.
 *
 * Addresses are a weak signal. Offices, universities, mobile carriers and
 * VPNs put many people behind one address and move one person across many,
 * so the default action only alerts, and every alert says so.
 */

export const IP_CAVEAT =
  'IP addresses are a signal, not proof: offices, universities, mobile carriers and VPNs share and rotate addresses, so one person can use many and many people can share one. Review the account before acting.';

export const accountSharingSettings = z.object({
  enabled: z.boolean().describe('Flag customer accounts that use more distinct IP addresses than the limit within the window. ' + IP_CAVEAT),
  maxAddresses: z.number().int().min(2).max(1000).describe('Distinct addresses (or networks) allowed within the window before the account is flagged'),
  windowHours: z.number().int().min(1).max(720).describe('Length of the counting window in hours'),
  countBy: z.enum(['address', 'network']).describe('"network" counts each IPv4 /24 and IPv6 /48 once, which tolerates mobile carriers rotating addresses'),
  action: z
    .enum(['alert', 'revoke_sessions', 'block_logins'])
    .describe('alert: raise a security alert for review. revoke_sessions: also sign the customer out everywhere. block_logins: also refuse new sign-ins for the cooling-off period. Prefer alert, because a flag is not proof of sharing.'),
  cooldownMinutes: z.number().int().min(5).max(10080).describe('How long new sign-ins are refused when the action is block_logins'),
  trustedNetworks: z
    .array(z.string().trim().max(64))
    .max(200)
    .refine((list) => list.every(isValidCidr), 'Each entry must be an IP address or CIDR range')
    .describe('Addresses never counted, such as your office or a known corporate proxy'),
});
export type AccountSharingSettings = z.infer<typeof accountSharingSettings>;

export const ACCOUNT_SHARING_DEFAULTS: AccountSharingSettings = {
  enabled: true,
  maxAddresses: 10,
  windowHours: 24,
  countBy: 'address',
  action: 'alert',
  cooldownMinutes: 60,
  trustedNetworks: [],
};

export type CustomerIpSource = 'identity_login' | 'identity_register' | 'session_verify' | 'social_login' | 'app_login' | 'client_api';

export interface SharingOutcome {
  /** Distinct addresses (or networks) in the window, trusted networks excluded. */
  distinct: number;
  flagged: boolean;
  flagId: string | null;
  blockedUntil: Date | null;
}

/** Repeated sightings of the same address are written at most this often per instance. */
const RECORD_INTERVAL_MS = 5 * MINUTE;
const recent = new WeakMap<App, Map<string, number>>();

function seenRecently(app: App, key: string): boolean {
  let map = recent.get(app);
  if (!map) recent.set(app, (map = new Map()));
  const now = app.clock.now().getTime();
  const last = map.get(key);
  if (last !== undefined && now - last < RECORD_INTERVAL_MS) return true;
  if (map.size > 50_000) map.clear();
  map.set(key, now);
  return false;
}

function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  if (tail === undefined) return h;
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

/** The /24 (IPv4) or /48 (IPv6) block an address belongs to. */
export function networkOf(ip: string): string {
  const addr = normalizeIp(ip);
  if (isIP(addr) === 4) return `${addr.split('.').slice(0, 3).join('.')}.0/24`;
  const parts = expandIpv6(addr.toLowerCase()).slice(0, 3).map((p) => p.replace(/^0+(?=.)/, ''));
  return `${parts.join(':')}::/48`;
}

interface IpRow {
  ip: string;
  network: string;
  first_seen_at: Date;
  last_seen_at: Date;
  hits: number;
  sources: string[];
}

/** An active login block from an open flag, if any. */
export async function sharingBlock(db: Db, app: App, userId: string): Promise<{ flagId: string; blockedUntil: Date } | null> {
  const row = await db.maybe<{ id: string; blocked_until: Date }>(sql`
    SELECT id, blocked_until FROM account_sharing_flags
    WHERE user_id = ${userId} AND status = 'open' AND blocked_until > ${app.clock.now()} ORDER BY blocked_until DESC LIMIT 1
  `);
  return row ? { flagId: row.id, blockedUntil: row.blocked_until } : null;
}

export function cooldownMessage(app: App, blockedUntil: Date): string {
  const minutes = Math.max(1, Math.ceil((blockedUntil.getTime() - app.clock.now().getTime()) / MINUTE));
  return `Sign-in to this account is paused for ${minutes} more minute${minutes === 1 ? '' : 's'} because it was used from an unusual number of networks. Contact support if this is a mistake.`;
}

async function evaluate(tx: Db, app: App, userId: string, ip: string, s: AccountSharingSettings): Promise<SharingOutcome> {
  const now = app.clock.now();
  const cleared = await tx.one<{ at: Date | null }>(sql`SELECT max(cleared_at) AS at FROM account_sharing_flags WHERE user_id = ${userId} AND status = 'cleared'`);
  // After an administrator clears a flag, counting starts again from that moment.
  const windowStart = new Date(now.getTime() - s.windowHours * HOUR);
  const since = cleared.at && cleared.at > windowStart ? cleared.at : windowStart;
  const rows = await tx.many<IpRow>(sql`
    SELECT ip, network, first_seen_at, last_seen_at, hits, sources FROM customer_ip_addresses
    WHERE user_id = ${userId} AND last_seen_at >= ${since} ORDER BY last_seen_at DESC
  `);
  const counted = rows.filter((r) => !ipMatches(r.ip, s.trustedNetworks));
  const distinct = new Set(counted.map((r) => (s.countBy === 'network' ? r.network : r.ip))).size;
  if (distinct <= s.maxAddresses) return { distinct, flagged: false, flagId: null, blockedUntil: null };

  const addresses = counted.slice(0, 50).map((r) => ({ ip: r.ip, network: r.network, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, hits: r.hits, sources: r.sources }));
  const open = await tx.maybe<{ id: string; blocked_until: Date | null }>(sql`SELECT id, blocked_until FROM account_sharing_flags WHERE user_id = ${userId} AND status = 'open' FOR UPDATE`);
  if (open) {
    await tx.exec(sql`
      UPDATE account_sharing_flags SET distinct_count = GREATEST(distinct_count, ${distinct}), addresses = ${sql.json(addresses)}, updated_at = ${now} WHERE id = ${open.id}
    `);
    return { distinct, flagged: true, flagId: open.id, blockedUntil: open.blocked_until && open.blocked_until > now ? open.blocked_until : null };
  }

  const blockedUntil = s.action === 'block_logins' ? new Date(now.getTime() + s.cooldownMinutes * MINUTE) : null;
  const flagId = newId('shf');
  const inserted = await tx.exec(sql`
    INSERT INTO account_sharing_flags (id, user_id, status, distinct_count, max_allowed, window_hours, count_by, addresses, action, blocked_until, created_at, updated_at)
    VALUES (${flagId}, ${userId}, 'open', ${distinct}, ${s.maxAddresses}, ${s.windowHours}, ${s.countBy}, ${sql.json(addresses)}, ${s.action}, ${blockedUntil}, ${now}, ${now})
    ON CONFLICT (user_id) WHERE status = 'open' DO NOTHING
  `);
  if (!inserted) return { distinct, flagged: true, flagId: null, blockedUntil: null };

  const user = await tx.one<{ email: string }>(sql`SELECT email FROM users WHERE id = ${userId}`);
  if (s.action !== 'alert') await revokeUserSessions(tx, app, userId, 'account_sharing', SYSTEM_ACTOR, { audit: false });
  const eventId = await raiseSecurityEvent(tx, app, {
    type: 'account_sharing.suspected',
    severity: 'warning',
    subjectType: 'user',
    subjectId: userId,
    ip,
    details: {
      email: user.email,
      distinctAddresses: distinct,
      limit: s.maxAddresses,
      windowHours: s.windowHours,
      countBy: s.countBy,
      action: s.action,
      blockedUntil,
      addresses: addresses.map((a) => a.ip),
      note: IP_CAVEAT,
    },
  });
  await tx.exec(sql`UPDATE account_sharing_flags SET security_event_id = ${eventId} WHERE id = ${flagId}`);
  await writeAudit(tx, app, {
    actor: SYSTEM_ACTOR,
    action: 'user.sharing_flag',
    targetType: 'user',
    targetId: userId,
    metadata: { flagId, distinct, limit: s.maxAddresses, windowHours: s.windowHours, action: s.action, blockedUntil },
  });
  await app.events.emit(tx, 'user.sharing_flagged', { userId, flagId, distinctAddresses: distinct, limit: s.maxAddresses, windowHours: s.windowHours, action: s.action, blockedUntil }, { userId });
  return { distinct, flagged: true, flagId, blockedUntil };
}

/**
 * Record that a customer used an IP address, and flag the account when the
 * sharing policy's limit is exceeded. Safe to call on every request: repeated
 * sightings are throttled, and tracking failures never fail the caller.
 * Call it outside a transaction; it commits on its own.
 */
export async function recordCustomerIp(
  app: App,
  input: { userId: string; ip: string; source: CustomerIpSource; userAgent?: string | null; country?: string | null },
): Promise<SharingOutcome | null> {
  const ip = normalizeIp(input.ip.trim());
  if (!isIP(ip)) return null;
  if (seenRecently(app, `${input.userId}|${ip}`)) return null;
  try {
    return await app.db.tx(async (tx) => {
      const user = await tx.maybe(sql`SELECT 1 FROM users WHERE id = ${input.userId} AND deleted_at IS NULL`);
      if (!user) return null;
      const s = app.settings.get<AccountSharingSettings>('accountSharing');
      const now = app.clock.now();
      const prev = await tx.maybe<{ last_seen_at: Date }>(sql`SELECT last_seen_at FROM customer_ip_addresses WHERE user_id = ${input.userId} AND ip = ${ip} FOR UPDATE`);
      await tx.exec(sql`
        INSERT INTO customer_ip_addresses (user_id, ip, network, first_seen_at, last_seen_at, hits, sources, last_source, user_agent, country)
        VALUES (${input.userId}, ${ip}, ${networkOf(ip)}, ${now}, ${now}, 1, ${sql.json([input.source])}, ${input.source}, ${input.userAgent?.slice(0, 500) ?? null}, ${input.country ?? null})
        ON CONFLICT (user_id, ip) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, hits = customer_ip_addresses.hits + 1,
          last_source = EXCLUDED.last_source,
          sources = CASE WHEN customer_ip_addresses.sources ? EXCLUDED.last_source THEN customer_ip_addresses.sources ELSE customer_ip_addresses.sources || EXCLUDED.sources END,
          user_agent = coalesce(EXCLUDED.user_agent, customer_ip_addresses.user_agent), country = coalesce(EXCLUDED.country, customer_ip_addresses.country)
      `);
      // Only an address entering the window can change the count.
      const entering = !prev || prev.last_seen_at < new Date(now.getTime() - s.windowHours * HOUR);
      if (!s.enabled || !entering) return { distinct: 0, flagged: false, flagId: null, blockedUntil: null };
      return evaluate(tx, app, input.userId, ip, s);
    });
  } catch (err) {
    recent.get(app)?.delete(`${input.userId}|${ip}`);
    app.log.warn({ err, userId: input.userId }, 'recording a customer IP address failed');
    return null;
  }
}

export function presentFlag(f: Record<string, any>) {
  return {
    id: f.id,
    userId: f.user_id,
    email: f.email ?? null,
    name: f.name ?? null,
    status: f.status,
    distinctCount: f.distinct_count,
    maxAllowed: f.max_allowed,
    windowHours: f.window_hours,
    countBy: f.count_by,
    addresses: f.addresses,
    action: f.action,
    blockedUntil: f.blocked_until,
    securityEventId: f.security_event_id,
    clearedBy: f.cleared_by,
    clearedAt: f.cleared_at,
    clearNote: f.clear_note,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  };
}

export function registerSharingRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/security/account-sharing',
    auth: 'admin',
    permission: 'security.sharing.view',
    summary: 'Customer accounts flagged for possible sharing, with the addresses that triggered the flag',
    description: IP_CAVEAT,
    tags: ['Security'],
    query: z.object({ ...pageQuery, status: z.enum(['open', 'cleared', 'all']).default('open'), userId: z.string().optional() }),
    handler: async (c) => {
      const page = await paginate<Record<string, any>>(app.db, {
        select: sql`f.*, u.email, u.name`,
        from: sql`account_sharing_flags f JOIN users u ON u.id = f.user_id`,
        where: sql.where([c.query.status !== 'all' && sql`f.status = ${c.query.status}`, c.query.userId && sql`f.user_id = ${c.query.userId}`, userScopeSql(c.orgScope())]),
        orderBy: sql`ORDER BY f.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      const s = app.settings.get<AccountSharingSettings>('accountSharing');
      return { ...page, data: page.data.map(presentFlag), policy: s, caveat: IP_CAVEAT };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/security/account-sharing/:id/clear',
    auth: 'admin',
    permission: 'security.sharing.manage',
    summary: 'Clear a flag after review: lifts any sign-in block and resolves its security alert',
    tags: ['Security'],
    params: z.object({ id: z.string() }),
    body: z.object({ note: z.string().trim().max(1000).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const flag = await tx.maybe<Record<string, any>>(sql`SELECT * FROM account_sharing_flags WHERE id = ${c.params.id} FOR UPDATE`);
        if (!flag) throw notFound('Flag');
        await getUser(tx, flag.user_id, c.orgScope(), { includeDeleted: true });
        if (flag.status !== 'open') throw conflict('This flag is already cleared', 'flag_cleared');
        const now = app.clock.now();
        const admin = c.admin().adminId;
        const row = await tx.one<Record<string, any>>(sql`
          UPDATE account_sharing_flags SET status = 'cleared', cleared_by = ${admin}, cleared_at = ${now}, clear_note = ${c.body.note ?? null}, updated_at = ${now}
          WHERE id = ${flag.id} RETURNING *
        `);
        if (flag.security_event_id) {
          await tx.exec(sql`
            UPDATE security_events SET status = 'resolved', resolved_by = ${admin}, resolved_at = ${now} WHERE id = ${flag.security_event_id} AND status <> 'resolved'
          `);
        }
        await c.audit(tx, 'user.sharing_clear', { type: 'user', id: flag.user_id }, { flagId: flag.id, note: c.body.note ?? null, liftedBlock: Boolean(flag.blocked_until && flag.blocked_until > now) });
        await app.events.emit(tx, 'user.sharing_cleared', { userId: flag.user_id, flagId: flag.id }, { userId: flag.user_id });
        return presentFlag(row);
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/ip-addresses',
    auth: 'admin',
    permission: 'security.sharing.view',
    summary: "Addresses a customer used (sign-ins, session checks, the client API), with any sharing flags",
    description: IP_CAVEAT,
    tags: ['Security', 'Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, c.orgScope(), { includeDeleted: true });
      const s = app.settings.get<AccountSharingSettings>('accountSharing');
      const [addresses, flags, block] = await Promise.all([
        app.db.many<IpRow & { last_source: string; user_agent: string | null; country: string | null }>(sql`
          SELECT ip, network, first_seen_at, last_seen_at, hits, sources, last_source, user_agent, country FROM customer_ip_addresses
          WHERE user_id = ${user.id} ORDER BY last_seen_at DESC LIMIT 200
        `),
        app.db.many<Record<string, any>>(sql`SELECT * FROM account_sharing_flags WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 20`),
        sharingBlock(app.db, app, user.id),
      ]);
      const since = new Date(app.clock.now().getTime() - s.windowHours * HOUR);
      const inWindow = addresses.filter((a) => a.last_seen_at >= since && !ipMatches(a.ip, s.trustedNetworks));
      return {
        addresses: addresses.map((a) => ({
          ip: a.ip,
          network: a.network,
          firstSeenAt: a.first_seen_at,
          lastSeenAt: a.last_seen_at,
          hits: a.hits,
          sources: a.sources,
          lastSource: a.last_source,
          userAgent: a.user_agent,
          country: a.country,
          trusted: ipMatches(a.ip, s.trustedNetworks),
        })),
        window: { hours: s.windowHours, distinct: new Set(inWindow.map((a) => (s.countBy === 'network' ? a.network : a.ip))).size, limit: s.maxAddresses, countBy: s.countBy, enabled: s.enabled },
        flags: flags.map(presentFlag),
        blockedUntil: block?.blockedUntil ?? null,
        caveat: IP_CAVEAT,
      };
    },
  });
}
