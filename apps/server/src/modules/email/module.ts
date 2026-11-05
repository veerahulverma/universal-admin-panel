import type { ModuleDefinition } from '../../core/modules.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { HOUR } from '../../core/clock.js';
import { likePattern } from '../../core/validation.js';
import { addSearchProvider } from '../core/routes.js';
import { registerMergePolicy } from '../customers/merge.js';
import { emailMigrations } from './migrations.js';
import { emailSettingsDefaults, emailSettingsSchema } from './settings.js';
import { SYSTEM_TEMPLATES, upsertSystemTemplates } from './templates.js';
import { deliverMessage, queueEmail, settingsOf, systemEmailSender } from './service.js';
import type { AdminNotification } from '../iam/notify.js';
import { registerAutomations, runLifecycleEmails } from './automations.js';
import { registerSequenceTriggers, runSequences } from './sequences.js';
import { registerEmailRoutes } from './routes.js';
import { registerSequenceRoutes } from './sequence-routes.js';

export const emailModule: ModuleDefinition = {
  id: 'email',
  name: 'Email',
  description: 'Email providers with fallback, editable templates, delivery queue and log, suppressions, consent, lifecycle emails and autoresponders.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers', 'developers'],
  migrations: emailMigrations,
  permissions: [
    { key: 'email.providers.view', label: 'View email providers' },
    { key: 'email.providers.manage', label: 'Configure email providers and resend email', dangerous: true },
    { key: 'email.templates.view', label: 'View email templates' },
    { key: 'email.templates.manage', label: 'Edit email templates' },
    { key: 'email.messages.view', label: 'View the email log and suppressions' },
    { key: 'email.suppressions.manage', label: 'Manage suppressions and consent records', dangerous: true },
    { key: 'email.autoresponders.view', label: 'View autoresponders and who is enrolled' },
    { key: 'email.autoresponders.manage', label: 'Create, activate and pause autoresponders' },
  ],
  nav: [
    { id: 'email-autoresponders', label: 'Autoresponders', path: '/growth/email/autoresponders', icon: 'calendar-clock', section: 'email', permission: 'email.autoresponders.view', order: 20 },
    { id: 'email-templates', label: 'Email templates', path: '/growth/email/templates', icon: 'mail', section: 'email', permission: 'email.templates.view', order: 30 },
    { id: 'email-log', label: 'Email log', path: '/growth/email/messages', icon: 'inbox', section: 'email', permission: 'email.messages.view', order: 40 },
    { id: 'email-providers', label: 'Email delivery', path: '/growth/email/providers', icon: 'send', section: 'email', permission: 'email.providers.view', order: 50 },
  ],
  events: [
    { type: 'email.preferences_updated', description: 'Someone opted in to or out of marketing email' },
    { type: 'email.sequence_enrolled', description: 'Someone was enrolled in an autoresponder' },
    { type: 'email.sequence_finished', description: 'Someone completed an autoresponder or left it (unsubscribed, trigger ended)' },
  ],
  setup(app) {
    app.settings.define({
      key: 'email',
      module: 'email',
      label: 'Email',
      description: 'Sender defaults, branding, retry policy and automatic lifecycle emails.',
      schema: emailSettingsSchema,
      defaults: emailSettingsDefaults,
      permission: 'email.providers.manage',
    });
    app.services['email.send'] = systemEmailSender(app);

    app.jobs.register(
      'email.deliver',
      async ({ messageId }, { app, job }) => {
        // Throttle queue (Settings → Email): each send takes a slot in a shared per-minute counter (atomic, across
        // workers and instances). Without a free slot the message waits for the next minute without using up an attempt.
        const { throttlePerMinute, maxAttempts } = settingsOf(app);
        if (throttlePerMinute > 0) {
          const slot = await app.rateLimiter.hit('email:send-throttle', throttlePerMinute, 60);
          if (!slot.allowed) {
            await app.jobs.enqueue(app.db, 'email.deliver', { messageId }, { runAt: slot.resetAt, maxAttempts });
            return;
          }
        }
        let outcome;
        try {
          outcome = await deliverMessage(app, messageId, { attempts: job.attempts, maxAttempts: job.max_attempts });
        } catch (err) {
          // Unexpected failure (not a provider error): put the message back so the retry can claim it.
          await app.db.exec(sql`UPDATE email_messages SET status = 'queued', last_error = ${(err as Error).message.slice(0, 2000)} WHERE id = ${messageId} AND status = 'sending'`);
          throw err;
        }
        // Throwing hands the retry (with backoff) to the job queue.
        if (outcome.status === 'queued') throw new Error(outcome.error ?? 'email delivery failed');
      },
      { module: 'email', timeoutMs: 60_000 },
    );

    // Settings → Email: a copy of every admin notification goes to the admin address and the copy list.
    app.hooks.addFilter('admin.notified', 'email', async (_v: unknown, ctx: { db: Db; notification: AdminNotification }) => {
      if (!app.modules.isEnabled('email')) return null;
      const { adminEmail, adminNotificationCopies } = settingsOf(app);
      const recipients = [...new Set([adminEmail, ...adminNotificationCopies].map((e) => e.trim().toLowerCase()).filter(Boolean))];
      const n = ctx.notification;
      for (const to of recipients) {
        await queueEmail(ctx.db, app, {
          to,
          templateKey: 'admin.notification',
          category: 'transactional',
          data: { title: n.title, body: n.body ?? '', link: n.link ? new URL(n.link, app.config.appUrl).toString() : '', severity: n.severity ?? 'info' },
          metadata: { notificationType: n.type },
        });
      }
      return null;
    });

    registerAutomations(app);
    registerSequenceTriggers(app);
    // Merging duplicate accounts: enrolments follow the kept account. Where both were enrolled for the same
    // occurrence, the kept account's enrolment stays and the duplicate's goes with its send records.
    registerMergePolicy(app, 'email_sequence_enrollments', {
      kind: 'custom',
      resolve: (tx, { sourceId, targetId }) =>
        tx.exec(sql`
          DELETE FROM email_sequence_enrollments s USING email_sequence_enrollments x
          WHERE s.user_id = ${sourceId} AND x.user_id = ${targetId} AND x.sequence_id = s.sequence_id AND x.trigger_ref = s.trigger_ref
        `),
    });

    app.jobs.register('email.sequences', async (_p, { app }) => {
      await runSequences(app);
    }, { module: 'email', timeoutMs: 10 * 60_000 });
    app.jobs.schedule({ key: 'email.sequences', jobType: 'email.sequences', intervalSeconds: 300, description: 'Enrol upcoming renewals and send autoresponder emails that are due', module: 'email' });
    app.jobs.register('email.lifecycle', async (_p, { app }) => {
      await runLifecycleEmails(app);
    }, { module: 'email', timeoutMs: 10 * 60_000 });
    app.jobs.schedule({ key: 'email.lifecycle', jobType: 'email.lifecycle', intervalSeconds: 3600, description: 'Renewal reminders and access expiry notices', module: 'email' });

    addSearchProvider(app, 'email', 'email.templates.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; key: string; name: string; locale: string }>(sql`
        SELECT id, key, name, locale FROM email_templates WHERE key ILIKE ${likePattern(q)} OR name ILIKE ${likePattern(q)} LIMIT 5
      `);
      return rows.map((t) => ({ type: 'email_template', id: t.id, title: t.name, subtitle: `${t.key} · ${t.locale}`, url: `/growth/email/templates/${t.id}` }));
    });

    app.hooks.addFilter('system.retention', 'email', async (_v: unknown, ctx: { before: (d: number) => Date; settings: { emailLogDays: number } }) => {
      await app.db.exec(sql`DELETE FROM email_messages WHERE created_at < ${ctx.before(ctx.settings.emailLogDays)} AND status NOT IN ('queued', 'sending')`);
      await app.db.exec(sql`DELETE FROM email_automation_log WHERE created_at < ${ctx.before(Math.max(400, ctx.settings.emailLogDays))}`);
      return null;
    });

    app.hooks.addFilter('privacy.export', 'email', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      email: {
        messages: await ctx.db.many(sql`SELECT template_key, subject, category, status, created_at, sent_at FROM email_messages WHERE user_id = ${ctx.userId} ORDER BY created_at DESC LIMIT 5000`),
        preferences: await ctx.db.many(sql`SELECT category, subscribed, updated_at FROM email_preferences WHERE user_id = ${ctx.userId}`),
        autoresponders: await ctx.db.many(sql`
          SELECT s.name, e.status, e.stop_reason, e.steps_sent, e.enrolled_at, e.finished_at
          FROM email_sequence_enrollments e JOIN email_sequences s ON s.id = e.sequence_id WHERE e.user_id = ${ctx.userId} ORDER BY e.enrolled_at
        `),
      },
    }));

    // Message bodies are personal data. Suppressions stay so we keep honouring "do not contact".
    app.hooks.addFilter('privacy.anonymize', 'email', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      await ctx.db.exec(sql`UPDATE email_messages SET to_email = 'anonymized', subject = '[redacted]', html = NULL, text = NULL, metadata = '{}' WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`DELETE FROM email_preferences WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`DELETE FROM email_sequence_enrollments WHERE user_id = ${ctx.userId}`);
      return null;
    });

    app.hooks.addFilter('customers.user.profile', 'email', async (panels: Record<string, unknown>, ctx: { user: { id: string; email: string } }) => {
      if (!app.modules.isEnabled('email')) return panels;
      const [recent, suppression] = await Promise.all([
        app.db.many(sql`SELECT id, template_key, subject, status, suppression_reason, created_at, opened_at FROM email_messages WHERE user_id = ${ctx.user.id} ORDER BY created_at DESC LIMIT 20`),
        app.db.maybe(sql`SELECT reason, scope, created_at FROM email_suppressions WHERE email = ${ctx.user.email.toLowerCase()}`),
      ]);
      return { ...panels, email: { recent, suppression } };
    });

    app.hooks.addFilter('system.health', 'email', async (checks: any[]) => {
      if (!app.modules.isEnabled('email')) return checks;
      const providers = await app.db.many<{ name: string; last_test_ok: boolean | null; last_test_message: string | null }>(sql`SELECT name, last_test_ok, last_test_message FROM email_providers WHERE enabled ORDER BY priority DESC`);
      const since = new Date(app.clock.now().getTime() - 24 * HOUR);
      const failed = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM email_messages WHERE status = 'failed' AND updated_at > ${since}`);
      const backlog = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM email_messages WHERE status = 'queued' AND created_at < ${new Date(app.clock.now().getTime() - HOUR)}`);
      const out = [...checks];
      if (!providers.length) {
        out.push({ name: 'Email delivery', status: app.config.isProd || !settingsOf(app).devLogFallback ? 'down' : 'unconfigured', detail: 'No email provider configured' });
      }
      for (const p of providers) {
        out.push({ name: `Email: ${p.name}`, status: p.last_test_ok === false ? 'degraded' : p.last_test_ok ? 'ok' : 'unconfigured', detail: p.last_test_message ?? 'Connection not tested yet' });
      }
      out.push({ name: 'Email queue', status: failed.count || backlog.count ? 'degraded' : 'ok', detail: `${failed.count} failed in 24h, ${backlog.count} waiting over an hour` });
      return out;
    });
  },
  async start(app) {
    await upsertSystemTemplates(app.db, app, SYSTEM_TEMPLATES);
  },
  routes(r, app) {
    registerEmailRoutes(r, app);
    registerSequenceRoutes(r, app);
  },
};
