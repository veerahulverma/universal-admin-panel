import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call } from '../../test/fixtures.js';
import { allModules } from '../index.js';
import { themesModule } from './module.js';
import { identityModule } from '../identity/module.js';
import { sanitizeCss, PRESETS } from './tokens.js';
import { issuePasswordReset } from '../identity/module.js';
import { sql } from '../../core/sql.js';
import { sha256 } from '../../core/crypto.js';
import { MINUTE } from '../../core/clock.js';

let t: TestPlatform;
let admin: AdminSession;

beforeEach(async () => {
  const extra = [themesModule, identityModule].filter((m) => !allModules.some((x) => x.id === m.id));
  t = await createTestPlatform({ modules: [...allModules, ...extra] });
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

describe('themes', () => {
  it('seeds presets and serves the active theme to the admin shell and public pages', async () => {
    const list = await call(t, admin, 'GET', '/api/admin/themes');
    expect(list.data.filter((x: any) => x.source === 'preset')).toHaveLength(PRESETS.length);
    expect(list.data.find((x: any) => x.is_active).key).toBe('preset-default');
    const boot = await call(t, admin, 'GET', '/api/admin/bootstrap');
    expect(boot.theme.css).toContain('--color-primary: #4f46e5');
    const css = await t.server.inject({ method: 'GET', url: '/api/public/theme.css' });
    expect(css.headers['content-type']).toContain('text/css');
    const cached = await t.server.inject({ method: 'GET', url: '/api/public/theme.css', headers: { 'if-none-match': css.headers.etag as string } });
    expect(cached.statusCode).toBe(304);
  });

  it('edits drafts, publishes, activates and rolls back', async () => {
    const theme = await call(t, admin, 'POST', '/api/admin/themes', { name: 'Acme', basedOn: 'preset-ocean' });
    const detail = await call(t, admin, 'GET', `/api/admin/themes/${theme.id}`);
    const tokens = { ...detail.draft.tokens, colors: { ...detail.draft.tokens.colors, primary: '#ff0055' }, branding: { ...detail.draft.tokens.branding, appName: 'Acme Console' } };
    const bad = await t.request({ method: 'PUT', url: `/api/admin/themes/${theme.id}/draft`, as: admin, body: { tokens: { ...tokens, colors: { ...tokens.colors, primary: 'red; } body { display:none' } } } });
    expect(bad.status).toBe(422);
    const saved = await call(t, admin, 'PUT', `/api/admin/themes/${theme.id}/draft`, { tokens, customCss: '.x{color:red}' });
    expect(saved.css).toContain('--color-primary: #ff0055');
    expect((await t.request({ method: 'POST', url: `/api/admin/themes/${theme.id}/activate`, as: admin, body: {} })).status).toBe(409);
    await call(t, admin, 'POST', `/api/admin/themes/${theme.id}/publish`, {});
    await call(t, admin, 'POST', `/api/admin/themes/${theme.id}/activate`, {});
    expect((await t.server.inject({ method: 'GET', url: '/api/public/theme.css' })).body).toContain('#ff0055');
    expect((await t.server.inject({ method: 'GET', url: '/api/public/branding' })).json().appName).toBe('Acme Console');

    const v1 = (await call(t, admin, 'GET', `/api/admin/themes/${theme.id}`)).published.id;
    await call(t, admin, 'PUT', `/api/admin/themes/${theme.id}/draft`, { tokens: { ...tokens, colors: { ...tokens.colors, primary: '#00aa00' } } });
    await call(t, admin, 'POST', `/api/admin/themes/${theme.id}/publish`, {});
    expect((await t.server.inject({ method: 'GET', url: '/api/public/theme.css' })).body).toContain('#00aa00');
    await call(t, admin, 'POST', `/api/admin/themes/${theme.id}/publish`, { revisionId: v1 });
    expect((await t.server.inject({ method: 'GET', url: '/api/public/theme.css' })).body).toContain('#ff0055');
  });

  it('gives an organization its own branding and resolves custom domains', async () => {
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Tenant', customDomain: 'admin.tenant.io' });
    const theme = await call(t, admin, 'POST', '/api/admin/themes', { name: 'Tenant theme', basedOn: 'preset-rose' });
    await call(t, admin, 'POST', `/api/admin/themes/${theme.id}/publish`, {});
    await call(t, admin, 'POST', `/api/admin/themes/${theme.id}/activate`, { scope: `org:${org.id}` });
    expect((await t.server.inject({ method: 'GET', url: `/api/public/theme.css?org=${org.slug}` })).body).toContain('#e11d48');
    expect((await t.server.inject({ method: 'GET', url: '/api/public/theme.css?domain=admin.tenant.io' })).body).toContain('#e11d48');
    expect((await t.server.inject({ method: 'GET', url: '/api/public/theme.css' })).body).toContain('#4f46e5');
  });

  it('strips dangerous custom CSS', () => {
    const css = sanitizeCss(`@import url(https://evil.example/x.css); .a { background: url(javascript:alert(1)) } .b { width: expression(alert(1)) } </style><script>x</script> .c { background: url(https://cdn.example.com/bg.png) }`);
    expect(css).not.toMatch(/@import|javascript:|expression\(|<\/style/i);
    expect(css).toContain('url(https://cdn.example.com/bg.png)');
  });

  it('exports and imports theme packages', async () => {
    const exported = await t.request({ url: '/api/admin/themes/preset-sunset/export', as: admin });
    expect(exported.body.format).toBe('steward-theme');
    const imported = await call(t, admin, 'POST', '/api/admin/themes/import', { ...exported.body, name: 'Sunset copy' });
    expect(imported.source).toBe('upload');
    expect(imported.published_revision_id).toBeTruthy();
  });
});

describe('built-in identity', () => {
  let key: string;
  beforeEach(async () => {
    await t.request({ method: 'POST', url: '/api/admin/modules/identity/enable', as: admin });
    key = await apiKey(t, admin, ['identity:write', 'users:read']);
  });

  it('is disabled by default and enabled per installation', async () => {
    const fresh = await createTestPlatform({ modules: [...allModules, ...[themesModule, identityModule].filter((m) => !allModules.some((x) => x.id === m.id))] });
    try {
      const a = await adminSession(fresh);
      // Scopes of disabled modules cannot even be granted, so use a wildcard key.
      const k = await apiKey(fresh, a, ['*']);
      const res = await fresh.request({ method: 'POST', url: '/api/v1/identity/login', bearer: k, body: { email: 'x@example.com', password: 'whatever-123' } });
      expect(res.body.error.code).toBe('module_disabled');
    } finally {
      await fresh.close();
    }
  });

  it('registers, requires verification, signs in and validates sessions', async () => {
    const reg = await t.request({ method: 'POST', url: '/api/v1/identity/register', bearer: key, body: { email: 'new@example.com', password: 'correct horse battery', name: 'New' } });
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ verificationRequired: true, session: null });
    const unverified = await t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email: 'new@example.com', password: 'correct horse battery' } });
    expect(unverified.body.error.code).toBe('email_unverified');
    await t.app.db.exec(sql`INSERT INTO user_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES ('utk_t', ${reg.body.user.id}, 'verify_email', ${sha256('verify-token-123')}, ${new Date(Date.now() + 3600_000)}, now())`);
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/verify-email', bearer: key, body: { token: 'verify-token-123' } })).body.verified).toBe(true);
    const login = await t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email: 'new@example.com', password: 'correct horse battery', ip: '198.51.100.20', userAgent: 'Firefox' } });
    expect(login.body.session.token).toMatch(/^us_/);
    const verify = await t.request({ method: 'POST', url: '/api/v1/identity/sessions/verify', bearer: key, body: { token: login.body.session.token } });
    expect(verify.body).toMatchObject({ valid: true, user: { email: 'new@example.com' } });
    // Banning the user from the admin panel invalidates their sessions immediately.
    await t.request({ method: 'POST', url: `/api/admin/users/${reg.body.user.id}/status`, as: admin, body: { action: 'ban', reason: 'abuse' } });
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/sessions/verify', bearer: key, body: { token: login.body.session.token } })).body.valid).toBe(false);
  });

  it('locks accounts after repeated failures', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/identity', { requireEmailVerification: false });
    await t.request({ method: 'POST', url: '/api/v1/identity/register', bearer: key, body: { email: 'lock@example.com', password: 'correct horse battery' } });
    for (let i = 0; i < 10; i++) await t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email: 'lock@example.com', password: 'wrong password!' } });
    const locked = await t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email: 'lock@example.com', password: 'correct horse battery' } });
    expect(locked.body.error.code).toBe('account_locked');
    t.clock.advance(16 * MINUTE);
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email: 'lock@example.com', password: 'correct horse battery' } })).status).toBe(200);
  });

  it('resets passwords with single-use tokens and signs the user out everywhere', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/identity', { requireEmailVerification: false });
    const reg = await t.request({ method: 'POST', url: '/api/v1/identity/register', bearer: key, body: { email: 'reset@example.com', password: 'correct horse battery' } });
    const session = reg.body.session.token;
    const token = await t.app.db.tx((tx) => issuePasswordReset(tx, t.app, reg.body.user.id));
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/password-reset/confirm', bearer: key, body: { token, password: 'brand new passphrase' } })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/password-reset/confirm', bearer: key, body: { token, password: 'another passphrase' } })).body.error.code).toBe('token_invalid');
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/sessions/verify', bearer: key, body: { token: session } })).body.valid).toBe(false);
    expect((await t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email: 'reset@example.com', password: 'brand new passphrase' } })).status).toBe(200);
  });

  it('enforces email domain rules', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/identity', { blockedEmailDomains: ['mailinator.com'] });
    const res = await t.request({ method: 'POST', url: '/api/v1/identity/register', bearer: key, body: { email: 'x@mailinator.com', password: 'correct horse battery' } });
    expect(res.status).toBe(422);
  });
});

describe('theme brand assets', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5950000000049454e44ae426082', 'hex');

  function multipart(filename: string, contentType: string, data: Buffer) {
    const boundary = '----steward-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return {
      method: 'POST' as const,
      url: '/api/admin/themes/assets',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': admin.csrf },
      cookies: { stw_admin: admin.token },
    };
  }

  it('stores sniffed images and serves them publicly without letting them run script', async () => {
    const res = await t.server.inject(multipart('logo.png', 'image/png', PNG));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toMatch(/^\/api\/public\/theme-assets\/file_/);
    expect(body.contentType).toBe('image/png');

    const served = await t.server.inject({ method: 'GET', url: body.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['content-security-policy']).toContain('sandbox');
    expect(served.rawPayload.equals(PNG)).toBe(true);

    // The returned URL is accepted as a theme asset.
    const theme = await call(t, admin, 'POST', '/api/admin/themes', { name: 'Branded', basedOn: 'preset-default' });
    const detail = await call(t, admin, 'GET', `/api/admin/themes/${theme.id}`);
    await call(t, admin, 'PUT', `/api/admin/themes/${theme.id}/draft`, { tokens: detail.revisions[0].tokens, assets: { logoUrl: body.url } });
  });

  it('rejects files that are not images, whatever their declared type', async () => {
    const html = await t.server.inject(multipart('logo.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>')));
    expect(html.statusCode).toBe(422);
    const svg = await t.server.inject(multipart('logo.svg', 'image/svg+xml', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')));
    expect(JSON.parse(svg.body).contentType).toBe('image/svg+xml');
    const anonymous = await t.server.inject({ ...multipart('logo.png', 'image/png', PNG), cookies: {} });
    expect(anonymous.statusCode).toBe(401);
  });
});
