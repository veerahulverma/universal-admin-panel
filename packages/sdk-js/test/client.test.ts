import { describe, expect, it, vi } from 'vitest';
import { StewardClient, StewardClientError, formatMoney } from '../src/index.js';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('StewardClient', () => {
  it('rejects secret keys in the browser', () => {
    expect(() => new StewardClient({ baseUrl: 'https://x.test', token: 'sk_live_abc' })).toThrow(/secret API key/);
  });

  it('sends the customer session and refreshes it once on expiry (deduplicating concurrent refreshes)', async () => {
    let valid = 'cs_new';
    const getToken = vi.fn(async () => valid);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth !== `Bearer ${valid}`) return json(401, { error: { code: 'session_invalid', message: 'expired' } });
      return json(200, { user: { id: 'usr_1', email: 'a@x.test' }, organization: null, url });
    });
    const client = new StewardClient({ baseUrl: 'https://steward.test/', token: 'cs_old', getToken, fetch: fetchImpl as unknown as typeof fetch });
    const [a, b] = await Promise.all([client.me(), client.me()]);
    expect(a.user.id).toBe('usr_1');
    expect(b.user.id).toBe('usr_1');
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://steward.test/api/client/me');
    expect((fetchImpl.mock.calls[0][1] as RequestInit).credentials).toBe('omit');
  });

  it('reports unrecoverable sessions and maps errors', async () => {
    const onUnauthorized = vi.fn();
    const client = new StewardClient({ baseUrl: 'https://steward.test', getToken: () => null, onUnauthorized, fetch: (async () => json(401, { error: { code: 'session_missing', message: 'no session' } })) as unknown as typeof fetch });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(StewardClientError);
    expect(err).toMatchObject({ status: 401, code: 'session_missing' });
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it('caches entitlements and answers hasFeature for flags and quotas', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        subject: { type: 'user', id: 'usr_1' },
        plans: [],
        features: {
          sso: { key: 'sso', type: 'boolean', enabled: true },
          api_calls: { key: 'api_calls', type: 'quota', enabled: true, limit: 10, remaining: 0 },
          seats: { key: 'seats', type: 'quota', enabled: true, unlimited: true, limit: null },
        },
      }),
    );
    const client = new StewardClient({ baseUrl: 'https://steward.test', token: 'cs_1', fetch: fetchImpl as unknown as typeof fetch });
    expect(await client.hasFeature('sso')).toBe(true);
    expect(await client.hasFeature('api_calls')).toBe(false);
    expect(await client.hasFeature('seats')).toBe(true);
    expect(await client.hasFeature('missing')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when optional modules are absent', async () => {
    const client = new StewardClient({
      baseUrl: 'https://steward.test',
      token: 'cs_1',
      fetch: (async (url: string) =>
        String(url).includes('notifications')
          ? json(404, { error: { code: 'not_found', message: 'Route GET /api/client/notifications not found' } })
          : json(403, { error: { code: 'module_disabled', message: 'The "email" module is disabled' } })) as unknown as typeof fetch,
    });
    expect(await client.notifications.list()).toEqual({ supported: false, data: [] });
    expect(await client.emailPreferences.get()).toEqual({ supported: false, data: null });
  });

  it('downloads invoice PDFs as blobs and object URLs', async () => {
    const client = new StewardClient({
      baseUrl: 'https://steward.test',
      token: 'cs_1',
      fetch: (async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch,
    });
    const blob = await client.invoices.pdf('inv_1');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    const url = await client.invoices.pdfUrl('inv_1');
    expect(url.startsWith('blob:')).toBe(true);
    URL.revokeObjectURL(url);
  });

  it('formats money with the right minor units', () => {
    expect(formatMoney(1999, 'USD', 'en-US')).toBe('$19.99');
    expect(formatMoney(500, 'JPY', 'en-US')).toBe('¥500');
  });
});

describe('optional platform features', () => {
  it('reads notifications and email preferences in the server shapes', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const client = new StewardClient({
      baseUrl: 'https://steward.test',
      token: 'cs_1',
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(url).includes('/api/client/notifications')) {
          return json(200, { data: [{ id: 'ntf_1', type: 'usage', title: 'Quota at 80%', body: null, link: null, severity: 'warning', readAt: null, createdAt: '2026-11-01T10:00:00.000Z' }], page: 1, pageSize: 25, total: 1, unread: 1 });
        }
        if (init?.method === 'PUT') return json(200, { ok: true, marketing: false });
        return json(200, { email: 'a@example.com', marketingConsent: true, categories: [{ category: 'transactional', subscribed: true, required: true }, { category: 'marketing', subscribed: true, required: false }] });
      }) as unknown as typeof fetch,
    });
    const notes = await client.notifications.list({ unread: true });
    expect(notes.supported).toBe(true);
    expect(notes.data[0].readAt).toBeNull();
    const prefs = await client.emailPreferences.get();
    expect(prefs.data?.categories.find((c) => c.category === 'marketing')?.subscribed).toBe(true);
    expect((await client.emailPreferences.setMarketing(false)).data).toEqual({ ok: true, marketing: false });
    expect(seen.at(-1)?.body).toEqual({ marketing: false });
    expect(seen[0].url).toContain('unread=true');
  });
});

describe('content', () => {
  it('lists content, requests a download link and surfaces refusal reasons', async () => {
    const seen: { url: string; method?: string }[] = [];
    const allowance = { limit: 10, period: 'day', used: 0, remaining: 10, resetsAt: null };
    const client = new StewardClient({
      baseUrl: 'https://steward.test',
      token: 'cs_1',
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method });
        if (String(url).endsWith('/link')) {
          return json(200, { url: 'https://steward.test/api/public/downloads/dlk_1.sig', expiresAt: '2026-11-04T10:15:00.000Z', file: { id: 'acf_1', title: 'Guide', filename: 'guide.pdf', size: 10 }, download: allowance });
        }
        if (String(url).endsWith('/api/client/content')) {
          return json(200, { data: [{ id: 'res_1', kind: 'file', title: 'Guide', description: '', path: null, fileCount: 1, state: 'available', allowed: true, reason: 'plan', availableAt: null, availableUntil: null }] });
        }
        return json(403, { error: { code: 'not_yet_available', message: 'This content is not available yet', details: { availableAt: '2026-12-01T00:00:00.000Z' } } });
      }) as unknown as typeof fetch,
    });
    expect(await client.content.list()).toMatchObject({ supported: true, data: [{ id: 'res_1', state: 'available' }] });
    const link = await client.content.downloadLink('res_1', 'acf_1');
    expect(link.download.remaining).toBe(10);
    expect(seen[1]).toEqual({ url: 'https://steward.test/api/client/content/res_1/files/acf_1/link', method: 'POST' });
    const err = await client.content.get('res_2').catch((e) => e);
    expect(err).toBeInstanceOf(StewardClientError);
    expect(err).toMatchObject({ status: 403, code: 'not_yet_available', details: { availableAt: '2026-12-01T00:00:00.000Z' } });
  });
});

describe('carts, vouchers and agreements', () => {
  it('calls the customer endpoints with the session and the expected bodies', async () => {
    const seen: { url: string; method?: string; body?: any }[] = [];
    const client = new StewardClient({
      baseUrl: 'https://steward.test',
      token: 'cs_1',
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const u = String(url);
        if (u.endsWith('/cart/checkout')) return json(200, { id: null, status: 'completed', url: null, invoiceId: 'inv_1', orderId: 'ord_1', amount: { total: 0, currency: 'USD' } });
        if (u.endsWith('/vouchers/redeem')) return json(200, { voucher: { id: 'vch_1', kind: 'credit' }, grant: null, balance: 2500 });
        if (u.endsWith('/api/client/agreements')) return json(200, { pending: [{ versionId: 'agv_2', key: 'terms', version: 2, title: 'Terms' }], accepted: [] });
        return json(200, { ok: true });
      }) as unknown as typeof fetch,
    });
    expect((await client.cartCheckout({ items: [{ priceId: 'pri_a' }] })).status).toBe('completed');
    expect(seen[0]).toMatchObject({ method: 'POST', body: { items: [{ priceId: 'pri_a' }] } });
    expect((await client.vouchers.redeem('GIFT-1')).balance).toBe(2500);
    expect(seen[1].body).toEqual({ code: 'GIFT-1' });
    expect((await client.agreements.get()).data?.pending[0].versionId).toBe('agv_2');
    await client.agreements.accept('agv_2');
    expect(seen[3]).toMatchObject({ url: 'https://steward.test/api/client/agreements/agv_2/accept', method: 'POST' });
  });
});

describe('push', () => {
  it('registers and removes an app install token for the signed-in customer', async () => {
    const seen: { url: string; body?: any }[] = [];
    const client = new StewardClient({
      baseUrl: 'https://steward.test',
      token: 'cs_1',
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json(200, String(url).endsWith('/remove') ? { removed: 1 } : { id: 'pdev_1' });
      }) as unknown as typeof fetch,
    });
    expect(await client.push.registerDevice({ provider: 'firebase', token: 'fcm-token-123', platform: 'ios' })).toEqual({ id: 'pdev_1' });
    expect(seen[0]).toEqual({ url: 'https://steward.test/api/client/push/devices', body: { provider: 'firebase', token: 'fcm-token-123', platform: 'ios' } });
    expect(await client.push.unregisterDevice('fcm-token-123')).toEqual({ removed: 1 });
    expect(seen[1]).toEqual({ url: 'https://steward.test/api/client/push/devices/remove', body: { token: 'fcm-token-123' } });
  });
});
