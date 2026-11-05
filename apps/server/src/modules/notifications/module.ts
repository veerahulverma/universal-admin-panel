import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { DomainEvent } from '../../core/events.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { pageQuery, paginate } from '../../core/validation.js';
import { registerApiScopes } from '../developers/keys.js';
import { getUser } from '../customers/service.js';
import { DAY } from '../../core/clock.js';
import { formatMoney } from '../billing/money.js';
import { endpointAllowed, validSubscriptionKeys } from './webpush.js';
import { deliverProviderPush, deliverPush, notificationDefaults, notificationSettingsSchema, notifyUser, queueAdminPushes, usersForSubject, vapidKeys, type NotificationSettings } from './service.js';
import { PROVIDER_KEY, pushProviders } from './providers.js';
import { audiencePreview, audienceSchema, campaignKinds, campaignStats, createCampaign, getCampaign, sendCampaignBatch, type CampaignRow } from './campaigns.js';

const deviceBody = z.object({
  /** The push provider the token belongs to, e.g. "firebase". */
  provider: z.string().regex(PROVIDER_KEY, 'Use the provider key, e.g. firebase'),
  token: z.string().trim().min(8).max(4096),
  platform: z.enum(['ios', 'android', 'web', 'other']).default('other'),
});

/** At most this many devices per customer and provider; the least recently seen go first. */
const MAX_DEVICES = 20;

async function saveDevice(db: Db, app: App, userId: string, body: z.infer<typeof deviceBody>): Promise<{ id: string }> {
  const now = app.clock.now();
  // A token identifies one app install; registering it again moves it to the current customer.
  const row = await db.one<{ id: string }>(sql`
    INSERT INTO push_devices (id, user_id, provider, token, platform, created_at, updated_at)
    VALUES (${newId('pdev')}, ${userId}, ${body.provider}, ${body.token}, ${body.platform}, ${now}, ${now})
    ON CONFLICT (provider, token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, failure_count = 0, updated_at = EXCLUDED.updated_at
    RETURNING id
  `);
  await db.exec(sql`
    DELETE FROM push_devices WHERE id IN (
      SELECT id FROM push_devices WHERE user_id = ${userId} AND provider = ${body.provider} ORDER BY updated_at DESC OFFSET ${MAX_DEVICES}
    )
  `);
  return row;
}

/** Upcoming-renewal notifications, once per customer and billing period. */
async function renewalReminders(app: App): Promise<number> {
  const s = app.settings.get<NotificationSettings>('notifications');
  if (!s.notifyRenewalReminder || !app.modules.isEnabled('billing')) return 0;
  const now = app.clock.now();
  const subs = await app.db.many<any>(sql`
    SELECT s.id, s.subject_type, s.subject_id, s.current_period_end, p.name AS product_name
    FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id
    WHERE s.status = 'active' AND NOT s.cancel_at_period_end AND s.collection_method <> 'complimentary'
      AND NOT (pr.payment_count IS NOT NULL AND s.installments_billed >= pr.payment_count)
      AND s.current_period_end > ${now} AND s.current_period_end <= ${new Date(now.getTime() + s.renewalReminderDays * DAY)}
    ORDER BY s.current_period_end LIMIT 500
  `);
  let sent = 0;
  for (const sub of subs) {
    const key = `renewal:${sub.id}:${Math.floor(new Date(sub.current_period_end).getTime() / 1000)}`;
    await app.db.tx(async (tx) => {
      for (const userId of await usersForSubject(tx, { type: sub.subject_type, id: sub.subject_id })) {
        const exists = await tx.maybe(sql`SELECT 1 FROM notifications WHERE recipient_type = 'user' AND recipient_id = ${userId} AND data->>'reminderKey' = ${key}`);
        if (exists) continue;
        await notifyUser(tx, app, {
          userId,
          type: 'subscription.renewal_reminder',
          title: 'Your subscription renews soon',
          body: `${sub.product_name} renews on ${new Date(sub.current_period_end).toISOString().slice(0, 10)}.`,
          severity: 'info',
          data: { reminderKey: key, subscriptionId: sub.id },
        });
        sent++;
      }
    });
  }
  return sent;
}

function presentCampaign(c: CampaignRow, stats?: { notified: number; read: number; pushSent: number; pushFailed: number; pushPending: number }) {
  return {
    id: c.id,
    title: c.title,
    body: c.body,
    link: c.link,
    severity: c.severity,
    kind: c.kind,
    audience: c.audience,
    audienceLabel: c.audience_label,
    status: c.status,
    scheduledAt: c.scheduled_at,
    startedAt: c.started_at,
    finishedAt: c.finished_at,
    recipients: c.recipients,
    createdBy: c.created_by,
    createdAt: c.created_at,
    lastError: c.last_error,
    stats: stats ?? { notified: 0, read: 0, pushSent: 0, pushFailed: 0, pushPending: 0 },
  };
}

const subscriptionBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

async function saveSubscription(db: Db, app: App, recipientType: 'admin' | 'user', recipientId: string, body: z.infer<typeof subscriptionBody>, userAgent: string) {
  const settings = app.settings.get<NotificationSettings>('notifications');
  if (!endpointAllowed(body.endpoint, settings.pushServiceHosts)) throw validationError([{ path: ['endpoint'], message: 'Push endpoints must belong to a supported browser push service' }]);
  if (!validSubscriptionKeys(body.keys.p256dh, body.keys.auth)) throw validationError([{ path: ['keys'], message: 'Invalid push subscription keys' }]);
  const now = app.clock.now();
  // An endpoint belongs to one browser; re-subscribing moves it to the current recipient.
  await db.exec(sql`
    INSERT INTO push_subscriptions (id, recipient_type, recipient_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
    VALUES (${newId('psub')}, ${recipientType}, ${recipientId}, ${body.endpoint}, ${body.keys.p256dh}, ${body.keys.auth}, ${userAgent.slice(0, 300)}, ${now}, ${now})
    ON CONFLICT (endpoint) DO UPDATE SET recipient_type = EXCLUDED.recipient_type, recipient_id = EXCLUDED.recipient_id,
      p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, failure_count = 0, updated_at = EXCLUDED.updated_at
  `);
  return { ok: true };
}

function subjectOf(event: DomainEvent): { type: 'user' | 'organization'; id: string } | null {
  const d = event.data as Record<string, any>;
  if (d.subjectType && d.subjectId) return { type: d.subjectType, id: d.subjectId };
  if (event.orgId) return { type: 'organization', id: event.orgId };
  if (event.userId) return { type: 'user', id: event.userId };
  return null;
}

export const notificationsModule: ModuleDefinition = {
  id: 'notifications',
  name: 'Notifications',
  description: 'In-app notification center for customers, event-driven alerts, and web push for customers and admins.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers', 'developers'],
  migrations: [
    {
      version: '001',
      name: 'push subscriptions and deliveries',
      up: `
        CREATE TABLE push_subscriptions (
          id text PRIMARY KEY,
          recipient_type text NOT NULL CHECK (recipient_type IN ('admin', 'user')),
          recipient_id text NOT NULL,
          endpoint text NOT NULL UNIQUE,
          p256dh text NOT NULL,
          auth text NOT NULL,
          user_agent text,
          failure_count int NOT NULL DEFAULT 0,
          last_success_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE INDEX push_subscriptions_recipient_idx ON push_subscriptions (recipient_type, recipient_id);

        CREATE TABLE push_deliveries (
          id text PRIMARY KEY,
          notification_id text NOT NULL,
          subscription_id text NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
          status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'gone')),
          attempts int NOT NULL DEFAULT 0,
          last_status int,
          error text,
          created_at timestamptz NOT NULL,
          sent_at timestamptz,
          UNIQUE (notification_id, subscription_id)
        );
        CREATE INDEX push_deliveries_created_idx ON push_deliveries (created_at DESC);
      `,
    },
    {
      version: '002',
      name: 'app push devices, provider deliveries and push campaigns',
      up: `
        CREATE TABLE push_devices (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider text NOT NULL,
          token text NOT NULL,
          platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web', 'other')),
          failure_count int NOT NULL DEFAULT 0,
          last_success_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          UNIQUE (provider, token)
        );
        CREATE INDEX push_devices_user_idx ON push_devices (user_id, provider);

        CREATE TABLE push_provider_deliveries (
          id text PRIMARY KEY,
          notification_id text NOT NULL,
          provider text NOT NULL,
          user_id text NOT NULL,
          status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
          attempts int NOT NULL DEFAULT 0,
          error text,
          provider_message_id text,
          created_at timestamptz NOT NULL,
          sent_at timestamptz,
          UNIQUE (notification_id, provider)
        );
        CREATE INDEX push_provider_deliveries_created_idx ON push_provider_deliveries (created_at DESC);

        CREATE TABLE push_campaigns (
          id text PRIMARY KEY,
          title text NOT NULL,
          body text,
          link text,
          severity text NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'critical')),
          kind text NOT NULL CHECK (kind IN ('announcement', 'marketing')),
          audience jsonb NOT NULL,
          audience_label text NOT NULL,
          status text NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'canceled', 'failed')),
          scheduled_at timestamptz,
          started_at timestamptz,
          finished_at timestamptz,
          cursor text,
          recipients int NOT NULL DEFAULT 0,
          created_by text,
          last_error text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE INDEX push_campaigns_created_idx ON push_campaigns (created_at DESC);
        CREATE INDEX notifications_campaign_idx ON notifications ((data->>'campaignId')) WHERE data ? 'campaignId';
      `,
    },
  ],
  permissions: [
    { key: 'notifications.messages.view', label: "View customers' in-app notifications" },
    { key: 'notifications.messages.send', label: 'Send in-app notifications to customers' },
    { key: 'notifications.campaigns.view', label: 'View push notification campaigns and their delivery' },
    { key: 'notifications.campaigns.manage', label: 'Send push notifications to many customers at once' },
  ],
  nav: [{ id: 'push-campaigns', label: 'Push notifications', path: '/growth/push', icon: 'radio-tower', section: 'growth', permission: 'notifications.campaigns.view', order: 25 }],
  events: [
    { type: 'notification.created', description: 'An in-app notification was created for a user' },
    { type: 'push_campaign.sent', description: 'A push notification campaign finished sending' },
  ],
  setup(app) {
    app.settings.define({
      key: 'notifications',
      module: 'notifications',
      label: 'Notifications',
      description: 'Push notifications and which events notify customers (in their notification center and as a push).',
      schema: notificationSettingsSchema,
      defaults: notificationDefaults,
      permission: 'notifications.messages.send',
    });
    registerApiScopes(app, 'notifications', [
      { scope: 'notifications:read', description: "Read a user's in-app notifications" },
      { scope: 'notifications:write', description: 'Create in-app notifications for users' },
    ]);

    app.jobs.register('push.deliver', async ({ deliveryId }, { app }) => deliverPush(app, deliveryId), { module: 'notifications', timeoutMs: 30_000 });
    app.jobs.register('push.admin_scan', async (_p, { app }) => {
      await queueAdminPushes(app);
    }, { module: 'notifications' });
    app.jobs.schedule({ key: 'push.admin_scan', jobType: 'push.admin_scan', intervalSeconds: 60, description: 'Send web push for new admin notifications', module: 'notifications' });
    app.jobs.register(
      'push.provider_deliver',
      async ({ deliveryId }, { app, job }) => deliverProviderPush(app, deliveryId, { attempts: job.attempts, maxAttempts: job.max_attempts }),
      { module: 'notifications', timeoutMs: 30_000 },
    );
    app.jobs.register('push.campaign_send', async ({ campaignId }, { app }) => {
      await sendCampaignBatch(app, campaignId);
    }, { module: 'notifications', timeoutMs: 120_000 });
    app.jobs.register('notifications.renewal_reminders', async (_p, { app }) => {
      await renewalReminders(app);
    }, { module: 'notifications' });
    app.jobs.schedule({ key: 'notifications.renewal_reminders', jobType: 'notifications.renewal_reminders', intervalSeconds: 3600, description: 'Notify customers before their subscription renews', module: 'notifications' });

    const onEvent = (id: string, pattern: string, setting: keyof NotificationSettings, build: (event: DomainEvent, db: Db) => Promise<{ type: string; title: string; body?: string; link?: string; severity?: 'info' | 'success' | 'warning' | 'critical' } | null>) =>
      app.events.subscribe(
        `notifications.${id}`,
        pattern,
        async (event) => {
          if (!app.settings.get<NotificationSettings>('notifications')[setting]) return;
          const subject = subjectOf(event);
          if (!subject) return;
          await app.db.tx(async (tx) => {
            const message = await build(event, tx);
            if (!message) return;
            for (const userId of await usersForSubject(tx, subject)) {
              // Keyed by event so a retried handler never notifies twice.
              const exists = await tx.maybe(sql`SELECT 1 FROM notifications WHERE recipient_type = 'user' AND recipient_id = ${userId} AND data->>'eventId' = ${event.id}`);
              if (!exists) await notifyUser(tx, app, { userId, ...message, data: { eventId: event.id, ...(event.data as Record<string, unknown>) } });
            }
          });
        },
        { module: 'notifications' },
      );

    onEvent('usage-warning', 'usage.limit_warning', 'notifyUsageAlerts', async (e) => ({
      type: 'usage.limit_warning',
      title: `You've used ${e.data.percent ?? 80}% of your ${e.data.meter}`,
      body: `${e.data.used} of ${e.data.limit} used this period.`,
      severity: 'warning',
    }));
    onEvent('usage-reached', 'usage.limit_reached', 'notifyUsageAlerts', async (e) => ({
      type: 'usage.limit_reached',
      title: `You've reached your ${e.data.meter} limit`,
      body: `${e.data.used} of ${e.data.limit} used. Upgrade to keep going.`,
      severity: 'critical',
    }));
    onEvent('payment-failed', 'invoice.payment_failed', 'notifyPaymentFailures', async (e) => ({
      type: 'billing.payment_failed',
      title: 'Payment failed',
      body: `We could not collect payment for invoice ${e.data.number ?? ''}. Please update your payment method.`.trim(),
      severity: 'critical',
    }));
    onEvent('trial-ending', 'subscription.trial_will_end', 'notifyTrialEnding', async (e) => ({
      type: 'subscription.trial_will_end',
      title: 'Your trial ends soon',
      body: e.data.trialEnd ? `Your trial ends on ${new Date(e.data.trialEnd).toISOString().slice(0, 10)}.` : undefined,
      severity: 'info',
    }));
    onEvent('payment-succeeded', 'payment.succeeded', 'notifyPaymentSucceeded', async (e) => ({
      type: 'billing.payment_succeeded',
      title: 'Payment received',
      body: typeof e.data.amount === 'number' && e.data.currency ? `We received your payment of ${formatMoney(e.data.amount, e.data.currency)}. Thank you!` : 'We received your payment. Thank you!',
      severity: 'success',
    }));
    onEvent('subscription-canceled', 'subscription.canceled', 'notifySubscriptionCanceled', async (e) =>
      // A paid-off installment plan ends as planned; that is not a cancellation.
      e.data.reason === 'installments_completed'
        ? null
        : {
            type: 'subscription.canceled',
            title: 'Your subscription has ended',
            body: e.data.reason === 'payment_failed' ? 'It was cancelled after payments failed. Renew any time to continue.' : 'You can renew any time to continue.',
            severity: 'warning',
          },
    );

    app.hooks.addFilter('privacy.export', 'notifications', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      notifications: await ctx.db.many(sql`SELECT type, title, body, created_at, read_at FROM notifications WHERE recipient_type = 'user' AND recipient_id = ${ctx.userId}`),
      pushDevices: await ctx.db.many(sql`SELECT provider, platform, created_at, last_success_at FROM push_devices WHERE user_id = ${ctx.userId}`),
    }));
    app.hooks.addFilter('privacy.anonymize', 'notifications', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      await ctx.db.exec(sql`DELETE FROM notifications WHERE recipient_type = 'user' AND recipient_id = ${ctx.userId}`);
      await ctx.db.exec(sql`DELETE FROM push_subscriptions WHERE recipient_type = 'user' AND recipient_id = ${ctx.userId}`);
      await ctx.db.exec(sql`DELETE FROM push_devices WHERE user_id = ${ctx.userId}`);
      return null;
    });
  },
  async start(app) {
    await vapidKeys(app);
  },
  routes(r, app) {
    r.route({
      method: 'GET',
      url: '/api/public/push/vapid-public-key',
      auth: 'public',
      summary: 'VAPID public key (applicationServerKey) for browser push subscriptions',
      tags: ['Notifications'],
      handler: async () => ({ publicKey: (await vapidKeys(app)).publicKey }),
    });

    // ---- Client (browser SDK) -----------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/client/notifications',
      auth: 'client',
      summary: 'Your in-app notifications',
      tags: ['Client'],
      query: z.object({ ...pageQuery, unread: z.enum(['true', 'false']).optional() }),
      handler: async (c) => {
        const userId = c.customer().userId;
        const page = await paginate(app.db, {
          select: sql`id, type, title, body, link, severity, read_at AS "readAt", created_at AS "createdAt"`,
          from: sql`notifications`,
          where: sql.where([sql`recipient_type = 'user' AND recipient_id = ${userId}`, c.query.unread === 'true' && sql`read_at IS NULL`]),
          orderBy: sql`ORDER BY created_at DESC, id DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
        const unread = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM notifications WHERE recipient_type = 'user' AND recipient_id = ${userId} AND read_at IS NULL`);
        return { ...page, unread: unread.count };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/client/notifications/read',
      auth: 'client',
      summary: 'Mark notifications as read',
      tags: ['Client'],
      body: z.object({ ids: z.array(z.string()).max(500).optional(), all: z.boolean().optional() }),
      handler: async (c) => {
        const n = await app.db.exec(sql`
          UPDATE notifications SET read_at = ${app.clock.now()}
          WHERE recipient_type = 'user' AND recipient_id = ${c.customer().userId} AND read_at IS NULL
          ${c.body.all ? sql.empty : sql`AND id IN ${sql.in(c.body.ids ?? [])}`}
        `);
        return { updated: n };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/client/push/subscriptions',
      auth: 'client',
      summary: 'Register this browser for web push',
      tags: ['Client'],
      body: subscriptionBody,
      handler: (c) => saveSubscription(app.db, app, 'user', c.customer().userId, c.body, c.userAgent),
    });

    r.route({
      method: 'POST',
      url: '/api/client/push/subscriptions/remove',
      auth: 'client',
      summary: 'Stop web push for this browser',
      tags: ['Client'],
      body: z.object({ endpoint: z.string().max(2000) }),
      handler: async (c) => ({
        removed: await app.db.exec(sql`DELETE FROM push_subscriptions WHERE endpoint = ${c.body.endpoint} AND recipient_type = 'user' AND recipient_id = ${c.customer().userId}`),
      }),
    });

    // ---- Integration API --------------------------------------------------------------
    r.route({
      method: 'POST',
      url: '/api/v1/notifications',
      auth: 'api',
      scope: 'notifications:write',
      summary: "Add a notification to a user's notification center (and push it to their browsers)",
      tags: ['Notifications'],
      body: z.object({
        userId: z.string(),
        type: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/).default('general'),
        title: z.string().trim().min(1).max(300),
        body: z.string().max(5000).optional(),
        link: z.string().url().max(2000).optional(),
        severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'),
        data: z.record(z.string(), z.unknown()).optional(),
        push: z.boolean().default(true),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          await getUser(tx, c.body.userId, c.orgScope());
          const id = await notifyUser(tx, app, { ...c.body, data: c.body.data ?? {} });
          c.reply.status(201);
          return { id };
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/v1/notifications',
      auth: 'api',
      scope: 'notifications:read',
      summary: "A user's notifications",
      tags: ['Notifications'],
      query: z.object({ ...pageQuery, userId: z.string(), unread: z.enum(['true', 'false']).optional() }),
      handler: async (c) => {
        await getUser(app.db, c.query.userId, c.orgScope());
        return paginate(app.db, {
          select: sql`id, type, title, body, link, severity, data, read_at AS "readAt", created_at AS "createdAt"`,
          from: sql`notifications`,
          where: sql.where([sql`recipient_type = 'user' AND recipient_id = ${c.query.userId}`, c.query.unread === 'true' && sql`read_at IS NULL`]),
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
      },
    });

    // ---- Admin ------------------------------------------------------------------------
    r.route({
      method: 'POST',
      url: '/api/admin/push/subscriptions',
      auth: 'admin',
      summary: 'Register this browser for admin web push (security alerts, approvals)',
      tags: ['Notifications'],
      body: subscriptionBody,
      handler: (c) => saveSubscription(app.db, app, 'admin', c.admin().adminId, c.body, c.userAgent),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/push/subscriptions/remove',
      auth: 'admin',
      summary: 'Stop admin web push for this browser',
      tags: ['Notifications'],
      body: z.object({ endpoint: z.string().max(2000) }),
      handler: async (c) => ({
        removed: await app.db.exec(sql`DELETE FROM push_subscriptions WHERE endpoint = ${c.body.endpoint} AND recipient_type = 'admin' AND recipient_id = ${c.admin().adminId}`),
      }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/user-notifications',
      auth: 'admin',
      permission: 'notifications.messages.view',
      summary: "A customer's in-app notifications",
      tags: ['Notifications'],
      query: z.object({ ...pageQuery, userId: z.string() }),
      handler: async (c) => {
        await getUser(app.db, c.query.userId, c.orgScope(), { includeDeleted: true });
        // Push outcome per notification, over browsers and provider plugins together.
        const pushCount = (status: string[]) => sql`(
          (SELECT count(*) FROM push_deliveries d WHERE d.notification_id = n.id AND d.status IN ${sql.in(status)})
          + (SELECT count(*) FROM push_provider_deliveries p WHERE p.notification_id = n.id AND p.status IN ${sql.in(status)})
        )::int`;
        return paginate(app.db, {
          select: sql`n.*, ${pushCount(['sent'])} AS push_sent, ${pushCount(['failed', 'gone'])} AS push_failed, ${pushCount(['pending'])} AS push_pending`,
          from: sql`notifications n`,
          where: sql`WHERE n.recipient_type = 'user' AND n.recipient_id = ${c.query.userId}`,
          orderBy: sql`ORDER BY n.created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/user-notifications',
      auth: 'admin',
      permission: 'notifications.messages.send',
      summary: 'Send an in-app notification to customers',
      tags: ['Notifications'],
      body: z.object({
        userIds: z.array(z.string()).min(1).max(1000),
        title: z.string().trim().min(1).max(300),
        body: z.string().max(5000).optional(),
        link: z.string().url().max(2000).optional(),
        severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'),
        push: z.boolean().default(true),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const ids: string[] = [];
          for (const userId of c.body.userIds) {
            await getUser(tx, userId, c.orgScope());
            ids.push(await notifyUser(tx, app, { userId, type: 'admin.message', title: c.body.title, body: c.body.body, link: c.body.link, severity: c.body.severity, push: c.body.push, data: { sentBy: c.admin().adminId } }));
          }
          await c.audit(tx, 'notification.send', undefined, { recipients: c.body.userIds.length, title: c.body.title });
          return { sent: ids.length, ids };
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/push/test',
      auth: 'admin',
      summary: 'Send a test push notification to your own browsers',
      tags: ['Notifications'],
      handler: async (c) => {
        const admin = c.admin();
        const subs = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM push_subscriptions WHERE recipient_type = 'admin' AND recipient_id = ${admin.adminId}`);
        if (!subs.count) throw notFound('Push subscription for this admin');
        await app.db.tx(async (tx) => {
          await tx.exec(sql.insert('notifications', {
            id: newId('ntf'),
            recipient_type: 'admin',
            recipient_id: admin.adminId,
            type: 'push.test',
            title: 'Test notification',
            body: 'Web push is working.',
            severity: 'info',
            created_at: app.clock.now(),
          }, ''));
        });
        return { queued: await queueAdminPushes(app) };
      },
    });

    // ---- App push devices (tokens for providers such as Firebase) ------------------------------
    r.route({
      method: 'POST',
      url: '/api/client/push/devices',
      auth: 'client',
      summary: 'Register this app install for push (a device token from your push provider)',
      tags: ['Client'],
      rateLimit: { max: 30, windowSec: 60, by: 'principal' },
      body: deviceBody,
      handler: (c) => saveDevice(app.db, app, c.customer().userId, c.body),
    });

    r.route({
      method: 'POST',
      url: '/api/client/push/devices/remove',
      auth: 'client',
      summary: 'Stop push to this app install',
      tags: ['Client'],
      body: z.object({ token: z.string().max(4096) }),
      handler: async (c) => ({ removed: await app.db.exec(sql`DELETE FROM push_devices WHERE token = ${c.body.token} AND user_id = ${c.customer().userId}`) }),
    });

    r.route({
      method: 'POST',
      url: '/api/v1/users/:id/push-devices',
      auth: 'api',
      scope: 'notifications:write',
      summary: "Register a customer's app install for push, from your backend",
      tags: ['Notifications'],
      params: z.object({ id: z.string() }),
      body: deviceBody,
      handler: async (c) => {
        const user = await getUser(app.db, c.params.id, c.orgScope());
        return saveDevice(app.db, app, user.id, c.body);
      },
    });

    r.route({
      method: 'POST',
      url: '/api/v1/users/:id/push-devices/remove',
      auth: 'api',
      scope: 'notifications:write',
      summary: "Stop push to one of a customer's app installs",
      tags: ['Notifications'],
      params: z.object({ id: z.string() }),
      body: z.object({ token: z.string().max(4096) }),
      handler: async (c) => {
        const user = await getUser(app.db, c.params.id, c.orgScope());
        return { removed: await app.db.exec(sql`DELETE FROM push_devices WHERE token = ${c.body.token} AND user_id = ${user.id}`) };
      },
    });

    // ---- Push campaigns (Marketing → Push notifications) --------------------------------------
    const noOrgScope = (scope: string[] | null) => {
      if (scope) throw forbidden('Push notifications to many customers are not available to organization-scoped administrators', 'org_scope');
    };

    r.route({
      method: 'GET',
      url: '/api/admin/push/overview',
      auth: 'admin',
      permission: 'notifications.campaigns.view',
      summary: 'Push channels: browser push, app devices and the push providers of active plugins',
      tags: ['Notifications'],
      handler: async () => {
        const settings = app.settings.get<NotificationSettings>('notifications');
        const browsers = await app.db.one<{ subscriptions: number; customers: number }>(sql`
          SELECT count(*)::int AS subscriptions, count(DISTINCT recipient_id)::int AS customers FROM push_subscriptions WHERE recipient_type = 'user'
        `);
        const devices = await app.db.many<{ provider: string; devices: number; customers: number }>(sql`
          SELECT provider, count(*)::int AS devices, count(DISTINCT user_id)::int AS customers FROM push_devices GROUP BY provider ORDER BY provider
        `);
        const providers = (await pushProviders(app, { fresh: true })).map(({ provider, owner, status }) => ({
          key: provider.key,
          name: provider.name,
          description: provider.description,
          targets: provider.targets,
          plugin: owner.startsWith('plugin:') ? owner.slice(7) : null,
          configured: status.configured,
          message: status.message,
          devices: devices.find((d) => d.provider === provider.key)?.devices ?? 0,
        }));
        return { pushEnabled: settings.pushEnabled, browsers, devices, providers };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/push/audience-options',
      auth: 'admin',
      permission: 'notifications.campaigns.view',
      summary: 'Segments and products a push notification can be sent to',
      tags: ['Notifications'],
      handler: async () => ({
        segments: app.modules.isEnabled('marketing') ? await app.db.many(sql`SELECT id, name FROM segments ORDER BY lower(name) LIMIT 500`) : [],
        products: await app.db.many(sql`SELECT id, name, kind FROM products WHERE status <> 'archived' ORDER BY lower(name) LIMIT 500`),
      }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/push/audience-preview',
      auth: 'admin',
      permission: 'notifications.campaigns.view',
      summary: 'How many customers a push notification would reach',
      tags: ['Notifications'],
      body: z.object({ audience: audienceSchema, kind: z.enum(campaignKinds) }),
      handler: async (c) => {
        noOrgScope(c.orgScope());
        return audiencePreview(app.db, app, c.body.audience, c.body.kind);
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/push/campaigns',
      auth: 'admin',
      permission: 'notifications.campaigns.view',
      summary: 'Push notifications sent or scheduled for many customers',
      tags: ['Notifications'],
      query: z.object({ ...pageQuery }),
      handler: async (c) => {
        const page = await paginate<CampaignRow>(app.db, { select: sql`*`, from: sql`push_campaigns`, where: sql.empty, orderBy: sql`ORDER BY created_at DESC, id DESC`, page: c.query.page, pageSize: c.query.pageSize });
        const stats = await campaignStats(app.db, page.data.map((r) => r.id));
        return { ...page, data: page.data.map((r) => presentCampaign(r, stats.get(r.id))) };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/push/campaigns',
      auth: 'admin',
      permission: 'notifications.campaigns.manage',
      summary: 'Send a push notification to many customers now, or schedule it',
      tags: ['Notifications'],
      body: z.object({
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().max(1000).optional(),
        link: z.string().url().max(2000).optional(),
        severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'),
        kind: z.enum(campaignKinds),
        audience: audienceSchema,
        scheduledAt: z.coerce.date().optional(),
      }),
      handler: async (c) => {
        noOrgScope(c.orgScope());
        const b = c.body;
        if (b.scheduledAt && b.scheduledAt.getTime() > app.clock.now().getTime() + 90 * DAY) throw validationError([{ path: ['scheduledAt'], message: 'Schedule at most 90 days ahead' }]);
        let audienceLabel = 'All customers';
        if (b.audience.type === 'segment') audienceLabel = `Segment: ${(await app.db.maybe<{ name: string }>(sql`SELECT name FROM segments WHERE id = ${b.audience.segmentId}`))?.name ?? b.audience.segmentId}`;
        if (b.audience.type === 'product') audienceLabel = `Customers with ${(await app.db.maybe<{ name: string }>(sql`SELECT name FROM products WHERE id = ${b.audience.productId}`))?.name ?? b.audience.productId}`;
        if (b.kind === 'marketing') audienceLabel += ' (marketing consent only)';
        const campaign = await app.db.tx(async (tx) => {
          const created = await createCampaign(tx, app, { title: b.title, body: b.body || null, link: b.link ?? null, severity: b.severity, kind: b.kind, audience: b.audience, audienceLabel, scheduledAt: b.scheduledAt ?? null, createdBy: c.admin().adminId });
          await c.audit(tx, 'push_campaign.create', { type: 'push_campaign', id: created.id }, { title: b.title, kind: b.kind, audience: b.audience, scheduledAt: b.scheduledAt ?? null });
          return created;
        });
        c.reply.status(201);
        return presentCampaign(campaign);
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/push/campaigns/:id',
      auth: 'admin',
      permission: 'notifications.campaigns.view',
      summary: 'A push notification campaign with its delivery figures',
      tags: ['Notifications'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const campaign = await getCampaign(app.db, c.params.id);
        return presentCampaign(campaign, (await campaignStats(app.db, [campaign.id])).get(campaign.id));
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/push/campaigns/:id/cancel',
      auth: 'admin',
      permission: 'notifications.campaigns.manage',
      summary: 'Cancel a scheduled push notification, or stop one that is still sending',
      tags: ['Notifications'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        noOrgScope(c.orgScope());
        return app.db.tx(async (tx) => {
          const campaign = await tx.maybe<CampaignRow>(sql`SELECT * FROM push_campaigns WHERE id = ${c.params.id} FOR UPDATE`);
          if (!campaign) throw notFound('Push notification');
          if (campaign.status !== 'scheduled' && campaign.status !== 'sending') throw conflict(`A ${campaign.status} push notification cannot be cancelled`, 'not_cancelable');
          await tx.exec(sql`UPDATE push_campaigns SET status = 'canceled', finished_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${campaign.id}`);
          await c.audit(tx, 'push_campaign.cancel', { type: 'push_campaign', id: campaign.id }, { recipientsSoFar: campaign.recipients });
          return presentCampaign(await getCampaign(tx, campaign.id));
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/users/:id/push-channels',
      auth: 'admin',
      permission: 'notifications.messages.view',
      summary: "A customer's push channels: subscribed browsers and registered app devices",
      tags: ['Notifications'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const user = await getUser(app.db, c.params.id, c.orgScope(), { includeDeleted: true });
        const [browsers, devices] = await Promise.all([
          app.db.many(sql`SELECT id, user_agent AS "userAgent", failure_count AS "failureCount", last_success_at AS "lastSuccessAt", created_at AS "createdAt" FROM push_subscriptions WHERE recipient_type = 'user' AND recipient_id = ${user.id} ORDER BY created_at DESC`),
          app.db.many(sql`SELECT id, provider, platform, failure_count AS "failureCount", last_success_at AS "lastSuccessAt", created_at AS "createdAt" FROM push_devices WHERE user_id = ${user.id} ORDER BY updated_at DESC`),
        ]);
        const providers = (await pushProviders(app)).filter((p) => p.status.configured).map((p) => ({ key: p.provider.key, name: p.provider.name, targets: p.provider.targets }));
        return { pushEnabled: app.settings.get<NotificationSettings>('notifications').pushEnabled, browsers, devices, providers };
      },
    });
  },
};
