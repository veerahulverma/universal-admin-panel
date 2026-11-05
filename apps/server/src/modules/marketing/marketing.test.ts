import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, HOUR, MINUTE } from '../../core/clock.js';
import { allModules } from '../index.js';
import { emailModule } from '../email/module.js';
import { notificationsModule } from '../notifications/module.js';
import { marketingModule } from './module.js';
import { payToken } from '../billing/checkout.js';
import { setMarketingPreference, suppress } from '../email/service.js';

const modules = [...new Set([...allModules, emailModule, notificationsModule, marketingModule])];

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;

beforeEach(async () => {
  t = await createTestPlatform({ modules });
  t.clock.set('2026-06-01T09:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0`);
});
afterEach(async () => {
  await t.close();
});

async function createUser(body: Record<string, unknown>): Promise<{ id: string; email: string }> {
  return call(t, admin, 'POST', '/api/admin/users', body);
}

async function preview(rules: unknown) {
  return t.request({ method: 'POST', url: '/api/admin/segments/preview', as: admin, body: { rules } });
}

async function audience(rules: unknown): Promise<string[]> {
  const res = await preview(rules);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.sample.map((u: any) => u.email).sort();
}

async function campaign(body: Record<string, unknown>) {
  const segment = await call(t, admin, 'POST', '/api/admin/segments', { name: 'Newsletter', rules: { match: 'all', conditions: [{ field: 'tag', op: 'has', value: 'newsletter' }] } });
  return call(t, admin, 'POST', '/api/admin/campaigns', {
    name: 'June launch',
    segmentId: segment.id,
    subject: 'Big news, {{recipient.name}}',
    html: '<p>Read <a href="https://example.com/blog?x=1">the post</a>.</p>',
    ...body,
  });
}

async function messages(template?: string) {
  return t.app.db.many<any>(template ? sql`SELECT * FROM email_messages WHERE template_key = ${template} ORDER BY created_at` : sql`SELECT * FROM email_messages ORDER BY created_at`);
}

async function payCheckout(userId: string, priceId: string) {
  const chk = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId, priceId } });
  expect(chk.status, JSON.stringify(chk.body)).toBe(200);
  const gw = chk.body.url.split('/pay/sandbox/')[1].split('/')[0];
  const res = await t.server.inject({ method: 'POST', url: `/pay/sandbox/${gw}/${chk.body.id}`, payload: { token: payToken(t.app, chk.body.id), outcome: 'success' } });
  expect(res.statusCode).toBe(303);
  return chk.body.id as string;
}

async function sandbox() {
  await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: 'sbx' } });
}

describe('segments', () => {
  it('compiles every rule type into the right audience', async () => {
    await createUser({ email: 'ada@example.com', country: 'DE', tags: ['vip'], marketingConsent: true });
    await createUser({ email: 'bob@example.com', country: 'FR' });
    await createUser({ email: 'cy@example.com', country: 'US' });
    const dee = await createUser({ email: 'dee@example.com', country: 'IN' });
    const eve = await createUser({ email: 'eve@example.com' });
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: dee.id, priceId: cat.proMonthly.id, collectionMethod: 'complimentary' });
    await t.app.db.exec(sql`UPDATE users SET lifetime_revenue = 50000, last_active_at = ${t.clock.now()} WHERE id = ${eve.id}`);

    expect(await audience({ conditions: [{ field: 'plan', op: 'is', value: 'pro' }] })).toEqual(['dee@example.com']);
    expect(await audience({ conditions: [{ field: 'country', op: 'in', value: ['de', 'FR'] }] })).toEqual(['ada@example.com', 'bob@example.com']);
    expect(await audience({ conditions: [{ field: 'tag', op: 'has', value: 'vip' }] })).toEqual(['ada@example.com']);
    expect(await audience({ match: 'any', conditions: [{ field: 'country', op: 'is', value: 'US' }, { field: 'plan', op: 'is', value: 'pro' }] })).toEqual(['cy@example.com', 'dee@example.com']);
    expect(await audience({ conditions: [{ field: 'lifetime_revenue', op: 'gte', value: 10000 }] })).toEqual(['eve@example.com']);
    expect(await audience({ conditions: [{ field: 'subscription_status', op: 'is', value: 'none' }, { field: 'last_active_at', op: 'never' }] })).toEqual(['ada@example.com', 'bob@example.com', 'cy@example.com']);
    expect(await audience({ conditions: [{ field: 'marketing_consent', op: 'is', value: true }, { field: 'created_at', op: 'within_days', value: 1 }] })).toEqual(['ada@example.com']);
    expect(await audience({ conditions: [{ field: 'tag', op: 'has', value: "vip' OR 1=1 --" }] })).toEqual([]);

    const counts = await preview({ conditions: [] });
    expect(counts.body).toMatchObject({ total: 5, reachable: 1 });
    expect((await preview({ conditions: [{ field: 'country', op: 'gte', value: 1 }] })).status).toBe(422);
    expect((await preview({ conditions: [{ field: 'password_hash', op: 'is', value: 'x' }] })).status).toBe(422);
    expect((await preview({ conditions: [{ field: 'created_at', op: 'within_days', value: 'yesterday' }] })).status).toBe(422);
  });
});

describe('campaigns', () => {
  it('reaches only consenting, unsuppressed recipients in throttled batches with tagged links', async () => {
    const a = await createUser({ email: 'a@example.com', name: 'Ann', tags: ['newsletter'], marketingConsent: true });
    await createUser({ email: 'b@example.com', tags: ['newsletter'] });
    const c = await createUser({ email: 'c@example.com', tags: ['newsletter'], marketingConsent: true });
    await createUser({ email: 'd@example.com', tags: ['newsletter'], marketingConsent: true });
    await createUser({ email: 'not-in-segment@example.com', marketingConsent: true });
    await t.app.db.tx(async (tx) => {
      await setMarketingPreference(tx, t.app, { email: c.email, userId: c.id, subscribed: false, source: 'test' });
      await suppress(tx, t.app, { email: 'd@example.com', reason: 'hard_bounce', scope: 'all', source: 'test' });
    });
    const cmp = await campaign({ batchSize: 2, utmCampaign: 'June Launch!' });
    await call(t, admin, 'POST', `/api/admin/campaigns/${cmp.id}/schedule`, {});
    await t.app.worker.runUntilIdle();
    expect((await call(t, admin, 'GET', `/api/admin/campaigns/${cmp.id}`)).status).toBe('sending');
    t.clock.advance(10_000);
    await t.app.worker.runUntilIdle();

    const result = await call(t, admin, 'GET', `/api/admin/campaigns/${cmp.id}`);
    expect(result.status).toBe('sent');
    expect(result.stats.audience).toBe(4);
    const recipients = await t.app.db.many(sql`SELECT email, status, skip_reason FROM campaign_recipients WHERE campaign_id = ${cmp.id} ORDER BY email`);
    expect(recipients).toEqual([
      { email: 'a@example.com', status: 'queued', skip_reason: null },
      { email: 'b@example.com', status: 'skipped', skip_reason: 'no_consent' },
      { email: 'c@example.com', status: 'skipped', skip_reason: 'unsubscribe' },
      { email: 'd@example.com', status: 'skipped', skip_reason: 'hard_bounce' },
    ]);
    const sent = (await messages()).filter((m) => m.campaign_id === cmp.id && m.status === 'sent');
    expect(sent.map((m) => m.to_email)).toEqual([a.email]);
    expect(sent[0].subject).toBe('Big news, Ann');
    expect(sent[0].html).toContain('href="https://example.com/blog?x=1&amp;utm_source=email&amp;utm_medium=campaign&amp;utm_campaign=june-launch&amp;utm_content=');
    const unsub = /href="(http:\/\/localhost:4000\/u\/[^"]+)"/.exec(sent[0].html)![1];
    expect(unsub).not.toContain('utm_');
    expect(sent[0].headers['List-Unsubscribe']).toBe(`<${unsub}>`);
    expect(result.results.messages.sent).toBe(1);
  });

  it('stops when canceled and honours a future send time', async () => {
    for (const n of [1, 2, 3]) await createUser({ email: `u${n}@example.com`, tags: ['newsletter'], marketingConsent: true });
    const cmp = await campaign({ batchSize: 1 });
    const sendAt = new Date(t.clock.now().getTime() + HOUR).toISOString();
    await call(t, admin, 'POST', `/api/admin/campaigns/${cmp.id}/schedule`, { sendAt });
    await t.app.worker.runUntilIdle();
    expect(await messages()).toHaveLength(0);
    t.clock.advance(HOUR + MINUTE);
    await t.app.worker.runUntilIdle();
    expect((await messages()).filter((m) => m.campaign_id === cmp.id)).toHaveLength(1);
    await call(t, admin, 'POST', `/api/admin/campaigns/${cmp.id}/cancel`);
    t.clock.advance(MINUTE);
    await t.app.worker.runUntilIdle();
    expect((await messages()).filter((m) => m.campaign_id === cmp.id)).toHaveLength(1);
    expect((await call(t, admin, 'GET', `/api/admin/campaigns/${cmp.id}`)).status).toBe('canceled');
    expect((await t.request({ method: 'PATCH', url: `/api/admin/campaigns/${cmp.id}`, as: admin, body: { name: 'x' } })).status).toBe(409);
  });

  it('attributes paid orders to the campaign email that preceded them', async () => {
    await sandbox();
    const buyer = await createUser({ email: 'buyer@example.com', tags: ['newsletter'], marketingConsent: true });
    const late = await createUser({ email: 'late@example.com', tags: ['newsletter'], marketingConsent: true });
    const cmp = await campaign({});
    await call(t, admin, 'POST', `/api/admin/campaigns/${cmp.id}/schedule`, {});
    await t.app.worker.runUntilIdle();
    t.clock.advance(2 * DAY);
    await payCheckout(buyer.id, cat.proMonthly.id);
    t.clock.advance(8 * DAY);
    await payCheckout(late.id, cat.proMonthly.id);
    await t.app.worker.runUntilIdle();
    const attributions = await t.app.db.many(sql`SELECT user_id, amount, currency FROM campaign_attributions WHERE campaign_id = ${cmp.id}`);
    expect(attributions).toEqual([{ user_id: buyer.id, amount: 2000, currency: 'USD' }]);
    const result = await call(t, admin, 'GET', `/api/admin/campaigns/${cmp.id}`);
    expect(result.results.revenue).toEqual([{ currency: 'USD', amount: 2000, orders: 1 }]);
  });
});

describe('automated flows', () => {
  it('sends exactly one abandoned-checkout reminder', async () => {
    await sandbox();
    const u = await createUser({ email: 'cart@example.com', marketingConsent: true });
    const chk = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: u.id, priceId: cat.proMonthly.id } });
    expect(chk.body.status).toBe('open');
    await t.app.jobs.enqueue(t.app.db, 'marketing.abandoned_checkouts', {});
    await t.app.worker.runUntilIdle();
    expect(await messages('checkout.recovery')).toHaveLength(0);
    t.clock.advance(3 * HOUR);
    for (let i = 0; i < 2; i++) {
      await t.app.jobs.enqueue(t.app.db, 'marketing.abandoned_checkouts', {});
      await t.app.worker.runUntilIdle();
    }
    // Expiry later fires the email module's own recovery automation; the shared once-key keeps it at one email.
    t.clock.advance(DAY);
    await t.app.jobs.enqueue(t.app.db, 'billing.maintenance', {});
    await t.app.worker.runUntilIdle();
    const sent = await messages('checkout.recovery');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to_email: 'cart@example.com', status: 'sent', category: 'marketing' });
    expect(sent[0].html).toContain('Pro');
    expect((await t.app.db.one(sql`SELECT status, recovery_email_sent_at FROM checkout_sessions WHERE id = ${chk.body.id}`)).status).toBe('expired');
  });

  it('wins back customers who stay away, but not ones who came back', async () => {
    const gone = await createUser({ email: 'gone@example.com', marketingConsent: true });
    const back = await createUser({ email: 'back@example.com', marketingConsent: true });
    for (const u of [gone, back]) {
      const sub = await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: u.id, priceId: cat.proMonthly.id, collectionMethod: 'complimentary' });
      await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: false, reason: 'test' });
    }
    await t.app.worker.runUntilIdle();
    t.clock.advance(3 * DAY);
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: back.id, priceId: cat.proYearly.id, collectionMethod: 'complimentary' });
    t.clock.advance(12 * DAY);
    await t.app.worker.runUntilIdle();
    const winbacks = await messages('marketing.winback');
    expect(winbacks.map((m) => m.to_email)).toEqual(['gone@example.com']);
    expect(winbacks[0].status).toBe('sent');
  });

  it('suggests upgrades at most once per cooldown', async () => {
    const u = await createUser({ email: 'heavy@example.com', marketingConsent: true });
    const warn = () => t.app.db.tx((tx) => t.app.events.emit(tx, 'usage.limit_warning', { subjectType: 'user', subjectId: u.id, meter: 'api_calls', feature: 'api_calls', used: 9, limit: 10, percent: 90 }, { userId: u.id }));
    await warn();
    await warn();
    await t.app.worker.runUntilIdle();
    expect(await messages('marketing.upsell')).toHaveLength(1);
    t.clock.advance(31 * DAY);
    await warn();
    await t.app.worker.runUntilIdle();
    const upsells = await messages('marketing.upsell');
    expect(upsells).toHaveLength(2);
    expect(upsells[0].subject).toBe('Need more API calls?');
  });
});
