import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call, seedCatalog } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

async function customerSession(key: string, userId: string): Promise<string> {
  const res = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token;
}

describe('agreements', () => {
  it('versions documents and records who accepted which version, from where', async () => {
    const terms = await call(t, admin, 'POST', '/api/admin/agreements', { key: 'terms', title: 'Terms of Service', body: 'Version one text', required: true });
    expect(terms.current).toMatchObject({ version: 1, title: 'Terms of Service' });
    const key = await apiKey(t, admin, ['users:write', 'customer_sessions:write']);
    const user = (await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email: 'reader@example.com' } })).body.user;
    const token = await customerSession(key, user.id);

    const pending = await t.request({ url: '/api/client/agreements', bearer: token });
    expect(pending.body.pending).toHaveLength(1);
    expect(pending.body.pending[0]).toMatchObject({ key: 'terms', version: 1, body: 'Version one text' });
    const v1 = pending.body.pending[0].versionId;
    const accepted = await t.request({ method: 'POST', url: `/api/client/agreements/${v1}/accept`, bearer: token, ip: '198.51.100.23', headers: { 'user-agent': 'Firefox' } });
    expect(accepted.body).toMatchObject({ version: 1, created: true });
    expect((await t.request({ method: 'POST', url: `/api/client/agreements/${v1}/accept`, bearer: token })).body.created).toBe(false);
    expect((await t.request({ url: '/api/client/agreements', bearer: token })).body.pending).toEqual([]);

    // A scheduled version does not apply until its date; then it must be accepted again.
    const v2 = await call(t, admin, 'POST', `/api/admin/agreements/${terms.id}/versions`, { body: 'Version two text', summary: 'New refund terms', effectiveAt: new Date(t.clock.now().getTime() + 7 * DAY).toISOString() });
    expect((await t.request({ url: '/api/public/agreements/terms' })).body.version).toBe(1);
    expect((await t.request({ method: 'POST', url: `/api/client/agreements/${v2.versionId}/accept`, bearer: token })).body.error.code).toBe('agreement_version_outdated');
    const edited = await call(t, admin, 'PATCH', `/api/admin/agreement-versions/${v2.versionId}`, { body: 'Version two, corrected' });
    expect(edited.body).toBe('Version two, corrected');
    const locked = await t.request({ method: 'PATCH', url: `/api/admin/agreement-versions/${v1}`, as: admin, body: { body: 'Rewriting history' } });
    expect(locked.body.error.code).toBe('agreement_version_locked');
    const backdated = await t.request({ method: 'POST', url: `/api/admin/agreements/${terms.id}/versions`, as: admin, body: { body: 'x', effectiveAt: new Date(t.clock.now().getTime() - DAY).toISOString() } });
    expect(backdated.status).toBe(422);

    t.clock.advance(8 * DAY);
    const token2 = await customerSession(key, user.id);
    const nowPending = (await t.request({ url: '/api/client/agreements', bearer: token2 })).body.pending;
    expect(nowPending.map((p: any) => p.version)).toEqual([2]);
    expect((await t.request({ method: 'POST', url: `/api/client/agreements/${v1}/accept`, bearer: token2 })).body.error.code).toBe('agreement_version_outdated');
    const viaApi = await t.request({ method: 'POST', url: `/api/v1/users/${user.id}/agreements/accept`, bearer: key, body: { versionId: v2.versionId, ip: '203.0.113.99' } });
    expect(viaApi.body).toMatchObject({ version: 2, created: true });

    const forAdmin = await call(t, admin, 'GET', `/api/admin/users/${user.id}/agreements`);
    expect(forAdmin.pending).toEqual([]);
    expect(forAdmin.accepted.map((a: any) => [a.version, a.source, a.ip, a.current])).toEqual([
      [2, 'api', '203.0.113.99', true],
      [1, 'client', '198.51.100.23', false],
    ]);
    const acceptances = await call(t, admin, 'GET', `/api/admin/agreements/${terms.id}/acceptances`);
    expect(acceptances.total).toBe(2);
    expect((await t.app.db.many(sql`SELECT type FROM events WHERE type LIKE 'agreement.%' ORDER BY created_at`)).map((e) => e.type)).toEqual([
      'agreement.version_published',
      'agreement.accepted',
      'agreement.version_published',
      'agreement.accepted',
    ]);
  });

  it('limits management to agreement managers and keeps versions in use', async () => {
    const support = await adminSession(t, ['support']);
    expect((await t.request({ method: 'POST', url: '/api/admin/agreements', as: support, body: { key: 'privacy', title: 'Privacy', body: 'x' } })).status).toBe(403);
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/agreements', as: analyst })).status).toBe(200);
    const privacy = await call(t, admin, 'POST', '/api/admin/agreements', { key: 'privacy', title: 'Privacy', body: 'x' });
    expect((await t.request({ method: 'POST', url: '/api/admin/agreements', as: admin, body: { key: 'privacy', title: 'Again', body: 'y' } })).status).toBe(409);
    await call(t, admin, 'POST', '/api/admin/signup-forms', { key: 'main', name: 'Main', agreementId: privacy.id });
    expect((await t.request({ method: 'PATCH', url: `/api/admin/agreements/${privacy.id}`, as: admin, body: { archived: true } })).body.error.code).toBe('agreement_in_use');
    const only = (await call(t, admin, 'GET', `/api/admin/agreements/${privacy.id}`)).versionList[0];
    expect((await t.request({ method: 'DELETE', url: `/api/admin/agreement-versions/${only.versionId}`, as: admin })).body.error.code).toBe('agreement_version_locked');
  });
});

describe('signup forms', () => {
  it('validates definitions against the fields, agreements and plans that exist', async () => {
    await call(t, admin, 'POST', '/api/admin/custom-fields', { entity: 'user', key: 'industry', label: 'Industry', type: 'select', options: ['retail', 'saas'], required: true });
    const bad = await t.request({
      method: 'POST',
      url: '/api/admin/signup-forms',
      as: admin,
      body: { key: 'bad', name: 'Bad', fields: [{ type: 'custom', key: 'nope' }, { type: 'profile', key: 'marketingConsent', required: true }, { type: 'profile', key: 'shoe_size' }], planIds: ['prod_missing'] },
    });
    expect(bad.status).toBe(422);
    const messages = bad.body.error.details.map((d: any) => d.message).join(' | ');
    expect(messages).toMatch(/No custom field "nope"/);
    expect(messages).toMatch(/Marketing consent must stay optional/);
    expect(messages).toMatch(/Unknown profile field "shoe_size"/);
    expect(messages).toMatch(/Industry is required for every customer/);
    expect(messages).toMatch(/Not an active plan/);
    const support = await adminSession(t, ['support']);
    expect((await t.request({ method: 'POST', url: '/api/admin/signup-forms', as: support, body: { key: 'x', name: 'X' } })).status).toBe(403);
  });

  it('serves the form publicly and validates API registrations against it', async () => {
    const catalog = await seedCatalog(t, admin);
    await call(t, admin, 'POST', '/api/admin/custom-fields', { entity: 'user', key: 'company_size', label: 'Company size', type: 'number' });
    const terms = await call(t, admin, 'POST', '/api/admin/agreements', { key: 'terms', title: 'Terms of Service', body: 'Be nice.' });
    const form = await call(t, admin, 'POST', '/api/admin/signup-forms', {
      key: 'partners',
      name: 'Partner signup',
      fields: [
        { type: 'profile', key: 'name', required: true },
        { type: 'custom', key: 'company_size', required: true, label: 'Team size' },
        { type: 'profile', key: 'marketingConsent' },
      ],
      agreementId: terms.id,
      planIds: [catalog.pro.id],
      redirectUrl: 'https://app.example.com/welcome',
      tags: ['partner'],
    });

    const pub = await t.request({ url: '/api/public/signup-forms/partners' });
    expect(pub.status).toBe(200);
    expect(pub.body.fields.map((f: any) => [f.key, f.required, f.input])).toEqual([
      ['email', true, 'email'],
      ['name', true, 'text'],
      ['company_size', true, 'number'],
      ['marketingConsent', false, 'checkbox'],
    ]);
    expect(pub.body.fields[2].label).toBe('Team size');
    expect(pub.body.agreement).toMatchObject({ key: 'terms', version: 1, body: 'Be nice.' });
    expect(pub.body.plans.map((p: any) => p.key)).toEqual(['pro']);
    expect(pub.body.plans[0].prices.map((p: any) => p.unitAmount).sort()).toEqual([2000, 20000]);
    expect(pub.body.redirectUrl).toBe('https://app.example.com/welcome');

    const key = await apiKey(t, admin, ['users:write']);
    const missing = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email: 'p@example.com', formKey: 'partners' } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.map((d: any) => d.path.join('.'))).toEqual(expect.arrayContaining(['fields.name', 'fields.company_size', 'agreementVersionId']));
    const stale = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email: 'p@example.com', name: 'P', customFields: { company_size: 5 }, formKey: 'partners', agreementVersionId: 'agv_old' } });
    expect(stale.body.error.code).toBe('agreement_version_outdated');
    const wrongPlan = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email: 'p@example.com', name: 'P', customFields: { company_size: 5 }, formKey: 'partners', agreementVersionId: pub.body.agreement.versionId, plan: 'team' } });
    expect(wrongPlan.body.error.details[0].path).toEqual(['plan']);

    const ok = await t.request({
      method: 'POST',
      url: '/api/v1/users',
      bearer: key,
      body: { email: 'p@example.com', name: 'Pat Partner', customFields: { company_size: 12 }, formKey: 'partners', agreementVersionId: pub.body.agreement.versionId, plan: 'pro', ip: '198.51.100.40' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ redirectUrl: 'https://app.example.com/welcome', plan: 'pro', user: { tags: ['partner'], metadata: { signupForm: 'partners', signupPlan: 'pro' }, customFields: { company_size: 12 } } });
    const acceptance = await t.app.db.one(sql`SELECT source, ip FROM agreement_acceptances WHERE user_id = ${ok.body.user.id}`);
    expect(acceptance).toEqual({ source: 'api', ip: '198.51.100.40' });
    expect((await call(t, admin, 'GET', '/api/admin/signup-forms')).data[0]).toMatchObject({ key: 'partners', signups: 1, agreementTitle: 'Terms of Service' });

    await call(t, admin, 'PATCH', `/api/admin/signup-forms/${form.id}`, { active: false });
    expect((await t.request({ url: '/api/public/signup-forms/partners' })).status).toBe(404);
    const inactive = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email: 'q@example.com', formKey: 'partners' } });
    expect(inactive.body.error.details[0].path).toEqual(['formKey']);
  });
});
