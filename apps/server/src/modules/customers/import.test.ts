import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { parseCsv } from './csv-parse.js';

let t: TestPlatform;
let admin: AdminSession;
beforeEach(async () => {
  t = await createTestPlatform();
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
});

async function upload(csv: string, as = admin, filename = 'customers.csv') {
  const boundary = '----steward-import-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(csv),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.server.inject({
    method: 'POST',
    url: '/api/admin/users/imports',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': as.csrf },
    cookies: { stw_admin: as.token },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const FILE = [
  'Email,First name,Last name,Phone,Tags,Newsletter,Company size,Tier,Time zone',
  'ada@example.com,Ada,Lovelace,,vip|beta,yes,12,Silver,Europe/London',
  'grace@example.com,Grace,Hopper,+1 555 0100,,no,,gold,',
  'not-an-email,X,Y,,,,,,',
  'linus@example.com,Linus,,,,maybe,,,',
  'GRACE@example.com,Duplicate,,,,,,,',
  'margaret@example.com,Margaret,Hamilton,,,,abc,,Mars/Base',
].join('\n');

describe('CSV import', () => {
  it('maps columns, dry-runs with per-row errors and commits as a recorded background job', async () => {
    await call(t, admin, 'POST', '/api/admin/custom-fields', { entity: 'user', key: 'company_size', label: 'Company size', type: 'number' });
    await call(t, admin, 'POST', '/api/admin/custom-fields', { entity: 'user', key: 'plan_tier', label: 'Tier', type: 'select', options: ['gold', 'silver'] });
    const ada = await call(t, admin, 'POST', '/api/admin/users', { email: 'ada@example.com', name: 'Ada', phone: '+44 20 7946 0000', tags: ['early'], customFields: { plan_tier: 'gold' } });

    const uploaded = await upload(FILE);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect(uploaded.body).toMatchObject({ status: 'uploaded', rowCount: 6, delimiter: ',' });
    expect(uploaded.body.sample[0][0]).toBe('ada@example.com');
    const mapping = uploaded.body.suggestedMapping;
    expect(mapping).toMatchObject({
      email: 'Email',
      firstName: 'First name',
      lastName: 'Last name',
      phone: 'Phone',
      tags: 'Tags',
      marketingConsent: 'Newsletter',
      timezone: 'Time zone',
      customFields: { company_size: 'Company size', plan_tier: 'Tier' },
    });

    const early = await t.request({ method: 'POST', url: `/api/admin/users/imports/${uploaded.body.id}/commit`, as: admin });
    expect(early.body.error.code).toBe('import_not_validated');

    const dry = await call(t, admin, 'POST', `/api/admin/users/imports/${uploaded.body.id}/dry-run`, { mapping, options: { updateExisting: true, tags: ['imported'] } });
    expect(dry.summary).toEqual({ created: 1, updated: 1, unchanged: 0, skipped: 0, failed: 4 });
    const errors = Object.fromEntries(dry.errors.map((e: any) => [e.row, e.message]));
    expect(errors[4]).toMatch(/not a valid email/);
    expect(errors[5]).toMatch(/Marketing consent "maybe"/);
    expect(errors[6]).toBe('Duplicate of row 3');
    expect(errors[7]).toMatch(/not a number/);
    expect(errors[7]).toMatch(/not a time zone/);
    // A dry run changes nothing.
    expect((await t.app.db.many(sql`SELECT 1 FROM users`)).length).toBe(1);

    const committed = await call(t, admin, 'POST', `/api/admin/users/imports/${uploaded.body.id}/commit`);
    expect(committed.status).toBe('queued');
    await t.app.worker.runUntilIdle();
    const done = await call(t, admin, 'GET', `/api/admin/users/imports/${uploaded.body.id}`);
    expect(done.status).toBe('completed');
    expect(done.progress).toEqual({ processed: 6, created: 1, updated: 1, unchanged: 0, skipped: 0, failed: 4 });

    // Updated: filled cells applied, the blank phone cell left the stored phone alone, tags added.
    const updated = await call(t, admin, 'GET', `/api/admin/users/${ada.id}`);
    expect(updated).toMatchObject({ name: 'Ada Lovelace', phone: '+44 20 7946 0000', timezone: 'Europe/London', marketing_consent: true, custom_fields: { plan_tier: 'silver', company_size: 12 } });
    expect(updated.tags.sort()).toEqual(['beta', 'early', 'imported', 'vip']);
    // Created: "no" in the consent column never grants consent.
    const grace = await t.app.db.one(sql`SELECT * FROM users WHERE email = 'grace@example.com'`);
    expect(grace).toMatchObject({ name: 'Grace Hopper', phone: '+1 555 0100', marketing_consent: false, registration_source: 'import', tags: ['imported'], custom_fields: { plan_tier: 'gold' } });
    expect((await t.app.db.many(sql`SELECT type FROM events WHERE user_id = ${grace.id}`)).map((e) => e.type)).toContain('user.created');

    const results = await t.request({ url: `/api/admin/users/imports/${uploaded.body.id}/results.csv`, as: admin });
    expect(results.headers['content-type']).toContain('text/csv');
    expect(results.body).toContain(`2,ada@example.com,updated,${ada.id},`);
    expect(results.body).toContain('6,grace@example.com,failed,,Duplicate of row 3');
    const audit = await t.app.db.many(sql`SELECT action FROM audit_logs WHERE target_id = ${uploaded.body.id} ORDER BY seq`);
    expect(audit.map((a) => a.action)).toEqual(['user.import_upload', 'user.import', 'user.import_complete', 'user.import_results_download']);
  });

  it('skips existing customers unless updating is enabled, and needs edit rights to update', async () => {
    await call(t, admin, 'POST', '/api/admin/users', { email: 'kept@example.com', name: 'Kept' });
    const file = await upload('email,name\nkept@example.com,Changed\nnew@example.com,New\n');
    const mapping = { email: 'email', name: 'name' };
    const dry = await call(t, admin, 'POST', `/api/admin/users/imports/${file.body.id}/dry-run`, { mapping });
    expect(dry.summary).toMatchObject({ created: 1, skipped: 1 });
    await call(t, admin, 'POST', `/api/admin/users/imports/${file.body.id}/commit`);
    await t.app.worker.runUntilIdle();
    expect((await t.app.db.one(sql`SELECT name FROM users WHERE email = 'kept@example.com'`)).name).toBe('Kept');
    expect((await t.app.db.many(sql`SELECT result FROM user_import_rows WHERE import_id = ${file.body.id} ORDER BY row_number`)).map((r) => r.result)).toEqual(['skipped', 'created']);

    // A role that may import but not edit cannot overwrite existing customers.
    const role = await call(t, admin, 'POST', '/api/admin/roles', { name: 'Importer', permissions: ['customers.users.import', 'customers.users.view'] });
    const importerSession = await adminSession(t, [role.key]);
    const second = await upload('email,name\nkept@example.com,Changed\n', importerSession);
    const refused = await t.request({ method: 'POST', url: `/api/admin/users/imports/${second.body.id}/dry-run`, as: importerSession, body: { mapping, options: { updateExisting: true } } });
    expect(refused.status).toBe(403);
  });

  it('keeps organization-scoped administrators inside their organizations', async () => {
    const orgA = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Org A' });
    const orgB = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Org B' });
    await call(t, admin, 'POST', '/api/admin/users', { email: 'outside@example.com', orgId: orgB.id });
    const scoped = await adminSession(t, ['admin'], [orgA.id]);
    const file = await upload('email\noutside@example.com\ninside@example.com\n', scoped);
    const noOrg = await t.request({ method: 'POST', url: `/api/admin/users/imports/${file.body.id}/dry-run`, as: scoped, body: { mapping: { email: 'email' } } });
    expect(noOrg.body.error.code).toBe('org_scope');
    const otherOrg = await t.request({ method: 'POST', url: `/api/admin/users/imports/${file.body.id}/dry-run`, as: scoped, body: { mapping: { email: 'email' }, options: { orgId: orgB.id } } });
    expect(otherOrg.body.error.code).toBe('org_scope');
    const dry = await call(t, scoped, 'POST', `/api/admin/users/imports/${file.body.id}/dry-run`, { mapping: { email: 'email' }, options: { orgId: orgA.id, updateExisting: true } });
    expect(dry.summary).toMatchObject({ created: 1, failed: 1 });
    expect(dry.errors[0].message).toMatch(/outside your organizations/);
    await call(t, scoped, 'POST', `/api/admin/users/imports/${file.body.id}/commit`);
    await t.app.worker.runUntilIdle();
    const inside = await t.app.db.one(sql`SELECT id FROM users WHERE email = 'inside@example.com'`);
    expect(await t.app.db.maybe(sql`SELECT 1 FROM memberships WHERE user_id = ${inside.id} AND org_id = ${orgA.id}`)).toBeTruthy();

    // Imports are private to the scoped administrator who uploaded them.
    const other = await upload('email\nx@example.com\n');
    expect((await t.request({ url: `/api/admin/users/imports/${other.body.id}`, as: scoped })).status).toBe(404);
    expect((await t.request({ url: '/api/admin/users/imports', as: scoped })).body.data.map((i: any) => i.id)).toEqual([file.body.id]);
    const support = await adminSession(t, ['support']);
    expect((await upload('email\ny@example.com\n', support)).status).toBe(403);
  });

  it('rejects unreadable files and mappings, and refuses to commit when nothing can be imported', async () => {
    expect((await upload('')).status).toBe(422);
    expect((await upload('email,name\n')).body.error.details[0].message).toMatch(/no data rows/);
    const file = await upload('email,name\nbad-address,Someone\n');
    const missingColumn = await t.request({ method: 'POST', url: `/api/admin/users/imports/${file.body.id}/dry-run`, as: admin, body: { mapping: { email: 'E-mail' } } });
    expect(missingColumn.status).toBe(422);
    await call(t, admin, 'POST', `/api/admin/users/imports/${file.body.id}/dry-run`, { mapping: { email: 'email', name: 'name' } });
    const nothing = await t.request({ method: 'POST', url: `/api/admin/users/imports/${file.body.id}/commit`, as: admin });
    expect(nothing.body.error.code).toBe('import_nothing_to_do');
    expect((await t.request({ method: 'DELETE', url: `/api/admin/users/imports/${file.body.id}`, as: admin })).status).toBe(204);
    expect((await call(t, admin, 'GET', `/api/admin/users/imports/${file.body.id}`)).status).toBe('cancelled');
  });
});

describe('CSV parsing', () => {
  it('handles delimiters, quoting, line breaks, byte order marks and exported formula protection', () => {
    const csv = parseCsv('﻿Email;Name;Note\r\n"a@example.com";"Lovelace; Ada";"line one\nline two"\r\nb@example.com;"Say ""hi""";\'=1+1\r\n\r\n', { maxRows: 10, maxColumns: 10 });
    expect(csv.delimiter).toBe(';');
    expect(csv.headers).toEqual(['Email', 'Name', 'Note']);
    expect(csv.rows).toEqual([
      ['a@example.com', 'Lovelace; Ada', 'line one\nline two'],
      ['b@example.com', 'Say "hi"', '=1+1'],
    ]);
    expect(parseCsv('a\tb\n1\t2', { maxRows: 10, maxColumns: 10 }).delimiter).toBe('\t');
    expect(parseCsv('email,email\nx,y', { maxRows: 10, maxColumns: 10 }).headers).toEqual(['email', 'email (2)']);
    expect(() => parseCsv('email\n1\n2\n3', { maxRows: 2, maxColumns: 10 })).toThrow(/at most 2 rows/);
    expect(() => parseCsv('email\n"unterminated', { maxRows: 2, maxColumns: 10 })).toThrow(/not closed/);
  });
});
