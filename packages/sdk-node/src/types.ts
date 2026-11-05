/**
 * Response and request shapes of the Steward integration API (v1).
 * Timestamps are ISO-8601 strings; money is in minor units (cents) with an ISO currency code.
 */

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Who an operation applies to: a user, or an organization (optionally with the acting member). */
export interface Subject {
  userId?: string | null;
  orgId?: string | null;
}

export type UserStatusValue = 'active' | 'suspended' | 'banned' | 'pending';

export interface User {
  id: string;
  externalId: string | null;
  email: string;
  emailVerified: boolean;
  name: string | null;
  phone: string | null;
  avatarUrl: string | null;
  status: UserStatusValue;
  statusReason: string | null;
  suspendedUntil: string | null;
  locale: string | null;
  timezone: string | null;
  country: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
  metadata: Record<string, unknown>;
  marketingConsent: boolean;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserInput {
  email: string;
  externalId?: string;
  name?: string;
  phone?: string;
  avatarUrl?: string;
  locale?: string;
  timezone?: string;
  country?: string;
  registrationSource?: string;
  utm?: Record<string, string>;
  referralCode?: string;
  customFields?: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
  marketingConsent?: boolean;
  emailVerified?: boolean;
  status?: 'active' | 'pending';
}

export interface UserStatus {
  userId: string;
  status: UserStatusValue | 'deleted';
  /** False for suspended, banned, pending or deleted users. */
  allowed: boolean;
  reason: string | null;
}

export interface LoginEventInput {
  success: boolean;
  ip: string;
  userAgent?: string;
  country?: string;
  method?: string;
  failureReason?: string;
  /** Your session id; lets admins see and revoke the session. */
  sessionId?: string;
}

export interface Organization {
  id: string;
  externalId: string | null;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  ownerUserId: string | null;
  billingEmail: string | null;
  seatLimit: number | null;
  customDomain: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OrganizationInput {
  name: string;
  slug?: string;
  externalId?: string;
  ownerUserId?: string;
  billingEmail?: string;
  seatLimit?: number | null;
  customDomain?: string | null;
  customFields?: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  createdAt: string;
}

// ---- Catalog & entitlements ------------------------------------------------------

export interface Tier {
  upTo: number | null;
  unitAmount: number;
  flatAmount?: number;
}

export interface Price {
  id: string;
  productId: string;
  nickname: string | null;
  currency: string;
  type: 'recurring' | 'one_time';
  interval: 'day' | 'week' | 'month' | 'year' | null;
  intervalCount: number;
  pricingModel: 'flat' | 'per_seat' | 'usage' | 'tiered';
  unitAmount: number;
  meterKey: string | null;
  includedUnits: number;
  tiers: Tier[] | null;
  tierMode: 'graduated' | 'volume' | null;
  packageSize: number | null;
  taxBehavior: 'inclusive' | 'exclusive';
  introAmount: number | null;
  introCycles: number | null;
  minQuantity: number;
  maxQuantity: number | null;
  active: boolean;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: 'plan' | 'addon' | 'one_time' | 'credit_pack';
  planType: 'free' | 'paid' | 'lifetime' | 'custom' | null;
  subscriberType: 'user' | 'organization';
  trialDays: number;
  highlights: string[];
  metadata: Record<string, unknown>;
  prices: Price[];
  features: { key: string; name: string; type: string; unit: string | null; enabled: boolean; limit: number | null; unlimited: boolean; resetPeriod: string; value: unknown }[];
}

export interface FeatureEntitlement {
  key: string;
  type: 'boolean' | 'quota' | 'config';
  enabled: boolean;
  meter?: string | null;
  /** Quota limit; null means unlimited. */
  limit?: number | null;
  unlimited?: boolean;
  resetPeriod?: string;
  enforcement?: 'hard' | 'soft' | 'overage';
  /** Value of a config feature. */
  value?: unknown;
  used?: number;
  remaining?: number | null;
  resetsAt?: string | null;
}

export interface Entitlements {
  subject: { type: 'user' | 'organization'; id: string };
  plans: { productId: string; key: string; name: string; kind: string; origin: string; originId: string | null; status: string | null; quantity: number }[];
  features: Record<string, FeatureEntitlement>;
}

export interface FeatureCheck {
  allowed: boolean;
  reason?: 'unknown_feature' | 'not_in_plan' | 'limit_exceeded' | null;
  feature: string;
  limit?: number | null;
  used?: number;
  remaining?: number | null;
  enforcement?: string;
  resetsAt?: string | null;
  value?: unknown;
}

export interface GrantInput extends Subject {
  productKey: string;
  quantity?: number;
  endsAt?: string | Date;
  reason?: string;
  /** Idempotency: the same reference never grants twice. */
  reference?: string;
}

// ---- Usage & credits ---------------------------------------------------------------

export interface UsageInput extends Subject {
  meter: string;
  quantity?: number;
  /** Dimensions select weights, e.g. { model: 'large' }. */
  dimensions?: Record<string, string>;
  /** Generated automatically when omitted so SDK retries are never double-counted. */
  idempotencyKey?: string;
}

export interface UsageResult {
  allowed: boolean;
  duplicate?: boolean;
  reason?: 'limit_exceeded' | 'insufficient_credits' | 'not_in_plan' | 'unmetered';
  meter: string;
  quantity: number;
  used: number;
  limit: number | null;
  remaining: number | null;
  overage: number;
  enforcement: string | null;
  resetsAt: string | null;
  eventId?: string;
  reservationId?: string;
  expiresAt?: string;
  credits?: { type: string; charged: number; balance: number };
  warning?: 'approaching_limit' | 'limit_reached' | 'over_limit';
}

export interface MeterUsage {
  meter: string;
  name: string;
  unit: string;
  kind: 'counter' | 'gauge';
  feature: string | null;
  used: number;
  reserved: number;
  limit: number | null;
  unlimited: boolean;
  remaining: number | null;
  overage: number;
  enforcement: string | null;
  resetPeriod: string | null;
  periodStart: string;
  periodEnd: string | null;
  forecast: { projected: number; limitReachedAt: string | null } | null;
}

export interface CreditBalance {
  type: string;
  balance: number;
  updatedAt: string;
}

export interface CreditInput extends Subject {
  amount: number;
  creditType?: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface CreditGrantResult {
  balance: number;
  ledgerId: string;
  duplicate?: boolean;
}

export interface CreditConsumeResult {
  allowed: boolean;
  ok: boolean;
  charged: number;
  balance: number;
  duplicate?: boolean;
  reason: 'insufficient_credits' | null;
}

// ---- Billing ----------------------------------------------------------------------------

export interface CheckoutInput extends Subject {
  priceId: string;
  quantity?: number;
  couponCode?: string;
  successUrl?: string;
  cancelUrl?: string;
  /** Gateway id or adapter key (e.g. "stripe"); defaults to the platform's default gateway. */
  gateway?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSession {
  id: string;
  status: 'open' | 'completed';
  /** Redirect the customer here (null when the checkout completed immediately, e.g. a free trial). */
  url: string | null;
  amount: { subtotal: number; discount: number; tax: number; total: number; currency: string };
  subscriptionId?: string | null;
  orderId?: string | null;
  invoiceId?: string | null;
  trialDays?: number;
}

export interface CheckoutStatus {
  id: string;
  status: 'open' | 'completed' | 'expired' | 'canceled' | 'failed';
  url: string | null;
  total: number;
  currency: string;
  orderId: string | null;
  invoiceId: string | null;
  failureMessage: string | null;
  expiresAt: string;
}

export interface Subscription {
  id: string;
  status: 'incomplete' | 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'unpaid';
  productId: string;
  productKey?: string;
  productName?: string;
  priceId: string;
  quantity: number;
  currency: string;
  unitAmount?: number;
  interval?: string;
  intervalCount?: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
  pausedAt: string | null;
  scheduledChange: { priceId: string; quantity: number; requestedAt: string } | null;
  collectionMethod: 'charge_automatically' | 'send_invoice' | 'complimentary';
  createdAt: string;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  amountDue: number;
  amountPaid: number;
  amountRefunded: number;
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string | null;
  paidAt: string | null;
  subscriptionId: string | null;
  /** Hosted payment link for open invoices. */
  payUrl: string | null;
  createdAt: string;
}

export interface SubscriptionChange {
  priceId?: string;
  quantity?: number;
  timing?: 'immediate' | 'period_end' | 'auto';
  prorate?: boolean;
}

export interface SubscriptionChangeResult {
  subscription: Subscription;
  invoice: Invoice | null;
  /** True when the change takes effect at the end of the current period. */
  scheduled: boolean;
}

export interface BillingProfileInput {
  name?: string | null;
  company?: string | null;
  email?: string | null;
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
  taxId?: string | null;
  taxIdType?: string | null;
  taxExempt?: boolean;
  preferredCurrency?: string;
}

// ---- Developers -----------------------------------------------------------------------------

export interface CustomerSession {
  id: string;
  /** Short-lived token for the browser SDK (cs_...). */
  token: string;
  expiresAt: string;
}

export interface CustomerKeyInput extends Subject {
  name: string;
  scopes?: string[];
  rateLimitPerMinute?: number;
  /** Count each verified request against this usage meter. */
  meterKey?: string;
  expiresAt?: string | Date;
  /** 2-8 lowercase letters used as the key prefix (default "ck"). */
  prefix?: string;
}

export interface IssuedCustomerKey {
  id: string;
  /** The full key. Shown once; store only what you need. */
  key: string;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
}

export interface CustomerKey {
  id: string;
  userId: string | null;
  orgId: string | null;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface VerifiedCustomerKey {
  valid: boolean;
  reason?: 'invalid_key' | 'account_inactive' | 'rate_limited' | 'quota_exceeded';
  key?: { id: string; userId: string | null; orgId: string | null; scopes: string[]; name: string };
  rateLimit?: { limit: number; remaining: number; resetAt: string } | null;
  usage?: UsageResult | null;
  retryAfterSeconds?: number;
}

export interface ImpersonationSession {
  impersonationId: string;
  userId: string;
  /** Your app must block writes when true. */
  readOnly: boolean;
  expiresAt: string;
  admin: { id: string; name: string | null; email: string | null };
  reason: string;
}

export interface StewardEvent<T = Record<string, any>> {
  id: string;
  type: string;
  data: T;
  userId: string | null;
  orgId: string | null;
  created: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  orgId: string | null;
  createdAt: string;
}

export interface PingResult {
  ok: true;
  keyId: string;
  mode: 'live' | 'test';
  scopes: string[];
  orgId: string | null;
  apiVersion: string;
}

/** Where a protected resource stands for a customer. */
export type AccessState = 'available' | 'scheduled' | 'ended' | 'locked' | 'disabled' | 'inactive';

export interface AccessCheckInput extends Subject {
  /** A resource id (res_...), the path your app is about to serve, or an http(s) URL. */
  resource: string;
  /** The end user's IP address, recorded in the access log. */
  ip?: string;
}

export interface AccessCheck {
  allowed: boolean;
  /**
   * What granted access (plan, product, group, any_customer, unprotected) or why it was refused
   * (no_access, not_yet_available, access_ended, resource_disabled, account_inactive).
   */
  reason: string;
  /** When drip-released content opens for this customer. */
  availableAt: string | null;
  /** When access through a release window ends (or ended). */
  availableUntil: string | null;
  /** The protection that matched; `url` is only present for allowed links. */
  resource: { id: string; kind: string; title: string; url?: string | null } | null;
}

export interface AccessResource {
  id: string;
  kind: 'url' | 'folder' | 'page' | 'link' | 'file';
  title: string;
  description: string;
  path: string | null;
  /** Only for links the subject may open. */
  url: string | null;
  allowed: boolean;
  state: AccessState;
  reason: string;
  availableAt: string | null;
  availableUntil: string | null;
  matchedBy: { type: 'plan' | 'product' | 'group' | 'any_customer'; id: string | null; name: string } | null;
}

export interface CartInput extends Subject {
  items: { priceId: string; quantity?: number }[];
  couponCode?: string;
  gatewayId?: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CartCheckout {
  /** Gateway checkout session; null when nothing is left to pay. */
  id: string | null;
  status: 'open' | 'completed';
  url: string | null;
  invoiceId: string;
  orderId: string;
  amount: { subtotal: number; discount: number; tax: number; total: number; balanceApplied: number; amountDue: number; currency: string };
}

export interface VoucherRedemption {
  voucher: { id: string; name: string; kind: 'product' | 'credit'; productId: string | null; productName: string | null; quantity: number; accessDays: number | null; creditAmount: number | null; currency: string | null };
  grant: { id: string; startsAt: string; endsAt: string | null } | null;
  /** Account credit after redeeming a credit voucher. */
  balance: number | null;
}

export interface UserAgreements {
  accepted: Record<string, unknown>[];
  pending: Record<string, unknown>[];
}

export interface AgreementAcceptanceInput {
  versionId: string;
  /** The end user's IP address and browser, stored as evidence of acceptance. */
  ip?: string;
  userAgent?: string;
}

export type IntegrationHealthStatus = 'ok' | 'degraded' | 'down' | 'unknown' | 'disabled';

export interface IntegrationHealth {
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  lastRunAt: string | null;
  /** True for organization-scoped keys: only that organization's webhooks and keys are included. */
  scoped: boolean;
  counts: Record<IntegrationHealthStatus, number>;
  groups: { kind: string; label: string; note: string | null; checks: { key: string; status: IntegrationHealthStatus; since: string | null; [key: string]: unknown }[] }[];
}

export interface NotificationInput {
  userId: string;
  title: string;
  body?: string;
  /** Opened when the notification is tapped. */
  link?: string;
  /** Your own category, e.g. "report.ready". */
  type?: string;
  severity?: 'info' | 'success' | 'warning' | 'critical';
  data?: Record<string, unknown>;
  /** false: the notification center only, no push. Default true. */
  push?: boolean;
}

export interface CustomerNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
