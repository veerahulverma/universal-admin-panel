import type { Config } from '../config.js';
import type { Clock } from './clock.js';
import type { Db } from './db.js';
import type { Encryptor } from './crypto.js';
import type { SettingsService } from './settings.js';
import type { SecretStore } from './secrets.js';
import type { EventBus } from './events.js';
import type { JobQueue, Worker } from './jobs.js';
import type { RateLimiter } from './ratelimit.js';
import type { ModuleRegistry } from './modules.js';
import type { PermissionCatalog } from './permissions.js';
import type { HookRegistry } from './hooks.js';
import type { OpenApiRegistry } from './openapi.js';
import type { FastifyRequest } from 'fastify';
import type { Storage } from './storage.js';

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AdminPrincipal {
  kind: 'admin';
  adminId: string;
  email: string;
  name: string;
  sessionId: string;
  permissions: string[];
  /** null = may see all organizations; otherwise data visibility is limited to these. */
  orgScope: string[] | null;
  mfaVerified: boolean;
  reauthAt: Date | null;
  viaCookie: boolean;
}

export interface ApiKeyPrincipal {
  kind: 'api_key';
  keyId: string;
  name: string;
  scopes: string[];
  /** Organization-scoped keys may only touch that organization's data. */
  orgId: string | null;
  mode: 'live' | 'test';
}

export interface CustomerPrincipal {
  kind: 'customer';
  sessionId: string;
  userId: string;
  orgId: string | null;
}

export interface AnonymousPrincipal {
  kind: 'anonymous';
}

export type Principal = AdminPrincipal | ApiKeyPrincipal | CustomerPrincipal | AnonymousPrincipal;

export type AuthMode = 'admin' | 'admin:partial' | 'admin:enroll' | 'api' | 'client' | 'public';

export type Authenticator = (req: FastifyRequest, mode: AuthMode) => Promise<Principal>;

export interface Actor {
  type: 'admin' | 'system' | 'api_key' | 'user' | 'plugin';
  id: string | null;
  label?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: 'System' };

export interface App {
  config: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  encryptor: Encryptor;
  settings: SettingsService;
  secrets: SecretStore;
  events: EventBus;
  jobs: JobQueue;
  worker: Worker;
  rateLimiter: RateLimiter;
  modules: ModuleRegistry;
  permissions: PermissionCatalog;
  hooks: HookRegistry;
  openapi: OpenApiRegistry;
  storage: Storage;
  authenticators: Partial<Record<'admin' | 'api' | 'client', Authenticator>>;
  /** Late-bound services registered by modules (kept loosely typed to avoid import cycles). */
  services: Record<string, unknown>;
}
