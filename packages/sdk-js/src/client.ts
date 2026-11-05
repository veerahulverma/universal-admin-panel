import type {
  AgreementStatus,
  BillingProfile,
  BillingProfileInput,
  CartCheckout,
  CartParams,
  CheckoutParams,
  CheckoutSession,
  ContentDetail,
  ContentItem,
  CreditBalance,
  DownloadLink,
  Entitlements,
  Invoice,
  Me,
  MeterUsage,
  Notification,
  EmailPreferences,
  Optional,
  Plan,
  Subscription,
  VoucherRedemption,
} from './types.js';

export interface StewardClientOptions {
  /** Base URL of your Steward deployment (it must list your site's origin in its client origins setting). */
  baseUrl: string;
  /** Customer session token (cs_...) minted by your backend. */
  token?: string | null;
  /**
   * Called when there is no token or the current one expired. Fetch a fresh
   * customer session from your backend and return its token (or null when the
   * user is signed out). Concurrent calls are de-duplicated.
   */
  getToken?: () => Promise<string | null> | string | null;
  /** Called when the session cannot be refreshed (e.g. redirect to sign in). */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

export class StewardClientError extends Error {
  override readonly name = 'StewardClientError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const SESSION_CODES = new Set(['session_invalid', 'session_missing', 'unauthorized']);

interface RequestOpts {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  binary?: boolean;
}

/**
 * Browser client for self-service features. Uses a short-lived customer
 * session token, never a secret key, so it is safe to ship to browsers.
 *
 * ```ts
 * const steward = new StewardClient({ baseUrl: 'https://admin.example.com', getToken: () => fetch('/api/steward-session').then(r => r.json()).then(r => r.token) });
 * if (await steward.hasFeature('exports')) showExportButton();
 * ```
 */
export class StewardClient {
  private token: string | null;
  private refreshing: Promise<string | null> | null = null;
  private entitlementCache: { value: Entitlements; at: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: StewardClientOptions) {
    if (!opts?.baseUrl) throw new TypeError('StewardClient: baseUrl is required');
    if (opts.token && /^sk_(live|test)_/.test(opts.token)) throw new Error('StewardClient: never use a secret API key in the browser; mint a customer session on your backend');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  }

  setToken(token: string | null): void {
    this.token = token;
    this.entitlementCache = null;
  }

  private async refresh(): Promise<string | null> {
    if (!this.opts.getToken) return null;
    if (!this.refreshing) {
      this.refreshing = Promise.resolve(this.opts.getToken())
        .then((t) => {
          this.token = t ?? null;
          return this.token;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private async send(method: string, path: string, opts: RequestOpts, token: string | null): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return this.fetchImpl(url.toString(), {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        accept: opts.binary ? 'application/pdf' : 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit',
    });
  }

  private async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    let token = this.token ?? (await this.refresh());
    let res = await this.send(method, path, opts, token);
    if (res.status === 401 && this.opts.getToken) {
      const code = await res.clone().json().then((b: any) => b?.error?.code).catch(() => null);
      if (!code || SESSION_CODES.has(code)) {
        token = await this.refresh();
        if (token) res = await this.send(method, path, opts, token);
      }
    }
    if (res.status === 401) this.opts.onUnauthorized?.();
    if (!res.ok) {
      const payload: any = await res.json().catch(() => null);
      const e = payload?.error ?? {};
      throw new StewardClientError(res.status, e.code ?? `http_${res.status}`, e.message ?? `Request failed (${res.status})`, e.requestId ?? res.headers.get('x-request-id'), e.details);
    }
    if (res.status === 204) return undefined as T;
    if (opts.binary) return (await res.blob()) as T;
    return (await res.json()) as T;
  }

  /** Optional endpoints: resolve to `supported: false` when the platform module is not installed or enabled. */
  private async optional<T>(method: string, path: string, fallback: T, opts: RequestOpts = {}): Promise<Optional<T>> {
    try {
      const body = await this.request<{ data?: T } & Record<string, unknown>>(method, path, opts);
      return { supported: true, data: (body?.data ?? (body as unknown as T)) as T };
    } catch (err) {
      if (err instanceof StewardClientError && ((err.status === 404 && /^Route /.test(err.message)) || err.code === 'module_disabled')) {
        return { supported: false, data: fallback };
      }
      throw err;
    }
  }

  /** The signed-in customer and their organization. */
  me(): Promise<Me> {
    return this.request('GET', '/api/client/me');
  }

  /** Plans, features and quota usage. Cached for 30s unless `fresh`. */
  async entitlements(opts: { fresh?: boolean } = {}): Promise<Entitlements> {
    if (!opts.fresh && this.entitlementCache && Date.now() - this.entitlementCache.at < 30_000) return this.entitlementCache.value;
    const value = await this.request<Entitlements>('GET', '/api/client/entitlements');
    this.entitlementCache = { value, at: Date.now() };
    return value;
  }

  /** UI helper: is a feature enabled (and, for quotas, is anything left)? */
  async hasFeature(key: string): Promise<boolean> {
    const f = (await this.entitlements()).features[key];
    if (!f?.enabled) return false;
    return f.type !== 'quota' || f.unlimited === true || (f.remaining ?? 1) > 0;
  }

  async usage(): Promise<MeterUsage[]> {
    return (await this.request<{ data: MeterUsage[] }>('GET', '/api/client/usage')).data;
  }

  async credits(): Promise<CreditBalance[]> {
    return (await this.request<{ data: CreditBalance[] }>('GET', '/api/client/credits')).data;
  }

  async plans(opts: { currency?: string } = {}): Promise<Plan[]> {
    return (await this.request<{ data: Plan[] }>('GET', '/api/client/plans', { query: opts })).data;
  }

  /** Start a checkout. Redirect to `url`, or use {@link redirectToCheckout}. */
  checkout(params: CheckoutParams): Promise<CheckoutSession> {
    return this.request('POST', '/api/client/checkout', { body: { quantity: 1, ...params } });
  }

  /** Start a checkout and navigate there (or to `successUrl` when it completed immediately, e.g. a free trial). */
  async redirectToCheckout(params: CheckoutParams): Promise<CheckoutSession> {
    const session = await this.checkout(params);
    const target = session.url ?? (session.status === 'completed' ? params.successUrl : null);
    if (target && typeof window !== 'undefined') window.location.assign(target);
    this.entitlementCache = null;
    return session;
  }

  /** Buy several products in one checkout. Redirect to `url`, or to your success page when `status` is `completed`. */
  async cartCheckout(params: CartParams): Promise<CartCheckout> {
    const result = await this.request<CartCheckout>('POST', '/api/client/cart/checkout', { body: params });
    this.entitlementCache = null;
    return result;
  }

  readonly vouchers = {
    /** Redeem a gift voucher code: grants its product (or account credit) to the signed-in customer, once. */
    redeem: async (code: string): Promise<VoucherRedemption> => {
      const result = await this.request<VoucherRedemption>('POST', '/api/client/vouchers/redeem', { body: { code } });
      this.entitlementCache = null;
      return result;
    },
  };

  readonly subscriptions = {
    list: async (): Promise<Subscription[]> => (await this.request<{ data: Subscription[] }>('GET', '/api/client/subscriptions')).data,
    /** Upgrades apply now (prorated); downgrades take effect at the period end. */
    change: (id: string, change: { priceId?: string; quantity?: number }) => this.subscriptionAction(id, 'change', change),
    /** Cancels at the end of the current period. */
    cancel: (id: string, opts: { reason?: string } = {}) => this.subscriptionAction(id, 'cancel', opts),
    reactivate: (id: string) => this.subscriptionAction(id, 'reactivate', {}),
  };

  private async subscriptionAction(id: string, action: string, body: Record<string, unknown>): Promise<{ subscription: Subscription; scheduled?: boolean; invoice?: Invoice | null }> {
    const result = await this.request<{ subscription: Subscription; scheduled?: boolean; invoice?: Invoice | null }>('POST', `/api/client/subscriptions/${encodeURIComponent(id)}/${action}`, { body });
    this.entitlementCache = null;
    return result;
  }

  readonly invoices = {
    list: async (opts: { page?: number; pageSize?: number } = {}): Promise<Invoice[]> => (await this.request<{ data: Invoice[] }>('GET', '/api/client/invoices', { query: opts })).data,
    /** PDF as a Blob (authenticated download). */
    pdf: (id: string): Promise<Blob> => this.request('GET', `/api/client/invoices/${encodeURIComponent(id)}/pdf`, { binary: true }),
    /** Object URL for the PDF (for <a download> or window.open). Call URL.revokeObjectURL when done. */
    pdfUrl: async (id: string): Promise<string> => URL.createObjectURL(await this.invoices.pdf(id)),
    /** Start paying an open invoice; returns the gateway URL. */
    pay: (id: string, opts: { gateway?: string; successUrl?: string; cancelUrl?: string } = {}): Promise<{ id: string; url: string }> =>
      this.request('POST', `/api/client/invoices/${encodeURIComponent(id)}/pay`, { body: opts }),
  };

  readonly billingProfile = {
    get: (): Promise<BillingProfile> => this.request('GET', '/api/client/billing-profile'),
    update: (input: BillingProfileInput): Promise<Record<string, unknown>> => this.request('PUT', '/api/client/billing-profile', { body: input }),
  };

  /** Push notifications to this browser or app (requires the notifications module on the platform). */
  readonly push = {
    /**
     * Subscribe this browser to web push: asks for permission, subscribes through your service worker
     * and registers the subscription. Call it from a user gesture (a click). Resolves to null when the
     * customer declines.
     */
    subscribeBrowser: async (registration: ServiceWorkerRegistration): Promise<PushSubscription | null> => {
      if (typeof Notification === 'undefined' || !('pushManager' in registration)) throw new Error('This browser does not support push notifications');
      if ((await Notification.requestPermission()) !== 'granted') return null;
      const { publicKey } = await this.request<{ publicKey: string }>('GET', '/api/public/push/vapid-public-key');
      const padded = (publicKey + '='.repeat((4 - (publicKey.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
      const applicationServerKey = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      const { endpoint, keys } = subscription.toJSON();
      await this.request('POST', '/api/client/push/subscriptions', { body: { endpoint, keys } });
      return subscription;
    },
    /** Stop web push to this browser. */
    unsubscribeBrowser: async (registration: ServiceWorkerRegistration): Promise<void> => {
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      await this.request('POST', '/api/client/push/subscriptions/remove', { body: { endpoint: subscription.endpoint } });
      await subscription.unsubscribe();
    },
    /** Register this app install's token from a push provider (for example a Firebase FCM token). */
    registerDevice: (input: { provider: string; token: string; platform?: 'ios' | 'android' | 'web' | 'other' }): Promise<{ id: string }> =>
      this.request('POST', '/api/client/push/devices', { body: input }),
    /** Stop push to this app install (on sign-out). */
    unregisterDevice: (token: string): Promise<{ removed: number }> => this.request('POST', '/api/client/push/devices/remove', { body: { token } }),
  };

  /** In-app notifications (requires the notifications module on the platform). */
  readonly notifications = {
    list: (opts: { unread?: boolean } = {}) => this.optional<Notification[]>('GET', '/api/client/notifications', [], { query: { unread: opts.unread ? 'true' : undefined } }),
    markRead: (ids: string[] | 'all') => this.optional<unknown>('POST', '/api/client/notifications/read', null, { body: ids === 'all' ? { all: true } : { ids } }),
  };

  /** Email subscription preferences (requires the email module on the platform). */
  readonly emailPreferences = {
    get: () => this.optional<EmailPreferences | null>('GET', '/api/client/email-preferences', null),
    /** Opt in to or out of marketing email. Transactional email (receipts, security) cannot be turned off. */
    setMarketing: (subscribed: boolean) => this.optional<{ ok: boolean; marketing: boolean } | null>('PUT', '/api/client/email-preferences', null, { body: { marketing: subscribed } }),
  };

  /** Terms and policies the customer must accept (requires agreements on the platform). */
  readonly agreements = {
    /** Required agreements still to accept (with their text), and those already accepted. */
    get: () => this.optional<AgreementStatus | null>('GET', '/api/client/agreements', null),
    /** Record acceptance of an agreement version; the platform stores when and from which address. */
    accept: (versionId: string) => this.request<Record<string, unknown>>('POST', `/api/client/agreements/${encodeURIComponent(versionId)}/accept`, { body: {} }),
  };

  /** Members-only pages, links and downloads (requires the access module on the platform). */
  readonly content = {
    /** What you can open now, what opens later (availableAt) and locked teasers. */
    list: () => this.optional<ContentItem[]>('GET', '/api/client/content', []),
    /** Open an item: a page's sanitized HTML, a link, or its files. Refusals are 403s whose code is the reason (e.g. not_yet_available). */
    get: (id: string): Promise<ContentDetail> => this.request('GET', `/api/client/content/${encodeURIComponent(id)}`),
    /** A signed, short-lived download URL. Each download through it counts against your limit for the file (429 when used up). */
    downloadLink: (id: string, fileId: string): Promise<DownloadLink> =>
      this.request('POST', `/api/client/content/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/link`, { body: {} }),
  };
}
