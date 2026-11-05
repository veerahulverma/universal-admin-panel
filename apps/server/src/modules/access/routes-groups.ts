import { z } from 'zod';
import type { Router, RouteContext } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { likePattern, pageQuery } from '../../core/validation.js';
import { getUser, userScopeSql } from '../customers/service.js';
import { countGroupMembers, groupsOfUser, listGroupMembers } from './service.js';

/** Group and content definitions are shared by every tenant, so only unrestricted administrators change them. */
export function requireUnscoped(c: RouteContext, what: string): void {
  if (c.orgScope()) throw forbidden(`Organization-scoped administrators cannot change ${what}`, 'org_scope');
}

interface GroupRow {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ProductRef {
  id: string;
  key: string;
  name: string;
  kind: string;
}

async function getGroup(db: Db, id: string, opts: { lock?: boolean } = {}): Promise<GroupRow> {
  const row = await db.maybe<GroupRow>(sql`SELECT * FROM user_groups WHERE id = ${id} ${opts.lock ? sql`FOR UPDATE` : sql.empty}`);
  if (!row) throw notFound('User group');
  return row;
}

async function autoProductsOf(db: Db, groupIds: string[]): Promise<Map<string, ProductRef[]>> {
  const out = new Map<string, ProductRef[]>();
  if (!groupIds.length) return out;
  const rows = await db.many<ProductRef & { group_id: string }>(sql`
    SELECT gp.group_id, p.id, p.key, p.name, p.kind FROM user_group_products gp JOIN products p ON p.id = gp.product_id
    WHERE gp.group_id IN ${sql.in(groupIds)} ORDER BY p.kind, p.sort_order, p.name
  `);
  for (const { group_id, ...p } of rows) out.set(group_id, [...(out.get(group_id) ?? []), p]);
  return out;
}

async function presentGroups(db: Db, app: App, groups: GroupRow[], scope: string[] | null) {
  const products = await autoProductsOf(db, groups.map((g) => g.id));
  const usage = groups.length
    ? await db.many<{ group_id: string; resources: number }>(sql`
        SELECT group_id, count(*)::int AS resources FROM access_rules WHERE group_id IN ${sql.in(groups.map((g) => g.id))} GROUP BY group_id
      `)
    : [];
  const out = [];
  for (const g of groups) {
    out.push({
      id: g.id,
      name: g.name,
      description: g.description,
      autoProducts: products.get(g.id) ?? [],
      members: await countGroupMembers(db, app, g.id, scope),
      resourceCount: usage.find((u) => u.group_id === g.id)?.resources ?? 0,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
    });
  }
  return out;
}

/** Product ids for automatic membership; ids or keys are accepted. */
async function resolveProducts(db: Db, refs: string[]): Promise<string[]> {
  const unique = [...new Set(refs)];
  if (!unique.length) return [];
  const rows = await db.many<{ id: string; key: string }>(sql`SELECT id, key FROM products WHERE id IN ${sql.in(unique)} OR key IN ${sql.in(unique)}`);
  const missing = unique.filter((r) => !rows.some((p) => p.id === r || p.key === r));
  if (missing.length) throw validationError([{ path: ['autoProductIds'], message: `Unknown products: ${missing.join(', ')}` }]);
  return [...new Set(rows.map((p) => p.id))];
}

async function assertNameFree(db: Db, name: string, exceptId: string | null): Promise<void> {
  const taken = await db.maybe(sql`SELECT 1 FROM user_groups WHERE lower(name) = ${name.toLowerCase()} ${exceptId ? sql`AND id <> ${exceptId}` : sql.empty}`);
  if (taken) throw conflict(`A group named "${name}" already exists`, 'group_name_taken');
}

async function setAutoProducts(db: Db, groupId: string, productIds: string[]): Promise<void> {
  await db.exec(sql`DELETE FROM user_group_products WHERE group_id = ${groupId}`);
  if (productIds.length) await db.exec(sql.insertMany('user_group_products', productIds.map((product_id) => ({ group_id: groupId, product_id })), ''));
}

const groupBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  /** Members while they hold one of these products (ids or keys) through an active subscription or grant. */
  autoProductIds: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

const groupParams = z.object({ id: z.string().max(100) });

export function registerGroupRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/user-groups',
    auth: 'admin',
    permission: 'customers.groups.view',
    summary: 'User groups with member counts; with userId, only the groups that user belongs to',
    tags: ['User groups'],
    query: z.object({ q: z.string().trim().max(100).optional(), userId: z.string().max(100).optional() }),
    handler: async (c) => {
      const scope = c.orgScope();
      if (c.query.userId) {
        const user = await getUser(app.db, c.query.userId, scope);
        const memberships = await groupsOfUser(app.db, app, user.id);
        const groups = memberships.length ? await app.db.many<GroupRow>(sql`SELECT * FROM user_groups WHERE id IN ${sql.in(memberships.map((m) => m.id))} ORDER BY lower(name)`) : [];
        const products = await autoProductsOf(app.db, groups.map((g) => g.id));
        return {
          data: groups.map((g) => {
            const m = memberships.find((x) => x.id === g.id)!;
            return { id: g.id, name: g.name, description: g.description, autoProducts: products.get(g.id) ?? [], membership: { manual: m.manual, automatic: m.automatic, since: m.since } };
          }),
        };
      }
      const groups = await app.db.many<GroupRow>(sql`
        SELECT * FROM user_groups ${sql.where([c.query.q && sql`(name ILIKE ${likePattern(c.query.q)} OR description ILIKE ${likePattern(c.query.q)})`])} ORDER BY lower(name)
      `);
      return { data: await presentGroups(app.db, app, groups, scope) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/user-groups/options',
    auth: 'admin',
    permission: 'customers.groups.view',
    summary: 'Products that can drive automatic membership',
    tags: ['User groups'],
    handler: async () => ({
      products: await app.db.many(sql`SELECT id, key, name, kind, status FROM products ORDER BY CASE kind WHEN 'plan' THEN 0 ELSE 1 END, sort_order, name`),
    }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/user-groups',
    auth: 'admin',
    permission: 'customers.groups.manage',
    summary: 'Create a user group (optionally with automatic membership by product)',
    tags: ['User groups'],
    body: groupBody,
    handler: async (c) => {
      requireUnscoped(c, 'user groups');
      const group = await app.db.tx(async (tx) => {
        await assertNameFree(tx, c.body.name, null);
        const productIds = await resolveProducts(tx, c.body.autoProductIds);
        const now = app.clock.now();
        const row = await tx.one<GroupRow>(sql.insert('user_groups', {
          id: newId('ugrp'),
          name: c.body.name,
          description: c.body.description,
          created_by: c.admin().adminId,
          created_at: now,
          updated_at: now,
        }));
        await setAutoProducts(tx, row.id, productIds);
        await c.audit(tx, 'user_group.create', { type: 'user_group', id: row.id }, { name: row.name, autoProductIds: productIds });
        await app.events.emit(tx, 'user_group.created', { groupId: row.id, name: row.name, autoProductIds: productIds });
        return row;
      });
      c.reply.status(201);
      return (await presentGroups(app.db, app, [group], c.orgScope()))[0];
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/user-groups/:id',
    auth: 'admin',
    permission: 'customers.groups.view',
    summary: 'A user group with its automatic-membership products and the content it unlocks',
    tags: ['User groups'],
    params: groupParams,
    handler: async (c) => {
      const group = await getGroup(app.db, c.params.id);
      const [presented] = await presentGroups(app.db, app, [group], c.orgScope());
      const resources = await app.db.many(sql`
        SELECT r.id, r.kind, r.title, r.status FROM access_rules ru JOIN access_resources r ON r.id = ru.resource_id
        WHERE ru.group_id = ${group.id} ORDER BY lower(r.title)
      `);
      return { ...presented, resources };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/user-groups/:id',
    auth: 'admin',
    permission: 'customers.groups.manage',
    summary: 'Rename a group, change its description or its automatic-membership products',
    tags: ['User groups'],
    params: groupParams,
    body: groupBody.partial(),
    handler: async (c) => {
      requireUnscoped(c, 'user groups');
      const group = await app.db.tx(async (tx) => {
        const before = await getGroup(tx, c.params.id, { lock: true });
        const b = c.body;
        if (b.name !== undefined) await assertNameFree(tx, b.name, before.id);
        const productIds = b.autoProductIds !== undefined ? await resolveProducts(tx, b.autoProductIds) : undefined;
        await tx.exec(sql`UPDATE user_groups SET ${sql.set({ name: b.name, description: b.description, updated_at: app.clock.now() })} WHERE id = ${before.id}`);
        if (productIds) await setAutoProducts(tx, before.id, productIds);
        const changes = { ...(b.name !== undefined && b.name !== before.name ? { name: { from: before.name, to: b.name } } : {}), ...(b.description !== undefined ? { description: true } : {}), ...(productIds ? { autoProductIds: productIds } : {}) };
        await c.audit(tx, 'user_group.update', { type: 'user_group', id: before.id }, changes);
        await app.events.emit(tx, 'user_group.updated', { groupId: before.id, name: b.name ?? before.name, changes: Object.keys(changes) });
        return getGroup(tx, before.id);
      });
      return (await presentGroups(app.db, app, [group], c.orgScope()))[0];
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/user-groups/:id',
    auth: 'admin',
    permission: 'customers.groups.manage',
    summary: 'Delete a group (refused while access rules use it)',
    tags: ['User groups'],
    params: groupParams,
    handler: async (c) => {
      requireUnscoped(c, 'user groups');
      await app.db.tx(async (tx) => {
        const group = await getGroup(tx, c.params.id, { lock: true });
        const resources = await tx.many<{ id: string; title: string }>(sql`
          SELECT r.id, r.title FROM access_rules ru JOIN access_resources r ON r.id = ru.resource_id WHERE ru.group_id = ${group.id} ORDER BY lower(r.title)
        `);
        if (resources.length) {
          throw conflict(`Remove this group from the access rules of ${resources.length === 1 ? `"${resources[0].title}"` : `${resources.length} resources`} first`, 'group_in_use', { resources });
        }
        const members = await tx.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM user_group_members WHERE group_id = ${group.id}`);
        await tx.exec(sql`DELETE FROM user_groups WHERE id = ${group.id}`);
        await c.audit(tx, 'user_group.delete', { type: 'user_group', id: group.id }, { name: group.name, manualMembers: members.n });
        await app.events.emit(tx, 'user_group.deleted', { groupId: group.id, name: group.name });
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/user-groups/:id/members',
    auth: 'admin',
    permission: 'customers.groups.view',
    summary: 'Members of a group, added by hand or automatically through a product',
    tags: ['User groups'],
    params: groupParams,
    query: z.object({ ...pageQuery, q: z.string().trim().max(200).optional(), source: z.enum(['all', 'manual', 'automatic']).default('all') }),
    handler: async (c) => {
      const group = await getGroup(app.db, c.params.id);
      const page = await listGroupMembers(app.db, app, group.id, { scope: c.orgScope(), q: c.query.q, source: c.query.source, page: c.query.page, pageSize: c.query.pageSize });
      return {
        ...page,
        data: page.data.map((m) => ({ id: m.id, email: m.email, name: m.name, status: m.status, manual: m.added_at !== null, automatic: m.auto_since !== null, addedAt: m.added_at, automaticSince: m.auto_since })),
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/user-groups/:id/members',
    auth: 'admin',
    permission: 'customers.groups.manage',
    summary: 'Add one or many users (by ID or email) to a group',
    tags: ['User groups'],
    params: groupParams,
    body: z.object({ users: z.array(z.string().trim().min(1).max(254)).min(1).max(500) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const group = await getGroup(tx, c.params.id, { lock: true });
        const values = [...new Set(c.body.users)];
        const emails = values.filter((v) => v.includes('@')).map((v) => v.toLowerCase());
        const ids = values.filter((v) => !v.includes('@'));
        const found = await tx.many<{ id: string; email: string }>(sql`
          SELECT u.id, lower(u.email) AS email FROM users u
          ${sql.where([sql`(u.id IN ${sql.in(ids)} OR lower(u.email) IN ${sql.in(emails)})`, sql`u.deleted_at IS NULL`, userScopeSql(c.orgScope(), 'u')])}
        `);
        const userFor = (v: string) => found.find((u) => u.id === v || u.email === v.toLowerCase());
        const skipped: { value: string; reason: 'not_found' | 'already_member' }[] = values.filter((v) => !userFor(v)).map((value) => ({ value, reason: 'not_found' }));
        const candidates = [...new Set(values.map(userFor).filter((u): u is { id: string; email: string } => Boolean(u)).map((u) => u.id))];
        const now = app.clock.now();
        const admin = c.admin();
        const inserted = candidates.length
          ? await tx.many<{ user_id: string }>(sql`
              ${sql.insertMany('user_group_members', candidates.map((user_id) => ({ group_id: group.id, user_id, added_by_type: 'admin', added_by_id: admin.adminId, created_at: now })), '')}
              ON CONFLICT (group_id, user_id) DO NOTHING RETURNING user_id
            `)
          : [];
        const added = inserted.map((r) => r.user_id);
        for (const id of candidates.filter((id) => !added.includes(id))) skipped.push({ value: values.find((v) => userFor(v)?.id === id) ?? id, reason: 'already_member' });
        if (added.length) {
          await c.audit(tx, 'user_group.members_add', { type: 'user_group', id: group.id }, { name: group.name, userIds: added });
          for (const userId of added) await app.events.emit(tx, 'user_group.member_added', { groupId: group.id, name: group.name, userId }, { userId });
        }
        return { added, skipped };
      }),
  });

  const removeMembers = async (c: RouteContext, groupId: string, userIds: string[]): Promise<string[]> =>
    app.db.tx(async (tx) => {
      const group = await getGroup(tx, groupId, { lock: true });
      const scope = userScopeSql(c.orgScope(), 'u');
      const removed = await tx.many<{ user_id: string }>(sql`
        DELETE FROM user_group_members gm WHERE gm.group_id = ${group.id} AND gm.user_id IN ${sql.in(userIds)}
        ${scope ? sql`AND EXISTS (SELECT 1 FROM users u WHERE u.id = gm.user_id AND ${scope})` : sql.empty}
        RETURNING gm.user_id
      `);
      const ids = removed.map((r) => r.user_id);
      if (ids.length) {
        await c.audit(tx, 'user_group.members_remove', { type: 'user_group', id: group.id }, { name: group.name, userIds: ids });
        for (const userId of ids) await app.events.emit(tx, 'user_group.member_removed', { groupId: group.id, name: group.name, userId }, { userId });
      }
      return ids;
    });

  r.route({
    method: 'POST',
    url: '/api/admin/user-groups/:id/members/remove',
    auth: 'admin',
    permission: 'customers.groups.manage',
    summary: 'Remove one or many users from a group (automatic members stay while they hold the product)',
    tags: ['User groups'],
    params: groupParams,
    body: z.object({ userIds: z.array(z.string().min(1).max(100)).min(1).max(500) }),
    handler: async (c) => ({ removed: await removeMembers(c, c.params.id, [...new Set(c.body.userIds)]) }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/user-groups/:id/members/:userId',
    auth: 'admin',
    permission: 'customers.groups.manage',
    summary: 'Remove a user from a group',
    tags: ['User groups'],
    params: z.object({ id: z.string().max(100), userId: z.string().max(100) }),
    handler: async (c) => {
      await getUser(app.db, c.params.userId, c.orgScope());
      const removed = await removeMembers(c, c.params.id, [c.params.userId]);
      if (!removed.length) throw notFound('Group membership');
    },
  });
}
