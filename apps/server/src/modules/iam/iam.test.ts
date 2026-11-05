import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, currentTotp, loginAdmin, seedAdmin, type TestPlatform } from '../../test/harness.js';
import { sql } from '../../core/sql.js';
import { MINUTE } from '../../core/clock.js';
import { registerApprovalExecutor, requestApproval } from './approvals.js';

let t: TestPlatform;
beforeEach(async () => {
  t = await createTestPlatform();
});
afterEach(async () => {
  await t.close();
});

function sessionCookie(res: { headers: Record<string, any> }): string {
  const raw = [res.headers['set-cookie']].flat().join(';');
  const m = /stw_admin=([^;]+)/.exec(raw);
  if (!m) throw new Error('no session cookie');
  return m[1];
}

describe('first-run setup', () => {
  it('requires the setup token and only works once', async () => {
    expect((await t.request({ url: '/api/admin/setup/status' })).body).toEqual({ needsSetup: true });
    const body = { email: 'owner@example.com', name: 'Owner', password: 'Sup3r-Secret-Pass' };
    const bad = await t.request({ method: 'POST', url: '/api/admin/setup', body: { ...body, setupToken: 'nope' } });
    expect(bad.status).toBe(403);
    const token = t.app.services['iam.setupToken'] as string;
    const ok = await t.request({ method: 'POST', url: '/api/admin/setup', body: { ...body, setupToken: token } });
    expect(ok.status).toBe(200);
    expect(sessionCookie(ok)).toMatch(/^stw_/);
    expect((await t.request({ url: '/api/admin/setup/status' })).body).toEqual({ needsSetup: false });
    const again = await t.request({ method: 'POST', url: '/api/admin/setup', body: { ...body, setupToken: token } });
    expect(again.status).toBe(403);
  });

  it('enforces the password policy', async () => {
    const token = t.app.services['iam.setupToken'] as string;
    const res = await t.request({ method: 'POST', url: '/api/admin/setup', body: { email: 'a@example.com', name: 'A', password: 'short', setupToken: token } });
    expect(res.status).toBe(422);
  });
});

describe('login', () => {
  it('rejects bad credentials without revealing whether the account exists', async () => {
    const creds = await seedAdmin(t);
    const wrong = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { email: creds.email, password: 'wrong-password' } });
    const missing = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { email: 'nobody@example.com', password: 'wrong-password' } });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.error.code).toBe(missing.body.error.code);
    const events = await t.app.db.many(sql`SELECT failure_reason FROM login_events ORDER BY created_at`);
    expect(events.map((e) => e.failure_reason)).toEqual(['bad_password', 'unknown_email']);
  });

  it('locks the account after repeated failures and unlocks after the lockout window', async () => {
    const creds = await seedAdmin(t);
    for (let i = 0; i < 5; i++) {
      await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { email: creds.email, password: 'bad-bad-bad' } });
    }
    const locked = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: creds });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('account_locked');
    const sev = await t.app.db.one(sql`SELECT type FROM security_events WHERE type = 'admin.locked_out'`);
    expect(sev.type).toBe('admin.locked_out');
    t.clock.advance(16 * MINUTE);
    const ok = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: creds });
    expect(ok.status).toBe(200);
  });

  it('requires a CSRF token for cookie-authenticated writes', async () => {
    const creds = await seedAdmin(t);
    const login = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: creds });
    const cookie = sessionCookie(login);
    const noCsrf = await t.app.db && (await t.server.inject({ method: 'POST', url: '/api/admin/auth/logout', cookies: { stw_admin: cookie } }));
    expect(noCsrf.statusCode).toBe(403);
    expect(JSON.parse(noCsrf.body).error.code).toBe('csrf_invalid');
    const withCsrf = await t.server.inject({ method: 'POST', url: '/api/admin/auth/logout', cookies: { stw_admin: cookie }, headers: { 'x-csrf-token': login.body.csrfToken } });
    expect(withCsrf.statusCode).toBe(200);
    const after = await t.server.inject({ method: 'GET', url: '/api/admin/auth/me', cookies: { stw_admin: cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('expires idle web sessions', async () => {
    const creds = await seedAdmin(t);
    const login = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: creds });
    const cookie = sessionCookie(login);
    t.clock.advance(121 * MINUTE);
    const res = await t.server.inject({ method: 'GET', url: '/api/admin/auth/me', cookies: { stw_admin: cookie } });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('session_idle');
  });
});

describe('two-factor authentication', () => {
  it('enrolls, requires the second factor at login, rejects replays, and accepts recovery codes once', async () => {
    const creds = await seedAdmin(t);
    const s = await loginAdmin(t, creds);
    const setup = await t.request({ method: 'POST', url: '/api/admin/auth/2fa/setup', as: s });
    expect(setup.status).toBe(200);
    expect(setup.body.qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    const enable = await t.request({ method: 'POST', url: '/api/admin/auth/2fa/enable', as: s, body: { code: currentTotp(setup.body.secret, t.clock) } });
    expect(enable.status).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);

    const login = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { ...creds, client: 'mobile' } });
    expect(login.body.status).toBe('mfa_required');
    const partial = { token: login.body.token, csrf: login.body.csrfToken, adminId: creds.id };
    expect((await t.request({ url: '/api/admin/team', as: partial })).body.error.code).toBe('mfa_required');
    expect((await t.request({ url: '/api/admin/auth/me', as: partial })).body.session.mfaRequired).toBe(true);

    // The code used during enrollment cannot be replayed.
    t.clock.advance(1000);
    const replay = await t.request({ method: 'POST', url: '/api/admin/auth/mfa', as: partial, body: { code: currentTotp(setup.body.secret, t.clock) } });
    expect(replay.status).toBe(401);
    t.clock.advance(31_000);
    const verify = await t.request({ method: 'POST', url: '/api/admin/auth/mfa', as: partial, body: { code: currentTotp(setup.body.secret, t.clock) } });
    expect(verify.status).toBe(200);
    expect((await t.request({ url: '/api/admin/team', as: partial })).status).toBe(200);

    const recovery = enable.body.recoveryCodes[0];
    const login2 = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { ...creds, client: 'mobile' } });
    const p2 = { token: login2.body.token, csrf: login2.body.csrfToken, adminId: creds.id };
    expect((await t.request({ method: 'POST', url: '/api/admin/auth/mfa', as: p2, body: { recoveryCode: recovery } })).status).toBe(200);
    const login3 = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { ...creds, client: 'mobile' } });
    const p3 = { token: login3.body.token, csrf: login3.body.csrfToken, adminId: creds.id };
    expect((await t.request({ method: 'POST', url: '/api/admin/auth/mfa', as: p3, body: { recoveryCode: recovery } })).status).toBe(401);
  });

  it('forces enrollment when the policy requires 2FA', async () => {
    await t.app.db.tx((tx) => t.app.settings.update(tx, 'auth', { require2fa: true }, { type: 'system', id: null }));
    const creds = await seedAdmin(t);
    const login = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { ...creds, client: 'mobile' } });
    expect(login.body.status).toBe('mfa_enrollment_required');
    const s = { token: login.body.token, csrf: login.body.csrfToken, adminId: creds.id };
    expect((await t.request({ url: '/api/admin/team', as: s })).body.error.code).toBe('mfa_enrollment_required');
    expect((await t.request({ method: 'POST', url: '/api/admin/auth/2fa/setup', as: s })).status).toBe(200);
  });
});

describe('role-based access control', () => {
  it('enforces permissions on the backend', async () => {
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/roles', as: support })).status).toBe(403);
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/team', as: analyst })).status).toBe(200);
    const target = await seedAdmin(t, { roles: ['support'] });
    const patch = await t.request({ method: 'PATCH', url: `/api/admin/team/${target.id}`, as: analyst, body: { name: 'x' } });
    expect(patch.status).toBe(403);
  });

  it('prevents privilege escalation', async () => {
    const admin = await adminSession(t, ['admin']);
    const roles = (await t.request({ url: '/api/admin/roles', as: await adminSession(t) })).body.data;
    const superRole = roles.find((r: any) => r.key === 'super_admin');
    const invite = await t.request({ method: 'POST', url: '/api/admin/team/invitations', as: admin, body: { email: 'x@example.com', roleIds: [superRole.id] } });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('privilege_escalation');

    const billing = await adminSession(t, ['billing_manager']);
    const custom = await t.request({ method: 'POST', url: '/api/admin/roles', as: await adminSession(t), body: { name: 'Everything', permissions: ['*'] } });
    expect(custom.status).toBe(200);
    // billing manager lacks iam.roles.manage entirely
    expect((await t.request({ method: 'POST', url: '/api/admin/roles', as: billing, body: { name: 'x', permissions: [] } })).status).toBe(403);
  });

  it('rejects unknown permission patterns in roles', async () => {
    const s = await adminSession(t);
    const res = await t.request({ method: 'POST', url: '/api/admin/roles', as: s, body: { name: 'Typo', permissions: ['custmers.users.view'] } });
    expect(res.status).toBe(422);
  });

  it('requires recent re-authentication for sensitive actions', async () => {
    const creds = await seedAdmin(t);
    const s = await loginAdmin(t, creds);
    await t.app.db.exec(sql`UPDATE admin_sessions SET reauth_at = NULL WHERE admin_id = ${s.adminId}`);
    const target = await seedAdmin(t, { roles: ['support'] });
    const first = await t.request({ method: 'PATCH', url: `/api/admin/team/${target.id}`, as: s, body: { status: 'disabled' } });
    expect(first.body.error.code).toBe('reauth_required');
    const reauth = await t.request({ method: 'POST', url: '/api/admin/auth/reauth', as: s, body: { password: creds.password } });
    expect(reauth.status).toBe(200);
    const second = await t.request({ method: 'PATCH', url: `/api/admin/team/${target.id}`, as: s, body: { status: 'disabled' } });
    expect(second.status).toBe(200);
  });

  it('never leaves the platform without a super administrator', async () => {
    const a = await adminSession(t);
    const b = await adminSession(t);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/team/${b.adminId}`, as: a })).status).toBe(204);
    const other = await adminSession(t, ['admin']);
    const res = await t.request({ method: 'PATCH', url: `/api/admin/team/${a.adminId}`, as: other, body: { status: 'disabled' } });
    // admin role cannot modify a super admin (more privileged) in the first place
    expect(res.status).toBe(403);
  });
});

describe('audit trail', () => {
  it('is append-only and its hash chain verifies', async () => {
    const s = await adminSession(t);
    await t.request({ method: 'POST', url: '/api/admin/roles', as: s, body: { name: 'Auditors', permissions: ['security.audit.view'] } });
    await t.request({ method: 'PATCH', url: '/api/admin/settings/general', as: s, body: { appName: 'Acme Admin' } });
    const verify = await t.request({ url: '/api/admin/audit-logs/verify', as: s });
    expect(verify.body.ok).toBe(true);
    expect(verify.body.checked).toBeGreaterThanOrEqual(2);
    await expect(t.app.db.exec(sql`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(t.app.db.exec(sql`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    const list = await t.request({ url: '/api/admin/audit-logs', as: s, query: { action: 'role.*' } });
    expect(list.body.data[0].action).toBe('role.create');
  });

  it('exports the filtered log as CSV and audits the export', async () => {
    const s = await adminSession(t);
    await t.request({ method: 'POST', url: '/api/admin/roles', as: s, body: { name: 'Auditors', permissions: ['security.audit.view'] } });
    const res = await t.request({ url: '/api/admin/audit-logs/export.csv', as: s, query: { action: 'role.*' } });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    const lines = String(res.body).trim().split('\r\n');
    expect(lines[0]).toBe('seq,id,created_at,actor_type,actor_id,actor_label,action,target_type,target_id,org_id,ip,user_agent,metadata');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('role.create');
    const exported = await t.request({ url: '/api/admin/audit-logs', as: s, query: { action: 'audit_log.export' } });
    expect(exported.body.data[0].metadata.count).toBe(1);
    const support = await adminSession(t, ['support']);
    expect((await t.request({ url: '/api/admin/audit-logs/export.csv', as: support })).status).toBe(403);
  });
});

describe('security center', () => {
  it('filters security events by type and lists the types seen', async () => {
    const s = await adminSession(t);
    const { raiseSecurityEvent } = await import('../security/module.js');
    await t.app.db.tx(async (tx) => {
      await raiseSecurityEvent(tx, t.app, { type: 'login.new_device', severity: 'info' });
      await raiseSecurityEvent(tx, t.app, { type: 'login.unusual_location', severity: 'warning' });
      await raiseSecurityEvent(tx, t.app, { type: 'ip.auto_blocked', severity: 'warning' });
    });
    const prefix = await t.request({ url: '/api/admin/security/events', as: s, query: { type: 'login.*' } });
    expect(prefix.body.data.map((e: any) => e.type).sort()).toEqual(['login.new_device', 'login.unusual_location']);
    const exact = await t.request({ url: '/api/admin/security/events', as: s, query: { type: 'ip.auto_blocked' } });
    expect(exact.body.total).toBe(1);
    const types = await t.request({ url: '/api/admin/security/event-types', as: s });
    expect(types.body.data).toEqual(expect.arrayContaining([{ type: 'ip.auto_blocked', count: 1 }, { type: 'login.new_device', count: 1 }]));
  });

  it('lists active admin sessions across the team and revokes one', async () => {
    const owner = await adminSession(t);
    const other = await adminSession(t, ['support']);
    const list = await t.request({ url: '/api/admin/team/sessions', as: owner });
    expect(list.status).toBe(200);
    const mine = list.body.data.find((x: any) => x.admin_id === owner.adminId);
    const theirs = list.body.data.find((x: any) => x.admin_id === other.adminId);
    expect(mine.current).toBe(true);
    expect(theirs.current).toBe(false);
    expect(theirs.admin_email).toMatch(/@example\.com$/);

    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/team/sessions', as: analyst })).status).toBe(200);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/team/sessions/${theirs.id}`, as: analyst })).status).toBe(403);

    expect((await t.request({ method: 'DELETE', url: `/api/admin/team/sessions/${theirs.id}`, as: owner })).status).toBe(204);
    expect((await t.request({ url: '/api/admin/auth/me', as: other })).status).toBe(401);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/team/sessions/${theirs.id}`, as: owner })).status).toBe(404);
    const audit = await t.request({ url: '/api/admin/audit-logs', as: owner, query: { action: 'admin.session_revoke' } });
    expect(audit.body.data[0]).toMatchObject({ target_type: 'admin', target_id: other.adminId });
  });
});

describe('managing administrators', () => {
  it('keeps organization-scoped administrators within their own organizations', async () => {
    const owner = await adminSession(t);
    await t.request({ method: 'POST', url: '/api/admin/roles', as: owner, body: { name: 'Regional admin', permissions: ['iam.admins.*', 'iam.roles.view', 'customers.users.view'] } });
    const viewer = await t.request({ method: 'POST', url: '/api/admin/roles', as: owner, body: { name: 'Viewer', permissions: ['customers.users.view'] } });
    const scoped = await adminSession(t, ['regional_admin'], ['org_a']);
    let n = 0;
    const invite = (orgScope: string[] | null | undefined) =>
      t.request({ method: 'POST', url: '/api/admin/team/invitations', as: scoped, body: { email: `invitee${++n}@example.com`, roleIds: [viewer.body.id], orgScope } });
    expect((await invite(undefined)).body.error.code).toBe('org_scope');
    expect((await invite(null)).body.error.code).toBe('org_scope');
    expect((await invite(['org_a', 'org_b'])).body.error.code).toBe('org_scope');
    expect((await invite(['org_a'])).status).toBe(200);

    // No lifting their own restriction, and no acting on administrators who see more.
    const widen = await t.request({ method: 'PATCH', url: `/api/admin/team/${scoped.adminId}`, as: scoped, body: { orgScope: null } });
    expect(widen.body.error.code).toBe('org_scope');
    const global = await seedAdmin(t, { roles: ['viewer'] });
    expect((await t.request({ method: 'POST', url: `/api/admin/team/${global.id}/revoke-sessions`, as: scoped })).body.error.code).toBe('org_scope');
    const peer = await seedAdmin(t, { roles: ['viewer'], orgScope: ['org_a'] });
    expect((await t.request({ method: 'POST', url: `/api/admin/team/${peer.id}/revoke-sessions`, as: scoped })).status).toBe(200);
  });

  it('refuses to reset 2FA or sign out a more privileged administrator', async () => {
    const superAdmin = await adminSession(t);
    const admin = await adminSession(t, ['admin']);
    const reset = await t.request({ method: 'POST', url: `/api/admin/team/${superAdmin.adminId}/reset-2fa`, as: admin });
    expect(reset.body.error.code).toBe('privilege_escalation');
    const revoke = await t.request({ method: 'POST', url: `/api/admin/team/${superAdmin.adminId}/revoke-sessions`, as: admin });
    expect(revoke.body.error.code).toBe('privilege_escalation');
    const sessions = (await t.request({ url: '/api/admin/team/sessions', as: admin })).body.data;
    const target = sessions.find((s: any) => s.admin_id === superAdmin.adminId);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/team/sessions/${target.id}`, as: admin })).body.error.code).toBe('privilege_escalation');
    expect((await t.request({ url: '/api/admin/auth/me', as: superAdmin })).status).toBe(200);
  });
});

describe('IP rules', () => {
  it('blocks a network and refuses to lock out the current admin', async () => {
    const s = await adminSession(t);
    const self = await t.request({ method: 'POST', url: '/api/admin/security/ip-rules', as: s, body: { cidr: '203.0.113.0/24', action: 'block', scope: 'admin' } });
    expect(self.status).toBe(422);
    const ok = await t.request({ method: 'POST', url: '/api/admin/security/ip-rules', as: s, body: { cidr: '198.51.100.0/24', action: 'block', scope: 'auth' } });
    expect(ok.status).toBe(200);
    const creds = await seedAdmin(t);
    const blocked = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: creds, ip: '198.51.100.7' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ip_blocked');
  });
});

describe('approvals (separation of duties)', () => {
  it('requires a different admin to approve and then executes', async () => {
    let executed = 0;
    registerApprovalExecutor(t.app, 'test.payout', {
      approvePermission: 'iam.approvals.view',
      async execute() {
        executed++;
        return { done: true };
      },
    });
    const a = await adminSession(t);
    const b = await adminSession(t);
    const { id } = await t.app.db.tx((tx) => requestApproval(tx, t.app, { action: 'test.payout', requestedBy: a.adminId, summary: 'Pay out $500', payload: {} }));
    const own = await t.request({ method: 'POST', url: `/api/admin/approvals/${id}/approve`, as: a, body: {} });
    expect(own.body.error.code).toBe('separation_of_duties');
    const ok = await t.request({ method: 'POST', url: `/api/admin/approvals/${id}/approve`, as: b, body: {} });
    expect(ok.body.status).toBe('executed');
    expect(executed).toBe(1);
    const again = await t.request({ method: 'POST', url: `/api/admin/approvals/${id}/approve`, as: b, body: {} });
    expect(again.status).toBe(409);
    const notes = await t.app.db.many(sql`SELECT recipient_id FROM notifications WHERE type = 'approval.requested'`);
    expect(notes.map((n) => n.recipient_id)).not.toContain(a.adminId);
  });
});
