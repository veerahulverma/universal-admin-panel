export { StewardClient, StewardClientError, type StewardClientOptions } from './client.js';
export * from './types.js';

/** Format minor units for display, e.g. formatMoney(1999, 'USD') -> "$19.99". */
export function formatMoney(minor: number, currency: string, locale?: string): string {
  const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
  const threeDecimal = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
  const digits = zeroDecimal.has(currency) ? 0 : threeDecimal.has(currency) ? 3 : 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
}
