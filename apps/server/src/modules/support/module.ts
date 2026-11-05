import type { ModuleDefinition } from '../../core/modules.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { likePattern } from '../../core/validation.js';
import { registerApiScopes } from '../developers/keys.js';
import { addSearchProvider } from '../core/routes.js';
import { supportMigrations } from './migrations.js';
import { SUPPORT_TEMPLATES } from './templates.js';
import { upsertSystemTemplates } from '../email/templates.js';
import { registerSupportRoutes } from './routes.js';
import { registerKbRoutes } from './kb-routes.js';
import { autoCloseSolved, escalateBreaches, inboundToken, settingsOf, supportDefaults, supportSettingsSchema, ticketScopeSql } from './service.js';

export const supportModule: ModuleDefinition = {
  id: 'support',
  name: 'Customer support',
  description: 'Tickets with SLAs, custom fields, automatic assignment, internal notes, saved replies, attachments, email-to-ticket, CSAT and a knowledge base.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers', 'developers'],
  migrations: supportMigrations,
  permissions: [
    { key: 'support.tickets.view', label: 'View support tickets' },
    { key: 'support.tickets.manage', label: 'Reply to, assign and resolve tickets; manage saved replies' },
    { key: 'support.settings.manage', label: 'Manage ticket categories, custom fields, SLAs, automatic assignment and the inbound email address' },
    { key: 'support.reports.view', label: 'View support reports' },
    { key: 'support.kb.view', label: 'View knowledge base articles, drafts included' },
    { key: 'support.kb.manage', label: 'Write, publish and organize knowledge base articles' },
  ],
  nav: [
    { id: 'support', label: 'Support', path: '/customers/support', icon: 'life-buoy', section: 'customers', permission: 'support.tickets.view', order: 20 },
    { id: 'kb', label: 'Knowledge base', path: '/customers/kb', icon: 'book-open', section: 'customers', permission: 'support.kb.view', order: 21 },
  ],
  events: [
    { type: 'ticket.created', description: 'A support ticket was opened' },
    { type: 'ticket.updated', description: 'A ticket was reassigned, re-prioritized or its status changed' },
    { type: 'ticket.assigned', description: 'A ticket was assigned to an agent, by hand, by its category or by round-robin' },
    { type: 'ticket.replied', description: 'An agent replied to a ticket' },
    { type: 'ticket.customer_replied', description: 'The customer replied to a ticket' },
    { type: 'ticket.solved', description: 'A ticket was solved' },
    { type: 'ticket.closed', description: 'A ticket was closed' },
    { type: 'ticket.sla_breached', description: 'A ticket missed its first-response or resolution SLA' },
    { type: 'ticket.rated', description: 'A customer rated their support experience' },
    { type: 'kb.article_published', description: 'A knowledge base article was published' },
    { type: 'kb.article_unpublished', description: 'A knowledge base article was unpublished or deleted' },
  ],
  setup(app) {
    // Lets "reset to default" in the template editor restore the shipped copy.
    app.services['email.extraTemplates'] = [...((app.services['email.extraTemplates'] as unknown[]) ?? []), ...SUPPORT_TEMPLATES];
    app.settings.define({
      key: 'support',
      module: 'support',
      label: 'Support',
      description: 'SLA targets per priority, auto-close, attachment limits and inbound email behaviour.',
      schema: supportSettingsSchema,
      defaults: supportDefaults,
      permission: 'support.settings.manage',
    });
    registerApiScopes(app, 'support', [
      { scope: 'support:read', description: "Read a user's support tickets" },
      { scope: 'support:write', description: 'Open tickets on behalf of users' },
    ]);

    app.jobs.register('support.sla', async (_p, { app }) => {
      await escalateBreaches(app);
      await autoCloseSolved(app);
    }, { module: 'support' });
    app.jobs.schedule({ key: 'support.sla', jobType: 'support.sla', intervalSeconds: 300, description: 'Escalate SLA breaches and auto-close solved tickets', module: 'support' });

    addSearchProvider(app, 'support', 'support.tickets.view', async ({ q, orgScope }) => {
      const rows = await app.db.many<{ id: string; number: string; subject: string; status: string; requester_email: string }>(sql`
        SELECT t.id, t.number, t.subject, t.status, t.requester_email FROM tickets t
        ${sql.where([sql`(t.number = ${q.toUpperCase()} OR t.subject ILIKE ${likePattern(q)} OR t.requester_email ILIKE ${likePattern(q)})`, ticketScopeSql(orgScope)])}
        ORDER BY t.updated_at DESC LIMIT 5
      `);
      return rows.map((t) => ({ type: 'ticket', id: t.id, title: `${t.number} · ${t.subject}`, subtitle: `${t.status} · ${t.requester_email}`, url: `/customers/support/${t.id}` }));
    });

    addSearchProvider(app, 'support', 'support.kb.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; title: string; slug: string; status: string }>(sql`
        SELECT id, title, slug, status FROM kb_articles WHERE title ILIKE ${likePattern(q)} OR slug ILIKE ${likePattern(q)} ORDER BY updated_at DESC LIMIT 5
      `);
      return rows.map((a) => ({ type: 'kb_article', id: a.id, title: a.title, subtitle: `Knowledge base · ${a.status}`, url: `/customers/kb/${a.id}` }));
    });

    app.hooks.addFilter('customers.user.profile', 'support', async (panels: Record<string, unknown>, ctx: { user: { id: string } }) => {
      if (!app.modules.isEnabled('support')) return panels;
      const tickets = await app.db.many(sql`
        SELECT id, number, subject, status, priority, csat_rating, created_at, updated_at FROM tickets WHERE user_id = ${ctx.user.id} ORDER BY created_at DESC LIMIT 20
      `);
      const open = (tickets as { status: string }[]).filter((t) => t.status !== 'solved' && t.status !== 'closed').length;
      return { ...panels, support: { tickets, open } };
    });

    app.hooks.addFilter('privacy.export', 'support', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      support: {
        tickets: await ctx.db.many(sql`SELECT number, subject, status, custom_fields, created_at, csat_rating, csat_comment FROM tickets WHERE user_id = ${ctx.userId}`),
        messages: await ctx.db.many(sql`
          SELECT t.number, m.author_type, m.body, m.created_at FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id
          WHERE t.user_id = ${ctx.userId} AND NOT m.is_internal AND m.author_type <> 'system' ORDER BY m.created_at
        `),
        articleFeedback: await ctx.db.many(sql`
          SELECT a.title, v.helpful, v.updated_at FROM kb_article_votes v JOIN kb_articles a ON a.id = v.article_id WHERE v.voter = ${`usr:${ctx.userId}`}
        `),
      },
    }));

    // Erasure: requester identity, customer-written messages and customer attachments are removed.
    app.hooks.addFilter('privacy.anonymize', 'support', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      // Votes stay counted on the article; only the link to the person goes.
      await ctx.db.exec(sql`UPDATE kb_article_votes SET voter = ${`erased:${newId('v')}`} WHERE voter = ${`usr:${ctx.userId}`}`);
      const tickets = await ctx.db.many<{ id: string }>(sql`SELECT id FROM tickets WHERE user_id = ${ctx.userId}`);
      if (!tickets.length) return null;
      const ids = tickets.map((t) => t.id);
      await ctx.db.exec(sql`
        UPDATE tickets SET requester_email = ${`deleted+${ctx.userId}@anonymized.invalid`}, requester_name = NULL, csat_comment = NULL, custom_fields = '{}' WHERE id IN ${sql.in(ids)}
      `);
      await ctx.db.exec(sql`UPDATE ticket_messages SET body = '[removed at the customer''s request]' WHERE ticket_id IN ${sql.in(ids)} AND author_type = 'customer'`);
      const files = await ctx.db.many<{ id: string; storage_key: string }>(sql`
        SELECT f.id, f.storage_key FROM ticket_attachments a JOIN files f ON f.id = a.file_id WHERE a.ticket_id IN ${sql.in(ids)} AND a.uploaded_by_type = 'customer'
      `);
      for (const f of files) await app.storage.delete(f.storage_key);
      if (files.length) {
        await ctx.db.exec(sql`DELETE FROM ticket_attachments WHERE file_id IN ${sql.in(files.map((f) => f.id))}`);
        await ctx.db.exec(sql`DELETE FROM files WHERE id IN ${sql.in(files.map((f) => f.id))}`);
      }
      return null;
    });

    app.hooks.addFilter('system.retention', 'support', async (_v: unknown, ctx: { before: (days: number) => Date }) => {
      if (!app.modules.isEnabled('support')) return null;
      const old = await app.db.many<{ id: string }>(sql`SELECT id FROM tickets WHERE status = 'closed' AND closed_at < ${ctx.before(settingsOf(app).closedTicketRetentionDays)} LIMIT 1000`);
      if (!old.length) return null;
      const ids = old.map((t) => t.id);
      const files = await app.db.many<{ id: string; storage_key: string }>(sql`SELECT f.id, f.storage_key FROM ticket_attachments a JOIN files f ON f.id = a.file_id WHERE a.ticket_id IN ${sql.in(ids)}`);
      for (const f of files) await app.storage.delete(f.storage_key);
      await app.db.tx(async (tx) => {
        if (files.length) await tx.exec(sql`DELETE FROM files WHERE id IN ${sql.in(files.map((f) => f.id))}`);
        await tx.exec(sql`DELETE FROM tickets WHERE id IN ${sql.in(ids)}`);
      });
      return null;
    });
  },
  async start(app) {
    // Make sure an inbound email token exists so the address can be shown in the admin UI.
    await app.db.tx((tx) => inboundToken(app, tx));
    // Ticket emails need editable templates; the table exists only when the email module is installed.
    if (app.modules.defs.some((m) => m.id === 'email')) await upsertSystemTemplates(app.db, app, SUPPORT_TEMPLATES);
  },
  routes(r, app) {
    registerSupportRoutes(r, app);
    registerKbRoutes(r, app);
  },
};
