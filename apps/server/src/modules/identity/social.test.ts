import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { normalizeProfile } from './social.js';

/**
 * A stand-in OpenID Connect provider on localhost: discovery, a token endpoint
 * that checks the client credentials, redirect URI and PKCE verifier, and a
 * userinfo endpoint. `authorize` plays the customer approving the request.
 */
async function fakeProvider() {
  const codes = new Map<string, { challenge: string; redirectUri: string; profile: Record<string, unknown> }>();
  const tokens = new Map<string, Record<string, unknown>>();
  let base = '';
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo` });
    }
    if (url.pathname === '/userinfo') {
      const profile = tokens.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      return profile ? json(200, profile) : json(401, { error: 'invalid_token' });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const entry = codes.get(form.get('code') ?? '');
        const verifier = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!entry || form.get('client_id') !== 'fake-client' || form.get('client_secret') !== 'fake-client-secret' || form.get('redirect_uri') !== entry.redirectUri || verifier !== entry.challenge) {
          return json(400, { error: 'invalid_grant', error_description: 'Bad code, client or verifier' });
        }
        codes.delete(form.get('code')!);
        const token = `at_${randomUUID()}`;
        tokens.set(token, entry.profile);
        json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    authorize(authorizationUrl: string, profile: Record<string, unknown>) {
      const u = new URL(authorizationUrl);
      const code = `code_${randomUUID()}`;
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirectUri: u.searchParams.get('redirect_uri')!, profile });
      return { code, state: u.searchParams.get('state')! };
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive sockets from the token and userinfo calls would hold the test worker open.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const CALLBACK = 'https://app.example.com/auth/callback';

let t: TestPlatform;
let admin: AdminSession;
let key: string;
let provider: Awaited<ReturnType<typeof fakeProvider>>;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
  await call(t, admin, 'POST', '/api/admin/modules/identity/enable');
  await call(t, admin, 'PATCH', '/api/admin/settings/identity', { requireEmailVerification: false });
  key = await apiKey(t, admin, ['identity:write']);
  provider = await fakeProvider();
});
afterEach(async () => {
  await provider.close();
  await t.close();
});

async function addProvider(extra: Record<string, unknown> = {}) {
  return call(t, admin, 'POST', '/api/admin/identity/providers', {
    type: 'oidc',
    key: 'acme-sso',
    name: 'Acme SSO',
    clientId: 'fake-client',
    clientSecret: 'fake-client-secret',
    issuer: provider.base,
    redirectUrls: [CALLBACK],
    enabled: true,
    ...extra,
  });
}

async function signIn(profile: Record<string, unknown>) {
  const start = await t.request({ method: 'POST', url: '/api/v1/identity/social/acme-sso/start', bearer: key, body: { redirectUri: CALLBACK } });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const { code, state } = provider.authorize(start.body.authorizationUrl, profile);
  return t.request({ method: 'POST', url: '/api/v1/identity/social/acme-sso/callback', bearer: key, body: { code, state, ip: '198.51.100.61', userAgent: 'Firefox' } });
}

describe('social sign-in', () => {
  it('signs customers in through an OpenID Connect provider, creating the account once', async () => {
    const created = await addProvider();
    expect(created).toMatchObject({ key: 'acme-sso', type: 'oidc', hasSecret: true, secretLast4: 'cret', issuer: provider.base });
    const stored = await t.app.db.one(sql`SELECT ciphertext FROM secrets WHERE owner_type = 'identity_provider' AND owner_id = ${created.id}`);
    expect(stored.ciphertext).not.toContain('fake-client-secret');
    expect((await t.request({ url: '/api/v1/identity/social/providers', bearer: key })).body.data).toEqual([{ key: 'acme-sso', name: 'Acme SSO', type: 'oidc' }]);

    const elsewhere = await t.request({ method: 'POST', url: '/api/v1/identity/social/acme-sso/start', bearer: key, body: { redirectUri: 'https://evil.example/steal' } });
    expect(elsewhere.status).toBe(422);
    const start = await t.request({ method: 'POST', url: '/api/v1/identity/social/acme-sso/start', bearer: key, body: { redirectUri: CALLBACK } });
    const authUrl = new URL(start.body.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(`${provider.base}/authorize`);
    expect(Object.fromEntries(authUrl.searchParams)).toMatchObject({ client_id: 'fake-client', redirect_uri: CALLBACK, code_challenge_method: 'S256', scope: 'openid email profile', state: start.body.state });

    const { code, state } = provider.authorize(start.body.authorizationUrl, { sub: 'acme|1', email: 'New.Person@Example.com', email_verified: true, name: 'New Person' });
    const first = await t.request({ method: 'POST', url: '/api/v1/identity/social/acme-sso/callback', bearer: key, body: { code, state, ip: '198.51.100.61' } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ created: true, linkedBy: 'new_account', session: { token: expect.stringMatching(/^us_/) }, user: { email: 'new.person@example.com', name: 'New Person', emailVerified: true } });
    const replay = await t.request({ method: 'POST', url: '/api/v1/identity/social/acme-sso/callback', bearer: key, body: { code, state } });
    expect(replay.body.error.code).toBe('state_invalid');

    const again = await signIn({ sub: 'acme|1', email: 'new.person@example.com', email_verified: true, name: 'New Person' });
    expect(again.body).toMatchObject({ created: false, linkedBy: 'identity', user: { id: first.body.user.id } });
    expect((await t.app.db.many(sql`SELECT method FROM login_events WHERE subject_id = ${first.body.user.id} AND success`)).map((e) => e.method)).toEqual(['social:acme-sso', 'social:acme-sso']);
    expect((await t.app.db.one(sql`SELECT registration_source FROM users WHERE id = ${first.body.user.id}`)).registration_source).toBe('social:acme-sso');
    expect((await t.app.db.one(sql`SELECT sources FROM customer_ip_addresses WHERE user_id = ${first.body.user.id}`)).sources).toEqual(['social_login']);
  });

  it('links an existing account by email only when the provider verified the address', async () => {
    await addProvider();
    const reg = await t.request({ method: 'POST', url: '/api/v1/identity/register', bearer: key, body: { email: 'ada@example.com', password: 'correct horse battery' } });
    const unverified = await signIn({ sub: 'acme|2', email: 'ada@example.com', email_verified: false, name: 'Impostor' });
    expect(unverified.status).toBe(409);
    expect(unverified.body.error.code).toBe('email_unverified');
    expect(await t.app.db.many(sql`SELECT 1 FROM user_identities`)).toEqual([]);

    const verified = await signIn({ sub: 'acme|3', email: 'ada@example.com', email_verified: true, name: 'Ada' });
    expect(verified.body).toMatchObject({ created: false, linkedBy: 'email', user: { id: reg.body.user.id } });
    const identities = await call(t, admin, 'GET', `/api/admin/users/${reg.body.user.id}/identities`);
    expect(identities.data).toEqual([expect.objectContaining({ provider: 'acme-sso', email: 'ada@example.com', emailVerified: true })]);
    expect((await t.app.db.one(sql`SELECT data FROM events WHERE type = 'user.identity_linked'`)).data).toMatchObject({ userId: reg.body.user.id, linkedBy: 'email' });

    // Without sign-up allowed, a new person cannot create an account through the provider.
    await call(t, admin, 'PATCH', `/api/admin/identity/providers/${(await call(t, admin, 'GET', '/api/admin/identity/providers')).data[0].id}`, { allowSignup: false });
    expect((await signIn({ sub: 'acme|4', email: 'stranger@example.com', email_verified: true })).body.error.code).toBe('registration_closed');
  });

  it('protects provider configuration with permissions and re-authentication', async () => {
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/identity/providers', as: support })).status).toBe(403);
    const stale = await adminSession(t);
    await t.app.db.exec(sql`UPDATE admin_sessions SET reauth_at = NULL WHERE admin_id = ${stale.adminId}`);
    const noReauth = await t.request({ method: 'POST', url: '/api/admin/identity/providers', as: stale, body: { type: 'google', clientId: 'x', clientSecret: 'y', redirectUrls: [CALLBACK] } });
    expect(noReauth.body.error.code).toBe('reauth_required');
    const noIssuer = await t.request({ method: 'POST', url: '/api/admin/identity/providers', as: admin, body: { type: 'oidc', key: 'corp', clientId: 'x', clientSecret: 'y', redirectUrls: [CALLBACK] } });
    expect(noIssuer.status).toBe(422);

    const disabled = await addProvider({ enabled: false });
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/social/acme-sso/start', bearer: key, body: { redirectUri: CALLBACK } })).status).toBe(404);
    const check = await call(t, admin, 'POST', `/api/admin/identity/providers/${disabled.id}/check`);
    expect(check).toMatchObject({ ok: true, hasSecret: true, endpoints: { token: `${provider.base}/token` } });
    const google = await call(t, admin, 'POST', '/api/admin/identity/providers', { type: 'google', clientId: 'google-client', clientSecret: 'google-secret', redirectUrls: [CALLBACK] });
    expect(google).toMatchObject({ key: 'google', name: 'Google', enabled: false });
    expect((await t.request({ method: 'DELETE', url: `/api/admin/identity/providers/${google.id}`, as: admin })).status).toBe(204);
    expect(await t.app.db.many(sql`SELECT 1 FROM secrets WHERE owner_id = ${google.id}`)).toEqual([]);
  });

  it('maps GitHub and Microsoft profiles without trusting unverified addresses', () => {
    const github = normalizeProfile('github', { id: 42, login: 'octo', name: null, email: 'public@example.com' }, [
      { email: 'old@example.com', primary: false, verified: false },
      { email: 'Octo@Example.com', primary: true, verified: true },
    ], {});
    expect(github).toMatchObject({ subject: '42', email: 'octo@example.com', emailVerified: true, name: 'octo' });
    expect(normalizeProfile('github', { id: 7, login: 'x', email: 'x@example.com' }, [{ email: 'x@example.com', primary: true, verified: false }], {}).emailVerified).toBe(false);
    expect(normalizeProfile('microsoft', { sub: 'ms1', email: 'a@contoso.com' }, null, {}).emailVerified).toBe(false);
    expect(normalizeProfile('microsoft', { sub: 'ms1', email: 'a@contoso.com' }, null, { trustEmail: true }).emailVerified).toBe(true);
    expect(normalizeProfile('google', { sub: 'g1', email: 'g@example.com', email_verified: true, given_name: 'Grace', family_name: 'Hopper' }, null, {})).toMatchObject({ emailVerified: true, name: 'Grace Hopper' });
  });
});
