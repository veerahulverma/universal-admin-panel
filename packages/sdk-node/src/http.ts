import { StewardConnectionError, StewardError } from './errors.js';

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface HttpOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
  fetch: typeof fetch;
  userAgent: string;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Query;
  body?: unknown;
  /**
   * Safe to repeat after a network error or 5xx (the server dedupes it, e.g. via
   * an idempotency key or upsert semantics). GET/PUT/DELETE are always idempotent.
   */
  idempotent?: boolean;
  /** Return the raw bytes instead of parsing JSON (PDF downloads). */
  binary?: boolean;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRY_AFTER_SECONDS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return retryAfterSeconds * 1000;
  const base = Math.min(5000, 300 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

/** Join a base URL (which may include a path prefix) with an API path and query. */
export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * HTTP transport: bearer auth, JSON, timeouts and retries.
 *
 * Retry policy: 429 is always retried (the server rejected the request before
 * doing any work) honouring Retry-After; 502/503/504 and network errors are
 * retried only for idempotent requests, so nothing is ever applied twice.
 */
export class HttpClient {
  constructor(private readonly opts: HttpOptions) {}

  async request<T>(req: RequestOptions): Promise<T> {
    const idempotent = req.idempotent ?? req.method !== 'POST';
    const url = buildUrl(this.opts.baseUrl, req.path, req.query);
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.opts.fetch(url, {
          method: req.method,
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            accept: req.binary ? 'application/pdf, application/octet-stream' : 'application/json',
            'user-agent': this.opts.userAgent,
            ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        if (idempotent && attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt++));
          continue;
        }
        const timedOut = (err as Error)?.name === 'TimeoutError';
        throw new StewardConnectionError(timedOut ? `Request to ${req.path} timed out` : `Could not reach Steward: ${(err as Error)?.message ?? err}`, err);
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        if (req.binary) return new Uint8Array(await response.arrayBuffer()) as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const retryable = response.status === 429 ? retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_SECONDS : RETRYABLE_STATUS.has(response.status) && idempotent;
      if (retryable && attempt < this.opts.maxRetries) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(backoffMs(attempt++, response.status === 429 ? retryAfter : undefined));
        continue;
      }
      throw await toError(response, retryAfter);
    }
  }
}

async function toError(response: Response, retryAfter: number | undefined): Promise<StewardError> {
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body */
  }
  const err = payload?.error ?? {};
  return new StewardError(
    response.status,
    err.code ?? `http_${response.status}`,
    err.message ?? `Steward responded with HTTP ${response.status}`,
    err.requestId ?? response.headers.get('x-request-id'),
    err.details,
    retryAfter,
  );
}
