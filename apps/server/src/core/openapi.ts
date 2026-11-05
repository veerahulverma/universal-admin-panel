import { z, type ZodType } from 'zod';
import type { AuthMode } from './types.js';

export type ApiSurface = 'v1' | 'client' | 'admin' | 'public';

interface RouteDoc {
  module: string;
  method: string;
  url: string;
  auth: AuthMode;
  summary?: string;
  description?: string;
  tags?: string[];
  permission?: string;
  scope?: string;
  sensitive?: boolean;
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export function surfaceOf(auth: AuthMode): ApiSurface {
  if (auth === 'api') return 'v1';
  if (auth === 'client') return 'client';
  if (auth === 'public') return 'public';
  return 'admin';
}

function toSchema(schema: ZodType): Record<string, any> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, any>;
  delete json.$schema;
  return json;
}

const SURFACE_INFO: Record<ApiSurface, { title: string; description: string; security: Record<string, any> }> = {
  v1: {
    title: 'Integration API (v1)',
    description: 'Server-to-server API for your SaaS backend. Authenticate with a secret API key: `Authorization: Bearer sk_live_...`.',
    security: { apiKey: { type: 'http', scheme: 'bearer', description: 'Secret API key (sk_live_ / sk_test_)' } },
  },
  client: {
    title: 'Client API',
    description: 'Browser-safe API used by the frontend SDK. Authenticate with a short-lived customer session token created by your backend.',
    security: { customerSession: { type: 'http', scheme: 'bearer', description: 'Customer session token (cs_...)' } },
  },
  admin: {
    title: 'Admin API',
    description: 'API behind the admin panel and mobile app. Cookie session (web, requires X-CSRF-Token on writes) or bearer session token (mobile).',
    security: { adminSession: { type: 'http', scheme: 'bearer', description: 'Admin session token' } },
  },
  public: {
    title: 'Public endpoints',
    description: 'Unauthenticated endpoints: payment gateway webhooks, tracking links, health checks.',
    security: {},
  },
};

export class OpenApiRegistry {
  private readonly routes: RouteDoc[] = [];

  add(doc: RouteDoc): void {
    this.routes.push(doc);
  }

  document(surface: ApiSurface, opts: { version: string; serverUrl: string }): Record<string, any> {
    const info = SURFACE_INFO[surface];
    const paths: Record<string, any> = {};
    const tags = new Set<string>();
    for (const r of this.routes) {
      if (surfaceOf(r.auth) !== surface) continue;
      const path = r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const parameters: any[] = [];
      for (const [where, schema] of [['path', r.params], ['query', r.query]] as const) {
        if (!schema) continue;
        const json = toSchema(schema);
        const required = new Set<string>(json.required ?? []);
        for (const [name, prop] of Object.entries<any>(json.properties ?? {})) {
          parameters.push({ name, in: where, required: where === 'path' || required.has(name), schema: prop, description: prop.description });
        }
      }
      for (const t of r.tags ?? []) tags.add(t);
      const notes = [
        r.description,
        r.permission ? `Requires admin permission \`${r.permission}\`.` : null,
        r.scope ? `Requires API key scope \`${r.scope}\`.` : null,
        r.sensitive ? 'Sensitive action: requires a recent re-authentication.' : null,
      ].filter(Boolean);
      const op: Record<string, any> = {
        summary: r.summary,
        description: notes.join('\n\n') || undefined,
        tags: r.tags,
        parameters: parameters.length ? parameters : undefined,
        responses: {
          '200': { description: 'Success' },
          '4XX': { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
        security: surface === 'public' ? [] : [Object.fromEntries(Object.keys(info.security).map((k) => [k, []]))],
      };
      if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: toSchema(r.body) } } };
      paths[path] = { ...(paths[path] ?? {}), [r.method.toLowerCase()]: op };
    }
    return {
      openapi: '3.1.0',
      info: { title: info.title, version: opts.version, description: info.description },
      servers: [{ url: opts.serverUrl }],
      tags: [...tags].sort().map((name) => ({ name })),
      paths,
      components: {
        securitySchemes: info.security,
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } },
                required: ['code', 'message'],
              },
            },
          },
        },
      },
    };
  }
}
