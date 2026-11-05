import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';

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

describe('partial updates', () => {
  it('changes only the product fields that were sent', async () => {
    await call(t, admin, 'PATCH', `/api/admin/products/${cat.pro.id}`, { isPublic: false, highlights: ['SSO'], sortOrder: 4 });
    await call(t, admin, 'PATCH', `/api/admin/products/${cat.pro.id}`, { name: 'Pro (2026)' });
    const pro = await call(t, admin, 'GET', `/api/admin/products/${cat.pro.id}`);
    expect(pro).toMatchObject({ name: 'Pro (2026)', trial_days: 14, is_public: false, highlights: ['SSO'], sort_order: 4, status: 'active' });
    const archived = await call(t, admin, 'PATCH', `/api/admin/products/${cat.pro.id}`, { status: 'archived' });
    expect(archived).toMatchObject({ status: 'archived', trial_days: 14, is_public: false });
  });

  it('archives a meter without resetting its weights or credit consumption', async () => {
    const meters = await call(t, admin, 'GET', '/api/admin/meters');
    const tokens = meters.data.find((m: any) => m.key === 'tokens');
    const updated = await call(t, admin, 'PATCH', `/api/admin/meters/${tokens.id}`, { archived: true });
    expect(updated).toMatchObject({ archived: true, unit: 'tokens', weights: { model: { large: 10 } }, credit_type: 'credits', credits_per_unit: 2 });
  });

  it('renames a feature without clearing its description', async () => {
    const features = await call(t, admin, 'GET', '/api/admin/features');
    const sso = features.data.find((f: any) => f.key === 'sso');
    await call(t, admin, 'PATCH', `/api/admin/features/${sso.id}`, { description: 'SAML and OIDC' });
    const renamed = await call(t, admin, 'PATCH', `/api/admin/features/${sso.id}`, { name: 'SSO' });
    expect(renamed).toMatchObject({ name: 'SSO', description: 'SAML and OIDC' });
  });
});
