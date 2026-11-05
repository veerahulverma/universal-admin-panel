import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { allModules } from '../index.js';
import { reportsModule, fileToken } from './module.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';
import { payToken } from '../billing/checkout.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;
let gatewayId: string;

beforeEach(async () => {
  t = await createTestPlatform({ modules: allModules.some((m) => m.id === 'reports') ? allModules : [...allModules, reportsModule] });
  t.clock.set('2026-06-10T12:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0`);
  gatewayId = (await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: 's' } })).id;
});
afterEach(async () => {
  await t.close();
});

async function subscribe(email: string, priceId: string) {
  const user = await apiUser(t, key, email);
  const chk = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: user.id, priceId } });
  await t.server.inject({ method: 'POST', url: `/pay/sandbox/${gatewayId}/${chk.body.id}`, payload: { token: payToken(t.app, chk.body.id), outcome: 'success' } });
  return user;
}

describe('dashboard', () => {
  it('reports MRR, revenue and growth with comparison periods', async () => {
    await subscribe('m@example.com', cat.proMonthly.id);
    await subscribe('y@example.com', cat.proYearly.id);
    await apiUser(t, key, 'free@example.com');
    const dash = await call(t, admin, 'GET', '/api/admin/dashboard?days=30');
    const kpi = (k: string) => dash.kpis.find((x: any) => x.key === k);
    expect(dash.currency).toBe('USD');
    expect(kpi('mrr').value).toBe(2000 + Math.round(20000 / 12));
    expect(kpi('arr').value).toBe(kpi('mrr').value * 12);
    expect(kpi('revenue').value).toBe(22000);
    expect(kpi('new_users')).toMatchObject({ value: 3, previous: 0 });
    expect(kpi('active_subscriptions').value).toBe(2);
    expect(dash.series.revenue).toHaveLength(31); // a 30-day window ending at noon touches 31 calendar days
    expect(dash.series.revenue.reduce((s: number, p: any) => s + p.value, 0)).toBe(22000);
    expect(dash.recent.users).toHaveLength(3);
    expect(dash.recent.payments).toHaveLength(2);
  });

  it('nets refunds out of revenue in the period they happen', async () => {
    await subscribe('r@example.com', cat.proMonthly.id);
    const payment = await t.app.db.one<{ id: string }>(sql`SELECT id FROM payments`);
    await call(t, admin, 'POST', `/api/admin/payments/${payment.id}/refunds`, { amount: 500, reason: 'goodwill credit' });
    const dash = await call(t, admin, 'GET', '/api/admin/dashboard?days=7');
    expect(dash.kpis.find((k: any) => k.key === 'revenue').value).toBe(1500);
    expect(dash.kpis.find((k: any) => k.key === 'refunds').value).toBe(500);
  });

  it('saves a per-admin layout', async () => {
    await call(t, admin, 'PUT', '/api/admin/dashboard/layout', { widgets: [{ id: 'w1', type: 'kpi:mrr', size: 'sm' }] });
    expect((await call(t, admin, 'GET', '/api/admin/dashboard/layout')).widgets).toEqual([{ id: 'w1', type: 'kpi:mrr', size: 'sm', config: {} }]);
  });
});

describe('reports', () => {
  it('runs catalog reports and exports CSV', async () => {
    await subscribe('a@example.com', cat.proMonthly.id);
    await subscribe('b@example.com', cat.proMonthly.id);
    const catalog = await call(t, admin, 'GET', '/api/admin/reports');
    expect(catalog.data.map((r: any) => r.key)).toEqual(expect.arrayContaining(['revenue', 'mrr_by_plan', 'churn', 'ltv', 'signups', 'usage', 'api_usage']));
    const mrr = await call(t, admin, 'GET', '/api/admin/reports/mrr_by_plan');
    expect(mrr.rows).toEqual([{ plan: 'Pro', subscriptions: 2, mrr: 4000 }]);
    const revenue = await call(t, admin, 'GET', `/api/admin/reports/revenue?groupBy=month&from=2026-06-01&to=2026-07-01`);
    expect(revenue.rows[0]).toMatchObject({ gross: 4000, refunds: 0, net: 4000, payments: 2 });
    const csv = await t.request({ url: '/api/admin/reports/revenue/export.csv', as: admin, query: { groupBy: 'month' } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(String(csv.body).split('\r\n')[0]).toBe('Period,Payments,Gross,Refunds,Net');
    const churn = await call(t, admin, 'GET', `/api/admin/reports/churn?groupBy=month&from=2026-05-01&to=2026-06-30`);
    expect(churn.rows.length).toBeGreaterThan(0);
    const ltv = await call(t, admin, 'GET', '/api/admin/reports/ltv');
    expect(ltv.rows.map((r: any) => r.format)).toEqual(['number', 'money', 'percent', 'money']);
  });

  it('edits a saved report without resetting omitted fields', async () => {
    const saved = await call(t, admin, 'POST', '/api/admin/saved-reports', { name: 'Revenue', reportKey: 'revenue', params: { groupBy: 'week' }, schedule: 'weekly', recipients: ['cfo@example.com'] });
    const renamed = await call(t, admin, 'PATCH', `/api/admin/saved-reports/${saved.id}`, { name: 'Weekly revenue' });
    expect(renamed).toMatchObject({ name: 'Weekly revenue', schedule: 'weekly', recipients: ['cfo@example.com'], params: { groupBy: 'week' } });
    const monthly = await call(t, admin, 'PATCH', `/api/admin/saved-reports/${saved.id}`, { schedule: 'monthly' });
    expect(new Date(monthly.next_send_at).getTime()).toBeGreaterThan(new Date(saved.next_send_at).getTime());
    const bad = await t.request({ method: 'PATCH', url: `/api/admin/saved-reports/${saved.id}`, as: admin, body: { recipients: [] } });
    expect(bad.status).toBe(422);
    const other = await adminSession(t, ['analyst']);
    expect((await t.request({ method: 'PATCH', url: `/api/admin/saved-reports/${saved.id}`, as: other, body: { name: 'Mine' } })).status).toBeGreaterThanOrEqual(403);
  });

  it('delivers scheduled reports through a signed, expiring link', async () => {
    const saved = await call(t, admin, 'POST', '/api/admin/saved-reports', { name: 'Weekly revenue', reportKey: 'revenue', schedule: 'weekly', recipients: ['cfo@example.com'] });
    expect(new Date(saved.next_send_at).getTime()).toBeGreaterThan(t.clock.now().getTime());
    const sent = await call(t, admin, 'POST', `/api/admin/saved-reports/${saved.id}/send-now`);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const ok = await t.server.inject({ method: 'GET', url: `/api/public/report-files/${sent.fileId}?token=${encodeURIComponent(fileToken(t.app, sent.fileId, exp))}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.split('\r\n')[0]).toBe('Period,Payments,Gross,Refunds,Net');
    const forged = await t.server.inject({ method: 'GET', url: `/api/public/report-files/${sent.fileId}?token=${exp}.deadbeef` });
    expect(forged.statusCode).toBe(404);
    const expired = await t.server.inject({ method: 'GET', url: `/api/public/report-files/${sent.fileId}?token=${encodeURIComponent(fileToken(t.app, sent.fileId, 1000))}` });
    expect(expired.statusCode).toBe(404);
  });

  it('snapshots daily metrics for trend lines', async () => {
    await subscribe('s@example.com', cat.proMonthly.id);
    await t.app.jobs.enqueue(t.app.db, 'reports.snapshot', {});
    await t.app.worker.runUntilIdle();
    const snap = await t.app.db.one(sql`SELECT mrr, active_subscriptions FROM metrics_daily`);
    expect(snap).toEqual({ mrr: 2000, active_subscriptions: 1 });
    t.clock.advance(DAY);
    const dash = await call(t, admin, 'GET', '/api/admin/dashboard?days=3');
    expect(dash.series.mrr.some((p: any) => p.value === 2000)).toBe(true);
  });

  it('withholds platform-wide revenue from organization-scoped admins', async () => {
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Tenant' });
    const scoped = await adminSession(t, ['analyst'], [org.id]);
    const dash = await call(t, scoped, 'GET', '/api/admin/dashboard');
    expect(dash.kpis.find((k: any) => k.key === 'mrr')).toBeUndefined();
    // Every KPI and series is platform-wide, so a tenant-limited admin sees none of them.
    expect(dash.kpis).toEqual([]);
    expect(dash.series).toEqual({});
    expect(dash.scoped).toBe(true);
    expect((await t.request({ url: '/api/admin/reports/revenue', as: scoped })).status).toBe(422);
  });
});

describe('dashboard visibility by role', () => {
  it('shows each figure only to admins who may see its source data', async () => {
    await subscribe('paying@example.com', cat.proMonthly.id);
    const marketing = await adminSession(t, ['marketing_manager']);
    const dash = await call(t, marketing, 'GET', '/api/admin/dashboard?days=30');
    const keys = dash.kpis.map((k: any) => k.key);
    expect(keys).toContain('new_users');
    expect(keys).not.toContain('mrr');
    expect(keys).not.toContain('revenue');
    expect(keys).not.toContain('open_security_events');
    expect(dash.recent.payments).toEqual([]);
    expect(dash.recent.users.length).toBeGreaterThan(0);
    expect(Object.keys(dash.series)).toEqual(['signups']);

    const full = await call(t, admin, 'GET', '/api/admin/dashboard?days=30');
    const all = full.kpis.map((k: any) => k.key);
    expect(all).toEqual(expect.arrayContaining(['mrr', 'revenue', 'usage_events', 'affiliate_revenue', 'affiliate_commissions', 'affiliate_pending_payouts']));
    expect(full.recent.payments).toHaveLength(1);
    expect(full.scoped).toBe(false);
  });
});

describe('module reports', () => {
  it('covers affiliate, email and support analytics in the report catalog', async () => {
    const catalog = await call(t, admin, 'GET', '/api/admin/reports');
    expect(catalog.data.map((r: any) => r.key)).toEqual(expect.arrayContaining(['affiliate_performance', 'email_delivery', 'support_workload']));

    const user = await apiUser(t, key, 'helpme@example.com');
    const ticket = await t.request({ method: 'POST', url: '/api/v1/support/tickets', bearer: key, body: { userId: user.id, subject: 'Export help', body: 'The export is empty.' } });
    expect(ticket.status, JSON.stringify(ticket.body)).toBeLessThan(300);
    t.clock.advance(30 * 60 * 1000);
    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.body.id}/reply`, { body: 'Fixed, please try again.', status: 'solved' });
    await t.app.worker.runUntilIdle();

    const support = await call(t, admin, 'GET', '/api/admin/reports/support_workload?groupBy=month');
    const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    expect(sum(support.rows, 'created')).toBe(1);
    expect(sum(support.rows, 'solved')).toBe(1);
    expect(support.rows.find((r: any) => r.first_response_min !== null)?.first_response_min).toBe(30);

    const email = await call(t, admin, 'GET', '/api/admin/reports/email_delivery?groupBy=month');
    expect(email.columns.map((c: any) => c.key)).toEqual(expect.arrayContaining(['sent', 'open_rate', 'bounced']));
    expect(sum(email.rows, 'messages')).toBeGreaterThan(0); // the ticket confirmation and reply

    const affiliates = await call(t, admin, 'GET', '/api/admin/reports/affiliate_performance');
    expect(affiliates.columns.map((c: any) => c.key)).toEqual(expect.arrayContaining(['clicks', 'conversions', 'revenue', 'commissions']));
    expect(affiliates.currency).toBe('USD');
  });
});

describe('trial conversion', () => {
  it('splits trials into converted, dropped and still running', async () => {
    await t.app.db.exec(sql`UPDATE products SET trial_days = 14 WHERE key = 'pro'`);
    for (const email of ['trial-a@example.com', 'trial-b@example.com', 'trial-c@example.com']) await subscribe(email, cat.proMonthly.id);
    const subs = await t.app.db.many<{ id: string }>(sql`SELECT id FROM subscriptions WHERE trial_end IS NOT NULL ORDER BY created_at, id`);
    expect(subs).toHaveLength(3);
    const ended = new Date(t.clock.now().getTime() - DAY);
    // The first converted (still active after its trial), the second dropped at trial end, the third is still in trial.
    await t.app.db.exec(sql`UPDATE subscriptions SET trial_end = ${ended}, status = 'active' WHERE id = ${subs[0].id}`);
    await t.app.db.exec(sql`UPDATE subscriptions SET trial_end = ${ended}, status = 'canceled', ended_at = ${ended} WHERE id = ${subs[1].id}`);

    const report = await call(t, admin, 'GET', '/api/admin/reports/trial_conversion?groupBy=month');
    const total = (k: string) => report.rows.reduce((s: number, r: any) => s + Number(r[k]), 0);
    expect([total('trials'), total('converted'), total('dropped'), total('in_trial')]).toEqual([3, 1, 1, 1]);
    expect(report.rows[0].conversion_rate).toBeCloseTo(0.5);
  });
});
