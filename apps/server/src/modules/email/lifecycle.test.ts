import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call, seedCatalog, type CatalogFixture } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { DAY, HOUR } from '../../core/clock.js';
import { newId } from '../../core/ids.js';

let t: TestPlatform;
let admin: AdminSession;
let cat: CatalogFixture;

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-05-04T09:00:00Z');
  admin = await adminSession(t);
  cat = await seedCatalog(t, admin);
  await t.app.db.exec(sql`UPDATE products SET trial_days = 0`);
});
afterEach(async () => {
  await t.close();
});

async function user(email: string, extra: Record<string, unknown> = {}): Promise<{ id: string; email: string }> {
  return call(t, admin, 'POST', '/api/admin/users', { email, ...extra });
}

async function emails(template: string) {
  return t.app.db.many<{ to_email: string; subject: string; html: string; status: string; category: string }>(sql`
    SELECT to_email, subject, html, status, category FROM email_messages WHERE template_key = ${template} ORDER BY created_at, id
  `);
}

async function lifecycle() {
  await t.app.jobs.enqueue(t.app.db, 'email.lifecycle', {});
  await t.app.worker.runUntilIdle();
}

/** A paid subscription that renews by charging a saved card. */
async function payingSubscription(userId: string, priceId = cat.proMonthly.id) {
  const sub = await call(t, admin, 'POST', '/api/admin/subscriptions', { userId, priceId, collectionMethod: 'complimentary' });
  await t.app.db.exec(sql`UPDATE subscriptions SET collection_method = 'charge_automatically' WHERE id = ${sub.id}`);
  return { ...sub, current_period_end: new Date(sub.current_period_end) };
}

describe('welcome email', () => {
  it('welcomes new signups once when switched on, but not people created from support email', async () => {
    await user('before@example.com');
    await t.app.worker.runUntilIdle();
    expect(await emails('account.welcome')).toEqual([]);

    await call(t, admin, 'PATCH', '/api/admin/settings/email', { autoWelcome: true });
    // A CSV import must never mass-mail the people it creates.
    await user('imported@example.com', { registrationSource: 'import' });
    const grace = await user('grace@example.com', { name: 'Grace' });
    await t.app.db.tx((tx) => t.app.events.emit(tx, 'user.created', { userId: grace.id, email: grace.email, source: null }, { userId: grace.id }));
    const inbound = await call(t, admin, 'GET', '/api/admin/support/inbound');
    await t.server.inject({ method: 'POST', url: inbound.url.replace('http://localhost:4000', ''), payload: { from: 'mailer@example.com', subject: 'Help', text: 'Hi' } });
    await t.app.worker.runUntilIdle();

    const welcome = await emails('account.welcome');
    expect(welcome.map((m) => m.to_email)).toEqual(['grace@example.com']);
    // Transactional: it does not depend on marketing consent.
    expect(welcome[0]).toMatchObject({ status: 'sent', category: 'transactional', subject: 'Welcome to Steward' });
    expect(welcome[0].html).toContain('Welcome, Grace!');
  });
});

describe('renewal reminders', () => {
  it('reminds paying subscribers a set number of days before each renewal, once per period', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/email', { autoRenewalReminder: true, renewalReminderDays: 7 });
    const payer = await user('payer@example.com');
    const sub = await payingSubscription(payer.id);
    const comp = await user('comp@example.com');
    await call(t, admin, 'POST', '/api/admin/subscriptions', { userId: comp.id, priceId: cat.proMonthly.id, collectionMethod: 'complimentary' });

    t.clock.set(new Date(sub.current_period_end.getTime() - 8 * DAY));
    await lifecycle();
    expect(await emails('subscription.renewal_reminder')).toEqual([]);
    t.clock.advance(2 * DAY);
    await lifecycle();
    await lifecycle();
    const reminders = await emails('subscription.renewal_reminder');
    expect(reminders.map((m) => m.to_email)).toEqual(['payer@example.com']);
    expect(reminders[0].subject).toBe(`Your Pro subscription renews on ${sub.current_period_end.toISOString().slice(0, 10)}`);
    expect(reminders[0].html).toContain('$20.00');
    expect(reminders[0].category).toBe('billing');

    // The next period gets its own reminder.
    const next = new Date(sub.current_period_end.getTime() + 30 * DAY);
    await t.app.db.exec(sql`UPDATE subscriptions SET current_period_start = current_period_end, current_period_end = ${next} WHERE id = ${sub.id}`);
    t.clock.set(new Date(next.getTime() - 3 * DAY));
    await lifecycle();
    expect(await emails('subscription.renewal_reminder')).toHaveLength(2);

    // Nothing is announced for a subscription that will not renew.
    admin = await adminSession(t);
    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: true, reason: 'leaving' });
    await t.app.db.exec(sql`UPDATE subscriptions SET current_period_end = ${new Date(next.getTime() + 30 * DAY)} WHERE id = ${sub.id}`);
    t.clock.advance(28 * DAY);
    await lifecycle();
    expect(await emails('subscription.renewal_reminder')).toHaveLength(2);
  });
});

describe('expiry notices', () => {
  it('warns before access ends and confirms when a time-limited grant has ended', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/email', { autoExpiryNotices: true, expiryReminderDays: 3 });
    const leaver = await user('leaver@example.com');
    const sub = await payingSubscription(leaver.id);
    await call(t, admin, 'POST', `/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd: true, reason: 'leaving' });
    const trial = await user('trial@example.com');
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: trial.id, productId: cat.pro.id, endsAt: new Date(t.clock.now().getTime() + 10 * DAY).toISOString(), reason: 'extended trial' });
    const extended = await user('extended@example.com');
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: extended.id, productId: cat.pro.id, endsAt: new Date(t.clock.now().getTime() + 10 * DAY).toISOString(), reason: 'promo' });
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: extended.id, productId: cat.pro.id, endsAt: null, reason: 'lifetime deal' });

    await lifecycle();
    expect(await emails('access.expiring')).toEqual([]);

    // Three days before the grant ends: the reminder goes to the trial user only (the other one keeps a lifetime grant).
    t.clock.advance(7 * DAY + HOUR);
    await lifecycle();
    const expiring = await emails('access.expiring');
    expect(expiring.map((m) => m.to_email)).toEqual(['trial@example.com']);
    expect(expiring[0].subject).toBe(`Your access to Pro ends on ${new Date(t.clock.now().getTime() + 3 * DAY - HOUR).toISOString().slice(0, 10)}`);

    t.clock.advance(3 * DAY);
    await lifecycle();
    await lifecycle();
    expect((await emails('access.expired')).map((m) => m.to_email)).toEqual(['trial@example.com']);

    // The cancelled subscription's last period: a reminder three days before it ends.
    t.clock.set(new Date(sub.current_period_end.getTime() - 2 * DAY));
    await lifecycle();
    expect((await emails('access.expiring')).map((m) => m.to_email)).toEqual(['trial@example.com', 'leaver@example.com']);
  });
});

describe('installment plans', () => {
  it('skips the renewal reminder and the goodbye for a paid-off plan, and announces the end of its access', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/email', { autoRenewalReminder: true, renewalReminderDays: 7, autoExpiryNotices: true, expiryReminderDays: 7 });
    const threePayments = await call(t, admin, 'POST', `/api/admin/products/${cat.pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', unitAmount: 1000, paymentCount: 3 });
    const onePayment = await call(t, admin, 'POST', `/api/admin/products/${cat.pro.id}/prices`, { currency: 'USD', type: 'recurring', interval: 'month', unitAmount: 3000, paymentCount: 1 });
    const winback = await call(t, admin, 'POST', '/api/admin/email/sequences', { name: 'Win-back', trigger: 'subscription_ended', steps: [{ delayMinutes: 0, subject: 'Come back', html: '<p>We miss you</p>' }] });
    await call(t, admin, 'POST', `/api/admin/email/sequences/${winback.id}/status`, { status: 'active' });
    const paying = await user('paying@example.com', { marketingConsent: true });
    const ongoing = await payingSubscription(paying.id, threePayments.id);
    const done = await user('done@example.com', { marketingConsent: true });
    const last = await payingSubscription(done.id, onePayment.id);

    // Six days before the period ends: payments are left on one plan (renewal reminder); the other's last one is billed (its access ends).
    t.clock.set(new Date(last.current_period_end.getTime() - 6 * DAY));
    await lifecycle();
    expect((await emails('subscription.renewal_reminder')).map((m) => m.to_email)).toEqual(['paying@example.com']);
    expect((await emails('access.expiring')).map((m) => m.to_email)).toEqual(['done@example.com']);

    // Billing completes the paid-off plan: no "sorry to see you go", no win-back, but the end of access is confirmed.
    await t.app.db.exec(sql`UPDATE subscriptions SET installments_paid = 1 WHERE id = ${last.id}`);
    t.clock.set(new Date(last.current_period_end.getTime() + HOUR));
    await t.app.jobs.enqueue(t.app.db, 'billing.renewals', {});
    await t.app.worker.runUntilIdle();
    expect(await t.app.db.one(sql`SELECT status, cancel_reason FROM subscriptions WHERE id = ${last.id}`)).toEqual({ status: 'canceled', cancel_reason: 'installments_completed' });
    expect(await emails('subscription.canceled')).toEqual([]);
    expect((await emails('access.expired')).map((m) => m.to_email)).toEqual(['done@example.com']);
    expect(await t.app.db.many(sql`SELECT id FROM jobs WHERE type = 'marketing.winback'`)).toEqual([]);
    expect(await t.app.db.many(sql`SELECT id FROM email_sequence_enrollments`)).toEqual([]);

    // An ordinary cancellation still gets all three.
    admin = await adminSession(t);
    await call(t, admin, 'POST', `/api/admin/subscriptions/${ongoing.id}/cancel`, { atPeriodEnd: false, reason: 'too expensive' });
    await t.app.worker.runUntilIdle();
    expect((await emails('subscription.canceled')).map((m) => m.to_email)).toEqual(['paying@example.com']);
    expect(await t.app.db.many(sql`SELECT id FROM jobs WHERE type = 'marketing.winback'`)).toHaveLength(1);
    expect(await t.app.db.many(sql`SELECT id FROM email_sequence_enrollments`)).toHaveLength(1);
  });
});

describe('merged accounts', () => {
  it('sends lifecycle email to the account a duplicate was merged into, never to the duplicate', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/email', { autoRenewalReminder: true, renewalReminderDays: 7 });
    const onboarding = await call(t, admin, 'POST', '/api/admin/email/sequences', {
      name: 'Onboarding',
      trigger: 'signup',
      steps: [{ delayMinutes: 0, subject: 'Welcome', html: '<p>1</p>' }, { delayMinutes: 24 * 60, subject: 'Day two', html: '<p>2</p>' }],
    });
    await call(t, admin, 'POST', `/api/admin/email/sequences/${onboarding.id}/status`, { status: 'active' });
    const news = await call(t, admin, 'POST', '/api/admin/lists', { name: 'News' });
    const keep = await user('keep@example.com', { marketingConsent: true });
    const dup = await user('dup@example.com', { marketingConsent: true });
    await call(t, admin, 'POST', `/api/admin/lists/${news.id}/members`, { userIds: [keep.id, dup.id] });
    const sub = await payingSubscription(dup.id);
    await t.app.worker.runUntilIdle();

    await call(t, admin, 'POST', `/api/admin/users/${keep.id}/merge`, { sourceId: dup.id, confirm: 'MERGE' });
    // Rows both accounts had (the same sequence, the same list) keep the kept account's; nothing stays on the duplicate.
    expect(await t.app.db.many(sql`SELECT user_id FROM email_sequence_enrollments`)).toEqual([{ user_id: keep.id }]);
    expect(await t.app.db.many(sql`SELECT user_id FROM mailing_list_members`)).toEqual([{ user_id: keep.id }]);

    t.clock.set(new Date(sub.current_period_end.getTime() - 6 * DAY));
    await lifecycle();
    await t.app.jobs.enqueue(t.app.db, 'email.sequences', {});
    await t.app.worker.runUntilIdle();
    expect((await emails('subscription.renewal_reminder')).map((m) => m.to_email)).toEqual(['keep@example.com']);
    const dayTwo = await t.app.db.many<{ to_email: string }>(sql`SELECT to_email FROM email_messages WHERE subject = 'Day two'`);
    expect(dayTwo.map((m) => m.to_email)).toEqual(['keep@example.com']);
  });
});

describe('card expiry', () => {
  it('leaves card expiry warnings to billing, so customers are warned once', async () => {
    const gateway = await call(t, admin, 'POST', '/api/admin/gateways', { adapter: 'sandbox', name: 'Sandbox', mode: 'test', isDefault: true, secrets: { webhook_secret: 'sbx' } });
    const soon = await user('soon@example.com');
    const sub = await payingSubscription(soon.id);
    const card = newId('pm');
    await t.app.db.exec(sql.insert('payment_methods', {
      id: card, subject_type: 'user', subject_id: soon.id, gateway_id: gateway.id, gateway_ref: newId('ref'), type: 'card', brand: 'visa', last4: '4242',
      exp_month: 5, exp_year: 2026, is_default: true, created_at: t.clock.now(),
    }, ''));
    await t.app.db.exec(sql`UPDATE subscriptions SET payment_method_id = ${card} WHERE id = ${sub.id}`);
    await call(t, admin, 'PATCH', '/api/admin/settings/email', { autoRenewalReminder: true, autoExpiryNotices: true });
    for (const job of ['email.lifecycle', 'billing.card_expiry', 'email.lifecycle', 'billing.card_expiry']) {
      await t.app.jobs.enqueue(t.app.db, job, {});
      await t.app.worker.runUntilIdle();
    }
    expect((await emails('billing.card_expiring')).map((m) => m.to_email)).toEqual(['soon@example.com']);
  });
});
