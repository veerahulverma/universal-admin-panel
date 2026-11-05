import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { sql } from '../../core/sql.js';
import { hmacSha256 } from '../../core/crypto.js';
import { safeRequest } from '../../core/net.js';
import { MINUTE, HOUR } from '../../core/clock.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

async function apiKey(body: Record<string, unknown>) {
  const res = await t.request({ method: 'POST', url: '/api/admin/api-keys', as: admin, body: { name: 'test', ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; secret: string };
}

describe('API key authentication', () => {
  it('authenticates, enforces scopes, revocation and expiry', async () => {
    expect((await t.request({ url: '/api/v1/ping' })).status).toBe(401);
    const key = await apiKey({ scopes: ['users:read'] });
    expect(key.secret).toMatch(/^sk_live_/);
    const ping = await t.request({ url: '/api/v1/ping', bearer: key.secret });
    expect(ping.body).toMatchObject({ ok: true, scopes: ['users:read'] });
    expect((await t.request({ url: '/api/v1/users', bearer: key.secret })).status).toBe(200);
    const write = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'x@example.com' } });
    expect(write.body.error.code).toBe('insufficient_scope');
    const listed = await t.request({ url: '/api/admin/api-keys', as: admin });
    expect(JSON.stringify(listed.body)).not.toContain(key.secret);
    await t.request({ method: 'DELETE', url: `/api/admin/api-keys/${key.id}`, as: admin });
    expect((await t.request({ url: '/api/v1/ping', bearer: key.secret })).status).toBe(401);
  });

  it('rejects unknown scopes and rotates keys with a grace period', async () => {
    const bad = await t.request({ method: 'POST', url: '/api/admin/api-keys', as: admin, body: { name: 'x', scopes: ['users:delete-everything'] } });
    expect(bad.status).toBe(422);
    const key = await apiKey({ scopes: ['*'] });
    const rolled = await t.request({ method: 'POST', url: `/api/admin/api-keys/${key.id}/roll`, as: admin, body: { expireOldInHours: 1 } });
    expect(rolled.body.secret).not.toBe(key.secret);
    expect((await t.request({ url: '/api/v1/ping', bearer: key.secret })).status).toBe(200);
    t.clock.advance(HOUR + MINUTE);
    expect((await t.request({ url: '/api/v1/ping', bearer: key.secret })).status).toBe(401);
    expect((await t.request({ url: '/api/v1/ping', bearer: rolled.body.secret })).status).toBe(200);
  });

  it('rate-limits per key and reports limits in headers', async () => {
    const key = await apiKey({ scopes: ['*'], rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await t.request({ url: '/api/v1/ping', bearer: key.secret })).status).toBe(200);
    const limited = await t.request({ url: '/api/v1/ping', bearer: key.secret });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
    t.clock.advance(MINUTE);
    expect((await t.request({ url: '/api/v1/ping', bearer: key.secret })).status).toBe(200);
  });

  it('restricts keys to allowed IPs and logs requests', async () => {
    const key = await apiKey({ scopes: ['*'], allowedIps: ['10.0.0.0/8'] });
    expect((await t.request({ url: '/api/v1/ping', bearer: key.secret, ip: '10.1.2.3' })).status).toBe(200);
    expect((await t.request({ url: '/api/v1/ping', bearer: key.secret, ip: '192.0.2.1' })).status).toBe(403);
    const logs = await t.request({ url: '/api/admin/api-requests', as: admin, query: { keyId: key.id } });
    expect(logs.body.data.map((l: any) => l.status).sort()).toEqual([200, 403]);
    const stats = await t.request({ url: '/api/admin/api-requests/stats', as: admin });
    expect(stats.body.totals.requests).toBe(2);
  });

  it('filters the request log by method, path, latency, surface and time', async () => {
    const key = await apiKey({ scopes: ['*'] });
    await t.request({ url: '/api/v1/ping', bearer: key.secret });
    const created = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'logged@example.com' } });
    await t.request({ url: `/api/v1/users/${created.body.user.id}`, bearer: key.secret });
    const logs = (query: Record<string, string | number>) => t.request({ url: '/api/admin/api-requests', as: admin, query }).then((r) => r.body.data as any[]);

    expect((await logs({ method: 'POST' })).map((l) => l.route)).toEqual(['/api/v1/users']);
    expect((await logs({ q: created.body.user.id })).map((l) => l.method)).toEqual(['GET']);
    expect(await logs({ surface: 'client' })).toEqual([]);
    expect(await logs({ minDurationMs: 600_000 })).toEqual([]);
    expect(await logs({ to: new Date(t.clock.now().getTime() - HOUR).toISOString() })).toEqual([]);
    expect(await logs({ q: '100%_' })).toEqual([]); // LIKE wildcards are escaped
    expect((await logs({ surface: 'v1', from: new Date(t.clock.now().getTime() - HOUR).toISOString() })).length).toBe(3);
  });
});

describe('integration API: users and organizations', () => {
  it('upserts users idempotently by external id', async () => {
    const key = await apiKey({ scopes: ['users:write'] });
    const first = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { externalId: 'u-1', email: 'one@example.com', name: 'One' } });
    expect(first.status).toBe(201);
    const second = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { externalId: 'u-1', email: 'one@example.com', name: 'Uno' } });
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.body.user.name).toBe('Uno');
    const byExt = await t.request({ url: '/api/v1/users/external/u-1', bearer: key.secret });
    expect(byExt.body.user.email).toBe('one@example.com');
    const status = await t.request({ url: `/api/v1/users/${first.body.user.id}/status`, bearer: key.secret });
    expect(status.body).toMatchObject({ allowed: true, status: 'active' });
  });

  it('isolates organization-scoped keys', async () => {
    const orgA = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'A' } })).body;
    const orgB = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'B' } })).body;
    const outsider = (await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'b@example.com', orgId: orgB.id } })).body;
    const key = await apiKey({ scopes: ['*'], orgId: orgA.id });
    const created = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'a-user@example.com' } });
    expect(created.status).toBe(201);
    const members = await t.request({ url: `/api/v1/organizations/${orgA.id}/members`, bearer: key.secret });
    expect(members.body.data.map((m: any) => m.email)).toEqual(['a-user@example.com']);
    expect((await t.request({ url: `/api/v1/users/${outsider.id}`, bearer: key.secret })).status).toBe(404);
    expect((await t.request({ url: `/api/v1/organizations/${orgB.id}`, bearer: key.secret })).status).toBe(404);
    const takeover = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'b@example.com', name: 'hijack' } });
    expect(takeover.status).toBe(404);
    expect((await t.request({ method: 'POST', url: '/api/v1/organizations', bearer: key.secret, body: { name: 'C' } })).status).toBe(403);
    const list = await t.request({ url: '/api/v1/users', bearer: key.secret });
    expect(list.body.data.map((u: any) => u.email)).toEqual(['a-user@example.com']);
  });

  it('records externally reported logins for security monitoring', async () => {
    const key = await apiKey({ scopes: ['*'] });
    const user = (await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'l@example.com' } })).body.user;
    await t.request({ method: 'POST', url: `/api/v1/users/${user.id}/login-events`, bearer: key.secret, body: { success: true, ip: '198.51.100.4', userAgent: 'Firefox', sessionId: 's1' } });
    await t.request({ method: 'POST', url: `/api/v1/users/${user.id}/login-events`, bearer: key.secret, body: { success: true, ip: '203.0.113.99', userAgent: 'Chrome' } });
    const logins = await t.request({ url: `/api/admin/users/${user.id}/login-events`, as: admin });
    expect(logins.body.total).toBe(2);
    const newDevice = await t.app.db.maybe(sql`SELECT 1 FROM security_events WHERE type = 'login.new_device' AND subject_id = ${user.id}`);
    expect(newDevice).not.toBeNull();
  });
});

describe('customer sessions and the client API', () => {
  it('issues browser-safe sessions and blocks inactive users', async () => {
    const key = await apiKey({ scopes: ['*'] });
    const user = (await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'c@example.com' } })).body.user;
    const session = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key.secret, body: { userId: user.id } });
    expect(session.body.token).toMatch(/^cs_/);
    const me = await t.request({ url: '/api/client/me', bearer: session.body.token });
    expect(me.body.user.email).toBe('c@example.com');
    expect((await t.request({ url: '/api/client/me', bearer: key.secret })).status).toBe(401);
    await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/status`, as: admin, body: { action: 'ban', reason: 'abuse' } });
    expect((await t.request({ url: '/api/client/me', bearer: session.body.token })).status).toBe(403);
    expect((await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key.secret, body: { userId: user.id } })).status).toBe(409);
  });

  it('ends browser sessions when an administrator signs the customer out everywhere', async () => {
    const key = await apiKey({ scopes: ['*'] });
    const user = (await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'd@example.com' } })).body.user;
    const session = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key.secret, body: { userId: user.id } });
    expect((await t.request({ url: '/api/client/me', bearer: session.body.token })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/revoke-sessions`, as: admin })).status).toBe(200);
    await t.app.worker.runUntilIdle();
    const after = await t.request({ url: '/api/client/me', bearer: session.body.token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('session_invalid');
    // A new session can be minted afterwards: signing out is not a ban.
    const fresh = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key.secret, body: { userId: user.id } });
    expect((await t.request({ url: '/api/client/me', bearer: fresh.body.token })).status).toBe(200);
  });

  it('answers CORS preflights only for configured origins', async () => {
    await t.request({ method: 'PATCH', url: '/api/admin/settings/developers', as: admin, body: { clientOrigins: ['https://app.example.com', 'https://*.example.org'] } });
    const ok = await t.server.inject({ method: 'OPTIONS', url: '/api/client/me', headers: { origin: 'https://app.example.com' } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const wildcard = await t.server.inject({ method: 'OPTIONS', url: '/api/client/me', headers: { origin: 'https://tenant.example.org' } });
    expect(wildcard.headers['access-control-allow-origin']).toBe('https://tenant.example.org');
    const denied = await t.server.inject({ method: 'OPTIONS', url: '/api/client/me', headers: { origin: 'https://evil.com' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('customer API keys (API products)', () => {
  it('issues, verifies, rate-limits and revokes keys', async () => {
    const key = await apiKey({ scopes: ['*'] });
    const user = (await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: 'dev@example.com' } })).body.user;
    const issued = await t.request({ method: 'POST', url: '/api/v1/customer-keys', bearer: key.secret, body: { userId: user.id, name: 'prod', scopes: ['read'], rateLimitPerMinute: 2 } });
    expect(issued.body.key).toMatch(/^ck_/);
    const verify = () => t.request({ method: 'POST', url: '/api/v1/customer-keys/verify', bearer: key.secret, body: { key: issued.body.key } });
    expect((await verify()).body).toMatchObject({ valid: true, key: { userId: user.id, scopes: ['read'] } });
    expect((await verify()).body.valid).toBe(true);
    expect((await verify()).body).toMatchObject({ valid: false, reason: 'rate_limited' });
    await t.request({ method: 'DELETE', url: `/api/v1/customer-keys/${issued.body.id}`, bearer: key.secret });
    t.clock.advance(MINUTE);
    expect((await verify()).body).toMatchObject({ valid: false, reason: 'invalid_key' });
  });
});

describe('webhooks', () => {
  async function receiver(status: () => number) {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status()).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    return { url, received, close: () => new Promise((r) => server.close(r)) };
  }

  it('delivers signed events and verifies the signature', async () => {
    const rx = await receiver(() => 200);
    try {
      const ep = await t.request({ method: 'POST', url: '/api/admin/webhooks', as: admin, body: { url: rx.url, events: ['user.*'] } });
      expect(ep.body.secret).toMatch(/^whsec_/);
      await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'hook@example.com' } });
      await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'not subscribed' } });
      await t.app.worker.runUntilIdle();
      expect(rx.received).toHaveLength(1);
      const { headers, body } = rx.received[0];
      const [tPart, vPart] = String(headers['steward-signature']).split(',');
      const ts = tPart.slice(2);
      expect(vPart.slice(3)).toBe(hmacSha256(ep.body.secret, `${ts}.${body}`));
      const payload = JSON.parse(body);
      expect(payload.type).toBe('user.created');
      expect(payload.data.email).toBe('hook@example.com');
      const deliveries = await t.request({ url: `/api/admin/webhooks/${ep.body.id}/deliveries`, as: admin });
      expect(deliveries.body.data[0]).toMatchObject({ status: 'succeeded', attempts: 1, response_status: 200 });
    } finally {
      await rx.close();
    }
  });

  it('retries failed deliveries with backoff, then gives up', async () => {
    let code = 500;
    const rx = await receiver(() => code);
    try {
      await t.request({ method: 'PATCH', url: '/api/admin/settings/developers', as: admin, body: { webhookMaxAttempts: 3 } });
      const ep = await t.request({ method: 'POST', url: '/api/admin/webhooks', as: admin, body: { url: rx.url } });
      await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'retry@example.com' } });
      await t.app.worker.runUntilIdle();
      let d = (await t.request({ url: `/api/admin/webhooks/${ep.body.id}/deliveries`, as: admin })).body.data[0];
      expect(d).toMatchObject({ status: 'pending', attempts: 1, response_status: 500 });
      t.clock.advance(2 * MINUTE);
      await t.app.worker.runUntilIdle();
      t.clock.advance(6 * MINUTE);
      await t.app.worker.runUntilIdle();
      d = (await t.request({ url: `/api/admin/webhooks/${ep.body.id}/deliveries`, as: admin })).body.data[0];
      expect(d).toMatchObject({ status: 'failed', attempts: 3 });
      expect(rx.received).toHaveLength(3);
      code = 200;
      const retry = await t.request({ method: 'POST', url: `/api/admin/webhook-deliveries/${d.id}/retry`, as: admin });
      expect(retry.body.ok).toBe(true);
    } finally {
      await rx.close();
    }
  });

  it('only delivers an organization’s events to its org-scoped endpoint', async () => {
    const rx = await receiver(() => 200);
    try {
      const orgA = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'A' } })).body;
      const orgB = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'B' } })).body;
      await t.request({ method: 'POST', url: '/api/admin/webhooks', as: admin, body: { url: rx.url, events: ['organization.updated'], orgId: orgA.id } });
      await t.request({ method: 'PATCH', url: `/api/admin/organizations/${orgB.id}`, as: admin, body: { name: 'B2' } });
      await t.request({ method: 'PATCH', url: `/api/admin/organizations/${orgA.id}`, as: admin, body: { name: 'A2' } });
      await t.app.worker.runUntilIdle();
      expect(rx.received.map((r) => JSON.parse(r.body).orgId)).toEqual([orgA.id]);
    } finally {
      await rx.close();
    }
  });

  it('shows a delivery with the exact payload that was sent', async () => {
    const rx = await receiver(() => 200);
    try {
      const ep = await t.request({ method: 'POST', url: '/api/admin/webhooks', as: admin, body: { url: rx.url, events: ['user.created'] } });
      await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'payload@example.com' } });
      await t.app.worker.runUntilIdle();
      const detail = await t.request({ url: `/api/admin/webhooks/${ep.body.id}`, as: admin });
      expect(detail.body).toMatchObject({ id: ep.body.id, url: rx.url, deliveries_24h: 1, failed_24h: 0, pending: 0 });
      const list = await t.request({ url: `/api/admin/webhooks/${ep.body.id}/deliveries`, as: admin, query: { eventType: 'user.created' } });
      const delivery = await t.request({ url: `/api/admin/webhook-deliveries/${list.body.data[0].id}`, as: admin });
      expect(delivery.body).toMatchObject({ status: 'succeeded', endpoint_url: rx.url, response_status: 200 });
      expect(delivery.body.payload).toEqual(JSON.parse(rx.received[0].body));
    } finally {
      await rx.close();
    }
  });

  it('keeps organization-scoped admins to their own endpoints', async () => {
    const orgA = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'A' } })).body;
    const orgB = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'B' } })).body;
    const other = (await t.request({ method: 'POST', url: '/api/admin/webhooks', as: admin, body: { url: 'https://hooks.example.com/b', orgId: orgB.id } })).body;
    const global = (await t.request({ method: 'POST', url: '/api/admin/webhooks', as: admin, body: { url: 'https://hooks.example.com/all' } })).body;
    const scoped = await adminSession(t, ['super_admin'], [orgA.id]);

    // No endpoint that would receive other tenants' events.
    const globalTry = await t.request({ method: 'POST', url: '/api/admin/webhooks', as: scoped, body: { url: 'https://hooks.example.com/a' } });
    expect(globalTry.status).toBe(422);
    const own = await t.request({ method: 'POST', url: '/api/admin/webhooks', as: scoped, body: { url: 'https://hooks.example.com/a', orgId: orgA.id } });
    expect(own.status).toBe(200);

    expect((await t.request({ url: '/api/admin/webhooks', as: scoped })).body.data.map((e: any) => e.id)).toEqual([own.body.id]);
    for (const id of [other.id, global.id]) {
      expect((await t.request({ url: `/api/admin/webhooks/${id}`, as: scoped })).status).toBe(404);
      expect((await t.request({ method: 'PATCH', url: `/api/admin/webhooks/${id}`, as: scoped, body: { enabled: false } })).status).toBe(404);
      expect((await t.request({ method: 'POST', url: `/api/admin/webhooks/${id}/rotate-secret`, as: scoped })).status).toBe(404);
      expect((await t.request({ url: `/api/admin/webhooks/${id}/deliveries`, as: scoped })).status).toBe(404);
      expect((await t.request({ method: 'DELETE', url: `/api/admin/webhooks/${id}`, as: scoped })).status).toBe(404);
    }
    expect((await t.request({ url: `/api/admin/webhooks/${own.body.id}`, as: scoped })).body).toMatchObject({ org_id: orgA.id, org_name: 'A' });
  });

  it('blocks requests to private networks (SSRF)', async () => {
    await expect(safeRequest('http://127.0.0.1:1/x')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(safeRequest('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(safeRequest('http://[::1]/')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(safeRequest('file:///etc/passwd')).rejects.toMatchObject({ code: 'invalid_url' });
  });
});

describe('event polling', () => {
  it('pages through events with a cursor', async () => {
    const key = await apiKey({ scopes: ['events:read', 'users:write'] });
    for (const e of ['p1', 'p2', 'p3']) await t.request({ method: 'POST', url: '/api/v1/users', bearer: key.secret, body: { email: `${e}@example.com` } });
    const first = await t.request({ url: '/api/v1/events', bearer: key.secret, query: { type: 'user.*', limit: 2 } });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);
    const next = await t.request({ url: '/api/v1/events', bearer: key.secret, query: { type: 'user.*', after: first.body.data[1].id } });
    expect(next.body.data.map((e: any) => e.data.email)).toEqual(['p3@example.com']);
  });
});
