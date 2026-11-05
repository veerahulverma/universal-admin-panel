import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError } from '../../core/errors.js';
import { resolveEntitlements, type Subject } from './entitlements.js';

/*
 * Purchase rules and stock. Every place a sale starts (checkout, product invoices and carts, the
 * admin "New subscription" route, plan changes) calls `reserveSale`, which refuses what the
 * product's rules forbid and records the units sold. Reservations become `sold` when the sale is
 * paid and `released` when it expires or is voided, so stock and per-customer limits count both
 * paid sales and sales still waiting for payment.
 */

export interface SaleProduct {
  id: string;
  name: string;
  requires_products: string[];
  excludes_products: string[];
  purchase_limit: number | null;
  stock_limit: number | null;
}

export interface SalePrice {
  id: string;
  type: 'recurring' | 'one_time';
  stock_limit: number | null;
}

export interface SaleItem {
  product: SaleProduct;
  price: SalePrice;
  quantity: number;
}

export type SaleSource = { type: 'checkout' | 'order' | 'subscription'; id: string };

export interface SaleInput {
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  items: SaleItem[];
  source: SaleSource;
  /** `sold` for sales that are complete at once (admin subscriptions, plan changes); `reserved` until paid otherwise. */
  status: 'reserved' | 'sold';
  /** Products the sale replaces (the current plan in a plan change); they do not count as owned. */
  replaces?: string[];
}

/** Units of stock a line uses: each unit of a one-time price, one per subscription (seats are not stock). */
export function saleUnits(price: Pick<SalePrice, 'type'>, quantity: number): number {
  return price.type === 'one_time' ? quantity : 1;
}

const refused = (status: number, code: string, message: string, details?: unknown) => new AppError(status, code, message, details);

/** Products the subject has right now: subscriptions, grants and what their bundles include (not the default plan). */
export async function ownedProducts(db: Db, app: App, subject: Subject): Promise<Set<string>> {
  const ent = await resolveEntitlements(db, app, subject);
  return new Set(ent.plans.filter((p) => p.origin !== 'default').map((p) => p.productId));
}

async function productNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.many<{ id: string; name: string }>(sql`SELECT id, name FROM products WHERE id IN ${sql.in(ids)}`);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function oneOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'another product';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** Serialize sales that compete for the same limit (advisory locks are released at commit). */
async function lockKeys(db: Db, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) await db.query(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

async function unitsInUse(db: Db, column: 'product_id' | 'price_id', id: string): Promise<number> {
  const row = await db.one<{ units: number }>(sql`
    SELECT coalesce(sum(quantity), 0)::int AS units FROM stock_reservations WHERE ${sql.ident(column)} = ${id} AND status IN ('reserved', 'sold')
  `);
  return row.units;
}

/**
 * Check a sale against the product rules and stock, then record its units. Throws
 * `purchase_requires` / `purchase_excluded` (422), `purchase_limit_reached` or `sold_out` (409).
 */
export async function reserveSale(db: Db, app: App, input: SaleInput): Promise<void> {
  const inSale = new Set(input.items.map((i) => i.product.id));
  const ruled = input.items.some((i) => i.product.requires_products.length || i.product.excludes_products.length);
  const owned = ruled ? await ownedProducts(db, app, input.subject) : new Set<string>();
  for (const id of input.replaces ?? []) owned.delete(id);
  const names = await productNames(db, [...new Set(input.items.flatMap((i) => [...i.product.requires_products, ...i.product.excludes_products]))]);
  const nameOf = (id: string) => names.get(id) ?? id;

  for (const [index, item] of input.items.entries()) {
    const { product } = item;
    const has = (id: string) => id !== product.id && (owned.has(id) || inSale.has(id));
    if (product.requires_products.length && !product.requires_products.some(has)) {
      throw refused(422, 'purchase_requires', `${product.name} can only be bought with ${oneOf(product.requires_products.map(nameOf))}`, { index, productId: product.id, requires: product.requires_products });
    }
    const clash = product.excludes_products.find(has);
    if (clash) {
      const why = inSale.has(clash) ? 'in the same order as' : 'by customers who have';
      throw refused(422, 'purchase_excluded', `${product.name} cannot be bought ${why} ${nameOf(clash)}`, { index, productId: product.id, excludes: clash });
    }
  }

  const units = new Map<string, number>();
  const priceUnits = new Map<string, number>();
  for (const item of input.items) {
    const n = saleUnits(item.price, item.quantity);
    units.set(item.product.id, (units.get(item.product.id) ?? 0) + n);
    priceUnits.set(item.price.id, (priceUnits.get(item.price.id) ?? 0) + n);
  }
  const products = new Map(input.items.map((i) => [i.product.id, i.product]));
  const prices = new Map(input.items.map((i) => [i.price.id, i.price]));
  const subjectKey = `${input.subject.type}:${input.subject.id}`;
  await lockKeys(db, [
    ...[...products.values()].filter((p) => p.stock_limit !== null).map((p) => `stock:product:${p.id}`),
    ...[...prices.values()].filter((p) => p.stock_limit !== null).map((p) => `stock:price:${p.id}`),
    ...[...products.values()].filter((p) => p.purchase_limit !== null).map((p) => `purchases:${subjectKey}:${p.id}`),
  ]);

  // Limits are read again under the lock: an administrator may have just changed them.
  const limits = await db.many<{ id: string; stock_limit: number | null; purchase_limit: number | null }>(sql`
    SELECT id, stock_limit, purchase_limit FROM products WHERE id IN ${sql.in([...products.keys()])}
  `);
  for (const p of limits) {
    const wanted = units.get(p.id) ?? 0;
    const name = products.get(p.id)!.name;
    if (p.stock_limit !== null) {
      const left = Math.max(0, p.stock_limit - (await unitsInUse(db, 'product_id', p.id)));
      if (wanted > left) throw refused(409, 'sold_out', left ? `Only ${left} of ${name} left` : `${name} is sold out`, { productId: p.id, available: left });
    }
    if (p.purchase_limit !== null) {
      const bought = await db.one<{ units: number }>(sql`
        SELECT coalesce(sum(quantity), 0)::int AS units FROM stock_reservations
        WHERE subject_type = ${input.subject.type} AND subject_id = ${input.subject.id} AND product_id = ${p.id} AND status IN ('reserved', 'sold')
      `);
      if (bought.units + wanted > p.purchase_limit) {
        throw refused(409, 'purchase_limit_reached', `${name} can be bought ${p.purchase_limit === 1 ? 'once' : `${p.purchase_limit} times`} per customer`, { productId: p.id, limit: p.purchase_limit, bought: bought.units });
      }
    }
  }
  const priceLimits = await db.many<{ id: string; product_id: string; stock_limit: number | null }>(sql`
    SELECT id, product_id, stock_limit FROM prices WHERE id IN ${sql.in([...prices.keys()])} AND stock_limit IS NOT NULL
  `);
  for (const p of priceLimits) {
    const left = Math.max(0, p.stock_limit! - (await unitsInUse(db, 'price_id', p.id)));
    const wanted = priceUnits.get(p.id) ?? 0;
    const name = products.get(p.product_id)?.name ?? 'This price';
    if (wanted > left) throw refused(409, 'sold_out', left ? `Only ${left} of ${name} left at this price` : `${name} is sold out at this price`, { priceId: p.id, available: left });
  }

  const now = app.clock.now();
  await db.exec(sql.insertMany('stock_reservations', input.items.map((item) => ({
    id: newId('stk'),
    product_id: item.product.id,
    price_id: item.price.id,
    subject_type: input.subject.type,
    subject_id: input.subject.id,
    user_id: input.userId,
    org_id: input.orgId,
    quantity: saleUnits(item.price, item.quantity),
    source_type: input.source.type,
    source_id: input.source.id,
    order_id: input.source.type === 'order' ? input.source.id : null,
    status: input.status,
    created_at: now,
    updated_at: now,
  })), ''));
}

/** The sale was paid: its units are sold for good (even if an expiry had released them meanwhile). */
export async function commitSale(db: Db, app: App, source: SaleSource, orderId: string | null): Promise<void> {
  await db.exec(sql`
    UPDATE stock_reservations SET status = 'sold', order_id = coalesce(order_id, ${orderId}), updated_at = ${app.clock.now()}
    WHERE source_type = ${source.type} AND source_id = ${source.id} AND status <> 'sold'
  `);
}

/** The sale expired or was voided before payment: its units are available again. */
export async function releaseSale(db: Db, app: App, source: SaleSource): Promise<number> {
  return db.exec(sql`
    UPDATE stock_reservations SET status = 'released', updated_at = ${app.clock.now()}
    WHERE source_type = ${source.type} AND source_id = ${source.id} AND status = 'reserved'
  `);
}

/** A paid order was refunded and its access revoked: what it sold goes back into stock. */
export async function releaseOrder(db: Db, app: App, orderId: string): Promise<number> {
  return db.exec(sql`
    UPDATE stock_reservations SET status = 'released', updated_at = ${app.clock.now()} WHERE order_id = ${orderId} AND status IN ('reserved', 'sold')
  `);
}

export interface StockLevel {
  sold: number;
  reserved: number;
}

/** Units sold and reserved per product and per price. */
export async function stockLevels(db: Db, productIds: string[]): Promise<{ products: Map<string, StockLevel>; prices: Map<string, StockLevel> }> {
  const products = new Map<string, StockLevel>();
  const prices = new Map<string, StockLevel>();
  if (!productIds.length) return { products, prices };
  const rows = await db.many<{ product_id: string; price_id: string | null; status: 'reserved' | 'sold'; units: number }>(sql`
    SELECT product_id, price_id, status, sum(quantity)::int AS units FROM stock_reservations
    WHERE product_id IN ${sql.in(productIds)} AND status IN ('reserved', 'sold') GROUP BY product_id, price_id, status
  `);
  const add = (map: Map<string, StockLevel>, id: string, status: 'reserved' | 'sold', n: number) => {
    const level = map.get(id) ?? { sold: 0, reserved: 0 };
    level[status] += n;
    map.set(id, level);
  };
  for (const r of rows) {
    add(products, r.product_id, r.status, r.units);
    if (r.price_id) add(prices, r.price_id, r.status, r.units);
  }
  return { products, prices };
}

/** Units still for sale under a limit; null when there is no limit. */
export function available(limit: number | null, level: StockLevel | undefined): number | null {
  if (limit === null) return null;
  return Math.max(0, limit - (level?.sold ?? 0) - (level?.reserved ?? 0));
}
