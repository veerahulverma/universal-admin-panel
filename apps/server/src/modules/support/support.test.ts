import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call } from '../../test/fixtures.js';
import { allModules } from '../index.js';
import { affiliatesModule } from '../affiliates/module.js';
import { supportModule } from './module.js';
import { sql } from '../../core/sql.js';
import { DAY, MINUTE } from '../../core/clock.js';

const modules = [...allModules.filter((m) => m.id !== affiliatesModule.id && m.id !== supportModule.id), affiliatesModule, supportModule];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');

let t: TestPlatform;
let admin: AdminSession;
let key: string;
let user: { id: string };
let session: string;

beforeEach(async () => {
  t = await createTestPlatform({ modules });
  t.clock.set('2026-02-02T10:00:00Z');
  admin = await adminSession(t);
  key = await apiKey(t, admin);
  user = await apiUser(t, key, 'customer@gmail.com');
  session = await customerSession(user.id);
});
afterEach(async () => {
  await t.close();
});

async function customerSession(userId: string, orgId?: string): Promise<string> {
  const res = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId, orgId } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token;
}

async function openTicket(token = session, body: Record<string, unknown> = {}) {
  const res = await t.request({ method: 'POST', url: '/api/client/support/tickets', bearer: token, body: { subject: 'Cannot export CSV', body: 'The export button spins forever.', ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function runSla() {
  await t.app.jobs.enqueue(t.app.db, 'support.sla', {});
  await t.app.worker.runUntilIdle();
}

async function inbound(payload: Record<string, unknown>, token?: string) {
  const url = token ? `/api/public/support/inbound/${token}` : (await call(t, admin, 'GET', '/api/admin/support/inbound')).url.replace('http://localhost:4000', '');
  return t.server.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } });
}

describe('ticket lifecycle', () => {
  it('moves through open, pending, solved and closed with first-response tracking and CSAT', async () => {
    const ticket = await openTicket();
    expect(ticket).toMatchObject({ number: 'T-000001', status: 'open', priority: 'normal', channel: 'web' });

    const queue = await call(t, admin, 'GET', '/api/admin/support/tickets?view=active');
    expect(queue.data.map((x: any) => x.number)).toEqual(['T-000001']);

    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/notes`, { body: 'Customer is on the legacy exporter; check flag.' });
    const replied = await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/reply`, { body: 'Thanks! Could you tell us which browser you use?' });
    expect(replied.ticket.status).toBe('pending');
    expect(replied.ticket.first_responded_at).not.toBeNull();

    const view = await t.request({ url: `/api/client/support/tickets/${ticket.id}`, bearer: session });
    expect(view.body.messages.map((m: any) => m.author_type)).toEqual(['customer', 'admin']);
    expect(JSON.stringify(view.body)).not.toContain('legacy exporter');
    const adminView = await call(t, admin, 'GET', `/api/admin/support/tickets/${ticket.id}`);
    expect(adminView.messages.filter((m: any) => m.is_internal).map((m: any) => m.body)).toEqual(['Customer is on the legacy exporter; check flag.']);

    expect((await t.request({ method: 'POST', url: `/api/client/support/tickets/${ticket.id}/rate`, bearer: session, body: { rating: 5 } })).body.error.code).toBe('ticket_not_solved');
    const reply = await t.request({ method: 'POST', url: `/api/client/support/tickets/${ticket.id}/reply`, bearer: session, body: { body: 'Firefox 140.' } });
    expect(reply.body.status).toBe('open');

    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/reply`, { body: 'Fixed in today\'s release.', status: 'solved' });
    const rated = await t.request({ method: 'POST', url: `/api/client/support/tickets/${ticket.id}/rate`, bearer: session, body: { rating: 5, comment: 'Fast and friendly' } });
    expect(rated.body).toMatchObject({ csatRating: 5, status: 'solved' });
    expect((await t.request({ method: 'POST', url: `/api/client/support/tickets/${ticket.id}/rate`, bearer: session, body: { rating: 1 } })).body.error.code).toBe('already_rated');

    t.clock.advance(8 * DAY);
    await runSla();
    const fresh = await customerSession(user.id);
    const closed = await t.request({ url: `/api/client/support/tickets/${ticket.id}`, bearer: fresh });
    expect(closed.body.status).toBe('closed');
    const late = await t.request({ method: 'POST', url: `/api/client/support/tickets/${ticket.id}/reply`, bearer: fresh, body: { body: 'One more thing' } });
    expect(late.body.error.code).toBe('ticket_closed');

    const types = (await t.app.db.many(sql`SELECT type FROM events WHERE type LIKE 'ticket.%' ORDER BY created_at, id`)).map((e) => e.type);
    expect(types).toEqual(['ticket.created', 'ticket.replied', 'ticket.customer_replied', 'ticket.replied', 'ticket.solved', 'ticket.rated', 'ticket.closed']);
    // Ticket activity shows up on the customer's timeline.
    const timeline = await call(t, admin, 'GET', `/api/admin/users/${user.id}/timeline`);
    expect(timeline.data.some((e: any) => e.title === 'ticket.created')).toBe(true);
  });

  it('expands saved replies with ticket and customer variables', async () => {
    const ticket = await openTicket();
    const saved = await call(t, admin, 'POST', '/api/admin/support/saved-replies', { title: 'Greeting', body: 'Hi {{ customer.email }}, about {{ ticket.number }} — {{ agent.name }} here.' });
    const res = await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/reply`, { savedReplyId: saved.id });
    const msg = await t.app.db.one<{ body: string }>(sql`SELECT body FROM ticket_messages WHERE id = ${res.messageId}`);
    expect(msg.body).toMatch(/^Hi customer@gmail\.com, about T-000001 — .+ here\.$/);
  });

  it('lets your backend open tickets for a user and supports bulk actions', async () => {
    const created = await t.request({ method: 'POST', url: '/api/v1/support/tickets', bearer: key, body: { userId: user.id, subject: 'Billing question', body: 'Can I get an invoice?', priority: 'high', tags: ['billing'] } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ channel: 'api', priority: 'high' });
    const second = await openTicket();
    const agent = await adminSession(t, ['support']);
    const bulk = await call(t, agent, 'POST', '/api/admin/support/tickets/bulk', { ids: [created.body.id, second.id, 'tkt_missing'], action: 'assign', value: agent.adminId });
    expect(bulk).toMatchObject({ succeeded: 2, total: 3 });
    const mine = await call(t, agent, 'GET', '/api/admin/support/tickets?view=mine');
    expect(mine.total).toBe(2);
    const listed = await t.request({ url: '/api/v1/support/tickets', bearer: key, query: { userId: user.id } });
    expect(listed.body.total).toBe(2);
  });
});

describe('SLA', () => {
  it('escalates a missed first response once, bumping priority and alerting agents', async () => {
    const ticket = await openTicket();
    t.clock.advance(479 * MINUTE);
    await runSla();
    expect((await t.app.db.one(sql`SELECT escalated_at FROM tickets WHERE id = ${ticket.id}`)).escalated_at).toBeNull();
    t.clock.advance(2 * MINUTE);
    await runSla();
    const row = await t.app.db.one<any>(sql`SELECT priority, sla_breached_at, escalated_at FROM tickets WHERE id = ${ticket.id}`);
    expect(row.priority).toBe('high');
    expect(row.sla_breached_at).not.toBeNull();
    const system = await t.app.db.many(sql`SELECT body, is_internal FROM ticket_messages WHERE ticket_id = ${ticket.id} AND author_type = 'system'`);
    expect(system).toEqual([expect.objectContaining({ is_internal: true, body: expect.stringMatching(/first response overdue/) })]);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'ticket.sla_breached'`)).n).toBeGreaterThan(0);
    t.clock.advance(DAY);
    await runSla();
    expect((await t.app.db.one(sql`SELECT priority FROM tickets WHERE id = ${ticket.id}`)).priority).toBe('high');
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM events WHERE type = 'ticket.sla_breached'`)).n).toBe(1);
    admin = await adminSession(t);
    const breached = await call(t, admin, 'GET', '/api/admin/support/tickets?view=breached');
    expect(breached.total).toBe(1);
  });

  it('uses category SLAs and does not escalate answered tickets for first response', async () => {
    const cat = await call(t, admin, 'POST', '/api/admin/support/categories', { name: 'Outage', defaultPriority: 'urgent', firstResponseMinutes: 15, resolutionMinutes: 600 });
    const ticket = await openTicket(session, { categoryId: cat.id });
    expect(ticket.priority).toBe('urgent');
    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/reply`, { body: 'Looking into it now.', status: 'open' });
    t.clock.advance(20 * MINUTE);
    await runSla();
    expect((await t.app.db.one(sql`SELECT escalated_at FROM tickets WHERE id = ${ticket.id}`)).escalated_at).toBeNull();
    t.clock.advance(600 * MINUTE);
    await runSla();
    const row = await t.app.db.one<any>(sql`SELECT priority, escalated_at FROM tickets WHERE id = ${ticket.id}`);
    expect(row.escalated_at).not.toBeNull();
    expect(row.priority).toBe('urgent');
  });
});

describe('tenant isolation', () => {
  it('limits org-scoped agents to their organizations', async () => {
    const orgA = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'A' });
    const orgB = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'B' });
    const a = await apiUser(t, key, 'a@corp-a.com');
    const b = await apiUser(t, key, 'b@corp-b.com');
    await call(t, admin, 'POST', `/api/admin/organizations/${orgA.id}/members`, { userId: a.id });
    await call(t, admin, 'POST', `/api/admin/organizations/${orgB.id}/members`, { userId: b.id });
    const ticketA = await openTicket(await customerSession(a.id, orgA.id), { attachments: [{ filename: 'a.png', contentType: 'image/png', data: PNG }] });
    const ticketB = await openTicket(await customerSession(b.id), { attachments: [{ filename: 'b.png', contentType: 'image/png', data: PNG }] });
    const scoped = await adminSession(t, ['support'], [orgA.id]);
    const queue = await call(t, scoped, 'GET', '/api/admin/support/tickets');
    expect(queue.data.map((x: any) => x.id)).toEqual([ticketA.id]);
    expect((await t.request({ url: `/api/admin/support/tickets/${ticketB.id}`, as: scoped })).status).toBe(404);
    expect((await t.request({ method: 'POST', url: `/api/admin/support/tickets/${ticketB.id}/reply`, as: scoped, body: { body: 'hi' } })).status).toBe(404);
    const attB = await t.app.db.one<{ id: string }>(sql`SELECT id FROM ticket_attachments WHERE ticket_id = ${ticketB.id}`);
    expect((await t.request({ url: `/api/admin/support/attachments/${attB.id}`, as: scoped })).status).toBe(404);
    const search = await call(t, scoped, 'GET', '/api/admin/search?q=Cannot');
    expect(search.data.filter((r: any) => r.type === 'ticket').map((r: any) => r.id)).toEqual([ticketA.id]);
    const keys = await t.app.db.many<{ storage_key: string }>(sql`SELECT storage_key FROM files WHERE owner_type = 'ticket' ORDER BY created_at`);
    expect(keys[0].storage_key.startsWith(`org/${orgA.id}/tickets/${ticketA.id}/`)).toBe(true);
    expect(keys[1].storage_key.startsWith(`user/${b.id}/tickets/${ticketB.id}/`)).toBe(true);
  });
});

describe('attachments', () => {
  it('validates type, content and size, and serves files only to authorized viewers', async () => {
    const ticket = await openTicket(session, { attachments: [{ filename: '../../screen shot.png', contentType: 'image/png', data: PNG }] });
    const fake = await t.request({ method: 'POST', url: '/api/client/support/tickets', bearer: session, body: { subject: 's', body: 'b', attachments: [{ filename: 'x.png', contentType: 'image/png', data: Buffer.from('MZ\x90\x00 not a png').toString('base64') }] } });
    expect(fake.status).toBe(422);
    const exe = await t.request({ method: 'POST', url: '/api/client/support/tickets', bearer: session, body: { subject: 's', body: 'b', attachments: [{ filename: 'x.exe', contentType: 'application/x-msdownload', data: PNG }] } });
    expect(exe.status).toBe(422);
    await call(t, admin, 'PATCH', '/api/admin/settings/support', { maxAttachmentBytes: 1024 });
    const big = await t.request({ method: 'POST', url: '/api/client/support/tickets', bearer: session, body: { subject: 's', body: 'b', attachments: [{ filename: 'big.txt', contentType: 'text/plain', data: Buffer.alloc(2048, 'a').toString('base64') }] } });
    expect(big.status).toBe(422);

    const view = await t.request({ url: `/api/client/support/tickets/${ticket.id}`, bearer: session });
    const att = view.body.attachments[0];
    expect(att.filename).toBe('../../screen shot.png');
    const own = await t.server.inject({ method: 'GET', url: `/api/client/support/attachments/${att.id}`, headers: { authorization: `Bearer ${session}` } });
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-disposition']).toMatch(/^attachment;/);
    expect(own.rawPayload.equals(Buffer.from(PNG, 'base64'))).toBe(true);
    const storageKey = (await t.app.db.one<{ storage_key: string }>(sql`SELECT storage_key FROM files LIMIT 1`)).storage_key;
    expect(storageKey).not.toContain('..');

    const other = await apiUser(t, key, 'other@gmail.com');
    const otherSession = await customerSession(other.id);
    expect((await t.request({ url: `/api/client/support/attachments/${att.id}`, bearer: otherSession })).status).toBe(404);
    expect((await t.request({ url: `/api/client/support/tickets/${ticket.id}`, bearer: otherSession })).status).toBe(404);

    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/notes`, { body: 'internal log', attachments: [{ filename: 'log.txt', contentType: 'text/plain', data: Buffer.from('secret internal log').toString('base64') }] });
    const internal = await t.app.db.one<{ id: string }>(sql`SELECT id FROM ticket_attachments WHERE is_internal`);
    expect((await t.request({ url: `/api/client/support/attachments/${internal.id}`, bearer: session })).status).toBe(404);
    const after = await t.request({ url: `/api/client/support/tickets/${ticket.id}`, bearer: session });
    expect(after.body.attachments).toHaveLength(1);
    const adminDl = await t.server.inject({ method: 'GET', url: `/api/admin/support/attachments/${internal.id}`, headers: { authorization: `Bearer ${admin.token}` } });
    expect(adminDl.body).toBe('secret internal log');
  });
});

describe('email to ticket', () => {
  it('creates tickets and users from email, threads replies, ignores duplicates and rejects bad tokens', async () => {
    expect((await inbound({ from: 'x@y.com', subject: 'hi', text: 'x' }, 'inb_wrong')).statusCode).toBe(404);
    const first = await inbound({ from: 'Jane Doe <jane@newco.org>', subject: 'Invoice address wrong', text: 'Please fix our address.', messageId: '<m1@newco.org>' });
    const created = JSON.parse(first.body);
    expect(created).toMatchObject({ created: true, number: 'T-000001' });
    const ticket = await t.app.db.one<any>(sql`SELECT * FROM tickets WHERE id = ${created.ticketId}`);
    expect(ticket).toMatchObject({ requester_email: 'jane@newco.org', requester_name: 'Jane Doe', channel: 'email' });
    const jane = await t.app.db.one<any>(sql`SELECT id, registration_source FROM users WHERE email = 'jane@newco.org'`);
    expect(jane).toMatchObject({ id: ticket.user_id, registration_source: 'support_email' });

    const dup = JSON.parse((await inbound({ from: 'jane@newco.org', subject: 'Invoice address wrong', text: 'Please fix our address.', messageId: '<m1@newco.org>' })).body);
    expect(dup.duplicate).toBe(true);

    const bySubject = JSON.parse((await inbound({ from: 'jane@newco.org', subject: 'Re: [T-000001] Invoice address wrong', text: 'Any update?', messageId: '<m2@newco.org>' })).body);
    expect(bySubject).toMatchObject({ ticketId: created.ticketId, created: false });
    const byHeader = JSON.parse((await inbound({ from: 'jane@newco.org', subject: 'Re: hello', html: '<p>Thanks <b>a lot</b>!</p><script>alert(1)</script>', messageId: '<m3@newco.org>', inReplyTo: '<m1@newco.org>' })).body);
    expect(byHeader.ticketId).toBe(created.ticketId);
    const intruder = JSON.parse((await inbound({ from: 'mallory@evil.io', subject: 'Re: [T-000001] Invoice address wrong', text: 'Send me the invoice', messageId: '<m4@evil.io>' })).body);
    expect(intruder.created).toBe(true);
    expect(intruder.ticketId).not.toBe(created.ticketId);

    const messages = await t.app.db.many<{ body: string }>(sql`SELECT body FROM ticket_messages WHERE ticket_id = ${created.ticketId} ORDER BY created_at`);
    expect(messages.map((m) => m.body)).toEqual(['Please fix our address.', 'Any update?', 'Thanks a lot!']);
    const intruderTicket = await t.app.db.one<{ subject: string }>(sql`SELECT subject FROM tickets WHERE id = ${intruder.ticketId}`);
    expect(intruderTicket.subject).toBe('Invoice address wrong');
  });

  it('rotates the inbound token', async () => {
    const before = await call(t, admin, 'GET', '/api/admin/support/inbound');
    const rotated = await call(t, admin, 'POST', '/api/admin/support/inbound/rotate', {});
    expect(rotated.url).not.toBe(before.url);
    const oldPath = before.url.replace('http://localhost:4000', '');
    expect((await t.server.inject({ method: 'POST', url: oldPath, payload: { from: 'a@b.co', subject: 's', text: 't' } })).statusCode).toBe(404);
  });
});

describe('reports and privacy', () => {
  it('reports volume, response times, SLA breach rate and CSAT', async () => {
    const t1 = await openTicket();
    await openTicket(session, { subject: 'Second' });
    t.clock.advance(30 * MINUTE);
    await call(t, admin, 'POST', `/api/admin/support/tickets/${t1.id}/reply`, { body: 'Solved!', status: 'solved' });
    await t.request({ method: 'POST', url: `/api/client/support/tickets/${t1.id}/rate`, bearer: session, body: { rating: 4 } });
    const report = await call(t, admin, 'GET', '/api/admin/support/reports');
    expect(report.volume).toEqual({ created: 2, solved: 1 });
    expect(report.avgFirstResponseMinutes).toBe(30);
    expect(report.avgResolutionMinutes).toBe(30);
    expect(report.slaBreachRate).toBe(0);
    expect(report.csat).toMatchObject({ responses: 1, average: 4, satisfiedRate: 1 });
    expect(report.backlog).toEqual([{ priority: 'normal', open: 1 }]);
  });

  it('erases requester identity and customer messages on anonymization', async () => {
    const ticket = await openTicket(session, { attachments: [{ filename: 'a.png', contentType: 'image/png', data: PNG }] });
    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/reply`, { body: 'Agent answer stays.' });
    const exported = await call(t, admin, 'GET', `/api/admin/users/${user.id}/export`);
    expect(exported.support.tickets).toHaveLength(1);
    await call(t, admin, 'POST', `/api/admin/users/${user.id}/anonymize`, { confirm: 'ERASE' });
    const row = await t.app.db.one<any>(sql`SELECT requester_email, requester_name FROM tickets WHERE id = ${ticket.id}`);
    expect(row.requester_email).toMatch(/@anonymized\.invalid$/);
    const bodies = (await t.app.db.many<{ author_type: string; body: string }>(sql`SELECT author_type, body FROM ticket_messages WHERE ticket_id = ${ticket.id} ORDER BY created_at`)).map((m) => [m.author_type, m.body]);
    expect(bodies).toEqual([['customer', "[removed at the customer's request]"], ['admin', 'Agent answer stays.']]);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM ticket_attachments WHERE ticket_id = ${ticket.id}`)).n).toBe(0);
  });

  it('enforces support permissions', async () => {
    const ticket = await openTicket();
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: `/api/admin/support/tickets/${ticket.id}`, as: analyst })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: `/api/admin/support/tickets/${ticket.id}/reply`, as: analyst, body: { body: 'x' } })).status).toBe(403);
    const billing = await adminSession(t, ['billing_manager']);
    expect((await t.request({ url: '/api/admin/support/tickets', as: billing })).status).toBe(403);
    const highPrio = await t.request({ method: 'POST', url: '/api/client/support/tickets', bearer: session, body: { subject: 's', body: 'b', priority: 'urgent' } });
    expect(highPrio.body.error.code).toBe('priority_not_allowed');
  });
});

describe('assignment', () => {
  it('lists active administrators who can work tickets, readable by agents without team access', async () => {
    const agent = await adminSession(t, ['support']);
    const developer = await adminSession(t, ['developer']);
    const res = await t.request({ url: '/api/admin/support/agents', as: agent });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining([admin.adminId, agent.adminId]));
    expect(ids).not.toContain(developer.adminId);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['email', 'id', 'name']);
    expect((await t.request({ url: '/api/admin/team', as: agent })).status).toBe(403);
    expect((await t.request({ url: '/api/admin/support/agents', as: developer })).status).toBe(403);
  });
});

describe('support emails', () => {
  it('confirms new tickets and sends public replies with editable templates', async () => {
    const ticket = await openTicket();
    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/reply`, { body: 'We are on it.' });
    await call(t, admin, 'POST', `/api/admin/support/tickets/${ticket.id}/notes`, { body: 'Internal: check the export worker.' });
    await t.app.worker.runUntilIdle();
    const sent = await t.app.db.many<{ template_key: string; subject: string; status: string; last_error: string | null }>(
      sql`SELECT template_key, subject, status, last_error FROM email_messages WHERE to_email = 'customer@gmail.com' AND template_key LIKE 'support.%' ORDER BY created_at`,
    );
    expect(sent.map((m) => m.template_key)).toEqual(['support.ticket_created', 'support.reply']);
    for (const m of sent) expect(m.last_error ?? '').not.toContain('template_not_found');
    expect(sent[0].subject).toContain(ticket.number);
    const templates = await call(t, admin, 'GET', '/api/admin/email/templates', undefined);
    const keys = (templates.data ?? templates).map((x: any) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['support.ticket_created', 'support.reply']));
  });
});
