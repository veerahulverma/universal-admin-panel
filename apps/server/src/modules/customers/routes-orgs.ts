import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { Actor, App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { conflict, forbidden, notFound } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { likePattern, pageQuery, paginate, slug as slugSchema } from '../../core/validation.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import { DAY } from '../../core/clock.js';
import { diff } from '../../core/json.js';
import { addMember, getOrganization, getUser, orgScopeSql, removeMember, slugify, uniqueSlug, validateCustomFields } from './service.js';
import { sendSystemEmail } from '../core/mail.js';

export const orgInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
  externalId: z.string().trim().min(1).max(200).optional(),
  ownerUserId: z.string().optional(),
  billingEmail: z.string().email().optional(),
  seatLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  customDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a domain like app.example.com').nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function createOrganization(app: App, tx: Db, input: z.infer<typeof orgInputSchema>, actor: Actor) {
  const slug = input.slug ? input.slug : await uniqueSlug(tx, slugify(input.name));
  if (input.slug && (await tx.maybe(sql`SELECT 1 FROM organizations WHERE slug = ${slug} AND deleted_at IS NULL`))) throw conflict('This slug is taken', 'slug_taken');
  if (input.externalId && (await tx.maybe(sql`SELECT 1 FROM organizations WHERE external_id = ${input.externalId} AND deleted_at IS NULL`))) {
    throw conflict('An organization with this external ID already exists', 'external_id_taken');
  }
  const customFields = input.customFields ? await validateCustomFields(tx, 'organization', input.customFields, { partial: false }) : {};
  const now = app.clock.now();
  const id = newId('org');
  await tx.exec(sql.insert('organizations', {
    id,
    external_id: input.externalId ?? null,
    name: input.name,
    slug,
    owner_user_id: input.ownerUserId ?? null,
    billing_email: input.billingEmail ?? null,
    seat_limit: input.seatLimit ?? null,
    custom_domain: input.customDomain ?? null,
    custom_fields: customFields,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
    created_at: now,
    updated_at: now,
  }, ''));
  if (input.ownerUserId) {
    await getUser(tx, input.ownerUserId, null);
    await addMember(tx, app, id, input.ownerUserId, 'owner', actor);
  }
  await app.events.emit(tx, 'organization.created', { orgId: id, name: input.name, ownerUserId: input.ownerUserId ?? null }, { orgId: id, userId: input.ownerUserId ?? null });
  return getOrganization(tx, id, null);
}

export async function updateOrganization(app: App, tx: Db, id: string, input: Partial<z.infer<typeof orgInputSchema>>, scope: string[] | null) {
  const before = await getOrganization(tx, id, scope, { lock: true });
  if (input.slug && input.slug !== before.slug && (await tx.maybe(sql`SELECT 1 FROM organizations WHERE slug = ${input.slug} AND deleted_at IS NULL`))) {
    throw conflict('This slug is taken', 'slug_taken');
  }
  const customFields = input.customFields ? { ...before.custom_fields, ...(await validateCustomFields(tx, 'organization', input.customFields, { partial: true })) } : undefined;
  const patch = {
    name: input.name,
    slug: input.slug,
    external_id: input.externalId,
    billing_email: input.billingEmail,
    seat_limit: input.seatLimit,
    custom_domain: input.customDomain,
    custom_fields: customFields,
    tags: input.tags,
    metadata: input.metadata ? { ...before.metadata, ...input.metadata } : undefined,
  };
  const changes = diff(before, patch);
  if (Object.keys(changes).length) {
    await tx.exec(sql`UPDATE organizations SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${id}`);
    await app.events.emit(tx, 'organization.updated', { orgId: id, changes: Object.keys(changes) }, { orgId: id });
  }
  return { org: await getOrganization(tx, id, null), changes };
}

export function registerOrgRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/organizations',
    auth: 'admin',
    permission: 'customers.organizations.view',
    summary: 'List organizations',
    tags: ['Organizations'],
    query: z.object({
      ...pageQuery,
      q: z.string().trim().max(200).optional(),
      status: z.enum(['active', 'suspended']).optional(),
      sort: z.enum(['created_at', 'name', 'members']).default('created_at'),
      order: z.enum(['asc', 'desc']).default('desc'),
    }),
    handler: async (c) =>
      paginate(app.db, {
        select: sql`o.*, (SELECT count(*)::int FROM memberships m WHERE m.org_id = o.id AND m.status = 'active') AS member_count,
                    ow.email AS owner_email, ow.name AS owner_name`,
        from: sql`organizations o LEFT JOIN users ow ON ow.id = o.owner_user_id`,
        where: sql.where([
          sql`o.deleted_at IS NULL`,
          c.query.q && sql`(o.name ILIKE ${likePattern(c.query.q)} OR o.slug ILIKE ${likePattern(c.query.q)} OR o.id = ${c.query.q} OR o.external_id = ${c.query.q})`,
          c.query.status && sql`o.status = ${c.query.status}`,
          orgScopeSql(c.orgScope()),
        ]),
        orderBy: sql.orderBy(c.query.sort, c.query.order, { created_at: 'o.created_at', name: 'lower(o.name)', members: 'member_count' }),
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/organizations',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    summary: 'Create an organization',
    tags: ['Organizations'],
    body: orgInputSchema,
    handler: async (c) => {
      if (c.orgScope()) throw forbidden('Organization-scoped administrators cannot create organizations', 'org_scope');
      return app.db.tx(async (tx) => {
        const org = await createOrganization(app, tx, c.body, c.actor);
        await c.audit(tx, 'organization.create', { type: 'organization', id: org.id, orgId: org.id }, { name: org.name });
        return org;
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/organizations/:id',
    auth: 'admin',
    permission: 'customers.organizations.view',
    summary: 'Organization details',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const org = await getOrganization(app.db, c.params.id, c.orgScope());
      const [members, invitations] = await Promise.all([
        app.db.many(sql`
          SELECT m.id, m.user_id, u.email, u.name, u.status AS user_status, m.role, m.status, m.created_at
          FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ${org.id} ORDER BY m.role = 'owner' DESC, u.email
        `),
        app.db.many(sql`SELECT id, email, role, requires_approval, expires_at, created_at FROM org_invitations WHERE org_id = ${org.id} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${app.clock.now()}`),
      ]);
      const panels = await app.hooks.apply<Record<string, unknown>>('customers.organization.profile', {}, { app, org, permissions: c.admin().permissions });
      return { ...org, members, invitations, panels };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/organizations/:id',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    summary: 'Update an organization',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    body: orgInputSchema.omit({ ownerUserId: true }).partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const { org, changes } = await updateOrganization(app, tx, c.params.id, c.body, c.orgScope());
        if (Object.keys(changes).length) await c.audit(tx, 'organization.update', { type: 'organization', id: org.id, orgId: org.id }, { changes });
        return org;
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/organizations/:id/status',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    summary: 'Suspend or reactivate an organization',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().max(1000).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getOrganization(tx, c.params.id, c.orgScope(), { lock: true });
        await tx.exec(sql`UPDATE organizations SET status = ${c.body.status}, updated_at = ${app.clock.now()} WHERE id = ${c.params.id}`);
        await c.audit(tx, `organization.${c.body.status === 'active' ? 'reactivate' : 'suspend'}`, { type: 'organization', id: c.params.id, orgId: c.params.id }, { reason: c.body.reason });
        await app.events.emit(tx, c.body.status === 'active' ? 'organization.reactivated' : 'organization.suspended', { orgId: c.params.id, reason: c.body.reason ?? null }, { orgId: c.params.id });
        return getOrganization(tx, c.params.id, null);
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/organizations/:id',
    auth: 'admin',
    permission: 'customers.organizations.delete',
    sensitive: true,
    summary: 'Delete an organization (soft delete; memberships are removed)',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        await getOrganization(tx, c.params.id, c.orgScope(), { lock: true });
        await tx.exec(sql`UPDATE organizations SET deleted_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${c.params.id}`);
        await tx.exec(sql`DELETE FROM memberships WHERE org_id = ${c.params.id}`);
        await c.audit(tx, 'organization.delete', { type: 'organization', id: c.params.id, orgId: c.params.id });
        await app.events.emit(tx, 'organization.deleted', { orgId: c.params.id }, { orgId: c.params.id });
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/organizations/:id/members',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    summary: 'Add a user to an organization',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    body: z.object({ userId: z.string(), role: z.string().min(1).max(50).default('member') }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getOrganization(tx, c.params.id, c.orgScope());
        await getUser(tx, c.body.userId, null);
        await addMember(tx, app, c.params.id, c.body.userId, c.body.role, c.actor);
        return { ok: true };
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/organizations/:id/members/:userId',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    summary: "Change a member's role or approve a pending member",
    tags: ['Organizations'],
    params: z.object({ id: z.string(), userId: z.string() }),
    body: z.object({ role: z.string().min(1).max(50).optional(), status: z.enum(['active', 'suspended']).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await getOrganization(tx, c.params.id, c.orgScope());
        const row = await tx.maybe(sql`
          UPDATE memberships SET ${sql.set({ role: c.body.role, status: c.body.status, updated_at: app.clock.now() })}
          WHERE org_id = ${c.params.id} AND user_id = ${c.params.userId} RETURNING *
        `);
        if (!row) throw notFound('Membership');
        await c.audit(tx, 'organization.member_update', { type: 'organization', id: c.params.id, orgId: c.params.id }, { userId: c.params.userId, ...c.body });
        await app.events.emit(tx, 'organization.member_updated', { orgId: c.params.id, userId: c.params.userId, ...c.body }, { orgId: c.params.id, userId: c.params.userId });
        return row;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/organizations/:id/members/:userId',
    auth: 'admin',
    permission: 'customers.organizations.manage',
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

  r.route({
    method: 'POST',
    url: '/api/admin/organizations/:id/transfer-ownership',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    sensitive: true,
    summary: 'Transfer organization ownership to another member',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    body: z.object({ userId: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const org = await getOrganization(tx, c.params.id, c.orgScope(), { lock: true });
        const member = await tx.maybe(sql`SELECT 1 FROM memberships WHERE org_id = ${org.id} AND user_id = ${c.body.userId} AND status = 'active'`);
        if (!member) throw conflict('The new owner must be an active member', 'not_a_member');
        if (org.owner_user_id) await tx.exec(sql`UPDATE memberships SET role = 'admin' WHERE org_id = ${org.id} AND user_id = ${org.owner_user_id}`);
        await tx.exec(sql`UPDATE memberships SET role = 'owner' WHERE org_id = ${org.id} AND user_id = ${c.body.userId}`);
        await tx.exec(sql`UPDATE organizations SET owner_user_id = ${c.body.userId}, updated_at = ${app.clock.now()} WHERE id = ${org.id}`);
        await c.audit(tx, 'organization.transfer_ownership', { type: 'organization', id: org.id, orgId: org.id }, { from: org.owner_user_id, to: c.body.userId });
        await app.events.emit(tx, 'organization.ownership_transferred', { orgId: org.id, from: org.owner_user_id, to: c.body.userId }, { orgId: org.id });
        return getOrganization(tx, org.id, null);
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/organizations/:id/invitations',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    summary: 'Invite someone to an organization by email',
    tags: ['Organizations'],
    params: z.object({ id: z.string() }),
    body: z.object({ email: z.string().trim().toLowerCase().email(), role: z.string().min(1).max(50).default('member'), requiresApproval: z.boolean().default(false) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const org = await getOrganization(tx, c.params.id, c.orgScope());
        const token = randomToken(32);
        const id = newId('oinv');
        await tx.exec(sql.insert('org_invitations', {
          id,
          org_id: org.id,
          email: c.body.email,
          role: c.body.role,
          token_hash: sha256(token),
          requires_approval: c.body.requiresApproval,
          invited_by_admin_id: c.admin().adminId,
          expires_at: new Date(app.clock.now().getTime() + 14 * DAY),
          created_at: app.clock.now(),
        }, ''));
        await c.audit(tx, 'organization.invite', { type: 'organization', id: org.id, orgId: org.id }, { email: c.body.email, role: c.body.role });
        await app.events.emit(tx, 'organization.invitation_created', { orgId: org.id, invitationId: id, email: c.body.email, role: c.body.role, token }, { orgId: org.id });
        await sendSystemEmail(app, tx, { to: c.body.email, template: 'organization.invitation', data: { orgName: org.name, role: c.body.role, token }, orgId: org.id });
        return { id, email: c.body.email, token };
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/organizations/:id/invitations/:invitationId',
    auth: 'admin',
    permission: 'customers.organizations.manage',
    summary: 'Revoke an organization invitation',
    tags: ['Organizations'],
    params: z.object({ id: z.string(), invitationId: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        await getOrganization(tx, c.params.id, c.orgScope());
        const n = await tx.exec(sql`UPDATE org_invitations SET revoked_at = ${app.clock.now()} WHERE id = ${c.params.invitationId} AND org_id = ${c.params.id} AND accepted_at IS NULL`);
        if (!n) throw notFound('Invitation');
        await c.audit(tx, 'organization.invitation_revoke', { type: 'organization', id: c.params.id, orgId: c.params.id }, { invitationId: c.params.invitationId });
      });
    },
  });
}
