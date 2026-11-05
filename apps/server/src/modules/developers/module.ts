import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { sha256 } from '../../core/crypto.js';
import { likePattern, pageQuery, paginate, qDate } from '../../core/validation.js';
import type { Db } from '../../core/db.js';
import { isValidCidr } from '../../core/net.js';
import { HOUR, MINUTE } from '../../core/clock.js';
import {
  apiKeyAuthenticator,
  apiScopes,
  assertKeyScopesValid,
  customerSessionAuthenticator,
  generateCustomerKey,
  generateSecretKey,
  logApiRequest,
  originAllowed,
  rateHeaders,
  registerApiScopes,
  type DeveloperSettings,
} from './keys.js';
import { attemptDelivery, createEndpoint, fanOutEvent, generateWebhookSecret } from './webhooks.js';
import { registerIntegrationHealthRoutes, setupIntegrationHealth } from './health.js';
import { getUser, getOrganization } from '../customers/service.js';
import { presentUser } from '../customers/routes-api.js';

const developerSettings = z.object({
  defaultRateLimitPerMinute: z.number().int().min(1).max(100_000),
  clientOrigins: z.array(z.string().max(200)).max(50),
  customerSessionMinutes: z.number().int().min(5).max(1440),
  webhookMaxAttempts: z.number().int().min(1).max(20),
  webhookTimeoutSeconds: z.number().int().min(1).max(30),
  webhookAutoDisableAfter: z.number().int().min(1).max(1000),
  apiVersion: z.string().max(20),
});

const webhookUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//.test(u), 'Use an http(s) URL');

function presentKey(k: any) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    mode: k.mode,
    scopes: k.scopes,
    orgId: k.org_id,
    rateLimitPerMinute: k.rate_limit_per_minute,
    allowedIps: k.allowed_ips,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    lastUsedIp: k.last_used_ip,
    revokedAt: k.revoked_at,
    createdAt: k.created_at,
  };
}

/** Tenant isolation: organization-scoped admins only reach their own organizations' endpoints. */
async function endpointInScope(db: Db, id: string, scope: string[] | null): Promise<Record<string, any>> {
  const row = await db.maybe<Record<string, any>>(sql`SELECT * FROM webhook_endpoints WHERE id = ${id} ${scope ? sql`AND org_id IN ${sql.in(scope)}` : sql.empty}`);
  if (!row) throw notFound('Webhook endpoint');
  return row;
}

async function issueCustomerSession(app: App, db: typeof app.db, input: { userId: string; orgId?: string | null; apiKeyId: string | null; ttlMinutes?: number }) {
  const token = `cs_${randomBase62(40)}`;
  const minutes = input.ttlMinutes ?? app.settings.get<DeveloperSettings>('developers').customerSessionMinutes;
  const expiresAt = new Date(app.clock.now().getTime() + minutes * MINUTE);
  const id = newId('cses');
  await db.exec(sql.insert('customer_sessions', {
    id,
    token_hash: sha256(token),
    user_id: input.userId,
    org_id: input.orgId ?? null,
    api_key_id: input.apiKeyId,
    expires_at: expiresAt,
    created_at: app.clock.now(),
  }, ''));
  return { id, token, expiresAt };
}

export const developersModule: ModuleDefinition = {
  id: 'developers',
  name: 'Developers & API',
  description: 'API keys, integration API, customer sessions for the browser SDK, customer API keys, webhooks and request logs.',
  version: '1.0.0',
  required: true,
  dependencies: ['core', 'security', 'iam', 'customers'],
  migrations: [
    {
      version: '001',
      name: 'api keys, webhooks, customer sessions',
      up: `
        CREATE TABLE api_keys (
          id text PRIMARY KEY,
          name text NOT NULL,
          prefix text NOT NULL,
          key_hash text NOT NULL UNIQUE,
          mode text NOT NULL CHECK (mode IN ('live', 'test')),
          scopes jsonb NOT NULL DEFAULT '[]',
          org_id text REFERENCES organizations(id) ON DELETE CASCADE,
          rate_limit_per_minute int,
          allowed_ips jsonb NOT NULL DEFAULT '[]',
          expires_at timestamptz,
          last_used_at timestamptz,
          last_used_ip text,
          revoked_at timestamptz,
          rotated_from_id text,
          created_by text,
          created_at timestamptz NOT NULL
        );

        CREATE TABLE api_requests (
          id text PRIMARY KEY,
          api_key_id text,
          surface text NOT NULL,
          org_id text,
          method text NOT NULL,
          route text NOT NULL,
          path text NOT NULL,
          status int NOT NULL,
          duration_ms int NOT NULL,
          ip text,
          error_code text,
          request_id text,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX api_requests_created_idx ON api_requests (created_at DESC);
        CREATE INDEX api_requests_key_idx ON api_requests (api_key_id, created_at DESC);
        CREATE INDEX api_requests_org_idx ON api_requests (org_id, created_at DESC);

        CREATE TABLE customer_api_keys (
          id text PRIMARY KEY,
          user_id text REFERENCES users(id) ON DELETE CASCADE,
          org_id text REFERENCES organizations(id) ON DELETE CASCADE,
          name text NOT NULL,
          prefix text NOT NULL,
          key_hash text NOT NULL UNIQUE,
          scopes jsonb NOT NULL DEFAULT '[]',
          rate_limit_per_minute int,
          meter_key text,
          expires_at timestamptz,
          last_used_at timestamptz,
          last_used_ip text,
          revoked_at timestamptz,
          created_by_type text,
          created_by_id text,
          created_at timestamptz NOT NULL,
          CHECK (user_id IS NOT NULL OR org_id IS NOT NULL)
        );
        CREATE INDEX customer_api_keys_user_idx ON customer_api_keys (user_id);
        CREATE INDEX customer_api_keys_org_idx ON customer_api_keys (org_id);

        CREATE TABLE customer_sessions (
          id text PRIMARY KEY,
          token_hash text NOT NULL UNIQUE,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          org_id text REFERENCES organizations(id) ON DELETE CASCADE,
          api_key_id text,
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX customer_sessions_user_idx ON customer_sessions (user_id);

        CREATE TABLE webhook_endpoints (
          id text PRIMARY KEY,
          url text NOT NULL,
          description text NOT NULL DEFAULT '',
          events jsonb NOT NULL DEFAULT '["*"]',
          enabled boolean NOT NULL DEFAULT true,
          org_id text REFERENCES organizations(id) ON DELETE CASCADE,
          api_version text NOT NULL,
          consecutive_failures int NOT NULL DEFAULT 0,
          disabled_reason text,
          created_by text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );

        CREATE TABLE webhook_deliveries (
          id text PRIMARY KEY,
          endpoint_id text NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
          event_id text NOT NULL,
          event_type text NOT NULL,
          status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
          attempts int NOT NULL DEFAULT 0,
          response_status int,
          response_body text,
          error text,
          duration_ms int,
          next_attempt_at timestamptz,
          delivered_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          UNIQUE (endpoint_id, event_id)
        );
        CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
        CREATE INDEX webhook_deliveries_status_idx ON webhook_deliveries (status, created_at DESC);
      `,
    },
    {
      version: '002',
      name: 'integration health monitor state',
      up: `
        -- Last observed state of each integration check, so the monitor can alert on changes.
        CREATE TABLE integration_health (
          key text PRIMARY KEY,
          kind text NOT NULL,
          name text NOT NULL,
          status text NOT NULL CHECK (status IN ('ok', 'degraded', 'down', 'unknown', 'disabled')),
          summary text NOT NULL DEFAULT '',
          last_error text,
          last_error_at timestamptz,
          org_id text,
          changed_at timestamptz NOT NULL,
          checked_at timestamptz NOT NULL,
          alerted_at timestamptz
        );
      `,
    },
  ],
  permissions: [
    { key: 'developers.keys.view', label: 'View API keys' },
    { key: 'developers.keys.manage', label: 'Create, roll and revoke API keys', dangerous: true },
    { key: 'developers.webhooks.view', label: 'View webhooks and deliveries' },
    { key: 'developers.webhooks.manage', label: 'Manage webhook endpoints' },
    { key: 'developers.logs.view', label: 'View API request logs' },
    { key: 'developers.customer_keys.view', label: "View customers' API keys" },
    { key: 'developers.customer_keys.manage', label: "Revoke customers' API keys" },
    { key: 'developers.health.view', label: 'View integration health (gateways, email, webhooks, plugins, API keys, jobs)' },
    { key: 'developers.health.manage', label: 'Run integration checks and change alert thresholds' },
  ],
  events: [
    { type: 'integration.unhealthy', description: 'A connected integration (gateway, email provider, webhook endpoint, plugin, API key or the job queue) became unhealthy or got worse' },
    { type: 'integration.recovered', description: 'An unhealthy integration is healthy again' },
  ],
  nav: [
    { id: 'integration-health', label: 'Integration health', path: '/platform/health', icon: 'gauge', section: 'platform', permission: 'developers.health.view', order: 5 },
    { id: 'api-keys', label: 'API keys', path: '/developers/api-keys', icon: 'key', section: 'developers', permission: 'developers.keys.view', order: 0 },
    { id: 'webhooks', label: 'Webhooks', path: '/developers/webhooks', icon: 'webhook', section: 'developers', permission: 'developers.webhooks.view', order: 10 },
    { id: 'api-logs', label: 'API logs', path: '/developers/logs', icon: 'list-tree', section: 'developers', permission: 'developers.logs.view', order: 20 },
    { id: 'api-explorer', label: 'API explorer', path: '/developers/explorer', icon: 'terminal-square', section: 'developers', order: 30 },
    { id: 'events', label: 'Event log', path: '/developers/events', icon: 'radio-tower', section: 'developers', permission: 'system.events.view', order: 40 },
  ],
  setup(app) {
    app.settings.define({
      key: 'developers',
      module: 'developers',
      label: 'API & webhooks',
      description: 'Rate limits, browser origins for the client SDK, and webhook delivery policy.',
      schema: developerSettings,
      defaults: {
        defaultRateLimitPerMinute: 600,
        clientOrigins: [],
        customerSessionMinutes: 60,
        webhookMaxAttempts: 8,
        webhookTimeoutSeconds: 10,
        webhookAutoDisableAfter: 25,
        apiVersion: '2026-11-01',
      },
      permission: 'developers.keys.manage',
    });
    app.authenticators.api = apiKeyAuthenticator(app);
    app.authenticators.client = customerSessionAuthenticator(app);
    // Signing a customer out everywhere (by an admin, a ban or the account-sharing policy) also ends the
    // browser SDK sessions minted for them, not only the built-in sign-in sessions.
    app.events.subscribe('developers.customer-sessions-revoke', 'user.sessions_revoked', async (event, app) => {
      if (!event.data.userId) return;
      await app.db.exec(sql`UPDATE customer_sessions SET revoked_at = ${app.clock.now()} WHERE user_id = ${event.data.userId} AND revoked_at IS NULL`);
    }, { module: 'developers' });
    registerApiScopes(app, 'developers', [
      { scope: 'users:read', description: 'Read users' },
      { scope: 'users:write', description: 'Create, update, suspend and delete users' },
      { scope: 'orgs:read', description: 'Read organizations and members' },
      { scope: 'orgs:write', description: 'Manage organizations and members' },
      { scope: 'events:read', description: 'Poll the event stream' },
      { scope: 'events:write', description: 'Report logins and activity from your app' },
      { scope: 'customer_sessions:write', description: 'Create customer sessions for the browser SDK' },
      { scope: 'customer_keys:read', description: "List customers' API keys" },
      { scope: 'customer_keys:write', description: "Issue and revoke customers' API keys" },
      { scope: 'customer_keys:verify', description: "Verify customers' API keys on incoming requests" },
      { scope: 'webhooks:manage', description: 'Manage webhook endpoints' },
      { scope: 'impersonation:verify', description: 'Verify admin impersonation tokens' },
      { scope: 'health:read', description: 'Read integration health (for monitoring)' },
    ]);
    setupIntegrationHealth(app);
    app.events.subscribe('developers.webhooks', '*', fanOutEvent, { module: 'developers' });
    app.jobs.register('webhooks.deliver', async ({ deliveryId }, { app }) => {
      await attemptDelivery(app, deliveryId);
    }, { module: 'developers', timeoutMs: 60_000 });
    app.hooks.addFilter('system.retention', 'developers', async (_v, ctx: { before: (d: number) => Date; settings: { apiRequestLogDays: number; webhookDeliveryDays: number } }) => {
      await app.db.exec(sql`DELETE FROM api_requests WHERE created_at < ${ctx.before(ctx.settings.apiRequestLogDays)}`);
      await app.db.exec(sql`DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < ${ctx.before(ctx.settings.webhookDeliveryDays)}`);
      await app.db.exec(sql`DELETE FROM customer_sessions WHERE expires_at < ${ctx.before(1)}`);
    });
    app.hooks.addFilter('system.health', 'developers', async (checks: any[]) => {
      const since = new Date(app.clock.now().getTime() - HOUR);
      const failing = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM webhook_deliveries WHERE status = 'failed' AND updated_at > ${since}`);
      const disabled = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM webhook_endpoints WHERE NOT enabled AND disabled_reason IS NOT NULL`);
      return [...checks, { name: 'Webhooks', status: disabled.count ? 'degraded' : failing.count ? 'degraded' : 'ok', detail: `${failing.count} failed deliveries in the last hour, ${disabled.count} auto-disabled endpoints` }];
    });
  },

  http(server, app) {
    // CORS for the browser client API, restricted to configured origins.
    server.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/client/')) return;
      const origin = req.headers.origin;
      if (origin && originAllowed(origin, app.settings.get<DeveloperSettings>('developers').clientOrigins)) {
        reply.header('access-control-allow-origin', origin);
        reply.header('vary', 'Origin');
        reply.header('access-control-allow-headers', 'authorization, content-type');
        reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
        reply.header('access-control-max-age', '600');
      }
      if (req.method === 'OPTIONS') return reply.status(204).send();
    });
    server.addHook('onSend', async (req, reply, payload) => {
      const rl = rateHeaders.get(req);
      if (rl) {
        reply.header('x-ratelimit-limit', rl.limit);
        reply.header('x-ratelimit-remaining', rl.remaining);
        reply.header('x-ratelimit-reset', rl.reset);
      }
      return payload;
    });
    server.addHook('onResponse', async (req, reply) => {
      if (!req.url.startsWith('/api/v1/') && !req.url.startsWith('/api/client/')) return;
      try {
        const code = reply.statusCode >= 400 ? (reply.getHeader('x-error-code') as string | undefined) ?? `http_${reply.statusCode}` : null;
        await logApiRequest(app, app.db, req, reply.statusCode, reply.elapsedTime, code);
      } catch (err) {
        app.log.warn({ err }, 'failed to log API request');
      }
    });
  },

  routes(r, app) {
    registerIntegrationHealthRoutes(r, app);

    // ---- Admin: API keys ---------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/api-keys',
      auth: 'admin',
      permission: 'developers.keys.view',
      summary: 'List API keys',
      tags: ['API keys'],
      query: z.object({ includeRevoked: z.enum(['true', 'false']).optional() }),
      handler: async (c) => {
        const scope = c.orgScope();
        const rows = await app.db.many(sql`
          SELECT k.*, o.name AS org_name FROM api_keys k LEFT JOIN organizations o ON o.id = k.org_id
          ${sql.where([c.query.includeRevoked !== 'true' && sql`k.revoked_at IS NULL`, scope && sql`k.org_id IN ${sql.in(scope)}`])}
          ORDER BY k.created_at DESC
        `);
        return { data: rows.map((k: any) => ({ ...presentKey(k), orgName: k.org_name })) };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/api-scopes',
      auth: 'admin',
      summary: 'Available API key scopes',
      tags: ['API keys'],
      handler: () => ({ data: apiScopes(app) }),
    });

    const keyBody = z.object({
      name: z.string().trim().min(1).max(100),
      mode: z.enum(['live', 'test']).default('live'),
      scopes: z.array(z.string().max(60)).min(1).max(100),
      orgId: z.string().nullable().optional(),
      rateLimitPerMinute: z.number().int().min(1).max(100_000).nullable().optional(),
      allowedIps: z.array(z.string()).max(50).default([]),
      expiresAt: z.coerce.date().nullable().optional(),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/api-keys',
      auth: 'admin',
      permission: 'developers.keys.manage',
      sensitive: true,
      summary: 'Create an API key (the secret is shown once)',
      tags: ['API keys'],
      body: keyBody,
      handler: async (c) => {
        assertKeyScopesValid(app, c.body.scopes);
        if (c.body.allowedIps.some((ip) => !isValidCidr(ip))) throw validationError([{ path: ['allowedIps'], message: 'Invalid IP or CIDR' }]);
        const scope = c.orgScope();
        if (scope && (!c.body.orgId || !scope.includes(c.body.orgId))) throw validationError([{ path: ['orgId'], message: 'Choose one of your organizations' }]);
        return app.db.tx(async (tx) => {
          if (c.body.orgId) await getOrganization(tx, c.body.orgId, scope);
          const { key, prefix, hash } = generateSecretKey(c.body.mode);
          const row = await tx.one(sql.insert('api_keys', {
            id: newId('key'),
            name: c.body.name,
            prefix,
            key_hash: hash,
            mode: c.body.mode,
            scopes: c.body.scopes,
            org_id: c.body.orgId ?? null,
            rate_limit_per_minute: c.body.rateLimitPerMinute ?? null,
            allowed_ips: c.body.allowedIps,
            expires_at: c.body.expiresAt ?? null,
            created_by: c.admin().adminId,
            created_at: app.clock.now(),
          }));
          await c.audit(tx, 'api_key.create', { type: 'api_key', id: row.id, orgId: row.org_id }, { name: row.name, scopes: row.scopes, mode: row.mode });
          return { ...presentKey(row), secret: key };
        });
      },
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/api-keys/:id',
      auth: 'admin',
      permission: 'developers.keys.manage',
      summary: 'Update an API key (name, scopes, limits, IP allowlist)',
      tags: ['API keys'],
      params: z.object({ id: z.string() }),
      body: keyBody.omit({ mode: true, orgId: true }).partial(),
      handler: async (c) => {
        if (c.body.scopes) assertKeyScopesValid(app, c.body.scopes);
        if (c.body.allowedIps?.some((ip) => !isValidCidr(ip))) throw validationError([{ path: ['allowedIps'], message: 'Invalid IP or CIDR' }]);
        return app.db.tx(async (tx) => {
          const scope = c.orgScope();
          const row = await tx.maybe(sql`
            UPDATE api_keys SET ${sql.set({ name: c.body.name, scopes: c.body.scopes, rate_limit_per_minute: c.body.rateLimitPerMinute, allowed_ips: c.body.allowedIps, expires_at: c.body.expiresAt })}
            WHERE id = ${c.params.id} AND revoked_at IS NULL ${scope ? sql`AND org_id IN ${sql.in(scope)}` : sql.empty} RETURNING *
          `);
          if (!row) throw notFound('API key');
          await c.audit(tx, 'api_key.update', { type: 'api_key', id: c.params.id }, c.body);
          return presentKey(row);
        });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/api-keys/:id/roll',
      auth: 'admin',
      permission: 'developers.keys.manage',
      sensitive: true,
      summary: 'Rotate a key: issue a replacement and expire the old one after a grace period',
      tags: ['API keys'],
      params: z.object({ id: z.string() }),
      body: z.object({ expireOldInHours: z.number().min(0).max(720).default(24) }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const scope = c.orgScope();
          const old = await tx.maybe<any>(sql`SELECT * FROM api_keys WHERE id = ${c.params.id} AND revoked_at IS NULL ${scope ? sql`AND org_id IN ${sql.in(scope)}` : sql.empty} FOR UPDATE`);
          if (!old) throw notFound('API key');
          const { key, prefix, hash } = generateSecretKey(old.mode);
          const now = app.clock.now();
          const row = await tx.one(sql.insert('api_keys', {
            id: newId('key'),
            name: old.name,
            prefix,
            key_hash: hash,
            mode: old.mode,
            scopes: old.scopes,
            org_id: old.org_id,
            rate_limit_per_minute: old.rate_limit_per_minute,
            allowed_ips: old.allowed_ips,
            expires_at: old.expires_at,
            rotated_from_id: old.id,
            created_by: c.admin().adminId,
            created_at: now,
          }));
          const expireAt = new Date(now.getTime() + c.body.expireOldInHours * HOUR);
          await tx.exec(sql`UPDATE api_keys SET expires_at = ${expireAt} WHERE id = ${old.id}`);
          await c.audit(tx, 'api_key.roll', { type: 'api_key', id: old.id, orgId: old.org_id }, { newKeyId: row.id, oldExpiresAt: expireAt });
          return { ...presentKey(row), secret: key, previousKeyExpiresAt: expireAt };
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/api-keys/:id',
      auth: 'admin',
      permission: 'developers.keys.manage',
      summary: 'Revoke an API key immediately',
      tags: ['API keys'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const scope = c.orgScope();
          const n = await tx.exec(sql`UPDATE api_keys SET revoked_at = ${app.clock.now()} WHERE id = ${c.params.id} AND revoked_at IS NULL ${scope ? sql`AND org_id IN ${sql.in(scope)}` : sql.empty}`);
          if (!n) throw notFound('API key');
          await c.audit(tx, 'api_key.revoke', { type: 'api_key', id: c.params.id });
        });
      },
    });

    // ---- Admin: request logs ---------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/api-requests',
      auth: 'admin',
      permission: 'developers.logs.view',
      summary: 'API request log',
      tags: ['API keys'],
      query: z.object({
        ...pageQuery,
        keyId: z.string().optional(),
        status: z.enum(['2xx', '4xx', '5xx', '429']).optional(),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        surface: z.enum(['v1', 'client']).optional(),
        route: z.string().max(200).optional(),
        /** Substring of the request path (e.g. a user id). */
        q: z.string().trim().max(200).optional(),
        minDurationMs: z.coerce.number().int().min(0).max(600_000).optional(),
        from: qDate.optional(),
        to: qDate.optional(),
      }),
      handler: (c) => {
        const scope = c.orgScope();
        const s = c.query.status;
        return paginate(app.db, {
          select: sql`r.*, k.name AS key_name, k.prefix AS key_prefix`,
          from: sql`api_requests r LEFT JOIN api_keys k ON k.id = r.api_key_id`,
          where: sql.where([
            c.query.keyId && sql`r.api_key_id = ${c.query.keyId}`,
            s === '2xx' && sql`r.status BETWEEN 200 AND 299`,
            s === '4xx' && sql`r.status BETWEEN 400 AND 499`,
            s === '5xx' && sql`r.status >= 500`,
            s === '429' && sql`r.status = 429`,
            c.query.method && sql`r.method = ${c.query.method}`,
            c.query.surface && sql`r.surface = ${c.query.surface}`,
            c.query.route && sql`r.route = ${c.query.route}`,
            c.query.q && sql`r.path ILIKE ${likePattern(c.query.q)}`,
            c.query.minDurationMs !== undefined && sql`r.duration_ms >= ${c.query.minDurationMs}`,
            c.query.from && sql`r.created_at >= ${c.query.from}`,
            c.query.to && sql`r.created_at < ${c.query.to}`,
            scope && sql`r.org_id IN ${sql.in(scope)}`,
          ]),
          orderBy: sql`ORDER BY r.created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/api-requests/stats',
      auth: 'admin',
      permission: 'developers.logs.view',
      summary: 'API traffic, errors and latency by endpoint',
      tags: ['API keys'],
      query: z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }),
      handler: async (c) => {
        const since = new Date(app.clock.now().getTime() - c.query.hours * HOUR);
        const scope = c.orgScope();
        const scoped = scope ? sql`AND org_id IN ${sql.in(scope)}` : sql.empty;
        const [totals, byRoute, byKey] = await Promise.all([
          app.db.one(sql`
            SELECT count(*)::int AS requests, count(*) FILTER (WHERE status >= 500)::int AS server_errors,
                   count(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS client_errors,
                   count(*) FILTER (WHERE status = 429)::int AS rate_limited,
                   coalesce(round(avg(duration_ms)), 0)::int AS avg_ms,
                   coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms
            FROM api_requests WHERE created_at >= ${since} ${scoped}
          `),
          app.db.many(sql`
            SELECT method, route, count(*)::int AS requests, count(*) FILTER (WHERE status >= 400)::int AS errors, round(avg(duration_ms))::int AS avg_ms
            FROM api_requests WHERE created_at >= ${since} ${scoped} GROUP BY method, route ORDER BY requests DESC LIMIT 25
          `),
          app.db.many(sql`
            SELECT r.api_key_id, k.name, count(*)::int AS requests FROM api_requests r LEFT JOIN api_keys k ON k.id = r.api_key_id
            WHERE r.created_at >= ${since} ${scope ? sql`AND r.org_id IN ${sql.in(scope)}` : sql.empty} GROUP BY r.api_key_id, k.name ORDER BY requests DESC LIMIT 10
          `),
        ]);
        return { since, totals, byRoute, byKey };
      },
    });

    // ---- Admin: webhooks ------------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/webhooks',
      auth: 'admin',
      permission: 'developers.webhooks.view',
      summary: 'List webhook endpoints',
      tags: ['Webhooks'],
      handler: async (c) => {
        const scope = c.orgScope();
        return {
          data: await app.db.many(sql`
            SELECT e.*,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.created_at > ${new Date(app.clock.now().getTime() - 24 * HOUR)}) AS deliveries_24h,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'failed' AND d.created_at > ${new Date(app.clock.now().getTime() - 24 * HOUR)}) AS failed_24h
            FROM webhook_endpoints e ${scope ? sql`WHERE e.org_id IN ${sql.in(scope)}` : sql.empty} ORDER BY e.created_at DESC
          `),
        };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/webhooks/:id',
      auth: 'admin',
      permission: 'developers.webhooks.view',
      summary: 'A webhook endpoint with its recent delivery health',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const ep = await endpointInScope(app.db, c.params.id, c.orgScope());
        const since = new Date(app.clock.now().getTime() - 24 * HOUR);
        const [health, org] = await Promise.all([
          app.db.one<{ deliveries_24h: number; failed_24h: number; pending: number; last_delivery_at: Date | null }>(sql`
            SELECT count(*) FILTER (WHERE created_at > ${since})::int AS deliveries_24h,
                   count(*) FILTER (WHERE status = 'failed' AND created_at > ${since})::int AS failed_24h,
                   count(*) FILTER (WHERE status = 'pending')::int AS pending,
                   max(created_at) AS last_delivery_at
            FROM webhook_deliveries WHERE endpoint_id = ${ep.id}
          `),
          ep.org_id ? app.db.maybe<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${ep.org_id}`) : null,
        ]);
        return { ...ep, ...health, org_name: org?.name ?? null };
      },
    });

    const endpointBody = z.object({
      url: webhookUrl,
      description: z.string().max(500).optional(),
      events: z.array(z.string().max(100)).min(1).max(200).default(['*']),
      orgId: z.string().nullable().optional(),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/webhooks',
      auth: 'admin',
      permission: 'developers.webhooks.manage',
      summary: 'Create a webhook endpoint (the signing secret is returned once)',
      tags: ['Webhooks'],
      body: endpointBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          // An endpoint without an organization receives every tenant's events.
          const scope = c.orgScope();
          if (scope && (!c.body.orgId || !scope.includes(c.body.orgId))) throw validationError([{ path: ['orgId'], message: 'Choose one of your organizations' }]);
          if (c.body.orgId) await getOrganization(tx, c.body.orgId, scope);
          const { id, secret } = await createEndpoint(tx, app, { ...c.body, createdBy: c.admin().adminId });
          await c.audit(tx, 'webhook.create', { type: 'webhook_endpoint', id, orgId: c.body.orgId ?? null }, { url: c.body.url, events: c.body.events });
          return { id, secret };
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/webhooks/:id',
      auth: 'admin',
      permission: 'developers.webhooks.manage',
      summary: 'Update or re-enable a webhook endpoint',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      body: endpointBody.omit({ orgId: true }).partial().extend({ enabled: z.boolean().optional() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          await endpointInScope(tx, c.params.id, c.orgScope());
          const row = await tx.maybe(sql`
            UPDATE webhook_endpoints SET ${sql.set({
              url: c.body.url,
              description: c.body.description,
              events: c.body.events,
              enabled: c.body.enabled,
              disabled_reason: c.body.enabled ? null : undefined,
              consecutive_failures: c.body.enabled ? 0 : undefined,
              updated_at: app.clock.now(),
            })}
            WHERE id = ${c.params.id} RETURNING *
          `);
          if (!row) throw notFound('Webhook endpoint');
          await c.audit(tx, 'webhook.update', { type: 'webhook_endpoint', id: c.params.id }, c.body);
          return row;
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/webhooks/:id/rotate-secret',
      auth: 'admin',
      permission: 'developers.webhooks.manage',
      sensitive: true,
      summary: 'Generate a new signing secret',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          await endpointInScope(tx, c.params.id, c.orgScope());
          const secret = generateWebhookSecret();
          await app.secrets.set(tx, 'webhook_endpoint', c.params.id, 'signing_secret', secret);
          await c.audit(tx, 'webhook.rotate_secret', { type: 'webhook_endpoint', id: c.params.id });
          return { secret };
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/webhooks/:id/test',
      auth: 'admin',
      permission: 'developers.webhooks.manage',
      summary: 'Send a test event to this endpoint now',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const ep = await endpointInScope(app.db, c.params.id, c.orgScope());
        const deliveryId = await app.db.tx(async (tx) => {
          const event = await app.events.emit(tx, 'webhook.test', { message: 'This is a test event from Steward', endpointId: ep.id });
          await tx.exec(sql`UPDATE events SET dispatched_at = ${app.clock.now()} WHERE id = ${event.id}`);
          const id = newId('whd');
          const now = app.clock.now();
          await tx.exec(sql.insert('webhook_deliveries', { id, endpoint_id: ep.id, event_id: event.id, event_type: event.type, status: 'pending', attempts: 0, created_at: now, updated_at: now }, ''));
          return id;
        });
        const result = await attemptDelivery(app, deliveryId);
        return { deliveryId, ...result };
      },
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/webhooks/:id',
      auth: 'admin',
      permission: 'developers.webhooks.manage',
      summary: 'Delete a webhook endpoint',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          await endpointInScope(tx, c.params.id, c.orgScope());
          const n = await tx.exec(sql`DELETE FROM webhook_endpoints WHERE id = ${c.params.id}`);
          if (!n) throw notFound('Webhook endpoint');
          await app.secrets.delete(tx, 'webhook_endpoint', c.params.id);
          await c.audit(tx, 'webhook.delete', { type: 'webhook_endpoint', id: c.params.id });
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/webhooks/:id/deliveries',
      auth: 'admin',
      permission: 'developers.webhooks.view',
      summary: 'Delivery history for an endpoint',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      query: z.object({ ...pageQuery, status: z.enum(['pending', 'succeeded', 'failed']).optional(), eventType: z.string().max(100).optional() }),
      handler: async (c) => {
        await endpointInScope(app.db, c.params.id, c.orgScope());
        return paginate(app.db, {
          select: sql`*`,
          from: sql`webhook_deliveries`,
          where: sql.where([sql`endpoint_id = ${c.params.id}`, c.query.status && sql`status = ${c.query.status}`, c.query.eventType && sql`event_type = ${c.query.eventType}`]),
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/webhook-deliveries/:id',
      auth: 'admin',
      permission: 'developers.webhooks.view',
      summary: 'A delivery with the exact payload sent to the endpoint',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const scope = c.orgScope();
        const d = await app.db.maybe<Record<string, any>>(sql`
          SELECT d.*, e.url AS endpoint_url, e.enabled AS endpoint_enabled, e.api_version, e.org_id AS endpoint_org_id,
                 ev.type, ev.data, ev.user_id, ev.org_id, ev.created_at AS event_created_at
          FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id LEFT JOIN events ev ON ev.id = d.event_id
          WHERE d.id = ${c.params.id} ${scope ? sql`AND e.org_id IN ${sql.in(scope)}` : sql.empty}
        `);
        if (!d) throw notFound('Webhook delivery');
        const { type, data, user_id, org_id, event_created_at, api_version, ...delivery } = d;
        // Same body attemptDelivery() signs and sends (null when the event was pruned by retention).
        const payload = type ? { id: d.event_id, type, created: event_created_at, apiVersion: api_version, data, userId: user_id, orgId: org_id } : null;
        return { ...delivery, payload };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/webhook-deliveries/:id/retry',
      auth: 'admin',
      permission: 'developers.webhooks.manage',
      summary: 'Redeliver now',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const scope = c.orgScope();
        const owned = await app.db.maybe<{ enabled: boolean }>(sql`
          SELECT e.enabled FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.id = ${c.params.id} ${scope ? sql`AND e.org_id IN ${sql.in(scope)}` : sql.empty}
        `);
        if (!owned) throw notFound('Webhook delivery');
        // A disabled endpoint would leave the delivery stuck in "pending".
        if (!owned.enabled) throw conflict('Enable the endpoint before redelivering', 'endpoint_disabled');
        const d = await app.db.maybe(sql`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, updated_at = ${app.clock.now()} WHERE id = ${c.params.id} AND status <> 'pending' RETURNING id`);
        if (!d) throw conflict('Delivery is not in a retryable state', 'not_retryable');
        return attemptDelivery(app, c.params.id);
      },
    });

    // ---- Admin: customer API keys ------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/customer-keys',
      auth: 'admin',
      permission: 'developers.customer_keys.view',
      summary: "Customers' API keys (for API products)",
      tags: ['API keys'],
      query: z.object({ userId: z.string().optional(), orgId: z.string().optional() }),
      handler: async (c) => {
        const scope = c.orgScope();
        return {
          data: await app.db.many(sql`
            SELECT id, user_id, org_id, name, prefix, scopes, rate_limit_per_minute, meter_key, expires_at, last_used_at, last_used_ip, revoked_at, created_at
            FROM customer_api_keys ${sql.where([
              c.query.userId && sql`user_id = ${c.query.userId}`,
              c.query.orgId && sql`org_id = ${c.query.orgId}`,
              scope && sql`(org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = customer_api_keys.user_id AND m.org_id IN ${sql.in(scope)}))`,
            ])} ORDER BY created_at DESC LIMIT 200
          `),
        };
      },
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/customer-keys/:id',
      auth: 'admin',
      permission: 'developers.customer_keys.manage',
      summary: "Revoke a customer's API key",
      tags: ['API keys'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const n = await tx.exec(sql`UPDATE customer_api_keys SET revoked_at = ${app.clock.now()} WHERE id = ${c.params.id} AND revoked_at IS NULL`);
          if (!n) throw notFound('Customer API key');
          await c.audit(tx, 'customer_key.revoke', { type: 'customer_api_key', id: c.params.id });
        });
      },
    });

    // ---- Integration API (v1) ---------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/v1/ping',
      auth: 'api',
      summary: 'Check your API key',
      tags: ['Meta'],
      handler: (c) => {
        const k = c.apiKey();
        return { ok: true, keyId: k.keyId, mode: k.mode, scopes: k.scopes, orgId: k.orgId, apiVersion: app.settings.get<DeveloperSettings>('developers').apiVersion };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/customer-sessions',
      auth: 'api',
      scope: 'customer_sessions:write',
      summary: 'Create a short-lived customer session for the browser SDK',
      description: 'Call from your backend after you authenticate the user, then pass the token to the frontend SDK. Never expose secret keys to browsers.',
      tags: ['Customer sessions'],
      body: z.object({ userId: z.string(), orgId: z.string().optional(), ttlMinutes: z.number().int().min(5).max(1440).optional() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const user = await getUser(tx, c.body.userId, c.orgScope());
          if (user.status === 'banned' || user.status === 'suspended') throw conflict('This user is not active', 'account_inactive');
          if (c.body.orgId) {
            await getOrganization(tx, c.body.orgId, c.orgScope());
            const member = await tx.maybe(sql`SELECT 1 FROM memberships WHERE org_id = ${c.body.orgId} AND user_id = ${user.id} AND status = 'active'`);
            if (!member) throw conflict('The user is not an active member of this organization', 'not_a_member');
          }
          const s = await issueCustomerSession(app, tx, { userId: user.id, orgId: c.body.orgId ?? null, apiKeyId: c.apiKey().keyId, ttlMinutes: c.body.ttlMinutes });
          return { id: s.id, token: s.token, expiresAt: s.expiresAt };
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/v1/customer-sessions/:id',
      auth: 'api',
      scope: 'customer_sessions:write',
      summary: 'Revoke a customer session (e.g. on logout)',
      tags: ['Customer sessions'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.exec(sql`UPDATE customer_sessions SET revoked_at = ${app.clock.now()} WHERE id = ${c.params.id} AND revoked_at IS NULL`);
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/customer-keys',
      auth: 'api',
      scope: 'customer_keys:write',
      summary: "Issue an API key to one of your customers (for your own API product)",
      tags: ['Customer API keys'],
      body: z.object({
        userId: z.string().optional(),
        orgId: z.string().optional(),
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.string().max(60)).max(100).default([]),
        rateLimitPerMinute: z.number().int().min(1).max(1_000_000).optional(),
        meterKey: z.string().max(100).optional(),
        expiresAt: z.coerce.date().optional(),
        prefix: z.string().regex(/^[a-z]{2,8}$/).default('ck'),
      }).refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          if (c.body.userId) await getUser(tx, c.body.userId, c.orgScope());
          if (c.body.orgId) await getOrganization(tx, c.body.orgId, c.orgScope());
          const { key, prefix, hash } = generateCustomerKey(c.body.prefix);
          const row = await tx.one<any>(sql.insert('customer_api_keys', {
            id: newId('ckey'),
            user_id: c.body.userId ?? null,
            org_id: c.body.orgId ?? null,
            name: c.body.name,
            prefix,
            key_hash: hash,
            scopes: c.body.scopes,
            rate_limit_per_minute: c.body.rateLimitPerMinute ?? null,
            meter_key: c.body.meterKey ?? null,
            expires_at: c.body.expiresAt ?? null,
            created_by_type: 'api_key',
            created_by_id: c.apiKey().keyId,
            created_at: app.clock.now(),
          }));
          await app.events.emit(tx, 'customer_key.created', { keyId: row.id, userId: row.user_id, orgId: row.org_id }, { userId: row.user_id, orgId: row.org_id });
          return { id: row.id, key, prefix, name: row.name, scopes: row.scopes, expiresAt: row.expires_at };
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/v1/customer-keys',
      auth: 'api',
      scope: 'customer_keys:read',
      summary: "List a customer's API keys",
      tags: ['Customer API keys'],
      query: z.object({ userId: z.string().optional(), orgId: z.string().optional() }).refine((q) => q.userId || q.orgId, 'userId or orgId is required'),
      handler: async (c) => {
        if (c.query.userId) await getUser(app.db, c.query.userId, c.orgScope());
        if (c.query.orgId) await getOrganization(app.db, c.query.orgId, c.orgScope());
        return {
          data: await app.db.many(sql`
            SELECT id, user_id AS "userId", org_id AS "orgId", name, prefix, scopes, expires_at AS "expiresAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt"
            FROM customer_api_keys ${sql.where([c.query.userId && sql`user_id = ${c.query.userId}`, c.query.orgId && sql`org_id = ${c.query.orgId}`])} ORDER BY created_at DESC
          `),
        };
      },
    });

    r.route({
      method: 'DELETE',
      url: '/api/v1/customer-keys/:id',
      auth: 'api',
      scope: 'customer_keys:write',
      summary: "Revoke a customer's API key",
      tags: ['Customer API keys'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const scope = c.orgScope();
        const n = await app.db.exec(sql`
          UPDATE customer_api_keys SET revoked_at = ${app.clock.now()} WHERE id = ${c.params.id} AND revoked_at IS NULL
          ${scope ? sql`AND (org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = customer_api_keys.user_id AND m.org_id IN ${sql.in(scope)}))` : sql.empty}
        `);
        if (!n) throw notFound('Customer API key');
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/customer-keys/verify',
      auth: 'api',
      scope: 'customer_keys:verify',
      summary: "Verify a customer's API key on an incoming request to your API",
      description: 'Checks validity, per-key rate limits and (if the key has a usage meter) records one unit of usage, enforcing plan quotas.',
      tags: ['Customer API keys'],
      body: z.object({ key: z.string().min(10).max(200), ip: z.string().max(64).optional(), quantity: z.number().int().min(1).max(1_000_000).default(1) }),
      handler: async (c) => {
        const row = await app.db.maybe<any>(sql`SELECT * FROM customer_api_keys WHERE key_hash = ${sha256(c.body.key)}`);
        const now = app.clock.now();
        if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) return { valid: false, reason: 'invalid_key' };
        const owner = row.user_id ? await app.db.maybe<any>(sql`SELECT status, deleted_at FROM users WHERE id = ${row.user_id}`) : null;
        if (owner && (owner.deleted_at || owner.status === 'banned' || owner.status === 'suspended')) return { valid: false, reason: 'account_inactive' };
        let rateLimit = null;
        if (row.rate_limit_per_minute) {
          const rl = await app.rateLimiter.hit(`ckey:${row.id}`, row.rate_limit_per_minute, 60);
          rateLimit = { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt };
          if (!rl.allowed) return { valid: false, reason: 'rate_limited', rateLimit, retryAfterSeconds: rl.retryAfterSeconds };
        }
        const usage = await app.hooks.apply<{ allowed: boolean; [k: string]: unknown } | null>('developers.customerKeyVerified', null, {
          key: row,
          quantity: c.body.quantity,
          actor: c.actor,
        });
        if (usage && !usage.allowed) return { valid: false, reason: 'quota_exceeded', usage, rateLimit };
        if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > MINUTE) {
          await app.db.exec(sql`UPDATE customer_api_keys SET last_used_at = ${now}, last_used_ip = ${c.body.ip ?? null} WHERE id = ${row.id}`);
        }
        return { valid: true, key: { id: row.id, userId: row.user_id, orgId: row.org_id, scopes: row.scopes, name: row.name }, rateLimit, usage };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/v1/events',
      auth: 'api',
      scope: 'events:read',
      summary: 'Poll events (alternative to webhooks)',
      tags: ['Events'],
      query: z.object({ type: z.string().max(100).optional(), after: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      handler: async (c) => {
        const scope = c.orgScope();
        const rows = await app.db.many(sql`
          SELECT id, type, data, user_id AS "userId", org_id AS "orgId", created_at AS created FROM events
          ${sql.where([
            c.query.type && (c.query.type.endsWith('*') ? sql`type LIKE ${c.query.type.slice(0, -1) + '%'}` : sql`type = ${c.query.type}`),
            c.query.after && sql`(created_at, id) > (SELECT created_at, id FROM events WHERE id = ${c.query.after})`,
            scope && sql`org_id IN ${sql.in(scope)}`,
          ])}
          ORDER BY created_at, id LIMIT ${c.query.limit}
        `);
        return { data: rows, hasMore: rows.length === c.query.limit };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/v1/webhook-endpoints',
      auth: 'api',
      scope: 'webhooks:manage',
      summary: 'List webhook endpoints',
      tags: ['Webhooks'],
      handler: async (c) => {
        const scope = c.orgScope();
        return { data: await app.db.many(sql`SELECT id, url, description, events, enabled, org_id AS "orgId", created_at AS "createdAt" FROM webhook_endpoints ${scope ? sql`WHERE org_id IN ${sql.in(scope)}` : sql.empty}`) };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/webhook-endpoints',
      auth: 'api',
      scope: 'webhooks:manage',
      summary: 'Register a webhook endpoint (the signing secret is returned once)',
      tags: ['Webhooks'],
      body: z.object({ url: webhookUrl, description: z.string().max(500).optional(), events: z.array(z.string().max(100)).min(1).max(200).default(['*']) }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const orgId = c.apiKey().orgId;
          const { id, secret } = await createEndpoint(tx, app, { ...c.body, orgId });
          await c.audit(tx, 'webhook.create', { type: 'webhook_endpoint', id, orgId }, { url: c.body.url });
          return { id, secret };
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/v1/webhook-endpoints/:id',
      auth: 'api',
      scope: 'webhooks:manage',
      summary: 'Delete a webhook endpoint',
      tags: ['Webhooks'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const scope = c.orgScope();
        const n = await app.db.exec(sql`DELETE FROM webhook_endpoints WHERE id = ${c.params.id} ${scope ? sql`AND org_id IN ${sql.in(scope)}` : sql.empty}`);
        if (!n) throw notFound('Webhook endpoint');
      },
    });

    // ---- Client API (browser SDK) ---------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/client/me',
      auth: 'client',
      summary: 'The signed-in customer and their organization',
      tags: ['Client'],
      handler: async (c) => {
        const p = c.customer();
        const user = await getUser(app.db, p.userId, null);
        const org = p.orgId ? await app.db.maybe(sql`SELECT id, name, slug FROM organizations WHERE id = ${p.orgId}`) : null;
        return { user: presentUser(user), organization: org };
      },
    });
  },
};
