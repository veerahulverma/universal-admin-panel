import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { currencyCode, keySlug, likePattern, pageQuery, paginate } from '../../core/validation.js';
import { diff } from '../../core/json.js';
import { toCsv } from '../../core/csv.js';
import { catalogMigrations } from './migrations.js';
import { bundleContents, presentFeature, resolveEntitlements, subjectFor, type ResolvedFeature, type Subject } from './entitlements.js';
import { insertGeneratedCodes, randomCode } from './coupons.js';
import { available, stockLevels } from './purchases.js';
import { registerApiScopes } from '../developers/keys.js';
import { addSearchProvider } from '../core/routes.js';

const resetPeriods = ['none', 'day', 'week', 'month', 'year', 'billing_period', 'rolling'] as const;

/**
 * PATCH bodies reuse the create schemas with .partial(), but zod still fills
 * their defaults for absent fields; keep only the fields the client sent so an
 * update never silently resets the rest.
 */
function sent<T extends object>(body: T, raw: unknown): Partial<T> {
  const keys = new Set(raw && typeof raw === 'object' ? Object.keys(raw) : []);
  return Object.fromEntries(Object.entries(body).filter(([k]) => keys.has(k))) as Partial<T>;
}

const productBody = z.object({
  key: keySlug,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  kind: z.enum(['plan', 'addon', 'one_time', 'credit_pack']),
  planType: z.enum(['free', 'paid', 'lifetime', 'custom']).nullable().optional(),
  status: z.enum(['draft', 'active', 'archived']).default('active'),
  isPublic: z.boolean().default(true),
  subscriberType: z.enum(['user', 'organization']).default('user'),
  sortOrder: z.number().int().default(0),
  trialDays: z.number().int().min(0).max(365).default(0),
  trialRequiresPaymentMethod: z.boolean().default(false),
  graceDays: z.number().int().min(0).max(90).default(3),
  creditType: z.string().max(50).nullable().optional(),
  creditAmount: z.number().int().min(1).nullable().optional(),
  creditsExpireDays: z.number().int().min(1).max(3650).nullable().optional(),
  highlights: z.array(z.string().max(200)).max(20).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** Customers must have (or buy at the same time) one of these products. */
  requiresProducts: z.array(z.string()).max(100).default([]),
  /** Customers who have (or buy at the same time) one of these products cannot buy this one. */
  excludesProducts: z.array(z.string()).max(100).default([]),
  /** Units one customer can buy in all (null = no limit). */
  purchaseLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  /** Units for sale in all (null = unlimited). */
  stockLimit: z.number().int().min(0).max(100_000_000).nullable().optional(),
});

const tierSchema = z.object({ upTo: z.number().int().positive().nullable(), unitAmount: z.number().int().min(0), flatAmount: z.number().int().min(0).default(0) });

const priceBody = z
  .object({
    nickname: z.string().max(100).optional(),
    currency: currencyCode,
    type: z.enum(['recurring', 'one_time']),
    interval: z.enum(['day', 'week', 'month', 'year']).optional(),
    intervalCount: z.number().int().min(1).max(36).default(1),
    pricingModel: z.enum(['flat', 'per_seat', 'usage', 'tiered']).default('flat'),
    unitAmount: z.number().int().min(0).default(0),
    meterKey: z.string().optional(),
    includedUnits: z.number().int().min(0).default(0),
    tiers: z.array(tierSchema).max(20).optional(),
    tierMode: z.enum(['graduated', 'volume']).optional(),
    packageSize: z.number().int().min(1).optional(),
    taxBehavior: z.enum(['inclusive', 'exclusive']).default('exclusive'),
    introAmount: z.number().int().min(0).optional(),
    introCycles: z.number().int().min(1).max(36).optional(),
    minQuantity: z.number().int().min(1).default(1),
    maxQuantity: z.number().int().min(1).optional(),
    /** Installments: the subscription ends after this many paid periods (null = until cancelled). */
    paymentCount: z.number().int().min(1).max(600).nullable().optional(),
    /** After the last installment: access ends with the last paid period, or the customer keeps the product. */
    afterLastPayment: z.enum(['end_access', 'keep_access']).default('end_access'),
    /** One-time prices: access lasts this many days (null = for good). */
    accessDays: z.number().int().min(1).max(36_500).nullable().optional(),
    stockLimit: z.number().int().min(0).max(100_000_000).nullable().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.type === 'recurring' && !p.interval) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'Recurring prices need an interval' });
    if (p.type === 'one_time' && p.interval) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'One-time prices have no interval' });
    if (p.pricingModel === 'usage' && !p.meterKey) ctx.addIssue({ code: 'custom', path: ['meterKey'], message: 'Usage prices need a meter' });
    if (p.pricingModel === 'tiered' && !p.tiers?.length) ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Tiered prices need tiers' });
    if ((p.introAmount === undefined) !== (p.introCycles === undefined)) ctx.addIssue({ code: 'custom', path: ['introCycles'], message: 'Introductory pricing needs both an amount and a number of cycles' });
    if (p.paymentCount != null && p.type !== 'recurring') ctx.addIssue({ code: 'custom', path: ['paymentCount'], message: 'Only recurring prices are paid in installments' });
    if (p.paymentCount != null && p.pricingModel === 'usage') ctx.addIssue({ code: 'custom', path: ['paymentCount'], message: 'Usage-based prices are billed in arrears, so they cannot be paid in installments' });
    if (p.accessDays != null && p.type !== 'one_time') ctx.addIssue({ code: 'custom', path: ['accessDays'], message: 'Only one-time prices grant access for a number of days; subscriptions last until they end' });
  });

const productFeatureBody = z.object({
  featureKey: z.string(),
  enabled: z.boolean().default(true),
  limit: z.number().int().min(0).nullable().optional(),
  unlimited: z.boolean().default(false),
  resetPeriod: z.enum(resetPeriods).default('month'),
  rollingWindowSeconds: z.number().int().min(60).nullable().optional(),
  enforcement: z.enum(['hard', 'soft', 'overage']).default('hard'),
  warnAtPercent: z.number().int().min(1).max(100).default(80),
  graceUnits: z.number().int().min(0).default(0),
  overageUnitAmount: z.number().int().min(0).nullable().optional(),
  perSeat: z.boolean().default(false),
  config: z.unknown().optional(),
});

export function presentPrice(p: any) {
  return {
    id: p.id,
    productId: p.product_id,
    nickname: p.nickname,
    currency: p.currency,
    type: p.type,
    interval: p.interval,
    intervalCount: p.interval_count,
    pricingModel: p.pricing_model,
    unitAmount: p.unit_amount,
    meterKey: p.meter_key,
    includedUnits: p.included_units,
    tiers: p.tiers,
    tierMode: p.tier_mode,
    packageSize: p.package_size,
    taxBehavior: p.tax_behavior,
    introAmount: p.intro_amount,
    introCycles: p.intro_cycles,
    minQuantity: p.min_quantity,
    maxQuantity: p.max_quantity,
    paymentCount: p.payment_count,
    afterLastPayment: p.after_last_payment,
    accessDays: p.access_days,
    stockLimit: p.stock_limit,
    active: p.active,
  };
}

/** Products a rule or bundle refers to must exist and differ from the product itself. */
async function checkRelatedProducts(db: Db, productId: string | null, lists: Record<string, string[]>): Promise<void> {
  const ids = [...new Set(Object.values(lists).flat())];
  const found = new Set(ids.length ? (await db.many<{ id: string }>(sql`SELECT id FROM products WHERE id IN ${sql.in(ids)}`)).map((r) => r.id) : []);
  const issues: { path: (string | number)[]; message: string }[] = [];
  for (const [field, list] of Object.entries(lists)) {
    list.forEach((id, i) => {
      if (id === productId) issues.push({ path: [field, i], message: 'A product cannot refer to itself' });
      else if (!found.has(id)) issues.push({ path: [field, i], message: `Unknown product ${id}` });
    });
  }
  const requires = lists.requiresProducts ?? [];
  if ((lists.excludesProducts ?? []).some((id) => requires.includes(id))) issues.push({ path: ['excludesProducts'], message: 'A product cannot be both required and excluded' });
  if (issues.length) throw validationError(issues);
}

/** Public catalog for pricing tables (active, public plans and add-ons with their active prices). */
export async function publicCatalog(db: Db, opts: { currency?: string } = {}) {
  const products = await db.many<any>(sql`
    SELECT id, key, name, description, kind, plan_type, subscriber_type, trial_days, highlights, sort_order, metadata, stock_limit
    FROM products WHERE status = 'active' AND is_public ORDER BY kind, sort_order, name
  `);
  if (!products.length) return [];
  const ids = products.map((p) => p.id);
  const prices = await db.many<any>(sql`
    SELECT * FROM prices WHERE active AND product_id IN ${sql.in(ids)} ${opts.currency ? sql`AND currency = ${opts.currency}` : sql.empty}
    ORDER BY unit_amount
  `);
  const features = await db.many<any>(sql`
    SELECT pf.product_id, f.key, f.name, f.type, f.unit, pf.enabled, pf.limit_value, pf.unlimited, pf.reset_period, pf.config_value
    FROM product_features pf JOIN features f ON f.id = pf.feature_id WHERE pf.product_id IN ${sql.in(ids)} ORDER BY f.name
  `);
  const limited = products.some((p) => p.stock_limit !== null) || prices.some((p) => p.stock_limit !== null);
  const levels = limited ? await stockLevels(db, ids) : null;
  return products.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    kind: p.kind,
    planType: p.plan_type,
    subscriberType: p.subscriber_type,
    trialDays: p.trial_days,
    highlights: p.highlights,
    metadata: p.metadata,
    /** Units left when stock is limited (null = unlimited). */
    available: available(p.stock_limit, levels?.products.get(p.id)),
    prices: prices.filter((x) => x.product_id === p.id).map((x) => ({ ...presentPrice(x), available: available(x.stock_limit, levels?.prices.get(x.id)) })),
    features: features
      .filter((f) => f.product_id === p.id)
      .map((f) => ({ key: f.key, name: f.name, type: f.type, unit: f.unit, enabled: f.enabled, limit: f.unlimited ? null : f.limit_value, unlimited: f.unlimited, resetPeriod: f.reset_period, value: f.config_value })),
  }));
}

export interface UsageSnapshot {
  used: number;
  reserved: number;
  periodStart: Date;
  periodEnd: Date | null;
}
export type CurrentUsageFn = (db: Db, subject: Subject, feature: ResolvedFeature) => Promise<UsageSnapshot>;

async function presentEntitlements(app: App, db: Db, subject: Subject) {
  const ent = await resolveEntitlements(db, app, subject);
  const usageFn = app.modules.isEnabled('usage') ? (app.services['usage.current'] as CurrentUsageFn | undefined) : undefined;
  const features: Record<string, unknown> = {};
  for (const f of Object.values(ent.features)) {
    const base: Record<string, unknown> = presentFeature(f);
    if (f.type === 'quota' && usageFn && f.enabled) {
      const u = await usageFn(db, subject, f);
      base.used = u.used;
      base.remaining = f.limit === null ? null : Math.max(0, f.limit - u.used - u.reserved);
      base.resetsAt = u.periodEnd;
    }
    features[f.key] = base;
  }
  return { subject: ent.subject, plans: ent.plans, features };
}

/** Decide whether a subject may use `quantity` of a feature right now (no usage is recorded). */
async function checkFeature(app: App, db: Db, subject: Subject, featureKey: string, quantity: number) {
  const ent = await resolveEntitlements(db, app, subject);
  const f = ent.features[featureKey];
  if (!f) return { allowed: false, reason: 'unknown_feature', feature: featureKey };
  if (!f.enabled) return { allowed: false, reason: 'not_in_plan', feature: featureKey };
  if (f.type !== 'quota') return { allowed: true, feature: featureKey, value: f.config ?? null };
  if (f.unlimited) return { allowed: true, feature: featureKey, limit: null, remaining: null };
  const usageFn = app.modules.isEnabled('usage') ? (app.services['usage.current'] as CurrentUsageFn | undefined) : undefined;
  const u = usageFn ? await usageFn(db, subject, f) : { used: 0, reserved: 0, periodEnd: null };
  const remaining = Math.max(0, (f.limit ?? 0) - u.used - u.reserved);
  const allowed = f.enforcement !== 'hard' || quantity <= remaining + f.graceUnits;
  return { allowed, reason: allowed ? null : 'limit_exceeded', feature: featureKey, limit: f.limit, used: u.used, remaining, enforcement: f.enforcement, resetsAt: u.periodEnd };
}

export const catalogModule: ModuleDefinition = {
  id: 'catalog',
  name: 'Plans & entitlements',
  description: 'Products, plans, add-ons, prices, features, usage meters, coupons and the entitlement engine.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers', 'developers'],
  migrations: catalogMigrations,
  permissions: [
    { key: 'catalog.products.view', label: 'View plans and products' },
    { key: 'catalog.products.manage', label: 'Create and edit plans, prices and features' },
    { key: 'catalog.coupons.view', label: 'View coupons' },
    { key: 'catalog.coupons.manage', label: 'Create and edit coupons' },
    { key: 'catalog.entitlements.view', label: 'View customer entitlements' },
    { key: 'catalog.entitlements.manage', label: 'Grant plans and override limits', dangerous: true },
  ],
  nav: [
    { id: 'plans', label: 'Plans & products', path: '/catalog/products', icon: 'package', section: 'catalog', permission: 'catalog.products.view', order: 0 },
    { id: 'features', label: 'Features & meters', path: '/catalog/features', icon: 'gauge', section: 'catalog', permission: 'catalog.products.view', order: 10 },
    { id: 'coupons', label: 'Coupons', path: '/catalog/coupons', icon: 'ticket-percent', section: 'growth', permission: 'catalog.coupons.view', order: 30 },
  ],
  events: [
    { type: 'entitlements.updated', description: 'A subject gained or lost access (grant, override or plan change)' },
    { type: 'product.updated', description: 'A plan or product changed' },
  ],
  setup(app) {
    app.settings.define({
      key: 'catalog',
      module: 'catalog',
      label: 'Plans & entitlements',
      description: 'Default plan for customers without a subscription and policy for unmapped meters.',
      schema: z.object({ defaultPlanKey: z.string().max(64), unknownMeterPolicy: z.enum(['allow', 'deny']) }),
      defaults: { defaultPlanKey: 'free', unknownMeterPolicy: 'allow' },
      permission: 'catalog.products.manage',
    });
    registerApiScopes(app, 'catalog', [
      { scope: 'catalog:read', description: 'Read public plans and prices' },
      { scope: 'entitlements:read', description: 'Read and check entitlements' },
      { scope: 'entitlements:write', description: 'Grant products to users and organizations' },
    ]);
    addSearchProvider(app, 'catalog', 'catalog.products.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; name: string; key: string; kind: string }>(sql`
        SELECT id, name, key, kind FROM products WHERE name ILIKE ${likePattern(q)} OR key ILIKE ${likePattern(q)} LIMIT 5
      `);
      return rows.map((p) => ({ type: 'product', id: p.id, title: p.name, subtitle: `${p.kind} · ${p.key}`, url: `/catalog/products/${p.id}` }));
    });
    app.services['catalog.resolve'] = (db: Db, subject: Subject) => resolveEntitlements(db, app, subject);
  },
  routes(r, app) {
    // ---- Products ---------------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/products',
      auth: 'admin',
      permission: 'catalog.products.view',
      summary: 'List products, plans and add-ons',
      tags: ['Catalog'],
      query: z.object({ kind: z.enum(['plan', 'addon', 'one_time', 'credit_pack']).optional(), status: z.enum(['draft', 'active', 'archived']).optional(), q: z.string().max(100).optional() }),
      handler: async (c) => {
        const rows = await app.db.many<any>(sql`
          SELECT p.*, (SELECT count(*)::int FROM prices pr WHERE pr.product_id = p.id AND pr.active) AS price_count,
                 (SELECT count(*)::int FROM product_features pf WHERE pf.product_id = p.id) AS feature_count
          FROM products p ${sql.where([
            c.query.kind && sql`p.kind = ${c.query.kind}`,
            c.query.status ? sql`p.status = ${c.query.status}` : sql`p.status <> 'archived'`,
            c.query.q && sql`(p.name ILIKE ${likePattern(c.query.q)} OR p.key ILIKE ${likePattern(c.query.q)})`,
          ])} ORDER BY p.kind, p.sort_order, p.name
        `);
        const stats = await app.hooks.apply<Record<string, Record<string, unknown>>>('catalog.products.stats', {}, { ids: rows.map((p) => p.id) });
        return { data: rows.map((p) => ({ ...p, ...(stats[p.id] ?? {}) })) };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/products',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Create a product (plan, add-on, one-time product or credit pack)',
      tags: ['Catalog'],
      body: productBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          if (await tx.maybe(sql`SELECT 1 FROM products WHERE key = ${c.body.key}`)) throw conflict('A product with this key exists', 'key_taken');
          const b = c.body;
          if (b.kind === 'credit_pack' && (!b.creditType || !b.creditAmount)) throw validationError([{ path: ['creditAmount'], message: 'Credit packs need a credit type and amount' }]);
          await checkRelatedProducts(tx, null, { requiresProducts: b.requiresProducts, excludesProducts: b.excludesProducts });
          const now = app.clock.now();
          const row = await tx.one(sql.insert('products', {
            id: newId('prod'),
            key: b.key,
            name: b.name,
            description: b.description,
            kind: b.kind,
            plan_type: b.kind === 'plan' ? b.planType ?? 'paid' : null,
            status: b.status,
            is_public: b.isPublic,
            subscriber_type: b.subscriberType,
            sort_order: b.sortOrder,
            trial_days: b.trialDays,
            trial_requires_payment_method: b.trialRequiresPaymentMethod,
            grace_days: b.graceDays,
            credit_type: b.creditType ?? null,
            credit_amount: b.creditAmount ?? null,
            credits_expire_days: b.creditsExpireDays ?? null,
            highlights: b.highlights,
            metadata: b.metadata,
            requires_products: b.requiresProducts,
            excludes_products: b.excludesProducts,
            purchase_limit: b.purchaseLimit ?? null,
            stock_limit: b.stockLimit ?? null,
            created_at: now,
            updated_at: now,
          }));
          await c.audit(tx, 'product.create', { type: 'product', id: row.id }, { key: b.key, kind: b.kind });
          return row;
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/products/:id',
      auth: 'admin',
      permission: 'catalog.products.view',
      summary: 'Product with prices and feature configuration',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const product = await app.db.maybe<any>(sql`SELECT * FROM products WHERE id = ${c.params.id} OR key = ${c.params.id}`);
        if (!product) throw notFound('Product');
        const [prices, features, bundle, includedIn, levels] = await Promise.all([
          app.db.many<any>(sql`SELECT * FROM prices WHERE product_id = ${product.id} ORDER BY active DESC, currency, unit_amount`),
          app.db.many(sql`
            SELECT f.id AS feature_id, f.key, f.name, f.type, f.meter_key, f.unit, pf.enabled, pf.limit_value, pf.unlimited, pf.reset_period,
                   pf.rolling_window_seconds, pf.enforcement, pf.warn_at_percent, pf.grace_units, pf.overage_unit_amount, pf.per_seat, pf.config_value
            FROM product_features pf JOIN features f ON f.id = pf.feature_id WHERE pf.product_id = ${product.id} ORDER BY f.name
          `),
          app.db.many(sql`SELECT p.id, p.key, p.name, p.kind, p.status FROM product_bundle_items b JOIN products p ON p.id = b.product_id WHERE b.bundle_id = ${product.id} ORDER BY p.name`),
          app.db.many(sql`SELECT p.id, p.key, p.name, p.kind, p.status FROM product_bundle_items b JOIN products p ON p.id = b.bundle_id WHERE b.product_id = ${product.id} ORDER BY p.name`),
          stockLevels(app.db, [product.id]),
        ]);
        const level = levels.products.get(product.id);
        return {
          ...product,
          stock: { limit: product.stock_limit, sold: level?.sold ?? 0, reserved: level?.reserved ?? 0, available: available(product.stock_limit, level) },
          prices: prices.map((p) => {
            const l = levels.prices.get(p.id);
            return { ...presentPrice(p), stock: { sold: l?.sold ?? 0, reserved: l?.reserved ?? 0, available: available(p.stock_limit, l) } };
          }),
          features,
          bundle,
          includedIn,
        };
      },
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/products/:id',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Update a product',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: productBody.omit({ key: true, kind: true }).partial(),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const before = await tx.maybe<any>(sql`SELECT * FROM products WHERE id = ${c.params.id} FOR UPDATE`);
          if (!before) throw notFound('Product');
          const b = sent(c.body, c.req.body);
          if (b.requiresProducts || b.excludesProducts) {
            await checkRelatedProducts(tx, before.id, { requiresProducts: b.requiresProducts ?? before.requires_products, excludesProducts: b.excludesProducts ?? before.excludes_products });
          }
          const patch = {
            name: b.name,
            description: b.description,
            plan_type: b.planType,
            status: b.status,
            is_public: b.isPublic,
            subscriber_type: b.subscriberType,
            sort_order: b.sortOrder,
            trial_days: b.trialDays,
            trial_requires_payment_method: b.trialRequiresPaymentMethod,
            grace_days: b.graceDays,
            credit_type: b.creditType,
            credit_amount: b.creditAmount,
            credits_expire_days: b.creditsExpireDays,
            highlights: b.highlights,
            metadata: b.metadata,
            requires_products: b.requiresProducts,
            excludes_products: b.excludesProducts,
            purchase_limit: b.purchaseLimit,
            stock_limit: b.stockLimit,
          };
          const row = await tx.one(sql`UPDATE products SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${c.params.id} RETURNING *`);
          const changes = diff(before, patch);
          await c.audit(tx, 'product.update', { type: 'product', id: c.params.id }, { changes });
          await app.events.emit(tx, 'product.updated', { productId: c.params.id, changes: Object.keys(changes) });
          return row;
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/products/:id/duplicate',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Duplicate a product with its prices and features (as a draft)',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: z.object({ key: keySlug, name: z.string().trim().min(1).max(120) }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const src = await tx.maybe<any>(sql`SELECT * FROM products WHERE id = ${c.params.id}`);
          if (!src) throw notFound('Product');
          if (await tx.maybe(sql`SELECT 1 FROM products WHERE key = ${c.body.key}`)) throw conflict('A product with this key exists', 'key_taken');
          const now = app.clock.now();
          const id = newId('prod');
          const { id: _id, key: _key, name: _name, created_at: _c, updated_at: _u, status: _s, gateway_refs: _g, ...rest } = src;
          await tx.exec(sql.insert('products', { ...rest, id, key: c.body.key, name: c.body.name, status: 'draft', gateway_refs: {}, created_at: now, updated_at: now }, ''));
          await tx.exec(sql`
            INSERT INTO product_features (product_id, feature_id, enabled, limit_value, unlimited, reset_period, rolling_window_seconds, enforcement, warn_at_percent, grace_units, overage_unit_amount, per_seat, config_value)
            SELECT ${id}, feature_id, enabled, limit_value, unlimited, reset_period, rolling_window_seconds, enforcement, warn_at_percent, grace_units, overage_unit_amount, per_seat, config_value
            FROM product_features WHERE product_id = ${src.id}
          `);
          const prices = await tx.many<any>(sql`SELECT * FROM prices WHERE product_id = ${src.id} AND active`);
          for (const p of prices) {
            const { id: _pid, product_id: _pp, created_at: _pc, gateway_refs: _gr, ...prest } = p;
            await tx.exec(sql.insert('prices', { ...prest, id: newId('price'), product_id: id, gateway_refs: {}, created_at: now }, ''));
          }
          await tx.exec(sql`INSERT INTO product_bundle_items (bundle_id, product_id, created_at) SELECT ${id}, product_id, ${now} FROM product_bundle_items WHERE bundle_id = ${src.id}`);
          await c.audit(tx, 'product.duplicate', { type: 'product', id }, { from: src.id });
          return tx.one(sql`SELECT * FROM products WHERE id = ${id}`);
        }),
    });

    r.route({
      method: 'PUT',
      url: '/api/admin/products/:id/features',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: "Replace a product's feature and limit configuration",
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: z.object({ features: z.array(productFeatureBody).max(500) }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const product = await tx.maybe<{ id: string }>(sql`SELECT id FROM products WHERE id = ${c.params.id} FOR UPDATE`);
          if (!product) throw notFound('Product');
          const keys = c.body.features.map((f) => f.featureKey);
          const defs = keys.length ? await tx.many<{ id: string; key: string; type: string }>(sql`SELECT id, key, type FROM features WHERE key IN ${sql.in(keys)}`) : [];
          const byKey = new Map(defs.map((d) => [d.key, d]));
          const missing = keys.filter((k) => !byKey.has(k));
          if (missing.length) throw validationError([{ path: ['features'], message: `Unknown features: ${missing.join(', ')}` }]);
          const issues: { path: (string | number)[]; message: string }[] = [];
          c.body.features.forEach((f, i) => {
            const def = byKey.get(f.featureKey)!;
            if (def.type === 'quota' && !f.unlimited && (f.limit === null || f.limit === undefined)) issues.push({ path: ['features', i, 'limit'], message: `${f.featureKey}: set a limit or mark unlimited` });
            if (f.resetPeriod === 'rolling' && !f.rollingWindowSeconds) issues.push({ path: ['features', i, 'rollingWindowSeconds'], message: 'Rolling windows need a window length' });
            if (f.enforcement === 'overage' && (f.overageUnitAmount === null || f.overageUnitAmount === undefined)) issues.push({ path: ['features', i, 'overageUnitAmount'], message: 'Overage billing needs a price per unit' });
          });
          if (issues.length) throw validationError(issues);
          await tx.exec(sql`DELETE FROM product_features WHERE product_id = ${product.id}`);
          for (const f of c.body.features) {
            await tx.exec(sql.insert('product_features', {
              product_id: product.id,
              feature_id: byKey.get(f.featureKey)!.id,
              enabled: f.enabled,
              limit_value: f.unlimited ? null : f.limit ?? null,
              unlimited: f.unlimited,
              reset_period: f.resetPeriod,
              rolling_window_seconds: f.rollingWindowSeconds ?? null,
              enforcement: f.enforcement,
              warn_at_percent: f.warnAtPercent,
              grace_units: f.graceUnits,
              overage_unit_amount: f.overageUnitAmount ?? null,
              per_seat: f.perSeat,
              config_value: f.config === undefined ? null : sql.json(f.config),
            }, ''));
          }
          await c.audit(tx, 'product.features_update', { type: 'product', id: product.id }, { features: keys });
          await app.events.emit(tx, 'product.updated', { productId: product.id, changes: ['features'] });
          return { ok: true, count: c.body.features.length };
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/products/:id/prices',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Add a price (prices are immutable; archive and add a new one to change amounts)',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: priceBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const product = await tx.maybe<any>(sql`SELECT id, kind FROM products WHERE id = ${c.params.id}`);
          if (!product) throw notFound('Product');
          const b = c.body;
          if ((product.kind === 'one_time' || product.kind === 'credit_pack') && b.type !== 'one_time') {
            throw validationError([{ path: ['type'], message: 'One-time products and credit packs need one-time prices' }]);
          }
          if (product.kind === 'credit_pack' && b.accessDays) throw validationError([{ path: ['accessDays'], message: 'Credit packs add credits; they grant no access period' }]);
          if (b.meterKey && !(await tx.maybe(sql`SELECT 1 FROM meters WHERE key = ${b.meterKey}`))) throw validationError([{ path: ['meterKey'], message: 'Unknown meter' }]);
          const row = await tx.one(sql.insert('prices', {
            id: newId('price'),
            product_id: product.id,
            nickname: b.nickname ?? null,
            currency: b.currency,
            type: b.type,
            interval: b.type === 'recurring' ? b.interval : null,
            interval_count: b.intervalCount,
            pricing_model: b.pricingModel,
            unit_amount: b.unitAmount,
            meter_key: b.meterKey ?? null,
            included_units: b.includedUnits,
            tiers: b.tiers ?? null,
            tier_mode: b.tiers ? b.tierMode ?? 'graduated' : null,
            package_size: b.packageSize ?? null,
            tax_behavior: b.taxBehavior,
            intro_amount: b.introAmount ?? null,
            intro_cycles: b.introCycles ?? null,
            min_quantity: b.minQuantity,
            max_quantity: b.maxQuantity ?? null,
            payment_count: b.type === 'recurring' ? b.paymentCount ?? null : null,
            after_last_payment: b.afterLastPayment,
            access_days: b.type === 'one_time' ? b.accessDays ?? null : null,
            stock_limit: b.stockLimit ?? null,
            active: true,
            created_at: app.clock.now(),
          }));
          await c.audit(tx, 'price.create', { type: 'price', id: row.id }, { productId: product.id, currency: b.currency, unitAmount: b.unitAmount, paymentCount: row.payment_count, accessDays: row.access_days, stockLimit: row.stock_limit });
          return presentPrice(row);
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/prices/:id',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Rename, archive or re-activate a price, or change its stock limit',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: z.object({
        nickname: z.string().max(100).nullable().optional(),
        active: z.boolean().optional(),
        gatewayRefs: z.record(z.string(), z.string()).optional(),
        stockLimit: z.number().int().min(0).max(100_000_000).nullable().optional(),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe(sql`
            UPDATE prices SET ${sql.set({ nickname: c.body.nickname, active: c.body.active, gateway_refs: c.body.gatewayRefs, stock_limit: c.body.stockLimit })} WHERE id = ${c.params.id} RETURNING *
          `);
          if (!row) throw notFound('Price');
          await c.audit(tx, 'price.update', { type: 'price', id: c.params.id }, c.body);
          return presentPrice(row);
        }),
    });

    r.route({
      method: 'PUT',
      url: '/api/admin/products/:id/bundle',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Set the products a bundle includes',
      description: 'Owning the bundle (by subscription, purchase or grant) confers the features and plans of every included product.',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: z.object({ productIds: z.array(z.string()).max(50) }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const product = await tx.maybe<{ id: string; name: string; kind: string }>(sql`SELECT id, name, kind FROM products WHERE id = ${c.params.id} FOR UPDATE`);
          if (!product) throw notFound('Product');
          const ids = [...new Set(c.body.productIds)];
          if (product.kind === 'credit_pack' && ids.length) throw validationError([{ path: ['productIds'], message: 'Credit packs add credits; they cannot include products' }]);
          await checkRelatedProducts(tx, product.id, { productIds: ids });
          const before = (await tx.many<{ product_id: string }>(sql`SELECT product_id FROM product_bundle_items WHERE bundle_id = ${product.id}`)).map((r) => r.product_id);
          const included = ids.length ? await tx.many<{ id: string; name: string; kind: string; status: string }>(sql`SELECT id, name, kind, status FROM products WHERE id IN ${sql.in(ids)}`) : [];
          const issues: { path: (string | number)[]; message: string }[] = [];
          for (const p of included) {
            const path = ['productIds', ids.indexOf(p.id)];
            if (p.kind === 'credit_pack') issues.push({ path, message: `${p.name} is a credit pack; credits are bought, not included` });
            else if (p.status === 'archived' && !before.includes(p.id)) issues.push({ path, message: `${p.name} is archived` });
            else if ((await bundleContents(tx, p.id)).has(product.id)) issues.push({ path, message: `${p.name} already includes ${product.name}` });
          }
          if (issues.length) throw validationError(issues);
          const now = app.clock.now();
          await tx.exec(sql`DELETE FROM product_bundle_items WHERE bundle_id = ${product.id}`);
          if (ids.length) await tx.exec(sql.insertMany('product_bundle_items', ids.map((id) => ({ bundle_id: product.id, product_id: id, created_at: now })), ''));
          await tx.exec(sql`UPDATE products SET updated_at = ${now} WHERE id = ${product.id}`);
          await c.audit(tx, 'product.bundle_update', { type: 'product', id: product.id }, { productIds: ids, previous: before });
          await app.events.emit(tx, 'product.updated', { productId: product.id, changes: ['bundle'] });
          return { productIds: ids };
        }),
    });

    // ---- Features & meters --------------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/features',
      auth: 'admin',
      permission: 'catalog.products.view',
      summary: 'Feature catalog',
      tags: ['Catalog'],
      handler: async () => ({
        data: await app.db.many(sql`
          SELECT f.*, (SELECT count(*)::int FROM product_features pf WHERE pf.feature_id = f.id) AS product_count FROM features f ORDER BY f.name
        `),
      }),
    });

    const featureBody = z.object({
      key: keySlug,
      name: z.string().trim().min(1).max(120),
      description: z.string().max(1000).default(''),
      type: z.enum(['boolean', 'quota', 'config']),
      meterKey: z.string().optional(),
      unit: z.string().max(30).optional(),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/features',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Define a feature (boolean flag, quota on a meter, or configuration value)',
      tags: ['Catalog'],
      body: featureBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const b = c.body;
          if (b.type === 'quota') {
            if (!b.meterKey) throw validationError([{ path: ['meterKey'], message: 'Quota features need a meter' }]);
            if (!(await tx.maybe(sql`SELECT 1 FROM meters WHERE key = ${b.meterKey}`))) throw validationError([{ path: ['meterKey'], message: 'Unknown meter' }]);
            if (await tx.maybe(sql`SELECT 1 FROM features WHERE meter_key = ${b.meterKey}`)) throw conflict('Another feature already limits this meter', 'meter_in_use');
          }
          if (await tx.maybe(sql`SELECT 1 FROM features WHERE key = ${b.key}`)) throw conflict('A feature with this key exists', 'key_taken');
          const now = app.clock.now();
          const row = await tx.one(sql.insert('features', { id: newId('feat'), key: b.key, name: b.name, description: b.description, type: b.type, meter_key: b.type === 'quota' ? b.meterKey : null, unit: b.unit ?? null, created_at: now, updated_at: now }));
          await c.audit(tx, 'feature.create', { type: 'feature', id: row.id }, b);
          return row;
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/features/:id',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Update a feature',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: featureBody.pick({ name: true, description: true, unit: true }).partial(),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const b = sent(c.body, c.req.body);
          const row = await tx.maybe(sql`UPDATE features SET ${sql.set({ ...b, updated_at: app.clock.now() })} WHERE id = ${c.params.id} RETURNING *`);
          if (!row) throw notFound('Feature');
          await c.audit(tx, 'feature.update', { type: 'feature', id: c.params.id }, b);
          return row;
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/features/:id',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Delete a feature that no product uses',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const used = await tx.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM product_features WHERE feature_id = ${c.params.id}`);
          if (used.count) throw conflict(`Used by ${used.count} product(s)`, 'feature_in_use');
          const n = await tx.exec(sql`DELETE FROM features WHERE id = ${c.params.id}`);
          if (!n) throw notFound('Feature');
          await c.audit(tx, 'feature.delete', { type: 'feature', id: c.params.id });
        });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/meters',
      auth: 'admin',
      permission: 'catalog.products.view',
      summary: 'Usage meters',
      tags: ['Catalog'],
      query: z.object({ includeArchived: z.enum(['true', 'false']).optional() }),
      handler: async (c) => ({
        data: await app.db.many(sql`
          SELECT m.*, (SELECT f.key FROM features f WHERE f.meter_key = m.key) AS feature_key
          FROM meters m ${c.query.includeArchived === 'true' ? sql.empty : sql`WHERE NOT m.archived`} ORDER BY m.name
        `),
      }),
    });

    const meterBody = z.object({
      key: keySlug,
      name: z.string().trim().min(1).max(120),
      description: z.string().max(1000).default(''),
      unit: z.string().max(30).default('units'),
      kind: z.enum(['counter', 'gauge']).default('counter'),
      weights: z.record(z.string(), z.record(z.string(), z.number().positive())).default({}),
      creditType: z.string().max(50).nullable().optional(),
      creditsPerUnit: z.number().positive().nullable().optional(),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/meters',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Define a usage meter for any measurable resource',
      tags: ['Catalog'],
      body: meterBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          if (await tx.maybe(sql`SELECT 1 FROM meters WHERE key = ${c.body.key}`)) throw conflict('A meter with this key exists', 'key_taken');
          if (Boolean(c.body.creditType) !== Boolean(c.body.creditsPerUnit)) throw validationError([{ path: ['creditsPerUnit'], message: 'Set both a credit type and credits per unit, or neither' }]);
          const now = app.clock.now();
          const row = await tx.one(sql.insert('meters', {
            id: newId('mtr'),
            key: c.body.key,
            name: c.body.name,
            description: c.body.description,
            unit: c.body.unit,
            kind: c.body.kind,
            weights: c.body.weights,
            credit_type: c.body.creditType ?? null,
            credits_per_unit: c.body.creditsPerUnit ?? null,
            created_at: now,
            updated_at: now,
          }));
          await c.audit(tx, 'meter.create', { type: 'meter', id: row.id }, c.body);
          return row;
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/meters/:id',
      auth: 'admin',
      permission: 'catalog.products.manage',
      summary: 'Update a meter (weights, credit consumption, archive)',
      tags: ['Catalog'],
      params: z.object({ id: z.string() }),
      body: meterBody.omit({ key: true, kind: true }).partial().extend({ archived: z.boolean().optional() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const b = sent(c.body, c.req.body);
          const row = await tx.maybe(sql`
            UPDATE meters SET ${sql.set({
              name: b.name,
              description: b.description,
              unit: b.unit,
              weights: b.weights,
              credit_type: b.creditType,
              credits_per_unit: b.creditsPerUnit,
              archived: b.archived,
              updated_at: app.clock.now(),
            })} WHERE id = ${c.params.id} RETURNING *
          `);
          if (!row) throw notFound('Meter');
          await c.audit(tx, 'meter.update', { type: 'meter', id: c.params.id }, b);
          return row;
        }),
    });

    // ---- Coupons --------------------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/admin/coupons',
      auth: 'admin',
      permission: 'catalog.coupons.view',
      summary: 'Coupons and promotions',
      tags: ['Coupons'],
      query: z.object({ ...pageQuery, active: z.enum(['true', 'false']).optional(), q: z.string().max(100).optional(), batchId: z.string().optional() }),
      handler: (c) =>
        paginate(app.db, {
          select: sql`*`,
          from: sql`coupons`,
          where: sql.where([
            c.query.active && sql`active = ${c.query.active === 'true'}`,
            c.query.q && sql`(code ILIKE ${likePattern(c.query.q)} OR name ILIKE ${likePattern(c.query.q)} OR campaign ILIKE ${likePattern(c.query.q)})`,
            // Batch codes are listed per batch (or found by searching), not among the hand-made coupons.
            c.query.batchId ? sql`batch_id = ${c.query.batchId}` : !c.query.q && sql`batch_id IS NULL`,
          ]),
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        }),
    });

    /** What a coupon gives and when it applies; shared by single coupons and generated batches. */
    const couponTerms = {
      discountType: z.enum(['percent', 'fixed']),
      percentOff: z.number().min(0.01).max(100).optional(),
      amountOff: z.number().int().min(1).optional(),
      currency: currencyCode.optional(),
      duration: z.enum(['once', 'repeating', 'forever']).default('once'),
      durationCycles: z.number().int().min(1).max(120).optional(),
      appliesTo: z.array(z.string()).max(200).default([]),
      firstPurchaseOnly: z.boolean().default(false),
      minAmount: z.number().int().min(0).optional(),
      startsAt: z.coerce.date().optional(),
      expiresAt: z.coerce.date().optional(),
      campaign: z.string().max(100).optional(),
    };
    const couponTermsSchema = z.object(couponTerms);
    type CouponTerms = z.infer<typeof couponTermsSchema>;
    const checkCouponTerms = (b: CouponTerms, ctx: z.RefinementCtx<CouponTerms>) => {
      if (b.discountType === 'percent' && !b.percentOff) ctx.addIssue({ code: 'custom', path: ['percentOff'], message: 'Enter a percentage' });
      if (b.discountType === 'fixed' && (!b.amountOff || !b.currency)) ctx.addIssue({ code: 'custom', path: ['amountOff'], message: 'Enter an amount and currency' });
      if (b.duration === 'repeating' && !b.durationCycles) ctx.addIssue({ code: 'custom', path: ['durationCycles'], message: 'How many billing cycles?' });
    };
    const couponColumns = (b: CouponTerms) => ({
      discount_type: b.discountType,
      percent_off_bps: b.discountType === 'percent' ? Math.round(b.percentOff! * 100) : null,
      amount_off: b.discountType === 'fixed' ? b.amountOff : null,
      currency: b.discountType === 'fixed' ? b.currency : null,
      duration: b.duration,
      duration_cycles: b.duration === 'repeating' ? b.durationCycles : null,
      applies_to: b.appliesTo,
      first_purchase_only: b.firstPurchaseOnly,
      min_amount: b.minAmount ?? null,
      starts_at: b.startsAt ?? null,
      expires_at: b.expiresAt ?? null,
      campaign: b.campaign ?? null,
    });

    const couponBody = z
      .object({
        code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, dashes and underscores'),
        name: z.string().trim().min(1).max(120),
        ...couponTerms,
        maxRedemptions: z.number().int().min(1).optional(),
        maxPerCustomer: z.number().int().min(1).max(1000).default(1),
        affiliateId: z.string().optional(),
      })
      .superRefine(checkCouponTerms);

    r.route({
      method: 'POST',
      url: '/api/admin/coupons',
      auth: 'admin',
      permission: 'catalog.coupons.manage',
      summary: 'Create a coupon',
      tags: ['Coupons'],
      body: couponBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const b = c.body;
          if (await tx.maybe(sql`SELECT 1 FROM coupons WHERE lower(code) = ${b.code.toLowerCase()}`)) throw conflict('This code is already in use', 'code_taken');
          const now = app.clock.now();
          const row = await tx.one(sql.insert('coupons', {
            id: newId('cpn'),
            code: b.code,
            name: b.name,
            ...couponColumns(b),
            max_redemptions: b.maxRedemptions ?? null,
            max_per_customer: b.maxPerCustomer,
            affiliate_id: b.affiliateId ?? null,
            created_at: now,
            updated_at: now,
          }));
          await c.audit(tx, 'coupon.create', { type: 'coupon', id: row.id }, { code: b.code });
          return row;
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/coupons/:id',
      auth: 'admin',
      permission: 'catalog.coupons.manage',
      summary: 'Update or deactivate a coupon',
      tags: ['Coupons'],
      params: z.object({ id: z.string() }),
      body: z.object({ name: z.string().max(120).optional(), active: z.boolean().optional(), expiresAt: z.coerce.date().nullable().optional(), maxRedemptions: z.number().int().min(1).nullable().optional() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe(sql`
            UPDATE coupons SET ${sql.set({ name: c.body.name, active: c.body.active, expires_at: c.body.expiresAt, max_redemptions: c.body.maxRedemptions, updated_at: app.clock.now() })}
            WHERE id = ${c.params.id} RETURNING *
          `);
          if (!row) throw notFound('Coupon');
          await c.audit(tx, 'coupon.update', { type: 'coupon', id: c.params.id }, c.body);
          return row;
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/coupons/:id/redemptions',
      auth: 'admin',
      permission: 'catalog.coupons.view',
      summary: 'Who redeemed a coupon',
      tags: ['Coupons'],
      params: z.object({ id: z.string() }),
      handler: async (c) => ({
        data: await app.db.many(sql`
          SELECT r.*, u.email AS user_email FROM coupon_redemptions r LEFT JOIN users u ON u.id = r.user_id
          WHERE r.coupon_id = ${c.params.id} ORDER BY r.created_at DESC LIMIT 500
        `),
      }),
    });

    // ---- Coupon batches --------------------------------------------------------------------
    const couponBatchBody = z
      .object({
        name: z.string().trim().min(1).max(120),
        /** Prepended to every code, e.g. "SPRING-"; prefix and random part fit the 40-character code limit. */
        prefix: z.string().trim().max(20).regex(/^[A-Za-z0-9_-]*$/, 'Letters, numbers, dashes and underscores').default(''),
        count: z.number().int().min(1).max(5000),
        codeLength: z.number().int().min(6).max(16).default(8),
        ...couponTerms,
      })
      .superRefine(checkCouponTerms);

    /** Batches with their codes' terms (shared by every code) and how many were redeemed. */
    const couponBatches = (db: Db, id?: string) =>
      db.many<any>(sql`
        SELECT b.*, s.codes, s.redeemed, s.active_codes, t.discount_type, t.percent_off_bps, t.amount_off, t.currency, t.duration, t.duration_cycles, t.starts_at, t.expires_at
        FROM coupon_batches b
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS codes, count(*) FILTER (WHERE redeemed_count > 0)::int AS redeemed, count(*) FILTER (WHERE active)::int AS active_codes
          FROM coupons WHERE batch_id = b.id
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT discount_type, percent_off_bps, amount_off, currency, duration, duration_cycles, starts_at, expires_at FROM coupons WHERE batch_id = b.id LIMIT 1
        ) t ON TRUE
        ${id ? sql`WHERE b.id = ${id}` : sql.empty}
        ORDER BY b.created_at DESC LIMIT 200
      `);

    r.route({
      method: 'GET',
      url: '/api/admin/coupon-batches',
      auth: 'admin',
      permission: 'catalog.coupons.view',
      summary: 'Batches of generated single-use coupon codes',
      tags: ['Coupons'],
      handler: async () => ({ data: await couponBatches(app.db) }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/coupon-batches',
      auth: 'admin',
      permission: 'catalog.coupons.manage',
      summary: 'Generate a batch of unique single-use coupon codes',
      description: 'Every code gets the same discount terms and can be redeemed once, by one customer. Export the codes as CSV to hand them out.',
      tags: ['Coupons'],
      body: couponBatchBody,
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const b = c.body;
          const now = app.clock.now();
          const prefix = b.prefix.toUpperCase();
          const batch = await tx.one<{ id: string }>(sql.insert('coupon_batches', { id: newId('cpb'), name: b.name, prefix, count: b.count, campaign: b.campaign ?? null, created_by: c.admin().adminId, created_at: now }, 'id'));
          const terms = couponColumns(b);
          await insertGeneratedCodes(tx, 'coupons', b.count, () => `${prefix}${randomCode(b.codeLength)}`, (code) => ({
            id: newId('cpn'),
            code,
            name: b.name,
            ...terms,
            max_redemptions: 1,
            max_per_customer: 1,
            batch_id: batch.id,
            created_at: now,
            updated_at: now,
          }));
          await c.audit(tx, 'coupon_batch.create', { type: 'coupon_batch', id: batch.id }, { name: b.name, prefix, count: b.count });
          return (await couponBatches(tx, batch.id))[0];
        }),
    });

    r.route({
      method: 'PATCH',
      url: '/api/admin/coupon-batches/:id',
      auth: 'admin',
      permission: 'catalog.coupons.manage',
      summary: 'Deactivate (or reactivate) every code of a batch',
      tags: ['Coupons'],
      params: z.object({ id: z.string() }),
      body: z.object({ active: z.boolean() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          if (!(await tx.maybe(sql`SELECT 1 FROM coupon_batches WHERE id = ${c.params.id}`))) throw notFound('Coupon batch');
          const changed = await tx.exec(sql`UPDATE coupons SET active = ${c.body.active}, updated_at = ${app.clock.now()} WHERE batch_id = ${c.params.id} AND active <> ${c.body.active}`);
          await c.audit(tx, c.body.active ? 'coupon_batch.reactivate' : 'coupon_batch.deactivate', { type: 'coupon_batch', id: c.params.id }, { changed });
          return (await couponBatches(tx, c.params.id))[0];
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/coupon-batches/:id/codes.csv',
      auth: 'admin',
      permission: 'catalog.coupons.view',
      summary: 'Export the codes of a coupon batch as CSV',
      tags: ['Coupons'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const batch = await app.db.maybe<{ id: string; name: string }>(sql`SELECT id, name FROM coupon_batches WHERE id = ${c.params.id}`);
        if (!batch) throw notFound('Coupon batch');
        const rows = await app.db.many<any>(sql`SELECT code, active, redeemed_count, expires_at FROM coupons WHERE batch_id = ${batch.id} ORDER BY code`);
        await c.audit(app.db, 'coupon_batch.export', { type: 'coupon_batch', id: batch.id }, { count: rows.length });
        const csv = toCsv(rows, [
          { header: 'code', value: (r) => r.code },
          { header: 'redeemed', value: (r) => (r.redeemed_count > 0 ? 'yes' : 'no') },
          { header: 'active', value: (r) => (r.active ? 'yes' : 'no') },
          { header: 'expires_at', value: (r) => r.expires_at },
        ]);
        const filename = `coupons-${batch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || batch.id}.csv`;
        return c.reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`).send(csv);
      },
    });

    // ---- Entitlements (admin) ----------------------------------------------------------
    const subjectQuery = z.object({ userId: z.string().optional(), orgId: z.string().optional() }).refine((q) => q.userId || q.orgId, 'userId or orgId is required');

    r.route({
      method: 'GET',
      url: '/api/admin/entitlements',
      auth: 'admin',
      permission: 'catalog.entitlements.view',
      summary: 'Resolved entitlements for a user or organization, with their sources',
      tags: ['Entitlements'],
      query: subjectQuery,
      handler: async (c) => {
        const subject = await subjectFor(app.db, { userId: c.query.orgId ? null : c.query.userId, orgId: c.query.orgId }, c.orgScope());
        const ent = await resolveEntitlements(app.db, app, subject);
        const [grants, overrides] = await Promise.all([
          app.db.many(sql`
            SELECT g.*, p.name AS product_name, p.key AS product_key, p.kind FROM entitlement_grants g JOIN products p ON p.id = g.product_id
            WHERE g.subject_type = ${subject.type} AND g.subject_id = ${subject.id} ORDER BY g.created_at DESC
          `),
          app.db.many(sql`
            SELECT o.*, f.key AS feature_key, f.name AS feature_name FROM entitlement_overrides o JOIN features f ON f.id = o.feature_id
            WHERE o.subject_type = ${subject.type} AND o.subject_id = ${subject.id} ORDER BY o.created_at DESC
          `),
        ]);
        const presented = await presentEntitlements(app, app.db, subject);
        return { ...presented, resolved: ent.features, grants, overrides };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/entitlement-grants',
      auth: 'admin',
      permission: 'catalog.entitlements.manage',
      summary: 'Grant a product manually (complimentary plan, lifetime deal, extension)',
      tags: ['Entitlements'],
      body: z.object({
        userId: z.string().optional(),
        orgId: z.string().optional(),
        productId: z.string(),
        quantity: z.number().int().min(1).default(1),
        endsAt: z.coerce.date().nullable().optional(),
        reason: z.string().trim().min(3).max(500),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const subject = await subjectFor(tx, { userId: c.body.orgId ? null : c.body.userId, orgId: c.body.orgId }, c.orgScope());
          const product = await tx.maybe(sql`SELECT id FROM products WHERE id = ${c.body.productId} AND status <> 'archived'`);
          if (!product) throw notFound('Product');
          const row = await tx.one(sql.insert('entitlement_grants', {
            id: newId('grt'),
            subject_type: subject.type,
            subject_id: subject.id,
            product_id: c.body.productId,
            quantity: c.body.quantity,
            source: 'admin',
            reason: c.body.reason,
            starts_at: app.clock.now(),
            ends_at: c.body.endsAt ?? null,
            created_by: c.admin().adminId,
            created_at: app.clock.now(),
          }));
          await c.audit(tx, 'entitlement.grant', { type: subject.type, id: subject.id, orgId: subject.type === 'organization' ? subject.id : null }, { productId: c.body.productId, endsAt: c.body.endsAt, reason: c.body.reason });
          await app.events.emit(tx, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'grant' }, subject.type === 'user' ? { userId: subject.id } : { orgId: subject.id });
          return row;
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/entitlement-grants/:id/revoke',
      auth: 'admin',
      permission: 'catalog.entitlements.manage',
      summary: 'Revoke a manual grant',
      tags: ['Entitlements'],
      params: z.object({ id: z.string() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const row = await tx.maybe<any>(sql`UPDATE entitlement_grants SET revoked_at = ${app.clock.now()} WHERE id = ${c.params.id} AND revoked_at IS NULL RETURNING *`);
          if (!row) throw notFound('Active grant');
          await c.audit(tx, 'entitlement.revoke', { type: row.subject_type, id: row.subject_id }, { grantId: row.id });
          await app.events.emit(tx, 'entitlements.updated', { subjectType: row.subject_type, subjectId: row.subject_id, reason: 'revoke' }, row.subject_type === 'user' ? { userId: row.subject_id } : { orgId: row.subject_id });
          return row;
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/entitlement-overrides',
      auth: 'admin',
      permission: 'catalog.entitlements.manage',
      summary: 'Override a feature or limit for one customer (optionally temporary)',
      tags: ['Entitlements'],
      body: z.object({
        userId: z.string().optional(),
        orgId: z.string().optional(),
        featureKey: z.string(),
        mode: z.enum(['set', 'add']).default('set'),
        enabled: z.boolean().optional(),
        limit: z.number().int().min(0).optional(),
        unlimited: z.boolean().optional(),
        enforcement: z.enum(['hard', 'soft', 'overage']).optional(),
        config: z.unknown().optional(),
        reason: z.string().trim().min(3).max(500),
        startsAt: z.coerce.date().optional(),
        expiresAt: z.coerce.date().optional(),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const subject = await subjectFor(tx, { userId: c.body.orgId ? null : c.body.userId, orgId: c.body.orgId }, c.orgScope());
          const feature = await tx.maybe<{ id: string }>(sql`SELECT id FROM features WHERE key = ${c.body.featureKey}`);
          if (!feature) throw notFound('Feature');
          if (c.body.mode === 'add' && !c.body.limit) throw validationError([{ path: ['limit'], message: '"add" overrides need a positive limit' }]);
          const row = await tx.one(sql.insert('entitlement_overrides', {
            id: newId('ovr'),
            subject_type: subject.type,
            subject_id: subject.id,
            feature_id: feature.id,
            mode: c.body.mode,
            enabled: c.body.enabled ?? null,
            limit_value: c.body.limit ?? null,
            unlimited: c.body.unlimited ?? null,
            enforcement: c.body.enforcement ?? null,
            config_value: c.body.config === undefined ? null : sql.json(c.body.config),
            reason: c.body.reason,
            starts_at: c.body.startsAt ?? app.clock.now(),
            expires_at: c.body.expiresAt ?? null,
            created_by: c.admin().adminId,
            created_at: app.clock.now(),
          }));
          await c.audit(tx, 'entitlement.override', { type: subject.type, id: subject.id }, { feature: c.body.featureKey, mode: c.body.mode, limit: c.body.limit, expiresAt: c.body.expiresAt, reason: c.body.reason });
          await app.events.emit(tx, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'override' }, subject.type === 'user' ? { userId: subject.id } : { orgId: subject.id });
          return row;
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/entitlement-overrides/:id',
      auth: 'admin',
      permission: 'catalog.entitlements.manage',
      summary: 'Remove an override',
      tags: ['Entitlements'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const row = await tx.maybe<any>(sql`DELETE FROM entitlement_overrides WHERE id = ${c.params.id} RETURNING *`);
          if (!row) throw notFound('Override');
          await c.audit(tx, 'entitlement.override_remove', { type: row.subject_type, id: row.subject_id }, { overrideId: row.id });
        });
      },
    });

    // ---- Integration API (v1) & client API ------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/v1/plans',
      auth: 'api',
      scope: 'catalog:read',
      summary: 'Public plans, add-ons and prices (for your pricing page)',
      tags: ['Catalog'],
      query: z.object({ currency: currencyCode.optional() }),
      handler: async (c) => ({ data: await publicCatalog(app.db, { currency: c.query.currency }) }),
    });

    r.route({
      method: 'GET',
      url: '/api/v1/entitlements',
      auth: 'api',
      scope: 'entitlements:read',
      summary: "Everything a user (or organization) can access, with quota usage",
      tags: ['Entitlements'],
      query: subjectQuery,
      handler: async (c) => presentEntitlements(app, app.db, await subjectFor(app.db, c.query, c.orgScope())),
    });

    r.route({
      method: 'POST',
      url: '/api/v1/entitlements/check',
      auth: 'api',
      scope: 'entitlements:read',
      summary: 'Can this user use a feature (and how much)? Does not record usage.',
      tags: ['Entitlements'],
      body: z.object({ userId: z.string().optional(), orgId: z.string().optional(), feature: z.string(), quantity: z.number().int().min(1).default(1) }),
      handler: async (c) => checkFeature(app, app.db, await subjectFor(app.db, c.body, c.orgScope()), c.body.feature, c.body.quantity),
    });

    r.route({
      method: 'POST',
      url: '/api/v1/entitlements/grants',
      auth: 'api',
      scope: 'entitlements:write',
      summary: 'Grant a product to a user or organization (e.g. a promotion inside your app)',
      tags: ['Entitlements'],
      body: z.object({
        userId: z.string().optional(),
        orgId: z.string().optional(),
        productKey: z.string(),
        quantity: z.number().int().min(1).default(1),
        endsAt: z.coerce.date().optional(),
        reason: z.string().max(500).default('Granted via API'),
        reference: z.string().max(200).optional(),
      }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const subject = await subjectFor(tx, { userId: c.body.orgId ? null : c.body.userId, orgId: c.body.orgId }, c.orgScope());
          const product = await tx.maybe<{ id: string }>(sql`SELECT id FROM products WHERE key = ${c.body.productKey} AND status = 'active'`);
          if (!product) throw notFound('Product');
          if (c.body.reference) {
            const existing = await tx.maybe(sql`SELECT * FROM entitlement_grants WHERE source = 'promotion' AND source_ref = ${c.body.reference} AND subject_id = ${subject.id}`);
            if (existing) return existing;
          }
          const row = await tx.one(sql.insert('entitlement_grants', {
            id: newId('grt'),
            subject_type: subject.type,
            subject_id: subject.id,
            product_id: product.id,
            quantity: c.body.quantity,
            source: 'promotion',
            source_ref: c.body.reference ?? null,
            reason: c.body.reason,
            starts_at: app.clock.now(),
            ends_at: c.body.endsAt ?? null,
            created_at: app.clock.now(),
          }));
          await app.events.emit(tx, 'entitlements.updated', { subjectType: subject.type, subjectId: subject.id, reason: 'grant' }, subject.type === 'user' ? { userId: subject.id } : { orgId: subject.id });
          return row;
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/client/plans',
      auth: 'client',
      summary: 'Public plans and prices',
      tags: ['Client'],
      query: z.object({ currency: currencyCode.optional() }),
      handler: async (c) => ({ data: await publicCatalog(app.db, { currency: c.query.currency }) }),
    });

    r.route({
      method: 'GET',
      url: '/api/client/entitlements',
      auth: 'client',
      summary: "The signed-in customer's entitlements and usage",
      tags: ['Client'],
      handler: async (c) => {
        const p = c.customer();
        return presentEntitlements(app, app.db, p.orgId ? { type: 'organization', id: p.orgId } : { type: 'user', id: p.userId });
      },
    });
  },
};
