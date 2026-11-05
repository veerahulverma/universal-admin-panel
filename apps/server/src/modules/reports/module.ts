import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { notFound, validationError } from '../../core/errors.js';
import { toCsv } from '../../core/csv.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import { DAY } from '../../core/clock.js';
import { addInterval } from '../billing/money.js';
import { sendSystemEmail } from '../core/mail.js';
import { baseCurrency, dailySeries, dashboardKpis, has, rangeFromDays, snapshotMetrics, type Range } from './metrics.js';
import { reportCatalog, reportParams, type ReportDef, type ReportParams, type ReportResult } from './catalog.js';
import type { HealthCheck } from '../core/routes.js';

function resolveRange(app: App, q: { from?: Date; to?: Date; days?: number }): Range {
  if (q.from && q.to) {
    if (q.from >= q.to) throw validationError([{ path: ['from'], message: '"from" must be before "to"' }]);
    if (q.to.getTime() - q.from.getTime() > 3 * 366 * DAY) throw validationError([{ path: ['to'], message: 'Ranges are limited to three years' }]);
    return { from: q.from, to: q.to };
  }
  return rangeFromDays(app.clock.now(), q.days ?? 30);
}

async function runReport(app: App, def: ReportDef, q: z.infer<typeof reportParams>): Promise<ReportResult & { key: string; name: string; range: Range }> {
  const range = resolveRange(app, { from: q.from, to: q.to, days: 30 });
  const params: ReportParams = { ...q, from: range.from, to: range.to };
  const result = await def.run(app, app.db, params);
  return { key: def.key, name: def.name, range, ...result };
}

function reportCsv(result: ReportResult): string {
  return toCsv(result.rows, result.columns.map((col) => ({ header: col.label, value: (r: Record<string, unknown>) => r[col.key] })));
}

/** Time-limited signed links for emailed report downloads. */
function fileToken(app: App, fileId: string, expires: number): string {
  return `${expires}.${hmacSha256(app.config.encryptionKeys, `report-file:${fileId}:${expires}`).slice(0, 40)}`;
}

function verifyFileToken(app: App, fileId: string, token: string): boolean {
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(token, fileToken(app, fileId, Number(exp)));
}

function nextSend(schedule: string, from: Date): Date | null {
  if (schedule === 'daily') return new Date(from.getTime() + DAY);
  if (schedule === 'weekly') return new Date(from.getTime() + 7 * DAY);
  if (schedule === 'monthly') return addInterval(from, 'month');
  return null;
}

async function deliverSavedReport(app: App, saved: any): Promise<{ fileId: string; recipients: number }> {
  const def = (await reportCatalog(app)).find((r) => r.key === saved.report_key);
  if (!def) throw new Error(`Report "${saved.report_key}" is not available`);
  const span = saved.schedule === 'monthly' ? 31 : saved.schedule === 'weekly' ? 7 : 1;
  const now = app.clock.now();
  const result = await runReport(app, def, reportParams.parse({ ...saved.params, from: new Date(now.getTime() - span * DAY), to: now }));
  const data = Buffer.from(reportCsv(result));
  const fileId = newId('file');
  const stored = await app.storage.put(`reports/${saved.id}/${fileId}.csv`, data);
  await app.db.exec(sql.insert('files', {
    id: fileId,
    owner_type: 'saved_report',
    owner_id: saved.id,
    filename: `${saved.report_key}-${now.toISOString().slice(0, 10)}.csv`,
    content_type: 'text/csv',
    size: stored.size,
    sha256: stored.sha256,
    storage_key: stored.key,
    uploaded_by_type: 'system',
    created_at: now,
  }, ''));
  const expires = Math.floor(now.getTime() / 1000) + 7 * 86400;
  const link = `${app.config.appUrl}/api/public/report-files/${fileId}?token=${encodeURIComponent(fileToken(app, fileId, expires))}`;
  const recipients: string[] = saved.recipients ?? [];
  await app.db.tx(async (tx) => {
    for (const to of recipients) {
      await sendSystemEmail(app, tx, { to, template: 'reports.scheduled', category: 'transactional', data: { reportName: saved.name, link, rows: result.rows.length } });
    }
    await tx.exec(sql`UPDATE saved_reports SET last_sent_at = ${now}, next_send_at = ${nextSend(saved.schedule, now)} WHERE id = ${saved.id}`);
  });
  return { fileId, recipients: recipients.length };
}

/** Permission needed to see dashboard figures computed from each module's data. */
const KPI_PERMISSIONS: Record<string, string> = {
  reports: 'customers.users.view',
  billing: 'billing.payments.view',
  usage: 'usage.meters.view',
  developers: 'developers.logs.view',
  security: 'security.events.view',
  affiliates: 'affiliates.program.view',
};

export const reportsModule: ModuleDefinition = {
  id: 'reports',
  name: 'Reports & analytics',
  description: 'Dashboard KPIs, revenue and growth reports, cohorts, exports, saved and scheduled reports.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers', 'developers'],
  migrations: [
    {
      version: '001',
      name: 'metrics snapshots, saved reports, dashboard layouts',
      up: `
        CREATE TABLE metrics_daily (
          day date PRIMARY KEY,
          currency text NOT NULL,
          mrr bigint NOT NULL DEFAULT 0,
          users_total int NOT NULL DEFAULT 0,
          active_subscriptions int NOT NULL DEFAULT 0,
          trialing int NOT NULL DEFAULT 0,
          captured_at timestamptz NOT NULL
        );

        CREATE TABLE saved_reports (
          id text PRIMARY KEY,
          name text NOT NULL,
          report_key text NOT NULL,
          params jsonb NOT NULL DEFAULT '{}',
          created_by text NOT NULL,
          shared boolean NOT NULL DEFAULT false,
          schedule text NOT NULL DEFAULT 'none' CHECK (schedule IN ('none', 'daily', 'weekly', 'monthly')),
          recipients jsonb NOT NULL DEFAULT '[]',
          last_sent_at timestamptz,
          next_send_at timestamptz,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX saved_reports_due_idx ON saved_reports (next_send_at) WHERE schedule <> 'none';

        CREATE TABLE dashboard_layouts (
          admin_id text PRIMARY KEY,
          widgets jsonb NOT NULL,
          updated_at timestamptz NOT NULL
        );
      `,
    },
  ],
  permissions: [
    { key: 'reports.dashboard.view', label: 'View the dashboard' },
    { key: 'reports.reports.view', label: 'Run reports' },
    { key: 'reports.reports.export', label: 'Export reports' },
    { key: 'reports.schedules.manage', label: 'Save and schedule reports' },
  ],
  nav: [{ id: 'reports', label: 'Reports', path: '/reports', icon: 'chart-line', section: 'overview', permission: 'reports.reports.view', order: 10 }],
  setup(app) {
    app.jobs.register('reports.snapshot', async (_p, { app }) => {
      await snapshotMetrics(app, app.clock.now());
    }, { module: 'reports' });
    app.jobs.schedule({ key: 'reports.snapshot', jobType: 'reports.snapshot', intervalSeconds: 6 * 3600, description: 'Capture daily MRR and growth snapshots', module: 'reports' });
    app.jobs.register('reports.deliver', async (_p, { app }) => {
      const due = await app.db.many<any>(sql`SELECT * FROM saved_reports WHERE schedule <> 'none' AND next_send_at <= ${app.clock.now()} LIMIT 50`);
      for (const s of due) {
        try {
          await deliverSavedReport(app, s);
        } catch (err) {
          app.log.warn({ err, savedReportId: s.id }, 'scheduled report failed');
        }
      }
    }, { module: 'reports' });
    app.jobs.schedule({ key: 'reports.deliver', jobType: 'reports.deliver', intervalSeconds: 3600, description: 'Email scheduled reports', module: 'reports' });
  },
  routes(r, app) {
    r.route({
      method: 'GET',
      url: '/api/admin/dashboard',
      auth: 'admin',
      permission: 'reports.dashboard.view',
      summary: 'Dashboard KPIs with comparison to the previous period, daily series and recent activity',
      tags: ['Reports'],
      query: z.object({ days: z.coerce.number().int().min(1).max(730).default(30), from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
      handler: async (c) => {
        const range = resolveRange(app, c.query);
        const scope = c.orgScope();
        const canUsers = c.can('customers.users.view');
        const canBilling = has(app, 'billing') && c.can('billing.payments.view');
        const [kpis, series] = await Promise.all([dashboardKpis(app, app.db, range), dailySeries(app, app.db, range)]);
        const recentUsers = !canUsers ? [] : await app.db.many(sql`
          SELECT u.id, u.email, u.name, u.created_at FROM users u WHERE u.deleted_at IS NULL
          ${scope ? sql`AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id IN ${sql.in(scope)})` : sql.empty}
          ORDER BY u.created_at DESC LIMIT 8
        `);
        const recentPayments = canBilling
          ? await app.db.many(sql`
              SELECT p.id, p.amount, p.currency, p.status, p.created_at, coalesce(u.email, o.name) AS customer_label
              FROM payments p LEFT JOIN users u ON p.subject_type = 'user' AND u.id = p.subject_id LEFT JOIN organizations o ON p.subject_type = 'organization' AND o.id = p.subject_id
              ${scope ? sql`WHERE p.org_id IN ${sql.in(scope)}` : sql.empty}
              ORDER BY p.created_at DESC LIMIT 8
            `)
          : [];
        const canSecurity = c.can('security.events.view');
        const recentSecurity = canSecurity ? await app.db.many(sql`SELECT id, type, severity, subject_type, subject_id, created_at FROM security_events ORDER BY created_at DESC LIMIT 8`) : [];
        const recentLogins = canSecurity ? await app.db.many(sql`SELECT id, subject_type, subject_id, email, success, ip, country, created_at FROM login_events ORDER BY created_at DESC LIMIT 8`) : [];
        const jobs = await app.db.many<{ status: string; count: number }>(sql`SELECT status, count(*)::int AS count FROM jobs WHERE status IN ('pending', 'running', 'dead') GROUP BY status`);
        const checks = c.can('system.jobs.view') ? await app.hooks.apply<HealthCheck[]>('system.health', [], { app }) : [];
        // KPIs and series are platform-wide figures: each is shown only to admins allowed to see its
        // source data, and none to organization-scoped admins (tenant isolation).
        const visibleKpis = scope ? [] : kpis.filter((k) => {
          const needed = KPI_PERMISSIONS[k.module];
          return !needed || c.can(needed);
        });
        const visibleSeries = scope ? {} : Object.fromEntries(Object.entries(series).filter(([key]) => (key === 'signups' ? canUsers : canBilling)));
        return {
          currency: baseCurrency(app),
          range,
          kpis: visibleKpis,
          series: visibleSeries,
          scoped: Boolean(scope),
          recent: { users: recentUsers, payments: recentPayments, security: recentSecurity, logins: recentLogins },
          system: { jobs: Object.fromEntries(jobs.map((j) => [j.status, j.count])), checks },
        };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/dashboard/layout',
      auth: 'admin',
      permission: 'reports.dashboard.view',
      summary: "The signed-in admin's saved dashboard layout",
      tags: ['Reports'],
      handler: async (c) => {
        const row = await app.db.maybe<{ widgets: unknown }>(sql`SELECT widgets FROM dashboard_layouts WHERE admin_id = ${c.admin().adminId}`);
        return { widgets: row?.widgets ?? null };
      },
    });

    r.route({
      method: 'PUT',
      url: '/api/admin/dashboard/layout',
      auth: 'admin',
      permission: 'reports.dashboard.view',
      summary: 'Save a custom dashboard layout',
      tags: ['Reports'],
      body: z.object({ widgets: z.array(z.object({ id: z.string().max(60), type: z.string().max(60), size: z.enum(['sm', 'md', 'lg', 'xl']).default('md'), config: z.record(z.string(), z.unknown()).default({}) })).max(40) }),
      handler: async (c) => {
        await app.db.exec(sql`
          INSERT INTO dashboard_layouts (admin_id, widgets, updated_at) VALUES (${c.admin().adminId}, ${sql.json(c.body.widgets)}, ${app.clock.now()})
          ON CONFLICT (admin_id) DO UPDATE SET widgets = EXCLUDED.widgets, updated_at = EXCLUDED.updated_at
        `);
        return { ok: true };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/reports',
      auth: 'admin',
      permission: 'reports.reports.view',
      summary: 'Available reports',
      tags: ['Reports'],
      handler: async () => ({ data: (await reportCatalog(app)).map(({ key, name, description, module, category }) => ({ key, name, description, module, category })) }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/reports/:key',
      auth: 'admin',
      permission: 'reports.reports.view',
      summary: 'Run a report',
      tags: ['Reports'],
      params: z.object({ key: z.string() }),
      query: reportParams,
      handler: async (c) => {
        if (c.orgScope()) throw validationError([{ path: ['key'], message: 'Platform-wide reports are not available to organization-scoped administrators' }]);
        const def = (await reportCatalog(app)).find((d) => d.key === c.params.key);
        if (!def) throw notFound('Report');
        return runReport(app, def, c.query);
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/reports/:key/export.csv',
      auth: 'admin',
      permission: 'reports.reports.export',
      summary: 'Export a report as CSV',
      tags: ['Reports'],
      params: z.object({ key: z.string() }),
      query: reportParams,
      handler: async (c) => {
        if (c.orgScope()) throw validationError([{ path: ['key'], message: 'Platform-wide reports are not available to organization-scoped administrators' }]);
        const def = (await reportCatalog(app)).find((d) => d.key === c.params.key);
        if (!def) throw notFound('Report');
        const result = await runReport(app, def, c.query);
        await c.audit(app.db, 'report.export', { type: 'report', id: def.key }, { from: result.range.from, to: result.range.to });
        return c.reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${def.key}.csv"`).send(reportCsv(result));
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/saved-reports',
      auth: 'admin',
      permission: 'reports.reports.view',
      summary: 'Saved and scheduled reports',
      tags: ['Reports'],
      handler: async (c) => ({ data: await app.db.many(sql`SELECT * FROM saved_reports WHERE created_by = ${c.admin().adminId} OR shared ORDER BY name`) }),
    });

    const savedBody = z.object({
      name: z.string().trim().min(1).max(120),
      reportKey: z.string(),
      params: z.record(z.string(), z.unknown()).default({}),
      shared: z.boolean().default(false),
      schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
      recipients: z.array(z.string().email()).max(50).default([]),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/saved-reports',
      auth: 'admin',
      permission: 'reports.schedules.manage',
      summary: 'Save a report (optionally scheduled by email)',
      tags: ['Reports'],
      body: savedBody,
      handler: async (c) => {
        if (!(await reportCatalog(app)).some((d) => d.key === c.body.reportKey)) throw validationError([{ path: ['reportKey'], message: 'Unknown report' }]);
        if (c.body.schedule !== 'none' && !c.body.recipients.length) throw validationError([{ path: ['recipients'], message: 'Scheduled reports need at least one recipient' }]);
        return app.db.tx(async (tx) => {
          const row = await tx.one(sql.insert('saved_reports', {
            id: newId('rpt'),
            name: c.body.name,
            report_key: c.body.reportKey,
            params: c.body.params,
            created_by: c.admin().adminId,
            shared: c.body.shared,
            schedule: c.body.schedule,
            recipients: c.body.recipients,
            next_send_at: nextSend(c.body.schedule, app.clock.now()),
            created_at: app.clock.now(),
          }));
          await c.audit(tx, 'saved_report.create', { type: 'saved_report', id: row.id }, { reportKey: c.body.reportKey, schedule: c.body.schedule, recipients: c.body.recipients });
          return row;
        });
      },
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/saved-reports/:id',
      auth: 'admin',
      permission: 'reports.schedules.manage',
      summary: 'Rename, re-parameterize or reschedule a saved report',
      tags: ['Reports'],
      params: z.object({ id: z.string() }),
      // Explicit optional fields: savedBody's defaults would otherwise reset whatever a PATCH omits.
      body: z.object({
        name: z.string().trim().min(1).max(120).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        shared: z.boolean().optional(),
        schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
        recipients: z.array(z.string().email()).max(50).optional(),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const current = await tx.maybe<any>(sql`SELECT * FROM saved_reports WHERE id = ${c.params.id} AND (created_by = ${c.admin().adminId} OR ${c.can('*')}) FOR UPDATE`);
          if (!current) throw notFound('Saved report');
          const schedule = c.body.schedule ?? current.schedule;
          const recipients = c.body.recipients ?? current.recipients;
          if (schedule !== 'none' && !recipients.length) throw validationError([{ path: ['recipients'], message: 'Scheduled reports need at least one recipient' }]);
          if (Object.values(c.body).every((v) => v === undefined)) return current;
          const row = await tx.one(sql`
            UPDATE saved_reports SET ${sql.set({
              name: c.body.name,
              params: c.body.params,
              shared: c.body.shared,
              schedule: c.body.schedule,
              recipients: c.body.recipients,
              next_send_at: c.body.schedule && c.body.schedule !== current.schedule ? nextSend(c.body.schedule, app.clock.now()) : undefined,
            })} WHERE id = ${c.params.id} RETURNING *
          `);
          await c.audit(tx, 'saved_report.update', { type: 'saved_report', id: c.params.id }, { changes: Object.keys(c.body), schedule, recipients });
          return row;
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/saved-reports/:id',
      auth: 'admin',
      permission: 'reports.schedules.manage',
      summary: 'Delete a saved report',
      tags: ['Reports'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const n = await tx.exec(sql`DELETE FROM saved_reports WHERE id = ${c.params.id} AND (created_by = ${c.admin().adminId} OR ${c.can('*')})`);
          if (!n) throw notFound('Saved report');
          await c.audit(tx, 'saved_report.delete', { type: 'saved_report', id: c.params.id });
        });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/saved-reports/:id/send-now',
      auth: 'admin',
      permission: 'reports.schedules.manage',
      summary: 'Deliver a scheduled report immediately',
      tags: ['Reports'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const saved = await app.db.maybe(sql`SELECT * FROM saved_reports WHERE id = ${c.params.id}`);
        if (!saved) throw notFound('Saved report');
        return deliverSavedReport(app, saved);
      },
    });

    r.route({
      method: 'GET',
      url: '/api/public/report-files/:id',
      auth: 'public',
      hidden: true,
      params: z.object({ id: z.string() }),
      query: z.object({ token: z.string().max(200) }),
      handler: async (c) => {
        if (!verifyFileToken(app, c.params.id, c.query.token)) throw notFound('File');
        const file = await app.db.maybe<any>(sql`SELECT * FROM files WHERE id = ${c.params.id} AND owner_type = 'saved_report'`);
        if (!file) throw notFound('File');
        const data = await app.storage.get(file.storage_key);
        if (!data) throw notFound('File');
        return c.reply.header('content-type', file.content_type).header('content-disposition', `attachment; filename="${file.filename}"`).send(data);
      },
    });
  },
};

export { verifyFileToken, fileToken };
