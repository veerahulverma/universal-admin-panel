import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';

/**
 * Metric definitions, kept in one place so the dashboard, reports and exports
 * reconcile with each other:
 *
 *  MRR      Σ over subscriptions that are paying at time T (active or past_due,
 *           not trialing, not complimentary) of price × quantity normalized to
 *           one month (yearly / 12, weekly × 52/12 ...), using the introductory
 *           price while intro cycles remain, converted to the base currency.
 *  ARR      MRR × 12.
 *  Revenue  Σ succeeded payments in the range minus refunds processed in the
 *           range, converted to the base currency (cash basis).
 *  Churn    subscriptions that ended in the range / subscriptions active at the
 *           start of the range.
 *  Active   users whose last_active_at falls in the range.
 */

export interface Range {
  from: Date;
  to: Date;
}

export function baseCurrency(app: App): string {
  const billing = app.settings.definitions().find((d) => d.key === 'billing');
  return billing ? app.settings.get<{ baseCurrency: string }>('billing').baseCurrency : app.settings.get('general').defaultCurrency;
}

export function has(app: App, moduleId: string): boolean {
  return Boolean(app.modules.get(moduleId)) && app.modules.isEnabled(moduleId);
}

/** SQL expression converting `amount` in `currency` to the base currency via exchange_rates (falls back to 1:1). */
function converted(amountCol: string, currencyCol: string, base: string) {
  return sql`(${sql.raw(amountCol)} * CASE WHEN ${sql.raw(currencyCol)} = ${base} THEN 1
    ELSE coalesce((SELECT rate FROM exchange_rates WHERE base = ${sql.raw(currencyCol)} AND quote = ${base}),
                  1 / NULLIF((SELECT rate FROM exchange_rates WHERE base = ${base} AND quote = ${sql.raw(currencyCol)}), 0), 1) END)`;
}

const MONTHLY_FACTOR = sql`(CASE pr.interval WHEN 'day' THEN 365.0 / 12 WHEN 'week' THEN 52.0 / 12 WHEN 'month' THEN 1.0 ELSE 1.0 / 12 END / pr.interval_count)`;

export async function mrrAt(app: App, db: Db, at: Date): Promise<number> {
  if (!has(app, 'billing')) return 0;
  const base = baseCurrency(app);
  const row = await db.one<{ mrr: number | null }>(sql`
    SELECT sum(
      ${converted(
        `(CASE WHEN s.intro_cycles_remaining > 0 AND pr.intro_amount IS NOT NULL THEN pr.intro_amount ELSE pr.unit_amount END) * (CASE WHEN pr.pricing_model = 'per_seat' THEN s.quantity ELSE 1 END)`,
        's.currency',
        base,
      )} * ${MONTHLY_FACTOR}
    ) AS mrr
    FROM subscriptions s JOIN prices pr ON pr.id = s.price_id
    WHERE s.collection_method <> 'complimentary' AND pr.pricing_model IN ('flat', 'per_seat')
      AND s.created_at <= ${at} AND (s.ended_at IS NULL OR s.ended_at > ${at})
      AND (s.trial_end IS NULL OR s.trial_end <= ${at})
      AND (s.status IN ('active', 'past_due') OR (s.status IN ('canceled', 'unpaid') AND s.ended_at > ${at}))
  `);
  return Math.round(row.mrr ?? 0);
}

export async function revenueBetween(app: App, db: Db, r: Range): Promise<{ gross: number; refunds: number; net: number }> {
  if (!has(app, 'billing')) return { gross: 0, refunds: 0, net: 0 };
  const base = baseCurrency(app);
  const gross = await db.one<{ v: number | null }>(sql`
    SELECT sum(${converted('amount', 'currency', base)}) AS v FROM payments
    WHERE status IN ('succeeded', 'refunded', 'partially_refunded', 'disputed') AND succeeded_at >= ${r.from} AND succeeded_at < ${r.to}
  `);
  const refunds = await db.one<{ v: number | null }>(sql`
    SELECT sum(${converted('amount', 'currency', base)}) AS v FROM refunds WHERE status = 'succeeded' AND processed_at >= ${r.from} AND processed_at < ${r.to}
  `);
  const g = Math.round(gross.v ?? 0);
  const f = Math.round(refunds.v ?? 0);
  return { gross: g, refunds: f, net: g - f };
}

export function previousRange(r: Range): Range {
  const span = r.to.getTime() - r.from.getTime();
  return { from: new Date(r.from.getTime() - span), to: r.from };
}

export function rangeFromDays(now: Date, days: number): Range {
  const to = new Date(now.getTime());
  return { from: new Date(to.getTime() - days * DAY), to };
}

export interface Kpi {
  key: string;
  label: string;
  value: number;
  previous: number | null;
  format: 'number' | 'money' | 'percent';
  module: string;
}

async function count(db: Db, q: ReturnType<typeof sql>): Promise<number> {
  return (await db.one<{ n: number }>(q)).n;
}

export async function dashboardKpis(app: App, db: Db, r: Range): Promise<Kpi[]> {
  const p = previousRange(r);
  const kpis: Kpi[] = [];
  const push = (k: Omit<Kpi, 'module'> & { module?: string }) => kpis.push({ module: 'reports', ...k });

  push({ key: 'total_users', label: 'Total users', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL AND created_at < ${r.to}`), previous: await count(db, sql`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL AND created_at < ${p.to}`) });
  push({ key: 'active_users', label: 'Active users', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL AND last_active_at >= ${r.from} AND last_active_at < ${r.to}`), previous: null });
  push({ key: 'new_users', label: 'New registrations', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM users WHERE created_at >= ${r.from} AND created_at < ${r.to}`), previous: await count(db, sql`SELECT count(*)::int AS n FROM users WHERE created_at >= ${p.from} AND created_at < ${p.to}`) });
  push({ key: 'suspended_users', label: 'Suspended / banned', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL AND status IN ('suspended', 'banned')`), previous: null });

  if (has(app, 'billing')) {
    const mrr = await mrrAt(app, db, r.to);
    const mrrPrev = await mrrAt(app, db, r.from);
    const rev = await revenueBetween(app, db, r);
    const revPrev = await revenueBetween(app, db, p);
    push({ key: 'mrr', label: 'MRR', format: 'money', value: mrr, previous: mrrPrev, module: 'billing' });
    push({ key: 'arr', label: 'ARR', format: 'money', value: mrr * 12, previous: mrrPrev * 12, module: 'billing' });
    push({ key: 'revenue', label: 'Net revenue', format: 'money', value: rev.net, previous: revPrev.net, module: 'billing' });
    push({ key: 'refunds', label: 'Refunds', format: 'money', value: rev.refunds, previous: revPrev.refunds, module: 'billing' });
    push({ key: 'active_subscriptions', label: 'Active subscriptions', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE status IN ('active', 'past_due')`), previous: null, module: 'billing' });
    push({ key: 'trialing', label: 'Trials', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'trialing'`), previous: null, module: 'billing' });
    push({ key: 'new_subscriptions', label: 'New subscriptions', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE created_at >= ${r.from} AND created_at < ${r.to}`), previous: await count(db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE created_at >= ${p.from} AND created_at < ${p.to}`), module: 'billing' });
    push({ key: 'cancellations', label: 'Cancellations', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE ended_at >= ${r.from} AND ended_at < ${r.to}`), previous: await count(db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE ended_at >= ${p.from} AND ended_at < ${p.to}`), module: 'billing' });
    push({ key: 'renewals', label: 'Renewals', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM events WHERE type = 'subscription.renewed' AND created_at >= ${r.from} AND created_at < ${r.to}`), previous: null, module: 'billing' });
    push({ key: 'failed_payments', label: 'Failed payments', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM payments WHERE status = 'failed' AND created_at >= ${r.from} AND created_at < ${r.to}`), previous: await count(db, sql`SELECT count(*)::int AS n FROM payments WHERE status = 'failed' AND created_at >= ${p.from} AND created_at < ${p.to}`), module: 'billing' });
    push({ key: 'new_orders', label: 'New purchases', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM orders WHERE status <> 'pending' AND created_at >= ${r.from} AND created_at < ${r.to}`), previous: null, module: 'billing' });
    push({ key: 'chargebacks', label: 'Chargebacks', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM disputes WHERE created_at >= ${r.from} AND created_at < ${r.to}`), previous: null, module: 'billing' });
    const base = baseCurrency(app);
    const open = await db.one<{ v: number | null }>(sql`SELECT sum(${converted('(amount_due - amount_paid)', 'currency', base)}) AS v FROM invoices WHERE status = 'open'`);
    push({ key: 'outstanding_invoices', label: 'Outstanding invoices', format: 'money', value: Math.round(open.v ?? 0), previous: null, module: 'billing' });
  }
  if (has(app, 'usage')) {
    push({ key: 'limit_hits', label: 'Quota limits reached', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM usage_counters WHERE limit_reached_at >= ${r.from} AND limit_reached_at < ${r.to}`), previous: null, module: 'usage' });
    // Meters have different units, so consumption is reported as recorded usage events (per-meter totals live in Catalog -> Usage).
    const usageEvents = (range: Range) => count(db, sql`SELECT count(*)::int AS n FROM usage_events WHERE created_at >= ${range.from} AND created_at < ${range.to}`);
    push({ key: 'usage_events', label: 'Usage events recorded', format: 'number', value: await usageEvents(r), previous: await usageEvents(p), module: 'usage' });
  }
  if (has(app, 'affiliates')) {
    const base = baseCurrency(app);
    const sum = async (q: ReturnType<typeof sql>) => Math.round((await db.one<{ v: number | null }>(q)).v ?? 0);
    // Revenue the program brought in: the commission base of sale commissions that still stand.
    const referred = (range: Range) => sum(sql`SELECT sum(${converted('base_amount', 'currency', base)}) AS v FROM affiliate_commissions WHERE kind = 'sale' AND status NOT IN ('rejected', 'reversed') AND created_at >= ${range.from} AND created_at < ${range.to}`);
    const earned = (range: Range) => sum(sql`SELECT sum(${converted('(amount - reversed_amount)', 'currency', base)}) AS v FROM affiliate_commissions WHERE status <> 'rejected' AND created_at >= ${range.from} AND created_at < ${range.to}`);
    push({ key: 'affiliate_revenue', label: 'Affiliate-referred revenue', format: 'money', value: await referred(r), previous: await referred(p), module: 'affiliates' });
    push({ key: 'affiliate_commissions', label: 'Affiliate commissions', format: 'money', value: await earned(r), previous: await earned(p), module: 'affiliates' });
    push({ key: 'affiliate_pending_payouts', label: 'Commissions awaiting payout', format: 'money', value: await sum(sql`SELECT sum(${converted('(amount - reversed_amount)', 'currency', base)}) AS v FROM affiliate_commissions WHERE status = 'approved'`), previous: null, module: 'affiliates' });
  }
  push({ key: 'api_requests', label: 'API requests', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM api_requests WHERE created_at >= ${r.from} AND created_at < ${r.to}`), previous: await count(db, sql`SELECT count(*)::int AS n FROM api_requests WHERE created_at >= ${p.from} AND created_at < ${p.to}`), module: 'developers' });
  push({ key: 'rate_limited', label: 'Rate-limit violations', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM api_requests WHERE status = 429 AND created_at >= ${r.from} AND created_at < ${r.to}`), previous: null, module: 'developers' });
  push({ key: 'open_security_events', label: 'Open security alerts', format: 'number', value: await count(db, sql`SELECT count(*)::int AS n FROM security_events WHERE status = 'open' AND severity <> 'info'`), previous: null, module: 'security' });
  return app.hooks.apply<Kpi[]>('reports.dashboard.kpis', kpis, { app, db, range: r, previous: p });
}

export interface Point {
  date: string;
  value: number;
}

function fillDays(r: Range, rows: { day: Date | string; value: number }[]): Point[] {
  const byDay = new Map(rows.map((x) => [new Date(x.day).toISOString().slice(0, 10), Number(x.value)]));
  const out: Point[] = [];
  const start = new Date(Date.UTC(r.from.getUTCFullYear(), r.from.getUTCMonth(), r.from.getUTCDate()));
  for (let d = start; d < r.to; d = new Date(d.getTime() + DAY)) {
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: byDay.get(key) ?? 0 });
  }
  return out;
}

/** Levels such as MRR: a day without a snapshot repeats the previous value; days before the first known value are left out. */
function carryForward(r: Range, rows: { day: Date | string; value: number }[], initial: number | null): Point[] {
  const byDay = new Map(rows.map((x) => [new Date(x.day).toISOString().slice(0, 10), Number(x.value)]));
  const out: Point[] = [];
  let last = initial;
  const start = new Date(Date.UTC(r.from.getUTCFullYear(), r.from.getUTCMonth(), r.from.getUTCDate()));
  for (let d = start; d < r.to; d = new Date(d.getTime() + DAY)) {
    const key = d.toISOString().slice(0, 10);
    if (byDay.has(key)) last = byDay.get(key)!;
    if (last !== null) out.push({ date: key, value: last });
  }
  return out;
}

export async function dailySeries(app: App, db: Db, r: Range): Promise<Record<string, Point[]>> {
  const signups = await db.many<{ day: Date; value: number }>(sql`
    SELECT date_trunc('day', created_at) AS day, count(*)::int AS value FROM users WHERE created_at >= ${r.from} AND created_at < ${r.to} GROUP BY 1
  `);
  const out: Record<string, Point[]> = { signups: fillDays(r, signups) };
  if (has(app, 'billing')) {
    const base = baseCurrency(app);
    const revenue = await db.many<{ day: Date; value: number }>(sql`
      SELECT day, sum(v)::bigint AS value FROM (
        SELECT date_trunc('day', succeeded_at) AS day, ${converted('amount', 'currency', base)} AS v FROM payments
          WHERE status IN ('succeeded', 'refunded', 'partially_refunded', 'disputed') AND succeeded_at >= ${r.from} AND succeeded_at < ${r.to}
        UNION ALL
        SELECT date_trunc('day', processed_at), -${converted('amount', 'currency', base)} FROM refunds WHERE status = 'succeeded' AND processed_at >= ${r.from} AND processed_at < ${r.to}
      ) x GROUP BY day
    `);
    out.revenue = fillDays(r, revenue);
    const snapshots = await db.many<{ day: Date; value: number }>(sql`SELECT day::timestamptz AS day, mrr AS value FROM metrics_daily WHERE day >= ${r.from} AND day < ${r.to}`);
    const before = await db.maybe<{ value: number }>(sql`SELECT mrr AS value FROM metrics_daily WHERE day < ${r.from} ORDER BY day DESC LIMIT 1`);
    out.mrr = carryForward(r, snapshots, before ? Number(before.value) : null);
  } else {
    out.revenue = fillDays(r, []);
  }
  return out;
}

/** Store today's headline numbers so trends (MRR history) do not depend on reconstructing the past. */
export async function snapshotMetrics(app: App, at: Date): Promise<void> {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const mrr = await mrrAt(app, app.db, at);
  const users = await count(app.db, sql`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`);
  const subs = has(app, 'billing') ? await count(app.db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE status IN ('active', 'past_due')`) : 0;
  const trials = has(app, 'billing') ? await count(app.db, sql`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'trialing'`) : 0;
  await app.db.exec(sql`
    INSERT INTO metrics_daily (day, currency, mrr, users_total, active_subscriptions, trialing, captured_at)
    VALUES (${day.toISOString().slice(0, 10)}, ${baseCurrency(app)}, ${mrr}, ${users}, ${subs}, ${trials}, ${at})
    ON CONFLICT (day) DO UPDATE SET mrr = EXCLUDED.mrr, users_total = EXCLUDED.users_total, active_subscriptions = EXCLUDED.active_subscriptions,
      trialing = EXCLUDED.trialing, currency = EXCLUDED.currency, captured_at = EXCLUDED.captured_at
  `);
}
