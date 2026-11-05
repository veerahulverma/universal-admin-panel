import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { sql } from '../../core/sql.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

async function createUser(body: Record<string, unknown>, as = admin) {
  const res = await t.request({ method: 'POST', url: '/api/admin/users', as, body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe('user directory', () => {
  it('creates, searches, filters, sorts and paginates users', async () => {
    await createUser({ email: 'ada@example.com', name: 'Ada Lovelace', tags: ['vip'], country: 'gb' });
    await createUser({ email: 'grace@example.com', name: 'Grace Hopper' });
    await createUser({ email: 'linus@example.com', name: 'Linus' });
    const dup = await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'ADA@example.com' } });
    expect(dup.status).toBe(409);

    const search = await t.request({ url: '/api/admin/users', as: admin, query: { q: 'hopper' } });
    expect(search.body.data.map((u: any) => u.email)).toEqual(['grace@example.com']);
    const tagged = await t.request({ url: '/api/admin/users', as: admin, query: { tag: 'vip' } });
    expect(tagged.body.total).toBe(1);
    expect(tagged.body.data[0].country).toBe('GB');
    const sorted = await t.request({ url: '/api/admin/users', as: admin, query: { sort: 'email', order: 'asc', pageSize: 2 } });
    expect(sorted.body.data.map((u: any) => u.email)).toEqual(['ada@example.com', 'grace@example.com']);
    expect(sorted.body.total).toBe(3);
    const page2 = await t.request({ url: '/api/admin/users', as: admin, query: { sort: 'email', order: 'asc', pageSize: 2, page: 2 } });
    expect(page2.body.data.map((u: any) => u.email)).toEqual(['linus@example.com']);
    const badSort = await t.request({ url: '/api/admin/users', as: admin, query: { sort: 'password_hash' } });
    expect(badSort.status).toBe(422);
  });

  it('exports CSV without formula injection', async () => {
    await createUser({ email: 'evil@example.com', name: '=HYPERLINK("http://x")' });
    const res = await t.request({ url: '/api/admin/users/export.csv', as: admin });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('account actions', () => {
  it('suspends with a reason, emits events, and needs the ban permission to ban', async () => {
    const user = await createUser({ email: 'u@example.com' });
    const noReason = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/status`, as: admin, body: { action: 'suspend' } });
    expect(noReason.status).toBe(422);
    const suspended = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/status`, as: admin, body: { action: 'suspend', reason: 'chargeback investigation' } });
    expect(suspended.body.status).toBe('suspended');
    const support = await adminSession(t, ['support']);
    const ban = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/status`, as: support, body: { action: 'ban', reason: 'fraud' } });
    expect(ban.status).toBe(403);
    const reactivate = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/status`, as: support, body: { action: 'reactivate' } });
    expect(reactivate.body.status).toBe('active');
    const events = await t.app.db.many(sql`SELECT type FROM events WHERE user_id = ${user.id} ORDER BY created_at`);
    expect(events.map((e) => e.type)).toEqual(['user.created', 'user.sessions_revoked', 'user.suspended', 'user.reactivated']);
  });

  it('lifts timed suspensions automatically', async () => {
    const user = await createUser({ email: 'timed@example.com' });
    const until = new Date(t.clock.now().getTime() + 3600_000).toISOString();
    await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/status`, as: admin, body: { action: 'suspend', reason: 'cool-off', until } });
    t.clock.advance(2 * 3600_000);
    await t.app.jobs.enqueue(t.app.db, 'customers.lift_suspensions', {});
    await t.app.worker.runUntilIdle();
    const after = await t.request({ url: `/api/admin/users/${user.id}`, as: admin });
    expect(after.body.status).toBe('active');
  });

  it('soft deletes, restores, exports and irreversibly anonymizes', async () => {
    const user = await createUser({ email: 'gdpr@example.com', name: 'Person', phone: '+15550100' });
    await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/notes`, as: admin, body: { body: 'called about invoice' } });
    const exported = await t.request({ url: `/api/admin/users/${user.id}/export`, as: admin });
    expect(exported.body.profile.email).toBe('gdpr@example.com');
    expect(exported.body.notes).toHaveLength(1);

    expect((await t.request({ method: 'DELETE', url: `/api/admin/users/${user.id}`, as: admin })).status).toBe(204);
    expect((await t.request({ url: '/api/admin/users', as: admin })).body.total).toBe(0);
    expect((await t.request({ url: '/api/admin/users', as: admin, query: { status: 'deleted' } })).body.total).toBe(1);
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/restore`, as: admin })).body.deleted_at).toBeNull();

    const noConfirm = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/anonymize`, as: admin, body: {} });
    expect(noConfirm.status).toBe(422);
    const erased = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/anonymize`, as: admin, body: { confirm: 'ERASE' } });
    expect(erased.status).toBe(200);
    const row = await t.app.db.one(sql`SELECT email, name, phone, anonymized_at FROM users WHERE id = ${user.id}`);
    expect(row.email).toMatch(/@anonymized\.invalid$/);
    expect(row.name).toBeNull();
    expect(row.phone).toBeNull();
    expect((await t.app.db.many(sql`SELECT 1 FROM user_notes WHERE user_id = ${user.id}`)).length).toBe(0);
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/restore`, as: admin })).status).toBe(409);
  });

  it('applies bulk actions and reports per-row failures', async () => {
    const a = await createUser({ email: 'a@example.com' });
    const b = await createUser({ email: 'b@example.com' });
    const res = await t.request({ method: 'POST', url: '/api/admin/users/bulk', as: admin, body: { ids: [a.id, b.id, 'usr_missing'], action: 'tag', tag: 'beta' } });
    expect(res.body.succeeded).toBe(2);
    expect(res.body.failed).toHaveLength(1);
    expect((await t.request({ url: '/api/admin/users', as: admin, query: { tag: 'beta' } })).body.total).toBe(2);
  });

  it('validates custom fields against their definitions', async () => {
    await t.request({ method: 'POST', url: '/api/admin/custom-fields', as: admin, body: { entity: 'user', key: 'tier', label: 'Tier', type: 'select', options: ['gold', 'silver'], required: true } });
    const missing = await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'cf@example.com', customFields: {} } });
    expect(missing.status).toBe(422);
    const bad = await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'cf@example.com', customFields: { tier: 'bronze' } } });
    expect(bad.status).toBe(422);
    const ok = await createUser({ email: 'cf@example.com', customFields: { tier: 'gold' } });
    expect(ok.custom_fields).toEqual({ tier: 'gold' });
  });
});

describe('impersonation', () => {
  it('is audited, time-limited, single-use and requires a reason', async () => {
    const user = await createUser({ email: 'imp@example.com' });
    const short = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/impersonate`, as: admin, body: { reason: 'help' } });
    expect(short.status).toBe(422);
    const start = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/impersonate`, as: admin, body: { reason: 'Reproduce billing page bug #42' } });
    expect(start.status).toBe(200);
    expect(start.body.token).toMatch(/^imp_/);

    const key = await t.request({ method: 'POST', url: '/api/admin/api-keys', as: admin, body: { name: 'app', scopes: ['impersonation:verify'] } });
    const verify = await t.request({ method: 'POST', url: '/api/v1/impersonation/verify', bearer: key.body.secret, body: { token: start.body.token } });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ userId: user.id, readOnly: true, admin: { id: admin.adminId } });
    const replay = await t.request({ method: 'POST', url: '/api/v1/impersonation/verify', bearer: key.body.secret, body: { token: start.body.token } });
    expect(replay.status).toBe(404);
    const audit = await t.app.db.many(sql`SELECT action FROM audit_logs WHERE target_id = ${user.id} AND action LIKE 'user.impersonate%' ORDER BY seq`);
    expect(audit.map((a) => a.action)).toEqual(['user.impersonate_start', 'user.impersonate_verify']);
  });

  it('refuses write-mode impersonation unless enabled', async () => {
    const user = await createUser({ email: 'w@example.com' });
    const res = await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/impersonate`, as: admin, body: { reason: 'Need to change settings for them', readOnly: false } });
    expect(res.body.error.code).toBe('impersonation_write_disabled');
  });
});

describe('tenant isolation', () => {
  it('limits org-scoped administrators to their organizations', async () => {
    const orgA = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'Org A' } })).body;
    const orgB = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'Org B' } })).body;
    const inA = await createUser({ email: 'in-a@example.com', orgId: orgA.id });
    const inB = await createUser({ email: 'in-b@example.com', orgId: orgB.id });

    const scoped = await adminSession(t, ['support'], [orgA.id]);
    const list = await t.request({ url: '/api/admin/users', as: scoped });
    expect(list.body.data.map((u: any) => u.email)).toEqual(['in-a@example.com']);
    expect((await t.request({ url: `/api/admin/users/${inB.id}`, as: scoped })).status).toBe(404);
    expect((await t.request({ url: `/api/admin/users/${inA.id}`, as: scoped })).status).toBe(200);
    expect((await t.request({ url: `/api/admin/organizations/${orgB.id}`, as: scoped })).status).toBe(404);
    const orgs = await t.request({ url: '/api/admin/organizations', as: scoped });
    expect(orgs.body.data.map((o: any) => o.id)).toEqual([orgA.id]);
    const search = await t.request({ url: '/api/admin/search', as: scoped, query: { q: 'example.com' } });
    expect(search.body.data.map((r: any) => r.id)).toEqual([inA.id]);
    const suspendB = await t.request({ method: 'POST', url: `/api/admin/users/${inB.id}/status`, as: scoped, body: { action: 'suspend', reason: 'x' } });
    expect(suspendB.status).toBe(404);
  });

  it('enforces seat limits on organizations', async () => {
    const org = (await t.request({ method: 'POST', url: '/api/admin/organizations', as: admin, body: { name: 'Small', seatLimit: 1 } })).body;
    const u1 = await createUser({ email: 's1@example.com' });
    const u2 = await createUser({ email: 's2@example.com' });
    expect((await t.request({ method: 'POST', url: `/api/admin/organizations/${org.id}/members`, as: admin, body: { userId: u1.id } })).status).toBe(200);
    const full = await t.request({ method: 'POST', url: `/api/admin/organizations/${org.id}/members`, as: admin, body: { userId: u2.id } });
    expect(full.body.error.code).toBe('seat_limit_reached');
  });
});

describe('timeline', () => {
  it('merges events, admin actions and notes', async () => {
    const user = await createUser({ email: 'tl@example.com' });
    await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/notes`, as: admin, body: { body: 'VIP onboarding' } });
    await t.request({ method: 'POST', url: `/api/admin/users/${user.id}/verify-email`, as: admin });
    const tl = await t.request({ url: `/api/admin/users/${user.id}/timeline`, as: admin });
    const kinds = new Set(tl.body.data.map((e: any) => e.kind));
    expect(kinds).toEqual(new Set(['event', 'admin_action', 'note']));
  });
});
