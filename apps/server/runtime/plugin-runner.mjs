// Sandbox entry point for untrusted plugins. Started by the plugin host with
// `node --permission --allow-fs-read=<plugin dir>`: no filesystem writes, no
// child processes, no workers, no native addons. Network and process modules are
// blocked at module resolution and `fetch` is routed through the host, which
// enforces the plugin's granted `http:<host>` permissions and SSRF rules.
import * as nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';

const BLOCKED = new Set(['net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'child_process', 'worker_threads', 'cluster', 'vm', 'inspector', 'module', 'repl', 'v8', 'wasi']);

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const name = specifier.replace(/^node:/, '').split('/')[0];
      if (BLOCKED.has(name)) {
        const err = new Error(`Module "${specifier}" is not available inside the plugin sandbox; use ctx.http.fetch`);
        err.code = 'ERR_PLUGIN_SANDBOX';
        throw err;
      }
      return nextResolve(specifier, context);
    },
  });
}

let seq = 0;
const pending = new Map();
function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ type: 'call', id, method, args });
  });
}

let hseq = 0;
const handlers = new Map();
const register = (value) => {
  const id = `h${++hseq}`;
  handlers.set(id, value);
  return id;
};

async function sandboxFetch(url, init = {}) {
  const res = await call('http.fetch', String(url), { method: init.method, headers: init.headers, body: init.body });
  return new Response(res.body, { status: res.status, headers: res.headers });
}
globalThis.fetch = sandboxFetch;
for (const key of ['WebSocket', 'EventSource']) {
  try {
    delete globalThis[key];
  } catch {
    /* ignore */
  }
}
process.binding = () => {
  throw new Error('process.binding is not available inside the plugin sandbox');
};
process.dlopen = () => {
  throw new Error('Native addons are not available inside the plugin sandbox');
};

const ctx = {
  plugin: { id: process.env.PLUGIN_ID, version: process.env.PLUGIN_VERSION },
  log: {
    info: (message, context) => call('log', 'info', String(message), context ?? null),
    warn: (message, context) => call('log', 'warn', String(message), context ?? null),
    error: (message, context) => call('log', 'error', String(message), context ?? null),
  },
  settings: { get: () => call('settings.get') },
  secrets: { get: (key) => call('secrets.get', key) },
  kv: { get: (key) => call('kv.get', key), set: (key, value) => call('kv.set', key, value), delete: (key) => call('kv.delete', key) },
  users: { get: (id) => call('users.get', id), list: (opts) => call('users.list', opts ?? {}) },
  http: { fetch: (url, init) => call('http.fetch', String(url), init ?? {}) },
  events: { on: (pattern, fn) => call('events.on', register(fn), pattern) },
  hooks: { filter: (name, fn) => call('hooks.filter', register(fn), name) },
  routes: { register: (def) => call('routes.register', register(def.handler), def.method ?? 'GET', def.path, def.auth ?? 'public') },
  jobs: { schedule: (name, intervalSeconds, fn) => call('jobs.schedule', register(fn), name, intervalSeconds) },
  gateways: {
    register: (adapter) =>
      call('gateways.register', register(adapter), {
        key: adapter.key,
        name: adapter.name,
        description: adapter.description ?? '',
        capabilities: adapter.capabilities,
        secretFields: adapter.secretFields ?? [],
        methods: ['testConnection', 'createCheckout', 'chargeSaved', 'refund', 'parseWebhook', 'handleReturn'].filter((m) => typeof adapter[m] === 'function'),
      }),
  },
  push: {
    register: (provider) => call('push.register', register(provider), { key: provider.key, name: provider.name, description: provider.description ?? '', targets: provider.targets }),
  },
};

let mod;
process.on('message', async (m) => {
  if (m.type === 'result') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(Object.assign(new Error(m.error), { name: m.errorName ?? 'Error' }));
    return;
  }
  if (m.type !== 'invoke') return;
  try {
    let value;
    if (m.kind === 'activate') value = await mod.activate?.(ctx);
    else if (m.kind === 'deactivate') value = await mod.deactivate?.();
    else if (m.kind === 'gateway') {
      const adapter = handlers.get(m.handlerId);
      const [gatewayCtx, ...rest] = m.args;
      value = await adapter[m.method]({ ...gatewayCtx, fetch: sandboxFetch, log: ctx.log }, ...rest);
    } else if (m.kind === 'push') {
      const provider = handlers.get(m.handlerId);
      value = await provider[m.method](...m.args);
    } else {
      const fn = handlers.get(m.handlerId);
      if (typeof fn !== 'function') throw new Error(`Unknown handler ${m.handlerId}`);
      value = await fn(...m.args);
    }
    process.send({ type: 'invokeResult', id: m.id, ok: true, value: value === undefined ? null : value });
  } catch (err) {
    process.send({ type: 'invokeResult', id: m.id, ok: false, error: String(err?.message ?? err), errorName: err?.name ?? 'Error' });
  }
});

try {
  mod = await import(pathToFileURL(process.env.PLUGIN_ENTRY).href);
  process.send({ type: 'ready' });
} catch (err) {
  process.send({ type: 'fatal', error: String(err?.stack ?? err) });
  process.exit(1);
}
