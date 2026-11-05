import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { forbidden, notFound, validationError } from '../../core/errors.js';
import { ipMatches, isValidCidr, normalizeIp } from '../../core/net.js';
import { pageQuery, paginate, qDate } from '../../core/validation.js';
import { sha256 } from '../../core/crypto.js';
import { MINUTE } from '../../core/clock.js';
import type { FastifyRequest } from 'fastify';
import { raiseSecurityEvent } from './alerts.js';
import { ACCOUNT_SHARING_DEFAULTS, IP_CAVEAT, accountSharingSettings, recordCustomerIp, registerSharingRoutes } from './sharing.js';
import type { RouteContext } from '../../core/http.js';

/** Org-scoped administrators only see sign-ins and security events of their organizations' customers. */
function subjectScopeSql(scope: string[] | null): Sql | null {
  if (!scope) return null;
  return sql`subject_type = 'user' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = subject_id AND m.org_id IN ${sql.in(scope)})`;
}

/** IP rules apply to the whole platform, so they are not for organization-scoped administrators. */
function platformOnly(c: RouteContext): void {
  if (c.orgScope()) throw forbidden('IP rules apply to the whole platform; organization-scoped administrators cannot view or change them', 'org_scope');
}

export { raiseSecurityEvent, type SecurityEventInput } from './alerts.js';
export { recordCustomerIp, sharingBlock, cooldownMessage, type CustomerIpSource, type SharingOutcome } from './sharing.js';

export const securitySettings = z.object({
  autoBlockEnabled: z.boolean(),
  autoBlockThreshold: z.number().int().min(5).max(1000),
  autoBlockWindowMinutes: z.number().int().min(1).max(1440),
  autoBlockMinutes: z.number().int().min(1).max(10080),
  /** Header set by your CDN/proxy with the client country (e.g. cf-ipcountry). Empty disables geolocation. */
  geoCountryHeader: z.string().max(64),
  alertOnNewDevice: z.boolean(),
  userLockoutThreshold: z.number().int().min(3).max(100),
  userLockoutMinutes: z.number().int().min(1).max(1440),
});
export type SecuritySettings = z.infer<typeof securitySettings>;

type IpScope = 'all' | 'admin' | 'api' | 'auth';

interface IpRule {
  id: string;
  cidr: string;
  action: 'block' | 'allow';
  scope: IpScope;
  expires_at: Date | null;
}

export async function loadIpRules(app: App, db: Db = app.db): Promise<void> {
  app.services['security.ipRules'] = await db.many<IpRule>(sql`
    SELECT id, cidr, action, scope, expires_at FROM ip_rules WHERE expires_at IS NULL OR expires_at > ${app.clock.now()}
  `);
}

/**
 * Throws if the IP is blocked for the scope. Allow rules override block rules,
 * so a trusted office range is never caught by a broad block.
 */
export function assertIpAllowed(app: App, ip: string, scope: Exclude<IpScope, 'all'>): void {
  const now = app.clock.now();
  const ipRules = (app.services['security.ipRules'] as IpRule[] | undefined) ?? [];
  const active = ipRules.filter((r) => (r.scope === 'all' || r.scope === scope) && (!r.expires_at || r.expires_at > now));
  const allowed = active.filter((r) => r.action === 'allow').map((r) => r.cidr);
  if (allowed.length && ipMatches(ip, allowed)) return;
  const blocked = active.filter((r) => r.action === 'block').map((r) => r.cidr);
  if (blocked.length && ipMatches(ip, blocked)) throw forbidden('Access from your network has been blocked', 'ip_blocked');
}

export function geoCountry(app: App, req: FastifyRequest): string | null {
  const header = app.settings.get<SecuritySettings>('security').geoCountryHeader;
  if (!header) return null;
  const v = req.headers[header.toLowerCase()];
  const country = Array.isArray(v) ? v[0] : v;
  return country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
}

/** Coarse device fingerprint: user agent family + /24 (or /48) network. Used only for "new device" hints. */
export function deviceHash(ip: string, userAgent: string): string {
  const addr = normalizeIp(ip);
  const net = addr.includes(':') ? addr.split(':').slice(0, 3).join(':') : addr.split('.').slice(0, 3).join('.');
  return sha256(`${userAgent.replace(/[\d.]+/g, '')}|${net}`).slice(0, 32);
}

export interface LoginEventInput {
  subjectType: 'admin' | 'user';
  subjectId: string | null;
  email: string | null;
  success: boolean;
  failureReason?: string | null;
  method?: string;
  ip: string;
  userAgent: string;
  country?: string | null;
}

/**
 * Record a login attempt and run lightweight detection:
 *  - brute force from one IP across accounts -> optional temporary auth block
 *  - successful login from a never-seen device/network -> informational event
 *  - country change within an hour -> "unusual location" warning (a hint only;
 *    VPNs and mobile networks make IP geography unreliable)
 */
export async function recordLogin(db: Db, app: App, e: LoginEventInput): Promise<void> {
  const now = app.clock.now();
  const device = deviceHash(e.ip, e.userAgent);
  const settings = app.settings.get<SecuritySettings>('security');

  if (e.success && e.subjectId) {
    const seen = await db.maybe(sql`
      SELECT 1 FROM login_events WHERE subject_type = ${e.subjectType} AND subject_id = ${e.subjectId} AND success AND device_hash = ${device} LIMIT 1
    `);
    const hadAny = await db.maybe(sql`SELECT 1 FROM login_events WHERE subject_type = ${e.subjectType} AND subject_id = ${e.subjectId} AND success LIMIT 1`);
    if (!seen && hadAny && settings.alertOnNewDevice) {
      await raiseSecurityEvent(db, app, {
        type: 'login.new_device',
        severity: 'info',
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        ip: e.ip,
        details: { userAgent: e.userAgent, country: e.country ?? null },
      });
    }
    if (e.country) {
      const last = await db.maybe<{ country: string; created_at: Date }>(sql`
        SELECT country, created_at FROM login_events
        WHERE subject_type = ${e.subjectType} AND subject_id = ${e.subjectId} AND success AND country IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `);
      if (last && last.country !== e.country && now.getTime() - last.created_at.getTime() < 60 * MINUTE) {
        await raiseSecurityEvent(db, app, {
          type: 'login.unusual_location',
          severity: 'warning',
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          ip: e.ip,
          details: { previousCountry: last.country, country: e.country, note: 'IP geolocation is approximate; VPNs and mobile networks can cause this.' },
        });
      }
    }
  }

  await db.exec(sql.insert('login_events', {
    id: newId('lgn'),
    subject_type: e.subjectType,
    subject_id: e.subjectId,
    email: e.email,
    success: e.success,
    failure_reason: e.failureReason ?? null,
    method: e.method ?? 'password',
    ip: e.ip,
    user_agent: e.userAgent.slice(0, 500),
    country: e.country ?? null,
    device_hash: device,
    created_at: now,
  }, ''));

  if (!e.success && settings.autoBlockEnabled) {
    const since = new Date(now.getTime() - settings.autoBlockWindowMinutes * MINUTE);
    const failures = await db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM login_events WHERE ip = ${e.ip} AND NOT success AND created_at > ${since}`);
    if (failures.count >= settings.autoBlockThreshold) {
      const already = await db.maybe(sql`SELECT 1 FROM ip_rules WHERE cidr = ${e.ip} AND action = 'block' AND (expires_at IS NULL OR expires_at > ${now})`);
      if (!already) {
        const expiresAt = new Date(now.getTime() + settings.autoBlockMinutes * MINUTE);
        await db.exec(sql.insert('ip_rules', {
          id: newId('ipr'),
          cidr: e.ip,
          action: 'block',
          scope: 'auth',
          reason: `Automatic: ${failures.count} failed sign-ins in ${settings.autoBlockWindowMinutes} min`,
          expires_at: expiresAt,
          created_by: null,
          created_at: now,
        }, ''));
        await raiseSecurityEvent(db, app, {
          type: 'ip.auto_blocked',
          severity: 'warning',
          subjectType: 'ip',
          subjectId: e.ip,
          ip: e.ip,
          details: { failures: failures.count, expiresAt },
        });
        db.onCommit(() => void loadIpRules(app).catch(() => undefined));
      }
    }
  }
}

export const securityModule: ModuleDefinition = {
  id: 'security',
  name: 'Security',
  description: 'IP rules, login monitoring, suspicious activity detection and security alerts.',
  version: '1.0.0',
  required: true,
  dependencies: ['core'],
  migrations: [
    {
      version: '001',
      name: 'security tables',
      up: `
        CREATE TABLE ip_rules (
          id text PRIMARY KEY,
          cidr text NOT NULL,
          action text NOT NULL CHECK (action IN ('block', 'allow')),
          scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'admin', 'api', 'auth')),
          reason text,
          expires_at timestamptz,
          created_by text,
          created_at timestamptz NOT NULL
        );

        CREATE TABLE security_events (
          id text PRIMARY KEY,
          type text NOT NULL,
          severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
          subject_type text,
          subject_id text,
          ip text,
          details jsonb NOT NULL DEFAULT '{}',
          status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
          resolved_by text,
          resolved_at timestamptz,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX security_events_created_idx ON security_events (created_at DESC);
        CREATE INDEX security_events_subject_idx ON security_events (subject_type, subject_id, created_at DESC);
        CREATE INDEX security_events_open_idx ON security_events (status, severity) WHERE status <> 'resolved';

        CREATE TABLE login_events (
          id text PRIMARY KEY,
          subject_type text NOT NULL CHECK (subject_type IN ('admin', 'user')),
          subject_id text,
          email text,
          success boolean NOT NULL,
          failure_reason text,
          method text NOT NULL DEFAULT 'password',
          ip text,
          user_agent text,
          country text,
          device_hash text,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX login_events_subject_idx ON login_events (subject_type, subject_id, created_at DESC);
        CREATE INDEX login_events_ip_idx ON login_events (ip, created_at DESC);
        CREATE INDEX login_events_created_idx ON login_events (created_at DESC);
      `,
    },
    {
      version: '002',
      name: 'customer addresses and account sharing flags',
      up: `
        -- One row per customer and address. Like login_events, rows reference users without a
        -- foreign key because this module is set up before the customers module.
        CREATE TABLE customer_ip_addresses (
          user_id text NOT NULL,
          ip text NOT NULL,
          network text NOT NULL,
          first_seen_at timestamptz NOT NULL,
          last_seen_at timestamptz NOT NULL,
          hits int NOT NULL DEFAULT 1,
          sources jsonb NOT NULL DEFAULT '[]',
          last_source text NOT NULL,
          user_agent text,
          country text,
          PRIMARY KEY (user_id, ip)
        );
        CREATE INDEX customer_ip_addresses_recent_idx ON customer_ip_addresses (user_id, last_seen_at DESC);
        CREATE INDEX customer_ip_addresses_seen_idx ON customer_ip_addresses (last_seen_at);

        CREATE TABLE account_sharing_flags (
          id text PRIMARY KEY,
          user_id text NOT NULL,
          status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared')),
          distinct_count int NOT NULL,
          max_allowed int NOT NULL,
          window_hours int NOT NULL,
          count_by text NOT NULL CHECK (count_by IN ('address', 'network')),
          addresses jsonb NOT NULL DEFAULT '[]',
          action text NOT NULL CHECK (action IN ('alert', 'revoke_sessions', 'block_logins')),
          blocked_until timestamptz,
          security_event_id text,
          cleared_by text,
          cleared_at timestamptz,
          clear_note text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX account_sharing_flags_open_uq ON account_sharing_flags (user_id) WHERE status = 'open';
        CREATE INDEX account_sharing_flags_status_idx ON account_sharing_flags (status, created_at DESC);
        CREATE INDEX account_sharing_flags_user_idx ON account_sharing_flags (user_id, created_at DESC);
      `,
    },
  ],
  permissions: [
    { key: 'security.events.view', label: 'View security events and login activity' },
    { key: 'security.events.manage', label: 'Acknowledge and resolve security events' },
    { key: 'security.ip_rules.view', label: 'View IP rules' },
    { key: 'security.ip_rules.manage', label: 'Block and allow IP addresses', dangerous: true },
    { key: 'security.sharing.view', label: 'View account-sharing flags and customer IP addresses' },
    { key: 'security.sharing.manage', label: 'Clear account-sharing flags and change the sharing policy' },
  ],
  nav: [{ id: 'security', label: 'Security', path: '/admin/security', icon: 'shield-alert', section: 'admin', permission: 'security.events.view', order: 20 }],
  events: [
    { type: 'security.alert', description: 'A warning or critical security event was detected' },
    { type: 'user.sharing_flagged', description: 'A customer account used more IP addresses than the sharing policy allows (a signal, not proof)' },
    { type: 'user.sharing_cleared', description: 'An administrator cleared an account-sharing flag' },
  ],
  setup(app) {
    app.settings.define({
      key: 'security',
      module: 'security',
      label: 'Security',
      description: 'Abuse prevention, geolocation and alerting.',
      schema: securitySettings,
      defaults: {
        autoBlockEnabled: true,
        autoBlockThreshold: 25,
        autoBlockWindowMinutes: 15,
        autoBlockMinutes: 60,
        geoCountryHeader: '',
        alertOnNewDevice: true,
        userLockoutThreshold: 10,
        userLockoutMinutes: 15,
      },
      permission: 'security.ip_rules.manage',
    });
    app.settings.define({
      key: 'accountSharing',
      module: 'security',
      label: 'Account sharing',
      description: `Flags customer accounts used from more IP addresses than expected. ${IP_CAVEAT} Prefer alerts over automatic sign-outs or sign-in blocks.`,
      schema: accountSharingSettings,
      defaults: ACCOUNT_SHARING_DEFAULTS,
      permission: 'security.sharing.manage',
    });
    app.hooks.addFilter('system.retention', 'security', async (_v, ctx: { before: (d: number) => Date; settings: { loginEventDays: number; auditLogDays: number } }) => {
      await app.db.exec(sql`DELETE FROM login_events WHERE created_at < ${ctx.before(ctx.settings.loginEventDays)}`);
      await app.db.exec(sql`DELETE FROM security_events WHERE status = 'resolved' AND created_at < ${ctx.before(ctx.settings.auditLogDays)}`);
      await app.db.exec(sql`DELETE FROM ip_rules WHERE expires_at IS NOT NULL AND expires_at < ${ctx.before(1)}`);
      // Customer address history follows the sign-in history retention.
      await app.db.exec(sql`DELETE FROM customer_ip_addresses WHERE last_seen_at < ${ctx.before(ctx.settings.loginEventDays)}`);
      await app.db.exec(sql`DELETE FROM account_sharing_flags WHERE status = 'cleared' AND cleared_at < ${ctx.before(ctx.settings.auditLogDays)}`);
    });
    app.hooks.addFilter('privacy.export', 'security', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      ipAddresses: await ctx.db.many(sql`
        SELECT ip, first_seen_at, last_seen_at, hits, sources, country FROM customer_ip_addresses WHERE user_id = ${ctx.userId} ORDER BY last_seen_at DESC
      `),
    }));
    app.hooks.addFilter('privacy.anonymize', 'security', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      await ctx.db.exec(sql`DELETE FROM customer_ip_addresses WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`UPDATE account_sharing_flags SET addresses = '[]' WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`
        UPDATE security_events SET ip = NULL, details = details - 'email' - 'addresses'
        WHERE subject_type = 'user' AND subject_id = ${ctx.userId} AND type = 'account_sharing.suspected'
      `);
    });
  },
  async start(app) {
    await loadIpRules(app);
    const timer = setInterval(() => void loadIpRules(app).catch(() => undefined), 30_000);
    timer.unref();
    app.services['security.stop'] = async () => clearInterval(timer);

    // Browser requests on the client API carry the customer's own address: feed it to sharing
    // detection. The authenticator is registered by the developers module during setup.
    const client = app.authenticators.client;
    if (client) {
      app.authenticators.client = async (req, mode) => {
        const principal = await client(req, mode);
        if (principal.kind === 'customer') {
          await recordCustomerIp(app, { userId: principal.userId, ip: req.ip, source: 'client_api', userAgent: String(req.headers['user-agent'] ?? '') || null, country: geoCountry(app, req) });
        }
        return principal;
      };
    }
  },
  routes(r, app) {
    registerSharingRoutes(r, app);
    r.route({
      method: 'GET',
      url: '/api/admin/security/overview',
      auth: 'admin',
      permission: 'security.events.view',
      summary: 'Security posture summary',
      tags: ['Security'],
      handler: async (c) => {
        const since = new Date(app.clock.now().getTime() - 86_400_000);
        const scope = c.orgScope();
        const [failed, open, blocked, lockedAdmins] = await Promise.all([
          app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM login_events ${sql.where([sql`NOT success`, sql`created_at > ${since}`, subjectScopeSql(scope)])}`),
          app.db.many<{ severity: string; count: number }>(sql`SELECT severity, count(*)::int AS count FROM security_events ${sql.where([sql`status = 'open'`, subjectScopeSql(scope)])} GROUP BY severity`),
          app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM ip_rules WHERE action = 'block' AND (expires_at IS NULL OR expires_at > ${app.clock.now()})`),
          app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM admins WHERE locked_until > ${app.clock.now()}`),
        ]);
        return {
          failedLogins24h: failed.count,
          openEvents: Object.fromEntries(open.map((o) => [o.severity, o.count])),
          // Platform-wide figures are left out for organization-scoped administrators.
          blockedIps: scope ? null : blocked.count,
          lockedAdmins: scope ? null : lockedAdmins.count,
        };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/security/events',
      auth: 'admin',
      permission: 'security.events.view',
      summary: 'List security events',
      tags: ['Security'],
      query: z.object({
        ...pageQuery,
        status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
        severity: z.enum(['info', 'warning', 'critical']).optional(),
        /** Exact type, or a prefix ending in "*" (e.g. "login.*"). */
        type: z.string().max(100).optional(),
        subjectType: z.string().optional(),
        subjectId: z.string().optional(),
      }),
      handler: (c) =>
        paginate(app.db, {
          select: sql`*`,
          from: sql`security_events`,
          where: sql.where([
            c.query.status && sql`status = ${c.query.status}`,
            c.query.severity && sql`severity = ${c.query.severity}`,
            c.query.type && (c.query.type.endsWith('*') ? sql`type LIKE ${c.query.type.slice(0, -1).replace(/[\\%_]/g, '\\$&') + '%'}` : sql`type = ${c.query.type}`),
            c.query.subjectType && sql`subject_type = ${c.query.subjectType}`,
            c.query.subjectId && sql`subject_id = ${c.query.subjectId}`,
            subjectScopeSql(c.orgScope()),
          ]),
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/security/event-types',
      auth: 'admin',
      permission: 'security.events.view',
      summary: 'Security event types that have occurred, with counts (for filters)',
      tags: ['Security'],
      handler: async (c) => ({
        data: await app.db.many(sql`SELECT type, count(*)::int AS count FROM security_events ${sql.where([subjectScopeSql(c.orgScope())])} GROUP BY type ORDER BY count DESC, type LIMIT 200`),
      }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/security/events/:id',
      auth: 'admin',
      permission: 'security.events.manage',
      summary: 'Acknowledge or resolve a security event',
      tags: ['Security'],
      params: z.object({ id: z.string() }),
      body: z.object({ status: z.enum(['open', 'acknowledged', 'resolved']) }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe(sql`
            UPDATE security_events SET status = ${c.body.status},
              resolved_by = ${c.body.status === 'resolved' ? c.admin().adminId : null},
              resolved_at = ${c.body.status === 'resolved' ? app.clock.now() : null}
            ${sql.where([sql`id = ${c.params.id}`, subjectScopeSql(c.orgScope())])} RETURNING *
          `);
          if (!row) throw notFound('Security event');
          await c.audit(tx, 'security_event.update', { type: 'security_event', id: c.params.id }, { status: c.body.status });
          return row;
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/security/login-events',
      auth: 'admin',
      permission: 'security.events.view',
      summary: 'Login history for admins and users',
      tags: ['Security'],
      query: z.object({
        ...pageQuery,
        subjectType: z.enum(['admin', 'user']).optional(),
        subjectId: z.string().optional(),
        success: z.enum(['true', 'false']).optional(),
        ip: z.string().max(64).optional(),
        from: qDate.optional(),
      }),
      handler: (c) =>
        paginate(app.db, {
          select: sql`*`,
          from: sql`login_events`,
          where: sql.where([
            c.query.subjectType && sql`subject_type = ${c.query.subjectType}`,
            c.query.subjectId && sql`subject_id = ${c.query.subjectId}`,
            c.query.success && sql`success = ${c.query.success === 'true'}`,
            c.query.ip && sql`ip = ${c.query.ip}`,
            c.query.from && sql`created_at >= ${c.query.from}`,
            subjectScopeSql(c.orgScope()),
          ]),
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/security/ip-rules',
      auth: 'admin',
      permission: 'security.ip_rules.view',
      summary: 'List IP allow/block rules',
      tags: ['Security'],
      handler: async (c) => {
        platformOnly(c);
        return { data: await app.db.many(sql`SELECT * FROM ip_rules WHERE expires_at IS NULL OR expires_at > ${app.clock.now()} ORDER BY created_at DESC`) };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/security/ip-rules',
      auth: 'admin',
      permission: 'security.ip_rules.manage',
      summary: 'Block or allow an IP address or CIDR range',
      tags: ['Security'],
      body: z.object({
        cidr: z.string().trim().min(2).max(64),
        action: z.enum(['block', 'allow']),
        scope: z.enum(['all', 'admin', 'api', 'auth']).default('all'),
        reason: z.string().max(500).optional(),
        expiresAt: z.coerce.date().optional(),
      }),
      handler: async (c) => {
        platformOnly(c);
        if (!isValidCidr(c.body.cidr)) throw validationError([{ path: ['cidr'], message: 'Enter a valid IPv4/IPv6 address or CIDR range' }]);
        if (c.body.action === 'block' && (c.body.scope === 'all' || c.body.scope === 'admin') && ipMatches(c.ip, [c.body.cidr])) {
          throw validationError([{ path: ['cidr'], message: 'This rule would block your own current IP address' }]);
        }
        const row = await app.db.tx(async (tx) => {
          const created = await tx.one(sql.insert('ip_rules', {
            id: newId('ipr'),
            cidr: c.body.cidr,
            action: c.body.action,
            scope: c.body.scope,
            reason: c.body.reason ?? null,
            expires_at: c.body.expiresAt ?? null,
            created_by: c.admin().adminId,
            created_at: app.clock.now(),
          }));
          await c.audit(tx, `ip_rule.${c.body.action}`, { type: 'ip_rule', id: created.id }, c.body);
          return created;
        });
        await loadIpRules(app);
        return row;
      },
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/security/ip-rules/:id',
      auth: 'admin',
      permission: 'security.ip_rules.manage',
      summary: 'Remove an IP rule',
      tags: ['Security'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        platformOnly(c);
        await app.db.tx(async (tx) => {
          const n = await tx.exec(sql`DELETE FROM ip_rules WHERE id = ${c.params.id}`);
          if (!n) throw notFound('IP rule');
          await c.audit(tx, 'ip_rule.delete', { type: 'ip_rule', id: c.params.id });
        });
        await loadIpRules(app);
      },
    });
  },
};
