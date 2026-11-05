import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, forbidden } from '../../core/errors.js';
import { safeRequest } from '../../core/net.js';
import { MINUTE } from '../../core/clock.js';
import { writeAudit } from '../../core/audit.js';
import { notifyAdmins } from '../iam/notify.js';
import { registerGatewayAdapter, unregisterGatewayAdapters } from '../billing/gateways/registry.js';
import { WebhookSignatureError, type GatewayAdapter, type GatewayContext } from '../billing/gateways/types.js';
import { PLUGIN_HOOKS, hostOf, permits, type PluginManifest } from './manifest.js';
import { registerPushProvider, unregisterPushProviders, type PushProvider } from '../notifications/providers.js';
import { satisfies } from './semver.js';

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  source: 'bundled' | 'upload' | 'marketplace';
  status: 'installed' | 'active' | 'inactive' | 'error';
  manifest: PluginManifest;
  settings: Record<string, unknown>;
  granted_permissions: string[];
  sandboxed: boolean;
  error_count: number;
  last_error: string | null;
}

export interface PluginRoute {
  handlerId: string;
  method: string;
  path: string;
  auth: 'public' | 'admin';
}

interface Runtime {
  invoke(kind: string, handlerId: string | null, args: unknown[], method?: string, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
}

export const RUNNER_PATH = path.resolve(import.meta.dirname, '../../../runtime/plugin-runner.mjs');
const INVOKE_TIMEOUT = 10_000;
const BREAKER_LIMIT = 10;
const BREAKER_WINDOW = 5 * MINUTE;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)))]).finally(() => clearTimeout(timer));
}

/** Runs a trusted (bundled) plugin in the server process. Capabilities are still mediated by the host. */
class InProcessRuntime implements Runtime {
  readonly handlers = new Map<string, any>();
  private mod: any;
  private seq = 0;

  constructor(private readonly host: PluginHost, private readonly plugin: PluginRow, private readonly entry: string) {}

  register(value: unknown): string {
    const id = `h${++this.seq}`;
    this.handlers.set(id, value);
    return id;
  }

  async start(): Promise<void> {
    this.mod = await import(`${pathToFileURL(this.entry).href}?v=${encodeURIComponent(this.plugin.version)}`);
  }

  context() {
    const call = (method: string, ...args: unknown[]) => this.host.handleCall(this.plugin.id, method, args);
    return {
      plugin: { id: this.plugin.id, version: this.plugin.version },
      log: {
        info: (m: string, c?: unknown) => call('log', 'info', m, c ?? null),
        warn: (m: string, c?: unknown) => call('log', 'warn', m, c ?? null),
        error: (m: string, c?: unknown) => call('log', 'error', m, c ?? null),
      },
      settings: { get: () => call('settings.get') },
      secrets: { get: (k: string) => call('secrets.get', k) },
      kv: { get: (k: string) => call('kv.get', k), set: (k: string, v: unknown) => call('kv.set', k, v), delete: (k: string) => call('kv.delete', k) },
      users: { get: (id: string) => call('users.get', id), list: (o?: unknown) => call('users.list', o ?? {}) },
      http: { fetch: (url: string, init?: unknown) => call('http.fetch', url, init ?? {}) },
      events: { on: (pattern: string, fn: unknown) => call('events.on', this.register(fn), pattern) },
      hooks: { filter: (name: string, fn: unknown) => call('hooks.filter', this.register(fn), name) },
      routes: { register: (def: any) => call('routes.register', this.register(def.handler), def.method ?? 'GET', def.path, def.auth ?? 'public') },
      jobs: { schedule: (name: string, sec: number, fn: unknown) => call('jobs.schedule', this.register(fn), name, sec) },
      gateways: {
        register: (adapter: GatewayAdapter) => {
          const methods = ['testConnection', 'createCheckout', 'chargeSaved', 'refund', 'parseWebhook', 'handleReturn'].filter((m) => typeof (adapter as any)[m] === 'function');
          return call('gateways.register', this.register(adapter), { key: adapter.key, name: adapter.name, description: adapter.description, capabilities: adapter.capabilities, secretFields: adapter.secretFields, methods });
        },
      },
      push: {
        register: (provider: PushProvider) => call('push.register', this.register(provider), { key: provider.key, name: provider.name, description: provider.description ?? '', targets: provider.targets }),
      },
    };
  }

  async invoke(kind: string, handlerId: string | null, args: unknown[], method?: string, timeoutMs = INVOKE_TIMEOUT): Promise<unknown> {
    let p: Promise<unknown>;
    if (kind === 'activate') p = Promise.resolve(this.mod.activate?.(this.context()));
    else if (kind === 'deactivate') p = Promise.resolve(this.mod.deactivate?.());
    else if (kind === 'gateway') {
      const adapter = this.handlers.get(handlerId!);
      const [gctx, ...rest] = args as [GatewayContext, ...unknown[]];
      const restrictedFetch = ((url: string, init?: any) => this.host.handleCall(this.plugin.id, 'http.fetch', [url, init ?? {}]).then((r: any) => new Response(r.body, { status: r.status, headers: r.headers }))) as unknown as typeof fetch;
      p = Promise.resolve(adapter[method!]({ ...gctx, fetch: restrictedFetch }, ...rest));
    } else if (kind === 'push') {
      const provider = this.handlers.get(handlerId!);
      p = Promise.resolve(provider[method!](...args));
    } else p = Promise.resolve(this.handlers.get(handlerId!)(...args));
    return withTimeout(p, timeoutMs, `Plugin ${this.plugin.id} ${kind}`);
  }

  async stop(): Promise<void> {
    this.handlers.clear();
  }
}

/** Runs an untrusted plugin in a permission-restricted child process and talks to it over IPC. */
class SandboxRuntime implements Runtime {
  private child?: ChildProcess;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stopping = false;

  constructor(private readonly host: PluginHost, private readonly plugin: PluginRow, private readonly dir: string, private readonly entry: string) {}

  async start(): Promise<void> {
    const env: NodeJS.ProcessEnv = { PLUGIN_ID: this.plugin.id, PLUGIN_VERSION: this.plugin.version, PLUGIN_ENTRY: this.entry, NODE_ENV: process.env.NODE_ENV };
    for (const k of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'PATH']) if (process.env[k]) env[k] = process.env[k];
    const child = fork(RUNNER_PATH, [], {
      execArgv: ['--permission', `--allow-fs-read=${this.dir}`, `--allow-fs-read=${RUNNER_PATH}`, '--max-old-space-size=128', '--disable-warning=ExperimentalWarning'],
      env,
      cwd: this.dir,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    child.stdout?.on('data', (d) => void this.host.log(this.plugin.id, 'info', String(d).slice(0, 2000)));
    child.stderr?.on('data', (d) => void this.host.log(this.plugin.id, 'error', String(d).slice(0, 2000)));
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.on('message', (m: any) => {
          if (m.type === 'ready') resolve();
          else if (m.type === 'fatal') reject(new Error(m.error));
          else void this.onMessage(m);
        });
        child.on('exit', (code) => {
          reject(new Error(`Plugin process exited (${code})`));
          for (const p of this.pending.values()) p.reject(new Error('Plugin process exited'));
          this.pending.clear();
          if (!this.stopping) void this.host.onCrash(this.plugin.id, code);
        });
        child.on('error', reject);
      }),
      15_000,
      `Plugin ${this.plugin.id} startup`,
    );
  }

  private async onMessage(m: any): Promise<void> {
    if (m.type === 'call') {
      try {
        const value = await this.host.handleCall(this.plugin.id, m.method, m.args);
        this.child?.send({ type: 'result', id: m.id, ok: true, value: value === undefined ? null : value });
      } catch (err) {
        this.child?.send({ type: 'result', id: m.id, ok: false, error: (err as Error).message, errorName: (err as Error).name });
      }
    } else if (m.type === 'invokeResult') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(m.errorName === 'WebhookSignatureError' ? new WebhookSignatureError(m.error) : Object.assign(new Error(m.error), { name: m.errorName }));
    }
  }

  invoke(kind: string, handlerId: string | null, args: unknown[], method?: string, timeoutMs = INVOKE_TIMEOUT): Promise<unknown> {
    if (!this.child?.connected) return Promise.reject(new Error(`Plugin ${this.plugin.id} is not running`));
    const id = ++this.seq;
    const sanitized = kind === 'gateway' ? args.map((a, i) => (i === 0 ? { ...(a as object), fetch: undefined, log: undefined } : a)) : args;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.send({ type: 'invoke', id, kind, handlerId, method, args: sanitized });
    });
    return withTimeout(p, timeoutMs, `Plugin ${this.plugin.id} ${kind}`).finally(() => this.pending.delete(id));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // Wait for the process to really exit: on Windows a live child keeps its folder locked.
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    }
  }
}

/**
 * Loads, activates and isolates plugins. Every capability a plugin uses goes
 * through `handleCall`, which checks the permissions an administrator granted.
 */
export class PluginHost {
  private readonly runtimes = new Map<string, Runtime>();
  readonly routes = new Map<string, PluginRoute[]>();
  private readonly failures = new Map<string, number[]>();
  private readonly logBudget = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly app: App) {}

  isRunning(id: string): boolean {
    return this.runtimes.has(id);
  }

  async row(id: string): Promise<PluginRow> {
    const row = await this.app.db.maybe<PluginRow>(sql`SELECT * FROM plugins WHERE id = ${id}`);
    if (!row) throw new AppError(404, 'not_found', 'Plugin not found');
    return row;
  }

  async pathFor(id: string, version: string): Promise<string> {
    const v = await this.app.db.maybe<{ path: string }>(sql`SELECT path FROM plugin_versions WHERE plugin_id = ${id} AND version = ${version}`);
    if (!v) throw new AppError(404, 'not_found', `Plugin ${id}@${version} files are missing`);
    return v.path;
  }

  /** Start the runtime and call the plugin's activate(ctx). Throws (and leaves nothing registered) on failure. */
  async start(id: string): Promise<void> {
    if (this.runtimes.has(id)) return;
    const plugin = await this.row(id);
    const engine = plugin.manifest.engine ?? '*';
    if (!satisfies(this.app.config.version, engine)) throw new AppError(409, 'incompatible_plugin', `${plugin.name} requires platform ${engine}`);
    const dir = await this.pathFor(id, plugin.version);
    const entry = path.resolve(dir, plugin.manifest.main);
    if (!entry.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(entry)) throw new AppError(422, 'plugin_invalid', `Entry file ${plugin.manifest.main} not found`);
    const runtime = plugin.sandboxed && this.app.config.pluginSandbox ? new SandboxRuntime(this, plugin, dir, entry) : new InProcessRuntime(this, plugin, entry);
    this.runtimes.set(id, runtime);
    try {
      await (runtime as InProcessRuntime | SandboxRuntime).start();
      await runtime.invoke('activate', null, [], undefined, 15_000);
    } catch (err) {
      await this.teardown(id);
      throw new AppError(422, 'plugin_activation_failed', `${plugin.name} failed to activate: ${(err as Error).message}`);
    }
  }

  /** Stop a plugin and remove everything it registered. */
  async stop(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      try {
        await runtime.invoke('deactivate', null, [], undefined, 5000);
      } catch {
        /* best effort */
      }
    }
    await this.teardown(id);
  }

  private async teardown(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    this.runtimes.delete(id);
    this.app.events.unsubscribeWhere((sub) => sub.startsWith(`plugin:${id}:`));
    this.app.hooks.removeOwner(`plugin:${id}`);
    unregisterGatewayAdapters(this.app, `plugin:${id}`);
    unregisterPushProviders(this.app, `plugin:${id}`);
    this.routes.delete(id);
    await this.app.db.exec(sql`UPDATE scheduled_tasks SET enabled = FALSE WHERE key LIKE ${`plugin.${id}.%`}`);
    await runtime?.stop();
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) await this.stop(id);
  }

  /** Call into plugin code. Every failure is counted here, once, for the circuit breaker. */
  async invoke(id: string, kind: string, handlerId: string, args: unknown[], method?: string, timeoutMs?: number): Promise<unknown> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Plugin ${id} is not active`);
    try {
      return await runtime.invoke(kind, handlerId, args, method, timeoutMs);
    } catch (err) {
      if (!(err instanceof WebhookSignatureError)) await this.recordFailure(id, err as Error);
      throw err;
    }
  }

  async log(id: string, level: string, message: string, context: unknown = null): Promise<void> {
    const now = Date.now();
    const budget = this.logBudget.get(id);
    if (!budget || now - budget.windowStart > MINUTE) this.logBudget.set(id, { windowStart: now, count: 1 });
    else if (++budget.count > 200) return; // a noisy plugin cannot flood the log table
    await this.app.db.exec(sql.insert('plugin_logs', { id: newId('plog'), plugin_id: id, level, message: message.slice(0, 4000), context: context ?? {}, created_at: this.app.clock.now() }, ''));
  }

  /** Circuit breaker: repeated failures within a window deactivate the plugin. */
  async recordFailure(id: string, err: Error): Promise<void> {
    const now = Date.now();
    const list = (this.failures.get(id) ?? []).filter((t) => now - t < BREAKER_WINDOW);
    list.push(now);
    this.failures.set(id, list);
    await this.app.db.exec(sql`UPDATE plugins SET error_count = error_count + 1, last_error = ${err.message.slice(0, 2000)}, last_error_at = ${this.app.clock.now()} WHERE id = ${id}`);
    await this.log(id, 'error', err.message);
    if (list.length >= BREAKER_LIMIT && this.runtimes.has(id)) {
      this.failures.delete(id);
      await this.disableWithError(id, `Disabled after ${BREAKER_LIMIT} failures in ${BREAKER_WINDOW / MINUTE} minutes: ${err.message}`);
    }
  }

  async onCrash(id: string, code: number | null): Promise<void> {
    if (!this.runtimes.has(id)) return;
    await this.disableWithError(id, `Plugin process exited unexpectedly (code ${code})`);
  }

  private async disableWithError(id: string, message: string): Promise<void> {
    await this.teardown(id);
    await this.app.db.tx(async (tx) => {
      await tx.exec(sql`UPDATE plugins SET status = 'error', last_error = ${message}, last_error_at = ${this.app.clock.now()}, updated_at = ${this.app.clock.now()} WHERE id = ${id}`);
      await writeAudit(tx, this.app, { actor: { type: 'system', id: null, label: 'Plugin host' }, action: 'plugin.auto_disable', targetType: 'plugin', targetId: id, metadata: { message } });
      await notifyAdmins(tx, this.app, { permission: 'plugins.manage.view', type: 'plugin.error', title: `Plugin ${id} was disabled`, body: message, link: '/platform/plugins', severity: 'critical' });
    });
  }

  private require(plugin: PluginRow, permission: string): void {
    if (!permits(plugin.granted_permissions, permission)) {
      throw forbidden(`Plugin ${plugin.id} has not been granted "${permission}"`, 'plugin_permission_denied');
    }
  }

  /** The single gate for every capability a plugin uses. */
  async handleCall(id: string, method: string, args: any[]): Promise<unknown> {
    const plugin = await this.row(id);
    const app = this.app;
    switch (method) {
      case 'log':
        await this.log(id, ['info', 'warn', 'error'].includes(args[0]) ? args[0] : 'info', String(args[1] ?? ''), args[2]);
        return null;
      case 'settings.get':
        this.require(plugin, 'settings');
        return plugin.settings;
      case 'secrets.get':
        this.require(plugin, 'secrets');
        return app.secrets.get(app.db, 'plugin', id, String(args[0]));
      case 'kv.get': {
        this.require(plugin, 'kv');
        const row = await app.db.maybe<{ value: unknown }>(sql`SELECT value FROM plugin_kv WHERE plugin_id = ${id} AND key = ${String(args[0])}`);
        return row?.value ?? null;
      }
      case 'kv.set': {
        this.require(plugin, 'kv');
        const json = JSON.stringify(args[1] ?? null);
        if (json.length > 64 * 1024) throw new Error('kv values are limited to 64KB');
        const count = await app.db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_kv WHERE plugin_id = ${id}`);
        if (count.n >= 1000) throw new Error('kv is limited to 1000 keys per plugin');
        await app.db.exec(sql`
          INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (${id}, ${String(args[0]).slice(0, 200)}, ${json}::jsonb, ${app.clock.now()})
          ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        `);
        return null;
      }
      case 'kv.delete':
        this.require(plugin, 'kv');
        await app.db.exec(sql`DELETE FROM plugin_kv WHERE plugin_id = ${id} AND key = ${String(args[0])}`);
        return null;
      case 'users.get':
        this.require(plugin, 'users:read');
        return app.db.maybe(sql`SELECT id, external_id, email, name, status, country, tags, created_at FROM users WHERE id = ${String(args[0])} AND deleted_at IS NULL`);
      case 'users.list': {
        this.require(plugin, 'users:read');
        const q = typeof args[0]?.q === 'string' ? args[0].q.slice(0, 100) : null;
        const limit = Math.min(100, Number(args[0]?.limit) || 25);
        return app.db.many(sql`
          SELECT id, external_id, email, name, status, created_at FROM users WHERE deleted_at IS NULL
          ${q ? sql`AND (email ILIKE ${`%${q}%`} OR name ILIKE ${`%${q}%`})` : sql.empty} ORDER BY created_at DESC LIMIT ${limit}
        `);
      }
      case 'http.fetch': {
        const url = String(args[0]);
        const host = hostOf(url);
        if (!host || !url.startsWith('https://') && !(app.config.allowPrivateNetwork && url.startsWith('http://'))) throw forbidden('Plugins may only call https:// URLs', 'plugin_permission_denied');
        this.require(plugin, `http:${host}`);
        const init = args[1] ?? {};
        const res = await safeRequest(url, {
          method: init.method ?? 'GET',
          headers: init.headers ?? {},
          body: typeof init.body === 'string' ? init.body : init.body ? JSON.stringify(init.body) : undefined,
          allowPrivate: app.config.allowPrivateNetwork,
          maxResponseBytes: 1024 * 1024,
        });
        return { status: res.status, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])), body: res.body };
      }
      case 'events.on': {
        const [handlerId, pattern] = args as [string, string];
        this.require(plugin, `events:${pattern}`);
        app.events.subscribe(`plugin:${id}:${handlerId}`, pattern, async (event) => {
          await this.invoke(id, 'event', handlerId, [{ id: event.id, type: event.type, data: event.data, userId: event.userId, orgId: event.orgId, createdAt: event.createdAt }]);
        }, { module: 'plugins' });
        return null;
      }
      case 'hooks.filter': {
        const [handlerId, name] = args as [string, string];
        const def = PLUGIN_HOOKS[name];
        if (!def) throw forbidden(`"${name}" is not an extension point available to plugins`, 'plugin_permission_denied');
        this.require(plugin, `hooks:${name}`);
        if (def.requires) this.require(plugin, def.requires);
        app.hooks.addFilter(name, `plugin:${id}`, async (value: unknown, ctx: any) => {
          const safeCtx = { subject: ctx?.subject ?? null, adminId: ctx?.admin?.adminId ?? null, range: ctx?.range ?? null };
          // Hooks sit on request paths: same 2s budget as the hook registry.
          return this.invoke(id, 'hook', handlerId, [value, safeCtx], undefined, 1900);
        }, 50);
        return null;
      }
      case 'routes.register': {
        this.require(plugin, 'routes');
        const [handlerId, method, routePath, auth] = args as [string, string, string, string];
        if (!/^\/[A-Za-z0-9/_-]*$/.test(routePath)) throw new Error('Invalid route path');
        const list = this.routes.get(id) ?? [];
        list.push({ handlerId, method: method.toUpperCase(), path: routePath, auth: auth === 'admin' ? 'admin' : 'public' });
        this.routes.set(id, list);
        return null;
      }
      case 'jobs.schedule': {
        this.require(plugin, 'jobs');
        const [handlerId, name, intervalSeconds] = args as [string, string, number];
        const type = `plugin.${id}.${String(name).replace(/[^a-z0-9_]/gi, '_')}`;
        app.jobs.register(type, async () => {
          await this.invoke(id, 'job', handlerId, []);
        }, { module: 'plugins' });
        app.jobs.schedule({ key: type, jobType: type, intervalSeconds: Math.max(60, Number(intervalSeconds) || 3600), description: `Plugin ${plugin.name}: ${name}`, module: 'plugins' });
        await app.jobs.syncSchedules(app.db);
        await app.db.exec(sql`UPDATE scheduled_tasks SET enabled = TRUE WHERE key = ${type}`);
        return null;
      }
      case 'gateways.register': {
        this.require(plugin, 'gateway');
        const [handlerId, d] = args as [string, any];
        const call = (m: string) => (...a: unknown[]) => this.invoke(id, 'gateway', handlerId, a, m) as Promise<any>;
        const adapter: GatewayAdapter = {
          key: String(d.key),
          name: String(d.name),
          description: String(d.description ?? ''),
          capabilities: d.capabilities,
          secretFields: d.secretFields ?? [],
          testConnection: call('testConnection'),
          createCheckout: call('createCheckout'),
          parseWebhook: call('parseWebhook'),
          ...(d.methods.includes('chargeSaved') ? { chargeSaved: call('chargeSaved') } : {}),
          ...(d.methods.includes('refund') ? { refund: call('refund') } : {}),
          ...(d.methods.includes('handleReturn') ? { handleReturn: call('handleReturn') } : {}),
        };
        registerGatewayAdapter(app, adapter, `plugin:${id}`);
        return null;
      }
      case 'push.register': {
        this.require(plugin, 'push');
        const [handlerId, d] = args as [string, any];
        const targets = d.targets === 'devices' ? 'devices' : 'users';
        registerPushProvider(app, {
          key: String(d.key),
          name: String(d.name),
          description: String(d.description ?? ''),
          targets,
          status: () => this.invoke(id, 'push', handlerId, [], 'status') as Promise<any>,
          send: (message) => this.invoke(id, 'push', handlerId, [message], 'send') as Promise<any>,
        }, `plugin:${id}`);
        return null;
      }
      default:
        throw forbidden(`Unknown plugin capability "${method}"`, 'plugin_permission_denied');
    }
  }
}
