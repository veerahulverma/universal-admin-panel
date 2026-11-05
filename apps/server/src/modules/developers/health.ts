import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { Router } from '../../core/http.js';
import { sql, type Sql } from '../../core/sql.js';
import { DAY, HOUR, MINUTE } from '../../core/clock.js';
import { notifyAdmins } from '../iam/notify.js';
import { adapters } from '../billing/gateways/registry.js';

/**
 * Integration health: one view of everything Steward talks to (payment gateways, email providers,
 * webhook endpoints, plugins, API keys) and of the job queue that drives it. Every check reads what
 * the owning module already records; a scheduled run stores the last state of each check so
 * administrators are alerted when one becomes unhealthy and again when it recovers.
 */

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown' | 'disabled';
export type IntegrationKind = 'gateway' | 'email' | 'webhook' | 'plugin' | 'api_key' | 'jobs';

export interface IntegrationCheck {
  /** Stable identity across runs, e.g. `gateway:gw_…`, `email:queue`. */
  key: string;
  kind: IntegrationKind;
  name: string;
  /** Standalone description for alerts ("Payment gateway Stripe"). */
  subject: string;
  status: HealthStatus;
  summary: string;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastSuccessAt: Date | null;
  metrics: Record<string, string | number | boolean | Date | null | Record<string, number>>;
  /** Console page where the integration is fixed. */
  link: string;
  orgId: string | null;
  /** Administrators holding this permission are alerted. */
  notify: string;
  /** The owning module already alerted administrators when this state began. */
  alerted?: boolean;
}

export interface IntegrationGroup {
  kind: IntegrationKind;
  label: string;
  checks: IntegrationCheck[];
  /** Why the group is empty (module disabled, nothing connected). */
  note: string | null;
}

export const integrationHealthSettings = z.object({
  /** Notify administrators when an integration becomes unhealthy, and when it recovers. */
  alerts: z.boolean(),
  /** Hard bounces per email sent over 7 days at which an email provider needs attention. */
  bounceRatePercent: z.number().min(0.1).max(100),
  /** Requests rejected (401, 403, 429) per API key in 24 hours at which the key needs attention. */
  apiKeyRejections: z.number().int().min(1).max(1_000_000),
  /** Webhook deliveries waiting for a retry at which the delivery queue needs attention. */
  webhookBacklog: z.number().int().min(1).max(1_000_000),
  /** Warn this many days before an API key that is still in use expires. */
  keyExpiryDays: z.number().int().min(0).max(90),
});
export type IntegrationHealthSettings = z.infer<typeof integrationHealthSettings>;

export const integrationHealthDefaults: IntegrationHealthSettings = {
  alerts: true,
  bounceRatePercent: 5,
  apiKeyRejections: 20,
  webhookBacklog: 100,
  keyExpiryDays: 7,
};

const settingsOf = (app: App) => app.settings.get<IntegrationHealthSettings>('integrationHealth');

/** Bounce rates are only judged on a meaningful sample. */
const MIN_BOUNCE_SAMPLE = 20;
/** Jobs and deliveries this late mean the worker is not keeping up (or not running). */
const OVERDUE_AFTER = 15 * MINUTE;
/** Running jobs are recovered after 15 minutes; flag them a little earlier. */
const STUCK_AFTER = 10 * MINUTE;

const UNHEALTHY = new Set<HealthStatus>(['degraded', 'down']);
const isUnhealthy = (s: HealthStatus | null | undefined) => Boolean(s && UNHEALTHY.has(s));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const latest = (...dates: (Date | null | undefined)[]) =>
  dates.reduce<Date | null>((best, d) => (d && (!best || d > best) ? d : best), null);

/** A module that is part of this installation and switched on (its tables exist and its data is live). */
const available = (app: App, id: string) => Boolean(app.modules.get(id)) && app.modules.isEnabled(id);

interface Window {
  now: Date;
  day: Date;
  week: Date;
}

// ---- Payment gateways ---------------------------------------------------------------------------

async function gatewayChecks(app: App, w: Window): Promise<IntegrationCheck[]> {
  const rows = await app.db.many<any>(sql`
    SELECT g.id, g.name, g.adapter, g.mode, g.enabled, g.last_test_at, g.last_test_ok, g.last_test_message, ev.*, pay.*, rf.failed_refunds_24h,
           fw.error AS webhook_error, fw.received_at AS webhook_error_at, fr.failure_message AS refund_error, fr.failed_at AS refund_error_at
    FROM payment_gateways g
    LEFT JOIN LATERAL (
      SELECT max(received_at) AS last_webhook_at,
             max(received_at) FILTER (WHERE status IN ('processed', 'ignored')) AS last_webhook_ok_at,
             count(*) FILTER (WHERE received_at >= ${w.day})::int AS webhooks_24h,
             count(*) FILTER (WHERE status = 'failed' AND received_at >= ${w.day})::int AS failed_webhooks_24h
      FROM gateway_events e WHERE e.gateway_id = g.id
    ) ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(p.created_at) FILTER (WHERE p.status <> 'failed') AS last_payment_at,
             count(*) FILTER (WHERE p.status = 'failed' AND p.created_at >= ${w.day})::int AS failed_payments_24h
      FROM payments p WHERE p.gateway_id = g.id
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS failed_refunds_24h FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE p.gateway_id = g.id AND r.status = 'failed' AND r.created_at >= ${w.day}
    ) rf ON TRUE
    LEFT JOIN LATERAL (
      SELECT error, received_at FROM gateway_events e WHERE e.gateway_id = g.id AND e.status = 'failed' ORDER BY received_at DESC LIMIT 1
    ) fw ON TRUE
    LEFT JOIN LATERAL (
      SELECT r.failure_message, coalesce(r.processed_at, r.created_at) AS failed_at FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE p.gateway_id = g.id AND r.status = 'failed' ORDER BY r.created_at DESC LIMIT 1
    ) fr ON TRUE
    ORDER BY g.is_default DESC, g.priority DESC, g.created_at
  `);
  return rows.map((g) => {
    const registered = adapters(app).has(g.adapter);
    const lastSuccessAt = latest(g.last_webhook_ok_at, g.last_payment_at, g.last_test_ok ? g.last_test_at : null);
    const errors = [
      g.last_test_ok === false ? { message: `Connection test: ${g.last_test_message ?? 'failed'}`, at: g.last_test_at as Date } : null,
      g.webhook_error ? { message: `Webhook: ${g.webhook_error}`, at: g.webhook_error_at as Date } : null,
      g.refund_error ? { message: `Refund: ${g.refund_error}`, at: g.refund_error_at as Date } : null,
    ].filter((e): e is { message: string; at: Date } => Boolean(e));
    const lastError = errors.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;

    let status: HealthStatus = 'ok';
    let summary = g.last_webhook_at ? 'Payments and webhooks are processing normally' : 'Connected; no webhooks received yet';
    if (!g.enabled) [status, summary] = ['disabled', 'Disabled; not offered at checkout'];
    else if (!registered) [status, summary] = ['down', `The "${g.adapter}" gateway plugin is not installed or not active`];
    // A failed connection test counts until the gateway works again (a payment, a processed webhook or a passing test).
    else if (g.last_test_ok === false && !(lastSuccessAt && lastSuccessAt > g.last_test_at)) [status, summary] = ['down', 'The last connection test failed'];
    else if (g.failed_webhooks_24h > 0) [status, summary] = ['degraded', `${plural(g.failed_webhooks_24h, 'webhook event')} failed to process in 24 hours`];
    else if (g.failed_refunds_24h > 0) [status, summary] = ['degraded', `${plural(g.failed_refunds_24h, 'refund')} failed at the gateway in 24 hours`];
    else if (!lastSuccessAt && g.last_test_ok === null) [status, summary] = ['unknown', 'Not tested yet and no payments or webhooks so far'];

    return {
      key: `gateway:${g.id}`,
      kind: 'gateway' as const,
      name: g.name,
      subject: `Payment gateway ${g.name}`,
      status,
      summary,
      lastError: !registered && g.enabled ? summary : (lastError?.message ?? null),
      lastErrorAt: lastError?.at ?? null,
      lastSuccessAt,
      metrics: {
        adapter: g.adapter,
        mode: g.mode,
        lastTestAt: g.last_test_at,
        lastTestOk: g.last_test_ok,
        lastWebhookAt: g.last_webhook_at,
        webhooks24h: g.webhooks_24h,
        failedWebhooks24h: g.failed_webhooks_24h,
        lastPaymentAt: g.last_payment_at,
        failedPayments24h: g.failed_payments_24h,
        failedRefunds24h: g.failed_refunds_24h,
      },
      link: `/platform/gateways/${g.id}`,
      orgId: null,
      notify: 'billing.gateways.manage',
    };
  });
}

// ---- Email --------------------------------------------------------------------------------------

/** The part of a delivery error that belongs to one provider ("Postmark: 401 …; SMTP: …"). */
function providerError(lastError: string | null, name: string): string | null {
  if (!lastError) return null;
  const start = lastError.indexOf(`${name}: `);
  if (start < 0) return null;
  const rest = lastError.slice(start + name.length + 2);
  const end = rest.indexOf('; ');
  return end < 0 ? rest : rest.slice(0, end);
}

async function emailChecks(app: App, w: Window): Promise<IntegrationCheck[]> {
  const s = app.settings.get<{ devLogFallback: boolean }>('email');
  const threshold = settingsOf(app).bounceRatePercent;
  // Only recent messages are read (email_messages is indexed by created_at); older failures have been retried long ago.
  const providers = await app.db.many<any>(sql`
    SELECT p.id, p.name, p.type, p.enabled, p.last_test_at, p.last_test_ok, p.last_test_message, st.*, fl.*, lf.last_error, lf.updated_at AS last_error_at
    FROM email_providers p
    LEFT JOIN LATERAL (
      SELECT max(m.sent_at) AS last_sent_at,
             count(*) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent_7d,
             count(*) FILTER (WHERE m.status = 'bounced')::int AS bounced_7d,
             count(*) FILTER (WHERE m.status = 'complained')::int AS complained_7d
      FROM email_messages m WHERE m.provider_id = p.id AND m.created_at >= ${w.week}
    ) st ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE m.updated_at >= ${w.day})::int AS failures_24h, max(m.updated_at) AS last_failure_at
      FROM email_messages m WHERE m.created_at >= ${w.week} AND m.last_error IS NOT NULL AND strpos(m.last_error, p.name || ': ') > 0
    ) fl ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.last_error, m.updated_at FROM email_messages m
      WHERE m.created_at >= ${w.week} AND m.last_error IS NOT NULL AND strpos(m.last_error, p.name || ': ') > 0 ORDER BY m.updated_at DESC LIMIT 1
    ) lf ON TRUE
    ORDER BY p.enabled DESC, p.priority DESC, p.created_at
  `);
  const checks: IntegrationCheck[] = providers.map((p) => {
    const bounceRate = p.sent_7d ? p.bounced_7d / p.sent_7d : null;
    const lastSuccessAt = latest(p.last_sent_at, p.last_test_ok ? p.last_test_at : null);
    const sendError = providerError(p.last_error, p.name);
    const testFailed = p.last_test_ok === false && !(p.last_sent_at && p.last_sent_at > p.last_test_at);
    let status: HealthStatus = 'ok';
    let summary = p.last_sent_at ? 'Sending normally' : 'Connected; nothing sent yet';
    if (!p.enabled) [status, summary] = ['disabled', 'Disabled; not used for sending'];
    else if (testFailed) [status, summary] = ['down', 'The last connection test failed'];
    else if (p.last_failure_at && (!p.last_sent_at || p.last_failure_at > p.last_sent_at)) [status, summary] = ['down', 'The last send through this provider failed'];
    else if (bounceRate !== null && p.sent_7d >= MIN_BOUNCE_SAMPLE && bounceRate * 100 >= threshold) {
      [status, summary] = ['degraded', `Bounce rate ${(bounceRate * 100).toFixed(1)}% over 7 days (alert at ${threshold}%)`];
    } else if (p.failures_24h > 0) [status, summary] = ['degraded', `${plural(p.failures_24h, 'message')} hit an error with this provider in 24 hours`];
    else if (!lastSuccessAt && p.last_test_ok === null) [status, summary] = ['unknown', 'Not tested yet and nothing sent so far'];
    const testError = p.last_test_ok === false ? { message: `Connection test: ${p.last_test_message ?? 'failed'}`, at: p.last_test_at as Date } : null;
    const lastError = sendError && (!testError || p.last_error_at > testError.at) ? { message: sendError, at: p.last_error_at as Date } : testError;
    return {
      key: `email:${p.id}`,
      kind: 'email' as const,
      name: p.name,
      subject: `Email provider ${p.name}`,
      status,
      summary,
      lastError: lastError?.message ?? null,
      lastErrorAt: lastError?.at ?? null,
      lastSuccessAt,
      metrics: {
        type: p.type,
        lastSentAt: p.last_sent_at,
        sent7d: p.sent_7d,
        bounced7d: p.bounced_7d,
        complained7d: p.complained_7d,
        bounceRate,
        failures24h: p.failures_24h,
        lastTestAt: p.last_test_at,
        lastTestOk: p.last_test_ok,
      },
      link: '/growth/email/providers',
      orgId: null,
      notify: 'email.providers.manage',
    };
  });

  const queue = await app.db.one<any>(sql`
    SELECT count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${w.day})::int AS failed_24h,
           count(*) FILTER (WHERE status IN ('queued', 'sending'))::int AS queued,
           count(*) FILTER (WHERE status = 'queued' AND attempts > 0)::int AS retrying,
           count(*) FILTER (WHERE status = 'queued' AND created_at < ${new Date(w.now.getTime() - HOUR)})::int AS waiting,
           max(sent_at) AS last_sent_at
    FROM email_messages WHERE created_at >= ${w.week}
  `);
  // The latest delivery error, whether the message has failed for good or is waiting for its next attempt.
  const lastFailed = await app.db.maybe<{ last_error: string | null; updated_at: Date }>(sql`
    SELECT last_error, updated_at FROM email_messages
    WHERE created_at >= ${w.week} AND (status = 'failed' OR (status = 'queued' AND attempts > 0)) AND last_error IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1
  `);
  const configured = providers.some((p) => p.enabled);
  let status: HealthStatus = 'ok';
  let summary = queue.last_sent_at ? 'Emails are being delivered' : 'Nothing sent in the last 7 days';
  if (!configured && (app.config.isProd || !s.devLogFallback)) [status, summary] = ['down', 'No email provider is enabled, so nothing is delivered'];
  else if (!configured) [status, summary] = ['unknown', 'No email provider yet: messages are written to the server log (development only)'];
  else if (queue.failed_24h > 0) [status, summary] = ['degraded', `${plural(queue.failed_24h, 'email')} failed in 24 hours`];
  else if (queue.retrying > 0) [status, summary] = ['degraded', `${plural(queue.retrying, 'email')} failing and waiting for another attempt`];
  else if (queue.waiting > 0) [status, summary] = ['degraded', `${plural(queue.waiting, 'email')} waiting for over an hour`];
  checks.push({
    key: 'email:queue',
    kind: 'email',
    name: 'Delivery queue',
    subject: 'Email delivery queue',
    status,
    summary,
    lastError: lastFailed?.last_error ?? null,
    lastErrorAt: lastFailed?.updated_at ?? null,
    lastSuccessAt: queue.last_sent_at,
    metrics: { failed24h: queue.failed_24h, queued: queue.queued, retrying: queue.retrying, waitingOverHour: queue.waiting },
    link: '/growth/email/messages',
    orgId: null,
    notify: 'email.providers.manage',
  });
  return checks;
}

// ---- Webhooks -----------------------------------------------------------------------------------

async function webhookChecks(app: App, w: Window, scope: string[] | null): Promise<IntegrationCheck[]> {
  const overdueBefore = new Date(w.now.getTime() - OVERDUE_AFTER);
  const inScope: Sql = scope ? sql`AND e.org_id IN ${sql.in(scope)}` : sql.empty;
  const endpoints = await app.db.many<any>(sql`
    SELECT e.id, e.url, e.enabled, e.disabled_reason, e.consecutive_failures, e.org_id, d.*, lf.error AS last_error, lf.updated_at AS last_error_at
    FROM webhook_endpoints e
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status = 'succeeded' AND updated_at >= ${w.day})::int AS delivered_24h,
             count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${w.day})::int AS failed_24h,
             count(*) FILTER (WHERE status = 'pending' AND attempts > 0)::int AS retrying,
             max(delivered_at) AS last_success_at
      FROM webhook_deliveries WHERE endpoint_id = e.id
    ) d ON TRUE
    LEFT JOIN LATERAL (
      SELECT error, updated_at FROM webhook_deliveries WHERE endpoint_id = e.id AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1
    ) lf ON TRUE
    WHERE TRUE ${inScope}
    ORDER BY e.created_at
  `);
  const checks: IntegrationCheck[] = endpoints.map((e) => {
    let status: HealthStatus = 'ok';
    let summary = e.delivered_24h ? `${plural(e.delivered_24h, 'delivery', 'deliveries')} in 24 hours` : 'No deliveries in 24 hours';
    let alerted = false;
    if (!e.enabled && e.disabled_reason) {
      // attemptDelivery() alerts administrators the moment it disables an endpoint.
      [status, summary, alerted] = ['down', e.disabled_reason, true];
    } else if (!e.enabled) [status, summary] = ['disabled', 'Disabled by an administrator'];
    else if (e.consecutive_failures > 0) [status, summary] = ['degraded', `The last ${plural(e.consecutive_failures, 'delivery', 'deliveries')} failed after every retry`];
    else if (e.failed_24h > 0) [status, summary] = ['degraded', `${plural(e.failed_24h, 'delivery', 'deliveries')} failed in 24 hours`];
    else if (e.retrying > 0) [status, summary] = ['degraded', `${plural(e.retrying, 'delivery', 'deliveries')} failing and being retried`];
    return {
      key: `webhook:${e.id}`,
      kind: 'webhook' as const,
      name: e.url,
      subject: `Webhook endpoint ${e.url}`,
      status,
      summary,
      lastError: e.last_error,
      lastErrorAt: e.last_error_at,
      lastSuccessAt: e.last_success_at,
      metrics: { delivered24h: e.delivered_24h, failed24h: e.failed_24h, retrying: e.retrying, consecutiveFailures: e.consecutive_failures },
      link: `/developers/webhooks/${e.id}`,
      orgId: e.org_id,
      notify: 'developers.webhooks.manage',
      alerted,
    };
  });

  // Deliveries of disabled endpoints wait for the endpoint to be re-enabled; they are not a backlog.
  const queue = await app.db.one<any>(sql`
    SELECT count(*)::int AS pending,
           count(*) FILTER (WHERE d.attempts > 0)::int AS retrying,
           count(*) FILTER (WHERE d.next_attempt_at < ${overdueBefore})::int AS overdue,
           min(d.next_attempt_at) AS next_attempt_at
    FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id AND e.enabled
    WHERE d.status = 'pending' ${inScope}
  `);
  const backlog = settingsOf(app).webhookBacklog;
  let status: HealthStatus = 'ok';
  let summary = queue.pending ? `${plural(queue.pending, 'delivery', 'deliveries')} in progress` : 'Nothing waiting';
  if (queue.overdue > 0) [status, summary] = ['down', `${plural(queue.overdue, 'delivery', 'deliveries')} overdue by over 15 minutes; check that the worker is running`];
  else if (queue.retrying >= backlog) [status, summary] = ['degraded', `${plural(queue.retrying, 'delivery', 'deliveries')} waiting for a retry (alert at ${backlog})`];
  checks.push({
    key: scope ? `webhooks:queue:${[...scope].sort().join(',')}` : 'webhooks:queue',
    kind: 'webhook',
    name: 'Delivery queue',
    subject: 'Webhook delivery queue',
    status,
    summary,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    metrics: { pending: queue.pending, retrying: queue.retrying, overdue: queue.overdue, nextAttemptAt: queue.next_attempt_at },
    link: '/developers/webhooks',
    orgId: null,
    notify: 'developers.webhooks.manage',
  });
  return checks;
}

// ---- Plugins ------------------------------------------------------------------------------------

async function pluginChecks(app: App, w: Window): Promise<IntegrationCheck[]> {
  const rows = await app.db.many<any>(sql`
    SELECT p.id, p.name, p.version, p.status, p.error_count, p.last_error, p.last_error_at, p.activated_at,
           (SELECT count(*)::int FROM plugin_logs l WHERE l.plugin_id = p.id AND l.level = 'error' AND l.created_at >= ${w.day}) AS error_logs_24h,
           -- The plugin host alerts administrators when it stops a plugin (same message, same moment).
           EXISTS (SELECT 1 FROM notifications n WHERE n.type = 'plugin.error' AND n.body = p.last_error AND n.created_at >= p.last_error_at) AS alerted
    FROM plugins p ORDER BY lower(p.name)
  `);
  return rows.map((p) => {
    let status: HealthStatus = 'ok';
    let summary = 'Running';
    if (p.status === 'error') [status, summary] = ['down', 'Stopped after an error'];
    else if (p.status === 'inactive') [status, summary] = ['disabled', 'Deactivated'];
    else if (p.status === 'installed') [status, summary] = ['disabled', 'Installed, not activated'];
    else if (p.last_error_at && p.last_error_at >= w.day) [status, summary] = ['degraded', 'Calls into the plugin failed in the last 24 hours'];
    return {
      key: `plugin:${p.id}`,
      kind: 'plugin' as const,
      name: p.name,
      subject: `Plugin ${p.name}`,
      status,
      summary,
      lastError: p.last_error,
      lastErrorAt: p.last_error_at,
      lastSuccessAt: null,
      metrics: { version: p.version, state: p.status, errorCount: p.error_count, errorLogs24h: p.error_logs_24h, activatedAt: p.activated_at },
      link: `/platform/plugins/${p.id}`,
      orgId: null,
      notify: 'plugins.manage.view',
      alerted: p.status === 'error' && p.alerted,
    };
  });
}

// ---- API keys -----------------------------------------------------------------------------------

const REJECTED = sql`(401, 403, 429)`;

async function apiKeyChecks(app: App, w: Window, scope: string[] | null): Promise<IntegrationCheck[]> {
  const s = settingsOf(app);
  const expiryHorizon = new Date(w.now.getTime() + s.keyExpiryDays * DAY);
  const keys = await app.db.many<any>(sql`
    SELECT k.id, k.name, k.prefix, k.mode, k.org_id, k.revoked_at, k.expires_at, k.last_used_at, req.requests, rej.*, lr.error_code AS last_code, lr.ip AS last_ip, lr.created_at AS last_rejected_at
    FROM api_keys k
    LEFT JOIN LATERAL (SELECT count(*)::int AS requests FROM api_requests r WHERE r.api_key_id = k.id AND r.created_at >= ${w.day}) req ON TRUE
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(x.n), 0)::int AS rejected, jsonb_object_agg(x.code, x.n) FILTER (WHERE x.code IS NOT NULL) AS codes
      FROM (
        SELECT coalesce(r.error_code, 'http_' || r.status) AS code, count(*)::int AS n FROM api_requests r
        WHERE r.api_key_id = k.id AND r.created_at >= ${w.day} AND r.status IN ${REJECTED} GROUP BY 1
      ) x
    ) rej ON TRUE
    LEFT JOIN LATERAL (
      SELECT error_code, ip, created_at FROM api_requests r WHERE r.api_key_id = k.id AND r.created_at >= ${w.day} AND r.status IN ${REJECTED}
      ORDER BY created_at DESC LIMIT 1
    ) lr ON TRUE
    WHERE ((k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ${w.now})) OR rej.rejected > 0)
      ${scope ? sql`AND k.org_id IN ${sql.in(scope)}` : sql.empty}
    ORDER BY k.created_at
  `);
  const checks: IntegrationCheck[] = keys.map((k) => {
    const revoked = Boolean(k.revoked_at);
    const expired = !revoked && k.expires_at && k.expires_at <= w.now;
    const expiringInUse = !revoked && !expired && k.expires_at && k.expires_at <= expiryHorizon && k.last_used_at && k.last_used_at >= w.week;
    const rejections = plural(k.rejected, 'request');
    let status: HealthStatus = 'ok';
    let summary = k.requests ? `${plural(k.requests, 'request')} in 24 hours${k.rejected ? `, ${k.rejected} rejected` : ''}` : 'Not used in the last 24 hours';
    if (revoked) [status, summary] = ['down', `Revoked, but still used: ${rejections} rejected in 24 hours`];
    else if (expired) [status, summary] = ['down', `Expired, but still used: ${rejections} rejected in 24 hours`];
    else if (k.rejected >= s.apiKeyRejections) [status, summary] = ['degraded', `${rejections} rejected in 24 hours (alert at ${s.apiKeyRejections})`];
    else if (expiringInUse) [status, summary] = ['degraded', `Expires ${k.expires_at.toISOString().slice(0, 10)} and is still in use; roll it before then`];
    return {
      key: `api_key:${k.id}`,
      kind: 'api_key' as const,
      name: k.name,
      subject: `API key ${k.name}`,
      status,
      summary,
      lastError: k.last_code ? `${k.last_code}${k.last_ip ? ` from ${k.last_ip}` : ''}` : null,
      lastErrorAt: k.last_rejected_at,
      lastSuccessAt: k.last_used_at,
      metrics: { prefix: k.prefix, mode: k.mode, requests24h: k.requests, rejected24h: k.rejected, rejectedBy: k.codes ?? {}, expiresAt: k.expires_at, revokedAt: k.revoked_at },
      link: '/developers/api-keys',
      orgId: k.org_id,
      notify: 'developers.keys.manage',
    };
  });

  // Keys nobody recognises (mistyped, deleted, or from another installation) are only visible platform-wide.
  if (!scope) {
    const unknown = await app.db.one<any>(sql`
      SELECT count(*) FILTER (WHERE error_code = 'api_key_invalid')::int AS invalid, count(*) FILTER (WHERE error_code = 'api_key_missing')::int AS missing,
             max(created_at) FILTER (WHERE error_code = 'api_key_invalid') AS last_at
      FROM api_requests WHERE api_key_id IS NULL AND surface = 'v1' AND status = 401 AND created_at >= ${w.day}
    `);
    const last = unknown.invalid
      ? await app.db.maybe<{ ip: string | null; path: string }>(sql`
          SELECT ip, path FROM api_requests WHERE api_key_id IS NULL AND surface = 'v1' AND error_code = 'api_key_invalid' AND created_at >= ${w.day} ORDER BY created_at DESC LIMIT 1
        `)
      : null;
    const degraded = unknown.invalid >= s.apiKeyRejections;
    checks.push({
      key: 'api_keys:unknown',
      kind: 'api_key',
      name: 'Unrecognised keys',
      subject: 'API key authentication',
      status: degraded ? 'degraded' : 'ok',
      summary: degraded
        ? `${plural(unknown.invalid, 'request')} with an unknown key in 24 hours (alert at ${s.apiKeyRejections})`
        : unknown.invalid
          ? `${plural(unknown.invalid, 'request')} with an unknown key in 24 hours`
          : 'No requests with unknown keys in 24 hours',
      lastError: last ? `Unknown key on ${last.path}${last.ip ? ` from ${last.ip}` : ''}` : null,
      lastErrorAt: unknown.last_at,
      lastSuccessAt: null,
      metrics: { invalid24h: unknown.invalid, missing24h: unknown.missing },
      link: '/developers/logs?status=4xx',
      orgId: null,
      notify: 'developers.keys.manage',
    });
  }
  return checks;
}

// ---- Job queue ----------------------------------------------------------------------------------

async function jobChecks(app: App, w: Window): Promise<IntegrationCheck[]> {
  const q = await app.db.one<any>(sql`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'running')::int AS running,
           count(*) FILTER (WHERE status = 'dead')::int AS dead,
           count(*) FILTER (WHERE status = 'dead' AND updated_at >= ${w.day})::int AS dead_24h,
           count(*) FILTER (WHERE status = 'running' AND locked_at < ${new Date(w.now.getTime() - STUCK_AFTER)})::int AS stuck,
           count(*) FILTER (WHERE status = 'pending' AND run_at < ${new Date(w.now.getTime() - OVERDUE_AFTER)})::int AS overdue,
           min(run_at) FILTER (WHERE status = 'pending' AND run_at <= ${w.now}) AS oldest_due_at,
           max(completed_at) AS last_completed_at
    FROM jobs WHERE status <> 'completed' OR completed_at >= ${w.day}
  `);
  const deadByType = await app.db.many<{ type: string; n: number }>(sql`
    SELECT type, count(*)::int AS n FROM jobs WHERE status = 'dead' AND updated_at >= ${w.day} GROUP BY type ORDER BY n DESC, type LIMIT 5
  `);
  const lastDead = await app.db.maybe<{ type: string; last_error: string | null; updated_at: Date }>(sql`
    SELECT type, last_error, updated_at FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 1
  `);
  let status: HealthStatus = 'ok';
  let summary = 'Processing normally';
  if (q.overdue > 0) [status, summary] = ['down', `${plural(q.overdue, 'job')} overdue by over 15 minutes; check that the worker is running`];
  else if (q.stuck > 0) [status, summary] = ['degraded', `${plural(q.stuck, 'job')} running for over 10 minutes`];
  else if (q.dead_24h > 0) [status, summary] = ['degraded', `${plural(q.dead_24h, 'job')} failed permanently in 24 hours`];
  return [
    {
      key: 'jobs',
      kind: 'jobs',
      name: 'Job queue',
      subject: 'Background job queue',
      status,
      summary,
      lastError: lastDead ? `${lastDead.type}: ${lastDead.last_error ?? 'failed'}` : null,
      lastErrorAt: lastDead?.updated_at ?? null,
      lastSuccessAt: q.last_completed_at,
      metrics: {
        pending: q.pending,
        running: q.running,
        dead: q.dead,
        dead24h: q.dead_24h,
        stuck: q.stuck,
        overdue: q.overdue,
        oldestDueAt: q.oldest_due_at,
        deadByType: Object.fromEntries(deadByType.map((d) => [d.type, d.n])),
      },
      link: '/platform/system?tab=jobs',
      orgId: null,
      notify: 'system.jobs.manage',
    },
  ];
}

// ---- Collection, alerts and presentation --------------------------------------------------------

/**
 * Run every check. Organization-scoped callers only see their organizations' webhook endpoints and API
 * keys: the platform-wide integrations' errors can carry other tenants' data.
 */
export async function collectIntegrationHealth(app: App, scope: string[] | null): Promise<IntegrationGroup[]> {
  const now = app.clock.now();
  const w: Window = { now, day: new Date(now.getTime() - DAY), week: new Date(now.getTime() - 7 * DAY) };
  const groups: IntegrationGroup[] = [];
  if (!scope) {
    const billing = available(app, 'billing');
    const gateways = billing ? await gatewayChecks(app, w) : [];
    groups.push({ kind: 'gateway', label: 'Payment gateways', checks: gateways, note: !billing ? 'The billing module is disabled.' : gateways.length ? null : 'No payment gateway connected yet.' });
    const email = available(app, 'email');
    groups.push({ kind: 'email', label: 'Email delivery', checks: email ? await emailChecks(app, w) : [], note: email ? null : 'The email module is disabled.' });
  }
  const webhooks = await webhookChecks(app, w, scope);
  groups.push({ kind: 'webhook', label: 'Webhooks', checks: webhooks, note: webhooks.length > 1 ? null : 'No webhook endpoints yet.' });
  if (!scope) {
    const plugins = available(app, 'plugins') ? await pluginChecks(app, w) : [];
    groups.push({ kind: 'plugin', label: 'Plugins', checks: plugins, note: plugins.length ? null : 'No plugins installed.' });
  }
  groups.push({ kind: 'api_key', label: 'API keys', checks: await apiKeyChecks(app, w, scope), note: null });
  if (!scope) groups.push({ kind: 'jobs', label: 'Job queue', checks: await jobChecks(app, w), note: null });
  return groups;
}

export type HealthChange = 'unhealthy' | 'recovered';

/** Alert on becoming unhealthy (or degraded getting worse) and on recovering; other moves are only recorded. */
export function classifyChange(previous: HealthStatus | null, next: HealthStatus): HealthChange | null {
  if (isUnhealthy(next) && (!isUnhealthy(previous) || (previous === 'degraded' && next === 'down'))) return 'unhealthy';
  if (next === 'ok' && isUnhealthy(previous)) return 'recovered';
  return null;
}

interface StoredCheck {
  key: string;
  status: HealthStatus;
  changed_at: Date;
  checked_at: Date;
}

/**
 * The scheduled monitor: evaluate every integration, store each check's state, and alert administrators
 * (by the permission that lets them fix it) when a check becomes unhealthy or recovers. Each change is
 * also an `integration.unhealthy` / `integration.recovered` event for webhooks and plugins.
 */
export async function recordIntegrationHealth(app: App): Promise<{ groups: IntegrationGroup[]; changes: { key: string; change: HealthChange; status: HealthStatus }[] }> {
  const groups = await collectIntegrationHealth(app, null);
  const checks = groups.flatMap((g) => g.checks);
  const now = app.clock.now();
  const alerts = settingsOf(app).alerts;
  return app.db.tx(async (tx) => {
    const previous = new Map((await tx.many<StoredCheck>(sql`SELECT key, status, changed_at, checked_at FROM integration_health FOR UPDATE`)).map((r) => [r.key, r]));
    const changes: { key: string; change: HealthChange; status: HealthStatus }[] = [];
    for (const check of checks) {
      const prev = previous.get(check.key) ?? null;
      await tx.exec(sql`
        INSERT INTO integration_health (key, kind, name, status, summary, last_error, last_error_at, org_id, changed_at, checked_at)
        VALUES (${check.key}, ${check.kind}, ${check.name}, ${check.status}, ${check.summary}, ${check.lastError?.slice(0, 2000) ?? null}, ${check.lastErrorAt}, ${check.orgId}, ${now}, ${now})
        ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, status = EXCLUDED.status, summary = EXCLUDED.summary,
          last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at, org_id = EXCLUDED.org_id, checked_at = EXCLUDED.checked_at,
          changed_at = CASE WHEN integration_health.status = EXCLUDED.status THEN integration_health.changed_at ELSE EXCLUDED.changed_at END
      `);
      const change = prev?.status === check.status ? null : classifyChange(prev?.status ?? null, check.status);
      if (!change) continue;
      changes.push({ key: check.key, change, status: check.status });
      await alert(tx, app, check, prev?.status ?? null, change, alerts);
    }
    // Integrations that no longer exist (a deleted gateway, endpoint or key) leave the monitor.
    await tx.exec(sql`DELETE FROM integration_health WHERE ${checks.length ? sql`key NOT IN ${sql.in(checks.map((c) => c.key))}` : sql`TRUE`}`);
    return { groups, changes };
  });
}

async function alert(db: Db, app: App, check: IntegrationCheck, previous: HealthStatus | null, change: HealthChange, notify: boolean): Promise<void> {
  const data = { key: check.key, kind: check.kind, name: check.name, status: check.status, previousStatus: previous, summary: check.summary, lastError: check.lastError };
  await app.events.emit(db, change === 'recovered' ? 'integration.recovered' : 'integration.unhealthy', data, { orgId: check.orgId });
  if (!notify || (change === 'unhealthy' && check.alerted)) return;
  const title =
    change === 'recovered' ? `${check.subject} is healthy again` : check.status === 'down' ? `${check.subject} is down` : `${check.subject} needs attention`;
  await notifyAdmins(db, app, {
    permission: check.notify,
    type: change === 'recovered' ? 'integration.recovered' : 'integration.unhealthy',
    title,
    body: change === 'recovered' ? check.summary : [check.summary, check.lastError].filter(Boolean).join(' · ').slice(0, 500),
    link: '/platform/health',
    severity: change === 'recovered' ? 'success' : check.status === 'down' ? 'critical' : 'warning',
    data: { key: check.key, kind: check.kind, status: check.status, previousStatus: previous },
  });
  await db.exec(sql`UPDATE integration_health SET alerted_at = ${app.clock.now()} WHERE key = ${check.key}`);
}

const RANK: Record<HealthStatus, number> = { down: 4, degraded: 3, ok: 2, unknown: 1, disabled: 0 };

/** The report as the console and the API return it: checks with how long they have been in their state. */
async function report(app: App, groups: IntegrationGroup[], scope: string[] | null) {
  const stored = new Map((await app.db.many<StoredCheck>(sql`SELECT key, status, changed_at, checked_at FROM integration_health`)).map((r) => [r.key, r]));
  const lastRun = await app.db.one<{ last_run_at: Date | null }>(sql`SELECT max(checked_at) AS last_run_at FROM integration_health`);
  const all = groups.flatMap((g) => g.checks);
  const counts = { ok: 0, degraded: 0, down: 0, unknown: 0, disabled: 0 };
  for (const c of all) counts[c.status]++;
  const worst = all.reduce<HealthStatus>((acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc), 'ok');
  return {
    status: worst === 'down' || worst === 'degraded' ? worst : ('ok' as const),
    checkedAt: app.clock.now(),
    /** When the scheduled monitor last ran (it stores state and sends alerts). */
    lastRunAt: lastRun.last_run_at,
    scoped: Boolean(scope),
    counts,
    groups: groups.map((g) => ({
      kind: g.kind,
      label: g.label,
      note: g.note,
      checks: g.checks.map(({ notify: _notify, alerted: _alerted, ...c }) => {
        const s = stored.get(c.key);
        return { ...c, since: s && s.status === c.status ? s.changed_at : null };
      }),
    })),
  };
}

export function setupIntegrationHealth(app: App): void {
  app.settings.define({
    key: 'integrationHealth',
    module: 'developers',
    label: 'Integration health',
    description: 'Alerts and thresholds for the integration health monitor (payment gateways, email, webhooks, plugins, API keys, jobs).',
    schema: integrationHealthSettings,
    defaults: integrationHealthDefaults,
    permission: 'developers.health.manage',
  });
  app.jobs.register('developers.integration_health', async (_p, { app }) => {
    await recordIntegrationHealth(app);
  }, { module: 'developers', timeoutMs: 2 * MINUTE });
  app.jobs.schedule({
    key: 'developers.integration_health',
    jobType: 'developers.integration_health',
    intervalSeconds: 300,
    description: 'Check connected integrations and alert administrators when one becomes unhealthy or recovers',
    module: 'developers',
  });
}

export function registerIntegrationHealthRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/integration-health',
    auth: 'admin',
    permission: 'developers.health.view',
    summary: 'Health of every connected integration: payment gateways, email delivery, webhooks, plugins, API keys and the job queue',
    tags: ['Integration health'],
    handler: async (c) => {
      const scope = c.orgScope();
      return report(app, await collectIntegrationHealth(app, scope), scope);
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/integration-health/run',
    auth: 'admin',
    permission: 'developers.health.manage',
    summary: 'Run the integration monitor now (stores the state and sends alerts like the scheduled run)',
    tags: ['Integration health'],
    rateLimit: { max: 10, windowSec: 60, by: 'principal' },
    handler: async (c) => {
      const { groups, changes } = await recordIntegrationHealth(app);
      await c.audit(app.db, 'integration_health.run', { type: 'integration_health', id: null }, { changes: changes.length });
      const scope = c.orgScope();
      return { ...(await report(app, scope ? await collectIntegrationHealth(app, scope) : groups, scope)), changes: scope ? [] : changes };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/integration-health',
    auth: 'api',
    scope: 'health:read',
    summary: 'Integration health for monitoring: overall status and each check with its last error',
    description: 'Organization-scoped keys see their organization’s webhook endpoints and API keys only.',
    tags: ['Integration health'],
    handler: async (c) => {
      const scope = c.orgScope();
      return report(app, await collectIntegrationHealth(app, scope), scope);
    },
  });
}
