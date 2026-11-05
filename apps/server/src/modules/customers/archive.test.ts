import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call, seedCatalog } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

const emails = (page: { data: { email: string }[] }) => page.data.map((u) => u.email).sort();

async function runArchiving() {
  await t.app.jobs.enqueue(t.app.db, 'customers.archive_inactive', {});
  await t.app.worker.runUntilIdle();
}

describe('inactive-user archiving', () => {
  it('archives long-inactive customers without access, hides them by default and restores them on sign-in', async () => {
    const catalog = await seedCatalog(t, admin);
    const dormant = await call(t, admin, 'POST', '/api/admin/users', { email: 'dormant@example.com' });
    const subscriber = await call(t, admin, 'POST', '/api/admin/users', { email: 'subscriber@example.com' });
    const granted = await call(t, admin, 'POST', '/api/admin/users', { email: 'granted@example.com' });
    const teamMember = await call(t, admin, 'POST', '/api/admin/users', { email: 'member@example.com' });
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: subscriber.id, priceId: catalog.proMonthly.id, collectionMethod: 'complimentary' });
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: granted.id, productId: catalog.pro.id, reason: 'Lifetime deal' });
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Team' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: teamMember.id });
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { orgId: org.id, productId: catalog.team.id, reason: 'Team trial' });

    // Off by default: nothing happens however old the accounts are.
    t.clock.advance(400 * DAY);
    admin = await adminSession(t);
    const recent = await call(t, admin, 'POST', '/api/admin/users', { email: 'recent@example.com' });
    await runArchiving();
    expect((await call(t, admin, 'GET', '/api/admin/users')).total).toBe(5);

    await call(t, admin, 'PATCH', '/api/admin/settings/customers', { archiveInactive: true, archiveAfterDays: 365 });
    await runArchiving();
    expect(emails(await call(t, admin, 'GET', '/api/admin/users'))).toEqual(['granted@example.com', 'member@example.com', 'recent@example.com', 'subscriber@example.com']);
    expect(emails(await call(t, admin, 'GET', '/api/admin/users?archived=only'))).toEqual(['dormant@example.com']);
    expect((await call(t, admin, 'GET', '/api/admin/users?archived=include')).total).toBe(5);
    const archived = await call(t, admin, 'GET', `/api/admin/users/${dormant.id}`);
    expect(archived).toMatchObject({ archived_reason: 'inactive' });
    expect((await t.app.db.many(sql`SELECT type FROM events WHERE user_id = ${dormant.id} AND type = 'user.archived'`)).length).toBe(1);
    expect((await t.app.db.one(sql`SELECT metadata FROM audit_logs WHERE action = 'user.archive_inactive'`)).metadata).toMatchObject({ count: 1, inactiveDays: 365 });
    expect(recent.id).toBeTruthy();

    // A login reported by the customer's app restores the account.
    const key = await apiKey(t, admin, ['events:write', 'users:read']);
    const login = await t.request({ method: 'POST', url: `/api/v1/users/${dormant.id}/login-events`, bearer: key, body: { success: true, ip: '198.51.100.5' } });
    expect(login.body).toMatchObject({ ok: true, allowed: true });
    expect((await call(t, admin, 'GET', `/api/admin/users/${dormant.id}`)).archived_at).toBeNull();
    expect((await t.app.db.many(sql`SELECT action FROM audit_logs WHERE target_id = ${dormant.id} AND action = 'user.unarchive'`)).length).toBe(1);
  });

  it('lets administrators archive and restore by hand, one by one or in bulk', async () => {
    const a = await call(t, admin, 'POST', '/api/admin/users', { email: 'a@example.com' });
    const b = await call(t, admin, 'POST', '/api/admin/users', { email: 'b@example.com' });
    expect((await call(t, admin, 'POST', `/api/admin/users/${a.id}/archive`, { reason: 'Duplicate test account' })).archived_reason).toBe('Duplicate test account');
    const bulk = await call(t, admin, 'POST', '/api/admin/users/bulk', { ids: [b.id], action: 'archive' });
    expect(bulk.succeeded).toBe(1);
    expect((await call(t, admin, 'GET', '/api/admin/users')).total).toBe(0);
    expect((await call(t, admin, 'POST', `/api/admin/users/${a.id}/unarchive`)).archived_at).toBeNull();
    await call(t, admin, 'POST', '/api/admin/users/bulk', { ids: [b.id], action: 'unarchive' });
    expect((await call(t, admin, 'GET', '/api/admin/users')).total).toBe(2);
    expect((await t.app.db.many(sql`SELECT type FROM events WHERE type IN ('user.archived', 'user.unarchived') ORDER BY created_at`)).map((e) => e.type)).toEqual([
      'user.archived',
      'user.archived',
      'user.unarchived',
      'user.unarchived',
    ]);

    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${a.id}/archive`, as: analyst, body: {} })).status).toBe(403);
    const scoped = await adminSession(t, ['admin'], ['org_none']);
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${a.id}/archive`, as: scoped, body: {} })).status).toBe(404);
  });
});
