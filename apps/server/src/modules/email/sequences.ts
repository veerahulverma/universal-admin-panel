import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { DomainEvent } from '../../core/events.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { DAY, MINUTE } from '../../core/clock.js';
import { validateTemplate } from '../../core/template.js';
import { queueEmail } from './service.js';
import { FINAL_INSTALLMENT_BILLED, INSTALLMENTS_COMPLETED, isSignup } from './automations.js';

/**
 * Autoresponders: a sequence of emails sent with delays after something
 * happens to a customer (signup, a purchase, a subscription starting, an
 * upcoming renewal, a subscription ending). They are marketing email, so only
 * people who consented receive them; an enrolment stops as soon as the person
 * unsubscribes or cannot be reached, and when its trigger no longer applies
 * (the order was refunded, the subscription was cancelled or renewed, the
 * customer came back).
 *
 * De-duplication: one enrolment per sequence, person and trigger occurrence,
 * and each step is claimed in `email_sequence_sends` before it is queued, so
 * retries and concurrent workers never send a step twice.
 */
export const SEQUENCE_TRIGGERS = ['signup', 'purchase', 'subscription_started', 'renewal_upcoming', 'subscription_ended'] as const;
export type SequenceTrigger = (typeof SEQUENCE_TRIGGERS)[number];

export interface SequenceRow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused';
  trigger_type: SequenceTrigger;
  product_ids: string[];
  days_before: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface StepRow {
  id: string;
  sequence_id: string;
  position: number;
  delay_minutes: number;
  template_key: string | null;
  subject: string;
  html: string;
  text: string | null;
}

export interface EnrollmentRow {
  id: string;
  sequence_id: string;
  user_id: string;
  trigger_ref: string;
  context: EnrollmentContext;
  status: 'active' | 'completed' | 'stopped';
  stop_reason: string | null;
  last_position: number;
  steps_sent: number;
  next_run_at: Date | null;
  enrolled_at: Date;
}

/** What the trigger was about; also the data templates can use. */
export interface EnrollmentContext {
  orderId?: string;
  subscriptionId?: string;
  productIds?: string[];
  productName?: string;
  periodEnd?: string;
  endedAt?: string;
}

export const stepInput = z
  .object({
    id: z.string().max(100).optional(),
    /** Wait after the previous email (after enrolment for the first step). */
    delayMinutes: z.number().int().min(0).max(366 * 24 * 60),
    templateKey: z.string().max(100).nullable().optional(),
    subject: z.string().trim().max(500).default(''),
    html: z.string().max(200_000).default(''),
    text: z.string().max(100_000).nullable().optional(),
  })
  .superRefine((s, ctx) => {
    if (!s.templateKey && (!s.subject || !s.html)) ctx.addIssue({ code: 'custom', path: ['html'], message: 'Write a subject and body, or choose a template' });
    for (const f of ['subject', 'html', 'text'] as const) {
      const problem = s[f] ? validateTemplate(s[f]!) : null;
      if (problem) ctx.addIssue({ code: 'custom', path: [f], message: problem });
    }
  });
export type StepInput = z.infer<typeof stepInput>;

export const sequenceInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).default(''),
    trigger: z.enum(SEQUENCE_TRIGGERS),
    /** Purchase and subscription triggers: only these products (empty: any product). */
    productIds: z.array(z.string().max(100)).max(50).default([]),
    /** Renewal trigger: how many days before the renewal date to enrol. */
    daysBefore: z.number().int().min(1).max(365).nullable().optional(),
    steps: z.array(stepInput).max(20).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.trigger === 'renewal_upcoming' && !s.daysBefore) ctx.addIssue({ code: 'custom', path: ['daysBefore'], message: 'Choose how many days before the renewal to start' });
    if (s.trigger === 'signup' && s.productIds.length) ctx.addIssue({ code: 'custom', path: ['productIds'], message: 'Signup sequences cannot be limited to products' });
  });
export type SequenceInput = z.infer<typeof sequenceInput>;

/** Suppression reasons that mean the person cannot or does not want to receive the sequence: the enrolment stops. */
const UNREACHABLE = new Set(['no_consent', 'unsubscribed', 'unsubscribe', 'hard_bounce', 'complaint', 'manual', 'inactive_recipient']);

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export async function loadSteps(db: Db, sequenceId: string): Promise<StepRow[]> {
  return db.many<StepRow>(sql`SELECT * FROM email_sequence_steps WHERE sequence_id = ${sequenceId} ORDER BY position, created_at`);
}

/** Replace a sequence's steps; steps that keep their id keep their history (and are not re-sent). */
export async function saveSteps(db: Db, app: App, sequenceId: string, steps: StepInput[]): Promise<void> {
  const now = app.clock.now();
  const existing = new Set((await db.many<{ id: string }>(sql`SELECT id FROM email_sequence_steps WHERE sequence_id = ${sequenceId}`)).map((s) => s.id));
  const kept = steps.map((s) => (s.id && existing.has(s.id) ? s.id : null));
  await db.exec(sql`DELETE FROM email_sequence_steps WHERE sequence_id = ${sequenceId} ${kept.some(Boolean) ? sql`AND id NOT IN ${sql.in(kept.filter(Boolean))}` : sql.empty}`);
  for (const [position, s] of steps.entries()) {
    const values = {
      position,
      delay_minutes: s.delayMinutes,
      template_key: s.templateKey || null,
      subject: s.templateKey ? '' : s.subject,
      html: s.templateKey ? '' : s.html,
      text: s.templateKey ? null : s.text || null,
      updated_at: now,
    };
    if (kept[position]) await db.exec(sql`UPDATE email_sequence_steps SET ${sql.set(values)} WHERE id = ${kept[position]}`);
    else await db.exec(sql.insert('email_sequence_steps', { id: newId('stp'), sequence_id: sequenceId, ...values, created_at: now }, ''));
  }
}

// ---- Enrolment ---------------------------------------------------------------------------------

/** Enrol a person; returns the new enrolment id, or null when they are already enrolled for this occurrence. */
export async function enroll(db: Db, app: App, seq: SequenceRow, input: { userId: string; triggerRef: string; context: EnrollmentContext }): Promise<string | null> {
  const [first] = await loadSteps(db, seq.id);
  if (!first) return null;
  const now = app.clock.now();
  const row = await db.maybe<{ id: string }>(sql`
    INSERT INTO email_sequence_enrollments (id, sequence_id, user_id, trigger_ref, context, status, next_run_at, enrolled_at, updated_at)
    VALUES (${newId('enr')}, ${seq.id}, ${input.userId}, ${input.triggerRef}, ${sql.json(input.context)}, 'active',
            ${new Date(now.getTime() + first.delay_minutes * MINUTE)}, ${now}, ${now})
    ON CONFLICT (sequence_id, user_id, trigger_ref) DO NOTHING RETURNING id
  `);
  if (!row) return null;
  await app.events.emit(db, 'email.sequence_enrolled', { sequenceId: seq.id, enrollmentId: row.id, userId: input.userId, trigger: seq.trigger_type }, { userId: input.userId });
  return row.id;
}

async function finish(db: Db, app: App, e: Pick<EnrollmentRow, 'id' | 'sequence_id' | 'user_id'>, status: 'completed' | 'stopped', reason: string | null): Promise<void> {
  const now = app.clock.now();
  const n = await db.exec(sql`
    UPDATE email_sequence_enrollments SET status = ${status}, stop_reason = ${reason}, next_run_at = NULL, finished_at = ${now}, updated_at = ${now}
    WHERE id = ${e.id} AND status = 'active'
  `);
  if (n) await app.events.emit(db, 'email.sequence_finished', { sequenceId: e.sequence_id, enrollmentId: e.id, userId: e.user_id, status, reason }, { userId: e.user_id });
}

export async function stopEnrollment(db: Db, app: App, e: Pick<EnrollmentRow, 'id' | 'sequence_id' | 'user_id'>, reason: string): Promise<void> {
  await finish(db, app, e, 'stopped', reason);
}

/** Everyone who unsubscribes from marketing leaves every sequence at once. */
export async function stopForUser(db: Db, app: App, userId: string, reason: string): Promise<number> {
  const active = await db.many<EnrollmentRow>(sql`SELECT * FROM email_sequence_enrollments WHERE user_id = ${userId} AND status = 'active' FOR UPDATE`);
  for (const e of active) await stopEnrollment(db, app, e, reason);
  return active.length;
}

const ACTIVE_SUBSCRIPTION = ['active', 'trialing', 'past_due'];

/** Why an enrolment's trigger no longer applies (null while it still does). */
async function triggerEnded(db: Db, app: App, seq: SequenceRow, e: EnrollmentRow): Promise<string | null> {
  if (seq.trigger_type === 'signup' || !app.modules.isEnabled('billing')) return null;
  if (seq.trigger_type === 'purchase') {
    const order = await db.maybe<{ status: string }>(sql`SELECT status FROM orders WHERE id = ${e.context.orderId ?? ''}`);
    return !order || ['refunded', 'canceled', 'failed'].includes(order.status) ? 'trigger_ended' : null;
  }
  const sub = await db.maybe<{ status: string; cancel_at_period_end: boolean; current_period_end: Date; subject_type: string; subject_id: string; product_id: string }>(sql`
    SELECT status, cancel_at_period_end, current_period_end, subject_type, subject_id, product_id FROM subscriptions WHERE id = ${e.context.subscriptionId ?? ''}
  `);
  if (!sub) return 'trigger_ended';
  switch (seq.trigger_type) {
    case 'subscription_started':
      return ['canceled', 'unpaid', 'incomplete'].includes(sub.status) ? 'trigger_ended' : null;
    case 'renewal_upcoming':
      // Cancelled, set to end, or already renewed: the renewal this sequence was about will not happen.
      return !['active', 'past_due'].includes(sub.status) || sub.cancel_at_period_end || sub.current_period_end.toISOString() !== e.context.periodEnd ? 'trigger_ended' : null;
    case 'subscription_ended': {
      const back = await db.maybe(sql`
        SELECT 1 FROM subscriptions WHERE subject_type = ${sub.subject_type} AND subject_id = ${sub.subject_id} AND product_id = ${sub.product_id}
          AND status IN ${sql.in(ACTIVE_SUBSCRIPTION)} LIMIT 1
      `);
      return back ? 'customer_returned' : null;
    }
  }
}

function templateData(seq: SequenceRow, e: EnrollmentRow): Record<string, unknown> {
  return {
    sequence: { name: seq.name },
    productName: e.context.productName ?? '',
    renewsAt: day(e.context.periodEnd),
    endedAt: day(e.context.endedAt),
  };
}

export type StepOutcome = 'sent' | 'completed' | 'stopped' | 'waiting' | 'skipped';

/**
 * Send the next due step of one enrolment. The next step is scheduled from
 * when this one went out, so a delay means "after the previous email" and a
 * backlog never sends several emails at once.
 */
export async function processEnrollment(app: App, enrollmentId: string): Promise<StepOutcome> {
  return app.db.tx(async (tx) => {
    const now = app.clock.now();
    const e = await tx.maybe<EnrollmentRow>(sql`SELECT * FROM email_sequence_enrollments WHERE id = ${enrollmentId} AND status = 'active' FOR UPDATE SKIP LOCKED`);
    if (!e || !e.next_run_at || e.next_run_at > now) return 'skipped';
    const seq = await tx.maybe<SequenceRow>(sql`SELECT * FROM email_sequences WHERE id = ${e.sequence_id}`);
    if (!seq || seq.status !== 'active') return 'waiting';
    const ended = await triggerEnded(tx, app, seq, e);
    if (ended) {
      await stopEnrollment(tx, app, e, ended);
      return 'stopped';
    }
    const steps = await loadSteps(tx, seq.id);
    const step = steps.find((s) => s.position > e.last_position);
    if (!step) {
      await finish(tx, app, e, 'completed', null);
      return 'completed';
    }
    const user = await tx.maybe<{ email: string; locale: string | null; status: string; deleted_at: Date | null }>(sql`SELECT email, locale, status, deleted_at FROM users WHERE id = ${e.user_id}`);
    if (!user || user.deleted_at || user.status === 'banned') {
      await stopEnrollment(tx, app, e, 'inactive_recipient');
      return 'stopped';
    }
    const claimed = await tx.maybe(sql`
      INSERT INTO email_sequence_sends (enrollment_id, step_id, status, created_at) VALUES (${e.id}, ${step.id}, 'pending', ${now})
      ON CONFLICT (enrollment_id, step_id) DO NOTHING RETURNING step_id
    `);
    let queued = false;
    if (claimed) {
      const result = await queueEmail(tx, app, {
        to: user.email,
        userId: e.user_id,
        locale: user.locale,
        category: 'marketing',
        templateKey: step.template_key,
        content: step.template_key ? null : { subject: step.subject, html: step.html, text: step.text },
        data: templateData(seq, e),
        metadata: { automation: 'autoresponder', sequenceId: seq.id, enrollmentId: e.id, stepId: step.id },
      });
      await tx.exec(sql`UPDATE email_sequence_sends SET message_id = ${result.id}, status = ${result.status}, reason = ${result.reason} WHERE enrollment_id = ${e.id} AND step_id = ${step.id}`);
      if (result.status === 'suppressed' && UNREACHABLE.has(result.reason ?? '')) {
        await stopEnrollment(tx, app, e, result.reason!);
        return 'stopped';
      }
      queued = result.status === 'queued';
    }
    const following = steps.find((s) => s.position > step.position);
    await tx.exec(sql`
      UPDATE email_sequence_enrollments SET last_position = ${step.position}, steps_sent = steps_sent + ${queued ? 1 : 0},
        next_run_at = ${following ? new Date(now.getTime() + following.delay_minutes * MINUTE) : null}, updated_at = ${now}
      WHERE id = ${e.id}
    `);
    if (!following) await finish(tx, app, e, 'completed', null);
    return 'sent';
  });
}

// ---- Triggers --------------------------------------------------------------------------------------

async function activeSequences(db: Db, trigger: SequenceTrigger): Promise<SequenceRow[]> {
  return db.many<SequenceRow>(sql`SELECT * FROM email_sequences WHERE status = 'active' AND trigger_type = ${trigger} ORDER BY created_at`);
}

const forProducts = (seq: SequenceRow, productIds: readonly string[]) => !seq.product_ids.length || seq.product_ids.some((p) => productIds.includes(p));

/** The person to write to about a billing subject: the buyer, else the user subject, else the organization's owner. */
async function personFor(db: Db, row: { user_id: string | null; subject_type: string; subject_id: string }): Promise<string | null> {
  if (row.user_id) return row.user_id;
  if (row.subject_type === 'user') return row.subject_id;
  return (await db.maybe<{ owner_user_id: string | null }>(sql`SELECT owner_user_id FROM organizations WHERE id = ${row.subject_id}`))?.owner_user_id ?? null;
}

/** Enrol into every matching active sequence, then send steps that are due right away. */
async function enrollAll(app: App, trigger: SequenceTrigger, build: (db: Db) => Promise<{ userId: string; triggerRef: string; context: EnrollmentContext; productIds: string[] } | null>): Promise<void> {
  const sequences = await activeSequences(app.db, trigger);
  if (!sequences.length) return;
  const enrolled = await app.db.tx(async (tx) => {
    const target = await build(tx);
    if (!target) return [];
    const ids: string[] = [];
    for (const seq of sequences) {
      if (!forProducts(seq, target.productIds)) continue;
      const id = await enroll(tx, app, seq, target);
      if (id) ids.push(id);
    }
    return ids;
  });
  for (const id of enrolled) await processEnrollment(app, id);
}

async function subscriptionTarget(db: Db, subscriptionId: string, extra: (sub: any) => EnrollmentContext) {
  const sub = await db.maybe<any>(sql`SELECT s.*, p.name AS product_name FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.id = ${subscriptionId}`);
  if (!sub) return null;
  const userId = await personFor(db, sub);
  if (!userId) return null;
  return {
    userId,
    triggerRef: `subscription:${sub.id}`,
    productIds: [sub.product_id as string],
    context: { subscriptionId: sub.id, productIds: [sub.product_id], productName: sub.product_name, ...extra(sub) },
  };
}

export function registerSequenceTriggers(app: App): void {
  const on = (id: string, pattern: string, fn: (event: DomainEvent) => Promise<void>) => app.events.subscribe(`email.sequences.${id}`, pattern, fn, { module: 'email' });

  on('signup', 'user.created', async (event) => {
    if (!isSignup(app, event.data.source as string | null)) return;
    await enrollAll(app, 'signup', async () => ({ userId: event.data.userId, triggerRef: 'signup', context: {}, productIds: [] }));
  });

  on('purchase', 'order.paid', async (event) =>
    enrollAll(app, 'purchase', async (db) => {
      const order = await db.maybe<{ id: string; user_id: string | null; subject_type: string; subject_id: string }>(sql`SELECT id, user_id, subject_type, subject_id FROM orders WHERE id = ${event.data.orderId}`);
      if (!order) return null;
      const userId = await personFor(db, order);
      if (!userId) return null;
      const items = await db.many<{ product_id: string; name: string }>(sql`
        SELECT i.product_id, p.name FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ${order.id} ORDER BY i.id
      `);
      return { userId, triggerRef: `order:${order.id}`, productIds: items.map((i) => i.product_id), context: { orderId: order.id, productIds: items.map((i) => i.product_id), productName: items[0]?.name ?? '' } };
    }),
  );

  on('subscription-started', 'subscription.created', async (event) => enrollAll(app, 'subscription_started', (db) => subscriptionTarget(db, event.data.subscriptionId, () => ({}))));

  on('subscription-ended', 'subscription.canceled', async (event) => {
    // Paying off an installment plan completes a purchase; it is not the customer leaving.
    if (event.data.reason === INSTALLMENTS_COMPLETED) return;
    await enrollAll(app, 'subscription_ended', (db) => subscriptionTarget(db, event.data.subscriptionId, (sub) => ({ endedAt: new Date(sub.ended_at ?? event.data.endedAt ?? event.createdAt).toISOString() })));
  });

  on('unsubscribed', 'email.preferences_updated', async (event) => {
    if (event.data.subscribed !== false || event.data.category !== 'marketing' || !event.data.userId) return;
    await app.db.tx((tx) => stopForUser(tx, app, event.data.userId, 'unsubscribed'));
  });
}

/** Renewal sequences enrol subscribers whose next renewal is within the sequence's window (once per renewal date). */
export async function enrollUpcomingRenewals(app: App): Promise<number> {
  if (!app.modules.isEnabled('billing')) return 0;
  const sequences = await activeSequences(app.db, 'renewal_upcoming');
  const now = app.clock.now();
  const enrolled: string[] = [];
  for (const seq of sequences) {
    const subs = await app.db.many<any>(sql`
      SELECT s.id, s.user_id, s.subject_type, s.subject_id, s.product_id, s.current_period_end, p.name AS product_name
      FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_id
      WHERE s.status = 'active' AND NOT s.cancel_at_period_end AND s.collection_method <> 'complimentary' AND NOT ${FINAL_INSTALLMENT_BILLED}
        AND s.current_period_end > ${now} AND s.current_period_end <= ${new Date(now.getTime() + (seq.days_before ?? 7) * DAY)}
        ${seq.product_ids.length ? sql`AND s.product_id IN ${sql.in(seq.product_ids)}` : sql.empty}
      ORDER BY s.current_period_end LIMIT 1000
    `);
    for (const sub of subs) {
      const id = await app.db.tx(async (tx) => {
        const userId = await personFor(tx, sub);
        if (!userId) return null;
        const periodEnd = (sub.current_period_end as Date).toISOString();
        return enroll(tx, app, seq, {
          userId,
          triggerRef: `renewal:${sub.id}:${periodEnd}`,
          context: { subscriptionId: sub.id, productIds: [sub.product_id], productName: sub.product_name, periodEnd },
        });
      });
      if (id) enrolled.push(id);
    }
  }
  return enrolled.length;
}

/** Scheduled run: enrol upcoming renewals, then send every step that is due (several passes for zero-delay steps). */
export async function runSequences(app: App): Promise<{ enrolled: number; sent: number }> {
  const enrolled = await enrollUpcomingRenewals(app);
  let sent = 0;
  for (let pass = 0; pass < 20; pass++) {
    const due = await app.db.many<{ id: string }>(sql`
      SELECT e.id FROM email_sequence_enrollments e JOIN email_sequences s ON s.id = e.sequence_id AND s.status = 'active'
      WHERE e.status = 'active' AND e.next_run_at <= ${app.clock.now()} ORDER BY e.next_run_at LIMIT 500
    `);
    if (!due.length) break;
    let progressed = 0;
    for (const row of due) {
      const outcome = await processEnrollment(app, row.id);
      if (outcome === 'sent') sent++;
      if (outcome !== 'skipped' && outcome !== 'waiting') progressed++;
    }
    if (!progressed) break;
  }
  return { enrolled, sent };
}
