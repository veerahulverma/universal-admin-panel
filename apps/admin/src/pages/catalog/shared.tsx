import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, errorMessage } from '../../lib/api';
import { fromMinor, interval as intervalLabel, money, num, toMinor } from '../../lib/format';
import { useBootstrap } from '../../components/layout/AppShell';
import { Input } from '../../components/ui';

// ---- Types (shapes returned by the catalog module) ----------------------------------------

export type ProductKind = 'plan' | 'addon' | 'one_time' | 'credit_pack';

export interface Product {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: ProductKind;
  plan_type: 'free' | 'paid' | 'lifetime' | 'custom' | null;
  status: 'draft' | 'active' | 'archived';
  is_public: boolean;
  subscriber_type: 'user' | 'organization';
  sort_order: number;
  trial_days: number;
  trial_requires_payment_method: boolean;
  grace_days: number;
  credit_type: string | null;
  credit_amount: number | null;
  credits_expire_days: number | null;
  highlights: string[];
  metadata: Record<string, unknown>;
  gateway_refs: Record<string, unknown>;
  /** Customers must have, or buy at the same time, one of these products. */
  requires_products: string[];
  /** Customers who have, or buy at the same time, one of these products cannot buy this one. */
  excludes_products: string[];
  purchase_limit: number | null;
  stock_limit: number | null;
  created_at: string;
  updated_at: string;
  price_count?: number;
  feature_count?: number;
  active_subscriptions?: number;
}

/** Units sold (paid) and reserved (sales waiting for payment); available is null without a limit. */
export interface StockLevel {
  sold: number;
  reserved: number;
  available: number | null;
}

export interface ProductRef {
  id: string;
  key: string;
  name: string;
  kind: ProductKind;
  status: Product['status'];
}

export interface Tier {
  upTo: number | null;
  unitAmount: number;
  flatAmount: number;
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
  /** Installments: the subscription ends after this many payments (null = until cancelled). */
  paymentCount: number | null;
  afterLastPayment: 'end_access' | 'keep_access';
  /** One-time prices: days of access (null = for good). */
  accessDays: number | null;
  stockLimit: number | null;
  active: boolean;
  /** Present on the product detail. */
  stock?: StockLevel;
}

export interface ProductFeatureRow {
  feature_id: string;
  key: string;
  name: string;
  type: 'boolean' | 'quota' | 'config';
  meter_key: string | null;
  unit: string | null;
  enabled: boolean;
  limit_value: number | null;
  unlimited: boolean;
  reset_period: ResetPeriod;
  rolling_window_seconds: number | null;
  enforcement: Enforcement;
  warn_at_percent: number;
  grace_units: number;
  overage_unit_amount: number | null;
  per_seat: boolean;
  config_value: unknown;
}

export interface ProductDetail extends Product {
  prices: Price[];
  features: ProductFeatureRow[];
  stock: StockLevel & { limit: number | null };
  /** Products this bundle includes. */
  bundle: ProductRef[];
  /** Bundles that include this product. */
  includedIn: ProductRef[];
}

export interface Feature {
  id: string;
  key: string;
  name: string;
  description: string;
  type: 'boolean' | 'quota' | 'config';
  meter_key: string | null;
  unit: string | null;
  product_count: number;
  created_at: string;
}

export interface Meter {
  id: string;
  key: string;
  name: string;
  description: string;
  unit: string;
  kind: 'counter' | 'gauge';
  weights: Record<string, Record<string, number>>;
  credit_type: string | null;
  credits_per_unit: number | null;
  archived: boolean;
  feature_key: string | null;
  created_at: string;
}

export type ResetPeriod = 'none' | 'day' | 'week' | 'month' | 'year' | 'billing_period' | 'rolling';
export type Enforcement = 'hard' | 'soft' | 'overage';

// ---- Labels -------------------------------------------------------------------------------

export const KIND_OPTIONS: { value: ProductKind; label: string; hint: string }[] = [
  { value: 'plan', label: 'Plan', hint: 'A subscription tier customers are on (Free, Pro, Team…).' },
  { value: 'addon', label: 'Add-on', hint: 'Extra capacity or features bought on top of a plan.' },
  { value: 'one_time', label: 'One-time product', hint: 'A single purchase, such as a lifetime deal or setup fee.' },
  { value: 'credit_pack', label: 'Credit pack', hint: 'Prepaid credits that usage meters can consume.' },
];
export const KIND_LABEL: Record<ProductKind, string> = { plan: 'Plan', addon: 'Add-on', one_time: 'One-time', credit_pack: 'Credit pack' };

export const PLAN_TYPES = [
  { value: 'free', label: 'Free' },
  { value: 'paid', label: 'Paid' },
  { value: 'lifetime', label: 'Lifetime' },
  { value: 'custom', label: 'Custom / enterprise' },
];

export const RESET_OPTIONS: { value: ResetPeriod; label: string }[] = [
  { value: 'month', label: 'Every calendar month' },
  { value: 'billing_period', label: 'Every billing period' },
  { value: 'day', label: 'Every day' },
  { value: 'week', label: 'Every week' },
  { value: 'year', label: 'Every year' },
  { value: 'rolling', label: 'Rolling window' },
  { value: 'none', label: 'Never (lifetime total or level)' },
];
export const RESET_LABEL = Object.fromEntries(RESET_OPTIONS.map((o) => [o.value, o.label])) as Record<ResetPeriod, string>;

export const ENFORCEMENT_OPTIONS: { value: Enforcement; label: string; hint: string }[] = [
  { value: 'hard', label: 'Hard limit', hint: 'Requests beyond the limit are denied.' },
  { value: 'soft', label: 'Soft limit', hint: 'Usage continues; the customer and your team are warned.' },
  { value: 'overage', label: 'Overage billing', hint: 'Usage continues and extra units are invoiced.' },
];

export const FEATURE_TYPE_LABEL: Record<Feature['type'], string> = { boolean: 'On / off', quota: 'Quota', config: 'Setting' };

// ---- Helpers ------------------------------------------------------------------------------

/** "€49.00/month", "$10.00 per seat/month", "$0.01 per call, 1,000 included/month"... */
export function describePrice(p: Price, meterUnit?: string): string {
  // intervalLabel gives "/month" or " every 3 months"
  const every = p.type === 'recurring' && p.interval ? intervalLabel(p.interval, p.intervalCount) : '';
  const amount = money(p.unitAmount, p.currency);
  switch (p.pricingModel) {
    case 'per_seat':
      return `${amount} per seat${every}`;
    case 'usage': {
      const unit = p.packageSize && p.packageSize > 1 ? `${num(p.packageSize)} ${meterUnit ?? 'units'}` : meterUnit ?? 'unit';
      const included = p.includedUnits ? `, ${num(p.includedUnits)} included` : '';
      return `${amount} per ${unit}${included}${every}`;
    }
    case 'tiered': {
      const first = p.tiers?.[0];
      return `Tiered (${p.tierMode ?? 'graduated'}) from ${money(first?.unitAmount ?? 0, p.currency)}${every}`;
    }
    default:
      return `${amount}${every}`;
  }
}

/** "3 payments, then access ends", "30 days of access": the terms besides the amount. */
export function priceTerms(p: Pick<Price, 'paymentCount' | 'afterLastPayment' | 'accessDays'>): string | null {
  if (p.paymentCount) return `${p.paymentCount} payment${p.paymentCount === 1 ? '' : 's'}, then ${p.afterLastPayment === 'keep_access' ? 'kept for good' : 'access ends'}`;
  if (p.accessDays) return `${num(p.accessDays)} days of access`;
  return null;
}

/** "12 of 50 left", "Sold out", or null without a limit. */
export function stockText(limit: number | null, level: StockLevel | undefined): string | null {
  if (limit === null || !level) return null;
  if (!level.available) return 'Sold out';
  return `${num(level.available)} of ${num(limit)} left`;
}

/** "model: large ×5, small ×1" */
export function describeWeights(weights: Meter['weights']): string {
  const parts = Object.entries(weights ?? {}).map(([dim, values]) => `${dim}: ${Object.entries(values).map(([v, w]) => `${v} ×${w}`).join(', ')}`);
  return parts.join(' · ');
}

/** Lowercase key from a display name, matching the server's key rules. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^[a-z]/.test(s) ? s : s ? `p_${s}`.slice(0, 64) : '';
}

export function useCurrencies(): { base: string; all: string[] } {
  const boot = useBootstrap();
  const base = boot.data?.locale.currency ?? 'USD';
  const all = boot.data?.locale.currencies?.length ? boot.data.locale.currencies : [base];
  return { base, all: all.includes(base) ? all : [base, ...all] };
}

export function useMeters(includeArchived = false) {
  return useQuery({
    queryKey: ['meters', includeArchived],
    queryFn: () => api.get<{ data: Meter[] }>('/api/admin/meters', includeArchived ? { includeArchived: 'true' } : undefined),
    staleTime: 60_000,
  });
}

export function useFeatures() {
  return useQuery({ queryKey: ['features'], queryFn: () => api.get<{ data: Feature[] }>('/api/admin/features'), staleTime: 60_000 });
}

/** Every product that is not archived (for pickers: bundles, purchase rules, coupons). */
export function useProductList() {
  return useQuery({ queryKey: ['products', 'all-active'], queryFn: () => api.get<{ data: Product[] }>('/api/admin/products'), staleTime: 60_000 });
}

/**
 * Validation errors from the server, split into field messages (shown next to
 * the inputs) and a general message for everything else.
 */
export function useFormErrors() {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  return {
    fields,
    general,
    clear: () => {
      setFields({});
      setGeneral(null);
    },
    set: (err: unknown, known: string[] = []) => {
      const f = err instanceof ApiError ? err.fieldErrors() : {};
      const shown = Object.fromEntries(Object.entries(f).filter(([k]) => known.some((n) => k === n || k.startsWith(`${n}.`))));
      setFields(shown);
      const rest = Object.entries(f).filter(([k]) => !(k in shown));
      setGeneral(Object.keys(shown).length && !rest.length ? null : rest.length ? rest.map(([k, v]) => `${k}: ${v}`).join(' · ') : errorMessage(err));
    },
  };
}

/** Decimal money input that reports minor units (e.g. "49.90" -> 4990). */
export function MoneyInput({ id, value, currency, onChange, required, placeholder, invalid }: { id?: string; value: number | null; currency: string; onChange: (minor: number | null) => void; required?: boolean; placeholder?: string; invalid?: boolean }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : fromMinor(value, currency));
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">{currency}</span>
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        required={required}
        invalid={invalid}
        placeholder={placeholder ?? '0.00'}
        className="pl-12 tabular"
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.trim() === '' ? null : toMinor(e.target.value, currency));
        }}
      />
    </div>
  );
}
