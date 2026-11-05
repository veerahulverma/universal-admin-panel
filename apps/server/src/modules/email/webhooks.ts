import { createHmac, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import { setMarketingPreference, suppress, type ProviderRow } from './service.js';

export type DeliveryEventType = 'bounce' | 'complaint' | 'delivered' | 'open' | 'click' | 'unsubscribe' | 'ignored';

export interface DeliveryEvent {
  type: DeliveryEventType;
  email: string | null;
  /** Our message id when the provider echoes our metadata. */
  messageId?: string | null;
  providerMessageId?: string | null;
  /** Hard (permanent) bounce vs soft (temporary). */
  hard?: boolean;
  detail?: string | null;
}

export class EmailWebhookError extends Error {}

type Headers = Record<string, string | string[] | undefined>;
const h = (headers: Headers, name: string) => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Generic JSON events signed with HMAC-SHA256 (x-steward-signature). Use it with any relay or ESP. */
export function parseGeneric(rawBody: string, headers: Headers, secret: string | undefined): DeliveryEvent[] {
  const sig = h(headers, 'x-steward-signature');
  if (!secret || !sig || !safeEqual(sig, hmacSha256(secret, rawBody))) throw new EmailWebhookError('Invalid signature');
  const body = JSON.parse(rawBody);
  const list: any[] = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
  return list.map((e) => ({
    type: ['bounce', 'complaint', 'delivered', 'open', 'click', 'unsubscribe'].includes(e.type) ? e.type : 'ignored',
    email: e.email ?? null,
    messageId: e.messageId ?? null,
    providerMessageId: e.providerMessageId ?? null,
    hard: e.type === 'bounce' ? e.hard !== false && e.bounceType !== 'soft' : undefined,
    detail: e.detail ?? e.reason ?? null,
  }));
}

/** Postmark does not sign webhooks; we require a secret token in the URL query instead. */
export function parsePostmark(rawBody: string, query: Record<string, string>, secret: string | undefined): DeliveryEvent[] {
  if (!secret || !query.token || !safeEqual(query.token, secret)) throw new EmailWebhookError('Invalid token');
  const e = JSON.parse(rawBody);
  const messageId = e.Metadata?.steward_message_id ?? null;
  const providerMessageId = e.MessageID ?? null;
  switch (e.RecordType) {
    case 'Bounce': {
      const hardTypes = ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'Blocked', 'SpamNotification', 'Unknown'];
      return [{ type: 'bounce', email: e.Email ?? null, messageId, providerMessageId, hard: hardTypes.includes(e.Type), detail: e.Description ?? e.Type }];
    }
    case 'SpamComplaint':
      return [{ type: 'complaint', email: e.Email ?? null, messageId, providerMessageId }];
    case 'Delivery':
      return [{ type: 'delivered', email: e.Recipient ?? null, messageId, providerMessageId }];
    case 'Open':
      return [{ type: 'open', email: e.Recipient ?? null, messageId, providerMessageId }];
    case 'Click':
      return [{ type: 'click', email: e.Recipient ?? null, messageId, providerMessageId }];
    case 'SubscriptionChange':
      return e.SuppressSending ? [{ type: 'unsubscribe', email: e.Recipient ?? null, messageId, providerMessageId }] : [];
    default:
      return [{ type: 'ignored', email: null, detail: e.RecordType }];
  }
}

/** Resend signs webhooks with Svix: base64 HMAC-SHA256 over "id.timestamp.body" with the whsec_ secret. */
export function verifySvix(rawBody: string, headers: Headers, secret: string | undefined, nowSec: number, toleranceSec = 300): boolean {
  const id = h(headers, 'svix-id') ?? h(headers, 'webhook-id');
  const ts = h(headers, 'svix-timestamp') ?? h(headers, 'webhook-timestamp');
  const sigs = h(headers, 'svix-signature') ?? h(headers, 'webhook-signature');
  if (!secret || !id || !ts || !sigs) return false;
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  return sigs.split(' ').some((part) => {
    const [, sig] = part.split(',');
    return Boolean(sig) && safeEqual(sig, expected);
  });
}

export function parseResend(rawBody: string, headers: Headers, secret: string | undefined, nowSec: number): DeliveryEvent[] {
  if (!verifySvix(rawBody, headers, secret, nowSec)) throw new EmailWebhookError('Invalid signature');
  const e = JSON.parse(rawBody);
  const email = Array.isArray(e.data?.to) ? e.data.to[0] : e.data?.to ?? null;
  const providerMessageId = e.data?.email_id ?? null;
  switch (e.type) {
    case 'email.bounced':
      return [{ type: 'bounce', email, providerMessageId, hard: (e.data?.bounce?.type ?? 'Permanent') !== 'Transient', detail: e.data?.bounce?.message ?? null }];
    case 'email.complained':
      return [{ type: 'complaint', email, providerMessageId }];
    case 'email.delivered':
      return [{ type: 'delivered', email, providerMessageId }];
    case 'email.opened':
      return [{ type: 'open', email, providerMessageId }];
    case 'email.clicked':
      return [{ type: 'click', email, providerMessageId }];
    default:
      return [{ type: 'ignored', email, detail: e.type }];
  }
}

/** SendGrid signs its Event Webhook with ECDSA (P-256) over timestamp + body. */
export function verifySendgrid(rawBody: string, headers: Headers, publicKey: string | undefined): boolean {
  const sig = h(headers, 'x-twilio-email-event-webhook-signature');
  const ts = h(headers, 'x-twilio-email-event-webhook-timestamp');
  if (!publicKey || !sig || !ts) return false;
  try {
    const key = publicKey.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(publicKey)
      : createPublicKey({ key: Buffer.from(publicKey.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
    return verifySignature('sha256', Buffer.from(ts + rawBody), key, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

export function parseSendgrid(rawBody: string, headers: Headers, publicKey: string | undefined): DeliveryEvent[] {
  if (!verifySendgrid(rawBody, headers, publicKey)) throw new EmailWebhookError('Invalid signature');
  const list = JSON.parse(rawBody) as any[];
  return list.map((e) => {
    const base = { email: e.email ?? null, messageId: e.steward_message_id ?? null, providerMessageId: e.sg_message_id ? String(e.sg_message_id).split('.')[0] : null };
    switch (e.event) {
      case 'bounce':
        return { ...base, type: 'bounce' as const, hard: e.type !== 'blocked', detail: e.reason ?? null };
      case 'dropped':
        return { ...base, type: 'bounce' as const, hard: true, detail: e.reason ?? 'dropped' };
      case 'spamreport':
        return { ...base, type: 'complaint' as const };
      case 'delivered':
        return { ...base, type: 'delivered' as const };
      case 'open':
        return { ...base, type: 'open' as const };
      case 'click':
        return { ...base, type: 'click' as const };
      case 'unsubscribe':
      case 'group_unsubscribe':
        return { ...base, type: 'unsubscribe' as const };
      default:
        return { ...base, type: 'ignored' as const, detail: e.event };
    }
  });
}

export async function parseProviderWebhook(app: App, provider: ProviderRow, req: { rawBody: string; headers: Headers; query: Record<string, string> }): Promise<DeliveryEvent[]> {
  const secrets = await app.secrets.getAll(app.db, 'email_provider', provider.id);
  // Any provider accepts the generic signed format (useful for relays and custom MTAs).
  if (h(req.headers, 'x-steward-signature')) return parseGeneric(req.rawBody, req.headers, secrets.webhook_secret);
  const nowSec = Math.floor(app.clock.now().getTime() / 1000);
  switch (provider.type) {
    case 'postmark':
      return parsePostmark(req.rawBody, req.query, secrets.webhook_secret);
    case 'resend':
      return parseResend(req.rawBody, req.headers, secrets.webhook_secret, nowSec);
    case 'sendgrid':
      return parseSendgrid(req.rawBody, req.headers, secrets.webhook_public_key);
    default:
      throw new EmailWebhookError('Sign events with x-steward-signature for this provider type');
  }
}

/**
 * Apply delivery feedback: hard bounces and spam complaints suppress the
 * address for all mail (and complaints also withdraw marketing consent); soft
 * bounces are noted only; opens/clicks/deliveries update the message.
 */
export async function applyDeliveryEvents(app: App, provider: ProviderRow, events: DeliveryEvent[]): Promise<{ applied: number }> {
  let applied = 0;
  for (const e of events) {
    if (e.type === 'ignored') continue;
    await app.db.tx(async (tx) => {
      const msg = e.messageId
        ? await tx.maybe<any>(sql`SELECT * FROM email_messages WHERE id = ${e.messageId}`)
        : e.providerMessageId
          ? await tx.maybe<any>(sql`SELECT * FROM email_messages WHERE provider_message_id = ${e.providerMessageId} ORDER BY created_at DESC LIMIT 1`)
          : null;
      const email = (e.email ?? msg?.to_email ?? '').toLowerCase();
      const now = app.clock.now();
      switch (e.type) {
        case 'bounce':
          if (msg) {
            await tx.exec(sql`
              UPDATE email_messages SET ${e.hard ? sql`status = 'bounced', bounced_at = ${now},` : sql.empty} last_error = ${`bounce: ${e.detail ?? (e.hard ? 'hard' : 'soft')}`}, updated_at = ${now}
              WHERE id = ${msg.id}
            `);
          }
          if (e.hard && email) await suppress(tx, app, { email, reason: 'hard_bounce', scope: 'all', source: provider.type, details: { detail: e.detail ?? null, messageId: msg?.id ?? null } });
          break;
        case 'complaint':
          if (msg) await tx.exec(sql`UPDATE email_messages SET status = 'complained', updated_at = ${now} WHERE id = ${msg.id}`);
          if (email) {
            await setMarketingPreference(tx, app, { email, userId: msg?.user_id ?? null, subscribed: false, source: `complaint:${provider.type}` });
            await suppress(tx, app, { email, reason: 'complaint', scope: 'all', source: provider.type, details: { messageId: msg?.id ?? null } });
          }
          break;
        case 'unsubscribe':
          if (email) await setMarketingPreference(tx, app, { email, userId: msg?.user_id ?? null, subscribed: false, source: `provider:${provider.type}` });
          break;
        case 'delivered':
          if (msg) await tx.exec(sql`UPDATE email_messages SET delivered_at = coalesce(delivered_at, ${now}) WHERE id = ${msg.id}`);
          break;
        case 'open':
          if (msg) await tx.exec(sql`UPDATE email_messages SET opened_at = coalesce(opened_at, ${now}) WHERE id = ${msg.id}`);
          break;
        case 'click':
          if (msg) await tx.exec(sql`UPDATE email_messages SET clicked_at = coalesce(clicked_at, ${now}), opened_at = coalesce(opened_at, ${now}) WHERE id = ${msg.id}`);
          break;
      }
      applied++;
    });
  }
  return { applied };
}
