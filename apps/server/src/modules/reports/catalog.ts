import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { qDate } from '../../core/validation.js';
import { DAY } from '../../core/clock.js';
import { baseCurrency, has, mrrAt } from './metrics.js';

export interface ReportColumn {
  key: string;
  label: string;
  format?: 'number' | 'money' | 'percent' | 'date' | 'text';
}

export interface ReportResult {
  columns: ReportColumn[];
  /** A row may carry its own `format` for columns that mix units (metric/value tables). */
  rows: Record<string, unknown>[];
  chart?: { type: 'line' | 'bar'; x: string; series: string[] };
  currency?: string;
  notes?: string;
}

export const reportParams = z.object({
  from: qDate.optional(),
  to: qDate.optional(),
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
  meter: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type ReportParams = z.infer<typeof reportParams> & { from: Date; to: Date };

export interface ReportDef {
  key: string;
  name: string;
  description: string;
  module: string;
  category: 'revenue' | 'customers' | 'usage' | 'developers' | 'growth' | 'support';
  run(app: App, db: Db, p: ReportParams): Promise<ReportResult>;
}

const bucket = (groupBy: string, col: string) => sql`date_trunc(${groupBy}, ${sql.raw(col)})`;

const conv = (amount: string, currency: string, base: string) => sql`(${sql.raw(amount)} * CASE WHEN ${sql.raw(currency)} = ${base} THEN 1
  ELSE coalesce((SELECT rate FROM exchange_rates WHERE base = ${sql.raw(currency)} AND quote = ${base}), 1 / NULLIF((SELECT rate FROM exchange_rates WHERE base = ${base} AND quote = ${sql.raw(currency)}), 0), 1) END)`;

export const builtinReports: ReportDef[] = [
  {
    key: 'revenue',
    name: 'Revenue',
    description: 'Gross payments, refunds and net revenue per period (cash basis, base currency).',
    module: 'billing',
    category: 'revenue',
    async run(app, db, p) {
      const base = baseCurrency(app);
      const rows = await db.many(sql`
        SELECT period, sum(gross)::bigint AS gross, sum(refunds)::bigint AS refunds, sum(gross - refunds)::bigint AS net, sum(payments)::int AS payments FROM (
          SELECT ${bucket(p.groupBy, 'succeeded_at')} AS period, ${conv('amount', 'currency', base)} AS gross, 0 AS refunds, 1 AS payments
            FROM payments WHERE status IN ('succeeded', 'refunded', 'partially_refunded', 'disputed') AND succeeded_at >= ${p.from} AND succeeded_at < ${p.to}
          UNION ALL
          SELECT ${bucket(p.groupBy, 'processed_at')}, 0, ${conv('amount', 'currency', base)}, 0
            FROM refunds WHERE status = 'succeeded' AND processed_at >= ${p.from} AND processed_at < ${p.to}
        ) x GROUP BY period ORDER BY period
      `);
      return {
        currency: base,
        columns: [{ key: 'period', label: 'Period', format: 'date' }, { key: 'payments', label: 'Payments', format: 'number' }, { key: 'gross', label: 'Gross', format: 'money' }, { key: 'refunds', label: 'Refunds', format: 'money' }, { key: 'net', label: 'Net', format: 'money' }],
        rows,
        chart: { type: 'bar', x: 'period', series: ['net'] },
      };
    },
  },
  {
    key: 'revenue_by_product',
    name: 'Revenue by product',
    description: 'Paid invoice line revenue per product in the range.',
    module: 'billing',
    category: 'revenue',
    async run(app, db, p) {
      const base = baseCurrency(app);
      const rows = await db.many(sql`
        SELECT coalesce(pr.name, 'Other') AS product, count(DISTINCT i.id)::int AS invoices, sum(${conv('(l.amount - l.discount_amount)', 'i.currency', base)})::bigint AS revenue
        FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN products pr ON pr.id = l.product_id
        WHERE i.status = 'paid' AND i.paid_at >= ${p.from} AND i.paid_at < ${p.to}
        GROUP BY 1 ORDER BY 3 DESC
      `);
      return { currency: base, columns: [{ key: 'product', label: 'Product' }, { key: 'invoices', label: 'Invoices', format: 'number' }, { key: 'revenue', label: 'Revenue', format: 'money' }], rows, chart: { type: 'bar', x: 'product', series: ['revenue'] } };
    },
  },
  {
    key: 'mrr_by_plan',
    name: 'MRR by plan',
    description: 'Current monthly recurring revenue and paying subscriptions per plan.',
    module: 'billing',
    category: 'revenue',
    async run(app, db) {
      const base = baseCurrency(app);
      const rows = await db.many(sql`
        SELECT p.name AS plan, count(*)::int AS subscriptions,
          round(sum(${conv(`(CASE WHEN s.intro_cycles_remaining > 0 AND pr.intro_amount IS NOT NULL THEN pr.intro_amount ELSE pr.unit_amount END) * (CASE WHEN pr.pricing_model = 'per_seat' THEN s.quantity ELSE 1 END)`, 's.currency', base)}
            * (CASE pr.interval WHEN 'day' THEN 365.0 / 12 WHEN 'week' THEN 52.0 / 12 WHEN 'month' THEN 1.0 ELSE 1.0 / 12 END / pr.interval_count)))::bigint AS mrr
        FROM subscriptions s JOIN prices pr ON pr.id = s.price_id JOIN products p ON p.id = s.product_id
        WHERE s.status IN ('active', 'past_due') AND s.collection_method <> 'complimentary' AND pr.pricing_model IN ('flat', 'per_seat')
        GROUP BY 1 ORDER BY 3 DESC
      `);
      return { currency: base, columns: [{ key: 'plan', label: 'Plan' }, { key: 'subscriptions', label: 'Subscriptions', format: 'number' }, { key: 'mrr', label: 'MRR', format: 'money' }], rows, chart: { type: 'bar', x: 'plan', series: ['mrr'] } };
    },
  },
  {
    key: 'subscriptions',
    name: 'Subscription growth',
    description: 'New, cancelled and net subscriptions per period.',
    module: 'billing',
    category: 'revenue',
    async run(_app, db, p) {
      const rows = await db.many(sql`
        SELECT period, sum(new)::int AS new, sum(canceled)::int AS canceled, sum(new - canceled)::int AS net FROM (
          SELECT ${bucket(p.groupBy, 'created_at')} AS period, 1 AS new, 0 AS canceled FROM subscriptions WHERE created_at >= ${p.from} AND created_at < ${p.to}
          UNION ALL
          SELECT ${bucket(p.groupBy, 'ended_at')}, 0, 1 FROM subscriptions WHERE ended_at >= ${p.from} AND ended_at < ${p.to}
        ) x GROUP BY period ORDER BY period
      `);
      return { columns: [{ key: 'period', label: 'Period', format: 'date' }, { key: 'new', label: 'New', format: 'number' }, { key: 'canceled', label: 'Cancelled', format: 'number' }, { key: 'net', label: 'Net', format: 'number' }], rows, chart: { type: 'line', x: 'period', series: ['new', 'canceled'] } };
    },
  },
  {
    key: 'churn',
    name: 'Churn rate',
    description: 'Share of subscriptions active at the start of each period that ended during it.',
    module: 'billing',
    category: 'revenue',
    async run(_app, db, p) {
      const periods = await db.many<{ period: Date }>(sql`SELECT generate_series(date_trunc(${p.groupBy}, ${p.from}::timestamptz), ${p.to}::timestamptz, ('1 ' || ${p.groupBy})::interval) AS period`);
      const rows = [];
      for (const { period } of periods) {
        const end = await db.one<{ e: Date }>(sql`SELECT (${period}::timestamptz + ('1 ' || ${p.groupBy})::interval) AS e`);
        const start = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM subscriptions WHERE created_at < ${period} AND (ended_at IS NULL OR ended_at >= ${period}) AND (trial_end IS NULL OR trial_end <= ${period})`);
        const churned = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM subscriptions WHERE created_at < ${period} AND ended_at >= ${period} AND ended_at < ${end.e}`);
        rows.push({ period, active_at_start: start.n, churned: churned.n, churn_rate: start.n ? churned.n / start.n : 0 });
      }
      return { columns: [{ key: 'period', label: 'Period', format: 'date' }, { key: 'active_at_start', label: 'Active at start', format: 'number' }, { key: 'churned', label: 'Churned', format: 'number' }, { key: 'churn_rate', label: 'Churn rate', format: 'percent' }], rows, chart: { type: 'line', x: 'period', series: ['churn_rate'] } };
    },
  },
  {
    key: 'ltv',
    name: 'Customer lifetime value',
    description: 'Average revenue per paying customer, monthly churn and estimated LTV (ARPU ÷ churn) for the range.',
    module: 'billing',
    category: 'revenue',
    async run(app, db, p) {
      const base = baseCurrency(app);
      const months = Math.max(1, (p.to.getTime() - p.from.getTime()) / (30 * DAY));
      const mrr = await mrrAt(app, db, p.to);
      const paying = await db.one<{ n: number }>(sql`SELECT count(DISTINCT subject_id)::int AS n FROM subscriptions WHERE status IN ('active', 'past_due') AND collection_method <> 'complimentary'`);
      const startActive = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM subscriptions WHERE created_at < ${p.from} AND (ended_at IS NULL OR ended_at >= ${p.from})`);
      const churned = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM subscriptions WHERE ended_at >= ${p.from} AND ended_at < ${p.to} AND created_at < ${p.from}`);
      const monthlyChurn = startActive.n ? churned.n / startActive.n / months : 0;
      const arpu = paying.n ? mrr / paying.n : 0;
      return {
        currency: base,
        columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }],
        rows: [
          { metric: 'Paying customers', value: paying.n, format: 'number' },
          { metric: 'ARPU (monthly)', value: Math.round(arpu), format: 'money' },
          { metric: 'Monthly churn', value: Number(monthlyChurn.toFixed(4)), format: 'percent' },
          { metric: 'Estimated LTV', value: monthlyChurn > 0 ? Math.round(arpu / monthlyChurn) : null, format: 'money' },
        ],
        notes: 'LTV is undefined (null) when no churn was observed in the range.',
      };
    },
  },
  {
    key: 'payment_recovery',
    name: 'Payment failures & recovery',
    description: 'Invoices that failed at least once, and how many were eventually paid.',
    module: 'billing',
    category: 'revenue',
    async run(_app, db, p) {
      const rows = await db.many(sql`
        SELECT ${bucket(p.groupBy, 'i.created_at')} AS period, count(*)::int AS failed_invoices,
          count(*) FILTER (WHERE i.status = 'paid')::int AS recovered,
          coalesce(round(100.0 * count(*) FILTER (WHERE i.status = 'paid') / NULLIF(count(*), 0), 1), 0) AS recovery_pct
        FROM invoices i WHERE i.created_at >= ${p.from} AND i.created_at < ${p.to}
          AND EXISTS (SELECT 1 FROM payments pa WHERE pa.invoice_id = i.id AND pa.status = 'failed')
        GROUP BY 1 ORDER BY 1
      `);
      return { columns: [{ key: 'period', label: 'Period', format: 'date' }, { key: 'failed_invoices', label: 'Failed invoices', format: 'number' }, { key: 'recovered', label: 'Recovered', format: 'number' }, { key: 'recovery_pct', label: 'Recovery %', format: 'number' }], rows };
    },
  },
  {
    key: 'subscription_retention',
    name: 'Subscription retention cohorts',
    description: 'Subscriptions grouped by start month, and the share still active 1, 2, 3 and 6 months later.',
    module: 'billing',
    category: 'customers',
    async run(app, db, p) {
      const rows = await db.many<any>(sql`
        SELECT date_trunc('month', created_at) AS cohort, count(*)::int AS size,
          ${sql.join([1, 2, 3, 6].map((m) => sql`count(*) FILTER (WHERE (ended_at IS NULL OR ended_at > created_at + ${`${m} months`}::interval) AND created_at + ${`${m} months`}::interval <= ${app.clock.now()})::int AS ${sql.raw(`m${m}`)}`))}
        FROM subscriptions WHERE created_at >= ${p.from} AND created_at < ${p.to} GROUP BY 1 ORDER BY 1
      `);
      return {
        columns: [{ key: 'cohort', label: 'Cohort', format: 'date' }, { key: 'size', label: 'Started', format: 'number' }, { key: 'm1', label: 'Month 1', format: 'number' }, { key: 'm2', label: 'Month 2', format: 'number' }, { key: 'm3', label: 'Month 3', format: 'number' }, { key: 'm6', label: 'Month 6', format: 'number' }],
        rows,
        notes: 'Months not yet elapsed for a cohort show 0.',
      };
    },
  },
  {
    key: 'signups',
    name: 'User acquisition',
    description: 'New registrations per period, with verified emails.',
    module: 'customers',
    category: 'customers',
    async run(_app, db, p) {
      const rows = await db.many(sql`
        SELECT ${bucket(p.groupBy, 'created_at')} AS period, count(*)::int AS signups, count(email_verified_at)::int AS verified
        FROM users WHERE created_at >= ${p.from} AND created_at < ${p.to} GROUP BY 1 ORDER BY 1
      `);
      return { columns: [{ key: 'period', label: 'Period', format: 'date' }, { key: 'signups', label: 'Signups', format: 'number' }, { key: 'verified', label: 'Verified', format: 'number' }], rows, chart: { type: 'line', x: 'period', series: ['signups'] } };
    },
  },
  {
    key: 'acquisition_sources',
    name: 'Signups by source',
    description: 'Registrations and paying conversions per registration source.',
    module: 'customers',
    category: 'growth',
    async run(app, db, p) {
      const paying = has(app, 'billing') ? sql`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM orders o WHERE o.subject_type = 'user' AND o.subject_id = u.id AND o.status IN ('paid', 'partially_refunded')))::int` : sql`0`;
      const rows = await db.many(sql`
        SELECT coalesce(u.registration_source, '(direct)') AS source, count(*)::int AS signups, ${paying} AS paying
        FROM users u WHERE u.created_at >= ${p.from} AND u.created_at < ${p.to} GROUP BY 1 ORDER BY 2 DESC
      `);
      return { columns: [{ key: 'source', label: 'Source' }, { key: 'signups', label: 'Signups', format: 'number' }, { key: 'paying', label: 'Paying', format: 'number' }], rows, chart: { type: 'bar', x: 'source', series: ['signups', 'paying'] } };
    },
  },
  {
    key: 'top_customers',
    name: 'Top customers',
    description: 'Customers ranked by lifetime revenue.',
    module: 'customers',
    category: 'customers',
    async run(app, db, p) {
      const rows = await db.many(sql`
        SELECT id, email, name, lifetime_revenue, created_at FROM users WHERE deleted_at IS NULL AND lifetime_revenue > 0 ORDER BY lifetime_revenue DESC LIMIT ${p.limit}
      `);
      return { currency: baseCurrency(app), columns: [{ key: 'email', label: 'Email' }, { key: 'name', label: 'Name' }, { key: 'lifetime_revenue', label: 'Lifetime revenue', format: 'money' }, { key: 'created_at', label: 'Customer since', format: 'date' }], rows };
    },
  },
  {
    key: 'usage',
    name: 'Usage consumption',
    description: 'Metered consumption per meter and period.',
    module: 'usage',
    category: 'usage',
    async run(_app, db, p) {
      const rows = await db.many(sql`
        SELECT ${bucket(p.groupBy, 'created_at')} AS period, meter_key AS meter, sum(quantity)::bigint AS quantity, count(DISTINCT subject_id)::int AS customers
        FROM usage_events WHERE created_at >= ${p.from} AND created_at < ${p.to} ${p.meter ? sql`AND meter_key = ${p.meter}` : sql.empty}
        GROUP BY 1, 2 ORDER BY 1, 2
      `);
      return { columns: [{ key: 'period', label: 'Period', format: 'date' }, { key: 'meter', label: 'Meter' }, { key: 'quantity', label: 'Quantity', format: 'number' }, { key: 'customers', label: 'Customers', format: 'number' }], rows };
    },
  },
  {
    key: 'api_usage',
    name: 'API usage & reliability',
    description: 'Requests, errors and latency of the integration API.',
    module: 'developers',
    category: 'developers',
    async run(_app, db, p) {
      const rows = await db.many(sql`
        SELECT ${bucket(p.groupBy, 'created_at')} AS period, count(*)::int AS requests, count(*) FILTER (WHERE status >= 500)::int AS server_errors,
          count(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS client_errors, count(*) FILTER (WHERE status = 429)::int AS rate_limited,
          coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms
        FROM api_requests WHERE created_at >= ${p.from} AND created_at < ${p.to} GROUP BY 1 ORDER BY 1
      `);
      return { columns: [{ key: 'period', label: 'Period', format: 'date' }, { key: 'requests', label: 'Requests', format: 'number' }, { key: 'server_errors', label: '5xx', format: 'number' }, { key: 'client_errors', label: '4xx', format: 'number' }, { key: 'rate_limited', label: '429', format: 'number' }, { key: 'p95_ms', label: 'p95 ms', format: 'number' }], rows, chart: { type: 'line', x: 'period', series: ['requests'] } };
    },
  },
  {
    key: 'trial_conversion',
    name: 'Trial conversion',
    description: 'Trials started per period and how many converted to paid, dropped, or are still running.',
    module: 'billing',
    category: 'customers',
    async run(app, db, p) {
      const now = app.clock.now();
      const rows = await db.many<Record<string, number | string>>(sql`
        SELECT ${bucket(p.groupBy, 'coalesce(trial_start, created_at)')} AS period, count(*)::int AS trials,
          count(*) FILTER (WHERE trial_end <= ${now} AND (status IN ('active', 'past_due', 'paused') OR ended_at > trial_end))::int AS converted,
          count(*) FILTER (WHERE trial_end <= ${now} AND status NOT IN ('active', 'past_due', 'paused') AND (ended_at IS NULL OR ended_at <= trial_end))::int AS dropped,
          count(*) FILTER (WHERE trial_end > ${now})::int AS in_trial
        FROM subscriptions
        WHERE trial_end IS NOT NULL AND coalesce(trial_start, created_at) >= ${p.from} AND coalesce(trial_start, created_at) < ${p.to}
        GROUP BY 1 ORDER BY 1
      `);
      return {
        columns: [
          { key: 'period', label: 'Trials started', format: 'date' },
          { key: 'trials', label: 'Trials', format: 'number' },
          { key: 'converted', label: 'Converted', format: 'number' },
          { key: 'dropped', label: 'Dropped', format: 'number' },
          { key: 'in_trial', label: 'Still in trial', format: 'number' },
          { key: 'conversion_rate', label: 'Conversion', format: 'percent' },
        ],
        // Conversion counts finished trials only, so running trials do not drag the rate down.
        rows: rows.map((r) => ({ ...r, conversion_rate: Number(r.converted) + Number(r.dropped) ? Number(r.converted) / (Number(r.converted) + Number(r.dropped)) : 0 })),
        chart: { type: 'bar', x: 'period', series: ['trials'] },
      };
    },
  },
  {
    key: 'affiliate_performance',
    name: 'Affiliate performance',
    description: 'Clicks, referrals, conversions, referred revenue and commissions per approved affiliate.',
    module: 'affiliates',
    category: 'growth',
    async run(app, db, p) {
      const base = baseCurrency(app);
      const inRange = (col: string) => sql`${sql.raw(col)} >= ${p.from} AND ${sql.raw(col)} < ${p.to}`;
      const rows = await db.many<Record<string, number | string>>(sql`
        SELECT a.name, a.code,
          (SELECT count(*)::int FROM affiliate_clicks c WHERE c.affiliate_id = a.id AND ${inRange('c.created_at')}) AS clicks,
          (SELECT count(*)::int FROM referrals r WHERE r.affiliate_id = a.id AND ${inRange('r.created_at')}) AS referrals,
          (SELECT count(*)::int FROM referrals r WHERE r.affiliate_id = a.id AND ${inRange('r.converted_at')}) AS conversions,
          (SELECT coalesce(sum(${conv('m.base_amount', 'm.currency', base)}), 0)::bigint FROM affiliate_commissions m
            WHERE m.affiliate_id = a.id AND m.kind = 'sale' AND m.status NOT IN ('rejected', 'reversed') AND ${inRange('m.created_at')}) AS revenue,
          (SELECT coalesce(sum(${conv('(m.amount - m.reversed_amount)', 'm.currency', base)}), 0)::bigint FROM affiliate_commissions m
            WHERE m.affiliate_id = a.id AND m.status <> 'rejected' AND ${inRange('m.created_at')}) AS commissions
        FROM affiliates a WHERE a.status = 'approved'
        ORDER BY revenue DESC, conversions DESC, a.name LIMIT ${p.limit}
      `);
      return {
        columns: [
          { key: 'name', label: 'Affiliate', format: 'text' },
          { key: 'code', label: 'Code', format: 'text' },
          { key: 'clicks', label: 'Clicks', format: 'number' },
          { key: 'referrals', label: 'Referrals', format: 'number' },
          { key: 'conversions', label: 'Conversions', format: 'number' },
          { key: 'conversion_rate', label: 'Click conversion', format: 'percent' },
          { key: 'revenue', label: 'Referred revenue', format: 'money' },
          { key: 'commissions', label: 'Commissions', format: 'money' },
        ],
        rows: rows.map((r) => ({ ...r, conversion_rate: Number(r.clicks) ? Number(r.conversions) / Number(r.clicks) : 0 })),
        chart: { type: 'bar', x: 'name', series: ['revenue'] },
        currency: base,
      };
    },
  },
  {
    key: 'email_delivery',
    name: 'Email delivery & engagement',
    description: 'Messages sent, delivered, opened, clicked, bounced and complained about per period.',
    module: 'email',
    category: 'growth',
    async run(_app, db, p) {
      const rows = await db.many<Record<string, number | string>>(sql`
        SELECT ${bucket(p.groupBy, 'created_at')} AS period, count(*)::int AS messages,
          count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
          count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
          count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
          count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked,
          count(*) FILTER (WHERE status = 'bounced' OR bounced_at IS NOT NULL)::int AS bounced,
          count(*) FILTER (WHERE status = 'complained')::int AS complained,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE status = 'suppressed')::int AS suppressed
        FROM email_messages WHERE created_at >= ${p.from} AND created_at < ${p.to} GROUP BY 1 ORDER BY 1
      `);
      const rate = (n: unknown, d: unknown) => (Number(d) ? Number(n) / Number(d) : 0);
      return {
        columns: [
          { key: 'period', label: 'Period', format: 'date' },
          { key: 'sent', label: 'Sent', format: 'number' },
          { key: 'delivered', label: 'Delivered', format: 'number' },
          { key: 'open_rate', label: 'Open rate', format: 'percent' },
          { key: 'click_rate', label: 'Click rate', format: 'percent' },
          { key: 'bounced', label: 'Bounced', format: 'number' },
          { key: 'complained', label: 'Complaints', format: 'number' },
          { key: 'failed', label: 'Failed', format: 'number' },
          { key: 'suppressed', label: 'Suppressed', format: 'number' },
        ],
        rows: rows.map((r) => ({ ...r, open_rate: rate(r.opened, r.sent), click_rate: rate(r.clicked, r.sent) })),
        chart: { type: 'line', x: 'period', series: ['sent'] },
        notes: 'Opens and clicks depend on provider tracking and on recipients loading images; treat them as estimates.',
      };
    },
  },
  {
    key: 'support_workload',
    name: 'Support workload & resolution',
    description: 'Tickets created and solved per period, median first response and resolution times, SLA breaches and CSAT.',
    module: 'support',
    category: 'support',
    async run(_app, db, p) {
      const rows = await db.many(sql`
        WITH created AS (
          SELECT ${bucket(p.groupBy, 'created_at')} AS period, count(*)::int AS created,
            count(*) FILTER (WHERE sla_breached_at IS NOT NULL)::int AS sla_breached,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_responded_at - created_at)) / 60) FILTER (WHERE first_responded_at IS NOT NULL) AS first_response_min
          FROM tickets WHERE created_at >= ${p.from} AND created_at < ${p.to} GROUP BY 1
        ), solved AS (
          SELECT ${bucket(p.groupBy, 'solved_at')} AS period, count(*)::int AS solved,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (solved_at - created_at)) / 3600) AS resolution_hours,
            avg(csat_rating) AS csat
          FROM tickets WHERE solved_at >= ${p.from} AND solved_at < ${p.to} GROUP BY 1
        )
        SELECT coalesce(c.period, s.period) AS period, coalesce(c.created, 0) AS created, coalesce(s.solved, 0) AS solved,
          round(c.first_response_min::numeric, 1)::float8 AS first_response_min, round(s.resolution_hours::numeric, 1)::float8 AS resolution_hours,
          coalesce(c.sla_breached, 0) AS sla_breached, round(s.csat::numeric, 2)::float8 AS csat
        FROM created c FULL OUTER JOIN solved s ON s.period = c.period ORDER BY 1
      `);
      return {
        columns: [
          { key: 'period', label: 'Period', format: 'date' },
          { key: 'created', label: 'Created', format: 'number' },
          { key: 'solved', label: 'Solved', format: 'number' },
          { key: 'first_response_min', label: 'Median first response (min)', format: 'number' },
          { key: 'resolution_hours', label: 'Median resolution (h)', format: 'number' },
          { key: 'sla_breached', label: 'SLA breaches', format: 'number' },
          { key: 'csat', label: 'CSAT (1–5)', format: 'number' },
        ],
        rows,
        chart: { type: 'bar', x: 'period', series: ['created'] },
      };
    },
  },
];

export async function reportCatalog(app: App): Promise<ReportDef[]> {
  const all = await app.hooks.apply<ReportDef[]>('reports.catalog', [...builtinReports], { app });
  return all.filter((r) => has(app, r.module));
}
