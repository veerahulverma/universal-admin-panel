import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { allModules } from '../index.js';
import { affiliatesModule } from './module.js';
import { supportModule } from '../support/module.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';
import { payToken } from '../billing/checkout.js';
import { signSandboxEvent } from '../billing/gateways/sandbox.js';
import { approveDueCommissions, commissionForInvoice } from './service.js';

const modules = [...allModules.filter((m) => m.id !== affiliatesModule.id && m.id !== supportModule.id), affiliatesModule, supportModule];
const SECRET = 'sandbox-secret';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;
let gateway: { id: string };

beforeEach(async () => {
  t = await createTestPlatform({ modules });
  // Stay well before real time so scheduled tasks never fire on their own during time travel.
  t.clock.set('2026-01-05T09:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  gateway = await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: SECRET } });
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0`);
});
afterEach(async () => {
  await t.close();
});

async function affiliate(body: Record<string, unknown> = {}) {
  return call(t, admin, 'POST', '/api/admin/affiliates', { email: 'partner@partner.io', name: 'Partner', code: 'partner', ...body });
}

async function click(code: string, opts: { visitor?: string; to?: string; ip?: string; sub?: string } = {}) {
  const query = new URLSearchParams();
  if (opts.to !== undefined) query.set('to', opts.to);
  if (opts.sub !== undefined) query.set('sub', opts.sub);
  const res = await t.server.inject({
    method: 'GET',
    url: `/r/${code}${query.size ? `?${query}` : ''}`,
    cookies: opts.visitor ? { stw_aff_vid: opts.visitor } : {},
    remoteAddress: opts.ip ?? '198.51.100.20',
  });
  expect(res.statusCode).toBe(302);
  const setCookie = [res.headers['set-cookie']].flat().filter(Boolean).join(';');
  const location = new URL(String(res.headers.location));
  return { location, visitor: /stw_aff_vid=([^;]+)/.exec(setCookie)?.[1], clickId: location.searchParams.get('click'), ref: location.searchParams.get('ref'), setCookie };
}

async function refer(userId: string, body: Record<string, unknown>) {
  return (await t.request({ method: 'POST', url: '/api/v1/referrals', bearer: key, body: { userId, ...body } })).body;
}

async function buy(userId: string, priceId: string, couponCode?: string) {
  const chk = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId, priceId, couponCode } });
  expect(chk.status, JSON.stringify(chk.body)).toBe(200);
  await t.server.inject({ method: 'POST', url: `/pay/sandbox/${gateway.id}/${chk.body.id}`, payload: { token: payToken(t.app, chk.body.id), outcome: 'success' } });
  await t.app.worker.runUntilIdle();
  return chk.body;
}

async function commissions(): Promise<any[]> {
  return t.app.db.many(sql`SELECT * FROM affiliate_commissions ORDER BY created_at, id`);
}

async function customerSession(userId: string): Promise<string> {
  return (await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId } })).body.token;
}

async function payment(userId: string): Promise<{ id: string; gateway_payment_id: string }> {
  return t.app.db.one(sql`SELECT id, gateway_payment_id FROM payments WHERE user_id = ${userId}`);
}

/** Time travel invalidates admin sessions (idle timeout); sign a fresh admin in. */
async function travel(ms: number) {
  t.clock.advance(ms);
  admin = await adminSession(t);
}

describe('applications', () => {
  it('lets customers apply, requires terms, and admins approve', async () => {
    const user = await apiUser(t, key, 'creator@studio.dev');
    const session = (await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId: user.id } })).body.token;
    const noTerms = await t.request({ method: 'POST', url: '/api/client/affiliate/apply', bearer: session, body: { website: 'https://studio.dev' } });
    expect(noTerms.status).toBe(422);
    const applied = await t.request({ method: 'POST', url: '/api/client/affiliate/apply', bearer: session, body: { website: 'https://studio.dev', acceptTerms: true } });
    expect(applied.body.affiliate.status).toBe('pending');
    expect((await t.request({ method: 'POST', url: '/api/client/affiliate/apply', bearer: session, body: { acceptTerms: true } })).status).toBe(409);
    expect((await click(applied.body.affiliate.code)).clickId).toBeNull(); // pending affiliates do not track
    await call(t, admin, 'POST', `/api/admin/affiliates/${applied.body.affiliate.id}/status`, { action: 'approve' });
    const welcome = await t.app.db.one<{ status: string; subject: string }>(sql`SELECT status, subject FROM email_messages WHERE template_key = 'affiliates.approved'`);
    expect(welcome.status).not.toBe('failed'); // the template is registered, so the email is not dropped as template_not_found
    expect(welcome.subject).toContain('affiliate program');
    const portal = await t.request({ url: '/api/client/affiliate', bearer: session });
    expect(portal.body.affiliate).toMatchObject({ status: 'approved', link: `http://localhost:4000/r/${applied.body.affiliate.code}` });
    expect(portal.body.stats).toMatchObject({ clicks: 0, signups: 0 });
    const row = await t.app.db.one(sql`SELECT terms_accepted_at, application_ip_hash FROM affiliates WHERE id = ${applied.body.affiliate.id}`);
    expect(row.terms_accepted_at).not.toBeNull();
    expect(row.application_ip_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps payout and tax details encrypted and masked', async () => {
    const aff = await affiliate();
    await call(t, admin, 'PUT', `/api/admin/affiliates/${aff.id}/payout-details`, { payoutDetails: 'IBAN DE89370400440532013000', taxInfo: 'VAT DE123456789' });
    const details = await call(t, admin, 'GET', `/api/admin/affiliates/${aff.id}`);
    expect(details.sensitive.find((s: any) => s.name === 'payout_details').last4).toBe('3000');
    expect(JSON.stringify(details)).not.toContain('DE89370400440532013000');
    const stored = await t.app.db.many<{ ciphertext: string }>(sql`SELECT ciphertext FROM secrets WHERE owner_type = 'affiliate'`);
    expect(stored).toHaveLength(2);
    expect(stored.every((s) => s.ciphertext.startsWith('enc:v1:') && !s.ciphertext.includes('IBAN'))).toBe(true);
  });

  it('rejects duplicate codes', async () => {
    await affiliate();
    const dup = await t.request({ method: 'POST', url: '/api/admin/affiliates', as: admin, body: { email: 'other@x.io', name: 'Other', code: 'PARTNER' } });
    expect(dup.body.error.code).toBe('code_taken');
  });
});

describe('click tracking and attribution', () => {
  it('attributes to the last click by default and to the first click when configured', async () => {
    await affiliate();
    await affiliate({ email: 'b@other.io', name: 'B', code: 'bravo' });
    const first = await click('partner');
    expect(first.visitor).toMatch(/^v_/);
    expect(first.setCookie).toMatch(/HttpOnly/i);
    t.clock.advance(DAY);
    const second = await click('bravo', { visitor: first.visitor });
    expect(second.ref).toBe('bravo');
    const user = await apiUser(t, key, 'u1@gmail.com');
    const res = await refer(user.id, { clickId: first.clickId });
    expect(res).toMatchObject({ attributed: true, referral: { attribution: 'last_click' } });
    const aff = await t.app.db.one<{ code: string }>(sql`SELECT a.code FROM referrals r JOIN affiliates a ON a.id = r.affiliate_id WHERE r.user_id = ${user.id}`);
    expect(aff.code).toBe('bravo');

    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { attribution: 'first_click' });
    const v2a = await click('partner');
    t.clock.advance(DAY);
    const v2b = await click('bravo', { visitor: v2a.visitor });
    expect(v2b.ref).toBe('partner');
    const user2 = await apiUser(t, key, 'u2@gmail.com');
    expect((await refer(user2.id, { clickId: v2b.clickId })).referral.attribution).toBe('first_click');
    const aff2 = await t.app.db.one<{ code: string }>(sql`SELECT a.code FROM referrals r JOIN affiliates a ON a.id = r.affiliate_id WHERE r.user_id = ${user2.id}`);
    expect(aff2.code).toBe('partner');
  });

  it('honours the attribution window', async () => {
    await affiliate();
    await affiliate({ email: 'b@other.io', name: 'B', code: 'bravo' });
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { attribution: 'first_click', cookieDays: 30 });
    const old = await click('partner');
    t.clock.advance(31 * DAY);
    const fresh = await click('bravo', { visitor: old.visitor });
    expect(fresh.ref).toBe('bravo'); // the expired first click no longer wins
    const lonely = await click('partner', { visitor: 'v_' + 'x'.repeat(24) });
    t.clock.advance(31 * DAY);
    const user = await apiUser(t, key, 'late@gmail.com');
    expect(await refer(user.id, { clickId: lonely.clickId })).toMatchObject({ attributed: false, reason: 'attribution_window_expired' });
  });

  it('never redirects off-site', async () => {
    await affiliate();
    expect((await click('partner', { to: 'https://evil.com/phish' })).location.origin).toBe('http://localhost:4000');
    expect((await click('partner', { to: '//evil.com/phish' })).location.origin).toBe('http://localhost:4000');
    expect((await click('partner', { to: '/\\evil.com' })).location.origin).toBe('http://localhost:4000');
    const pricing = await click('partner', { to: '/pricing?plan=pro' });
    expect(pricing.location.pathname).toBe('/pricing');
    expect(pricing.location.searchParams.get('plan')).toBe('pro');
    expect(pricing.location.searchParams.get('ref')).toBe('partner');
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { allowedRedirectHosts: ['www.myapp.com'] });
    expect((await click('partner', { to: 'https://www.myapp.com/signup' })).location.host).toBe('www.myapp.com');
    const unknown = await t.server.inject({ method: 'GET', url: '/r/nope?to=https://evil.com' });
    expect(new URL(String(unknown.headers.location)).origin).toBe('http://localhost:4000');
    expect(unknown.headers['set-cookie']).toBeUndefined();
    const clicks = await t.app.db.many<{ ip_hash: string }>(sql`SELECT ip_hash FROM affiliate_clicks`);
    expect(clicks.every((c) => c.ip_hash && !c.ip_hash.includes('198.51'))).toBe(true);
  });

  it('refers a customer only once, including from the signup payload', async () => {
    await affiliate();
    await affiliate({ email: 'b@other.io', name: 'B', code: 'bravo' });
    const signup = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email: 'new@gmail.com', referralCode: 'PARTNER' } });
    await t.app.worker.runUntilIdle();
    const ref = await t.request({ url: `/api/v1/referrals/${signup.body.user.id}`, bearer: key });
    expect(ref.body).toMatchObject({ code: 'partner', attribution: 'code' });
    expect(await refer(signup.body.user.id, { code: 'bravo' })).toMatchObject({ attributed: false, reason: 'already_referred' });
    expect(await refer(signup.body.user.id, { code: 'missing' })).toMatchObject({ attributed: false });
  });
});

describe('commissions', () => {
  it('earns a held commission on payment, idempotently, then approves it after the hold', async () => {
    await affiliate();
    const user = await apiUser(t, key, 'buyer@gmail.com');
    await refer(user.id, { code: 'partner' });
    await buy(user.id, cat.proMonthly.id);
    const [c1] = await commissions();
    expect(c1).toMatchObject({ kind: 'sale', amount: 400, base_amount: 2000, rate_bps: 2000, currency: 'USD', status: 'pending', flagged: false });
    expect((await t.app.db.one(sql`SELECT status FROM referrals WHERE user_id = ${user.id}`)).status).toBe('converted');
    expect(await commissionForInvoice(t.app, c1.invoice_id)).toMatchObject({ created: false, reason: 'exists' });
    expect(await commissions()).toHaveLength(1);

    expect(await approveDueCommissions(t.app)).toBe(0);
    t.clock.advance(31 * DAY);
    expect(await approveDueCommissions(t.app)).toBe(1);
    expect((await commissions())[0].status).toBe('approved');
  });

  it('pays recurring commissions on renewals unless the affiliate is one-time', async () => {
    const aff = await affiliate();
    const user = await apiUser(t, key, 'loyal@gmail.com');
    await refer(user.id, { code: 'partner' });
    await buy(user.id, cat.proMonthly.id);
    await travel(32 * DAY);
    await t.app.jobs.enqueue(t.app.db, 'billing.renewals', {});
    await t.app.worker.runUntilIdle();
    expect((await commissions()).map((c) => c.amount)).toEqual([400, 400]);

    await call(t, admin, 'PATCH', `/api/admin/affiliates/${aff.id}`, { recurring: false });
    await travel(31 * DAY);
    await t.app.jobs.enqueue(t.app.db, 'billing.renewals', {});
    await t.app.worker.runUntilIdle();
    expect(await commissions()).toHaveLength(2);
  });

  it('uses tier rates once an affiliate qualifies', async () => {
    await affiliate();
    await call(t, admin, 'POST', '/api/admin/affiliate-tiers', { name: 'Gold', metric: 'conversions', threshold: 1, ratePercent: 30 });
    const a = await apiUser(t, key, 'first@gmail.com');
    const b = await apiUser(t, key, 'second@gmail.com');
    await refer(a.id, { code: 'partner' });
    await refer(b.id, { code: 'partner' });
    await buy(a.id, cat.proMonthly.id);
    await buy(b.id, cat.proMonthly.id);
    expect((await commissions()).map((c) => c.amount)).toEqual([400, 600]);
    expect((await t.app.db.one(sql`SELECT tier_id FROM affiliates WHERE code = 'partner'`)).tier_id).not.toBeNull();
  });

  it('attributes coupon purchases to the coupon owner', async () => {
    const aff = await affiliate();
    await call(t, admin, 'POST', '/api/admin/coupons', { code: 'PARTNER10', name: 'Partner 10%', discountType: 'percent', percentOff: 10, affiliateId: aff.id });
    const user = await apiUser(t, key, 'coupon@gmail.com');
    await buy(user.id, cat.proMonthly.id, 'PARTNER10');
    const referral = await t.app.db.one(sql`SELECT attribution, status FROM referrals WHERE user_id = ${user.id}`);
    expect(referral).toEqual({ attribution: 'coupon', status: 'converted' });
    const [c] = await commissions();
    expect(c).toMatchObject({ base_amount: 1800, amount: 360 });
  });

  it('reverses proportionally on refunds and claws back paid commissions', async () => {
    await affiliate();
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { minPayout: 100, holdDays: 0 });
    const user = await apiUser(t, key, 'refund@gmail.com');
    await refer(user.id, { code: 'partner' });
    await buy(user.id, cat.proMonthly.id);
    const payment = await t.app.db.one<{ id: string }>(sql`SELECT id FROM payments`);
    await call(t, admin, 'POST', `/api/admin/payments/${payment.id}/refunds`, { amount: 1000, reason: 'Half refund' });
    await t.app.worker.runUntilIdle();
    let [c] = await commissions();
    expect(c).toMatchObject({ amount: 400, reversed_amount: 200, status: 'pending' });

    // Pay out the remaining 200, then refund the rest: the paid part becomes a clawback.
    await approveDueCommissions(t.app);
    const affId = c.affiliate_id;
    const payout = await call(t, admin, 'POST', `/api/admin/affiliates/${affId}/payouts`, { currency: 'USD' });
    expect(payout).toMatchObject({ status: 'created', payout: { amount: 200 } });
    await call(t, admin, 'POST', `/api/admin/affiliate-payouts/${payout.payout.id}/mark-paid`, { reference: 'PAYPAL-1' });
    await call(t, admin, 'POST', `/api/admin/payments/${payment.id}/refunds`, { amount: 1000, reason: 'Rest' });
    await t.app.worker.runUntilIdle();
    const rows = await commissions();
    c = rows.find((r) => r.kind === 'sale');
    const clawback = rows.find((r) => r.kind === 'clawback');
    expect(c).toMatchObject({ status: 'paid', reversed_amount: 400 });
    expect(clawback).toMatchObject({ amount: -200, status: 'approved' });
    const balance = await call(t, admin, 'GET', `/api/admin/affiliates/${affId}`);
    expect(balance.payable).toEqual([{ currency: 'USD', payable: -200 }]);
  });

  it('reverses the full commission when a chargeback is lost', async () => {
    await affiliate();
    const user = await apiUser(t, key, 'chargeback@gmail.com');
    await refer(user.id, { code: 'partner' });
    await buy(user.id, cat.proMonthly.id);
    const payment = await t.app.db.one<{ gateway_payment_id: string }>(sql`SELECT gateway_payment_id FROM payments`);
    for (const event of [
      { type: 'dispute.created', eventId: 'd1', gatewayPaymentId: payment.gateway_payment_id, gatewayDisputeId: 'dsp', amount: 2000, currency: 'USD', reason: 'fraud' },
      { type: 'dispute.closed', eventId: 'd2', gatewayDisputeId: 'dsp', outcome: 'lost' },
    ]) {
      const signed = signSandboxEvent(SECRET, event as any);
      await t.server.inject({ method: 'POST', url: `/api/public/gateways/${gateway.id}/webhook`, payload: signed.body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': signed.signature } });
    }
    await t.app.worker.runUntilIdle();
    expect((await commissions())[0]).toMatchObject({ status: 'reversed', reversed_amount: 400 });
  });
});

describe('payouts', () => {
  async function approvedCommission(email = 'pay@gmail.com') {
    const user = await apiUser(t, key, email);
    await refer(user.id, { code: 'partner' });
    await buy(user.id, cat.proYearly.id);
    await travel(31 * DAY);
    await approveDueCommissions(t.app);
  }

  it('enforces the minimum payout and records paid payouts', async () => {
    const aff = await affiliate();
    await approvedCommission();
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { minPayout: 10_000 });
    const low = await t.request({ method: 'POST', url: `/api/admin/affiliates/${aff.id}/payouts`, as: admin, body: { currency: 'USD' } });
    expect(low.body.error.code).toBe('below_minimum_payout');
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { minPayout: 1000 });
    const res = await call(t, admin, 'POST', `/api/admin/affiliates/${aff.id}/payouts`, { currency: 'USD' });
    expect(res).toMatchObject({ status: 'created', payout: { amount: 4000, status: 'pending' } });
    const paid = await call(t, admin, 'POST', `/api/admin/affiliate-payouts/${res.payout.id}/mark-paid`, { reference: 'WIRE-77', method: 'bank_transfer' });
    expect(paid.status).toBe('paid');
    expect((await commissions())[0]).toMatchObject({ status: 'paid', payout_id: res.payout.id });
    const receipt = await t.app.db.one<{ status: string; subject: string }>(sql`SELECT status, subject FROM email_messages WHERE template_key = 'affiliates.payout_paid'`);
    expect(receipt.status).not.toBe('failed');
    expect(receipt.subject).toContain('$40.00'); // formatted money, not raw minor units
    const again = await t.request({ method: 'POST', url: `/api/admin/affiliate-payouts/${res.payout.id}/mark-paid`, as: admin, body: {} });
    expect(again.status).toBe(409);
  });

  it('requires a second approver for large payouts', async () => {
    const aff = await affiliate();
    await approvedCommission();
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { minPayout: 100, payoutApprovalThreshold: 1000 });
    const req = await call(t, admin, 'POST', `/api/admin/affiliates/${aff.id}/payouts`, { currency: 'USD' });
    expect(req.status).toBe('requires_approval');
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM affiliate_payouts`)).n).toBe(0);
    const self = await t.request({ method: 'POST', url: `/api/admin/approvals/${req.approvalId}/approve`, as: admin, body: {} });
    expect(self.body.error.code).toBe('separation_of_duties');
    const support = await adminSession(t, ['support']);
    expect((await t.request({ method: 'POST', url: `/api/admin/approvals/${req.approvalId}/approve`, as: support, body: {} })).status).toBe(403);
    const manager = await adminSession(t, ['affiliate_manager']);
    const approved = await call(t, manager, 'POST', `/api/admin/approvals/${req.approvalId}/approve`, {});
    expect(approved).toMatchObject({ status: 'executed', result: { amount: 4000, currency: 'USD' } });
    expect((await t.app.db.one(sql`SELECT status FROM affiliate_payouts`)).status).toBe('pending');
  });

  it('supports manual adjustments with an audit trail', async () => {
    const aff = await affiliate();
    await call(t, admin, 'POST', `/api/admin/affiliates/${aff.id}/adjustments`, { amount: 2500, currency: 'USD', reason: 'Launch bonus' });
    const details = await call(t, admin, 'GET', `/api/admin/affiliates/${aff.id}`);
    expect(details.payable).toEqual([{ currency: 'USD', payable: 2500 }]);
    const audit = await t.app.db.one(sql`SELECT action FROM audit_logs WHERE action = 'affiliate.commission_adjust'`);
    expect(audit.action).toBe('affiliate.commission_adjust');
  });
});

describe('fraud signals', () => {
  it('flags same-domain and self referrals without blocking, and holds their commissions for review', async () => {
    await affiliate({ email: 'owner@acme-widgets.io' });
    const colleague = await apiUser(t, key, 'buyer@acme-widgets.io');
    const res = await refer(colleague.id, { code: 'partner' });
    expect(res.attributed).toBe(true);
    const ref = await t.app.db.one<any>(sql`SELECT id, fraud_flags FROM referrals WHERE user_id = ${colleague.id}`);
    expect(ref.fraud_flags.map((f: any) => f.type)).toEqual(['same_email_domain']);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'affiliate.fraud_flag'`)).n).toBeGreaterThan(0);
    await buy(colleague.id, cat.proMonthly.id);
    expect((await commissions())[0].flagged).toBe(true);
    t.clock.advance(31 * DAY);
    expect(await approveDueCommissions(t.app)).toBe(0);
    admin = await adminSession(t);
    await call(t, admin, 'POST', `/api/admin/referrals/${ref.id}/clear-flags`, { note: 'Reseller, legitimate' });
    expect(await approveDueCommissions(t.app)).toBe(1);

    const selfUser = await apiUser(t, key, 'selfie@gmail.com');
    await call(t, admin, 'POST', '/api/admin/affiliates', { email: 'selfie-aff@gmail.com', name: 'Selfie', code: 'selfie', userId: selfUser.id });
    await refer(selfUser.id, { code: 'selfie' });
    const self = await t.app.db.one<any>(sql`SELECT fraud_flags FROM referrals WHERE user_id = ${selfUser.id}`);
    expect(self.fraud_flags.map((f: any) => f.type)).toContain('self_referral');
    const flagged = await call(t, admin, 'GET', '/api/admin/referrals?flagged=true');
    expect(flagged.data.map((r: any) => r.user_email)).toEqual(['selfie@gmail.com']);
  });

  it('flags bursts of signups from one network', async () => {
    await affiliate();
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { signupVelocityThreshold: 3 });
    const emails = ['a@gmail.com', 'b@gmail.com', 'c@gmail.com'];
    for (const e of emails) {
      const u = await apiUser(t, key, e);
      await refer(u.id, { code: 'partner', ip: '203.0.113.99' });
    }
    const rows = await t.app.db.many<any>(sql`SELECT fraud_flags FROM referrals ORDER BY created_at`);
    expect(rows.map((r) => r.fraud_flags.length)).toEqual([0, 0, 1]);
    expect(rows[2].fraud_flags[0].type).toBe('signup_velocity');
  });
});

describe('reports and access', () => {
  it('reports clicks, signups, conversions and earnings, and protects admin routes', async () => {
    await affiliate();
    const c = await click('partner');
    const user = await apiUser(t, key, 'report@gmail.com');
    await refer(user.id, { clickId: c.clickId });
    await buy(user.id, cat.proMonthly.id);
    const report = await call(t, admin, 'GET', '/api/admin/affiliate-report');
    expect(report.totals).toEqual({ clicks: 1, signups: 1, conversions: 1 });
    expect(report.affiliates[0].money).toEqual([{ currency: 'USD', revenue: 2000, commissions: 400 }]);
    const list = await call(t, admin, 'GET', '/api/admin/affiliates');
    expect(list.data[0]).toMatchObject({ clicks: 1, referrals: 1, conversions: 1, earnings: { USD: 400 } });
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/affiliates', as: support })).status).toBe(403);
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/affiliates', as: analyst })).status).toBe(200);
    const panel = await call(t, admin, 'GET', `/api/admin/users/${user.id}`);
    expect(panel.panels.affiliates.referredBy.affiliate_code).toBe('partner');
  });
});

describe('multi-level commissions', () => {
  /** top <- mid <- leaf: mid was recruited by top, leaf by mid. */
  async function chain() {
    const top = await affiliate({ email: 'top@partner.io', name: 'Top', code: 'top' });
    const mid = await affiliate({ email: 'mid@partner.io', name: 'Mid', code: 'mid', parentId: top.id });
    const leaf = await affiliate({ email: 'leaf@partner.io', name: 'Leaf', code: 'leaf', parentId: mid.id });
    return { top, mid, leaf };
  }

  it('pays every upline level on the same invoice, with the same hold, idempotently', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { uplineRatesBps: [500, 200] });
    const { top, mid, leaf } = await chain();
    const user = await apiUser(t, key, 'network@gmail.com');
    await refer(user.id, { code: 'leaf' });
    await buy(user.id, cat.proMonthly.id);

    const rows = await commissions();
    expect(rows.map((c) => [c.affiliate_id, c.kind, c.level, c.amount, c.rate_bps])).toEqual([
      [leaf.id, 'sale', 1, 400, 2000],
      [mid.id, 'upline', 2, 100, 500],
      [top.id, 'upline', 3, 40, 200],
    ]);
    const [sale, ...upline] = rows;
    for (const c of upline) {
      expect(c).toMatchObject({ status: 'pending', flagged: false, base_amount: 2000, source_commission_id: sale.id, referral_id: sale.referral_id, invoice_id: sale.invoice_id });
      expect(c.hold_until).toEqual(sale.hold_until);
    }
    expect(await commissionForInvoice(t.app, sale.invoice_id)).toMatchObject({ created: false, reason: 'exists' });
    expect(await commissions()).toHaveLength(3);
    const events = await t.app.db.many<{ data: any }>(sql`SELECT data FROM events WHERE type = 'commission.created' ORDER BY created_at, id`);
    expect(events.map((e) => [e.data.affiliateId, e.data.level])).toEqual([[leaf.id, 1], [mid.id, 2], [top.id, 3]]);

    const leafDetail = await call(t, admin, 'GET', `/api/admin/affiliates/${leaf.id}`);
    expect(leafDetail.upline).toEqual([
      { level: 2, id: mid.id, name: 'Mid', code: 'mid', status: 'approved', ratePercent: 5 },
      { level: 3, id: top.id, name: 'Top', code: 'top', status: 'approved', ratePercent: 2 },
    ]);
    const topDetail = await call(t, admin, 'GET', `/api/admin/affiliates/${top.id}`);
    expect(topDetail.network).toEqual({ recruits: 1, earnings: [{ level: 3, currency: 'USD', amount: 40 }] });
    const listed = await call(t, admin, 'GET', `/api/admin/affiliate-commissions?affiliateId=${top.id}`);
    expect(listed.data[0]).toMatchObject({ kind: 'upline', level: 3, source_affiliate_id: leaf.id, source_affiliate_name: 'Leaf' });
    expect((await call(t, admin, 'GET', `/api/admin/affiliates?parentId=${top.id}`)).data.map((a: any) => a.id)).toEqual([mid.id]);

    t.clock.advance(31 * DAY);
    expect(await approveDueCommissions(t.app)).toBe(3);
  });

  it('records who recruited an affiliate from their link or referral, and refuses loops', async () => {
    const recruiter = await affiliate({ email: 'recruiter@partner.io', name: 'Recruiter', code: 'recruiter' });
    // A customer referred by the recruiter later joins the program.
    const signup = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email: 'recruit@studio.dev', referralCode: 'recruiter' } });
    await t.app.worker.runUntilIdle();
    const applied = await t.request({ method: 'POST', url: '/api/client/affiliate/apply', bearer: await customerSession(signup.body.user.id), body: { acceptTerms: true } });
    expect(applied.status).toBe(200);
    const recruit = await call(t, admin, 'GET', `/api/admin/affiliates/${applied.body.affiliate.id}`);
    expect(recruit).toMatchObject({ parentId: recruiter.id, parentSource: 'referral', upline: [{ level: 2, id: recruiter.id, ratePercent: null }] });

    // An applicant who only followed the recruiting link passes its click id.
    const recruiting = await click('recruiter', { to: '/partners' });
    const other = await apiUser(t, key, 'other@studio.dev');
    const second = await t.request({ method: 'POST', url: '/api/client/affiliate/apply', bearer: await customerSession(other.id), body: { acceptTerms: true, referredBy: recruiting.clickId } });
    expect((await call(t, admin, 'GET', `/api/admin/affiliates/${second.body.affiliate.id}`)).parentId).toBe(recruiter.id);
    const changes = await t.app.db.many<{ data: any }>(sql`SELECT data FROM events WHERE type = 'affiliate.upline_changed' ORDER BY created_at, id`);
    expect(changes.map((e) => [e.data.parentId, e.data.source])).toEqual([[recruiter.id, 'referral'], [recruiter.id, 'referral']]);

    // second <- recruit <- recruiter is fine; recruiter <- second would close a loop.
    await call(t, admin, 'PATCH', `/api/admin/affiliates/${second.body.affiliate.id}`, { parentId: applied.body.affiliate.id });
    const loop = await t.request({ method: 'PATCH', url: `/api/admin/affiliates/${recruiter.id}`, as: admin, body: { parentId: second.body.affiliate.id } });
    expect(loop.status).toBe(409);
    expect(loop.body.error.code).toBe('affiliate_loop');
    expect((await t.request({ method: 'PATCH', url: `/api/admin/affiliates/${recruiter.id}`, as: admin, body: { parentId: recruiter.id } })).body.error.code).toBe('affiliate_loop');
    expect((await t.request({ method: 'PATCH', url: `/api/admin/affiliates/${recruiter.id}`, as: admin, body: { parentId: 'aff_missing' } })).status).toBe(422);
    expect((await t.app.db.one(sql`SELECT parent_id FROM affiliates WHERE id = ${recruiter.id}`)).parent_id).toBeNull();

    const removed = await call(t, admin, 'PATCH', `/api/admin/affiliates/${second.body.affiliate.id}`, { parentId: null });
    expect(removed).toMatchObject({ parentId: null, parentSource: null });
    const audit = await t.app.db.many<{ metadata: any }>(sql`SELECT metadata FROM audit_logs WHERE action = 'affiliate.upline_change' ORDER BY created_at`);
    expect(audit.map((a) => a.metadata.source)).toEqual(['referral', 'referral', 'admin', 'admin']);
  });

  it('reverses every level on refunds, clawing back upline commissions already paid', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { uplineRatesBps: [1000], minPayout: 100, holdDays: 0 });
    const top = await affiliate({ email: 'top@partner.io', name: 'Top', code: 'top' });
    await affiliate({ parentId: top.id });
    const user = await apiUser(t, key, 'refunded@gmail.com');
    await refer(user.id, { code: 'partner' });
    await buy(user.id, cat.proMonthly.id);
    const paid = await payment(user.id);
    await call(t, admin, 'POST', `/api/admin/payments/${paid.id}/refunds`, { amount: 1000, reason: 'Half refund' });
    await t.app.worker.runUntilIdle();
    let [sale, upline] = await commissions();
    expect(sale).toMatchObject({ kind: 'sale', amount: 400, reversed_amount: 200, status: 'pending' });
    expect(upline).toMatchObject({ kind: 'upline', level: 2, amount: 200, reversed_amount: 100, status: 'pending' });

    // The upline is paid its remaining 100, then the rest is refunded.
    await approveDueCommissions(t.app);
    const payout = await call(t, admin, 'POST', `/api/admin/affiliates/${top.id}/payouts`, { currency: 'USD' });
    expect(payout.payout.amount).toBe(100);
    await call(t, admin, 'POST', `/api/admin/affiliate-payouts/${payout.payout.id}/mark-paid`, { reference: 'WIRE-9' });
    await call(t, admin, 'POST', `/api/admin/payments/${paid.id}/refunds`, { amount: 1000, reason: 'Rest' });
    await t.app.worker.runUntilIdle();
    const rows = await commissions();
    [sale, upline] = rows;
    expect(sale).toMatchObject({ status: 'reversed', reversed_amount: 400 });
    expect(upline).toMatchObject({ status: 'paid', reversed_amount: 200 });
    expect(rows.find((c) => c.kind === 'clawback')).toMatchObject({ affiliate_id: top.id, level: 2, amount: -100, status: 'approved', reverses_id: upline.id });
  });

  it('reverses every level when a chargeback is lost', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { uplineRatesBps: [500] });
    const top = await affiliate({ email: 'top@partner.io', name: 'Top', code: 'top' });
    await affiliate({ parentId: top.id });
    const user = await apiUser(t, key, 'disputed@gmail.com');
    await refer(user.id, { code: 'partner' });
    await buy(user.id, cat.proMonthly.id);
    const { gateway_payment_id } = await payment(user.id);
    for (const event of [
      { type: 'dispute.created', eventId: 'd1', gatewayPaymentId: gateway_payment_id, gatewayDisputeId: 'dsp', amount: 2000, currency: 'USD', reason: 'fraud' },
      { type: 'dispute.closed', eventId: 'd2', gatewayDisputeId: 'dsp', outcome: 'lost' },
    ]) {
      const signed = signSandboxEvent(SECRET, event as any);
      await t.server.inject({ method: 'POST', url: `/api/public/gateways/${gateway.id}/webhook`, payload: signed.body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': signed.signature } });
    }
    await t.app.worker.runUntilIdle();
    expect((await commissions()).map((c) => [c.level, c.status, c.reversed_amount])).toEqual([
      [1, 'reversed', 400],
      [2, 'reversed', 100],
    ]);
    const reversed = await t.app.db.many<{ data: any }>(sql`SELECT data FROM events WHERE type = 'commission.reversed' ORDER BY created_at, id`);
    expect(reversed.map((e) => e.data.level)).toEqual([1, 2]);
  });

  it("holds commissions on an affiliate's own purchases for review, or pays none when set to", async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { uplineRatesBps: [500] });
    const topOwner = await apiUser(t, key, 'top-owner@gmail.com');
    const top = await affiliate({ email: 'top@partner.io', name: 'Top', code: 'top', userId: topOwner.id });
    const partnerOwner = await apiUser(t, key, 'partner-owner@gmail.com');
    const partner = await affiliate({ parentId: top.id, userId: partnerOwner.id });

    // By default the partner buying through their own link earns, but every level waits for review.
    await refer(partnerOwner.id, { code: 'partner' });
    await buy(partnerOwner.id, cat.proMonthly.id);
    expect((await commissions()).map((c) => [c.affiliate_id, c.level, c.flagged])).toEqual([[partner.id, 1, true], [top.id, 2, true]]);

    // Set to pay nothing: the recruiter buying through the partner's link earns the partner a commission,
    // and the recruiter nothing on their own purchase.
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { ownPurchases: 'never' });
    await refer(topOwner.id, { code: 'partner' });
    await buy(topOwner.id, cat.proMonthly.id);
    expect((await commissions()).slice(2).map((c) => [c.affiliate_id, c.level])).toEqual([[partner.id, 1]]);

    // An affiliate buying through their own link earns nothing at all.
    const soloOwner = await apiUser(t, key, 'solo-owner@gmail.com');
    await affiliate({ email: 'solo@partner.io', name: 'Solo', code: 'solo', userId: soloOwner.id });
    await refer(soloOwner.id, { code: 'solo' });
    await buy(soloOwner.id, cat.proMonthly.id);
    const own = await t.app.db.one<{ id: string }>(sql`SELECT id FROM invoices WHERE user_id = ${soloOwner.id}`);
    expect(await commissionForInvoice(t.app, own.id)).toMatchObject({ created: false, reason: 'own_purchase' });
    expect(await commissions()).toHaveLength(3);
  });

  it('skips inactive uplines without shifting levels and stops on a corrupted loop', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/affiliates', { uplineRatesBps: [500, 200, 100] });
    const { top, mid, leaf } = await chain();
    await call(t, admin, 'POST', `/api/admin/affiliates/${mid.id}/status`, { action: 'suspend', reason: 'Paused' });
    // A loop written behind the application's back (top <- leaf) must not make the walk run forever.
    await t.app.db.exec(sql`UPDATE affiliates SET parent_id = ${leaf.id} WHERE id = ${top.id}`);
    const user = await apiUser(t, key, 'loop@gmail.com');
    await refer(user.id, { code: 'leaf' });
    await buy(user.id, cat.proMonthly.id);
    expect((await commissions()).map((c) => [c.affiliate_id, c.level, c.amount])).toEqual([
      [leaf.id, 1, 400],
      [top.id, 3, 40],
    ]);
    expect((await call(t, admin, 'GET', `/api/admin/affiliates/${leaf.id}`)).upline.map((u: any) => u.level)).toEqual([2, 3]);
  });
});

describe('sub-ID tracking', () => {
  it('carries sub-IDs from links and the API to referrals and commissions, and reports them', async () => {
    const owner = await apiUser(t, key, 'subs@studio.dev');
    const aff = await affiliate({ userId: owner.id });
    const spring = await click('partner', { sub: 'spring-campaign', to: '/pricing' });
    expect(spring.location.searchParams.get('sub')).toBe('spring-campaign');
    expect((await click('partner', { sub: 'not valid!' })).location.searchParams.get('sub')).toBeNull();
    await click('partner');
    const clicks = await t.app.db.many<{ sub_id: string | null }>(sql`SELECT sub_id FROM affiliate_clicks ORDER BY created_at, id`);
    expect(clicks.map((c) => c.sub_id)).toEqual(['spring-campaign', null, null]);

    const fromLink = await apiUser(t, key, 'sub1@gmail.com');
    expect((await refer(fromLink.id, { clickId: spring.clickId })).referral.subId).toBe('spring-campaign');
    const fromCode = await apiUser(t, key, 'sub2@gmail.com');
    const invalid = await t.request({ method: 'POST', url: '/api/v1/referrals', bearer: key, body: { userId: fromCode.id, code: 'partner', subId: 'has spaces' } });
    expect(invalid.status).toBe(422);
    expect((await refer(fromCode.id, { code: 'partner', subId: 'newsletter' })).referral.subId).toBe('newsletter');
    expect((await t.request({ url: `/api/v1/referrals/${fromCode.id}`, bearer: key })).body.subId).toBe('newsletter');
    await buy(fromLink.id, cat.proMonthly.id);
    await buy(fromCode.id, cat.proYearly.id);
    expect((await commissions()).map((c) => c.sub_id)).toEqual(['spring-campaign', 'newsletter']);

    const report = await call(t, admin, 'GET', `/api/admin/affiliates/${aff.id}/sub-ids`);
    expect(report.data).toEqual([
      { subId: null, clicks: 2, signups: 0, conversions: 0, conversionRate: 0, commissions: [] },
      { subId: 'spring-campaign', clicks: 1, signups: 1, conversions: 1, conversionRate: 1, commissions: [{ currency: 'USD', amount: 400 }] },
      { subId: 'newsletter', clicks: 0, signups: 1, conversions: 1, conversionRate: null, commissions: [{ currency: 'USD', amount: 4000 }] },
    ]);
    const mine = await t.request({ url: '/api/client/affiliate/sub-ids', bearer: await customerSession(owner.id) });
    expect(mine.body.data).toEqual(report.data);
    expect((await call(t, admin, 'GET', '/api/admin/affiliate-commissions?subId=newsletter')).data.map((c: any) => c.amount)).toEqual([4000]);
    const before = new Date(t.clock.now().getTime() - DAY).toISOString();
    expect((await call(t, admin, 'GET', `/api/admin/affiliates/${aff.id}/sub-ids?to=${before}`)).data).toEqual([]);
    expect((await t.request({ url: `/api/admin/affiliates/${aff.id}/sub-ids?from=${t.clock.now().toISOString()}&to=${before}`, as: admin })).status).toBe(422);
  });
});

describe('marketing materials', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5950000000049454e44ae426082', 'hex');
  const PDF = Buffer.from('%PDF-1.4\n% brand kit\n');

  function upload(id: string, filename: string, contentType: string, data: Buffer, as: AdminSession = admin) {
    const boundary = '----steward-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return t.server.inject({
      method: 'POST',
      url: `/api/admin/affiliate-materials/${id}/file`,
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': as.csrf },
      cookies: { stw_admin: as.token },
    });
  }

  const material = (body: Record<string, unknown>, as: AdminSession = admin) => t.request({ method: 'POST', url: '/api/admin/affiliate-materials', as, body });

  it('publishes banners, text links and files with each affiliate’s own tracking link', async () => {
    const owner = await apiUser(t, key, 'promoter@studio.dev');
    const aff = await affiliate({ userId: owner.id });
    const group = await call(t, admin, 'POST', '/api/admin/affiliate-groups', { name: 'Influencers' });
    expect((await t.request({ method: 'POST', url: '/api/admin/affiliate-groups', as: admin, body: { name: 'influencers' } })).body.error.code).toBe('group_exists');
    const gold = await call(t, admin, 'POST', '/api/admin/affiliate-tiers', { name: 'Gold', metric: 'conversions', threshold: 1, ratePercent: 25 });

    expect((await material({ type: 'text_link', name: 'No text' })).status).toBe(422);
    expect((await material({ type: 'text_link', name: 'Off-site', linkText: 'Go', landingPath: 'https://evil.com/x' })).status).toBe(422);
    expect((await material({ type: 'banner', name: 'Insecure', imageUrl: 'http://cdn.example.com/b.png' })).status).toBe(422);
    expect((await material({ type: 'file', name: 'Nobody', groupIds: ['agrp_missing'] })).status).toBe(422);
    expect((await material({ type: 'file', name: 'Image', imageUrl: 'https://cdn.example.com/b.png' })).status).toBe(422);

    const text = (await material({ type: 'text_link', name: 'Pricing link', linkText: 'Try <Acme> free', landingPath: '/pricing' })).body;
    const hosted = (await material({ type: 'banner', name: 'Hosted banner', imageUrl: 'https://cdn.example.com/banner.png', width: 728, height: 90 })).body;
    const uploaded = (await material({ type: 'banner', name: 'Uploaded banner', linkText: 'Acme' })).body;
    const kit = (await material({ type: 'file', name: 'Brand kit', groupIds: [group.id] })).body;
    const vip = (await material({ type: 'banner', name: 'Gold banner', imageUrl: 'https://cdn.example.com/gold.png', tierIds: [gold.id] })).body;

    // Uploads are identified by their bytes; text links take no file.
    expect((await upload(uploaded.id, 'banner.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>'))).statusCode).toBe(422);
    expect((await upload(text.id, 'banner.png', 'image/png', PNG)).statusCode).toBe(422);
    const withImage = JSON.parse((await upload(uploaded.id, 'banner.png', 'image/png', PNG)).body);
    expect(withImage.previewUrl).toMatch(/^http:\/\/localhost:4000\/api\/public\/affiliate-assets\/file_/);
    const withFile = JSON.parse((await upload(kit.id, 'Brand kit.pdf', 'application/pdf', PDF)).body);
    expect(withFile.file).toMatchObject({ filename: 'Brand_kit.pdf', contentType: 'application/pdf', size: PDF.length });

    // Without a group or tier, the affiliate sees the unrestricted materials only.
    const session = await customerSession(owner.id);
    const visible = async () => (await t.request({ url: '/api/client/affiliate/materials', bearer: session })).body.data as any[];
    let list = await visible();
    expect(list.map((m) => m.name).sort()).toEqual(['Hosted banner', 'Pricing link', 'Uploaded banner']);
    const link = list.find((m) => m.id === text.id);
    expect(link.trackingLink).toBe(`http://localhost:4000/r/partner?to=%2Fpricing&m=${text.id}`);
    expect(link.embedHtml).toBe(`<a href="http://localhost:4000/r/partner?to=%2Fpricing&amp;m=${text.id}" rel="sponsored">Try &lt;Acme&gt; free</a>`);
    expect(list.find((m) => m.id === hosted.id).embedHtml).toContain('<img src="https://cdn.example.com/banner.png" alt="Hosted banner" width="728" height="90">');
    expect(list.find((m) => m.id === uploaded.id).imageUrl).toBe(withImage.previewUrl);

    // Joining the group reveals the brand kit, which downloads through the affiliate's own session only.
    await call(t, admin, 'PATCH', `/api/admin/affiliates/${aff.id}`, { groupId: group.id });
    list = await visible();
    expect(list.find((m) => m.id === kit.id).file).toEqual({ filename: 'Brand_kit.pdf', contentType: 'application/pdf', size: PDF.length });
    const download = await t.server.inject({ method: 'GET', url: `/api/client/affiliate/materials/${kit.id}/download`, headers: { authorization: `Bearer ${session}` } });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toBe('attachment; filename="Brand_kit.pdf"');
    expect(download.rawPayload.equals(PDF)).toBe(true);
    const outsider = await apiUser(t, key, 'outsider@studio.dev');
    await affiliate({ email: 'outsider@partner.io', name: 'Outsider', code: 'outsider', userId: outsider.id });
    const denied = await t.request({ url: `/api/client/affiliate/materials/${kit.id}/download`, bearer: await customerSession(outsider.id) });
    expect(denied.status).toBe(404);
    expect((await call(t, admin, 'GET', `/api/admin/affiliates/${aff.id}/materials`)).data.map((m: any) => m.id)).toContain(kit.id);

    // Reaching the Gold tier reveals the Gold banner.
    const buyer = await apiUser(t, key, 'gold@gmail.com');
    await refer(buyer.id, { code: 'partner' });
    await buy(buyer.id, cat.proMonthly.id);
    expect((await visible()).map((m) => m.id)).toContain(vip.id);

    // Banner images are public so affiliates can embed them; stored files are not.
    const asset = await t.server.inject({ method: 'GET', url: new URL(withImage.previewUrl).pathname });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('image/png');
    expect(asset.headers['content-security-policy']).toContain('sandbox');
    expect(asset.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(asset.rawPayload.equals(PNG)).toBe(true);
    expect((await t.server.inject({ method: 'GET', url: `/api/public/affiliate-assets/${withFile.file.id}` })).statusCode).toBe(404);

    // A material link records which material brought the click.
    const tracked = new URL(link.trackingLink);
    const followed = await t.server.inject({ method: 'GET', url: `${tracked.pathname}${tracked.search}`, remoteAddress: '198.51.100.30' });
    expect(new URL(String(followed.headers.location)).pathname).toBe('/pricing');
    const listed = await call(t, admin, 'GET', '/api/admin/affiliate-materials');
    expect(listed.data.find((m: any) => m.id === text.id).clicks30d).toBe(1);

    // Archived materials leave the affiliate area; groups and tiers that materials target cannot be deleted.
    await call(t, admin, 'PATCH', `/api/admin/affiliate-materials/${hosted.id}`, { status: 'archived' });
    expect((await visible()).map((m) => m.id)).not.toContain(hosted.id);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/affiliate-groups/${group.id}`, as: admin })).body.error.code).toBe('in_use');
    expect((await t.request({ method: 'DELETE', url: `/api/admin/affiliate-tiers/${gold.id}`, as: admin })).body.error.code).toBe('in_use');

    // Deleting a material removes its stored file.
    const stored = await t.app.db.one<{ storage_key: string }>(sql`SELECT storage_key FROM files WHERE id = ${withImage.file.id}`);
    await call(t, admin, 'DELETE', `/api/admin/affiliate-materials/${uploaded.id}`);
    expect(await t.app.storage.get(stored.storage_key)).toBeNull();
    expect((await t.server.inject({ method: 'GET', url: new URL(withImage.previewUrl).pathname })).statusCode).toBe(404);
    const audit = await t.app.db.many<{ action: string }>(sql`SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'affiliate.material_%'`);
    expect(audit.map((a) => a.action).sort()).toEqual(['affiliate.material_create', 'affiliate.material_delete', 'affiliate.material_update', 'affiliate.material_upload']);
  });

  it('switches a banner between uploaded images and a hosted image URL without leaving files behind', async () => {
    const stored = async () => t.app.db.many<{ id: string; storage_key: string }>(sql`SELECT id, storage_key FROM files WHERE owner_type = 'affiliate_material'`);
    const banner = (await material({ type: 'banner', name: 'Swap' })).body;
    const first = JSON.parse((await upload(banner.id, 'one.png', 'image/png', PNG)).body);
    const [firstFile] = await stored();
    const second = JSON.parse((await upload(banner.id, 'two.png', 'image/png', PNG)).body);
    expect(second.file.id).not.toBe(first.file.id);
    const [secondFile] = await stored();
    expect(secondFile.id).toBe(second.file.id);
    expect(await t.app.storage.get(firstFile.storage_key)).toBeNull();

    const hosted = await call(t, admin, 'PATCH', `/api/admin/affiliate-materials/${banner.id}`, { imageUrl: 'https://cdn.example.com/swap.png' });
    expect(hosted).toMatchObject({ file: null, imageUrl: 'https://cdn.example.com/swap.png', previewUrl: 'https://cdn.example.com/swap.png' });
    expect(await stored()).toEqual([]);
    expect(await t.app.storage.get(secondFile.storage_key)).toBeNull();

    const third = JSON.parse((await upload(banner.id, 'three.png', 'image/png', PNG)).body);
    expect(third).toMatchObject({ imageUrl: null, previewUrl: `http://localhost:4000/api/public/affiliate-assets/${third.file.id}` });
  });

  it('limits materials, groups and uplines to the right permissions', async () => {
    const aff = await affiliate();
    const text = (await material({ type: 'text_link', name: 'Home', linkText: 'Visit' })).body;
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/affiliate-materials', as: analyst })).status).toBe(200);
    expect((await t.request({ url: `/api/admin/affiliates/${aff.id}/sub-ids`, as: analyst })).status).toBe(200);
    expect((await material({ type: 'text_link', name: 'Nope', linkText: 'x' }, analyst)).status).toBe(403);
    expect((await upload(text.id, 'x.png', 'image/png', PNG, analyst)).statusCode).toBe(403);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/affiliate-materials/${text.id}`, as: analyst })).status).toBe(403);
    expect((await t.request({ method: 'POST', url: '/api/admin/affiliate-groups', as: analyst, body: { name: 'X' } })).status).toBe(403);
    expect((await t.request({ method: 'PATCH', url: `/api/admin/affiliates/${aff.id}`, as: analyst, body: { parentId: null } })).status).toBe(403);
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/affiliate-materials', as: support })).status).toBe(403);
    expect((await t.request({ url: '/api/admin/affiliate-groups', as: support })).status).toBe(403);
    expect((await t.request({ url: `/api/admin/affiliates/${aff.id}/sub-ids`, as: support })).status).toBe(403);
    const manager = await adminSession(t, ['affiliate_manager']);
    expect((await material({ type: 'text_link', name: 'Manager link', linkText: 'Visit' }, manager)).status).toBe(200);

    // Customers need an approved affiliate account of their own.
    expect((await t.request({ url: '/api/client/affiliate/materials' })).status).toBe(401);
    const stranger = await apiUser(t, key, 'stranger@studio.dev');
    expect((await t.request({ url: '/api/client/affiliate/materials', bearer: await customerSession(stranger.id) })).status).toBe(404);
    const applicant = await apiUser(t, key, 'applicant@studio.dev');
    const session = await customerSession(applicant.id);
    await t.request({ method: 'POST', url: '/api/client/affiliate/apply', bearer: session, body: { acceptTerms: true } });
    const pending = await t.request({ url: '/api/client/affiliate/materials', bearer: session });
    expect(pending.body.error.code).toBe('affiliate_inactive');
  });
});
