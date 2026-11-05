import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call, seedCatalog } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

const count = async (query: ReturnType<typeof sql>) => (await t.app.db.one<{ n: number }>(query)).n;

describe('merging duplicate accounts', () => {
  it('moves records from every module to the account being kept, in one step', async () => {
    const catalog = await seedCatalog(t, admin);
    const key = await apiKey(t, admin, ['usage:write', 'users:read']);
    await call(t, admin, 'POST', '/api/admin/custom-fields', { entity: 'user', key: 'company', label: 'Company', type: 'text' });
    const target = await call(t, admin, 'POST', '/api/admin/users', { email: 'ada@example.com', name: 'Ada', tags: ['vip'] });
    const source = await call(t, admin, 'POST', '/api/admin/users', { email: 'ada.lovelace@example.org', phone: '+44 20 7946 0000', tags: ['beta'], customFields: { company: 'Analytical Engines' }, externalId: 'app-42' });
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Engines Ltd' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: target.id, role: 'member' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: source.id, role: 'admin' });

    // Records in several modules: customers, catalog, usage, billing, support and security.
    await call(t, admin, 'POST', `/api/admin/users/${source.id}/notes`, { body: 'Called about the duplicate account' });
    await t.app.db.exec(sql.insert('user_sessions', { id: newId('uss'), user_id: source.id, ip: '198.51.100.7', created_at: t.clock.now(), last_seen_at: t.clock.now() }, ''));
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: source.id, productId: catalog.pro.id, reason: 'Conference giveaway' });
    await call(t, admin, 'POST', '/api/admin/credits/grant', { userId: source.id, creditType: 'credits', amount: 100, reason: 'Promotion' });
    await call(t, admin, 'POST', '/api/admin/credits/grant', { userId: target.id, creditType: 'credits', amount: 50, reason: 'Promotion' });
    for (const [userId, quantity] of [[source.id, 5], [target.id, 3]] as const) {
      const res = await t.request({ method: 'POST', url: '/api/v1/usage/record', bearer: key, body: { userId, meter: 'api_calls', quantity } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const subscription = await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: source.id, priceId: catalog.proMonthly.id, collectionMethod: 'complimentary' });
    const ticket = await call(t, admin, 'POST', '/api/admin/support/tickets', { userId: source.id, subject: 'Two accounts', body: 'Please merge my accounts' });
    await t.request({ method: 'POST', url: `/api/v1/users/${source.id}/login-events`, bearer: await apiKey(t, admin, ['events:write']), body: { success: true, ip: '198.51.100.7' } });

    const preview = await call(t, admin, 'GET', `/api/admin/users/${target.id}/merge-preview?sourceId=${source.id}`);
    const entry = (table: string, column?: string) => preview.entries.find((e: any) => e.table === table && (!column || e.column === column));
    expect(entry('user_notes')).toMatchObject({ module: 'customers', rows: 1, resolution: 'move' });
    expect(entry('memberships')).toMatchObject({ rows: 1, conflicts: 1, resolution: 'custom' });
    expect(entry('entitlement_grants')).toMatchObject({ module: 'catalog', column: 'subject_id', rows: 1 });
    expect(entry('credit_balances')).toMatchObject({ module: 'usage', conflicts: 1, resolution: 'combine' });
    expect(entry('usage_counters')).toMatchObject({ conflicts: 1, resolution: 'combine' });
    expect(entry('subscriptions', 'user_id')).toMatchObject({ module: 'billing', rows: 1 });
    expect(entry('tickets', 'user_id')).toMatchObject({ module: 'support', rows: 1 });
    expect(entry('login_events')).toMatchObject({ module: 'security', column: 'subject_id' });
    expect(preview.filled).toEqual(expect.arrayContaining(['phone', 'external_id', 'custom_fields.company', 'tags']));
    // Previewing changes nothing.
    expect(await count(sql`SELECT count(*)::int AS n FROM user_notes WHERE user_id = ${source.id}`)).toBe(1);

    // Re-authentication is required, and the action must be confirmed explicitly.
    const stale = await adminSession(t);
    await t.app.db.exec(sql`UPDATE admin_sessions SET reauth_at = NULL WHERE admin_id = ${stale.adminId}`);
    const noReauth = await t.request({ method: 'POST', url: `/api/admin/users/${target.id}/merge`, as: stale, body: { sourceId: source.id, confirm: 'MERGE' } });
    expect(noReauth.body.error.code).toBe('reauth_required');
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${target.id}/merge`, as: admin, body: { sourceId: source.id } })).status).toBe(422);

    const merged = await call(t, admin, 'POST', `/api/admin/users/${target.id}/merge`, { sourceId: source.id, confirm: 'MERGE' });
    expect(merged.moved.find((m: any) => m.table === 'credit_balances')).toMatchObject({ resolved: 1, kept: 0 });

    // Every module's rows now belong to the target.
    expect(await count(sql`SELECT count(*)::int AS n FROM user_notes WHERE user_id = ${target.id}`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM user_sessions WHERE user_id = ${target.id}`)).toBe(1);
    expect(await t.app.db.one(sql`SELECT subject_id, user_id FROM subscriptions WHERE id = ${subscription.id}`)).toEqual({ subject_id: target.id, user_id: target.id });
    expect((await t.app.db.one(sql`SELECT user_id FROM tickets WHERE id = ${ticket.id}`)).user_id).toBe(target.id);
    expect(await count(sql`SELECT count(*)::int AS n FROM entitlement_grants WHERE subject_type = 'user' AND subject_id = ${target.id}`)).toBe(1);
    expect(await t.app.db.many(sql`SELECT subject_id, balance FROM credit_balances WHERE subject_type = 'user'`)).toEqual([{ subject_id: target.id, balance: 150 }]);
    expect(await t.app.db.many(sql`SELECT subject_id, used FROM usage_counters WHERE subject_type = 'user' AND meter_key = 'api_calls'`)).toEqual([{ subject_id: target.id, used: 8 }]);
    expect(await t.app.db.many(sql`SELECT role FROM memberships WHERE org_id = ${org.id}`)).toEqual([{ role: 'admin' }]);
    expect(await count(sql`SELECT count(*)::int AS n FROM login_events WHERE subject_type = 'user' AND subject_id = ${source.id}`)).toBe(0);

    // The target keeps its profile, with blanks filled from the duplicate.
    const kept = await call(t, admin, 'GET', `/api/admin/users/${target.id}`);
    expect(kept).toMatchObject({ name: 'Ada', email: 'ada@example.com', phone: '+44 20 7946 0000', external_id: 'app-42', custom_fields: { company: 'Analytical Engines' } });
    expect(kept.tags.sort()).toEqual(['beta', 'vip']);
    expect(kept.mergedFrom.map((m: any) => m.source_id)).toEqual([source.id]);

    // The duplicate is marked as merged, points at the target and cannot be restored.
    const gone = await call(t, admin, 'GET', `/api/admin/users/${source.id}`);
    expect(gone).toMatchObject({ merged_into_id: target.id, mergedInto: { id: target.id } });
    expect(gone.deleted_at).toBeTruthy();
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${source.id}/restore`, as: admin })).body.error.code).toBe('user_merged');
    const status = await t.request({ url: `/api/v1/users/${source.id}/status`, bearer: key });
    expect(status.body).toMatchObject({ status: 'merged', allowed: false, mergedInto: target.id });
    expect((await t.request({ url: '/api/v1/users/external/app-42', bearer: key })).body.user.id).toBe(target.id);

    const audit = await t.app.db.many(sql`SELECT action, target_id FROM audit_logs WHERE action IN ('user.merge', 'user.merged_into') ORDER BY seq`);
    expect(audit).toEqual([{ action: 'user.merge', target_id: target.id }, { action: 'user.merged_into', target_id: source.id }]);
    const event = await t.app.db.one(sql`SELECT data FROM events WHERE type = 'user.merged'`);
    expect(event.data).toMatchObject({ sourceId: source.id, targetId: target.id });
    expect(await count(sql`SELECT count(*)::int AS n FROM user_merges WHERE target_id = ${target.id}`)).toBe(1);
  });

  it('keeps the target’s row when per-customer choices collide, and resolves chains of merges', async () => {
    const a = await call(t, admin, 'POST', '/api/admin/users', { email: 'a@example.com' });
    const b = await call(t, admin, 'POST', '/api/admin/users', { email: 'b@example.com' });
    const c = await call(t, admin, 'POST', '/api/admin/users', { email: 'c@example.com' });
    const now = t.clock.now();
    await t.app.db.exec(sql`INSERT INTO email_preferences (user_id, category, subscribed, updated_at) VALUES (${a.id}, 'marketing', false, ${now}), (${b.id}, 'marketing', true, ${now}), (${a.id}, 'product', true, ${now})`);
    await call(t, admin, 'POST', `/api/admin/users/${b.id}/merge`, { sourceId: a.id, confirm: 'MERGE' });
    expect(await t.app.db.many(sql`SELECT user_id, category, subscribed FROM email_preferences ORDER BY category`)).toEqual([
      { user_id: b.id, category: 'marketing', subscribed: true },
      { user_id: b.id, category: 'product', subscribed: true },
    ]);
    await call(t, admin, 'POST', `/api/admin/users/${c.id}/merge`, { sourceId: b.id, confirm: 'MERGE' });
    expect((await t.app.db.one(sql`SELECT merged_into_id FROM users WHERE id = ${a.id}`)).merged_into_id).toBe(c.id);
    // An account that was merged away cannot take part in another merge.
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${c.id}/merge`, as: admin, body: { sourceId: a.id, confirm: 'MERGE' } })).status).toBe(404);
  });

  it('refuses without the permission, outside the organization scope, and for the same account', async () => {
    const orgA = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'A' });
    const orgB = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'B' });
    const target = await call(t, admin, 'POST', '/api/admin/users', { email: 't@example.com', orgId: orgA.id });
    const inB = await call(t, admin, 'POST', '/api/admin/users', { email: 'b@example.com', orgId: orgB.id });
    const both = await call(t, admin, 'POST', '/api/admin/users', { email: 'both@example.com', orgId: orgA.id });
    await call(t, admin, 'POST', `/api/admin/organizations/${orgB.id}/members`, { userId: both.id });

    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: `/api/admin/users/${target.id}/merge-preview?sourceId=${both.id}`, as: support })).status).toBe(403);
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${target.id}/merge`, as: support, body: { sourceId: both.id, confirm: 'MERGE' } })).status).toBe(403);

    const scoped = await adminSession(t, ['admin'], [orgA.id]);
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${target.id}/merge`, as: scoped, body: { sourceId: inB.id, confirm: 'MERGE' } })).status).toBe(404);
    const crossOrg = await t.request({ method: 'POST', url: `/api/admin/users/${target.id}/merge`, as: scoped, body: { sourceId: both.id, confirm: 'MERGE' } });
    expect(crossOrg.body.error.code).toBe('org_scope');
    expect((await t.request({ method: 'POST', url: `/api/admin/users/${target.id}/merge`, as: admin, body: { sourceId: target.id, confirm: 'MERGE' } })).status).toBe(422);
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE merged_into_id IS NOT NULL`)).toBe(0);
  });
});
