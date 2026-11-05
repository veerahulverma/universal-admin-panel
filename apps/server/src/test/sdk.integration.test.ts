import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from './harness.js';
import { apiKey, call, seedCatalog, type CatalogFixture } from './fixtures.js';
import { payToken } from '../modules/billing/checkout.js';

/**
 * End-to-end: drive a live (listening) platform through the published SDK
 * sources. The SDKs live outside this package's rootDir, so they are loaded
 * with non-literal dynamic imports (a static import would break `tsc` here).
 */
const SDK_NODE = '../../../../packages/sdk-node/src/index.js';
const SDK_JS = '../../../../packages/sdk-js/src/index.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let baseUrl: string;
let sdk: any;
let browser: any;
let steward: any;
let gatewayId: string;

beforeAll(async () => {
  t = await createTestPlatform();
  await t.server.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.server.server.address() as AddressInfo).port}`;
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  gatewayId = (await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: 'sbx-secret' } })).id;
  await t.app.db.script(`UPDATE products SET trial_days = 0 WHERE key = 'pro'`);
  await call(t, admin, 'PATCH', '/api/admin/settings/developers', { clientOrigins: ['https://app.example.com'] });
  sdk = await import(/* @vite-ignore */ SDK_NODE);
  browser = await import(/* @vite-ignore */ SDK_JS);
  steward = new sdk.Steward({ apiKey: await apiKey(t, admin), baseUrl, cache: { entitlementsTtlMs: 60_000 } });
});

afterAll(async () => {
  await t.close();
});

describe('Node SDK against a live server', () => {
  it('pings and syncs users idempotently', async () => {
    expect(await steward.ping()).toMatchObject({ ok: true, mode: 'live' });
    const first = await steward.users.upsert({ externalId: 'app-42', email: 'ada@example.com', name: 'Ada' });
    expect(first.created).toBe(true);
    const second = await steward.users.upsert({ externalId: 'app-42', email: 'ada@example.com', name: 'Ada Lovelace' });
    expect(second).toMatchObject({ created: false, user: { id: first.user.id, name: 'Ada Lovelace' } });
    expect((await steward.users.getByExternalId('app-42')).id).toBe(first.user.id);
    expect(await steward.users.getByExternalId('nobody')).toBeNull();
    expect(await steward.users.status(first.user.id)).toMatchObject({ allowed: true, status: 'active' });
    const err = await steward.users.get('usr_missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(sdk.StewardError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
    expect(err.requestId).toMatch(/^req_/);
  });

  it('checks entitlements and enforces quotas with idempotent metering', async () => {
    const { user } = await steward.users.upsert({ externalId: 'meter-1', email: 'meter@example.com' });
    expect(await steward.entitlements.check({ userId: user.id, feature: 'sso' })).toMatchObject({ allowed: false, reason: 'not_in_plan' });
    expect(await steward.entitlements.check({ userId: user.id, feature: 'api_calls', quantity: 10 })).toMatchObject({ allowed: true, remaining: 10 });
    expect(await sdk.gate(steward, { userId: user.id, feature: 'sso' })).toMatchObject({ allowed: false, status: 402 });

    const results = await Promise.all(Array.from({ length: 12 }, () => steward.usage.consume({ userId: user.id, meter: 'api_calls' })));
    expect(results.filter((r: any) => r.allowed)).toHaveLength(10);
    expect(results.find((r: any) => !r.allowed).reason).toBe('limit_exceeded');
    const replay = await steward.usage.consume({ userId: user.id, meter: 'api_calls', idempotencyKey: (await t.app.db.one<{ idempotency_key: string }>(
      (await import('../core/sql.js')).sql`SELECT idempotency_key FROM usage_events WHERE subject_id = ${user.id} LIMIT 1`,
    )).idempotency_key });
    expect(replay).toMatchObject({ allowed: true, duplicate: true, used: 10 });
    const summary = await steward.usage.summary({ userId: user.id });
    expect(summary.find((m: any) => m.meter === 'api_calls')).toMatchObject({ used: 10, limit: 10, remaining: 0 });
  });

  it('runs a checkout end to end and sees the upgrade', async () => {
    const { user } = await steward.users.upsert({ externalId: 'buyer-1', email: 'buyer@example.com' });
    expect(await steward.entitlements.has({ userId: user.id }, 'sso')).toBe(false);
    const session = await steward.checkout.create({ userId: user.id, priceId: cat.proMonthly.id, successUrl: 'https://app.example.com/ok', cancelUrl: 'https://app.example.com/no' });
    expect(session).toMatchObject({ status: 'open', amount: { total: 2000, currency: 'USD' } });
    // The customer pays on the hosted sandbox page.
    const payPath = new URL(session.url).pathname;
    const pay = await fetch(`${baseUrl}${payPath}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: payToken(t.app, session.id), outcome: 'success' }) });
    expect(pay.status).toBe(303);
    expect(pay.headers.get('location')).toBe('https://app.example.com/ok');
    expect(await steward.checkout.get(session.id)).toMatchObject({ status: 'completed' });

    const [sub] = await steward.subscriptions.list({ userId: user.id });
    expect(sub).toMatchObject({ status: 'active', productKey: 'pro', cancelAtPeriodEnd: false });
    expect(await steward.entitlements.has({ userId: user.id }, 'sso')).toBe(false); // still cached
    steward.invalidate({ userId: user.id });
    expect(await steward.entitlements.has({ userId: user.id }, 'sso')).toBe(true);
    const [invoice] = await steward.invoices.list({ userId: user.id });
    expect(invoice).toMatchObject({ status: 'paid', total: 2000 });
    const pdf = await steward.invoices.pdf(invoice.id);
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');

    const canceled = await steward.subscriptions.cancel(sub.id, { reason: 'switching tools' });
    expect(canceled.subscription.cancelAtPeriodEnd).toBe(true);
    expect((await steward.subscriptions.reactivate(sub.id)).subscription.cancelAtPeriodEnd).toBe(false);
  });

  it('serves the browser SDK through customer sessions', async () => {
    const { user } = await steward.users.upsert({ externalId: 'browser-1', email: 'browser@example.com', name: 'Browser User' });
    const session = await steward.customerSessions.create({ userId: user.id });
    expect(session.token).toMatch(/^cs_/);
    let refreshes = 0;
    const client = new browser.StewardClient({
      baseUrl,
      token: 'cs_expired_token',
      getToken: async () => {
        refreshes++;
        return session.token;
      },
      fetch: (input: string | URL, init?: RequestInit) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), origin: 'https://app.example.com' } }),
    });
    const me = await client.me();
    expect(me.user).toMatchObject({ id: user.id, email: 'browser@example.com' });
    expect(refreshes).toBe(1);
    expect((await client.entitlements()).plans.map((p: any) => p.key)).toEqual(['free']);
    expect(await client.hasFeature('sso')).toBe(false);
    const plans = await client.plans({ currency: 'USD' });
    expect(plans.map((p: any) => p.key)).toEqual(expect.arrayContaining(['free', 'pro', 'team', 'extra_calls']));
    expect((await client.usage()).find((m: any) => m.meter === 'api_calls')).toMatchObject({ limit: 10 });
    const checkout = await client.checkout({ priceId: cat.proMonthly.id });
    expect(checkout.url).toContain('/pay/sandbox/');
    expect(await client.notifications.list()).toMatchObject({ supported: expect.any(Boolean) });
    // A secret key is never accepted by the client API.
    const bad = new browser.StewardClient({ baseUrl, token: 'cs_nope' });
    await expect(bad.me()).rejects.toMatchObject({ status: 401 });
  });

  it('issues and verifies customer API keys and impersonation tokens', async () => {
    const { user } = await steward.users.upsert({ externalId: 'dev-1', email: 'dev@example.com' });
    const issued = await steward.customerKeys.issue({ userId: user.id, name: 'CI', scopes: ['read'] });
    expect(await steward.customerKeys.verify(issued.key)).toMatchObject({ valid: true, key: { userId: user.id, scopes: ['read'] } });
    expect((await steward.customerKeys.list({ userId: user.id })).map((k: any) => k.id)).toEqual([issued.id]);
    await steward.customerKeys.revoke(issued.id);
    expect(await steward.customerKeys.verify(issued.key)).toMatchObject({ valid: false, reason: 'invalid_key' });

    const start = await call(t, admin, 'POST', `/api/admin/users/${user.id}/impersonate`, { reason: 'Reproducing a support ticket' });
    expect(await steward.impersonation.verify(start.token)).toMatchObject({ userId: user.id, readOnly: true, admin: { id: admin.adminId } });
    await expect(steward.impersonation.verify(start.token)).rejects.toMatchObject({ status: 404 });
  });

  it('receives webhooks whose signatures verify with the SDK', async () => {
    const received: { body: string; signature: string }[] = [];
    const receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, signature: String(req.headers[sdk.WEBHOOK_SIGNATURE_HEADER]) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
      // Dispatch events from earlier tests first; only new ones should reach this endpoint.
      await t.app.worker.runUntilIdle();
      const endpoint = await steward.webhookEndpoints.create({ url, events: ['user.created'] });
      expect(endpoint.secret).toMatch(/^whsec_/);
      const { user } = await steward.users.upsert({ externalId: 'hooked-1', email: 'hooked@example.com' });
      await t.app.worker.runUntilIdle();
      expect(received).toHaveLength(1);
      const event = sdk.verifyWebhook(received[0].body, received[0].signature, endpoint.secret);
      expect(event).toMatchObject({ type: 'user.created', userId: user.id, data: { email: 'hooked@example.com' } });
      expect(() => sdk.verifyWebhook(received[0].body.replace('hooked', 'hacked'), received[0].signature, endpoint.secret)).toThrow(sdk.StewardWebhookError);

      const handled: string[] = [];
      const handle = sdk.createWebhookHandler({ secret: endpoint.secret, handlers: { 'user.*': (e: any) => void handled.push(e.type) } });
      expect(await handle(received[0].body, received[0].signature)).toEqual({ status: 200, body: { received: true } });
      expect(handled).toEqual(['user.created']);

      const polled: string[] = [];
      for await (const e of steward.events.iterate({ type: 'user.created' })) polled.push(e.data.email);
      expect(polled).toContain('hooked@example.com');
      await steward.webhookEndpoints.delete(endpoint.id);
      expect(await steward.webhookEndpoints.list()).toEqual([]);
    } finally {
      await new Promise((r) => receiver.close(r));
    }
  });
});

export { gatewayId };
