import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, MINUTE } from '../../core/clock.js';
import type { Db } from '../../core/db.js';
import { groupsOfUser, normalizePath, type GroupMembership } from './service.js';

let t: TestPlatform;
let admin: AdminSession;
let key: string;
let cat: CatalogFixture;

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-03-02T09:00:00Z');
  admin = await adminSession(t);
  key = await apiKey(t, admin);
  cat = await seedCatalog(t, admin);
});
afterEach(async () => {
  await t.close();
});

// ---- Helpers ------------------------------------------------------------------------------------

async function customerSession(userId: string, orgId?: string): Promise<string> {
  const res = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId, orgId } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token;
}

/** A complimentary subscription, started now. */
async function subscribe(userId: string, priceId = cat.proMonthly.id) {
  return call(t, admin, 'POST', '/api/admin/subscriptions', { userId, priceId, collectionMethod: 'complimentary' });
}

async function grant(subject: { userId?: string; orgId?: string }, productId: string, endsAt?: Date) {
  return call(t, admin, 'POST', '/api/admin/entitlement-grants', { ...subject, productId, endsAt, reason: 'Test grant' });
}

async function protect(body: Record<string, unknown>, as = admin) {
  return call(t, as, 'POST', '/api/admin/access/resources', body);
}

async function check(subject: { userId?: string; orgId?: string }, resource: string, extra: Record<string, unknown> = {}) {
  const res = await t.request({ method: 'POST', url: '/api/v1/access/check', bearer: key, body: { ...subject, resource, ...extra } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { allowed: boolean; reason: string; availableAt: string | null; availableUntil: string | null; resource: { id: string; url?: string } | null };
}

function upload(url: string, filename: string, contentType: string, data: Buffer, opts: { as?: AdminSession; fields?: Record<string, string> } = {}) {
  const as = opts.as ?? admin;
  const boundary = '----steward-access-boundary';
  const payload = Buffer.concat([
    ...Object.entries(opts.fields ?? {}).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return t.server.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': as.csrf },
    cookies: { stw_admin: as.token },
  });
}

const download = (url: string, method: 'GET' | 'HEAD' = 'GET') => t.server.inject({ method, url: url.replace('http://localhost:4000', '') });

async function runRenewals() {
  await t.app.jobs.enqueue(t.app.db, 'billing.renewals', {});
  await t.app.worker.runUntilIdle();
}

// ---- User groups --------------------------------------------------------------------------------

describe('user groups', () => {
  it('creates, renames and deletes groups and adds or removes one or many members', async () => {
    const [ann, bob, cyd] = [await apiUser(t, key, 'ann@example.com'), await apiUser(t, key, 'bob@example.com'), await apiUser(t, key, 'cyd@example.com')];
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Beta testers', description: 'Early access' });
    expect(group).toMatchObject({ name: 'Beta testers', members: { total: 0, manual: 0, automatic: 0 }, autoProducts: [] });
    expect((await t.request({ method: 'POST', url: '/api/admin/user-groups', as: admin, body: { name: 'beta TESTERS' } })).body.error.code).toBe('group_name_taken');

    const added = await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members`, { users: [ann.id, 'BOB@example.com', 'nobody@example.com', ann.id] });
    expect(added.added.sort()).toEqual([ann.id, bob.id].sort());
    expect(added.skipped).toEqual([{ value: 'nobody@example.com', reason: 'not_found' }]);
    const again = await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members`, { users: [bob.id, cyd.id] });
    expect(again).toEqual({ added: [cyd.id], skipped: [{ value: bob.id, reason: 'already_member' }] });

    const members = await call(t, admin, 'GET', `/api/admin/user-groups/${group.id}/members`);
    expect(members.total).toBe(3);
    expect(members.data.every((m: any) => m.manual && !m.automatic)).toBe(true);
    expect((await call(t, admin, 'GET', `/api/admin/user-groups/${group.id}/members?q=cyd`)).data.map((m: any) => m.id)).toEqual([cyd.id]);

    expect(await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members/remove`, { userIds: [ann.id, bob.id] })).toEqual({ removed: expect.arrayContaining([ann.id, bob.id]) });
    expect((await t.request({ method: 'DELETE', url: `/api/admin/user-groups/${group.id}/members/${cyd.id}`, as: admin })).status).toBe(204);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/user-groups/${group.id}/members/${cyd.id}`, as: admin })).status).toBe(404);

    const renamed = await call(t, admin, 'PATCH', `/api/admin/user-groups/${group.id}`, { name: 'Insiders' });
    expect(renamed).toMatchObject({ name: 'Insiders', description: 'Early access' });
    expect((await t.request({ method: 'DELETE', url: `/api/admin/user-groups/${group.id}`, as: admin })).status).toBe(204);
    expect((await call(t, admin, 'GET', '/api/admin/user-groups')).data).toEqual([]);

    const events = (await t.app.db.many<{ type: string }>(sql`SELECT type FROM events WHERE type LIKE 'user_group.%' ORDER BY created_at, id`)).map((e) => e.type);
    expect(events.filter((e) => e === 'user_group.member_added')).toHaveLength(3);
    expect(events.filter((e) => e === 'user_group.member_removed')).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining(['user_group.created', 'user_group.updated', 'user_group.deleted']));
    const audit = (await t.app.db.many<{ action: string }>(sql`SELECT action FROM audit_logs WHERE target_type = 'user_group' ORDER BY seq`)).map((a) => a.action);
    expect(audit).toEqual(['user_group.create', 'user_group.members_add', 'user_group.members_add', 'user_group.members_remove', 'user_group.members_remove', 'user_group.update', 'user_group.delete']);
  });

  it('computes automatic membership from current subscriptions and grants, never copying it', async () => {
    const [subscriber, granted, orgMember, outsider] = [
      await apiUser(t, key, 'sub@example.com'),
      await apiUser(t, key, 'grant@example.com'),
      await apiUser(t, key, 'member@corp.com'),
      await apiUser(t, key, 'out@example.com'),
    ];
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Corp' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: orgMember.id });
    const sub = await subscribe(subscriber.id);
    await grant({ userId: granted.id }, cat.pro.id, new Date(t.clock.now().getTime() + 10 * DAY));
    await grant({ orgId: org.id }, cat.pro.id);

    // Products are accepted by key or id.
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Pro customers', autoProductIds: ['pro'] });
    expect(group.autoProducts.map((p: any) => p.id)).toEqual([cat.pro.id]);
    expect(group.members).toEqual({ total: 3, manual: 0, automatic: 3 });

    const viaService = t.app.services['access.groupsOfUser'] as (db: Db, userId: string) => Promise<GroupMembership[]>;
    for (const u of [subscriber, granted, orgMember]) {
      expect((await viaService(t.app.db, u.id)).map((g) => [g.name, g.manual, g.automatic])).toEqual([['Pro customers', false, true]]);
    }
    expect(await groupsOfUser(t.app.db, t.app, outsider.id)).toEqual([]);
    expect((await call(t, admin, 'GET', `/api/admin/user-groups?userId=${subscriber.id}`)).data).toEqual([expect.objectContaining({ id: group.id, membership: expect.objectContaining({ automatic: true, manual: false }) })]);

    // Being added by hand as well is reported as both; removing the manual entry keeps the automatic one.
    await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members`, { users: [subscriber.id] });
    expect((await viaService(t.app.db, subscriber.id))[0]).toMatchObject({ manual: true, automatic: true });
    await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members/remove`, { userIds: [subscriber.id] });

    // Access ends with the subscription or the grant; nothing was copied, so nothing needs cleaning up.
    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: false });
    t.clock.advance(11 * DAY);
    expect(await groupsOfUser(t.app.db, t.app, subscriber.id)).toEqual([]);
    expect(await groupsOfUser(t.app.db, t.app, granted.id)).toEqual([]);
    const members = await call(t, admin, 'GET', `/api/admin/user-groups/${group.id}/members?source=automatic`);
    expect(members.data.map((m: any) => m.id)).toEqual([orgMember.id]);
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM user_group_members`)).n).toBe(0);
  });

  it('refuses to delete a group while access rules use it', async () => {
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'VIP' });
    const page = await protect({ kind: 'page', title: 'VIP lounge', body: '<p>Hi</p>', rules: { groupIds: [group.id] } });
    const refused = await t.request({ method: 'DELETE', url: `/api/admin/user-groups/${group.id}`, as: admin });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'group_in_use', details: { resources: [{ id: page.id, title: 'VIP lounge' }] } });
    expect((await call(t, admin, 'GET', `/api/admin/user-groups/${group.id}`)).resources.map((r: any) => r.id)).toEqual([page.id]);
    await call(t, admin, 'PATCH', `/api/admin/access/resources/${page.id}`, { rules: { anyCustomer: true } });
    expect((await t.request({ method: 'DELETE', url: `/api/admin/user-groups/${group.id}`, as: admin })).status).toBe(204);
  });
});

// ---- Access rules -------------------------------------------------------------------------------

describe('access rules', () => {
  it('allows and refuses by plan, product and group, and matches paths by their most specific protection', async () => {
    const [pro, addon, beta, nobody] = [
      await apiUser(t, key, 'pro@example.com'),
      await apiUser(t, key, 'addon@example.com'),
      await apiUser(t, key, 'beta@example.com'),
      await apiUser(t, key, 'nobody@example.com'),
    ];
    await subscribe(pro.id);
    await grant({ userId: addon.id }, cat.extra.id);
    const betaGroup = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Beta' });
    await call(t, admin, 'POST', `/api/admin/user-groups/${betaGroup.id}/members`, { users: [beta.id] });

    const report = await protect({ kind: 'url', title: 'Annual report', path: '/reports/annual/', rules: { productIds: ['pro'] } });
    expect(report.path).toBe('/reports/annual');
    const bonus = await protect({ kind: 'page', title: 'Bonus chapter', body: '<p>Extra</p>', rules: { productIds: [cat.extra.id] } });
    const betaArea = await protect({ kind: 'folder', title: 'Beta area', path: 'https://app.example.com/beta', rules: { groupIds: [betaGroup.id] } });
    await protect({ kind: 'url', title: 'Beta sign-up', path: '/beta/join', rules: { anyCustomer: true } });
    const welcome = await protect({ kind: 'page', title: 'Welcome', body: '<p>Hello</p>', rules: { anyCustomer: true } });
    const forum = await protect({ kind: 'link', title: 'Community forum', url: 'https://forum.example.com/invite/abc', rules: { productIds: ['free'] } });
    expect((await t.request({ method: 'POST', url: '/api/admin/access/resources', as: admin, body: { kind: 'url', title: 'Dup', path: '/reports//annual' } })).body.error.code).toBe('path_taken');

    expect(await check({ userId: pro.id }, '/reports/annual')).toMatchObject({ allowed: true, reason: 'plan', resource: { id: report.id } });
    expect(await check({ userId: nobody.id }, '/reports/annual')).toMatchObject({ allowed: false, reason: 'no_access' });
    expect(await check({ userId: addon.id }, bonus.id)).toMatchObject({ allowed: true, reason: 'product' });
    expect(await check({ userId: pro.id }, bonus.id)).toMatchObject({ allowed: false, reason: 'no_access' });
    expect(await check({ userId: beta.id }, '/beta/builds/42')).toMatchObject({ allowed: true, reason: 'group', resource: { id: betaArea.id } });
    expect(await check({ userId: nobody.id }, '/beta/builds/42')).toMatchObject({ allowed: false, reason: 'no_access' });
    // A deeper, exact protection wins over the folder around it.
    expect(await check({ userId: nobody.id }, '/beta/join')).toMatchObject({ allowed: true, reason: 'any_customer' });
    expect(await check({ userId: nobody.id }, welcome.id)).toMatchObject({ allowed: true, reason: 'any_customer' });
    // Customers without a plan are on the default (free) plan; a paid plan replaces it.
    expect(await check({ userId: nobody.id }, forum.id)).toMatchObject({ allowed: true, reason: 'plan', resource: { url: 'https://forum.example.com/invite/abc' } });
    expect((await check({ userId: pro.id }, forum.id)).resource).toEqual({ id: forum.id, kind: 'link', title: 'Community forum' });

    // Paths are compared in canonical form, so detours cannot skip a folder.
    for (const path of ['/beta/../reports/./annual', '/reports//annual/', '/%72eports/annual?x=1#top', 'https://app.example.com/beta/%2e%2e/reports/annual']) {
      expect(await check({ userId: nobody.id }, path), path).toMatchObject({ allowed: false, resource: { id: report.id } });
    }
    expect(await check({ userId: nobody.id }, '/betamax')).toMatchObject({ allowed: true, reason: 'unprotected', resource: null });
    expect((await t.request({ method: 'POST', url: '/api/v1/access/check', bearer: key, body: { userId: nobody.id, resource: 'reports' } })).status).toBe(422);
    expect((await t.request({ method: 'POST', url: '/api/v1/access/check', bearer: key, body: { userId: 'usr_missing', resource: '/x' } })).status).toBe(404);

    const listed = await t.request({ url: '/api/v1/access/resources', bearer: key, query: { userId: beta.id } });
    const states = Object.fromEntries(listed.body.data.map((r: any) => [r.title, r.state]));
    expect(states).toMatchObject({ 'Beta area': 'available', 'Annual report': 'locked', Welcome: 'available', 'Community forum': 'available' });

    // Every check is recorded with the end user's IP when the app passes it.
    await check({ userId: nobody.id }, '/reports/annual', { ip: '198.51.100.7' });
    const last = await t.app.db.one<any>(sql`SELECT * FROM access_log ORDER BY created_at DESC, id DESC LIMIT 1`);
    expect(last).toMatchObject({ event: 'check', source: 'api', resource_id: report.id, user_id: nobody.id, allowed: false, reason: 'no_access', ip: '198.51.100.7', path: '/reports/annual' });
    const log = await call(t, admin, 'GET', `/api/admin/access/log?resourceId=${report.id}&outcome=denied`);
    expect(log.total).toBeGreaterThanOrEqual(5);
  });

  it('releases drip content on the right day and closes access windows', async () => {
    const user = await apiUser(t, key, 'drip@example.com');
    const sub = await subscribe(user.id);
    const start = new Date(sub.created_at).getTime();
    const week1 = await protect({ kind: 'page', title: 'Week 2 lesson', body: '<p>Lesson</p>', rules: { productIds: ['pro'] }, release: { mode: 'days', days: 7 } });
    const trial = await protect({ kind: 'page', title: 'Starter kit', body: '<p>Kit</p>', rules: { productIds: ['pro'] }, windowDays: 3 });
    const launch = await protect({ kind: 'page', title: 'Launch webinar', body: '<p>Webinar</p>', rules: { anyCustomer: true }, release: { mode: 'date', date: '2026-03-20T00:00:00.000Z' } });

    const locked = await check({ userId: user.id }, week1.id);
    expect(locked).toMatchObject({ allowed: false, reason: 'not_yet_available' });
    expect(new Date(locked.availableAt!).getTime()).toBe(start + 7 * DAY);
    const kit = await check({ userId: user.id }, trial.id);
    expect(kit).toMatchObject({ allowed: true, reason: 'plan' });
    expect(new Date(kit.availableUntil!).getTime()).toBe(start + 3 * DAY);
    expect(await check({ userId: user.id }, launch.id)).toMatchObject({ allowed: false, reason: 'not_yet_available', availableAt: '2026-03-20T00:00:00.000Z' });

    const session = await customerSession(user.id);
    const listing = (await t.request({ url: '/api/client/content', bearer: session })).body.data;
    expect(listing.find((i: any) => i.id === week1.id)).toMatchObject({ state: 'scheduled', allowed: false, availableAt: new Date(start + 7 * DAY).toISOString() });
    const early = await t.request({ url: `/api/client/content/${week1.id}`, bearer: session });
    expect(early.status).toBe(403);
    expect(early.body.error).toMatchObject({ code: 'not_yet_available', details: { availableAt: new Date(start + 7 * DAY).toISOString() } });

    t.clock.set(new Date(start + 7 * DAY - MINUTE));
    expect(await check({ userId: user.id }, week1.id)).toMatchObject({ allowed: false, reason: 'not_yet_available' });
    expect(await check({ userId: user.id }, trial.id)).toMatchObject({ allowed: false, reason: 'access_ended', availableUntil: new Date(start + 3 * DAY).toISOString() });
    t.clock.set(new Date(start + 7 * DAY + 5000));
    expect(await check({ userId: user.id }, week1.id)).toMatchObject({ allowed: true, reason: 'plan' });
    const opened = await t.request({ url: `/api/client/content/${week1.id}`, bearer: await customerSession(user.id) });
    expect(opened.body).toMatchObject({ state: 'available', body: '<p>Lesson</p>' });

    t.clock.set('2026-03-19T23:59:00Z');
    expect((await check({ userId: user.id }, launch.id)).allowed).toBe(false);
    t.clock.set('2026-03-20T00:00:01Z');
    expect(await check({ userId: user.id }, launch.id)).toMatchObject({ allowed: true, reason: 'any_customer' });
  });

  it('counts group drip from the day the customer joined the group', async () => {
    const user = await apiUser(t, key, 'joiner@example.com');
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Cohort A' });
    const module2 = await protect({ kind: 'page', title: 'Module 2', body: '<p>2</p>', rules: { groupIds: [group.id] }, release: { mode: 'days', days: 5 } });
    expect(await check({ userId: user.id }, module2.id)).toMatchObject({ allowed: false, reason: 'no_access' });
    t.clock.advance(2 * DAY);
    await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members`, { users: [user.id] });
    const joined = new Date((await t.app.db.one<{ created_at: Date }>(sql`SELECT created_at FROM user_group_members WHERE user_id = ${user.id}`)).created_at).getTime();
    expect(new Date((await check({ userId: user.id }, module2.id)).availableAt!).getTime()).toBe(joined + 5 * DAY);
    t.clock.set(new Date(joined + 5 * DAY + 1000));
    expect(await check({ userId: user.id }, module2.id)).toMatchObject({ allowed: true, reason: 'group' });
  });

  it('ends access when a subscription is cancelled at period end or a grant expires', async () => {
    const [subscriber, granted] = [await apiUser(t, key, 'leaving@example.com'), await apiUser(t, key, 'promo@example.com')];
    const sub = await subscribe(subscriber.id);
    await grant({ userId: granted.id }, cat.pro.id, new Date(t.clock.now().getTime() + 5 * DAY));
    const page = await protect({ kind: 'page', title: 'Pro guide', body: '<p>Guide</p>', rules: { productIds: ['pro'] } });

    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: true });
    expect(await check({ userId: subscriber.id }, page.id)).toMatchObject({ allowed: true, reason: 'plan' });
    expect(await check({ userId: granted.id }, page.id)).toMatchObject({ allowed: true, reason: 'plan' });

    t.clock.advance(6 * DAY);
    expect(await check({ userId: granted.id }, page.id)).toMatchObject({ allowed: false, reason: 'no_access' });
    expect(await check({ userId: subscriber.id }, page.id)).toMatchObject({ allowed: true });

    t.clock.advance(26 * DAY);
    await runRenewals();
    expect((await t.app.db.one<{ status: string }>(sql`SELECT status FROM subscriptions WHERE id = ${sub.id}`)).status).toBe('canceled');
    expect(await check({ userId: subscriber.id }, page.id)).toMatchObject({ allowed: false, reason: 'no_access' });
    const listing = await t.request({ url: '/api/client/content', bearer: await customerSession(subscriber.id) });
    expect(listing.body.data.map((i: any) => i.id)).not.toContain(page.id);
  });

  it('refuses everything to inactive accounts and disabled resources', async () => {
    const user = await apiUser(t, key, 'paused@example.com');
    const page = await protect({ kind: 'page', title: 'Open house', body: '<p>All</p>', rules: { anyCustomer: true } });
    const folder = await protect({ kind: 'folder', title: 'Archive', path: '/archive', rules: { anyCustomer: true }, status: 'disabled' });
    expect(await check({ userId: user.id }, '/archive/2019')).toMatchObject({ allowed: false, reason: 'resource_disabled', resource: { id: folder.id } });
    await call(t, admin, 'POST', `/api/admin/users/${user.id}/status`, { action: 'suspend', reason: 'Chargeback review' });
    expect(await check({ userId: user.id }, page.id)).toMatchObject({ allowed: false, reason: 'account_inactive' });
  });

  it('sanitizes page bodies and validates resources by kind', async () => {
    const page = await protect({ kind: 'page', title: 'Notes', body: '<p onclick="steal()">Hi <a href="javascript:alert(1)">there</a></p><script>alert(1)</script>' });
    expect(page.body).toBe('<p>Hi <a>there</a></p>');
    const bad = await t.request({ method: 'POST', url: '/api/admin/access/resources', as: admin, body: { kind: 'link', title: 'Bad', url: 'javascript:alert(1)' } });
    expect(bad.status).toBe(422);
    const noPath = await t.request({ method: 'POST', url: '/api/admin/access/resources', as: admin, body: { kind: 'folder', title: 'No path' } });
    expect(noPath.body.error.details).toEqual([expect.objectContaining({ path: ['path'] })]);
    const unknownRule = await t.request({ method: 'POST', url: '/api/admin/access/resources', as: admin, body: { kind: 'page', title: 'X', body: 'x', rules: { productIds: ['nope'] } } });
    expect(unknownRule.status).toBe(422);
    expect(normalizePath('/a/%2F..%2Fb')).toBe('/b');
    expect(normalizePath('relative/path')).toBeNull();
  });
});

// ---- Protected downloads ----------------------------------------------------------------------

describe('protected downloads', () => {
  const PDF = Buffer.from('%PDF-1.7\nmember handbook\n%%EOF');

  async function fileResource(file: { id: string }) {
    return protect({ kind: 'file', title: 'Member handbook', rules: { productIds: ['pro'] }, fileIds: [file.id] });
  }

  it('uploads within the size limit and serves files through signed, expiring, limited links', async () => {
    await call(t, admin, 'PATCH', '/api/admin/access/settings', { maxFileBytes: 1024 });
    const big = await upload('/api/admin/access/files', 'big.bin', 'application/octet-stream', Buffer.alloc(2048, 1));
    expect(big.statusCode).toBe(422);
    const created = await upload('/api/admin/access/files', 'handbook v2.pdf', 'application/pdf', PDF, { fields: { title: 'Handbook' } });
    expect(created.statusCode, created.body).toBe(201);
    const file = JSON.parse(created.body);
    expect(file).toMatchObject({ title: 'Handbook', filename: 'handbook v2.pdf', contentType: 'application/pdf', size: PDF.length, downloadLimit: 10, limitPeriod: 'day' });
    await call(t, admin, 'PATCH', `/api/admin/access/files/${file.id}`, { downloadLimit: 2, limitPeriod: 'day' });
    const resource = await fileResource(file);

    const user = await apiUser(t, key, 'reader@example.com');
    await subscribe(user.id);
    const session = await customerSession(user.id);
    const item = await t.request({ url: `/api/client/content/${resource.id}`, bearer: session });
    expect(item.body.files).toEqual([expect.objectContaining({ id: file.id, filename: 'handbook v2.pdf', download: { limit: 2, period: 'day', used: 0, remaining: 2, resetsAt: null } })]);

    const linkRes = await t.request({ method: 'POST', url: `/api/client/content/${resource.id}/files/${file.id}/link`, bearer: session });
    expect(linkRes.status, JSON.stringify(linkRes.body)).toBe(200);
    const link = linkRes.body;
    expect(link.url).toMatch(/^http:\/\/localhost:4000\/api\/public\/downloads\/dlk_[0-9a-z]{26}\.[0-9a-f]{64}$/);

    const first = await download(link.url);
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload.equals(PDF)).toBe(true);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['content-disposition']).toBe(`attachment; filename="handbook v2.pdf"; filename*=UTF-8''handbook%20v2.pdf`);
    expect(first.headers['cache-control']).toBe('private, no-store');
    // Probing with HEAD does not use up a download.
    expect((await download(link.url, 'HEAD')).statusCode).toBe(200);
    expect((await download(link.url)).statusCode).toBe(200);
    const third = await download(link.url);
    expect(third.statusCode).toBe(429);
    const limited = JSON.parse(third.body).error;
    expect(limited).toMatchObject({ code: 'download_limit_reached', details: { limit: 2, period: 'day' } });
    const firstAt = (await t.app.db.one<{ created_at: Date }>(sql`SELECT min(created_at) AS created_at FROM access_downloads`)).created_at;
    expect(new Date(limited.details.resetsAt).getTime()).toBe(new Date(firstAt).getTime() + DAY);
    expect((await t.request({ method: 'POST', url: `/api/client/content/${resource.id}/files/${file.id}/link`, bearer: session })).status).toBe(429);

    // The link expires after its lifetime; a fresh one works once the window has room again.
    t.clock.advance(DAY + MINUTE);
    const expired = await download(link.url);
    expect(expired.statusCode).toBe(410);
    expect(JSON.parse(expired.body).error.code).toBe('link_expired');
    const fresh = await t.request({ method: 'POST', url: `/api/client/content/${resource.id}/files/${file.id}/link`, bearer: await customerSession(user.id) });
    expect(fresh.body.download).toMatchObject({ used: 0, remaining: 2 });
    expect((await download(fresh.body.url)).statusCode).toBe(200);

    const dl = await call(t, admin, 'GET', `/api/admin/access/downloads?fileId=${file.id}`);
    expect(dl.total).toBe(3);
    expect(dl.data[0]).toMatchObject({ user_email: 'reader@example.com', file_title: 'Handbook', resource_title: 'Member handbook', bytes: PDF.length });
    const stats = await call(t, admin, 'GET', `/api/admin/access/files/${file.id}`);
    expect(stats.usage).toEqual({ downloads30d: 3, downloadsTotal: 3, customers: 1 });
    const outcomes = await t.app.db.many<{ allowed: boolean; reason: string }>(sql`SELECT allowed, reason FROM access_log WHERE event = 'download' ORDER BY created_at, id`);
    expect(outcomes.map((o) => `${o.allowed}:${o.reason}`)).toEqual(['true:plan', 'true:plan', 'false:download_limit_reached', 'false:link_expired', 'true:plan']);
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM events WHERE type = 'access_file.downloaded'`)).n).toBe(3);
  });

  it('rejects altered links and re-checks access when a link is used', async () => {
    const file = JSON.parse((await upload('/api/admin/access/files', 'guide.pdf', 'application/pdf', PDF)).body);
    const resource = await fileResource(file);
    const user = await apiUser(t, key, 'sharer@example.com');
    const sub = await subscribe(user.id);
    const session = await customerSession(user.id);
    const { url } = (await t.request({ method: 'POST', url: `/api/client/content/${resource.id}/files/${file.id}/link`, bearer: session })).body;
    const token = url.split('/').pop()!;
    const [id, sig] = token.split('.');
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'a' ? 'b' : 'a') + s.slice(i + 1);
    for (const altered of [`${id}.${flip(sig, 10)}`, `${flip(id, id.length - 1)}.${sig}`, `${id}.${sig.slice(0, -2)}`, 'dlk_00000000000000000000000000.00', 'not-a-token']) {
      expect((await download(`/api/public/downloads/${altered}`)).statusCode, altered).toBe(404);
    }
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM access_log WHERE reason = 'invalid_link'`)).n).toBe(5);
    expect((await download('/api/public/downloads/../../etc/passwd')).statusCode).toBe(404);

    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: false });
    const refused = await download(url);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).error.code).toBe('no_access');
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM access_downloads`)).n).toBe(0);

    // Short-lived by default: 15 minutes.
    await subscribe(user.id);
    const again = (await t.request({ method: 'POST', url: `/api/client/content/${resource.id}/files/${file.id}/link`, bearer: session })).body;
    t.clock.advance(16 * MINUTE);
    expect((await download(again.url)).statusCode).toBe(410);
  });

  it('replaces file contents in place and refuses to delete files that resources offer', async () => {
    const file = JSON.parse((await upload('/api/admin/access/files', 'v1.pdf', 'application/pdf', PDF)).body);
    const resource = await fileResource(file);
    const oldKey = (await t.app.db.one<{ storage_key: string }>(sql`SELECT f.storage_key FROM access_files af JOIN files f ON f.id = af.file_id WHERE af.id = ${file.id}`)).storage_key;
    const v2 = Buffer.from('%PDF-1.7\nsecond edition\n%%EOF');
    const replaced = await upload(`/api/admin/access/files/${file.id}/content`, 'v2.pdf', 'application/pdf', v2);
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(JSON.parse(replaced.body)).toMatchObject({ id: file.id, filename: 'v2.pdf', size: v2.length });
    expect(await t.app.storage.get(oldKey)).toBeNull();

    const user = await apiUser(t, key, 'v2@example.com');
    await subscribe(user.id);
    const { url } = (await t.request({ method: 'POST', url: `/api/client/content/${resource.id}/files/${file.id}/link`, bearer: await customerSession(user.id) })).body;
    expect((await download(url)).rawPayload.equals(v2)).toBe(true);

    const inUse = await t.request({ method: 'DELETE', url: `/api/admin/access/files/${file.id}`, as: admin });
    expect(inUse.body.error).toMatchObject({ code: 'file_in_use', details: { resources: [{ id: resource.id, title: 'Member handbook' }] } });
    await call(t, admin, 'PATCH', `/api/admin/access/resources/${resource.id}`, { fileIds: [] });
    expect((await t.request({ method: 'DELETE', url: `/api/admin/access/files/${file.id}`, as: admin })).status).toBe(204);
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM files WHERE owner_type = 'access_file'`)).n).toBe(0);
  });
});

// ---- Customer API -------------------------------------------------------------------------------

describe('client content', () => {
  it("shows each customer only their own content and reveals links only to those allowed", async () => {
    const [member, visitor] = [await apiUser(t, key, 'member@example.com'), await apiUser(t, key, 'visitor@example.com')];
    await subscribe(member.id);
    const secret = await protect({ kind: 'page', title: 'Strategy memo', body: '<p>Secret plan</p>', rules: { productIds: ['pro'] } });
    const teaser = await protect({ kind: 'link', title: 'Pro Slack', description: 'Join the Pro community', url: 'https://slack.example.com/join/xyz', rules: { productIds: ['pro'] }, showLocked: true });
    const file = JSON.parse((await upload('/api/admin/access/files', 'deck.pdf', 'application/pdf', Buffer.from('%PDF-1.4 deck'))).body);
    const downloads = await protect({ kind: 'file', title: 'Slides', rules: { productIds: ['pro'] }, fileIds: [file.id] });
    await protect({ kind: 'page', title: 'Draft', body: '<p>wip</p>', rules: { anyCustomer: true }, status: 'disabled' });

    const memberSession = await customerSession(member.id);
    const visitorSession = await customerSession(visitor.id);
    const mine = (await t.request({ url: '/api/client/content', bearer: memberSession })).body.data;
    expect(mine.map((i: any) => [i.title, i.state])).toEqual([['Pro Slack', 'available'], ['Slides', 'available'], ['Strategy memo', 'available']]);
    const theirs = (await t.request({ url: '/api/client/content', bearer: visitorSession })).body.data;
    expect(theirs).toEqual([expect.objectContaining({ id: teaser.id, state: 'locked', allowed: false, reason: 'no_access', description: 'Join the Pro community' })]);
    expect(JSON.stringify(theirs)).not.toContain('slack.example.com');

    expect((await t.request({ url: `/api/client/content/${secret.id}`, bearer: memberSession })).body).toMatchObject({ body: '<p>Secret plan</p>' });
    expect((await t.request({ url: `/api/client/content/${teaser.id}`, bearer: memberSession })).body.url).toBe('https://slack.example.com/join/xyz');
    expect((await t.request({ url: `/api/client/content/${secret.id}`, bearer: visitorSession })).status).toBe(404);
    const locked = await t.request({ url: `/api/client/content/${teaser.id}`, bearer: visitorSession });
    expect(locked.status).toBe(403);
    expect(JSON.stringify(locked.body)).not.toContain('slack.example.com');
    expect((await t.request({ method: 'POST', url: `/api/client/content/${downloads.id}/files/${file.id}/link`, bearer: visitorSession })).status).toBe(404);
    expect((await t.request({ method: 'POST', url: `/api/client/content/${downloads.id}/files/file_missing/link`, bearer: memberSession })).status).toBe(404);

    const views = await t.app.db.many<{ user_id: string; allowed: boolean; event: string }>(sql`SELECT user_id, allowed, event FROM access_log WHERE source = 'client' ORDER BY created_at, id`);
    expect(views.filter((v) => v.user_id === visitor.id).every((v) => !v.allowed)).toBe(true);
    expect(views.filter((v) => v.user_id === member.id).every((v) => v.allowed)).toBe(true);
  });

  it("uses the organization's products when the customer acts inside it", async () => {
    const user = await apiUser(t, key, 'teammate@corp.com');
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Team Corp' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: user.id });
    await call(t, admin, 'POST', '/api/admin/subscriptions', { orgId: org.id, priceId: cat.teamSeat.id, quantity: 3, collectionMethod: 'complimentary' });
    const playbook = await protect({ kind: 'page', title: 'Team playbook', body: '<p>Team</p>', rules: { productIds: ['team'] } });
    const personal = (await t.request({ url: '/api/client/content', bearer: await customerSession(user.id) })).body.data;
    expect(personal.map((i: any) => i.id)).not.toContain(playbook.id);
    const inOrg = (await t.request({ url: '/api/client/content', bearer: await customerSession(user.id, org.id) })).body.data;
    expect(inOrg).toEqual([expect.objectContaining({ id: playbook.id, state: 'available' })]);
    expect(await check({ orgId: org.id }, playbook.id)).toMatchObject({ allowed: true, reason: 'plan' });
  });
});

// ---- Tenancy and permissions -------------------------------------------------------------------

describe('tenant isolation and permissions', () => {
  it('limits organization-scoped administrators to their organizations', async () => {
    const orgA = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'A' });
    const orgB = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'B' });
    const [a, b] = [await apiUser(t, key, 'a@corp-a.com'), await apiUser(t, key, 'b@corp-b.com')];
    await call(t, admin, 'POST', `/api/admin/organizations/${orgA.id}/members`, { userId: a.id });
    await call(t, admin, 'POST', `/api/admin/organizations/${orgB.id}/members`, { userId: b.id });
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Partners' });
    await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members`, { users: [a.id, b.id] });
    const page = await protect({ kind: 'page', title: 'Partner kit', body: '<p>kit</p>', rules: { groupIds: [group.id] } });
    await check({ userId: a.id }, page.id);
    await check({ userId: b.id }, page.id);

    const scoped = await adminSession(t, ['admin'], [orgA.id]);
    const members = await call(t, scoped, 'GET', `/api/admin/user-groups/${group.id}/members`);
    expect(members.data.map((m: any) => m.id)).toEqual([a.id]);
    expect((await call(t, scoped, 'GET', '/api/admin/user-groups')).data[0].members).toEqual({ total: 1, manual: 1, automatic: 0 });
    expect((await call(t, scoped, 'POST', `/api/admin/user-groups/${group.id}/members`, { users: [b.id, 'b@corp-b.com'] })).added).toEqual([]);
    expect((await call(t, scoped, 'POST', `/api/admin/user-groups/${group.id}/members/remove`, { userIds: [b.id] })).removed).toEqual([]);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/user-groups/${group.id}/members/${b.id}`, as: scoped })).status).toBe(404);
    expect((await t.request({ url: `/api/admin/user-groups?userId=${b.id}`, as: scoped })).status).toBe(404);
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM user_group_members WHERE user_id = ${b.id}`)).n).toBe(1);

    for (const [method, url, body] of [
      ['POST', '/api/admin/user-groups', { name: 'Mine' }],
      ['PATCH', `/api/admin/user-groups/${group.id}`, { name: 'Renamed' }],
      ['DELETE', `/api/admin/user-groups/${group.id}`, undefined],
      ['POST', '/api/admin/access/resources', { kind: 'page', title: 'X', body: 'x' }],
      ['PATCH', `/api/admin/access/resources/${page.id}`, { title: 'Y' }],
      ['PATCH', '/api/admin/access/settings', { linkTtlMinutes: 60 }],
    ] as const) {
      const res = await t.request({ method, url, as: scoped, body });
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.error.code).toBe('org_scope');
    }
    expect((await upload('/api/admin/access/files', 'x.pdf', 'application/pdf', Buffer.from('%PDF'), { as: scoped })).statusCode).toBe(403);

    const log = await call(t, scoped, 'GET', '/api/admin/access/log');
    expect(log.data.map((l: any) => l.user_id)).toEqual([a.id]);
    expect((await t.request({ method: 'POST', url: '/api/admin/access/check', as: scoped, body: { userId: b.id, resource: page.id } })).status).toBe(404);
    expect(await call(t, scoped, 'POST', '/api/admin/access/check', { userId: a.id, resource: page.id })).toMatchObject({ allowed: true, reason: 'group', profile: { groups: [expect.objectContaining({ id: group.id })] } });
    expect((await t.request({ url: `/api/admin/access/users/${b.id}/content`, as: scoped })).status).toBe(404);
    const content = await call(t, scoped, 'GET', `/api/admin/access/users/${a.id}/content`);
    expect(content.data).toEqual([expect.objectContaining({ id: page.id, allowed: true, state: 'available' })]);
  });

  it('enforces permissions and API key scopes', async () => {
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Readers' });
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/user-groups', as: analyst })).status).toBe(200);
    expect((await t.request({ url: '/api/admin/access/resources', as: analyst })).status).toBe(200);
    expect((await t.request({ url: '/api/admin/access/log', as: analyst })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: '/api/admin/user-groups', as: analyst, body: { name: 'Nope' } })).status).toBe(403);
    expect((await t.request({ method: 'POST', url: `/api/admin/user-groups/${group.id}/members`, as: analyst, body: { users: ['x@example.com'] } })).status).toBe(403);
    expect((await t.request({ method: 'POST', url: '/api/admin/access/resources', as: analyst, body: { kind: 'page', title: 'X', body: 'x' } })).status).toBe(403);
    expect((await upload('/api/admin/access/files', 'x.pdf', 'application/pdf', Buffer.from('%PDF'), { as: analyst })).statusCode).toBe(403);
    // Support can look (to answer "why can't I open this?") but not change anything.
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/access/log', as: support })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: `/api/admin/user-groups/${group.id}/members`, as: support, body: { users: ['x@example.com'] } })).status).toBe(403);
    const marketing = await adminSession(t, ['marketing_manager']);
    expect((await t.request({ url: '/api/admin/user-groups', as: marketing })).status).toBe(403);
    expect((await t.request({ url: '/api/admin/access/log', as: marketing })).status).toBe(403);

    const user = await apiUser(t, key, 'scoped@example.com');
    const usersOnly = await apiKey(t, admin, ['users:read']);
    const denied = await t.request({ method: 'POST', url: '/api/v1/access/check', bearer: usersOnly, body: { userId: user.id, resource: '/x' } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_scope');
    expect((await t.request({ url: '/api/v1/access/resources', bearer: usersOnly, query: { userId: user.id } })).status).toBe(403);
    const accessKey = await apiKey(t, admin, ['access:read']);
    expect((await t.request({ method: 'POST', url: '/api/v1/access/check', bearer: accessKey, body: { userId: user.id, resource: '/x' } })).body).toMatchObject({ allowed: true, reason: 'unprotected' });
    // Customer tokens cannot reach admin or integration routes.
    const session = await customerSession(user.id);
    expect((await t.request({ url: '/api/admin/user-groups', bearer: session })).status).toBe(401);
    expect((await t.request({ method: 'POST', url: '/api/v1/access/check', bearer: session, body: { userId: user.id, resource: '/x' } })).status).toBe(401);
  });

  it('purges the access log after the retention period', async () => {
    const user = await apiUser(t, key, 'old@example.com');
    await check({ userId: user.id }, '/anything');
    t.clock.advance(181 * DAY);
    await check({ userId: user.id }, '/anything');
    await t.app.jobs.enqueue(t.app.db, 'system.retention', {});
    await t.app.worker.runUntilIdle();
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM access_log`)).n).toBe(1);
  });
});

// ---- Privacy and search --------------------------------------------------------------------------

describe('privacy and search', () => {
  it('exports group memberships and downloads, and erases them with the customer', async () => {
    const user = await apiUser(t, key, 'erase-me@example.com');
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Alumni' });
    await call(t, admin, 'POST', `/api/admin/user-groups/${group.id}/members`, { users: [user.id] });
    const file = JSON.parse((await upload('/api/admin/access/files', 'notes.txt', 'text/plain', Buffer.from('course notes'))).body);
    const resource = await protect({ kind: 'file', title: 'Course notes', rules: { groupIds: [group.id] }, fileIds: [file.id] });
    const { url } = (await t.request({ method: 'POST', url: `/api/client/content/${resource.id}/files/${file.id}/link`, bearer: await customerSession(user.id) })).body;
    expect((await download(url)).statusCode).toBe(200);

    const exported = await call(t, admin, 'GET', `/api/admin/users/${user.id}/export`);
    expect(exported.access.groups).toEqual([expect.objectContaining({ name: 'Alumni', manual: true, automatic: false })]);
    expect(exported.access.downloads).toEqual([expect.objectContaining({ file: 'notes.txt', ip: expect.any(String) })]);

    await call(t, admin, 'POST', `/api/admin/users/${user.id}/anonymize`, { confirm: 'ERASE' });
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM user_group_members WHERE user_id = ${user.id}`)).n).toBe(0);
    expect((await t.app.db.one<{ ip: string | null }>(sql`SELECT ip FROM access_downloads WHERE user_id = ${user.id}`)).ip).toBeNull();
    expect((await t.app.db.many<{ ip: string | null }>(sql`SELECT ip FROM access_log WHERE user_id = ${user.id}`)).every((l) => l.ip === null)).toBe(true);
  });

  it('finds protected content and groups in the admin search', async () => {
    const group = await call(t, admin, 'POST', '/api/admin/user-groups', { name: 'Webinar guests' });
    const folder = await protect({ kind: 'folder', title: 'Webinar recordings', path: '/webinars', rules: { groupIds: [group.id] } });
    const results = (await call(t, admin, 'GET', '/api/admin/search?q=webinar')).data;
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'access_resource', id: folder.id, url: `/content/resources/${folder.id}` }),
      expect.objectContaining({ type: 'user_group', id: group.id, url: `/customers/groups/${group.id}` }),
    ]));
    const marketing = await adminSession(t, ['marketing_manager']);
    expect((await call(t, marketing, 'GET', '/api/admin/search?q=webinar')).data.filter((r: any) => r.type === 'access_resource' || r.type === 'user_group')).toEqual([]);
  });
});
