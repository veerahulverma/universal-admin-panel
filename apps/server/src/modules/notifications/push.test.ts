import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, HOUR } from '../../core/clock.js';
import { allModules } from '../index.js';
import { emailModule } from '../email/module.js';
import { notificationsModule } from './module.js';
import { marketingModule } from '../marketing/module.js';
import { registerPushProvider, type PushMessage, type PushRecipientResult } from './providers.js';

const modules = [...new Set([...allModules, emailModule, notificationsModule, marketingModule])];

let t: TestPlatform;
let admin: AdminSession;
let key: string;
beforeEach(async () => {
  t = await createTestPlatform({ modules });
  admin = await adminSession(t);
  key = await apiKey(t, admin);
});
afterEach(async () => {
  await t.close();
});

const sentAll = (m: PushMessage) => ({ results: m.recipients.map((r): PushRecipientResult => ({ userId: r.userId, status: 'sent', providerMessageId: `msg-${r.userId}` })) });

function provider(key: string, targets: 'users' | 'devices', send: (m: PushMessage) => { results: PushRecipientResult[] } = sentAll, configured = true) {
  const calls: PushMessage[] = [];
  registerPushProvider(t.app, {
    key,
    name: key,
    description: '',
    targets,
    status: async () => ({ configured, message: configured ? 'ready' : 'missing credentials' }),
    send: async (m) => {
      calls.push(m);
      return send(m);
    },
  }, 'test');
  return calls;
}

const notify = (userIds: string[], title = 'Hello') => call(t, admin, 'POST', '/api/admin/user-notifications', { userIds, title, body: 'There', link: 'https://app.example.com/x' });
const session = async (userId: string) => (await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId } })).body.token as string;
const deliveries = () => t.app.db.many<any>(sql`SELECT provider, user_id, status, error, provider_message_id FROM push_provider_deliveries ORDER BY created_at, id`);

describe('push providers', () => {
  it('delivers through a provider that finds customers by id, and retries an outage before giving up', async () => {
    const calls = provider('fakeos', 'users');
    const ada = await apiUser(t, key, 'ada@example.com');
    await notify([ada.id]);
    await t.app.worker.runUntilIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ title: 'Hello', body: 'There', link: 'https://app.example.com/x', recipients: [{ userId: ada.id, externalId: null, devices: [] }] });
    expect(await deliveries()).toEqual([{ provider: 'fakeos', user_id: ada.id, status: 'sent', error: null, provider_message_id: `msg-${ada.id}` }]);

    provider('flaky', 'users', () => {
      throw new Error('provider down');
    });
    await notify([ada.id], 'Second');
    await t.app.worker.runUntilIdle();
    const pending = (await deliveries()).find((d) => d.provider === 'flaky');
    expect(pending).toMatchObject({ status: 'pending', error: 'provider down' });
    for (let i = 0; i < 6; i++) {
      t.clock.advance(7 * HOUR);
      await t.app.worker.runUntilIdle();
    }
    expect((await deliveries()).find((d) => d.provider === 'flaky')).toMatchObject({ status: 'failed', error: 'provider down' });
  });

  it('sends to registered devices only, moves a token between customers, and forgets invalid devices', async () => {
    const calls = provider('fakefcm', 'devices', (m) => ({ results: [{ userId: m.recipients[0].userId, status: 'sent', invalidDeviceIds: [m.recipients[0].devices.find((d) => d.token === 'stale-token')!.id] }] }));
    const ada = await apiUser(t, key, 'ada@example.com');
    const bob = await apiUser(t, key, 'bob@example.com');
    const token = await session(ada.id);
    for (const [deviceToken, platform] of [['phone-token', 'android'], ['stale-token', 'ios']]) {
      const res = await t.request({ method: 'POST', url: '/api/client/push/devices', bearer: token, body: { provider: 'fakefcm', token: deviceToken, platform } });
      expect(res.status).toBe(200);
    }
    // The same install signing in as someone else moves the token.
    await t.request({ method: 'POST', url: `/api/v1/users/${bob.id}/push-devices`, bearer: key, body: { provider: 'fakefcm', token: 'bob-token', platform: 'web' } });
    expect((await t.request({ method: 'POST', url: '/api/client/push/devices', bearer: key, body: { provider: 'fakefcm', token: 'x'.repeat(10) } })).status).toBe(401);

    await notify([ada.id]);
    await t.app.worker.runUntilIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0].recipients[0].devices.map((d) => d.token).sort()).toEqual(['phone-token', 'stale-token']);
    expect((await t.app.db.many<{ token: string }>(sql`SELECT token FROM push_devices WHERE user_id = ${ada.id}`)).map((d) => d.token)).toEqual(['phone-token']);

    const carol = await apiUser(t, key, 'carol@example.com');
    await notify([carol.id], 'No devices');
    await t.app.worker.runUntilIdle();
    expect((await deliveries()).filter((d) => d.user_id === carol.id)).toEqual([]);
  });

  it('leaves out providers that are not configured and shows every channel in the overview', async () => {
    provider('unset', 'users', sentAll, false);
    const ada = await apiUser(t, key, 'ada@example.com');
    await notify([ada.id]);
    await t.app.worker.runUntilIdle();
    expect(await deliveries()).toEqual([]);
    const overview = await call(t, admin, 'GET', '/api/admin/push/overview');
    expect(overview).toMatchObject({ pushEnabled: true, browsers: { subscriptions: 0 }, providers: [{ key: 'unset', configured: false, message: 'missing credentials', plugin: null }] });
    const channels = await call(t, admin, 'GET', `/api/admin/users/${ada.id}/push-channels`);
    expect(channels).toMatchObject({ browsers: [], devices: [], providers: [] });
  });
});

describe('push campaigns', () => {
  it('sends to consenting customers for marketing and to everyone for announcements, with delivery figures', async () => {
    provider('fakeos', 'users');
    const [a, b, c] = [await apiUser(t, key, 'a@example.com'), await apiUser(t, key, 'b@example.com'), await apiUser(t, key, 'c@example.com')];
    await t.app.db.exec(sql`UPDATE users SET marketing_consent = TRUE WHERE id IN ${sql.in([a.id, b.id])}`);
    expect(await call(t, admin, 'POST', '/api/admin/push/audience-preview', { audience: { type: 'all' }, kind: 'marketing' })).toEqual({ recipients: 2, reachable: 2 });

    const sale = await call(t, admin, 'POST', '/api/admin/push/campaigns', { title: 'Spring sale', body: '20% off this week', kind: 'marketing', audience: { type: 'all' } });
    expect(sale).toMatchObject({ status: 'scheduled', audienceLabel: 'All customers (marketing consent only)' });
    await t.app.worker.runUntilIdle();
    expect(await call(t, admin, 'GET', `/api/admin/push/campaigns/${sale.id}`)).toMatchObject({ status: 'sent', recipients: 2, stats: { notified: 2, pushSent: 2, pushFailed: 0 } });
    const reached = await t.app.db.many<{ recipient_id: string }>(sql`SELECT recipient_id FROM notifications WHERE data->>'campaignId' = ${sale.id} ORDER BY recipient_id`);
    expect(reached.map((n) => n.recipient_id).sort()).toEqual([a.id, b.id].sort());

    const notice = await call(t, admin, 'POST', '/api/admin/push/campaigns', { title: 'New feature', kind: 'announcement', audience: { type: 'all' } });
    await t.app.worker.runUntilIdle();
    expect((await call(t, admin, 'GET', `/api/admin/push/campaigns/${notice.id}`)).recipients).toBe(3);
    const list = await call(t, admin, 'GET', '/api/admin/push/campaigns');
    expect(list.data.map((x: any) => x.title)).toEqual(['New feature', 'Spring sale']);
    expect(c.id).toBeTruthy();
  });

  it('holds scheduled sends until their time, and cancelled ones never go out', async () => {
    const ada = await apiUser(t, key, 'ada@example.com');
    const later = await call(t, admin, 'POST', '/api/admin/push/campaigns', { title: 'Maintenance tonight', kind: 'announcement', audience: { type: 'all' }, scheduledAt: new Date(t.clock.now().getTime() + DAY).toISOString() });
    const kept = await call(t, admin, 'POST', '/api/admin/push/campaigns', { title: 'Tomorrow', kind: 'announcement', audience: { type: 'all' }, scheduledAt: new Date(t.clock.now().getTime() + DAY).toISOString() });
    await t.app.worker.runUntilIdle();
    expect((await call(t, admin, 'GET', `/api/admin/push/campaigns/${later.id}`)).status).toBe('scheduled');
    expect((await call(t, admin, 'POST', `/api/admin/push/campaigns/${later.id}/cancel`)).status).toBe('canceled');
    expect((await t.request({ method: 'POST', url: `/api/admin/push/campaigns/${later.id}/cancel`, as: admin })).status).toBe(409);
    t.clock.advance(2 * DAY);
    await t.app.worker.runUntilIdle();
    const titles = (await t.app.db.many<{ title: string }>(sql`SELECT title FROM notifications WHERE recipient_id = ${ada.id}`)).map((n) => n.title);
    expect(titles).toEqual(['Tomorrow']);
    expect(kept.id).toBeTruthy();
  });

  it('targets customers holding a product, and keeps bulk sends from organization-scoped and unpermitted admins', async () => {
    const cat = await seedCatalog(t, admin);
    const [a, b] = [await apiUser(t, key, 'a@example.com'), await apiUser(t, key, 'b@example.com')];
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: a.id, productId: cat.pro.id, reason: 'Beta access' });
    expect(await call(t, admin, 'POST', '/api/admin/push/audience-preview', { audience: { type: 'product', productId: cat.pro.id }, kind: 'announcement' })).toMatchObject({ recipients: 1 });
    expect((await t.request({ method: 'POST', url: '/api/admin/push/campaigns', as: admin, body: { title: 'x', kind: 'announcement', audience: { type: 'product', productId: 'prod_missing' } } })).status).toBe(422);

    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Acme' });
    const scoped = await adminSession(t, ['admin'], [org.id]);
    const refused = await t.request({ method: 'POST', url: '/api/admin/push/campaigns', as: scoped, body: { title: 'x', kind: 'announcement', audience: { type: 'all' } } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('org_scope');
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/push/campaigns', as: support })).status).toBe(403);
    const marketing = await adminSession(t, ['marketing_manager']);
    expect((await t.request({ url: '/api/admin/push/campaigns', as: marketing })).status).toBe(200);
    expect(b.id).toBeTruthy();
  });
});

describe('automatic notifications', () => {
  it('announces received payments and cancellations when switched on, but not a paid-off installment plan', async () => {
    const ada = await apiUser(t, key, 'ada@example.com');
    const emit = (type: string, data: Record<string, unknown>) => t.app.db.tx((tx) => t.app.events.emit(tx, type, data, { userId: ada.id }));
    await emit('payment.succeeded', { paymentId: 'pay_0', amount: 1999, currency: 'USD' });
    await t.app.worker.runUntilIdle();
    expect(await t.app.db.many(sql`SELECT 1 FROM notifications WHERE recipient_id = ${ada.id}`)).toHaveLength(0);

    await call(t, admin, 'PATCH', '/api/admin/settings/notifications', { notifyPaymentSucceeded: true, notifySubscriptionCanceled: true });
    await emit('payment.succeeded', { paymentId: 'pay_1', amount: 1999, currency: 'USD' });
    await emit('subscription.canceled', { subscriptionId: 'sub_1', reason: 'installments_completed' });
    await emit('subscription.canceled', { subscriptionId: 'sub_2', reason: 'payment_failed' });
    await t.app.worker.runUntilIdle();
    const rows = await t.app.db.many<{ type: string; title: string; body: string }>(sql`SELECT type, title, body FROM notifications WHERE recipient_id = ${ada.id} ORDER BY created_at, id`);
    expect(rows.map((r) => r.type)).toEqual(['billing.payment_succeeded', 'subscription.canceled']);
    expect(rows[0].body).toContain('$19.99');
  });

  it('reminds customers once before a subscription renews', async () => {
    const cat = await seedCatalog(t, admin);
    const ada = await apiUser(t, key, 'ada@example.com');
    const sub = await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: ada.id, priceId: cat.proMonthly.id, collectionMethod: 'send_invoice' });
    await call(t, admin, 'PATCH', '/api/admin/settings/notifications', { notifyRenewalReminder: true, renewalReminderDays: 3 });
    const run = async () => {
      await t.app.jobs.enqueue(t.app.db, 'notifications.renewal_reminders', {});
      await t.app.worker.runUntilIdle();
    };
    const reminders = () => t.app.db.many<{ title: string }>(sql`SELECT title FROM notifications WHERE recipient_id = ${ada.id} AND type = 'subscription.renewal_reminder'`);
    await run();
    expect(await reminders()).toHaveLength(0);
    t.clock.set(new Date(new Date(sub.current_period_end).getTime() - 2 * DAY));
    await run();
    await run();
    expect((await reminders()).map((r) => r.title)).toEqual(['Your subscription renews soon']);
  });

  it('labels the settings for the console', async () => {
    const settings = await call(t, admin, 'GET', '/api/admin/settings');
    const section = settings.data.find((s: any) => s.key === 'notifications');
    expect(section.schema.properties.notifyRenewalReminder).toMatchObject({ title: 'Upcoming renewal' });
    expect(section.value).toMatchObject({ notifyPaymentSucceeded: false, notifyRenewalReminder: false, renewalReminderDays: 3 });
  });
});

describe('the push notifications plugin', () => {
  it('registers OneSignal and Firebase through the plugin host, configured from its settings and credentials', async () => {
    const row = await t.app.db.one<{ manifest: { permissions: string[] } }>(sql`SELECT manifest FROM plugins WHERE id = 'push-notifications'`);
    expect(row.manifest.permissions).toContain('push');
    await call(t, admin, 'PUT', '/api/admin/plugins/push-notifications/settings', { settings: { onesignalAppId: 'app-1' } });
    await call(t, admin, 'PUT', '/api/admin/plugins/push-notifications/secrets', { secrets: { onesignal_api_key: 'os_v2_app_test' } });
    const activated = await t.request({ method: 'POST', url: '/api/admin/plugins/push-notifications/activate', as: admin, body: { grantPermissions: row.manifest.permissions } });
    expect(activated.status).toBe(200);
    const overview = await call(t, admin, 'GET', '/api/admin/push/overview');
    expect(overview.providers).toEqual([
      expect.objectContaining({ key: 'onesignal', plugin: 'push-notifications', targets: 'users', configured: true }),
      expect.objectContaining({ key: 'firebase', plugin: 'push-notifications', targets: 'devices', configured: false }),
    ]);
    await call(t, admin, 'POST', '/api/admin/plugins/push-notifications/deactivate');
    expect((await call(t, admin, 'GET', '/api/admin/push/overview')).providers).toEqual([]);
  });
});
