import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, HOUR } from '../../core/clock.js';
import { setMarketingPreference, suppress } from '../email/service.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-06-01T09:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0`);
});
afterEach(async () => {
  await t.close();
});

async function user(email: string, marketingConsent = false): Promise<{ id: string; email: string }> {
  return call(t, admin, 'POST', '/api/admin/users', { email, marketingConsent });
}

async function session(userId: string): Promise<string> {
  const res = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId } });
  return res.body.token;
}

async function list(body: Record<string, unknown>) {
  const res = await t.request({ method: 'POST', url: '/api/admin/lists', as: admin, body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function member(listId: string, userId: string) {
  return t.app.db.maybe<{ status: string; source: string; consented_at: Date | null }>(sql`SELECT status, source, consented_at FROM mailing_list_members WHERE list_id = ${listId} AND user_id = ${userId}`);
}

async function consents(listId: string, userId: string) {
  return (await t.app.db.many<{ action: string; source: string; ip: string | null }>(sql`SELECT action, source, ip FROM mailing_list_consents WHERE list_id = ${listId} AND user_id = ${userId} ORDER BY created_at, id`)).map((c) => [c.action, c.source, c.ip]);
}

describe('joining and leaving', () => {
  it('records consent for self-service changes and confirms double opt-in by email', async () => {
    const updates = await list({ name: 'Product updates', description: 'What shipped this month' });
    expect(updates.key).toBe('product-updates');
    const newsletter = await list({ name: 'Newsletter', doubleOptIn: true });
    const beta = await list({ name: 'Beta testers', visibility: 'hidden' });
    const ann = await user('ann@example.com');
    const token = await session(ann.id);

    const visible = await t.request({ url: '/api/client/lists', bearer: token });
    expect(visible.body.data.map((l: any) => [l.name, l.status])).toEqual([['Newsletter', null], ['Product updates', null]]);

    const joined = await t.request({ method: 'PUT', url: '/api/client/lists/product-updates', bearer: token, body: { subscribed: true }, ip: '198.51.100.20' });
    expect(joined.body).toMatchObject({ status: 'subscribed', subscribed: true });
    expect(await consents(updates.id, ann.id)).toEqual([['subscribed', 'customer', '198.51.100.20']]);
    expect((await member(updates.id, ann.id))?.consented_at).not.toBeNull();

    // Double opt-in: pending until the link in the confirmation email is used.
    const pending = await t.request({ method: 'PUT', url: `/api/client/lists/${newsletter.id}`, bearer: token, body: { subscribed: true } });
    expect(pending.body.status).toBe('pending');
    await t.request({ method: 'PUT', url: `/api/client/lists/${newsletter.id}`, bearer: token, body: { subscribed: true } });
    const confirmations = await t.app.db.many<{ html: string; category: string; status: string }>(sql`SELECT html, category, status FROM email_messages WHERE template_key = 'lists.confirm'`);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ category: 'transactional', status: 'queued' });
    const link = /href="(http:\/\/localhost:4000\/lists\/confirm\/[^"]+)"/.exec(confirmations[0].html)![1];
    const path = new URL(link).pathname;
    expect((await t.server.inject({ method: 'GET', url: path })).statusCode).toBe(200);
    expect((await member(newsletter.id, ann.id))?.status).toBe('pending');
    const confirmed = await t.server.inject({ method: 'POST', url: path, remoteAddress: '198.51.100.21' });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body).toContain('Newsletter');
    expect(await member(newsletter.id, ann.id)).toMatchObject({ status: 'subscribed', consented_at: expect.any(Date) });
    expect(await consents(newsletter.id, ann.id)).toEqual([['requested', 'customer', '203.0.113.10'], ['requested', 'customer', '203.0.113.10'], ['subscribed', 'double_opt_in', '198.51.100.21']]);
    expect((await t.server.inject({ method: 'POST', url: path.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a')) })).statusCode).toBe(404);

    // Unsubscribing cancels a pending request: the old link cannot sign them back up.
    const bob = await user('bob@example.com');
    const bobToken = await session(bob.id);
    await t.request({ method: 'PUT', url: `/api/client/lists/${newsletter.id}`, bearer: bobToken, body: { subscribed: true } });
    const bobLink = new URL(/href="([^"]+lists\/confirm\/[^"]+)"/.exec((await t.app.db.one<{ html: string }>(sql`SELECT html FROM email_messages WHERE template_key = 'lists.confirm' AND to_email = 'bob@example.com'`)).html)![1]).pathname;
    await t.request({ method: 'PUT', url: `/api/client/lists/${newsletter.id}`, bearer: bobToken, body: { subscribed: false } });
    expect((await t.server.inject({ method: 'POST', url: bobLink })).statusCode).toBe(404);

    // Hidden lists: customers cannot join, but can leave one they were put on; then nobody else can put them back.
    expect((await t.request({ method: 'PUT', url: `/api/client/lists/${beta.id}`, bearer: token, body: { subscribed: true } })).status).toBe(404);
    await call(t, admin, 'POST', `/api/admin/lists/${beta.id}/members`, { userIds: [ann.id] });
    expect((await t.request({ url: '/api/client/lists', bearer: token })).body.data.map((l: any) => l.name)).toContain('Beta testers');
    expect((await t.request({ method: 'PUT', url: `/api/client/lists/${beta.id}`, bearer: token, body: { subscribed: false } })).body.status).toBe('unsubscribed');
    const readd = await call(t, admin, 'POST', `/api/admin/lists/${beta.id}/members`, { userIds: [ann.id], confirm: true });
    expect(readd).toMatchObject({ added: 0, results: [{ userId: ann.id, error: expect.stringContaining('only they can subscribe again') }] });

    const events = await t.app.db.many<{ type: string; data: any }>(sql`SELECT type, data FROM events WHERE type LIKE 'list.%' AND user_id = ${ann.id} ORDER BY created_at, id`);
    expect(events.map((e) => [e.type, e.data.listKey, e.data.source])).toEqual([
      ['list.member_subscribed', 'product-updates', 'customer'],
      ['list.member_subscribed', 'newsletter', 'double_opt_in'],
      ['list.member_subscribed', 'beta-testers', 'admin'],
      ['list.member_unsubscribed', 'beta-testers', 'customer'],
    ]);

    // Confirmation links expire after a week.
    const cy = await user('cy@example.com');
    await t.request({ method: 'PUT', url: `/api/client/lists/${newsletter.id}`, bearer: await session(cy.id), body: { subscribed: true } });
    const cyLink = new URL(/href="([^"]+lists\/confirm\/[^"]+)"/.exec((await t.app.db.one<{ html: string }>(sql`SELECT html FROM email_messages WHERE template_key = 'lists.confirm' AND to_email = 'cy@example.com'`)).html)![1]).pathname;
    t.clock.advance(8 * DAY);
    expect((await t.server.inject({ method: 'POST', url: cyLink })).statusCode).toBe(404);
  });
});

describe('product rules', () => {
  it('joins people while they have a product and removes them when access ends', async () => {
    const pros = await list({ name: 'Pro customers', visibility: 'hidden', autoProductIds: [cat.pro.id] });
    const ann = await user('ann@example.com');
    const sub = await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: ann.id, priceId: cat.proMonthly.id, collectionMethod: 'complimentary' });
    await t.app.worker.runUntilIdle();
    expect(await member(pros.id, ann.id)).toEqual({ status: 'subscribed', source: 'rule', consented_at: null });

    // Products held by an organization count for its members.
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Acme' });
    const bob = await user('bob@acme.test');
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { orgId: org.id, productId: cat.pro.id, reason: 'team deal' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: bob.id });
    await t.app.worker.runUntilIdle();
    expect((await member(pros.id, bob.id))?.source).toBe('rule');

    // Someone who joined by themselves stays when access ends; someone who left is not added back.
    const cy = await user('cy@example.com');
    await t.request({ method: 'PUT', url: `/api/v1/lists/${pros.id}/members/${cy.id}`, bearer: key, body: { subscribed: true, consent: { ip: '192.0.2.1' } } });
    const dee = await user('dee@example.com');
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: dee.id, productId: cat.pro.id, reason: 'beta' });
    await t.app.worker.runUntilIdle();
    await call(t, admin, 'DELETE', `/api/admin/lists/${pros.id}/members/${dee.id}`);
    const cyGrant = await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: cy.id, productId: cat.pro.id, reason: 'beta' });
    await call(t, admin, 'POST', `/api/admin/entitlement-grants/${cyGrant.id}/revoke`, {});
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: dee.id, productId: cat.pro.id, reason: 'second grant' });

    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: false, reason: 'test' });
    await t.app.worker.runUntilIdle();
    expect(await member(pros.id, ann.id)).toBeNull();
    expect(await consents(pros.id, ann.id)).toEqual([['subscribed', 'rule', null], ['unsubscribed', 'rule', null]]);
    expect((await member(pros.id, cy.id))?.status).toBe('subscribed');
    expect((await member(pros.id, dee.id))?.status).toBe('unsubscribed');

    // Access that simply runs out (no event) is caught by the hourly sync.
    const eve = await user('eve@example.com');
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: eve.id, productId: cat.pro.id, endsAt: new Date(t.clock.now().getTime() + 2 * DAY).toISOString(), reason: 'trial' });
    await t.app.worker.runUntilIdle();
    expect((await member(pros.id, eve.id))?.status).toBe('subscribed');
    t.clock.advance(2 * DAY + HOUR);
    admin = await adminSession(t);
    await t.app.jobs.enqueue(t.app.db, 'marketing.lists_sync', {});
    await t.app.worker.runUntilIdle();
    expect(await member(pros.id, eve.id)).toBeNull();
    expect((await member(pros.id, bob.id))?.status).toBe('subscribed');

    // A list created later picks up existing customers; removing the rule removes the people it added.
    const late = await list({ name: 'Late list', autoProductIds: [cat.pro.id] });
    await t.app.worker.runUntilIdle();
    expect((await member(late.id, bob.id))?.source).toBe('rule');
    await call(t, admin, 'PATCH', `/api/admin/lists/${late.id}`, { autoProductIds: [] });
    await t.app.worker.runUntilIdle();
    expect(await member(late.id, bob.id)).toBeNull();
  });
});

describe('list campaigns', () => {
  it('sends to subscribers who consented and lets them leave just the list', async () => {
    const updates = await list({ name: 'Product updates' });
    const explicit = await user('explicit@example.com');
    await t.request({ method: 'PUT', url: '/api/client/lists/product-updates', bearer: await session(explicit.id), body: { subscribed: true } });
    const added = await user('added@example.com');
    const consenting = await user('consenting@example.com', true);
    const optedOut = await user('optedout@example.com');
    await t.request({ method: 'PUT', url: '/api/client/lists/product-updates', bearer: await session(optedOut.id), body: { subscribed: true } });
    const bounced = await user('bounced@example.com', true);
    await call(t, admin, 'POST', `/api/admin/lists/${updates.id}/members`, { userIds: [added.id, consenting.id, bounced.id] });
    t.clock.advance(HOUR);
    await t.app.db.tx(async (tx) => {
      await setMarketingPreference(tx, t.app, { email: optedOut.email, userId: optedOut.id, subscribed: false, source: 'test' });
      await suppress(tx, t.app, { email: bounced.email, reason: 'hard_bounce', scope: 'all', source: 'test' });
    });
    admin = await adminSession(t);

    const detail = await call(t, admin, 'GET', `/api/admin/lists/${updates.id}`);
    expect(detail.counts).toEqual({ subscribed: 5, pending: 0, unsubscribed: 0, reachable: 2 });
    const members = await call(t, admin, 'GET', `/api/admin/lists/${updates.id}/members?pageSize=10`);
    expect(Object.fromEntries(members.data.map((m: any) => [m.email, m.blocked_reason]))).toEqual({
      'explicit@example.com': null,
      'added@example.com': 'no_consent',
      'consenting@example.com': null,
      'optedout@example.com': 'unsubscribe',
      'bounced@example.com': 'hard_bounce',
    });

    expect((await t.request({ method: 'POST', url: '/api/admin/campaigns', as: admin, body: { name: 'x', subject: 's', html: '<p>x</p>' } })).status).toBe(422);
    const cmp = await call(t, admin, 'POST', '/api/admin/campaigns', { name: 'June update', listId: updates.id, subject: 'What is new', html: '<p>News</p>' });
    await call(t, admin, 'POST', `/api/admin/campaigns/${cmp.id}/schedule`, {});
    await t.app.worker.runUntilIdle();
    const recipients = await t.app.db.many(sql`SELECT email, status, skip_reason FROM campaign_recipients WHERE campaign_id = ${cmp.id} ORDER BY email`);
    expect(recipients).toEqual([
      { email: 'added@example.com', status: 'skipped', skip_reason: 'no_consent' },
      { email: 'bounced@example.com', status: 'skipped', skip_reason: 'hard_bounce' },
      { email: 'consenting@example.com', status: 'queued', skip_reason: null },
      { email: 'explicit@example.com', status: 'queued', skip_reason: null },
      { email: 'optedout@example.com', status: 'skipped', skip_reason: 'unsubscribe' },
    ]);
    const campaigns = await call(t, admin, 'GET', '/api/admin/campaigns');
    expect(campaigns.data[0]).toMatchObject({ list_id: updates.id, list_name: 'Product updates', segment_id: null });

    // The unsubscribe link leaves only this list.
    const msg = await t.app.db.one<{ headers: Record<string, string> }>(sql`SELECT headers FROM email_messages WHERE campaign_id = ${cmp.id} AND to_email = 'consenting@example.com'`);
    const unsub = new URL(/<(.+)>/.exec(msg.headers['List-Unsubscribe'])![1]).pathname;
    const page = await t.server.inject({ method: 'GET', url: unsub });
    expect(page.body).toContain('Product updates');
    const oneClick = await t.server.inject({ method: 'POST', url: unsub, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(oneClick.statusCode).toBe(200);
    expect((await member(updates.id, consenting.id))?.status).toBe('unsubscribed');
    expect((await t.app.db.one(sql`SELECT marketing_consent FROM users WHERE id = ${consenting.id}`)).marketing_consent).toBe(true);
    // ...or every marketing email, when the person asks for that.
    const explicitMsg = await t.app.db.one<{ headers: Record<string, string> }>(sql`SELECT headers FROM email_messages WHERE campaign_id = ${cmp.id} AND to_email = 'explicit@example.com'`);
    const explicitUnsub = new URL(/<(.+)>/.exec(explicitMsg.headers['List-Unsubscribe'])![1]).pathname;
    await t.server.inject({ method: 'POST', url: explicitUnsub, payload: 'scope=marketing', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await member(updates.id, explicit.id))?.status).toBe('unsubscribed');
    expect(await t.app.db.one(sql`SELECT reason, scope FROM email_suppressions WHERE email = 'explicit@example.com'`)).toEqual({ reason: 'unsubscribe', scope: 'marketing' });
  });
});

describe('integration API, external services and permissions', () => {
  it('records API consent evidence, reports newsletter services only when a plugin provides one, and checks permissions', async () => {
    const news = await list({ name: 'News' });
    const ann = await user('ann@example.com');
    const bob = await user('bob@example.com');
    const withConsent = await t.request({ method: 'PUT', url: `/api/v1/lists/news/members/${ann.id}`, bearer: key, body: { subscribed: true, consent: { ip: '192.0.2.7', userAgent: 'Signup form' } } });
    expect(withConsent.body).toMatchObject({ status: 'subscribed' });
    expect(await consents(news.id, ann.id)).toEqual([['subscribed', 'api', '192.0.2.7']]);
    await t.request({ method: 'PUT', url: `/api/v1/lists/news/members/${bob.id}`, bearer: key, body: { subscribed: true } });
    expect((await member(news.id, bob.id))?.consented_at).toBeNull();
    expect((await t.request({ url: `/api/v1/lists/news/members/${bob.id}`, bearer: key })).body.subscribed).toBe(true);
    const readOnly = await apiKey(t, admin, ['lists:read']);
    expect((await t.request({ url: '/api/v1/lists', bearer: readOnly })).body.data.map((l: any) => l.key)).toEqual(['news']);
    expect((await t.request({ method: 'PUT', url: `/api/v1/lists/news/members/${bob.id}`, bearer: readOnly, body: { subscribed: false } })).body.error.code).toBe('insufficient_scope');

    expect((await call(t, admin, 'GET', '/api/admin/lists/providers')).data).toEqual([]);
    expect((await t.request({ method: 'PATCH', url: `/api/admin/lists/${news.id}`, as: admin, body: { externalProvider: 'mailchimp', externalRef: 'a1b2' } })).status).toBe(422);
    t.app.hooks.addFilter('marketing.list_providers', 'test-mailchimp', (providers: unknown[]) => [...providers, { id: 'mailchimp', name: 'Mailchimp', connected: true }]);
    await call(t, admin, 'PATCH', `/api/admin/lists/${news.id}`, { externalProvider: 'mailchimp', externalRef: 'a1b2' });
    expect((await call(t, admin, 'GET', `/api/admin/lists/${news.id}`)).external).toEqual({ provider: 'mailchimp', ref: 'a1b2', connected: true, name: 'Mailchimp' });
    const cy = await user('cy@example.com');
    await t.request({ method: 'PUT', url: '/api/client/lists/news', bearer: await session(cy.id), body: { subscribed: true } });
    const event = await t.app.db.one<{ data: any }>(sql`SELECT data FROM events WHERE type = 'list.member_subscribed' AND user_id = ${cy.id}`);
    expect(event.data.external).toEqual({ provider: 'mailchimp', ref: 'a1b2' });

    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: `/api/admin/lists/${news.id}/members`, as: analyst })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: '/api/admin/lists', as: analyst, body: { name: 'Nope' } })).status).toBe(403);
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/lists', as: support })).status).toBe(403);
    const marketer = await adminSession(t, ['marketing_manager']);
    expect((await t.request({ method: 'POST', url: `/api/admin/lists/${news.id}/members`, as: marketer, body: { userIds: [cy.id] } })).status).toBe(200);
    const history = await call(t, marketer, 'GET', `/api/admin/lists/${news.id}/members/${ann.id}/history`);
    expect(history.data.map((h: any) => h.action)).toEqual(['subscribed']);
    const memberships = await call(t, marketer, 'GET', `/api/admin/lists/memberships?userId=${bob.id}`);
    expect(memberships.data).toEqual([expect.objectContaining({ key: 'news', status: 'subscribed', source: 'api', consented_at: null, blocked_reason: 'no_consent' })]);

    const used = await call(t, admin, 'POST', '/api/admin/campaigns', { name: 'To news', listId: news.id, subject: 's', html: '<p>x</p>' });
    expect((await t.request({ method: 'DELETE', url: `/api/admin/lists/${news.id}`, as: admin })).body.error.code).toBe('list_in_use');
    await call(t, admin, 'DELETE', `/api/admin/campaigns/${used.id}`);
    await call(t, admin, 'DELETE', `/api/admin/lists/${news.id}`);
    const audit = (await t.app.db.many<{ action: string }>(sql`SELECT action FROM audit_logs WHERE action LIKE 'mailing_list.%' ORDER BY seq`)).map((a) => a.action);
    expect(audit).toEqual(['mailing_list.create', 'mailing_list.update', 'mailing_list.member_add', 'mailing_list.delete']);
  });
});
