import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { email as emailField, likePattern, pageQuery, paginate, qDate } from '../../core/validation.js';
import { escapeHtml, templateVariables, validateTemplate } from '../../core/template.js';
import { DAY } from '../../core/clock.js';
import { emailProviders, type ProviderType } from './providers.js';
import { commonVariables, renderEmail, systemTemplate, type TemplateRow } from './templates.js';
import {
  MANDATORY_CATEGORIES,
  deliverMessage,
  listBridge,
  providerContext,
  queueEmail,
  setMarketingPreference,
  suppress,
  verifyUnsubscribeToken,
  type ProviderRow,
} from './service.js';
import { applyDeliveryEvents, EmailWebhookError, parseProviderWebhook } from './webhooks.js';
import { hostedPage as page, sendHtml as html } from './pages.js';
import { getUser } from '../customers/service.js';

const CATEGORY = z.enum(['transactional', 'security', 'billing', 'marketing']);
const PROVIDER_TYPE = z.enum(['log', 'smtp', 'ses', 'resend', 'postmark', 'sendgrid', 'mailgun', 'mailjet']);

function presentProvider(row: ProviderRow & Record<string, any>, secrets: { name: string; last4: string | null }[], appUrl: string) {
  return { ...row, secrets: secrets.map((s) => ({ name: s.name, last4: s.last4 })), webhookUrl: `${appUrl}/api/public/email/events/${row.id}` };
}

function templateIssues(t: { subject?: string; html?: string; text?: string | null }): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  for (const field of ['subject', 'html', 'text'] as const) {
    const src = t[field];
    if (!src) continue;
    const problem = validateTemplate(src);
    if (problem) issues.push({ path: [field], message: problem });
  }
  return issues;
}

export function registerEmailRoutes(r: Router, app: App): void {
  // ---- Providers -------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/email/providers',
    auth: 'admin',
    permission: 'email.providers.view',
    summary: 'Email providers and available provider types',
    tags: ['Email'],
    handler: async () => {
      const rows = await app.db.many<ProviderRow & Record<string, any>>(sql`SELECT * FROM email_providers ORDER BY priority DESC, created_at`);
      const data = [];
      for (const row of rows) data.push(presentProvider(row, await app.secrets.describe(app.db, 'email_provider', row.id), app.config.appUrl));
      return {
        data,
        available: Object.values(emailProviders).map((p) => ({
          type: p.type,
          name: p.name,
          description: p.description,
          secretFields: p.secretFields,
          configSchema: z.toJSONSchema(p.configSchema, { io: 'input', unrepresentable: 'any' }),
        })),
      };
    },
  });

  const providerBody = z.object({
    type: PROVIDER_TYPE,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(-1000).max(1000).default(0),
    /** Empty uses the sender address from Settings → Email. */
    fromEmail: emailField.or(z.literal('')).default(''),
    fromName: z.string().trim().max(100).nullable().optional(),
    replyTo: emailField.nullable().optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.string().max(5000)).default({}),
  });

  async function saveProviderDetails(tx: typeof app.db, id: string, type: ProviderType, config: Record<string, unknown> | undefined, secrets: Record<string, string> | undefined) {
    const adapter = emailProviders[type];
    if (config) {
      const parsed = adapter.configSchema.safeParse(config);
      if (!parsed.success) throw validationError(parsed.error.issues.map((i) => ({ path: ['config', ...i.path.map(String)], message: i.message })));
      await tx.exec(sql`UPDATE email_providers SET config = ${sql.json(parsed.data)} WHERE id = ${id}`);
    }
    for (const [key, value] of Object.entries(secrets ?? {})) {
      if (!adapter.secretFields.some((f) => f.key === key)) throw validationError([{ path: ['secrets', key], message: 'Unknown credential' }]);
      if (value) await app.secrets.set(tx, 'email_provider', id, key, value);
    }
  }

  r.route({
    method: 'POST',
    url: '/api/admin/email/providers',
    auth: 'admin',
    permission: 'email.providers.manage',
    sensitive: true,
    summary: 'Connect an email provider (credentials are encrypted at rest)',
    tags: ['Email'],
    body: providerBody,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const adapter = emailProviders[c.body.type];
        const missing = adapter.secretFields.filter((f) => f.required && !c.body.secrets[f.key]).map((f) => f.label);
        if (missing.length) throw validationError([{ path: ['secrets'], message: `Required: ${missing.join(', ')}` }]);
        const id = newId('emp');
        const now = app.clock.now();
        await tx.exec(sql.insert('email_providers', {
          id,
          type: c.body.type,
          name: c.body.name,
          enabled: c.body.enabled,
          priority: c.body.priority,
          from_email: c.body.fromEmail,
          from_name: c.body.fromName ?? null,
          reply_to: c.body.replyTo ?? null,
          config: {},
          created_at: now,
          updated_at: now,
        }, ''));
        await saveProviderDetails(tx, id, c.body.type, c.body.config, c.body.secrets);
        await c.audit(tx, 'email_provider.create', { type: 'email_provider', id }, { type: c.body.type, credentials: Object.keys(c.body.secrets) });
        const row = await tx.one<any>(sql`SELECT * FROM email_providers WHERE id = ${id}`);
        return presentProvider(row, await app.secrets.describe(tx, 'email_provider', id), app.config.appUrl);
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/email/providers/:id',
    auth: 'admin',
    permission: 'email.providers.manage',
    sensitive: true,
    summary: 'Update an email provider or rotate its credentials',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    // No defaults here: a field left out of an update must keep its stored value.
    body: z
      .object({
        name: z.string().trim().min(1).max(100),
        enabled: z.boolean(),
        priority: z.number().int().min(-1000).max(1000),
        fromEmail: emailField.or(z.literal('')),
        fromName: z.string().trim().max(100).nullable(),
        replyTo: emailField.nullable(),
        config: z.record(z.string(), z.unknown()),
        secrets: z.record(z.string(), z.string().max(5000)),
      })
      .partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.maybe<ProviderRow>(sql`SELECT * FROM email_providers WHERE id = ${c.params.id} FOR UPDATE`);
        if (!row) throw notFound('Email provider');
        await tx.exec(sql`
          UPDATE email_providers SET ${sql.set({
            name: c.body.name,
            enabled: c.body.enabled,
            priority: c.body.priority,
            from_email: c.body.fromEmail,
            from_name: c.body.fromName,
            reply_to: c.body.replyTo,
            updated_at: app.clock.now(),
          })} WHERE id = ${row.id}
        `);
        await saveProviderDetails(tx, row.id, row.type, c.body.config, c.body.secrets);
        await c.audit(tx, 'email_provider.update', { type: 'email_provider', id: row.id }, { ...c.body, secrets: Object.keys(c.body.secrets ?? {}) });
        const updated = await tx.one<any>(sql`SELECT * FROM email_providers WHERE id = ${row.id}`);
        return presentProvider(updated, await app.secrets.describe(tx, 'email_provider', row.id), app.config.appUrl);
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/email/providers/:id',
    auth: 'admin',
    permission: 'email.providers.manage',
    sensitive: true,
    summary: 'Remove an email provider',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const n = await tx.exec(sql`DELETE FROM email_providers WHERE id = ${c.params.id}`);
        if (!n) throw notFound('Email provider');
        await app.secrets.delete(tx, 'email_provider', c.params.id);
        await c.audit(tx, 'email_provider.delete', { type: 'email_provider', id: c.params.id });
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/providers/:id/test',
    auth: 'admin',
    permission: 'email.providers.manage',
    summary: 'Test the connection to an email provider',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe<ProviderRow>(sql`SELECT * FROM email_providers WHERE id = ${c.params.id}`);
      if (!row) throw notFound('Email provider');
      let result: { ok: boolean; message: string };
      try {
        result = await emailProviders[row.type].test(await providerContext(app, app.db, row));
      } catch (err) {
        result = { ok: false, message: (err as Error).message };
      }
      await app.db.exec(sql`UPDATE email_providers SET last_test_at = ${app.clock.now()}, last_test_ok = ${result.ok}, last_test_message = ${result.message} WHERE id = ${row.id}`);
      return result;
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/test',
    auth: 'admin',
    permission: 'email.providers.manage',
    summary: 'Send a test email now (through one provider, or the normal fallback chain)',
    tags: ['Email'],
    rateLimit: { max: 20, windowSec: 600, by: 'principal' },
    body: z.object({ to: emailField, providerId: z.string().optional(), templateId: z.string().optional() }),
    handler: async (c) => {
      let templateKey = 'email.test';
      let locale: string | null = null;
      let data: Record<string, unknown> = { message: `Sent by ${c.admin().email} at ${app.clock.now().toISOString()}.` };
      if (c.body.templateId) {
        const tpl = await app.db.maybe<TemplateRow>(sql`SELECT * FROM email_templates WHERE id = ${c.body.templateId}`);
        if (!tpl) throw notFound('Template');
        templateKey = tpl.key;
        locale = tpl.locale;
        data = tpl.sample_data;
      }
      const queued = await app.db.tx(async (tx) => {
        const q = await queueEmail(tx, app, { to: c.body.to, templateKey, locale, data, test: true, delivery: 'manual', metadata: { requestedBy: c.admin().adminId } });
        await c.audit(tx, 'email.test_send', { type: 'email_message', id: q.id }, { to: c.body.to, providerId: c.body.providerId ?? null, templateKey });
        return q;
      });
      if (queued.status !== 'queued') return { ok: false, messageId: queued.id, error: queued.reason };
      const outcome = await deliverMessage(app, queued.id, { attempts: 1, maxAttempts: 1 }, c.body.providerId ?? null);
      return { ok: outcome.status === 'sent', messageId: queued.id, providerMessageId: outcome.providerMessageId ?? null, error: outcome.error ?? null };
    },
  });

  // ---- Templates ---------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/email/templates',
    auth: 'admin',
    permission: 'email.templates.view',
    summary: 'Email templates',
    tags: ['Email'],
    query: z.object({ category: CATEGORY.optional(), q: z.string().max(100).optional(), key: z.string().max(100).optional() }),
    handler: async (c) => ({
      data: await app.db.many(sql`
        SELECT id, key, locale, name, description, category, subject, variables, is_system, edited, version, updated_at FROM email_templates
        ${sql.where([
          c.query.category && sql`category = ${c.query.category}`,
          c.query.key && sql`key = ${c.query.key}`,
          c.query.q && sql`(key ILIKE ${likePattern(c.query.q)} OR name ILIKE ${likePattern(c.query.q)} OR subject ILIKE ${likePattern(c.query.q)})`,
        ])}
        ORDER BY key, locale
      `),
    }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/email/templates/:id',
    auth: 'admin',
    permission: 'email.templates.view',
    summary: 'One template with its content',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe(sql`SELECT * FROM email_templates WHERE id = ${c.params.id}`);
      if (!row) throw notFound('Template');
      return row;
    },
  });

  const templateBody = z.object({
    key: z.string().regex(/^[a-z][a-z0-9_.-]{1,80}$/, 'Use lowercase letters, digits, dots, dashes and underscores'),
    locale: z.string().regex(/^[a-z]{2}([-_][A-Za-z]{2,4})?$/, 'Use a locale like en, de or pt-BR').default('en'),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).default(''),
    category: CATEGORY,
    subject: z.string().trim().min(1).max(500),
    html: z.string().min(1).max(200_000),
    text: z.string().max(100_000).nullable().optional(),
    variables: z.array(z.string().max(80)).max(100).default([]),
    sampleData: z.record(z.string(), z.unknown()).default({}),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/templates',
    auth: 'admin',
    permission: 'email.templates.manage',
    summary: 'Create a template (or a translation of an existing key)',
    tags: ['Email'],
    body: templateBody,
    handler: async (c) => {
      const issues = templateIssues(c.body);
      if (issues.length) throw validationError(issues);
      return app.db.tx(async (tx) => {
        if (await tx.maybe(sql`SELECT 1 FROM email_templates WHERE key = ${c.body.key} AND locale = ${c.body.locale}`)) {
          throw conflict('A template with this key and locale exists', 'template_exists');
        }
        const now = app.clock.now();
        const row = await tx.one(sql.insert('email_templates', {
          id: newId('etpl'),
          key: c.body.key,
          locale: c.body.locale,
          name: c.body.name,
          description: c.body.description,
          category: c.body.category,
          subject: c.body.subject,
          html: c.body.html,
          text: c.body.text ?? null,
          variables: c.body.variables,
          sample_data: c.body.sampleData,
          is_system: false,
          edited: true,
          updated_by: c.admin().adminId,
          created_at: now,
          updated_at: now,
        }));
        await c.audit(tx, 'email_template.create', { type: 'email_template', id: row.id }, { key: c.body.key, locale: c.body.locale });
        return row;
      });
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/email/templates/:id',
    auth: 'admin',
    permission: 'email.templates.manage',
    summary: 'Edit a template (system templates keep your edits across upgrades)',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    body: templateBody.omit({ key: true, locale: true }).partial(),
    handler: async (c) => {
      const issues = templateIssues(c.body);
      if (issues.length) throw validationError(issues);
      return app.db.tx(async (tx) => {
        const before = await tx.maybe<TemplateRow>(sql`SELECT * FROM email_templates WHERE id = ${c.params.id} FOR UPDATE`);
        if (!before) throw notFound('Template');
        const row = await tx.one(sql`
          UPDATE email_templates SET ${sql.set({
            name: c.body.name,
            description: c.body.description,
            category: c.body.category,
            subject: c.body.subject,
            html: c.body.html,
            text: c.body.text,
            variables: c.body.variables,
            sample_data: c.body.sampleData,
            edited: true,
            updated_by: c.admin().adminId,
            updated_at: app.clock.now(),
          })}, version = version + 1 WHERE id = ${before.id} RETURNING *
        `);
        await c.audit(tx, 'email_template.update', { type: 'email_template', id: before.id }, { key: before.key, locale: before.locale, fields: Object.keys(c.body) });
        return row;
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/templates/:id/reset',
    auth: 'admin',
    permission: 'email.templates.manage',
    summary: 'Restore a system template to the shipped default',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const row = await tx.maybe<TemplateRow>(sql`SELECT * FROM email_templates WHERE id = ${c.params.id} FOR UPDATE`);
        if (!row) throw notFound('Template');
        const def = systemTemplate(row.key, row.locale, (app.services['email.extraTemplates'] as any[]) ?? []);
        if (!row.is_system || !def) throw conflict('Only shipped system templates can be reset', 'not_system_template');
        const updated = await tx.one(sql`
          UPDATE email_templates SET subject = ${def.subject}, html = ${def.html}, text = ${def.text ?? null}, category = ${def.category},
            variables = ${sql.json(def.variables)}, sample_data = ${sql.json(def.sampleData)}, edited = FALSE, version = version + 1, updated_at = ${app.clock.now()}
          WHERE id = ${row.id} RETURNING *
        `);
        await c.audit(tx, 'email_template.reset', { type: 'email_template', id: row.id }, { key: row.key });
        return updated;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/email/templates/:id',
    auth: 'admin',
    permission: 'email.templates.manage',
    summary: 'Delete a custom template or translation',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const row = await tx.maybe<TemplateRow>(sql`SELECT * FROM email_templates WHERE id = ${c.params.id}`);
        if (!row) throw notFound('Template');
        if (row.is_system) throw conflict('System templates cannot be deleted; reset them instead', 'system_template');
        await tx.exec(sql`DELETE FROM email_templates WHERE id = ${row.id}`);
        await c.audit(tx, 'email_template.delete', { type: 'email_template', id: row.id }, { key: row.key, locale: row.locale });
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/templates/preview',
    auth: 'admin',
    permission: 'email.templates.view',
    summary: 'Render a template draft with sample data (nothing is sent)',
    tags: ['Email'],
    body: z.object({
      subject: z.string().max(500),
      html: z.string().max(200_000),
      text: z.string().max(100_000).nullable().optional(),
      category: CATEGORY.default('transactional'),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
    handler: async (c) => {
      const issues = templateIssues(c.body);
      if (issues.length) throw validationError(issues);
      const admin = c.admin();
      const data = { ...commonVariables(app, { email: admin.email, name: admin.name }), ...c.body.data };
      const unsubscribe = MANDATORY_CATEGORIES.includes(c.body.category) ? null : `${app.config.appUrl}/u/preview`;
      const rendered = renderEmail(app, { subject: c.body.subject, html: c.body.html, text: c.body.text ?? null }, data, { unsubscribeUrl: unsubscribe });
      const used = [...new Set([...templateVariables(c.body.subject), ...templateVariables(c.body.html), ...templateVariables(c.body.text ?? '')])];
      const missingVariables = used.filter((v) => {
        let cur: any = data;
        for (const part of v.split('.')) cur = cur == null ? undefined : cur[part];
        return cur === undefined;
      });
      return { ...rendered, variables: used, missingVariables };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/templates/:id/send-test',
    auth: 'admin',
    permission: 'email.templates.manage',
    summary: 'Send a template to yourself with sample data',
    tags: ['Email'],
    rateLimit: { max: 20, windowSec: 600, by: 'principal' },
    params: z.object({ id: z.string() }),
    body: z.object({ to: emailField.optional(), data: z.record(z.string(), z.unknown()).optional() }),
    handler: async (c) => {
      const tpl = await app.db.maybe<TemplateRow>(sql`SELECT * FROM email_templates WHERE id = ${c.params.id}`);
      if (!tpl) throw notFound('Template');
      const to = c.body.to ?? c.admin().email;
      const queued = await app.db.tx(async (tx) => {
        const q = await queueEmail(tx, app, { to, templateKey: tpl.key, locale: tpl.locale, data: { ...tpl.sample_data, ...(c.body.data ?? {}) }, test: true, metadata: { requestedBy: c.admin().adminId } });
        await c.audit(tx, 'email.test_send', { type: 'email_template', id: tpl.id }, { to });
        return q;
      });
      return queued;
    },
  });

  // ---- Message log & stats ---------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/email/messages',
    auth: 'admin',
    permission: 'email.messages.view',
    summary: 'Email log',
    tags: ['Email'],
    query: z.object({
      ...pageQuery,
      status: z.string().optional(),
      to: z.string().max(254).optional(),
      userId: z.string().optional(),
      templateKey: z.string().optional(),
      campaignId: z.string().optional(),
      category: CATEGORY.optional(),
      from: qDate.optional(),
      until: qDate.optional(),
    }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`id, to_email, user_id, org_id, template_key, locale, category, subject, status, suppression_reason, attempts, provider_type,
                    provider_message_id, last_error, campaign_id, sent_at, delivered_at, opened_at, clicked_at, bounced_at, created_at`,
        from: sql`email_messages`,
        where: sql.where([
          c.query.status && sql`status IN ${sql.in(c.query.status.split(','))}`,
          c.query.to && sql`lower(to_email) = ${c.query.to.toLowerCase()}`,
          c.query.userId && sql`user_id = ${c.query.userId}`,
          c.query.templateKey && sql`template_key = ${c.query.templateKey}`,
          c.query.campaignId && sql`campaign_id = ${c.query.campaignId}`,
          c.query.category && sql`category = ${c.query.category}`,
          c.query.from && sql`created_at >= ${c.query.from}`,
          c.query.until && sql`created_at <= ${c.query.until}`,
        ]),
        orderBy: sql`ORDER BY created_at DESC, id DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/email/messages/:id',
    auth: 'admin',
    permission: 'email.messages.view',
    summary: 'One message, including its rendered content',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe(sql`SELECT * FROM email_messages WHERE id = ${c.params.id}`);
      if (!row) throw notFound('Email message');
      return row;
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/messages/:id/resend',
    auth: 'admin',
    permission: 'email.providers.manage',
    summary: 'Queue a failed message again',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const msg = await tx.maybe<any>(sql`SELECT * FROM email_messages WHERE id = ${c.params.id} FOR UPDATE`);
        if (!msg) throw notFound('Email message');
        if (msg.status !== 'failed') throw conflict(`A ${msg.status} message cannot be resent`, 'not_resendable');
        await tx.exec(sql`UPDATE email_messages SET status = 'queued', last_error = NULL, updated_at = ${app.clock.now()} WHERE id = ${msg.id}`);
        await app.jobs.enqueue(tx, 'email.deliver', { messageId: msg.id }, { idempotencyKey: `email:${msg.id}:resend:${msg.attempts}`, maxAttempts: app.settings.get('email').maxAttempts });
        await c.audit(tx, 'email.resend', { type: 'email_message', id: msg.id });
        return { ok: true };
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/email/stats',
    auth: 'admin',
    permission: 'email.messages.view',
    summary: 'Delivery statistics by day and status',
    tags: ['Email'],
    query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    handler: async (c) => {
      const since = new Date(app.clock.now().getTime() - c.query.days * DAY);
      const [daily, totals, engagement] = await Promise.all([
        app.db.many(sql`SELECT date_trunc('day', created_at) AS day, status, count(*)::int AS count FROM email_messages WHERE created_at >= ${since} GROUP BY 1, 2 ORDER BY 1`),
        app.db.many<{ status: string; count: number }>(sql`SELECT status, count(*)::int AS count FROM email_messages WHERE created_at >= ${since} GROUP BY 1`),
        app.db.one<{ opened: number; clicked: number; delivered: number }>(sql`
          SELECT count(opened_at)::int AS opened, count(clicked_at)::int AS clicked, count(delivered_at)::int AS delivered FROM email_messages WHERE created_at >= ${since}
        `),
      ]);
      const by = Object.fromEntries(totals.map((t) => [t.status, t.count]));
      const attempted = (by.sent ?? 0) + (by.bounced ?? 0) + (by.complained ?? 0);
      return {
        since,
        daily,
        totals: by,
        engagement,
        bounceRate: attempted ? (by.bounced ?? 0) / attempted : 0,
        complaintRate: attempted ? (by.complained ?? 0) / attempted : 0,
      };
    },
  });

  // ---- Suppressions & preferences --------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/email/suppressions',
    auth: 'admin',
    permission: 'email.messages.view',
    summary: 'Addresses that do not receive email',
    tags: ['Email'],
    query: z.object({ ...pageQuery, q: z.string().max(254).optional(), reason: z.string().optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`*`,
        from: sql`email_suppressions`,
        where: sql.where([c.query.q && sql`email ILIKE ${likePattern(c.query.q.toLowerCase())}`, c.query.reason && sql`reason = ${c.query.reason}`]),
        orderBy: sql`ORDER BY created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/suppressions',
    auth: 'admin',
    permission: 'email.suppressions.manage',
    summary: 'Suppress an address manually',
    tags: ['Email'],
    body: z.object({ email: emailField, scope: z.enum(['all', 'marketing']).default('all'), note: z.string().max(500).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await suppress(tx, app, { email: c.body.email, reason: 'manual', scope: c.body.scope, source: 'admin', details: { note: c.body.note ?? null }, createdBy: c.admin().adminId });
        await c.audit(tx, 'email_suppression.create', { type: 'email_suppression', id: c.body.email }, { scope: c.body.scope });
        return tx.one(sql`SELECT * FROM email_suppressions WHERE email = ${c.body.email}`);
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/email/suppressions/:email',
    auth: 'admin',
    permission: 'email.suppressions.manage',
    sensitive: true,
    summary: 'Remove a suppression (only do this when the address is known to be valid again)',
    tags: ['Email'],
    params: z.object({ email: z.string().max(254) }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const row = await tx.maybe<{ reason: string }>(sql`DELETE FROM email_suppressions WHERE email = ${c.params.email.toLowerCase()} RETURNING reason`);
        if (!row) throw notFound('Suppression');
        await c.audit(tx, 'email_suppression.delete', { type: 'email_suppression', id: c.params.email.toLowerCase() }, { reason: row.reason });
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/email/preferences',
    auth: 'admin',
    permission: 'customers.users.view',
    summary: "A user's email consent, preferences and suppression state",
    tags: ['Email'],
    query: z.object({ userId: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.query.userId, c.orgScope(), { includeDeleted: true });
      const [prefs, suppression] = await Promise.all([
        app.db.many(sql`SELECT category, subscribed, source, updated_at FROM email_preferences WHERE user_id = ${user.id} ORDER BY category`),
        app.db.maybe(sql`SELECT reason, scope, created_at FROM email_suppressions WHERE email = ${user.email.toLowerCase()}`),
      ]);
      return { userId: user.id, email: user.email, marketingConsent: user.marketing_consent, preferences: prefs, suppression };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/admin/email/preferences',
    auth: 'admin',
    permission: 'email.suppressions.manage',
    summary: "Record a user's marketing consent change on their behalf (audited)",
    tags: ['Email'],
    body: z.object({ userId: z.string(), marketing: z.boolean(), reason: z.string().trim().min(3).max(500) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const user = await getUser(tx, c.body.userId, c.orgScope());
        await setMarketingPreference(tx, app, { email: user.email, userId: user.id, subscribed: c.body.marketing, source: `admin:${c.admin().adminId}` });
        await c.audit(tx, 'email.preferences_update', { type: 'user', id: user.id }, { marketing: c.body.marketing, reason: c.body.reason });
        return { ok: true };
      }),
  });

  // ---- Client API -----------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/client/email-preferences',
    auth: 'client',
    summary: 'Your email preferences',
    tags: ['Client'],
    handler: async (c) => {
      const p = c.customer();
      const user = await getUser(app.db, p.userId, null);
      const prefs = await app.db.many<{ category: string; subscribed: boolean }>(sql`SELECT category, subscribed FROM email_preferences WHERE user_id = ${user.id}`);
      const pref = (cat: string) => prefs.find((x) => x.category === cat)?.subscribed;
      return {
        email: user.email,
        marketingConsent: user.marketing_consent,
        categories: [
          ...MANDATORY_CATEGORIES.map((category) => ({ category, subscribed: true, required: true })),
          { category: 'marketing', subscribed: Boolean(user.marketing_consent) && pref('marketing') !== false, required: false },
        ],
      };
    },
  });

  r.route({
    method: 'PUT',
    url: '/api/client/email-preferences',
    auth: 'client',
    summary: 'Update your email preferences (marketing consent)',
    tags: ['Client'],
    body: z.object({ marketing: z.boolean() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const user = await getUser(tx, c.customer().userId, null);
        await setMarketingPreference(tx, app, { email: user.email, userId: user.id, subscribed: c.body.marketing, source: 'customer' });
        return { ok: true, marketing: c.body.marketing };
      }),
  });

  // ---- Public: unsubscribe and provider events ----------------------------------------------
  // A wildcard, not a `:token` parameter: tokens carry the address, and path parameters are capped at 100 characters.
  const unsubscribeParams = z.object({ '*': z.string().min(1).max(1000) });

  r.route({
    method: 'GET',
    url: '/u/*',
    auth: 'public',
    hidden: true,
    params: unsubscribeParams,
    handler: async (c) => {
      const parsed = verifyUnsubscribeToken(app, c.params['*']);
      if (!parsed) return html(c.reply, page(app, 'Link not valid', '<h1>This link is not valid</h1><p class="muted">It may have been copied incorrectly.</p>'), 404);
      const action = `/u/${escapeHtml(c.params['*'])}`;
      // Confirmation step: link scanners follow GET links, so only POST unsubscribes.
      if (parsed.category.startsWith('list:')) {
        const name = await listBridge(app)?.name(app.db, parsed.category.slice(5));
        if (!name) return html(c.reply, page(app, 'Link not valid', '<h1>This list no longer exists</h1><p class="muted">You will not receive its emails.</p>'), 404);
        return html(c.reply, page(app, 'Unsubscribe', `
          <h1>Unsubscribe</h1><p>Stop sending <strong>${escapeHtml(name)}</strong> emails to <strong>${escapeHtml(parsed.email)}</strong>?</p>
          <form method="post" action="${action}"><button type="submit">Unsubscribe from this list</button></form>
          <form method="post" action="${action}"><input type="hidden" name="scope" value="marketing"><button type="submit" class="secondary">Unsubscribe from all marketing email</button></form>`));
      }
      return html(c.reply, page(app, 'Unsubscribe', `
        <h1>Unsubscribe</h1><p>Stop sending <strong>${escapeHtml(parsed.category)}</strong> emails to <strong>${escapeHtml(parsed.email)}</strong>?</p>
        <p class="muted">You will still receive essential account, security and billing messages.</p>
        <form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`));
    },
  });

  r.route({
    method: 'POST',
    url: '/u/*',
    auth: 'public',
    hidden: true,
    summary: 'One-click unsubscribe (RFC 8058)',
    params: unsubscribeParams,
    body: z.object({ scope: z.enum(['list', 'marketing']).optional() }),
    rateLimit: { max: 30, windowSec: 60 },
    handler: async (c) => {
      const parsed = verifyUnsubscribeToken(app, c.params['*']);
      if (!parsed) return html(c.reply, page(app, 'Link not valid', '<h1>This link is not valid</h1>'), 404);
      if (parsed.category.startsWith('list:')) {
        const bridge = listBridge(app);
        const listId = parsed.category.slice(5);
        const name = await bridge?.name(app.db, listId);
        const everything = c.body.scope === 'marketing';
        await app.db.tx(async (tx) => {
          if (bridge && name) await bridge.unsubscribe(tx, { listId, email: parsed.email, source: 'unsubscribe_link' });
          if (everything) await setMarketingPreference(tx, app, { email: parsed.email, userId: null, subscribed: false, source: 'unsubscribe_link' });
        });
        const what = everything ? 'marketing' : name ? `“${name}”` : 'these';
        return html(c.reply, page(app, 'Unsubscribed', `<h1>You're unsubscribed</h1><p class="muted">${escapeHtml(parsed.email)} will no longer receive ${escapeHtml(what)} emails.</p>`));
      }
      await app.db.tx(async (tx) => {
        if (parsed.category === 'marketing') {
          await setMarketingPreference(tx, app, { email: parsed.email, userId: null, subscribed: false, source: 'unsubscribe_link' });
        } else {
          const user = await tx.maybe<{ id: string }>(sql`SELECT id FROM users WHERE lower(email) = ${parsed.email} AND deleted_at IS NULL`);
          if (user) {
            await tx.exec(sql`
              INSERT INTO email_preferences (user_id, category, subscribed, source, updated_at) VALUES (${user.id}, ${parsed.category}, FALSE, 'unsubscribe_link', ${app.clock.now()})
              ON CONFLICT (user_id, category) DO UPDATE SET subscribed = FALSE, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
            `);
          }
        }
      });
      return html(c.reply, page(app, 'Unsubscribed', `<h1>You're unsubscribed</h1><p class="muted">${escapeHtml(parsed.email)} will no longer receive ${escapeHtml(parsed.category)} emails.</p>`));
    },
  });

  r.route({
    method: 'POST',
    url: '/api/public/email/events/:providerId',
    auth: 'public',
    summary: 'Bounce, complaint and engagement events from email providers',
    description: 'Configure this URL in your provider. Resend (Svix) and SendGrid (ECDSA) signatures are verified; Postmark needs ?token=<webhook secret>; any provider can send the generic format signed with x-steward-signature.',
    tags: ['Email'],
    params: z.object({ providerId: z.string() }),
    bodyLimit: 2 * 1024 * 1024,
    handler: async (c) => {
      const provider = await app.db.maybe<ProviderRow>(sql`SELECT * FROM email_providers WHERE id = ${c.params.providerId}`);
      if (!provider) throw notFound('Email provider');
      let events;
      try {
        events = await parseProviderWebhook(app, provider, {
          rawBody: c.req.rawBody ?? '',
          headers: c.req.headers as Record<string, string | string[] | undefined>,
          query: c.req.query as Record<string, string>,
        });
      } catch (err) {
        if (err instanceof EmailWebhookError) throw new AppError(400, 'invalid_signature', err.message);
        throw err;
      }
      return { received: events.length, ...(await applyDeliveryEvents(app, provider, events)) };
    },
  });
}
