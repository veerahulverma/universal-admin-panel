import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { DomainEvent } from '../../core/events.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { hmacSha256, randomToken } from '../../core/crypto.js';
import { safeRequest } from '../../core/net.js';
import { MINUTE, HOUR } from '../../core/clock.js';
import { permissionMatches } from '../../core/permissions.js';
import { notifyAdmins } from '../iam/notify.js';
import type { DeveloperSettings } from './keys.js';

/** Retry schedule after the first attempt: 1m, 5m, 30m, 2h, 5h, 10h, 24h. */
const RETRY_DELAYS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 5 * HOUR, 10 * HOUR, 24 * HOUR];

export function generateWebhookSecret(): string {
  return `whsec_${randomToken(32)}`;
}

/**
 * Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * Receivers should recompute the HMAC, compare in constant time and reject
 * timestamps older than five minutes (replay protection). The SDKs do this.
 */
export function signPayload(secret: string, body: string, timestampSec: number): string {
  return `t=${timestampSec},v1=${hmacSha256(secret, `${timestampSec}.${body}`)}`;
}

export function eventMatches(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === '*' || permissionMatches(p, type));
}

/** Event handler: fan an event out to every subscribed endpoint. */
export async function fanOutEvent(event: DomainEvent, app: App): Promise<void> {
  if (event.type.startsWith('webhook.')) return; // never deliver webhook-health events recursively
  const endpoints = await app.db.many<{ id: string; events: string[]; org_id: string | null }>(sql`
    SELECT id, events, org_id FROM webhook_endpoints WHERE enabled
  `);
  for (const ep of endpoints) {
    if (!eventMatches(ep.events, event.type)) continue;
    // Org-scoped endpoints only receive their own organization's events.
    if (ep.org_id && ep.org_id !== event.orgId) continue;
    // Health alerts about an endpoint go to every other subscriber, not to the endpoint that is failing.
    if (event.type.startsWith('integration.') && event.data.key === `webhook:${ep.id}`) continue;
    await app.db.tx(async (tx) => {
      const now = app.clock.now();
      const row = await tx.maybe<{ id: string }>(sql`
        INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES (${newId('whd')}, ${ep.id}, ${event.id}, ${event.type}, 'pending', 0, ${now}, ${now}, ${now})
        ON CONFLICT (endpoint_id, event_id) DO NOTHING RETURNING id
      `);
      if (row) await app.jobs.enqueue(tx, 'webhooks.deliver', { deliveryId: row.id }, { idempotencyKey: `whd:${row.id}:0`, maxAttempts: 1 });
    });
  }
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export async function attemptDelivery(app: App, deliveryId: string): Promise<DeliveryResult | null> {
  const d = await app.db.maybe<any>(sql`
    SELECT d.*, e.url, e.enabled, e.api_version, ev.type, ev.data, ev.user_id, ev.org_id, ev.created_at AS event_created_at
    FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id JOIN events ev ON ev.id = d.event_id
    WHERE d.id = ${deliveryId}
  `);
  if (!d || d.status === 'succeeded' || !d.enabled) return null;
  const secret = await app.secrets.get(app.db, 'webhook_endpoint', d.endpoint_id, 'signing_secret');
  if (!secret) return null;
  const settings = app.settings.get<DeveloperSettings>('developers');
  const body = JSON.stringify({
    id: d.event_id,
    type: d.type,
    created: d.event_created_at,
    apiVersion: d.api_version,
    data: d.data,
    userId: d.user_id,
    orgId: d.org_id,
  });
  const ts = Math.floor(app.clock.now().getTime() / 1000);
  let status: number | null = null;
  let error: string | null = null;
  let responseBody = '';
  let durationMs = 0;
  try {
    const res = await safeRequest(d.url, {
      method: 'POST',
      body,
      timeoutMs: settings.webhookTimeoutSeconds * 1000,
      allowPrivate: app.config.allowPrivateNetwork,
      maxResponseBytes: 4096,
      headers: {
        'content-type': 'application/json',
        'user-agent': `Steward-Webhooks/${app.config.version}`,
        'steward-event-id': d.event_id,
        'steward-event-type': d.type,
        'steward-delivery-id': d.id,
        'steward-signature': signPayload(secret, body, ts),
      },
    });
    status = res.status;
    responseBody = res.body.slice(0, 2000);
    durationMs = res.durationMs;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const attempts = d.attempts + 1;
  const now = app.clock.now();
  await app.db.tx(async (tx) => {
    if (!error) {
      await tx.exec(sql`
        UPDATE webhook_deliveries SET status = 'succeeded', attempts = ${attempts}, response_status = ${status}, response_body = ${responseBody},
          error = NULL, duration_ms = ${durationMs}, delivered_at = ${now}, next_attempt_at = NULL, updated_at = ${now} WHERE id = ${d.id}
      `);
      await tx.exec(sql`UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = ${d.endpoint_id}`);
      return;
    }
    const finalFailure = attempts >= settings.webhookMaxAttempts;
    const nextAt = finalFailure ? null : new Date(now.getTime() + RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]);
    await tx.exec(sql`
      UPDATE webhook_deliveries SET status = ${finalFailure ? 'failed' : 'pending'}, attempts = ${attempts}, response_status = ${status},
        response_body = ${responseBody}, error = ${error}, duration_ms = ${durationMs}, next_attempt_at = ${nextAt}, updated_at = ${now}
      WHERE id = ${d.id}
    `);
    if (nextAt) {
      await app.jobs.enqueue(tx, 'webhooks.deliver', { deliveryId: d.id }, { runAt: nextAt, idempotencyKey: `whd:${d.id}:${attempts}`, maxAttempts: 1 });
    } else {
      const ep = await tx.one<{ consecutive_failures: number; url: string }>(sql`
        UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = ${d.endpoint_id} RETURNING consecutive_failures, url
      `);
      if (ep.consecutive_failures >= settings.webhookAutoDisableAfter) {
        await tx.exec(sql`UPDATE webhook_endpoints SET enabled = FALSE, disabled_reason = ${`Disabled after ${ep.consecutive_failures} consecutive failed deliveries`} WHERE id = ${d.endpoint_id}`);
        await notifyAdmins(tx, app, {
          permission: 'developers.webhooks.manage',
          type: 'webhook.disabled',
          title: 'Webhook endpoint disabled',
          body: `${ep.url} failed ${ep.consecutive_failures} deliveries in a row and was disabled.`,
          link: `/developers/webhooks`,
          severity: 'warning',
        });
      }
    }
  });
  return { ok: !error, status, error };
}

export async function createEndpoint(
  db: Db,
  app: App,
  input: { url: string; description?: string; events: string[]; orgId?: string | null; createdBy?: string | null },
): Promise<{ id: string; secret: string }> {
  const id = newId('whe');
  const now = app.clock.now();
  await db.exec(sql.insert('webhook_endpoints', {
    id,
    url: input.url,
    description: input.description ?? '',
    events: input.events,
    enabled: true,
    org_id: input.orgId ?? null,
    api_version: app.settings.get<DeveloperSettings>('developers').apiVersion,
    created_by: input.createdBy ?? null,
    created_at: now,
    updated_at: now,
  }, ''));
  const secret = generateWebhookSecret();
  await app.secrets.set(db, 'webhook_endpoint', id, 'signing_secret', secret);
  return { id, secret };
}
