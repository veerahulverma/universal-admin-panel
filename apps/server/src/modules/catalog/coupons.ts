import { randomBytes } from 'node:crypto';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict } from '../../core/errors.js';

/** 32 characters without look-alikes (no 0/O, 1/I), so each random byte maps without bias. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random code people can read out and type: uppercase letters and digits that cannot be confused. */
export function randomCode(length: number): string {
  return Array.from(randomBytes(length), (b) => CODE_ALPHABET[b & 31]).join('');
}

/**
 * Insert `count` rows with generated codes. Codes that collide with existing ones (the table's
 * unique index decides) are generated again; returns the rows created.
 */
export async function insertGeneratedCodes(
  db: Db,
  table: 'coupons' | 'vouchers',
  count: number,
  generate: () => string,
  row: (code: string) => Record<string, unknown>,
): Promise<{ id: string; code: string }[]> {
  const created: { id: string; code: string }[] = [];
  const tried = new Set<string>();
  for (let attempt = 0; created.length < count && attempt < 5; attempt++) {
    const codes: string[] = [];
    while (codes.length < count - created.length) {
      const code = generate();
      if (!tried.has(code)) {
        tried.add(code);
        codes.push(code);
      }
    }
    for (let i = 0; i < codes.length; i += 500) {
      const rows = codes.slice(i, i + 500).map(row);
      created.push(...(await db.many<{ id: string; code: string }>(sql`${sql.insertMany(table, rows, '')} ON CONFLICT DO NOTHING RETURNING id, code`)));
    }
  }
  if (created.length < count) throw conflict('Could not generate enough unique codes; use a longer code', 'codes_exhausted');
  return created;
}

export interface CouponRow {
  id: string;
  code: string;
  name: string;
  discount_type: 'percent' | 'fixed';
  percent_off_bps: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  duration_cycles: number | null;
  max_redemptions: number | null;
  redeemed_count: number;
  max_per_customer: number;
  applies_to: string[];
  first_purchase_only: boolean;
  min_amount: number | null;
  starts_at: Date | null;
  expires_at: Date | null;
  active: boolean;
  affiliate_id: string | null;
}

const invalid = (message: string) => new AppError(422, 'coupon_invalid', message);

export interface CouponContext {
  productId: string;
  amount: number;
  currency: string;
  userId: string | null;
  orgId: string | null;
  isFirstPurchase: boolean;
}

/** Look up and validate a coupon for a purchase. Throws `coupon_invalid` with a customer-friendly message. */
export async function validateCoupon(db: Db, app: App, code: string, ctx: CouponContext): Promise<CouponRow> {
  const c = await db.maybe<CouponRow>(sql`SELECT * FROM coupons WHERE lower(code) = ${code.trim().toLowerCase()}`);
  const now = app.clock.now();
  if (!c || !c.active) throw invalid('This coupon code is not valid');
  if (c.starts_at && c.starts_at > now) throw invalid('This coupon is not active yet');
  if (c.expires_at && c.expires_at <= now) throw invalid('This coupon has expired');
  if (c.max_redemptions !== null && c.redeemed_count >= c.max_redemptions) throw invalid('This coupon has been fully redeemed');
  if (c.applies_to.length && !c.applies_to.includes(ctx.productId)) throw invalid('This coupon does not apply to this plan');
  if (c.discount_type === 'fixed' && c.currency !== ctx.currency) throw invalid(`This coupon only applies to ${c.currency} purchases`);
  if (c.min_amount !== null && ctx.amount < c.min_amount) throw invalid('The order total is below the minimum for this coupon');
  if (c.first_purchase_only && !ctx.isFirstPurchase) throw invalid('This coupon is only valid on your first purchase');
  if (ctx.userId || ctx.orgId) {
    const used = await db.one<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM coupon_redemptions WHERE coupon_id = ${c.id}
      AND ${ctx.orgId ? sql`org_id = ${ctx.orgId}` : sql`user_id = ${ctx.userId}`}
    `);
    if (used.count >= c.max_per_customer) throw invalid('You have already used this coupon');
  }
  return c;
}

export function discountAmount(c: Pick<CouponRow, 'discount_type' | 'percent_off_bps' | 'amount_off'>, amount: number): number {
  if (amount <= 0) return 0;
  if (c.discount_type === 'percent') return Math.min(amount, Math.round((amount * (c.percent_off_bps ?? 0)) / 10_000));
  return Math.min(amount, c.amount_off ?? 0);
}

/** Atomically count a redemption; fails if another checkout took the last one. */
export async function redeemCoupon(
  db: Db,
  app: App,
  couponId: string,
  r: { userId: string | null; orgId: string | null; orderId?: string | null; subscriptionId?: string | null; discount: number; currency: string },
): Promise<void> {
  const ok = await db.maybe(sql`
    UPDATE coupons SET redeemed_count = redeemed_count + 1, updated_at = ${app.clock.now()}
    WHERE id = ${couponId} AND (max_redemptions IS NULL OR redeemed_count < max_redemptions) RETURNING id
  `);
  if (!ok) throw conflict('This coupon has been fully redeemed', 'coupon_exhausted');
  await db.exec(sql.insert('coupon_redemptions', {
    id: newId('red'),
    coupon_id: couponId,
    user_id: r.userId,
    org_id: r.orgId,
    order_id: r.orderId ?? null,
    subscription_id: r.subscriptionId ?? null,
    discount_amount: r.discount,
    currency: r.currency,
    created_at: app.clock.now(),
  }, ''));
}
