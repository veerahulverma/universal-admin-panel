import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, HOUR, MINUTE } from '../../core/clock.js';
import { periodBounds, weighQuantity } from './engine.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;
let user: { id: string };

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-03-10T12:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  user = await apiUser(t, key, 'meter@example.com');
});
afterEach(async () => {
  await t.close();
});

const consume = (body: Record<string, unknown>) => t.request({ method: 'POST', url: '/api/v1/usage/consume', bearer: key, body: { userId: user.id, meter: 'api_calls', ...body } });

describe('hard limits', () => {
  it('never lets concurrent requests overshoot the limit', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => consume({ quantity: 1 })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const allowed = results.filter((r) => r.body.allowed).length;
    expect(allowed).toBe(10);
    expect(results.find((r) => !r.body.allowed)!.body.reason).toBe('limit_exceeded');
    const counter = await t.app.db.one(sql`SELECT used FROM usage_counters WHERE subject_id = ${user.id} AND meter_key = 'api_calls'`);
    expect(counter.used).toBe(10);
    const events = await t.app.db.one(sql`SELECT count(*)::int AS n FROM usage_events WHERE subject_id = ${user.id}`);
    expect(events.n).toBe(10);
  });

  it('counts a repeated idempotency key once, even concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => consume({ quantity: 3, idempotencyKey: 'req-123' })));
    expect(results.filter((r) => r.body.duplicate).length).toBe(7);
    const usage = await t.request({ url: '/api/v1/usage', bearer: key, query: { userId: user.id } });
    expect(usage.body.data.find((m: any) => m.meter === 'api_calls').used).toBe(3);
  });

  it('resets on the next period and keeps history', async () => {
    expect((await consume({ quantity: 10 })).body.allowed).toBe(true);
    expect((await consume({ quantity: 1 })).body.allowed).toBe(false);
    t.clock.set('2026-04-01T00:00:01Z');
    const next = await consume({ quantity: 1 });
    expect(next.body).toMatchObject({ allowed: true, used: 1, remaining: 9 });
    const counters = await t.app.db.many(sql`SELECT used FROM usage_counters WHERE subject_id = ${user.id} AND meter_key = 'api_calls' ORDER BY period_start`);
    expect(counters.map((c) => c.used)).toEqual([10, 1]);
  });

  it('emits warning and limit events once per period', async () => {
    await consume({ quantity: 8 });
    await consume({ quantity: 1 });
    await consume({ quantity: 1 });
    await consume({ quantity: 1 });
    const types = (await t.app.db.many(sql`SELECT type FROM events WHERE type LIKE 'usage.%' ORDER BY created_at`)).map((e) => e.type);
    expect(types).toEqual(['usage.limit_warning', 'usage.limit_reached']);
  });

  it('rejects features the plan does not include', async () => {
    await call(t, admin, 'PUT', `/api/admin/products/${cat.free.id}/features`, { features: [{ featureKey: 'api_calls', enabled: false, limit: 0 }] });
    expect((await consume({})).body).toMatchObject({ allowed: false, reason: 'not_in_plan' });
  });

  it('never trusts client-supplied negative usage', async () => {
    const res = await consume({ quantity: -5 });
    expect(res.status).toBe(422);
  });
});

describe('soft limits and overage', () => {
  it('allows past a soft limit and tracks overage units for billing', async () => {
    await call(t, admin, 'PUT', `/api/admin/products/${cat.free.id}/features`, {
      features: [{ featureKey: 'api_calls', limit: 10, enforcement: 'overage', overageUnitAmount: 5 }],
    });
    await consume({ quantity: 8 });
    const over = await consume({ quantity: 5 });
    expect(over.body).toMatchObject({ allowed: true, used: 13, overage: 3, warning: 'over_limit' });
  });

  it('honours grace units on hard limits', async () => {
    await call(t, admin, 'PUT', `/api/admin/products/${cat.free.id}/features`, { features: [{ featureKey: 'api_calls', limit: 10, graceUnits: 2 }] });
    expect((await consume({ quantity: 12 })).body.allowed).toBe(true);
    expect((await consume({ quantity: 1 })).body.allowed).toBe(false);
  });
});

describe('reset periods', () => {
  it('computes calendar periods in UTC', () => {
    const now = new Date('2026-03-11T15:00:00Z'); // a Wednesday
    expect(periodBounds('day', now).start.toISOString()).toBe('2026-03-11T00:00:00.000Z');
    expect(periodBounds('week', now).start.toISOString()).toBe('2026-03-09T00:00:00.000Z');
    expect(periodBounds('month', now).end!.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(periodBounds('year', now).start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(periodBounds('none', now).end).toBeNull();
    const anchor = { start: new Date('2026-03-05T00:00:00Z'), end: new Date('2026-04-05T00:00:00Z') };
    expect(periodBounds('billing_period', now, anchor).start).toEqual(anchor.start);
  });

  it('supports rolling windows', async () => {
    await call(t, admin, 'PUT', `/api/admin/products/${cat.free.id}/features`, {
      features: [{ featureKey: 'api_calls', limit: 5, resetPeriod: 'rolling', rollingWindowSeconds: 3600 }],
    });
    await consume({ quantity: 3 });
    t.clock.advance(30 * MINUTE);
    await consume({ quantity: 2 });
    expect((await consume({ quantity: 1 })).body.allowed).toBe(false);
    t.clock.advance(31 * MINUTE); // the first 3 fall out of the window
    expect((await consume({ quantity: 3 })).body).toMatchObject({ allowed: true, used: 5 });
  });
});

describe('reservations', () => {
  it('holds capacity until committed or released', async () => {
    const r = await t.request({ method: 'POST', url: '/api/v1/usage/reserve', bearer: key, body: { userId: user.id, meter: 'api_calls', quantity: 8 } });
    expect(r.body.allowed).toBe(true);
    expect((await consume({ quantity: 3 })).body.allowed).toBe(false);
    const committed = await t.request({ method: 'POST', url: `/api/v1/usage/reservations/${r.body.reservationId}/commit`, bearer: key, body: { quantity: 5 } });
    expect(committed.body).toMatchObject({ allowed: true, used: 5, remaining: 5 });
    const again = await t.request({ method: 'POST', url: `/api/v1/usage/reservations/${r.body.reservationId}/commit`, bearer: key, body: { quantity: 5 } });
    expect(again.body.duplicate).toBe(true);
    expect((await consume({ quantity: 5 })).body.allowed).toBe(true);
  });

  it('releases expired reservations automatically', async () => {
    const r = await t.request({ method: 'POST', url: '/api/v1/usage/reserve', bearer: key, body: { userId: user.id, meter: 'api_calls', quantity: 10, ttlSeconds: 30 } });
    expect((await consume({ quantity: 1 })).body.allowed).toBe(false);
    t.clock.advance(MINUTE);
    await t.app.jobs.enqueue(t.app.db, 'usage.expire_reservations', {});
    await t.app.worker.runUntilIdle();
    expect((await consume({ quantity: 1 })).body.allowed).toBe(true);
    const status = await t.app.db.one(sql`SELECT status FROM usage_reservations WHERE id = ${r.body.reservationId}`);
    expect(status.status).toBe('expired');
  });
});

describe('weights and credits', () => {
  it('applies dimension multipliers', () => {
    expect(weighQuantity({ weights: { model: { large: 10, small: 0.5 } } }, 3, { model: 'large' })).toBe(30);
    expect(weighQuantity({ weights: { model: { large: 10, small: 0.5 } } }, 3, { model: 'small' })).toBe(2);
    expect(weighQuantity({ weights: { model: { large: 10 } } }, 3, { model: 'other' })).toBe(3);
  });

  it('debits credits atomically and denies when the balance is short', async () => {
    await t.request({ method: 'POST', url: '/api/v1/credits/grant', bearer: key, body: { userId: user.id, amount: 25 } });
    const ok = await consume({ meter: 'tokens', quantity: 1, dimensions: { model: 'large' } }); // 10 units x 2 credits
    expect(ok.body).toMatchObject({ allowed: true, quantity: 10, credits: { charged: 20, balance: 5 } });
    const short = await consume({ meter: 'tokens', quantity: 3 });
    expect(short.body).toMatchObject({ allowed: false, reason: 'insufficient_credits' });
    const results = await Promise.all(Array.from({ length: 10 }, () => consume({ meter: 'tokens', quantity: 1 })));
    expect(results.filter((r) => r.body.allowed)).toHaveLength(2);
    const balance = await t.request({ url: '/api/v1/credits', bearer: key, query: { userId: user.id } });
    expect(balance.body.data[0].balance).toBe(1);
  });

  it('spends expiring credits first and expires leftovers', async () => {
    const expiresAt = new Date(t.clock.now().getTime() + DAY).toISOString();
    await t.request({ method: 'POST', url: '/api/v1/credits/grant', bearer: key, body: { userId: user.id, amount: 5, expiresAt } });
    await t.request({ method: 'POST', url: '/api/v1/credits/grant', bearer: key, body: { userId: user.id, amount: 5 } });
    await t.request({ method: 'POST', url: '/api/v1/credits/consume', bearer: key, body: { userId: user.id, amount: 3 } });
    t.clock.advance(2 * DAY);
    await t.app.jobs.enqueue(t.app.db, 'usage.expire_credits', {});
    await t.app.worker.runUntilIdle();
    const balance = await t.request({ url: '/api/v1/credits', bearer: key, query: { userId: user.id } });
    expect(balance.body.data[0].balance).toBe(5);
  });

  it('refunds the credit hold of a released reservation', async () => {
    await t.request({ method: 'POST', url: '/api/v1/credits/grant', bearer: key, body: { userId: user.id, amount: 10 } });
    const r = await t.request({ method: 'POST', url: '/api/v1/usage/reserve', bearer: key, body: { userId: user.id, meter: 'tokens', quantity: 4 } });
    expect(r.body.credits).toMatchObject({ charged: 8, balance: 2 });
    await t.request({ method: 'POST', url: `/api/v1/usage/reservations/${r.body.reservationId}/release`, bearer: key, body: {} });
    const balance = await t.request({ url: '/api/v1/credits', bearer: key, query: { userId: user.id } });
    expect(balance.body.data[0].balance).toBe(10);
  });
});

describe('gauges', () => {
  it('enforces limits on the absolute level', async () => {
    const set = (value: number) => t.request({ method: 'PUT', url: '/api/v1/usage/gauges/projects', bearer: key, body: { userId: user.id, value } });
    expect((await set(1)).body.allowed).toBe(true);
    expect((await set(2)).body).toMatchObject({ allowed: false, reason: 'limit_exceeded' });
    expect((await set(0)).body).toMatchObject({ allowed: true, used: 0 });
  });
});

describe('entitlements', () => {
  it('falls back to the default plan and merges grants, add-ons and overrides', async () => {
    const base = await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } });
    expect(base.body.plans.map((p: any) => p.key)).toEqual(['free']);
    expect(base.body.features.sso.enabled).toBe(false);
    expect(base.body.features.support_tier.value).toBe('community');

    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: user.id, productId: cat.pro.id, reason: 'Lifetime deal' });
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: user.id, productId: cat.extra.id, quantity: 2, reason: 'Promo' });
    const pro = await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } });
    expect(pro.body.plans.map((p: any) => p.key).sort()).toEqual(['extra_calls', 'pro']);
    expect(pro.body.features.api_calls.limit).toBe(2000); // 1000 + 2 x 500
    expect(pro.body.features.sso.enabled).toBe(true);
    expect(pro.body.features.support_tier.value).toBe('priority');

    const tomorrow = new Date(t.clock.now().getTime() + DAY).toISOString();
    await call(t, admin, 'POST', '/api/admin/entitlement-overrides', { userId: user.id, featureKey: 'api_calls', mode: 'add', limit: 100, reason: 'Launch week boost', expiresAt: tomorrow });
    expect((await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } })).body.features.api_calls.limit).toBe(2100);
    t.clock.advance(DAY + HOUR);
    expect((await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } })).body.features.api_calls.limit).toBe(2000);
  });

  it('checks features without recording usage', async () => {
    const check = (feature: string, quantity = 1) => t.request({ method: 'POST', url: '/api/v1/entitlements/check', bearer: key, body: { userId: user.id, feature, quantity } });
    expect((await check('sso')).body).toMatchObject({ allowed: false, reason: 'not_in_plan' });
    expect((await check('api_calls', 10)).body).toMatchObject({ allowed: true, remaining: 10 });
    expect((await check('api_calls', 11)).body).toMatchObject({ allowed: false, reason: 'limit_exceeded' });
    const usage = await t.request({ url: '/api/v1/usage', bearer: key, query: { userId: user.id } });
    expect(usage.body.data.find((m: any) => m.meter === 'api_calls').used).toBe(0);
  });

  it('scales per-seat quotas and shares organization pools', async () => {
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Acme' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: user.id });
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { orgId: org.id, productId: cat.team.id, quantity: 3, reason: 'Enterprise pilot' });
    const ent = await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id, orgId: org.id } });
    expect(ent.body.features.api_calls.limit).toBe(1500);
    const r = await t.request({ method: 'POST', url: '/api/v1/usage/consume', bearer: key, body: { userId: user.id, orgId: org.id, meter: 'api_calls', quantity: 20 } });
    expect(r.body).toMatchObject({ allowed: true, remaining: 1480 });
    const outsider = await apiUser(t, key, 'outsider@example.com');
    const denied = await t.request({ method: 'POST', url: '/api/v1/usage/consume', bearer: key, body: { userId: outsider.id, orgId: org.id, meter: 'api_calls' } });
    expect(denied.status).toBe(404);
  });
});

describe('admin tools', () => {
  it('adjusts and resets usage with an audit trail', async () => {
    await consume({ quantity: 9 });
    await call(t, admin, 'POST', '/api/admin/usage/adjust', { userId: user.id, meter: 'api_calls', quantity: -4, reason: 'Refund failed batch' });
    let summary = await call(t, admin, 'GET', `/api/admin/usage?userId=${user.id}`);
    expect(summary.meters.find((m: any) => m.meter === 'api_calls').used).toBe(5);
    await call(t, admin, 'POST', '/api/admin/usage/reset', { userId: user.id, meter: 'api_calls', reason: 'Goodwill' });
    summary = await call(t, admin, 'GET', `/api/admin/usage?userId=${user.id}`);
    expect(summary.meters.find((m: any) => m.meter === 'api_calls').used).toBe(0);
    const audit = await t.app.db.many(sql`SELECT action FROM audit_logs WHERE action LIKE 'usage.%' ORDER BY seq`);
    expect(audit.map((a) => a.action)).toEqual(['usage.adjust', 'usage.reset']);
  });

  it('summarizes consumption per meter and the top consumers', async () => {
    await consume({ quantity: 4 });
    await consume({ quantity: 3 });
    const other = await apiUser(t, key, 'second@example.com');
    await t.request({ method: 'POST', url: '/api/v1/usage/consume', bearer: key, body: { userId: other.id, meter: 'api_calls', quantity: 2 } });
    const overview = await call(t, admin, 'GET', '/api/admin/usage/overview?days=7');
    expect(overview.totals).toEqual([{ meter_key: 'api_calls', quantity: 9, subjects: 2 }]);
    expect(overview.top.map((r: any) => [r.label, r.quantity])).toEqual([['meter@example.com', 7], ['second@example.com', 2]]);
    expect(overview.daily.reduce((s: number, d: any) => s + d.quantity, 0)).toBe(9);
    const filtered = await call(t, admin, 'GET', '/api/admin/usage/overview?days=7&meter=projects');
    expect(filtered.totals).toEqual([]);
  });

  it('forecasts consumption for the period', async () => {
    t.clock.set('2026-03-16T12:00:00Z'); // roughly half way through March
    await consume({ quantity: 6 });
    const summary = await call(t, admin, 'GET', `/api/admin/usage?userId=${user.id}`);
    const calls = summary.meters.find((m: any) => m.meter === 'api_calls');
    expect(calls.forecast.projected).toBeGreaterThan(10); // on pace to exceed the quota
    expect(new Date(calls.forecast.limitReachedAt).getTime()).toBeLessThan(new Date('2026-04-01T00:00:00Z').getTime());
  });
});
