import { describe, expect, it, vi } from 'vitest';
import {
  Steward,
  StewardConnectionError,
  StewardError,
  StewardWebhookError,
  connectMiddleware,
  createWebhookHandler,
  gate,
  signWebhookPayload,
  verifyWebhook,
} from '../src/index.js';
import { buildUrl } from '../src/http.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function client(handler: Handler, opts: Partial<ConstructorParameters<typeof Steward>[0]> = {}) {
  const calls: { url: URL; init: RequestInit; body: any }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return handler(url, init);
  });
  const steward = new Steward({ apiKey: 'sk_test_abc', baseUrl: 'https://steward.example.com', fetch: fetchImpl as unknown as typeof fetch, ...opts });
  return { steward, calls, fetchImpl };
}

describe('transport', () => {
  it('builds URLs with base path prefixes and drops empty query values', () => {
    expect(buildUrl('https://x.test/admin/', '/api/v1/users', { a: 1, b: undefined, c: null, d: 'x y' })).toBe('https://x.test/admin/api/v1/users?a=1&d=x+y');
  });

  it('sends the bearer key and maps API errors', async () => {
    const { steward, calls } = client(() => json(403, { error: { code: 'insufficient_scope', message: 'Missing users:write', requestId: 'req_1' } }));
    const err = await steward.users.upsert({ email: 'a@example.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(StewardError);
    expect(err).toMatchObject({ status: 403, code: 'insufficient_scope', message: 'Missing users:write', requestId: 'req_1' });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_abc');
  });

  it('retries rate limits honouring Retry-After', async () => {
    let n = 0;
    const { steward, calls } = client(() => (n++ === 0 ? json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '0' }) : json(200, { ok: true, keyId: 'key_1' })));
    expect(await steward.ping()).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('gives up after maxRetries and exposes retryAfterSeconds', async () => {
    const { steward, calls } = client(() => json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '0' }), { maxRetries: 1 });
    const err = await steward.ping().catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 0 });
    expect(calls).toHaveLength(2);
  });

  it('retries 5xx only for idempotent requests', async () => {
    let n = 0;
    const get = client(() => (n++ === 0 ? json(503, { error: { code: 'unavailable', message: 'x' } }) : json(200, { user: { id: 'usr_1' } })));
    expect((await get.steward.users.get('usr_1')).id).toBe('usr_1');
    expect(get.calls).toHaveLength(2);

    const post = client(() => json(503, { error: { code: 'unavailable', message: 'x' } }));
    await expect(post.steward.checkout.create({ userId: 'usr_1', priceId: 'price_1' })).rejects.toMatchObject({ status: 503 });
    expect(post.calls).toHaveLength(1);
  });

  it('retries network errors for idempotent calls and reports connection errors', async () => {
    let n = 0;
    const flaky = client(() => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return json(200, { data: [] });
    });
    expect(await flaky.steward.plans.list()).toEqual([]);
    const down = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.steward.checkout.create({ userId: 'u', priceId: 'p' })).rejects.toBeInstanceOf(StewardConnectionError);
    expect(down.calls).toHaveLength(1);
  });

  it('generates one idempotency key per usage call and reuses it across retries', async () => {
    let n = 0;
    const { steward, calls } = client(() => (n++ === 0 ? json(502, {}) : json(200, { allowed: true, meter: 'api_calls', used: 1 })));
    await steward.usage.consume({ userId: 'usr_1', meter: 'api_calls' });
    expect(calls).toHaveLength(2);
    expect(calls[0].body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1].body.idempotencyKey).toBe(calls[0].body.idempotencyKey);
    expect(calls[0].body.quantity).toBe(1);
    await steward.usage.consume({ userId: 'usr_1', meter: 'api_calls', idempotencyKey: 'mine' });
    expect(calls[2].body.idempotencyKey).toBe('mine');
  });

  it('requires a subject for subject-scoped calls', async () => {
    const { steward } = client(() => json(200, {}));
    expect(() => steward.usage.consume({ meter: 'x' })).toThrow(/userId or orgId/);
  });
});

describe('caching', () => {
  it('caches entitlements and user status briefly, with invalidation', async () => {
    const { steward, calls } = client((url) =>
      url.pathname.endsWith('/status') ? json(200, { userId: 'usr_1', status: 'active', allowed: true, reason: null }) : json(200, { subject: { type: 'user', id: 'usr_1' }, plans: [], features: { sso: { key: 'sso', type: 'boolean', enabled: true } } }),
    );
    await steward.entitlements.get({ userId: 'usr_1' });
    expect(await steward.entitlements.has({ userId: 'usr_1' }, 'sso')).toBe(true);
    expect(calls).toHaveLength(1);
    await steward.entitlements.get({ userId: 'usr_1' }, { fresh: true });
    expect(calls).toHaveLength(2);
    steward.invalidate({ userId: 'usr_1' });
    await steward.entitlements.get({ userId: 'usr_1' });
    expect(calls).toHaveLength(3);
    await steward.users.status('usr_1');
    await steward.users.status('usr_1');
    expect(calls).toHaveLength(4);
  });

  it('returns null for unknown external ids', async () => {
    const { steward } = client(() => json(404, { error: { code: 'not_found', message: 'User not found' } }));
    expect(await steward.users.getByExternalId('nope')).toBeNull();
  });

  it('refuses to run without a key or base URL', () => {
    expect(() => new Steward({ apiKey: '' })).toThrow(/apiKey/);
    const prev = process.env.STEWARD_URL;
    delete process.env.STEWARD_URL;
    expect(() => new Steward({ apiKey: 'sk_test_x' })).toThrow(/baseUrl/);
    if (prev) process.env.STEWARD_URL = prev;
  });
});

describe('webhooks', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'user.banned', created: '2026-01-01T00:00:00Z', apiVersion: '2026-11-01', data: { userId: 'usr_1' }, userId: 'usr_1', orgId: null });

  it('verifies signatures, rejects tampering, replays and wrong secrets, and supports rotation', () => {
    const now = 1_800_000_000;
    const header = signWebhookPayload('whsec_new', body, now);
    expect(verifyWebhook(body, header, 'whsec_new', { now }).type).toBe('user.banned');
    expect(verifyWebhook(Buffer.from(body), header, ['whsec_old', 'whsec_new'], { now }).id).toBe('evt_1');
    expect(() => verifyWebhook(body + ' ', header, 'whsec_new', { now })).toThrow(StewardWebhookError);
    expect(() => verifyWebhook(body, header, 'whsec_old', { now })).toThrow(/does not match/);
    expect(() => verifyWebhook(body, header, 'whsec_new', { now: now + 301 })).toThrow(/window/);
    expect(() => verifyWebhook(body, undefined, 'whsec_new', { now })).toThrow(/Missing/);
  });

  it('dispatches by exact type, prefix and wildcard; 400 on bad signatures, 500 on handler errors', async () => {
    const seen: string[] = [];
    const handle = createWebhookHandler({
      secret: 'whsec_x',
      handlers: { 'user.banned': () => void seen.push('exact'), 'user.*': () => void seen.push('prefix'), '*': () => void seen.push('any') },
    });
    expect(await handle(body, signWebhookPayload('whsec_x', body))).toEqual({ status: 200, body: { received: true } });
    expect(seen).toEqual(['exact', 'prefix', 'any']);
    expect((await handle(body, 't=1,v1=00')).status).toBe(400);
    const failing = createWebhookHandler({ secret: 'whsec_x', handlers: { '*': () => Promise.reject(new Error('db down')) } });
    expect((await failing(body, signWebhookPayload('whsec_x', body))).status).toBe(500);
  });

  it('invalidates caches for the affected subject when verifying through the client', async () => {
    const { steward, calls } = client(() => json(200, { userId: 'usr_1', status: 'active', allowed: true, reason: null }), { webhookSecret: 'whsec_x' });
    await steward.users.status('usr_1');
    steward.webhooks.verify(body, signWebhookPayload('whsec_x', body));
    await steward.users.status('usr_1');
    expect(calls).toHaveLength(2);
  });
});

describe('guards', () => {
  const steward = (feature: Record<string, unknown>, status: { allowed: boolean; status: string; reason: string | null } = { allowed: true, status: 'active', reason: null }) =>
    client((url) => (url.pathname.endsWith('/status') ? json(200, { userId: 'usr_1', ...status }) : json(200, { feature: 'x', ...feature }))).steward;

  it('maps entitlement decisions to HTTP statuses', async () => {
    expect(await gate(steward({ allowed: true, remaining: 4 }), { userId: 'usr_1', feature: 'x' })).toMatchObject({ allowed: true, status: 200, remaining: 4 });
    expect(await gate(steward({ allowed: false, reason: 'not_in_plan' }), { userId: 'usr_1', feature: 'x' })).toMatchObject({ allowed: false, status: 402, reason: 'not_in_plan' });
    expect(await gate(steward({ allowed: false, reason: 'limit_exceeded', remaining: 0 }), { userId: 'usr_1', feature: 'x' })).toMatchObject({ status: 429, reason: 'limit_exceeded' });
    expect(await gate(steward({ allowed: true }, { allowed: false, status: 'banned', reason: 'fraud' }), { userId: 'usr_1', feature: 'x' })).toMatchObject({ status: 403, reason: 'account_inactive' });
    expect(await gate(steward({ allowed: true }), {})).toMatchObject({ status: 401, reason: 'unauthenticated' });
  });

  it('works as Connect/Express middleware', async () => {
    const mw = connectMiddleware(steward({ allowed: false, reason: 'not_in_plan' }), { feature: 'x', getSubject: (req: { userId: string }) => ({ userId: req.userId }) });
    const res = { statusCode: 200, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v; }, end(b?: string) { this.body = b ?? ''; } };
    const next = vi.fn();
    await new Promise<void>((resolve) => {
      res.end = function (b?: string) { this.body = b ?? ''; resolve(); };
      mw({ userId: 'usr_1' }, res, next);
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).error.code).toBe('not_in_plan');

    const allow = connectMiddleware(steward({ allowed: true }), { feature: 'x', getSubject: () => ({ userId: 'usr_1' }) });
    const req: { steward?: unknown } = {};
    await new Promise<void>((resolve) => allow(req, res, () => resolve()));
    expect(req.steward).toMatchObject({ allowed: true });
  });
});

describe('content access', () => {
  it('checks a path for a subject and lists resource states', async () => {
    const { steward, calls } = client((url) =>
      url.pathname.endsWith('/check')
        ? json(200, { allowed: false, reason: 'not_yet_available', availableAt: '2026-12-01T00:00:00.000Z', availableUntil: null, resource: { id: 'res_1', kind: 'folder', title: 'Course' } })
        : json(200, { data: [{ id: 'res_1', kind: 'folder', title: 'Course', description: '', path: '/course', url: null, allowed: false, state: 'scheduled', reason: 'not_yet_available', availableAt: '2026-12-01T00:00:00.000Z', availableUntil: null, matchedBy: null }] }),
    );
    const check = await steward.access.check({ userId: 'usr_1', resource: '/course/week-2', ip: '203.0.113.9' });
    expect(check).toMatchObject({ allowed: false, reason: 'not_yet_available', availableAt: '2026-12-01T00:00:00.000Z' });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url.pathname).toBe('/api/v1/access/check');
    expect(calls[0].body).toEqual({ userId: 'usr_1', resource: '/course/week-2', ip: '203.0.113.9' });
    const list = await steward.access.resources({ orgId: 'org_1' });
    expect(list[0].state).toBe('scheduled');
    expect(calls[1].url.pathname).toBe('/api/v1/access/resources');
    expect(calls[1].url.searchParams.get('orgId')).toBe('org_1');
    expect(() => steward.access.check({ resource: '/x' })).toThrow(/userId or orgId/);
  });
});

describe('carts, vouchers and integration health', () => {
  it('checks out a cart, redeems vouchers and reads integration health', async () => {
    const { steward, calls } = client((url) =>
      url.pathname.endsWith('/cart')
        ? json(200, { id: 'chk_1', status: 'open', url: 'https://pay.example.com/1', invoiceId: 'inv_1', orderId: 'ord_1', amount: { total: 3000, currency: 'USD' } })
        : url.pathname.endsWith('/redeem')
          ? json(200, { voucher: { id: 'vch_1', kind: 'product' }, grant: { id: 'grt_1', startsAt: '2026-11-05T00:00:00Z', endsAt: null }, balance: null })
          : json(200, { status: 'degraded', counts: { ok: 3, degraded: 1, down: 0, unknown: 0, disabled: 0 }, groups: [], scoped: false }),
    );
    const cart = await steward.checkout.cart({ userId: 'usr_1', items: [{ priceId: 'pri_a' }, { priceId: 'pri_b', quantity: 2 }] });
    expect(cart.url).toBe('https://pay.example.com/1');
    expect(calls[0].body.items).toHaveLength(2);
    expect((await steward.vouchers.redeem({ userId: 'usr_1', code: 'GIFT-ABCD' })).grant?.id).toBe('grt_1');
    expect((await steward.integrationHealth()).status).toBe('degraded');
    expect(calls[2].url.pathname).toBe('/api/v1/integration-health');
  });
});

describe('notifications and push devices', () => {
  it('sends a notification and registers an app install for a customer', async () => {
    const { steward, calls } = client((url) => (url.pathname.endsWith('/push-devices') ? json(200, { id: 'pdev_1' }) : json(201, { id: 'ntf_1' })));
    expect(await steward.notifications.send({ userId: 'usr_1', title: 'Report ready', link: 'https://app.example.com/r/1' })).toEqual({ id: 'ntf_1' });
    expect(calls[0]).toMatchObject({ body: { userId: 'usr_1', title: 'Report ready', link: 'https://app.example.com/r/1' } });
    expect(calls[0].url.pathname).toBe('/api/v1/notifications');
    expect(await steward.pushDevices.register('usr_1', { provider: 'firebase', token: 'fcm-token-123', platform: 'android' })).toEqual({ id: 'pdev_1' });
    expect(calls[1].url.pathname).toBe('/api/v1/users/usr_1/push-devices');
    expect(calls[1].body).toEqual({ provider: 'firebase', token: 'fcm-token-123', platform: 'android' });
  });
});
