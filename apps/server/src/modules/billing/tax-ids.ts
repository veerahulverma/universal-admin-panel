import type { App } from '../../core/types.js';
import { validationError } from '../../core/errors.js';

/*
 * Tax ID checks when billing details are saved. Built in: the format of EU VAT numbers, per member
 * state. This is NOT a VIES lookup: nothing here asks the EU whether a number is registered. A plugin
 * or module that does (VIES, or another registry) registers a `billing.tax_id.validate` filter; it
 * receives the format check and may reject the number or mark it verified.
 */

/** VAT number formats per prefix. Greece uses EL; XI is Northern Ireland. */
const EU_VAT: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  EL: /^EL\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
  XI: /^XI(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** VAT prefix of an EU member state's ISO country code (null outside the EU). */
export function vatPrefix(country: string | null | undefined): string | null {
  if (!country) return null;
  const code = country.toUpperCase();
  if (code === 'GR') return 'EL';
  return code in EU_VAT && code !== 'XI' && code !== 'EL' ? code : null;
}

export interface TaxIdCheck {
  /** The ID as it will be stored: EU VAT numbers uppercase, with their prefix and without separators; others as given. */
  normalized: string;
  /** 'eu_vat' when the ID was checked as an EU VAT number. */
  type: 'eu_vat' | null;
  valid: boolean;
  message: string | null;
  /** True only if a registered validator confirmed the ID with an authority; the built-in check never does. */
  verified: boolean;
  /** Who decided: 'format' for the built-in check, or the validator that changed the result. */
  source: string;
}

export interface TaxIdContext {
  app: App;
  /** Billing country of the customer (ISO code), if known. */
  country: string | null;
  /** The type the customer or administrator gave (e.g. 'eu_vat'); other types are not format-checked. */
  declaredType: string | null;
}

/** Built-in format check, then any registered `billing.tax_id.validate` filters. */
export async function checkTaxId(app: App, taxId: string, opts: { country: string | null; type: string | null }): Promise<TaxIdCheck> {
  const compact = taxId.toUpperCase().replace(/[\s.\-/]/g, '');
  const country = opts.country?.toUpperCase() ?? null;
  const declared = opts.type?.toLowerCase() ?? null;
  let result: TaxIdCheck = { normalized: taxId.trim(), type: null, valid: true, message: null, verified: false, source: 'format' };
  if (!declared || declared === 'eu_vat') {
    const ownPrefix = compact.slice(0, 2);
    const countryPrefix = vatPrefix(country);
    // Outside the EU (and Northern Ireland) an ID is read as a VAT number only when declared as one.
    const inScope = declared === 'eu_vat' || !country || countryPrefix !== null || (country === 'GB' && ownPrefix === 'XI');
    const prefixed = !inScope ? null : ownPrefix in EU_VAT ? compact : countryPrefix ? `${countryPrefix}${compact}` : null;
    if (prefixed) {
      const prefix = prefixed.slice(0, 2);
      const valid = EU_VAT[prefix].test(prefixed);
      result = { ...result, normalized: prefixed, type: 'eu_vat', valid, message: valid ? null : `This is not a valid ${prefix} VAT number format` };
    } else if (declared === 'eu_vat') {
      result = { ...result, valid: false, message: 'EU VAT numbers start with the country code, for example DE123456789' };
    }
  }
  return app.hooks.apply<TaxIdCheck, TaxIdContext>('billing.tax_id.validate', result, { app, country, declaredType: declared });
}

/** The tax ID to store, or a validation error (422 on `taxId`) when it is invalid. */
export async function validatedTaxId(app: App, taxId: string, opts: { country: string | null; type: string | null }): Promise<string> {
  const check = await checkTaxId(app, taxId, opts);
  if (!check.valid) throw validationError([{ path: ['taxId'], message: check.message ?? 'This tax ID is not valid' }]);
  return check.normalized;
}
