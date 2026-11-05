import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { MINUTE } from '../../core/clock.js';
import { networkOf } from './sharing.js';

let t: TestPlatform;
let admin: AdminSession;
let key: string;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
  key = await apiKey(t, admin, ['events:write', 'users:read', 'users:write', 'customer_sessions:write']);
});
afterEach(async () => {
  await t.close();
});

function reportLogin(userId: string, ip: string, extra: Record<string, unknown> = {}) {
  return t.request({ method: 'POST', url: `/api/v1/users/${userId}/login-events`, bearer: key, body: { success: true, ip, ...extra } });
}

describe('account sharing', () => {
  it('flags accounts above the limit, says addresses are only a signal, and counts afresh after review', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/accountSharing', { maxAddresses: 3, trustedNetworks: ['192.0.2.0/24'] });
    const user = await apiUser(t, key, 'shared@example.com');
    for (const ip of ['198.51.100.1', '198.51.100.2', '203.0.113.3', '192.0.2.10', '192.0.2.11']) {
      expect((await reportLogin(user.id, ip)).body).toMatchObject({ ok: true, allowed: true });
    }
    // Three counted addresses (the trusted office network is ignored): at the limit, not over it.
    expect((await call(t, admin, 'GET', '/api/admin/security/account-sharing')).total).toBe(0);

    await reportLogin(user.id, '203.0.113.4');
    const flags = await call(t, admin, 'GET', '/api/admin/security/account-sharing');
    expect(flags.total).toBe(1);
    expect(flags.caveat).toMatch(/signal, not proof/);
    const flag = flags.data[0];
    expect(flag).toMatchObject({ userId: user.id, email: 'shared@example.com', status: 'open', distinctCount: 4, maxAllowed: 3, action: 'alert', blockedUntil: null });
    expect(flag.addresses.map((a: any) => a.ip).sort()).toEqual(['198.51.100.1', '198.51.100.2', '203.0.113.3', '203.0.113.4']);
    const event = await t.app.db.one(sql`SELECT * FROM security_events WHERE id = ${flag.securityEventId}`);
    expect(event).toMatchObject({ type: 'account_sharing.suspected', severity: 'warning', subject_type: 'user', subject_id: user.id, status: 'open' });
    expect(event.details.note).toMatch(/signal, not proof/);
    await t.app.worker.runUntilIdle();
    expect((await t.app.db.many(sql`SELECT 1 FROM notifications WHERE recipient_id = ${admin.adminId} AND type = 'security.alert'`)).length).toBe(1);
    expect((await t.app.db.one(sql`SELECT data FROM events WHERE type = 'user.sharing_flagged'`)).data).toMatchObject({ userId: user.id, distinctAddresses: 4 });

    // While a flag is open, more addresses update it instead of raising new alerts.
    await reportLogin(user.id, '203.0.113.5');
    const updated = await call(t, admin, 'GET', '/api/admin/security/account-sharing');
    expect(updated.data).toHaveLength(1);
    expect(updated.data[0].distinctCount).toBe(5);

    const cleared = await call(t, admin, 'POST', `/api/admin/security/account-sharing/${flag.id}/clear`, { note: 'Family plan, confirmed by phone' });
    expect(cleared).toMatchObject({ status: 'cleared', clearNote: 'Family plan, confirmed by phone' });
    expect((await t.app.db.one(sql`SELECT status FROM security_events WHERE id = ${flag.securityEventId}`)).status).toBe('resolved');
    expect((await t.request({ method: 'POST', url: `/api/admin/security/account-sharing/${flag.id}/clear`, as: admin, body: {} })).status).toBe(409);
    // Counting restarts at the review: one new address is far from the limit.
    await reportLogin(user.id, '203.0.113.6');
    expect((await call(t, admin, 'GET', '/api/admin/security/account-sharing')).total).toBe(0);

    const history = await call(t, admin, 'GET', `/api/admin/users/${user.id}/ip-addresses`);
    expect(history.addresses).toHaveLength(8);
    expect(history.addresses.find((a: any) => a.ip === '192.0.2.10')).toMatchObject({ trusted: true, sources: ['app_login'] });
    expect(history.flags.map((f: any) => f.status)).toEqual(['cleared']);
  });

  it('can sign the customer out and pause sign-ins for a cooling-off period', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/accountSharing', { maxAddresses: 2, action: 'block_logins', cooldownMinutes: 30 });
    const user = await apiUser(t, key, 'blocked@example.com');
    await reportLogin(user.id, '198.51.100.1', { sessionId: 'app-session-1' });
    await reportLogin(user.id, '198.51.100.2');
    const third = await reportLogin(user.id, '198.51.100.3');
    expect(third.body).toMatchObject({ ok: true, allowed: false, reason: 'account_sharing_cooldown' });
    expect(await t.app.db.one(sql`SELECT revoked_reason FROM user_sessions WHERE user_id = ${user.id}`)).toEqual({ revoked_reason: 'account_sharing' });
    expect((await t.request({ url: `/api/v1/users/${user.id}/status`, bearer: key })).body).toMatchObject({ allowed: false, reason: 'account_sharing_cooldown' });
    expect((await t.app.db.one(sql`SELECT action FROM audit_logs WHERE action = 'user.sharing_flag'`)).action).toBe('user.sharing_flag');

    t.clock.advance(31 * MINUTE);
    expect((await t.request({ url: `/api/v1/users/${user.id}/status`, bearer: key })).body).toMatchObject({ allowed: true });
  });

  it('can count networks instead of addresses, to tolerate carriers rotating addresses', async () => {
    expect(networkOf('198.51.100.77')).toBe('198.51.100.0/24');
    expect(networkOf('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(networkOf('::ffff:203.0.113.9')).toBe('203.0.113.0/24');
    await call(t, admin, 'PATCH', '/api/admin/settings/accountSharing', { maxAddresses: 2, countBy: 'network' });
    const user = await apiUser(t, key, 'mobile@example.com');
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '2001:db8:abcd:1::5', '2001:db8:abcd:2::9']) await reportLogin(user.id, ip);
    expect((await call(t, admin, 'GET', '/api/admin/security/account-sharing')).total).toBe(0);
    await reportLogin(user.id, '203.0.113.50');
    expect((await call(t, admin, 'GET', '/api/admin/security/account-sharing')).data[0]).toMatchObject({ distinctCount: 3, countBy: 'network' });
  });

  it('records the addresses customers use on the client API', async () => {
    const user = await apiUser(t, key, 'browser@example.com');
    const session = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId: user.id } });
    expect((await t.request({ url: '/api/client/me', bearer: session.body.token, ip: '198.51.100.77', headers: { 'user-agent': 'Safari' } })).status).toBe(200);
    expect((await t.request({ url: '/api/client/me', bearer: session.body.token, ip: '198.51.100.77' })).status).toBe(200);
    const history = await call(t, admin, 'GET', `/api/admin/users/${user.id}/ip-addresses`);
    expect(history.addresses).toEqual([expect.objectContaining({ ip: '198.51.100.77', sources: ['client_api'], hits: 1, userAgent: 'Safari' })]);
  });

  it('enforces permissions, organization scope and a valid policy', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/accountSharing', { maxAddresses: 2 });
    const orgA = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'A' });
    const orgB = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'B' });
    const inA = await call(t, admin, 'POST', '/api/admin/users', { email: 'a@example.com', orgId: orgA.id });
    const inB = await call(t, admin, 'POST', '/api/admin/users', { email: 'b@example.com', orgId: orgB.id });
    for (const user of [inA, inB]) for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await reportLogin(user.id, ip);

    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/security/account-sharing', as: support })).status).toBe(403);
    expect((await t.request({ url: `/api/admin/users/${inA.id}/ip-addresses`, as: support })).status).toBe(403);
    const analyst = await adminSession(t, ['analyst']);
    const visible = await call(t, analyst, 'GET', '/api/admin/security/account-sharing');
    expect(visible.total).toBe(2);
    expect((await t.request({ method: 'POST', url: `/api/admin/security/account-sharing/${visible.data[0].id}/clear`, as: analyst, body: {} })).status).toBe(403);

    const scoped = await adminSession(t, ['admin'], [orgA.id]);
    const scopedList = await call(t, scoped, 'GET', '/api/admin/security/account-sharing');
    expect(scopedList.data.map((f: any) => f.userId)).toEqual([inA.id]);
    const flagB = visible.data.find((f: any) => f.userId === inB.id);
    expect((await t.request({ method: 'POST', url: `/api/admin/security/account-sharing/${flagB.id}/clear`, as: scoped, body: {} })).status).toBe(404);
    expect((await t.request({ url: `/api/admin/users/${inB.id}/ip-addresses`, as: scoped })).status).toBe(404);

    expect((await t.request({ method: 'PATCH', url: '/api/admin/settings/accountSharing', as: admin, body: { trustedNetworks: ['not-a-network'] } })).status).toBe(422);
    expect((await t.request({ method: 'PATCH', url: '/api/admin/settings/accountSharing', as: support, body: { enabled: false } })).status).toBe(403);
  });

  it('exports and erases address history with the rest of the personal data', async () => {
    const user = await apiUser(t, key, 'private@example.com');
    await reportLogin(user.id, '198.51.100.9');
    const exported = await call(t, admin, 'GET', `/api/admin/users/${user.id}/export`);
    expect(exported.ipAddresses).toEqual([expect.objectContaining({ ip: '198.51.100.9' })]);
    await call(t, admin, 'POST', `/api/admin/users/${user.id}/anonymize`, { confirm: 'ERASE' });
    expect(await t.app.db.many(sql`SELECT 1 FROM customer_ip_addresses WHERE user_id = ${user.id}`)).toEqual([]);
  });
});
