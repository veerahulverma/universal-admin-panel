import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  /** Public base URL of this server (used in links, webhooks, checkout redirects). */
  APP_URL: z.string().url().default('http://localhost:4000'),
  /** Origin of the admin UI when served separately (dev: Vite on 5173). */
  ADMIN_URL: z.string().url().optional(),
  DATABASE_URL: z.string().default('pglite://./data/pglite'),
  DB_POOL_MAX: z.coerce.number().int().default(10),
  DATA_DIR: z.string().default('./data'),
  /** Comma-separated "<keyId>:<base64 32-byte key>" list. The last (or ENCRYPTION_ACTIVE_KEY) encrypts. */
  ENCRYPTION_KEYS: z.string().optional(),
  ENCRYPTION_ACTIVE_KEY: z.string().optional(),
  /** Fastify trustProxy: "true", a hop count, or a comma-separated list of proxy CIDRs. */
  TRUST_PROXY: z.string().optional(),
  COOKIE_SECURE: bool.optional(),
  FORCE_HTTPS: bool.default(false),
  WORKER: bool.default(true),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  LOG_LEVEL: z.string().default('info'),
  /** Allow webhooks/plugin HTTP to private networks (development only). */
  ALLOW_PRIVATE_NETWORK: bool.optional(),
  /** One-time token required to create the first super admin. Generated and logged if unset. */
  SETUP_TOKEN: z.string().optional(),
  PLUGINS_DIR: z.string().optional(),
  STORAGE_DIR: z.string().optional(),
  PLUGIN_SANDBOX: bool.default(true),
  MARKETPLACE_URL: z.string().url().optional(),
  /** Ed25519 public key (PEM or base64 DER) used to verify marketplace package signatures. */
  MARKETPLACE_PUBLIC_KEY: z.string().optional(),
  ADMIN_DIST_DIR: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  isProd: boolean;
  isTest: boolean;
  host: string;
  port: number;
  appUrl: string;
  adminUrl: string;
  databaseUrl: string;
  dbPoolMax: number;
  dataDir: string;
  encryptionKeys: string;
  encryptionActiveKey?: string;
  trustProxy: boolean | number | string[];
  cookieSecure: boolean;
  forceHttps: boolean;
  worker: boolean;
  workerConcurrency: number;
  logLevel: string;
  allowPrivateNetwork: boolean;
  setupToken?: string;
  pluginsDir: string;
  storageDir: string;
  pluginSandbox: boolean;
  marketplaceUrl?: string;
  marketplacePublicKey?: string;
  adminDistDir: string;
  version: string;
}

function parseTrustProxy(v: string | undefined): boolean | number | string[] {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim());
}

/**
 * In development, generate and persist an encryption key so the platform runs
 * with zero configuration. Production refuses to start without explicit keys.
 */
function devEncryptionKeys(dataDir: string): string {
  const file = path.join(dataDir, 'dev-encryption-key.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(dataDir, { recursive: true });
  const spec = `dev1:${randomBytes(32).toString('base64')}`;
  fs.writeFileSync(file, spec, { mode: 0o600 });
  return spec;
}

export function loadConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const dataDir = path.resolve(e.DATA_DIR);
  let encryptionKeys = overrides.encryptionKeys ?? e.ENCRYPTION_KEYS;
  if (!encryptionKeys) {
    if (isProd) throw new Error('ENCRYPTION_KEYS is required in production (see .env.example)');
    encryptionKeys = e.NODE_ENV === 'test' ? `test:${Buffer.alloc(32, 7).toString('base64')}` : devEncryptionKeys(dataDir);
  }
  const appUrl = e.APP_URL.replace(/\/$/, '');
  const config: Config = {
    env: e.NODE_ENV,
    isProd,
    isTest: e.NODE_ENV === 'test',
    host: e.HOST,
    port: e.PORT,
    appUrl,
    adminUrl: (e.ADMIN_URL ?? appUrl).replace(/\/$/, ''),
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    dataDir,
    encryptionKeys,
    encryptionActiveKey: e.ENCRYPTION_ACTIVE_KEY,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    cookieSecure: e.COOKIE_SECURE ?? isProd,
    forceHttps: e.FORCE_HTTPS,
    worker: e.WORKER,
    workerConcurrency: e.WORKER_CONCURRENCY,
    logLevel: e.LOG_LEVEL,
    allowPrivateNetwork: e.ALLOW_PRIVATE_NETWORK ?? !isProd,
    setupToken: e.SETUP_TOKEN,
    pluginsDir: path.resolve(e.PLUGINS_DIR ?? path.join(dataDir, 'plugins')),
    storageDir: path.resolve(e.STORAGE_DIR ?? path.join(dataDir, 'storage')),
    pluginSandbox: e.PLUGIN_SANDBOX,
    marketplaceUrl: e.MARKETPLACE_URL,
    marketplacePublicKey: e.MARKETPLACE_PUBLIC_KEY,
    adminDistDir: path.resolve(e.ADMIN_DIST_DIR ?? path.join(import.meta.dirname, '../../admin/dist')),
    version: '0.1.0',
    ...overrides,
  };
  return config;
}
