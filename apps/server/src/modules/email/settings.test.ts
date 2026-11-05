import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { sendSystemEmail } from '../core/mail.js';
import { notifyAdmins } from '../iam/notify.js';
import { allModules } from '../index.js';
import { emailModule } from './module.js';
import { notificationsModule } from '../notifications/module.js';
import { marketingModule } from '../marketing/module.js';
import { queueEmail } from './service.js';

const modules = [...new Set([...allModules, emailModule, notificationsModule, marketingModule])];

let t: TestPlatform;
let admin: AdminSession;
let sent: { options: any; mail: any }[];

beforeEach(async () => {
  t = await createTestPlatform({ modules });
  admin = await adminSession(t);
  sent = [];
  t.app.services['email.smtpTransport'] = (options: any) => ({
    sendMail: async (mail: any) => {
      sent.push({ options, mail });
      return { messageId: `<${sent.length}@smtp.test>` };
    },
    verify: async () => true,
  });
});
afterEach(async () => {
  await t.close();
});

type FetchCall = { url: string; init: RequestInit };
function fakeFetch(handler: (call: FetchCall) => { status?: number; body?: unknown }) {
  const calls: FetchCall[] = [];
  t.app.services['email.fetch'] = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), init };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const settings = (body: Record<string, unknown>) => call(t, admin, 'PATCH', '/api/admin/settings/email', body);
const smtp = (body: Record<string, unknown> = {}) =>
  call(t, admin, 'POST', '/api/admin/email/providers', { type: 'smtp', name: 'Relay', config: { host: 'smtp.acme.test', port: 587, username: 'mailer' }, secrets: { password: 'pw' }, ...body });
const testSend = (body: Record<string, unknown>) => call(t, admin, 'POST', '/api/admin/email/test', { to: 'ada@example.com', ...body });

describe('Settings → Email', () => {
  it('sends from the address and name in settings when the provider has none, and refuses without any sender', async () => {
    await smtp({ fromEmail: '' });
    const none = await testSend({});
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/No sender address/);

    await settings({ adminEmail: 'admin@acme.test', fromName: 'Acme Support' });
    expect((await testSend({})).ok).toBe(true);
    expect(sent.at(-1)!.mail.from).toBe('"Acme Support" <admin@acme.test>');

    await settings({ defaultFromEmail: 'hello@acme.test' });
    await testSend({});
    expect(sent.at(-1)!.mail.from).toBe('"Acme Support" <hello@acme.test>');
  });

  it('turns sending off: messages are recorded as not sent, while test sends still go out', async () => {
    await smtp({ fromEmail: 'hello@acme.test' });
    await settings({ sendingDisabled: true });
    await t.app.db.tx((tx) => sendSystemEmail(t.app, tx, { to: 'ada@example.com', template: 'email.test', data: { message: 'hi' } }));
    await t.app.worker.runUntilIdle();
    const msg = await t.app.db.one<any>(sql`SELECT status, suppression_reason FROM email_messages WHERE metadata->>'test' IS NULL`);
    expect(msg).toEqual({ status: 'suppressed', suppression_reason: 'sending_disabled' });
    expect(sent).toHaveLength(0);
    expect((await testSend({})).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('leaves unsubscribe links out of optional notifications when asked, but never out of marketing email', async () => {
    await settings({ notificationUnsubscribeLinks: false });
    const queue = (category: string) =>
      t.app.db.tx((tx) => queueEmail(tx, t.app, { to: 'ada@example.com', category, content: { subject: `${category} news`, html: '<p>Hello</p>' }, delivery: 'manual' }));
    const usage = await queue('usage');
    const marketing = await queue('marketing');
    const headers = async (id: string) => (await t.app.db.one<{ headers: Record<string, string> }>(sql`SELECT headers FROM email_messages WHERE id = ${id}`)).headers;
    expect(await headers(usage.id)).not.toHaveProperty('List-Unsubscribe');
    expect((await headers(marketing.id))['List-Unsubscribe']).toMatch(/\/u\//);
  });

  it('emails a copy of admin notifications to the admin address and the copy list, once per address', async () => {
    await settings({ adminEmail: 'ops@acme.test', adminNotificationCopies: ['cto@acme.test', 'OPS@acme.test'] });
    await t.app.db.tx((tx) => notifyAdmins(tx, t.app, { permission: 'system.settings.view', type: 'test.alert', title: 'Disk almost full', body: 'Uploads use 95% of storage.', link: '/platform/system' }));
    const copies = await t.app.db.many<any>(sql`SELECT to_email, subject, html, template_key FROM email_messages ORDER BY to_email`);
    expect(copies.map((m) => m.to_email)).toEqual(['cto@acme.test', 'ops@acme.test']);
    expect(copies[0]).toMatchObject({ template_key: 'admin.notification', subject: expect.stringContaining('Disk almost full') });
    expect(copies[0].html).toContain(`${t.app.config.appUrl}/platform/system`);

    await settings({ adminEmail: '', adminNotificationCopies: [] });
    await t.app.db.tx((tx) => notifyAdmins(tx, t.app, { permission: 'system.settings.view', type: 'test.alert', title: 'Second' }));
    expect(await t.app.db.many(sql`SELECT 1 FROM email_messages WHERE subject LIKE '%Second%'`)).toHaveLength(0);
  });

  it('throttles sending to the configured number of emails a minute', async () => {
    await smtp({ fromEmail: 'hello@acme.test' });
    await settings({ throttlePerMinute: 1 });
    for (const to of ['a@example.com', 'b@example.com']) {
      await t.app.db.tx((tx) => sendSystemEmail(t.app, tx, { to, template: 'email.test', data: { message: 'hi' } }));
    }
    await t.app.worker.runUntilIdle();
    expect(sent).toHaveLength(1);
    expect((await t.app.db.many(sql`SELECT 1 FROM email_messages WHERE status = 'queued'`)).length).toBe(1);
    t.clock.advance(61_000);
    await t.app.worker.runUntilIdle();
    expect(sent.map((s) => s.mail.to).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('shows the help address on hosted pages', async () => {
    await settings({ technicalEmail: 'help@acme.test' });
    const page = await t.server.inject({ method: 'GET', url: '/u/not-a-real-token' });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('mailto:help@acme.test');
  });
});

describe('sending methods', () => {
  it('delivers through Amazon SES with its regional SMTP endpoint', async () => {
    const p = await call(t, admin, 'POST', '/api/admin/email/providers', { type: 'ses', name: 'SES', fromEmail: 'hello@acme.test', config: { region: 'eu-west-1', username: 'AKIAEXAMPLE' }, secrets: { password: 'ses-smtp-pass' } });
    expect((await testSend({ providerId: p.id })).ok).toBe(true);
    expect(sent[0].options).toMatchObject({ host: 'email-smtp.eu-west-1.amazonaws.com', port: 587, requireTLS: true, auth: { user: 'AKIAEXAMPLE', pass: 'ses-smtp-pass' } });
    const bad = await t.request({ method: 'POST', url: '/api/admin/email/providers', as: admin, body: { type: 'ses', name: 'SES', config: { region: 'mars-1', username: 'x' }, secrets: { password: 'y' } } });
    expect(bad.status).toBe(422);
  });

  it('delivers through Mailgun (EU region) and Mailjet', async () => {
    const calls = fakeFetch((c) => (c.url.includes('mailgun') ? { body: { id: '<mg-1@mg.acme.test>', message: 'Queued' } } : { body: { Messages: [{ Status: 'success', To: [{ MessageUUID: '1ab23cd4-e567-8901-f234-56789abcdef0', MessageID: 288230376151711744 }] }] } }));
    const mg = await call(t, admin, 'POST', '/api/admin/email/providers', { type: 'mailgun', name: 'Mailgun', fromEmail: 'hello@acme.test', config: { domain: 'mg.acme.test', region: 'eu' }, secrets: { api_key: 'key-123' } });
    const mj = await call(t, admin, 'POST', '/api/admin/email/providers', { type: 'mailjet', name: 'Mailjet', fromEmail: 'hello@acme.test', secrets: { api_key: 'pub', secret_key: 'priv' } });

    const viaMailgun = await testSend({ providerId: mg.id });
    expect(viaMailgun).toMatchObject({ ok: true, providerMessageId: '<mg-1@mg.acme.test>' });
    expect(calls[0].url).toBe('https://api.eu.mailgun.net/v3/mg.acme.test/messages');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('api:key-123').toString('base64')}`);
    const form = calls[0].init.body as URLSearchParams;
    expect(form.get('to')).toBe('ada@example.com');
    expect(form.get('v:steward_message_id')).toBe(viaMailgun.messageId);

    const viaMailjet = await testSend({ providerId: mj.id });
    expect(viaMailjet).toMatchObject({ ok: true, providerMessageId: '1ab23cd4-e567-8901-f234-56789abcdef0' });
    expect(calls[1].url).toBe('https://api.mailjet.com/v3.1/send');
    expect(JSON.parse(String(calls[1].init.body)).Messages[0]).toMatchObject({ From: { Email: 'hello@acme.test' }, To: [{ Email: 'ada@example.com' }], CustomID: viaMailjet.messageId });
  });

  it('updates a provider without resetting the fields it was not sent', async () => {
    const p = await smtp({ fromEmail: 'hello@acme.test', priority: 5, enabled: false });
    await call(t, admin, 'PATCH', `/api/admin/email/providers/${p.id}`, { name: 'Renamed relay' });
    const row = await t.app.db.one<any>(sql`SELECT name, enabled, priority, from_email, config FROM email_providers WHERE id = ${p.id}`);
    expect(row).toMatchObject({ name: 'Renamed relay', enabled: false, priority: 5, from_email: 'hello@acme.test', config: { host: 'smtp.acme.test', username: 'mailer' } });
  });

  it('reuses one SMTP connection pool when connection reuse is on', async () => {
    let created = 0;
    t.app.services['email.smtpTransport'] = (options: any) => {
      created++;
      return {
        sendMail: async (mail: any) => {
          sent.push({ options, mail });
          return { messageId: `<${sent.length}@smtp.test>` };
        },
        verify: async () => true,
      };
    };
    const p = await smtp({ fromEmail: 'hello@acme.test', config: { host: 'smtp.acme.test', port: 587, username: 'mailer', pooled: true, authMethod: 'LOGIN' } });
    await testSend({ providerId: p.id });
    await testSend({ providerId: p.id });
    expect(created).toBe(1);
    expect(sent[0].options).toMatchObject({ pool: true, authMethod: 'LOGIN' });
  });
});
