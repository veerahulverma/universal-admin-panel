// @ts-check
/** @typedef {import('./index.js').PluginPermission} PluginPermission */

/** @param {import('./index.js').PluginModule} plugin */
export function definePlugin(plugin) {
  return plugin;
}

/**
 * Mirror of the host's permission check (see apps/server/src/modules/plugins/manifest.ts).
 * @param {string[]} granted
 * @param {string} needed
 */
function permits(granted, needed) {
  if (granted.includes(needed)) return true;
  if (needed.startsWith('http:')) {
    const host = needed.slice(5);
    return granted.some((g) => g.startsWith('http:*.') && (host.endsWith(g.slice(6)) || host === g.slice(7)));
  }
  if (needed.startsWith('events:')) {
    const pattern = needed.slice(7);
    return granted.some((g) => {
      if (!g.startsWith('events:')) return false;
      const p = g.slice(7);
      if (p === '*') return true;
      if (p.endsWith('.*')) return pattern === p || pattern.startsWith(p.slice(0, -1));
      return p === pattern;
    });
  }
  return false;
}

/** @param {Parameters<typeof import('./index.js').createMockContext>[0]} opts */
export function createMockContext(opts) {
  const granted = /** @type {string[]} */ (opts.permissions);
  const need = (/** @type {string} */ p) => {
    if (!permits(granted, p)) throw new Error(`Plugin has not been granted "${p}"`);
  };
  const registered = { events: new Map(), hooks: new Map(), routes: new Map(), jobs: new Map(), gateways: /** @type {any[]} */ ([]), push: /** @type {any[]} */ ([]) };
  /** @type {{ level: string; message: string; context?: unknown }[]} */
  const logs = [];
  const kvStore = new Map();
  const users = opts.users ?? [];
  const log = (/** @type {string} */ level) => async (/** @type {string} */ message, /** @type {unknown} */ context) => {
    logs.push({ level, message, context });
  };

  /** @type {import('./index.js').MockContext} */
  const ctx = {
    plugin: { id: opts.id ?? 'test-plugin', version: '0.0.0' },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    settings: { get: async () => (need('settings'), /** @type {any} */ (opts.settings ?? {})) },
    secrets: { get: async (key) => (need('secrets'), opts.secrets?.[key] ?? null) },
    kv: {
      get: async (key) => (need('kv'), kvStore.has(key) ? kvStore.get(key) : null),
      set: async (key, value) => {
        need('kv');
        kvStore.set(key, JSON.parse(JSON.stringify(value)));
      },
      delete: async (key) => {
        need('kv');
        kvStore.delete(key);
      },
    },
    users: {
      get: async (id) => (need('users:read'), /** @type {any} */ (users.find((u) => /** @type {any} */ (u).id === id) ?? null)),
      list: async () => (need('users:read'), /** @type {any} */ (users)),
    },
    http: {
      fetch: async (url, init) => {
        need(`http:${new URL(url).hostname}`);
        if (!url.startsWith('https://')) throw new Error('Plugins may only call https:// URLs');
        if (!opts.fetch) throw new Error('No fetch mock provided');
        return opts.fetch(url, init);
      },
    },
    events: {
      on: async (pattern, handler) => {
        need(`events:${pattern}`);
        registered.events.set(pattern, handler);
      },
    },
    hooks: {
      filter: async (name, fn) => {
        need(`hooks:${name}`);
        registered.hooks.set(name, fn);
      },
    },
    routes: {
      register: async (def) => {
        need('routes');
        registered.routes.set(`${def.method ?? 'GET'} ${def.path}`, def.handler);
      },
    },
    jobs: {
      schedule: async (name, _interval, handler) => {
        need('jobs');
        registered.jobs.set(name, handler);
      },
    },
    gateways: {
      register: async (adapter) => {
        need('gateway');
        registered.gateways.push(adapter);
      },
    },
    push: {
      register: async (provider) => {
        need('push');
        registered.push.push(provider);
      },
    },
    registered,
    logs,
    kvStore,
    async emit(type, data) {
      for (const [pattern, handler] of registered.events) {
        const match = pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));
        if (match) await handler({ id: `evt_test_${Date.now()}`, type, data, userId: /** @type {any} */ (data).userId ?? null, orgId: null, createdAt: new Date() });
      }
    },
    async request(method, path, init = {}) {
      const handler = registered.routes.get(`${method} ${path}`);
      if (!handler) return { status: 404, body: 'Not found' };
      return handler({ method, path, query: {}, body: null, rawBody: null, headers: {}, admin: null, ...init });
    },
  };
  return ctx;
}
