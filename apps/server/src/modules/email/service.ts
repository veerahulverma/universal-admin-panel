import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import type { SystemEmail } from '../core/mail.js';
import { defaultSmtpTransport, emailProviders, ProviderError, type EmailProviderAdapter, type OutgoingEmail, type ProviderContext, type ProviderType } from './providers.js';
import { addLinkParams, commonVariables, findTemplate, htmlToText, localeChain, renderEmail, type EmailCategory } from './templates.js';
import type { EmailSettings } from './settings.js';

/** Categories people cannot opt out of (they still stop on hard bounces and complaints). */
export const MANDATORY_CATEGORIES: readonly string[] = ['transactional', 'security', 'billing'];

export interface ProviderRow {
  id: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  priority: number;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  config: Record<string, any>;
}

export const settingsOf = (app: App) => app.settings.get<EmailSettings>('email');

// ---- One-click unsubscribe tokens ------------------------------------------------------

/** Signed, self-contained token: no database lookup is needed to honour an unsubscribe. */
export function unsubscribeToken(app: App, email: string, category = 'marketing'): string {
  const payload = Buffer.from(JSON.stringify({ e: email.trim().toLowerCase(), c: category })).toString('base64url');
  return `${payload}.${hmacSha256(app.config.encryptionKeys, `unsub:${payload}`).slice(0, 32)}`;
}

export function verifyUnsubscribeToken(app: App, token: string): { email: string; category: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmacSha256(app.config.encryptionKeys, `unsub:${payload}`).slice(0, 32))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { e?: string; c?: string };
    return parsed.e && parsed.c ? { email: parsed.e, category: parsed.c } : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(app: App, email: string, category = 'marketing'): string {
  return `${app.config.appUrl}/u/${unsubscribeToken(app, email, category)}`;
}

// ---- Suppression, consent and preferences -------------------------------------------------

export interface DeliveryDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Mailing lists belong to the marketing module, which registers this bridge
 * (`app.services['email.lists']`) so list email follows list consent and list
 * unsubscribe links work. Without it, list email is never sent.
 */
export interface ListBridge {
  /** Whether a member may receive this list's email: subscribed, consented, not opted out since. */
  deliverable(db: Db, input: { listId: string; userId: string | null; email: string }): Promise<DeliveryDecision>;
  name(db: Db, listId: string): Promise<string | null>;
  /** Unsubscribe an address from one list (one-click links). Returns false when it was not subscribed. */
  unsubscribe(db: Db, input: { listId: string; email: string; source: string }): Promise<boolean>;
}

export function listBridge(app: App): ListBridge | null {
  const bridge = app.services['email.lists'] as ListBridge | undefined;
  return bridge && app.modules.isEnabled('marketing') ? bridge : null;
}

/** Unsubscribe-token category for one mailing list. */
export const listCategory = (listId: string) => `list:${listId}`;

/**
 * Whether an address may receive a category of email. Suppressions always win
 * (hard bounces and complaints block everything); marketing additionally needs
 * recorded consent and no opt-out; other optional categories honour opt-outs.
 * Email to a mailing list (`listId`) is decided by the list's own consent rules.
 */
export async function checkDeliverable(db: Db, input: { email: string; category: string; userId: string | null; listId?: string | null }, app?: App): Promise<DeliveryDecision> {
  const email = input.email.trim().toLowerCase();
  const sup = await db.maybe<{ reason: string; scope: string }>(sql`SELECT reason, scope FROM email_suppressions WHERE email = ${email}`);
  if (input.listId) {
    if (sup?.scope === 'all') return { allowed: false, reason: sup.reason };
    const bridge = app ? listBridge(app) : null;
    if (!bridge) return { allowed: false, reason: 'list_unavailable' };
    return bridge.deliverable(db, { listId: input.listId, userId: input.userId, email });
  }
  if (sup && (sup.scope === 'all' || !MANDATORY_CATEGORIES.includes(input.category))) return { allowed: false, reason: sup.reason };
  if (MANDATORY_CATEGORIES.includes(input.category)) return { allowed: true, reason: null };
  if (input.category === 'marketing') {
    if (!input.userId) return { allowed: false, reason: 'no_consent' };
    const user = await db.maybe<{ marketing_consent: boolean; status: string; deleted_at: Date | null }>(
      sql`SELECT marketing_consent, status, deleted_at FROM users WHERE id = ${input.userId}`,
    );
    if (!user || user.deleted_at || user.status === 'banned') return { allowed: false, reason: 'inactive_recipient' };
    if (!user.marketing_consent) return { allowed: false, reason: 'no_consent' };
  }
  if (input.userId) {
    const pref = await db.maybe<{ subscribed: boolean }>(sql`SELECT subscribed FROM email_preferences WHERE user_id = ${input.userId} AND category = ${input.category}`);
    if (pref && !pref.subscribed) return { allowed: false, reason: 'unsubscribed' };
  }
  return { allowed: true, reason: null };
}

export async function suppress(db: Db, app: App, input: { email: string; reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual'; scope: 'all' | 'marketing'; source: string; details?: Record<string, unknown>; createdBy?: string | null }): Promise<void> {
  const email = input.email.trim().toLowerCase();
  // A stronger suppression (scope all) is never downgraded by a weaker one.
  await db.exec(sql`
    INSERT INTO email_suppressions (email, reason, scope, source, details, created_by, created_at)
    VALUES (${email}, ${input.reason}, ${input.scope}, ${input.source}, ${sql.json(input.details ?? {})}, ${input.createdBy ?? null}, ${app.clock.now()})
    ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, scope = EXCLUDED.scope, source = EXCLUDED.source, details = EXCLUDED.details, created_at = EXCLUDED.created_at
    WHERE email_suppressions.scope = 'marketing' OR EXCLUDED.scope = 'all'
  `);
}

/** Opt a person in or out of marketing email. Opt-out also records an address-level suppression. */
export async function setMarketingPreference(db: Db, app: App, input: { email: string; userId: string | null; subscribed: boolean; source: string }): Promise<void> {
  const now = app.clock.now();
  const email = input.email.trim().toLowerCase();
  const userId =
    input.userId ?? (await db.maybe<{ id: string }>(sql`SELECT id FROM users WHERE lower(email) = ${email} AND deleted_at IS NULL`))?.id ?? null;
  if (userId) {
    await db.exec(sql`
      INSERT INTO email_preferences (user_id, category, subscribed, source, updated_at) VALUES (${userId}, 'marketing', ${input.subscribed}, ${input.source}, ${now})
      ON CONFLICT (user_id, category) DO UPDATE SET subscribed = EXCLUDED.subscribed, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
    `);
    await db.exec(sql`UPDATE users SET marketing_consent = ${input.subscribed}, consent_updated_at = ${now}, updated_at = ${now} WHERE id = ${userId}`);
  }
  if (input.subscribed) {
    await db.exec(sql`DELETE FROM email_suppressions WHERE email = ${email} AND reason = 'unsubscribe'`);
  } else {
    await suppress(db, app, { email, reason: 'unsubscribe', scope: 'marketing', source: input.source });
  }
  await app.events.emit(db, 'email.preferences_updated', { email, userId, category: 'marketing', subscribed: input.subscribed, source: input.source }, userId ? { userId } : {});
}

// ---- Queueing -------------------------------------------------------------------------------

export interface QueueInput {
  to: string;
  userId?: string | null;
  orgId?: string | null;
  templateKey?: string | null;
  locale?: string | null;
  category?: EmailCategory | string | null;
  /** Inline content (campaigns) instead of a stored template. */
  content?: { subject: string; html: string; text?: string | null } | null;
  data?: Record<string, unknown>;
  campaignId?: string | null;
  /** Email to a mailing list: list consent decides delivery and the unsubscribe link leaves just that list. */
  listId?: string | null;
  metadata?: Record<string, unknown>;
  /** Admin test sends skip consent checks (they go to the admin's own address). */
  test?: boolean;
  /** Query parameters added to links in the HTML (campaign UTM tags); unsubscribe links are left alone. */
  linkParams?: Record<string, string> | null;
  /** 'manual' leaves delivery to the caller (synchronous test sends). */
  delivery?: 'queue' | 'manual';
}

export interface QueueResult {
  id: string;
  status: 'queued' | 'suppressed' | 'failed';
  reason: string | null;
}

async function insertMessage(db: Db, app: App, row: Record<string, unknown>): Promise<void> {
  const now = app.clock.now();
  await db.exec(sql.insert('email_messages', { ...row, created_at: now, updated_at: now }, ''));
}

/**
 * Render and queue an email in the caller's transaction: if the business change
 * rolls back, the email is never sent. Suppressed sends are still logged so
 * support can see why someone did not receive a message.
 */
export async function queueEmail(db: Db, app: App, input: QueueInput): Promise<QueueResult> {
  const to = input.to.trim().toLowerCase();
  const settings = settingsOf(app);
  const user = input.userId
    ? await db.maybe<{ id: string; name: string | null; locale: string | null }>(sql`SELECT id, name, locale FROM users WHERE id = ${input.userId}`)
    : await db.maybe<{ id: string; name: string | null; locale: string | null }>(sql`SELECT id, name, locale FROM users WHERE lower(email) = ${to} AND deleted_at IS NULL`);
  const id = newId('msg');
  const base = {
    id,
    to_email: to,
    user_id: user?.id ?? input.userId ?? null,
    org_id: input.orgId ?? null,
    template_key: input.templateKey ?? null,
    campaign_id: input.campaignId ?? null,
    metadata: { ...(input.metadata ?? {}), ...(input.listId ? { listId: input.listId } : {}), ...(input.test ? { test: true } : {}) },
  };

  let tpl: { subject: string; html: string; text: string | null; category: string; locale?: string } | null = null;
  if (input.templateKey) {
    const row = await findTemplate(db, input.templateKey, localeChain(input.locale, user?.locale, settings.defaultLocale));
    if (!row) {
      await insertMessage(db, app, { ...base, category: input.category ?? 'transactional', subject: `[missing template ${input.templateKey}]`, status: 'failed', last_error: 'template_not_found' });
      app.log.warn({ template: input.templateKey }, 'email template not found');
      return { id, status: 'failed', reason: 'template_not_found' };
    }
    tpl = row;
  } else if (input.content) {
    tpl = { subject: input.content.subject, html: input.content.html, text: input.content.text ?? null, category: input.category ?? 'marketing' };
  } else {
    throw new Error('queueEmail needs a templateKey or content');
  }

  const category = (input.category ?? tpl.category) as string;
  const decision = input.test ? { allowed: true, reason: null } : await checkDeliverable(db, { email: to, category, userId: base.user_id, listId: input.listId ?? null }, app);
  // Marketing email always carries an unsubscribe link; optional notifications (usage, product) may leave it out.
  const marketing = category === 'marketing' || Boolean(input.listId) || Boolean(input.campaignId);
  const unsubscribe =
    MANDATORY_CATEGORIES.includes(category) || (!marketing && !settings.notificationUnsubscribeLinks)
      ? null
      : unsubscribeUrl(app, to, input.listId ? listCategory(input.listId) : category);
  const data = { ...commonVariables(app, { email: to, name: user?.name ?? null }), ...(input.data ?? {}), ...(unsubscribe ? { unsubscribeUrl: unsubscribe } : {}) };

  let rendered;
  try {
    rendered = renderEmail(app, tpl, data, { unsubscribeUrl: unsubscribe });
    if (input.linkParams && Object.keys(input.linkParams).length) {
      const unsubPrefix = `${app.config.appUrl}/u/`;
      rendered.html = addLinkParams(rendered.html, input.linkParams, (url) => url.startsWith(unsubPrefix));
    }
  } catch (err) {
    await insertMessage(db, app, { ...base, category, subject: tpl.subject.slice(0, 200), status: 'failed', last_error: `render_error: ${(err as Error).message}` });
    return { id, status: 'failed', reason: 'render_error' };
  }

  const headers: Record<string, string> = {};
  if (unsubscribe) {
    headers['List-Unsubscribe'] = `<${unsubscribe}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const status = decision.allowed ? 'queued' : 'suppressed';
  await insertMessage(db, app, {
    ...base,
    locale: tpl.locale ?? null,
    category,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers,
    status,
    suppression_reason: decision.reason,
  });
  if (status === 'queued' && input.delivery !== 'manual') {
    await app.jobs.enqueue(db, 'email.deliver', { messageId: id }, { idempotencyKey: `email:${id}`, maxAttempts: settings.maxAttempts });
  }
  return { id, status, reason: decision.reason };
}

/** SendEmailFn used by every module through `sendSystemEmail` (modules/core/mail.ts). */
export function systemEmailSender(app: App) {
  return async (db: Db, email: SystemEmail): Promise<{ id: string | null; suppressed?: boolean }> => {
    const result = await queueEmail(db, app, {
      to: email.to,
      userId: email.userId ?? null,
      orgId: email.orgId ?? null,
      templateKey: email.template,
      locale: email.locale ?? null,
      category: email.category ?? null,
      data: email.data,
    });
    return { id: result.id, suppressed: result.status === 'suppressed' };
  };
}

/** Queue at most once per key (automations, recovery emails). Returns null if already sent. */
export async function sendOnce(db: Db, app: App, key: string, input: QueueInput): Promise<QueueResult | null> {
  const claimed = await db.maybe(sql`
    INSERT INTO email_automation_log (key, created_at) VALUES (${key}, ${app.clock.now()}) ON CONFLICT (key) DO NOTHING RETURNING key
  `);
  if (!claimed) return null;
  const result = await queueEmail(db, app, input);
  await db.exec(sql`UPDATE email_automation_log SET message_id = ${result.id} WHERE key = ${key}`);
  return result;
}

// ---- Delivery --------------------------------------------------------------------------------

export async function providerContext(app: App, db: Db, row: ProviderRow): Promise<ProviderContext> {
  return {
    config: row.config,
    secrets: await app.secrets.getAll(db, 'email_provider', row.id),
    fetch: (app.services['email.fetch'] as typeof fetch | undefined) ?? fetch,
    smtpTransport: (app.services['email.smtpTransport'] as ProviderContext['smtpTransport'] | undefined) ?? defaultSmtpTransport,
  };
}

const IMPLICIT_LOG: ProviderRow = { id: 'log', type: 'log', name: 'Development log', enabled: true, priority: 0, from_email: 'no-reply@localhost', from_name: null, reply_to: null, config: {} };

async function deliveryChain(app: App, onlyProviderId?: string | null): Promise<ProviderRow[]> {
  const rows = await app.db.many<ProviderRow>(sql`
    SELECT * FROM email_providers WHERE enabled ${onlyProviderId ? sql`AND id = ${onlyProviderId}` : sql.empty}
    ORDER BY priority DESC, created_at ASC
  `);
  if (rows.length || onlyProviderId) return rows;
  return !app.config.isProd && settingsOf(app).devLogFallback ? [IMPLICIT_LOG] : [];
}

function outgoing(app: App, msg: any, provider: ProviderRow): OutgoingEmail {
  const general = app.settings.get<{ appName: string }>('general');
  const settings = settingsOf(app);
  // A provider's own sender wins; otherwise Settings → Email (outgoing address, then the admin address).
  const fromEmail = provider.from_email || settings.defaultFromEmail || settings.adminEmail;
  if (!fromEmail) throw new ProviderError('No sender address: set the outgoing or admin email address in Settings → Email');
  return {
    messageId: msg.id,
    fromEmail,
    fromName: provider.from_name || settings.fromName || general.appName,
    replyTo: provider.reply_to,
    to: msg.to_email,
    subject: msg.subject,
    html: msg.html ?? '',
    text: msg.text ?? htmlToText(msg.html ?? ''),
    headers: msg.headers ?? {},
  };
}

export interface DeliveryOutcome {
  status: 'sent' | 'queued' | 'failed' | 'suppressed' | 'skipped';
  providerId?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
}

/**
 * Deliver one message: re-check suppression (people may have unsubscribed
 * since it was queued), then try enabled providers by priority, falling back
 * on failure. When every provider fails the message goes back to the queue and
 * the job retries with backoff; the final attempt marks it failed.
 */
export async function deliverMessage(app: App, messageId: string, attempt: { attempts: number; maxAttempts: number }, onlyProviderId?: string | null): Promise<DeliveryOutcome> {
  const now = app.clock.now();
  // A message stuck in "sending" for 10 minutes was abandoned by a crashed worker; reclaim it.
  const msg = await app.db.maybe<any>(sql`
    UPDATE email_messages SET status = 'sending', attempts = attempts + 1, updated_at = ${now}
    WHERE id = ${messageId} AND (status = 'queued' OR (status = 'sending' AND updated_at < ${new Date(now.getTime() - 10 * 60_000)}))
    RETURNING *
  `);
  if (!msg) return { status: 'skipped' };
  if (!msg.metadata?.test) {
    const decision = await checkDeliverable(app.db, { email: msg.to_email, category: msg.category, userId: msg.user_id, listId: msg.metadata?.listId ?? null }, app);
    if (!decision.allowed) {
      await app.db.exec(sql`UPDATE email_messages SET status = 'suppressed', suppression_reason = ${decision.reason}, updated_at = ${now} WHERE id = ${msg.id}`);
      return { status: 'suppressed', error: decision.reason };
    }
    // Settings → Email → sending method "Disabled": nothing leaves the server; the log says why.
    if (settingsOf(app).sendingDisabled) {
      await app.db.exec(sql`UPDATE email_messages SET status = 'suppressed', suppression_reason = 'sending_disabled', updated_at = ${now} WHERE id = ${msg.id}`);
      return { status: 'suppressed', error: 'sending_disabled' };
    }
  }
  const chain = await deliveryChain(app, onlyProviderId);
  const errors: string[] = [];
  if (!chain.length) errors.push('No email provider is configured');
  for (const provider of chain) {
    const adapter: EmailProviderAdapter | undefined = emailProviders[provider.type];
    if (!adapter) {
      errors.push(`${provider.name}: unknown provider type`);
      continue;
    }
    try {
      const res = await adapter.send(await providerContext(app, app.db, provider), outgoing(app, msg, provider));
      await app.db.exec(sql`
        UPDATE email_messages SET status = 'sent', provider_id = ${provider.id === 'log' ? null : provider.id}, provider_type = ${provider.type},
          provider_message_id = ${res.providerMessageId}, sent_at = ${app.clock.now()}, last_error = ${errors.length ? errors.join('; ').slice(0, 2000) : null},
          updated_at = ${app.clock.now()} WHERE id = ${msg.id}
      `);
      return { status: 'sent', providerId: provider.id, providerMessageId: res.providerMessageId };
    } catch (err) {
      errors.push(`${provider.name}: ${(err as Error).message}`);
      app.log.warn({ messageId: msg.id, provider: provider.name, err: (err as Error).message }, 'email provider failed; trying next');
    }
  }
  const final = attempt.attempts >= attempt.maxAttempts;
  const error = errors.join('; ').slice(0, 2000);
  await app.db.exec(sql`UPDATE email_messages SET status = ${final ? 'failed' : 'queued'}, last_error = ${error}, updated_at = ${app.clock.now()} WHERE id = ${msg.id}`);
  return { status: final ? 'failed' : 'queued', error };
}

// ---- Recipients -------------------------------------------------------------------------------

export interface Recipient {
  email: string;
  userId: string | null;
  name: string | null;
  locale: string | null;
}

/** Who should receive mail for a billing subject: the user, or an organization's billing contact (else its owner). */
export async function recipientForSubject(db: Db, subject: { type: 'user' | 'organization'; id: string }): Promise<Recipient | null> {
  if (subject.type === 'user') {
    const u = await db.maybe<{ email: string; name: string | null; locale: string | null }>(sql`SELECT email, name, locale FROM users WHERE id = ${subject.id} AND deleted_at IS NULL`);
    return u ? { email: u.email, userId: subject.id, name: u.name, locale: u.locale } : null;
  }
  const org = await db.maybe<{ billing_email: string | null; owner_user_id: string | null }>(sql`SELECT billing_email, owner_user_id FROM organizations WHERE id = ${subject.id} AND deleted_at IS NULL`);
  if (!org) return null;
  const owner = org.owner_user_id
    ? await db.maybe<{ email: string; name: string | null; locale: string | null }>(sql`SELECT email, name, locale FROM users WHERE id = ${org.owner_user_id} AND deleted_at IS NULL`)
    : null;
  if (org.billing_email) return { email: org.billing_email, userId: owner && owner.email.toLowerCase() === org.billing_email.toLowerCase() ? org.owner_user_id : null, name: owner?.name ?? null, locale: owner?.locale ?? null };
  return owner ? { email: owner.email, userId: org.owner_user_id, name: owner.name, locale: owner.locale } : null;
}
