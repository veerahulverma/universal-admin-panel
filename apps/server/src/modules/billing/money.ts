/** Minor-unit exponent per ISO currency (default 2). */
const DECIMALS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function currencyDecimals(currency: string): number {
  return DECIMALS[currency.toUpperCase()] ?? 2;
}

/** Minor units -> decimal string, e.g. (1234, USD) -> "12.34", (500, JPY) -> "500". */
export function toDecimalString(minor: number, currency: string): string {
  const d = currencyDecimals(currency);
  return (minor / 10 ** d).toFixed(d);
}

export function formatMoney(minor: number, currency: string, locale = 'en'): string {
  const d = currencyDecimals(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(minor / 10 ** d);
  } catch {
    return `${toDecimalString(minor, currency)} ${currency}`;
  }
}

export type Interval = 'day' | 'week' | 'month' | 'year';

/**
 * Add billing intervals in UTC. Month arithmetic keeps the anchor day and clamps
 * to the last day of shorter months (Jan 31 + 1 month = Feb 28/29).
 */
export function addInterval(date: Date, interval: Interval, count = 1): Date {
  const d = new Date(date.getTime());
  if (interval === 'day') return new Date(d.getTime() + count * 86_400_000);
  if (interval === 'week') return new Date(d.getTime() + count * 7 * 86_400_000);
  const months = interval === 'year' ? 12 * count : count;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** Approximate months in an interval (for MRR normalization). */
export function monthsIn(interval: Interval, count: number): number {
  switch (interval) {
    case 'day':
      return (count * 12) / 365;
    case 'week':
      return (count * 12) / 52;
    case 'year':
      return count * 12;
    default:
      return count;
  }
}

export interface TaxResult {
  net: number;
  tax: number;
  total: number;
}

/** Tax on an amount. Inclusive prices already contain the tax; exclusive prices add it. Rates are basis points. */
export function computeTax(amount: number, rateBps: number, inclusive: boolean): TaxResult {
  if (rateBps <= 0 || amount <= 0) return { net: amount, tax: 0, total: amount };
  if (inclusive) {
    const tax = Math.round((amount * rateBps) / (10_000 + rateBps));
    return { net: amount - tax, tax, total: amount };
  }
  const tax = Math.round((amount * rateBps) / 10_000);
  return { net: amount, tax, total: amount + tax };
}

/** Value of the unused part of a period at time `at` (for proration credits/charges). */
export function unusedValue(amountPerPeriod: number, periodStart: Date, periodEnd: Date, at: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0) return 0;
  const remaining = Math.min(total, Math.max(0, periodEnd.getTime() - at.getTime()));
  return Math.round((amountPerPeriod * remaining) / total);
}

export interface Tier {
  upTo: number | null;
  unitAmount: number;
  flatAmount?: number;
}

/**
 * Tiered pricing. Graduated: each unit is priced by the tier it falls in.
 * Volume: all units are priced by the tier the total falls in.
 */
export function tieredAmount(units: number, tiers: readonly Tier[], mode: 'graduated' | 'volume'): number {
  if (units <= 0 || !tiers.length) return 0;
  if (mode === 'volume') {
    const tier = tiers.find((t) => t.upTo === null || units <= t.upTo) ?? tiers[tiers.length - 1];
    return units * tier.unitAmount + (tier.flatAmount ?? 0);
  }
  let total = 0;
  let prev = 0;
  for (const tier of tiers) {
    const cap = tier.upTo ?? Infinity;
    if (units <= prev) break;
    const inTier = Math.min(units, cap) - prev;
    total += inTier * tier.unitAmount + (tier.flatAmount ?? 0);
    prev = cap;
  }
  return total;
}

export interface PriceLike {
  pricing_model: 'flat' | 'per_seat' | 'usage' | 'tiered';
  unit_amount: number;
  included_units: number;
  tiers: Tier[] | null;
  tier_mode: 'graduated' | 'volume' | null;
  package_size: number | null;
  meter_key: string | null;
}

/** Recurring/one-time charge for a price at a quantity (seats). Usage prices are billed in arrears separately. */
export function licensedAmount(price: PriceLike, quantity: number): number {
  switch (price.pricing_model) {
    case 'flat':
      return price.unit_amount;
    case 'per_seat':
      return price.unit_amount * quantity;
    case 'tiered':
      return price.meter_key ? 0 : tieredAmount(quantity, price.tiers ?? [], price.tier_mode ?? 'graduated');
    default:
      return 0;
  }
}

/** Charge for metered usage over a finished period. */
export function usageAmount(price: PriceLike, units: number): number {
  const billable = Math.max(0, units - price.included_units);
  if (billable === 0) return 0;
  if (price.tiers?.length) return tieredAmount(billable, price.tiers, price.tier_mode ?? 'graduated');
  const pkg = price.package_size ?? 1;
  return Math.ceil(billable / pkg) * price.unit_amount;
}
