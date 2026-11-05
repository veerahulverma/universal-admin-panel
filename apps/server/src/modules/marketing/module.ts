import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { Db } from '../../core/db.js';
import type { DomainEvent } from '../../core/events.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { email as emailField, likePattern, pageQuery, paginate } from '../../core/validation.js';
import { validateTemplate } from '../../core/template.js';
import { addSearchProvider } from '../core/routes.js';
import { registerApiScopes } from '../developers/keys.js';
import { registerMergePolicy } from '../customers/merge.js';
import { queueEmail } from '../email/service.js';
import { upsertSystemTemplates } from '../email/templates.js';
import { segmentCondition, segmentRulesSchema } from './segments.js';
import { listBridgeFor, syncList, syncUserLists } from './lists.js';
import { registerListRoutes } from './list-routes.js';
import {
  MARKETING_TEMPLATES,
  attributeOrder,
  campaignStats,
  marketingDefaults,
  marketingSettingsSchema,
  scanAbandonedCheckouts,
  scheduleWinback,
  sendCampaignBatch,
  sendUpsell,
  sendWinback,
  startCampaign,
  utmParams,
} from './campaigns.js';

const campaignBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    /** The audience: a segment or a mailing list. */
    segmentId: z.string().optional(),
    listId: z.string().optional(),
    subject: z.string().trim().max(500).default(''),
    html: z.string().max(200_000).default(''),
    text: z.string().max(100_000).nullable().optional(),
    templateKey: z.string().max(100).nullable().optional(),
    utmCampaign: z.string().max(100).nullable().optional(),
    batchSize: z.number().int().min(1).max(5000).optional(),
  })
  .superRefine((b, ctx) => {
    if (Boolean(b.segmentId) === Boolean(b.listId)) ctx.addIssue({ code: 'custom', path: ['segmentId'], message: 'Choose a segment or a mailing list' });
    if (!b.templateKey && (!b.subject || !b.html)) ctx.addIssue({ code: 'custom', path: ['html'], message: 'Write a subject and body, or choose a template' });
    for (const f of ['subject', 'html', 'text'] as const) {
      const problem = b[f] ? validateTemplate(b[f]!) : null;
      if (problem) ctx.addIssue({ code: 'custom', path: [f], message: problem });
    }
  });

export const marketingModule: ModuleDefinition = {
  id: 'marketing',
  name: 'Marketing',
  description: 'Customer segments, mailing lists with double opt-in and product rules, consent-respecting email campaigns with attribution, and automated recovery, win-back and upsell flows.',
  version: '1.0.0',
  dependencies: ['core', 'customers', 'developers', 'email', 'catalog', 'billing'],
  migrations: [
    {
      version: '001',
      name: 'segments, campaigns, attribution',
      up: `
        CREATE TABLE segments (
          id text PRIMARY KEY,
          name text NOT NULL,
          description text NOT NULL DEFAULT '',
          rules jsonb NOT NULL,
          created_by text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );

        CREATE TABLE campaigns (
          id text PRIMARY KEY,
          name text NOT NULL,
          status text NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'canceled')),
          segment_id text REFERENCES segments(id),
          subject text NOT NULL DEFAULT '',
          html text NOT NULL DEFAULT '',
          text text,
          template_key text,
          utm_campaign text,
          batch_size int NOT NULL DEFAULT 200 CHECK (batch_size > 0),
          scheduled_at timestamptz,
          started_at timestamptz,
          completed_at timestamptz,
          canceled_at timestamptz,
          stats jsonb NOT NULL DEFAULT '{}',
          created_by text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE INDEX campaigns_status_idx ON campaigns (status, created_at DESC);

        CREATE TABLE campaign_recipients (
          campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          user_id text NOT NULL,
          email text NOT NULL,
          status text NOT NULL CHECK (status IN ('pending', 'queued', 'skipped')),
          skip_reason text,
          message_id text,
          created_at timestamptz NOT NULL,
          sent_at timestamptz,
          PRIMARY KEY (campaign_id, user_id)
        );
        CREATE INDEX campaign_recipients_pending_idx ON campaign_recipients (campaign_id) WHERE status = 'pending';

        CREATE TABLE campaign_attributions (
          id text PRIMARY KEY,
          campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          user_id text NOT NULL,
          order_id text NOT NULL UNIQUE,
          amount bigint NOT NULL,
          currency text NOT NULL,
          message_id text,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX campaign_attributions_campaign_idx ON campaign_attributions (campaign_id);
      `,
    },
    {
      version: '002',
      name: 'mailing lists, members, consent records, list campaigns',
      up: `
        CREATE TABLE mailing_lists (
          id text PRIMARY KEY,
          key text NOT NULL UNIQUE,
          name text NOT NULL,
          description text NOT NULL DEFAULT '',
          visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
          double_opt_in boolean NOT NULL DEFAULT false,
          auto_product_ids jsonb NOT NULL DEFAULT '[]',
          external_provider text,
          external_ref text,
          created_by text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );

        CREATE TABLE mailing_list_members (
          list_id text NOT NULL REFERENCES mailing_lists(id) ON DELETE CASCADE,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status text NOT NULL CHECK (status IN ('pending', 'subscribed', 'unsubscribed')),
          source text NOT NULL,
          consented_at timestamptz,
          confirmation_sent_at timestamptz,
          subscribed_at timestamptz,
          unsubscribed_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          PRIMARY KEY (list_id, user_id)
        );
        CREATE INDEX mailing_list_members_user_idx ON mailing_list_members (user_id);
        CREATE INDEX mailing_list_members_status_idx ON mailing_list_members (list_id, status);

        -- Append-only record of every request, subscription and unsubscription, with its source and evidence.
        CREATE TABLE mailing_list_consents (
          id text PRIMARY KEY,
          list_id text NOT NULL REFERENCES mailing_lists(id) ON DELETE CASCADE,
          user_id text NOT NULL,
          email text NOT NULL,
          action text NOT NULL CHECK (action IN ('requested', 'subscribed', 'unsubscribed')),
          source text NOT NULL,
          ip text,
          user_agent text,
          actor text,
          created_at timestamptz NOT NULL
        );
        CREATE INDEX mailing_list_consents_member_idx ON mailing_list_consents (list_id, user_id, created_at DESC);

        ALTER TABLE campaigns ADD COLUMN list_id text REFERENCES mailing_lists(id);
        CREATE INDEX campaigns_list_idx ON campaigns (list_id) WHERE list_id IS NOT NULL;
      `,
    },
  ],
  permissions: [
    { key: 'marketing.segments.view', label: 'View customer segments' },
    { key: 'marketing.segments.manage', label: 'Create and edit segments' },
    { key: 'marketing.campaigns.view', label: 'View campaigns and their results' },
    { key: 'marketing.campaigns.manage', label: 'Create and edit campaigns' },
    { key: 'marketing.campaigns.send', label: 'Schedule and send campaigns', dangerous: true },
    { key: 'marketing.lists.view', label: 'View mailing lists, members and consent records' },
    { key: 'marketing.lists.manage', label: 'Create mailing lists, set their rules and manage members' },
  ],
  nav: [
    { id: 'campaigns', label: 'Campaigns', path: '/growth/campaigns', icon: 'megaphone', section: 'growth', permission: 'marketing.campaigns.view', order: 0 },
    { id: 'segments', label: 'Segments', path: '/growth/segments', icon: 'filter', section: 'growth', permission: 'marketing.segments.view', order: 10 },
    { id: 'mailing-lists', label: 'Mailing lists', path: '/growth/lists', icon: 'mail-plus', section: 'growth', permission: 'marketing.lists.view', order: 15 },
  ],
  events: [
    { type: 'campaign.sent', description: 'A campaign finished sending' },
    { type: 'campaign.conversion', description: 'An order was attributed to a campaign' },
    { type: 'list.member_subscribed', description: 'Someone joined a mailing list (by themselves, confirmed by email, added by an administrator or by a product rule)' },
    { type: 'list.member_unsubscribed', description: 'Someone left a mailing list (unsubscribed, removed, or lost the product a rule requires)' },
  ],
  setup(app) {
    app.settings.define({
      key: 'marketing',
      module: 'marketing',
      label: 'Marketing',
      description: 'Campaign throughput, attribution window and automated flows (abandoned checkout, win-back, upsell).',
      schema: marketingSettingsSchema,
      defaults: marketingDefaults,
      permission: 'marketing.campaigns.send',
    });
    app.services['email.extraTemplates'] = [...((app.services['email.extraTemplates'] as unknown[]) ?? []), ...MARKETING_TEMPLATES];

    app.jobs.register('marketing.campaign_start', async ({ campaignId }, { app }) => startCampaign(app, campaignId), { module: 'marketing' });
    app.jobs.register('marketing.campaign_batch', async ({ campaignId, batch }, { app }) => sendCampaignBatch(app, campaignId, batch), { module: 'marketing', timeoutMs: 10 * 60_000 });
    app.jobs.register('marketing.winback', async ({ subscriptionId }, { app }) => {
      await sendWinback(app, subscriptionId);
    }, { module: 'marketing' });
    app.jobs.register('marketing.abandoned_checkouts', async (_p, { app }) => {
      await scanAbandonedCheckouts(app);
    }, { module: 'marketing' });
    app.jobs.schedule({ key: 'marketing.abandoned_checkouts', jobType: 'marketing.abandoned_checkouts', intervalSeconds: 900, description: 'Send one recovery email per abandoned checkout', module: 'marketing' });

    app.events.subscribe('marketing.attribution', 'order.paid', (event, app) => attributeOrder(app, event), { module: 'marketing' });
    app.events.subscribe('marketing.winback-schedule', 'subscription.canceled', (event, app) => scheduleWinback(app, event), { module: 'marketing' });
    app.events.subscribe('marketing.upsell', 'usage.limit_warning', async (event, app) => {
      await sendUpsell(app, event);
    }, { module: 'marketing' });

    addSearchProvider(app, 'marketing', 'marketing.campaigns.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; name: string; status: string }>(sql`SELECT id, name, status FROM campaigns WHERE name ILIKE ${likePattern(q)} LIMIT 5`);
      return rows.map((c) => ({ type: 'campaign', id: c.id, title: c.name, subtitle: c.status, url: `/growth/campaigns/${c.id}` }));
    });

    // ---- Mailing lists ---------------------------------------------------------------------------
    app.services['email.lists'] = listBridgeFor(app);
    // Merging duplicate accounts: memberships follow the kept account; on a list both were on, the kept account's choice (and opt-out) wins.
    registerMergePolicy(app, 'mailing_list_members', { kind: 'keep_target' });
    registerApiScopes(app, 'marketing', [
      { scope: 'lists:read', description: 'Read mailing lists and memberships' },
      { scope: 'lists:write', description: 'Subscribe and unsubscribe users, with their consent' },
    ]);

    app.jobs.register('marketing.list_sync', async ({ listId }, { app }) => {
      await syncList(app, listId);
    }, { module: 'marketing', timeoutMs: 10 * 60_000 });
    app.jobs.register('marketing.lists_sync', async (_p, { app }) => {
      const lists = await app.db.many<{ id: string }>(sql`SELECT id FROM mailing_lists WHERE jsonb_array_length(auto_product_ids) > 0`);
      for (const list of lists) await syncList(app, list.id);
    }, { module: 'marketing', timeoutMs: 30 * 60_000 });
    app.jobs.schedule({ key: 'marketing.lists_sync', jobType: 'marketing.lists_sync', intervalSeconds: 3600, description: 'Keep rule-based mailing lists in step with product access (expired access, missed events)', module: 'marketing' });

    // Product rules follow access as it changes: purchases, cancellations, grants, team membership.
    const syncUsers = async (userIds: string[]) => {
      for (const userId of userIds) await app.db.tx((tx) => syncUserLists(tx, app, userId));
    };
    const membersOf = async (orgId: string) => (await app.db.many<{ user_id: string }>(sql`SELECT user_id FROM memberships WHERE org_id = ${orgId}`)).map((m) => m.user_id);
    app.events.subscribe('marketing.lists.access', 'entitlements.updated', async (event: DomainEvent) => {
      const d = event.data as { subjectType?: string; subjectId?: string };
      if (!d.subjectId) return;
      await syncUsers(d.subjectType === 'organization' ? await membersOf(d.subjectId) : [d.subjectId]);
    }, { module: 'marketing' });
    app.events.subscribe('marketing.lists.membership', 'organization.*', async (event: DomainEvent) => {
      if (event.type.startsWith('organization.member_') && event.data.userId) await syncUsers([event.data.userId]);
    }, { module: 'marketing' });
    app.events.subscribe('marketing.lists.signup', 'user.created', async (event: DomainEvent) => syncUsers([event.data.userId]), { module: 'marketing' });

    app.hooks.addFilter('privacy.export', 'marketing', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      mailingLists: {
        memberships: await ctx.db.many(sql`
          SELECT l.name, m.status, m.source, m.consented_at, m.subscribed_at, m.unsubscribed_at FROM mailing_list_members m JOIN mailing_lists l ON l.id = m.list_id WHERE m.user_id = ${ctx.userId}
        `),
        consentRecords: await ctx.db.many(sql`
          SELECT l.name AS list, c.action, c.source, c.ip, c.user_agent, c.created_at FROM mailing_list_consents c JOIN mailing_lists l ON l.id = c.list_id
          WHERE c.user_id = ${ctx.userId} ORDER BY c.created_at
        `),
      },
    }));
    app.hooks.addFilter('privacy.anonymize', 'marketing', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      await ctx.db.exec(sql`DELETE FROM mailing_list_members WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`DELETE FROM mailing_list_consents WHERE user_id = ${ctx.userId}`);
      return null;
    });
  },
  async start(app) {
    await upsertSystemTemplates(app.db, app, MARKETING_TEMPLATES);
  },
  routes(r, app) {
    registerListRoutes(r, app);

    // ---- Segments ------------------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/segments',
      auth: 'admin',
      permission: 'marketing.segments.view',
      summary: 'Customer segments',
      tags: ['Marketing'],
      handler: async () => ({ data: await app.db.many(sql`SELECT * FROM segments ORDER BY name`) }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/segments/preview',
      auth: 'admin',
      permission: 'marketing.segments.view',
      summary: 'Count and sample the users matching segment rules',
      tags: ['Marketing'],
      body: z.object({ rules: segmentRulesSchema }),
      handler: async (c) => {
        const where = segmentCondition(c.body.rules, app.clock.now());
        const [counts, sample] = await Promise.all([
          app.db.one<{ total: number; reachable: number }>(sql`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE u.marketing_consent AND u.status <> 'banned'
                     AND NOT EXISTS (SELECT 1 FROM email_suppressions es WHERE es.email = lower(u.email))
                     AND NOT EXISTS (SELECT 1 FROM email_preferences ep WHERE ep.user_id = u.id AND ep.category = 'marketing' AND NOT ep.subscribed))::int AS reachable
            FROM users u WHERE ${where}
          `),
          app.db.many(sql`SELECT u.id, u.email, u.name, u.country, u.marketing_consent, u.created_at FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 10`),
        ]);
        return { ...counts, sample };
      },
    });

    const segmentBody = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(1000).default(''), rules: segmentRulesSchema });

    r.route({
      method: 'POST',
      url: '/api/admin/segments',
      auth: 'admin',
      permission: 'marketing.segments.manage',
      summary: 'Create a segment',
      tags: ['Marketing'],
      body: segmentBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const now = app.clock.now();
          const row = await tx.one(sql.insert('segments', { id: newId('seg'), name: c.body.name, description: c.body.description, rules: c.body.rules, created_by: c.admin().adminId, created_at: now, updated_at: now }));
          await c.audit(tx, 'segment.create', { type: 'segment', id: row.id }, { name: c.body.name });
          return row;
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/segments/:id',
      auth: 'admin',
      permission: 'marketing.segments.manage',
      summary: 'Update a segment',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      body: segmentBody.partial(),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe(sql`UPDATE segments SET ${sql.set({ name: c.body.name, description: c.body.description, rules: c.body.rules, updated_at: app.clock.now() })} WHERE id = ${c.params.id} RETURNING *`);
          if (!row) throw notFound('Segment');
          await c.audit(tx, 'segment.update', { type: 'segment', id: c.params.id }, { fields: Object.keys(c.body) });
          return row;
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/segments/:id',
      auth: 'admin',
      permission: 'marketing.segments.manage',
      summary: 'Delete a segment that no active campaign uses',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const used = await tx.maybe(sql`SELECT 1 FROM campaigns WHERE segment_id = ${c.params.id} LIMIT 1`);
          if (used) throw conflict('Campaigns use this segment', 'segment_in_use');
          const n = await tx.exec(sql`DELETE FROM segments WHERE id = ${c.params.id}`);
          if (!n) throw notFound('Segment');
          await c.audit(tx, 'segment.delete', { type: 'segment', id: c.params.id });
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/segments/:id/members',
      auth: 'admin',
      permission: 'marketing.segments.view',
      summary: 'Users currently in a segment',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      query: z.object(pageQuery),
      handler: async (c) => {
        const seg = await app.db.maybe<{ rules: unknown }>(sql`SELECT rules FROM segments WHERE id = ${c.params.id}`);
        if (!seg) throw notFound('Segment');
        return paginate(app.db, {
          select: sql`u.id, u.email, u.name, u.country, u.status, u.marketing_consent, u.lifetime_revenue, u.created_at`,
          from: sql`users u`,
          where: sql`WHERE ${segmentCondition(segmentRulesSchema.parse(seg.rules), app.clock.now())}`,
          orderBy: sql`ORDER BY u.created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
      },
    });

    // ---- Campaigns ------------------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/campaigns',
      auth: 'admin',
      permission: 'marketing.campaigns.view',
      summary: 'Email campaigns',
      tags: ['Marketing'],
      query: z.object({ ...pageQuery, status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'canceled']).optional() }),
      handler: (c) =>
        paginate(app.db, {
          select: sql`ca.id, ca.name, ca.status, ca.segment_id, s.name AS segment_name, ca.list_id, l.name AS list_name, ca.subject, ca.template_key, ca.scheduled_at, ca.started_at, ca.completed_at, ca.stats, ca.created_at,
                      (SELECT count(*)::int FROM campaign_recipients r WHERE r.campaign_id = ca.id AND r.status = 'queued') AS sent_count,
                      (SELECT coalesce(sum(amount), 0)::bigint FROM campaign_attributions a WHERE a.campaign_id = ca.id) AS attributed_amount`,
          from: sql`campaigns ca LEFT JOIN segments s ON s.id = ca.segment_id LEFT JOIN mailing_lists l ON l.id = ca.list_id`,
          where: sql.where([c.query.status && sql`ca.status = ${c.query.status}`]),
          orderBy: sql`ORDER BY ca.created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/campaigns/:id',
      auth: 'admin',
      permission: 'marketing.campaigns.view',
      summary: 'A campaign with delivery, engagement and revenue statistics',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const row = await app.db.maybe<any>(sql`SELECT * FROM campaigns WHERE id = ${c.params.id}`);
        if (!row) throw notFound('Campaign');
        return { ...row, results: await campaignStats(app.db, row.id) };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/campaigns',
      auth: 'admin',
      permission: 'marketing.campaigns.manage',
      summary: 'Create a campaign draft',
      tags: ['Marketing'],
      body: campaignBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          if (c.body.segmentId && !(await tx.maybe(sql`SELECT 1 FROM segments WHERE id = ${c.body.segmentId}`))) throw validationError([{ path: ['segmentId'], message: 'Unknown segment' }]);
          if (c.body.listId && !(await tx.maybe(sql`SELECT 1 FROM mailing_lists WHERE id = ${c.body.listId}`))) throw validationError([{ path: ['listId'], message: 'Unknown mailing list' }]);
          if (c.body.templateKey && !(await tx.maybe(sql`SELECT 1 FROM email_templates WHERE key = ${c.body.templateKey}`))) throw validationError([{ path: ['templateKey'], message: 'Unknown template' }]);
          const now = app.clock.now();
          const row = await tx.one(sql.insert('campaigns', {
            id: newId('cmp'),
            name: c.body.name,
            status: 'draft',
            segment_id: c.body.segmentId ?? null,
            list_id: c.body.listId ?? null,
            subject: c.body.subject,
            html: c.body.html,
            text: c.body.text ?? null,
            template_key: c.body.templateKey ?? null,
            utm_campaign: c.body.utmCampaign ?? null,
            batch_size: c.body.batchSize ?? app.settings.get('marketing').defaultBatchSize,
            created_by: c.admin().adminId,
            created_at: now,
            updated_at: now,
          }));
          await c.audit(tx, 'campaign.create', { type: 'campaign', id: row.id }, { name: c.body.name });
          return row;
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/campaigns/:id',
      auth: 'admin',
      permission: 'marketing.campaigns.manage',
      summary: 'Edit a draft or scheduled campaign',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      body: z.object({
        name: z.string().trim().min(1).max(200).optional(),
        /** Switching the audience to a segment clears the list, and the other way round. */
        segmentId: z.string().optional(),
        listId: z.string().optional(),
        subject: z.string().trim().max(500).optional(),
        html: z.string().max(200_000).optional(),
        text: z.string().max(100_000).nullable().optional(),
        templateKey: z.string().max(100).nullable().optional(),
        utmCampaign: z.string().max(100).nullable().optional(),
        batchSize: z.number().int().min(1).max(5000).optional(),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe<any>(sql`SELECT status FROM campaigns WHERE id = ${c.params.id} FOR UPDATE`);
          if (!row) throw notFound('Campaign');
          if (!['draft', 'scheduled'].includes(row.status)) throw conflict(`A ${row.status} campaign can no longer be edited`, 'campaign_locked');
          if (c.body.segmentId && c.body.listId) throw validationError([{ path: ['segmentId'], message: 'Choose a segment or a mailing list, not both' }]);
          if (c.body.segmentId && !(await tx.maybe(sql`SELECT 1 FROM segments WHERE id = ${c.body.segmentId}`))) throw validationError([{ path: ['segmentId'], message: 'Unknown segment' }]);
          if (c.body.listId && !(await tx.maybe(sql`SELECT 1 FROM mailing_lists WHERE id = ${c.body.listId}`))) throw validationError([{ path: ['listId'], message: 'Unknown mailing list' }]);
          if (c.body.templateKey && !(await tx.maybe(sql`SELECT 1 FROM email_templates WHERE key = ${c.body.templateKey}`))) throw validationError([{ path: ['templateKey'], message: 'Unknown template' }]);
          for (const f of ['subject', 'html', 'text'] as const) {
            const problem = c.body[f] ? validateTemplate(c.body[f]!) : null;
            if (problem) throw validationError([{ path: [f], message: problem }]);
          }
          const updated = await tx.one(sql`
            UPDATE campaigns SET ${sql.set({
              name: c.body.name,
              segment_id: c.body.segmentId ?? (c.body.listId ? null : undefined),
              list_id: c.body.listId ?? (c.body.segmentId ? null : undefined),
              subject: c.body.subject,
              html: c.body.html,
              text: c.body.text,
              template_key: c.body.templateKey,
              utm_campaign: c.body.utmCampaign,
              batch_size: c.body.batchSize,
              updated_at: app.clock.now(),
            })} WHERE id = ${c.params.id} RETURNING *
          `);
          await c.audit(tx, 'campaign.update', { type: 'campaign', id: c.params.id }, { fields: Object.keys(c.body) });
          return updated;
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/campaigns/:id/schedule',
      auth: 'admin',
      permission: 'marketing.campaigns.send',
      sensitive: true,
      summary: 'Schedule a campaign (or send it now)',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      body: z.object({ sendAt: z.coerce.date().optional() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe<any>(sql`SELECT * FROM campaigns WHERE id = ${c.params.id} FOR UPDATE`);
          if (!row) throw notFound('Campaign');
          if (row.status !== 'draft') throw conflict(`A ${row.status} campaign cannot be scheduled`, 'campaign_not_draft');
          const sendAt = c.body.sendAt && c.body.sendAt > app.clock.now() ? c.body.sendAt : app.clock.now();
          await tx.exec(sql`UPDATE campaigns SET status = 'scheduled', scheduled_at = ${sendAt}, updated_at = ${app.clock.now()} WHERE id = ${row.id}`);
          await app.jobs.enqueue(tx, 'marketing.campaign_start', { campaignId: row.id }, { runAt: sendAt, idempotencyKey: `campaign:${row.id}:start:${sendAt.toISOString()}`, maxAttempts: 3 });
          await c.audit(tx, 'campaign.schedule', { type: 'campaign', id: row.id }, { sendAt });
          return tx.one(sql`SELECT * FROM campaigns WHERE id = ${row.id}`);
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/campaigns/:id/cancel',
      auth: 'admin',
      permission: 'marketing.campaigns.send',
      summary: 'Cancel a scheduled campaign or stop one that is sending',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe<any>(sql`SELECT status FROM campaigns WHERE id = ${c.params.id} FOR UPDATE`);
          if (!row) throw notFound('Campaign');
          if (!['scheduled', 'sending', 'draft'].includes(row.status)) throw conflict(`A ${row.status} campaign cannot be canceled`, 'campaign_finished');
          await tx.exec(sql`UPDATE campaigns SET status = 'canceled', canceled_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${c.params.id}`);
          await c.audit(tx, 'campaign.cancel', { type: 'campaign', id: c.params.id }, { previous: row.status });
          return tx.one(sql`SELECT * FROM campaigns WHERE id = ${c.params.id}`);
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/campaigns/:id/test',
      auth: 'admin',
      permission: 'marketing.campaigns.manage',
      summary: 'Send the campaign to yourself as a test',
      tags: ['Marketing'],
      rateLimit: { max: 20, windowSec: 600, by: 'principal' },
      params: z.object({ id: z.string() }),
      body: z.object({ to: emailField.optional() }),
      handler: async (c) => {
        const row = await app.db.maybe<any>(sql`SELECT * FROM campaigns WHERE id = ${c.params.id}`);
        if (!row) throw notFound('Campaign');
        return app.db.tx(async (tx) => {
          const result = await queueEmail(tx, app, {
            to: c.body.to ?? c.admin().email,
            category: 'marketing',
            templateKey: row.template_key ?? null,
            content: row.template_key ? null : { subject: `[Test] ${row.subject}`, html: row.html, text: row.text },
            listId: row.list_id ?? null,
            linkParams: utmParams(row),
            data: { campaign: { name: row.name } },
            test: true,
            metadata: { campaignTest: row.id },
          });
          await c.audit(tx, 'campaign.test_send', { type: 'campaign', id: row.id }, { to: c.body.to ?? c.admin().email });
          return result;
        });
      },
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/campaigns/:id',
      auth: 'admin',
      permission: 'marketing.campaigns.manage',
      summary: 'Delete a draft campaign',
      tags: ['Marketing'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const n = await tx.exec(sql`DELETE FROM campaigns WHERE id = ${c.params.id} AND status = 'draft'`);
          if (!n) throw conflict('Only draft campaigns can be deleted', 'campaign_not_draft');
          await c.audit(tx, 'campaign.delete', { type: 'campaign', id: c.params.id });
        });
      },
    });
  },
};
