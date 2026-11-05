import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { sha256 } from '../../core/crypto.js';
import { HOUR } from '../../core/clock.js';

let t: TestPlatform;
let admin: AdminSession;
let key: string;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
  await call(t, admin, 'POST', '/api/admin/modules/identity/enable');
  await call(t, admin, 'PATCH', '/api/admin/settings/identity', { requireEmailVerification: false });
  key = await apiKey(t, admin, ['identity:write', 'users:read']);
});
afterEach(async () => {
  await t.close();
});

const register = (body: Record<string, unknown>) => t.request({ method: 'POST', url: '/api/v1/identity/register', bearer: key, body: { password: 'correct horse battery', ...body } });
const login = (email: string, ip?: string) => t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email, password: 'correct horse battery', ip, userAgent: 'Firefox' } });

describe('registration with signup forms', () => {
  it('validates the form fields, the agreement and the plan, and records the acceptance', async () => {
    await call(t, admin, 'POST', '/api/admin/custom-fields', { entity: 'user', key: 'job_role', label: 'Role', type: 'select', options: ['developer', 'designer'] });
    const terms = await call(t, admin, 'POST', '/api/admin/agreements', { key: 'terms', title: 'Terms of Service', body: 'The rules.' });
    await call(t, admin, 'POST', '/api/admin/signup-forms', {
      key: 'beta',
      name: 'Beta programme',
      fields: [
        { type: 'profile', key: 'name', required: true },
        { type: 'custom', key: 'job_role', required: true },
        { type: 'profile', key: 'country' },
      ],
      agreementId: terms.id,
      redirectUrl: 'https://app.example.com/onboarding',
      tags: ['beta'],
    });
    const form = (await t.request({ url: '/api/public/signup-forms/beta' })).body;

    expect((await register({ email: 'a@example.com', fields: { name: 'A' } })).body.error.details[0].path).toEqual(['formKey']);
    const invalid = await register({ email: 'a@example.com', formKey: 'beta', fields: { name: '', job_role: 'astronaut', country: 'Germany', shoe_size: 44 } });
    expect(invalid.status).toBe(422);
    const issues = Object.fromEntries(invalid.body.error.details.map((d: any) => [d.path.join('.'), d.message]));
    expect(Object.keys(issues).sort()).toEqual(['agreementVersionId', 'fields.country', 'fields.job_role', 'fields.name', 'fields.shoe_size']);
    expect(issues['fields.shoe_size']).toMatch(/not part of the form/);

    const ok = await register({ email: 'a@example.com', formKey: 'beta', fields: { name: 'Ada', job_role: 'developer', country: 'gb' }, agreementVersionId: form.agreement.versionId, ip: '198.51.100.30', userAgent: 'Firefox' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ redirectUrl: 'https://app.example.com/onboarding', session: { token: expect.stringMatching(/^us_/) } });
    expect(ok.body.user).toMatchObject({ name: 'Ada', country: 'GB', tags: ['beta'], customFields: { job_role: 'developer' }, metadata: { signupForm: 'beta' } });
    expect(await t.app.db.one(sql`SELECT source, ip, user_agent FROM agreement_acceptances WHERE user_id = ${ok.body.user.id}`)).toEqual({ source: 'signup', ip: '198.51.100.30', user_agent: 'Firefox' });
    expect((await t.app.db.one(sql`SELECT registration_source FROM users WHERE id = ${ok.body.user.id}`)).registration_source).toBe('signup_form:beta');
    expect((await t.app.db.one(sql`SELECT sources FROM customer_ip_addresses WHERE user_id = ${ok.body.user.id}`)).sources).toEqual(['identity_register']);
  });
});

describe('account sharing on built-in sign-in', () => {
  it('pauses sign-ins when an account is used from too many addresses, until an administrator clears it', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/accountSharing', { maxAddresses: 2, action: 'block_logins', cooldownMinutes: 60 });
    const reg = await register({ email: 'sharer@example.com' });
    const userId = reg.body.user.id;
    expect((await login('sharer@example.com', '198.51.100.1')).status).toBe(200);
    const second = await login('sharer@example.com', '198.51.100.2');
    expect(second.status).toBe(200);

    // A session used from a third address trips the policy and is signed out.
    const verify = await t.request({ method: 'POST', url: '/api/v1/identity/sessions/verify', bearer: key, body: { token: second.body.session.token, ip: '203.0.113.3' } });
    expect(verify.body).toEqual({ valid: false, reason: 'session_invalid' });
    const refused = await login('sharer@example.com', '203.0.113.4');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('account_sharing_cooldown');
    expect(refused.body.error.message).toMatch(/paused for 60 more minutes/);
    expect(await t.app.db.many(sql`SELECT failure_reason FROM login_events WHERE subject_id = ${userId} AND NOT success`)).toEqual([{ failure_reason: 'sharing_cooldown' }]);
    // A wrong password is still just a wrong password: the block is never revealed to guessers.
    const guess = await t.request({ method: 'POST', url: '/api/v1/identity/login', bearer: key, body: { email: 'sharer@example.com', password: 'wrong password!!' } });
    expect(guess.body.error.code).toBe('invalid_credentials');

    const flag = (await call(t, admin, 'GET', '/api/admin/security/account-sharing')).data[0];
    expect(flag).toMatchObject({ userId, action: 'block_logins' });
    await call(t, admin, 'POST', `/api/admin/security/account-sharing/${flag.id}/clear`, { note: 'Travelling' });
    expect((await login('sharer@example.com', '203.0.113.4')).status).toBe(200);
    const sources = await t.app.db.many(sql`SELECT ip, sources FROM customer_ip_addresses WHERE user_id = ${userId} ORDER BY ip`);
    expect(sources).toEqual([
      { ip: '198.51.100.1', sources: ['identity_login'] },
      { ip: '198.51.100.2', sources: ['identity_login'] },
      { ip: '203.0.113.3', sources: ['session_verify'] },
      { ip: '203.0.113.4', sources: ['identity_login'] },
    ]);
  });

  it('expires the pause after the cooling-off period', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/accountSharing', { maxAddresses: 2, action: 'block_logins', cooldownMinutes: 60 });
    await register({ email: 'wait@example.com' });
    for (const ip of ['198.51.100.1', '198.51.100.2']) await login('wait@example.com', ip);
    expect((await login('wait@example.com', '198.51.100.3')).status).toBe(403);
    t.clock.advance(2 * HOUR);
    expect((await login('wait@example.com', '198.51.100.3')).status).toBe(200);
  });
});

describe('archived customers and merges', () => {
  it('restores an archived customer when they sign in', async () => {
    const reg = await register({ email: 'back@example.com' });
    await call(t, admin, 'POST', `/api/admin/users/${reg.body.user.id}/archive`, {});
    const signedIn = await login('back@example.com');
    expect(signedIn.body.user.archivedAt).toBeNull();
    const audit = await t.app.db.one(sql`SELECT actor_type, metadata FROM audit_logs WHERE action = 'user.unarchive' AND target_id = ${reg.body.user.id}`);
    expect(audit).toEqual({ actor_type: 'user', metadata: { reason: 'signed_in' } });
  });

  it('retires one-time links sent to the duplicate account when it is merged', async () => {
    const target = (await register({ email: 'keep@example.com' })).body.user;
    const source = (await register({ email: 'old@example.com' })).body.user;
    await t.app.db.exec(sql`INSERT INTO user_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES ('utk_old', ${source.id}, 'verify_email', ${sha256('old-address-link')}, ${new Date(t.clock.now().getTime() + HOUR)}, ${t.clock.now()})`);
    await call(t, admin, 'POST', `/api/admin/users/${target.id}/merge`, { sourceId: source.id, confirm: 'MERGE' });
    const used = await t.request({ method: 'POST', url: '/api/v1/identity/verify-email', bearer: key, body: { token: 'old-address-link' } });
    expect(used.body.error.code).toBe('token_invalid');
    // The password set on the duplicate does not replace the kept account's own.
    expect((await login('keep@example.com')).status).toBe(200);
    expect((await login('old@example.com')).status).toBe(401);
  });
});
