import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call } from '../../test/fixtures.js';
import { raiseSecurityEvent } from './alerts.js';

let t: TestPlatform;
let admin: AdminSession;
let key: string;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
  key = await apiKey(t, admin, ['events:write', 'users:read', 'users:write', 'orgs:write']);
});
afterEach(async () => {
  await t.close();
});

describe('organization-scoped security views', () => {
  it("shows scoped admins only their customers' sign-ins and alerts, and keeps platform IP rules from them", async () => {
    const orgRes = await t.request({ method: 'POST', url: '/api/v1/organizations', bearer: key, body: { name: 'Acme' } });
    expect(orgRes.status).toBe(201);
    const org = orgRes.body.organization;
    const member = await apiUser(t, key, 'member@acme.test');
    const outsider = await apiUser(t, key, 'outsider@example.com');
    const mem = await t.request({ method: 'PUT', url: `/api/v1/organizations/${org.id}/members/${member.id}`, bearer: key, body: { role: 'member' } });
    expect(mem.status).toBe(200);
    for (const u of [member, outsider]) {
      await t.request({ method: 'POST', url: `/api/v1/users/${u.id}/login-events`, bearer: key, body: { success: false, ip: '203.0.113.7' } });
      await raiseSecurityEvent(t.app.db, t.app, { type: 'test.alert', severity: 'warning', subjectType: 'user', subjectId: u.id, ip: '203.0.113.7' });
    }
    await call(t, admin, 'POST', '/api/admin/security/ip-rules', { cidr: '198.51.100.0/24', action: 'block', scope: 'api' });

    const scoped = await adminSession(t, ['analyst'], [org.id]);
    const logins = await call(t, scoped, 'GET', '/api/admin/security/login-events');
    expect(logins.data.map((e: any) => e.subject_id)).toEqual([member.id]);
    const events = await call(t, scoped, 'GET', '/api/admin/security/events', undefined);
    expect(events.data.map((e: any) => e.subject_id)).toEqual([member.id]);
    const overview = await call(t, scoped, 'GET', '/api/admin/security/overview');
    expect(overview).toMatchObject({ failedLogins24h: 1, openEvents: { warning: 1 }, blockedIps: null, lockedAdmins: null });
    const rules = await t.request({ url: '/api/admin/security/ip-rules', as: scoped });
    expect(rules.status).toBe(403);
    expect(rules.body.error.code).toBe('org_scope');
    const outsiderEvent = (await call(t, admin, 'GET', '/api/admin/security/events')).data.find((e: any) => e.subject_id === outsider.id);
    const ack = await t.request({ method: 'PATCH', url: `/api/admin/security/events/${outsiderEvent.id}`, as: await adminSession(t, ['admin'], [org.id]), body: { status: 'resolved' } });
    expect(ack.status).toBe(404);

    // Unscoped administrators still see everything.
    expect((await call(t, admin, 'GET', '/api/admin/security/login-events?subjectType=user')).total).toBe(2);
    expect((await call(t, admin, 'GET', '/api/admin/security/overview')).blockedIps).toBe(1);
  });
});
