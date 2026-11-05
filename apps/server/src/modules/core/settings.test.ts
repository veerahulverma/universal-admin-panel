import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call } from '../../test/fixtures.js';

let t: TestPlatform;
let admin: AdminSession;

beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

const section = (list: { data: any[] }, key: string) => list.data.find((s) => s.key === key);

describe('settings API', () => {
  it('returns the stored values from PATCH and resets a section to its defaults', async () => {
    const saved = await call(t, admin, 'PATCH', '/api/admin/settings/general', { appName: 'Acme' });
    expect(saved.value.appName).toBe('Acme');

    const general = section(await call(t, admin, 'GET', '/api/admin/settings'), 'general');
    expect(general.value.appName).toBe('Acme');
    expect(general.override).toEqual({ appName: 'Acme' });
    expect(general.permission).toBe('system.settings.manage');

    const reset = await call(t, admin, 'DELETE', '/api/admin/settings/general');
    expect(reset.value.appName).toBe('Steward');
    expect(t.app.settings.get('general').appName).toBe('Steward');
    expect(section(await call(t, admin, 'GET', '/api/admin/settings'), 'general').override).toBeNull();
  });

  it('reads, writes and removes organization overrides of tenant-overridable sections', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/general', { appName: 'Platform' });
    await call(t, admin, 'PATCH', '/api/admin/settings/general?scope=org:org_acme', { appName: 'Acme portal' });

    const scoped = await call(t, admin, 'GET', '/api/admin/settings?scope=org:org_acme');
    expect(scoped.scope).toBe('org:org_acme');
    expect(section(scoped, 'general').value.appName).toBe('Acme portal');
    expect(section(scoped, 'general').override).toEqual({ appName: 'Acme portal' });
    expect(section(await call(t, admin, 'GET', '/api/admin/settings'), 'general').value.appName).toBe('Platform');

    const removed = await call(t, admin, 'DELETE', '/api/admin/settings/general?scope=org:org_acme');
    expect(removed.value.appName).toBe('Platform');
    expect(t.app.settings.get('general', 'org:org_acme').appName).toBe('Platform');

    const notOverridable = await t.request({ method: 'PATCH', url: '/api/admin/settings/retention?scope=org:org_acme', as: admin, body: { auditLogDays: 90 } });
    expect(notOverridable.status).toBe(422);
  });

  it('keeps organization-scoped administrators to their own organizations', async () => {
    const scopedAdmin = await adminSession(t, ['super_admin'], ['org_acme']);
    const global = await t.request({ method: 'PATCH', url: '/api/admin/settings/general', as: scopedAdmin, body: { appName: 'Hijack' } });
    expect(global.status).toBe(403);
    expect((await t.request({ method: 'DELETE', url: '/api/admin/settings/general', as: scopedAdmin })).status).toBe(403);
    expect((await t.request({ method: 'GET', url: '/api/admin/settings', query: { scope: 'org:org_other' }, as: scopedAdmin })).status).toBe(403);

    const own = await t.request({ method: 'PATCH', url: '/api/admin/settings/general?scope=org:org_acme', as: scopedAdmin, body: { appName: 'Acme' } });
    expect(own.status).toBe(200);
    expect(t.app.settings.get('general').appName).toBe('Steward');
  });
});
