import { describe, expect, it, vi } from 'vitest';
import { ago, compact, money, normalizeServerUrl, percentChange } from './format';
import { can, canAny } from './permissions';
import { AdminApi, ApiError } from './api';

describe('format', () => {
  it('formats money in minor units', () => {
    expect(money(123456, 'USD')).toMatch(/1,234\.56/);
    expect(money(500, 'JPY')).toMatch(/500/);
    expect(money(null)).toBe('—');
  });

  it('compacts and compares numbers', () => {
    expect(compact(950)).toBe('950');
    expect(compact(12_345)).toBe('12.3K');
    expect(compact(2_500_000)).toBe('2.5M');
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(5, 0)).toBeNull();
  });

  it('renders relative times', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    expect(ago('2026-11-03T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-11-03T11:45:00Z', now)).toBe('15 min ago');
    expect(ago('2026-11-01T12:00:00Z', now)).toBe('2 d ago');
  });

  it('normalizes server URLs', () => {
    expect(normalizeServerUrl('admin.example.com/')).toBe('https://admin.example.com');
    expect(normalizeServerUrl('http://10.0.2.2:4000')).toBe('http://10.0.2.2:4000');
    expect(normalizeServerUrl('  ')).toBeNull();
  });
});

describe('permissions', () => {
  it('checks expanded permission keys', () => {
    expect(can(['customers.users.view'], 'customers.users.view')).toBe(true);
    expect(can(['customers.users.view'], 'customers.users.ban')).toBe(false);
    expect(canAny(['a', 'b'], ['c', 'b'])).toBe(true);
    expect(can(undefined, 'x')).toBe(false);
  });
});

describe('AdminApi', () => {
  it('sends bearer tokens, maps errors and reports expired sessions', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/auth/me')) return new Response(JSON.stringify({ error: { code: 'session_invalid', message: 'expired' } }), { status: 401 });
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer stw_x');
      return new Response(JSON.stringify({ error: { code: 'reauth_required', message: 'Please confirm' } }), { status: 403 });
    });
    const api = new AdminApi('https://admin.example.com', 'stw_x', onUnauthorized, fetchImpl as unknown as typeof fetch);
    const err = await api.refund('pay_1', 100, 'test').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('reauth_required');
    await api.me().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://admin.example.com/api/admin/payments/pay_1/refunds');
  });

  it('logs in with the mobile client type', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'mfa_required', token: 'stw_t', expiresAt: '2026-12-01T00:00:00Z' }), { status: 200 }));
    const api = new AdminApi('https://admin.example.com', null, undefined, fetchImpl as unknown as typeof fetch);
    expect(await api.login('a@example.com', 'pw')).toMatchObject({ status: 'mfa_required', token: 'stw_t' });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ email: 'a@example.com', password: 'pw', client: 'mobile' });
  });
});
