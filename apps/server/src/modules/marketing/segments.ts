import { z } from 'zod';
import { sql, type Sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';

/** Allowed operators per field. Anything else is rejected before it can reach SQL. */
export const SEGMENT_FIELDS = {
  plan: ['is', 'is_not'],
  subscription_status: ['is', 'is_not'],
  country: ['is', 'is_not', 'in'],
  tag: ['has', 'not_has'],
  created_at: ['before', 'after', 'within_days', 'older_than_days'],
  last_active_at: ['within_days', 'older_than_days', 'never'],
  lifetime_revenue: ['gte', 'lte'],
  marketing_consent: ['is'],
  email_verified: ['is'],
  status: ['is', 'is_not'],
  organization: ['member_of'],
  locale: ['is'],
  registration_source: ['is'],
} as const satisfies Record<string, readonly string[]>;

type Field = keyof typeof SEGMENT_FIELDS;
const FIELD_KEYS = Object.keys(SEGMENT_FIELDS) as [Field, ...Field[]];
const SUB_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled', 'unpaid', 'none'];
const USER_STATUSES = ['active', 'suspended', 'banned', 'pending'];

export const conditionSchema = z
  .object({ field: z.enum(FIELD_KEYS), op: z.string(), value: z.unknown().optional() })
  .superRefine((c, ctx) => {
    const ops = SEGMENT_FIELDS[c.field] as readonly string[];
    if (!ops.includes(c.op)) {
      ctx.addIssue({ code: 'custom', path: ['op'], message: `"${c.op}" is not valid for ${c.field}; use ${ops.join(', ')}` });
      return;
    }
    const v = c.value;
    const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['value'], message });
    switch (c.field) {
      case 'plan':
      case 'organization':
      case 'registration_source':
      case 'tag':
        if (typeof v !== 'string' || !v || v.length > 100) bad('Enter a value');
        break;
      case 'locale':
        if (typeof v !== 'string' || !/^[a-zA-Z]{2}([-_][a-zA-Z]{2,4})?$/.test(v)) bad('Enter a locale like en or pt-BR');
        break;
      case 'subscription_status':
        if (typeof v !== 'string' || !SUB_STATUSES.includes(v)) bad(`Use one of ${SUB_STATUSES.join(', ')}`);
        break;
      case 'status':
        if (typeof v !== 'string' || !USER_STATUSES.includes(v)) bad(`Use one of ${USER_STATUSES.join(', ')}`);
        break;
      case 'country': {
        const list = c.op === 'in' ? v : [v];
        if (!Array.isArray(list) || !list.length || list.length > 250 || list.some((x) => typeof x !== 'string' || !/^[a-zA-Z]{2}$/.test(x))) bad('Use two-letter country codes');
        break;
      }
      case 'created_at':
      case 'last_active_at':
        if (c.op === 'never') break;
        if (c.op === 'before' || c.op === 'after') {
          if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) bad('Enter a date');
        } else if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 36_500) bad('Enter a number of days');
        break;
      case 'lifetime_revenue':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) bad('Enter an amount in minor units');
        break;
      case 'marketing_consent':
      case 'email_verified':
        if (typeof v !== 'boolean') bad('Enter true or false');
        break;
    }
  });

export const segmentRulesSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).max(50).default([]),
});
export type SegmentRules = z.infer<typeof segmentRulesSchema>;
export type SegmentCondition = z.infer<typeof conditionSchema>;

const ACTIVE_SUBSCRIPTION = sql`('active', 'trialing', 'past_due')`;

function compileCondition(c: SegmentCondition, now: Date): Sql {
  const v = c.value as any;
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
  switch (c.field) {
    case 'plan': {
      const has = sql`(
        EXISTS (SELECT 1 FROM subscriptions s JOIN products p ON p.id = s.product_id
                WHERE s.subject_type = 'user' AND s.subject_id = u.id AND p.key = ${v} AND s.status IN ${ACTIVE_SUBSCRIPTION})
        OR EXISTS (SELECT 1 FROM entitlement_grants g JOIN products p ON p.id = g.product_id
                WHERE g.subject_type = 'user' AND g.subject_id = u.id AND p.key = ${v} AND g.revoked_at IS NULL AND (g.ends_at IS NULL OR g.ends_at > ${now}))
      )`;
      return c.op === 'is' ? has : sql`NOT ${has}`;
    }
    case 'subscription_status': {
      const has =
        v === 'none'
          ? sql`NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.subject_type = 'user' AND s.subject_id = u.id)`
          : sql`EXISTS (SELECT 1 FROM subscriptions s WHERE s.subject_type = 'user' AND s.subject_id = u.id AND s.status = ${v})`;
      return c.op === 'is' ? has : sql`NOT ${has}`;
    }
    case 'country':
      if (c.op === 'in') return sql`u.country IN ${sql.in((v as string[]).map((x) => x.toUpperCase()))}`;
      return c.op === 'is' ? sql`u.country = ${String(v).toUpperCase()}` : sql`(u.country IS NULL OR u.country <> ${String(v).toUpperCase()})`;
    case 'tag':
      return c.op === 'has' ? sql`u.tags ? ${v}` : sql`NOT (u.tags ? ${v})`;
    case 'created_at':
      if (c.op === 'before') return sql`u.created_at < ${new Date(v)}`;
      if (c.op === 'after') return sql`u.created_at >= ${new Date(v)}`;
      return c.op === 'within_days' ? sql`u.created_at >= ${daysAgo(v)}` : sql`u.created_at < ${daysAgo(v)}`;
    case 'last_active_at':
      if (c.op === 'never') return sql`u.last_active_at IS NULL`;
      return c.op === 'within_days' ? sql`u.last_active_at >= ${daysAgo(v)}` : sql`(u.last_active_at IS NULL OR u.last_active_at < ${daysAgo(v)})`;
    case 'lifetime_revenue':
      return c.op === 'gte' ? sql`u.lifetime_revenue >= ${v}` : sql`u.lifetime_revenue <= ${v}`;
    case 'marketing_consent':
      return sql`u.marketing_consent = ${Boolean(v)}`;
    case 'email_verified':
      return v ? sql`u.email_verified_at IS NOT NULL` : sql`u.email_verified_at IS NULL`;
    case 'status':
      return c.op === 'is' ? sql`u.status = ${v}` : sql`u.status <> ${v}`;
    case 'organization':
      return sql`EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id = ${v} AND m.status = 'active')`;
    case 'locale':
      return sql`(u.locale = ${v} OR u.locale ILIKE ${`${String(v).split(/[-_]/)[0]}-%`} OR u.locale = ${String(v).split(/[-_]/)[0]})`;
    case 'registration_source':
      return sql`u.registration_source = ${v}`;
  }
}

/**
 * Compile segment rules into a WHERE condition over `users u`. Every value is a
 * bound parameter and every field/operator comes from the allowlist above, so
 * user-authored rules cannot inject SQL.
 */
export function segmentCondition(rules: SegmentRules, now: Date): Sql {
  const parts = rules.conditions.map((c) => compileCondition(c, now));
  const combined = parts.length ? (rules.match === 'any' ? sql.or(parts) : sql.and(parts)) : sql`TRUE`;
  return sql`u.deleted_at IS NULL AND (${combined})`;
}
