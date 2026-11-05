import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { MINUTE } from '../../core/clock.js';
import { notifyAdmins } from '../iam/notify.js';
import { allModules } from '../index.js';
import { emailModule } from '../email/module.js';
import { notificationsModule } from './module.js';
import { marketingModule } from '../marketing/module.js';
import { b64u, decryptPayload, encryptPayload, fromB64u, generateVapidKeys, vapidAuthorization } from './webpush.js';

const modules = [...new Set([...allModules, emailModule, notificationsModule, marketingModule])];

describe('web push cryptography', () => {
  it('matches the RFC 8291 Appendix A test vector', () => {
    const body = encryptPayload({
      uaPublic: fromB64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      authSecret: fromB64u('BTBZMqHH6r4Tts7J_aSIgg'),
      plaintext: Buffer.from('When I grow up, I want to be a watermelon'),
      asPrivate: fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw'),
      recordSize: 4096,
    });
    expect(b64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    const plain = decryptPayload(body, fromB64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), fromB64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), fromB64u('BTBZMqHH6r4Tts7J_aSIgg'));
    expect(plain.toString()).toBe('When I grow up, I want to be a watermelon');
  });

  it('signs VAPID JWTs that verify with the public key', () => {
    const keys = generateVapidKeys();
    const now = Math.floor(Date.now() / 1000);
    const header = vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:ops@example.com', now);
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toEqual({ aud: 'https://fcm.googleapis.com', exp: now + 12 * 3600, sub: 'mailto:ops@example.com' });
    const pub = fromB64u(keys.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(s))).toBe(true);
  });
});

describe('notification center and push delivery', () => {
  let t: TestPlatform;
  let admin: AdminSession;
  let key: string;
  beforeEach(async () => {
    t = await createTestPlatform({ modules });
    admin = await adminSession(t);
    key = (await call(t, admin, 'POST', '/api/admin/api-keys', { name: 'app', scopes: ['*'] })).secret;
  });
  afterEach(async () => {
    await t.close();
  });

  async function user(email: string) {
    return (await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email } })).body.user as { id: string };
  }
  async function session(userId: string) {
    return (await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId } })).body.token as string;
  }
  function browserKeys() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = randomBytes(16);
    return { ecdh, auth, p256dh: b64u(ecdh.getPublicKey()), authB64: b64u(auth) };
  }
  type PushCall = { url: string; headers: Record<string, string>; body: Buffer };
  function fakePush(statuses: number[]) {
    const calls: PushCall[] = [];
    t.app.services['push.fetch'] = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: statuses.shift() ?? 201 });
    }) as typeof fetch;
    return calls;
  }

  it('creates notifications through the API and lets customers read them', async () => {
    const u = await user('reader@example.com');
    const token = await session(u.id);
    const limited = (await call(t, admin, 'POST', '/api/admin/api-keys', { name: 'ro', scopes: ['users:read'] })).secret;
    expect((await t.request({ method: 'POST', url: '/api/v1/notifications', bearer: limited, body: { userId: u.id, title: 'x' } })).status).toBe(403);
    const created = await t.request({ method: 'POST', url: '/api/v1/notifications', bearer: key, body: { userId: u.id, title: 'Export ready', body: 'Your CSV is ready', link: 'https://app.example.com/exports/1' } });
    expect(created.status).toBe(201);
    const list = await t.request({ url: '/api/client/notifications', bearer: token });
    expect(list.body).toMatchObject({ unread: 1, total: 1 });
    expect(list.body.data[0]).toMatchObject({ title: 'Export ready', readAt: null });
    await t.request({ method: 'POST', url: '/api/client/notifications/read', bearer: token, body: { all: true } });
    expect((await t.request({ url: '/api/client/notifications', bearer: token })).body.unread).toBe(0);
    const other = await user('other@example.com');
    expect((await t.request({ url: '/api/client/notifications', bearer: await session(other.id) })).body.total).toBe(0);
  });

  it('encrypts pushes so only the browser can read them, and drops gone subscriptions', async () => {
    const u = await user('push@example.com');
    const token = await session(u.id);
    const b = browserKeys();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1';
    const bad = await t.request({ method: 'POST', url: '/api/client/push/subscriptions', bearer: token, body: { endpoint: 'https://169.254.169.254/latest', keys: { p256dh: b.p256dh, auth: b.authB64 } } });
    expect(bad.status).toBe(422);
    const plain = await t.request({ method: 'POST', url: '/api/client/push/subscriptions', bearer: token, body: { endpoint: 'http://fcm.googleapis.com/x', keys: { p256dh: b.p256dh, auth: b.authB64 } } });
    expect(plain.status).toBe(422);
    expect((await t.request({ method: 'POST', url: '/api/client/push/subscriptions', bearer: token, body: { endpoint, keys: { p256dh: b.p256dh, auth: b.authB64 } } })).status).toBe(200);

    const calls = fakePush([201, 410]);
    await t.request({ method: 'POST', url: '/api/v1/notifications', bearer: key, body: { userId: u.id, title: 'Deploy finished', severity: 'critical' } });
    await t.app.worker.runUntilIdle();
    expect(calls).toHaveLength(1);
    const { publicKey } = (await t.request({ url: '/api/public/push/vapid-public-key' })).body;
    expect(fromB64u(publicKey)).toHaveLength(65);
    expect(calls[0].url).toBe(endpoint);
    expect(calls[0].headers).toMatchObject({ 'content-encoding': 'aes128gcm', urgency: 'high', ttl: '86400' });
    expect(calls[0].headers.authorization).toMatch(new RegExp(`^vapid t=.+, k=${publicKey}$`));
    const payload = JSON.parse(decryptPayload(calls[0].body, b.ecdh.getPrivateKey(), b.ecdh.getPublicKey(), b.auth).toString());
    expect(payload).toMatchObject({ title: 'Deploy finished', severity: 'critical' });

    await t.request({ method: 'POST', url: '/api/v1/notifications', bearer: key, body: { userId: u.id, title: 'Second' } });
    await t.app.worker.runUntilIdle();
    expect(await t.app.db.maybe(sql`SELECT 1 FROM push_subscriptions WHERE endpoint = ${endpoint}`)).toBeNull();
  });

  it('retries pushes the push service rejects temporarily', async () => {
    const u = await user('retry@example.com');
    const b = browserKeys();
    await t.request({ method: 'POST', url: '/api/client/push/subscriptions', bearer: await session(u.id), body: { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', keys: { p256dh: b.p256dh, auth: b.authB64 } } });
    const calls = fakePush([503, 201]);
    await t.request({ method: 'POST', url: '/api/v1/notifications', bearer: key, body: { userId: u.id, title: 'Hello' } });
    await t.app.worker.runUntilIdle();
    t.clock.advance(5 * MINUTE);
    await t.app.worker.runUntilIdle();
    expect(calls).toHaveLength(2);
    expect((await t.app.db.one(sql`SELECT status, attempts FROM push_deliveries`))).toEqual({ status: 'sent', attempts: 2 });
  });

  it('notifies organization owners about usage alerts once per event', async () => {
    const owner = await user('owner@example.com');
    const member = await user('member@example.com');
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Acme', ownerUserId: owner.id });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: member.id, role: 'member' });
    await t.app.db.tx((tx) => t.app.events.emit(tx, 'usage.limit_reached', { subjectType: 'organization', subjectId: org.id, meter: 'api_calls', used: 100, limit: 100 }, { orgId: org.id }));
    await t.app.worker.runUntilIdle();
    const rows = await t.app.db.many(sql`SELECT recipient_id, type, severity FROM notifications WHERE recipient_type = 'user'`);
    expect(rows).toEqual([{ recipient_id: owner.id, type: 'usage.limit_reached', severity: 'critical' }]);
  });

  it('pushes admin notifications to subscribed admins', async () => {
    const b = browserKeys();
    await call(t, admin, 'POST', '/api/admin/push/subscriptions', { endpoint: 'https://web.push.apple.com/QAbc', keys: { p256dh: b.p256dh, auth: b.authB64 } });
    const calls = fakePush([201]);
    await t.app.db.tx((tx) => notifyAdmins(tx, t.app, { permission: 'security.events.view', type: 'security.alert', title: 'Brute force detected', severity: 'critical' }));
    await t.app.jobs.enqueue(t.app.db, 'push.admin_scan', {});
    await t.app.worker.runUntilIdle();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(decryptPayload(calls[0].body, b.ecdh.getPrivateKey(), b.ecdh.getPublicKey(), b.auth).toString()).title).toBe('Brute force detected');
    await t.app.jobs.enqueue(t.app.db, 'push.admin_scan', {});
    await t.app.worker.runUntilIdle();
    expect(calls).toHaveLength(1);
  });
});
