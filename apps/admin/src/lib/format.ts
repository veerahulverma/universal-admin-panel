const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function decimals(currency: string): number {
  const c = currency.toUpperCase();
  return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
}

/** Minor units -> localized currency string. */
export function money(minor: number | null | undefined, currency = 'USD', opts: { compact?: boolean; whole?: boolean } = {}): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '—';
  const d = decimals(currency);
  const value = minor / 10 ** d;
  const short = opts.compact && Math.abs(value) >= 10_000;
  // whole: drop the minor units (headline numbers, axis ticks)
  const digits = short || opts.whole ? 0 : d;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: short ? 'compact' : 'standard',
      minimumFractionDigits: digits,
      maximumFractionDigits: short ? 1 : digits,
    }).format(value);
  } catch {
    return `${value.toFixed(d)} ${currency}`;
  }
}

/** Parse a user-entered decimal amount into minor units. */
export function toMinor(input: string, currency = 'USD'): number | null {
  const cleaned = String(input).replace(/[^0-9.-]/g, '');
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** decimals(currency));
}

export function fromMinor(minor: number, currency = 'USD'): string {
  return (minor / 10 ** decimals(currency)).toFixed(decimals(currency));
}

export function num(n: number | null | undefined, opts: { compact?: boolean; digits?: number } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(undefined, {
    notation: opts.compact && Math.abs(n) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: opts.digits ?? (opts.compact ? 1 : 0),
  }).format(n);
}

export function pct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

const dtf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dttf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function date(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dtf.format(d);
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dttf.format(d);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function ago(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/[_.-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name: string | null | undefined, email?: string | null): string {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function interval(intervalUnit: string | null | undefined, count = 1): string {
  if (!intervalUnit) return 'one-time';
  const map: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };
  return count === 1 ? `/${map[intervalUnit] ?? intervalUnit}` : ` every ${count} ${map[intervalUnit] ?? intervalUnit}s`;
}
