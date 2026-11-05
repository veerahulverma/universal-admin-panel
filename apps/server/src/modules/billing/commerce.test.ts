import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, HOUR } from '../../core/clock.js';
import { SANDBOX_DECLINE_METHOD } from './gateways/sandbox.js';
import { payToken } from './checkout.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;
let user: { id: string };
let gateway: { id: string };

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-05-01T10:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  user = await apiUser(t, key, 'buyer@example.com');
  gateway = await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: 'sandbox-secret' } });
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0 WHERE key = 'pro'`);
});
afterEach(async () => {
  await t.close();
});

const v1 = (method: 'GET' | 'POST', url: string, body?: Record<string, unknown>) => t.request({ method, url, bearer: key, body });

async function checkout(body: Record<string, unknown>, userId = user.id) {
  const res = await v1('POST', '/api/v1/checkout/sessions', { userId, successUrl: 'https://app.example.com/ok', cancelUrl: 'https://app.example.com/cancel', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Complete a sandbox checkout through the hosted page, as a customer would. */
async function pay(checkoutId: string, outcome: 'success' | 'decline' = 'success') {
  const res = await t.server.inject({ method: 'POST', url: `/pay/sandbox/${gateway.id}/${checkoutId}`, payload: { token: payToken(t.app, checkoutId), outcome } });
  expect(res.statusCode).toBe(303);
  return res.headers.location;
}

async function product(key: string, kind: string, price: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const p = await call(t, admin, 'POST', '/api/admin/products', { key, name: key.replace(/_/g, ' '), kind, ...extra });
  const pr = await call(t, admin, 'POST', `/api/admin/products/${p.id}/prices`, { currency: 'USD', ...price });
  return { product: p, price: pr };
}

async function owned(userId = user.id): Promise<string[]> {
  const ent = (await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId } })).body;
  return ent.plans.map((p: any) => p.key).sort();
}

async function subscriptionOf(id = user.id) {
  return t.app.db.one<any>(sql`SELECT * FROM subscriptions WHERE subject_id = ${id} ORDER BY created_at DESC LIMIT 1`);
}

async function runJob(type: string) {
  await t.app.jobs.enqueue(t.app.db, type, {});
  await t.app.worker.runUntilIdle();
}

const runRenewals = () => runJob('billing.renewals');

async function customerToken(userId = user.id): Promise<string> {
  return (await v1('POST', '/api/v1/customer-sessions', { userId })).body.token;
}

async function eventsOf(type: string) {
  return t.app.db.many<any>(sql`SELECT data FROM events WHERE type = ${type} ORDER BY created_at`);
}

describe('installments', () => {
  it('bills a fixed number of payments, then ends the subscription and its access', async () => {
    const course = await product('course', 'addon', { type: 'recurring', interval: 'month', unitAmount: 10000, paymentCount: 3 });
    expect(course.price).toMatchObject({ paymentCount: 3, afterLastPayment: 'end_access' });
    await pay((await checkout({ priceId: course.price.id })).id);
    for (let i = 0; i < 2; i++) {
      t.clock.advance(31 * DAY);
      await runRenewals();
    }
    expect(await subscriptionOf()).toMatchObject({ status: 'active', installments_billed: 3, installments_paid: 3 });
    expect(await owned()).toContain('course');
    const lines = await t.app.db.many<{ description: string }>(sql`SELECT l.description FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id ORDER BY i.created_at`);
    expect(lines.map((l) => l.description)).toEqual([
      expect.stringContaining('installment 1 of 3'),
      expect.stringContaining('installment 2 of 3'),
      expect.stringContaining('installment 3 of 3'),
    ]);

    t.clock.advance(31 * DAY);
    await runRenewals();
    const sub = await subscriptionOf();
    expect(sub).toMatchObject({ status: 'canceled', cancel_reason: 'installments_completed' });
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM invoices`)).n).toBe(3);
    expect(await owned()).not.toContain('course');
    expect((await eventsOf('subscription.installments_completed')).map((e) => e.data)).toEqual([expect.objectContaining({ subscriptionId: sub.id, payments: 3, access: 'end_access', grantId: null })]);
    const mine = (await t.request({ url: '/api/client/subscriptions', bearer: await customerToken() })).body.data;
    expect(mine[0].installments).toEqual({ total: 3, paid: 3, afterLastPayment: 'end_access' });
  });

  it('lets the customer keep the product once the last installment is paid', async () => {
    const course = await product('course', 'addon', { type: 'recurring', interval: 'month', unitAmount: 10000, paymentCount: 2, afterLastPayment: 'keep_access' });
    await pay((await checkout({ priceId: course.price.id })).id);
    t.clock.advance(31 * DAY);
    await runRenewals();
    const sub = await subscriptionOf();
    expect(sub).toMatchObject({ status: 'active', installments_paid: 2 });
    // Granted when the last payment arrives, effective when the paid period ends, so access never counts twice.
    const grant = await t.app.db.one<any>(sql`SELECT * FROM entitlement_grants WHERE source_ref = ${sub.id}`);
    expect(grant).toMatchObject({ source: 'purchase', ends_at: null, product_id: course.product.id });
    expect(grant.starts_at.getTime()).toBe(sub.current_period_end.getTime());
    const before = (await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } })).body.plans.filter((p: any) => p.key === 'course');
    expect(before.map((p: any) => p.origin)).toEqual(['subscription']);

    t.clock.advance(31 * DAY);
    await runRenewals();
    expect(await subscriptionOf()).toMatchObject({ status: 'canceled', cancel_reason: 'installments_completed' });
    const after = (await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } })).body.plans.filter((p: any) => p.key === 'course');
    expect(after.map((p: any) => p.origin)).toEqual(['grant']);
    expect((await eventsOf('subscription.installments_completed'))[0].data).toMatchObject({ access: 'keep_access', grantId: grant.id });
  });

  it('keeps installment plans fixed and waits for an overdue last payment before ending', async () => {
    const course = await product('course', 'addon', { type: 'recurring', interval: 'month', unitAmount: 10000, paymentCount: 2 });
    await pay((await checkout({ priceId: course.price.id })).id);
    const sub = await subscriptionOf();
    const change = await t.request({ method: 'POST', url: `/api/admin/subscriptions/${sub.id}/change`, as: admin, body: { priceId: cat.extraPrice.id } });
    expect(change.body.error.code).toBe('installment_plan');
    const pause = await t.request({ method: 'POST', url: `/api/admin/subscriptions/${sub.id}/pause`, as: admin, body: {} });
    expect(pause.body.error.code).toBe('installment_plan');

    await t.app.db.exec(sql`UPDATE payment_methods SET gateway_ref = ${SANDBOX_DECLINE_METHOD}`);
    t.clock.advance(31 * DAY);
    await runRenewals();
    expect(await subscriptionOf()).toMatchObject({ status: 'past_due', installments_billed: 2, installments_paid: 1 });
    // The period of the unpaid last installment ends: nothing more is billed while it is due.
    t.clock.advance(31 * DAY);
    await runRenewals();
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM invoices`)).n).toBe(2);
    expect((await subscriptionOf()).status).toBe('past_due');

    const open = await t.app.db.one<{ id: string }>(sql`SELECT id FROM invoices WHERE status = 'open'`);
    await call(t, await adminSession(t), 'POST', `/api/admin/invoices/${open.id}/mark-paid`, { method: 'bank_transfer' });
    expect(await subscriptionOf()).toMatchObject({ status: 'active', installments_paid: 2 });
    await runRenewals();
    expect(await subscriptionOf()).toMatchObject({ status: 'canceled', cancel_reason: 'installments_completed' });
  });
});

describe('fixed-term access', () => {
  it('grants access for a number of days and extends it from the current end when bought again', async () => {
    const pass = await product('pass', 'one_time', { type: 'one_time', unitAmount: 1500, accessDays: 30 });
    expect(pass.price.accessDays).toBe(30);
    await pay((await checkout({ priceId: pass.price.id })).id);
    const first = await t.app.db.one<any>(sql`SELECT * FROM entitlement_grants WHERE product_id = ${pass.product.id}`);
    expect(first.ends_at.getTime() - first.starts_at.getTime()).toBe(30 * DAY);
    expect((await t.app.db.one<{ description: string }>(sql`SELECT description FROM invoice_lines`)).description).toContain('30 days of access');

    t.clock.advance(10 * DAY);
    await pay((await checkout({ priceId: pass.price.id })).id);
    const grants = await t.app.db.many<any>(sql`SELECT * FROM entitlement_grants WHERE product_id = ${pass.product.id} ORDER BY created_at`);
    expect(grants[1].starts_at.getTime()).toBe(first.ends_at.getTime());
    expect(grants[1].ends_at.getTime()).toBe(first.ends_at.getTime() + 30 * DAY);

    t.clock.advance(45 * DAY);
    expect(await owned()).toContain('pass');
    t.clock.advance(6 * DAY);
    expect(await owned()).not.toContain('pass');
  });
});

describe('purchase rules and stock', () => {
  it('enforces required products, excluded products and per-customer limits wherever a sale starts', async () => {
    const basic = await product('basic_course', 'one_time', { type: 'one_time', unitAmount: 1000 });
    const advanced = await product('advanced_course', 'one_time', { type: 'one_time', unitAmount: 2000 }, { requiresProducts: [], purchaseLimit: 1 });
    await call(t, admin, 'PATCH', `/api/admin/products/${advanced.product.id}`, { requiresProducts: [basic.product.id] });
    const starter = await product('starter_kit', 'one_time', { type: 'one_time', unitAmount: 900 }, { excludesProducts: [cat.pro.id] });

    const refused = await v1('POST', '/api/v1/checkout/sessions', { userId: user.id, priceId: advanced.price.id });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'purchase_requires', message: 'advanced course can only be bought with basic course' });
    const invoiced = await t.request({ method: 'POST', url: '/api/admin/invoices/products', as: admin, body: { userId: user.id, items: [{ priceId: advanced.price.id }] } });
    expect(invoiced.body.error.code).toBe('purchase_requires');

    // Buying the required product in the same cart is enough.
    const other = await apiUser(t, key, 'other@example.com');
    const cart = await v1('POST', '/api/v1/checkout/cart', { userId: other.id, items: [{ priceId: basic.price.id }, { priceId: advanced.price.id }] });
    expect(cart.status, JSON.stringify(cart.body)).toBe(200);

    await pay((await checkout({ priceId: basic.price.id })).id);
    const first = await checkout({ priceId: advanced.price.id });
    // The open checkout holds the one advanced course this customer may buy, even before it is paid.
    const again = await v1('POST', '/api/v1/checkout/sessions', { userId: user.id, priceId: advanced.price.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'purchase_limit_reached', message: 'advanced course can be bought once per customer' });
    await pay(first.id);
    expect(await owned()).toEqual(expect.arrayContaining(['advanced_course', 'basic_course']));

    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const excluded = await v1('POST', '/api/v1/checkout/sessions', { userId: user.id, priceId: starter.price.id });
    expect(excluded.status).toBe(422);
    expect(excluded.body.error.code).toBe('purchase_excluded');
  });

  it('reserves stock when a sale starts, releases it on expiry, void or refund, and refuses sales when sold out', async () => {
    const kit = await product('launch_kit', 'one_time', { type: 'one_time', unitAmount: 5000 }, { stockLimit: 2 });
    const second = await apiUser(t, key, 'second@example.com');
    const third = await apiUser(t, key, 'third@example.com');
    const stock = async () => (await call(t, admin, 'GET', `/api/admin/products/${kit.product.id}`)).stock;

    const chk = await checkout({ priceId: kit.price.id });
    const inv = await call(t, admin, 'POST', '/api/admin/invoices/products', { userId: second.id, items: [{ priceId: kit.price.id }] });
    expect(await stock()).toEqual({ limit: 2, sold: 0, reserved: 2, available: 0 });
    const soldOut = await v1('POST', '/api/v1/checkout/sessions', { userId: third.id, priceId: kit.price.id });
    expect(soldOut.status).toBe(409);
    expect(soldOut.body.error).toMatchObject({ code: 'sold_out', message: 'launch kit is sold out' });
    const plans = (await v1('GET', '/api/v1/plans')).body.data;
    expect(plans.find((p: any) => p.key === 'launch_kit').available).toBe(0);

    await call(t, admin, 'POST', `/api/admin/invoices/${inv.id}/void`);
    const third1 = await checkout({ priceId: kit.price.id }, third.id);
    await pay(chk.id);
    expect(await stock()).toEqual({ limit: 2, sold: 1, reserved: 1, available: 0 });

    // The third customer abandons the checkout: it expires and the unit is for sale again.
    t.clock.advance(25 * HOUR);
    await runJob('billing.maintenance');
    expect((await t.app.db.one(sql`SELECT status FROM checkout_sessions WHERE id = ${third1.id}`)).status).toBe('expired');
    expect(await stock()).toEqual({ limit: 2, sold: 1, reserved: 0, available: 1 });

    // A refund that takes the product back returns the unit to stock.
    admin = await adminSession(t);
    const payment = await t.app.db.one<{ id: string }>(sql`SELECT id FROM payments WHERE status = 'succeeded'`);
    await call(t, admin, 'POST', `/api/admin/payments/${payment.id}/refunds`, { reason: 'Returned the kit', revokeAccess: true });
    expect(await stock()).toEqual({ limit: 2, sold: 0, reserved: 0, available: 2 });
    expect(await owned()).not.toContain('launch_kit');

    // Price stock, and the admin "New subscription" route.
    const cohort = await product('cohort', 'addon', { type: 'recurring', interval: 'month', unitAmount: 3000, stockLimit: 1 });
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: user.id, priceId: cohort.price.id, collectionMethod: 'complimentary' });
    const full = await t.request({ method: 'POST', url: '/api/admin/subscriptions', as: admin, body: { userId: second.id, priceId: cohort.price.id, collectionMethod: 'complimentary' } });
    expect(full.status).toBe(409);
    expect(full.body.error).toMatchObject({ code: 'sold_out', message: 'cohort is sold out at this price' });
    await call(t, admin, 'PATCH', `/api/admin/prices/${cohort.price.id}`, { stockLimit: 2 });
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: second.id, priceId: cohort.price.id, collectionMethod: 'complimentary' });
  });
});

describe('shopping cart', () => {
  it('pays several products in one checkout and grants them all', async () => {
    const setup = await product('setup', 'one_time', { type: 'one_time', unitAmount: 5000 });
    const token = await customerToken();
    const cart = (body: Record<string, unknown>) => t.request({ method: 'POST', url: '/api/client/cart/checkout', bearer: token, body: { successUrl: 'https://app.example.com/ok', cancelUrl: 'https://app.example.com/cancel', ...body } });

    expect((await cart({ items: [{ priceId: cat.proMonthly.id, quantity: 2 }] })).status).toBe(422);
    expect((await cart({ items: [{ priceId: setup.price.id }, { priceId: setup.price.id }] })).status).toBe(422);

    const res = await cart({ items: [{ priceId: cat.proMonthly.id }, { priceId: setup.price.id, quantity: 2 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'open', amount: { subtotal: 12000, total: 12000, amountDue: 12000, currency: 'USD' } });
    expect(res.body.url).toContain(`/pay/sandbox/${gateway.id}/${res.body.id}`);
    expect(await t.app.db.one(sql`SELECT status, metadata->>'source' AS source FROM orders WHERE id = ${res.body.orderId}`)).toEqual({ status: 'pending', source: 'cart' });
    expect(await owned()).toEqual(['free']);

    expect(await pay(res.body.id)).toBe('https://app.example.com/ok');
    expect((await t.app.db.one(sql`SELECT status FROM invoices WHERE id = ${res.body.invoiceId}`)).status).toBe('paid');
    expect(await subscriptionOf()).toMatchObject({ status: 'active', price_id: cat.proMonthly.id, collection_method: 'charge_automatically' });
    expect(await t.app.db.one(sql`SELECT quantity FROM entitlement_grants WHERE product_id = ${setup.product.id}`)).toEqual({ quantity: 2 });
    expect(await owned()).toEqual(['pro', 'setup']);
    expect((await t.app.db.one(sql`SELECT status FROM stock_reservations WHERE product_id = ${setup.product.id}`)).status).toBe('sold');

    // Through the API, a cart covered by a coupon completes at once.
    await call(t, admin, 'POST', '/api/admin/coupons', { code: 'ONUS', name: 'On us', discountType: 'percent', percentOff: 100 });
    const other = await apiUser(t, key, 'other@example.com');
    const free = await v1('POST', '/api/v1/checkout/cart', { userId: other.id, items: [{ priceId: setup.price.id }], couponCode: 'ONUS', successUrl: 'https://app.example.com/ok' });
    expect(free.body).toMatchObject({ id: null, status: 'completed', url: 'https://app.example.com/ok', amount: { total: 0 } });
    expect(await owned(other.id)).toContain('setup');
  });

  it('voids an abandoned cart and releases what it held', async () => {
    const kit = await product('launch_kit', 'one_time', { type: 'one_time', unitAmount: 5000 }, { stockLimit: 1 });
    const res = await v1('POST', '/api/v1/checkout/cart', { userId: user.id, items: [{ priceId: kit.price.id }] });
    expect(res.status).toBe(200);
    const other = await apiUser(t, key, 'other@example.com');
    expect((await v1('POST', '/api/v1/checkout/sessions', { userId: other.id, priceId: kit.price.id })).body.error.code).toBe('sold_out');

    t.clock.advance(25 * HOUR);
    await runJob('billing.maintenance');
    expect((await t.app.db.one(sql`SELECT status FROM invoices WHERE id = ${res.body.invoiceId}`)).status).toBe('void');
    expect((await t.app.db.one(sql`SELECT status FROM orders WHERE id = ${res.body.orderId}`)).status).toBe('canceled');
    await checkout({ priceId: kit.price.id }, other.id);
  });
});

describe('gift vouchers', () => {
  it('redeems a product voucher once, however the code is typed, with an audit trail', async () => {
    const pass = await product('pass', 'one_time', { type: 'one_time', unitAmount: 1500 });
    const issued = await call(t, admin, 'POST', '/api/admin/vouchers', { name: 'Holiday gift', kind: 'product', productId: pass.product.id, accessDays: 30, code: 'HOLIDAY-2026' });
    expect(issued).toMatchObject({ batch: null, count: 1, vouchers: [expect.objectContaining({ code: 'HOLIDAY-2026', status: 'active', product_name: 'pass' })] });

    const token = await customerToken();
    const redeem = (code: string, bearer = token) => t.request({ method: 'POST', url: '/api/client/vouchers/redeem', bearer, body: { code } });
    const res = await redeem('holiday 2026');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ voucher: { kind: 'product', productName: 'pass', accessDays: 30 }, balance: null });
    expect(new Date(res.body.grant.endsAt).getTime() - new Date(res.body.grant.startsAt).getTime()).toBe(30 * DAY);
    expect(await owned()).toContain('pass');

    const other = await apiUser(t, key, 'other@example.com');
    const twice = await redeem('HOLIDAY-2026', await customerToken(other.id));
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('voucher_redeemed');
    expect((await redeem('NOT-A-CODE')).body.error.code).toBe('voucher_invalid');

    const audit = await t.app.db.one<any>(sql`SELECT actor_type, actor_id, metadata FROM audit_logs WHERE action = 'voucher.redeem'`);
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: user.id, metadata: { kind: 'product', productId: pass.product.id } });
    const list = await call(t, admin, 'GET', '/api/admin/vouchers?status=redeemed');
    expect(list.data.map((v: any) => [v.code, v.redeemed_by])).toEqual([['HOLIDAY-2026', 'buyer@example.com']]);
  });

  it('issues credit vouchers in batches that pay for later purchases', async () => {
    const issued = await call(t, admin, 'POST', '/api/admin/vouchers', { name: 'Store credit', kind: 'credit', creditAmount: 2500, currency: 'USD', count: 3, prefix: 'credit' });
    expect(issued.count).toBe(3);
    expect(issued.batch).toMatchObject({ name: 'Store credit', prefix: 'CREDIT', count: 3 });
    const codes: string[] = issued.vouchers.map((v: any) => v.code);
    expect(new Set(codes).size).toBe(3);
    for (const code of codes) expect(code).toMatch(/^CREDIT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const redeemed = await v1('POST', '/api/v1/vouchers/redeem', { userId: user.id, code: codes[0] });
    expect(redeemed.body).toMatchObject({ voucher: { kind: 'credit', creditAmount: 2500, currency: 'USD' }, balance: 2500 });

    // The credit pays a cart in full, so it completes without a gateway.
    const cart = await v1('POST', '/api/v1/checkout/cart', { userId: user.id, items: [{ priceId: cat.proMonthly.id }] });
    expect(cart.body).toMatchObject({ status: 'completed', amount: { total: 2000, balanceApplied: 2000, amountDue: 0 } });
    expect((await subscriptionOf()).status).toBe('active');
    expect((await t.app.db.one(sql`SELECT balance FROM customer_balances WHERE subject_id = ${user.id}`)).balance).toBe(500);

    const csv = await t.server.inject({ method: 'GET', url: `/api/admin/voucher-batches/${issued.batch.id}/codes.csv`, headers: { authorization: `Bearer ${admin.token}` } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.trim().split('\r\n')).toHaveLength(4);
    const batches = await call(t, admin, 'GET', '/api/admin/voucher-batches');
    expect(batches.data[0]).toMatchObject({ codes: 3, redeemed: 1, disabled: 0, kind: 'credit', credit_amount: 2500 });

    await call(t, admin, 'POST', `/api/admin/voucher-batches/${issued.batch.id}/disable`);
    expect((await v1('POST', '/api/v1/vouchers/redeem', { userId: user.id, code: codes[1] })).body.error.code).toBe('voucher_invalid');

    const expiring = await call(t, admin, 'POST', '/api/admin/vouchers', { name: 'Flash credit', kind: 'credit', creditAmount: 500, currency: 'USD', expiresAt: '2026-05-08T00:00:00Z' });
    t.clock.advance(8 * DAY);
    const late = await v1('POST', '/api/v1/vouchers/redeem', { userId: user.id, code: expiring.vouchers[0].code });
    expect(late.body.error).toMatchObject({ code: 'voucher_invalid', message: 'This voucher has expired' });
  });

  it('lets only unscoped administrators with the permission issue vouchers', async () => {
    const body = { name: 'Gift', kind: 'credit', creditAmount: 1000, currency: 'USD' };
    const issued = await call(t, admin, 'POST', '/api/admin/vouchers', body);
    const support = await adminSession(t, ['support']);
    // Support can see vouchers and who redeemed them, but not the codes themselves.
    const seen = await t.request({ url: '/api/admin/vouchers', as: support });
    expect(seen.body.data.map((v: any) => v.code)).toEqual([`••••${issued.vouchers[0].code.slice(-4)}`]);
    expect(seen.body.data[0].code_key).toBeUndefined();
    expect((await t.request({ method: 'POST', url: '/api/admin/vouchers', as: support, body })).status).toBe(403);
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Acme' });
    const scoped = await adminSession(t, ['billing_manager'], [org.id]);
    expect((await t.request({ method: 'POST', url: '/api/admin/vouchers', as: scoped, body })).status).toBe(403);
    expect((await t.request({ method: 'POST', url: '/api/admin/vouchers', as: admin, body: { ...body, creditAmount: undefined } })).status).toBe(422);
  });
});

describe('tax IDs', () => {
  it('checks the format of EU VAT numbers when billing details are saved, and lets a validator plug in', async () => {
    const save = (body: Record<string, unknown>) => t.request({ method: 'PUT', url: '/api/v1/billing-profile', bearer: key, body: { userId: user.id, ...body } });
    expect((await save({ address: { country: 'DE' }, taxId: 'de 123.456.789' })).body.tax_id).toBe('DE123456789');
    expect((await save({ taxId: '123456789' })).body.tax_id).toBe('DE123456789');
    const bad = await save({ taxId: 'DE12345' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details).toEqual([expect.objectContaining({ path: ['taxId'], message: 'This is not a valid DE VAT number format' })]);
    expect((await save({ address: { country: 'GR' }, taxId: '094259216' })).body.tax_id).toBe('EL094259216');
    // Other countries' IDs, and IDs declared as another type, are stored as given.
    expect((await save({ address: { country: 'US' }, taxId: '12-3456789' })).body.tax_id).toBe('12-3456789');
    expect((await save({ address: { country: 'DE' }, taxId: '12/345/67890', taxIdType: 'de_stnr' })).body.tax_id).toBe('12/345/67890');
    expect((await save({ taxId: 'FR123', taxIdType: 'eu_vat' })).status).toBe(422);

    // A registry check (VIES or another) plugs in after the format check.
    t.app.hooks.addFilter<any, unknown>('billing.tax_id.validate', 'test', (check) => (check.normalized === 'DE999999999' ? { ...check, valid: false, message: 'Not registered for VAT', source: 'test' } : check));
    const rejected = await save({ taxIdType: null, taxId: 'DE999999999' });
    expect(rejected.body.error.details[0].message).toBe('Not registered for VAT');
    const client = await t.request({ method: 'PUT', url: '/api/client/billing-profile', bearer: await customerToken(), body: { taxId: 'DE 000', taxIdType: null } });
    expect(client.status).toBe(422);
  });
});

describe('card expiry warnings', () => {
  it('warns once before the card that pays a subscription expires', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    expect(await t.app.db.one(sql`SELECT exp_month, exp_year FROM payment_methods`)).toEqual({ exp_month: 12, exp_year: 2029 });
    await runJob('billing.card_expiry');
    expect(await eventsOf('payment_method.expiring')).toEqual([]);

    // A card for a one-off purchase pays no subscription: no warning for it.
    const other = await apiUser(t, key, 'other@example.com');
    const pass = await product('pass', 'one_time', { type: 'one_time', unitAmount: 1500 });
    await pay((await checkout({ priceId: pass.price.id }, other.id)).id);

    // The card works through May 31; warn 45 days ahead.
    await t.app.db.exec(sql`UPDATE payment_methods SET exp_month = 5, exp_year = 2026`);
    await call(t, admin, 'PATCH', '/api/admin/settings/billing', { cardExpiryWarningDays: 45 });
    await runJob('billing.card_expiry');
    await runJob('billing.card_expiry');
    const events = await eventsOf('payment_method.expiring');
    expect(events.map((e) => e.data)).toEqual([expect.objectContaining({ brand: 'visa', last4: '4242', expMonth: 5, expYear: 2026, subscriptionIds: [(await subscriptionOf()).id] })]);
    const email = await t.app.db.one<any>(sql`SELECT to_email, subject FROM email_messages WHERE template_key = 'billing.card_expiring'`);
    expect(email).toEqual({ to_email: 'buyer@example.com', subject: 'Your Visa card ending in 4242 expires soon' });

    // The gateway reports a renewed card: the new expiry is watched again later.
    await t.app.db.exec(sql`UPDATE payment_methods SET exp_month = 5, exp_year = 2029`);
    await runJob('billing.card_expiry');
    expect(await eventsOf('payment_method.expiring')).toHaveLength(1);
  });
});
