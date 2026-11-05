import { randomUUID } from 'node:crypto';
import { HttpClient, type Query } from './http.js';
import { TtlCache } from './cache.js';
import { StewardError } from './errors.js';
import { verifyWebhook, type VerifyOptions, type WebhookEvent } from './webhooks.js';
import type {
  AccessCheck,
  AccessCheckInput,
  AccessResource,
  AgreementAcceptanceInput,
  BillingProfileInput,
  CartCheckout,
  CartInput,
  CheckoutInput,
  CheckoutSession,
  CheckoutStatus,
  CreditBalance,
  CreditConsumeResult,
  CreditGrantResult,
  CreditInput,
  CustomerKey,
  CustomerNotification,
  CustomerKeyInput,
  CustomerSession,
  Entitlements,
  FeatureCheck,
  GrantInput,
  ImpersonationSession,
  Invoice,
  IntegrationHealth,
  IssuedCustomerKey,
  LoginEventInput,
  Member,
  NotificationInput,
  MeterUsage,
  Organization,
  OrganizationInput,
  Page,
  PingResult,
  Plan,
  StewardEvent,
  Subject,
  Subscription,
  SubscriptionChange,
  SubscriptionChangeResult,
  UsageInput,
  UsageResult,
  User,
  UserAgreements,
  UserInput,
  UserStatus,
  VerifiedCustomerKey,
  VoucherRedemption,
  WebhookEndpoint,
} from './types.js';

export interface StewardOptions {
  /** Secret API key (sk_live_... / sk_test_...). Never ship it to browsers. */
  apiKey: string;
  /** Base URL of your Steward deployment, e.g. https://admin.example.com. Defaults to STEWARD_URL. */
  baseUrl?: string;
  /** Retries for rate limits and transient failures (default 2). */
  maxRetries?: number;
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /**
   * Short-lived caches for hot paths. Entitlements default to 30s and user
   * status to 30s; set either to 0 to disable. Webhooks invalidate them
   * immediately when you route deliveries through `steward.webhooks.verify`.
   */
  cache?: { entitlementsTtlMs?: number; userStatusTtlMs?: number };
  /** Webhook signing secret(s) for `steward.webhooks.verify`. */
  webhookSecret?: string | string[];
}

const subjectKey = (s: Subject) => (s.orgId ? `org:${s.orgId}` : `user:${s.userId}`);
const enc = encodeURIComponent;

function requireSubject(s: Subject): void {
  if (!s.userId && !s.orgId) throw new TypeError('userId or orgId is required');
}

function iso(d: string | Date | undefined): string | undefined {
  return d instanceof Date ? d.toISOString() : d;
}

/**
 * Steward server-side client.
 *
 * ```ts
 * const steward = new Steward({ apiKey: process.env.STEWARD_API_KEY!, baseUrl: 'https://admin.example.com' });
 * await steward.users.upsert({ externalId: user.id, email: user.email });
 * const r = await steward.usage.consume({ userId, meter: 'api_calls' });
 * if (!r.allowed) return res.status(429).send('Quota exceeded');
 * ```
 */
export class Steward {
  private readonly http: HttpClient;
  private readonly entitlementCache: TtlCache<Entitlements>;
  private readonly statusCache: TtlCache<UserStatus>;
  private readonly webhookSecret?: string | string[];

  constructor(opts: StewardOptions) {
    if (!opts?.apiKey) throw new TypeError('Steward: apiKey is required');
    const g = globalThis as { window?: unknown; document?: unknown };
    if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined') {
      throw new Error('Steward: @steward/node must not run in a browser (it needs a secret key). Use @steward/js with a customer session instead.');
    }
    const baseUrl = opts.baseUrl ?? process.env.STEWARD_URL;
    if (!baseUrl) throw new TypeError('Steward: baseUrl is required (or set STEWARD_URL)');
    this.http = new HttpClient({
      apiKey: opts.apiKey,
      baseUrl,
      maxRetries: opts.maxRetries ?? 2,
      timeoutMs: opts.timeoutMs ?? 30_000,
      fetch: opts.fetch ?? globalThis.fetch,
      userAgent: `steward-node/0.1.0 node/${process.versions.node}`,
    });
    this.entitlementCache = new TtlCache(opts.cache?.entitlementsTtlMs ?? 30_000);
    this.statusCache = new TtlCache(opts.cache?.userStatusTtlMs ?? 30_000);
    this.webhookSecret = opts.webhookSecret;
  }

  /** Check the API key: returns its mode, scopes and organization scope. */
  ping(): Promise<PingResult> {
    return this.http.request({ method: 'GET', path: '/api/v1/ping' });
  }

  /** Drop cached entitlements and status for a subject (or everything). */
  invalidate(subject?: Subject): void {
    if (!subject) {
      this.entitlementCache.clear();
      this.statusCache.clear();
      return;
    }
    if (subject.orgId) this.entitlementCache.deletePrefix(`org:${subject.orgId}`);
    if (subject.userId) {
      this.entitlementCache.delete(`user:${subject.userId}`);
      this.statusCache.delete(subject.userId);
    }
  }

  // ---- Users ---------------------------------------------------------------------
  readonly users = {
    /** Create or update a user, matched by externalId (preferred) or email. Safe to call on every login. */
    upsert: (input: UserInput) => this.http.request<{ user: User; created: boolean }>({ method: 'POST', path: '/api/v1/users', body: input, idempotent: true }),
    get: async (id: string) => (await this.http.request<{ user: User }>({ method: 'GET', path: `/api/v1/users/${enc(id)}` })).user,
    /** Look up by your own user id; null if unknown. */
    getByExternalId: async (externalId: string): Promise<User | null> => {
      try {
        return (await this.http.request<{ user: User }>({ method: 'GET', path: `/api/v1/users/external/${enc(externalId)}` })).user;
      } catch (err) {
        if (err instanceof StewardError && err.status === 404) return null;
        throw err;
      }
    },
    list: (params: { email?: string; externalId?: string; status?: string; page?: number; pageSize?: number } = {}) =>
      this.http.request<Page<User>>({ method: 'GET', path: '/api/v1/users', query: params as Query }),
    update: async (id: string, patch: Partial<Omit<UserInput, 'status'>>) => {
      const r = await this.http.request<{ user: User }>({ method: 'PATCH', path: `/api/v1/users/${enc(id)}`, body: patch });
      this.invalidate({ userId: id });
      return r.user;
    },
    delete: async (id: string) => {
      await this.http.request<void>({ method: 'DELETE', path: `/api/v1/users/${enc(id)}` });
      this.invalidate({ userId: id });
    },
    /**
     * Whether the user may use your app right now (false if suspended, banned or
     * deleted). Cached briefly; pass `{ fresh: true }` to bypass the cache.
     */
    status: async (id: string, opts: { fresh?: boolean } = {}): Promise<UserStatus> => {
      const cached = opts.fresh ? undefined : this.statusCache.get(id);
      if (cached) return cached;
      const status = await this.http.request<UserStatus>({ method: 'GET', path: `/api/v1/users/${enc(id)}/status` });
      this.statusCache.set(id, status);
      return status;
    },
    suspend: async (id: string, opts: { reason?: string; until?: string | Date } = {}) => {
      const r = await this.http.request<{ user: User }>({ method: 'POST', path: `/api/v1/users/${enc(id)}/suspend`, body: { action: 'suspend', reason: opts.reason, until: iso(opts.until) }, idempotent: true });
      this.invalidate({ userId: id });
      return r.user;
    },
    reactivate: async (id: string) => {
      const r = await this.http.request<{ user: User }>({ method: 'POST', path: `/api/v1/users/${enc(id)}/suspend`, body: { action: 'reactivate' }, idempotent: true });
      this.invalidate({ userId: id });
      return r.user;
    },
    /** Mark the user active (feeds active-user metrics; throttled server-side). */
    trackActivity: async (id: string) => {
      await this.http.request({ method: 'POST', path: `/api/v1/users/${enc(id)}/activity`, idempotent: true });
    },
    /** Report a login from your own auth system (login history, new-device and brute-force detection). */
    recordLogin: async (id: string, event: LoginEventInput) => {
      await this.http.request({ method: 'POST', path: `/api/v1/users/${enc(id)}/login-events`, body: event });
    },
    revokeSessions: (id: string) => this.http.request<{ revoked: number }>({ method: 'POST', path: `/api/v1/users/${enc(id)}/sessions/revoke`, idempotent: true }),
  };

  // ---- Organizations -------------------------------------------------------------------
  readonly organizations = {
    /** Create, or update by externalId. */
    upsert: (input: OrganizationInput) => this.http.request<{ organization: Organization; created: boolean }>({ method: 'POST', path: '/api/v1/organizations', body: input, idempotent: Boolean(input.externalId) }),
    get: async (id: string) => (await this.http.request<{ organization: Organization }>({ method: 'GET', path: `/api/v1/organizations/${enc(id)}` })).organization,
    update: async (id: string, patch: Partial<Omit<OrganizationInput, 'ownerUserId'>>) =>
      (await this.http.request<{ organization: Organization }>({ method: 'PATCH', path: `/api/v1/organizations/${enc(id)}`, body: patch })).organization,
    members: {
      list: async (orgId: string) => (await this.http.request<{ data: Member[] }>({ method: 'GET', path: `/api/v1/organizations/${enc(orgId)}/members` })).data,
      /** Add a member or change their role. */
      set: async (orgId: string, userId: string, role = 'member') => {
        await this.http.request({ method: 'PUT', path: `/api/v1/organizations/${enc(orgId)}/members/${enc(userId)}`, body: { role } });
        this.invalidate({ orgId });
      },
      remove: async (orgId: string, userId: string) => {
        await this.http.request({ method: 'DELETE', path: `/api/v1/organizations/${enc(orgId)}/members/${enc(userId)}` });
        this.invalidate({ orgId });
      },
    },
  };

  // ---- Catalog & entitlements ------------------------------------------------------------
  readonly plans = {
    /** Public plans, add-ons and prices for your pricing page. */
    list: async (opts: { currency?: string } = {}) => (await this.http.request<{ data: Plan[] }>({ method: 'GET', path: '/api/v1/plans', query: opts })).data,
  };

  readonly entitlements = {
    /** Everything the subject can access, with quota usage. Cached briefly unless `fresh`. */
    get: async (subject: Subject, opts: { fresh?: boolean } = {}): Promise<Entitlements> => {
      requireSubject(subject);
      const key = subjectKey(subject) + (subject.orgId && subject.userId ? `:${subject.userId}` : '');
      const cached = opts.fresh ? undefined : this.entitlementCache.get(key);
      if (cached) return cached;
      const ent = await this.http.request<Entitlements>({ method: 'GET', path: '/api/v1/entitlements', query: { userId: subject.userId, orgId: subject.orgId } });
      this.entitlementCache.set(key, ent);
      return ent;
    },
    /** Server-side decision for a feature and quantity (always fresh; does not record usage). */
    check: (input: Subject & { feature: string; quantity?: number }) => {
      requireSubject(input);
      return this.http.request<FeatureCheck>({ method: 'POST', path: '/api/v1/entitlements/check', body: input, idempotent: true });
    },
    /** Local check of a boolean or config feature against cached entitlements (fast path for UI decisions). */
    has: async (subject: Subject, feature: string): Promise<boolean> => {
      const ent = await this.entitlements.get(subject);
      return Boolean(ent.features[feature]?.enabled);
    },
    /** Value of a config feature (e.g. support tier). */
    value: async <T = unknown>(subject: Subject, feature: string): Promise<T | null> => {
      const ent = await this.entitlements.get(subject);
      return (ent.features[feature]?.value as T) ?? null;
    },
    /** Grant a product (promotion, referral reward). Pass `reference` to make it idempotent. */
    grant: async (input: GrantInput) => {
      requireSubject(input);
      const r = await this.http.request<Record<string, unknown>>({ method: 'POST', path: '/api/v1/entitlements/grants', body: { ...input, endsAt: iso(input.endsAt) }, idempotent: Boolean(input.reference) });
      this.invalidate(input);
      return r;
    },
  };

  // ---- Content access ----------------------------------------------------------------------
  readonly access = {
    /**
     * May the subject open a protected resource right now? Pass a resource id or the path
     * (or URL) your app is about to serve; a path nothing protects is allowed with reason
     * "unprotected". Every check is recorded in the access log. Needs the access:read scope.
     */
    check: (input: AccessCheckInput) => {
      requireSubject(input);
      return this.http.request<AccessCheck>({ method: 'POST', path: '/api/v1/access/check', body: input, idempotent: true });
    },
    /** Every protected resource with its state for the subject: open, scheduled (availableAt), ended or locked. */
    resources: async (subject: Subject) => {
      requireSubject(subject);
      return (await this.http.request<{ data: AccessResource[] }>({ method: 'GET', path: '/api/v1/access/resources', query: { userId: subject.userId, orgId: subject.orgId } })).data;
    },
  };

  // ---- Usage & credits ------------------------------------------------------------------------
  private usageBody(input: UsageInput) {
    requireSubject(input);
    return { ...input, quantity: input.quantity ?? 1, idempotencyKey: input.idempotencyKey ?? randomUUID() };
  }

  readonly usage = {
    /**
     * Atomically check the quota and record usage. `allowed: false` means
     * nothing was recorded. An idempotency key is generated when you do not
     * pass one, so automatic retries are never double-counted.
     */
    consume: (input: UsageInput) => this.http.request<UsageResult>({ method: 'POST', path: '/api/v1/usage/consume', body: this.usageBody(input), idempotent: true }),
    /** Record usage that already happened (never denied; overage is tracked). */
    record: (input: UsageInput) => this.http.request<UsageResult>({ method: 'POST', path: '/api/v1/usage/record', body: this.usageBody(input), idempotent: true }),
    /** Hold quota (and credits) for a long-running task. Commit or release it afterwards. */
    reserve: (input: UsageInput & { ttlSeconds?: number }) =>
      this.http.request<UsageResult>({ method: 'POST', path: '/api/v1/usage/reserve', body: this.usageBody(input), idempotent: true }),
    /** Convert a reservation to usage; `quantity` defaults to the reserved amount. Idempotent. */
    commit: (reservationId: string, quantity?: number) =>
      this.http.request<UsageResult>({ method: 'POST', path: `/api/v1/usage/reservations/${enc(reservationId)}/commit`, body: quantity === undefined ? {} : { quantity }, idempotent: true }),
    release: (reservationId: string) => this.http.request<{ released: boolean }>({ method: 'POST', path: `/api/v1/usage/reservations/${enc(reservationId)}/release`, idempotent: true }),
    /** Set a gauge meter (projects, seats, storage) to its current level; enforces the limit. */
    setGauge: (meter: string, input: Subject & { value: number }) => {
      requireSubject(input);
      return this.http.request<UsageResult>({ method: 'PUT', path: `/api/v1/usage/gauges/${enc(meter)}`, body: input });
    },
    /** Usage, limits and forecasts for every meter. */
    summary: async (subject: Subject) => {
      requireSubject(subject);
      return (await this.http.request<{ data: MeterUsage[] }>({ method: 'GET', path: '/api/v1/usage', query: { userId: subject.userId, orgId: subject.orgId } })).data;
    },
    /**
     * Run `task` inside a reservation: reserve, run, commit what the task
     * reports (or the reserved amount), and release on failure.
     */
    withReservation: async <T>(input: UsageInput & { ttlSeconds?: number }, task: () => Promise<{ result: T; quantity?: number }>): Promise<{ allowed: true; result: T; usage: UsageResult } | { allowed: false; usage: UsageResult }> => {
      const hold = await this.usage.reserve(input);
      if (!hold.allowed || !hold.reservationId) return { allowed: false, usage: hold };
      try {
        const { result, quantity } = await task();
        return { allowed: true, result, usage: await this.usage.commit(hold.reservationId, quantity) };
      } catch (err) {
        await this.usage.release(hold.reservationId).catch(() => undefined);
        throw err;
      }
    },
  };

  readonly credits = {
    balances: async (subject: Subject) => {
      requireSubject(subject);
      return (await this.http.request<{ data: CreditBalance[] }>({ method: 'GET', path: '/api/v1/credits', query: { userId: subject.userId, orgId: subject.orgId } })).data;
    },
    grant: (input: CreditInput & { expiresAt?: string | Date }) => {
      requireSubject(input);
      return this.http.request<CreditGrantResult>({
        method: 'POST',
        path: '/api/v1/credits/grant',
        body: { ...input, expiresAt: iso(input.expiresAt), idempotencyKey: input.idempotencyKey ?? randomUUID() },
        idempotent: true,
      });
    },
    /** Spend credits atomically; `allowed: false` when the balance is too low (nothing is spent). */
    consume: (input: CreditInput) => {
      requireSubject(input);
      return this.http.request<CreditConsumeResult>({ method: 'POST', path: '/api/v1/credits/consume', body: { ...input, idempotencyKey: input.idempotencyKey ?? randomUUID() }, idempotent: true });
    },
  };

  // ---- Billing ------------------------------------------------------------------------------
  readonly checkout = {
    /** Start a checkout; redirect the customer to `url` (null when it completed immediately). */
    create: (input: CheckoutInput) => {
      requireSubject(input);
      return this.http.request<CheckoutSession>({ method: 'POST', path: '/api/v1/checkout/sessions', body: input });
    },
    get: (id: string) => this.http.request<CheckoutStatus>({ method: 'GET', path: `/api/v1/checkout/sessions/${enc(id)}` }),
    /**
     * Buy several products in one purchase: one invoice, paid at `url`. Plans start and products are
     * granted when it is paid; `status: completed` when discounts or account credit cover it.
     */
    cart: (input: CartInput) => {
      requireSubject(input);
      return this.http.request<CartCheckout>({ method: 'POST', path: '/api/v1/checkout/cart', body: input });
    },
  };

  readonly vouchers = {
    /** Redeem a gift voucher for a customer: grants its product (or account credit), exactly once. Needs checkout:write. */
    redeem: (input: Subject & { code: string }) => {
      requireSubject(input);
      return this.http.request<VoucherRedemption>({ method: 'POST', path: '/api/v1/vouchers/redeem', body: input });
    },
  };

  readonly subscriptions = {
    list: async (subject: Subject) => {
      requireSubject(subject);
      return (await this.http.request<{ data: Subscription[] }>({ method: 'GET', path: '/api/v1/subscriptions', query: { userId: subject.userId, orgId: subject.orgId } })).data;
    },
    /** Upgrade, downgrade or change seats. Downgrades wait for the period end unless `timing: 'immediate'`. */
    change: (id: string, change: SubscriptionChange) => this.subscriptionAction<SubscriptionChangeResult>(id, 'change', { ...change }),
    cancel: (id: string, opts: { atPeriodEnd?: boolean; reason?: string } = {}) => this.subscriptionAction<{ subscription: Subscription }>(id, 'cancel', { atPeriodEnd: opts.atPeriodEnd ?? true, reason: opts.reason }),
    reactivate: (id: string) => this.subscriptionAction<{ subscription: Subscription }>(id, 'reactivate', {}),
    pause: (id: string, opts: { resumeAt?: string | Date } = {}) => this.subscriptionAction<{ subscription: Subscription }>(id, 'pause', { resumeAt: iso(opts.resumeAt) }),
    resume: (id: string) => this.subscriptionAction<{ subscription: Subscription; invoice: Invoice | null }>(id, 'resume', {}),
  };

  private async subscriptionAction<T>(id: string, action: string, body: Record<string, unknown>): Promise<T> {
    const result = await this.http.request<T>({ method: 'POST', path: `/api/v1/subscriptions/${enc(id)}/${action}`, body });
    this.entitlementCache.clear();
    return result;
  }

  readonly invoices = {
    list: async (subject: Subject & { page?: number; pageSize?: number }) => {
      requireSubject(subject);
      return (await this.http.request<{ data: Invoice[] }>({ method: 'GET', path: '/api/v1/invoices', query: subject as Query })).data;
    },
    /** Invoice PDF bytes. */
    pdf: (id: string) => this.http.request<Uint8Array>({ method: 'GET', path: `/api/v1/invoices/${enc(id)}/pdf`, binary: true }),
  };

  readonly billingProfile = {
    /** Billing name, address and tax ID (they drive tax calculation and appear on invoices). */
    update: (input: Subject & BillingProfileInput) => {
      requireSubject(input);
      return this.http.request<Record<string, unknown>>({ method: 'PUT', path: '/api/v1/billing-profile', body: input });
    },
  };

  // ---- Developers ---------------------------------------------------------------------------
  readonly customerSessions = {
    /** Mint a short-lived token for the browser SDK after you authenticate the user. */
    create: (input: { userId: string; orgId?: string; ttlMinutes?: number }) => this.http.request<CustomerSession>({ method: 'POST', path: '/api/v1/customer-sessions', body: input }),
    revoke: async (id: string) => {
      await this.http.request({ method: 'DELETE', path: `/api/v1/customer-sessions/${enc(id)}` });
    },
  };

  readonly customerKeys = {
    /** Issue an API key to one of your customers (for an API product you sell). */
    issue: (input: CustomerKeyInput) => {
      requireSubject(input);
      return this.http.request<IssuedCustomerKey>({ method: 'POST', path: '/api/v1/customer-keys', body: { ...input, expiresAt: iso(input.expiresAt) } });
    },
    list: async (subject: Subject) => {
      requireSubject(subject);
      return (await this.http.request<{ data: CustomerKey[] }>({ method: 'GET', path: '/api/v1/customer-keys', query: { userId: subject.userId, orgId: subject.orgId } })).data;
    },
    revoke: async (id: string) => {
      await this.http.request({ method: 'DELETE', path: `/api/v1/customer-keys/${enc(id)}` });
    },
    /** Verify a key presented to your API: validity, per-key rate limit and (if metered) quota. */
    verify: (key: string, opts: { ip?: string; quantity?: number } = {}) =>
      this.http.request<VerifiedCustomerKey>({ method: 'POST', path: '/api/v1/customer-keys/verify', body: { key, ...opts } }),
  };

  // ---- Notifications -----------------------------------------------------------------------
  readonly notifications = {
    /**
     * Add a notification to a customer's notification center and push it to their browsers and
     * apps (set `push: false` for the notification center only). Needs notifications:write.
     */
    send: (input: NotificationInput) => this.http.request<{ id: string }>({ method: 'POST', path: '/api/v1/notifications', body: input }),
    /** A customer's notifications, newest first. Needs notifications:read. */
    list: (userId: string, opts: { unread?: boolean; page?: number; pageSize?: number } = {}) =>
      this.http.request<Page<CustomerNotification>>({ method: 'GET', path: '/api/v1/notifications', query: { userId, unread: opts.unread ? 'true' : undefined, page: opts.page, pageSize: opts.pageSize } }),
  };

  readonly pushDevices = {
    /** Register a customer's app install (a device token from your push provider, e.g. Firebase) from your backend. */
    register: (userId: string, input: { provider: string; token: string; platform?: 'ios' | 'android' | 'web' | 'other' }) =>
      this.http.request<{ id: string }>({ method: 'POST', path: `/api/v1/users/${enc(userId)}/push-devices`, body: input }),
    /** Stop push to one of a customer's app installs. */
    remove: (userId: string, token: string) => this.http.request<{ removed: number }>({ method: 'POST', path: `/api/v1/users/${enc(userId)}/push-devices/remove`, body: { token } }),
  };

  readonly agreements = {
    /** What a user accepted (version, when, from where) and required agreements still pending. Needs users:read. */
    forUser: (userId: string) => this.http.request<UserAgreements>({ method: 'GET', path: `/api/v1/users/${enc(userId)}/agreements` }),
    /** Record that a user accepted an agreement version in your own signup or settings screen. Needs users:write. */
    accept: (userId: string, input: AgreementAcceptanceInput) =>
      this.http.request<Record<string, unknown>>({ method: 'POST', path: `/api/v1/users/${enc(userId)}/agreements/accept`, body: input }),
  };

  /** Webhooks, API keys, gateways, email providers and plugins: what is healthy and what needs attention. Needs health:read. */
  integrationHealth(): Promise<IntegrationHealth> {
    return this.http.request({ method: 'GET', path: '/api/v1/integration-health' });
  }

  readonly impersonation = {
    /** Exchange a one-time `imp_...` token. Show a visible banner and honour `readOnly`. */
    verify: (token: string) => this.http.request<ImpersonationSession>({ method: 'POST', path: '/api/v1/impersonation/verify', body: { token } }),
  };

  readonly events = {
    list: (params: { type?: string; after?: string; limit?: number } = {}) =>
      this.http.request<{ data: StewardEvent[]; hasMore: boolean }>({ method: 'GET', path: '/api/v1/events', query: params }),
    /** Iterate events after a cursor (polling alternative to webhooks). Stops when caught up. */
    iterate: (params: { type?: string; after?: string; pageSize?: number } = {}): AsyncGenerator<StewardEvent> => this.iterateEvents(params),
  };

  private async *iterateEvents(params: { type?: string; after?: string; pageSize?: number }): AsyncGenerator<StewardEvent> {
    let after = params.after;
    for (;;) {
      const page = await this.events.list({ type: params.type, after, limit: params.pageSize ?? 100 });
      for (const e of page.data) yield e;
      if (!page.hasMore || !page.data.length) return;
      after = page.data[page.data.length - 1].id;
    }
  }

  readonly webhookEndpoints = {
    list: async () => (await this.http.request<{ data: WebhookEndpoint[] }>({ method: 'GET', path: '/api/v1/webhook-endpoints' })).data,
    /** Register an endpoint; the signing secret is returned once. */
    create: (input: { url: string; description?: string; events?: string[] }) =>
      this.http.request<{ id: string; secret: string }>({ method: 'POST', path: '/api/v1/webhook-endpoints', body: input }),
    delete: async (id: string) => {
      await this.http.request({ method: 'DELETE', path: `/api/v1/webhook-endpoints/${enc(id)}` });
    },
  };

  readonly webhooks = {
    /**
     * Verify a delivery with the configured secret and return the event. Also
     * drops cached entitlements/status for the affected subject, so access
     * changes take effect immediately.
     */
    verify: <T = Record<string, any>>(rawBody: string | Buffer | Uint8Array, signatureHeader: string | string[] | null | undefined, opts?: VerifyOptions): WebhookEvent<T> => {
      if (!this.webhookSecret) throw new TypeError('Steward: set webhookSecret to verify webhooks');
      const event = verifyWebhook<T>(rawBody, signatureHeader, this.webhookSecret, opts);
      if (/^(entitlements|subscription|user|organization)\./.test(event.type)) {
        this.invalidate({ userId: event.userId, orgId: event.orgId });
        const data = event.data as Record<string, unknown>;
        if (data?.subjectType === 'organization') this.invalidate({ orgId: String(data.subjectId) });
        if (data?.subjectType === 'user') this.invalidate({ userId: String(data.subjectId) });
      }
      return event;
    },
  };
}
