import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, HOUR, MINUTE } from '../../core/clock.js';
import { processEnrollment } from './sequences.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;
let key: string;

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-05-04T09:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  key = await apiKey(t, admin);
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0`);
});
afterEach(async () => {
  await t.close();
});

const step = (delayMinutes: number, subject: string) => ({ delayMinutes, subject, html: `<p>${subject} for {{productName}}</p>` });

async function sequence(body: Record<string, unknown>, activate = true) {
  const created = await call(t, admin, 'POST', '/api/admin/email/sequences', { name: 'Onboarding', trigger: 'signup', ...body });
  if (activate) await call(t, admin, 'POST', `/api/admin/email/sequences/${created.id}/status`, { status: 'active' });
  return created;
}

async function user(email: string, marketingConsent = true): Promise<{ id: string; email: string }> {
  return call(t, admin, 'POST', '/api/admin/users', { email, marketingConsent });
}

/** Run the scheduled autoresponder pass the way the scheduler does, then deliver what it queued. */
async function tick() {
  await t.app.jobs.enqueue(t.app.db, 'email.sequences', {});
  await t.app.worker.runUntilIdle();
}

async function sent(to: string) {
  const rows = await t.app.db.many<{ subject: string; status: string; html: string }>(sql`
    SELECT subject, status, html FROM email_messages WHERE to_email = ${to} AND metadata->>'automation' = 'autoresponder' ORDER BY created_at, id
  `);
  return rows;
}

async function enrollment(userId: string) {
  return t.app.db.one<{ id: string; status: string; stop_reason: string | null; steps_sent: number }>(sql`SELECT id, status, stop_reason, steps_sent FROM email_sequence_enrollments WHERE user_id = ${userId}`);
}

describe('autoresponders', () => {
  it('sends a signup sequence on schedule, exactly once, and stops when the customer unsubscribes', async () => {
    await sequence({ steps: [step(0, 'Welcome aboard'), step(2 * 24 * 60, 'Day two tips'), step(3 * 24 * 60, 'Last tips')] });
    const ann = await user('ann@example.com');
    const bob = await user('bob@example.com', false);
    // People created by a CSV import or from a support email did not sign up.
    await call(t, admin, 'POST', '/api/admin/users', { email: 'imported@example.com', marketingConsent: true, registrationSource: 'import' });
    await call(t, admin, 'POST', '/api/admin/users', { email: 'mailer@example.com', marketingConsent: true, registrationSource: 'support_email' });
    await t.app.worker.runUntilIdle();
    expect((await t.app.db.many<{ email: string }>(sql`SELECT u.email FROM email_sequence_enrollments e JOIN users u ON u.id = e.user_id ORDER BY u.email`)).map((r) => r.email)).toEqual(['ann@example.com', 'bob@example.com']);

    expect((await sent('ann@example.com')).map((m) => [m.subject, m.status])).toEqual([['Welcome aboard', 'sent']]);
    // Autoresponders are marketing email: no consent, no enrolment progress.
    expect(await enrollment(bob.id)).toMatchObject({ status: 'stopped', stop_reason: 'no_consent', steps_sent: 0 });
    expect((await t.app.db.one(sql`SELECT status FROM email_messages WHERE to_email = 'bob@example.com'`)).status).toBe('suppressed');

    t.clock.advance(DAY);
    await tick();
    expect(await sent('ann@example.com')).toHaveLength(1);
    t.clock.advance(DAY + MINUTE);
    await tick();
    expect((await sent('ann@example.com')).map((m) => m.subject)).toEqual(['Welcome aboard', 'Day two tips']);

    // Replayed events, overlapping runs and retries never send a step twice.
    await t.app.db.tx((tx) => t.app.events.emit(tx, 'user.created', { userId: ann.id, email: ann.email, source: null }, { userId: ann.id }));
    await tick();
    await tick();
    const e = await enrollment(ann.id);
    await processEnrollment(t.app, e.id);
    expect(await sent('ann@example.com')).toHaveLength(2);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM email_sequence_enrollments WHERE user_id = ${ann.id}`)).n).toBe(1);

    const session = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId: ann.id } });
    await t.request({ method: 'PUT', url: '/api/client/email-preferences', bearer: session.body.token, body: { marketing: false } });
    await t.app.worker.runUntilIdle();
    expect(await enrollment(ann.id)).toMatchObject({ status: 'stopped', stop_reason: 'unsubscribed', steps_sent: 2 });
    t.clock.advance(4 * DAY);
    await tick();
    expect(await sent('ann@example.com')).toHaveLength(2);

    const types = (await t.app.db.many<{ type: string }>(sql`SELECT type FROM events WHERE type LIKE 'email.sequence_%' AND user_id = ${ann.id} ORDER BY created_at, id`)).map((r) => r.type);
    expect(types).toEqual(['email.sequence_enrolled', 'email.sequence_finished']);
  });

  it('enrols on subscriptions to chosen products and stops when the trigger no longer applies', async () => {
    const started = await sequence({ name: 'Pro onboarding', trigger: 'subscription_started', productIds: [cat.pro.id], steps: [step(0, 'Pro: getting started'), step(24 * 60, 'Pro: advanced')] });
    await sequence({ name: 'Win-back', trigger: 'subscription_ended', steps: [step(2 * 24 * 60, 'We miss you')] });
    const cy = await user('cy@example.com');
    const dee = await user('dee@example.com');

    const sub = await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: cy.id, priceId: cat.proMonthly.id, collectionMethod: 'complimentary' });
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: dee.id, priceId: cat.extraPrice.id, collectionMethod: 'complimentary' });
    await t.app.worker.runUntilIdle();
    expect((await sent('cy@example.com')).map((m) => m.subject)).toEqual(['Pro: getting started']);
    expect((await sent('cy@example.com'))[0].html).toContain('Pro: getting started for Pro');
    expect(await sent('dee@example.com')).toEqual([]);

    // Cancelling ends the onboarding sequence and starts the win-back one.
    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: false, reason: 'test' });
    await t.app.worker.runUntilIdle();
    t.clock.advance(DAY + MINUTE);
    await tick();
    const onboarding = await t.app.db.one<any>(sql`SELECT status, stop_reason FROM email_sequence_enrollments WHERE sequence_id = ${started.id}`);
    expect(onboarding).toEqual({ status: 'stopped', stop_reason: 'trigger_ended' });
    expect(await sent('cy@example.com')).toHaveLength(1);

    // The customer comes back before the win-back email is due: it is never sent, and the new subscription starts onboarding again.
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: cy.id, priceId: cat.proYearly.id, collectionMethod: 'complimentary' });
    await t.app.worker.runUntilIdle();
    t.clock.advance(2 * DAY);
    await tick();
    const winback = await t.app.db.one<any>(sql`SELECT e.status, e.stop_reason FROM email_sequence_enrollments e JOIN email_sequences s ON s.id = e.sequence_id WHERE s.name = 'Win-back'`);
    expect(winback).toEqual({ status: 'stopped', stop_reason: 'customer_returned' });
    expect((await sent('cy@example.com')).map((m) => m.subject)).toEqual(['Pro: getting started', 'Pro: getting started', 'Pro: advanced']);
  });

  it('enrols subscribers a set number of days before each renewal, once per renewal', async () => {
    await sequence({ name: 'Renewal heads-up', trigger: 'renewal_upcoming', daysBefore: 3, steps: [{ delayMinutes: 0, subject: 'Renewing {{renewsAt}}', html: '<p>Your plan renews on {{renewsAt}}.</p>' }] });
    const eve = await user('eve@example.com');
    const sub = await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: eve.id, priceId: cat.proMonthly.id, collectionMethod: 'complimentary' });
    // A paying, auto-renewing subscription (as a card checkout would create).
    await t.app.db.exec(sql`UPDATE subscriptions SET collection_method = 'charge_automatically' WHERE id = ${sub.id}`);
    const comp = await user('comp@example.com');
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: comp.id, priceId: cat.proMonthly.id, collectionMethod: 'complimentary' });
    await tick();
    expect(await sent('eve@example.com')).toEqual([]);

    const periodEnd = new Date(sub.current_period_end);
    t.clock.set(new Date(periodEnd.getTime() - 3 * DAY - HOUR));
    await tick();
    expect(await sent('eve@example.com')).toEqual([]);
    t.clock.advance(2 * HOUR);
    await tick();
    await tick();
    expect((await sent('eve@example.com')).map((m) => m.subject)).toEqual([`Renewing ${periodEnd.toISOString().slice(0, 10)}`]);
    // Complimentary subscriptions do not renew for money, so they get no renewal sequence.
    expect(await sent('comp@example.com')).toEqual([]);
  });

  it('enrols buyers on paid orders and stops after a refund', async () => {
    await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: 'sbx' } });
    await sequence({ name: 'After purchase', trigger: 'purchase', steps: [step(0, 'Thanks for buying'), step(24 * 60, 'How is it going?')] });
    const fay = await user('fay@example.com');
    const chk = await t.request({ method: 'POST', url: '/api/v1/checkout/sessions', bearer: key, body: { userId: fay.id, priceId: cat.proMonthly.id } });
    const gw = chk.body.url.split('/pay/sandbox/')[1].split('/')[0];
    const { payToken } = await import('../billing/checkout.js');
    await t.server.inject({ method: 'POST', url: `/pay/sandbox/${gw}/${chk.body.id}`, payload: { token: payToken(t.app, chk.body.id), outcome: 'success' } });
    await t.app.worker.runUntilIdle();
    expect((await sent('fay@example.com')).map((m) => m.subject)).toEqual(['Thanks for buying']);
    await t.app.db.exec(sql`UPDATE orders SET status = 'refunded' WHERE subject_id = ${fay.id}`);
    t.clock.advance(DAY + MINUTE);
    await tick();
    expect(await sent('fay@example.com')).toHaveLength(1);
    expect(await enrollment(fay.id)).toMatchObject({ status: 'stopped', stop_reason: 'trigger_ended' });
  });

  it('validates sequences, keeps step history across edits and enforces permissions', async () => {
    expect((await t.request({ method: 'POST', url: '/api/admin/email/sequences', as: admin, body: { name: 'x', trigger: 'renewal_upcoming', steps: [step(0, 'a')] } })).status).toBe(422);
    expect((await t.request({ method: 'POST', url: '/api/admin/email/sequences', as: admin, body: { name: 'x', trigger: 'signup', productIds: [cat.pro.id] } })).status).toBe(422);
    expect((await t.request({ method: 'POST', url: '/api/admin/email/sequences', as: admin, body: { name: 'x', trigger: 'signup', steps: [{ delayMinutes: 0, templateKey: 'nope.nope' }] } })).status).toBe(422);
    expect((await t.request({ method: 'POST', url: '/api/admin/email/sequences', as: admin, body: { name: 'x', trigger: 'signup', steps: [{ delayMinutes: 0, subject: 'x', html: '{{#if a}}' }] } })).status).toBe(422);
    const empty = await sequence({ name: 'Empty' }, false);
    expect((await t.request({ method: 'POST', url: `/api/admin/email/sequences/${empty.id}/status`, as: admin, body: { status: 'active' } })).body.error.code).toBe('sequence_empty');

    const seq = await sequence({ steps: [step(0, 'One'), step(60, 'Two')] });
    const gil = await user('gil@example.com');
    await t.app.worker.runUntilIdle();
    const detail = await call(t, admin, 'GET', `/api/admin/email/sequences/${seq.id}`);
    expect(detail.steps.map((s: any) => s.stats.queued)).toEqual([1, 0]);
    expect(detail.enrollments).toEqual({ active: 1 });

    // Rewording a step keeps its id, so nobody receives it twice; a new first step is not sent to people past it.
    const [one, two] = detail.steps;
    await call(t, admin, 'PUT', `/api/admin/email/sequences/${seq.id}`, {
      name: 'Onboarding',
      trigger: 'signup',
      steps: [{ id: one.id, delayMinutes: 0, subject: 'One (reworded)', html: '<p>1</p>' }, { id: two.id, delayMinutes: 60, subject: 'Two (reworded)', html: '<p>2</p>' }],
    });
    t.clock.advance(61 * MINUTE);
    await tick();
    expect((await sent('gil@example.com')).map((m) => m.subject)).toEqual(['One', 'Two (reworded)']);
    expect((await t.request({ method: 'PUT', url: `/api/admin/email/sequences/${seq.id}`, as: admin, body: { name: 'x', trigger: 'subscription_started', steps: [step(0, 'a')] } })).body.error.code).toBe('sequence_has_enrollments');

    const test = await call(t, admin, 'POST', `/api/admin/email/sequences/${seq.id}/test`, { stepId: one.id, to: 'me@example.com' });
    expect(test.status).toBe('queued');

    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/email/sequences', as: analyst })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: `/api/admin/email/sequences/${seq.id}/status`, as: analyst, body: { status: 'paused' } })).status).toBe(403);
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/email/sequences', as: support })).status).toBe(403);
    const marketer = await adminSession(t, ['marketing_manager']);
    expect((await t.request({ method: 'POST', url: `/api/admin/email/sequences/${seq.id}/status`, as: marketer, body: { status: 'paused' } })).status).toBe(200);
    const enrollments = await call(t, marketer, 'GET', `/api/admin/email/sequences/${seq.id}/enrollments`);
    expect(enrollments.data.map((e: any) => [e.email, e.status])).toEqual([['gil@example.com', 'completed']]);
    const profile = await call(t, marketer, 'GET', `/api/admin/email/sequences/enrollments?userId=${gil.id}`);
    expect(profile.data.map((e: any) => [e.name, e.status, e.steps_sent])).toEqual([['Onboarding', 'completed', 2]]);
    // Administrators limited to some organizations only see their customers.
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Elsewhere' });
    const scoped = await adminSession(t, ['marketing_manager'], [org.id]);
    expect((await call(t, scoped, 'GET', `/api/admin/email/sequences/${seq.id}/enrollments`)).total).toBe(0);
    expect((await t.request({ url: `/api/admin/email/sequences/enrollments?userId=${gil.id}`, as: scoped })).status).toBe(404);
    const audit = await t.app.db.many<{ action: string }>(sql`SELECT action FROM audit_logs WHERE action LIKE 'email_sequence.%' AND target_id = ${seq.id} ORDER BY seq`);
    expect(audit.map((a) => a.action)).toEqual(['email_sequence.create', 'email_sequence.activate', 'email_sequence.update', 'email_sequence.test_send', 'email_sequence.pause']);
  });
});
