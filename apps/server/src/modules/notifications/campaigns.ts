import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { notFound, validationError } from '../../core/errors.js';
import { segmentCondition, segmentRulesSchema } from '../marketing/segments.js';
import { notifyUser } from './service.js';
import { pushProviders } from './providers.js';

/*
 * Push campaigns: one notification sent to many customers at once (Marketing → Push notifications).
 * Each customer gets it in their notification center and on every push channel that reaches them.
 * Marketing campaigns only reach customers who consented to marketing.
 */

export const audienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('segment'), segmentId: z.string().min(1) }),
  z.object({ type: z.literal('product'), productId: z.string().min(1) }),
]);
export type Audience = z.infer<typeof audienceSchema>;

export const campaignKinds = ['announcement', 'marketing'] as const;
export type CampaignKind = (typeof campaignKinds)[number];

/** Customers processed per job, so a large send is spread over many short transactions. */
export const BATCH_SIZE = 500;

/** WHERE condition over `users u` for an audience and kind. */
export async function audienceCondition(db: Db, app: App, audience: Audience, kind: CampaignKind): Promise<Sql> {
  const now = app.clock.now();
  const base = [sql`u.deleted_at IS NULL`, sql`u.status <> 'banned'`, kind === 'marketing' ? sql`u.marketing_consent` : null];
  if (audience.type === 'segment') {
    if (!app.modules.isEnabled('marketing')) throw validationError([{ path: ['audience'], message: 'Segments need the marketing module' }]);
    const seg = await db.maybe<{ rules: unknown }>(sql`SELECT rules FROM segments WHERE id = ${audience.segmentId}`);
    if (!seg) throw validationError([{ path: ['audience', 'segmentId'], message: 'Unknown segment' }]);
    return sql.and([...base.filter((x): x is Sql => x !== null), segmentCondition(segmentRulesSchema.parse(seg.rules), now)]);
  }
  if (audience.type === 'product') {
    const product = await db.maybe(sql`SELECT 1 FROM products WHERE id = ${audience.productId}`);
    if (!product) throw validationError([{ path: ['audience', 'productId'], message: 'Unknown product' }]);
    // Customers holding the product themselves or through an organization they belong to.
    const holder = (subjectType: string, subjectId: string) => sql`(
      (${sql.raw(subjectType)} = 'user' AND ${sql.raw(subjectId)} = u.id)
      OR (${sql.raw(subjectType)} = 'organization' AND ${sql.raw(subjectId)} IN (SELECT m.org_id FROM memberships m WHERE m.user_id = u.id AND m.status = 'active'))
    )`;
    const grants = sql`EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.product_id = ${audience.productId} AND g.revoked_at IS NULL
      AND g.starts_at <= ${now} AND (g.ends_at IS NULL OR g.ends_at > ${now}) AND ${holder('g.subject_type', 'g.subject_id')})`;
    const subscriptions = app.modules.isEnabled('billing')
      ? sql`EXISTS (SELECT 1 FROM subscriptions s WHERE s.product_id = ${audience.productId} AND s.status IN ('active', 'trialing', 'past_due') AND ${holder('s.subject_type', 's.subject_id')})`
      : null;
    return sql.and([...base.filter((x): x is Sql => x !== null), subscriptions ? sql`(${grants} OR ${subscriptions})` : grants]);
  }
  return sql.and(base.filter((x): x is Sql => x !== null));
}

/**
 * How many customers an audience reaches, and how many of them a push channel reaches right now:
 * a subscribed browser, a registered device, or a provider that targets customers by id.
 */
export async function audiencePreview(db: Db, app: App, audience: Audience, kind: CampaignKind): Promise<{ recipients: number; reachable: number }> {
  const where = await audienceCondition(db, app, audience, kind);
  const { recipients } = await db.one<{ recipients: number }>(sql`SELECT count(*)::int AS recipients FROM users u WHERE ${where}`);
  const providers = (await pushProviders(app)).filter((p) => p.status.configured);
  if (providers.some((p) => p.provider.targets === 'users')) return { recipients, reachable: recipients };
  const deviceProviders = providers.map((p) => p.provider.key);
  const { reachable } = await db.one<{ reachable: number }>(sql`
    SELECT count(*)::int AS reachable FROM users u WHERE ${where} AND (
      EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.recipient_type = 'user' AND s.recipient_id = u.id)
      ${deviceProviders.length ? sql`OR EXISTS (SELECT 1 FROM push_devices d WHERE d.user_id = u.id AND d.provider IN ${sql.in(deviceProviders)})` : sql.empty}
    )
  `);
  return { recipients, reachable };
}

export interface CampaignRow {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  kind: CampaignKind;
  audience: Audience;
  audience_label: string;
  status: 'scheduled' | 'sending' | 'sent' | 'canceled' | 'failed';
  scheduled_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  cursor: string | null;
  recipients: number;
  created_by: string | null;
  created_at: Date;
  last_error: string | null;
}

export async function getCampaign(db: Db, id: string): Promise<CampaignRow> {
  const row = await db.maybe<CampaignRow>(sql`SELECT * FROM push_campaigns WHERE id = ${id}`);
  if (!row) throw notFound('Push notification');
  return row;
}

/** Delivery figures for campaigns, from the notifications they created. */
export async function campaignStats(db: Db, ids: string[]): Promise<Map<string, { notified: number; read: number; pushSent: number; pushFailed: number; pushPending: number }>> {
  const out = new Map<string, { notified: number; read: number; pushSent: number; pushFailed: number; pushPending: number }>();
  if (!ids.length) return out;
  const rows = await db.many<{ campaign_id: string; notified: number; read: number; sent: number; failed: number; pending: number }>(sql`
    WITH n AS (SELECT id, read_at, data->>'campaignId' AS campaign_id FROM notifications WHERE recipient_type = 'user' AND data->>'campaignId' IN ${sql.in(ids)}),
    deliveries AS (
      SELECT d.notification_id, d.status FROM push_deliveries d WHERE d.notification_id IN (SELECT id FROM n)
      UNION ALL
      SELECT p.notification_id, p.status FROM push_provider_deliveries p WHERE p.notification_id IN (SELECT id FROM n)
    )
    SELECT n.campaign_id,
      count(DISTINCT n.id)::int AS notified,
      count(DISTINCT n.id) FILTER (WHERE n.read_at IS NOT NULL)::int AS read,
      count(d.status) FILTER (WHERE d.status = 'sent')::int AS sent,
      count(d.status) FILTER (WHERE d.status IN ('failed', 'gone'))::int AS failed,
      count(d.status) FILTER (WHERE d.status = 'pending')::int AS pending
    FROM n LEFT JOIN deliveries d ON d.notification_id = n.id
    GROUP BY n.campaign_id
  `);
  for (const r of rows) out.set(r.campaign_id, { notified: r.notified, read: r.read, pushSent: r.sent, pushFailed: r.failed, pushPending: r.pending });
  return out;
}

export interface NewCampaign {
  title: string;
  body?: string | null;
  link?: string | null;
  severity: 'info' | 'success' | 'warning' | 'critical';
  kind: CampaignKind;
  audience: Audience;
  audienceLabel: string;
  scheduledAt?: Date | null;
  createdBy: string | null;
}

/** Store a campaign and queue its first batch, now or at the scheduled time. */
export async function createCampaign(db: Db, app: App, input: NewCampaign): Promise<CampaignRow> {
  await audienceCondition(db, app, input.audience, input.kind); // validates the audience
  const now = app.clock.now();
  const scheduled = input.scheduledAt && input.scheduledAt > now ? input.scheduledAt : null;
  const id = newId('pcm');
  await db.exec(sql.insert('push_campaigns', {
    id,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
    severity: input.severity,
    kind: input.kind,
    audience: sql.json(input.audience),
    audience_label: input.audienceLabel,
    status: 'scheduled',
    scheduled_at: scheduled,
    recipients: 0,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
  }, ''));
  await app.jobs.enqueue(db, 'push.campaign_send', { campaignId: id }, { idempotencyKey: `push-campaign:${id}:start`, runAt: scheduled ?? now, maxAttempts: 5 });
  return getCampaign(db, id);
}

/**
 * Send the next batch of a campaign. Each batch commits its notifications and the cursor together,
 * so a retried batch never notifies anyone twice; cancelling stops the campaign before the next one.
 */
export async function sendCampaignBatch(app: App, campaignId: string): Promise<'more' | 'done' | 'stopped'> {
  return app.db.tx(async (tx) => {
    const c = await tx.maybe<CampaignRow>(sql`SELECT * FROM push_campaigns WHERE id = ${campaignId} FOR UPDATE`);
    if (!c || c.status === 'canceled' || c.status === 'sent' || c.status === 'failed') return 'stopped';
    const now = app.clock.now();
    if (c.status === 'scheduled') await tx.exec(sql`UPDATE push_campaigns SET status = 'sending', started_at = ${now}, updated_at = ${now} WHERE id = ${c.id}`);
    const where = await audienceCondition(tx, app, c.audience, c.kind);
    const batch = await tx.many<{ id: string }>(sql`
      SELECT u.id FROM users u WHERE ${where} ${c.cursor ? sql`AND u.id > ${c.cursor}` : sql.empty} ORDER BY u.id LIMIT ${BATCH_SIZE}
    `);
    for (const u of batch) {
      await notifyUser(tx, app, { userId: u.id, type: 'push.campaign', title: c.title, body: c.body, link: c.link, severity: c.severity as any, data: { campaignId: c.id, kind: c.kind } });
    }
    const done = batch.length < BATCH_SIZE;
    await tx.exec(sql`
      UPDATE push_campaigns SET cursor = ${batch.length ? batch[batch.length - 1].id : c.cursor}, recipients = recipients + ${batch.length},
        status = ${done ? 'sent' : 'sending'}, finished_at = ${done ? now : null}, updated_at = ${now}
      WHERE id = ${c.id}
    `);
    if (!done) {
      await app.jobs.enqueue(tx, 'push.campaign_send', { campaignId: c.id }, { idempotencyKey: `push-campaign:${c.id}:${batch[batch.length - 1].id}`, maxAttempts: 5 });
      return 'more';
    }
    await app.events.emit(tx, 'push_campaign.sent', { campaignId: c.id, recipients: c.recipients + batch.length });
    return 'done';
  });
}
