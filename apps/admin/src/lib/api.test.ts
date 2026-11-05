import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorMessage, onReauthRequired, onUnauthorized, qs, setCsrfToken } from './api';

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let calls: Call[];
let responses: Response[];

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
  onReauthRequired(null);
  onUnauthorized(null);
});

describe('qs', () => {
  it('drops empty values and joins lists', () => {
    expect(qs({ q: 'ada', status: '', page: 2, tags: ['a', 'b'], none: undefined, empty: [] })).toBe('?q=ada&page=2&tags=a%2Cb');
    expect(qs({})).toBe('');
  });
});

describe('api client', () => {
  it('sends the CSRF token on writes only', async () => {
    setCsrfToken('csrf-1');
    responses.push(json(200, { ok: true }), json(200, { data: [] }));
    await api.post('/api/admin/things', { a: 1 });
    await api.get('/api/admin/things', { page: 1 });
    const post = new Headers(calls[0].init.headers);
    const get = new Headers(calls[1].init.headers);
    expect(post.get('x-csrf-token')).toBe('csrf-1');
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(get.get('x-csrf-token')).toBeNull();
    expect(calls[1].url).toBe('/api/admin/things?page=1');
    expect(calls[0].init.credentials).toBe('same-origin');
  });

  it('turns error bodies into ApiError with field errors', async () => {
    responses.push(json(422, { error: { code: 'validation_error', message: 'Invalid request', details: [{ path: ['body', 'email'], message: 'Invalid email' }], requestId: 'req-1' } }));
    const err = (await api.post('/api/admin/users', {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.requestId).toBe('req-1');
    expect(err.fieldErrors()).toEqual({ email: 'Invalid email' });
    expect(errorMessage(err)).toBe('email: Invalid email');
  });

  it('asks for re-authentication once and retries the original request', async () => {
    const handler = vi.fn(async () => true);
    onReauthRequired(handler);
    responses.push(json(403, { error: { code: 'reauth_required', message: 'Confirm your identity' } }), json(200, { refunded: true }));
    await expect(api.post('/api/admin/payments/pay_1/refunds', { amount: 100 })).resolves.toEqual({ refunded: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].init.body).toBe('{"amount":100}');
  });

  it('does not retry when re-authentication is cancelled', async () => {
    onReauthRequired(async () => false);
    responses.push(json(403, { error: { code: 'reauth_required', message: 'Confirm your identity' } }));
    const err = (await api.post('/api/admin/team/adm_1', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('reauth_required');
    expect(calls).toHaveLength(1);
  });

  it('reports expired sessions unless the caller opts out', async () => {
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);
    responses.push(json(401, { error: { code: 'session_expired', message: 'Sign in again' } }), json(401, { error: { code: 'invalid_credentials', message: 'Invalid email or password' } }));
    await api.get('/api/admin/users').catch(() => undefined);
    await api.post('/api/admin/auth/login', { email: 'a@example.com', password: 'x' }, { quiet401: true }).catch(() => undefined);
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(unauthorized).toHaveBeenCalledWith('session_expired');
  });
});
