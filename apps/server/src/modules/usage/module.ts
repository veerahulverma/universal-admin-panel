import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { notFound } from '../../core/errors.js';
import { pageQuery, paginate } from '../../core/validation.js';
import { DAY } from '../../core/clock.js';
import { subjectFor, type Subject } from '../catalog/entitlements.js';
import { registerApiScopes } from '../developers/keys.js';
import {
  commitReservation,
  creditBalance,
  currentUsageFor,
  debitCredits,
  expireCredits,
  grantCredits,
  recordUsage,
  releaseReservation,
  reserveUsage,
  setGauge,
  usageSummary,
} from './engine.js';

const subjectFields = { userId: z.string().optional(), orgId: z.string().optional() };
const usageBody = z
  .object({
    ...subjectFields,
    meter: z.string().min(1).max(64),
    quantity: z.number().refine((n) => n !== 0, 'Quantity cannot be zero').default(1),
    dimensions: z.record(z.string().max(40), z.string().max(100)).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .refine((b) => b.userId || b.orgId, 'userId or orgId is required');

async function creditsFor(db: Db, subject: Subject) {
  return db.many(sql`SELECT credit_type AS type, balance, updated_at AS "updatedAt" FROM credit_balances WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} ORDER BY credit_type`);
}

function subjectFromPrincipal(p: { userId: string; orgId: string | null }): Subject {
  return p.orgId ? { type: 'organization', id: p.orgId } : { type: 'user', id: p.userId };
}

export const usageModule: ModuleDefinition = {
  id: 'usage',
  name: 'Usage & limits',
  description: 'Metering, quotas, reservations, overage tracking, credits and consumption forecasts.',
  version: '1.0.0',
  dependencies: ['core', 'customers', 'developers', 'catalog'],
  migrations: [
    {
      version: '001',
      name: 'usage counters, events, reservations, credits',
      up: `
        CREATE TABLE usage_counters (
          id text PRIMARY KEY,
          subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization')),
          subject_id text NOT NULL,
          meter_key text NOT NULL,
          period_start timestamptz NOT NULL,
          period_end timestamptz,
          used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
          reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
          overage bigint NOT NULL DEFAULT 0,
          warned_at timestamptz,
          limit_reached_at timestamptz,
          billed_at timestamptz,
          updated_at timestamptz NOT NULL,
          UNIQUE (subject_type, subject_id, meter_key, period_start)
        );
        CREATE INDEX usage_counters_meter_period_idx ON usage_counters (meter_key, period_start);

        CREATE TABLE usage_events (
          id text PRIMARY KEY,
          subject_type text NOT NULL,
          subject_id text NOT NULL,
          user_id text,
          org_id text,
          meter_key text NOT NULL,
          quantity bigint NOT NULL,
          raw_quantity numeric NOT NULL,
          dimensions jsonb NOT NULL DEFAULT '{}',
          idempotency_key text,
          source text NOT NULL,
          actor_id text,
          reason text,
          reservation_id text,
          counter_id text,
          created_at timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX usage_events_idem_uq ON usage_events (meter_key, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX usage_events_subject_idx ON usage_events (subject_type, subject_id, meter_key, created_at DESC);
        CREATE INDEX usage_events_created_idx ON usage_events (created_at DESC);

        CREATE TABLE usage_reservations (
          id text PRIMARY KEY,
          counter_id text NOT NULL REFERENCES usage_counters(id),
          subject_type text NOT NULL,
          subject_id text NOT NULL,
          user_id text,
          org_id text,
          meter_key text NOT NULL,
          quantity bigint NOT NULL CHECK (quantity > 0),
          dimensions jsonb NOT NULL DEFAULT '{}',
          credit_hold bigint NOT NULL DEFAULT 0,
          status text NOT NULL CHECK (status IN ('held', 'committed', 'released', 'expired')),
          idempotency_key text,
          committed_quantity bigint,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL,
          finalized_at timestamptz
        );
        CREATE UNIQUE INDEX usage_reservations_idem_uq ON usage_reservations (meter_key, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX usage_reservations_expiry_idx ON usage_reservations (expires_at) WHERE status = 'held';

        CREATE TABLE credit_balances (
          subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization')),
          subject_id text NOT NULL,
          credit_type text NOT NULL,
          balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
          updated_at timestamptz NOT NULL,
          PRIMARY KEY (subject_type, subject_id, credit_type)
        );

        CREATE TABLE credit_ledger (
          id text PRIMARY KEY,
          subject_type text NOT NULL,
          subject_id text NOT NULL,
          credit_type text NOT NULL,
          amount bigint NOT NULL,
          balance_after bigint NOT NULL,
          remaining bigint,
          reason text,
          source text NOT NULL,
          source_ref text,
          expires_at timestamptz,
          idempotency_key text,
          actor_id text,
          created_at timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX credit_ledger_idem_uq ON credit_ledger (credit_type, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX credit_ledger_subject_idx ON credit_ledger (subject_type, subject_id, created_at DESC);
        CREATE INDEX credit_ledger_expiry_idx ON credit_ledger (expires_at) WHERE amount > 0 AND remaining > 0;
      `,
    },
  ],
  permissions: [
    { key: 'usage.meters.view', label: 'View usage and quotas' },
    { key: 'usage.adjust.manage', label: 'Adjust or reset usage counters', dangerous: true },
    { key: 'usage.credits.view', label: 'View credit balances' },
    { key: 'usage.credits.manage', label: 'Grant and deduct credits', dangerous: true },
  ],
  nav: [{ id: 'usage', label: 'Usage', path: '/catalog/usage', icon: 'chart-column', section: 'catalog', permission: 'usage.meters.view', order: 30 }],
  events: [
    { type: 'usage.limit_warning', description: 'A customer crossed the warning threshold of a quota' },
    { type: 'usage.limit_reached', description: 'A customer reached a quota limit' },
    { type: 'credits.granted', description: 'Credits were added to a balance' },
  ],
  setup(app) {
    app.settings.define({
      key: 'usage',
      module: 'usage',
      label: 'Usage engine',
      description: 'Reservation lifetimes.',
      schema: z.object({ defaultReservationSeconds: z.number().int().min(5).max(86400), maxReservationSeconds: z.number().int().min(60).max(7 * 86400) }),
      defaults: { defaultReservationSeconds: 300, maxReservationSeconds: 86400 },
      permission: 'catalog.products.manage',
    });
    registerApiScopes(app, 'usage', [
      { scope: 'usage:read', description: 'Read usage and quotas' },
      { scope: 'usage:write', description: 'Record, reserve and commit usage' },
      { scope: 'credits:read', description: 'Read credit balances' },
      { scope: 'credits:write', description: 'Grant and consume credits' },
    ]);
    app.services['usage.current'] = (db: Db, subject: Subject, feature: any) => currentUsageFor(db, app, subject, feature);

    app.jobs.register('usage.expire_reservations', async (_p, { app }) => {
      const due = await app.db.many<{ id: string }>(sql`SELECT id FROM usage_reservations WHERE status = 'held' AND expires_at <= ${app.clock.now()} LIMIT 1000`);
      for (const r of due) await releaseReservation(app.db, app, r.id, null, 'expired');
    }, { module: 'usage' });
    app.jobs.schedule({ key: 'usage.expire_reservations', jobType: 'usage.expire_reservations', intervalSeconds: 60, description: 'Release reservations that were never committed', module: 'usage' });
    app.jobs.register('usage.expire_credits', async (_p, { app }) => {
      await expireCredits(app);
    }, { module: 'usage' });
    app.jobs.schedule({ key: 'usage.expire_credits', jobType: 'usage.expire_credits', intervalSeconds: 3600, description: 'Remove expired credits from balances', module: 'usage' });

    // Customer API keys with a meter count each verified request against the owner's quota.
    app.hooks.addFilter('developers.customerKeyVerified', 'usage', async (prev: unknown, ctx: { key: any; quantity: number; actor: any }) => {
      if (!ctx.key.meter_key || !app.modules.isEnabled('usage')) return prev;
      const subject: Subject = ctx.key.org_id ? { type: 'organization', id: ctx.key.org_id } : { type: 'user', id: ctx.key.user_id };
      return recordUsage(app.db, app, { subject, userId: ctx.key.user_id, orgId: ctx.key.org_id, meterKey: ctx.key.meter_key, quantity: ctx.quantity, mode: 'enforce', source: 'api' });
    });

    app.hooks.addFilter('customers.user.profile', 'usage', async (panels: Record<string, unknown>, ctx: { app: App; user: { id: string }; permissions: string[] }) => {
      if (!app.modules.isEnabled('usage')) return panels;
      const subject: Subject = { type: 'user', id: ctx.user.id };
      return { ...panels, usage: await usageSummary(app.db, app, subject), credits: await creditsFor(app.db, subject) };
    });

    app.hooks.addFilter('privacy.export', 'usage', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      usage: await ctx.db.many(sql`SELECT meter_key, quantity, dimensions, created_at FROM usage_events WHERE user_id = ${ctx.userId} ORDER BY created_at DESC LIMIT 10000`),
      credits: await ctx.db.many(sql`SELECT credit_type, amount, reason, source, created_at FROM credit_ledger WHERE subject_type = 'user' AND subject_id = ${ctx.userId}`),
    }));

    // Plans and credit packs can grant credits (per billing period or per purchase).
    app.events.subscribe('usage.grant-plan-credits', 'billing.credits_due', async (event) => {
      const d = event.data as { subjectType: Subject['type']; subjectId: string; creditType: string; amount: number; expiresAt: string | null; reference: string; reason: string };
      await app.db.tx((tx) =>
        grantCredits(tx, app, {
          subject: { type: d.subjectType, id: d.subjectId },
          creditType: d.creditType,
          amount: d.amount,
          source: 'purchase',
          reason: d.reason,
          expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
          idempotencyKey: d.reference,
          sourceRef: d.reference,
        }),
      );
    }, { module: 'usage' });
  },
  routes(r, app) {
    const ttlOf = (requested?: number) => {
      const s = app.settings.get<{ defaultReservationSeconds: number; maxReservationSeconds: number }>('usage');
      return Math.min(requested ?? s.defaultReservationSeconds, s.maxReservationSeconds);
    };

    // ---- Integration API ----------------------------------------------------------
    r.route({
      method: 'POST',
      url: '/api/v1/usage/consume',
      auth: 'api',
      scope: 'usage:write',
      summary: 'Check the quota and record usage atomically',
      description: 'Returns `allowed: false` (and records nothing) when a hard limit would be exceeded. Pass an idempotencyKey so retries are never double-counted.',
      tags: ['Usage'],
      body: usageBody,
      handler: async (c) => {
        const subject = await subjectFor(app.db, c.body, c.orgScope());
        return recordUsage(app.db, app, { subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, meterKey: c.body.meter, quantity: c.body.quantity, dimensions: c.body.dimensions, idempotencyKey: c.body.idempotencyKey, mode: 'enforce', source: 'api', actorId: c.apiKey().keyId });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/usage/record',
      auth: 'api',
      scope: 'usage:write',
      summary: 'Record usage that already happened (no denial; tracks overage)',
      tags: ['Usage'],
      body: usageBody,
      handler: async (c) => {
        const subject = await subjectFor(app.db, c.body, c.orgScope());
        return recordUsage(app.db, app, { subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, meterKey: c.body.meter, quantity: c.body.quantity, dimensions: c.body.dimensions, idempotencyKey: c.body.idempotencyKey, mode: 'record', source: 'api', actorId: c.apiKey().keyId });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/usage/reserve',
      auth: 'api',
      scope: 'usage:write',
      summary: 'Hold quota (and credits) before a long-running task; commit or release later',
      tags: ['Usage'],
      body: usageBody.and(z.object({ ttlSeconds: z.number().int().min(5).optional() })),
      handler: async (c) => {
        const subject = await subjectFor(app.db, c.body, c.orgScope());
        return reserveUsage(app.db, app, { subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, meterKey: c.body.meter, quantity: c.body.quantity, dimensions: c.body.dimensions, idempotencyKey: c.body.idempotencyKey, mode: 'enforce', source: 'api', ttlSeconds: ttlOf(c.body.ttlSeconds) });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/usage/reservations/:id/commit',
      auth: 'api',
      scope: 'usage:write',
      summary: 'Commit a reservation with the actual quantity used (defaults to the reserved amount)',
      tags: ['Usage'],
      params: z.object({ id: z.string() }),
      body: z.object({ quantity: z.number().min(0).optional() }),
      handler: (c) => commitReservation(app.db, app, c.params.id, c.body.quantity, c.orgScope()),
    });

    r.route({
      method: 'POST',
      url: '/api/v1/usage/reservations/:id/release',
      auth: 'api',
      scope: 'usage:write',
      summary: 'Release a reservation without using it',
      tags: ['Usage'],
      params: z.object({ id: z.string() }),
      handler: (c) => releaseReservation(app.db, app, c.params.id, c.orgScope()),
    });

    r.route({
      method: 'PUT',
      url: '/api/v1/usage/gauges/:meter',
      auth: 'api',
      scope: 'usage:write',
      summary: 'Set a gauge meter (e.g. projects, seats, storage) to its current level, enforcing the limit',
      tags: ['Usage'],
      params: z.object({ meter: z.string() }),
      body: z.object({ ...subjectFields, value: z.number().int().min(0) }).refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
      handler: async (c) => {
        const subject = await subjectFor(app.db, c.body, c.orgScope());
        return setGauge(app.db, app, { subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, meterKey: c.params.meter, value: c.body.value, source: 'api' });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/v1/usage',
      auth: 'api',
      scope: 'usage:read',
      summary: 'Current usage, limits and forecasts for every meter',
      tags: ['Usage'],
      query: z.object(subjectFields).refine((q) => q.userId || q.orgId, 'userId or orgId is required'),
      handler: async (c) => ({ data: await usageSummary(app.db, app, await subjectFor(app.db, c.query, c.orgScope())) }),
    });

    r.route({
      method: 'GET',
      url: '/api/v1/credits',
      auth: 'api',
      scope: 'credits:read',
      summary: 'Credit balances',
      tags: ['Credits'],
      query: z.object(subjectFields).refine((q) => q.userId || q.orgId, 'userId or orgId is required'),
      handler: async (c) => ({ data: await creditsFor(app.db, await subjectFor(app.db, c.query, c.orgScope())) }),
    });

    const creditBody = z
      .object({ ...subjectFields, creditType: z.string().min(1).max(50).default('credits'), amount: z.number().int().min(1), reason: z.string().max(500).optional(), idempotencyKey: z.string().max(200).optional() })
      .refine((b) => b.userId || b.orgId, 'userId or orgId is required');

    r.route({
      method: 'POST',
      url: '/api/v1/credits/grant',
      auth: 'api',
      scope: 'credits:write',
      summary: 'Add credits',
      tags: ['Credits'],
      body: creditBody.and(z.object({ expiresAt: z.coerce.date().optional() })),
      handler: async (c) => {
        const subject = await subjectFor(app.db, c.body, c.orgScope());
        return app.db.tx((tx) => grantCredits(tx, app, { subject, creditType: c.body.creditType, amount: c.body.amount, source: 'promotion', reason: c.body.reason, expiresAt: c.body.expiresAt, idempotencyKey: c.body.idempotencyKey, actorId: c.apiKey().keyId }));
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/credits/consume',
      auth: 'api',
      scope: 'credits:write',
      summary: 'Spend credits atomically (fails without spending if the balance is too low)',
      tags: ['Credits'],
      body: creditBody,
      handler: async (c) => {
        const subject = await subjectFor(app.db, c.body, c.orgScope());
        const result = await app.db.tx((tx) => debitCredits(tx, app, { subject, creditType: c.body.creditType, amount: c.body.amount, source: 'usage', reason: c.body.reason, idempotencyKey: c.body.idempotencyKey, actorId: c.apiKey().keyId }));
        return { allowed: result.ok, ...result, reason: result.ok ? null : 'insufficient_credits' };
      },
    });

    // ---- Client API -----------------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/client/usage',
      auth: 'client',
      summary: "The signed-in customer's usage and limits",
      tags: ['Client'],
      handler: async (c) => ({ data: await usageSummary(app.db, app, subjectFromPrincipal(c.customer())) }),
    });

    r.route({
      method: 'GET',
      url: '/api/client/credits',
      auth: 'client',
      summary: "The signed-in customer's credit balances",
      tags: ['Client'],
      handler: async (c) => ({ data: await creditsFor(app.db, subjectFromPrincipal(c.customer())) }),
    });

    // ---- Admin -----------------------------------------------------------------------
    const adminSubject = z.object(subjectFields).refine((q) => q.userId || q.orgId, 'userId or orgId is required');

    r.route({
      method: 'GET',
      url: '/api/admin/usage',
      auth: 'admin',
      permission: 'usage.meters.view',
      summary: 'Usage, limits, forecasts and credits for a user or organization',
      tags: ['Usage'],
      query: adminSubject,
      handler: async (c) => {
        const subject = await subjectFor(app.db, { userId: c.query.orgId ? null : c.query.userId, orgId: c.query.orgId }, c.orgScope());
        return { subject, meters: await usageSummary(app.db, app, subject), credits: await creditsFor(app.db, subject) };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/usage/events',
      auth: 'admin',
      permission: 'usage.meters.view',
      summary: 'Raw usage events',
      tags: ['Usage'],
      query: z.object({ ...pageQuery, ...subjectFields, meter: z.string().optional() }),
      handler: async (c) => {
        const scope = c.orgScope();
        return paginate(app.db, {
          select: sql`*`,
          from: sql`usage_events`,
          where: sql.where([
            c.query.orgId && sql`subject_type = 'organization' AND subject_id = ${c.query.orgId}`,
            !c.query.orgId && c.query.userId && sql`user_id = ${c.query.userId}`,
            c.query.meter && sql`meter_key = ${c.query.meter}`,
            scope && sql`(org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = usage_events.user_id AND m.org_id IN ${sql.in(scope)}))`,
          ]),
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/usage/overview',
      auth: 'admin',
      permission: 'usage.meters.view',
      summary: 'Consumption per meter per day and top consumers',
      tags: ['Usage'],
      query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30), meter: z.string().optional() }),
      handler: async (c) => {
        const since = new Date(app.clock.now().getTime() - c.query.days * DAY);
        const meterFilter = c.query.meter ? sql`AND meter_key = ${c.query.meter}` : sql.empty;
        const [daily, totals, top, denied] = await Promise.all([
          app.db.many(sql`
            SELECT date_trunc('day', created_at) AS day, meter_key, sum(quantity)::bigint AS quantity FROM usage_events
            WHERE created_at >= ${since} ${meterFilter} GROUP BY 1, 2 ORDER BY 1
          `),
          app.db.many(sql`SELECT meter_key, sum(quantity)::bigint AS quantity, count(DISTINCT subject_id)::int AS subjects FROM usage_events WHERE created_at >= ${since} ${meterFilter} GROUP BY 1 ORDER BY 2 DESC`),
          app.db.many(sql`
            SELECT e.subject_type, e.subject_id, e.meter_key, sum(e.quantity)::bigint AS quantity,
                   coalesce(u.email, o.name) AS label
            FROM usage_events e LEFT JOIN users u ON e.subject_type = 'user' AND u.id = e.subject_id
            LEFT JOIN organizations o ON e.subject_type = 'organization' AND o.id = e.subject_id
            WHERE e.created_at >= ${since} ${meterFilter} GROUP BY 1, 2, 3, 5 ORDER BY 4 DESC LIMIT 20
          `),
          app.db.one(sql`SELECT count(*)::int AS at_limit FROM usage_counters WHERE limit_reached_at >= ${since} ${meterFilter}`),
        ]);
        return { since, daily, totals, top, atLimit: (denied as any).at_limit };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/usage/adjust',
      auth: 'admin',
      permission: 'usage.adjust.manage',
      summary: 'Manually correct usage (positive or negative), with a reason',
      tags: ['Usage'],
      body: z.object({ ...subjectFields, meter: z.string(), quantity: z.number().int().refine((n) => n !== 0), reason: z.string().trim().min(3).max(500) }).refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
      handler: async (c) => {
        const subject = await subjectFor(app.db, { userId: c.body.orgId ? null : c.body.userId, orgId: c.body.orgId }, c.orgScope());
        return app.db.tx(async (tx) => {
          const result = await recordUsage(tx, app, { subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, meterKey: c.body.meter, quantity: c.body.quantity, mode: 'record', source: 'admin', actorId: c.admin().adminId, reason: c.body.reason });
          await c.audit(tx, 'usage.adjust', { type: subject.type, id: subject.id }, { meter: c.body.meter, quantity: c.body.quantity, reason: c.body.reason });
          return result;
        });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/usage/reset',
      auth: 'admin',
      permission: 'usage.adjust.manage',
      summary: "Reset a meter's usage for the current period",
      tags: ['Usage'],
      body: z.object({ ...subjectFields, meter: z.string(), reason: z.string().trim().min(3).max(500) }).refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
      handler: async (c) => {
        const subject = await subjectFor(app.db, { userId: c.body.orgId ? null : c.body.userId, orgId: c.body.orgId }, c.orgScope());
        const current = (await usageSummary(app.db, app, subject)).find((m) => m.meter === c.body.meter);
        if (!current) throw notFound('Meter');
        if (current.used === 0) return { ok: true, used: 0 };
        return app.db.tx(async (tx) => {
          const result = await recordUsage(tx, app, { subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, meterKey: c.body.meter, quantity: -current.used, mode: 'record', source: 'admin', actorId: c.admin().adminId, reason: `reset: ${c.body.reason}` });
          await tx.exec(sql`UPDATE usage_counters SET warned_at = NULL, limit_reached_at = NULL, overage = 0 WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND meter_key = ${c.body.meter} AND period_start = ${current.periodStart}`);
          await c.audit(tx, 'usage.reset', { type: subject.type, id: subject.id }, { meter: c.body.meter, previous: current.used, reason: c.body.reason });
          return result;
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/credits',
      auth: 'admin',
      permission: 'usage.credits.view',
      summary: 'Credit balances and ledger',
      tags: ['Credits'],
      query: z.object({ ...subjectFields, ...pageQuery }).refine((q) => q.userId || q.orgId, 'userId or orgId is required'),
      handler: async (c) => {
        const subject = await subjectFor(app.db, { userId: c.query.orgId ? null : c.query.userId, orgId: c.query.orgId }, c.orgScope());
        const ledger = await paginate(app.db, {
          select: sql`*`,
          from: sql`credit_ledger`,
          where: sql`WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}`,
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
        return { balances: await creditsFor(app.db, subject), ledger };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/credits/:action',
      auth: 'admin',
      permission: 'usage.credits.manage',
      summary: 'Grant complimentary credits or deduct credits',
      tags: ['Credits'],
      params: z.object({ action: z.enum(['grant', 'deduct']) }),
      body: z
        .object({ ...subjectFields, creditType: z.string().min(1).max(50).default('credits'), amount: z.number().int().min(1).max(1_000_000_000), reason: z.string().trim().min(3).max(500), expiresAt: z.coerce.date().optional() })
        .refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
      handler: async (c) => {
        const subject = await subjectFor(app.db, { userId: c.body.orgId ? null : c.body.userId, orgId: c.body.orgId }, c.orgScope());
        return app.db.tx(async (tx) => {
          const result =
            c.params.action === 'grant'
              ? await grantCredits(tx, app, { subject, creditType: c.body.creditType, amount: c.body.amount, source: 'admin', reason: c.body.reason, expiresAt: c.body.expiresAt, actorId: c.admin().adminId })
              : await debitCredits(tx, app, { subject, creditType: c.body.creditType, amount: c.body.amount, source: 'admin', reason: c.body.reason, actorId: c.admin().adminId, allowPartial: true });
          await c.audit(tx, `credits.${c.params.action}`, { type: subject.type, id: subject.id }, { creditType: c.body.creditType, amount: c.body.amount, reason: c.body.reason });
          return { ...result, balance: await creditBalance(tx, subject, c.body.creditType) };
        });
      },
    });
  },
};
