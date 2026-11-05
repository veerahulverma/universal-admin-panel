import { z } from 'zod';
import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { DAY, MINUTE } from '../../core/clock.js';
import { writeAudit } from '../../core/audit.js';
import { renderTemplate } from '../../core/template.js';
import { notifyAdmins } from '../iam/notify.js';
import { sendSystemEmail, type SystemEmail } from '../core/mail.js';
import { createUser } from '../customers/service.js';
import { agentsWith, nextRoundRobinAgent, notifyAgents } from './assignment.js';
import { validateTicketFields, type TicketField } from './fields.js';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketStatus = 'open' | 'pending' | 'on_hold' | 'solved' | 'closed';
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

const minutesByPriority = z.object({
  low: z.number().int().min(1),
  normal: z.number().int().min(1),
  high: z.number().int().min(1),
  urgent: z.number().int().min(1),
});

export const supportSettingsSchema = z.object({
  /** Solved tickets close automatically after this many days without a customer reply. */
  autoCloseDays: z.number().int().min(1).max(90),
  firstResponseMinutes: minutesByPriority,
  resolutionMinutes: minutesByPriority,
  maxAttachmentBytes: z.number().int().min(1024).max(50 * 1024 * 1024),
  allowedAttachmentTypes: z.array(z.string().max(100)).max(50),
  closedTicketRetentionDays: z.number().int().min(30).max(3650),
  customerCanSetPriority: z.boolean(),
  /** Inbound email from unknown senders creates a user (otherwise the ticket has only an email). */
  createUsersFromEmail: z.boolean(),
  /** New tickets that are still unassigned (no assignee and no category default) rotate through the pool. */
  roundRobinEnabled: z.boolean(),
  roundRobinAgentIds: z.array(z.string().max(100)).max(200),
  /** Link to an article in your help center, e.g. https://example.com/help/{slug}. Empty: suggestions carry no link. */
  kbArticleUrl: z
    .string()
    .max(500)
    .refine((v) => v === '' || (/^https?:\/\//.test(v) && v.includes('{slug}')), 'Use an http(s) URL containing {slug}, or leave it empty'),
});
export type SupportSettings = z.infer<typeof supportSettingsSchema>;

export const supportDefaults: SupportSettings = {
  autoCloseDays: 7,
  firstResponseMinutes: { low: 1440, normal: 480, high: 240, urgent: 60 },
  resolutionMinutes: { low: 5760, normal: 2880, high: 1440, urgent: 480 },
  maxAttachmentBytes: 10 * 1024 * 1024,
  allowedAttachmentTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'application/json', 'application/zip'],
  closedTicketRetentionDays: 730,
  customerCanSetPriority: false,
  createUsersFromEmail: true,
  roundRobinEnabled: false,
  roundRobinAgentIds: [],
  kbArticleUrl: '',
};

export const settingsOf = (app: App) => app.settings.get<SupportSettings>('support');

export interface TicketRow {
  id: string;
  number: string;
  user_id: string | null;
  org_id: string | null;
  requester_email: string;
  requester_name: string | null;
  subject: string;
  status: TicketStatus;
  priority: Priority;
  category_id: string | null;
  assignee_id: string | null;
  channel: string;
  tags: string[];
  custom_fields: Record<string, unknown>;
  watcher_ids: string[];
  email_thread_id: string | null;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_responded_at: Date | null;
  solved_at: Date | null;
  closed_at: Date | null;
  escalated_at: Date | null;
  csat_rating: number | null;
  created_at: Date;
}

/** Org-scoped admins only see tickets of their organizations (directly or through the requester's membership). */
export function ticketScopeSql(scope: string[] | null, alias = 't'): Sql | null {
  if (!scope) return null;
  const a = sql.raw(alias);
  return sql`(${a}.org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${a}.user_id AND m.org_id IN ${sql.in(scope)}))`;
}

export async function getTicket(db: Db, id: string, scope: string[] | null, opts: { lock?: boolean } = {}): Promise<TicketRow & Record<string, any>> {
  const row = await db.maybe<TicketRow & Record<string, any>>(sql`
    SELECT t.* FROM tickets t ${sql.where([sql`(t.id = ${id} OR t.number = ${id})`, ticketScopeSql(scope)])} ${opts.lock ? sql`FOR UPDATE` : sql.empty}
  `);
  if (!row) throw notFound('Ticket');
  return row;
}

/** Best-effort customer email: support must keep working when email is disabled or a template is missing. */
async function email(app: App, db: Db, message: SystemEmail): Promise<void> {
  try {
    await db.tx((inner) => sendSystemEmail(app, inner, message));
  } catch (err) {
    app.log.warn({ err, template: message.template }, 'support email could not be queued');
  }
}

// ---- Attachments ----------------------------------------------------------------------

export interface AttachmentInput {
  filename: string;
  contentType: string;
  /** Base64-encoded file contents. */
  data: string;
}

export const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().toLowerCase().max(100),
  data: z.string().max(70 * 1024 * 1024),
});

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'application/zip': (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
};

/** Declared type must be allowed and match the file's actual bytes (blocks disguised executables). */
export function validateAttachment(app: App, input: AttachmentInput): Buffer {
  const s = settingsOf(app);
  if (!s.allowedAttachmentTypes.includes(input.contentType)) {
    throw validationError([{ path: ['attachments', 'contentType'], message: `Files of type ${input.contentType} are not allowed` }]);
  }
  const data = Buffer.from(input.data, 'base64');
  if (!data.length) throw validationError([{ path: ['attachments', 'data'], message: 'The file is empty' }]);
  if (data.length > s.maxAttachmentBytes) {
    throw validationError([{ path: ['attachments', 'data'], message: `Files must be smaller than ${Math.floor(s.maxAttachmentBytes / 1024 / 1024)} MB` }]);
  }
  const check = MAGIC[input.contentType];
  const textual = input.contentType.startsWith('text/') || input.contentType === 'application/json';
  const valid = check ? check(data) : textual ? !data.subarray(0, 4096).includes(0) : true;
  if (!valid) throw validationError([{ path: ['attachments', 'data'], message: `The file content does not match ${input.contentType}` }]);
  return data;
}

function storagePrefix(ticket: Pick<TicketRow, 'org_id' | 'user_id' | 'id'>): string {
  const tenant = ticket.org_id ? `org/${ticket.org_id}` : ticket.user_id ? `user/${ticket.user_id}` : 'unassigned';
  return `${tenant}/tickets/${ticket.id}`;
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._-]+/, '');
  return cleaned.slice(-100) || 'file';
}

export async function addAttachment(
  db: Db,
  app: App,
  ticket: Pick<TicketRow, 'org_id' | 'user_id' | 'id'>,
  input: AttachmentInput,
  opts: { internal: boolean; messageId: string | null; uploadedByType: 'customer' | 'admin' | 'system'; uploadedById: string | null },
): Promise<{ id: string; fileId: string; filename: string; size: number }> {
  const data = validateAttachment(app, input);
  const fileId = newId('file');
  const filename = safeFilename(input.filename);
  const stored = await app.storage.put(`${storagePrefix(ticket)}/${fileId}-${filename}`, data);
  const now = app.clock.now();
  await db.exec(sql.insert('files', {
    id: fileId,
    owner_type: 'ticket',
    owner_id: ticket.id,
    org_id: ticket.org_id,
    filename: input.filename.slice(0, 200),
    content_type: input.contentType,
    size: stored.size,
    sha256: stored.sha256,
    storage_key: stored.key,
    uploaded_by_type: opts.uploadedByType,
    uploaded_by_id: opts.uploadedById,
    created_at: now,
  }, ''));
  const id = newId('tat');
  await db.exec(sql.insert('ticket_attachments', { id, ticket_id: ticket.id, message_id: opts.messageId, file_id: fileId, is_internal: opts.internal, uploaded_by_type: opts.uploadedByType, created_at: now }, ''));
  return { id, fileId, filename: input.filename, size: stored.size };
}

export async function readAttachment(app: App, attachmentId: string, ticketFilter: Sql): Promise<{ filename: string; contentType: string; data: Buffer }> {
  const row = await app.db.maybe<{ filename: string; content_type: string; storage_key: string }>(sql`
    SELECT f.filename, f.content_type, f.storage_key FROM ticket_attachments a JOIN files f ON f.id = a.file_id JOIN tickets t ON t.id = a.ticket_id
    WHERE a.id = ${attachmentId} AND ${ticketFilter}
  `);
  if (!row) throw notFound('Attachment');
  const data = await app.storage.get(row.storage_key);
  if (!data) throw notFound('Attachment contents');
  return { filename: row.filename, contentType: row.content_type, data };
}

// ---- Tickets & messages -------------------------------------------------------------------

async function slaMinutes(db: Db, app: App, priority: Priority, categoryId: string | null): Promise<{ first: number; resolution: number }> {
  const s = settingsOf(app);
  const category = categoryId ? await db.maybe<{ first_response_minutes: number | null; resolution_minutes: number | null }>(sql`SELECT first_response_minutes, resolution_minutes FROM ticket_categories WHERE id = ${categoryId}`) : null;
  return {
    first: category?.first_response_minutes ?? s.firstResponseMinutes[priority],
    resolution: category?.resolution_minutes ?? s.resolutionMinutes[priority],
  };
}

export interface CreateTicketInput {
  userId: string | null;
  orgId: string | null;
  requesterEmail: string;
  requesterName: string | null;
  subject: string;
  body: string;
  priority?: Priority | null;
  categoryId?: string | null;
  channel: 'web' | 'email' | 'api' | 'admin';
  tags?: string[];
  customFields?: Record<string, unknown>;
  assigneeId?: string | null;
  authorType: 'customer' | 'admin';
  authorId: string | null;
  emailMessageId?: string | null;
  attachments?: AttachmentInput[];
}

export interface CategoryRow {
  id: string;
  name: string;
  default_priority: Priority;
  active: boolean;
  fields: TicketField[];
  default_assignee_id: string | null;
  watcher_ids: string[];
}

export async function getCategory(db: Db, id: string): Promise<CategoryRow | null> {
  return db.maybe<CategoryRow>(sql`SELECT id, name, default_priority, active, fields, default_assignee_id, watcher_ids FROM ticket_categories WHERE id = ${id}`);
}

export type AssignmentRule = 'manual' | 'category' | 'round_robin';

/**
 * Who gets a new ticket: the assignee chosen when it was opened, else the
 * category's default agent, else the next agent of the round-robin pool when
 * that is switched on. Unavailable agents are skipped.
 */
async function automaticAssignee(db: Db, app: App, category: CategoryRow | null): Promise<{ assigneeId: string; rule: AssignmentRule } | null> {
  if (category?.default_assignee_id) {
    const [agent] = await agentsWith(db, [category.default_assignee_id], 'support.tickets.manage');
    if (agent) return { assigneeId: agent.id, rule: 'category' };
  }
  const s = settingsOf(app);
  if (!s.roundRobinEnabled) return null;
  const next = await nextRoundRobinAgent(db, app, s.roundRobinAgentIds);
  return next ? { assigneeId: next, rule: 'round_robin' } : null;
}

const RULE_LABEL: Record<AssignmentRule, string> = { manual: 'Assigned when the ticket was opened', category: 'Default agent for the category', round_robin: 'Round-robin assignment' };

/** Event and notification for a new assignee (the agent who made the change is not notified). */
export async function announceAssignment(
  db: Db,
  app: App,
  ticket: Pick<TicketRow, 'id' | 'number' | 'subject' | 'user_id' | 'org_id'>,
  change: { assigneeId: string | null; previousAssigneeId: string | null; rule: AssignmentRule; actorAdminId: string | null },
): Promise<void> {
  if (change.assigneeId === change.previousAssigneeId) return;
  await app.events.emit(db, 'ticket.assigned', { ticketId: ticket.id, number: ticket.number, assigneeId: change.assigneeId, previousAssigneeId: change.previousAssigneeId, rule: change.rule }, { userId: ticket.user_id, orgId: ticket.org_id });
  if (!change.assigneeId) return;
  await notifyAgents(db, app, [change.assigneeId], {
    type: 'ticket.assigned',
    title: `Assigned to you: ${ticket.number} · ${ticket.subject}`,
    body: change.rule === 'manual' ? null : RULE_LABEL[change.rule],
    link: `/customers/support/${ticket.id}`,
    data: { ticketId: ticket.id },
  }, { exclude: change.actorAdminId });
}

export async function createTicket(db: Db, app: App, input: CreateTicketInput, actor: Actor): Promise<TicketRow & Record<string, any>> {
  let priority: Priority = input.priority ?? 'normal';
  let category: CategoryRow | null = null;
  if (input.categoryId) {
    category = await getCategory(db, input.categoryId);
    if (!category?.active) throw validationError([{ path: ['categoryId'], message: 'Unknown category' }]);
    priority = input.priority ?? category.default_priority;
  }
  if (input.assigneeId && !(await db.maybe(sql`SELECT 1 FROM admins WHERE id = ${input.assigneeId} AND status = 'active'`))) {
    throw validationError([{ path: ['assigneeId'], message: 'Unknown administrator' }]);
  }
  const customFields = category?.fields.length || Object.keys(input.customFields ?? {}).length
    ? validateTicketFields(category?.fields ?? [], input.customFields ?? {}, { partial: false })
    : {};
  const assigned = input.assigneeId ? { assigneeId: input.assigneeId, rule: 'manual' as const } : await automaticAssignee(db, app, category);
  const watchers = (await agentsWith(db, category?.watcher_ids ?? [], 'support.tickets.view')).map((a) => a.id);
  const now = app.clock.now();
  const sla = await slaMinutes(db, app, priority, input.categoryId ?? null);
  const seq = await db.one<{ n: number }>(sql`SELECT nextval('ticket_number_seq') AS n`);
  const id = newId('tkt');
  const number = `T-${String(seq.n).padStart(6, '0')}`;
  const agentAuthored = input.authorType === 'admin';
  await db.exec(sql.insert('tickets', {
    id,
    number,
    user_id: input.userId,
    org_id: input.orgId,
    requester_email: input.requesterEmail.toLowerCase(),
    requester_name: input.requesterName,
    subject: input.subject,
    status: agentAuthored ? 'pending' : 'open',
    priority,
    category_id: input.categoryId ?? null,
    assignee_id: assigned?.assigneeId ?? null,
    channel: input.channel,
    tags: input.tags ?? [],
    custom_fields: customFields,
    watcher_ids: watchers,
    email_thread_id: input.emailMessageId ?? null,
    first_response_due_at: new Date(now.getTime() + sla.first * MINUTE),
    resolution_due_at: new Date(now.getTime() + sla.resolution * MINUTE),
    first_responded_at: agentAuthored ? now : null,
    last_customer_message_at: agentAuthored ? null : now,
    last_agent_message_at: agentAuthored ? now : null,
    created_at: now,
    updated_at: now,
  }, ''));
  const messageId = newId('tmsg');
  await db.exec(sql.insert('ticket_messages', {
    id: messageId,
    ticket_id: id,
    author_type: input.authorType,
    author_id: input.authorId,
    body: input.body,
    is_internal: false,
    channel: input.channel,
    email_message_id: input.emailMessageId ?? null,
    created_at: now,
  }, ''));
  const ticket = await getTicket(db, id, null);
  for (const a of input.attachments ?? []) {
    await addAttachment(db, app, ticket, a, { internal: false, messageId, uploadedByType: input.authorType, uploadedById: input.authorId });
  }
  await writeAudit(db, app, { actor, action: 'ticket.create', targetType: 'ticket', targetId: id, orgId: input.orgId, metadata: { number, channel: input.channel, priority, assignment: assigned?.rule ?? null } });
  await app.events.emit(db, 'ticket.created', { ticketId: id, number, subject: input.subject, priority, channel: input.channel, userId: input.userId }, { userId: input.userId, orgId: input.orgId });
  const actorAdminId = actor.type === 'admin' ? actor.id : null;
  if (assigned) await announceAssignment(db, app, ticket, { assigneeId: assigned.assigneeId, previousAssigneeId: null, rule: assigned.rule, actorAdminId });
  await notifyAgents(db, app, watchers.filter((w) => w !== assigned?.assigneeId), {
    type: 'ticket.created',
    title: `New ticket ${number} · ${input.subject}`,
    body: `${input.requesterName ?? input.requesterEmail}${category ? ` · ${category.name}` : ''}`,
    link: `/customers/support/${id}`,
    data: { ticketId: id },
  }, { exclude: actorAdminId });
  await email(app, db, { to: ticket.requester_email, template: agentAuthored ? 'support.reply' : 'support.ticket_created', data: { number, subject: input.subject, body: input.body }, userId: input.userId, orgId: input.orgId, category: 'transactional' });
  return ticket;
}

/** The agent working a ticket and everyone watching it hear about customer activity. */
async function notifyFollowers(db: Db, app: App, ticket: TicketRow, n: { type: string; title: string; body?: string | null }): Promise<void> {
  await notifyAgents(db, app, [ticket.assignee_id, ...(ticket.watcher_ids ?? [])], { ...n, link: `/customers/support/${ticket.id}`, data: { ticketId: ticket.id } });
}

export interface MessageInput {
  authorType: 'customer' | 'admin' | 'system';
  authorId: string | null;
  authorName?: string | null;
  body: string;
  internal: boolean;
  channel: string;
  emailMessageId?: string | null;
  /** Status after an agent reply (default: pending, i.e. waiting on the customer). */
  statusAfter?: TicketStatus | null;
  attachments?: AttachmentInput[];
}

/**
 * Add a message and move the ticket through its lifecycle: agent replies record
 * the first response and wait on the customer; customer replies reopen solved
 * or waiting tickets. Internal notes change nothing the customer can see.
 */
export async function addMessage(db: Db, app: App, ticketId: string, input: MessageInput, actor: Actor): Promise<{ messageId: string; ticket: TicketRow & Record<string, any> }> {
  const ticket = await getTicket(db, ticketId, null, { lock: true });
  if (ticket.status === 'closed' && input.authorType === 'customer') throw conflict('This ticket is closed. Please open a new ticket.', 'ticket_closed');
  const now = app.clock.now();
  const messageId = newId('tmsg');
  await db.exec(sql.insert('ticket_messages', {
    id: messageId,
    ticket_id: ticket.id,
    author_type: input.authorType,
    author_id: input.authorId,
    body: input.body,
    is_internal: input.internal,
    channel: input.channel,
    email_message_id: input.emailMessageId ?? null,
    created_at: now,
  }, ''));
  for (const a of input.attachments ?? []) {
    await addAttachment(db, app, ticket, a, { internal: input.internal, messageId, uploadedByType: input.authorType, uploadedById: input.authorId });
  }
  const scope = { userId: ticket.user_id, orgId: ticket.org_id };
  if (input.authorType === 'admin' && !input.internal) {
    const status = input.statusAfter ?? 'pending';
    await db.exec(sql`
      UPDATE tickets SET status = ${status}, first_responded_at = coalesce(first_responded_at, ${now}), last_agent_message_at = ${now},
        solved_at = ${status === 'solved' ? now : null}, closed_at = ${status === 'closed' ? now : null}, updated_at = ${now}
      WHERE id = ${ticket.id}
    `);
    await app.events.emit(db, 'ticket.replied', { ticketId: ticket.id, number: ticket.number, status }, scope);
    if (status === 'solved' && ticket.status !== 'solved') await app.events.emit(db, 'ticket.solved', { ticketId: ticket.id, number: ticket.number }, scope);
    await email(app, db, {
      to: ticket.requester_email,
      template: 'support.reply',
      data: { number: ticket.number, subject: ticket.subject, body: input.body, agentName: input.authorName ?? null, status },
      userId: ticket.user_id,
      orgId: ticket.org_id,
      category: 'transactional',
    });
  } else if (input.authorType === 'customer') {
    const reopen = ['pending', 'on_hold', 'solved'].includes(ticket.status);
    await db.exec(sql`
      UPDATE tickets SET status = ${reopen ? 'open' : ticket.status}, solved_at = ${reopen ? null : ticket.solved_at},
        last_customer_message_at = ${now}, updated_at = ${now}
      WHERE id = ${ticket.id}
    `);
    await app.events.emit(db, 'ticket.customer_replied', { ticketId: ticket.id, number: ticket.number, reopened: reopen }, scope);
    await notifyFollowers(db, app, ticket, {
      type: 'ticket.customer_replied',
      title: `${reopen ? 'Reopened' : 'New reply'}: ${ticket.number} · ${ticket.subject}`,
      body: input.body.replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  } else {
    await db.exec(sql`UPDATE tickets SET updated_at = ${now} WHERE id = ${ticket.id}`);
  }
  if (input.authorType === 'admin') {
    await writeAudit(db, app, { actor, action: input.internal ? 'ticket.note' : 'ticket.reply', targetType: 'ticket', targetId: ticket.id, orgId: ticket.org_id, metadata: { messageId } });
  }
  return { messageId, ticket: await getTicket(db, ticket.id, null) };
}

export async function setTicketStatus(db: Db, app: App, ticketId: string, status: TicketStatus, actor: Actor, scope: string[] | null): Promise<TicketRow & Record<string, any>> {
  const ticket = await getTicket(db, ticketId, scope, { lock: true });
  if (ticket.status === status) return ticket;
  if (status === 'closed' && ticket.status !== 'solved') throw conflict('Solve the ticket before closing it', 'ticket_not_solved');
  if (ticket.status === 'closed') throw conflict('Closed tickets cannot be reopened; the customer can open a new one', 'ticket_closed');
  const now = app.clock.now();
  await db.exec(sql`
    UPDATE tickets SET status = ${status}, solved_at = ${status === 'solved' ? now : status === 'closed' ? ticket.solved_at : null},
      closed_at = ${status === 'closed' ? now : null}, updated_at = ${now}
    WHERE id = ${ticket.id}
  `);
  await writeAudit(db, app, { actor, action: 'ticket.status', targetType: 'ticket', targetId: ticket.id, orgId: ticket.org_id, metadata: { from: ticket.status, to: status } });
  const scopeEv = { userId: ticket.user_id, orgId: ticket.org_id };
  if (status === 'solved') await app.events.emit(db, 'ticket.solved', { ticketId: ticket.id, number: ticket.number }, scopeEv);
  else if (status === 'closed') await app.events.emit(db, 'ticket.closed', { ticketId: ticket.id, number: ticket.number }, scopeEv);
  else await app.events.emit(db, 'ticket.updated', { ticketId: ticket.id, number: ticket.number, status }, scopeEv);
  return getTicket(db, ticket.id, null);
}

export function renderSavedReply(body: string, ctx: { ticket: Pick<TicketRow, 'number' | 'subject' | 'requester_name' | 'requester_email'>; agentName: string | null }): string {
  // Replies are stored and shown as plain text, so no HTML escaping here.
  return renderTemplate(body, {
    ticket: { number: ctx.ticket.number, subject: ctx.ticket.subject },
    customer: { name: ctx.ticket.requester_name ?? ctx.ticket.requester_email, email: ctx.ticket.requester_email },
    agent: { name: ctx.agentName ?? 'Support' },
  }, { escape: false });
}

// ---- SLA & lifecycle jobs ---------------------------------------------------------------------

const NEXT_PRIORITY: Record<Priority, Priority> = { low: 'normal', normal: 'high', high: 'urgent', urgent: 'urgent' };

/** Escalate tickets whose first-response or resolution SLA passed: bump priority, note it, alert agents. Once per ticket. */
export async function escalateBreaches(app: App): Promise<number> {
  const now = app.clock.now();
  const due = await app.db.many<{ id: string }>(sql`
    SELECT id FROM tickets WHERE status NOT IN ('solved', 'closed') AND escalated_at IS NULL
      AND ((first_responded_at IS NULL AND first_response_due_at <= ${now}) OR resolution_due_at <= ${now})
    ORDER BY created_at LIMIT 200
  `);
  let count = 0;
  for (const row of due) {
    const escalated = await app.db.tx(async (tx) => {
      const t = await tx.maybe<TicketRow & Record<string, any>>(sql`SELECT * FROM tickets WHERE id = ${row.id} AND escalated_at IS NULL FOR UPDATE`);
      if (!t || t.status === 'solved' || t.status === 'closed') return false;
      const kind = !t.first_responded_at && t.first_response_due_at && t.first_response_due_at <= now ? 'first_response' : 'resolution';
      const priority = NEXT_PRIORITY[t.priority as Priority];
      await tx.exec(sql`UPDATE tickets SET priority = ${priority}, sla_breached_at = coalesce(sla_breached_at, ${now}), escalated_at = ${now}, updated_at = ${now} WHERE id = ${t.id}`);
      await tx.exec(sql.insert('ticket_messages', {
        id: newId('tmsg'),
        ticket_id: t.id,
        author_type: 'system',
        body: `SLA breached (${kind === 'first_response' ? 'first response' : 'resolution'} overdue). Priority ${t.priority === priority ? 'kept at' : 'raised to'} ${priority}.`,
        is_internal: true,
        channel: 'system',
        created_at: now,
      }, ''));
      await notifyAdmins(tx, app, {
        permission: 'support.tickets.manage',
        type: 'ticket.sla_breached',
        title: `SLA breached: ${t.number}`,
        body: `${t.subject} — ${kind === 'first_response' ? 'no first response yet' : 'not resolved in time'}`,
        link: `/customers/support/${t.id}`,
        severity: 'warning',
        data: { ticketId: t.id },
      });
      await app.events.emit(tx, 'ticket.sla_breached', { ticketId: t.id, number: t.number, sla: kind, priority }, { userId: t.user_id, orgId: t.org_id });
      return true;
    });
    if (escalated) count++;
  }
  return count;
}

export async function autoCloseSolved(app: App): Promise<number> {
  const cutoff = new Date(app.clock.now().getTime() - settingsOf(app).autoCloseDays * DAY);
  const rows = await app.db.many<{ id: string; number: string; user_id: string | null; org_id: string | null }>(sql`
    UPDATE tickets SET status = 'closed', closed_at = ${app.clock.now()}, updated_at = ${app.clock.now()}
    WHERE status = 'solved' AND solved_at <= ${cutoff} RETURNING id, number, user_id, org_id
  `);
  for (const r of rows) await app.events.emit(app.db, 'ticket.closed', { ticketId: r.id, number: r.number, automatic: true }, { userId: r.user_id, orgId: r.org_id });
  return rows.length;
}

// ---- Inbound email ------------------------------------------------------------------------------

export const inboundEmailSchema = z.object({
  from: z.string().trim().min(3).max(320),
  subject: z.string().max(998).default('(no subject)'),
  text: z.string().max(200_000).optional(),
  html: z.string().max(500_000).optional(),
  messageId: z.string().max(998).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).max(100).optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
});
export type InboundEmail = z.infer<typeof inboundEmailSchema>;

export function parseAddress(from: string): { email: string; name: string | null } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const email = (m ? m[2] : from).trim().toLowerCase();
  const name = m && m[1].trim() ? m[1].trim() : null;
  if (!z.string().email().safeParse(email).success) throw validationError([{ path: ['from'], message: 'Invalid sender address' }]);
  return { email, name };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Turn an inbound email into a ticket or a reply. Replies thread by a ticket
 * reference in the subject ([T-000123]) or by In-Reply-To/References, but only
 * when the sender is the ticket's requester, so guessing a number cannot inject
 * messages into someone else's ticket. Duplicate deliveries are ignored.
 */
export async function receiveEmail(app: App, mail: InboundEmail): Promise<{ ticketId: string; number: string; created: boolean; duplicate?: boolean }> {
  const { email: sender, name } = parseAddress(mail.from);
  const body = (mail.text?.trim() || (mail.html ? htmlToText(mail.html) : '') || '(empty message)').slice(0, 50_000);
  return app.db.tx(async (tx) => {
    if (mail.messageId) {
      const dup = await tx.maybe<{ ticket_id: string; number: string }>(sql`
        SELECT m.ticket_id, t.number FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id WHERE m.email_message_id = ${mail.messageId}
      `);
      if (dup) return { ticketId: dup.ticket_id, number: dup.number, created: false, duplicate: true };
    }
    let ticket: (TicketRow & Record<string, any>) | null = null;
    const ref = /\[?#?(T-\d{6,})\]?/i.exec(mail.subject);
    if (ref) ticket = await tx.maybe(sql`SELECT * FROM tickets WHERE number = ${ref[1].toUpperCase()}`);
    if (!ticket) {
      const ids = [mail.inReplyTo, ...(mail.references ?? [])].filter((x): x is string => Boolean(x));
      if (ids.length) {
        ticket = await tx.maybe(sql`
          SELECT t.* FROM tickets t WHERE t.email_thread_id IN ${sql.in(ids)}
             OR t.id IN (SELECT ticket_id FROM ticket_messages WHERE email_message_id IN ${sql.in(ids)})
          ORDER BY t.created_at DESC LIMIT 1
        `);
      }
    }
    const system: Actor = { type: 'system', id: null, label: 'Inbound email' };
    if (ticket && ticket.requester_email === sender && ticket.status !== 'closed') {
      await addMessage(tx, app, ticket.id, { authorType: 'customer', authorId: ticket.user_id, body, internal: false, channel: 'email', emailMessageId: mail.messageId ?? null, attachments: mail.attachments }, system);
      return { ticketId: ticket.id, number: ticket.number, created: false };
    }
    let user = await tx.maybe<{ id: string; name: string | null }>(sql`SELECT id, name FROM users WHERE lower(email) = ${sender} AND deleted_at IS NULL`);
    if (!user && settingsOf(app).createUsersFromEmail) {
      const created = await createUser(tx, app, { email: sender, name: name ?? undefined, registrationSource: 'support_email' }, system);
      user = { id: created.id, name: created.name };
    }
    const membership = user ? await tx.maybe<{ org_id: string }>(sql`SELECT org_id FROM memberships WHERE user_id = ${user.id} AND status = 'active' ORDER BY created_at LIMIT 1`) : null;
    const subject = mail.subject.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').replace(/\[?#?T-\d{6,}\]?/gi, '').trim() || '(no subject)';
    const created = await createTicket(tx, app, {
      userId: user?.id ?? null,
      orgId: membership?.org_id ?? null,
      requesterEmail: sender,
      requesterName: name ?? user?.name ?? null,
      subject: subject.slice(0, 300),
      body,
      channel: 'email',
      authorType: 'customer',
      authorId: user?.id ?? null,
      emailMessageId: mail.messageId ?? null,
      attachments: mail.attachments,
    }, system);
    return { ticketId: created.id, number: created.number, created: true };
  });
}

export async function inboundToken(app: App, db: Db = app.db): Promise<string> {
  const existing = await app.secrets.get(db, 'support', 'inbound', 'token');
  if (existing) return existing;
  const token = `inb_${randomBase62(32)}`;
  await app.secrets.set(db, 'support', 'inbound', 'token', token);
  return token;
}

export function assertPriorityAllowed(app: App, priority: Priority | undefined): void {
  if (priority && priority !== 'normal' && !settingsOf(app).customerCanSetPriority) {
    throw new AppError(422, 'priority_not_allowed', 'Customers cannot choose a ticket priority');
  }
}
