import { z } from 'zod';
import { validationError } from '../../core/errors.js';

/**
 * Custom ticket fields are defined per category ("Order number", "Affected
 * URL"...). Customers and agents fill them in when a ticket is opened; values
 * are validated against the definitions and stored with the ticket.
 */
export const TICKET_FIELD_TYPES = ['text', 'number', 'url', 'select'] as const;

export const ticketFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and underscores; start with a letter'),
    label: z.string().trim().min(1).max(100),
    type: z.enum(TICKET_FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    required: z.boolean().default(false),
    help: z.string().trim().max(300).default(''),
  })
  .superRefine((f, ctx) => {
    if (f.type === 'select' && f.options.length === 0) ctx.addIssue({ code: 'custom', path: ['options'], message: 'A list field needs at least one option' });
    if (new Set(f.options).size !== f.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique' });
  })
  .transform((f) => ({ ...f, options: f.type === 'select' ? f.options : [] }));

export const ticketFieldsSchema = z
  .array(ticketFieldSchema)
  .max(20)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `The key "${f.key}" is used twice` });
      seen.add(f.key);
    });
  });

export type TicketField = z.output<typeof ticketFieldSchema>;
export type TicketFieldValue = string | number | null;

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function coerce(def: TicketField, value: unknown): { ok: true; value: string | number } | { ok: false; message: string } {
  switch (def.type) {
    case 'text':
      if (typeof value !== 'string' && typeof value !== 'number') return { ok: false, message: 'Enter text' };
      return String(value).trim().length > 2000 ? { ok: false, message: 'Use at most 2000 characters' } : { ok: true, value: String(value).trim() };
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: 'Enter a number' };
    }
    case 'url': {
      if (typeof value !== 'string' || value.length > 2000) return { ok: false, message: 'Enter a URL' };
      try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? { ok: true, value: url.toString() } : { ok: false, message: 'Use an http or https URL' };
      } catch {
        return { ok: false, message: 'Enter a valid URL' };
      }
    }
    case 'select':
      return typeof value === 'string' && def.options.includes(value) ? { ok: true, value } : { ok: false, message: `Choose one of: ${def.options.join(', ')}` };
  }
}

/**
 * Validate submitted values against a category's fields. Unknown keys are
 * rejected; required fields must be present unless `partial` (agents editing
 * one field later). Blank values clear a field.
 */
export function validateTicketFields(defs: readonly TicketField[], values: Record<string, unknown>, opts: { partial: boolean }): Record<string, TicketFieldValue> {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const issues: { path: string[]; message: string }[] = [];
  const out: Record<string, TicketFieldValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def) {
      issues.push({ path: ['customFields', key], message: 'This category has no such field' });
      continue;
    }
    if (blank(value)) {
      if (def.required) issues.push({ path: ['customFields', key], message: `${def.label} is required` });
      else out[key] = null;
      continue;
    }
    const result = coerce(def, value);
    if (result.ok) out[key] = result.value;
    else issues.push({ path: ['customFields', key], message: `${def.label}: ${result.message}` });
  }
  if (!opts.partial) {
    for (const def of defs) {
      if (def.required && !(def.key in values)) issues.push({ path: ['customFields', def.key], message: `${def.label} is required` });
    }
  }
  if (issues.length) throw validationError(issues);
  return out;
}

/** What a customer's form needs to render a category's fields. */
export function presentFields(defs: readonly TicketField[]) {
  return defs.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, required: f.required, help: f.help }));
}
