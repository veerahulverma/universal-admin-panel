import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { loadConfig, type Config } from './config.js';
import { Db } from './core/db.js';
import { SystemClock, type Clock } from './core/clock.js';
import { Encryptor } from './core/crypto.js';
import { SettingsService } from './core/settings.js';
import { SecretStore } from './core/secrets.js';
import { EventBus } from './core/events.js';
import { JobQueue, Worker } from './core/jobs.js';
import { RateLimiter } from './core/ratelimit.js';
import { ModuleRegistry, type ModuleDefinition } from './core/modules.js';
import { PermissionCatalog } from './core/permissions.js';
import { HookRegistry } from './core/hooks.js';
import { OpenApiRegistry } from './core/openapi.js';
import { LocalStorage, type Storage } from './core/storage.js';
import { runMigrations } from './core/migrate.js';
import { Router, errorPayload } from './core/http.js';
import { newId } from './core/ids.js';
import type { App, Logger } from './core/types.js';
import { allModules } from './modules/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface CreatePlatformOptions {
  config?: Partial<Config>;
  env?: NodeJS.ProcessEnv;
  db?: Db;
  clock?: Clock;
  storage?: Storage;
  modules?: ModuleDefinition[];
}

export interface Platform {
  app: App;
  server: FastifyInstance;
  close(): Promise<void>;
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  "object-src 'none'",
].join('; ');

/** JSON.parse that drops prototype-pollution keys. */
function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => (key === '__proto__' || key === 'constructor' ? undefined : value));
}

export async function createPlatform(opts: CreatePlatformOptions = {}): Promise<Platform> {
  const config = loadConfig(opts.config, opts.env);
  const server = Fastify({
    logger: config.isTest
      ? false
      : {
          level: config.logLevel,
          redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'],
        },
    trustProxy:
      typeof config.trustProxy === 'number'
        ? ((hops: number) => (_addr: string, hop: number) => hop < hops)(config.trustProxy)
        : config.trustProxy,
    bodyLimit: 1024 * 1024,
    genReqId: () => newId('req'),
    requestIdHeader: false,
  });
  const log: Logger = config.isTest ? silentLogger : server.log;
  const ownsDb = !opts.db;
  const db = opts.db ?? (await Db.connect(config.databaseUrl, { poolMax: config.dbPoolMax }));

  const app = {
    config,
    db,
    clock: opts.clock ?? new SystemClock(),
    log,
    encryptor: Encryptor.fromSpec(config.encryptionKeys, config.encryptionActiveKey),
    authenticators: {},
    services: {},
  } as App;
  app.settings = new SettingsService(app);
  app.secrets = new SecretStore(app);
  app.events = new EventBus(app);
  app.jobs = new JobQueue(app);
  app.worker = new Worker(app, config.workerConcurrency);
  app.rateLimiter = new RateLimiter(app);
  app.permissions = new PermissionCatalog();
  app.hooks = new HookRegistry(app);
  app.openapi = new OpenApiRegistry();
  app.storage = opts.storage ?? new LocalStorage(config.storageDir);
  app.modules = new ModuleRegistry(app, opts.modules ?? allModules);

  await runMigrations(db, app.modules.defs, log);

  for (const m of app.modules.defs) {
    if (m.permissions) app.permissions.register(m.id, m.permissions);
    if (m.events) app.events.defineTypes(m.id, m.events);
    await m.setup?.(app);
  }
  await app.modules.load();
  await app.settings.load();
  await app.jobs.syncSchedules(db);

  // ---- HTTP plumbing -------------------------------------------------------
  await server.register(cookie);
  await server.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 5 } });
  server.decorateRequest('rawBody', undefined);
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, safeJsonParse(body as string));
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  server.addHook('onRequest', async (req, reply) => {
    if (config.forceHttps && req.protocol === 'http' && !req.url.startsWith('/api/health')) {
      return reply.redirect(`https://${req.host}${req.url}`, 301);
    }
  });

  server.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'DENY');
    if (config.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.includes('text/html') && !reply.hasHeader('content-security-policy')) reply.header('content-security-policy', CSP);
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  server.setErrorHandler((err, req, reply) => {
    const { status, body, headers } = errorPayload(err, String(req.id));
    if (status >= 500) log.error({ err, url: req.url, method: req.method }, 'request failed');
    if (headers) reply.headers(headers);
    reply.header('x-error-code', body.error.code);
    return reply.status(status).send(body);
  });

  const adminIndex = path.join(config.adminDistDir, 'index.html');
  const hasAdminUi = fs.existsSync(adminIndex);
  server.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && hasAdminUi) {
      return reply.type('text/html').send(fs.readFileSync(adminIndex));
    }
    return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found`, requestId: req.id } });
  });

  for (const m of app.modules.defs) await m.http?.(server, app);
  for (const m of app.modules.defs) m.routes?.(new Router(app, server, m.id), app);

  if (hasAdminUi) {
    await server.register(fastifyStatic, { root: config.adminDistDir, prefix: '/', wildcard: false, index: false });
    server.get('/', (_req, reply) => reply.type('text/html').send(fs.readFileSync(adminIndex)));
  }

  for (const m of app.modules.defs) await m.start?.(app);
  if (!config.isTest) app.settings.startRefresh();

  return {
    app,
    server,
    async close() {
      await app.worker.stop();
      app.settings.stop();
      for (const m of [...app.modules.defs].reverse()) {
        const stop = (app.services[`${m.id}.stop`] as (() => Promise<void>) | undefined);
        if (stop) await stop();
      }
      await server.close();
      if (ownsDb) await db.close();
    },
  };
}
