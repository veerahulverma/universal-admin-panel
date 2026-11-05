import { expect } from 'vitest';
import type { AdminSession, TestPlatform } from './harness.js';

export async function call(t: TestPlatform, as: AdminSession, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown) {
  const res = await t.request({ method, url, as, body });
  expect(res.status, `${method} ${url} -> ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

export interface CatalogFixture {
  free: { id: string };
  pro: { id: string };
  extra: { id: string };
  team: { id: string };
  proMonthly: { id: string };
  proYearly: { id: string };
  teamSeat: { id: string };
  extraPrice: { id: string };
}

/**
 * A small but realistic catalog:
 *   meters: api_calls (counter), projects (gauge), tokens (credits-consuming counter)
 *   features: api_calls quota, projects quota, sso flag, support_tier config
 *   plans: free (10 calls/mo, 1 project), pro ($20/mo or $200/yr, 1000 calls, 10 projects, SSO), team (per seat)
 *   add-on: extra_calls (+500 calls)
 */
export async function seedCatalog(t: TestPlatform, as: AdminSession): Promise<CatalogFixture> {
  await call(t, as, 'POST', '/api/admin/meters', { key: 'api_calls', name: 'API calls', unit: 'calls' });
  await call(t, as, 'POST', '/api/admin/meters', { key: 'projects', name: 'Projects', kind: 'gauge' });
  await call(t, as, 'POST', '/api/admin/meters', { key: 'tokens', name: 'AI tokens', unit: 'tokens', weights: { model: { large: 10 } }, creditType: 'credits', creditsPerUnit: 2 });
  await call(t, as, 'POST', '/api/admin/features', { key: 'api_calls', name: 'API calls', type: 'quota', meterKey: 'api_calls' });
  await call(t, as, 'POST', '/api/admin/features', { key: 'projects', name: 'Projects', type: 'quota', meterKey: 'projects' });
  await call(t, as, 'POST', '/api/admin/features', { key: 'sso', name: 'Single sign-on', type: 'boolean' });
  await call(t, as, 'POST', '/api/admin/features', { key: 'support_tier', name: 'Support tier', type: 'config' });

  const free = await call(t, as, 'POST', '/api/admin/products', { key: 'free', name: 'Free', kind: 'plan', planType: 'free' });
  await call(t, as, 'PUT', `/api/admin/products/${free.id}/features`, {
    features: [
      { featureKey: 'api_calls', limit: 10, resetPeriod: 'month', enforcement: 'hard' },
      { featureKey: 'projects', limit: 1, resetPeriod: 'none' },
      { featureKey: 'support_tier', config: 'community' },
    ],
  });
  const pro = await call(t, as, 'POST', '/api/admin/products', { key: 'pro', name: 'Pro', kind: 'plan', planType: 'paid', trialDays: 14 });
  await call(t, as, 'PUT', `/api/admin/products/${pro.id}/features`, {
    features: [
      { featureKey: 'api_calls', limit: 1000, resetPeriod: 'billing_period', enforcement: 'overage', overageUnitAmount: 2 },
      { featureKey: 'projects', limit: 10, resetPeriod: 'none' },
      { featureKey: 'sso' },
      { featureKey: 'support_tier', config: 'priority' },
    ],
  });
  const proMonthly = await call(t, as, 'POST', `/api/admin/products/${pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', unitAmount: 2000 });
  const proYearly = await call(t, as, 'POST', `/api/admin/products/${pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'year', unitAmount: 20000 });

  const team = await call(t, as, 'POST', '/api/admin/products', { key: 'team', name: 'Team', kind: 'plan', planType: 'paid', subscriberType: 'organization' });
  await call(t, as, 'PUT', `/api/admin/products/${team.id}/features`, {
    features: [
      { featureKey: 'api_calls', limit: 500, perSeat: true, resetPeriod: 'billing_period' },
      { featureKey: 'sso' },
    ],
  });
  const teamSeat = await call(t, as, 'POST', `/api/admin/products/${team.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', pricingModel: 'per_seat', unitAmount: 1000 });

  const extra = await call(t, as, 'POST', '/api/admin/products', { key: 'extra_calls', name: 'Extra calls', kind: 'addon' });
  await call(t, as, 'PUT', `/api/admin/products/${extra.id}/features`, { features: [{ featureKey: 'api_calls', limit: 500 }] });
  const extraPrice = await call(t, as, 'POST', `/api/admin/products/${extra.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', unitAmount: 500 });
  return { free, pro, extra, team, proMonthly, proYearly, teamSeat, extraPrice };
}

export async function apiKey(t: TestPlatform, as: AdminSession, scopes: string[] = ['*'], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call(t, as, 'POST', '/api/admin/api-keys', { name: 'test', scopes, ...extra });
  return res.secret;
}

export async function apiUser(t: TestPlatform, key: string, email: string): Promise<{ id: string }> {
  const res = await t.request({ method: 'POST', url: '/api/v1/users', bearer: key, body: { email } });
  expect(res.status).toBeLessThan(300);
  return res.body.user;
}
