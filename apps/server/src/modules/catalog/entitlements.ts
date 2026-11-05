import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { notFound } from '../../core/errors.js';

export type SubjectType = 'user' | 'organization';
export interface Subject {
  type: SubjectType;
  id: string;
}
export type ResetPeriod = 'none' | 'day' | 'week' | 'month' | 'year' | 'billing_period' | 'rolling';
export type Enforcement = 'hard' | 'soft' | 'overage';

/**
 * Something that confers a product: an active subscription, a manual/lifetime grant, the default
 * plan, or a bundle the subject owns (`originId` is then the bundle's product id).
 */
export interface EntitlementSource {
  productId: string;
  quantity: number;
  origin: 'subscription' | 'subscription_item' | 'grant' | 'default' | 'bundle';
  originId: string | null;
  status?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

export interface ResolvedFeature {
  key: string;
  name: string;
  type: 'boolean' | 'quota' | 'config';
  enabled: boolean;
  meterKey: string | null;
  unit: string | null;
  /** Quota limit; null means unlimited. */
  limit: number | null;
  unlimited: boolean;
  resetPeriod: ResetPeriod;
  rollingWindowSeconds: number | null;
  enforcement: Enforcement;
  warnAtPercent: number;
  graceUnits: number;
  overageUnitAmount: number | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  config: unknown;
  sources: string[];
}

export interface Entitlements {
  subject: Subject;
  plans: { productId: string; key: string; name: string; kind: string; origin: string; originId: string | null; status: string | null; quantity: number }[];
  features: Record<string, ResolvedFeature>;
}

export interface SourcesContext {
  db: Db;
  app: App;
  subject: Subject;
}

interface ProductFeatureRow {
  product_id: string;
  product_key: string;
  product_name: string;
  kind: string;
  feature_id: string;
  feature_key: string;
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

export interface CatalogSettings {
  defaultPlanKey: string;
  unknownMeterPolicy: 'allow' | 'deny';
}

/**
 * Resolve what a subject (user or organization) may use right now.
 *
 * Merge rules:
 *  - a bundle confers the products it includes, as if they were owned directly
 *  - boolean features: enabled if any source enables them
 *  - quotas: plans take the highest plan limit (seat-based limits scale with
 *    quantity); add-ons and one-time purchases add on top; any unlimited
 *    source makes the quota unlimited
 *  - config values: plan < add-on < override
 *  - admin overrides apply last ("set" replaces, "add" increases), honouring
 *    their start/expiry window (temporary increases)
 *  - plugins may adjust the result through the `entitlements.resolve` hook
 */
export async function resolveEntitlements(db: Db, app: App, subject: Subject): Promise<Entitlements> {
  const now = app.clock.now();
  const grants = await db.many<{ id: string; product_id: string; quantity: number; ends_at: Date | null }>(sql`
    SELECT id, product_id, quantity, ends_at FROM entitlement_grants
    WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND revoked_at IS NULL
      AND starts_at <= ${now} AND (ends_at IS NULL OR ends_at > ${now})
  `);
  let sources: EntitlementSource[] = grants.map((g) => ({ productId: g.product_id, quantity: g.quantity, origin: 'grant', originId: g.id, periodEnd: g.ends_at }));
  sources = await app.hooks.apply<EntitlementSource[], SourcesContext>('entitlements.sources', sources, { db, app, subject });
  sources = await withBundledProducts(db, sources);

  const productIds = [...new Set(sources.map((s) => s.productId))];
  const products = productIds.length
    ? await db.many<{ id: string; key: string; name: string; kind: string }>(sql`SELECT id, key, name, kind FROM products WHERE id IN ${sql.in(productIds)}`)
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  if (!sources.some((s) => productById.get(s.productId)?.kind === 'plan')) {
    const defaultKey = app.settings.get<CatalogSettings>('catalog').defaultPlanKey;
    if (defaultKey) {
      const def = await db.maybe<{ id: string; key: string; name: string; kind: string }>(sql`SELECT id, key, name, kind FROM products WHERE key = ${defaultKey} AND kind = 'plan' AND status <> 'archived'`);
      if (def) {
        sources.push({ productId: def.id, quantity: 1, origin: 'default', originId: null });
        productById.set(def.id, def);
      }
    }
  }

  const allIds = [...new Set(sources.map((s) => s.productId))];
  const rows = allIds.length
    ? await db.many<ProductFeatureRow>(sql`
        SELECT pf.*, p.key AS product_key, p.name AS product_name, p.kind, f.key AS feature_key
        FROM product_features pf JOIN products p ON p.id = pf.product_id JOIN features f ON f.id = pf.feature_id
        WHERE pf.product_id IN ${sql.in(allIds)}
      `)
    : [];
  const allFeatures = await db.many<{ id: string; key: string; name: string; type: ResolvedFeature['type']; meter_key: string | null; unit: string | null }>(
    sql`SELECT id, key, name, type, meter_key, unit FROM features`,
  );

  const features: Record<string, ResolvedFeature> = {};
  for (const f of allFeatures) {
    features[f.key] = {
      key: f.key,
      name: f.name,
      type: f.type,
      enabled: false,
      meterKey: f.meter_key,
      unit: f.unit,
      limit: f.type === 'quota' ? 0 : null,
      unlimited: false,
      resetPeriod: 'month',
      rollingWindowSeconds: null,
      enforcement: 'hard',
      warnAtPercent: 80,
      graceUnits: 0,
      overageUnitAmount: null,
      periodStart: null,
      periodEnd: null,
      config: null,
      sources: [],
    };
  }

  const primaryLimit = new Map<string, number>();
  const sourcesByProduct = new Map<string, EntitlementSource[]>();
  for (const s of sources) sourcesByProduct.set(s.productId, [...(sourcesByProduct.get(s.productId) ?? []), s]);

  // Plans first so add-ons stack on the chosen plan limit.
  const ordered = [...rows].sort((a, b) => (a.kind === 'plan' ? 0 : 1) - (b.kind === 'plan' ? 0 : 1));
  for (const row of ordered) {
    const f = features[row.feature_key];
    if (!f) continue;
    for (const src of sourcesByProduct.get(row.product_id) ?? []) {
      const label = `${row.product_key}${src.origin === 'default' ? ' (default)' : ''}`;
      if (!f.sources.includes(label)) f.sources.push(label);
      if (f.type === 'boolean') {
        f.enabled = f.enabled || row.enabled;
        continue;
      }
      if (f.type === 'config') {
        if (row.config_value !== null && row.config_value !== undefined) f.config = row.config_value;
        f.enabled = f.enabled || row.enabled;
        continue;
      }
      // quota
      f.enabled = f.enabled || row.enabled;
      const units = row.unlimited ? Infinity : (row.limit_value ?? 0) * (row.per_seat ? src.quantity : 1);
      if (row.kind === 'plan') {
        const best = primaryLimit.get(f.key) ?? -1;
        if (units > best) {
          primaryLimit.set(f.key, units);
          f.resetPeriod = row.reset_period;
          f.rollingWindowSeconds = row.rolling_window_seconds;
          f.enforcement = row.enforcement;
          f.warnAtPercent = row.warn_at_percent;
          f.graceUnits = row.grace_units;
          f.overageUnitAmount = row.overage_unit_amount;
          f.periodStart = src.periodStart ?? null;
          f.periodEnd = src.periodEnd ?? null;
        }
      } else {
        const add = row.unlimited ? Infinity : (row.limit_value ?? 0) * src.quantity;
        primaryLimit.set(f.key, (primaryLimit.get(f.key) ?? 0) + add);
      }
    }
  }
  for (const [key, units] of primaryLimit) {
    const f = features[key];
    f.unlimited = units === Infinity;
    f.limit = f.unlimited ? null : Math.max(0, units);
  }

  const overrides = await db.many<any>(sql`
    SELECT o.*, f.key AS feature_key FROM entitlement_overrides o JOIN features f ON f.id = o.feature_id
    WHERE o.subject_type = ${subject.type} AND o.subject_id = ${subject.id}
      AND o.starts_at <= ${now} AND (o.expires_at IS NULL OR o.expires_at > ${now})
    ORDER BY o.created_at
  `);
  for (const o of overrides) {
    const f = features[o.feature_key];
    if (!f) continue;
    f.sources.push(`override:${o.id}`);
    if (o.mode === 'add') {
      if (f.type === 'quota' && !f.unlimited) f.limit = (f.limit ?? 0) + (o.limit_value ?? 0);
      f.enabled = true;
      continue;
    }
    if (o.enabled !== null) f.enabled = o.enabled;
    if (o.unlimited) {
      f.unlimited = true;
      f.limit = null;
    } else if (o.limit_value !== null) {
      f.unlimited = false;
      f.limit = o.limit_value;
      f.enabled = true;
    }
    if (o.enforcement) f.enforcement = o.enforcement;
    if (o.config_value !== null) f.config = o.config_value;
  }

  const plans = sources
    .filter((s) => productById.has(s.productId))
    .map((s) => {
      const p = productById.get(s.productId)!;
      return { productId: p.id, key: p.key, name: p.name, kind: p.kind, origin: s.origin, originId: s.originId, status: s.status ?? null, quantity: s.quantity };
    });

  const result: Entitlements = { subject, plans, features };
  return app.hooks.apply<Entitlements, SourcesContext>('entitlements.resolve', result, { db, app, subject });
}

/** Bundles nest at most this deep; saving a bundle refuses cycles, the cap only guards resolution. */
const MAX_BUNDLE_DEPTH = 5;

/**
 * Owning a bundle confers every product it includes (and what included bundles include), with the
 * bundle's quantity and period, for as long as the bundle itself is owned.
 */
export async function withBundledProducts(db: Db, sources: EntitlementSource[]): Promise<EntitlementSource[]> {
  const out = [...sources];
  let frontier = sources;
  for (let depth = 0; depth < MAX_BUNDLE_DEPTH && frontier.length; depth++) {
    const items = await db.many<{ bundle_id: string; product_id: string }>(sql`
      SELECT bundle_id, product_id FROM product_bundle_items WHERE bundle_id IN ${sql.in([...new Set(frontier.map((s) => s.productId))])} ORDER BY bundle_id, product_id
    `);
    if (!items.length) break;
    frontier = frontier.flatMap((s) =>
      items
        .filter((i) => i.bundle_id === s.productId)
        .map((i) => ({ productId: i.product_id, quantity: s.quantity, origin: 'bundle' as const, originId: s.productId, status: s.status, periodStart: s.periodStart, periodEnd: s.periodEnd })),
    );
    out.push(...frontier);
  }
  return out;
}

/** Products a bundle includes, directly or through nested bundles. */
export async function bundleContents(db: Db, bundleId: string): Promise<Set<string>> {
  const found = new Set<string>();
  let frontier = [bundleId];
  for (let depth = 0; depth < MAX_BUNDLE_DEPTH + 1 && frontier.length; depth++) {
    const rows = await db.many<{ product_id: string }>(sql`SELECT product_id FROM product_bundle_items WHERE bundle_id IN ${sql.in(frontier)}`);
    frontier = rows.map((r) => r.product_id).filter((id) => !found.has(id));
    for (const id of frontier) found.add(id);
  }
  return found;
}

/** Subject for a request: the organization when acting inside one (verifying membership), else the user. */
export async function subjectFor(db: Db, input: { userId?: string | null; orgId?: string | null }, scope: string[] | null): Promise<Subject> {
  if (input.orgId) {
    const org = await db.maybe(sql`SELECT 1 FROM organizations WHERE id = ${input.orgId} AND deleted_at IS NULL ${scope ? sql`AND id IN ${sql.in(scope)}` : sql.empty}`);
    if (!org) throw notFound('Organization');
    if (input.userId) {
      const member = await db.maybe(sql`SELECT 1 FROM memberships WHERE org_id = ${input.orgId} AND user_id = ${input.userId} AND status = 'active'`);
      if (!member) throw notFound('Membership');
    }
    return { type: 'organization', id: input.orgId };
  }
  if (!input.userId) throw notFound('User');
  const user = await db.maybe(sql`
    SELECT 1 FROM users u WHERE u.id = ${input.userId} AND u.deleted_at IS NULL
    ${scope ? sql`AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id IN ${sql.in(scope)})` : sql.empty}
  `);
  if (!user) throw notFound('User');
  return { type: 'user', id: input.userId };
}

export function presentFeature(f: ResolvedFeature) {
  return {
    key: f.key,
    type: f.type,
    enabled: f.enabled,
    ...(f.type === 'quota'
      ? {
          meter: f.meterKey,
          limit: f.limit,
          unlimited: f.unlimited,
          resetPeriod: f.resetPeriod,
          enforcement: f.enforcement,
        }
      : {}),
    ...(f.type === 'config' ? { value: f.config } : {}),
  };
}
