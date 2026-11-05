import { z } from 'zod';
import type { Router, RouteContext } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql, type Fragment, type Sql } from '../../core/sql.js';
import { forbidden, notFound, validationError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { likePattern, pageQuery, paginate, qDate, qList } from '../../core/validation.js';
import { toCsv } from '../../core/csv.js';
import { DAY } from '../../core/clock.js';
import {
  USER_COLUMNS,
  anonymizeUser,
  createUser,
  exportUserData,
  getUser,
  restoreUser,
  revokeUserSessions,
  setUserStatus,
  softDeleteUser,
  startImpersonation,
  updateUser,
  userInputSchema,
  userScopeSql,
  type UserRow,
} from './service.js';
import { sendSystemEmail } from '../core/mail.js';
import { writeAudit } from '../../core/audit.js';
import { archiveUser, unarchiveUser } from './archive.js';

export interface UserListFilterContext {
  query: Record<string, any>;
}

/** Hook payload: other modules enrich directory rows (current plan, revenue) in one batch. */
export interface UserEnrichContext {
  app: App;
  ids: string[];
}

const listQuery = z.object({
  ...pageQuery,
  q: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'suspended', 'banned', 'pending', 'deleted']).optional(),
  tag: z.string().max(50).optional(),
  orgId: z.string().optional(),
  country: z.string().length(2).optional(),
  source: z.string().max(100).optional(),
  verified: z.enum(['true', 'false']).optional(),
  createdFrom: qDate.optional(),
  createdTo: qDate.optional(),
  activeWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
  inactiveForDays: z.coerce.number().int().min(1).max(3650).optional(),
  plan: z.string().max(100).optional(),
  subscriptionStatus: z.string().max(30).optional(),
  /** Archived (long-inactive) customers are hidden unless asked for. */
  archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
  sort: z.enum(['created_at', 'last_active_at', 'email', 'name', 'lifetime_revenue']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
type ListQuery = z.infer<typeof listQuery>;

const SORTS: Record<ListQuery['sort'], string> = {
  created_at: 'u.created_at',
  last_active_at: 'u.last_active_at',
  email: 'lower(u.email)',
  name: 'lower(u.name)',
  lifetime_revenue: 'u.lifetime_revenue',
};

async function userConditions(app: App, q: ListQuery, scope: string[] | null): Promise<Fragment[]> {
  const now = app.clock.now().getTime();
  const extra = await app.hooks.apply<Sql[], UserListFilterContext>('customers.users.filters', [], { query: q });
  return [
    q.status === 'deleted' ? sql`u.deleted_at IS NOT NULL` : sql`u.deleted_at IS NULL`,
    q.status && q.status !== 'deleted' && sql`u.status = ${q.status}`,
    q.status !== 'deleted' && q.archived === 'exclude' && sql`u.archived_at IS NULL`,
    q.status !== 'deleted' && q.archived === 'only' && sql`u.archived_at IS NOT NULL`,
    q.q &&
      sql`(u.email ILIKE ${likePattern(q.q)} OR u.name ILIKE ${likePattern(q.q)} OR u.id = ${q.q} OR u.external_id = ${q.q} OR u.phone ILIKE ${likePattern(q.q)})`,
    q.tag && sql`u.tags ? ${q.tag}`,
    q.orgId && sql`EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id = u.id AND mm.org_id = ${q.orgId})`,
    q.country && sql`u.country = ${q.country.toUpperCase()}`,
    q.source && sql`u.registration_source = ${q.source}`,
    q.verified && (q.verified === 'true' ? sql`u.email_verified_at IS NOT NULL` : sql`u.email_verified_at IS NULL`),
    q.createdFrom && sql`u.created_at >= ${q.createdFrom}`,
    q.createdTo && sql`u.created_at <= ${q.createdTo}`,
    q.activeWithinDays && sql`u.last_active_at >= ${new Date(now - q.activeWithinDays * DAY)}`,
    q.inactiveForDays && sql`(u.last_active_at IS NULL OR u.last_active_at < ${new Date(now - q.inactiveForDays * DAY)})`,
    userScopeSql(scope),
    ...extra,
  ];
}

async function enrich(app: App, rows: UserRow[]): Promise<Record<string, unknown>[]> {
  if (!rows.length) return [];
  const extra = await app.hooks.apply<Record<string, Record<string, unknown>>, UserEnrichContext>('customers.users.enrich', {}, { app, ids: rows.map((r) => r.id) });
  return rows.map((r) => ({ ...r, ...(extra[r.id] ?? {}) }));
}

function scopeOf(c: RouteContext): string[] | null {
  return c.orgScope();
}

export function registerUserRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/users',
    auth: 'admin',
    permission: 'customers.users.view',
    summary: 'User directory with search, filters, sorting and pagination',
    tags: ['Users'],
    query: listQuery,
    handler: async (c) => {
      const page = await paginate<UserRow>(app.db, {
        select: USER_COLUMNS,
        from: sql`users u`,
        where: sql.where(await userConditions(app, c.query, scopeOf(c))),
        orderBy: sql.orderBy(c.query.sort, c.query.order, SORTS),
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      return { ...page, data: await enrich(app, page.data) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/export.csv',
    auth: 'admin',
    permission: 'customers.users.export',
    summary: 'Export the filtered user directory as CSV',
    tags: ['Users'],
    query: listQuery.omit({ page: true, pageSize: true }),
    handler: async (c) => {
      const q = { ...c.query, page: 1, pageSize: 50_000 } as ListQuery;
      const rows = await app.db.many<UserRow>(sql`
        SELECT ${USER_COLUMNS} FROM users u ${sql.where(await userConditions(app, q, scopeOf(c)))}
        ${sql.orderBy(q.sort, q.order, SORTS)} LIMIT 50000
      `);
      const enriched = await enrich(app, rows);
      await writeAudit(app.db, app, { actor: c.actor, action: 'user.export_csv', metadata: { count: rows.length, filters: c.query } });
      const csv = toCsv(enriched, [
        { header: 'id', value: (r) => r.id },
        { header: 'external_id', value: (r) => r.external_id },
        { header: 'email', value: (r) => r.email },
        { header: 'name', value: (r) => r.name },
        { header: 'status', value: (r) => r.status },
        { header: 'plan', value: (r) => (r.plan as any)?.name ?? '' },
        { header: 'lifetime_revenue', value: (r) => r.lifetime_revenue },
        { header: 'country', value: (r) => r.country },
        { header: 'tags', value: (r) => (r.tags as string[]).join('|') },
        { header: 'registration_source', value: (r) => r.registration_source },
        { header: 'created_at', value: (r) => r.created_at },
        { header: 'last_active_at', value: (r) => r.last_active_at },
        { header: 'archived_at', value: (r) => r.archived_at },
      ]);
      return c.reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`)
        .send(csv);
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users',
    auth: 'admin',
    permission: 'customers.users.create',
    summary: 'Create a user',
    tags: ['Users'],
    body: userInputSchema.extend({ orgId: z.string().optional() }),
    handler: async (c) => {
      const { orgId, ...input } = c.body;
      const scope = scopeOf(c);
      if (scope && (!orgId || !scope.includes(orgId))) throw forbidden('Choose an organization you manage for this user', 'org_scope');
      return app.db.tx((tx) => createUser(tx, app, input, c.actor, { orgId }));
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/:id',
    auth: 'admin',
    permission: 'customers.users.view',
    summary: 'User profile with organizations and module panels',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, scopeOf(c), { includeDeleted: true });
      const [orgs, notesCount, sessions, impersonation, mergedInto, mergedFrom] = await Promise.all([
        app.db.many(sql`
          SELECT o.id, o.name, o.slug, m.role, m.status, m.created_at FROM memberships m JOIN organizations o ON o.id = m.org_id
          WHERE m.user_id = ${user.id} AND o.deleted_at IS NULL ORDER BY o.name
        `),
        app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM user_notes WHERE user_id = ${user.id}`),
        app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM user_sessions WHERE user_id = ${user.id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${app.clock.now()})`),
        app.db.maybe(sql`SELECT id, admin_id, expires_at, read_only FROM impersonations WHERE user_id = ${user.id} AND ended_at IS NULL AND expires_at > ${app.clock.now()} ORDER BY started_at DESC LIMIT 1`),
        user.merged_into_id ? app.db.maybe(sql`SELECT id, email, name FROM users WHERE id = ${user.merged_into_id}`) : null,
        app.db.many(sql`
          SELECT m.id, m.source_id, u.email, u.name, m.created_at FROM user_merges m JOIN users u ON u.id = m.source_id
          WHERE m.target_id = ${user.id} ORDER BY m.created_at DESC LIMIT 20
        `),
      ]);
      const [enriched] = await enrich(app, [user]);
      const panels = await app.hooks.apply<Record<string, unknown>>('customers.user.profile', {}, { app, user, permissions: c.admin().permissions });
      return { ...enriched, organizations: orgs, notesCount: notesCount.count, activeSessions: sessions.count, activeImpersonation: impersonation, mergedInto, mergedFrom, panels };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/users/:id',
    auth: 'admin',
    permission: 'customers.users.edit',
    summary: 'Update a user profile, tags or custom fields',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: userInputSchema.omit({ status: true, emailVerified: true }).partial(),
    handler: async (c) => app.db.tx((tx) => updateUser(tx, app, c.params.id, c.body, c.actor, scopeOf(c))),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/status',
    auth: 'admin',
    permission: 'customers.users.suspend',
    summary: 'Suspend, ban or reactivate a user',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ action: z.enum(['suspend', 'ban', 'reactivate']), reason: z.string().max(1000).optional(), until: z.coerce.date().optional() }),
    handler: async (c) => {
      if (c.body.action === 'ban' && !c.can('customers.users.ban')) throw forbidden('Banning users requires the customers.users.ban permission');
      if (c.body.action !== 'reactivate' && !c.body.reason) throw validationError([{ path: ['reason'], message: 'Give a reason; it is recorded in the audit log' }]);
      return app.db.tx((tx) => setUserStatus(tx, app, c.params.id, c.body.action, { reason: c.body.reason, until: c.body.until }, c.actor, scopeOf(c)));
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/archive',
    auth: 'admin',
    permission: 'customers.users.edit',
    summary: 'Archive a customer: hidden from the default directory views, still able to sign in (which restores them)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ reason: z.string().trim().max(500).optional() }),
    handler: async (c) => app.db.tx((tx) => archiveUser(tx, app, c.params.id, c.body.reason || 'manual', c.actor, scopeOf(c))),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/unarchive',
    auth: 'admin',
    permission: 'customers.users.edit',
    summary: 'Restore an archived customer to the directory',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => app.db.tx((tx) => unarchiveUser(tx, app, c.params.id, 'restored_by_admin', c.actor, scopeOf(c))),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/verify-email',
    auth: 'admin',
    permission: 'customers.users.edit',
    summary: 'Mark the email address as verified',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getUser(tx, c.params.id, scopeOf(c));
        await tx.exec(sql`UPDATE users SET email_verified_at = coalesce(email_verified_at, ${app.clock.now()}), updated_at = ${app.clock.now()} WHERE id = ${c.params.id}`);
        await c.audit(tx, 'user.verify_email', { type: 'user', id: c.params.id });
        await app.events.emit(tx, 'user.email_verified', { userId: c.params.id }, { userId: c.params.id });
        return getUser(tx, c.params.id, null);
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/password-reset',
    auth: 'admin',
    permission: 'customers.users.edit',
    summary: 'Send a secure password reset (built-in identity) or notify the app (external auth)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const user = await getUser(tx, c.params.id, scopeOf(c));
        const issue = app.services['identity.issuePasswordReset'] as ((db: typeof tx, userId: string) => Promise<string>) | undefined;
        let mode: 'email' | 'webhook';
        if (issue && app.modules.isEnabled('identity')) {
          await issue(tx, user.id);
          mode = 'email';
        } else {
          await app.events.emit(tx, 'user.password_reset_requested', { userId: user.id, email: user.email, requestedBy: 'admin' }, { userId: user.id });
          mode = 'webhook';
        }
        await c.audit(tx, 'user.password_reset', { type: 'user', id: user.id }, { mode });
        return { ok: true, mode };
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/sessions',
    auth: 'admin',
    permission: 'customers.sessions.view',
    summary: 'Active and recent sessions',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await getUser(app.db, c.params.id, scopeOf(c), { includeDeleted: true });
      return {
        data: await app.db.many(sql`
          SELECT id, ip, user_agent, country, impersonator_admin_id, created_at, last_seen_at, expires_at, revoked_at, revoked_reason
          FROM user_sessions WHERE user_id = ${c.params.id} ORDER BY created_at DESC LIMIT 100
        `),
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/revoke-sessions',
    auth: 'admin',
    permission: 'customers.sessions.revoke',
    summary: 'Sign the user out everywhere',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getUser(tx, c.params.id, scopeOf(c));
        return { revoked: await revokeUserSessions(tx, app, c.params.id, 'revoked_by_admin', c.actor) };
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/login-events',
    auth: 'admin',
    permission: 'customers.users.view',
    summary: 'Login history and IP addresses',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    query: z.object(pageQuery),
    handler: async (c) => {
      await getUser(app.db, c.params.id, scopeOf(c), { includeDeleted: true });
      return paginate(app.db, {
        select: sql`id, success, failure_reason, method, ip, user_agent, country, created_at`,
        from: sql`login_events`,
        where: sql`WHERE subject_type = 'user' AND subject_id = ${c.params.id}`,
        orderBy: sql`ORDER BY created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/users/:id',
    auth: 'admin',
    permission: 'customers.users.delete',
    sensitive: true,
    summary: 'Soft-delete a user (restorable)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx((tx) => softDeleteUser(tx, app, c.params.id, c.actor, scopeOf(c)));
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/restore',
    auth: 'admin',
    permission: 'customers.users.delete',
    summary: 'Restore a soft-deleted user',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => app.db.tx((tx) => restoreUser(tx, app, c.params.id, c.actor, scopeOf(c))),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/anonymize',
    auth: 'admin',
    permission: 'customers.users.delete',
    sensitive: true,
    summary: 'Erase personal data (right to erasure). Irreversible.',
    tags: ['Users', 'Privacy'],
    params: z.object({ id: z.string() }),
    body: z.object({ confirm: z.literal('ERASE') }),
    handler: async (c) => {
      await app.db.tx((tx) => anonymizeUser(tx, app, c.params.id, c.actor, scopeOf(c)));
      return { ok: true };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/export',
    auth: 'admin',
    permission: 'customers.users.export',
    summary: 'Download everything stored about this user (JSON)',
    tags: ['Users', 'Privacy'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const data = await exportUserData(app.db, app, c.params.id, scopeOf(c));
      await writeAudit(app.db, app, { actor: c.actor, action: 'user.export_data', targetType: 'user', targetId: c.params.id });
      return c.reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="user-${c.params.id}.json"`)
        .send(JSON.stringify(data, null, 2));
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/impersonate',
    auth: 'admin',
    permission: 'customers.users.impersonate',
    sensitive: true,
    summary: 'Start an audited, time-limited impersonation session',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ reason: z.string().trim().min(10, 'Explain why (at least 10 characters)').max(500), readOnly: z.boolean().default(true) }),
    handler: async (c) =>
      app.db.tx((tx) =>
        startImpersonation(tx, app, { adminId: c.admin().adminId, userId: c.params.id, reason: c.body.reason, readOnly: c.body.readOnly, ip: c.ip }, c.actor, scopeOf(c)),
      ),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/impersonations',
    auth: 'admin',
    permission: 'customers.users.impersonate',
    summary: 'Impersonation history',
    tags: ['Users'],
    query: z.object({ ...pageQuery, active: z.enum(['true', 'false']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`i.id, i.admin_id, a.name AS admin_name, i.user_id, u.email AS user_email, i.reason, i.read_only, i.started_at, i.expires_at, i.consumed_at, i.ended_at, i.ended_reason`,
        from: sql`impersonations i JOIN users u ON u.id = i.user_id LEFT JOIN admins a ON a.id = i.admin_id`,
        where: sql.where([c.query.active === 'true' && sql`i.ended_at IS NULL AND i.expires_at > ${app.clock.now()}`, userScopeSql(scopeOf(c))]),
        orderBy: sql`ORDER BY i.started_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/impersonations/:id/end',
    auth: 'admin',
    permission: 'customers.users.impersonate',
    summary: 'End an impersonation session',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.maybe<{ user_id: string }>(sql`
          UPDATE impersonations SET ended_at = ${app.clock.now()}, ended_reason = 'ended_by_admin' WHERE id = ${c.params.id} AND ended_at IS NULL RETURNING user_id
        `);
        if (!row) throw notFound('Active impersonation');
        await tx.exec(sql`UPDATE user_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = 'impersonation_ended' WHERE user_id = ${row.user_id} AND impersonator_admin_id IS NOT NULL AND revoked_at IS NULL`);
        await c.audit(tx, 'user.impersonate_end', { type: 'user', id: row.user_id }, { impersonationId: c.params.id });
        await app.events.emit(tx, 'user.impersonation_ended', { userId: row.user_id, impersonationId: c.params.id }, { userId: row.user_id });
        return { ok: true };
      }),
  });

  // ---- Notes ---------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/notes',
    auth: 'admin',
    permission: 'customers.notes.view',
    summary: 'Internal notes about a user',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await getUser(app.db, c.params.id, scopeOf(c), { includeDeleted: true });
      return {
        data: await app.db.many(sql`
          SELECT n.*, a.name AS admin_name FROM user_notes n LEFT JOIN admins a ON a.id = n.admin_id
          WHERE n.user_id = ${c.params.id} ORDER BY n.pinned DESC, n.created_at DESC
        `),
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/notes',
    auth: 'admin',
    permission: 'customers.notes.manage',
    summary: 'Add an internal note',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ body: z.string().trim().min(1).max(10_000), pinned: z.boolean().default(false) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getUser(tx, c.params.id, scopeOf(c));
        const now = app.clock.now();
        const note = await tx.one(sql.insert('user_notes', { id: newId('note'), user_id: c.params.id, admin_id: c.admin().adminId, body: c.body.body, pinned: c.body.pinned, created_at: now, updated_at: now }));
        await c.audit(tx, 'user.note_add', { type: 'user', id: c.params.id }, { noteId: note.id });
        return note;
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/notes/:id',
    auth: 'admin',
    permission: 'customers.notes.manage',
    summary: 'Edit or pin a note',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ body: z.string().trim().min(1).max(10_000).optional(), pinned: z.boolean().optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const note = await tx.maybe<{ user_id: string }>(sql`SELECT user_id FROM user_notes WHERE id = ${c.params.id}`);
        if (!note) throw notFound('Note');
        await getUser(tx, note.user_id, scopeOf(c), { includeDeleted: true });
        return tx.one(sql`UPDATE user_notes SET ${sql.set({ body: c.body.body, pinned: c.body.pinned, updated_at: app.clock.now() })} WHERE id = ${c.params.id} RETURNING *`);
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/notes/:id',
    auth: 'admin',
    permission: 'customers.notes.manage',
    summary: 'Delete a note',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const note = await tx.maybe<{ user_id: string }>(sql`SELECT user_id FROM user_notes WHERE id = ${c.params.id}`);
        if (!note) throw notFound('Note');
        await getUser(tx, note.user_id, scopeOf(c), { includeDeleted: true });
        await tx.exec(sql`DELETE FROM user_notes WHERE id = ${c.params.id}`);
        await c.audit(tx, 'user.note_delete', { type: 'user', id: note.user_id }, { noteId: c.params.id });
      });
    },
  });

  // ---- Timeline ---------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/timeline',
    auth: 'admin',
    permission: 'customers.users.view',
    summary: 'Unified customer timeline: account, billing, support, usage and admin actions',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    query: z.object({ before: qDate.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    handler: async (c) => {
      await getUser(app.db, c.params.id, scopeOf(c), { includeDeleted: true });
      const before = c.query.before ?? new Date(app.clock.now().getTime() + 1000);
      const id = c.params.id;
      const rows = await app.db.many<any>(sql`
        (SELECT 'event' AS kind, id, type AS title, data AS detail, created_at FROM events WHERE user_id = ${id} AND created_at < ${before})
        UNION ALL
        (SELECT 'admin_action', id, action, jsonb_build_object('actor', actor_label, 'metadata', metadata), created_at FROM audit_logs
          WHERE target_type = 'user' AND target_id = ${id} AND created_at < ${before})
        UNION ALL
        (SELECT 'login', id, CASE WHEN success THEN 'login.success' ELSE 'login.failed' END, jsonb_build_object('ip', ip, 'country', country, 'reason', failure_reason), created_at
          FROM login_events WHERE subject_type = 'user' AND subject_id = ${id} AND created_at < ${before})
        UNION ALL
        (SELECT 'note', id, 'note', jsonb_build_object('body', body), created_at FROM user_notes WHERE user_id = ${id} AND created_at < ${before})
        ORDER BY created_at DESC LIMIT ${c.query.limit}
      `);
      return { data: rows };
    },
  });

  // ---- Bulk actions ----------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/admin/users/bulk',
    auth: 'admin',
    permission: 'customers.users.edit',
    summary: 'Apply an action to many users',
    tags: ['Users'],
    body: z.object({
      ids: z.array(z.string()).min(1).max(1000),
      action: z.enum(['suspend', 'reactivate', 'ban', 'delete', 'tag', 'untag', 'revoke_sessions', 'archive', 'unarchive']),
      tag: z.string().trim().min(1).max(50).optional(),
      reason: z.string().max(1000).optional(),
    }),
    handler: async (c) => {
      const { ids, action, tag, reason } = c.body;
      const required: Record<string, string> = {
        suspend: 'customers.users.suspend',
        reactivate: 'customers.users.suspend',
        ban: 'customers.users.ban',
        delete: 'customers.users.delete',
        revoke_sessions: 'customers.sessions.revoke',
        tag: 'customers.users.edit',
        untag: 'customers.users.edit',
        archive: 'customers.users.edit',
        unarchive: 'customers.users.edit',
      };
      if (!c.can(required[action])) throw forbidden(`This bulk action requires ${required[action]}`);
      if ((action === 'tag' || action === 'untag') && !tag) throw validationError([{ path: ['tag'], message: 'Tag is required' }]);
      if ((action === 'suspend' || action === 'ban') && !reason) throw validationError([{ path: ['reason'], message: 'Reason is required' }]);
      const scope = scopeOf(c);
      const results: { id: string; ok: boolean; error?: string }[] = [];
      for (const id of ids) {
        try {
          await app.db.tx(async (tx) => {
            if (action === 'suspend' || action === 'ban' || action === 'reactivate') await setUserStatus(tx, app, id, action, { reason }, c.actor, scope);
            else if (action === 'delete') await softDeleteUser(tx, app, id, c.actor, scope);
            else if (action === 'archive') await archiveUser(tx, app, id, reason || 'manual', c.actor, scope);
            else if (action === 'unarchive') await unarchiveUser(tx, app, id, 'restored_by_admin', c.actor, scope);
            else if (action === 'revoke_sessions') {
              await getUser(tx, id, scope);
              await revokeUserSessions(tx, app, id, 'revoked_by_admin', c.actor);
            } else {
              const user = await getUser(tx, id, scope);
              const tags = action === 'tag' ? [...new Set([...user.tags, tag!])] : user.tags.filter((t) => t !== tag);
              await updateUser(tx, app, id, { tags }, c.actor, scope);
            }
          });
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: ids.length };
    },
  });

  // ---- Custom fields -------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/custom-fields',
    auth: 'admin',
    permission: 'customers.users.view',
    summary: 'Custom field definitions',
    tags: ['Users'],
    query: z.object({ entity: z.enum(['user', 'organization']).optional() }),
    handler: async (c) => ({
      data: await app.db.many(sql`SELECT * FROM custom_field_defs ${c.query.entity ? sql`WHERE entity = ${c.query.entity}` : sql.empty} ORDER BY entity, position, label`),
    }),
  });

  const fieldBody = z.object({
    entity: z.enum(['user', 'organization']),
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Lowercase letters, digits and underscores'),
    label: z.string().trim().min(1).max(80),
    type: z.enum(['text', 'number', 'boolean', 'select', 'date', 'url']),
    options: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
    required: z.boolean().default(false),
    showInList: z.boolean().default(false),
    position: z.number().int().default(0),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/custom-fields',
    auth: 'admin',
    permission: 'customers.fields.manage',
    summary: 'Define a custom field',
    tags: ['Users'],
    body: fieldBody,
    handler: async (c) => {
      if (c.body.type === 'select' && !c.body.options.length) throw validationError([{ path: ['options'], message: 'Select fields need options' }]);
      return app.db.tx(async (tx) => {
        const row = await tx.one(sql.insert('custom_field_defs', {
          id: newId('cfd'),
          entity: c.body.entity,
          key: c.body.key,
          label: c.body.label,
          type: c.body.type,
          options: c.body.options,
          required: c.body.required,
          show_in_list: c.body.showInList,
          position: c.body.position,
          created_at: app.clock.now(),
        }));
        await c.audit(tx, 'custom_field.create', { type: 'custom_field', id: row.id }, c.body);
        return row;
      });
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/custom-fields/:id',
    auth: 'admin',
    permission: 'customers.fields.manage',
    summary: 'Update a custom field',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: fieldBody.omit({ entity: true, key: true, type: true }).partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.maybe(sql`
          UPDATE custom_field_defs SET ${sql.set({ label: c.body.label, options: c.body.options, required: c.body.required, show_in_list: c.body.showInList, position: c.body.position })}
          WHERE id = ${c.params.id} RETURNING *
        `);
        if (!row) throw notFound('Custom field');
        await c.audit(tx, 'custom_field.update', { type: 'custom_field', id: c.params.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/custom-fields/:id',
    auth: 'admin',
    permission: 'customers.fields.manage',
    summary: 'Delete a custom field definition (stored values are kept)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const n = await tx.exec(sql`DELETE FROM custom_field_defs WHERE id = ${c.params.id}`);
        if (!n) throw notFound('Custom field');
        await c.audit(tx, 'custom_field.delete', { type: 'custom_field', id: c.params.id });
      });
    },
  });

  // ---- Privacy requests ------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/privacy-requests',
    auth: 'admin',
    permission: 'customers.privacy.manage',
    summary: 'Data export and deletion requests',
    tags: ['Privacy'],
    query: z.object({ ...pageQuery, status: z.enum(['pending', 'processing', 'completed', 'rejected']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`*`,
        from: sql`privacy_requests`,
        where: sql.where([c.query.status && sql`status = ${c.query.status}`]),
        orderBy: sql`ORDER BY created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/privacy-requests',
    auth: 'admin',
    permission: 'customers.privacy.manage',
    summary: 'Log a data export or deletion request',
    tags: ['Privacy'],
    body: z.object({ userId: z.string(), type: z.enum(['export', 'delete']), notes: z.string().max(2000).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const user = await getUser(tx, c.body.userId, scopeOf(c), { includeDeleted: true });
        const days = app.settings.get<{ privacyRequestDueDays: number }>('customers').privacyRequestDueDays;
        const row = await tx.one(sql.insert('privacy_requests', {
          id: newId('prq'),
          user_id: user.id,
          email: user.email,
          type: c.body.type,
          status: 'pending',
          source: 'admin',
          requested_by: c.admin().adminId,
          notes: c.body.notes ?? null,
          due_at: new Date(app.clock.now().getTime() + days * DAY),
          created_at: app.clock.now(),
        }));
        await c.audit(tx, `privacy.${c.body.type}_request`, { type: 'user', id: user.id }, { requestId: row.id });
        return row;
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/privacy-requests/:id/:action',
    auth: 'admin',
    permission: 'customers.privacy.manage',
    sensitive: true,
    summary: 'Fulfil (export / erase) or reject a privacy request',
    tags: ['Privacy'],
    params: z.object({ id: z.string(), action: z.enum(['complete', 'reject']) }),
    body: z.object({ notes: z.string().max(2000).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const req = await tx.maybe<any>(sql`SELECT * FROM privacy_requests WHERE id = ${c.params.id} FOR UPDATE`);
        if (!req || (req.status !== 'pending' && req.status !== 'processing')) throw notFound('Open privacy request');
        let fileId: string | null = null;
        if (c.params.action === 'complete') {
          if (req.type === 'delete') await anonymizeUser(tx, app, req.user_id, c.actor, scopeOf(c));
          else {
            const data = Buffer.from(JSON.stringify(await exportUserData(tx, app, req.user_id, scopeOf(c)), null, 2));
            fileId = newId('file');
            const stored = await app.storage.put(`privacy/${req.user_id}/${fileId}.json`, data);
            await tx.exec(sql.insert('files', {
              id: fileId,
              owner_type: 'privacy_request',
              owner_id: req.id,
              filename: `user-${req.user_id}.json`,
              content_type: 'application/json',
              size: stored.size,
              sha256: stored.sha256,
              storage_key: stored.key,
              uploaded_by_type: 'admin',
              uploaded_by_id: c.admin().adminId,
              created_at: app.clock.now(),
            }, ''));
            await sendSystemEmail(app, tx, { to: req.email, template: 'privacy.export_ready', data: { requestId: req.id }, userId: req.user_id, category: 'security' });
          }
        }
        const row = await tx.one(sql`
          UPDATE privacy_requests SET status = ${c.params.action === 'complete' ? 'completed' : 'rejected'}, file_id = ${fileId},
            notes = coalesce(${c.body.notes ?? null}, notes), completed_at = ${app.clock.now()} WHERE id = ${req.id} RETURNING *
        `);
        await c.audit(tx, `privacy.request_${c.params.action}`, { type: 'user', id: req.user_id }, { requestId: req.id, type: req.type });
        return row;
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/files/:id',
    auth: 'admin',
    permission: 'customers.privacy.manage',
    summary: 'Download a stored privacy export',
    tags: ['Privacy'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const file = await app.db.maybe<any>(sql`SELECT * FROM files WHERE id = ${c.params.id} AND owner_type = 'privacy_request'`);
      if (!file) throw notFound('File');
      const data = await app.storage.get(file.storage_key);
      if (!data) throw notFound('File contents');
      await writeAudit(app.db, app, { actor: c.actor, action: 'file.download', targetType: 'file', targetId: file.id });
      return c.reply.header('content-type', file.content_type).header('content-disposition', `attachment; filename="${file.filename}"`).send(data);
    },
  });
}
