import type { QueryClient } from '@tanstack/react-query';
import type { JsonSchema } from '../../components/SchemaForm';
import { ApiError } from '../../lib/api';

/**
 * Simplify zod's JSON Schema output for SchemaForm, recursively:
 * - "value or empty string" unions (z.string().url().or(z.literal(''))) become
 *   the plain field, no longer marked required (empty is allowed);
 * - unions of literals become an enum.
 */
export function normalizeSchema(schema: JsonSchema | null | undefined): JsonSchema {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s: JsonSchema = { ...schema };
  const variants = s.anyOf ?? s.oneOf;
  if (variants) {
    const nonNull = variants.filter((v) => v.type !== 'null');
    const hasNull = nonNull.length < variants.length;
    let merged: JsonSchema | null = null;
    if (nonNull.length > 0 && nonNull.every((v) => v.const !== undefined)) {
      merged = { type: typeof nonNull[0].const === 'number' ? 'number' : 'string', enum: nonNull.map((v) => v.const) };
    } else if (nonNull.length > 1 && nonNull.every((v) => v.type !== undefined && v.type === nonNull[0].type)) {
      const main = nonNull.find((v) => v.const === undefined) ?? nonNull[0];
      merged = { ...normalizeSchema(main), 'x-allow-empty': nonNull.some((v) => v.const === '') };
    }
    if (merged) {
      const { anyOf: _a, oneOf: _o, ...rest } = s;
      const base: JsonSchema = { ...merged, title: rest.title ?? merged.title, description: rest.description ?? merged.description, default: rest.default ?? merged.default };
      return hasNull ? { ...rest, anyOf: [base, { type: 'null' }] } : { ...rest, ...base };
    }
    s.anyOf = s.anyOf?.map(normalizeSchema);
    s.oneOf = s.oneOf?.map(normalizeSchema);
  }
  if (s.properties) {
    s.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, normalizeSchema(v)]));
    if (s.required) s.required = s.required.filter((k) => !s.properties![k]?.['x-allow-empty']);
  }
  if (s.items) s.items = normalizeSchema(s.items);
  return s;
}

/**
 * SchemaForm drops a cleared optional field; fields that accept an empty string
 * must send "" instead, or the stored value could never be cleared.
 */
export function keepEmptyStrings(schema: JsonSchema, value: Record<string, unknown>): Record<string, unknown> {
  const out = { ...value };
  for (const [k, p] of Object.entries(schema.properties ?? {})) if (p['x-allow-empty'] && out[k] === undefined) out[k] = '';
  return out;
}

/** Keys whose value differs (deep, by JSON) between the saved object and the draft. */
export function changedKeys(saved: Record<string, unknown>, draft: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(saved ?? {}), ...Object.keys(draft ?? {})]);
  return [...keys].filter((k) => JSON.stringify(saved?.[k] ?? null) !== JSON.stringify(draft?.[k] ?? null));
}

export function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

/** Field errors keyed by path ("config.feePercent" -> "feePercent" when a prefix is given). */
export function fieldErrors(err: unknown, prefix?: string): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const all = err.fieldErrors();
  if (!prefix) return all;
  return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(`${prefix}.`)).map(([k, v]) => [k.slice(prefix.length + 1), v]));
}

/** Navigation, branding and module availability come from the bootstrap payload. */
export function refreshShell(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: ['bootstrap'] });
  void client.invalidateQueries({ queryKey: ['public-branding'] });
}

export function intervalLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `every ${seconds / 86_400 === 1 ? 'day' : `${seconds / 86_400} days`}`;
  if (seconds % 3_600 === 0) return `every ${seconds / 3_600 === 1 ? 'hour' : `${seconds / 3_600} hours`}`;
  if (seconds % 60 === 0) return `every ${seconds / 60 === 1 ? 'minute' : `${seconds / 60} minutes`}`;
  return `every ${seconds} seconds`;
}
