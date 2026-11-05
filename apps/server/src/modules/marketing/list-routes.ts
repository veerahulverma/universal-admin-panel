import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { escapeHtml } from '../../core/template.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { likePattern, pageQuery, paginate } from '../../core/validation.js';
import { getUser, userScopeSql } from '../customers/service.js';
import { hostedPage, sendHtml } from '../email/pages.js';
import {
  BLOCK_REASON,
  confirmSubscription,
  getList,
  listCounts,
  listInput,
  listProviders,
  subscribe,
  unsubscribe,
  type ListInput,
  type ListRow,
  type MemberStatus,
} from './lists.js';

function slugKey(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return /^[a-z]/.test(base) ? base : `list-${base || newId('l').slice(-6)}`;
}

async function checkRules(db: Db, app: App, input: Partial<ListInput>): Promise<void> {
  const ids = input.autoProductIds ?? [];
  if (ids.length) {
    const found = await db.many<{ id: string }>(sql`SELECT id FROM products WHERE id IN ${sql.in(ids)}`);
    const missing = ids.filter((id) => !found.some((p) => p.id === id));
    if (missing.length) throw validationError([{ path: ['autoProductIds'], message: `Unknown product: ${missing.join(', ')}` }]);
  }
  if (input.externalProvider) {
    const providers = await listProviders(app);
    if (!providers.some((p) => p.id === input.externalProvider)) {
      throw validationError([{ path: ['externalProvider'], message: 'No plugin provides this newsletter service; install and activate one first' }]);
    }
  }
}

function presentForCustomer(row: { id: string; key: string; name: string; description: string; double_opt_in: boolean; status: MemberStatus | null }) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    doubleOptIn: row.double_opt_in,
    status: row.status,
    subscribed: row.status === 'subscribed',
  };
}

async function customerList(db: Db, userId: string, list: ListRow) {
  const m = await db.maybe<{ status: MemberStatus }>(sql`SELECT status FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${userId}`);
  return presentForCustomer({ ...list, status: m?.status ?? null });
}

export function registerListRoutes(r: Router, app: App): void {
  // ---- Admin -----------------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/lists',
    auth: 'admin',
    permission: 'marketing.lists.view',
    summary: 'Mailing lists with member counts',
    tags: ['Marketing'],
    handler: async () => ({
      data: await app.db.many(sql`
        SELECT l.*, count(m.user_id) FILTER (WHERE m.status = 'subscribed')::int AS subscribed_count,
          count(m.user_id) FILTER (WHERE m.status = 'pending')::int AS pending_count
        FROM mailing_lists l LEFT JOIN mailing_list_members m ON m.list_id = l.id GROUP BY l.id ORDER BY l.name
      `),
    }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/lists/memberships',
    auth: 'admin',
    permission: 'marketing.lists.view',
    summary: "A customer's mailing lists: membership, how they joined, consent and whether list email reaches them",
    tags: ['Marketing'],
    query: z.object({ userId: z.string().max(100) }),
    handler: async (c) => {
      const user = await getUser(app.db, c.query.userId, c.orgScope(), { includeDeleted: true });
      return {
        data: await app.db.many(sql`
          SELECT l.id AS list_id, l.key, l.name, l.visibility, m.status, m.source, m.consented_at, m.subscribed_at, m.unsubscribed_at, ${BLOCK_REASON} AS blocked_reason
          FROM mailing_list_members m JOIN mailing_lists l ON l.id = m.list_id JOIN users u ON u.id = m.user_id
          WHERE m.user_id = ${user.id} ORDER BY l.name
        `),
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/lists/providers',
    auth: 'admin',
    permission: 'marketing.lists.view',
    summary: 'External newsletter services provided by plugins (empty when none is connected)',
    tags: ['Marketing'],
    handler: async () => ({ data: await listProviders(app) }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/lists/:id',
    auth: 'admin',
    permission: 'marketing.lists.view',
    summary: 'A mailing list with its rule, reach and external sync',
    tags: ['Marketing'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const list = await getList(app.db, c.params.id);
      const [counts, products, providers, campaigns] = await Promise.all([
        listCounts(app.db, list.id),
        list.auto_product_ids.length ? app.db.many(sql`SELECT id, key, name FROM products WHERE id IN ${sql.in(list.auto_product_ids)}`) : [],
        listProviders(app),
        app.db.many(sql`SELECT id, name, status, completed_at FROM campaigns WHERE list_id = ${list.id} ORDER BY created_at DESC LIMIT 10`),
      ]);
      const provider = list.external_provider ? providers.find((p) => p.id === list.external_provider) ?? null : null;
      return { ...list, counts, products, campaigns, external: list.external_provider ? { provider: list.external_provider, ref: list.external_ref, connected: Boolean(provider?.connected), name: provider?.name ?? null } : null };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/lists',
    auth: 'admin',
    permission: 'marketing.lists.manage',
    summary: 'Create a mailing list',
    tags: ['Marketing'],
    body: listInput,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const key = c.body.key ?? slugKey(c.body.name);
        if (await tx.maybe(sql`SELECT 1 FROM mailing_lists WHERE key = ${key}`)) throw conflict(`A list with the key "${key}" exists`, 'key_taken');
        await checkRules(tx, app, c.body);
        const now = app.clock.now();
        const row = await tx.one<ListRow>(sql.insert('mailing_lists', {
          id: newId('lst'),
          key,
          name: c.body.name,
          description: c.body.description,
          visibility: c.body.visibility,
          double_opt_in: c.body.doubleOptIn,
          auto_product_ids: [...new Set(c.body.autoProductIds)],
          external_provider: c.body.externalProvider || null,
          external_ref: c.body.externalProvider ? c.body.externalRef || null : null,
          created_by: c.admin().adminId,
          created_at: now,
          updated_at: now,
        }));
        await c.audit(tx, 'mailing_list.create', { type: 'mailing_list', id: row.id }, { key, name: c.body.name, autoProductIds: row.auto_product_ids });
        if (row.auto_product_ids.length) await app.jobs.enqueue(tx, 'marketing.list_sync', { listId: row.id }, { idempotencyKey: `list-sync:${row.id}:${now.toISOString()}` });
        c.reply.status(201);
        return row;
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/lists/:id',
    auth: 'admin',
    permission: 'marketing.lists.manage',
    summary: 'Update a mailing list (changing the product rule re-syncs its members)',
    tags: ['Marketing'],
    params: z.object({ id: z.string() }),
    body: listInput.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await getList(tx, c.params.id, { lock: true });
        if (c.body.key && c.body.key !== before.key && (await tx.maybe(sql`SELECT 1 FROM mailing_lists WHERE key = ${c.body.key}`))) throw conflict(`A list with the key "${c.body.key}" exists`, 'key_taken');
        await checkRules(tx, app, c.body);
        const rules = c.body.autoProductIds ? [...new Set(c.body.autoProductIds)] : undefined;
        const now = app.clock.now();
        const row = await tx.one<ListRow>(sql`
          UPDATE mailing_lists SET ${sql.set({
            key: c.body.key,
            name: c.body.name,
            description: c.body.description,
            visibility: c.body.visibility,
            double_opt_in: c.body.doubleOptIn,
            auto_product_ids: rules,
            external_provider: c.body.externalProvider === undefined ? undefined : c.body.externalProvider || null,
            external_ref: c.body.externalRef === undefined ? undefined : c.body.externalRef || null,
            updated_at: now,
          })} WHERE id = ${before.id} RETURNING *
        `);
        await c.audit(tx, 'mailing_list.update', { type: 'mailing_list', id: before.id }, { fields: Object.keys(c.body), autoProductIds: rules });
        if (rules && JSON.stringify([...rules].sort()) !== JSON.stringify([...before.auto_product_ids].sort())) {
          await app.jobs.enqueue(tx, 'marketing.list_sync', { listId: before.id }, { idempotencyKey: `list-sync:${before.id}:${now.toISOString()}` });
        }
        return row;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/lists/:id',
    auth: 'admin',
    permission: 'marketing.lists.manage',
    summary: 'Delete a mailing list that no campaign uses (members and consent records go with it)',
    tags: ['Marketing'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const list = await getList(tx, c.params.id, { lock: true });
        if (await tx.maybe(sql`SELECT 1 FROM campaigns WHERE list_id = ${list.id} LIMIT 1`)) throw conflict('Campaigns use this list', 'list_in_use');
        await tx.exec(sql`DELETE FROM mailing_lists WHERE id = ${list.id}`);
        await c.audit(tx, 'mailing_list.delete', { type: 'mailing_list', id: list.id }, { key: list.key, name: list.name });
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/lists/:id/sync',
    auth: 'admin',
    permission: 'marketing.lists.manage',
    summary: 'Re-apply the product rule now (runs in the background)',
    tags: ['Marketing'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const list = await getList(tx, c.params.id);
        await app.jobs.enqueue(tx, 'marketing.list_sync', { listId: list.id }, { idempotencyKey: `list-sync:${list.id}:${app.clock.now().toISOString()}` });
        await c.audit(tx, 'mailing_list.sync', { type: 'mailing_list', id: list.id });
        return { queued: true };
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/lists/:id/members',
    auth: 'admin',
    permission: 'marketing.lists.view',
    summary: 'List members with how they joined, their consent and whether list email reaches them',
    tags: ['Marketing'],
    params: z.object({ id: z.string() }),
    query: z.object({ ...pageQuery, status: z.enum(['pending', 'subscribed', 'unsubscribed']).optional(), source: z.string().max(40).optional(), q: z.string().trim().max(200).optional() }),
    handler: async (c) => {
      const list = await getList(app.db, c.params.id);
      return paginate(app.db, {
        select: sql`m.user_id, u.email, u.name, m.status, m.source, m.consented_at, m.subscribed_at, m.unsubscribed_at, m.confirmation_sent_at, m.created_at, ${BLOCK_REASON} AS blocked_reason`,
        from: sql`mailing_list_members m JOIN users u ON u.id = m.user_id`,
        where: sql.where([
          sql`m.list_id = ${list.id}`,
          c.query.status && sql`m.status = ${c.query.status}`,
          c.query.source && sql`m.source = ${c.query.source}`,
          c.query.q && sql`(u.email ILIKE ${likePattern(c.query.q)} OR u.name ILIKE ${likePattern(c.query.q)})`,
          userScopeSql(c.orgScope(), 'u'),
        ]),
        orderBy: sql`ORDER BY m.updated_at DESC, m.user_id`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/lists/:id/members',
    auth: 'admin',
    permission: 'marketing.lists.manage',
    summary: 'Add people to a list (or send them a confirmation request)',
    description: 'Without confirmation, members added by an administrator receive list email only if they consented to marketing. With `confirm` (always on double opt-in lists) they get a confirmation email and their click is recorded as consent.',
    tags: ['Marketing'],
    params: z.object({ id: z.string() }),
    body: z.object({ userIds: z.array(z.string()).min(1).max(500), confirm: z.boolean().default(false) }),
    handler: async (c) => {
      const list = await getList(app.db, c.params.id);
      const scope = c.orgScope();
      const results: { userId: string; status?: MemberStatus; error?: string }[] = [];
      for (const userId of [...new Set(c.body.userIds)]) {
        try {
          const status = await app.db.tx(async (tx) => {
            const user = await getUser(tx, userId, scope);
            const consent = c.body.confirm || list.double_opt_in ? 'request' : 'none';
            const status = await subscribe(tx, app, list, user, { consent, byPerson: false, evidence: { source: 'admin', actor: c.admin().adminId } });
            await c.audit(tx, 'mailing_list.member_add', { type: 'mailing_list', id: list.id }, { userId, status });
            return status;
          });
          results.push({ userId, status });
        } catch (err) {
          results.push({ userId, error: err instanceof AppError ? err.message : 'Could not add this person' });
        }
      }
      return { results, added: results.filter((x) => x.status).length };
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/lists/:id/members/:userId',
    auth: 'admin',
    permission: 'marketing.lists.manage',
    summary: 'Unsubscribe someone from a list (recorded; rules will not add them back)',
    tags: ['Marketing'],
    params: z.object({ id: z.string(), userId: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const list = await getList(tx, c.params.id);
        const user = await getUser(tx, c.params.userId, c.orgScope());
        if (!(await unsubscribe(tx, app, list, user, { source: 'admin', actor: c.admin().adminId }))) throw notFound('Membership');
        await c.audit(tx, 'mailing_list.member_remove', { type: 'mailing_list', id: list.id }, { userId: user.id });
        return { ok: true };
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/lists/:id/members/:userId/history',
    auth: 'admin',
    permission: 'marketing.lists.view',
    summary: "A member's consent record: every subscribe request, confirmation and unsubscribe with its source",
    tags: ['Marketing'],
    params: z.object({ id: z.string(), userId: z.string() }),
    handler: async (c) => {
      const list = await getList(app.db, c.params.id);
      await getUser(app.db, c.params.userId, c.orgScope(), { includeDeleted: true });
      return { data: await app.db.many(sql`SELECT * FROM mailing_list_consents WHERE list_id = ${list.id} AND user_id = ${c.params.userId} ORDER BY created_at DESC`) };
    },
  });

  // ---- Customers -------------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/client/lists',
    auth: 'client',
    summary: 'Mailing lists you can join, and the ones you are on',
    tags: ['Client'],
    handler: async (c) => {
      const rows = await app.db.many<{ id: string; key: string; name: string; description: string; double_opt_in: boolean; status: MemberStatus | null }>(sql`
        SELECT l.id, l.key, l.name, l.description, l.double_opt_in, m.status FROM mailing_lists l
        LEFT JOIN mailing_list_members m ON m.list_id = l.id AND m.user_id = ${c.customer().userId}
        WHERE l.visibility = 'public' OR m.status IN ('subscribed', 'pending') ORDER BY l.name
      `);
      return { data: rows.map(presentForCustomer) };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/client/lists/:list',
    auth: 'client',
    summary: 'Join or leave a list (double opt-in lists send a confirmation email first)',
    tags: ['Client'],
    rateLimit: { max: 30, windowSec: 600, by: 'principal' },
    params: z.object({ list: z.string().max(100) }),
    body: z.object({ subscribed: z.boolean() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const list = await getList(tx, c.params.list);
        const user = await getUser(tx, c.customer().userId, null);
        const membership = await tx.maybe<{ status: MemberStatus }>(sql`SELECT status FROM mailing_list_members WHERE list_id = ${list.id} AND user_id = ${user.id}`);
        // Hidden lists are run by the business: customers can leave them but not join.
        if (list.visibility === 'hidden' && !(membership && membership.status !== 'unsubscribed')) throw notFound('Mailing list');
        const evidence = { source: 'customer', ip: c.ip, userAgent: c.userAgent };
        if (c.body.subscribed) {
          if (list.visibility === 'hidden') throw notFound('Mailing list');
          await subscribe(tx, app, list, user, { consent: list.double_opt_in ? 'request' : 'given', byPerson: true, evidence });
        } else {
          await unsubscribe(tx, app, list, user, evidence);
        }
        return customerList(tx, user.id, list);
      }),
  });

  // ---- Integration API -------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/v1/lists',
    auth: 'api',
    scope: 'lists:read',
    summary: 'Mailing lists',
    tags: ['Marketing'],
    handler: async () => ({
      data: (await app.db.many<ListRow>(sql`SELECT * FROM mailing_lists ORDER BY name`)).map((l) => ({ id: l.id, key: l.key, name: l.name, description: l.description, visibility: l.visibility, doubleOptIn: l.double_opt_in })),
    }),
  });

  const memberParams = z.object({ list: z.string().max(100), userId: z.string().max(100) });

  r.route({
    method: 'GET',
    url: '/api/v1/lists/:list/members/:userId',
    auth: 'api',
    scope: 'lists:read',
    summary: "A user's membership of a list",
    tags: ['Marketing'],
    params: memberParams,
    handler: async (c) => {
      const list = await getList(app.db, c.params.list);
      const user = await getUser(app.db, c.params.userId, c.orgScope());
      return customerList(app.db, user.id, list);
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/v1/lists/:list/members/:userId',
    auth: 'api',
    scope: 'lists:write',
    summary: 'Subscribe or unsubscribe a user (e.g. from the newsletter box of your own signup form)',
    description: 'Pass `consent` when the person opted in themselves (a checkbox they ticked); it is recorded with the IP address and user agent you send. On double opt-in lists consented subscriptions wait for the confirmation email.',
    tags: ['Marketing'],
    params: memberParams,
    body: z.object({
      subscribed: z.boolean(),
      consent: z.object({ ip: z.string().max(100).optional(), userAgent: z.string().max(500).optional() }).optional(),
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const list = await getList(tx, c.params.list);
        const user = await getUser(tx, c.params.userId, c.orgScope());
        const evidence = { source: 'api', ip: c.body.consent?.ip ?? null, userAgent: c.body.consent?.userAgent ?? null, actor: c.apiKey().keyId };
        if (c.body.subscribed) {
          // Consent evidence means the person opted in on your side; without it this is an administrative add.
          const consent = !c.body.consent ? 'none' : list.double_opt_in ? 'request' : 'given';
          await subscribe(tx, app, list, user, { consent, byPerson: Boolean(c.body.consent), evidence });
        } else {
          await unsubscribe(tx, app, list, user, evidence);
        }
        return customerList(tx, user.id, list);
      }),
  });

  // ---- Public: double opt-in confirmation ----------------------------------------------------------
  // A wildcard, not a `:token` parameter: path parameters are capped at 100 characters.
  const confirmParams = z.object({ '*': z.string().min(1).max(1000) });

  r.route({
    method: 'GET',
    url: '/lists/confirm/*',
    auth: 'public',
    hidden: true,
    params: confirmParams,
    handler: async (c) => {
      const action = `/lists/confirm/${escapeHtml(c.params['*'])}`;
      // Confirmation step: link scanners follow GET links, so only POST confirms.
      return sendHtml(c.reply, hostedPage(app, 'Confirm your subscription', `
        <h1>Confirm your subscription</h1><p>Click below to start receiving these emails. You can unsubscribe at any time.</p>
        <form method="post" action="${action}"><button type="submit">Confirm subscription</button></form>`));
    },
  });

  r.route({
    method: 'POST',
    url: '/lists/confirm/*',
    auth: 'public',
    hidden: true,
    summary: 'Confirm a double opt-in subscription',
    params: confirmParams,
    rateLimit: { max: 30, windowSec: 60 },
    handler: async (c) => {
      const outcome = await app.db.tx((tx) => confirmSubscription(tx, app, c.params['*'], { ip: c.ip, userAgent: c.userAgent }));
      if (!outcome) return sendHtml(c.reply, hostedPage(app, 'Link not valid', '<h1>This link is no longer valid</h1><p class="muted">It may have expired. Subscribe again to get a new one.</p>'), 404);
      return sendHtml(c.reply, hostedPage(app, 'Subscribed', `<h1>You're subscribed</h1><p class="muted">You will receive <strong>${escapeHtml(outcome.list.name)}</strong> emails. Every email has a link to unsubscribe.</p>`));
    },
  });
}
