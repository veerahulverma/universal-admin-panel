import type { FastifyRequest } from 'fastify';
import type { ApiKeyPrincipal, App, Authenticator, CustomerPrincipal } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { AppError, unauthorized, forbidden, tooManyRequests } from '../../core/errors.js';
import { randomBase62 } from '../../core/ids.js';
import { sha256 } from '../../core/crypto.js';
import { ipMatches } from '../../core/net.js';
import { MINUTE } from '../../core/clock.js';
import { assertIpAllowed } from '../security/module.js';

export interface DeveloperSettings {
  defaultRateLimitPerMinute: number;
  clientOrigins: string[];
  customerSessionMinutes: number;
  webhookMaxAttempts: number;
  webhookTimeoutSeconds: number;
  webhookAutoDisableAfter: number;
  apiVersion: string;
}

export interface ApiScope {
  scope: string;
  description: string;
  module: string;
}

export function registerApiScopes(app: App, module: string, scopes: { scope: string; description: string }[]): void {
  const list = (app.services['developers.scopes'] as ApiScope[] | undefined) ?? [];
  list.push(...scopes.map((s) => ({ ...s, module })));
  app.services['developers.scopes'] = list;
}

export function apiScopes(app: App): ApiScope[] {
  return ((app.services['developers.scopes'] as ApiScope[] | undefined) ?? []).filter((s) => app.modules.isEnabled(s.module));
}

export function generateSecretKey(mode: 'live' | 'test'): { key: string; prefix: string; hash: string } {
  const key = `sk_${mode}_${randomBase62(32)}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

export function generateCustomerKey(prefix: string): { key: string; prefix: string; hash: string } {
  const key = `${prefix}_${randomBase62(32)}`;
  return { key, prefix: key.slice(0, prefix.length + 5), hash: sha256(key) };
}

/** Per-request metadata for API logging (kept off the request object's shape). */
export const apiRequestInfo = new WeakMap<FastifyRequest, { keyId: string | null; orgId: string | null; surface: 'v1' | 'client' }>();

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const apiKey = req.headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : null;
}

export function apiKeyAuthenticator(app: App): Authenticator {
  return async (req) => {
    // Log every attempt, including rejected ones, so abuse shows up in API logs.
    apiRequestInfo.set(req, { keyId: null, orgId: null, surface: 'v1' });
    const token = bearer(req);
    if (!token || !/^sk_(live|test)_/.test(token)) throw unauthorized('Provide a secret API key: Authorization: Bearer sk_live_...', 'api_key_missing');
    const key = await app.db.maybe<any>(sql`SELECT * FROM api_keys WHERE key_hash = ${sha256(token)}`);
    const now = app.clock.now();
    // Attempts with a revoked or expired key are logged against that key, so an integration still using it shows up.
    if (key) apiRequestInfo.set(req, { keyId: key.id, orgId: key.org_id, surface: 'v1' });
    if (!key || key.revoked_at || (key.expires_at && key.expires_at <= now)) throw unauthorized('Invalid, expired or revoked API key', 'api_key_invalid');
    assertIpAllowed(app, req.ip, 'api');
    if (key.allowed_ips.length && !ipMatches(req.ip, key.allowed_ips)) throw forbidden('This API key cannot be used from your IP address', 'ip_not_allowed');

    const settings = app.settings.get<DeveloperSettings>('developers');
    const limit = key.rate_limit_per_minute ?? settings.defaultRateLimitPerMinute;
    const rl = await app.rateLimiter.hit(`apikey:${key.id}`, limit, 60);
    rateHeaders.set(req, { limit: rl.limit, remaining: rl.remaining, reset: Math.ceil(rl.resetAt.getTime() / 1000) });
    if (!rl.allowed) throw tooManyRequests(`Rate limit of ${limit} requests per minute exceeded`, rl.retryAfterSeconds);

    if (!key.last_used_at || now.getTime() - key.last_used_at.getTime() > MINUTE) {
      await app.db.exec(sql`UPDATE api_keys SET last_used_at = ${now}, last_used_ip = ${req.ip} WHERE id = ${key.id}`);
    }
    const principal: ApiKeyPrincipal = { kind: 'api_key', keyId: key.id, name: key.name, scopes: key.scopes, orgId: key.org_id, mode: key.mode };
    return principal;
  };
}

export const rateHeaders = new WeakMap<FastifyRequest, { limit: number; remaining: number; reset: number }>();

export function customerSessionAuthenticator(app: App): Authenticator {
  return async (req) => {
    const token = bearer(req);
    if (!token || !token.startsWith('cs_')) throw unauthorized('Provide a customer session token: Authorization: Bearer cs_...', 'session_missing');
    const row = await app.db.maybe<any>(sql`
      SELECT s.id, s.user_id, s.org_id, s.expires_at, s.revoked_at, u.status, u.deleted_at
      FROM customer_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${sha256(token)}
    `);
    const now = app.clock.now();
    if (!row || row.revoked_at || row.expires_at <= now || row.deleted_at) throw unauthorized('Customer session expired', 'session_invalid');
    if (row.status === 'banned' || row.status === 'suspended') throw forbidden('This account is not active', 'account_inactive');
    if (row.org_id) {
      const member = await app.db.maybe(sql`SELECT 1 FROM memberships WHERE org_id = ${row.org_id} AND user_id = ${row.user_id} AND status = 'active'`);
      if (!member) throw forbidden('No longer a member of this organization', 'not_a_member');
    }
    const rl = await app.rateLimiter.hit(`customer:${row.user_id}`, 300, 60);
    if (!rl.allowed) throw tooManyRequests('Too many requests', rl.retryAfterSeconds);
    apiRequestInfo.set(req, { keyId: null, orgId: row.org_id, surface: 'client' });
    const principal: CustomerPrincipal = { kind: 'customer', sessionId: row.id, userId: row.user_id, orgId: row.org_id };
    return principal;
  };
}

/** Origin matching for the browser client API. Supports exact origins and https://*.example.com. */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => {
    if (a === origin) return true;
    const m = /^(https?):\/\/\*\.(.+)$/.exec(a);
    if (!m) return false;
    try {
      const u = new URL(origin);
      return u.protocol === `${m[1]}:` && u.hostname.endsWith(`.${m[2]}`);
    } catch {
      return false;
    }
  });
}

export async function logApiRequest(app: App, db: Db, req: FastifyRequest, status: number, durationMs: number, errorCode: string | null): Promise<void> {
  const info = apiRequestInfo.get(req);
  if (!info) return;
  await db.exec(sql.insert('api_requests', {
    id: `req_${String(req.id).slice(4)}`,
    api_key_id: info.keyId,
    surface: info.surface,
    org_id: info.orgId,
    method: req.method,
    route: req.routeOptions.url ?? req.url.split('?')[0],
    path: req.url.split('?')[0].slice(0, 500),
    status,
    duration_ms: Math.round(durationMs),
    ip: req.ip,
    error_code: errorCode,
    request_id: String(req.id),
    created_at: app.clock.now(),
  }, ''));
}

export function assertKeyScopesValid(app: App, scopes: string[]): void {
  const known = new Set(apiScopes(app).map((s) => s.scope));
  const resources = new Set([...known].map((s) => s.split(':')[0]));
  const bad = scopes.filter((s) => s !== '*' && !known.has(s) && !(s.endsWith(':*') && resources.has(s.slice(0, -2))));
  if (bad.length) throw new AppError(422, 'validation_error', `Unknown scopes: ${bad.join(', ')}`);
}
