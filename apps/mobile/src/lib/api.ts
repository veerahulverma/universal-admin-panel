/**
 * Admin API client for the mobile app. Uses a bearer session token (issued by
 * POST /api/admin/auth/login with client "mobile"), so no cookies or CSRF.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Me {
  admin: { id: string; email: string; name: string; totpEnabled: boolean; roles: { id: string; key: string; name: string }[]; orgScope: string[] | null; lastLoginAt: string | null };
  grants: string[];
  /** Expanded permission keys the admin holds. */
  permissions: string[];
  session: { id: string; mfaRequired: boolean; enrollmentRequired: boolean; reauthValidUntil: string | null; expiresAt: string };
}

export interface LoginResult {
  status: 'ok' | 'mfa_required' | 'mfa_enrollment_required';
  token?: string;
  expiresAt: string;
}

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface Kpi {
  key: string;
  label: string;
  value: number;
  previous: number | null;
  format: 'number' | 'money' | 'percent';
}

export interface Dashboard {
  currency: string;
  range: { from: string; to: string };
  kpis: Kpi[];
  series: { revenue: { date: string; value: number }[]; signups: { date: string; value: number }[] };
  recent: {
    users: { id: string; email: string; name: string | null; created_at: string }[];
    payments: { id: string; amount: number; currency: string; status: string; created_at: string; customer_label: string | null }[];
    security: { id: string; type: string; severity: string; created_at: string }[];
  };
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  status: 'active' | 'suspended' | 'banned' | 'pending';
  status_reason: string | null;
  country: string | null;
  lifetime_revenue: number;
  created_at: string;
  last_active_at: string | null;
  deleted_at: string | null;
  tags: string[];
  plan?: { name: string; key: string; status: string };
}

export interface UserDetail extends UserRow {
  external_id: string | null;
  phone: string | null;
  email_verified_at: string | null;
  last_login_at: string | null;
  last_login_ip: string | null;
  organizations: { id: string; name: string; role: string; status: string }[];
  activeSessions: number;
  notesCount: number;
  panels: {
    billing?: {
      subscriptions: { id: string; status: string; product_name: string; unit_amount: number; currency: string; interval: string | null; current_period_end: string; cancel_at_period_end: boolean }[];
      payments: { id: string; status: string; amount: number; amount_refunded: number; currency: string; created_at: string }[];
    };
  };
}

export interface SubscriptionRow {
  id: string;
  status: string;
  product_name: string;
  customer_label: string | null;
  unit_amount: number;
  interval: string | null;
  interval_count: number;
  currency: string;
  quantity: number;
  current_period_end: string;
  cancel_at_period_end: boolean;
}

export interface PaymentRow {
  id: string;
  status: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  method_type: string | null;
  method_details: { brand?: string; last4?: string } | null;
  customer_label: string | null;
  gateway_name: string | null;
  invoice_id: string | null;
  created_at: string;
}

export interface PaymentDetail extends PaymentRow {
  refunds: { id: string; amount: number; status: string; reason: string | null; created_at: string }[];
  refundable: boolean;
  partialRefunds: boolean;
}

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: 'info' | 'success' | 'warning' | 'critical';
  read_at: string | null;
  created_at: string;
}

export interface SecurityEventRow {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  subject_type: string | null;
  subject_id: string | null;
  ip: string | null;
  created_at: string;
}

export interface AuditRow {
  seq: number;
  id: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  created_at: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class AdminApi {
  constructor(
    readonly baseUrl: string,
    private token: string | null,
    private readonly onUnauthorized?: () => void,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  async request<T>(method: string, path: string, opts: { body?: unknown; query?: Query } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new ApiError(0, 'network_error', `Cannot reach the server (${(err as Error).message})`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const e = payload?.error ?? {};
      const error = new ApiError(res.status, e.code ?? `http_${res.status}`, e.message ?? `Request failed (${res.status})`, e.details);
      if (res.status === 401 && ['session_invalid', 'session_idle', 'unauthorized'].includes(error.code)) this.onUnauthorized?.();
      throw error;
    }
    return payload as T;
  }

  // ---- Auth ----------------------------------------------------------------------
  login(email: string, password: string) {
    return this.request<LoginResult>('POST', '/api/admin/auth/login', { body: { email, password, client: 'mobile' } });
  }
  verifyMfa(input: { code?: string; recoveryCode?: string }) {
    return this.request<{ status: 'ok' }>('POST', '/api/admin/auth/mfa', { body: input });
  }
  setupTotp() {
    return this.request<{ secret: string; otpauthUrl: string }>('POST', '/api/admin/auth/2fa/setup', { body: {} });
  }
  enableTotp(code: string) {
    return this.request<{ recoveryCodes: string[] }>('POST', '/api/admin/auth/2fa/enable', { body: { code } });
  }
  me() {
    return this.request<Me>('GET', '/api/admin/auth/me');
  }
  logout() {
    return this.request<{ ok: true }>('POST', '/api/admin/auth/logout', { body: {} });
  }
  reauth(password: string, code?: string) {
    return this.request<{ reauthValidUntil: string }>('POST', '/api/admin/auth/reauth', { body: { password, code: code || undefined } });
  }

  // ---- Data ------------------------------------------------------------------------
  dashboard(days = 30) {
    return this.request<Dashboard>('GET', '/api/admin/dashboard', { query: { days } });
  }
  users(q: { q?: string; status?: string; page?: number; pageSize?: number }) {
    return this.request<Page<UserRow>>('GET', '/api/admin/users', { query: q });
  }
  user(id: string) {
    return this.request<UserDetail>('GET', `/api/admin/users/${encodeURIComponent(id)}`);
  }
  setUserStatus(id: string, action: 'suspend' | 'ban' | 'reactivate', reason?: string) {
    return this.request<UserRow>('POST', `/api/admin/users/${encodeURIComponent(id)}/status`, { body: { action, reason: reason || undefined } });
  }
  revokeSessions(id: string) {
    return this.request<{ revoked: number }>('POST', `/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { body: {} });
  }
  subscriptions(q: { status?: string; q?: string; page?: number; pageSize?: number }) {
    return this.request<Page<SubscriptionRow>>('GET', '/api/admin/subscriptions', { query: q });
  }
  cancelSubscription(id: string, atPeriodEnd: boolean, reason?: string) {
    return this.request<SubscriptionRow>('POST', `/api/admin/subscriptions/${encodeURIComponent(id)}/cancel`, { body: { atPeriodEnd, reason } });
  }
  payments(q: { status?: string; q?: string; page?: number; pageSize?: number }) {
    return this.request<Page<PaymentRow>>('GET', '/api/admin/payments', { query: q });
  }
  payment(id: string) {
    return this.request<PaymentDetail>('GET', `/api/admin/payments/${encodeURIComponent(id)}`);
  }
  refund(id: string, amount: number, reason: string) {
    return this.request<{ status: string; approvalId?: string; refund?: { id: string; status: string } }>('POST', `/api/admin/payments/${encodeURIComponent(id)}/refunds`, { body: { amount, reason } });
  }
  notifications(q: { unread?: boolean; page?: number } = {}) {
    return this.request<Page<NotificationRow> & { unread: number }>('GET', '/api/admin/notifications', { query: { unread: q.unread ? 'true' : undefined, page: q.page } });
  }
  markNotificationsRead(ids?: string[]) {
    return this.request<{ updated: number }>('POST', '/api/admin/notifications/read', { body: ids ? { ids } : { all: true } });
  }
  securityEvents(q: { status?: string; severity?: string; page?: number }) {
    return this.request<Page<SecurityEventRow>>('GET', '/api/admin/security/events', { query: q });
  }
  updateSecurityEvent(id: string, status: SecurityEventRow['status']) {
    return this.request<SecurityEventRow>('PATCH', `/api/admin/security/events/${encodeURIComponent(id)}`, { body: { status } });
  }
  auditLogs(q: { q?: string; page?: number; pageSize?: number }) {
    return this.request<Page<AuditRow>>('GET', '/api/admin/audit-logs', { query: q });
  }
}
