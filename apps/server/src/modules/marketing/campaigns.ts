import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { DomainEvent } from '../../core/events.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { DAY, HOUR } from '../../core/clock.js';
import { queueEmail, recipientForSubject, sendOnce } from '../email/service.js';
import { INSTALLMENTS_COMPLETED, sendCheckoutRecovery } from '../email/automations.js';
import { segmentCondition, segmentRulesSchema } from './segments.js';
import type { TemplateDefinition } from '../email/templates.js';

export const marketingSettingsSchema = z.object({
  defaultBatchSize: z.number().int().min(1).max(5000),
  campaignBatchDelaySeconds: z.number().int().min(0).max(3600),
  abandonedCheckoutEnabled: z.boolean(),
  abandonedCheckoutDelayHours: z.number().int().min(1).max(168),
  winbackEnabled: z.boolean(),
  winbackDelayDays: z.number().int().min(1).max(365),
  winbackUrl: z.string().url().or(z.literal('')),
  upsellEnabled: z.boolean(),
  upsellCooldownDays: z.number().int().min(1).max(365),
  upsellUrl: z.string().url().or(z.literal('')),
  attributionWindowDays: z.number().int().min(1).max(90),
});
export type MarketingSettings = z.infer<typeof marketingSettingsSchema>;

export const marketingDefaults: MarketingSettings = {
  defaultBatchSize: 200,
  campaignBatchDelaySeconds: 5,
  abandonedCheckoutEnabled: true,
  abandonedCheckoutDelayHours: 2,
  winbackEnabled: true,
  winbackDelayDays: 14,
  winbackUrl: '',
  upsellEnabled: true,
  upsellCooldownDays: 30,
  upsellUrl: '',
  attributionWindowDays: 7,
};

const settingsOf = (app: App) => app.settings.get<MarketingSettings>('marketing');

const button = (urlVar: string, label: string) =>
  `<p style="margin:28px 0"><a href="{{${urlVar}}}" style="background:{{brandColor}};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">${label}</a></p>`;

export const MARKETING_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'marketing.winback',
    name: 'Win-back',
    description: 'Sent some time after a subscription ends, unless the customer came back.',
    category: 'marketing',
    subject: 'We miss you at {{appName}}',
    html: `<p>Hello,</p><p>It's been a while since your <strong>{{productName}}</strong> subscription ended. A lot has improved since then, and we'd love to have you back.</p>${button('resubscribeUrl', 'Come back')}`,
    variables: ['productName', 'resubscribeUrl'],
    sampleData: { productName: 'Pro', resubscribeUrl: 'https://app.example.com/pricing' },
  },
  {
    key: 'marketing.upsell',
    name: 'Upgrade suggestion',
    description: 'Suggests an upgrade when a customer approaches a plan limit.',
    category: 'marketing',
    subject: 'Need more {{featureName}}?',
    html: `<p>Hello,</p><p>You've used <strong>{{percent}}%</strong> of your {{featureName}} this period. Upgrading gives you more room to grow, with no interruptions.</p>${button('upgradeUrl', 'See plans')}`,
    variables: ['featureName', 'percent', 'upgradeUrl'],
    sampleData: { featureName: 'API calls', percent: 80, upgradeUrl: 'https://app.example.com/pricing' },
  },
  {
    key: 'lists.confirm',
    name: 'Confirm list subscription',
    description: 'Double opt-in: asks people to confirm they want to join a mailing list. Nothing is sent to the list until they click.',
    category: 'transactional',
    subject: 'Please confirm your subscription to {{listName}}',
    html: `<p>Hello,</p><p>Please confirm that you want to receive <strong>{{listName}}</strong> emails from {{appName}}.</p>${button('confirmUrl', 'Confirm subscription')}<p style="color:#6b7280;font-size:13px">If you did not ask for this, ignore this email and you will not be subscribed. The link is valid for 7 days.</p>`,
    variables: ['listName', 'confirmUrl'],
    sampleData: { listName: 'Product updates', confirmUrl: 'https://admin.example.com/lists/confirm/example' },
  },
];

function appLink(app: App): string {
  const general = app.settings.get<{ appUrl: string }>('general');
  return general.appUrl || app.config.appUrl;
}

export function utmParams(campaign: { id: string; name: string; utm_campaign: string | null }): Record<string, string> {
  const slug = (campaign.utm_campaign || campaign.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || campaign.id;
  return { utm_source: 'email', utm_medium: 'campaign', utm_campaign: slug, utm_content: campaign.id };
}

// ---- Campaign sending ------------------------------------------------------------------

/** Freeze the audience (a segment's matches or a list's subscribers) at send time, then hand off to throttled batch jobs. */
export async function startCampaign(app: App, campaignId: string): Promise<void> {
  await app.db.tx(async (tx) => {
    const c = await tx.maybe<any>(sql`SELECT * FROM campaigns WHERE id = ${campaignId} FOR UPDATE`);
    if (!c || c.status !== 'scheduled') return;
    const now = app.clock.now();
    const cancel = (error: string) => tx.exec(sql`UPDATE campaigns SET status = 'canceled', canceled_at = ${now}, stats = stats || ${sql.json({ error })} WHERE id = ${c.id}`);
    if (c.list_id) {
      if (!(await tx.maybe(sql`SELECT 1 FROM mailing_lists WHERE id = ${c.list_id}`))) return void (await cancel('list_missing'));
      await tx.exec(sql`
        INSERT INTO campaign_recipients (campaign_id, user_id, email, status, created_at)
        SELECT ${c.id}, u.id, lower(u.email), 'pending', ${now} FROM mailing_list_members m JOIN users u ON u.id = m.user_id
        WHERE m.list_id = ${c.list_id} AND m.status = 'subscribed' AND u.deleted_at IS NULL
        ON CONFLICT DO NOTHING
      `);
    } else {
      const segment = await tx.maybe<{ rules: unknown }>(sql`SELECT rules FROM segments WHERE id = ${c.segment_id}`);
      if (!segment) return void (await cancel('segment_missing'));
      const rules = segmentRulesSchema.parse(segment.rules);
      await tx.exec(sql`
        INSERT INTO campaign_recipients (campaign_id, user_id, email, status, created_at)
        SELECT ${c.id}, u.id, lower(u.email), 'pending', ${now} FROM users u WHERE ${segmentCondition(rules, now)}
        ON CONFLICT DO NOTHING
      `);
    }
    const count = await tx.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = ${c.id}`);
    await tx.exec(sql`UPDATE campaigns SET status = 'sending', started_at = ${now}, stats = stats || ${sql.json({ audience: count.n })}, updated_at = ${now} WHERE id = ${c.id}`);
    await app.jobs.enqueue(tx, 'marketing.campaign_batch', { campaignId: c.id, batch: 1 }, { idempotencyKey: `campaign:${c.id}:batch:1`, maxAttempts: 3 });
  });
}

/**
 * Send one batch. Consent, suppressions and opt-outs are enforced per
 * recipient by the email queue; skipped recipients are recorded with the reason.
 */
export async function sendCampaignBatch(app: App, campaignId: string, batch: number): Promise<void> {
  await app.db.tx(async (tx) => {
    const c = await tx.maybe<any>(sql`SELECT * FROM campaigns WHERE id = ${campaignId} FOR UPDATE`);
    if (!c || c.status !== 'sending') return;
    const recipients = await tx.many<{ user_id: string; email: string }>(sql`
      SELECT user_id, email FROM campaign_recipients WHERE campaign_id = ${c.id} AND status = 'pending'
      ORDER BY user_id LIMIT ${c.batch_size} FOR UPDATE SKIP LOCKED
    `);
    const params = utmParams(c);
    for (const r of recipients) {
      const result = await queueEmail(tx, app, {
        to: r.email,
        userId: r.user_id,
        category: 'marketing',
        templateKey: c.template_key ?? null,
        content: c.template_key ? null : { subject: c.subject, html: c.html, text: c.text },
        campaignId: c.id,
        listId: c.list_id ?? null,
        linkParams: params,
        data: { campaign: { name: c.name } },
        metadata: { campaignId: c.id },
      });
      await tx.exec(sql`
        UPDATE campaign_recipients SET status = ${result.status === 'queued' ? 'queued' : 'skipped'}, skip_reason = ${result.reason}, message_id = ${result.id}, sent_at = ${app.clock.now()}
        WHERE campaign_id = ${c.id} AND user_id = ${r.user_id}
      `);
    }
    const pending = await tx.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = ${c.id} AND status = 'pending'`);
    const now = app.clock.now();
    if (pending.n > 0) {
      const runAt = new Date(now.getTime() + settingsOf(app).campaignBatchDelaySeconds * 1000);
      await app.jobs.enqueue(tx, 'marketing.campaign_batch', { campaignId: c.id, batch: batch + 1 }, { runAt, idempotencyKey: `campaign:${c.id}:batch:${batch + 1}`, maxAttempts: 3 });
    } else {
      await tx.exec(sql`UPDATE campaigns SET status = 'sent', completed_at = ${now}, updated_at = ${now} WHERE id = ${c.id}`);
      await app.events.emit(tx, 'campaign.sent', { campaignId: c.id, name: c.name });
    }
  });
}

export async function campaignStats(db: Db, campaignId: string) {
  const [recipients, messages, engagement, revenue] = await Promise.all([
    db.many<{ status: string; skip_reason: string | null; count: number }>(sql`
      SELECT status, skip_reason, count(*)::int AS count FROM campaign_recipients WHERE campaign_id = ${campaignId} GROUP BY 1, 2 ORDER BY 1, 2
    `),
    db.many<{ status: string; count: number }>(sql`SELECT status, count(*)::int AS count FROM email_messages WHERE campaign_id = ${campaignId} GROUP BY 1`),
    db.one<{ opened: number; clicked: number }>(sql`SELECT count(opened_at)::int AS opened, count(clicked_at)::int AS clicked FROM email_messages WHERE campaign_id = ${campaignId}`),
    db.many<{ currency: string; amount: number; orders: number }>(sql`
      SELECT currency, sum(amount)::bigint AS amount, count(*)::int AS orders FROM campaign_attributions WHERE campaign_id = ${campaignId} GROUP BY 1
    `),
  ]);
  const sent = messages.find((m) => m.status === 'sent')?.count ?? 0;
  return {
    recipients,
    messages: Object.fromEntries(messages.map((m) => [m.status, m.count])),
    opened: engagement.opened,
    clicked: engagement.clicked,
    openRate: sent ? engagement.opened / sent : 0,
    clickRate: sent ? engagement.clicked / sent : 0,
    revenue,
  };
}

// ---- Attribution ------------------------------------------------------------------------

/** Last-touch attribution: an order paid within the window after a campaign email credits that campaign. */
export async function attributeOrder(app: App, event: DomainEvent): Promise<void> {
  const orderId = (event.data as { orderId?: string }).orderId;
  if (!orderId) return;
  await app.db.tx(async (tx) => {
    const order = await tx.maybe<any>(sql`SELECT id, user_id, subject_type, subject_id, total, currency, created_at, paid_at FROM orders WHERE id = ${orderId}`);
    if (!order || order.total <= 0) return;
    const userId = order.user_id ?? (order.subject_type === 'user' ? order.subject_id : null);
    if (!userId) return;
    const paidAt: Date = order.paid_at ?? order.created_at;
    const since = new Date(paidAt.getTime() - settingsOf(app).attributionWindowDays * DAY);
    const msg = await tx.maybe<{ id: string; campaign_id: string }>(sql`
      SELECT id, campaign_id FROM email_messages
      WHERE user_id = ${userId} AND campaign_id IS NOT NULL AND status = 'sent' AND sent_at >= ${since} AND sent_at <= ${paidAt}
      ORDER BY sent_at DESC LIMIT 1
    `);
    if (!msg) return;
    const row = await tx.maybe(sql`
      INSERT INTO campaign_attributions (id, campaign_id, user_id, order_id, amount, currency, message_id, created_at)
      VALUES (${newId('cat')}, ${msg.campaign_id}, ${userId}, ${order.id}, ${order.total}, ${order.currency}, ${msg.id}, ${app.clock.now()})
      ON CONFLICT (order_id) DO NOTHING RETURNING id
    `);
    if (row) await app.events.emit(tx, 'campaign.conversion', { campaignId: msg.campaign_id, orderId: order.id, amount: order.total, currency: order.currency }, { userId });
  });
}

// ---- Automated flows -----------------------------------------------------------------------

/** Abandoned checkouts that have waited long enough get one recovery email (shared once-key with the email module). */
export async function scanAbandonedCheckouts(app: App): Promise<number> {
  const s = settingsOf(app);
  if (!s.abandonedCheckoutEnabled) return 0;
  const now = app.clock.now();
  const rows = await app.db.many<{ id: string }>(sql`
    SELECT id FROM checkout_sessions
    WHERE kind = 'purchase' AND status IN ('open', 'expired') AND recovery_email_sent_at IS NULL
      AND created_at <= ${new Date(now.getTime() - s.abandonedCheckoutDelayHours * HOUR)} AND created_at > ${new Date(now.getTime() - 7 * DAY)}
    ORDER BY created_at LIMIT 500
  `);
  let sent = 0;
  for (const r of rows) {
    const result = await app.db.tx((tx) => sendCheckoutRecovery(tx, app, r.id));
    if (result) sent++;
    else await app.db.exec(sql`UPDATE checkout_sessions SET recovery_email_sent_at = coalesce(recovery_email_sent_at, ${now}) WHERE id = ${r.id}`);
  }
  return sent;
}

export async function scheduleWinback(app: App, event: DomainEvent): Promise<void> {
  const s = settingsOf(app);
  if (!s.winbackEnabled) return;
  const { subscriptionId, reason } = event.data as { subscriptionId?: string; reason?: string | null };
  // A paid-off installment plan is a completed purchase, not a customer to win back.
  if (!subscriptionId || reason === INSTALLMENTS_COMPLETED) return;
  await app.jobs.enqueue(app.db, 'marketing.winback', { subscriptionId }, {
    runAt: new Date(app.clock.now().getTime() + s.winbackDelayDays * DAY),
    idempotencyKey: `winback:${subscriptionId}`,
    maxAttempts: 3,
  });
}

export async function sendWinback(app: App, subscriptionId: string): Promise<boolean> {
  if (!settingsOf(app).winbackEnabled) return false;
  return app.db.tx(async (tx) => {
    const sub = await tx.maybe<any>(sql`SELECT s.*, p.name AS product_name FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.id = ${subscriptionId}`);
    if (!sub || sub.status !== 'canceled') return false;
    const back = await tx.maybe(sql`
      SELECT 1 FROM subscriptions WHERE subject_type = ${sub.subject_type} AND subject_id = ${sub.subject_id} AND status IN ('active', 'trialing', 'past_due', 'paused') LIMIT 1
    `);
    if (back) return false;
    const recipient = await recipientForSubject(tx, { type: sub.subject_type, id: sub.subject_id });
    if (!recipient) return false;
    const result = await sendOnce(tx, app, `marketing:winback:${sub.id}`, {
      to: recipient.email,
      userId: recipient.userId,
      locale: recipient.locale,
      templateKey: 'marketing.winback',
      category: 'marketing',
      data: { productName: sub.product_name, resubscribeUrl: settingsOf(app).winbackUrl || appLink(app) },
      metadata: { subscriptionId: sub.id, automation: 'winback' },
    });
    return Boolean(result);
  });
}

/** Suggest an upgrade when a quota warning fires, at most once per cooldown per customer. */
export async function sendUpsell(app: App, event: DomainEvent): Promise<boolean> {
  const s = settingsOf(app);
  if (!s.upsellEnabled) return false;
  const d = event.data as Record<string, any>;
  const subject = d.subjectType && d.subjectId ? { type: d.subjectType, id: d.subjectId } : event.userId ? { type: 'user' as const, id: event.userId } : null;
  if (!subject) return false;
  return app.db.tx(async (tx) => {
    const recipient = await recipientForSubject(tx, subject);
    if (!recipient) return false;
    const since = new Date(app.clock.now().getTime() - s.upsellCooldownDays * DAY);
    const recent = await tx.maybe(sql`
      SELECT 1 FROM email_messages WHERE template_key = 'marketing.upsell' AND lower(to_email) = ${recipient.email.toLowerCase()} AND created_at >= ${since} LIMIT 1
    `);
    if (recent) return false;
    const feature = await tx.maybe<{ name: string }>(sql`SELECT name FROM features WHERE key = ${d.feature ?? ''}`);
    const result = await sendOnce(tx, app, `marketing:upsell:${event.id}`, {
      to: recipient.email,
      userId: recipient.userId,
      locale: recipient.locale,
      templateKey: 'marketing.upsell',
      category: 'marketing',
      data: { featureName: feature?.name ?? d.meter, percent: d.percent ?? 80, upgradeUrl: s.upsellUrl || appLink(app) },
      metadata: { automation: 'upsell', meter: d.meter ?? null },
    });
    return Boolean(result);
  });
}
