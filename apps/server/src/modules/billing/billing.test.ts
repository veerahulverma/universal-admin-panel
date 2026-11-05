import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';
import { signSandboxEvent, SANDBOX_DECLINE_METHOD } from './gateways/sandbox.js';
import { addInterval, computeTax, tieredAmount, unusedValue, usageAmount } from './money.js';
import { payToken } from './checkout.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;
let user: { id: string };
let gateway: { id: string };
const SECRET = 'sandbox-test-secret';

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-05-01T10:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  user = await apiUser(t, key, 'buyer@example.com');
  gateway = await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: SECRET } });
  // Skip the 14-day trial for most tests by marking the pro trial as used.
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0 WHERE key = 'pro'`);
});
afterEach(async () => {
  await t.close();
});

async function checkout(body: Record<string, unknown>) {
  const res = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: user.id, successUrl: 'https://app.example.com/ok', cancelUrl: 'https://app.example.com/cancel', ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Complete a sandbox checkout through the hosted page, exactly as a customer would. */
async function pay(checkoutId: string, outcome: 'success' | 'decline' = 'success') {
  const page = await t.server.inject({ method: 'GET', url: `/pay/sandbox/${gateway.id}/${checkoutId}` });
  expect(page.statusCode).toBe(200);
  const res = await t.server.inject({ method: 'POST', url: `/pay/sandbox/${gateway.id}/${checkoutId}`, payload: { token: payToken(t.app, checkoutId), outcome } });
  expect(res.statusCode).toBe(303);
  return res.headers.location;
}

async function entitlements() {
  return (await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id } })).body;
}

async function subscriptionOf(id = user.id) {
  return t.app.db.one<any>(sql`SELECT * FROM subscriptions WHERE subject_id = ${id} ORDER BY created_at DESC LIMIT 1`);
}

/** The test clock keeps flowing in real time, so allow for slow machines. */
function expectNear(actual: Date, expected: string, toleranceMs = 30_000) {
  expect(Math.abs(new Date(actual).getTime() - new Date(expected).getTime())).toBeLessThan(toleranceMs);
}

async function runRenewals() {
  await t.app.jobs.enqueue(t.app.db, 'billing.renewals', {});
  await t.app.worker.runUntilIdle();
}

async function runDunningJob() {
  await t.app.jobs.enqueue(t.app.db, 'billing.dunning', {});
  await t.app.worker.runUntilIdle();
}

describe('money math', () => {
  it('handles intervals, taxes, proration and tiers', () => {
    expect(addInterval(new Date('2026-01-31T00:00:00Z'), 'month').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addInterval(new Date('2028-01-31T00:00:00Z'), 'month').toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(addInterval(new Date('2026-03-15T00:00:00Z'), 'month', 3).toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(computeTax(10000, 1900, false)).toEqual({ net: 10000, tax: 1900, total: 11900 });
    expect(computeTax(11900, 1900, true)).toEqual({ net: 10000, tax: 1900, total: 11900 });
    expect(unusedValue(3000, new Date('2026-01-01'), new Date('2026-01-31'), new Date('2026-01-16'))).toBe(1500);
    const tiers = [{ upTo: 100, unitAmount: 10 }, { upTo: 1000, unitAmount: 5 }, { upTo: null, unitAmount: 1 }];
    expect(tieredAmount(150, tiers, 'graduated')).toBe(100 * 10 + 50 * 5);
    expect(tieredAmount(150, tiers, 'volume')).toBe(150 * 5);
    expect(usageAmount({ pricing_model: 'usage', unit_amount: 2, included_units: 100, tiers: null, tier_mode: null, package_size: null, meter_key: 'x' }, 250)).toBe(300);
    expect(usageAmount({ pricing_model: 'usage', unit_amount: 500, included_units: 0, tiers: null, tier_mode: null, package_size: 1000, meter_key: 'x' }, 2500)).toBe(1500);
  });
});

describe('checkout and webhooks', () => {
  it('turns a paid checkout into an order, paid invoice, active subscription and entitlements', async () => {
    const chk = await checkout({ priceId: cat.proMonthly.id });
    expect(chk).toMatchObject({ status: 'open', amount: { total: 2000, currency: 'USD' } });
    expect(chk.url).toContain(`/pay/sandbox/${gateway.id}/${chk.id}`);
    expect((await entitlements()).plans.map((p: any) => p.key)).toEqual(['free']);

    const redirect = await pay(chk.id);
    expect(redirect).toBe('https://app.example.com/ok');

    const sub = await subscriptionOf();
    expect(sub).toMatchObject({ status: 'active', collection_method: 'charge_automatically', currency: 'USD' });
    expectNear(sub.current_period_end, '2026-06-01T10:00:00Z');
    const inv = await t.app.db.one(sql`SELECT * FROM invoices WHERE subscription_id = ${sub.id}`);
    expect(inv).toMatchObject({ status: 'paid', total: 2000, amount_paid: 2000, number: 'INV-2026-000001' });
    const order = await t.app.db.one(sql`SELECT * FROM orders WHERE subscription_id = ${sub.id}`);
    expect(order).toMatchObject({ status: 'paid', number: 'ORD-2026-000001' });
    // Invoices and payments link to their order by ID; the admin order search accepts it.
    for (const q of [order.id, 'ORD-2026-000001']) {
      const found = await call(t, admin, 'GET', `/api/admin/orders?q=${encodeURIComponent(q)}`);
      expect(found.data.map((o: any) => o.id)).toEqual([order.id]);
    }
    expect((await t.app.db.one(sql`SELECT lifetime_revenue FROM users WHERE id = ${user.id}`)).lifetime_revenue).toBe(2000);
    const ent = await entitlements();
    expect(ent.plans.map((p: any) => p.key)).toEqual(['pro']);
    expect(ent.features.api_calls.limit).toBe(1000);
    const types = (await t.app.db.many(sql`SELECT type FROM events WHERE type IN ('checkout.completed', 'order.paid', 'invoice.paid', 'payment.succeeded', 'subscription.created')`)).map((e) => e.type).sort();
    expect(types).toEqual(['checkout.completed', 'invoice.paid', 'order.paid', 'payment.succeeded', 'subscription.created']);
  });

  it('processes each gateway event exactly once and rejects bad signatures', async () => {
    const chk = await checkout({ priceId: cat.proMonthly.id });
    const event = { type: 'payment.succeeded' as const, eventId: 'evt_dup_1', checkoutId: chk.id, gatewayPaymentId: 'pi_dup_1', amount: 2000, currency: 'USD', paymentMethodRef: 'pm_ok' };
    const signed = signSandboxEvent(SECRET, event);
    const send = (sig: string) => t.server.inject({ method: 'POST', url: `/api/public/gateways/${gateway.id}/webhook`, payload: signed.body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig } });
    expect((await send('forged')).statusCode).toBe(400);
    const first = await send(signed.signature);
    expect(JSON.parse(first.body)).toMatchObject({ processed: 1, duplicates: 0 });
    const second = await send(signed.signature);
    expect(JSON.parse(second.body)).toMatchObject({ processed: 0, duplicates: 1 });
    // Same payment arriving under a different event id (e.g. return URL + webhook) is also a no-op.
    const other = signSandboxEvent(SECRET, { ...event, eventId: 'evt_dup_2' });
    await t.server.inject({ method: 'POST', url: `/api/public/gateways/${gateway.id}/webhook`, payload: other.body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': other.signature } });
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM payments`)).n).toBe(1);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM subscriptions`)).n).toBe(1);
  });

  it('refuses to fulfil a checkout when the paid amount does not match', async () => {
    const chk = await checkout({ priceId: cat.proMonthly.id });
    const signed = signSandboxEvent(SECRET, { type: 'payment.succeeded', eventId: 'evt_low', checkoutId: chk.id, gatewayPaymentId: 'pi_low', amount: 1, currency: 'USD' });
    await t.server.inject({ method: 'POST', url: `/api/public/gateways/${gateway.id}/webhook`, payload: signed.body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': signed.signature } });
    expect((await t.app.db.one(sql`SELECT status, failure_message FROM checkout_sessions WHERE id = ${chk.id}`))).toMatchObject({ status: 'failed', failure_message: 'amount_mismatch' });
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM subscriptions`)).n).toBe(0);
  });

  it('keeps the checkout open after a declined card', async () => {
    const chk = await checkout({ priceId: cat.proMonthly.id });
    expect(await pay(chk.id, 'decline')).toBe('https://app.example.com/cancel');
    expect((await t.app.db.one(sql`SELECT status FROM checkout_sessions WHERE id = ${chk.id}`)).status).toBe('open');
    await pay(chk.id, 'success');
    expect((await subscriptionOf()).status).toBe('active');
  });

  it('prevents double subscriptions to plans', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const again = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: user.id, priceId: cat.proYearly.id } });
    expect(again.body.error.code).toBe('already_subscribed');
  });
});

describe('trials, coupons and taxes', () => {
  it('starts trials without payment and expires them into past due when unpaid', async () => {
    await t.app.db.exec(sql`UPDATE products SET trial_days = 14, grace_days = 3 WHERE key = 'pro'`);
    const chk = await checkout({ priceId: cat.proMonthly.id });
    expect(chk).toMatchObject({ status: 'completed', trialDays: 14 });
    const sub = await subscriptionOf();
    expect(sub.status).toBe('trialing');
    expect((await entitlements()).features.sso.enabled).toBe(true);
    // Trial ends: no card on file, so an invoice is issued for manual payment.
    t.clock.advance(15 * DAY);
    await runRenewals();
    const inv = await t.app.db.one<any>(sql`SELECT * FROM invoices WHERE subscription_id = ${sub.id}`);
    expect(inv).toMatchObject({ status: 'open', total: 2000 });
    expect((await subscriptionOf()).status).toBe('active');
    // Unpaid past the due date and grace period: access ends.
    t.clock.advance(8 * DAY);
    await runDunningJob();
    expect((await subscriptionOf()).status).toBe('past_due');
    t.clock.advance(4 * DAY);
    await runDunningJob();
    expect((await subscriptionOf()).status).toBe('canceled');
    expect((await entitlements()).plans.map((p: any) => p.key)).toEqual(['free']);
    // A second checkout does not get another trial.
    expect((await checkout({ priceId: cat.proMonthly.id })).trialDays).toBe(0);
  });

  it('charges a trial that requires a payment method once: the checkout pays the first period after the trial', async () => {
    await t.app.db.exec(sql`UPDATE products SET trial_days = 14, trial_requires_payment_method = true WHERE key = 'pro'`);
    const chk = await checkout({ priceId: cat.proMonthly.id });
    expect(chk).toMatchObject({ status: 'open', trialDays: 14 });
    await pay(chk.id);
    const sub = await subscriptionOf();
    expect(sub.status).toBe('trialing');
    const first = await t.app.db.one<any>(sql`SELECT * FROM invoices WHERE subscription_id = ${sub.id}`);
    expect(first).toMatchObject({ status: 'paid', total: 2000 });
    expect(first.period_start.toISOString()).toBe(sub.trial_end.toISOString());
    // The trial ends: the paid period starts without a second invoice or charge.
    t.clock.advance(15 * DAY);
    await runRenewals();
    const active = await subscriptionOf();
    expect(active.status).toBe('active');
    expect(active.current_period_start.toISOString()).toBe(sub.trial_end.toISOString());
    expect(active.current_period_end.toISOString()).toBe(addInterval(sub.trial_end, 'month').toISOString());
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM invoices WHERE subscription_id = ${sub.id}`)).n).toBe(1);
    // The period after that is billed to the saved card as usual.
    t.clock.advance(31 * DAY);
    await runRenewals();
    const invoices = await t.app.db.many<any>(sql`SELECT status, total FROM invoices WHERE subscription_id = ${sub.id} ORDER BY created_at`);
    expect(invoices).toEqual([{ status: 'paid', total: 2000 }, { status: 'paid', total: 2000 }]);
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM payments WHERE status = 'succeeded'`)).n).toBe(2);
  });

  it('keeps the paid period of a card-required trial that is cancelled during the trial', async () => {
    await t.app.db.exec(sql`UPDATE products SET trial_days = 14, trial_requires_payment_method = true WHERE key = 'pro'`);
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const sub = await subscriptionOf();
    await t.request({ method: 'POST', url: `/api/v1/subscriptions/${sub.id}/cancel`, bearer: key, body: { atPeriodEnd: true } });
    t.clock.advance(15 * DAY);
    await runRenewals();
    expect(await subscriptionOf()).toMatchObject({ status: 'active', cancel_at_period_end: true });
    expect((await entitlements()).features.sso.enabled).toBe(true);
    t.clock.advance(31 * DAY);
    await runRenewals();
    expect((await subscriptionOf()).status).toBe('canceled');
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM invoices WHERE subscription_id = ${sub.id}`)).n).toBe(1);
  });

  it('applies a once-only coupon to the first invoice and enforces redemption limits', async () => {
    await call(t, admin, 'POST', '/api/admin/coupons', { code: 'LAUNCH50', name: 'Launch', discountType: 'percent', percentOff: 50, maxRedemptions: 1 });
    const chk = await checkout({ priceId: cat.proMonthly.id, couponCode: 'launch50' });
    expect(chk.amount).toMatchObject({ subtotal: 2000, discount: 1000, total: 1000 });
    await pay(chk.id);
    t.clock.advance(31 * DAY);
    await runRenewals();
    const invoices = await t.app.db.many(sql`SELECT total FROM invoices ORDER BY created_at`);
    expect(invoices.map((i) => i.total)).toEqual([1000, 2000]);
    const other = await apiUser(t, key, 'second@example.com');
    const used = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: other.id, priceId: cat.proMonthly.id, couponCode: 'LAUNCH50' } });
    expect(used.body.error.code).toBe('coupon_invalid');
  });

  it('charges VAT by country and applies B2B reverse charge', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/billing', { taxEnabled: true, sellerCountry: 'IE' });
    await call(t, admin, 'POST', '/api/admin/tax-rates', { name: 'VAT', country: 'DE', ratePercent: 19, reverseChargeB2b: true });
    await t.request({ method: 'PUT', url: '/api/v1/billing-profile', bearer: key, body: { userId: user.id, name: 'Ada', address: { country: 'DE', city: 'Berlin' } } });
    const consumer = await checkout({ priceId: cat.proMonthly.id });
    expect(consumer.amount).toMatchObject({ subtotal: 2000, tax: 380, total: 2380 });
    await t.request({ method: 'PUT', url: '/api/v1/billing-profile', bearer: key, body: { userId: user.id, taxId: 'DE123456789' } });
    const business = await checkout({ priceId: cat.proMonthly.id });
    expect(business.amount).toMatchObject({ tax: 0, total: 2000 });
    await pay(business.id);
    const inv = await t.app.db.one<any>(sql`SELECT tax_note, customer_details FROM invoices LIMIT 1`);
    expect(inv.tax_note).toMatch(/Reverse charge/);
    expect(inv.customer_details.taxId).toBe('DE123456789');
  });
});

describe('renewals and dunning', () => {
  it('renews with the saved card and keeps entitlements', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    t.clock.advance(31 * DAY);
    await runRenewals();
    const sub = await subscriptionOf();
    expect(sub.status).toBe('active');
    expectNear(sub.current_period_end, '2026-07-01T10:00:00Z');
    const invoices = await t.app.db.many(sql`SELECT status, billing_reason FROM invoices ORDER BY created_at`);
    expect(invoices).toEqual([{ status: 'paid', billing_reason: 'checkout' }, { status: 'paid', billing_reason: 'subscription_cycle' }]);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM payments WHERE status = 'succeeded'`)).n).toBe(2);
  });

  it('enters dunning on a declined renewal, retries, then cancels and revokes access', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    await t.app.db.exec(sql`UPDATE payment_methods SET gateway_ref = ${SANDBOX_DECLINE_METHOD}`);
    t.clock.advance(31 * DAY);
    await runRenewals();
    let sub = await subscriptionOf();
    expect(sub.status).toBe('past_due');
    expect((await entitlements()).plans.map((p: any) => p.key)).toEqual(['pro']); // grace period
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM events WHERE type = 'invoice.payment_failed'`)).n).toBe(1);
    // Retries on days 1, 3 and 5 all fail.
    for (const days of [1, 3, 5]) {
      t.clock.advance(days * DAY + 60_000);
      await runDunningJob();
    }
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM payments WHERE status = 'failed'`)).n).toBe(4);
    t.clock.advance(DAY);
    await runDunningJob();
    sub = await subscriptionOf();
    expect(sub).toMatchObject({ status: 'canceled', cancel_reason: 'payment_failed' });
    expect((await t.app.db.one(sql`SELECT status FROM invoices WHERE billing_reason = 'subscription_cycle'`)).status).toBe('uncollectible');
    expect((await entitlements()).plans.map((p: any) => p.key)).toEqual(['free']);
  });

  it('recovers when a retry succeeds', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const original = (await t.app.db.one<{ gateway_ref: string }>(sql`SELECT gateway_ref FROM payment_methods`)).gateway_ref;
    await t.app.db.exec(sql`UPDATE payment_methods SET gateway_ref = ${SANDBOX_DECLINE_METHOD}`);
    t.clock.advance(31 * DAY);
    await runRenewals();
    await t.app.db.exec(sql`UPDATE payment_methods SET gateway_ref = ${original}`);
    t.clock.advance(DAY + 60_000);
    await runDunningJob();
    expect((await subscriptionOf()).status).toBe('active');
  });

  it('bills metered usage and overage in arrears', async () => {
    await call(t, admin, 'POST', `/api/admin/products/${cat.pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', pricingModel: 'usage', meterKey: 'api_calls', unitAmount: 1, includedUnits: 100 });
    const usagePrice = (await t.app.db.one<{ id: string }>(sql`SELECT id FROM prices WHERE pricing_model = 'usage'`)).id;
    await t.app.db.exec(sql`UPDATE products SET kind = 'addon' WHERE key = 'extra_calls'`);
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    // Pro's api_calls quota is overage-billed at 2 cents beyond 1000 per billing period.
    await t.request({ method: 'POST', url: '/api/v1/usage/record', bearer: key, body: { userId: user.id, meter: 'api_calls', quantity: 1250 } });
    t.clock.advance(31 * DAY);
    await runRenewals();
    const lines = await t.app.db.many<any>(sql`SELECT type, amount, quantity FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.billing_reason = 'subscription_cycle' ORDER BY l.position`);
    expect(lines.map((l) => l.type)).toEqual(['subscription', 'overage']);
    expect(lines[1]).toMatchObject({ quantity: 250, amount: 500 });
    expect(usagePrice).toBeTruthy();
  });
});

describe('plan changes', () => {
  it('prorates an immediate upgrade in seats', async () => {
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Acme' });
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: user.id, role: 'owner' });
    const chk = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: user.id, orgId: org.id, priceId: cat.teamSeat.id, quantity: 2 } });
    expect(chk.body.amount.total).toBe(2000);
    await pay(chk.body.id);
    const sub = await subscriptionOf(org.id);
    t.clock.set(new Date(sub.current_period_start.getTime() + (sub.current_period_end.getTime() - sub.current_period_start.getTime()) / 2));
    const res = await t.request({ method: 'POST', url: `/api/v1/subscriptions/${sub.id}/change`, bearer: key, body: { quantity: 5 } });
    expect(res.body.scheduled).toBe(false);
    // Half a period: +2500 for 5 seats, -1000 credit for the unused 2 seats.
    expect(res.body.invoice).toMatchObject({ total: 1500, status: 'paid' });
    expect((await t.request({ url: '/api/v1/entitlements', bearer: key, query: { userId: user.id, orgId: org.id } })).body.features.api_calls.limit).toBe(2500);
  });

  it('schedules downgrades for the period end', async () => {
    await pay((await checkout({ priceId: cat.proYearly.id })).id);
    const sub = await subscriptionOf();
    const res = await t.request({ method: 'POST', url: `/api/v1/subscriptions/${sub.id}/change`, bearer: key, body: { priceId: cat.proMonthly.id } });
    expect(res.body.scheduled).toBe(true);
    expect((await subscriptionOf()).price_id).toBe(cat.proYearly.id);
    t.clock.advance(366 * DAY);
    await runRenewals();
    const after = await subscriptionOf();
    expect(after.price_id).toBe(cat.proMonthly.id);
    expect((await t.app.db.one(sql`SELECT total FROM invoices ORDER BY created_at DESC LIMIT 1`)).total).toBe(2000);
  });

  it('cancels at period end, can be reactivated, and ends when the period does', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const sub = await subscriptionOf();
    await t.request({ method: 'POST', url: `/api/v1/subscriptions/${sub.id}/cancel`, bearer: key, body: { atPeriodEnd: true, reason: 'too expensive' } });
    await t.request({ method: 'POST', url: `/api/v1/subscriptions/${sub.id}/reactivate`, bearer: key, body: {} });
    expect((await subscriptionOf()).cancel_at_period_end).toBe(false);
    await t.request({ method: 'POST', url: `/api/v1/subscriptions/${sub.id}/cancel`, bearer: key, body: {} });
    t.clock.advance(31 * DAY);
    await runRenewals();
    expect((await subscriptionOf()).status).toBe('canceled');
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM invoices`)).n).toBe(1);
  });

  it('pauses and resumes with a fresh billing period', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const sub = await subscriptionOf();
    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/pause`, {});
    expect((await entitlements()).features.sso.enabled).toBe(false);
    t.clock.advance(10 * DAY);
    const resumed = await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/resume`, {});
    expect(resumed.subscription.status).toBe('active');
    expect(resumed.invoice.status).toBe('paid');
    expect((await entitlements()).features.sso.enabled).toBe(true);
  });
});

describe('refunds and separation of duties', () => {
  it('refunds small amounts immediately with a credit note', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const payment = await t.app.db.one<{ id: string }>(sql`SELECT id FROM payments`);
    const res = await call(t, admin, 'POST', `/api/admin/payments/${payment.id}/refunds`, { amount: 500, reason: 'Service outage credit' });
    expect(res.status).toBe('succeeded');
    const p = await t.app.db.one(sql`SELECT status, amount_refunded FROM payments WHERE id = ${payment.id}`);
    expect(p).toEqual({ status: 'partially_refunded', amount_refunded: 500 });
    expect((await t.app.db.one(sql`SELECT number FROM credit_notes`)).number).toBe('CN-2026-000001');
    expect((await t.app.db.one(sql`SELECT lifetime_revenue FROM users WHERE id = ${user.id}`)).lifetime_revenue).toBe(1500);
    const over = await t.request({ method: 'POST', url: `/api/admin/payments/${payment.id}/refunds`, as: admin, body: { amount: 1600, reason: 'too much' } });
    expect(over.status).toBe(422);
  });

  it('parks large refunds for a second approver and revokes access on a full refund', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/billing', { refundApprovalThreshold: 1000 });
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const payment = await t.app.db.one<{ id: string }>(sql`SELECT id FROM payments`);
    const req = await call(t, admin, 'POST', `/api/admin/payments/${payment.id}/refunds`, { reason: 'Customer requested refund', revokeAccess: true });
    expect(req.status).toBe('requires_approval');
    expect((await t.app.db.one(sql`SELECT amount_refunded FROM payments`)).amount_refunded).toBe(0);
    const self = await t.request({ method: 'POST', url: `/api/admin/approvals/${req.approvalId}/approve`, as: admin, body: {} });
    expect(self.body.error.code).toBe('separation_of_duties');
    const billing = await adminSession(t, ['billing_manager']);
    const approved = await call(t, billing, 'POST', `/api/admin/approvals/${req.approvalId}/approve`, {});
    expect(approved.status).toBe('executed');
    expect((await t.app.db.one(sql`SELECT status FROM payments`)).status).toBe('refunded');
    expect((await subscriptionOf()).status).toBe('canceled');
    expect((await entitlements()).plans.map((p: any) => p.key)).toEqual(['free']);
  });

  it('requires the refund permission', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const payment = await t.app.db.one<{ id: string }>(sql`SELECT id FROM payments`);
    const support = await adminSession(t, ['support']);
    const res = await t.request({ method: 'POST', url: `/api/admin/payments/${payment.id}/refunds`, as: support, body: { amount: 100, reason: 'please' } });
    expect(res.status).toBe(403);
  });
});

describe('invoices, one-time purchases and disputes', () => {
  it('creates manual invoices, records offline payment and renders a PDF', async () => {
    await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'manual', name: 'Bank transfer', mode: 'live', config: { instructions: 'Wire to IBAN XX00' } });
    const inv = await call(t, admin, 'POST', '/api/admin/invoices', { userId: user.id, currency: 'USD', lines: [{ description: 'Onboarding package', unitAmount: 50000 }, { description: 'Extra training — Ünïcødé ✓', quantity: 2, unitAmount: 10000 }] });
    expect(inv).toMatchObject({ status: 'open', total: 70000 });
    const pdf = await t.server.inject({ method: 'GET', url: `/api/admin/invoices/${inv.id}/pdf`, headers: { authorization: `Bearer ${admin.token}` } });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const paid = await call(t, admin, 'POST', `/api/admin/invoices/${inv.id}/mark-paid`, { method: 'bank_transfer', reference: 'WIRE-1' });
    expect(paid.status).toBe('paid');
    const payLink = await t.server.inject({ method: 'GET', url: `/pay/invoice/${inv.id}?token=wrong` });
    expect(payLink.statusCode).toBe(404);
  });

  it('invoices a user from their profile: drafts stay internal, issued invoices reach their account, payment settles them', async () => {
    const session = (await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId: user.id } })).body.token as string;
    const profile = async () => (await call(t, admin, 'GET', `/api/admin/users/${user.id}`)).panels.billing.invoices.map((i: any) => [i.id, i.status]);
    const account = async () => (await t.request({ url: '/api/client/invoices', bearer: session })).body.data.map((i: any) => i.id);

    const draft = await call(t, admin, 'POST', '/api/admin/invoices', { userId: user.id, currency: 'USD', lines: [{ description: 'Setup fee', unitAmount: 15000 }], draft: true });
    expect(draft.status).toBe('draft');
    expect(await profile()).toContainEqual([draft.id, 'draft']);
    expect(await account()).not.toContain(draft.id);

    const inv = await call(t, admin, 'POST', '/api/admin/invoices', { userId: user.id, currency: 'USD', lines: [{ description: 'Consulting', quantity: 2, unitAmount: 20000 }], dueDays: 7 });
    expect(inv).toMatchObject({ status: 'open', subject_type: 'user', subject_id: user.id, user_id: user.id, total: 40000 });
    expect(await account()).toContain(inv.id);

    const paid = await call(t, admin, 'POST', `/api/admin/invoices/${inv.id}/mark-paid`, { method: 'bank_transfer', reference: 'WIRE-7' });
    expect(paid.status).toBe('paid');
    expect(await profile()).toContainEqual([inv.id, 'paid']);
    expect(await t.app.db.one(sql`SELECT status, amount, user_id FROM payments WHERE invoice_id = ${inv.id}`)).toEqual({ status: 'succeeded', amount: 40000, user_id: user.id });
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM events WHERE type = 'invoice.paid' AND data->>'invoiceId' = ${inv.id}`)).n).toBe(1);

    const open = await call(t, admin, 'POST', '/api/admin/invoices', { userId: user.id, currency: 'USD', lines: [{ description: 'Workshop', unitAmount: 9900 }] });
    const link = await call(t, admin, 'POST', `/api/admin/invoices/${open.id}/checkout`, { gatewayId: gateway.id });
    expect(link.url).toContain(`/pay/sandbox/${gateway.id}/`);

    const support = await adminSession(t, ['support']);
    const denied = await t.request({ method: 'POST', url: '/api/admin/invoices', as: support, body: { userId: user.id, currency: 'USD', lines: [{ description: 'Not allowed', unitAmount: 100 }] } });
    expect(denied.status).toBe(403);
  });

  it('grants lifetime access for one-time products and credits for credit packs', async () => {
    const lifetime = await call(t, admin, 'POST', '/api/admin/products', { key: 'lifetime', name: 'Lifetime', kind: 'plan', planType: 'lifetime' });
    await call(t, admin, 'PUT', `/api/admin/products/${lifetime.id}/features`, { features: [{ featureKey: 'sso' }, { featureKey: 'api_calls', unlimited: true }] });
    const lifetimePrice = await call(t, admin, 'POST', `/api/admin/products/${lifetime.id}/prices`, { currency: 'USD', type: 'one_time', unitAmount: 29900 });
    await pay((await checkout({ priceId: lifetimePrice.id })).id);
    const ent = await entitlements();
    expect(ent.features.api_calls.unlimited).toBe(true);
    expect(ent.plans.find((p: any) => p.key === 'lifetime').origin).toBe('grant');

    const pack = await call(t, admin, 'POST', '/api/admin/products', { key: 'credits_100', name: '100 credits', kind: 'credit_pack', creditType: 'credits', creditAmount: 100 });
    const packPrice = await call(t, admin, 'POST', `/api/admin/products/${pack.id}/prices`, { currency: 'USD', type: 'one_time', unitAmount: 1000 });
    await pay((await checkout({ priceId: packPrice.id, quantity: 2 })).id);
    await t.app.worker.runUntilIdle();
    const credits = await t.request({ url: '/api/v1/credits', bearer: key, query: { userId: user.id } });
    expect(credits.body.data).toEqual([expect.objectContaining({ type: 'credits', balance: 200 })]);
  });

  it('records chargebacks from gateway webhooks', async () => {
    await pay((await checkout({ priceId: cat.proMonthly.id })).id);
    const payment = await t.app.db.one<{ gateway_payment_id: string }>(sql`SELECT gateway_payment_id FROM payments`);
    const send = async (event: any) => {
      const signed = signSandboxEvent(SECRET, event);
      return t.server.inject({ method: 'POST', url: `/api/public/gateways/${gateway.id}/webhook`, payload: signed.body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': signed.signature } });
    };
    await send({ type: 'dispute.created', eventId: 'dp1', gatewayPaymentId: payment.gateway_payment_id, gatewayDisputeId: 'dsp_1', amount: 2000, currency: 'USD', reason: 'fraudulent' });
    expect((await t.app.db.one(sql`SELECT status FROM payments`)).status).toBe('disputed');
    await send({ type: 'dispute.closed', eventId: 'dp2', gatewayDisputeId: 'dsp_1', outcome: 'lost' });
    expect((await t.app.db.one(sql`SELECT status FROM disputes`)).status).toBe('lost');
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'dispute.created'`)).n).toBeGreaterThan(0);
  });
});

describe('gateway plugins declare capabilities', () => {
  it('lists adapters and refuses sandbox in live mode', async () => {
    const list = await call(t, admin, 'GET', '/api/admin/gateways');
    const keys = list.available.map((a: any) => a.key).sort();
    expect(keys).toEqual(['manual', 'paypal', 'razorpay', 'sandbox', 'stripe']);
    expect(list.available.find((a: any) => a.key === 'razorpay').capabilities.offSessionCharge).toBe(false);
    expect(JSON.stringify(list.data)).not.toContain(SECRET);
    const live = await t.request({ method: 'POST', url: '/api/admin/gateways', as: admin, body: { adapter: 'sandbox', name: 'x', mode: 'live', secrets: { webhook_secret: 'x' } } });
    expect(live.status).toBe(422);
    const missing = await t.request({ method: 'POST', url: '/api/admin/gateways', as: admin, body: { adapter: 'stripe', name: 'Stripe', mode: 'test', secrets: {} } });
    expect(missing.status).toBe(422);
  });
});

describe('product invoices', () => {
  async function setupProduct(currency = 'USD', unitAmount = 5000) {
    const product = await call(t, admin, 'POST', '/api/admin/products', { key: `setup_${currency.toLowerCase()}`, name: 'Onboarding setup', kind: 'one_time' });
    const price = await call(t, admin, 'POST', `/api/admin/products/${product.id}/prices`, { currency, type: 'one_time', unitAmount });
    return { product, price };
  }
  const invoiceProducts = (body: Record<string, unknown>, as = admin) => t.request({ method: 'POST', url: '/api/admin/invoices/products', as, body: { userId: user.id, ...body } });

  it('grants nothing until paid, then starts the plan, grants the product and keeps the discounts on renewals', async () => {
    const setup = await setupProduct();
    const coupon = await call(t, admin, 'POST', '/api/admin/coupons', { code: 'SPRING20', name: 'Spring', discountType: 'percent', percentOff: 20, duration: 'repeating', durationCycles: 2 });
    const options = await call(t, admin, 'GET', '/api/admin/invoices/product-options');
    expect(options.products.find((p: any) => p.id === cat.pro.id).prices.map((p: any) => p.id).sort()).toEqual([cat.proMonthly.id, cat.proYearly.id].sort());
    expect(options.products.some((p: any) => p.id === cat.free.id)).toBe(false);
    expect(options.coupons.map((c: any) => c.code)).toContain('SPRING20');

    // Pro 20.00 + setup 50.00; 20% coupon on both (4.00 + 10.00) and 10.00 extra off the first invoice.
    const res = await invoiceProducts({ items: [{ priceId: cat.proMonthly.id }, { priceId: setup.price.id }], couponCode: 'spring20', discount: { first: 1000, renewal: 300 }, dueDays: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const inv = res.body;
    expect(inv).toMatchObject({ status: 'open', subtotal: 7000, discount_total: 2400, total: 4600, user_id: user.id, subscription_id: null });
    const order = await t.app.db.one<any>(sql`SELECT * FROM orders WHERE id = ${inv.order_id}`);
    expect(order).toMatchObject({ status: 'pending', coupon_id: coupon.id, total: 4600 });
    expect(await t.app.db.many(sql`SELECT id FROM subscriptions WHERE subject_id = ${user.id}`)).toEqual([]);
    expect((await entitlements()).plans.map((p: any) => p.key)).toEqual(['free']);
    expect((await t.app.db.one<any>(sql`SELECT redeemed_count FROM coupons WHERE id = ${coupon.id}`)).redeemed_count).toBe(0);

    await call(t, admin, 'POST', `/api/admin/invoices/${inv.id}/mark-paid`, { method: 'bank_transfer', reference: 'WIRE-9' });
    const sub = await subscriptionOf();
    expect(sub).toMatchObject({ status: 'active', price_id: cat.proMonthly.id, coupon_id: coupon.id, discount_cycles_remaining: 1, renewal_discount: 300 });
    expect(await t.app.db.one<any>(sql`SELECT status, subscription_id FROM orders WHERE id = ${inv.order_id}`)).toEqual({ status: 'paid', subscription_id: sub.id });
    expect((await t.app.db.one<any>(sql`SELECT subscription_id FROM invoices WHERE id = ${inv.id}`)).subscription_id).toBe(sub.id);
    expect(await t.app.db.many(sql`SELECT product_id, source FROM entitlement_grants WHERE subject_id = ${user.id} AND source_ref = ${inv.order_id}`)).toEqual([{ product_id: setup.product.id, source: 'purchase' }]);
    expect((await t.app.db.one<any>(sql`SELECT redeemed_count FROM coupons WHERE id = ${coupon.id}`)).redeemed_count).toBe(1);
    expect((await t.app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM events WHERE type = 'order.paid' AND data->>'orderId' = ${inv.order_id}`)).n).toBe(1);
    expect((await entitlements()).plans.map((p: any) => p.key).sort()).toEqual(['pro', 'setup_usd']);
    const again = await invoiceProducts({ items: [{ priceId: cat.proYearly.id }] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_subscribed');

    // Renewal: 20.00 less the coupon's last cycle (4.00) and the agreed 3.00.
    t.clock.advance(31 * DAY);
    await runRenewals();
    const renewal = await t.app.db.one<any>(sql`SELECT * FROM invoices WHERE subscription_id = ${sub.id} AND billing_reason = 'subscription_cycle'`);
    expect(renewal).toMatchObject({ subtotal: 2000, discount_total: 700, total: 1300 });
  });

  it('settles through a payment link, grants fully discounted invoices at once, and refuses what cannot be invoiced', async () => {
    const res = await invoiceProducts({ items: [{ priceId: cat.extraPrice.id }], sendEmail: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const link = await call(t, admin, 'POST', `/api/admin/invoices/${res.body.id}/checkout`, { gatewayId: gateway.id });
    await pay(link.id);
    expect((await t.app.db.one<any>(sql`SELECT status FROM invoices WHERE id = ${res.body.id}`)).status).toBe('paid');
    expect(await subscriptionOf()).toMatchObject({ status: 'active', price_id: cat.extraPrice.id, renewal_discount: 0 });

    const setup = await setupProduct();
    await call(t, admin, 'POST', '/api/admin/coupons', { code: 'ONUS', name: 'On us', discountType: 'percent', percentOff: 100 });
    const free = await invoiceProducts({ items: [{ priceId: setup.price.id }], couponCode: 'ONUS' });
    expect(free.body).toMatchObject({ status: 'paid', total: 0 });
    expect(await t.app.db.many(sql`SELECT product_id FROM entitlement_grants WHERE source_ref = ${free.body.order_id}`)).toEqual([{ product_id: setup.product.id }]);

    const voided = await invoiceProducts({ items: [{ priceId: setup.price.id }] });
    await call(t, admin, 'POST', `/api/admin/invoices/${voided.body.id}/void`);
    expect((await t.app.db.one<any>(sql`SELECT status FROM orders WHERE id = ${voided.body.order_id}`)).status).toBe('canceled');
    expect(await t.app.db.many(sql`SELECT id FROM entitlement_grants WHERE source_ref = ${voided.body.order_id}`)).toEqual([]);

    const euro = await setupProduct('EUR', 900);
    expect((await invoiceProducts({ items: [{ priceId: setup.price.id }, { priceId: euro.price.id }] })).status).toBe(422);
    expect((await invoiceProducts({ items: [{ priceId: cat.proMonthly.id }, { priceId: cat.proYearly.id }] })).status).toBe(422);
    expect((await invoiceProducts({ items: [{ priceId: setup.price.id }], discount: { renewal: 100 } })).status).toBe(422);
    expect((await invoiceProducts({ items: [{ priceId: setup.price.id }], discount: { first: 5001 } })).status).toBe(422);
    expect((await invoiceProducts({ items: [{ priceId: cat.teamSeat.id }] })).status).toBe(422);
    expect((await invoiceProducts({ items: [{ priceId: setup.price.id }], couponCode: 'NOPE' })).status).toBe(422);

    const support = await adminSession(t, ['support']);
    expect((await invoiceProducts({ items: [{ priceId: setup.price.id }] }, support)).status).toBe(403);
    expect((await t.request({ url: '/api/admin/invoices/product-options', as: support })).status).toBe(403);
  });
});
