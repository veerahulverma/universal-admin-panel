import { createPlatform, type Platform } from '../app.js';
import { Db } from '../core/db.js';
import { OffsetClock } from '../core/clock.js';
import { MemoryStorage } from '../core/storage.js';
import { sql } from '../core/sql.js';
import { hashPassword } from '../core/crypto.js';
import { newId } from '../core/ids.js';
import { totpAt, totpCounter } from '../core/totp.js';
import { sortModules, type ModuleDefinition } from '../core/modules.js';
import { runMigrations } from '../core/migrate.js';
import { allModules } from '../modules/index.js';

export interface TestPlatform extends Platform {
  clock: OffsetClock;
  request(opts: RequestOpts): Promise<TestResponse>;
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Authenticate as an admin session created by `loginAdmin`. */
  as?: AdminSession;
  /** Authenticate with an API key / customer session bearer token. */
  bearer?: string;
  ip?: string;
}

export interface TestResponse {
  status: number;
  body: any;
  headers: Record<string, any>;
}

export interface AdminSession {
  token: string;
  csrf: string;
  adminId: string;
}

const templates = new Map<string, Promise<import('@electric-sql/pglite').PGlite>>();

/** Migrate once per module set and test file, then hand each test a cheap clone. */
async function freshDb(modules: ModuleDefinition[] | undefined): Promise<Db> {
  if (process.env.TEST_DATABASE_URL) {
    const db = await Db.connect(process.env.TEST_DATABASE_URL);
    await db.script('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    return db;
  }
  const defs = sortModules(modules ?? allModules);
  const key = defs.map((d) => d.id).join(',');
  let template = templates.get(key);
  if (!template) {
    template = (async () => {
      const { PGlite } = await import('@electric-sql/pglite');
      const pg = new PGlite();
      await runMigrations(await Db.fromPglite(pg), defs);
      return pg;
    })();
    templates.set(key, template);
  }
  return Db.fromPglite(await (await template).clone());
}

/**
 * A fully booted platform on an in-memory PGlite database. Set TEST_DATABASE_URL
 * to run the same tests against a real Postgres server.
 */
export async function createTestPlatform(opts: { modules?: ModuleDefinition[]; settings?: Record<string, Record<string, unknown>> } = {}): Promise<TestPlatform> {
  const db = await freshDb(opts.modules);
  const clock = new OffsetClock();
  const platform = await createPlatform({
    db,
    clock,
    storage: new MemoryStorage(),
    modules: opts.modules,
    env: { NODE_ENV: 'test', APP_URL: 'http://localhost:4000', ALLOW_PRIVATE_NETWORK: 'true', PLUGIN_SANDBOX: 'false' },
  });
  for (const [key, value] of Object.entries(opts.settings ?? {})) {
    await db.tx((tx) => platform.app.settings.update(tx, key, value, { type: 'system', id: null }));
  }
  const close = platform.close;
  return {
    ...platform,
    clock,
    async close() {
      await close();
      await db.close();
    },
    async request(o: RequestOpts): Promise<TestResponse> {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      const cookies: Record<string, string> = {};
      if (o.as) {
        cookies.stw_admin = o.as.token;
        if (o.method && o.method !== 'GET') headers['x-csrf-token'] = o.as.csrf;
      }
      if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
      const query = o.query ? Object.fromEntries(Object.entries(o.query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) : undefined;
      const res = await platform.server.inject({
        method: o.method ?? 'GET',
        url: o.url,
        query,
        payload: o.body === undefined ? undefined : JSON.stringify(o.body),
        headers: o.body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        cookies,
        remoteAddress: o.ip ?? '203.0.113.10',
      });
      let body: any = res.body;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        /* non-JSON response */
      }
      return { status: res.statusCode, body, headers: res.headers };
    },
  };
}

/** Insert an admin with the given role keys directly (fast; bypasses the setup flow). */
export async function seedAdmin(
  t: TestPlatform,
  opts: { email?: string; password?: string; roles?: string[]; orgScope?: string[] | null } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = opts.email ?? `${newId('a').slice(-8)}@example.com`;
  const password = opts.password ?? 'Correct-Horse-Battery-9';
  const id = newId('adm');
  const now = t.clock.now();
  await t.app.db.exec(sql.insert('admins', {
    id,
    email,
    name: email.split('@')[0],
    password_hash: await hashPassword(password),
    status: 'active',
    org_scope: opts.orgScope ?? null,
    created_at: now,
    updated_at: now,
  }, ''));
  for (const key of opts.roles ?? ['super_admin']) {
    await t.app.db.exec(sql`INSERT INTO admin_roles (admin_id, role_id) SELECT ${id}, id FROM roles WHERE key = ${key}`);
  }
  return { id, email, password };
}

export async function loginAdmin(t: TestPlatform, creds: { email: string; password: string }): Promise<AdminSession> {
  const res = await t.request({ method: 'POST', url: '/api/admin/auth/login', body: { email: creds.email, password: creds.password, client: 'mobile' } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await t.request({ url: '/api/admin/auth/me', bearer: res.body.token });
  return { token: res.body.token, csrf: res.body.csrfToken, adminId: me.body.admin.id };
}

/** Seed + log in + mark the session freshly re-authenticated (for sensitive routes). */
export async function adminSession(t: TestPlatform, roles: string[] = ['super_admin'], orgScope: string[] | null = null): Promise<AdminSession> {
  const creds = await seedAdmin(t, { roles, orgScope });
  const session = await loginAdmin(t, creds);
  await t.app.db.exec(sql`UPDATE admin_sessions SET reauth_at = ${t.clock.now()} WHERE admin_id = ${session.adminId}`);
  return session;
}

export function currentTotp(secret: string, clock: { now(): Date }): string {
  return totpAt(secret, totpCounter(clock.now().getTime()));
}
