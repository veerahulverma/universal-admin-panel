import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { DEFAULT_PUSH_HOSTS, encryptPayload, endpointAllowed, fromB64u, generateVapidKeys, vapidAuthorization, type VapidKeys } from './webpush.js';
import { pushProvider, pushProviders, type PushRecipientResult } from './providers.js';

export const notificationSettingsSchema = z.object({
  pushEnabled: z.boolean().meta({
    title: 'Send push notifications',
    description: 'To browsers (built in) and through the push providers of active plugins. Off: notifications only appear in the in-app notification center.',
  }),
  /** "mailto:" or https URL identifying you to push services (RFC 8292). Defaults to the support email. */
  vapidSubject: z.string().max(200).meta({ title: 'Web push contact', description: 'A mailto: address or https URL browser push services can reach you at. Empty uses the support email.' }),
  pushServiceHosts: z.array(z.string().max(200)).min(1).max(50).meta({ title: 'Allowed browser push services', description: 'Hosts that browser push subscriptions may point to.' }),
  notifyPaymentSucceeded: z.boolean().meta({ title: 'Payment received', description: 'Thank the customer when a payment succeeds.' }),
  notifyPaymentFailures: z.boolean().meta({ title: 'Payment failed', description: 'When a charge fails, asking the customer to update their payment method.' }),
  notifyRenewalReminder: z.boolean().meta({ title: 'Upcoming renewal', description: 'Before a paid subscription renews.' }),
  renewalReminderDays: z.number().int().min(1).max(60).meta({ title: 'Days before the renewal', description: 'How early the upcoming renewal notification goes out.' }),
  notifyTrialEnding: z.boolean().meta({ title: 'Trial ending', description: 'A few days before a trial ends.' }),
  notifySubscriptionCanceled: z.boolean().meta({ title: 'Subscription cancelled', description: 'When a subscription ends early or is cancelled (not when an installment plan is paid off).' }),
  notifyUsageAlerts: z.boolean().meta({ title: 'Usage alerts', description: 'When a quota is nearly or fully used.' }),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const notificationDefaults: NotificationSettings = {
  pushEnabled: true,
  vapidSubject: '',
  pushServiceHosts: DEFAULT_PUSH_HOSTS,
  // Newer automatic notifications start off, so an upgrade does not suddenly message every customer.
  notifyPaymentSucceeded: false,
  notifyPaymentFailures: true,
  notifyRenewalReminder: false,
  renewalReminderDays: 3,
  notifyTrialEnding: true,
  notifySubscriptionCanceled: false,
  notifyUsageAlerts: true,
};

const VAPID_LOCK = 72_710_300;

/** VAPID keys are created once per installation and stored encrypted. */
export async function vapidKeys(app: App, db: Db = app.db): Promise<VapidKeys> {
  const cached = app.services['notifications.vapid'] as VapidKeys | undefined;
  if (cached) return cached;
  const keys = await db.tx(async (tx) => {
    await tx.query(sql`SELECT pg_advisory_xact_lock(${VAPID_LOCK})`);
    const stored = await app.secrets.get(tx, 'push', 'vapid', 'keys');
    if (stored) return JSON.parse(stored) as VapidKeys;
    const fresh = generateVapidKeys();
    await app.secrets.set(tx, 'push', 'vapid', 'keys', JSON.stringify(fresh));
    return fresh;
  });
  app.services['notifications.vapid'] = keys;
  return keys;
}

export interface UserNotification {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'critical';
  data?: Record<string, unknown>;
  push?: boolean;
}

/** One delivery per configured push provider (from plugins) that can reach the customer. */
async function queueProviderPushes(db: Db, app: App, notificationId: string, userId: string): Promise<number> {
  let queued = 0;
  for (const { provider, status } of await pushProviders(app)) {
    if (!status.configured) continue;
    if (provider.targets === 'devices' && !(await db.maybe(sql`SELECT 1 FROM push_devices WHERE user_id = ${userId} AND provider = ${provider.key} LIMIT 1`))) continue;
    const row = await db.maybe<{ id: string }>(sql`
      INSERT INTO push_provider_deliveries (id, notification_id, provider, user_id, status, attempts, created_at)
      VALUES (${newId('ppd')}, ${notificationId}, ${provider.key}, ${userId}, 'pending', 0, ${app.clock.now()})
      ON CONFLICT (notification_id, provider) DO NOTHING RETURNING id
    `);
    if (!row) continue;
    await app.jobs.enqueue(db, 'push.provider_deliver', { deliveryId: row.id }, { idempotencyKey: `push-provider:${row.id}`, maxAttempts: 5 });
    queued++;
  }
  return queued;
}

/** Fan a notification out to one push job per subscription, so retries never duplicate other deliveries. */
async function queuePush(db: Db, app: App, notificationId: string, recipientType: 'admin' | 'user', recipientId: string): Promise<number> {
  if (!app.settings.get<NotificationSettings>('notifications').pushEnabled) return 0;
  const subs = await db.many<{ id: string }>(sql`SELECT id FROM push_subscriptions WHERE recipient_type = ${recipientType} AND recipient_id = ${recipientId}`);
  for (const s of subs) {
    const row = await db.maybe<{ id: string }>(sql`
      INSERT INTO push_deliveries (id, notification_id, subscription_id, status, attempts, created_at)
      VALUES (${newId('pdl')}, ${notificationId}, ${s.id}, 'pending', 0, ${app.clock.now()})
      ON CONFLICT (notification_id, subscription_id) DO NOTHING RETURNING id
    `);
    if (row) await app.jobs.enqueue(db, 'push.deliver', { deliveryId: row.id }, { idempotencyKey: `push:${row.id}`, maxAttempts: 5 });
  }
  return subs.length + (recipientType === 'user' ? await queueProviderPushes(db, app, notificationId, recipientId) : 0);
}

export async function notifyUser(db: Db, app: App, n: UserNotification): Promise<string> {
  const id = newId('ntf');
  await db.exec(sql.insert('notifications', {
    id,
    recipient_type: 'user',
    recipient_id: n.userId,
    type: n.type,
    title: n.title.slice(0, 300),
    body: n.body ?? null,
    link: n.link ?? null,
    severity: n.severity ?? 'info',
    data: n.data ?? {},
    created_at: app.clock.now(),
  }, ''));
  await app.events.emit(db, 'notification.created', { notificationId: id, type: n.type, title: n.title }, { userId: n.userId });
  if (n.push !== false) await queuePush(db, app, id, 'user', n.userId);
  return id;
}

/** Admin notifications are written by other modules (notifyAdmins); pick up recent ones for admins with push enabled. */
export async function queueAdminPushes(app: App): Promise<number> {
  const since = new Date(app.clock.now().getTime() - 3_600_000);
  const rows = await app.db.many<{ id: string; recipient_id: string }>(sql`
    SELECT n.id, n.recipient_id FROM notifications n
    WHERE n.recipient_type = 'admin' AND n.created_at > ${since}
      AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.recipient_type = 'admin' AND s.recipient_id = n.recipient_id)
      AND NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.notification_id = n.id)
    LIMIT 500
  `);
  let queued = 0;
  for (const r of rows) queued += await app.db.tx((tx) => queuePush(tx, app, r.id, 'admin', r.recipient_id));
  return queued;
}

class RetryablePushError extends Error {}

/**
 * Deliver one notification to one browser subscription. 404/410 mean the
 * subscription is gone and it is removed; 429/5xx are retried with backoff.
 */
export async function deliverPush(app: App, deliveryId: string): Promise<void> {
  const d = await app.db.maybe<any>(sql`
    SELECT d.*, s.endpoint, s.p256dh, s.auth, n.title, n.body, n.link, n.type, n.severity
    FROM push_deliveries d JOIN push_subscriptions s ON s.id = d.subscription_id JOIN notifications n ON n.id = d.notification_id
    WHERE d.id = ${deliveryId}
  `);
  if (!d || d.status === 'sent') return;
  const settings = app.settings.get<NotificationSettings>('notifications');
  if (!endpointAllowed(d.endpoint, settings.pushServiceHosts)) {
    await app.db.exec(sql`UPDATE push_deliveries SET status = 'failed', error = 'endpoint host not allowed' WHERE id = ${d.id}`);
    return;
  }
  const keys = await vapidKeys(app);
  const general = app.settings.get<{ supportEmail: string; appName: string }>('general');
  const subject = settings.vapidSubject || `mailto:${general.supportEmail || 'admin@localhost'}`;
  const body = encryptPayload({
    uaPublic: fromB64u(d.p256dh),
    authSecret: fromB64u(d.auth),
    plaintext: Buffer.from(JSON.stringify({ id: d.notification_id, type: d.type, title: d.title, body: d.body, link: d.link, severity: d.severity, app: general.appName })),
  });
  const fetchImpl = (app.services['push.fetch'] as typeof fetch | undefined) ?? fetch;
  const res = await fetchImpl(d.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(keys, d.endpoint, subject, Math.floor(app.clock.now().getTime() / 1000)),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: d.severity === 'critical' ? 'high' : 'normal',
    },
    body,
  });
  const now = app.clock.now();
  if (res.status >= 200 && res.status < 300) {
    await app.db.exec(sql`UPDATE push_deliveries SET status = 'sent', attempts = attempts + 1, last_status = ${res.status}, sent_at = ${now} WHERE id = ${d.id}`);
    await app.db.exec(sql`UPDATE push_subscriptions SET failure_count = 0, last_success_at = ${now} WHERE id = ${d.subscription_id}`);
    return;
  }
  if (res.status === 404 || res.status === 410) {
    await app.db.exec(sql`UPDATE push_deliveries SET status = 'gone', attempts = attempts + 1, last_status = ${res.status} WHERE id = ${d.id}`);
    await app.db.exec(sql`DELETE FROM push_subscriptions WHERE id = ${d.subscription_id}`);
    return;
  }
  await app.db.exec(sql`UPDATE push_deliveries SET attempts = attempts + 1, last_status = ${res.status}, error = ${`HTTP ${res.status}`} WHERE id = ${d.id}`);
  if (res.status === 429 || res.status >= 500) throw new RetryablePushError(`Push service responded ${res.status}`);
  await app.db.exec(sql`UPDATE push_deliveries SET status = 'failed' WHERE id = ${d.id}`);
}

/**
 * Deliver one notification to one customer through a provider plugin. Failures the provider
 * throws are retried with backoff by the job queue; the final attempt marks the delivery failed.
 */
export async function deliverProviderPush(app: App, deliveryId: string, attempt: { attempts: number; maxAttempts: number }): Promise<void> {
  const d = await app.db.maybe<any>(sql`
    SELECT d.*, n.title, n.body, n.link, n.type, n.severity, u.external_id, u.deleted_at
    FROM push_provider_deliveries d JOIN notifications n ON n.id = d.notification_id JOIN users u ON u.id = d.user_id
    WHERE d.id = ${deliveryId}
  `);
  if (!d || d.status !== 'pending') return;
  const finish = (status: 'sent' | 'failed' | 'skipped', error: string | null, providerMessageId: string | null = null) =>
    app.db.exec(sql`
      UPDATE push_provider_deliveries SET status = ${status}, attempts = attempts + 1, error = ${error?.slice(0, 500) ?? null},
        provider_message_id = ${providerMessageId}, sent_at = ${status === 'sent' ? app.clock.now() : null}
      WHERE id = ${d.id}
    `);
  const provider = pushProvider(app, d.provider);
  if (!provider) return void (await finish('failed', 'The push provider is no longer available (its plugin was deactivated)'));
  if (d.deleted_at) return void (await finish('skipped', 'The account was deleted'));
  const devices =
    provider.targets === 'devices'
      ? await app.db.many<{ id: string; token: string; platform: string }>(sql`SELECT id, token, platform FROM push_devices WHERE user_id = ${d.user_id} AND provider = ${provider.key} ORDER BY updated_at DESC LIMIT 20`)
      : [];
  if (provider.targets === 'devices' && !devices.length) return void (await finish('skipped', 'No registered devices'));

  let result: PushRecipientResult | undefined;
  try {
    const out = await provider.send({
      notificationId: d.notification_id,
      type: d.type,
      title: d.title,
      body: d.body,
      link: d.link,
      severity: d.severity,
      recipients: [{ userId: d.user_id, externalId: d.external_id, devices }],
    });
    result = out?.results?.find((r) => r.userId === d.user_id);
  } catch (err) {
    const message = (err as Error).message;
    if (attempt.attempts >= attempt.maxAttempts) return void (await finish('failed', message));
    await app.db.exec(sql`UPDATE push_provider_deliveries SET attempts = attempts + 1, error = ${message.slice(0, 500)} WHERE id = ${d.id}`);
    throw err;
  }
  const known = new Set(devices.map((dv) => dv.id));
  const invalid = (result?.invalidDeviceIds ?? []).filter((id) => known.has(id));
  if (invalid.length) await app.db.exec(sql`DELETE FROM push_devices WHERE id IN ${sql.in(invalid)}`);
  if (result?.status === 'sent' && devices.length > invalid.length) {
    await app.db.exec(sql`
      UPDATE push_devices SET last_success_at = ${app.clock.now()}, failure_count = 0
      WHERE user_id = ${d.user_id} AND provider = ${provider.key} ${invalid.length ? sql`AND id NOT IN ${sql.in(invalid)}` : sql.empty}
    `);
  }
  const status = result && ['sent', 'failed', 'skipped'].includes(result.status) ? result.status : 'failed';
  await finish(status, result ? (result.error ?? null) : 'The provider returned no result for this customer', result?.providerMessageId ?? null);
}

/** Users who should hear about a billing subject: the user, or an organization's owners and admins. */
export async function usersForSubject(db: Db, subject: { type: 'user' | 'organization'; id: string }): Promise<string[]> {
  if (subject.type === 'user') return [subject.id];
  const rows = await db.many<{ user_id: string }>(sql`
    SELECT user_id FROM memberships WHERE org_id = ${subject.id} AND status = 'active' AND role IN ('owner', 'admin', 'billing')
  `);
  return rows.map((r) => r.user_id);
}
