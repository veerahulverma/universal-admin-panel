import type { Platform } from './app.js';
import type { OffsetClock } from './core/clock.js';
import { DAY } from './core/clock.js';
import { sql } from './core/sql.js';
import { hashPassword, randomToken } from './core/crypto.js';
import { newId, randomBase62 } from './core/ids.js';
import { createInvoiceCheckout, payToken } from './modules/billing/checkout.js';
import { renewSubscription } from './modules/billing/engine.js';
import { SANDBOX_DECLINE_METHOD } from './modules/billing/gateways/sandbox.js';

/**
 * Demo data generated through the real APIs (so every invariant, event and
 * audit entry is genuine). The clock is moved through the past 120 days so
 * dashboards show realistic trends: signups, renewals, upgrades, churn,
 * failed payments, refunds and usage.
 */
export async function seedDemo(platform: Platform, clock: OffsetClock, opts: { adminEmail: string; adminPassword?: string; log?: (m: string) => void }): Promise<{ adminEmail: string; adminPassword: string; apiKey: string }> {
  const { app, server } = platform;
  const log = opts.log ?? (() => undefined);
  const end = Date.now();
  const start = end - 120 * DAY;
  clock.set(new Date(start));

  // ---- Administrator ------------------------------------------------------------
  const adminPassword = opts.adminPassword ?? `Demo-${randomBase62(10)}!`;
  const existing = await app.db.maybe<{ id: string }>(sql`SELECT id FROM admins WHERE lower(email) = ${opts.adminEmail.toLowerCase()}`);
  if (existing) throw new Error(`An administrator ${opts.adminEmail} already exists; seed into an empty database`);
  const adminId = newId('adm');
  await app.db.exec(sql.insert('admins', { id: adminId, email: opts.adminEmail, name: 'Demo Admin', password_hash: await hashPassword(adminPassword), status: 'active', password_changed_at: clock.now(), created_at: clock.now(), updated_at: clock.now() }, ''));
  await app.db.exec(sql`INSERT INTO admin_roles (admin_id, role_id) SELECT ${adminId}, id FROM roles WHERE key = 'super_admin'`);
  delete app.services['iam.setupToken'];
  const token = `stw_${randomToken(32)}`;
  const { sha256 } = await import('./core/crypto.js');
  await app.db.exec(sql.insert('admin_sessions', { id: newId('ses'), admin_id: adminId, token_hash: sha256(token), csrf_token: randomToken(16), client: 'mobile', mfa_verified: true, reauth_at: new Date(end + DAY), created_at: clock.now(), last_seen_at: new Date(end), expires_at: new Date(end + DAY) }, ''));

  const call = async (method: string, url: string, body?: unknown, bearer = token) => {
    await app.db.exec(sql`UPDATE admin_sessions SET last_seen_at = ${clock.now()}, reauth_at = ${clock.now()} WHERE token_hash = ${sha256(token)}`);
    const res = await server.inject({ method: method as any, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, remoteAddress: '127.0.0.1' });
    if (res.statusCode >= 300) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
    return res.body ? JSON.parse(res.body) : null;
  };

  log('settings');
  await call('PATCH', '/api/admin/settings/general', { appName: 'Acme Cloud', supportEmail: 'support@acme.test', currencies: ['USD', 'EUR', 'GBP', 'INR'] });
  await call('PATCH', '/api/admin/settings/billing', { sellerName: 'Acme Cloud Inc.', sellerAddress: '500 Market Street\nSan Francisco, CA 94105', sellerEmail: 'billing@acme.test', sellerCountry: 'US', taxEnabled: true, refundApprovalThreshold: 20000 });
  await call('PATCH', '/api/admin/settings/developers', { clientOrigins: ['http://localhost:3000', 'http://localhost:5173'] });

  // ---- Catalog ------------------------------------------------------------------
  log('catalog');
  for (const m of [
    { key: 'api_calls', name: 'API calls', unit: 'calls' },
    { key: 'ai_tokens', name: 'AI tokens', unit: 'tokens', weights: { model: { large: 5, small: 1 } }, creditType: 'credits', creditsPerUnit: 0.01 },
    { key: 'projects', name: 'Projects', kind: 'gauge' },
    { key: 'storage_mb', name: 'Storage', unit: 'MB', kind: 'gauge' },
  ]) await call('POST', '/api/admin/meters', m);
  for (const f of [
    { key: 'api_calls', name: 'API calls / month', type: 'quota', meterKey: 'api_calls', unit: 'calls' },
    { key: 'ai_tokens', name: 'AI tokens / month', type: 'quota', meterKey: 'ai_tokens', unit: 'tokens' },
    { key: 'projects', name: 'Projects', type: 'quota', meterKey: 'projects' },
    { key: 'storage', name: 'Storage', type: 'quota', meterKey: 'storage_mb', unit: 'MB' },
    { key: 'sso', name: 'Single sign-on', type: 'boolean' },
    { key: 'custom_domain', name: 'Custom domain', type: 'boolean' },
    { key: 'priority_support', name: 'Priority support', type: 'boolean' },
    { key: 'audit_log', name: 'Audit log export', type: 'boolean' },
    { key: 'support_tier', name: 'Support tier', type: 'config' },
  ]) await call('POST', '/api/admin/features', f);

  const product = async (body: Record<string, unknown>, features: Record<string, unknown>[], prices: Record<string, unknown>[]) => {
    const p = await call('POST', '/api/admin/products', body);
    await call('PUT', `/api/admin/products/${p.id}/features`, { features });
    const out = [];
    for (const price of prices) out.push(await call('POST', `/api/admin/products/${p.id}/prices`, price));
    return { product: p, prices: out };
  };
  const monthly = (unitAmount: number, extra = {}) => ({ currency: 'USD', type: 'recurring', interval: 'month', unitAmount, ...extra });
  const yearly = (unitAmount: number, extra = {}) => ({ currency: 'USD', type: 'recurring', interval: 'year', unitAmount, ...extra });

  await product({ key: 'free', name: 'Free', kind: 'plan', planType: 'free', sortOrder: 0, highlights: ['1 project', '1,000 API calls / month', 'Community support'] }, [
    { featureKey: 'api_calls', limit: 1000, resetPeriod: 'month' },
    { featureKey: 'ai_tokens', limit: 5000, resetPeriod: 'month' },
    { featureKey: 'projects', limit: 1, resetPeriod: 'none' },
    { featureKey: 'storage', limit: 500, resetPeriod: 'none' },
    { featureKey: 'support_tier', config: 'community' },
  ], []);
  const starter = await product({ key: 'starter', name: 'Starter', kind: 'plan', planType: 'paid', sortOrder: 1, trialDays: 14, highlights: ['5 projects', '50,000 API calls', 'Email support'] }, [
    { featureKey: 'api_calls', limit: 50_000, resetPeriod: 'billing_period', warnAtPercent: 80 },
    { featureKey: 'ai_tokens', limit: 200_000, resetPeriod: 'billing_period' },
    { featureKey: 'projects', limit: 5, resetPeriod: 'none' },
    { featureKey: 'storage', limit: 10_000, resetPeriod: 'none' },
    { featureKey: 'support_tier', config: 'email' },
  ], [monthly(1900), yearly(19000), { currency: 'EUR', type: 'recurring', interval: 'month', unitAmount: 1800 }, { currency: 'INR', type: 'recurring', interval: 'month', unitAmount: 149900 }]);
  const pro = await product({ key: 'pro', name: 'Pro', kind: 'plan', planType: 'paid', sortOrder: 2, highlights: ['Unlimited projects', '500,000 API calls', 'SSO', 'Priority support'] }, [
    { featureKey: 'api_calls', limit: 500_000, resetPeriod: 'billing_period', enforcement: 'overage', overageUnitAmount: 1 },
    { featureKey: 'ai_tokens', limit: 2_000_000, resetPeriod: 'billing_period' },
    { featureKey: 'projects', unlimited: true, resetPeriod: 'none' },
    { featureKey: 'storage', limit: 100_000, resetPeriod: 'none' },
    { featureKey: 'sso' },
    { featureKey: 'custom_domain' },
    { featureKey: 'priority_support' },
    { featureKey: 'support_tier', config: 'priority' },
  ], [monthly(4900, { introAmount: 2900, introCycles: 2 }), yearly(49000)]);
  const team = await product({ key: 'team', name: 'Team', kind: 'plan', planType: 'paid', subscriberType: 'organization', sortOrder: 3, highlights: ['Per-seat pricing', 'Shared quotas', 'Audit log export'] }, [
    { featureKey: 'api_calls', limit: 100_000, perSeat: true, resetPeriod: 'billing_period' },
    { featureKey: 'projects', unlimited: true, resetPeriod: 'none' },
    { featureKey: 'sso' },
    { featureKey: 'audit_log' },
    { featureKey: 'priority_support' },
  ], [monthly(1500, { pricingModel: 'per_seat', minQuantity: 2 })]);
  const addon = await product({ key: 'extra_calls', name: 'Extra 100k API calls', kind: 'addon' }, [{ featureKey: 'api_calls', limit: 100_000 }], [monthly(900)]);
  const pack = await product({ key: 'credits_1000', name: '1,000 AI credits', kind: 'credit_pack', creditType: 'credits', creditAmount: 1000 }, [], [{ currency: 'USD', type: 'one_time', unitAmount: 1000 }]);
  const lifetime = await product({ key: 'lifetime', name: 'Lifetime deal', kind: 'plan', planType: 'lifetime', isPublic: false }, [
    { featureKey: 'api_calls', limit: 100_000, resetPeriod: 'month' },
    { featureKey: 'projects', limit: 20, resetPeriod: 'none' },
    { featureKey: 'sso' },
  ], [{ currency: 'USD', type: 'one_time', unitAmount: 29900 }]);

  await call('POST', '/api/admin/coupons', { code: 'WELCOME20', name: 'Welcome 20%', discountType: 'percent', percentOff: 20, duration: 'once', maxPerCustomer: 1, campaign: 'onboarding' });
  await call('POST', '/api/admin/coupons', { code: 'ANNUAL50', name: '$50 off annual plans', discountType: 'fixed', amountOff: 5000, currency: 'USD', appliesTo: [pro.product.id, starter.product.id] });
  await call('POST', '/api/admin/coupons', { code: 'BLACKFRIDAY', name: 'Black Friday 40% for 3 months', discountType: 'percent', percentOff: 40, duration: 'repeating', durationCycles: 3, maxRedemptions: 500 });
  for (const tr of [
    { name: 'VAT', country: 'DE', ratePercent: 19, reverseChargeB2b: true },
    { name: 'VAT', country: 'FR', ratePercent: 20, reverseChargeB2b: true },
    { name: 'VAT', country: 'GB', ratePercent: 20 },
    { name: 'GST', country: 'IN', ratePercent: 18, taxType: 'gst' },
  ]) await call('POST', '/api/admin/tax-rates', tr);
  await call('PUT', '/api/admin/exchange-rates', { rates: [{ base: 'EUR', quote: 'USD', rate: 1.08 }, { base: 'GBP', quote: 'USD', rate: 1.27 }, { base: 'USD', quote: 'INR', rate: 83.2 }] });

  log('gateways');
  const sandbox = await call('POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox (test cards)', mode: 'test', isDefault: true, secrets: { webhook_secret: randomToken(24) } });
  await call('POST', '/api/admin/gateways', { adapter: 'manual', name: 'Bank transfer', mode: 'live', config: { instructions: 'Transfer the amount due to the account below and include the payment reference.', bankDetails: 'Acme Cloud Inc.\nIBAN: DE00 0000 0000 0000 0000 00\nBIC: DEMODEFF' } });

  const keyRes = await call('POST', '/api/admin/api-keys', { name: 'Demo app backend', scopes: ['*'], mode: 'test' });
  const apiKey: string = keyRes.secret;
  const v1 = (method: string, url: string, body?: unknown) => call(method, url, body, apiKey);

  // ---- Customers over time --------------------------------------------------------
  log('customers and subscriptions');
  const first = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Barbara', 'Ken', 'Radia', 'Tim', 'Frances', 'Dennis', 'Hedy', 'John', 'Katherine', 'Edsger', 'Shafi', 'Donald', 'Sophie', 'Raj', 'Mei', 'Ana', 'Kofi', 'Yuki', 'Lars', 'Priya', 'Omar', 'Elena', 'Diego'];
  const last = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Turing', 'Liskov', 'Thompson', 'Perlman', 'Berners', 'Allen', 'Ritchie', 'Lamarr', 'Backus', 'Johnson', 'Dijkstra', 'Goldwasser', 'Knuth', 'Wilson', 'Reddy', 'Chen', 'Silva', 'Mensah', 'Tanaka', 'Nilsson', 'Patel', 'Haddad', 'Petrova', 'Garcia'];
  const countries = ['US', 'US', 'US', 'GB', 'DE', 'FR', 'IN', 'IN', 'CA', 'BR', 'JP', 'AU', 'NL', 'ES'];
  const sources = ['organic', 'google_ads', 'producthunt', 'referral', 'newsletter', 'twitter', null];
  const rand = (() => {
    let s = 42;
    return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  })();
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const users: { id: string; email: string; plan: string | null; subscriptionId?: string }[] = [];

  const payCheckout = async (id: string, outcome: 'success' | 'decline' = 'success') => {
    const res = await server.inject({ method: 'POST', url: `/pay/sandbox/${sandbox.id}/${id}`, payload: { token: payToken(app, id), outcome } });
    if (res.statusCode !== 303) throw new Error(`sandbox payment failed: ${res.statusCode} ${res.body}`);
  };

  const orgs: { id: string; owner: string }[] = [];
  for (let day = 0; day < 120; day++) {
    clock.set(new Date(start + day * DAY + (9 + rand() * 9) * 3600_000));
    const signups = Math.floor(rand() * 3) + (day > 80 ? 1 : 0);
    for (let i = 0; i < signups; i++) {
      const name = `${pick(first)} ${pick(last)}`;
      const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${users.length + 1}@example.com`;
      const res = await v1('POST', '/api/v1/users', { email, name, externalId: `app-user-${users.length + 1}`, country: pick(countries), registrationSource: pick(sources) ?? undefined, marketingConsent: rand() > 0.4, tags: rand() > 0.85 ? ['vip'] : [] });
      const u = { id: res.user.id as string, email, plan: null as string | null, subscriptionId: undefined as string | undefined };
      users.push(u);
      await v1('POST', `/api/v1/users/${u.id}/login-events`, { success: true, ip: `198.51.100.${Math.floor(rand() * 250)}`, userAgent: pick(['Mozilla/5.0 Chrome/131', 'Mozilla/5.0 Firefox/133', 'Mozilla/5.0 Safari/18']) });
      const roll = rand();
      try {
        if (roll < 0.28) {
          const chk = await v1('POST', '/api/v1/checkout/sessions', { userId: u.id, priceId: rand() > 0.85 ? starter.prices[1].id : starter.prices[0].id, couponCode: rand() > 0.8 ? 'WELCOME20' : undefined });
          if (chk.status === 'open') await payCheckout(chk.id);
          u.plan = 'starter';
        } else if (roll < 0.43) {
          const chk = await v1('POST', '/api/v1/checkout/sessions', { userId: u.id, priceId: rand() > 0.7 ? pro.prices[1].id : pro.prices[0].id });
          if (chk.status === 'open') await payCheckout(chk.id, rand() > 0.93 ? 'decline' : 'success');
          u.plan = 'pro';
        } else if (roll < 0.47) {
          const chk = await v1('POST', '/api/v1/checkout/sessions', { userId: u.id, priceId: lifetime.prices[0].id });
          await payCheckout(chk.id);
        } else if (roll < 0.52) {
          const chk = await v1('POST', '/api/v1/checkout/sessions', { userId: u.id, priceId: pack.prices[0].id, quantity: 1 + Math.floor(rand() * 3) });
          await payCheckout(chk.id);
        }
      } catch (err) {
        log(`skipped purchase for ${email}: ${(err as Error).message}`);
      }
      if (rand() > 0.93 && orgs.length < 6) {
        const org = await call('POST', '/api/admin/organizations', { name: `${pick(last)} ${pick(['Labs', 'Systems', 'Studio', 'Analytics', 'Robotics'])}`, ownerUserId: u.id });
        orgs.push({ id: org.id, owner: u.id });
        const chk = await v1('POST', '/api/v1/checkout/sessions', { userId: u.id, orgId: org.id, priceId: team.prices[0].id, quantity: 2 + Math.floor(rand() * 6) });
        if (chk.status === 'open') await payCheckout(chk.id);
      }
    }
    // Usage from paying customers.
    for (const u of users.slice(-40)) {
      if (rand() > 0.5) continue;
      await v1('POST', '/api/v1/usage/record', { userId: u.id, meter: 'api_calls', quantity: Math.floor(rand() * (u.plan === 'pro' ? 25_000 : u.plan === 'starter' ? 2500 : 60)) + 1, idempotencyKey: `seed-${u.id}-${day}` });
      if (rand() > 0.6) await v1('POST', `/api/v1/users/${u.id}/activity`, {});
    }
    // Occasionally a saved card starts declining, so dunning has something to do.
    if (day % 17 === 9) {
      await app.db.exec(sql`
        UPDATE payment_methods SET gateway_ref = ${SANDBOX_DECLINE_METHOD} || '_' || id
        WHERE id IN (SELECT id FROM payment_methods WHERE gateway_ref NOT LIKE ${`${SANDBOX_DECLINE_METHOD}%`} ORDER BY random() LIMIT 1)
      `);
    }
    // Renewals, dunning and maintenance for this day.
    const due = await app.db.many<{ id: string }>(sql`SELECT id FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due') AND current_period_end <= ${clock.now()}`);
    for (const s of due) await renewSubscription(app.db, app, s.id).catch((err) => log(`renewal failed: ${err.message}`));
    // Most trial customers pay their first invoice through the hosted invoice page.
    const open = await app.db.many<{ id: string }>(sql`SELECT id FROM invoices WHERE status = 'open' AND subscription_id IS NOT NULL AND attempt_count = 0`);
    for (const inv of open) {
      if (rand() > 0.75) continue;
      const chk = await app.db.tx((tx) => createInvoiceCheckout(tx, app, inv.id, { gatewayId: sandbox.id })).catch(() => null);
      if (chk) await payCheckout(chk.id).catch(() => undefined);
    }
    if (day % 7 === 0) await app.jobs.enqueue(app.db, 'billing.dunning', {});
    await app.jobs.enqueue(app.db, 'reports.snapshot', {});
    await app.worker.runUntilIdle(500).catch(() => undefined);

    // Churn, upgrades and support moments.
    if (day > 30 && rand() > 0.7) {
      const active = await app.db.many<{ id: string }>(sql`SELECT id FROM subscriptions WHERE status = 'active' AND subject_type = 'user' ORDER BY random() LIMIT 1`);
      if (active[0]) await v1('POST', `/api/v1/subscriptions/${active[0].id}/cancel`, { atPeriodEnd: true, reason: pick(['too expensive', 'missing features', 'switched to competitor', 'no longer needed']) }).catch(() => undefined);
    }
    if (day > 20 && rand() > 0.75) {
      const sub = await app.db.maybe<{ id: string }>(sql`SELECT s.id FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE p.key = 'starter' AND s.status = 'active' AND s.currency = 'USD' ORDER BY random() LIMIT 1`);
      if (sub) await v1('POST', `/api/v1/subscriptions/${sub.id}/change`, { priceId: pro.prices[0].id }).catch(() => undefined);
    }
  }

  clock.set(new Date(end));
  // A few operational stories for the demo.
  const recent = await app.db.many<{ id: string }>(sql`SELECT id FROM payments WHERE status = 'succeeded' ORDER BY created_at DESC LIMIT 3`);
  if (recent[0]) await call('POST', `/api/admin/payments/${recent[0].id}/refunds`, { amount: 500, reason: 'Downtime credit for incident #142' }).catch(() => undefined);
  if (users[3]) await call('POST', `/api/admin/users/${users[3].id}/status`, { action: 'suspend', reason: 'Payment dispute under review' }).catch(() => undefined);
  if (users[5]) await call('POST', `/api/admin/users/${users[5].id}/notes`, { body: 'Asked about SSO for their whole team; follow up next week.', pinned: true }).catch(() => undefined);
  await call('POST', '/api/admin/security/ip-rules', { cidr: '203.0.113.0/24', action: 'block', scope: 'auth', reason: 'Credential stuffing seen from this range' }).catch(() => undefined);
  await app.jobs.enqueue(app.db, 'reports.snapshot', {});
  await app.worker.runUntilIdle(500).catch(() => undefined);
  await app.db.exec(sql`DELETE FROM admin_sessions WHERE token_hash = ${sha256(token)}`);
  log(`created ${users.length} users, ${orgs.length} organizations`);
  void addon;
  return { adminEmail: opts.adminEmail, adminPassword, apiKey };
}
