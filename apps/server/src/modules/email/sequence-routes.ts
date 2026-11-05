import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { email as emailField, pageQuery, paginate } from '../../core/validation.js';
import { getUser, userScopeSql } from '../customers/service.js';
import { queueEmail } from './service.js';
import { loadSteps, saveSteps, sequenceInput, stopEnrollment, type EnrollmentRow, type SequenceInput, type SequenceRow } from './sequences.js';

const BILLING_TRIGGERS = new Set(['purchase', 'subscription_started', 'renewal_upcoming', 'subscription_ended']);

async function validateSequence(db: Db, app: App, input: Pick<SequenceInput, 'trigger' | 'productIds' | 'steps'>): Promise<void> {
  if (BILLING_TRIGGERS.has(input.trigger) && !app.modules.isEnabled('billing')) {
    throw validationError([{ path: ['trigger'], message: 'This trigger needs the billing module' }]);
  }
  if (input.productIds.length) {
    const found = await db.many<{ id: string }>(sql`SELECT id FROM products WHERE id IN ${sql.in(input.productIds)}`);
    const missing = input.productIds.filter((id) => !found.some((p) => p.id === id));
    if (missing.length) throw validationError([{ path: ['productIds'], message: `Unknown product: ${missing.join(', ')}` }]);
  }
  const keys = [...new Set(input.steps.map((s) => s.templateKey).filter((k): k is string => Boolean(k)))];
  if (keys.length) {
    const found = await db.many<{ key: string }>(sql`SELECT DISTINCT key FROM email_templates WHERE key IN ${sql.in(keys)}`);
    const missing = keys.filter((k) => !found.some((t) => t.key === k));
    if (missing.length) throw validationError([{ path: ['steps'], message: `Unknown template: ${missing.join(', ')}` }]);
  }
}

async function sequenceDetail(db: Db, id: string) {
  const seq = await db.maybe<SequenceRow>(sql`SELECT * FROM email_sequences WHERE id = ${id}`);
  if (!seq) throw notFound('Autoresponder');
  const [steps, enrollments, sends] = await Promise.all([
    loadSteps(db, seq.id),
    db.many<{ status: string; count: number }>(sql`SELECT status, count(*)::int AS count FROM email_sequence_enrollments WHERE sequence_id = ${seq.id} GROUP BY 1`),
    db.many<{ step_id: string; status: string; count: number; opened: number; clicked: number }>(sql`
      SELECT s.step_id, s.status, count(*)::int AS count, count(m.opened_at)::int AS opened, count(m.clicked_at)::int AS clicked
      FROM email_sequence_sends s JOIN email_sequence_enrollments e ON e.id = s.enrollment_id LEFT JOIN email_messages m ON m.id = s.message_id
      WHERE e.sequence_id = ${seq.id} GROUP BY 1, 2
    `),
  ]);
  const stopped = await db.many<{ reason: string; count: number }>(sql`
    SELECT coalesce(stop_reason, 'unknown') AS reason, count(*)::int AS count FROM email_sequence_enrollments WHERE sequence_id = ${seq.id} AND status = 'stopped' GROUP BY 1 ORDER BY 2 DESC
  `);
  return {
    ...seq,
    steps: steps.map((s) => {
      const rows = sends.filter((x) => x.step_id === s.id);
      return {
        ...s,
        stats: {
          queued: rows.find((x) => x.status === 'queued')?.count ?? 0,
          suppressed: rows.find((x) => x.status === 'suppressed')?.count ?? 0,
          failed: rows.find((x) => x.status === 'failed')?.count ?? 0,
          opened: rows.reduce((n, x) => n + x.opened, 0),
          clicked: rows.reduce((n, x) => n + x.clicked, 0),
        },
      };
    }),
    enrollments: Object.fromEntries(enrollments.map((r) => [r.status, r.count])),
    stopReasons: stopped,
  };
}

export function registerSequenceRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/email/sequences',
    auth: 'admin',
    permission: 'email.autoresponders.view',
    summary: 'Autoresponder sequences with their enrolment counts',
    tags: ['Email'],
    handler: async () => ({
      data: await app.db.many(sql`
        SELECT s.*, (SELECT count(*)::int FROM email_sequence_steps st WHERE st.sequence_id = s.id) AS step_count,
          (SELECT count(*)::int FROM email_sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'active') AS active_count,
          (SELECT count(*)::int FROM email_sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'completed') AS completed_count,
          (SELECT count(*)::int FROM email_sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'stopped') AS stopped_count
        FROM email_sequences s ORDER BY s.created_at DESC
      `),
    }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/email/sequences/enrollments',
    auth: 'admin',
    permission: 'email.autoresponders.view',
    summary: "A customer's autoresponder enrolments, newest first",
    tags: ['Email'],
    query: z.object({ userId: z.string().max(100) }),
    handler: async (c) => {
      const user = await getUser(app.db, c.query.userId, c.orgScope(), { includeDeleted: true });
      return {
        data: await app.db.many(sql`
          SELECT e.id, e.sequence_id, s.name, s.trigger_type, e.status, e.stop_reason, e.steps_sent, e.next_run_at, e.enrolled_at, e.finished_at
          FROM email_sequence_enrollments e JOIN email_sequences s ON s.id = e.sequence_id WHERE e.user_id = ${user.id} ORDER BY e.enrolled_at DESC LIMIT 100
        `),
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/email/sequences/:id',
    auth: 'admin',
    permission: 'email.autoresponders.view',
    summary: 'One autoresponder with its steps and per-step delivery statistics',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: (c) => sequenceDetail(app.db, c.params.id),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/sequences',
    auth: 'admin',
    permission: 'email.autoresponders.manage',
    summary: 'Create an autoresponder (as a draft; activate it to start enrolling)',
    tags: ['Email'],
    bodyLimit: 4 * 1024 * 1024,
    body: sequenceInput,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        await validateSequence(tx, app, c.body);
        const now = app.clock.now();
        const id = newId('seq');
        await tx.exec(sql.insert('email_sequences', {
          id,
          name: c.body.name,
          description: c.body.description,
          status: 'draft',
          trigger_type: c.body.trigger,
          product_ids: [...new Set(c.body.productIds)],
          days_before: c.body.trigger === 'renewal_upcoming' ? c.body.daysBefore ?? null : null,
          created_by: c.admin().adminId,
          created_at: now,
          updated_at: now,
        }, ''));
        await saveSteps(tx, app, id, c.body.steps);
        await c.audit(tx, 'email_sequence.create', { type: 'email_sequence', id }, { name: c.body.name, trigger: c.body.trigger, steps: c.body.steps.length });
        c.reply.status(201);
        return sequenceDetail(tx, id);
      }),
  });

  r.route({
    method: 'PUT',
    url: '/api/admin/email/sequences/:id',
    auth: 'admin',
    permission: 'email.autoresponders.manage',
    summary: 'Save an autoresponder: name, audience and the full list of steps (steps keep their history by id)',
    tags: ['Email'],
    bodyLimit: 4 * 1024 * 1024,
    params: z.object({ id: z.string() }),
    body: sequenceInput,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await tx.maybe<SequenceRow>(sql`SELECT * FROM email_sequences WHERE id = ${c.params.id} FOR UPDATE`);
        if (!before) throw notFound('Autoresponder');
        if (c.body.trigger !== before.trigger_type && (await tx.maybe(sql`SELECT 1 FROM email_sequence_enrollments WHERE sequence_id = ${before.id} LIMIT 1`))) {
          throw conflict('People are already enrolled; create a new autoresponder for a different trigger', 'sequence_has_enrollments');
        }
        await validateSequence(tx, app, c.body);
        if (before.status === 'active' && !c.body.steps.length) throw validationError([{ path: ['steps'], message: 'An active autoresponder needs at least one email' }]);
        await tx.exec(sql`
          UPDATE email_sequences SET ${sql.set({
            name: c.body.name,
            description: c.body.description,
            trigger_type: c.body.trigger,
            product_ids: [...new Set(c.body.productIds)],
            days_before: c.body.trigger === 'renewal_upcoming' ? c.body.daysBefore ?? null : null,
            updated_at: app.clock.now(),
          })} WHERE id = ${before.id}
        `);
        await saveSteps(tx, app, before.id, c.body.steps);
        await c.audit(tx, 'email_sequence.update', { type: 'email_sequence', id: before.id }, { name: c.body.name, trigger: c.body.trigger, steps: c.body.steps.length });
        return sequenceDetail(tx, before.id);
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/sequences/:id/status',
    auth: 'admin',
    permission: 'email.autoresponders.manage',
    summary: 'Activate or pause an autoresponder (paused ones neither enrol nor send)',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    body: z.object({ status: z.enum(['active', 'paused']) }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const seq = await tx.maybe<SequenceRow>(sql`SELECT * FROM email_sequences WHERE id = ${c.params.id} FOR UPDATE`);
        if (!seq) throw notFound('Autoresponder');
        if (c.body.status === 'active' && !(await loadSteps(tx, seq.id)).length) throw conflict('Add at least one email before activating', 'sequence_empty');
        if (seq.status !== c.body.status) {
          await tx.exec(sql`UPDATE email_sequences SET status = ${c.body.status}, updated_at = ${app.clock.now()} WHERE id = ${seq.id}`);
          await c.audit(tx, c.body.status === 'active' ? 'email_sequence.activate' : 'email_sequence.pause', { type: 'email_sequence', id: seq.id }, { name: seq.name });
        }
        return sequenceDetail(tx, seq.id);
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/email/sequences/:id',
    auth: 'admin',
    permission: 'email.autoresponders.manage',
    summary: 'Delete an autoresponder and its enrolments (emails already sent stay in the log)',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const row = await tx.maybe<{ name: string }>(sql`DELETE FROM email_sequences WHERE id = ${c.params.id} RETURNING name`);
        if (!row) throw notFound('Autoresponder');
        await c.audit(tx, 'email_sequence.delete', { type: 'email_sequence', id: c.params.id }, { name: row.name });
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/email/sequences/:id/enrollments',
    auth: 'admin',
    permission: 'email.autoresponders.view',
    summary: 'People enrolled in an autoresponder and where they are in it',
    tags: ['Email'],
    params: z.object({ id: z.string() }),
    query: z.object({ ...pageQuery, status: z.enum(['active', 'completed', 'stopped']).optional() }),
    handler: (c) =>
      paginate(app.db, {
        select: sql`e.id, e.user_id, u.email, u.name, e.trigger_ref, e.status, e.stop_reason, e.steps_sent, e.next_run_at, e.enrolled_at, e.finished_at`,
        from: sql`email_sequence_enrollments e JOIN users u ON u.id = e.user_id`,
        where: sql.where([sql`e.sequence_id = ${c.params.id}`, c.query.status && sql`e.status = ${c.query.status}`, userScopeSql(c.orgScope(), 'u')]),
        orderBy: sql`ORDER BY e.enrolled_at DESC, e.id DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/sequences/:id/enrollments/:enrollmentId/stop',
    auth: 'admin',
    permission: 'email.autoresponders.manage',
    summary: 'Take one person out of an autoresponder',
    tags: ['Email'],
    params: z.object({ id: z.string(), enrollmentId: z.string() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const e = await tx.maybe<EnrollmentRow>(sql`
          SELECT e.* FROM email_sequence_enrollments e JOIN users u ON u.id = e.user_id
          ${sql.where([sql`e.id = ${c.params.enrollmentId}`, sql`e.sequence_id = ${c.params.id}`, userScopeSql(c.orgScope(), 'u')])} FOR UPDATE OF e
        `);
        if (!e) throw notFound('Enrolment');
        if (e.status !== 'active') throw conflict(`This enrolment is already ${e.status}`, 'enrollment_finished');
        await stopEnrollment(tx, app, e, 'stopped_by_admin');
        await c.audit(tx, 'email_sequence.enrollment_stop', { type: 'email_sequence', id: e.sequence_id }, { enrollmentId: e.id, userId: e.user_id });
        return { ok: true };
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/email/sequences/:id/test',
    auth: 'admin',
    permission: 'email.autoresponders.manage',
    summary: 'Send one step to yourself with sample data (skips consent checks; marked as a test)',
    tags: ['Email'],
    rateLimit: { max: 20, windowSec: 600, by: 'principal' },
    params: z.object({ id: z.string() }),
    body: z.object({ stepId: z.string(), to: emailField.optional() }),
    handler: async (c) => {
      const seq = await app.db.maybe<SequenceRow>(sql`SELECT * FROM email_sequences WHERE id = ${c.params.id}`);
      if (!seq) throw notFound('Autoresponder');
      const step = (await loadSteps(app.db, seq.id)).find((s) => s.id === c.body.stepId);
      if (!step) throw notFound('Step');
      const to = c.body.to ?? c.admin().email;
      return app.db.tx(async (tx) => {
        const result = await queueEmail(tx, app, {
          to,
          category: 'marketing',
          templateKey: step.template_key,
          content: step.template_key ? null : { subject: `[Test] ${step.subject}`, html: step.html, text: step.text },
          data: { sequence: { name: seq.name }, productName: 'Pro', renewsAt: '2026-06-01', endedAt: '2026-05-31' },
          test: true,
          metadata: { sequenceTest: seq.id, stepId: step.id },
        });
        await c.audit(tx, 'email_sequence.test_send', { type: 'email_sequence', id: seq.id }, { stepId: step.id, to });
        return result;
      });
    },
  });
}
