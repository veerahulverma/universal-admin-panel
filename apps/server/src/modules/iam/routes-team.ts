import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { AppError, conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import { email as emailSchema, keySlug, pageQuery, paginate } from '../../core/validation.js';
import { isValidCidr } from '../../core/net.js';
import { DAY } from '../../core/clock.js';
import { isAllowed } from '../../core/permissions.js';
import { diff } from '../../core/json.js';
import { flattenPermissions, revokeAdminSessions, rolePermissionsSql } from './auth.js';
import { raiseSecurityEvent } from '../security/module.js';
import { sendSystemEmail } from '../core/mail.js';
import { approvalExecutor } from './approvals.js';

async function rolePermissions(db: Db, roleIds: readonly string[]): Promise<string[]> {
  if (!roleIds.length) return [];
  const rows = await db.many<{ id: string; permissions: string[] }>(sql`SELECT id, permissions FROM roles WHERE id IN ${sql.in(roleIds)}`);
  if (rows.length !== new Set(roleIds).size) throw validationError([{ path: ['roleIds'], message: 'One or more roles do not exist' }]);
  return rows.flatMap((r) => r.permissions);
}

/** Refuse changes that would leave no active super administrator. */
async function assertSuperAdminRemains(db: Db): Promise<void> {
  const row = await db.one<{ count: number }>(sql`
    SELECT count(DISTINCT a.id)::int AS count FROM admins a
    JOIN admin_roles ar ON ar.admin_id = a.id JOIN roles r ON r.id = ar.role_id
    WHERE a.status = 'active' AND r.permissions @> '["*"]'::jsonb AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(r.permissions) p WHERE p LIKE '!%'
    )
  `);
  if (row.count === 0) throw conflict('At least one active super administrator must remain', 'last_super_admin');
}

const orgScopeSchema = z.array(z.string().max(64)).max(500).nullable();

/** Organization-scoped administrators can only give data access within their own organizations. */
function assertScopeWithin(actorScope: string[] | null, scope: string[] | null): void {
  if (!actorScope) return;
  if (scope === null || scope.some((id) => !actorScope.includes(id))) {
    throw forbidden('You can only give access to organizations you manage yourself', 'org_scope');
  }
}

/**
 * You can only act on administrators who hold no permissions or data access
 * beyond your own (otherwise resetting 2FA, signing out or removing a more
 * powerful account would be an escalation path).
 */
async function assertCanManage(db: Db, app: App, actor: { permissions: string[]; orgScope: string[] | null }, targetId: string): Promise<void> {
  const target = await db.maybe<{ org_scope: string[] | null; p: string[][] }>(sql`SELECT a.org_scope, ${rolePermissionsSql('a.id')} AS p FROM admins a WHERE a.id = ${targetId}`);
  if (!target) throw notFound('Administrator');
  if (!app.permissions.canGrant(actor.permissions, flattenPermissions(target.p)).ok) throw forbidden('You cannot manage an administrator with more privileges than you', 'privilege_escalation');
  if (actor.orgScope && (target.org_scope === null || target.org_scope.some((id) => !actor.orgScope!.includes(id)))) {
    throw forbidden('You cannot manage an administrator with access beyond your organizations', 'org_scope');
  }
}

export function registerTeamRoutes(r: Router, app: App): void {
  // ---- Team -----------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/team',
    auth: 'admin',
    permission: 'iam.admins.view',
    summary: 'List administrators',
    tags: ['Team'],
    query: z.object({ status: z.enum(['active', 'disabled']).optional() }),
    handler: async (c) => ({
      data: await app.db.many(sql`
        SELECT a.id, a.email, a.name, a.status, a.totp_enabled, a.org_scope, a.allowed_ips, a.last_login_at, a.last_login_ip,
               a.locked_until, a.created_at,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'key', r.key, 'name', r.name) ORDER BY r.name), '[]'::jsonb)
                  FROM admin_roles ar JOIN roles r ON r.id = ar.role_id WHERE ar.admin_id = a.id) AS roles,
               (SELECT count(*)::int FROM admin_sessions s WHERE s.admin_id = a.id AND s.revoked_at IS NULL AND s.expires_at > ${app.clock.now()}) AS active_sessions
        FROM admins a ${c.query.status ? sql`WHERE a.status = ${c.query.status}` : sql.empty}
        ORDER BY a.name
      `),
    }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/team/:id',
    auth: 'admin',
    permission: 'iam.admins.view',
    summary: 'Administrator details, sessions and recent activity',
    tags: ['Team'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const admin = await app.db.maybe<any>(sql`
        SELECT a.id, a.email, a.name, a.status, a.totp_enabled, a.org_scope, a.allowed_ips, a.last_login_at, a.last_login_ip,
               a.locked_until, a.created_at, a.password_changed_at,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'key', r.key, 'name', r.name)), '[]'::jsonb)
                  FROM admin_roles ar JOIN roles r ON r.id = ar.role_id WHERE ar.admin_id = a.id) AS roles,
               ${rolePermissionsSql('a.id')} AS role_permissions
        FROM admins a WHERE a.id = ${c.params.id}
      `);
      if (!admin) throw notFound('Administrator');
      const sessions = await app.db.many(sql`
        SELECT id, client, ip, user_agent, created_at, last_seen_at, expires_at FROM admin_sessions
        WHERE admin_id = ${admin.id} AND revoked_at IS NULL AND expires_at > ${app.clock.now()} ORDER BY last_seen_at DESC
      `);
      const activity = await app.db.many(sql`
        SELECT id, action, target_type, target_id, ip, created_at FROM audit_logs
        WHERE actor_type = 'admin' AND actor_id = ${admin.id} ORDER BY seq DESC LIMIT 25
      `);
      const { role_permissions, ...rest } = admin;
      return { ...rest, permissions: app.permissions.expand(flattenPermissions(role_permissions)), sessions, activity };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/team/invitations',
    auth: 'admin',
    permission: 'iam.admins.manage',
    summary: 'Invite an administrator',
    tags: ['Team'],
    body: z.object({ email: emailSchema, roleIds: z.array(z.string()).min(1).max(20), orgScope: orgScopeSchema.optional() }),
    handler: async (c) => {
      const me = c.admin();
      const exists = await app.db.maybe(sql`SELECT 1 FROM admins WHERE lower(email) = ${c.body.email}`);
      if (exists) throw conflict('An administrator with this email already exists', 'admin_exists');
      const token = randomToken(32);
      const link = `${app.config.adminUrl}/accept-invite?token=${encodeURIComponent(token)}`;
      return app.db.tx(async (tx) => {
        const granted = await rolePermissions(tx, c.body.roleIds);
        const check = app.permissions.canGrant(me.permissions, granted);
        if (!check.ok) throw forbidden(`You cannot grant permissions you do not hold: ${check.missing.slice(0, 5).join(', ')}`, 'privilege_escalation');
        assertScopeWithin(me.orgScope, c.body.orgScope ?? null);
        const id = newId('inv');
        const expiresAt = new Date(app.clock.now().getTime() + 7 * DAY);
        await tx.exec(sql.insert('admin_invitations', {
          id,
          email: c.body.email,
          role_ids: c.body.roleIds,
          org_scope: c.body.orgScope ?? null,
          token_hash: sha256(token),
          invited_by: me.adminId,
          expires_at: expiresAt,
          created_at: app.clock.now(),
        }, ''));
        await c.audit(tx, 'admin.invite', { type: 'admin_invitation', id }, { email: c.body.email, roleIds: c.body.roleIds });
        await app.events.emit(tx, 'admin.invited', { invitationId: id, email: c.body.email });
        const emailed = await sendSystemEmail(app, tx, {
          to: c.body.email,
          template: 'admin.invitation',
          data: { inviterName: me.name, link, appName: app.settings.get('general').appName },
          category: 'security',
        });
        // The link is shown to the inviter so invitations work even without email configured.
        return { id, email: c.body.email, expiresAt, emailed, inviteLink: link };
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/team/invitations',
    auth: 'admin',
    permission: 'iam.admins.view',
    summary: 'Pending invitations',
    tags: ['Team'],
    handler: async () => ({
      data: await app.db.many(sql`
        SELECT i.id, i.email, i.role_ids, i.org_scope, i.expires_at, i.created_at, a.name AS invited_by_name
        FROM admin_invitations i LEFT JOIN admins a ON a.id = i.invited_by
        WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${app.clock.now()}
        ORDER BY i.created_at DESC
      `),
    }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/team/invitations/:id',
    auth: 'admin',
    permission: 'iam.admins.manage',
    summary: 'Revoke an invitation',
    tags: ['Team'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const n = await tx.exec(sql`UPDATE admin_invitations SET revoked_at = ${app.clock.now()} WHERE id = ${c.params.id} AND accepted_at IS NULL AND revoked_at IS NULL`);
        if (!n) throw notFound('Invitation');
        await c.audit(tx, 'admin.invitation_revoke', { type: 'admin_invitation', id: c.params.id });
      });
    },
  });

  // ---- Sessions across the team (security center) ---------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/team/sessions',
    auth: 'admin',
    permission: 'iam.admins.view',
    summary: 'Active administrator sessions across the team',
    tags: ['Team'],
    handler: async (c) => {
      const rows = await app.db.many<{ id: string }>(sql`
        SELECT s.id, s.admin_id, a.name AS admin_name, a.email AS admin_email, s.client, s.ip, s.user_agent, s.mfa_verified,
               s.created_at, s.last_seen_at, s.expires_at
        FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
        WHERE s.revoked_at IS NULL AND s.expires_at > ${app.clock.now()}
        ORDER BY s.last_seen_at DESC LIMIT 500
      `);
      return { data: rows.map((s) => ({ ...s, current: s.id === c.admin().sessionId })) };
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/team/sessions/:id',
    auth: 'admin',
    permission: 'iam.admins.manage',
    summary: 'Sign out a single administrator session',
    tags: ['Team'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const session = await tx.maybe<{ admin_id: string }>(sql`SELECT admin_id FROM admin_sessions WHERE id = ${c.params.id} AND revoked_at IS NULL`);
        if (!session) throw notFound('Session');
        await assertCanManage(tx, app, c.admin(), session.admin_id);
        await tx.exec(sql`UPDATE admin_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = 'revoked_by_admin' WHERE id = ${c.params.id} AND revoked_at IS NULL`);
        await c.audit(tx, 'admin.session_revoke', { type: 'admin', id: session.admin_id }, { sessionId: c.params.id });
      });
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/team/:id',
    auth: 'admin',
    permission: 'iam.admins.manage',
    sensitive: true,
    summary: 'Update an administrator (roles, status, data scope, IP restrictions)',
    tags: ['Team'],
    params: z.object({ id: z.string() }),
    body: z.object({
      name: z.string().trim().min(1).max(100).optional(),
      roleIds: z.array(z.string()).min(1).max(20).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      orgScope: orgScopeSchema.optional(),
      allowedIps: z.array(z.string()).max(50).optional(),
      unlock: z.boolean().optional(),
    }),
    handler: async (c) => {
      const me = c.admin();
      const b = c.body;
      if (b.allowedIps?.some((ip) => !isValidCidr(ip))) throw validationError([{ path: ['allowedIps'], message: 'Each entry must be an IP address or CIDR range' }]);
      if (c.params.id === me.adminId && (b.status === 'disabled' || b.roleIds)) {
        throw forbidden('You cannot change your own roles or disable yourself', 'self_modification');
      }
      return app.db.tx(async (tx) => {
        const before = await tx.maybe<any>(sql`SELECT * FROM admins WHERE id = ${c.params.id} FOR UPDATE`);
        if (!before) throw notFound('Administrator');
        // Editing someone who holds more power (or wider data access) than you is itself an escalation path.
        await assertCanManage(tx, app, me, c.params.id);
        if (b.orgScope !== undefined) assertScopeWithin(me.orgScope, b.orgScope);
        if (b.roleIds) {
          const granted = await rolePermissions(tx, b.roleIds);
          const check = app.permissions.canGrant(me.permissions, granted);
          if (!check.ok) throw forbidden(`You cannot grant permissions you do not hold: ${check.missing.slice(0, 5).join(', ')}`, 'privilege_escalation');
          await tx.exec(sql`DELETE FROM admin_roles WHERE admin_id = ${c.params.id}`);
          for (const roleId of b.roleIds) await tx.exec(sql`INSERT INTO admin_roles (admin_id, role_id) VALUES (${c.params.id}, ${roleId})`);
        }
        const patch = {
          name: b.name,
          status: b.status,
          org_scope: b.orgScope === undefined ? undefined : b.orgScope,
          allowed_ips: b.allowedIps,
          ...(b.unlock ? { locked_until: null, failed_login_count: 0 } : {}),
        };
        if (Object.values(patch).some((v) => v !== undefined)) {
          await tx.exec(sql`UPDATE admins SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${c.params.id}`);
        }
        if (b.status === 'disabled') await revokeAdminSessions(tx, app, c.params.id, 'disabled');
        await assertSuperAdminRemains(tx);
        await c.audit(tx, 'admin.update', { type: 'admin', id: c.params.id }, { changes: diff(before, patch), roleIds: b.roleIds });
        return { ok: true };
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/team/:id/reset-2fa',
    auth: 'admin',
    permission: 'iam.admins.manage',
    sensitive: true,
    summary: "Reset an administrator's two-factor authentication (they must re-enroll)",
    tags: ['Team'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        await assertCanManage(tx, app, c.admin(), c.params.id);
        const n = await tx.exec(sql`UPDATE admins SET totp_enabled = FALSE, totp_secret_enc = NULL, totp_pending_secret_enc = NULL, recovery_codes = '[]' WHERE id = ${c.params.id}`);
        if (!n) throw notFound('Administrator');
        await revokeAdminSessions(tx, app, c.params.id, '2fa_reset');
        await c.audit(tx, 'admin.2fa_reset', { type: 'admin', id: c.params.id });
        await raiseSecurityEvent(tx, app, { type: 'admin.2fa_reset', severity: 'warning', subjectType: 'admin', subjectId: c.params.id, ip: c.ip, details: { by: c.admin().adminId } });
      });
      return { ok: true };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/team/:id/revoke-sessions',
    auth: 'admin',
    permission: 'iam.admins.manage',
    summary: 'Sign an administrator out everywhere',
    tags: ['Team'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await assertCanManage(tx, app, c.admin(), c.params.id);
        const n = await revokeAdminSessions(tx, app, c.params.id, 'revoked_by_admin');
        await c.audit(tx, 'admin.sessions_revoke', { type: 'admin', id: c.params.id }, { count: n });
        return { revoked: n };
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/team/:id',
    auth: 'admin',
    permission: 'iam.admins.delete',
    sensitive: true,
    summary: 'Remove an administrator (disables the account and strips roles; audit history is kept)',
    tags: ['Team'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      if (c.params.id === c.admin().adminId) throw forbidden('You cannot remove yourself', 'self_modification');
      await app.db.tx(async (tx) => {
        await assertCanManage(tx, app, c.admin(), c.params.id);
        const n = await tx.exec(sql`UPDATE admins SET status = 'disabled', updated_at = ${app.clock.now()} WHERE id = ${c.params.id}`);
        if (!n) throw notFound('Administrator');
        await tx.exec(sql`DELETE FROM admin_roles WHERE admin_id = ${c.params.id}`);
        await revokeAdminSessions(tx, app, c.params.id, 'removed');
        await assertSuperAdminRemains(tx);
        await c.audit(tx, 'admin.remove', { type: 'admin', id: c.params.id });
      });
    },
  });

  // ---- Roles --------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/permissions',
    auth: 'admin',
    permission: 'iam.roles.view',
    summary: 'Permission catalog',
    tags: ['Roles'],
    handler: () => ({ data: app.permissions.list() }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/roles',
    auth: 'admin',
    permission: 'iam.roles.view',
    summary: 'List roles',
    tags: ['Roles'],
    handler: async () => ({
      data: await app.db.many(sql`
        SELECT r.*, (SELECT count(*)::int FROM admin_roles ar JOIN admins a ON a.id = ar.admin_id WHERE ar.role_id = r.id AND a.status = 'active') AS admin_count
        FROM roles r ORDER BY r.is_system DESC, r.name
      `),
    }),
  });

  const roleBody = z.object({
    key: keySlug.optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(''),
    permissions: z.array(z.string().max(100)).max(500),
    limits: z.record(z.string(), z.number()).default({}),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/roles',
    auth: 'admin',
    permission: 'iam.roles.manage',
    summary: 'Create a custom role',
    tags: ['Roles'],
    body: roleBody,
    handler: async (c) => {
      const me = c.admin();
      const unknown = app.permissions.validatePatterns(c.body.permissions);
      if (unknown.length) throw validationError([{ path: ['permissions'], message: `Unknown permissions: ${unknown.join(', ')}` }]);
      const check = app.permissions.canGrant(me.permissions, c.body.permissions);
      if (!check.ok) throw forbidden(`You cannot grant permissions you do not hold: ${check.missing.slice(0, 5).join(', ')}`, 'privilege_escalation');
      const key = c.body.key ?? c.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
      return app.db.tx(async (tx) => {
        const exists = await tx.maybe(sql`SELECT 1 FROM roles WHERE key = ${key}`);
        if (exists) throw conflict('A role with this key already exists', 'role_exists');
        const now = app.clock.now();
        const role = await tx.one(sql.insert('roles', {
          id: newId('role'),
          key,
          name: c.body.name,
          description: c.body.description,
          permissions: c.body.permissions,
          limits: c.body.limits,
          is_system: false,
          created_at: now,
          updated_at: now,
        }));
        await c.audit(tx, 'role.create', { type: 'role', id: role.id }, { permissions: c.body.permissions });
        return role;
      });
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/roles/:id',
    auth: 'admin',
    permission: 'iam.roles.manage',
    sensitive: true,
    summary: 'Update a custom role',
    tags: ['Roles'],
    params: z.object({ id: z.string() }),
    body: roleBody.partial(),
    handler: async (c) => {
      const me = c.admin();
      if (c.body.permissions) {
        const unknown = app.permissions.validatePatterns(c.body.permissions);
        if (unknown.length) throw validationError([{ path: ['permissions'], message: `Unknown permissions: ${unknown.join(', ')}` }]);
        const check = app.permissions.canGrant(me.permissions, c.body.permissions);
        if (!check.ok) throw forbidden(`You cannot grant permissions you do not hold: ${check.missing.slice(0, 5).join(', ')}`, 'privilege_escalation');
      }
      return app.db.tx(async (tx) => {
        const role = await tx.maybe<any>(sql`SELECT * FROM roles WHERE id = ${c.params.id} FOR UPDATE`);
        if (!role) throw notFound('Role');
        if (role.is_system) throw forbidden('System roles cannot be edited. Clone the role to customize it.', 'system_role');
        const patch = { name: c.body.name, description: c.body.description, permissions: c.body.permissions, limits: c.body.limits };
        const updated = await tx.one(sql`UPDATE roles SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${role.id} RETURNING *`);
        await assertSuperAdminRemains(tx);
        await c.audit(tx, 'role.update', { type: 'role', id: role.id }, { changes: diff(role, patch) });
        return updated;
      });
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/roles/:id',
    auth: 'admin',
    permission: 'iam.roles.manage',
    sensitive: true,
    summary: 'Delete a custom role (must not be assigned)',
    tags: ['Roles'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const role = await tx.maybe<any>(sql`SELECT * FROM roles WHERE id = ${c.params.id}`);
        if (!role) throw notFound('Role');
        if (role.is_system) throw forbidden('System roles cannot be deleted', 'system_role');
        const assigned = await tx.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM admin_roles WHERE role_id = ${role.id}`);
        if (assigned.count) throw conflict(`This role is assigned to ${assigned.count} administrator(s). Reassign them first.`, 'role_in_use');
        await tx.exec(sql`DELETE FROM roles WHERE id = ${role.id}`);
        await c.audit(tx, 'role.delete', { type: 'role', id: role.id }, { key: role.key });
      });
    },
  });

  // ---- Approvals (separation of duties) --------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/approvals',
    auth: 'admin',
    permission: 'iam.approvals.view',
    summary: 'Approval requests',
    tags: ['Approvals'],
    query: z.object({ ...pageQuery, status: z.enum(['pending', 'approved', 'rejected', 'executed', 'failed', 'expired']).optional() }),
    handler: async (c) => {
      const page = await paginate<any>(app.db, {
        select: sql`ar.*, req.name AS requested_by_name, dec.name AS decided_by_name`,
        from: sql`approval_requests ar JOIN admins req ON req.id = ar.requested_by LEFT JOIN admins dec ON dec.id = ar.decided_by`,
        where: sql.where([c.query.status && sql`ar.status = ${c.query.status}`]),
        orderBy: sql`ORDER BY ar.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      const me = c.admin();
      return {
        ...page,
        data: page.data.map((a) => ({
          ...a,
          canDecide: a.status === 'pending' && a.requested_by !== me.adminId && isAllowed(me.permissions, a.approve_permission),
        })),
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/approvals/:id/:decision',
    auth: 'admin',
    permission: 'iam.approvals.view',
    sensitive: true,
    summary: 'Approve (and execute) or reject a pending request',
    tags: ['Approvals'],
    params: z.object({ id: z.string(), decision: z.enum(['approve', 'reject']) }),
    body: z.object({ note: z.string().max(1000).optional() }),
    handler: async (c) => {
      const me = c.admin();
      return app.db.tx(async (tx) => {
        const req = await tx.maybe<any>(sql`SELECT * FROM approval_requests WHERE id = ${c.params.id} FOR UPDATE`);
        if (!req) throw notFound('Approval request');
        if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`, 'approval_decided');
        if (req.expires_at <= app.clock.now()) throw conflict('This request has expired', 'approval_expired');
        if (req.requested_by === me.adminId) throw forbidden('You cannot approve your own request', 'separation_of_duties');
        if (!isAllowed(me.permissions, req.approve_permission)) throw forbidden(`Approving requires the ${req.approve_permission} permission`);
        const now = app.clock.now();
        if (c.params.decision === 'reject') {
          await tx.exec(sql`UPDATE approval_requests SET status = 'rejected', decided_by = ${me.adminId}, decided_at = ${now}, decision_note = ${c.body.note ?? null} WHERE id = ${req.id}`);
          await c.audit(tx, 'approval.reject', { type: 'approval_request', id: req.id }, { action: req.action, note: c.body.note });
          return { status: 'rejected' };
        }
        const executor = approvalExecutor(app, req.action);
        if (!executor) throw new AppError(500, 'executor_missing', `No executor for ${req.action}`);
        try {
          const result = await tx.tx((inner) => executor.execute(inner, app, req.payload, c.actor));
          await tx.exec(sql`
            UPDATE approval_requests SET status = 'executed', decided_by = ${me.adminId}, decided_at = ${now},
              decision_note = ${c.body.note ?? null}, result = ${sql.json(result ?? {})} WHERE id = ${req.id}
          `);
          await c.audit(tx, 'approval.approve', { type: 'approval_request', id: req.id }, { action: req.action, note: c.body.note });
          return { status: 'executed', result: result ?? null };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await tx.exec(sql`
            UPDATE approval_requests SET status = 'failed', decided_by = ${me.adminId}, decided_at = ${now}, error = ${message} WHERE id = ${req.id}
          `);
          await c.audit(tx, 'approval.execute_failed', { type: 'approval_request', id: req.id }, { action: req.action, error: message });
          return { status: 'failed', error: message };
        }
      });
    },
  });
}
