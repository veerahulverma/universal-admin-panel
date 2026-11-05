/**
 * Steward plugin SDK.
 *
 * A plugin is a folder with `plugin.json` (the manifest) and an ES module that
 * exports `activate(ctx)` and optionally `deactivate()`. Everything a plugin
 * does goes through `ctx`; each capability must be declared in the manifest's
 * `permissions` and approved by an administrator before activation.
 */

export type PluginPermission =
  | 'settings'
  | 'secrets'
  | 'kv'
  | 'users:read'
  | 'routes'
  | 'jobs'
  | 'gateway'
  | 'push'
  | `http:${string}`
  | `events:${string}`
  | `hooks:${PluginHookName}`;

export type PluginHookName = 'entitlements.resolve' | 'admin.nav' | 'reports.dashboard.kpis' | 'system.health' | 'marketing.list_providers';

export interface PluginManifest {
  /** Lowercase letters, digits and dashes. Unique per installation. */
  id: string;
  name: string;
  /** Semantic version, e.g. 1.2.3. */
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  type?: 'extension' | 'payment_gateway' | 'integration' | 'theme';
  /** Compatible platform versions, e.g. ">=0.1.0 <2.0.0". */
  engine?: string;
  /** Entry module (default index.js). */
  main?: string;
  permissions?: PluginPermission[];
  /** Other plugins that must be active, with version ranges. */
  dependencies?: Record<string, string>;
  /** JSON Schema (object with typed properties) for the settings form. */
  settingsSchema?: Record<string, unknown>;
  /** Credentials stored encrypted by the platform. */
  secrets?: { key: string; label: string; required?: boolean }[];
  /** Pages rendered in a sandboxed iframe in the admin panel (served by your routes). */
  adminPages?: { id: string; title: string; path: string }[];
}

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  data: T;
  userId: string | null;
  orgId: string | null;
  createdAt: Date;
}

export interface PluginRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  rawBody: string | null;
  headers: Record<string, string>;
  /** Present for routes registered with auth: 'admin'. */
  admin: { id: string; email: string } | null;
}

export interface PluginResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PluginContext {
  plugin: { id: string; version: string };
  log: {
    info(message: string, context?: unknown): Promise<void>;
    warn(message: string, context?: unknown): Promise<void>;
    error(message: string, context?: unknown): Promise<void>;
  };
  /** Requires `settings`. */
  settings: { get<T = Record<string, unknown>>(): Promise<T> };
  /** Requires `secrets`. */
  secrets: { get(key: string): Promise<string | null> };
  /** Requires `kv`. Values are JSON, up to 64KB each, 1000 keys per plugin. */
  kv: { get<T = unknown>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
  /** Requires `users:read`. */
  users: { get(id: string): Promise<Record<string, unknown> | null>; list(opts?: { q?: string; limit?: number }): Promise<Record<string, unknown>[]> };
  /** Requires `http:<host>` for each host. HTTPS only; private networks are blocked. */
  http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | object }): Promise<HttpResponse> };
  /** Requires `events:<pattern>`. Handlers run in background jobs with retries. */
  events: { on(pattern: string, handler: (event: DomainEvent) => Promise<void> | void): Promise<void> };
  /** Requires `hooks:<name>`. Filters must be fast (2s budget) and side-effect free. */
  hooks: { filter<T = any>(name: PluginHookName, fn: (value: T, ctx: { subject?: { type: string; id: string } | null; adminId?: string | null; range?: unknown }) => T | Promise<T>): Promise<void> };
  /** Requires `routes`. Mounted at /api/plugins/<plugin id><path>. */
  routes: { register(def: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; auth?: 'public' | 'admin'; handler: (req: PluginRequest) => PluginResponse | Promise<PluginResponse> }): Promise<void> };
  /** Requires `jobs`. Minimum interval 60 seconds. */
  jobs: { schedule(name: string, intervalSeconds: number, handler: () => Promise<void> | void): Promise<void> };
  /** Requires `gateway`. */
  gateways: { register(adapter: GatewayAdapter): Promise<void> };
  /** Requires `push`. */
  push: { register(provider: PushProvider): Promise<void> };
}

// ---- Push notifications -------------------------------------------------------------

/** A customer to notify. `devices` holds the tokens your app registered for this provider (providers that target devices). */
export interface PushRecipient {
  userId: string;
  /** The customer's id in your application, when set. */
  externalId: string | null;
  devices: { id: string; token: string; platform: string }[];
}

export interface PushMessage {
  notificationId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  recipients: PushRecipient[];
}

export interface PushRecipientResult {
  userId: string;
  /** "skipped": nothing to deliver to (no subscribed device). */
  status: 'sent' | 'failed' | 'skipped';
  error?: string | null;
  providerMessageId?: string | null;
  /** Device ids that are no longer valid; Steward removes them. */
  invalidDeviceIds?: string[];
}

/**
 * Delivers push notifications through a provider. Steward decides who is notified and keeps the
 * history; throw to have a delivery retried (rate limits, outages), return "failed" for errors that
 * a retry will not fix.
 */
export interface PushProvider {
  key: string;
  name: string;
  description?: string;
  /** "users": the provider finds customers by id. "devices": it needs device tokens your app registers with Steward. */
  targets: 'users' | 'devices';
  status(): Promise<{ configured: boolean; message: string }>;
  send(message: PushMessage): Promise<{ results: PushRecipientResult[] }>;
}

// ---- Payment gateways -------------------------------------------------------------

export interface GatewayCapabilities {
  checkout: boolean;
  savePaymentMethod: boolean;
  offSessionCharge: boolean;
  refunds: boolean;
  partialRefunds: boolean;
  webhooks: boolean;
  currencies: string[] | '*';
  paymentMethods: string[];
}

export interface GatewayContext {
  gatewayId: string;
  mode: 'test' | 'live';
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  appUrl: string;
  webhookUrl: string;
  returnUrl: string;
  /** Permission-checked fetch (declare http:<provider host>). */
  fetch: typeof fetch;
}

export interface CheckoutRequest {
  checkoutId: string;
  amount: number;
  currency: string;
  description: string;
  lineItems: { description: string; amount: number; quantity: number }[];
  customer: { id: string; email: string | null; name: string | null; gatewayCustomerRef: string | null };
  successUrl: string;
  cancelUrl: string;
  savePaymentMethod: boolean;
  metadata: Record<string, string>;
}

export type GatewayEvent =
  | { type: 'payment.succeeded'; eventId: string; checkoutId?: string | null; invoiceId?: string | null; gatewayPaymentId: string; amount: number; currency: string; method?: { type: string; brand?: string | null; last4?: string | null }; customerRef?: string | null; paymentMethodRef?: string | null; fee?: number | null }
  | { type: 'payment.failed'; eventId: string; checkoutId?: string | null; invoiceId?: string | null; gatewayPaymentId?: string | null; failureCode: string; failureMessage: string }
  | { type: 'refund.succeeded'; eventId: string; gatewayPaymentId: string; gatewayRefundId: string; amount: number; currency: string }
  | { type: 'refund.failed'; eventId: string; gatewayRefundId: string; failureMessage: string }
  | { type: 'dispute.created'; eventId: string; gatewayPaymentId: string; gatewayDisputeId: string; amount: number; currency: string; reason: string | null; evidenceDueBy?: Date | null }
  | { type: 'dispute.closed'; eventId: string; gatewayDisputeId: string; outcome: 'won' | 'lost' }
  | { type: 'ignored'; eventId: string; reason: string };

export interface GatewayAdapter {
  key: string;
  name: string;
  description?: string;
  capabilities: GatewayCapabilities;
  secretFields?: { key: string; label: string; required: boolean; help?: string }[];
  testConnection(ctx: GatewayContext): Promise<{ ok: boolean; message: string }>;
  createCheckout(ctx: GatewayContext, req: CheckoutRequest): Promise<{ url: string; gatewaySessionId: string }>;
  chargeSaved?(ctx: GatewayContext, req: { invoiceId: string; amount: number; currency: string; customerRef: string | null; paymentMethodRef: string; description: string; idempotencyKey: string }): Promise<
    | { status: 'succeeded'; gatewayPaymentId: string; fee?: number | null }
    | { status: 'requires_action'; gatewayPaymentId: string }
    | { status: 'failed'; gatewayPaymentId: string | null; failureCode: string; failureMessage: string }
  >;
  refund?(ctx: GatewayContext, req: { gatewayPaymentId: string; amount: number; currency: string; reason: string | null; idempotencyKey: string }): Promise<{ status: 'succeeded' | 'pending'; gatewayRefundId: string } | { status: 'failed'; failureMessage: string }>;
  /** Verify the provider signature (throw an Error named "WebhookSignatureError" if invalid) and normalize. */
  parseWebhook(ctx: GatewayContext, req: { rawBody: string; headers: Record<string, string | string[] | undefined>; query: Record<string, string> }): Promise<GatewayEvent[]>;
  handleReturn?(ctx: GatewayContext, query: Record<string, string>): Promise<{ events: GatewayEvent[]; checkoutId: string | null }>;
}

export interface PluginModule {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

/** Identity helper for type inference: `export const { activate } = definePlugin({ activate(ctx) { ... } })`. */
export function definePlugin(plugin: PluginModule): PluginModule;

export interface MockContext extends PluginContext {
  /** Everything the plugin registered, for assertions. */
  registered: {
    events: Map<string, (event: DomainEvent) => unknown>;
    hooks: Map<string, (value: unknown, ctx: unknown) => unknown>;
    routes: Map<string, (req: PluginRequest) => unknown>;
    jobs: Map<string, () => unknown>;
    gateways: GatewayAdapter[];
    push: PushProvider[];
  };
  logs: { level: string; message: string; context?: unknown }[];
  kvStore: Map<string, unknown>;
  /** Simulate an event delivery. */
  emit(type: string, data: Record<string, unknown>): Promise<void>;
  /** Simulate an HTTP request to one of the plugin's routes. */
  request(method: string, path: string, init?: Partial<PluginRequest>): Promise<PluginResponse>;
}

/**
 * In-memory context for unit-testing a plugin without a running platform.
 * Permissions are enforced the same way the host enforces them.
 */
export function createMockContext(opts: {
  id?: string;
  permissions: PluginPermission[];
  settings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  users?: Record<string, unknown>[];
  fetch?: (url: string, init?: unknown) => Promise<HttpResponse>;
}): MockContext;
