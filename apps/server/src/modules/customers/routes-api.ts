import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { forbidden, notFound } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { pageQuery, paginate } from '../../core/validation.js';
import { MINUTE } from '../../core/clock.js';
import {
  USER_COLUMNS,
  addMember,
  findUserByExternalId,
  getOrganization,
  getUser,
  removeMember,
  revokeUserSessions,
  setUserStatus,
  softDeleteUser,
  updateUser,
  upsertUser,
  userInputSchema,
  userScopeSql,
  verifyImpersonationToken,
} from './service.js';
import { createOrganization, orgInputSchema, updateOrganization } from './routes-orgs.js';
import { applySignupForm, withFormInput } from './signup-forms.js';
import { recordAcceptance } from './agreements.js';
import { restoreIfArchived } from './archive.js';
import { recordCustomerIp, recordLogin, sharingBlock } from '../security/module.js';

/** Public (API) shape of a user: camelCase, no internals. */
export function presentUser(u: any) {
  return {
    id: u.id,
    externalId: u.external_id,
    email: u.email,
    emailVerified: Boolean(u.email_verified_at),
    name: u.name,
    phone: u.phone,
    avatarUrl: u.avatar_url,
    status: u.status,
    statusReason: u.status_reason,
    suspendedUntil: u.suspended_until,
    locale: u.locale,
    timezone: u.timezone,
    country: u.country,
    tags: u.tags,
    customFields: u.custom_fields,
    metadata: u.metadata,
    marketingConsent: u.marketing_consent,
    lastActiveAt: u.last_active_at,
    archivedAt: u.archived_at ?? null,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

function presentOrg(o: any) {
  return {
    id: o.id,
    externalId: o.external_id,
    name: o.name,
    slug: o.slug,
    status: o.status,
    ownerUserId: o.owner_user_id,
    billingEmail: o.billing_email,
    seatLimit: o.seat_limit,
    customDomain: o.custom_domain,
    tags: o.tags,
    customFields: o.custom_fields,
    metadata: o.metadata,
    createdAt: o.created_at,
  };
}

export function registerApiRoutes(r: Router, app: App): void {
  r.route({
    method: 'POST',
    url: '/api/v1/users',
    auth: 'api',
    scope: 'users:write',
    summary: 'Create or update (upsert) a user by externalId or email',
    description:
      'Call this when a user signs up or changes their profile in your app. Idempotent: repeated calls update the same user. When the user signed up through a signup form, pass `formKey` (plus the accepted `agreementVersionId`, the user\'s `ip` and the chosen `plan`): the profile is validated against the form and the acceptance is recorded.',
    tags: ['Users'],
    body: userInputSchema.extend({
      formKey: z.string().max(64).optional(),
      agreementVersionId: z.string().max(100).optional(),
      plan: z.string().max(100).optional(),
      ip: z.string().max(64).optional(),
      userAgent: z.string().max(500).optional(),
    }),
    handler: async (c) => {
      const { formKey, agreementVersionId, plan, ip, userAgent, ...input } = c.body;
      const result = await app.db.tx(async (tx) => {
        if (!formKey) return { ...(await upsertUser(tx, app, input, c.actor, c.orgScope())), form: null };
        const values = { name: input.name, phone: input.phone, locale: input.locale, timezone: input.timezone, country: input.country, marketingConsent: input.marketingConsent, ...(input.customFields ?? {}) };
        const form = await applySignupForm(tx, app, { formKey, values, strict: false, agreementVersionId, plan });
        const upserted = await upsertUser(tx, app, withFormInput(input, form), c.actor, c.orgScope());
        if (form.agreementVersion) {
          await recordAcceptance(tx, app, { userId: upserted.user.id, versionId: form.agreementVersion.id, ip: ip ?? null, userAgent: userAgent ?? null, source: 'api' });
        }
        return { ...upserted, form };
      });
      c.reply.status(result.created ? 201 : 200);
      return {
        user: presentUser(result.user),
        created: result.created,
        ...(result.form ? { redirectUrl: result.form.redirectUrl, plan: result.form.plan?.key ?? null } : {}),
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/users',
    auth: 'api',
    scope: 'users:read',
    summary: 'List or look up users',
    tags: ['Users'],
    query: z.object({ ...pageQuery, email: z.string().optional(), externalId: z.string().optional(), status: z.string().optional() }),
    handler: async (c) => {
      const page = await paginate<any>(app.db, {
        select: USER_COLUMNS,
        from: sql`users u`,
        where: sql.where([
          sql`u.deleted_at IS NULL`,
          c.query.email && sql`lower(u.email) = ${c.query.email.toLowerCase()}`,
          c.query.externalId && sql`u.external_id = ${c.query.externalId}`,
          c.query.status && sql`u.status = ${c.query.status}`,
          userScopeSql(c.orgScope()),
        ]),
        orderBy: sql`ORDER BY u.created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      return { ...page, data: page.data.map(presentUser) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/users/:id',
    auth: 'api',
    scope: 'users:read',
    summary: 'Get a user',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => ({ user: presentUser(await getUser(app.db, c.params.id, c.orgScope())) }),
  });

  r.route({
    method: 'GET',
    url: '/api/v1/users/external/:externalId',
    auth: 'api',
    scope: 'users:read',
    summary: 'Get a user by your own (external) ID',
    tags: ['Users'],
    params: z.object({ externalId: z.string() }),
    handler: async (c) => {
      const user = await findUserByExternalId(app.db, c.params.externalId, c.orgScope());
      if (!user) throw notFound('User');
      return { user: presentUser(user) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/users/:id/status',
    auth: 'api',
    scope: 'users:read',
    summary: 'Fast access check: may this user use the app right now?',
    description:
      'Returns `allowed: false` for suspended, banned or deleted users, during an account-sharing sign-in block (`reason: account_sharing_cooldown`, with `blockedUntil`), and for accounts merged into another (`status: merged`, with `mergedInto`). Cache for a short time (the SDK caches 30s).',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, c.orgScope(), { includeDeleted: true });
      if (user.merged_into_id) return { userId: user.id, status: 'merged', allowed: false, reason: 'merged', mergedInto: user.merged_into_id };
      const suspendedActive = user.status === 'suspended' && (!user.suspended_until || user.suspended_until > app.clock.now());
      const allowed = !user.deleted_at && user.status !== 'banned' && !suspendedActive && user.status !== 'pending';
      const block = allowed ? await sharingBlock(app.db, app, user.id) : null;
      if (block) return { userId: user.id, status: user.status, allowed: false, reason: 'account_sharing_cooldown', blockedUntil: block.blockedUntil };
      return { userId: user.id, status: user.deleted_at ? 'deleted' : user.status, allowed, reason: allowed ? null : user.status_reason };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/v1/users/:id',
    auth: 'api',
    scope: 'users:write',
    summary: 'Update a user',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: userInputSchema.omit({ status: true }).partial(),
    handler: async (c) => ({ user: presentUser(await app.db.tx((tx) => updateUser(tx, app, c.params.id, c.body, c.actor, c.orgScope()))) }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/v1/users/:id',
    auth: 'api',
    scope: 'users:write',
    summary: 'Delete a user (soft delete)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx((tx) => softDeleteUser(tx, app, c.params.id, c.actor, c.orgScope()));
    },
  });

  r.route({
    method: 'POST',
    url: '/api/v1/users/:id/suspend',
    auth: 'api',
    scope: 'users:write',
    summary: 'Suspend or reactivate a user from your app',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ action: z.enum(['suspend', 'reactivate']), reason: z.string().max(1000).optional(), until: z.coerce.date().optional() }),
    handler: async (c) => ({
      user: presentUser(await app.db.tx((tx) => setUserStatus(tx, app, c.params.id, c.body.action, { reason: c.body.reason ?? 'Suspended via API', until: c.body.until }, c.actor, c.orgScope()))),
    }),
  });

  r.route({
    method: 'POST',
    url: '/api/v1/users/:id/activity',
    auth: 'api',
    scope: 'users:write',
    summary: 'Mark the user as active (for "active users" metrics); throttled server-side. Restores an archived user.',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, c.orgScope());
      const now = app.clock.now();
      await app.db.exec(sql`
        UPDATE users SET last_active_at = ${now} WHERE id = ${c.params.id} AND (last_active_at IS NULL OR last_active_at < ${new Date(now.getTime() - 5 * MINUTE)})
      `);
      if (user.archived_at) await app.db.tx((tx) => restoreIfArchived(tx, app, user.id, 'active'));
      return { ok: true };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/v1/users/:id/login-events',
    auth: 'api',
    scope: 'events:write',
    summary: 'Report a login attempt from your own authentication system',
    description:
      'Feeds login history, IP history, account-sharing detection and suspicious-activity detection when your app owns authentication. A successful login restores an archived user. The response says whether the user may continue (`allowed: false` during an account-sharing sign-in block).',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({
      success: z.boolean(),
      ip: z.string().max(64),
      userAgent: z.string().max(500).default(''),
      country: z.string().length(2).optional(),
      method: z.string().max(30).default('password'),
      failureReason: z.string().max(100).optional(),
      sessionId: z.string().max(200).optional(),
    }),
    handler: async (c) => {
      const userId = await app.db.tx(async (tx) => {
        const user = await getUser(tx, c.params.id, c.orgScope());
        await recordLogin(tx, app, {
          subjectType: 'user',
          subjectId: user.id,
          email: user.email,
          success: c.body.success,
          failureReason: c.body.failureReason ?? null,
          method: c.body.method,
          ip: c.body.ip,
          userAgent: c.body.userAgent,
          country: c.body.country?.toUpperCase() ?? null,
        });
        if (c.body.success) {
          const now = app.clock.now();
          await tx.exec(sql`UPDATE users SET last_login_at = ${now}, last_login_ip = ${c.body.ip}, last_active_at = ${now} WHERE id = ${user.id}`);
          await restoreIfArchived(tx, app, user.id, 'signed_in');
          if (c.body.sessionId) {
            await tx.exec(sql.insert('user_sessions', {
              id: newId('uss'),
              user_id: user.id,
              external_session_id: c.body.sessionId,
              ip: c.body.ip,
              user_agent: c.body.userAgent,
              country: c.body.country?.toUpperCase() ?? null,
              created_at: now,
              last_seen_at: now,
            }, ''));
          }
        }
        return user.id;
      });
      if (!c.body.success) return { ok: true, allowed: true, reason: null };
      await recordCustomerIp(app, { userId, ip: c.body.ip, source: 'app_login', userAgent: c.body.userAgent || null, country: c.body.country?.toUpperCase() ?? null });
      const block = await sharingBlock(app.db, app, userId);
      return block ? { ok: true, allowed: false, reason: 'account_sharing_cooldown', blockedUntil: block.blockedUntil } : { ok: true, allowed: true, reason: null };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/v1/users/:id/sessions/revoke',
    auth: 'api',
    scope: 'users:write',
    summary: 'Revoke all sessions for a user',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getUser(tx, c.params.id, c.orgScope());
        return { revoked: await revokeUserSessions(tx, app, c.params.id, 'revoked_via_api', c.actor) };
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/v1/impersonation/verify',
    auth: 'api',
    scope: 'impersonation:verify',
    summary: 'Exchange a one-time impersonation token for the session details',
    description: 'Your app must display a visible banner while impersonating and honour `readOnly`.',
    tags: ['Users'],
    body: z.object({ token: z.string().startsWith('imp_') }),
    handler: async (c) => app.db.tx((tx) => verifyImpersonationToken(tx, app, c.body.token, c.actor)),
  });

  // ---- Organizations --------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/v1/organizations',
    auth: 'api',
    scope: 'orgs:write',
    summary: 'Create or update (upsert by externalId) an organization',
    tags: ['Organizations'],
    body: orgInputSchema,
    handler: async (c) => {
      if (c.orgScope()) throw forbidden('Organization-scoped keys cannot create organizations', 'org_scope');
      return app.db.tx(async (tx) => {
        if (c.body.externalId) {
          const existing = await tx.maybe<{ id: string }>(sql`SELECT id FROM organizations WHERE external_id = ${c.body.externalId} AND deleted_at IS NULL`);
          if (existing) {
            const { ownerUserId: _owner, ...rest } = c.body;
            return { organization: presentOrg((await updateOrganization(app, tx, existing.id, rest, null)).org), created: false };
          }
        }
        c.reply.status(201);
        return { organization: presentOrg(await createOrganization(app, tx, c.body, c.actor)), created: true };
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/organizations/:id',
    auth: 'api',
    scope: 'orgs:read',
    summary: 'Get an organization',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    handler: async (c) => ({ organization: presentOrg(await getOrganization(app.db, c.params.id, c.orgScope())) }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/v1/organizations/:id',
    auth: 'api',
    scope: 'orgs:write',
    summary: 'Update an organization',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    body: orgInputSchema.omit({ ownerUserId: true }).partial(),
    handler: async (c) => ({ organization: presentOrg((await app.db.tx((tx) => updateOrganization(app, tx, c.params.id, c.body, c.orgScope()))).org) }),
  });

  r.route({
    method: 'GET',
    url: '/api/v1/organizations/:id/members',
    auth: 'api',
    scope: 'orgs:read',
    summary: 'List members of an organization',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await getOrganization(app.db, c.params.id, c.orgScope());
      return {
        data: await app.db.many(sql`
          SELECT m.user_id AS "userId", u.email, u.name, m.role, m.status, m.created_at AS "createdAt"
          FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ${c.params.id} ORDER BY m.created_at
        `),
      };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/v1/organizations/:id/members/:userId',
    auth: 'api',
    scope: 'orgs:write',
    summary: 'Add a member or change their role',
    tags: ['Organizations'],
    params: z.object({ id: z.string(), userId: z.string() }),
    body: z.object({ role: z.string().min(1).max(50).default('member') }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getOrganization(tx, c.params.id, c.orgScope());
        await getUser(tx, c.params.userId, null);
        await addMember(tx, app, c.params.id, c.params.userId, c.body.role, c.actor);
        return { ok: true };
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/v1/organizations/:id/members/:userId',
    auth: 'api',
    scope: 'orgs:write',
    summary: 'Remove a member',
    tags: ['Organizations'],
    params: z.object({ id: z.string(), userId: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        await getOrganization(tx, c.params.id, c.orgScope());
        await removeMember(tx, app, c.params.id, c.params.userId, c.actor);
      });
    },
  });
}
