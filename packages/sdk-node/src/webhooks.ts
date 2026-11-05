import { createHmac, timingSafeEqual } from 'node:crypto';
import { StewardWebhookError } from './errors.js';

/** Header carrying the signature on every webhook delivery. */
export const WEBHOOK_SIGNATURE_HEADER = 'steward-signature';

export interface WebhookEvent<T = Record<string, any>> {
  id: string;
  type: string;
  created: string;
  apiVersion: string;
  data: T;
  userId: string | null;
  orgId: string | null;
}

export interface VerifyOptions {
  /** Maximum age (and clock skew) of a delivery in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Override "now" (unix seconds), for tests. */
  now?: number;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Produce a signature header (useful for testing your webhook handler). */
export function signWebhookPayload(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSeconds},v1=${hmacHex(secret, `${timestampSeconds}.${body}`)}`;
}

/**
 * Verify a Steward webhook and return the parsed event.
 *
 * The header is `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Pass the raw request body exactly as received (not re-serialized JSON).
 * Accepts several secrets so you can rotate without dropping deliveries.
 * Throws {@link StewardWebhookError} if anything is off; respond 400 then.
 */
export function verifyWebhook<T = Record<string, any>>(
  rawBody: string | Buffer | Uint8Array,
  signatureHeader: string | string[] | null | undefined,
  secret: string | string[],
  opts: VerifyOptions = {},
): WebhookEvent<T> {
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header) throw new StewardWebhookError('missing_signature', `Missing ${WEBHOOK_SIGNATURE_HEADER} header`);
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || !signatures.length) {
    throw new StewardWebhookError('invalid_signature', 'Malformed signature header');
  }

  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new StewardWebhookError('timestamp_out_of_tolerance', 'Webhook timestamp is outside the allowed window (possible replay)');
  }

  const secrets = Array.isArray(secret) ? secret : [secret];
  const valid = secrets.some((s) => {
    const expected = hmacHex(s, `${timestamp}.${body}`);
    return signatures.some((sig) => constantTimeEqual(sig, expected));
  });
  if (!valid) throw new StewardWebhookError('invalid_signature', 'Webhook signature does not match');

  try {
    return JSON.parse(body) as WebhookEvent<T>;
  } catch {
    throw new StewardWebhookError('invalid_payload', 'Webhook body is not valid JSON');
  }
}

export type WebhookHandlers = {
  [eventType: string]: ((event: WebhookEvent) => unknown | Promise<unknown>) | undefined;
};

export interface WebhookResponse {
  status: number;
  body: { received: boolean; error?: string };
}

/**
 * Framework-agnostic webhook endpoint: verifies, dispatches to handlers by type
 * (exact type, `prefix.*`, or `*`), and returns the HTTP response to send.
 * A handler error yields 500 so Steward retries the delivery.
 */
export function createWebhookHandler(opts: { secret: string | string[]; handlers: WebhookHandlers; toleranceSeconds?: number; onEvent?: (e: WebhookEvent) => void | Promise<void> }) {
  return async (rawBody: string | Buffer | Uint8Array, signatureHeader: string | string[] | null | undefined): Promise<WebhookResponse> => {
    let event: WebhookEvent;
    try {
      event = verifyWebhook(rawBody, signatureHeader, opts.secret, { toleranceSeconds: opts.toleranceSeconds });
    } catch (err) {
      return { status: 400, body: { received: false, error: (err as Error).message } };
    }
    try {
      await opts.onEvent?.(event);
      const prefix = `${event.type.split('.')[0]}.*`;
      for (const key of [event.type, prefix, '*']) {
        const handler = opts.handlers[key];
        if (handler) await handler(event);
      }
      return { status: 200, body: { received: true } };
    } catch (err) {
      return { status: 500, body: { received: false, error: (err as Error).message } };
    }
  };
}
