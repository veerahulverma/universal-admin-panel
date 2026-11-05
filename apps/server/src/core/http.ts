import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import type { Actor, AdminPrincipal, ApiKeyPrincipal, App, AuthMode, CustomerPrincipal, Principal } from './types.js';
import { AppError, forbidden, moduleDisabled, tooManyRequests, validationError } from './errors.js';
import { isAllowed } from './permissions.js';
import { writeAudit } from './audit.js';
import type { Db } from './db.js';
import { MINUTE } from './clock.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDef<B = any, Q = any, P = any> {
  method: HttpMethod;
  url: string;
  auth: AuthMode;
  /** Admin permission required (backend-enforced regardless of what the UI shows). */
  permission?: string;
  /** API key scope required for `auth: 'api'` routes. */
  scope?: string;
  /** Requires the admin to have re-authenticated recently (password/2FA prompt). */
  sensitive?: boolean;
  rateLimit?: { max: number; windowSec: number; by?: 'ip' | 'principal'; key?: string };
  summary?: string;
  description?: string;
  tags?: string[];
  hidden?: boolean;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
  bodyLimit?: number;
  handler: (c: RouteContext<B, Q, P>) => unknown;
}

export interface RouteContext<B = any, Q = any, P = any> {
  app: App;
  req: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: P;
  principal: Principal;
  ip: string;
  userAgent: string;
  requestId: string;
  actor: Actor;
  admin(): AdminPrincipal;
  apiKey(): ApiKeyPrincipal;
  customer(): CustomerPrincipal;
  can(permission: string): boolean;
  /** Organizations the caller may see; null means unrestricted. */
  orgScope(): string[] | null;
  audit(
    db: Db,
    action: string,
    target?: { type: string; id: string | null; orgId?: string | null },
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

/** `users:write` implies `users:read`; `users:*` and `*` grant everything below them. */
export function scopeAllowed(granted: readonly string[], required: string): boolean {
  const [resource, action] = required.split(':');
  return granted.some(
    (g) =>
      g === '*' ||
      g === required ||
      g === `${resource}:*` ||
      (action === 'read' && g === `${resource}:write`),
  );
}

export function actorFor(principal: Principal, ip: string | null, userAgent: string | null): Actor {
  switch (principal.kind) {
    case 'admin':
      return { type: 'admin', id: principal.adminId, label: principal.email, ip, userAgent };
    case 'api_key':
      return { type: 'api_key', id: principal.keyId, label: principal.name, ip, userAgent };
    case 'customer':
      return { type: 'user', id: principal.userId, label: null, ip, userAgent };
    default:
      return { type: 'system', id: null, label: 'Anonymous', ip, userAgent };
  }
}

function parsePart<T>(schema: ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return value as T;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw validationError(
      result.error.issues.map((i) => ({ path: [where, ...i.path.map(String)], message: i.message, code: i.code })),
    );
  }
  return result.data;
}

/**
 * PATCH is a partial update, but zod fills `.default()` values even through
 * `.partial()`, which would silently reset every field the client did not send
 * (an API key's IP allowlist, a gateway's configuration...). Keep only declared
 * fields that were actually sent; keys a schema derives itself are left alone.
 */
function sentFieldsOnly<T>(schema: ZodType | undefined, parsed: T, raw: unknown): T {
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (!shape || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const sent = new Set(raw && typeof raw === 'object' ? Object.keys(raw) : []);
  return Object.fromEntries(Object.entries(parsed as object).filter(([key]) => sent.has(key) || !(key in shape))) as T;
}

async function authenticate(app: App, req: FastifyRequest, mode: AuthMode): Promise<Principal> {
  if (mode === 'public') return { kind: 'anonymous' };
  const key = mode.startsWith('admin') ? 'admin' : (mode as 'api' | 'client');
  const auth = app.authenticators[key];
  if (!auth) throw new AppError(503, 'auth_unavailable', `No authenticator registered for ${key} routes`);
  return auth(req, mode);
}

export class Router {
  constructor(
    private readonly app: App,
    private readonly fastify: FastifyInstance,
    readonly moduleId: string,
  ) {}

  route<B = any, Q = any, P = any>(def: RouteDef<B, Q, P>): void {
    const app = this.app;
    const moduleId = this.moduleId;
    if (!def.hidden) {
      app.openapi.add({
        module: moduleId,
        method: def.method,
        url: def.url,
        auth: def.auth,
        summary: def.summary,
        description: def.description,
        tags: def.tags,
        permission: def.permission,
        scope: def.scope,
        sensitive: def.sensitive,
        body: def.body,
        query: def.query,
        params: def.params,
      });
    }
    this.fastify.route({
      method: def.method,
      url: def.url,
      bodyLimit: def.bodyLimit,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!app.modules.isEnabled(moduleId)) throw moduleDisabled(moduleId);
        const ip = req.ip;
        const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 500);

        if (def.rateLimit && def.rateLimit.by !== 'principal') {
          const rl = await app.rateLimiter.hit(`route:${def.rateLimit.key ?? def.url}:ip:${ip}`, def.rateLimit.max, def.rateLimit.windowSec);
          if (!rl.allowed) throw tooManyRequests('Too many requests, please slow down', rl.retryAfterSeconds);
        }

        const principal = await authenticate(app, req, def.auth);

        if (def.rateLimit?.by === 'principal') {
          const id = principal.kind === 'admin' ? principal.adminId : principal.kind === 'api_key' ? principal.keyId : principal.kind === 'customer' ? principal.userId : ip;
          const rl = await app.rateLimiter.hit(`route:${def.rateLimit.key ?? def.url}:p:${id}`, def.rateLimit.max, def.rateLimit.windowSec);
          if (!rl.allowed) throw tooManyRequests('Too many requests, please slow down', rl.retryAfterSeconds);
        }

        if (principal.kind === 'admin') {
          if (def.permission && !isAllowed(principal.permissions, def.permission)) {
            throw new AppError(403, 'forbidden', 'You do not have permission to perform this action', { permission: def.permission });
          }
          if (def.sensitive) {
            const windowMin = app.settings.get<{ reauthWindowMinutes: number }>('auth').reauthWindowMinutes;
            const fresh = principal.reauthAt && app.clock.now().getTime() - principal.reauthAt.getTime() < windowMin * MINUTE;
            if (!fresh) throw new AppError(403, 'reauth_required', 'Please confirm your identity to continue');
          }
        }
        if (principal.kind === 'api_key' && def.scope && !scopeAllowed(principal.scopes, def.scope)) {
          throw new AppError(403, 'insufficient_scope', `This API key lacks the "${def.scope}" scope`, { scope: def.scope });
        }

        const params = parsePart(def.params, req.params, 'params');
        const query = parsePart(def.query, req.query, 'query');
        const parsedBody = parsePart(def.body, req.body, 'body');
        const body = def.method === 'PATCH' ? sentFieldsOnly(def.body, parsedBody, req.body) : parsedBody;
        const actor = actorFor(principal, ip, userAgent);

        const ctx: RouteContext<B, Q, P> = {
          app,
          req,
          reply,
          body,
          query,
          params,
          principal,
          ip,
          userAgent,
          requestId: String(req.id),
          actor,
          admin: () => {
            if (principal.kind !== 'admin') throw forbidden();
            return principal;
          },
          apiKey: () => {
            if (principal.kind !== 'api_key') throw forbidden();
            return principal;
          },
          customer: () => {
            if (principal.kind !== 'customer') throw forbidden();
            return principal;
          },
          can: (permission) => principal.kind === 'admin' && isAllowed(principal.permissions, permission),
          orgScope: () => {
            if (principal.kind === 'admin') return principal.orgScope;
            if (principal.kind === 'api_key') return principal.orgId ? [principal.orgId] : null;
            if (principal.kind === 'customer') return principal.orgId ? [principal.orgId] : [];
            return [];
          },
          audit: (db, action, target, metadata) =>
            writeAudit(db, app, {
              actor,
              action,
              targetType: target?.type ?? null,
              targetId: target?.id ?? null,
              orgId: target?.orgId ?? null,
              metadata,
            }),
        };

        const result = await def.handler(ctx);
        if (result === reply || reply.sent) return reply;
        if (result === undefined) return reply.status(204).send();
        return reply.send(result);
      },
    });
  }
}

/** Convert unknown errors to the API error envelope. */
export function errorPayload(err: unknown, requestId: string): { status: number; body: any; headers?: Record<string, string> } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      headers: err.headers,
      body: { error: { code: err.code, message: err.message, details: err.details, requestId } },
    };
  }
  if (err instanceof ZodError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'validation_error',
          message: 'Validation failed',
          details: err.issues.map((i) => ({ path: i.path, message: i.message })),
          requestId,
        },
      },
    };
  }
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
    return { status: e.statusCode, body: { error: { code: e.code ?? 'bad_request', message: e.message ?? 'Bad request', requestId } } };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'An unexpected error occurred', requestId } } };
}
