import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../test/harness.js';
import { call } from '../test/fixtures.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

// zod applies `.default()` values even through `.partial()`; the router must not let a
// PATCH that changes one field reset the others to their defaults.
describe('PATCH partial updates', () => {
  it('keeps fields the request did not send', async () => {
    const key = await call(t, admin, 'POST', '/api/admin/api-keys', { name: 'backend', scopes: ['users:read'], allowedIps: ['203.0.113.0/24'] });
    await call(t, admin, 'PATCH', `/api/admin/api-keys/${key.id}`, { name: 'backend (renamed)' });
    const keys = await call(t, admin, 'GET', '/api/admin/api-keys');
    const updated = keys.data.find((k: any) => k.id === key.id);
    expect(updated.name).toBe('backend (renamed)');
    expect(updated.allowed_ips ?? updated.allowedIps).toEqual(['203.0.113.0/24']);

    const hook = await call(t, admin, 'POST', '/api/admin/webhooks', { url: 'https://hooks.example.com/steward', events: ['user.created'] });
    const hookId = hook.id;
    await call(t, admin, 'PATCH', `/api/admin/webhooks/${hookId}`, { description: 'CRM sync' });
    const detail = await call(t, admin, 'GET', `/api/admin/webhooks/${hookId}`);
    expect((detail.endpoint ?? detail).events).toEqual(['user.created']);

    const rate = await call(t, admin, 'POST', '/api/admin/tax-rates', { name: 'VAT DE', country: 'DE', ratePercent: 19, taxType: 'vat', reverseChargeB2b: true });
    await call(t, admin, 'PATCH', `/api/admin/tax-rates/${rate.id}`, { name: 'Umsatzsteuer' });
    const rates = await call(t, admin, 'GET', '/api/admin/tax-rates');
    const r = (rates.data ?? rates).find((x: any) => x.id === rate.id);
    expect(r.name).toBe('Umsatzsteuer');
    expect(r.reverse_charge_b2b ?? r.reverseChargeB2b).toBe(true);
  });

  it('still validates and applies the fields that were sent', async () => {
    const key = await call(t, admin, 'POST', '/api/admin/api-keys', { name: 'ci', scopes: ['users:read'], allowedIps: ['203.0.113.7'] });
    await call(t, admin, 'PATCH', `/api/admin/api-keys/${key.id}`, { allowedIps: [] });
    const keys = await call(t, admin, 'GET', '/api/admin/api-keys');
    const updated = keys.data.find((k: any) => k.id === key.id);
    expect(updated.allowed_ips ?? updated.allowedIps).toEqual([]);
    const bad = await t.request({ method: 'PATCH', url: `/api/admin/api-keys/${key.id}`, as: admin, body: { rateLimitPerMinute: -5 } });
    expect(bad.status).toBe(422);
  });
});
