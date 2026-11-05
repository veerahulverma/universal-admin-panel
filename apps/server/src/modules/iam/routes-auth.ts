import { z } from 'zod';
import QRCode from 'qrcode';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { AppError, conflict, forbidden, notFound, unauthorized, validationError } from '../../core/errors.js';
import {
  checkPasswordPolicy,
  hashPassword,
  passwordNeedsRehash,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from '../../core/crypto.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../core/totp.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { email as emailSchema } from '../../core/validation.js';
import { HOUR, MINUTE } from '../../core/clock.js';
import { assertIpAllowed, geoCountry, raiseSecurityEvent, recordLogin } from '../security/module.js';
import {
  clearSessionCookie,
  createSession,
  extractToken,
  flattenPermissions,
  mfaState,
  revokeAdminSessions,
  rolePermissionsSql,
  setSessionCookie,
} from './auth.js';
import type { AuthSettings } from './module.js';
import { sendSystemEmail } from '../core/mail.js';
import { writeAudit } from '../../core/audit.js';

const passwordField = z.string().min(1).max(256);

function policyError(app: App, password: string): void {
  const s = app.settings.get<AuthSettings>('auth');
  const problem = checkPasswordPolicy(password, { minLength: s.passwordMinLength, requireMixed: s.passwordRequireMixed });
  if (problem) throw validationError([{ path: ['password'], message: problem }]);
}

function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () => {
    const raw = randomBase62(10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(c.replace(/-/g, ''))) };
}

export function registerAuthRoutes(r: Router, app: App): void {
  // ---- First-run setup -------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/setup/status',
    auth: 'public',
    summary: 'Whether the platform still needs its first administrator',
    tags: ['Auth'],
    handler: async () => {
      const row = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM admins`);
      return { needsSetup: row.count === 0 };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/setup',
    auth: 'public',
    summary: 'Create the first super administrator (requires the one-time setup token)',
    tags: ['Auth'],
    rateLimit: { max: 10, windowSec: 600 },
    body: z.object({ setupToken: z.string().min(1), email: emailSchema, name: z.string().trim().min(1).max(100), password: passwordField }),
    handler: async (c) => {
      const expected = app.services['iam.setupToken'] as string | undefined;
      if (!expected || !safeEqual(c.body.setupToken, expected)) throw forbidden('Invalid setup token', 'setup_token_invalid');
      policyError(app, c.body.password);
      const passwordHash = await hashPassword(c.body.password);
      const session = await app.db.tx(async (tx) => {
        await tx.query(sql`LOCK TABLE admins IN EXCLUSIVE MODE`);
        const existing = await tx.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM admins`);
        if (existing.count > 0) throw conflict('Setup has already been completed', 'setup_complete');
        const now = app.clock.now();
        const adminId = newId('adm');
        await tx.exec(sql.insert('admins', {
          id: adminId,
          email: c.body.email,
          name: c.body.name,
          password_hash: passwordHash,
          status: 'active',
          password_changed_at: now,
          created_at: now,
          updated_at: now,
        }, ''));
        await tx.exec(sql`INSERT INTO admin_roles (admin_id, role_id) SELECT ${adminId}, id FROM roles WHERE key = 'super_admin'`);
        await writeAudit(tx, app, { actor: { type: 'admin', id: adminId, label: c.body.email, ip: c.ip, userAgent: c.userAgent }, action: 'admin.setup', targetType: 'admin', targetId: adminId });
        return createSession(tx, app, { adminId, client: 'web', ip: c.ip, userAgent: c.userAgent, mfaVerified: true });
      });
      delete app.services['iam.setupToken'];
      setSessionCookie(app, c.reply, session.token, session.expiresAt);
      return { status: 'ok', csrfToken: session.csrfToken };
    },
  });

  // ---- Login -------------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/admin/auth/login',
    auth: 'public',
    summary: 'Sign in with email and password',
    tags: ['Auth'],
    rateLimit: { max: 20, windowSec: 60 },
    body: z.object({ email: emailSchema, password: passwordField, client: z.enum(['web', 'mobile']).default('web') }),
    handler: async (c) => {
      assertIpAllowed(app, c.ip, 'auth');
      assertIpAllowed(app, c.ip, 'admin');
      const settings = app.settings.get<AuthSettings>('auth');
      const now = app.clock.now();
      const country = geoCountry(app, c.req);
      const admin = await app.db.maybe<any>(sql`SELECT * FROM admins WHERE lower(email) = ${c.body.email}`);

      if (admin?.locked_until && admin.locked_until > now) {
        await app.db.tx((tx) => recordLogin(tx, app, { subjectType: 'admin', subjectId: admin.id, email: c.body.email, success: false, failureReason: 'locked', ip: c.ip, userAgent: c.userAgent, country }));
        const minutes = Math.ceil((admin.locked_until.getTime() - now.getTime()) / MINUTE);
        throw new AppError(429, 'account_locked', `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }

      const valid = await verifyPassword(c.body.password, admin?.password_hash);
      if (!valid || !admin || admin.status !== 'active') {
        await app.db.tx(async (tx) => {
          if (admin) {
            const updated = await tx.one<{ failed_login_count: number }>(sql`
              UPDATE admins SET failed_login_count = failed_login_count + 1 WHERE id = ${admin.id} RETURNING failed_login_count
            `);
            if (updated.failed_login_count >= settings.lockoutThreshold) {
              await tx.exec(sql`UPDATE admins SET failed_login_count = 0, locked_until = ${new Date(now.getTime() + settings.lockoutMinutes * MINUTE)} WHERE id = ${admin.id}`);
              await raiseSecurityEvent(tx, app, { type: 'admin.locked_out', severity: 'warning', subjectType: 'admin', subjectId: admin.id, ip: c.ip, details: { email: admin.email } });
            }
          }
          await recordLogin(tx, app, {
            subjectType: 'admin',
            subjectId: admin?.id ?? null,
            email: c.body.email,
            success: false,
            failureReason: !admin ? 'unknown_email' : admin.status !== 'active' ? 'disabled' : 'bad_password',
            ip: c.ip,
            userAgent: c.userAgent,
            country,
          });
        });
        throw unauthorized('Invalid email or password', 'invalid_credentials');
      }

      const session = await app.db.tx(async (tx) => {
        await tx.exec(sql`UPDATE admins SET failed_login_count = 0, locked_until = NULL WHERE id = ${admin.id}`);
        if (passwordNeedsRehash(admin.password_hash)) {
          await tx.exec(sql`UPDATE admins SET password_hash = ${await hashPassword(c.body.password)} WHERE id = ${admin.id}`);
        }
        const s = await createSession(tx, app, { adminId: admin.id, client: c.body.client, ip: c.ip, userAgent: c.userAgent, mfaVerified: !admin.totp_enabled });
        if (!admin.totp_enabled) {
          await tx.exec(sql`UPDATE admins SET last_login_at = ${now}, last_login_ip = ${c.ip} WHERE id = ${admin.id}`);
          await recordLogin(tx, app, { subjectType: 'admin', subjectId: admin.id, email: admin.email, success: true, ip: c.ip, userAgent: c.userAgent, country });
        }
        return s;
      });

      if (c.body.client === 'web') setSessionCookie(app, c.reply, session.token, session.expiresAt);
      const state = mfaState(app, { totp_enabled: admin.totp_enabled, mfa_verified: !admin.totp_enabled });
      return {
        status: state.mfaPending ? 'mfa_required' : state.enrollmentRequired ? 'mfa_enrollment_required' : 'ok',
        csrfToken: session.csrfToken,
        token: c.body.client === 'mobile' ? session.token : undefined,
        expiresAt: session.expiresAt,
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/mfa',
    auth: 'admin:partial',
    summary: 'Complete sign-in with a TOTP code or a recovery code',
    tags: ['Auth'],
    rateLimit: { max: 10, windowSec: 300, by: 'principal' },
    body: z.object({ code: z.string().max(12).optional(), recoveryCode: z.string().max(20).optional() }).refine((b) => b.code || b.recoveryCode, 'Enter a code'),
    handler: async (c) => {
      const p = c.admin();
      if (p.mfaVerified) return { status: 'ok' };
      const admin = await app.db.one<any>(sql`SELECT * FROM admins WHERE id = ${p.adminId}`);
      const now = app.clock.now();
      const country = geoCountry(app, c.req);
      return app.db.tx(async (tx) => {
        let method = 'totp';
        if (c.body.code) {
          const secret = app.encryptor.decrypt(admin.totp_secret_enc, `admin-totp:${admin.id}`);
          const counter = verifyTotp(secret, c.body.code, now.getTime());
          if (counter === null || (admin.totp_last_counter !== null && counter <= admin.totp_last_counter)) {
            await recordLogin(tx, app, { subjectType: 'admin', subjectId: admin.id, email: admin.email, success: false, failureReason: 'bad_mfa_code', method: 'mfa', ip: c.ip, userAgent: c.userAgent, country });
            throw unauthorized('That code is not valid. Check your authenticator app and try again.', 'mfa_invalid');
          }
          await tx.exec(sql`UPDATE admins SET totp_last_counter = ${counter} WHERE id = ${admin.id}`);
        } else {
          method = 'recovery_code';
          const hash = sha256(c.body.recoveryCode!.toLowerCase().replace(/[^a-z0-9]/g, ''));
          const remaining: string[] = admin.recovery_codes ?? [];
          if (!remaining.includes(hash)) {
            await recordLogin(tx, app, { subjectType: 'admin', subjectId: admin.id, email: admin.email, success: false, failureReason: 'bad_recovery_code', method: 'mfa', ip: c.ip, userAgent: c.userAgent, country });
            throw unauthorized('That recovery code is not valid', 'mfa_invalid');
          }
          await tx.exec(sql`UPDATE admins SET recovery_codes = ${sql.json(remaining.filter((h) => h !== hash))} WHERE id = ${admin.id}`);
          await raiseSecurityEvent(tx, app, { type: 'admin.recovery_code_used', severity: 'warning', subjectType: 'admin', subjectId: admin.id, ip: c.ip, details: { remaining: remaining.length - 1 } });
        }
        await tx.exec(sql`UPDATE admin_sessions SET mfa_verified = TRUE, reauth_at = ${now} WHERE id = ${p.sessionId}`);
        await tx.exec(sql`UPDATE admins SET last_login_at = ${now}, last_login_ip = ${c.ip} WHERE id = ${admin.id}`);
        await recordLogin(tx, app, { subjectType: 'admin', subjectId: admin.id, email: admin.email, success: true, method, ip: c.ip, userAgent: c.userAgent, country });
        return { status: 'ok' };
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/logout',
    auth: 'admin:partial',
    summary: 'Sign out of the current session',
    tags: ['Auth'],
    handler: async (c) => {
      await app.db.exec(sql`UPDATE admin_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = 'logout' WHERE id = ${c.admin().sessionId}`);
      clearSessionCookie(app, c.reply);
      return { ok: true };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/auth/me',
    auth: 'admin:partial',
    summary: 'Current admin, permissions and session state',
    tags: ['Auth'],
    handler: async (c) => {
      const p = c.admin();
      const admin = await app.db.one<any>(sql`
        SELECT a.id, a.email, a.name, a.avatar_url, a.totp_enabled, a.org_scope, a.last_login_at, a.password_changed_at,
               jsonb_array_length(a.recovery_codes) AS recovery_codes_left,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'key', r.key, 'name', r.name)), '[]'::jsonb)
                  FROM admin_roles ar JOIN roles r ON r.id = ar.role_id WHERE ar.admin_id = a.id) AS roles
        FROM admins a WHERE a.id = ${p.adminId}
      `);
      const session = await app.db.one<any>(sql`SELECT csrf_token, mfa_verified, reauth_at, expires_at, client FROM admin_sessions WHERE id = ${p.sessionId}`);
      const state = mfaState(app, { totp_enabled: admin.totp_enabled, mfa_verified: session.mfa_verified });
      const windowMin = app.settings.get<AuthSettings>('auth').reauthWindowMinutes;
      return {
        admin: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          avatarUrl: admin.avatar_url,
          totpEnabled: admin.totp_enabled,
          recoveryCodesLeft: admin.recovery_codes_left,
          orgScope: admin.org_scope,
          roles: admin.roles,
          lastLoginAt: admin.last_login_at,
        },
        grants: p.permissions,
        permissions: state.mfaPending ? [] : app.permissions.expand(p.permissions),
        session: {
          id: p.sessionId,
          mfaRequired: state.mfaPending,
          enrollmentRequired: state.enrollmentRequired,
          reauthValidUntil: session.reauth_at ? new Date(session.reauth_at.getTime() + windowMin * MINUTE) : null,
          expiresAt: session.expires_at,
        },
        csrfToken: session.csrf_token,
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/reauth',
    auth: 'admin',
    summary: 'Confirm identity before a sensitive action',
    tags: ['Auth'],
    rateLimit: { max: 10, windowSec: 300, by: 'principal' },
    body: z.object({ password: passwordField, code: z.string().max(12).optional() }),
    handler: async (c) => {
      const p = c.admin();
      const admin = await app.db.one<any>(sql`SELECT * FROM admins WHERE id = ${p.adminId}`);
      if (!(await verifyPassword(c.body.password, admin.password_hash))) throw unauthorized('Incorrect password', 'invalid_credentials');
      if (admin.totp_enabled) {
        if (!c.body.code) throw unauthorized('Enter the code from your authenticator app', 'mfa_required');
        const secret = app.encryptor.decrypt(admin.totp_secret_enc, `admin-totp:${admin.id}`);
        const counter = verifyTotp(secret, c.body.code, app.clock.now().getTime());
        if (counter === null || (admin.totp_last_counter !== null && counter <= admin.totp_last_counter)) {
          throw unauthorized('That code is not valid', 'mfa_invalid');
        }
        await app.db.exec(sql`UPDATE admins SET totp_last_counter = ${counter} WHERE id = ${admin.id}`);
      }
      const now = app.clock.now();
      await app.db.exec(sql`UPDATE admin_sessions SET reauth_at = ${now} WHERE id = ${p.sessionId}`);
      const windowMin = app.settings.get<AuthSettings>('auth').reauthWindowMinutes;
      return { reauthValidUntil: new Date(now.getTime() + windowMin * MINUTE) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/password',
    auth: 'admin',
    summary: 'Change your password (signs out other sessions)',
    tags: ['Auth'],
    rateLimit: { max: 10, windowSec: 600, by: 'principal' },
    body: z.object({ currentPassword: passwordField, newPassword: passwordField }),
    handler: async (c) => {
      const p = c.admin();
      const admin = await app.db.one<any>(sql`SELECT password_hash FROM admins WHERE id = ${p.adminId}`);
      if (!(await verifyPassword(c.body.currentPassword, admin.password_hash))) throw unauthorized('Current password is incorrect', 'invalid_credentials');
      policyError(app, c.body.newPassword);
      const hash = await hashPassword(c.body.newPassword);
      await app.db.tx(async (tx) => {
        await tx.exec(sql`UPDATE admins SET password_hash = ${hash}, password_changed_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${p.adminId}`);
        await revokeAdminSessions(tx, app, p.adminId, 'password_changed', p.sessionId);
        await c.audit(tx, 'admin.password_change', { type: 'admin', id: p.adminId });
      });
      return { ok: true };
    },
  });

  // ---- Two-factor authentication ------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/admin/auth/2fa/setup',
    auth: 'admin:enroll',
    summary: 'Start TOTP enrollment: returns a secret and QR code',
    tags: ['Auth'],
    handler: async (c) => {
      const p = c.admin();
      const secret = generateTotpSecret();
      await app.db.exec(sql`UPDATE admins SET totp_pending_secret_enc = ${app.encryptor.encrypt(secret, `admin-totp:${p.adminId}`)} WHERE id = ${p.adminId}`);
      const issuer = app.settings.get('general').appName;
      const url = otpauthUrl(secret, p.email, issuer);
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
      return { secret, otpauthUrl: url, qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/2fa/enable',
    auth: 'admin:enroll',
    summary: 'Confirm TOTP enrollment with a code; returns one-time recovery codes',
    tags: ['Auth'],
    rateLimit: { max: 10, windowSec: 300, by: 'principal' },
    body: z.object({ code: z.string().max(12) }),
    handler: async (c) => {
      const p = c.admin();
      const admin = await app.db.one<any>(sql`SELECT totp_pending_secret_enc FROM admins WHERE id = ${p.adminId}`);
      if (!admin.totp_pending_secret_enc) throw conflict('Start two-factor setup first', 'mfa_setup_missing');
      const secret = app.encryptor.decrypt(admin.totp_pending_secret_enc, `admin-totp:${p.adminId}`);
      const counter = verifyTotp(secret, c.body.code, app.clock.now().getTime());
      if (counter === null) throw unauthorized('That code is not valid. Make sure your device clock is correct.', 'mfa_invalid');
      const { codes, hashes } = generateRecoveryCodes();
      await app.db.tx(async (tx) => {
        await tx.exec(sql`
          UPDATE admins SET totp_secret_enc = totp_pending_secret_enc, totp_pending_secret_enc = NULL, totp_enabled = TRUE,
            totp_last_counter = ${counter}, recovery_codes = ${sql.json(hashes)}, updated_at = ${app.clock.now()}
          WHERE id = ${p.adminId}
        `);
        await tx.exec(sql`UPDATE admin_sessions SET mfa_verified = TRUE WHERE id = ${p.sessionId}`);
        await c.audit(tx, 'admin.2fa_enable', { type: 'admin', id: p.adminId });
      });
      return { recoveryCodes: codes };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/2fa/disable',
    auth: 'admin',
    sensitive: true,
    summary: 'Turn off two-factor authentication for your account',
    tags: ['Auth'],
    handler: async (c) => {
      const p = c.admin();
      if (app.settings.get<AuthSettings>('auth').require2fa) throw forbidden('Two-factor authentication is required by policy', 'mfa_required_by_policy');
      await app.db.tx(async (tx) => {
        await tx.exec(sql`UPDATE admins SET totp_enabled = FALSE, totp_secret_enc = NULL, totp_last_counter = NULL, recovery_codes = '[]' WHERE id = ${p.adminId}`);
        await c.audit(tx, 'admin.2fa_disable', { type: 'admin', id: p.adminId });
        await raiseSecurityEvent(tx, app, { type: 'admin.2fa_disabled', severity: 'warning', subjectType: 'admin', subjectId: p.adminId, ip: c.ip });
      });
      return { ok: true };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/2fa/recovery-codes',
    auth: 'admin',
    sensitive: true,
    summary: 'Generate a new set of recovery codes (invalidates the old ones)',
    tags: ['Auth'],
    handler: async (c) => {
      const p = c.admin();
      const { codes, hashes } = generateRecoveryCodes();
      await app.db.tx(async (tx) => {
        const n = await tx.exec(sql`UPDATE admins SET recovery_codes = ${sql.json(hashes)} WHERE id = ${p.adminId} AND totp_enabled`);
        if (!n) throw conflict('Enable two-factor authentication first', 'mfa_not_enabled');
        await c.audit(tx, 'admin.recovery_codes_regenerate', { type: 'admin', id: p.adminId });
      });
      return { recoveryCodes: codes };
    },
  });

  // ---- Own sessions ---------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/auth/sessions',
    auth: 'admin',
    summary: 'Your active sessions',
    tags: ['Auth'],
    handler: async (c) => {
      const p = c.admin();
      const rows = await app.db.many<any>(sql`
        SELECT id, client, ip, user_agent, created_at, last_seen_at, expires_at FROM admin_sessions
        WHERE admin_id = ${p.adminId} AND revoked_at IS NULL AND expires_at > ${app.clock.now()} ORDER BY last_seen_at DESC
      `);
      return { data: rows.map((s) => ({ ...s, current: s.id === p.sessionId })) };
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/auth/sessions/:id',
    auth: 'admin',
    summary: 'Sign out one of your sessions',
    tags: ['Auth'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const p = c.admin();
      const n = await app.db.exec(sql`
        UPDATE admin_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = 'revoked_by_owner'
        WHERE id = ${c.params.id} AND admin_id = ${p.adminId} AND revoked_at IS NULL
      `);
      if (!n) throw notFound('Session');
    },
  });

  // ---- Password reset ------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/admin/auth/forgot-password',
    auth: 'public',
    summary: 'Email a password reset link (always responds the same way)',
    tags: ['Auth'],
    rateLimit: { max: 5, windowSec: 900 },
    body: z.object({ email: emailSchema }),
    handler: async (c) => {
      assertIpAllowed(app, c.ip, 'auth');
      const admin = await app.db.maybe<{ id: string; email: string; name: string }>(sql`SELECT id, email, name FROM admins WHERE lower(email) = ${c.body.email} AND status = 'active'`);
      if (admin) {
        const token = randomToken(32);
        await app.db.tx(async (tx) => {
          await tx.exec(sql.insert('admin_password_resets', {
            id: newId('apr'),
            admin_id: admin.id,
            token_hash: sha256(token),
            expires_at: new Date(app.clock.now().getTime() + HOUR),
            created_at: app.clock.now(),
          }, ''));
          const link = `${app.config.adminUrl}/reset-password?token=${encodeURIComponent(token)}`;
          const sent = await sendSystemEmail(app, tx, { to: admin.email, template: 'admin.password_reset', data: { name: admin.name, link }, category: 'security' });
          if (!sent && !app.config.isProd) app.log.warn({ link }, 'password reset link (email module unavailable)');
        });
      }
      return { ok: true, message: 'If that account exists, a reset link is on its way.' };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/auth/reset-password',
    auth: 'public',
    summary: 'Set a new password using a reset token',
    tags: ['Auth'],
    rateLimit: { max: 10, windowSec: 900 },
    body: z.object({ token: z.string().min(10).max(200), password: passwordField }),
    handler: async (c) => {
      policyError(app, c.body.password);
      const hash = await hashPassword(c.body.password);
      await app.db.tx(async (tx) => {
        const reset = await tx.maybe<{ id: string; admin_id: string }>(sql`
          UPDATE admin_password_resets SET used_at = ${app.clock.now()}
          WHERE token_hash = ${sha256(c.body.token)} AND used_at IS NULL AND expires_at > ${app.clock.now()}
          RETURNING id, admin_id
        `);
        if (!reset) throw new AppError(400, 'token_invalid', 'This reset link is invalid or has expired');
        await tx.exec(sql`UPDATE admins SET password_hash = ${hash}, password_changed_at = ${app.clock.now()}, failed_login_count = 0, locked_until = NULL WHERE id = ${reset.admin_id}`);
        await revokeAdminSessions(tx, app, reset.admin_id, 'password_reset');
        await writeAudit(tx, app, { actor: { type: 'admin', id: reset.admin_id, ip: c.ip, userAgent: c.userAgent }, action: 'admin.password_reset', targetType: 'admin', targetId: reset.admin_id });
      });
      return { ok: true };
    },
  });

  // ---- Invitations -------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/invitations/lookup',
    auth: 'public',
    summary: 'Check an invitation token',
    tags: ['Auth'],
    rateLimit: { max: 30, windowSec: 600 },
    query: z.object({ token: z.string().min(10).max(200) }),
    handler: async (c) => {
      const inv = await app.db.maybe<{ email: string; expires_at: Date }>(sql`
        SELECT email, expires_at FROM admin_invitations
        WHERE token_hash = ${sha256(c.query.token)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${app.clock.now()}
      `);
      if (!inv) throw notFound('Invitation');
      return { email: inv.email, expiresAt: inv.expires_at };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/invitations/accept',
    auth: 'public',
    summary: 'Accept an invitation and create your admin account',
    tags: ['Auth'],
    rateLimit: { max: 10, windowSec: 600 },
    body: z.object({ token: z.string().min(10).max(200), name: z.string().trim().min(1).max(100), password: passwordField }),
    handler: async (c) => {
      policyError(app, c.body.password);
      const hash = await hashPassword(c.body.password);
      const session = await app.db.tx(async (tx) => {
        const inv = await tx.maybe<any>(sql`
          UPDATE admin_invitations SET accepted_at = ${app.clock.now()}
          WHERE token_hash = ${sha256(c.body.token)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${app.clock.now()}
          RETURNING *
        `);
        if (!inv) throw new AppError(400, 'token_invalid', 'This invitation is invalid or has expired');
        const exists = await tx.maybe(sql`SELECT 1 FROM admins WHERE lower(email) = ${inv.email.toLowerCase()}`);
        if (exists) throw conflict('An administrator with this email already exists', 'admin_exists');
        const now = app.clock.now();
        const adminId = newId('adm');
        await tx.exec(sql.insert('admins', {
          id: adminId,
          email: inv.email,
          name: c.body.name,
          password_hash: hash,
          status: 'active',
          org_scope: inv.org_scope,
          password_changed_at: now,
          created_by: inv.invited_by,
          created_at: now,
          updated_at: now,
        }, ''));
        const roleIds: string[] = inv.role_ids ?? [];
        for (const roleId of roleIds) await tx.exec(sql`INSERT INTO admin_roles (admin_id, role_id) VALUES (${adminId}, ${roleId}) ON CONFLICT DO NOTHING`);
        await writeAudit(tx, app, { actor: { type: 'admin', id: adminId, label: inv.email, ip: c.ip, userAgent: c.userAgent }, action: 'admin.invitation_accept', targetType: 'admin', targetId: adminId, metadata: { invitationId: inv.id } });
        return createSession(tx, app, { adminId, client: 'web', ip: c.ip, userAgent: c.userAgent, mfaVerified: true });
      });
      setSessionCookie(app, c.reply, session.token, session.expiresAt);
      return { status: app.settings.get<AuthSettings>('auth').require2fa ? 'mfa_enrollment_required' : 'ok', csrfToken: session.csrfToken };
    },
  });
}

export { extractToken, flattenPermissions, rolePermissionsSql };
