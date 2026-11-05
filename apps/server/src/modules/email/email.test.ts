import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { hmacSha256 } from '../../core/crypto.js';
import { MINUTE } from '../../core/clock.js';
import { sendSystemEmail } from '../core/mail.js';
import { allModules } from '../index.js';
import { emailModule } from './module.js';
import { notificationsModule } from '../notifications/module.js';
import { marketingModule } from '../marketing/module.js';
import { SYSTEM_TEMPLATES, upsertSystemTemplates } from './templates.js';
import { queueEmail } from './service.js';

const modules = [...new Set([...allModules, emailModule, notificationsModule, marketingModule])];

let t: TestPlatform;
let admin: AdminSession;

beforeEach(async () => {
  t = await createTestPlatform({ modules });
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

type FetchCall = { url: string; init: RequestInit; body: any };

function fakeFetch(handler: (call: FetchCall) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: FetchCall[] = [];
  t.app.services['email.fetch'] = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call = { url: String(url), init, body };
    calls.push(call);
    const r = handler(call);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return calls;
}

async function createUser(body: Record<string, unknown>) {
  return call(t, admin, 'POST', '/api/admin/users', body);
}

async function provider(body: Record<string, unknown>) {
  return call(t, admin, 'POST', '/api/admin/email/providers', { fromEmail: 'hello@acme.test', fromName: 'Acme', ...body });
}

async function send(email: Parameters<typeof sendSystemEmail>[2]) {
  await t.app.db.tx((tx) => sendSystemEmail(t.app, tx, email));
}

async function messages() {
  return t.app.db.many<any>(sql`SELECT * FROM email_messages ORDER BY created_at, id`);
}

describe('templates', () => {
  it('seeds system templates and never overwrites edits', async () => {
    const list = await call(t, admin, 'GET', '/api/admin/email/templates');
    const keys = list.data.map((x: any) => x.key);
    for (const k of ['admin.invitation', 'billing.receipt', 'billing.payment_failed', 'usage.limit_warning', 'checkout.recovery', 'identity.verify_email']) expect(keys).toContain(k);
    const invite = list.data.find((x: any) => x.key === 'admin.invitation');
    await call(t, admin, 'PATCH', `/api/admin/email/templates/${invite.id}`, { subject: 'Join {{appName}} now' });
    const receipt = list.data.find((x: any) => x.key === 'billing.receipt');
    await t.app.db.exec(sql`UPDATE email_templates SET subject = 'stale copy' WHERE id = ${receipt.id}`);

    await upsertSystemTemplates(t.app.db, t.app, SYSTEM_TEMPLATES);
    expect((await t.app.db.one(sql`SELECT subject, edited FROM email_templates WHERE id = ${invite.id}`))).toEqual({ subject: 'Join {{appName}} now', edited: true });
    expect((await t.app.db.one(sql`SELECT subject FROM email_templates WHERE id = ${receipt.id}`)).subject).toBe('Receipt for invoice {{number}}');

    const reset = await call(t, admin, 'POST', `/api/admin/email/templates/${invite.id}/reset`);
    expect(reset).toMatchObject({ subject: '{{inviterName}} invited you to {{appName}}', edited: false });
    expect((await t.request({ method: 'DELETE', url: `/api/admin/email/templates/${invite.id}`, as: admin })).status).toBe(409);
  });

  it('escapes data in HTML, strips header injection from subjects and falls back across locales', async () => {
    const de = await createUser({ email: 'hans@example.com', name: '<script>alert(1)</script>', locale: 'de-AT' });
    const fr = await createUser({ email: 'marie@example.com', name: 'Marie', locale: 'fr' });
    await call(t, admin, 'POST', '/api/admin/email/templates', {
      key: 'identity.verify_email',
      locale: 'de',
      name: 'E-Mail bestätigen',
      category: 'security',
      subject: 'Bitte bestätigen, {{name}}',
      html: '<p>Hallo {{name}}</p><a href="{{link}}">Bestätigen</a>',
    });
    await send({ to: de.email, userId: de.id, template: 'identity.verify_email', data: { name: de.name, link: 'https://app.test/v?a=1&b=2' } });
    await send({ to: fr.email, userId: fr.id, template: 'identity.verify_email', data: { name: 'Marie\r\nBcc: attacker@evil.test', link: 'https://app.test/v' } });
    const [m1, m2] = await messages();
    expect(m1.locale).toBe('de');
    expect(m1.subject).toBe('Bitte bestätigen, <script>alert(1)</script>');
    expect(m1.html).toContain('Hallo &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(m1.html).not.toContain('<script>alert(1)');
    expect(m1.html).toContain('href="https://app.test/v?a=1&amp;b=2"');
    expect(m1.text).toContain('Hallo <script>alert(1)</script>');
    expect(m2.locale).toBe('en');
    expect(m2.subject).not.toMatch(/[\r\n]/);
    expect(m2.subject).toContain('Confirm your email address');
  });

  it('previews drafts, reports missing variables and rejects broken syntax', async () => {
    const ok = await call(t, admin, 'POST', '/api/admin/email/templates/preview', { subject: 'Hi {{recipient.name}}', html: '<p>{{appName}} {{unknownThing}}</p>', data: {} });
    expect(ok.missingVariables).toEqual(['unknownThing']);
    expect(ok.html).toContain('<!doctype html>');
    const bad = await t.request({ method: 'POST', url: '/api/admin/email/templates/preview', as: admin, body: { subject: 'x', html: '{{#if open}}never closed' } });
    expect(bad.status).toBe(422);
    const create = await t.request({ method: 'POST', url: '/api/admin/email/templates', as: admin, body: { key: 'custom.x', name: 'x', category: 'transactional', subject: 'x', html: '{{/if}}' } });
    expect(create.status).toBe(422);
  });

  it('logs a failure instead of breaking the caller when a template is missing', async () => {
    await send({ to: 'x@example.com', template: 'does.not.exist', data: {} });
    const [m] = await messages();
    expect(m).toMatchObject({ status: 'failed', last_error: 'template_not_found' });
  });
});

describe('providers and delivery', () => {
  it('falls back to the next provider by priority', async () => {
    const calls = fakeFetch((c) => (c.url.includes('resend') ? { status: 500, body: { message: 'internal error' } } : { body: { MessageID: 'pm-123', ErrorCode: 0 } }));
    await provider({ type: 'resend', name: 'Resend', priority: 10, secrets: { api_key: 're_secret' } });
    await provider({ type: 'postmark', name: 'Postmark', priority: 5, secrets: { server_token: 'pm_token' } });
    await send({ to: 'ada@example.com', template: 'email.test', data: { message: 'hello' } });
    await t.app.worker.runUntilIdle();
    const [m] = await messages();
    expect(m).toMatchObject({ status: 'sent', provider_type: 'postmark', provider_message_id: 'pm-123' });
    expect(m.last_error).toContain('Resend');
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['api.resend.com', 'api.postmarkapp.com']);
    const pm = calls[1];
    expect((pm.init.headers as Record<string, string>)['x-postmark-server-token']).toBe('pm_token');
    expect(pm.body).toMatchObject({ From: '"Acme" <hello@acme.test>', To: 'ada@example.com', Metadata: { steward_message_id: m.id } });
    const listed = await call(t, admin, 'GET', '/api/admin/email/providers');
    expect(JSON.stringify(listed.data)).not.toContain('pm_token');
  });

  it('retries with backoff, marks the message failed after the last attempt, and can resend', async () => {
    await call(t, admin, 'PATCH', '/api/admin/settings/email', { maxAttempts: 3 });
    let fail = true;
    fakeFetch(() => (fail ? { status: 503, body: { errors: [{ message: 'unavailable' }] } } : { status: 202, headers: { 'x-message-id': 'sg-1' } }));
    await provider({ type: 'sendgrid', name: 'SendGrid', secrets: { api_key: 'SG.key' } });
    await send({ to: 'retry@example.com', template: 'email.test', data: { message: 'x' } });
    await t.app.worker.runUntilIdle();
    expect((await messages())[0]).toMatchObject({ status: 'queued', attempts: 1 });
    for (let i = 0; i < 2; i++) {
      t.clock.advance(5 * MINUTE);
      await t.app.worker.runUntilIdle();
    }
    const [failed] = await messages();
    expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
    expect(failed.last_error).toContain('unavailable');
    fail = false;
    await call(t, admin, 'POST', `/api/admin/email/messages/${failed.id}/resend`);
    await t.app.worker.runUntilIdle();
    expect((await messages())[0]).toMatchObject({ status: 'sent', provider_message_id: 'sg-1' });
  });

  it('sends through SMTP with stored credentials', async () => {
    const sent: any[] = [];
    t.app.services['email.smtpTransport'] = (options: any) => ({
      sendMail: async (mail: any) => {
        sent.push({ options, mail });
        return { messageId: '<abc@smtp.example.com>' };
      },
      verify: async () => true,
    });
    const p = await provider({ type: 'smtp', name: 'Relay', config: { host: 'smtp.example.com', port: 465, secure: true, username: 'mailer' }, secrets: { password: 'p@ss' } });
    expect((await call(t, admin, 'POST', `/api/admin/email/providers/${p.id}/test`)).ok).toBe(true);
    await send({ to: 'smtp@example.com', template: 'email.test', data: { message: 'via smtp' } });
    await t.app.worker.runUntilIdle();
    expect(sent[0].options).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'mailer', pass: 'p@ss' } });
    expect(sent[0].mail).toMatchObject({ from: '"Acme" <hello@acme.test>', to: 'smtp@example.com' });
    expect((await messages())[0]).toMatchObject({ status: 'sent', provider_message_id: '<abc@smtp.example.com>' });
  });

  it('delivers to the development log when no provider is configured and supports test sends', async () => {
    const res = await call(t, admin, 'POST', '/api/admin/email/test', { to: 'me@example.com' });
    expect(res.ok).toBe(true);
    expect((await messages())[0]).toMatchObject({ status: 'sent', provider_type: 'log', template_key: 'email.test' });
    const log = await call(t, admin, 'GET', '/api/admin/email/messages?status=sent');
    expect(log.total).toBe(1);
    expect(log.data[0].html).toBeUndefined();
    const stats = await call(t, admin, 'GET', '/api/admin/email/stats');
    expect(stats.totals.sent).toBe(1);
  });
});

describe('suppression and consent', () => {
  it('requires consent for marketing and lets hard bounces stop everything', async () => {
    const noConsent = await createUser({ email: 'nc@example.com' });
    const consent = await createUser({ email: 'yes@example.com', marketingConsent: true });
    await send({ to: noConsent.email, userId: noConsent.id, template: 'checkout.recovery', data: { productName: 'Pro' } });
    await send({ to: noConsent.email, userId: noConsent.id, template: 'email.test', data: { message: 'transactional' } });
    await send({ to: consent.email, userId: consent.id, template: 'checkout.recovery', data: { productName: 'Pro' } });
    let [m1, m2, m3] = await messages();
    expect(m1).toMatchObject({ status: 'suppressed', suppression_reason: 'no_consent', category: 'marketing' });
    expect(m2.status).toBe('queued');
    expect(m3.status).toBe('queued');
    expect(m3.headers['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:4000\/u\/.+>$/);
    expect(m3.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m2.headers['List-Unsubscribe']).toBeUndefined();

    await call(t, admin, 'POST', '/api/admin/email/suppressions', { email: 'YES@example.com', scope: 'all' });
    await send({ to: consent.email, userId: consent.id, template: 'billing.receipt', data: {} });
    const last = (await messages()).at(-1);
    expect(last).toMatchObject({ status: 'suppressed', suppression_reason: 'manual' });
    // The earlier queued marketing email is re-checked at send time and not delivered.
    await t.app.worker.runUntilIdle();
    [m1, m2, m3] = await messages();
    expect(m2.status).toBe('sent');
    expect(m3.status).toBe('suppressed');
  });

  it('honours one-click unsubscribe links and lets customers resubscribe', async () => {
    const u = await createUser({ email: 'list@example.com', marketingConsent: true });
    await send({ to: u.email, userId: u.id, template: 'checkout.recovery', data: { productName: 'Pro' } });
    const [m] = await messages();
    const url = /<(.+)>/.exec(m.headers['List-Unsubscribe'])![1];
    const path = new URL(url).pathname;
    expect(m.html).toContain(url);
    const confirm = await t.server.inject({ method: 'GET', url: path });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('list@example.com');
    expect((await t.app.db.one(sql`SELECT marketing_consent FROM users WHERE id = ${u.id}`)).marketing_consent).toBe(true);
    const oneClick = await t.server.inject({ method: 'POST', url: path, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(oneClick.statusCode).toBe(200);
    expect((await t.app.db.one(sql`SELECT marketing_consent FROM users WHERE id = ${u.id}`)).marketing_consent).toBe(false);
    expect(await t.app.db.one(sql`SELECT reason, scope FROM email_suppressions WHERE email = 'list@example.com'`)).toEqual({ reason: 'unsubscribe', scope: 'marketing' });
    await send({ to: u.email, userId: u.id, template: 'checkout.recovery', data: {} });
    await send({ to: u.email, userId: u.id, template: 'billing.receipt', data: {} });
    const [, mk, tx] = await messages();
    expect(mk).toMatchObject({ status: 'suppressed', suppression_reason: 'unsubscribe' });
    expect(tx.status).toBe('queued');

    const tampered = await t.server.inject({ method: 'POST', url: path.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a')) });
    expect(tampered.statusCode).toBe(404);

    const key = (await call(t, admin, 'POST', '/api/admin/api-keys', { name: 'k', scopes: ['*'] })).secret;
    const session = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId: u.id } });
    const prefs = await t.request({ url: '/api/client/email-preferences', bearer: session.body.token });
    expect(prefs.body.categories.find((x: any) => x.category === 'marketing').subscribed).toBe(false);
    await t.request({ method: 'PUT', url: '/api/client/email-preferences', bearer: session.body.token, body: { marketing: true } });
    expect(await t.app.db.maybe(sql`SELECT 1 FROM email_suppressions WHERE email = 'list@example.com'`)).toBeNull();
    await send({ to: u.email, userId: u.id, template: 'checkout.recovery', data: {} });
    expect((await messages()).at(-1).status).toBe('queued');
  });
});

describe('unsubscribe links', () => {
  it('work for long addresses (tokens longer than a path parameter allows)', async () => {
    const u = await createUser({ email: 'a.really.long.mailbox.name.for.testing@subdomain.example-company.com', marketingConsent: true });
    await send({ to: u.email, userId: u.id, template: 'checkout.recovery', data: { productName: 'Pro' } });
    const [m] = await messages();
    const path = new URL(/<(.+)>/.exec(m.headers['List-Unsubscribe'])![1]).pathname;
    expect(path.length).toBeGreaterThan(110);
    expect((await t.server.inject({ method: 'GET', url: path })).statusCode).toBe(200);
    expect((await t.server.inject({ method: 'POST', url: path })).statusCode).toBe(200);
    expect((await t.app.db.one(sql`SELECT marketing_consent FROM users WHERE id = ${u.id}`)).marketing_consent).toBe(false);
  });
});

describe('provider feedback webhooks', () => {
  async function post(providerId: string, body: string, headers: Record<string, string>, query = '') {
    return t.server.inject({ method: 'POST', url: `/api/public/email/events/${providerId}${query}`, payload: body, headers: { 'content-type': 'application/json', ...headers } });
  }

  it('applies signed generic and Postmark events', async () => {
    const log = await provider({ type: 'log', name: 'Relay', secrets: {} });
    await t.app.secrets.set(t.app.db, 'email_provider', log.id, 'webhook_secret', 'generic-secret');
    const u = await createUser({ email: 'bounce@example.com' });
    await send({ to: u.email, userId: u.id, template: 'email.test', data: { message: 'x' } });
    await t.app.worker.runUntilIdle();
    const [m] = await messages();
    const body = JSON.stringify({ events: [{ type: 'bounce', email: u.email, messageId: m.id, hard: true, detail: 'mailbox does not exist' }] });
    expect((await post(log.id, body, { 'x-steward-signature': 'forged' })).statusCode).toBe(400);
    expect((await post(log.id, body, { 'x-steward-signature': hmacSha256('generic-secret', body) })).statusCode).toBe(200);
    expect((await t.app.db.one(sql`SELECT status FROM email_messages WHERE id = ${m.id}`)).status).toBe('bounced');
    expect(await t.app.db.one(sql`SELECT reason, scope FROM email_suppressions WHERE email = ${u.email}`)).toEqual({ reason: 'hard_bounce', scope: 'all' });

    const pm = await provider({ type: 'postmark', name: 'Postmark', secrets: { server_token: 't', webhook_secret: 'pm-hook' } });
    const complaint = JSON.stringify({ RecordType: 'SpamComplaint', Email: 'angry@example.com', MessageID: 'nope' });
    expect((await post(pm.id, complaint, {}, '?token=wrong')).statusCode).toBe(400);
    expect((await post(pm.id, complaint, {}, '?token=pm-hook')).statusCode).toBe(200);
    expect((await t.app.db.one(sql`SELECT reason FROM email_suppressions WHERE email = 'angry@example.com'`)).reason).toBe('complaint');
  });

  it('verifies Resend (Svix) and SendGrid (ECDSA) signatures', async () => {
    fakeFetch(() => ({ body: { id: 're_msg_1' } }));
    const secretBytes = randomBytes(24);
    const resend = await provider({ type: 'resend', name: 'Resend', secrets: { api_key: 're_x', webhook_secret: `whsec_${secretBytes.toString('base64')}` } });
    await send({ to: 'svix@example.com', template: 'email.test', data: { message: 'x' } });
    await t.app.worker.runUntilIdle();
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_msg_1', to: ['svix@example.com'], bounce: { type: 'Permanent', message: 'no such user' } } });
    const ts = String(Math.floor(t.clock.now().getTime() / 1000));
    const sig = createHmac('sha256', secretBytes).update(`evt_1.${ts}.${body}`).digest('base64');
    expect((await post(resend.id, body, { 'svix-id': 'evt_1', 'svix-timestamp': ts, 'svix-signature': 'v1,AAAA' })).statusCode).toBe(400);
    expect((await post(resend.id, body, { 'svix-id': 'evt_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` })).statusCode).toBe(200);
    expect((await messages())[0].status).toBe('bounced');

    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sg = await provider({ type: 'sendgrid', name: 'SendGrid', secrets: { api_key: 'SG.x', webhook_public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } });
    const events = JSON.stringify([{ email: 'spam@example.com', event: 'spamreport', sg_message_id: 'abc.filter0001' }]);
    const sgTs = String(Math.floor(Date.now() / 1000));
    const sgSig = sign('sha256', Buffer.from(sgTs + events), privateKey).toString('base64');
    expect((await post(sg.id, events, { 'x-twilio-email-event-webhook-signature': sgSig, 'x-twilio-email-event-webhook-timestamp': String(Number(sgTs) + 1) })).statusCode).toBe(400);
    expect((await post(sg.id, events, { 'x-twilio-email-event-webhook-signature': sgSig, 'x-twilio-email-event-webhook-timestamp': sgTs })).statusCode).toBe(200);
    expect((await t.app.db.one(sql`SELECT reason FROM email_suppressions WHERE email = 'spam@example.com'`)).reason).toBe('complaint');
  });
});

describe('lifecycle automations and integrations', () => {
  it('emails usage alerts to the subject and respects the automation toggle', async () => {
    const u = await createUser({ email: 'quota@example.com' });
    await t.app.db.tx((tx) => t.app.events.emit(tx, 'usage.limit_warning', { subjectType: 'user', subjectId: u.id, meter: 'api_calls', feature: 'api_calls', used: 80, limit: 100, percent: 80, periodEnd: '2026-06-01T00:00:00Z' }, { userId: u.id }));
    await t.app.worker.runUntilIdle();
    const usageMessages = async () => (await messages()).filter((m) => m.template_key?.startsWith('usage.'));
    const [m] = await usageMessages();
    expect(m).toMatchObject({ template_key: 'usage.limit_warning', to_email: 'quota@example.com', status: 'sent' });
    expect(m.subject).toBe("You've used 80% of your api_calls");
    // The marketing upsell flow also reacts, but without consent its email is suppressed.
    expect((await messages()).find((x) => x.template_key === 'marketing.upsell')).toMatchObject({ status: 'suppressed', suppression_reason: 'no_consent' });
    await call(t, admin, 'PATCH', '/api/admin/settings/email', { autoUsageAlerts: false });
    await t.app.db.tx((tx) => t.app.events.emit(tx, 'usage.limit_reached', { subjectType: 'user', subjectId: u.id, meter: 'api_calls', used: 100, limit: 100 }, { userId: u.id }));
    await t.app.worker.runUntilIdle();
    expect(await usageMessages()).toHaveLength(1);
  });

  it('sends a receipt when an invoice is paid and a dunning email when payment fails', async () => {
    const u = await createUser({ email: 'payer@example.com' });
    const inv = await call(t, admin, 'POST', '/api/admin/invoices', { userId: u.id, currency: 'USD', lines: [{ description: 'Setup', unitAmount: 5000 }] });
    await t.app.db.tx((tx) => t.app.events.emit(tx, 'invoice.payment_failed', { invoiceId: inv.id, number: inv.number, attempt: 1, nextAttemptAt: '2026-01-05T00:00:00Z', message: 'card declined' }, { userId: u.id }));
    await call(t, admin, 'POST', `/api/admin/invoices/${inv.id}/mark-paid`, { method: 'bank_transfer', reference: 'W1' });
    await t.app.worker.runUntilIdle();
    const byTemplate = Object.fromEntries((await messages()).map((m) => [m.template_key, m]));
    expect(byTemplate['billing.payment_failed'].html).toContain(`/pay/invoice/${inv.id}?token=`);
    expect(byTemplate['billing.payment_failed'].subject).toContain(inv.number);
    expect(byTemplate['billing.receipt'].html).toContain('$50.00');
    expect(byTemplate['billing.receipt'].to_email).toBe('payer@example.com');
  });

  it('is used by existing modules through sendSystemEmail', async () => {
    const roles = (await call(t, admin, 'GET', '/api/admin/roles')).data;
    const invite = await call(t, admin, 'POST', '/api/admin/team/invitations', { email: 'newbie@example.com', roleIds: [roles.find((r: any) => r.key === 'support').id] });
    expect(invite.emailed).toBe(true);
    const [m] = await messages();
    expect(m).toMatchObject({ template_key: 'admin.invitation', to_email: 'newbie@example.com', category: 'security' });
    expect(m.html).toContain(invite.inviteLink.replace(/&/g, '&amp;'));
  });

  it('sends nothing when the business transaction rolls back', async () => {
    await expect(
      t.app.db.tx(async (tx) => {
        await queueEmail(tx, t.app, { to: 'ghost@example.com', templateKey: 'email.test', data: {} });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await messages()).toHaveLength(0);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM jobs WHERE type = 'email.deliver'`)).n).toBe(0);
  });
});
