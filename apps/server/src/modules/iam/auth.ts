import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminPrincipal, App, Authenticator } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { forbidden, unauthorized } from '../../core/errors.js';
import { randomToken, safeEqual, sha256 } from '../../core/crypto.js';
import { newId } from '../../core/ids.js';
import { ipMatches } from '../../core/net.js';
import { DAY, HOUR, MINUTE } from '../../core/clock.js';
import { assertIpAllowed } from '../security/module.js';
import type { AuthSettings } from './module.js';

export const SESSION_COOKIE = 'stw_admin';

interface SessionRow {
  id: string;
  admin_id: string;
  csrf_token: string;
  client: 'web' | 'mobile';
  mfa_verified: boolean;
  reauth_at: Date | null;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  email: string;
  name: string;
  admin_status: string;
  totp_enabled: boolean;
  allowed_ips: string[];
  org_scope: string[] | null;
  role_permissions: string[][] | null;
}

export function flattenPermissions(rolePermissions: string[][] | null | undefined): string[] {
  return [...new Set((rolePermissions ?? []).flat())];
}

/** SQL fragment: every permission pattern granted to an admin through roles (array of arrays). */
export const rolePermissionsSql = (adminIdColumn: string) => sql`(
  SELECT coalesce(jsonb_agg(r.permissions), '[]'::jsonb) FROM admin_roles ar JOIN roles r ON r.id = ar.role_id
  WHERE ar.admin_id = ${sql.raw(adminIdColumn)}
)`;

export function extractToken(req: FastifyRequest): { token: string; viaCookie: boolean } | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return { token: header.slice(7).trim(), viaCookie: false };
  const cookie = req.cookies?.[SESSION_COOKIE];
  return cookie ? { token: cookie, viaCookie: true } : null;
}

export interface MfaState {
  mfaPending: boolean;
  enrollmentRequired: boolean;
}

export function mfaState(app: App, row: { totp_enabled: boolean; mfa_verified: boolean }): MfaState {
  const settings = app.settings.get<AuthSettings>('auth');
  return {
    mfaPending: row.totp_enabled && !row.mfa_verified,
    enrollmentRequired: settings.require2fa && !row.totp_enabled,
  };
}

/**
 * Authenticates admin requests (cookie for the web panel, bearer token for the
 * mobile app). Enforces revocation, absolute + idle expiry, IP restrictions,
 * CSRF for cookie-authenticated writes, and the two-factor state machine:
 *   admin:partial  -> session exists (2FA may be pending): me, verify, logout
 *   admin:enroll   -> 2FA verified, enrollment may be required: 2FA setup
 *   admin          -> fully authenticated
 */
export function adminAuthenticator(app: App): Authenticator {
  return async (req, mode) => {
    const extracted = extractToken(req);
    if (!extracted) throw unauthorized();
    const row = await app.db.maybe<SessionRow>(sql`
      SELECT s.id, s.admin_id, s.csrf_token, s.client, s.mfa_verified, s.reauth_at, s.last_seen_at, s.expires_at, s.revoked_at,
             a.email, a.name, a.status AS admin_status, a.totp_enabled, a.allowed_ips, a.org_scope,
             ${rolePermissionsSql('a.id')} AS role_permissions
      FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ${sha256(extracted.token)}
    `);
    const now = app.clock.now();
    if (!row || row.revoked_at || row.expires_at <= now || row.admin_status !== 'active') {
      throw unauthorized('Your session has expired. Please sign in again.', 'session_invalid');
    }
    const settings = app.settings.get<AuthSettings>('auth');
    const idleMs = row.client === 'mobile' ? settings.mobileSessionDays * DAY : settings.sessionIdleMinutes * MINUTE;
    if (now.getTime() - row.last_seen_at.getTime() > idleMs) {
      await app.db.exec(sql`UPDATE admin_sessions SET revoked_at = ${now}, revoked_reason = 'idle_timeout' WHERE id = ${row.id}`);
      throw unauthorized('Your session expired due to inactivity. Please sign in again.', 'session_idle');
    }

    assertIpAllowed(app, req.ip, 'admin');
    if (settings.ipAllowlist.length && !ipMatches(req.ip, settings.ipAllowlist)) {
      throw forbidden('The admin panel is not available from your network', 'ip_not_allowed');
    }
    if (row.allowed_ips.length && !ipMatches(req.ip, row.allowed_ips)) {
      throw forbidden('Your account is restricted to specific networks', 'ip_not_allowed');
    }

    if (extracted.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, row.csrf_token)) {
        throw forbidden('Missing or invalid CSRF token', 'csrf_invalid');
      }
    }

    const { mfaPending, enrollmentRequired } = mfaState(app, row);
    if (mode !== 'admin:partial' && mfaPending) throw unauthorized('Two-factor verification required', 'mfa_required');
    if (mode === 'admin' && enrollmentRequired) throw forbidden('Two-factor authentication must be set up first', 'mfa_enrollment_required');

    if (now.getTime() - row.last_seen_at.getTime() > MINUTE) {
      await app.db.exec(sql`UPDATE admin_sessions SET last_seen_at = ${now} WHERE id = ${row.id}`);
    }

    const principal: AdminPrincipal = {
      kind: 'admin',
      adminId: row.admin_id,
      email: row.email,
      name: row.name,
      sessionId: row.id,
      permissions: flattenPermissions(row.role_permissions),
      orgScope: row.org_scope && row.org_scope.length ? row.org_scope : null,
      mfaVerified: row.mfa_verified,
      reauthAt: row.reauth_at,
      viaCookie: extracted.viaCookie,
    };
    return principal;
  };
}

export async function createSession(
  db: Db,
  app: App,
  input: { adminId: string; client: 'web' | 'mobile'; ip: string; userAgent: string; mfaVerified: boolean },
): Promise<{ id: string; token: string; csrfToken: string; expiresAt: Date }> {
  const settings = app.settings.get<AuthSettings>('auth');
  const now = app.clock.now();
  const token = `stw_${randomToken(32)}`;
  const csrfToken = randomToken(24);
  const expiresAt = new Date(now.getTime() + (input.client === 'mobile' ? settings.mobileSessionDays * DAY : settings.sessionMaxHours * HOUR));
  const id = newId('ses');
  await db.exec(sql.insert('admin_sessions', {
    id,
    admin_id: input.adminId,
    token_hash: sha256(token),
    csrf_token: csrfToken,
    client: input.client,
    ip: input.ip,
    user_agent: input.userAgent,
    mfa_verified: input.mfaVerified,
    reauth_at: input.mfaVerified ? now : null,
    created_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
  }, ''));
  return { id, token, csrfToken, expiresAt };
}

export function setSessionCookie(app: App, reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: app.config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(app: App, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: app.config.cookieSecure, sameSite: 'strict' });
}

export async function revokeAdminSessions(db: Db, app: App, adminId: string, reason: string, exceptSessionId?: string): Promise<number> {
  return db.exec(sql`
    UPDATE admin_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = ${reason}
    WHERE admin_id = ${adminId} AND revoked_at IS NULL
    ${exceptSessionId ? sql`AND id <> ${exceptSessionId}` : sql.empty}
  `);
}
