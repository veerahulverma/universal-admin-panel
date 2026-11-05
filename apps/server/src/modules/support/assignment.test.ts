import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';

let t: TestPlatform;
let admin: AdminSession;
let key: string;
let customer: { id: string };
let session: string;

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-03-02T10:00:00Z');
  admin = await adminSession(t);
  key = await apiKey(t, admin);
  customer = await apiUser(t, key, 'customer@example.com');
  const s = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId: customer.id } });
  session = s.body.token;
});
afterEach(async () => {
  await t.close();
});

const FIELDS = [
  { key: 'order_number', label: 'Order number', type: 'text', required: true },
  { key: 'plan', label: 'Plan', type: 'select', options: ['Starter', 'Pro'] },
  { key: 'affected_url', label: 'Affected page', type: 'url' },
  { key: 'seats', label: 'Seats', type: 'number' },
];

async function open(body: Record<string, unknown>, token = session) {
  return t.request({ method: 'POST', url: '/api/client/support/tickets', bearer: token, body: { subject: 'Help', body: 'Something broke.', ...body } });
}

async function notifications(adminId: string) {
  return t.app.db.many<{ type: string; title: string }>(sql`SELECT type, title FROM notifications WHERE recipient_type = 'admin' AND recipient_id = ${adminId} ORDER BY created_at, id`);
}

describe('custom ticket fields', () => {
  it('validates fields defined per category on every channel and stores them with the ticket', async () => {
    const category = await call(t, admin, 'POST', '/api/admin/support/categories', { name: 'Orders', fields: FIELDS });
    const bad = await t.request({ method: 'POST', url: '/api/admin/support/categories', as: admin, body: { name: 'Broken', fields: [{ key: 'x', label: 'X', type: 'select' }, { key: 'x', label: 'Again', type: 'text' }] } });
    expect(bad.status).toBe(422);

    const listed = await t.request({ url: '/api/client/support/categories', bearer: session });
    expect(listed.body.data[0].fields).toEqual([
      { key: 'order_number', label: 'Order number', type: 'text', options: [], required: true, help: '' },
      { key: 'plan', label: 'Plan', type: 'select', options: ['Starter', 'Pro'], required: false, help: '' },
      { key: 'affected_url', label: 'Affected page', type: 'url', options: [], required: false, help: '' },
      { key: 'seats', label: 'Seats', type: 'number', options: [], required: false, help: '' },
    ]);

    const missing = await open({ categoryId: category.id });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details).toEqual([expect.objectContaining({ path: ['customFields', 'order_number'], message: 'Order number is required' })]);
    const invalid = await open({ categoryId: category.id, customFields: { order_number: 'A-1', plan: 'Enterprise', affected_url: 'javascript:alert(1)', seats: 'many', color: 'red' } });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details.map((d: any) => d.path[1]).sort()).toEqual(['affected_url', 'color', 'plan', 'seats']);

    const ok = await open({ categoryId: category.id, customFields: { order_number: ' A-1001 ', plan: 'Pro', affected_url: 'https://app.example.com/billing', seats: '12' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.customFields).toEqual({ order_number: 'A-1001', plan: 'Pro', affected_url: 'https://app.example.com/billing', seats: 12 });

    // Admin and integration API apply the same rules.
    expect((await t.request({ method: 'POST', url: '/api/admin/support/tickets', as: admin, body: { userId: customer.id, subject: 's', body: 'b', categoryId: category.id } })).status).toBe(422);
    const logged = await call(t, admin, 'POST', '/api/admin/support/tickets', { userId: customer.id, subject: 'Phone call', body: 'b', categoryId: category.id, customFields: { order_number: 'A-7' } });
    expect(logged.custom_fields).toEqual({ order_number: 'A-7' });
    expect((await t.request({ method: 'POST', url: '/api/v1/support/tickets', bearer: key, body: { userId: customer.id, subject: 's', body: 'b', categoryId: category.id, customFields: { order_number: 'A-8', seats: 'x' } } })).status).toBe(422);
    expect((await t.request({ method: 'POST', url: '/api/v1/support/tickets', bearer: key, body: { userId: customer.id, subject: 's', body: 'b', customFields: { order_number: 'A-8' } } })).status).toBe(422);

    // Agents see the definitions beside the values and can correct one field at a time.
    const detail = await call(t, admin, 'GET', `/api/admin/support/tickets/${ok.body.id}`);
    expect(detail.category_fields.map((f: any) => f.key)).toEqual(['order_number', 'plan', 'affected_url', 'seats']);
    const patched = await call(t, admin, 'PATCH', `/api/admin/support/tickets/${ok.body.id}`, { customFields: { plan: 'Starter', seats: null } });
    expect(patched.custom_fields).toEqual({ order_number: 'A-1001', plan: 'Starter', affected_url: 'https://app.example.com/billing', seats: null });
    expect((await t.request({ method: 'PATCH', url: `/api/admin/support/tickets/${ok.body.id}`, as: admin, body: { customFields: { order_number: '' } } })).status).toBe(422);
    const view = await t.request({ url: `/api/client/support/tickets/${ok.body.id}`, bearer: session });
    expect(view.body.customFields.plan).toBe('Starter');
  });
});

describe('automatic assignment', () => {
  it('assigns new tickets to the category default agent and notifies the category watchers', async () => {
    const owner = await adminSession(t, ['support']);
    const watcher = await adminSession(t, ['support']);
    const category = await call(t, admin, 'POST', '/api/admin/support/categories', { name: 'Billing', defaultAssigneeId: owner.adminId, watcherIds: [watcher.adminId] });
    expect((await t.request({ method: 'POST', url: '/api/admin/support/categories', as: admin, body: { name: 'X', watcherIds: ['adm_nope'] } })).status).toBe(422);

    const ticket = (await open({ categoryId: category.id, subject: 'Refund please' })).body;
    const row = await t.app.db.one<any>(sql`SELECT assignee_id, watcher_ids FROM tickets WHERE id = ${ticket.id}`);
    expect(row).toEqual({ assignee_id: owner.adminId, watcher_ids: [watcher.adminId] });
    expect(await notifications(owner.adminId)).toEqual([{ type: 'ticket.assigned', title: `Assigned to you: ${ticket.number} · Refund please` }]);
    expect(await notifications(watcher.adminId)).toEqual([{ type: 'ticket.created', title: `New ticket ${ticket.number} · Refund please` }]);
    const event = await t.app.db.one<{ data: any }>(sql`SELECT data FROM events WHERE type = 'ticket.assigned'`);
    expect(event.data).toMatchObject({ ticketId: ticket.id, assigneeId: owner.adminId, previousAssigneeId: null, rule: 'category' });

    await t.request({ method: 'POST', url: `/api/client/support/tickets/${ticket.id}/reply`, bearer: session, body: { body: 'Any news?' } });
    expect((await notifications(watcher.adminId)).map((n) => n.type)).toEqual(['ticket.created', 'ticket.customer_replied']);
    expect((await notifications(owner.adminId)).map((n) => n.type)).toEqual(['ticket.assigned', 'ticket.customer_replied']);

    const watching = await call(t, watcher, 'GET', '/api/admin/support/tickets?view=watching');
    expect(watching.data.map((x: any) => x.id)).toEqual([ticket.id]);

    // Handing the ticket over notifies the new assignee, but not the agent who did it.
    await call(t, owner, 'PATCH', `/api/admin/support/tickets/${ticket.id}`, { assigneeId: watcher.adminId });
    expect((await notifications(watcher.adminId)).map((n) => n.type)).toEqual(['ticket.created', 'ticket.customer_replied', 'ticket.assigned']);
    await call(t, watcher, 'PATCH', `/api/admin/support/tickets/${ticket.id}`, { assigneeId: watcher.adminId });
    expect((await notifications(watcher.adminId)).length).toBe(3);
    const unwatched = await call(t, watcher, 'PATCH', `/api/admin/support/tickets/${ticket.id}`, { watcherIds: [] });
    expect(unwatched.watcher_ids).toEqual([]);
  });

  it('rotates unassigned tickets through the round-robin pool and skips unavailable agents', async () => {
    const [a, b, c] = [await adminSession(t, ['support']), await adminSession(t, ['support']), await adminSession(t, ['support'])];
    const developer = await adminSession(t, ['developer']);
    expect((await t.request({ method: 'PUT', url: '/api/admin/support/assignment', as: admin, body: { roundRobinEnabled: true, agentIds: [a.adminId, developer.adminId] } })).status).toBe(422);
    expect((await t.request({ method: 'PUT', url: '/api/admin/support/assignment', as: admin, body: { roundRobinEnabled: true, agentIds: [] } })).status).toBe(422);
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ method: 'PUT', url: '/api/admin/support/assignment', as: analyst, body: { roundRobinEnabled: true, agentIds: [a.adminId] } })).status).toBe(403);
    await call(t, a, 'PUT', '/api/admin/support/assignment', { roundRobinEnabled: true, agentIds: [a.adminId, b.adminId, c.adminId] });
    expect(await call(t, analyst, 'GET', '/api/admin/support/assignment')).toMatchObject({ roundRobinEnabled: true, agentIds: [a.adminId, b.adminId, c.adminId] });

    const assignee = async (body: Record<string, unknown> = {}) => {
      const res = await open(body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (await t.app.db.one<{ assignee_id: string | null }>(sql`SELECT assignee_id FROM tickets WHERE id = ${res.body.id}`)).assignee_id;
    };
    expect([await assignee(), await assignee(), await assignee(), await assignee()]).toEqual([a.adminId, b.adminId, c.adminId, a.adminId]);

    // A ticket that already has an owner does not use up a turn.
    const owned = await call(t, admin, 'POST', '/api/admin/support/tickets', { userId: customer.id, subject: 'Mine', body: 'b', assigneeId: c.adminId });
    expect(owned.assignee_id).toBe(c.adminId);
    expect(await assignee()).toBe(b.adminId);

    // Category defaults win over the rotation.
    const vip = await call(t, admin, 'POST', '/api/admin/support/categories', { name: 'VIP', defaultAssigneeId: a.adminId });
    expect(await assignee({ categoryId: vip.id })).toBe(a.adminId);

    // Deactivated agents are skipped; an empty usable pool leaves tickets unassigned.
    await t.app.db.exec(sql`UPDATE admins SET status = 'disabled' WHERE id = ${c.adminId}`);
    expect(await assignee()).toBe(a.adminId);
    expect(await assignee()).toBe(b.adminId);
    const events = await t.app.db.many<{ data: any }>(sql`SELECT data FROM events WHERE type = 'ticket.assigned' ORDER BY created_at, id`);
    expect(events.filter((e) => e.data.rule === 'round_robin')).toHaveLength(7);
    await call(t, admin, 'PUT', '/api/admin/support/assignment', { roundRobinEnabled: false, agentIds: [a.adminId] });
    expect(await assignee()).toBeNull();
  });
});
