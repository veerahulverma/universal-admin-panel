import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;

beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
});
afterEach(async () => {
  await t.close();
});

const post = (url: string, body: unknown) => t.request({ method: 'POST', url, as: admin, body });

describe('prices', () => {
  it('stores installments, fixed-term access and stock, and refuses them where they make no sense', async () => {
    const installments = await call(t, admin, 'POST', `/api/admin/products/${cat.pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', unitAmount: 7000, paymentCount: 3, afterLastPayment: 'keep_access', stockLimit: 50 });
    expect(installments).toMatchObject({ paymentCount: 3, afterLastPayment: 'keep_access', accessDays: null, stockLimit: 50 });
    const pass = await call(t, admin, 'POST', '/api/admin/products', { key: 'pass', name: 'Pass', kind: 'one_time' });
    expect(await call(t, admin, 'POST', `/api/admin/products/${pass.id}/prices`, { currency: 'USD', type: 'one_time', unitAmount: 900, accessDays: 30 })).toMatchObject({ accessDays: 30, paymentCount: null });

    const refusals = [
      [`/api/admin/products/${pass.id}/prices`, { currency: 'USD', type: 'one_time', unitAmount: 900, paymentCount: 3 }, 'paymentCount'],
      [`/api/admin/products/${cat.pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', unitAmount: 900, accessDays: 30 }, 'accessDays'],
      [`/api/admin/products/${cat.pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', pricingModel: 'usage', meterKey: 'api_calls', unitAmount: 1, paymentCount: 3 }, 'paymentCount'],
    ] as const;
    for (const [url, body, field] of refusals) {
      const res = await post(url, body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.details[0].path).toContain(field);
    }
    const pack = await call(t, admin, 'POST', '/api/admin/products', { key: 'pack', name: 'Pack', kind: 'credit_pack', creditType: 'credits', creditAmount: 100 });
    expect((await post(`/api/admin/products/${pack.id}/prices`, { currency: 'USD', type: 'one_time', unitAmount: 900, accessDays: 30 })).status).toBe(422);

    // Stock can be changed later; the commercial terms cannot.
    const restocked = await call(t, admin, 'PATCH', `/api/admin/prices/${installments.id}`, { stockLimit: null });
    expect(restocked).toMatchObject({ stockLimit: null, paymentCount: 3 });
    const detail = await call(t, admin, 'GET', `/api/admin/products/${cat.pro.id}`);
    expect(detail.prices.find((p: any) => p.id === installments.id).stock).toEqual({ sold: 0, reserved: 0, available: null });
  });
});

describe('purchase rules', () => {
  it('validates the products a rule refers to', async () => {
    const kit = await call(t, admin, 'POST', '/api/admin/products', { key: 'kit', name: 'Kit', kind: 'one_time', requiresProducts: [cat.pro.id, cat.team.id], purchaseLimit: 1, stockLimit: 10 });
    expect(kit).toMatchObject({ requires_products: [cat.pro.id, cat.team.id], excludes_products: [], purchase_limit: 1, stock_limit: 10 });
    expect((await t.request({ method: 'PATCH', url: `/api/admin/products/${kit.id}`, as: admin, body: { excludesProducts: [kit.id] } })).status).toBe(422);
    expect((await t.request({ method: 'PATCH', url: `/api/admin/products/${kit.id}`, as: admin, body: { excludesProducts: ['prod_missing'] } })).status).toBe(422);
    expect((await t.request({ method: 'PATCH', url: `/api/admin/products/${kit.id}`, as: admin, body: { excludesProducts: [cat.pro.id] } })).status).toBe(422);
    const updated = await call(t, admin, 'PATCH', `/api/admin/products/${kit.id}`, { excludesProducts: [cat.extra.id], stockLimit: null });
    expect(updated).toMatchObject({ requires_products: [cat.pro.id, cat.team.id], excludes_products: [cat.extra.id], purchase_limit: 1, stock_limit: null });
  });
});

describe('bundles', () => {
  it('confers the included products while the bundle is owned', async () => {
    const key = await apiKey(t, admin);
    const user = await apiUser(t, key, 'bundle@example.com');
    const suite = await call(t, admin, 'POST', '/api/admin/products', { key: 'suite', name: 'Suite', kind: 'one_time' });
    await call(t, admin, 'PUT', `/api/admin/products/${suite.id}/bundle`, { productIds: [cat.pro.id, cat.extra.id] });
    const detail = await call(t, admin, 'GET', `/api/admin/products/${suite.id}`);
    expect(detail.bundle.map((p: any) => p.key)).toEqual(['extra_calls', 'pro']);
    expect((await call(t, admin, 'GET', `/api/admin/products/${cat.pro.id}`)).includedIn.map((p: any) => p.key)).toEqual(['suite']);

    const grant = await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: user.id, productId: suite.id, reason: 'Partner deal' });
    const ent = (await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } })).body;
    expect(ent.plans.map((p: any) => [p.key, p.origin, p.originId]).sort()).toEqual([
      ['extra_calls', 'bundle', suite.id],
      ['pro', 'bundle', suite.id],
      ['suite', 'grant', grant.id],
    ]);
    expect(ent.features.sso.enabled).toBe(true);
    expect(ent.features.api_calls.limit).toBe(1500);

    await call(t, admin, 'POST', `/api/admin/entitlement-grants/${grant.id}/revoke`);
    const after = (await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } })).body;
    expect(after.plans.map((p: any) => p.key)).toEqual(['free']);
  });

  it('refuses cycles, credit packs and self-inclusion, and copies the bundle when duplicating', async () => {
    const suite = await call(t, admin, 'POST', '/api/admin/products', { key: 'suite', name: 'Suite', kind: 'one_time' });
    const outer = await call(t, admin, 'POST', '/api/admin/products', { key: 'outer', name: 'Outer', kind: 'one_time' });
    await call(t, admin, 'PUT', `/api/admin/products/${suite.id}/bundle`, { productIds: [cat.extra.id] });
    await call(t, admin, 'PUT', `/api/admin/products/${outer.id}/bundle`, { productIds: [suite.id] });
    const cycle = await t.request({ method: 'PUT', url: `/api/admin/products/${cat.extra.id}/bundle`, as: admin, body: { productIds: [outer.id] } });
    expect(cycle.status).toBe(422);
    expect(cycle.body.error.details[0].message).toBe('Outer already includes Extra calls');
    expect((await t.request({ method: 'PUT', url: `/api/admin/products/${suite.id}/bundle`, as: admin, body: { productIds: [suite.id] } })).status).toBe(422);
    const pack = await call(t, admin, 'POST', '/api/admin/products', { key: 'pack', name: 'Pack', kind: 'credit_pack', creditType: 'credits', creditAmount: 100 });
    expect((await t.request({ method: 'PUT', url: `/api/admin/products/${suite.id}/bundle`, as: admin, body: { productIds: [pack.id] } })).status).toBe(422);

    const copy = await call(t, admin, 'POST', `/api/admin/products/${outer.id}/duplicate`, { key: 'outer_copy', name: 'Outer copy' });
    expect((await call(t, admin, 'GET', `/api/admin/products/${copy.id}`)).bundle.map((p: any) => p.id)).toEqual([suite.id]);
    expect(await t.app.db.many(sql`SELECT action FROM audit_logs WHERE action = 'product.bundle_update'`)).toHaveLength(2);
  });
});

describe('coupon batches', () => {
  it('generates unique single-use codes from one set of terms and exports them', async () => {
    const batch = await call(t, admin, 'POST', '/api/admin/coupon-batches', { name: 'Spring mailer', prefix: 'spring-', count: 25, discountType: 'percent', percentOff: 15, campaign: 'spring' });
    expect(batch).toMatchObject({ name: 'Spring mailer', prefix: 'SPRING-', count: 25, codes: 25, redeemed: 0, active_codes: 25, discount_type: 'percent', percent_off_bps: 1500 });

    const codes = await t.app.db.many<any>(sql`SELECT * FROM coupons WHERE batch_id = ${batch.id}`);
    expect(new Set(codes.map((c) => c.code)).size).toBe(25);
    for (const c of codes) {
      expect(c.code).toMatch(/^SPRING-[A-Z2-9]{8}$/);
      expect(c).toMatchObject({ max_redemptions: 1, max_per_customer: 1, campaign: 'spring' });
    }
    // Hand-made coupons stay uncluttered; batch codes are listed per batch or found by searching.
    await call(t, admin, 'POST', '/api/admin/coupons', { code: 'WELCOME', name: 'Welcome', discountType: 'percent', percentOff: 10 });
    expect((await call(t, admin, 'GET', '/api/admin/coupons')).data.map((c: any) => c.code)).toEqual(['WELCOME']);
    expect((await call(t, admin, 'GET', `/api/admin/coupons?batchId=${batch.id}&pageSize=100`)).total).toBe(25);
    expect((await call(t, admin, 'GET', `/api/admin/coupons?q=${codes[0].code}`)).data.map((c: any) => c.id)).toEqual([codes[0].id]);

    const csv = await t.server.inject({ method: 'GET', url: `/api/admin/coupon-batches/${batch.id}/codes.csv`, headers: { authorization: `Bearer ${admin.token}` } });
    const rows = csv.body.trim().split('\r\n');
    expect(rows[0]).toBe('code,redeemed,active,expires_at');
    expect(rows).toHaveLength(26);

    const off = await call(t, admin, 'PATCH', `/api/admin/coupon-batches/${batch.id}`, { active: false });
    expect(off.active_codes).toBe(0);
    expect((await call(t, admin, 'GET', '/api/admin/coupon-batches')).data.map((b: any) => b.id)).toEqual([batch.id]);
    expect((await post('/api/admin/coupon-batches', { name: 'Bad prefix', prefix: 'NO SPACES', count: 1, discountType: 'percent', percentOff: 5 })).status).toBe(422);
    const marketing = await adminSession(t, ['marketing_manager']);
    expect((await t.request({ method: 'POST', url: '/api/admin/coupon-batches', as: marketing, body: { name: 'Ok', count: 2, discountType: 'percent', percentOff: 5 } })).status).toBe(200);
    const support = await adminSession(t, ['support']);
    expect((await t.request({ method: 'POST', url: '/api/admin/coupon-batches', as: support, body: { name: 'No', count: 2, discountType: 'percent', percentOff: 5 } })).status).toBe(403);
  });

  it('lets each batch code be redeemed once', async () => {
    const key = await apiKey(t, admin);
    const first = await apiUser(t, key, 'first@example.com');
    const second = await apiUser(t, key, 'second@example.com');
    await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: 'x' } });
    const batch = await call(t, admin, 'POST', '/api/admin/coupon-batches', { name: 'Partners', count: 2, discountType: 'percent', percentOff: 100 });
    const [code] = (await t.app.db.many<{ code: string }>(sql`SELECT code FROM coupons WHERE batch_id = ${batch.id} ORDER BY code`)).map((c) => c.code);
    const one = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: first.id, priceId: cat.extraPrice.id, couponCode: code.toLowerCase() } });
    expect(one.body).toMatchObject({ status: 'completed', amount: { total: 0 } });
    const two = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: second.id, priceId: cat.extraPrice.id, couponCode: code } });
    expect(two.body.error.code).toBe('coupon_invalid');
    expect((await call(t, admin, 'GET', '/api/admin/coupon-batches')).data[0]).toMatchObject({ codes: 2, redeemed: 1 });
  });
});
