import { z } from 'zod';
import type { Router, RouteContext } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { safeEqual } from '../../core/crypto.js';
import { likePattern, pageQuery, paginate, qDate } from '../../core/validation.js';
import { DAY } from '../../core/clock.js';
import { isAllowed } from '../../core/permissions.js';
import { getUser } from '../customers/service.js';
import { flattenPermissions, rolePermissionsSql } from '../iam/auth.js';
import { notifyAdmins } from '../iam/notify.js';
import {
  PRIORITIES,
  addAttachment,
  addMessage,
  announceAssignment,
  assertPriorityAllowed,
  attachmentSchema,
  createTicket,
  getCategory,
  getTicket,
  inboundEmailSchema,
  inboundToken,
  readAttachment,
  receiveEmail,
  renderSavedReply,
  setTicketStatus,
  settingsOf,
  ticketScopeSql,
  type Priority,
  type TicketStatus,
} from './service.js';
import { agentsWith, assertActiveAdmins } from './assignment.js';
import { presentFields, ticketFieldsSchema, validateTicketFields } from './fields.js';

const ATTACHMENT_BODY_LIMIT = 72 * 1024 * 1024;
const statuses = ['open', 'pending', 'on_hold', 'solved', 'closed'] as const;
const priorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
const customFieldsInput = z.record(z.string().max(40), z.unknown()).refine((v) => Object.keys(v).length <= 20, 'At most 20 fields');

function presentForCustomer(t: any) {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    categoryId: t.category_id,
    customFields: t.custom_fields ?? {},
    channel: t.channel,
    csatRating: t.csat_rating,
    csatComment: t.csat_comment,
    solvedAt: t.solved_at,
    closedAt: t.closed_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

async function customerThread(app: App, ticketId: string) {
  const [messages, attachments] = await Promise.all([
    app.db.many(sql`
      SELECT m.id, m.author_type, m.body, m.created_at, CASE WHEN m.author_type = 'admin' THEN a.name END AS author_name
      FROM ticket_messages m LEFT JOIN admins a ON m.author_type = 'admin' AND a.id = m.author_id
      WHERE m.ticket_id = ${ticketId} AND NOT m.is_internal AND m.author_type <> 'system' ORDER BY m.created_at
    `),
    app.db.many(sql`
      SELECT ta.id, ta.message_id, f.filename, f.content_type, f.size, ta.created_at FROM ticket_attachments ta JOIN files f ON f.id = ta.file_id
      WHERE ta.ticket_id = ${ticketId} AND NOT ta.is_internal ORDER BY ta.created_at
    `),
  ]);
  return { messages, attachments };
}

async function ownTicket(app: App, c: RouteContext, id: string): Promise<any> {
  const t = await app.db.maybe(sql`SELECT * FROM tickets WHERE (id = ${id} OR number = ${id}) AND user_id = ${c.customer().userId}`);
  if (!t) throw notFound('Ticket');
  return t;
}

function sendFile(c: RouteContext, file: { filename: string; contentType: string; data: Buffer }) {
  const name = file.filename.replace(/["\r\n\\]/g, '_');
  return c.reply
    .header('content-type', file.contentType)
    .header('content-disposition', `attachment; filename="${name}"`)
    .header('cache-control', 'private, no-store')
    .send(file.data);
}

export function registerSupportRoutes(r: Router, app: App): void {
  // ---- Admin: queue & tickets --------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/support/tickets',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Ticket queue with views, filters and sorting',
    tags: ['Support'],
    query: z.object({
      ...pageQuery,
      view: z.enum(['all', 'mine', 'watching', 'unassigned', 'breached', 'active']).default('all'),
      status: z.string().max(100).optional(),
      priority: priorityEnum.optional(),
      categoryId: z.string().optional(),
      assigneeId: z.string().optional(),
      tag: z.string().max(50).optional(),
      q: z.string().trim().max(200).optional(),
      userId: z.string().optional(),
      orgId: z.string().optional(),
      sort: z.enum(['created_at', 'updated_at', 'priority', 'due']).default('created_at'),
      order: z.enum(['asc', 'desc']).default('desc'),
    }),
    handler: (c) => {
      const q = c.query;
      const me = c.admin().adminId;
      const statusList = q.status?.split(',').filter((s): s is TicketStatus => (statuses as readonly string[]).includes(s));
      return paginate(app.db, {
        select: sql`t.*, a.name AS assignee_name, cat.name AS category_name,
          (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id AND NOT m.is_internal) AS message_count`,
        from: sql`tickets t LEFT JOIN admins a ON a.id = t.assignee_id LEFT JOIN ticket_categories cat ON cat.id = t.category_id`,
        where: sql.where([
          q.view === 'mine' && sql`t.assignee_id = ${me} AND t.status NOT IN ('solved', 'closed')`,
          q.view === 'watching' && sql`t.watcher_ids ? ${me} AND t.status NOT IN ('solved', 'closed')`,
          q.view === 'unassigned' && sql`t.assignee_id IS NULL AND t.status NOT IN ('solved', 'closed')`,
          q.view === 'breached' && sql`t.sla_breached_at IS NOT NULL AND t.status NOT IN ('solved', 'closed')`,
          q.view === 'active' && sql`t.status NOT IN ('solved', 'closed')`,
          statusList?.length && sql`t.status IN ${sql.in(statusList)}`,
          q.priority && sql`t.priority = ${q.priority}`,
          q.categoryId && sql`t.category_id = ${q.categoryId}`,
          q.assigneeId && sql`t.assignee_id = ${q.assigneeId}`,
          q.tag && sql`t.tags ? ${q.tag}`,
          q.userId && sql`t.user_id = ${q.userId}`,
          q.orgId && sql`t.org_id = ${q.orgId}`,
          q.q && sql`(t.subject ILIKE ${likePattern(q.q)} OR t.number = ${q.q.toUpperCase()} OR t.requester_email ILIKE ${likePattern(q.q)})`,
          ticketScopeSql(c.orgScope()),
        ]),
        orderBy: sql.orderBy(q.sort, q.order, {
          created_at: 't.created_at',
          updated_at: 't.updated_at',
          priority: "CASE t.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END",
          due: 'LEAST(CASE WHEN t.first_responded_at IS NULL THEN t.first_response_due_at END, t.resolution_due_at)',
        }),
        page: q.page,
        pageSize: q.pageSize,
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/tickets',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Log a ticket for a customer (phone, chat) or start an outreach conversation',
    tags: ['Support'],
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    body: z
      .object({
        userId: z.string().optional(),
        email: z.string().trim().toLowerCase().email().optional(),
        name: z.string().max(200).optional(),
        subject: z.string().trim().min(1).max(300),
        body: z.string().trim().min(1).max(50_000),
        priority: priorityEnum.optional(),
        categoryId: z.string().optional(),
        assigneeId: z.string().optional(),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
        customFields: customFieldsInput.optional(),
        authorType: z.enum(['customer', 'admin']).default('customer'),
        attachments: z.array(attachmentSchema).max(10).optional(),
      })
      .refine((b) => b.userId || b.email, 'userId or email is required'),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const scope = c.orgScope();
        let user: { id: string; email: string; name: string | null } | null = null;
        if (c.body.userId) user = await getUser(tx, c.body.userId, scope);
        else user = await tx.maybe(sql`SELECT id, email, name FROM users WHERE lower(email) = ${c.body.email!} AND deleted_at IS NULL`);
        if (scope && !user) throw forbidden('Organization-scoped agents can only open tickets for their customers', 'org_scope');
        const membership = user
          ? await tx.maybe<{ org_id: string }>(sql`
              SELECT org_id FROM memberships WHERE user_id = ${user.id} AND status = 'active' ${scope ? sql`AND org_id IN ${sql.in(scope)}` : sql.empty} ORDER BY created_at LIMIT 1
            `)
          : null;
        const ticket = await createTicket(tx, app, {
          userId: user?.id ?? null,
          orgId: membership?.org_id ?? null,
          requesterEmail: user?.email ?? c.body.email!,
          requesterName: c.body.name ?? user?.name ?? null,
          subject: c.body.subject,
          body: c.body.body,
          priority: c.body.priority,
          categoryId: c.body.categoryId,
          assigneeId: c.body.assigneeId ?? null,
          tags: c.body.tags,
          customFields: c.body.customFields,
          channel: 'admin',
          authorType: c.body.authorType,
          authorId: c.body.authorType === 'admin' ? c.admin().adminId : user?.id ?? null,
          attachments: c.body.attachments,
        }, c.actor);
        return ticket;
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/support/tickets/:id',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Ticket with the full conversation (including internal notes)',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const t = await getTicket(app.db, c.params.id, c.orgScope());
      const [messages, attachments, requester, other] = await Promise.all([
        app.db.many(sql`
          SELECT m.*, CASE WHEN m.author_type = 'admin' THEN a.name END AS author_name FROM ticket_messages m
          LEFT JOIN admins a ON m.author_type = 'admin' AND a.id = m.author_id WHERE m.ticket_id = ${t.id} ORDER BY m.created_at
        `),
        app.db.many(sql`
          SELECT ta.id, ta.message_id, ta.is_internal, ta.uploaded_by_type, f.filename, f.content_type, f.size, ta.created_at
          FROM ticket_attachments ta JOIN files f ON f.id = ta.file_id WHERE ta.ticket_id = ${t.id} ORDER BY ta.created_at
        `),
        t.user_id ? app.db.maybe(sql`SELECT id, email, name, status, created_at, lifetime_revenue FROM users WHERE id = ${t.user_id}`) : null,
        app.db.many(sql`
          SELECT id, number, subject, status, created_at FROM tickets
          WHERE id <> ${t.id} AND (lower(requester_email) = ${t.requester_email} ${t.user_id ? sql`OR user_id = ${t.user_id}` : sql.empty})
          ORDER BY created_at DESC LIMIT 10
        `),
      ]);
      const category = t.category_id ? await getCategory(app.db, t.category_id) : null;
      const watchers = t.watcher_ids.length ? await app.db.many(sql`SELECT id, name, email FROM admins WHERE id IN ${sql.in(t.watcher_ids)} ORDER BY name`) : [];
      return { ...t, category_fields: category?.fields ?? [], watchers, messages, attachments, requester, otherTickets: other };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/support/tickets/:id',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Assign, prioritize, categorize, tag or change status',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    body: z.object({
      status: z.enum(statuses).optional(),
      priority: priorityEnum.optional(),
      categoryId: z.string().nullable().optional(),
      assigneeId: z.string().nullable().optional(),
      watcherIds: z.array(z.string().max(100)).max(50).optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
      customFields: customFieldsInput.optional(),
      subject: z.string().trim().min(1).max(300).optional(),
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const scope = c.orgScope();
        const before = await getTicket(tx, c.params.id, scope, { lock: true });
        const b = c.body;
        if (b.assigneeId && !(await tx.maybe(sql`SELECT 1 FROM admins WHERE id = ${b.assigneeId} AND status = 'active'`))) throw validationError([{ path: ['assigneeId'], message: 'Unknown administrator' }]);
        const category = b.categoryId ? await getCategory(tx, b.categoryId) : b.categoryId === null ? null : before.category_id ? await getCategory(tx, before.category_id) : null;
        if (b.categoryId && !category) throw validationError([{ path: ['categoryId'], message: 'Unknown category' }]);
        if (b.watcherIds) await assertActiveAdmins(tx, b.watcherIds, 'watcherIds');
        // A new category brings its watchers along; agents already watching stay.
        const recategorized = b.categoryId !== undefined && b.categoryId !== before.category_id;
        const categoryWatchers = recategorized && category ? (await agentsWith(tx, category.watcher_ids, 'support.tickets.view')).map((a) => a.id) : [];
        const watchers = b.watcherIds || categoryWatchers.length ? [...new Set([...(b.watcherIds ?? before.watcher_ids), ...categoryWatchers])] : undefined;
        const customFields = b.customFields ? { ...before.custom_fields, ...validateTicketFields(category?.fields ?? [], b.customFields, { partial: true }) } : undefined;
        const patch = { priority: b.priority, category_id: b.categoryId, assignee_id: b.assigneeId, watcher_ids: watchers, tags: b.tags, custom_fields: customFields, subject: b.subject };
        if (Object.values(patch).some((v) => v !== undefined)) {
          await tx.exec(sql`UPDATE tickets SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${before.id}`);
          await c.audit(tx, 'ticket.update', { type: 'ticket', id: before.id, orgId: before.org_id }, { ...b, status: undefined });
          await app.events.emit(tx, 'ticket.updated', { ticketId: before.id, number: before.number, changes: Object.keys(b) }, { userId: before.user_id, orgId: before.org_id });
          if (b.assigneeId !== undefined) await announceAssignment(tx, app, before, { assigneeId: b.assigneeId, previousAssigneeId: before.assignee_id, rule: 'manual', actorAdminId: c.admin().adminId });
        }
        if (b.status) return setTicketStatus(tx, app, before.id, b.status, c.actor, scope);
        return getTicket(tx, before.id, null);
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/tickets/:id/reply',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Reply to the customer (emails them; records the first response)',
    tags: ['Support'],
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    params: z.object({ id: z.string() }),
    body: z
      .object({
        body: z.string().max(50_000).optional(),
        savedReplyId: z.string().optional(),
        status: z.enum(['open', 'pending', 'on_hold', 'solved']).optional(),
        attachments: z.array(attachmentSchema).max(10).optional(),
      })
      .refine((b) => b.body?.trim() || b.savedReplyId, 'Write a reply or choose a saved reply'),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const ticket = await getTicket(tx, c.params.id, c.orgScope());
        if (ticket.status === 'closed') throw conflict('This ticket is closed', 'ticket_closed');
        const me = c.admin();
        let body = c.body.body?.trim() ?? '';
        if (c.body.savedReplyId) {
          const saved = await tx.maybe<{ body: string }>(sql`SELECT body FROM saved_replies WHERE id = ${c.body.savedReplyId}`);
          if (!saved) throw notFound('Saved reply');
          const rendered = renderSavedReply(saved.body, { ticket, agentName: me.name });
          body = body ? `${body}\n\n${rendered}` : rendered;
        }
        const { messageId, ticket: updated } = await addMessage(tx, app, ticket.id, {
          authorType: 'admin',
          authorId: me.adminId,
          authorName: me.name,
          body,
          internal: false,
          channel: 'web',
          statusAfter: c.body.status ?? 'pending',
          attachments: c.body.attachments,
        }, c.actor);
        return { messageId, ticket: updated };
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/tickets/:id/notes',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Add an internal note (never visible to the customer)',
    tags: ['Support'],
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    params: z.object({ id: z.string() }),
    body: z.object({ body: z.string().trim().min(1).max(50_000), attachments: z.array(attachmentSchema).max(10).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const ticket = await getTicket(tx, c.params.id, c.orgScope());
        const me = c.admin();
        return addMessage(tx, app, ticket.id, { authorType: 'admin', authorId: me.adminId, body: c.body.body, internal: true, channel: 'web', attachments: c.body.attachments }, c.actor);
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/tickets/bulk',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Assign, prioritize, tag or change the status of many tickets',
    tags: ['Support'],
    body: z.object({
      ids: z.array(z.string()).min(1).max(500),
      action: z.enum(['assign', 'status', 'priority', 'tag', 'untag']),
      value: z.string().max(100).nullable(),
    }),
    handler: async (c) => {
      const scope = c.orgScope();
      const { action, value } = c.body;
      if (action === 'status' && !(statuses as readonly string[]).includes(value ?? '')) throw validationError([{ path: ['value'], message: 'Unknown status' }]);
      if (action === 'priority' && !PRIORITIES.includes(value as Priority)) throw validationError([{ path: ['value'], message: 'Unknown priority' }]);
      if ((action === 'tag' || action === 'untag') && !value) throw validationError([{ path: ['value'], message: 'Tag is required' }]);
      if (action === 'assign' && value && !(await app.db.maybe(sql`SELECT 1 FROM admins WHERE id = ${value} AND status = 'active'`))) throw validationError([{ path: ['value'], message: 'Unknown administrator' }]);
      const results: { id: string; ok: boolean; error?: string }[] = [];
      for (const id of c.body.ids) {
        try {
          await app.db.tx(async (tx) => {
            const t = await getTicket(tx, id, scope, { lock: true });
            if (action === 'status') {
              await setTicketStatus(tx, app, t.id, value as TicketStatus, c.actor, scope);
              return;
            }
            const patch =
              action === 'assign' ? { assignee_id: value } :
              action === 'priority' ? { priority: value } :
              { tags: action === 'tag' ? [...new Set([...t.tags, value!])] : t.tags.filter((x: string) => x !== value) };
            await tx.exec(sql`UPDATE tickets SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${t.id}`);
            await c.audit(tx, `ticket.bulk_${action}`, { type: 'ticket', id: t.id, orgId: t.org_id }, { value });
            if (action === 'assign') await announceAssignment(tx, app, t, { assigneeId: value, previousAssigneeId: t.assignee_id, rule: 'manual', actorAdminId: c.admin().adminId });
          });
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: results.length };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/support/attachments/:id',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Download an attachment',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const scope = ticketScopeSql(c.orgScope());
      return sendFile(c, await readAttachment(app, c.params.id, scope ?? sql`TRUE`));
    },
  });

  // Assignee choices. Agents usually lack iam.admins.view, so the team directory is not an option.
  r.route({
    method: 'GET',
    url: '/api/admin/support/agents',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Active administrators who can work tickets (for assignment)',
    tags: ['Support'],
    handler: async () => {
      const rows = await app.db.many<{ id: string; name: string; email: string; role_permissions: string[][] | null }>(sql`
        SELECT a.id, a.name, a.email, ${rolePermissionsSql('a.id')} AS role_permissions FROM admins a WHERE a.status = 'active' ORDER BY a.name
      `);
      return {
        data: rows.filter((a) => isAllowed(flattenPermissions(a.role_permissions), 'support.tickets.manage')).map(({ id, name, email }) => ({ id, name, email })),
      };
    },
  });

  // ---- Admin: categories & saved replies ------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/support/categories',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Ticket categories and their SLAs',
    tags: ['Support'],
    handler: async () => ({ data: await app.db.many(sql`SELECT * FROM ticket_categories ORDER BY position, name`) }),
  });

  const categoryBody = z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(''),
    defaultPriority: priorityEnum.default('normal'),
    firstResponseMinutes: z.number().int().min(1).max(525_600).nullable().optional(),
    resolutionMinutes: z.number().int().min(1).max(525_600).nullable().optional(),
    active: z.boolean().default(true),
    position: z.number().int().default(0),
    /** Extra questions asked when a ticket is opened in this category. */
    fields: ticketFieldsSchema.default([]),
    /** New tickets in this category go to this agent (unless one was chosen). */
    defaultAssigneeId: z.string().max(100).nullable().optional(),
    /** Agents notified about every new ticket and customer reply in this category. */
    watcherIds: z.array(z.string().max(100)).max(50).default([]),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/categories',
    auth: 'admin',
    permission: 'support.settings.manage',
    summary: 'Create a ticket category (SLA overrides, custom fields, default assignee and watchers)',
    tags: ['Support'],
    body: categoryBody,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await assertActiveAdmins(tx, [c.body.defaultAssigneeId], 'defaultAssigneeId');
        await assertActiveAdmins(tx, c.body.watcherIds, 'watcherIds');
        const row = await tx.one(sql.insert('ticket_categories', {
          id: newId('tcat'),
          name: c.body.name,
          description: c.body.description,
          default_priority: c.body.defaultPriority,
          first_response_minutes: c.body.firstResponseMinutes ?? null,
          resolution_minutes: c.body.resolutionMinutes ?? null,
          active: c.body.active,
          position: c.body.position,
          fields: c.body.fields,
          default_assignee_id: c.body.defaultAssigneeId ?? null,
          watcher_ids: [...new Set(c.body.watcherIds)],
          created_at: app.clock.now(),
        }));
        await c.audit(tx, 'ticket_category.create', { type: 'ticket_category', id: row.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/support/categories/:id',
    auth: 'admin',
    permission: 'support.settings.manage',
    summary: 'Update a ticket category',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    body: categoryBody.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await assertActiveAdmins(tx, [c.body.defaultAssigneeId], 'defaultAssigneeId');
        await assertActiveAdmins(tx, c.body.watcherIds ?? [], 'watcherIds');
        const row = await tx.maybe(sql`
          UPDATE ticket_categories SET ${sql.set({
            name: c.body.name,
            description: c.body.description,
            default_priority: c.body.defaultPriority,
            first_response_minutes: c.body.firstResponseMinutes,
            resolution_minutes: c.body.resolutionMinutes,
            active: c.body.active,
            position: c.body.position,
            fields: c.body.fields,
            default_assignee_id: c.body.defaultAssigneeId,
            watcher_ids: c.body.watcherIds ? [...new Set(c.body.watcherIds)] : undefined,
          })} WHERE id = ${c.params.id} RETURNING *
        `);
        if (!row) throw notFound('Category');
        await c.audit(tx, 'ticket_category.update', { type: 'ticket_category', id: c.params.id }, c.body);
        return row;
      }),
  });

  // ---- Admin: automatic assignment -------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/support/assignment',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Round-robin assignment: whether it is on and which agents take part',
    tags: ['Support'],
    handler: async () => {
      const s = settingsOf(app);
      const last = await app.db.many<{ admin_id: string; last_assigned_at: Date }>(sql`SELECT admin_id, last_assigned_at FROM ticket_assignment_rotation`);
      return {
        roundRobinEnabled: s.roundRobinEnabled,
        agentIds: s.roundRobinAgentIds,
        lastAssigned: Object.fromEntries(last.map((r) => [r.admin_id, r.last_assigned_at])),
      };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/admin/support/assignment',
    auth: 'admin',
    permission: 'support.settings.manage',
    summary: 'Turn round-robin assignment on or off and choose the agents in the rotation',
    tags: ['Support'],
    body: z.object({ roundRobinEnabled: z.boolean(), agentIds: z.array(z.string().max(100)).max(200) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const agentIds = [...new Set(c.body.agentIds)];
        const eligible = await agentsWith(tx, agentIds, 'support.tickets.manage');
        const ineligible = agentIds.filter((id) => !eligible.some((a) => a.id === id));
        if (ineligible.length) throw validationError([{ path: ['agentIds'], message: `Not an active agent who can work tickets: ${ineligible.join(', ')}` }]);
        if (c.body.roundRobinEnabled && !agentIds.length) throw validationError([{ path: ['agentIds'], message: 'Choose at least one agent for the rotation' }]);
        const saved = await app.settings.update<{ roundRobinEnabled: boolean; roundRobinAgentIds: string[] }>(tx, 'support', { roundRobinEnabled: c.body.roundRobinEnabled, roundRobinAgentIds: agentIds }, c.actor);
        return { roundRobinEnabled: saved.roundRobinEnabled, agentIds: saved.roundRobinAgentIds };
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/support/saved-replies',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Saved replies (macros)',
    tags: ['Support'],
    handler: async () => ({ data: await app.db.many(sql`SELECT * FROM saved_replies ORDER BY title`) }),
  });

  const replyBody = z.object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(20_000),
    shortcut: z.string().max(40).optional(),
    categoryId: z.string().nullable().optional(),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/saved-replies',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Create a saved reply. Variables: {{ customer.name }}, {{ ticket.number }}, {{ ticket.subject }}, {{ agent.name }}',
    tags: ['Support'],
    body: replyBody,
    handler: async (c) => {
      const now = app.clock.now();
      return app.db.one(sql.insert('saved_replies', { id: newId('srp'), title: c.body.title, body: c.body.body, shortcut: c.body.shortcut ?? null, category_id: c.body.categoryId ?? null, created_by: c.admin().adminId, created_at: now, updated_at: now }));
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/support/saved-replies/:id',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Edit a saved reply',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    body: replyBody.partial(),
    handler: async (c) => {
      const row = await app.db.maybe(sql`
        UPDATE saved_replies SET ${sql.set({ title: c.body.title, body: c.body.body, shortcut: c.body.shortcut, category_id: c.body.categoryId, updated_at: app.clock.now() })}
        WHERE id = ${c.params.id} RETURNING *
      `);
      if (!row) throw notFound('Saved reply');
      return row;
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/support/saved-replies/:id',
    auth: 'admin',
    permission: 'support.tickets.manage',
    summary: 'Delete a saved reply',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const n = await app.db.exec(sql`DELETE FROM saved_replies WHERE id = ${c.params.id}`);
      if (!n) throw notFound('Saved reply');
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/support/saved-replies/:id/render',
    auth: 'admin',
    permission: 'support.tickets.view',
    summary: 'Preview a saved reply filled in for a ticket',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    query: z.object({ ticketId: z.string() }),
    handler: async (c) => {
      const saved = await app.db.maybe<{ body: string }>(sql`SELECT body FROM saved_replies WHERE id = ${c.params.id}`);
      if (!saved) throw notFound('Saved reply');
      const ticket = await getTicket(app.db, c.query.ticketId, c.orgScope());
      return { body: renderSavedReply(saved.body, { ticket, agentName: c.admin().name }) };
    },
  });

  // ---- Admin: inbound email configuration -------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/support/inbound',
    auth: 'admin',
    permission: 'support.settings.manage',
    sensitive: true,
    summary: 'The secret URL your email provider should POST inbound mail to',
    tags: ['Support'],
    handler: async () => {
      const token = await app.db.tx((tx) => inboundToken(app, tx));
      return {
        url: `${app.config.appUrl}/api/public/support/inbound/${token}`,
        payload: '{ "from": "Name <email>", "subject": "...", "text": "...", "html"?: "...", "messageId"?: "...", "inReplyTo"?: "...", "references"?: ["..."], "attachments"?: [{ "filename", "contentType", "data": "<base64>" }] }',
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/inbound/rotate',
    auth: 'admin',
    permission: 'support.settings.manage',
    sensitive: true,
    summary: 'Rotate the inbound email token (the old URL stops working)',
    tags: ['Support'],
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await app.secrets.delete(tx, 'support', 'inbound', 'token');
        const token = await inboundToken(app, tx);
        await c.audit(tx, 'support.inbound_token_rotate');
        return { url: `${app.config.appUrl}/api/public/support/inbound/${token}` };
      }),
  });

  // ---- Admin: reports ------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/support/reports',
    auth: 'admin',
    permission: 'support.reports.view',
    summary: 'Volume, response and resolution times, SLA breach rate and CSAT',
    tags: ['Support'],
    query: z.object({ from: qDate.optional(), to: qDate.optional() }),
    handler: async (c) => {
      const to = c.query.to ?? app.clock.now();
      const from = c.query.from ?? new Date(to.getTime() - 30 * DAY);
      const scope = ticketScopeSql(c.orgScope());
      const scoped = scope ? sql`AND ${scope}` : sql.empty;
      const [created, solved, csat, byCategory, byAgent, daily, backlog] = await Promise.all([
        app.db.one<any>(sql`
          SELECT count(*)::int AS created, count(*) FILTER (WHERE t.sla_breached_at IS NOT NULL)::int AS breached,
            round(avg(extract(epoch FROM (t.first_responded_at - t.created_at)) / 60) FILTER (WHERE t.first_responded_at IS NOT NULL))::int AS avg_first_response_minutes
          FROM tickets t WHERE t.created_at BETWEEN ${from} AND ${to} ${scoped}
        `),
        app.db.one<any>(sql`
          SELECT count(*)::int AS solved, round(avg(extract(epoch FROM (t.solved_at - t.created_at)) / 60))::int AS avg_resolution_minutes
          FROM tickets t WHERE t.solved_at BETWEEN ${from} AND ${to} ${scoped}
        `),
        app.db.many<{ rating: number; count: number }>(sql`
          SELECT t.csat_rating AS rating, count(*)::int AS count FROM tickets t WHERE t.csat_at BETWEEN ${from} AND ${to} ${scoped} GROUP BY t.csat_rating ORDER BY 1
        `),
        app.db.many(sql`
          SELECT coalesce(cat.name, 'Uncategorized') AS category, count(*)::int AS tickets FROM tickets t LEFT JOIN ticket_categories cat ON cat.id = t.category_id
          WHERE t.created_at BETWEEN ${from} AND ${to} ${scoped} GROUP BY 1 ORDER BY 2 DESC
        `),
        app.db.many(sql`
          SELECT a.id, a.name, count(*)::int AS assigned, count(*) FILTER (WHERE t.solved_at IS NOT NULL)::int AS solved,
            round(avg(extract(epoch FROM (t.first_responded_at - t.created_at)) / 60) FILTER (WHERE t.first_responded_at IS NOT NULL))::int AS avg_first_response_minutes,
            round(avg(t.csat_rating), 2)::float AS csat
          FROM tickets t JOIN admins a ON a.id = t.assignee_id WHERE t.created_at BETWEEN ${from} AND ${to} ${scoped} GROUP BY a.id, a.name ORDER BY assigned DESC
        `),
        app.db.many(sql`
          SELECT d::date AS day,
            (SELECT count(*)::int FROM tickets t WHERE t.created_at >= d AND t.created_at < d + interval '1 day' ${scoped}) AS created,
            (SELECT count(*)::int FROM tickets t WHERE t.solved_at >= d AND t.solved_at < d + interval '1 day' ${scoped}) AS solved
          FROM generate_series(date_trunc('day', ${from}::timestamptz), date_trunc('day', ${to}::timestamptz), interval '1 day') d ORDER BY d
        `),
        app.db.many(sql`SELECT t.priority, count(*)::int AS open FROM tickets t WHERE t.status NOT IN ('solved', 'closed') ${scoped} GROUP BY t.priority`),
      ]);
      const responses = csat.reduce((n, r) => n + r.count, 0);
      const satisfied = csat.filter((r) => r.rating >= 4).reduce((n, r) => n + r.count, 0);
      return {
        from,
        to,
        volume: { created: created.created, solved: solved.solved },
        avgFirstResponseMinutes: created.avg_first_response_minutes,
        avgResolutionMinutes: solved.avg_resolution_minutes,
        slaBreachRate: created.created ? created.breached / created.created : 0,
        csat: {
          responses,
          average: responses ? csat.reduce((s, r) => s + r.rating * r.count, 0) / responses : null,
          satisfiedRate: responses ? satisfied / responses : null,
          distribution: csat,
        },
        byCategory,
        byAgent,
        daily,
        backlog,
      };
    },
  });

  // ---- Public: inbound email ---------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/public/support/inbound/:token',
    auth: 'public',
    summary: 'Inbound email webhook (email-to-ticket)',
    description: 'Point your email provider (or a small relay) at this secret URL. Replies thread onto tickets by the [T-000123] reference in the subject or by In-Reply-To.',
    tags: ['Support'],
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    rateLimit: { max: 300, windowSec: 60 },
    params: z.object({ token: z.string().max(200) }),
    body: inboundEmailSchema,
    handler: async (c) => {
      const expected = await app.secrets.get(app.db, 'support', 'inbound', 'token');
      if (!expected || !safeEqual(c.params.token, expected)) throw notFound('Inbound endpoint');
      return receiveEmail(app, c.body);
    },
  });

  // ---- Customer (client) API ------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/client/support/categories',
    auth: 'client',
    summary: 'Categories for the contact form, with the extra fields each one asks for',
    tags: ['Client'],
    handler: async () => {
      const rows = await app.db.many<{ id: string; name: string; description: string; fields: Parameters<typeof presentFields>[0] }>(sql`
        SELECT id, name, description, fields FROM ticket_categories WHERE active ORDER BY position, name
      `);
      return { data: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, fields: presentFields(r.fields) })) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/support/tickets',
    auth: 'client',
    summary: 'Your support tickets',
    tags: ['Client'],
    query: z.object(pageQuery),
    handler: async (c) => {
      const page = await paginate<any>(app.db, {
        select: sql`*`,
        from: sql`tickets`,
        where: sql`WHERE user_id = ${c.customer().userId}`,
        orderBy: sql`ORDER BY updated_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      return { ...page, data: page.data.map(presentForCustomer) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/support/tickets',
    auth: 'client',
    summary: 'Open a support ticket',
    tags: ['Client'],
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    rateLimit: { max: 20, windowSec: 3600, by: 'principal' },
    body: z.object({
      subject: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(50_000),
      categoryId: z.string().optional(),
      priority: priorityEnum.optional(),
      customFields: customFieldsInput.optional(),
      attachments: z.array(attachmentSchema).max(10).optional(),
    }),
    handler: async (c) => {
      assertPriorityAllowed(app, c.body.priority);
      const p = c.customer();
      const user = await getUser(app.db, p.userId, null);
      const ticket = await app.db.tx((tx) =>
        createTicket(tx, app, {
          userId: user.id,
          orgId: p.orgId,
          requesterEmail: user.email,
          requesterName: user.name,
          subject: c.body.subject,
          body: c.body.body,
          priority: c.body.priority,
          categoryId: c.body.categoryId,
          customFields: c.body.customFields,
          channel: 'web',
          authorType: 'customer',
          authorId: user.id,
          attachments: c.body.attachments,
        }, c.actor),
      );
      return presentForCustomer(ticket);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/support/tickets/:id',
    auth: 'client',
    summary: 'A ticket and its conversation (internal notes are never included)',
    tags: ['Client'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const t = await ownTicket(app, c, c.params.id);
      return { ...presentForCustomer(t), ...(await customerThread(app, t.id)) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/support/tickets/:id/reply',
    auth: 'client',
    summary: 'Reply to your ticket (reopens it if it was solved)',
    tags: ['Client'],
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    rateLimit: { max: 60, windowSec: 3600, by: 'principal' },
    params: z.object({ id: z.string() }),
    body: z.object({ body: z.string().trim().min(1).max(50_000), attachments: z.array(attachmentSchema).max(10).optional() }),
    handler: async (c) => {
      const t = await ownTicket(app, c, c.params.id);
      await app.db.tx((tx) => addMessage(tx, app, t.id, { authorType: 'customer', authorId: c.customer().userId, body: c.body.body, internal: false, channel: 'web', attachments: c.body.attachments }, c.actor));
      const fresh = await ownTicket(app, c, t.id);
      return { ...presentForCustomer(fresh), ...(await customerThread(app, t.id)) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/support/tickets/:id/rate',
    auth: 'client',
    summary: 'Rate the support you received (after the ticket is solved)',
    tags: ['Client'],
    params: z.object({ id: z.string() }),
    body: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const t = await tx.maybe<any>(sql`SELECT * FROM tickets WHERE id = ${c.params.id} AND user_id = ${c.customer().userId} FOR UPDATE`);
        if (!t) throw notFound('Ticket');
        if (t.status !== 'solved' && t.status !== 'closed') throw conflict('You can rate a ticket once it is solved', 'ticket_not_solved');
        if (t.csat_rating) throw conflict('You already rated this ticket', 'already_rated');
        await tx.exec(sql`UPDATE tickets SET csat_rating = ${c.body.rating}, csat_comment = ${c.body.comment ?? null}, csat_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${t.id}`);
        await app.events.emit(tx, 'ticket.rated', { ticketId: t.id, number: t.number, rating: c.body.rating }, { userId: t.user_id, orgId: t.org_id });
        if (c.body.rating <= 2) {
          await notifyAdmins(tx, app, { permission: 'support.tickets.manage', type: 'ticket.low_rating', title: `Low CSAT on ${t.number}`, body: c.body.comment ?? `${c.body.rating}/5`, link: `/customers/support/${t.id}`, severity: 'warning' });
        }
        return presentForCustomer(await tx.one(sql`SELECT * FROM tickets WHERE id = ${t.id}`));
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/client/support/attachments/:id',
    auth: 'client',
    summary: 'Download an attachment from one of your tickets',
    tags: ['Client'],
    params: z.object({ id: z.string() }),
    handler: async (c) => sendFile(c, await readAttachment(app, c.params.id, sql`t.user_id = ${c.customer().userId} AND NOT a.is_internal`)),
  });

  // ---- Integration API -------------------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/v1/support/tickets',
    auth: 'api',
    scope: 'support:write',
    summary: "Open a ticket on a user's behalf (e.g. from your in-app contact form)",
    tags: ['Support'],
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    body: z.object({
      userId: z.string(),
      orgId: z.string().optional(),
      subject: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(50_000),
      priority: priorityEnum.optional(),
      categoryId: z.string().optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
      customFields: customFieldsInput.optional(),
      attachments: z.array(attachmentSchema).max(10).optional(),
    }),
    handler: async (c) => {
      const user = await getUser(app.db, c.body.userId, c.orgScope());
      const orgId = c.body.orgId ?? c.apiKey().orgId;
      if (orgId && !(await app.db.maybe(sql`SELECT 1 FROM memberships WHERE org_id = ${orgId} AND user_id = ${user.id}`))) throw notFound('Membership');
      const ticket = await app.db.tx((tx) =>
        createTicket(tx, app, {
          userId: user.id,
          orgId: orgId ?? null,
          requesterEmail: user.email,
          requesterName: user.name,
          subject: c.body.subject,
          body: c.body.body,
          priority: c.body.priority,
          categoryId: c.body.categoryId,
          tags: c.body.tags,
          customFields: c.body.customFields,
          channel: 'api',
          authorType: 'customer',
          authorId: user.id,
          attachments: c.body.attachments,
        }, c.actor),
      );
      c.reply.status(201);
      return presentForCustomer(ticket);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/support/tickets',
    auth: 'api',
    scope: 'support:read',
    summary: "A user's tickets",
    tags: ['Support'],
    query: z.object({ userId: z.string(), ...pageQuery }),
    handler: async (c) => {
      await getUser(app.db, c.query.userId, c.orgScope());
      const page = await paginate<any>(app.db, {
        select: sql`*`,
        from: sql`tickets`,
        where: sql`WHERE user_id = ${c.query.userId}`,
        orderBy: sql`ORDER BY updated_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      return { ...page, data: page.data.map(presentForCustomer) };
    },
  });
}

export { addAttachment };
