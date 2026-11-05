/** Shapes returned by the Steward client API (/api/client/*). Money is in minor units. */

export interface Me {
  user: {
    id: string;
    externalId: string | null;
    email: string;
    emailVerified: boolean;
    name: string | null;
    avatarUrl: string | null;
    status: string;
    locale: string | null;
    timezone: string | null;
    tags: string[];
    createdAt: string;
  };
  organization: { id: string; name: string; slug: string } | null;
}

export interface FeatureEntitlement {
  key: string;
  type: 'boolean' | 'quota' | 'config';
  enabled: boolean;
  meter?: string | null;
  limit?: number | null;
  unlimited?: boolean;
  resetPeriod?: string;
  enforcement?: 'hard' | 'soft' | 'overage';
  value?: unknown;
  used?: number;
  remaining?: number | null;
  resetsAt?: string | null;
}

export interface Entitlements {
  subject: { type: 'user' | 'organization'; id: string };
  plans: { productId: string; key: string; name: string; kind: string; origin: string; status: string | null; quantity: number }[];
  features: Record<string, FeatureEntitlement>;
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
  introAmount: number | null;
  introCycles: number | null;
  minQuantity: number;
  maxQuantity: number | null;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: 'plan' | 'addon' | 'one_time' | 'credit_pack';
  planType: string | null;
  trialDays: number;
  highlights: string[];
  prices: Price[];
  features: { key: string; name: string; type: string; unit: string | null; enabled: boolean; limit: number | null; unlimited: boolean; resetPeriod: string; value: unknown }[];
}

export interface CheckoutParams {
  priceId: string;
  quantity?: number;
  couponCode?: string;
  successUrl?: string;
  cancelUrl?: string;
  /** Gateway id or adapter key, e.g. "stripe". */
  gateway?: string;
}

export interface CheckoutSession {
  id: string;
  status: 'open' | 'completed';
  url: string | null;
  amount: { subtotal: number; discount: number; tax: number; total: number; currency: string };
  subscriptionId?: string | null;
  trialDays?: number;
}

export interface Subscription {
  id: string;
  status: string;
  productId: string;
  productKey?: string;
  productName?: string;
  priceId: string;
  quantity: number;
  currency: string;
  unitAmount?: number;
  interval?: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledChange: { priceId: string; quantity: number } | null;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  total: number;
  amountDue: number;
  amountPaid: number;
  dueAt: string | null;
  paidAt: string | null;
  payUrl: string | null;
  createdAt: string;
}

export interface BillingProfile {
  profile: {
    name: string | null;
    company: string | null;
    email: string | null;
    address: Record<string, string>;
    tax_id: string | null;
    tax_exempt: boolean;
  } | null;
  paymentMethods: { id: string; type: string; brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; is_default: boolean }[];
}

export interface BillingProfileInput {
  name?: string | null;
  company?: string | null;
  email?: string | null;
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
  taxId?: string | null;
  preferredCurrency?: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  readAt: string | null;
  createdAt: string;
}

/** Transactional categories are always on; marketing follows the customer's consent. */
export interface EmailPreferences {
  email: string;
  marketingConsent: boolean;
  categories: { category: string; subscribed: boolean; required: boolean }[];
}

/** Optional platform features (notifications, email preferences) report whether they are available. */
export interface Optional<T> {
  supported: boolean;
  data: T;
}

/** Download limit for one file: `remaining` and `limit` are null when unlimited. */
export interface DownloadAllowance {
  limit: number | null;
  period: 'day' | 'week' | 'month' | 'year' | 'lifetime';
  used: number;
  remaining: number | null;
  /** When the next download becomes possible again (only while the limit is reached). */
  resetsAt: string | null;
}

/** A members-only page, link, URL, folder or download as the signed-in customer sees it. */
export interface ContentItem {
  id: string;
  kind: 'url' | 'folder' | 'page' | 'link' | 'file';
  title: string;
  description: string;
  /** For protected URLs and folders. */
  path: string | null;
  fileCount?: number;
  /** available, scheduled (opens at availableAt), ended, or locked (a teaser the admin chose to show). */
  state: 'available' | 'scheduled' | 'ended' | 'locked';
  allowed: boolean;
  reason: string;
  availableAt: string | null;
  availableUntil: string | null;
}

export interface ContentFile {
  id: string;
  title: string;
  description: string;
  filename: string;
  contentType: string;
  size: number;
  download: DownloadAllowance;
}

export interface ContentDetail extends ContentItem {
  /** Sanitized HTML (pages only). */
  body?: string | null;
  /** Destination (links only). */
  url?: string | null;
  /** Downloadable files (downloads only). */
  files?: ContentFile[];
}

export interface DownloadLink {
  /** Works without credentials until `expiresAt`; each download counts against the limit. */
  url: string;
  expiresAt: string;
  file: { id: string; title: string; filename: string; size: number };
  download: DownloadAllowance;
}

export interface CartParams {
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

export interface AgreementVersion {
  agreementId: string;
  key: string;
  versionId: string;
  version: number;
  title: string;
  summary: string | null;
  effectiveAt: string;
  /** The text to show before asking for acceptance. */
  body?: string;
}

export interface AgreementStatus {
  pending: AgreementVersion[];
  accepted: { agreementId: string; key: string; versionId: string; version: number; title: string; acceptedAt: string; source: string; current: boolean; [key: string]: unknown }[];
}
