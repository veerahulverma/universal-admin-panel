import { z } from 'zod';
import type { RouteContext, Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { forbidden, notFound } from '../../core/errors.js';
import { isAllowed } from '../../core/permissions.js';
import { pageQuery, paginate, qList, qDate, likePattern } from '../../core/validation.js';
import { verifyAuditChain, writeAudit } from '../../core/audit.js';
import { toCsv } from '../../core/csv.js';
import { newId } from '../../core/ids.js';
import type { ApiSurface } from '../../core/openapi.js';

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle?: string | null;
  url: string;
}

export interface SearchContext {
  q: string;
  app: App;
  permissions: string[];
  orgScope: string[] | null;
}

export interface HealthCheck {
  name: string;
  status: 'ok' | 'degraded' | 'down' | 'unconfigured';
  detail?: string;
}

export function registerCoreRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/health',
    auth: 'public',
    summary: 'Liveness and database check',
    tags: ['System'],
    handler: async () => {
      const started = Date.now();
      await app.db.query(sql`SELECT 1`);
      return { status: 'ok', version: app.config.version, dbLatencyMs: Date.now() - started, time: app.clock.now() };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/openapi/:surface',
    auth: 'public',
    hidden: true,
    params: z.object({ surface: z.enum(['v1.json', 'client.json', 'public.json']) }),
    handler: ({ params }) =>
      app.openapi.document(params.surface.replace('.json', '') as ApiSurface, { version: app.config.version, serverUrl: app.config.appUrl }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/openapi.json',
    auth: 'admin',
    hidden: true,
    handler: () => app.openapi.document('admin', { version: app.config.version, serverUrl: app.config.appUrl }),
  });

  // Everything the admin UI needs to render the shell for this admin.
  r.route({
    method: 'GET',
    url: '/api/admin/bootstrap',
    auth: 'admin',
    summary: 'Shell configuration for the signed-in admin',
    tags: ['System'],
    handler: async (c) => {
      const admin = c.admin();
      const general = app.settings.get('general');
      const modules = app.modules.list();
      const nav = modules
        .filter((m) => m.enabled)
        .flatMap((m) => m.nav.map((n) => ({ ...n, module: m.id })))
        .filter((n) => !n.permission || isAllowed(admin.permissions, n.permission));
      const extraNav = await app.hooks.apply('admin.nav', [] as unknown[], { admin });
      const theme = await app.hooks.apply('admin.theme', null as unknown, { admin });
      return {
        app: { name: general.appName, logoUrl: general.logoUrl, faviconUrl: general.faviconUrl, version: app.config.version },
        locale: { locale: general.locale, timezone: general.timezone, dateFormat: general.dateFormat, currency: general.defaultCurrency, currencies: general.currencies },
        nav: [...nav, ...extraNav],
        modules: modules.map((m) => ({ id: m.id, enabled: m.enabled })),
        theme,
      };
    },
  });

  // ---- Global search --------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/search',
    auth: 'admin',
    summary: 'Search across customers, billing, support and more',
    tags: ['System'],
    query: z.object({ q: z.string().trim().min(1).max(100) }),
    rateLimit: { max: 120, windowSec: 60, by: 'principal' },
    handler: async (c) => {
      const admin = c.admin();
      const results = await app.hooks.apply<SearchResult[], SearchContext>('admin.search', [], {
        q: c.query.q,
        app,
        permissions: admin.permissions,
        orgScope: admin.orgScope,
      });
      return { data: results.slice(0, 30) };
    },
  });

  // ---- Settings -------------------------------------------------------------
  const settingsScope = z.object({ scope: z.string().regex(/^(global|org:[a-z0-9_]+)$/).default('global') });

  /** Organization-scoped administrators only see and change their own organizations' overrides. */
  function checkSettingsScope(c: RouteContext, scope: string, write: boolean): void {
    const orgScope = c.orgScope();
    if (!orgScope) return;
    if (scope === 'global' ? write : !orgScope.includes(scope.slice(4))) {
      throw forbidden('Organization-scoped administrators can only manage their organizations’ settings', 'org_scope');
    }
  }

  function settingsSection(key: string) {
    const def = app.settings.definitions().find((d) => d.key === key);
    if (!def) throw notFound('Settings section');
    return def;
  }

  r.route({
    method: 'GET',
    url: '/api/admin/settings',
    auth: 'admin',
    permission: 'system.settings.view',
    summary: 'List settings sections with schemas and current values (optionally for an organization override scope)',
    tags: ['Settings'],
    query: settingsScope,
    handler: (c) => {
      const scope = c.query.scope;
      checkSettingsScope(c, scope, false);
      return {
        scope,
        data: app.settings
          .definitions()
          .filter((d) => app.modules.isEnabled(d.module))
          .map((d) => ({
            key: d.key,
            module: d.module,
            label: d.label,
            description: d.description ?? null,
            tenantOverridable: Boolean(d.tenantOverridable),
            permission: d.permission ?? 'system.settings.manage',
            schema: z.toJSONSchema(d.schema, { io: 'input', unrepresentable: 'any' }),
            defaults: d.defaults,
            value: app.settings.get(d.key, scope),
            // What this scope stores itself (null when it only inherits).
            override: app.settings.getStored(d.key, scope),
          })),
      };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/settings/:key',
    auth: 'admin',
    permission: 'system.settings.view',
    summary: 'Update a settings section',
    tags: ['Settings'],
    params: z.object({ key: z.string() }),
    query: settingsScope,
    body: z.record(z.string(), z.unknown()),
    handler: async (c) => {
      const def = settingsSection(c.params.key);
      const needed = def.permission ?? 'system.settings.manage';
      if (!c.can(needed)) throw forbidden(undefined);
      checkSettingsScope(c, c.query.scope, true);
      const value = await app.db.tx((tx) => app.settings.update(tx, def.key, c.body, c.actor, c.query.scope));
      return { key: def.key, value };
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/settings/:key',
    auth: 'admin',
    permission: 'system.settings.view',
    summary: 'Reset a settings section to its defaults, or remove an organization override',
    tags: ['Settings'],
    params: z.object({ key: z.string() }),
    query: settingsScope,
    handler: async (c) => {
      const def = settingsSection(c.params.key);
      if (!c.can(def.permission ?? 'system.settings.manage')) throw forbidden(undefined);
      checkSettingsScope(c, c.query.scope, true);
      const value = await app.db.tx((tx) => app.settings.reset(tx, def.key, c.actor, c.query.scope));
      return { key: def.key, value };
    },
  });

  // ---- Modules --------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/modules',
    auth: 'admin',
    permission: 'system.modules.view',
    summary: 'List platform modules',
    tags: ['Modules'],
    handler: () => ({ data: app.modules.list() }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/modules/:id/:action',
    auth: 'admin',
    permission: 'system.modules.manage',
    sensitive: true,
    summary: 'Enable or disable a module',
    tags: ['Modules'],
    params: z.object({ id: z.string(), action: z.enum(['enable', 'disable']) }),
    handler: async (c) => {
      await app.db.tx((tx) => app.modules.setEnabled(tx, c.params.id, c.params.action === 'enable', c.actor));
      return { data: app.modules.list().find((m) => m.id === c.params.id) };
    },
  });

  // ---- Jobs & scheduled tasks ------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/jobs',
    auth: 'admin',
    permission: 'system.jobs.view',
    summary: 'List background jobs',
    tags: ['System'],
    query: z.object({
      ...pageQuery,
      status: z.enum(['pending', 'running', 'completed', 'failed', 'dead']).optional(),
      type: z.string().max(100).optional(),
    }),
    handler: async (c) =>
      paginate(app.db, {
        select: sql`id, queue, type, payload, status, attempts, max_attempts, run_at, last_error, created_at, updated_at, completed_at`,
        from: sql`jobs`,
        where: sql.where([c.query.status && sql`status = ${c.query.status}`, c.query.type && sql`type = ${c.query.type}`]),
        orderBy: sql`ORDER BY created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/jobs/:id/retry',
    auth: 'admin',
    permission: 'system.jobs.manage',
    summary: 'Retry a failed or dead job',
    tags: ['System'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const n = await app.db.tx(async (tx) => {
        const count = await tx.exec(sql`
          UPDATE jobs SET status = 'pending', run_at = ${app.clock.now()}, max_attempts = GREATEST(max_attempts, attempts + 1), updated_at = ${app.clock.now()}
          WHERE id = ${c.params.id} AND status IN ('dead', 'failed')
        `);
        if (count) await c.audit(tx, 'job.retry', { type: 'job', id: c.params.id });
        return count;
      });
      if (!n) throw notFound('Failed job');
      app.worker.nudge();
      return { ok: true };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/scheduled-tasks',
    auth: 'admin',
    permission: 'system.jobs.view',
    summary: 'List scheduled tasks',
    tags: ['System'],
    handler: async () => ({ data: await app.db.many(sql`SELECT * FROM scheduled_tasks ORDER BY key`) }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/scheduled-tasks/:key',
    auth: 'admin',
    permission: 'system.jobs.manage',
    summary: 'Enable/disable a scheduled task or change its interval',
    tags: ['System'],
    params: z.object({ key: z.string() }),
    body: z.object({ enabled: z.boolean().optional(), intervalSeconds: z.number().int().min(10).max(30 * 86400).optional() }),
    handler: async (c) => {
      const row = await app.db.tx(async (tx) => {
        const updated = await tx.maybe(sql`
          UPDATE scheduled_tasks SET enabled = COALESCE(${c.body.enabled ?? null}, enabled),
            interval_seconds = COALESCE(${c.body.intervalSeconds ?? null}, interval_seconds)
          WHERE key = ${c.params.key} RETURNING *
        `);
        if (updated) await c.audit(tx, 'scheduled_task.update', { type: 'scheduled_task', id: c.params.key }, c.body);
        return updated;
      });
      if (!row) throw notFound('Scheduled task');
      return row;
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/scheduled-tasks/:key/run',
    auth: 'admin',
    permission: 'system.jobs.manage',
    summary: 'Run a scheduled task now',
    tags: ['System'],
    params: z.object({ key: z.string() }),
    handler: async (c) => {
      const task = await app.db.maybe<{ job_type: string; payload: Record<string, unknown> }>(sql`SELECT job_type, payload FROM scheduled_tasks WHERE key = ${c.params.key}`);
      if (!task) throw notFound('Scheduled task');
      const jobId = await app.db.tx(async (tx) => {
        const id = await app.jobs.enqueue(tx, task.job_type, { ...task.payload, scheduledTask: c.params.key, manual: true });
        await c.audit(tx, 'scheduled_task.run', { type: 'scheduled_task', id: c.params.key });
        return id;
      });
      return { jobId };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/system/health',
    auth: 'admin',
    permission: 'system.jobs.view',
    summary: 'System health: database, queue, integrations',
    tags: ['System'],
    handler: async () => {
      const started = Date.now();
      await app.db.query(sql`SELECT 1`);
      const dbLatencyMs = Date.now() - started;
      const since = new Date(app.clock.now().getTime() - 86_400_000);
      const queue = await app.db.many<{ status: string; count: number }>(sql`SELECT status, count(*)::int AS count FROM jobs GROUP BY status`);
      const failed24h = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM jobs WHERE status = 'dead' AND updated_at > ${since}`);
      const backlog = await app.db.one<{ oldest: Date | null }>(sql`SELECT min(run_at) AS oldest FROM jobs WHERE status = 'pending' AND run_at <= ${app.clock.now()}`);
      const pendingEvents = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM events WHERE dispatched_at IS NULL`);
      const checks = await app.hooks.apply<HealthCheck[]>('system.health', [{ name: 'Database', status: dbLatencyMs < 500 ? 'ok' : 'degraded', detail: `${dbLatencyMs} ms (${app.db.dialect})` }], { app });
      return {
        version: app.config.version,
        environment: app.config.env,
        database: { dialect: app.db.dialect, latencyMs: dbLatencyMs },
        queue: Object.fromEntries(queue.map((q) => [q.status, q.count])),
        deadJobs24h: failed24h.count,
        oldestDueJobAt: backlog.oldest,
        pendingEvents: pendingEvents.count,
        workerId: app.worker.id,
        checks,
      };
    },
  });

  // ---- Audit log --------------------------------------------------------------
  const auditFilters = z.object({
    actorType: z.enum(['admin', 'system', 'api_key', 'user', 'plugin']).optional(),
    actorId: z.string().optional(),
    action: z.string().max(100).optional(),
    targetType: z.string().optional(),
    targetId: z.string().optional(),
    q: z.string().max(100).optional(),
    from: qDate.optional(),
    to: qDate.optional(),
  });
  const auditWhere = (q: z.infer<typeof auditFilters>, scope: string[] | null) =>
    sql.where([
      q.actorType && sql`actor_type = ${q.actorType}`,
      q.actorId && sql`actor_id = ${q.actorId}`,
      q.action && (q.action.endsWith('*') ? sql`action LIKE ${q.action.slice(0, -1) + '%'}` : sql`action = ${q.action}`),
      q.targetType && sql`target_type = ${q.targetType}`,
      q.targetId && sql`target_id = ${q.targetId}`,
      q.q && sql`(action ILIKE ${likePattern(q.q)} OR actor_label ILIKE ${likePattern(q.q)} OR target_id ILIKE ${likePattern(q.q)})`,
      q.from && sql`created_at >= ${q.from}`,
      q.to && sql`created_at <= ${q.to}`,
      scope && sql`org_id IN ${sql.in(scope)}`,
    ]);
  const AUDIT_COLUMNS = sql`seq, id, actor_type, actor_id, actor_label, action, target_type, target_id, org_id, ip, user_agent, metadata, created_at`;

  r.route({
    method: 'GET',
    url: '/api/admin/audit-logs',
    auth: 'admin',
    permission: 'security.audit.view',
    summary: 'Search the audit log',
    tags: ['Security'],
    query: auditFilters.extend(pageQuery),
    handler: async (c) =>
      paginate(app.db, {
        select: AUDIT_COLUMNS,
        from: sql`audit_logs`,
        where: auditWhere(c.query, c.orgScope()),
        orderBy: sql`ORDER BY seq DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/audit-logs/export.csv',
    auth: 'admin',
    permission: 'security.audit.view',
    summary: 'Export the filtered audit log as CSV (up to 50,000 entries; the export itself is audited)',
    tags: ['Security'],
    query: auditFilters,
    rateLimit: { max: 10, windowSec: 60, by: 'principal' },
    handler: async (c) => {
      const rows = await app.db.many<Record<string, unknown>>(sql`
        SELECT ${AUDIT_COLUMNS} FROM audit_logs ${auditWhere(c.query, c.orgScope())} ORDER BY seq DESC LIMIT 50000
      `);
      await writeAudit(app.db, app, { actor: c.actor, action: 'audit_log.export', metadata: { count: rows.length, filters: c.query } });
      const csv = toCsv(rows, ['seq', 'id', 'created_at', 'actor_type', 'actor_id', 'actor_label', 'action', 'target_type', 'target_id', 'org_id', 'ip', 'user_agent', 'metadata'].map((key) => ({ header: key, value: (row: Record<string, unknown>) => row[key] })));
      return c.reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="audit-log-${app.clock.now().toISOString().slice(0, 10)}.csv"`)
        .send(csv);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/audit-logs/verify',
    auth: 'admin',
    permission: 'security.audit.view',
    summary: 'Verify the audit log hash chain (tamper evidence)',
    tags: ['Security'],
    handler: () => verifyAuditChain(app.db),
  });

  // ---- Domain events -----------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/events',
    auth: 'admin',
    permission: 'system.events.view',
    summary: 'Browse domain events',
    tags: ['System'],
    query: z.object({ ...pageQuery, type: z.string().max(100).optional(), userId: z.string().optional(), orgId: z.string().optional() }),
    handler: async (c) => {
      const scope = c.orgScope();
      return paginate(app.db, {
        select: sql`id, type, data, user_id, org_id, created_at, dispatched_at`,
        from: sql`events`,
        where: sql.where([
          c.query.type && (c.query.type.endsWith('*') ? sql`type LIKE ${c.query.type.slice(0, -1) + '%'}` : sql`type = ${c.query.type}`),
          c.query.userId && sql`user_id = ${c.query.userId}`,
          c.query.orgId && sql`org_id = ${c.query.orgId}`,
          scope && sql`org_id IN ${sql.in(scope)}`,
        ]),
        orderBy: sql`ORDER BY created_at DESC, id DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/event-types',
    auth: 'admin',
    summary: 'Catalog of event types (for webhooks and automations)',
    tags: ['System'],
    handler: () => ({ data: app.events.catalog() }),
  });

  // ---- Admin notifications --------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/notifications',
    auth: 'admin',
    summary: 'Notification center for the signed-in admin',
    tags: ['Notifications'],
    query: z.object({ ...pageQuery, unread: z.enum(['true', 'false']).optional() }),
    handler: async (c) => {
      const admin = c.admin();
      const page = await paginate(app.db, {
        select: sql`id, type, title, body, link, severity, data, read_at, created_at`,
        from: sql`notifications`,
        where: sql.where([
          sql`recipient_type = 'admin' AND recipient_id = ${admin.adminId}`,
          c.query.unread === 'true' && sql`read_at IS NULL`,
        ]),
        orderBy: sql`ORDER BY created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      const unread = await app.db.one<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM notifications WHERE recipient_type = 'admin' AND recipient_id = ${admin.adminId} AND read_at IS NULL`,
      );
      return { ...page, unread: unread.count };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/notifications/read',
    auth: 'admin',
    summary: 'Mark notifications as read',
    tags: ['Notifications'],
    body: z.object({ ids: z.array(z.string()).max(500).optional(), all: z.boolean().optional() }),
    handler: async (c) => {
      const admin = c.admin();
      const n = await app.db.exec(sql`
        UPDATE notifications SET read_at = ${app.clock.now()}
        WHERE recipient_type = 'admin' AND recipient_id = ${admin.adminId} AND read_at IS NULL
        ${c.body.all ? sql.empty : sql`AND id IN ${sql.in(c.body.ids ?? [])}`}
      `);
      return { updated: n };
    },
  });

  // ---- Saved table views ------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/saved-views',
    auth: 'admin',
    summary: 'Saved filters for a list page',
    tags: ['System'],
    query: z.object({ resource: z.string().max(50) }),
    handler: async (c) => ({
      data: await app.db.many(sql`
        SELECT id, admin_id, resource, name, state, shared, created_at FROM saved_views
        WHERE resource = ${c.query.resource} AND (admin_id = ${c.admin().adminId} OR shared) ORDER BY name
      `),
    }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/saved-views',
    auth: 'admin',
    summary: 'Save the current filters of a list page',
    tags: ['System'],
    body: z.object({ resource: z.string().max(50), name: z.string().min(1).max(80), state: z.record(z.string(), z.unknown()), shared: z.boolean().default(false) }),
    handler: async (c) =>
      app.db.one(sql.insert('saved_views', {
        id: newId('view'),
        admin_id: c.admin().adminId,
        resource: c.body.resource,
        name: c.body.name,
        state: c.body.state,
        shared: c.body.shared,
        created_at: app.clock.now(),
      })),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/saved-views/:id',
    auth: 'admin',
    summary: 'Delete a saved view',
    tags: ['System'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const n = await app.db.exec(sql`DELETE FROM saved_views WHERE id = ${c.params.id} AND admin_id = ${c.admin().adminId}`);
      if (!n) throw notFound('Saved view');
    },
  });
}

/** Helper for modules to contribute search results (respecting permissions). */
export function addSearchProvider(
  app: App,
  owner: string,
  permission: string,
  fn: (ctx: SearchContext) => Promise<SearchResult[]>,
): void {
  app.hooks.addFilter<SearchResult[], SearchContext>('admin.search', owner, async (results, ctx) => {
    if (!app.modules.isEnabled(owner) || !isAllowed(ctx.permissions, permission)) return results;
    return [...results, ...(await fn(ctx))];
  });
}

export const listParam = qList;
