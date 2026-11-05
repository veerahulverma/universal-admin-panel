import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { MINUTE } from '../../core/clock.js';
import { sendSystemEmail } from '../core/mail.js';
import { classifyChange } from './health.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

async function receiver(status: () => number) {
  const received: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(status()).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { url, received, close: () => new Promise((r) => server.close(r)) };
}

async function report(as: AdminSession = admin) {
  return call(t, as, 'GET', '/api/admin/integration-health');
}

function check(r: any, key: string) {
  return r.groups.flatMap((g: any) => g.checks).find((c: any) => c.key === key);
}

/** Alerts are asserted on explicit runs; the scheduled run must not race them. */
async function pauseSchedule() {
  await t.app.db.exec(sql`UPDATE scheduled_tasks SET enabled = FALSE WHERE key = 'developers.integration_health'`);
}

async function apiKey(body: Record<string, unknown>) {
  return call(t, admin, 'POST', '/api/admin/api-keys', { name: 'test', scopes: ['*'], ...body }) as Promise<{ id: string; secret: string }>;
}

describe('integration health report', () => {
  it('reports gateways, email, webhooks, plugins, API keys and jobs with their state and last error', async () => {
    await pauseSchedule();
    const now = t.clock.now();
    // Payment gateways: one healthy but with a webhook that failed to process, one whose connection test fails,
    // one whose plugin is not active.
    const sandbox = await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', secrets: { webhook_secret: 'secret' } });
    expect((await call(t, admin, 'POST', `/api/admin/gateways/${sandbox.id}/test`)).ok).toBe(true);
    await t.app.db.exec(sql.insert('gateway_events', { id: newId('gev'), gateway_id: sandbox.id, event_id: 'evt_1', type: 'refund.succeeded', payload: {}, status: 'failed', error: 'No payment matches sbx_pi_1', attempts: 1, received_at: now }, ''));
    t.app.services['billing.fetch'] = (async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key provided' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const stripe = await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'stripe', name: 'Stripe', mode: 'live', secrets: { secret_key: 'sk_live_wrong', webhook_secret: 'whsec_x' } });
    expect((await call(t, admin, 'POST', `/api/admin/gateways/${stripe.id}/test`)).ok).toBe(false);
    await t.app.db.exec(sql.insert('payment_gateways', { id: 'gw_mockpay', adapter: 'mockpay', name: 'MockPay', mode: 'live', enabled: true, config: {}, created_at: now, updated_at: now }, ''));

    // Email: the only provider refuses connections.
    t.app.services['email.smtpTransport'] = () => ({
      sendMail: async () => {
        throw new Error('Connection refused');
      },
      verify: async () => true,
    });
    const relay = await call(t, admin, 'POST', '/api/admin/email/providers', { type: 'smtp', name: 'Relay', fromEmail: 'hello@acme.test', config: { host: 'smtp.acme.test', port: 465, secure: true, username: 'mailer' }, secrets: { password: 'p@ss' } });
    await t.app.db.tx((tx) => sendSystemEmail(t.app, tx, { to: 'someone@example.com', template: 'email.test', data: { message: 'hello' } }));

    // Webhooks: an endpoint that answers 500.
    const rx = await receiver(() => 500);
    try {
      const endpoint = await call(t, admin, 'POST', '/api/admin/webhooks', { url: rx.url, events: ['user.created'] });
      await call(t, admin, 'POST', '/api/admin/users', { email: 'hooked@example.com' });
      await t.app.worker.runUntilIdle();

      // A plugin that crashed, and a background job that failed for good.
      await t.app.db.exec(sql.insert('plugins', { id: 'acme-crm', name: 'Acme CRM', version: '1.2.0', source: 'upload', status: 'error', manifest: {}, last_error: 'Plugin process exited unexpectedly (code 1)', last_error_at: now, installed_at: now, updated_at: now }, ''));
      await t.app.db.exec(sql.insert('jobs', { id: newId('job'), type: 'reports.deliver', payload: {}, status: 'dead', attempts: 3, max_attempts: 3, run_at: now, last_error: 'SMTP timeout', created_at: now, updated_at: now }, ''));

      // API keys: one used from a blocked network, one still used after being revoked, and keys nobody knows.
      await call(t, admin, 'PATCH', '/api/admin/settings/integrationHealth', { apiKeyRejections: 2 });
      const restricted = await apiKey({ name: 'Office only', allowedIps: ['10.0.0.0/8'] });
      for (let i = 0; i < 2; i++) expect((await t.request({ url: '/api/v1/ping', bearer: restricted.secret, ip: '192.0.2.1' })).status).toBe(403);
      const revoked = await apiKey({ name: 'Old backend' });
      await call(t, admin, 'DELETE', `/api/admin/api-keys/${revoked.id}`);
      expect((await t.request({ url: '/api/v1/ping', bearer: revoked.secret })).status).toBe(401);
      for (let i = 0; i < 2; i++) await t.request({ url: '/api/v1/ping', bearer: `sk_live_${'x'.repeat(32)}` });
      // Attempts with a revoked key are logged against it.
      expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM api_requests WHERE api_key_id = ${revoked.id} AND status = 401`)).n).toBe(1);

      const r = await report();
      expect(r.status).toBe('down');
      expect(r.scoped).toBe(false);
      expect(r.groups.map((g: any) => g.kind)).toEqual(['gateway', 'email', 'webhook', 'plugin', 'api_key', 'jobs']);
      expect(check(r, `gateway:${sandbox.id}`)).toMatchObject({ status: 'degraded', lastError: 'Webhook: No payment matches sbx_pi_1', metrics: { failedWebhooks24h: 1, lastTestOk: true } });
      expect(check(r, `gateway:${stripe.id}`)).toMatchObject({ status: 'down', summary: 'The last connection test failed', lastError: expect.stringMatching(/^Connection test: /), link: `/platform/gateways/${stripe.id}` });
      expect(check(r, 'gateway:gw_mockpay')).toMatchObject({ status: 'down', summary: 'The "mockpay" gateway plugin is not installed or not active' });
      expect(check(r, `email:${relay.id}`)).toMatchObject({ status: 'down', summary: 'The last send through this provider failed', lastError: 'smtp: Connection refused' });
      expect(check(r, 'email:queue')).toMatchObject({ status: 'degraded', lastError: 'Relay: smtp: Connection refused', metrics: { retrying: 1 } });
      expect(check(r, `webhook:${endpoint.id}`)).toMatchObject({ status: 'degraded', lastError: 'HTTP 500', metrics: { retrying: 1, failed24h: 0 } });
      expect(check(r, 'webhooks:queue')).toMatchObject({ status: 'ok', metrics: { pending: 1, retrying: 1, overdue: 0 } });
      expect(check(r, 'plugin:acme-crm')).toMatchObject({ status: 'down', lastError: 'Plugin process exited unexpectedly (code 1)', link: '/platform/plugins/acme-crm' });
      expect(check(r, `api_key:${restricted.id}`)).toMatchObject({ status: 'degraded', lastError: 'ip_not_allowed from 192.0.2.1', metrics: { rejected24h: 2, rejectedBy: { ip_not_allowed: 2 } } });
      expect(check(r, `api_key:${revoked.id}`)).toMatchObject({ status: 'down', summary: 'Revoked, but still used: 1 request rejected in 24 hours' });
      expect(check(r, 'api_keys:unknown')).toMatchObject({ status: 'degraded', metrics: { invalid24h: 2 } });
      expect(check(r, 'jobs')).toMatchObject({ status: 'degraded', lastError: 'reports.deliver: SMTP timeout', metrics: { dead24h: 1, deadByType: { 'reports.deliver': 1 } } });
      for (const c of r.groups.flatMap((g: any) => g.checks)) {
        expect(c).not.toHaveProperty('notify');
        expect(c.since).toBeNull(); // the monitor has not run yet
      }

      // Once the monitor has run, each check says since when it has been in its state.
      await call(t, admin, 'POST', '/api/admin/integration-health/run');
      const again = await report();
      expect(again.lastRunAt).not.toBeNull();
      expect(check(again, `gateway:${stripe.id}`).since).not.toBeNull();
    } finally {
      await rx.close();
    }
  });

  it('flags API keys that expire soon while still in use, and keys used after they expired', async () => {
    const expiring = await apiKey({ name: 'Expiring', expiresAt: new Date(t.clock.now().getTime() + 3 * 86_400_000).toISOString() });
    expect((await t.request({ url: '/api/v1/ping', bearer: expiring.secret })).status).toBe(200);
    const idle = await apiKey({ name: 'Idle', expiresAt: new Date(t.clock.now().getTime() + 3 * 86_400_000).toISOString() });
    let r = await report();
    expect(check(r, `api_key:${expiring.id}`)).toMatchObject({ status: 'degraded', summary: expect.stringMatching(/^Expires \d{4}-\d{2}-\d{2} and is still in use/) });
    expect(check(r, `api_key:${idle.id}`)).toMatchObject({ status: 'ok', summary: 'Not used in the last 24 hours' });

    t.clock.advance(4 * 86_400_000);
    admin = await adminSession(t);
    expect((await t.request({ url: '/api/v1/ping', bearer: expiring.secret })).status).toBe(401);
    r = await report();
    expect(check(r, `api_key:${expiring.id}`)).toMatchObject({ status: 'down', summary: 'Expired, but still used: 1 request rejected in 24 hours', lastError: 'api_key_invalid from 203.0.113.10' });
    expect(check(r, `api_key:${idle.id}`)).toBeUndefined(); // expired and unused: no longer an integration
  });
});

describe('integration health alerts', () => {
  it('alerts the administrators who can fix an integration when it turns unhealthy, and when it recovers', async () => {
    await pauseSchedule();
    let code = 500;
    const rx = await receiver(() => code);
    const monitor = await receiver(() => 200);
    try {
      const developer = await adminSession(t, ['developer']);
      const billing = await adminSession(t, ['billing_manager']);
      const ep = await call(t, admin, 'POST', '/api/admin/webhooks', { url: rx.url, events: ['user.created', 'integration.*'] });
      await call(t, admin, 'POST', '/api/admin/webhooks', { url: monitor.url, events: ['integration.*'] });
      await call(t, admin, 'POST', '/api/admin/users', { email: 'alert@example.com' });
      await t.app.worker.runUntilIdle();
      const key = `webhook:${ep.id}`;
      const alerts = (type: string) => t.app.db.many<any>(sql`SELECT recipient_id, title, body, severity, link FROM notifications WHERE type = ${type} AND data->>'key' = ${key}`);

      const first = await call(t, developer, 'POST', '/api/admin/integration-health/run');
      expect(first.changes).toContainEqual({ key, change: 'unhealthy', status: 'degraded' });
      const raised = await alerts('integration.unhealthy');
      expect(raised.map((n) => n.recipient_id).sort()).toEqual([admin.adminId, developer.adminId].sort());
      expect(raised.map((n) => n.recipient_id)).not.toContain(billing.adminId);
      expect(raised[0]).toMatchObject({ title: `Webhook endpoint ${rx.url} needs attention`, severity: 'warning', link: '/platform/health' });
      expect(raised[0].body).toContain('HTTP 500');
      // The event reaches other subscribers, but never the failing endpoint it is about.
      await t.app.worker.runUntilIdle();
      expect(monitor.received.map((e) => [e.type, e.data.key, e.data.status])).toEqual([['integration.unhealthy', key, 'degraded']]);
      expect(rx.received.map((e) => e.type)).toEqual(['user.created']);

      // The same state on the next run is not announced again.
      expect((await call(t, developer, 'POST', '/api/admin/integration-health/run')).changes).toEqual([]);
      expect(await alerts('integration.unhealthy')).toHaveLength(2);

      // The endpoint recovers once its scheduled retry succeeds.
      code = 200;
      t.clock.advance(2 * MINUTE);
      await t.app.worker.runUntilIdle();
      const after = await call(t, developer, 'POST', '/api/admin/integration-health/run');
      expect(after.changes).toEqual([{ key, change: 'recovered', status: 'ok' }]);
      const recovered = await alerts('integration.recovered');
      expect(recovered).toHaveLength(2);
      expect(recovered[0]).toMatchObject({ title: `Webhook endpoint ${rx.url} is healthy again`, severity: 'success' });
      const events = await t.app.db.many<{ type: string; data: any }>(sql`SELECT type, data FROM events WHERE type LIKE 'integration.%' AND data->>'key' = ${key} ORDER BY created_at, id`);
      expect(events.map((e) => [e.type, e.data.status, e.data.previousStatus])).toEqual([
        ['integration.unhealthy', 'degraded', null],
        ['integration.recovered', 'ok', 'degraded'],
      ]);
      expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'integration_health.run'`)).n).toBe(3);
    } finally {
      await rx.close();
      await monitor.close();
    }
  });

  it('does not repeat an alert the owning module already sent, and can be silenced', async () => {
    await pauseSchedule();
    await call(t, admin, 'PATCH', '/api/admin/settings/developers', { webhookMaxAttempts: 1, webhookAutoDisableAfter: 1 });
    const rx = await receiver(() => 500);
    try {
      const ep = await call(t, admin, 'POST', '/api/admin/webhooks', { url: rx.url, events: ['user.created'] });
      await call(t, admin, 'POST', '/api/admin/users', { email: 'disabled@example.com' });
      await t.app.worker.runUntilIdle();
      // attemptDelivery() disabled the endpoint and told the administrators.
      expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'webhook.disabled'`)).n).toBeGreaterThan(0);
      const run = await call(t, admin, 'POST', '/api/admin/integration-health/run');
      expect(run.changes).toContainEqual({ key: `webhook:${ep.id}`, change: 'unhealthy', status: 'down' });
      expect(check(run, `webhook:${ep.id}`)).toMatchObject({ status: 'down', summary: 'Disabled after 1 consecutive failed deliveries' });
      expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'integration.unhealthy'`)).n).toBe(0);
      expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM events WHERE type = 'integration.unhealthy'`)).n).toBe(1);

      // With alerts off, changes are still recorded and published as events.
      await call(t, admin, 'PATCH', '/api/admin/settings/integrationHealth', { alerts: false });
      const now = t.clock.now();
      await t.app.db.exec(sql.insert('jobs', { id: newId('job'), type: 'reports.deliver', payload: {}, status: 'dead', attempts: 3, max_attempts: 3, run_at: now, last_error: 'Timeout', created_at: now, updated_at: now }, ''));
      expect((await call(t, admin, 'POST', '/api/admin/integration-health/run')).changes).toContainEqual({ key: 'jobs', change: 'unhealthy', status: 'degraded' });
      expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'integration.unhealthy'`)).n).toBe(0);
      expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM events WHERE type = 'integration.unhealthy'`)).n).toBe(2);
    } finally {
      await rx.close();
    }
  });

  it('runs on a schedule and forgets integrations that were removed', async () => {
    const task = await t.app.db.one<any>(sql`SELECT * FROM scheduled_tasks WHERE key = 'developers.integration_health'`);
    expect(task).toMatchObject({ job_type: 'developers.integration_health', interval_seconds: 300, module: 'developers', enabled: true });
    const ep = await call(t, admin, 'POST', '/api/admin/webhooks', { url: 'https://hooks.example.com/x', events: ['user.deleted'] });
    await t.app.db.exec(sql`UPDATE scheduled_tasks SET next_run_at = ${new Date(t.clock.now().getTime() - 1000)} WHERE key = 'developers.integration_health'`);
    await t.app.worker.runUntilIdle();
    expect(await t.app.db.maybe(sql`SELECT status FROM integration_health WHERE key = ${`webhook:${ep.id}`}`)).toEqual({ status: 'ok' });
    await call(t, admin, 'DELETE', `/api/admin/webhooks/${ep.id}`);
    await call(t, admin, 'POST', '/api/admin/integration-health/run');
    expect(await t.app.db.maybe(sql`SELECT status FROM integration_health WHERE key = ${`webhook:${ep.id}`}`)).toBeNull();
  });

  it('classifies state changes', () => {
    expect(classifyChange(null, 'ok')).toBeNull();
    expect(classifyChange(null, 'degraded')).toBe('unhealthy');
    expect(classifyChange('ok', 'down')).toBe('unhealthy');
    expect(classifyChange('unknown', 'degraded')).toBe('unhealthy');
    expect(classifyChange('degraded', 'down')).toBe('unhealthy');
    expect(classifyChange('down', 'degraded')).toBeNull();
    expect(classifyChange('down', 'ok')).toBe('recovered');
    expect(classifyChange('degraded', 'disabled')).toBeNull();
    expect(classifyChange('disabled', 'ok')).toBeNull();
  });
});

describe('integration health access', () => {
  it('limits organization-scoped administrators and keys to their own integrations, behind permissions', async () => {
    const orgA = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'A' });
    const orgB = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'B' });
    const epA = await call(t, admin, 'POST', '/api/admin/webhooks', { url: 'https://hooks.example.com/a', events: ['user.deleted'], orgId: orgA.id });
    const epB = await call(t, admin, 'POST', '/api/admin/webhooks', { url: 'https://hooks.example.com/b', events: ['user.deleted'], orgId: orgB.id });
    const keyA = await apiKey({ name: 'A monitor', scopes: ['health:read'], orgId: orgA.id });
    const keyB = await apiKey({ name: 'B backend', orgId: orgB.id });
    const monitor = await apiKey({ name: 'Monitor', scopes: ['health:read'] });
    const usersOnly = await apiKey({ name: 'Users', scopes: ['users:read'] });

    const scopedAdmin = await adminSession(t, ['super_admin'], [orgA.id]);
    const mine = await report(scopedAdmin);
    expect(mine.scoped).toBe(true);
    expect(mine.groups.map((g: any) => g.kind)).toEqual(['webhook', 'api_key']);
    const seen = mine.groups.flatMap((g: any) => g.checks).map((c: any) => c.key);
    expect(seen).toContain(`webhook:${epA.id}`);
    expect(seen).toContain(`api_key:${keyA.id}`);
    for (const hidden of [`webhook:${epB.id}`, `api_key:${keyB.id}`, `api_key:${monitor.id}`, 'api_keys:unknown', 'jobs']) expect(seen).not.toContain(hidden);
    expect((await report()).groups).toHaveLength(6);

    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/integration-health', as: support })).status).toBe(403);
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/integration-health', as: analyst })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: '/api/admin/integration-health/run', as: analyst })).status).toBe(403);
    expect((await t.request({ method: 'PATCH', url: '/api/admin/settings/integrationHealth', as: analyst, body: { alerts: false } })).status).toBe(403);
    const developer = await adminSession(t, ['developer']);
    expect((await t.request({ method: 'POST', url: '/api/admin/integration-health/run', as: developer })).status).toBe(200);

    const platform = await t.request({ url: '/api/v1/integration-health', bearer: monitor.secret });
    expect(platform.status).toBe(200);
    expect(platform.body.groups).toHaveLength(6);
    expect((await t.request({ url: '/api/v1/integration-health', bearer: usersOnly.secret })).body.error.code).toBe('insufficient_scope');
    const tenant = await t.request({ url: '/api/v1/integration-health', bearer: keyA.secret });
    expect(tenant.body.scoped).toBe(true);
    expect(tenant.body.groups.flatMap((g: any) => g.checks).map((c: any) => c.key)).not.toContain(`webhook:${epB.id}`);
  });
});
