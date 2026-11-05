import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { allModules } from '../index.js';
import { pluginsModule, installPackage } from './module.js';
import { buildTgz, parseTgz } from './tar.js';
import { satisfies } from './semver.js';
import { permits } from './manifest.js';
import { sql } from '../../core/sql.js';
import { gzipSync } from 'node:zlib';

let t: TestPlatform;
let admin: AdminSession;
let tmp: string;

beforeEach(async () => {
  t = await createTestPlatform({ modules: allModules.some((m) => m.id === 'plugins') ? allModules : [...allModules, pluginsModule] });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stw-plugins-'));
  t.app.config.pluginsDir = tmp;
  t.app.config.pluginSandbox = true;
  admin = await adminSession(t);
});
afterEach(async () => {
  await t.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function pkg(manifest: Record<string, unknown>, code: string) {
  return buildTgz({ 'plugin.json': JSON.stringify({ name: 'Test', version: '1.0.0', main: 'index.js', ...manifest }), 'index.js': code });
}

async function install(manifest: Record<string, unknown>, code: string) {
  return installPackage(t.app, pkg(manifest, code), { source: 'upload', actor: { type: 'admin', id: admin.adminId } });
}

async function activate(id: string) {
  const row = await t.app.db.one<{ manifest: { permissions: string[] } }>(sql`SELECT manifest FROM plugins WHERE id = ${id}`);
  return t.request({ method: 'POST', url: `/api/admin/plugins/${id}/activate`, as: admin, body: { grantPermissions: row.manifest.permissions } });
}

describe('building blocks', () => {
  it('matches semver ranges', () => {
    expect(satisfies('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('0.2.5', '^0.2.1')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('0.1.0', '>=0.1.0 <2.0.0')).toBe(true);
    expect(satisfies('3.0.0', '1.x || >=3')).toBe(true);
  });

  it('checks wildcard permissions', () => {
    expect(permits(['http:*.slack.com'], 'http:hooks.slack.com')).toBe(true);
    expect(permits(['http:*.slack.com'], 'http:slack.com.evil.io')).toBe(false);
    expect(permits(['events:user.*'], 'events:user.created')).toBe(true);
    expect(permits(['events:user.created'], 'events:user.deleted')).toBe(false);
  });

  it('rejects packages that try to escape their folder', () => {
    const evil = buildTgz({ '../../evil.js': 'x' }, '');
    expect(() => parseTgz(evil)).toThrow(/Unsafe path/);
    const header = Buffer.alloc(512);
    header.write('package/link', 0);
    header.write('0000777\0', 100);
    header.write('00000000000\0', 124);
    header.write('2', 156); // symlink
    expect(() => parseTgz(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])))).toThrow(/links are not allowed/);
  });
});

describe('sandboxed plugins', () => {
  const eventPlugin = `
    export async function activate(ctx) {
      await ctx.events.on('user.created', async (e) => { await ctx.kv.set('last', e.data.email); });
      await ctx.routes.register({ method: 'GET', path: '/ping', handler: async (req) => ({ status: 200, body: { pong: true, q: req.query.x ?? null } }) });
    }`;

  it('requires explicit consent to the declared permissions, then runs isolated', async () => {
    await install({ id: 'events-demo', permissions: ['events:user.created', 'kv', 'routes'] }, eventPlugin);
    const partial = await t.request({ method: 'POST', url: '/api/admin/plugins/events-demo/activate', as: admin, body: { grantPermissions: ['kv'] } });
    expect(partial.status).toBe(422);
    expect((await activate('events-demo')).status).toBe(200);

    await t.request({ method: 'POST', url: '/api/admin/users', as: admin, body: { email: 'plugin-saw@example.com' } });
    await t.app.worker.runUntilIdle();
    const kv = await t.app.db.one(sql`SELECT value FROM plugin_kv WHERE plugin_id = 'events-demo' AND key = 'last'`);
    expect(kv.value).toBe('plugin-saw@example.com');
    const ping = await t.request({ url: '/api/plugins/events-demo/ping', query: { x: '1' } });
    expect(ping.body).toEqual({ pong: true, q: '1' });
    expect(ping.headers['content-security-policy']).toContain('sandbox');
  });

  it('cannot read files outside its folder, reach the network directly, or use undeclared capabilities', async () => {
    await install({ id: 'nosy', permissions: ['routes'] }, `
      import fs from 'node:fs';
      export async function activate(ctx) {
        await ctx.routes.register({ method: 'GET', path: '/probe', handler: async () => {
          const out = {};
          try { fs.readFileSync(${JSON.stringify(path.resolve('package.json'))}); out.read = 'ALLOWED'; } catch (e) { out.read = e.code; }
          try { fs.writeFileSync('x.txt', 'x'); out.write = 'ALLOWED'; } catch (e) { out.write = e.code; }
          try { await import('node:net'); out.net = 'ALLOWED'; } catch (e) { out.net = e.code; }
          try { await ctx.secrets.get('x'); out.secrets = 'ALLOWED'; } catch (e) { out.secrets = 'DENIED'; }
          try { await ctx.http.fetch('https://example.com/'); out.http = 'ALLOWED'; } catch (e) { out.http = 'DENIED'; }
          out.env = Object.keys(process.env).filter((k) => /DATABASE|ENCRYPTION|SECRET/.test(k));
          return { status: 200, body: out };
        }});
      }`);
    expect((await activate('nosy')).status).toBe(200);
    const res = await t.request({ url: '/api/plugins/nosy/probe' });
    expect(res.body).toEqual({ read: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', net: 'ERR_PLUGIN_SANDBOX', secrets: 'DENIED', http: 'DENIED', env: [] });
  });

  it('disables a misbehaving plugin with the circuit breaker while the core keeps working', async () => {
    await install({ id: 'flaky', permissions: ['hooks:reports.dashboard.kpis'] }, `
      export async function activate(ctx) { await ctx.hooks.filter('reports.dashboard.kpis', () => { throw new Error('boom'); }); }`);
    expect((await activate('flaky')).status).toBe(200);
    for (let i = 0; i < 10; i++) await t.app.hooks.apply('reports.dashboard.kpis', [], {});
    const row = await t.app.db.one(sql`SELECT status, last_error FROM plugins WHERE id = 'flaky'`);
    expect(row.status).toBe('error');
    expect(row.last_error).toMatch(/Disabled after 10 failures/);
    expect((await t.request({ url: '/api/admin/users', as: admin })).status).toBe(200);
    expect((await t.app.db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'plugin.error'`)).n).toBeGreaterThan(0);
  });

  it('marks a crashed plugin as failed', async () => {
    await install({ id: 'crashy', permissions: ['routes'] }, `
      export async function activate(ctx) { await ctx.routes.register({ method: 'POST', path: '/die', handler: () => process.exit(3) }); }`);
    await activate('crashy');
    await t.request({ method: 'POST', url: '/api/plugins/crashy/die', body: {} });
    await new Promise((r) => setTimeout(r, 300));
    const row = await t.app.db.one(sql`SELECT status FROM plugins WHERE id = 'crashy'`);
    expect(row.status).toBe('error');
  });

  it('updates with automatic rollback and supports manual rollback', async () => {
    await install({ id: 'versioned', permissions: ['routes'] }, `export async function activate(ctx) { await ctx.routes.register({ method: 'GET', path: '/v', handler: () => ({ body: { v: 1 } }) }); }`);
    await activate('versioned');
    await installPackage(t.app, pkg({ id: 'versioned', version: '1.1.0', permissions: ['routes'] }, `export async function activate(ctx) { await ctx.routes.register({ method: 'GET', path: '/v', handler: () => ({ body: { v: 2 } }) }); }`), { source: 'upload', actor: { type: 'system', id: null } });
    expect((await t.request({ url: '/api/plugins/versioned/v' })).body).toEqual({ v: 2 });
    const broken = pkg({ id: 'versioned', version: '1.2.0', permissions: ['routes'] }, `export async function activate() { throw new Error('bad release'); }`);
    await expect(installPackage(t.app, broken, { source: 'upload', actor: { type: 'system', id: null } })).rejects.toThrow(/rolled back to 1.1.0/);
    expect((await t.request({ url: '/api/plugins/versioned/v' })).body).toEqual({ v: 2 });
    await t.request({ method: 'POST', url: '/api/admin/plugins/versioned/rollback', as: admin, body: { version: '1.0.0' } });
    expect((await t.request({ url: '/api/plugins/versioned/v' })).body).toEqual({ v: 1 });
  });

  it('holds updates that request new permissions until re-approved', async () => {
    await install({ id: 'grower', permissions: [] }, `export async function activate() {}`);
    await activate('grower');
    await installPackage(t.app, pkg({ id: 'grower', version: '2.0.0', permissions: ['users:read'] }, `export async function activate() {}`), { source: 'upload', actor: { type: 'system', id: null } });
    const row = await t.app.db.one(sql`SELECT status, last_error FROM plugins WHERE id = 'grower'`);
    expect(row).toMatchObject({ status: 'inactive', last_error: expect.stringContaining('users:read') });
  });

  it('lets a plugin add a payment gateway without changing billing core', async () => {
    const code = fs.readFileSync(path.resolve('../../plugins/gateway-mockpay/index.js'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.resolve('../../plugins/gateway-mockpay/plugin.json'), 'utf8'));
    await installPackage(t.app, pkg({ ...manifest, id: 'mockpay-upload' }, code), { source: 'upload', actor: { type: 'system', id: null } });
    await activate('mockpay-upload');
    const gateways = await t.request({ url: '/api/admin/gateways', as: admin });
    expect(gateways.body.available.map((a: any) => a.key)).toContain('mockpay');
    const created = await t.request({ method: 'POST', url: '/api/admin/gateways', as: admin, body: { adapter: 'mockpay', name: 'MockPay', mode: 'test', secrets: { signing_secret: 'sig' } } });
    expect(created.status).toBe(200);
    const test = await t.request({ method: 'POST', url: `/api/admin/gateways/${created.body.id}/test`, as: admin });
    expect(test.body).toEqual({ ok: true, message: 'MockPay configured' });
    await t.request({ method: 'POST', url: '/api/admin/plugins/mockpay-upload/deactivate', as: admin });
    const after = await t.request({ url: '/api/admin/gateways', as: admin });
    expect(after.body.available.map((a: any) => a.key)).not.toContain('mockpay');
  });

  it('validates settings against the plugin schema and uninstalls cleanly', async () => {
    await install({ id: 'configurable', permissions: ['settings'], settingsSchema: { type: 'object', required: ['color'], properties: { color: { type: 'string', enum: ['red', 'blue'] }, size: { type: 'integer', minimum: 1, maximum: 5 } } } }, `export async function activate() {}`);
    expect((await t.request({ method: 'PUT', url: '/api/admin/plugins/configurable/settings', as: admin, body: { settings: { color: 'green' } } })).status).toBe(422);
    expect((await t.request({ method: 'PUT', url: '/api/admin/plugins/configurable/settings', as: admin, body: { settings: { color: 'red', size: 3 } } })).status).toBe(200);
    expect((await t.request({ method: 'DELETE', url: '/api/admin/plugins/configurable', as: admin })).status).toBe(204);
    expect(await t.app.db.maybe(sql`SELECT 1 FROM plugins WHERE id = 'configurable'`)).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'configurable'))).toBe(false);
  });
});

describe('bundled plugins', () => {
  it('discovers repository plugins and runs them in-process when trusted', async () => {
    const list = await t.request({ url: '/api/admin/plugins', as: admin });
    const ids = list.body.data.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['hello-world', 'slack-notifications', 'gateway-mockpay']));
    await t.request({ method: 'PUT', url: '/api/admin/plugins/hello-world/settings', as: admin, body: { settings: { greeting: 'Hi there' } } });
    expect((await activate('hello-world')).status).toBe(200);
    expect((await t.request({ url: '/api/plugins/hello-world/hello' })).body).toMatchObject({ message: 'Hi there' });
    const page = await t.request({ url: '/api/plugins/hello-world/page' });
    expect(page.status).toBe(401);
    const nav = await t.request({ url: '/api/admin/bootstrap', as: admin });
    expect(nav.body.nav.some((n: any) => n.id === 'plugin-hello-world-overview')).toBe(true);
  });
});
