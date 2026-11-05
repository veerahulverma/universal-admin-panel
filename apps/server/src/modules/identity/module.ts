import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, unauthorized, validationError } from '../../core/errors.js';
import { checkPasswordPolicy, hashPassword, passwordNeedsRehash, randomToken, sha256, verifyPassword } from '../../core/crypto.js';
import { DAY, HOUR, MINUTE } from '../../core/clock.js';
import { writeAudit } from '../../core/audit.js';
import { assertIpAllowed, cooldownMessage, recordCustomerIp, recordLogin, sharingBlock, type CustomerIpSource, type SecuritySettings } from '../security/module.js';
import { createUser, getUser, revokeUserSessions, userInputSchema } from '../customers/service.js';
import { presentUser } from '../customers/routes-api.js';
import { applySignupForm, withFormInput } from '../customers/signup-forms.js';
import { recordAcceptance } from '../customers/agreements.js';
import { restoreIfArchived } from '../customers/archive.js';
import { onBeforeMerge } from '../customers/merge.js';
import { completeSocialSignIn, loadProvider, registerSocialAdminRoutes, startSocialSignIn } from './social.js';
import { sendSystemEmail } from '../core/mail.js';
import { registerApiScopes } from '../developers/keys.js';

const identitySettings = z.object({
  allowRegistration: z.boolean(),
  requireEmailVerification: z.boolean(),
  sessionDays: z.number().int().min(1).max(365),
  passwordMinLength: z.number().int().min(8).max(128),
  /** Your app's page that accepts ?token= for password resets. */
  resetUrl: z.string().max(500),
  verifyUrl: z.string().max(500),
  allowedEmailDomains: z.array(z.string().max(253)).max(100),
  blockedEmailDomains: z.array(z.string().max(253)).max(1000),
});
type IdentitySettings = z.infer<typeof identitySettings>;

const settingsOf = (app: App) => app.settings.get<IdentitySettings>('identity');

function link(base: string, token: string, fallback: string): string {
  if (!base) return `${fallback}?token=${encodeURIComponent(token)}`;
  return base.includes('{token}') ? base.replace('{token}', encodeURIComponent(token)) : `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

async function issueToken(db: Db, app: App, userId: string, type: 'verify_email' | 'password_reset', ttlMs: number): Promise<string> {
  const token = randomToken(32);
  await db.exec(sql`UPDATE user_tokens SET used_at = ${app.clock.now()} WHERE user_id = ${userId} AND type = ${type} AND used_at IS NULL`);
  await db.exec(sql.insert('user_tokens', { id: newId('utk'), user_id: userId, type, token_hash: sha256(token), expires_at: new Date(app.clock.now().getTime() + ttlMs), created_at: app.clock.now() }, ''));
  return token;
}

async function consumeToken(db: Db, app: App, token: string, type: 'verify_email' | 'password_reset'): Promise<string> {
  const row = await db.maybe<{ user_id: string }>(sql`
    UPDATE user_tokens SET used_at = ${app.clock.now()}
    WHERE token_hash = ${sha256(token)} AND type = ${type} AND used_at IS NULL AND expires_at > ${app.clock.now()} RETURNING user_id
  `);
  if (!row) throw new AppError(400, 'token_invalid', 'This link is invalid or has expired');
  return row.user_id;
}

export async function issuePasswordReset(db: Db, app: App, userId: string): Promise<string> {
  const user = await getUser(db, userId, null);
  const token = await issueToken(db, app, userId, 'password_reset', HOUR);
  await sendSystemEmail(app, db, { to: user.email, template: 'identity.password_reset', category: 'security', userId, data: { name: user.name ?? '', link: link(settingsOf(app).resetUrl, token, `${app.config.appUrl}/reset-password`) } });
  await app.events.emit(db, 'user.password_reset_requested', { userId, email: user.email, requestedBy: 'identity' }, { userId });
  return token;
}

async function sendVerification(db: Db, app: App, user: { id: string; email: string; name: string | null }): Promise<void> {
  const token = await issueToken(db, app, user.id, 'verify_email', 3 * DAY);
  await sendSystemEmail(app, db, { to: user.email, template: 'identity.verify_email', category: 'security', userId: user.id, data: { name: user.name ?? '', link: link(settingsOf(app).verifyUrl, token, `${app.config.appUrl}/verify-email`) } });
}

function policy(app: App, password: string): void {
  const problem = checkPasswordPolicy(password, { minLength: settingsOf(app).passwordMinLength, requireMixed: false });
  if (problem) throw validationError([{ path: ['password'], message: problem }]);
}

function domainAllowed(app: App, email: string): boolean {
  const s = settingsOf(app);
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (s.blockedEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
  return !s.allowedEmailDomains.length || s.allowedEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

async function createSession(db: Db, app: App, userId: string, ip: string | null, userAgent: string | null): Promise<{ token: string; expiresAt: Date; id: string }> {
  const token = `us_${randomToken(32)}`;
  const now = app.clock.now();
  const expiresAt = new Date(now.getTime() + settingsOf(app).sessionDays * DAY);
  const id = newId('uss');
  await db.exec(sql.insert('user_sessions', { id, user_id: userId, token_hash: sha256(token), ip, user_agent: userAgent?.slice(0, 500) ?? null, created_at: now, last_seen_at: now, expires_at: expiresAt }, ''));
  return { token, expiresAt, id };
}

/**
 * Record the address of a sign-in for account-sharing detection, then refuse
 * the sign-in while a sharing block is active (the policy's cooling-off
 * period). Only addresses your app passes are recorded; the API caller's own
 * address says nothing about the customer.
 */
async function assertNotSharingBlocked(app: App, user: { id: string; email: string }, opts: { ip: string; userAgent: string; sharingIp: string | null; source: CustomerIpSource }): Promise<void> {
  if (opts.sharingIp) await recordCustomerIp(app, { userId: user.id, ip: opts.sharingIp, source: opts.source, userAgent: opts.userAgent || null });
  const block = await sharingBlock(app.db, app, user.id);
  if (!block) return;
  await app.db.tx((tx) => recordLogin(tx, app, { subjectType: 'user', subjectId: user.id, email: user.email, success: false, failureReason: 'sharing_cooldown', ip: opts.ip, userAgent: opts.userAgent }));
  throw new AppError(403, 'account_sharing_cooldown', cooldownMessage(app, block.blockedUntil), { blockedUntil: block.blockedUntil });
}

export const identityModule: ModuleDefinition = {
  id: 'identity',
  name: 'Built-in authentication',
  description: 'Optional end-user sign-up, sign-in, sessions, email verification and password reset for apps without their own auth.',
  version: '1.0.0',
  defaultEnabled: false,
  dependencies: ['core', 'security', 'customers', 'developers'],
  migrations: [
    {
      version: '001',
      name: 'user tokens',
      up: `
        CREATE TABLE user_tokens (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type text NOT NULL CHECK (type IN ('verify_email', 'password_reset')),
          token_hash text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, type);
      `,
    },
    {
      version: '002',
      name: 'social sign-in',
      up: `
        -- OAuth / OpenID Connect providers. The client secret lives in the encrypted secrets store.
        CREATE TABLE identity_providers (
          id text PRIMARY KEY,
          key text NOT NULL UNIQUE,
          type text NOT NULL CHECK (type IN ('google', 'github', 'microsoft', 'oidc')),
          name text NOT NULL,
          enabled boolean NOT NULL DEFAULT false,
          client_id text NOT NULL,
          scopes jsonb NOT NULL DEFAULT '[]',
          config jsonb NOT NULL DEFAULT '{}',
          allow_signup boolean NOT NULL DEFAULT true,
          redirect_urls jsonb NOT NULL DEFAULT '[]',
          created_by text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );

        CREATE TABLE user_identities (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider_id text NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
          subject text NOT NULL,
          email text,
          email_verified boolean NOT NULL DEFAULT false,
          profile jsonb NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL,
          last_login_at timestamptz,
          UNIQUE (provider_id, subject)
        );
        CREATE INDEX user_identities_user_idx ON user_identities (user_id);

        -- One row per sign-in attempt: single use, short-lived, the PKCE verifier encrypted.
        CREATE TABLE oauth_states (
          id text PRIMARY KEY,
          state_hash text NOT NULL UNIQUE,
          provider_id text NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
          redirect_uri text NOT NULL,
          code_verifier text NOT NULL,
          nonce text NOT NULL,
          expires_at timestamptz NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at);
      `,
    },
  ],
  permissions: [
    { key: 'identity.providers.view', label: 'View social sign-in providers and linked identities' },
    { key: 'identity.providers.manage', label: 'Configure social sign-in providers', dangerous: true },
  ],
  nav: [{ id: 'social-sign-in', label: 'Social sign-in', path: '/customers/social-sign-in', icon: 'key-square', section: 'customers', permission: 'identity.providers.view', order: 50 }],
  events: [{ type: 'user.identity_linked', description: 'A social sign-in identity (Google, GitHub, Microsoft, OpenID Connect) was linked to a customer' }],
  setup(app) {
    app.settings.define({
      key: 'identity',
      module: 'identity',
      label: 'Built-in authentication',
      description: 'Registration policy, sessions and the pages in your app that handle email links.',
      schema: identitySettings,
      defaults: { allowRegistration: true, requireEmailVerification: true, sessionDays: 30, passwordMinLength: 10, resetUrl: '', verifyUrl: '', allowedEmailDomains: [], blockedEmailDomains: [] },
    });
    registerApiScopes(app, 'identity', [{ scope: 'identity:write', description: 'Register, authenticate and manage end-user credentials' }]);
    app.services['identity.issuePasswordReset'] = (db: Db, userId: string) => issuePasswordReset(db, app, userId);
    // Verification and reset links were sent to the duplicate's address; they must not act on the merged account.
    onBeforeMerge(app, 'identity', async ({ db, sourceId }) => {
      await db.exec(sql`UPDATE user_tokens SET used_at = ${app.clock.now()} WHERE user_id = ${sourceId} AND used_at IS NULL`);
    });
    app.hooks.addFilter('system.retention', 'identity', async (_v, ctx: { before: (days: number) => Date }) => {
      await app.db.exec(sql`DELETE FROM oauth_states WHERE expires_at < ${ctx.before(1)}`);
    });
    app.hooks.addFilter('privacy.export', 'identity', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      socialIdentities: await ctx.db.many(sql`
        SELECT p.name AS provider, i.email, i.created_at AS linked_at, i.last_login_at FROM user_identities i JOIN identity_providers p ON p.id = i.provider_id WHERE i.user_id = ${ctx.userId}
      `),
    }));
    app.hooks.addFilter('privacy.anonymize', 'identity', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      await ctx.db.exec(sql`DELETE FROM user_identities WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`DELETE FROM user_tokens WHERE user_id = ${ctx.userId}`);
    });
  },
  routes(r, app) {
    const authBody = { ip: z.string().max(64).optional(), userAgent: z.string().max(500).optional() };

    r.route({
      method: 'POST',
      url: '/api/v1/identity/register',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Register an end user with email and password',
      tags: ['Identity'],
      description:
        'With a signup form (GET /api/public/signup-forms/:key), pass `formKey`, the form values in `fields` (keyed by field key), the `agreementVersionId` the customer accepted and the chosen `plan`; they are validated against the form.',
      rateLimit: { max: 30, windowSec: 60, by: 'principal', key: 'identity-register' },
      body: userInputSchema
        .pick({ email: true, name: true, externalId: true, marketingConsent: true, referralCode: true, locale: true, country: true, registrationSource: true, utm: true })
        .extend({
          password: z.string().min(1).max(256),
          formKey: z.string().max(64).optional(),
          fields: z.record(z.string(), z.unknown()).optional(),
          agreementVersionId: z.string().max(100).optional(),
          plan: z.string().max(100).optional(),
          ...authBody,
        }),
      handler: async (c) => {
        const s = settingsOf(app);
        if (!s.allowRegistration) throw new AppError(403, 'registration_closed', 'Registration is currently closed');
        if (!domainAllowed(app, c.body.email)) throw validationError([{ path: ['email'], message: 'Registration with this email domain is not allowed' }]);
        if (c.body.ip) assertIpAllowed(app, c.body.ip, 'auth');
        policy(app, c.body.password);
        const { password, ip, userAgent, formKey, fields, agreementVersionId, plan, ...input } = c.body;
        if (!formKey && (fields || agreementVersionId || plan)) throw validationError([{ path: ['formKey'], message: 'Pass the signup form key along with form fields' }]);
        const hash = await hashPassword(password);
        const result = await app.db.tx(async (tx) => {
          const form = formKey ? await applySignupForm(tx, app, { formKey, values: fields ?? {}, strict: true, agreementVersionId, plan }) : null;
          const user = await createUser(tx, app, form ? withFormInput(input, form) : input, c.actor, { orgId: c.orgScope()?.[0] ?? null, passwordHash: hash });
          if (form?.agreementVersion) {
            await recordAcceptance(tx, app, { userId: user.id, versionId: form.agreementVersion.id, ip: ip ?? null, userAgent: userAgent ?? null, source: 'signup' });
          }
          if (s.requireEmailVerification) await sendVerification(tx, app, user);
          const session = s.requireEmailVerification ? null : await createSession(tx, app, user.id, ip ?? null, userAgent ?? null);
          return {
            user: presentUser(user),
            session,
            verificationRequired: s.requireEmailVerification,
            redirectUrl: form?.redirectUrl ?? null,
            plan: form?.plan?.key ?? null,
          };
        });
        if (ip) await recordCustomerIp(app, { userId: result.user.id, ip, source: 'identity_register', userAgent });
        return result;
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/login',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Authenticate an end user; returns a session token',
      description: 'Pass the end user\'s IP and user agent so lockout, IP rules and suspicious-login detection apply.',
      tags: ['Identity'],
      body: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(256), ...authBody }),
      handler: async (c) => {
        const ip = c.body.ip ?? c.ip;
        const ua = c.body.userAgent ?? '';
        assertIpAllowed(app, ip, 'auth');
        const rl = await app.rateLimiter.hit(`identity-login:${ip}`, 30, 60);
        if (!rl.allowed) throw new AppError(429, 'rate_limited', 'Too many sign-in attempts', { retryAfterSeconds: rl.retryAfterSeconds }, { 'retry-after': String(rl.retryAfterSeconds) });
        const sec = app.settings.get<SecuritySettings>('security');
        const now = app.clock.now();
        const user = await app.db.maybe<any>(sql`SELECT * FROM users WHERE lower(email) = ${c.body.email} AND deleted_at IS NULL`);
        if (user?.locked_until && user.locked_until > now) {
          await app.db.tx((tx) => recordLogin(tx, app, { subjectType: 'user', subjectId: user.id, email: c.body.email, success: false, failureReason: 'locked', ip, userAgent: ua }));
          throw new AppError(429, 'account_locked', `Too many failed attempts. Try again in ${Math.ceil((user.locked_until.getTime() - now.getTime()) / MINUTE)} minutes.`);
        }
        const ok = await verifyPassword(c.body.password, user?.password_hash);
        if (!ok || !user) {
          await app.db.tx(async (tx) => {
            if (user) {
              const u = await tx.one<{ failed_login_count: number }>(sql`UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ${user.id} RETURNING failed_login_count`);
              if (u.failed_login_count >= sec.userLockoutThreshold) {
                await tx.exec(sql`UPDATE users SET failed_login_count = 0, locked_until = ${new Date(now.getTime() + sec.userLockoutMinutes * MINUTE)} WHERE id = ${user.id}`);
              }
            }
            await recordLogin(tx, app, { subjectType: 'user', subjectId: user?.id ?? null, email: c.body.email, success: false, failureReason: user ? 'bad_password' : 'unknown_email', ip, userAgent: ua });
          });
          throw unauthorized('Invalid email or password', 'invalid_credentials');
        }
        if (user.status === 'banned' || (user.status === 'suspended' && (!user.suspended_until || user.suspended_until > now))) {
          throw new AppError(403, 'account_inactive', 'This account is not active');
        }
        if (settingsOf(app).requireEmailVerification && !user.email_verified_at) throw new AppError(403, 'email_unverified', 'Verify your email address first');
        await assertNotSharingBlocked(app, user, { ip, userAgent: ua, sharingIp: c.body.ip ?? null, source: 'identity_login' });
        return app.db.tx(async (tx) => {
          await tx.exec(sql`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ${now}, last_login_ip = ${ip}, last_active_at = ${now} WHERE id = ${user.id}`);
          if (passwordNeedsRehash(user.password_hash)) await tx.exec(sql`UPDATE users SET password_hash = ${await hashPassword(c.body.password)} WHERE id = ${user.id}`);
          await restoreIfArchived(tx, app, user.id, 'signed_in');
          await recordLogin(tx, app, { subjectType: 'user', subjectId: user.id, email: user.email, success: true, ip, userAgent: ua });
          const session = await createSession(tx, app, user.id, ip, ua);
          return { user: presentUser(await getUser(tx, user.id, null)), session };
        });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/sessions/verify',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Validate an end-user session token (call on each request; cache briefly)',
      description: "Pass the end user's `ip` (and `userAgent`) so account-sharing detection sees the addresses the session is used from.",
      tags: ['Identity'],
      body: z.object({ token: z.string().startsWith('us_'), ip: z.string().max(64).optional(), userAgent: z.string().max(500).optional() }),
      handler: async (c) => {
        const now = app.clock.now();
        const lookup = () =>
          app.db.maybe<any>(sql`
            SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.last_seen_at, s.impersonator_admin_id FROM user_sessions s WHERE s.token_hash = ${sha256(c.body.token)}
          `);
        let row = await lookup();
        if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) return { valid: false, reason: 'session_invalid' };
        if (c.body.ip && !row.impersonator_admin_id) {
          // A new address can trip the sharing policy, which may sign the customer out.
          const outcome = await recordCustomerIp(app, { userId: row.user_id, ip: c.body.ip, source: 'session_verify', userAgent: c.body.userAgent ?? null });
          if (outcome?.flagged) row = await lookup();
          if (!row || row.revoked_at) return { valid: false, reason: 'session_invalid' };
        }
        const user = await app.db.maybe<any>(sql`SELECT * FROM users WHERE id = ${row.user_id} AND deleted_at IS NULL`);
        if (!user || user.status === 'banned' || (user.status === 'suspended' && (!user.suspended_until || user.suspended_until > now))) return { valid: false, reason: 'account_inactive' };
        if (now.getTime() - row.last_seen_at.getTime() > MINUTE) await app.db.exec(sql`UPDATE user_sessions SET last_seen_at = ${now} WHERE id = ${row.id}`);
        return { valid: true, session: { id: row.id, expiresAt: row.expires_at, impersonatedBy: row.impersonator_admin_id }, user: presentUser(user) };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/logout',
      auth: 'api',
      scope: 'identity:write',
      summary: 'End an end-user session',
      tags: ['Identity'],
      body: z.object({ token: z.string().startsWith('us_') }),
      handler: async (c) => {
        await app.db.exec(sql`UPDATE user_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = 'logout' WHERE token_hash = ${sha256(c.body.token)} AND revoked_at IS NULL`);
        return { ok: true };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/verify-email',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Confirm an email address with the token from the verification email',
      tags: ['Identity'],
      body: z.object({ token: z.string().min(10).max(200) }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const userId = await consumeToken(tx, app, c.body.token, 'verify_email');
          await tx.exec(sql`UPDATE users SET email_verified_at = coalesce(email_verified_at, ${app.clock.now()}), status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = ${userId}`);
          await app.events.emit(tx, 'user.email_verified', { userId }, { userId });
          return { verified: true, userId };
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/verification/resend',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Resend the verification email',
      tags: ['Identity'],
      rateLimit: { max: 5, windowSec: 600, by: 'principal', key: 'identity-resend' },
      body: z.object({ userId: z.string() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const user = await getUser(tx, c.body.userId, c.orgScope());
          if (user.email_verified_at) throw conflict('Email already verified', 'already_verified');
          await sendVerification(tx, app, user);
          return { ok: true };
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/password-reset/request',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Email a password reset link (responds the same whether or not the account exists)',
      tags: ['Identity'],
      rateLimit: { max: 10, windowSec: 600, by: 'principal', key: 'identity-reset' },
      body: z.object({ email: z.string().trim().toLowerCase().email() }),
      handler: async (c) => {
        const user = await app.db.maybe<{ id: string }>(sql`SELECT id FROM users WHERE lower(email) = ${c.body.email} AND deleted_at IS NULL AND status <> 'banned'`);
        if (user) await app.db.tx((tx) => issuePasswordReset(tx, app, user.id));
        return { ok: true };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/password-reset/confirm',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Set a new password with a reset token (signs the user out everywhere)',
      tags: ['Identity'],
      body: z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(256) }),
      handler: async (c) => {
        policy(app, c.body.password);
        const hash = await hashPassword(c.body.password);
        return app.db.tx(async (tx) => {
          const userId = await consumeToken(tx, app, c.body.token, 'password_reset');
          await tx.exec(sql`UPDATE users SET password_hash = ${hash}, failed_login_count = 0, locked_until = NULL, updated_at = ${app.clock.now()} WHERE id = ${userId}`);
          await revokeUserSessions(tx, app, userId, 'password_reset', { type: 'user', id: userId });
          await writeAudit(tx, app, { actor: { type: 'user', id: userId }, action: 'user.password_reset', targetType: 'user', targetId: userId });
          return { ok: true };
        });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/change-password',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Change password with the current password (other sessions are signed out)',
      tags: ['Identity'],
      body: z.object({ userId: z.string(), currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256), keepSessionToken: z.string().optional() }),
      handler: async (c) => {
        const user = await app.db.maybe<any>(sql`SELECT id, password_hash FROM users WHERE id = ${c.body.userId} AND deleted_at IS NULL`);
        if (!user || !(await verifyPassword(c.body.currentPassword, user.password_hash))) throw unauthorized('Current password is incorrect', 'invalid_credentials');
        policy(app, c.body.newPassword);
        const hash = await hashPassword(c.body.newPassword);
        return app.db.tx(async (tx) => {
          await tx.exec(sql`UPDATE users SET password_hash = ${hash}, updated_at = ${app.clock.now()} WHERE id = ${user.id}`);
          await tx.exec(sql`
            UPDATE user_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = 'password_changed'
            WHERE user_id = ${user.id} AND revoked_at IS NULL ${c.body.keepSessionToken ? sql`AND token_hash <> ${sha256(c.body.keepSessionToken)}` : sql.empty}
          `);
          return { ok: true };
        });
      },
    });

    // ---- Social sign-in -----------------------------------------------------------------
    registerSocialAdminRoutes(r, app);

    r.route({
      method: 'GET',
      url: '/api/v1/identity/social/providers',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Enabled social sign-in providers, for the buttons on your sign-in page',
      tags: ['Identity'],
      handler: async () => ({
        data: await app.db.many(sql`SELECT key, name, type FROM identity_providers WHERE enabled ORDER BY name`),
      }),
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/social/:provider/start',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Start a social sign-in: returns the provider URL to redirect the browser to',
      description: 'Keep the returned `state` with the browser session; the provider sends it back to your callback URL with a `code`. Pass both to the callback endpoint within ten minutes.',
      tags: ['Identity'],
      rateLimit: { max: 60, windowSec: 60, by: 'principal', key: 'identity-social-start' },
      params: z.object({ provider: z.string().max(64) }),
      body: z.object({ redirectUri: z.string().trim().url().max(1000), ...authBody }),
      handler: async (c) => {
        if (c.body.ip) assertIpAllowed(app, c.body.ip, 'auth');
        const provider = await loadProvider(app.db, c.params.provider, { enabledOnly: true });
        return startSocialSignIn(app.db, app, provider, c.body.redirectUri);
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/identity/social/:provider/callback',
      auth: 'api',
      scope: 'identity:write',
      summary: 'Finish a social sign-in with the code and state from your callback URL; returns a session',
      description:
        'Signs in the customer linked to this provider account. Otherwise links the provider account to the customer with the same email address when the provider confirms the address is verified, or registers a new customer. An unverified address that matches an existing customer is refused (409 email_unverified).',
      tags: ['Identity'],
      rateLimit: { max: 60, windowSec: 60, by: 'principal', key: 'identity-social-callback' },
      params: z.object({ provider: z.string().max(64) }),
      body: z.object({ code: z.string().min(1).max(4000), state: z.string().min(10).max(200), ...authBody }),
      handler: async (c) => {
        const ip = c.body.ip ?? c.ip;
        const ua = c.body.userAgent ?? '';
        assertIpAllowed(app, ip, 'auth');
        const s = settingsOf(app);
        const provider = await loadProvider(app.db, c.params.provider, { enabledOnly: true });
        // The code exchange talks to the provider, so it runs outside any transaction.
        const profile = await completeSocialSignIn(app.db, app, provider, c.body.code, c.body.state);
        const linked = await app.db.tx(async (tx) => {
          const now = app.clock.now();
          const identityRow = { email: profile.email, email_verified: profile.emailVerified, profile: { name: profile.name, avatarUrl: profile.avatarUrl, locale: profile.locale } };
          const identity = await tx.maybe<{ id: string; user_id: string }>(sql`
            SELECT id, user_id FROM user_identities WHERE provider_id = ${provider.id} AND subject = ${profile.subject} FOR UPDATE
          `);
          if (identity) {
            await tx.exec(sql`UPDATE user_identities SET ${sql.set({ ...identityRow, last_login_at: now })} WHERE id = ${identity.id}`);
            return { userId: identity.user_id, linkedBy: 'identity' as const, created: false };
          }
          if (!profile.email) throw new AppError(422, 'email_required', 'The provider did not share an email address; allow access to it and try again');
          const link = async (userId: string, linkedBy: 'email' | 'new_account') => {
            await tx.exec(sql.insert('user_identities', { id: newId('uid'), user_id: userId, provider_id: provider.id, subject: profile.subject, ...identityRow, created_at: now, last_login_at: now }, ''));
            await app.events.emit(tx, 'user.identity_linked', { userId, provider: provider.key, linkedBy }, { userId });
          };
          const existing = await tx.maybe<{ id: string }>(sql`SELECT id FROM users WHERE lower(email) = ${profile.email} AND deleted_at IS NULL FOR UPDATE`);
          if (existing) {
            if (!profile.emailVerified) {
              throw conflict('An account with this email already exists. Sign in with your password; the provider did not confirm the address belongs to you.', 'email_unverified');
            }
            await link(existing.id, 'email');
            return { userId: existing.id, linkedBy: 'email' as const, created: false };
          }
          if (!provider.allow_signup || !s.allowRegistration) throw new AppError(403, 'registration_closed', 'Registration is currently closed');
          if (!domainAllowed(app, profile.email)) throw validationError([{ path: ['email'], message: 'Registration with this email domain is not allowed' }]);
          const avatar = profile.avatarUrl && /^https?:\/\//.test(profile.avatarUrl) && profile.avatarUrl.length <= 1000 ? profile.avatarUrl : undefined;
          const user = await createUser(
            tx,
            app,
            { email: profile.email, name: profile.name?.slice(0, 200) || undefined, avatarUrl: avatar, locale: profile.locale ?? undefined, emailVerified: profile.emailVerified, registrationSource: `social:${provider.key}` },
            c.actor,
            { orgId: c.orgScope()?.[0] ?? null },
          );
          await link(user.id, 'new_account');
          if (!profile.emailVerified && s.requireEmailVerification) await sendVerification(tx, app, user);
          return { userId: user.id, linkedBy: 'new_account' as const, created: true };
        });

        const now = app.clock.now();
        const user = await app.db.maybe<any>(sql`SELECT * FROM users WHERE id = ${linked.userId} AND deleted_at IS NULL`);
        if (!user || user.status === 'banned' || (user.status === 'suspended' && (!user.suspended_until || user.suspended_until > now))) {
          throw new AppError(403, 'account_inactive', 'This account is not active');
        }
        if (s.requireEmailVerification && !user.email_verified_at) {
          return { user: presentUser(user), session: null, verificationRequired: true, created: linked.created, linkedBy: linked.linkedBy };
        }
        await assertNotSharingBlocked(app, user, { ip, userAgent: ua, sharingIp: c.body.ip ?? null, source: 'social_login' });
        return app.db.tx(async (tx) => {
          await tx.exec(sql`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ${now}, last_login_ip = ${ip}, last_active_at = ${now} WHERE id = ${user.id}`);
          await restoreIfArchived(tx, app, user.id, 'signed_in');
          await recordLogin(tx, app, { subjectType: 'user', subjectId: user.id, email: user.email, success: true, method: `social:${provider.key}`.slice(0, 30), ip, userAgent: ua });
          const session = await createSession(tx, app, user.id, ip, ua);
          return { user: presentUser(await getUser(tx, user.id, null)), session, verificationRequired: false, created: linked.created, linkedBy: linked.linkedBy };
        });
      },
    });
  },
};
