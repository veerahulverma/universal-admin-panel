import type { JsonSchema } from '../../components/SchemaForm';

// ---- OpenAPI documents (as served by /api/openapi/:surface and /api/admin/openapi.json) ----------

export interface OpenApiParam {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParam[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
  security?: Record<string, string[]>[];
}

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  tags?: { name: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  tag: string;
  op: OpenApiOperation;
}

export type SurfaceId = 'v1' | 'client' | 'admin' | 'public';

export const SURFACES: { id: SurfaceId; label: string; doc: string; auth: 'apiKey' | 'session' | 'admin' | 'none'; blurb: string }[] = [
  { id: 'v1', label: 'Integration API', doc: '/api/openapi/v1.json', auth: 'apiKey', blurb: 'Server-to-server, with a secret API key.' },
  { id: 'client', label: 'Client API', doc: '/api/openapi/client.json', auth: 'session', blurb: 'Browser-safe, with a customer session token.' },
  { id: 'admin', label: 'Admin API', doc: '/api/admin/openapi.json', auth: 'admin', blurb: 'Behind this console and the mobile app.' },
  { id: 'public', label: 'Public', doc: '/api/openapi/public.json', auth: 'none', blurb: 'Unauthenticated endpoints.' },
];

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

export function operationsOf(doc: OpenApiDoc): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      out.push({ id: `${method} ${path}`, method: method.toUpperCase(), path, tag: op.tags?.[0] ?? 'Other', op });
    }
  }
  return out.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || METHODS.indexOf(a.method.toLowerCase()) - METHODS.indexOf(b.method.toLowerCase()));
}

export function bodySchema(op: OpenApiOperation): JsonSchema | null {
  return op.requestBody?.content?.['application/json']?.schema ?? null;
}

/** Unwrap `anyOf: [X, {type: 'null'}]` and `type: [X, 'null']`. */
export function unwrap(schema: JsonSchema): JsonSchema {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const real = variants.filter((v) => v.type !== 'null');
    if (real.length === 1) return { ...real[0], description: schema.description ?? real[0].description, default: schema.default ?? real[0].default };
  }
  if (Array.isArray(schema.type)) return { ...schema, type: schema.type.find((t) => t !== 'null') };
  return schema;
}

export function typeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return 'any';
  const s = unwrap(schema);
  const nullable = s !== schema;
  let label: string;
  if (s.enum) label = s.enum.map((e) => JSON.stringify(e)).join(' | ');
  else if (s.type === 'array') label = `${typeLabel(s.items)}[]`;
  else if (s.type === 'object' && !s.properties && s.additionalProperties) label = 'object (map)';
  else label = String(s.type ?? (s.anyOf ? 'one of' : 'any'));
  if (s.format) label += ` (${s.format})`;
  return nullable ? `${label} | null` : label;
}

export function constraints(schema: JsonSchema): string[] {
  const s = unwrap(schema);
  const out: string[] = [];
  if (s.minLength !== undefined) out.push(`min length ${s.minLength}`);
  if (s.maxLength !== undefined) out.push(`max length ${s.maxLength}`);
  if (s.minimum !== undefined) out.push(`≥ ${s.minimum}`);
  if (s.exclusiveMinimum !== undefined) out.push(`> ${s.exclusiveMinimum}`);
  if (s.maximum !== undefined) out.push(`≤ ${s.maximum}`);
  if (s.exclusiveMaximum !== undefined) out.push(`< ${s.exclusiveMaximum}`);
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
  const maxItems = (s as { maxItems?: number }).maxItems;
  if (maxItems !== undefined) out.push(`max ${maxItems} items`);
  return out;
}

// ---- Example values -----------------------------------------------------------------------------

const ID_PREFIXES: Record<string, string> = {
  users: 'usr',
  user: 'usr',
  organizations: 'org',
  org: 'org',
  subscriptions: 'sub',
  invoices: 'inv',
  payments: 'pay',
  sessions: 'chk',
  reservations: 'rsv',
  'customer-keys': 'ckey',
  'customer-sessions': 'cses',
  'webhook-endpoints': 'whe',
  tickets: 'tkt',
};

/** A realistic placeholder for a path parameter, from the segment before it ("/users/{id}" -> "usr_123"). */
export function paramExample(path: string, name: string, schema?: JsonSchema): string {
  const s = schema ? unwrap(schema) : undefined;
  if (s?.enum?.length) return String(s.enum[0]);
  const parts = path.split('/');
  const i = parts.indexOf(`{${name}}`);
  const before = i > 0 ? parts[i - 1] : '';
  if (name === 'userId') return 'usr_123';
  if (name === 'orgId') return 'org_123';
  if (name === 'meter') return 'api_calls';
  if (name === 'action') return 'cancel';
  if (name === 'externalId') return 'app-user-42';
  const prefix = ID_PREFIXES[before];
  return prefix ? `${prefix}_123` : `${name}_123`;
}

function stringExample(name: string, s: JsonSchema): string {
  const n = name.toLowerCase();
  if (s.format === 'email' || n.includes('email')) return 'jane@example.com';
  if (s.format === 'uri' || s.format === 'url' || n.endsWith('url')) return 'https://example.com';
  if (s.format === 'date-time') return new Date().toISOString();
  if (s.format === 'date') return new Date().toISOString().slice(0, 10);
  if (n === 'currency') return 'USD';
  if (n === 'country') return 'US';
  if (n === 'userid') return 'usr_123';
  if (n === 'orgid') return 'org_123';
  if (n === 'externalid') return 'app-user-42';
  if (n === 'meter' || n === 'meterkey') return 'api_calls';
  if (n === 'feature') return 'api_calls';
  if (n === 'name') return 'Jane Doe';
  if (n === 'idempotencykey') return 'req-7f3c9a';
  if (s.minLength && s.minLength > 6) return 'x'.repeat(s.minLength);
  return 'string';
}

/** Build an example value from a JSON Schema: required fields (or the first few when none are required). */
export function exampleFor(schema: JsonSchema | undefined, name = '', depth = 0): unknown {
  if (!schema) return null;
  const s = unwrap(schema);
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case 'string':
      return stringExample(name, s);
    case 'integer':
    case 'number':
      return s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    case 'boolean':
      return false;
    case 'array':
      return depth > 2 ? [] : [exampleFor(s.items, name.replace(/s$/, ''), depth + 1)];
    case 'object': {
      if (!s.properties) return {};
      if (depth > 2) return {};
      const required = new Set(s.required ?? []);
      const keys = Object.keys(s.properties);
      const chosen = required.size ? keys.filter((k) => required.has(k)) : keys.slice(0, 3);
      // "userId or orgId" rules are validated server-side and not expressed as `required`.
      if (depth === 0 && keys.includes('userId') && !chosen.includes('userId') && !chosen.includes('orgId')) chosen.unshift('userId');
      return Object.fromEntries(chosen.map((k) => [k, exampleFor(s.properties![k], k, depth + 1)]));
    }
    default:
      return null;
  }
}

// ---- Requests and code samples ------------------------------------------------------------------

export interface RequestInput {
  method: string;
  path: string;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  hasBody: boolean;
}

export function buildUrl(input: Pick<RequestInput, 'path' | 'pathParams' | 'query'>): string {
  const path = input.path.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(input.pathParams[name] || `{${name}}`));
  const qs = new URLSearchParams(Object.entries(input.query).filter(([, v]) => v !== ''));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function curlSnippet(surface: SurfaceId, base: string, input: RequestInput): string {
  const lines = [`curl -X ${input.method} ${shellQuote(base + buildUrl(input))}`];
  if (surface === 'v1') lines.push(`-H "Authorization: Bearer $STEWARD_API_KEY"`);
  if (surface === 'client') lines.push(`-H "Authorization: Bearer $CUSTOMER_SESSION_TOKEN"`);
  if (surface === 'admin') lines.push(`-H "Authorization: Bearer $ADMIN_SESSION_TOKEN"`);
  if (input.hasBody) {
    lines.push(`-H "Content-Type: application/json"`);
    lines.push(`-d ${shellQuote(JSON.stringify(input.body ?? {}, null, 2))}`);
  }
  return lines.join(' \\\n  ');
}

export function fetchSnippet(surface: SurfaceId, base: string, input: RequestInput): string {
  const headers: string[] = [];
  if (surface === 'v1') headers.push('Authorization: `Bearer ${process.env.STEWARD_API_KEY}`');
  if (surface === 'client') headers.push('Authorization: `Bearer ${customerSessionToken}`');
  if (surface === 'admin') headers.push('Authorization: `Bearer ${adminSessionToken}`');
  if (input.hasBody) headers.push("'Content-Type': 'application/json'");
  const opts = [`method: '${input.method}'`];
  if (headers.length) opts.push(`headers: { ${headers.join(', ')} }`);
  if (input.hasBody) opts.push(`body: JSON.stringify(${indent(JSON.stringify(input.body ?? {}, null, 2), 2)})`);
  return `const res = await fetch(${lit(base + buildUrl(input))}, {\n  ${opts.join(',\n  ')},\n});\nif (!res.ok) throw new Error((await res.json()).error.message);\nconst data = await res.json();`;
}

function indent(text: string, spaces: number): string {
  return text.split('\n').join(`\n${' '.repeat(spaces)}`);
}

const lit = (v: unknown) => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v));
const obj = (v: unknown) => jsLiteral(v);

/** JSON rendered as a JavaScript object literal (unquoted keys where possible). */
export function jsLiteral(v: unknown, depth = 0): string {
  if (Array.isArray(v)) return v.length ? `[${v.map((x) => jsLiteral(x, depth + 1)).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return '{}';
    const pad = '  '.repeat(depth + 1);
    const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k));
    return `{\n${entries.map(([k, x]) => `${pad}${key(k)}: ${jsLiteral(x, depth + 1)}`).join(',\n')}\n${'  '.repeat(depth)}}`;
  }
  return lit(v);
}

type SdkArgs = { p: Record<string, string>; q: Record<string, string>; body: unknown };
const subject = (a: SdkArgs) => obj(a.q.orgId ? { orgId: a.q.orgId } : { userId: a.q.userId || 'usr_123' });
const nonEmpty = (q: Record<string, string>) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== ''));

/** Integration API operations that have a typed helper in @steward/node. */
const SDK: Record<string, (a: SdkArgs) => string> = {
  'GET /api/v1/ping': () => 'steward.ping()',
  'POST /api/v1/users': (a) => `steward.users.upsert(${obj(a.body)})`,
  'GET /api/v1/users': (a) => `steward.users.list(${obj(nonEmpty(a.q))})`,
  'GET /api/v1/users/{id}': (a) => `steward.users.get(${lit(a.p.id)})`,
  'PATCH /api/v1/users/{id}': (a) => `steward.users.update(${lit(a.p.id)}, ${obj(a.body)})`,
  'DELETE /api/v1/users/{id}': (a) => `steward.users.delete(${lit(a.p.id)})`,
  'GET /api/v1/users/external/{externalId}': (a) => `steward.users.getByExternalId(${lit(a.p.externalId)})`,
  'GET /api/v1/users/{id}/status': (a) => `steward.users.status(${lit(a.p.id)})`,
  'POST /api/v1/users/{id}/suspend': (a) => {
    const b = (a.body ?? {}) as { action?: string; reason?: string };
    return b.action === 'reactivate' ? `steward.users.reactivate(${lit(a.p.id)})` : `steward.users.suspend(${lit(a.p.id)}, ${obj({ reason: b.reason ?? 'Abuse report #123' })})`;
  },
  'POST /api/v1/users/{id}/activity': (a) => `steward.users.trackActivity(${lit(a.p.id)})`,
  'POST /api/v1/users/{id}/login-events': (a) => `steward.users.recordLogin(${lit(a.p.id)}, ${obj(a.body)})`,
  'POST /api/v1/users/{id}/sessions/revoke': (a) => `steward.users.revokeSessions(${lit(a.p.id)})`,
  'POST /api/v1/organizations': (a) => `steward.organizations.upsert(${obj(a.body)})`,
  'GET /api/v1/organizations/{id}': (a) => `steward.organizations.get(${lit(a.p.id)})`,
  'PATCH /api/v1/organizations/{id}': (a) => `steward.organizations.update(${lit(a.p.id)}, ${obj(a.body)})`,
  'GET /api/v1/organizations/{id}/members': (a) => `steward.organizations.members.list(${lit(a.p.id)})`,
  'PUT /api/v1/organizations/{id}/members/{userId}': (a) => `steward.organizations.members.set(${lit(a.p.id)}, ${lit(a.p.userId)}, ${lit(((a.body ?? {}) as { role?: string }).role ?? 'member')})`,
  'DELETE /api/v1/organizations/{id}/members/{userId}': (a) => `steward.organizations.members.remove(${lit(a.p.id)}, ${lit(a.p.userId)})`,
  'GET /api/v1/plans': (a) => `steward.plans.list(${obj(nonEmpty(a.q))})`,
  'GET /api/v1/entitlements': (a) => `steward.entitlements.get(${subject(a)})`,
  'POST /api/v1/entitlements/check': (a) => `steward.entitlements.check(${obj(a.body)})`,
  'POST /api/v1/entitlements/grants': (a) => `steward.entitlements.grant(${obj(a.body)})`,
  'POST /api/v1/usage/consume': (a) => `steward.usage.consume(${obj(a.body)})`,
  'POST /api/v1/usage/record': (a) => `steward.usage.record(${obj(a.body)})`,
  'POST /api/v1/usage/reserve': (a) => `steward.usage.reserve(${obj(a.body)})`,
  'POST /api/v1/usage/reservations/{id}/commit': (a) => `steward.usage.commit(${lit(a.p.id)})`,
  'POST /api/v1/usage/reservations/{id}/release': (a) => `steward.usage.release(${lit(a.p.id)})`,
  'PUT /api/v1/usage/gauges/{meter}': (a) => `steward.usage.setGauge(${lit(a.p.meter)}, ${obj(a.body)})`,
  'GET /api/v1/usage': (a) => `steward.usage.summary(${subject(a)})`,
  'GET /api/v1/credits': (a) => `steward.credits.balances(${subject(a)})`,
  'POST /api/v1/credits/grant': (a) => `steward.credits.grant(${obj(a.body)})`,
  'POST /api/v1/credits/consume': (a) => `steward.credits.consume(${obj(a.body)})`,
  'POST /api/v1/checkout/sessions': (a) => `steward.checkout.create(${obj(a.body)})`,
  'GET /api/v1/checkout/sessions/{id}': (a) => `steward.checkout.get(${lit(a.p.id)})`,
  'GET /api/v1/subscriptions': (a) => `steward.subscriptions.list(${subject(a)})`,
  'POST /api/v1/subscriptions/{id}/{action}': (a) => {
    const action = ['change', 'cancel', 'reactivate', 'pause', 'resume'].includes(a.p.action) ? a.p.action : 'cancel';
    return action === 'reactivate' || action === 'resume' ? `steward.subscriptions.${action}(${lit(a.p.id)})` : `steward.subscriptions.${action}(${lit(a.p.id)}, ${obj(a.body)})`;
  },
  'GET /api/v1/invoices': (a) => `steward.invoices.list(${subject(a)})`,
  'GET /api/v1/invoices/{id}/pdf': (a) => `steward.invoices.pdf(${lit(a.p.id)})`,
  'PUT /api/v1/billing-profile': (a) => `steward.billingProfile.update(${obj(a.body)})`,
  'POST /api/v1/customer-sessions': (a) => `steward.customerSessions.create(${obj(a.body)})`,
  'DELETE /api/v1/customer-sessions/{id}': (a) => `steward.customerSessions.revoke(${lit(a.p.id)})`,
  'POST /api/v1/customer-keys': (a) => `steward.customerKeys.issue(${obj(a.body)})`,
  'GET /api/v1/customer-keys': (a) => `steward.customerKeys.list(${subject(a)})`,
  'DELETE /api/v1/customer-keys/{id}': (a) => `steward.customerKeys.revoke(${lit(a.p.id)})`,
  'POST /api/v1/customer-keys/verify': (a) => `steward.customerKeys.verify(${lit(((a.body ?? {}) as { key?: string }).key ?? 'ck_live_…')})`,
  'POST /api/v1/impersonation/verify': (a) => `steward.impersonation.verify(${lit(((a.body ?? {}) as { token?: string }).token ?? 'imp_…')})`,
  'GET /api/v1/events': (a) => `steward.events.list(${obj(nonEmpty(a.q))})`,
  'GET /api/v1/webhook-endpoints': () => 'steward.webhookEndpoints.list()',
  'POST /api/v1/webhook-endpoints': (a) => `steward.webhookEndpoints.create(${obj(a.body)})`,
  'DELETE /api/v1/webhook-endpoints/{id}': (a) => `steward.webhookEndpoints.delete(${lit(a.p.id)})`,
};

export function sdkSnippet(base: string, input: RequestInput): string | null {
  const build = SDK[`${input.method} ${input.path}`];
  if (!build) return null;
  const p = Object.fromEntries(Object.entries(input.pathParams).map(([k, v]) => [k, v || paramExample(input.path, k)]));
  const call = build({ p, q: input.query, body: input.body ?? {} });
  return `import { Steward } from '@steward/node';\n\nconst steward = new Steward({\n  apiKey: process.env.STEWARD_API_KEY!,\n  baseUrl: '${base}',\n});\n\nconst result = await ${call};`;
}

/** `inline code` in operation descriptions. */
export function splitCode(text: string): { code: boolean; text: string }[] {
  return text.split(/(`[^`]+`)/g).filter(Boolean).map((part) => (part.startsWith('`') && part.endsWith('`') ? { code: true, text: part.slice(1, -1) } : { code: false, text: part }));
}
