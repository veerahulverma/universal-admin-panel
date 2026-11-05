import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, validationError } from '../../core/errors.js';
import { DAY } from '../../core/clock.js';
import { discountAmount, validateCoupon, type CouponRow } from '../catalog/coupons.js';
import type { Subject } from '../catalog/entitlements.js';
import { reserveSale } from '../catalog/purchases.js';
import { assertSubjectMatchesProduct, createInvoice, describePrice, fulfilPendingOrder, installmentLabel, loadPrice, nextNumber, periodAmount, settingsOf, type PriceRow } from './engine.js';

/*
 * Product invoices: a customer is billed for catalog prices, by an admin or through the customer's
 * own cart. The invoice is backed by a pending order; nothing is granted until the invoice is paid
 * (see fulfilPendingOrder), so an unpaid invoice never gives access, and paying it any way grants
 * exactly what was invoiced. The order's units are reserved in stock until then.
 */

export interface ProductInvoiceItem {
  priceId: string;
  /** Seats for per-seat prices, units for one-time prices; other prices are sold one at a time. */
  quantity?: number;
}

export interface ProductInvoiceInput {
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  items: ProductInvoiceItem[];
  couponCode?: string | null;
  /** Extra amount off this invoice, on top of the coupon. */
  firstDiscount: number;
  /** Extra amount off every renewal of the recurring price. */
  renewalDiscount: number;
  dueDays: number;
  notes?: string | null;
  /** Who started the sale: an administrator, or the customer's cart (which expires with its checkout). */
  source?: 'admin_invoice' | 'cart';
}

interface Item {
  price: PriceRow;
  product: any;
  quantity: number;
  amount: number;
  coupon: number;
  extra: number;
}

/** Takes `amount` off the items in order, never more than what is left on an item. Returns what was taken. */
function spread(items: Item[], amount: number, key: 'coupon' | 'extra'): number {
  let left = amount;
  for (const item of items) {
    const take = Math.min(item.amount - item.coupon - item.extra, left);
    item[key] += take;
    left -= take;
  }
  return amount - left;
}

async function hasPaidOrder(db: Db, subject: Subject): Promise<boolean> {
  return Boolean(await db.maybe(sql`SELECT 1 FROM orders WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND status IN ('paid', 'partially_refunded') LIMIT 1`));
}

/** Quantity for a line: the price's minimum, or what was asked for where the price is sold by quantity. */
function lineQuantity(price: PriceRow, product: any, requested: number | undefined, path: (string | number)[]): number {
  if (requested === undefined) return Math.max(1, price.min_quantity);
  if (price.pricing_model !== 'per_seat' && price.type !== 'one_time') {
    if (requested !== 1) throw validationError([{ path, message: `${product.name} is sold one at a time` }]);
    return 1;
  }
  if (requested < price.min_quantity || (price.max_quantity && requested > price.max_quantity)) {
    throw validationError([{ path, message: `${product.name}: quantity must be between ${price.min_quantity} and ${price.max_quantity ?? 'unlimited'}` }]);
  }
  return requested;
}

export async function createProductInvoice(db: Db, app: App, input: ProductInvoiceInput): Promise<any> {
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const [i, line] of input.items.entries()) {
    const { price, product } = await loadPrice(db, line.priceId);
    const path = ['items', i, 'priceId'];
    if (seen.has(price.id)) throw validationError([{ path, message: `${product.name} is listed twice; set its quantity instead` }]);
    seen.add(price.id);
    if (!price.active || product.status !== 'active') throw validationError([{ path, message: `${product.name} is not available` }]);
    if (price.pricing_model === 'usage') throw validationError([{ path, message: `${product.name} is billed from usage, so it cannot be invoiced upfront` }]);
    assertSubjectMatchesProduct(product, input.subject);
    const quantity = lineQuantity(price, product, line.quantity, ['items', i, 'quantity']);
    // Same amounts a checkout would charge for this price: introductory pricing applies to the first period.
    const amount = price.type === 'recurring' ? periodAmount(price, quantity, price.intro_cycles) : price.pricing_model === 'flat' ? price.unit_amount * quantity : periodAmount(price, quantity, null);
    items.push({ price, product, quantity, amount, coupon: 0, extra: 0 });
  }
  if (!items.length) throw validationError([{ path: ['items'], message: 'Add at least one product' }]);
  const currency = items[0].price.currency;
  if (items.some((it) => it.price.currency !== currency)) throw validationError([{ path: ['items'], message: 'All products on one invoice must be priced in the same currency' }]);
  const recurring = items.filter((it) => it.price.type === 'recurring');
  if (recurring.length > 1) throw validationError([{ path: ['items'], message: 'An invoice can include one recurring price' }]);
  if (recurring[0]?.product.kind === 'plan') {
    const existing = await db.maybe<{ id: string }>(sql`
      SELECT s.id FROM subscriptions s JOIN products p ON p.id = s.product_id
      WHERE s.subject_type = ${input.subject.type} AND s.subject_id = ${input.subject.id} AND p.kind = 'plan'
        AND s.status IN ('active', 'trialing', 'past_due', 'paused')
    `);
    if (existing) throw conflict('This customer already has a plan; change their existing subscription instead', 'already_subscribed', { subscriptionId: existing.id });
  }
  if (input.renewalDiscount > 0) {
    if (!recurring.length) throw validationError([{ path: ['discount', 'renewal'], message: 'A renewal discount needs a recurring price' }]);
    const regular = periodAmount(recurring[0].price, recurring[0].quantity, null);
    if (input.renewalDiscount > regular) throw validationError([{ path: ['discount', 'renewal'], message: 'The renewal discount is more than the renewal price' }]);
  }

  let coupon: CouponRow | null = null;
  let couponTotal = 0;
  if (input.couponCode) {
    const found = await db.maybe<CouponRow>(sql`SELECT * FROM coupons WHERE lower(code) = ${input.couponCode.trim().toLowerCase()}`);
    const targets = items.filter((it) => !found?.applies_to.length || found.applies_to.includes(it.product.id));
    coupon = await validateCoupon(db, app, input.couponCode, {
      productId: (targets[0] ?? items[0]).product.id,
      amount: targets.reduce((sum, it) => sum + it.amount, 0),
      currency,
      userId: input.userId,
      orgId: input.orgId,
      isFirstPurchase: !(await hasPaidOrder(db, input.subject)),
    });
    // Percentages apply to each eligible line; a fixed amount is taken off once.
    if (coupon.discount_type === 'percent') for (const it of targets) it.coupon = discountAmount(coupon, it.amount);
    else spread(targets, coupon.amount_off ?? 0, 'coupon');
    couponTotal = items.reduce((sum, it) => sum + it.coupon, 0);
  }
  const room = items.reduce((sum, it) => sum + it.amount - it.coupon, 0);
  if (input.firstDiscount > room) throw validationError([{ path: ['discount', 'first'], message: 'The discount is more than the invoice total' }]);
  spread(items, input.firstDiscount, 'extra');

  const now = app.clock.now();
  const orderId = newId('ord');
  await reserveSale(db, app, {
    subject: input.subject,
    userId: input.userId,
    orgId: input.orgId,
    items: items.map((it) => ({ product: it.product, price: it.price, quantity: it.quantity })),
    source: { type: 'order', id: orderId },
    status: 'reserved',
  });
  await db.exec(sql.insert('orders', {
    id: orderId,
    number: await nextNumber(db, settingsOf(app).orderPrefix, now),
    subject_type: input.subject.type,
    subject_id: input.subject.id,
    user_id: input.userId,
    org_id: input.orgId,
    type: recurring.length ? 'subscription' : 'one_time',
    status: 'pending',
    currency,
    subtotal: items.reduce((sum, it) => sum + it.amount, 0),
    discount_total: couponTotal + input.firstDiscount,
    total: 0,
    coupon_id: coupon?.id ?? null,
    metadata: { source: input.source ?? 'admin_invoice', fulfil: 'on_payment', couponDiscount: couponTotal, renewalDiscount: input.renewalDiscount },
    created_at: now,
  }, ''));
  const invoice = await createInvoice(db, app, {
    subject: input.subject,
    userId: input.userId,
    orgId: input.orgId,
    currency,
    billingReason: input.source === 'cart' ? 'checkout' : 'manual',
    orderId,
    lines: items.map((it) => ({
      type: it.price.type === 'recurring' ? ('subscription' as const) : ('one_time' as const),
      description:
        describePrice(it.product, it.price, it.quantity) +
        (it.price.type === 'recurring' && it.price.intro_cycles && it.price.intro_amount !== null ? ' — introductory price' : '') +
        installmentLabel(it.price, 1),
      productId: it.product.id,
      priceId: it.price.id,
      quantity: it.quantity,
      unitAmount: it.price.pricing_model === 'per_seat' || it.price.type === 'one_time' ? Math.round(it.amount / it.quantity) : it.amount,
      amount: it.amount,
      discountAmount: it.coupon + it.extra,
      taxInclusive: it.price.tax_behavior === 'inclusive',
    })),
    dueAt: new Date(now.getTime() + input.dueDays * DAY),
    notes: input.notes ?? null,
  });
  const lines = await db.many<any>(sql`SELECT * FROM invoice_lines WHERE invoice_id = ${invoice.id} ORDER BY position`);
  await db.exec(sql.insertMany('order_items', items.map((it, i) => ({
    id: newId('oit'),
    order_id: orderId,
    product_id: it.product.id,
    price_id: it.price.id,
    description: lines[i].description,
    quantity: it.quantity,
    unit_amount: lines[i].unit_amount,
    amount: it.amount,
    discount_amount: it.coupon + it.extra,
    tax_amount: lines[i].tax_amount,
  })), ''));
  await db.exec(sql`UPDATE orders SET invoice_id = ${invoice.id}, tax_total = ${invoice.tax_total}, total = ${invoice.total} WHERE id = ${orderId}`);
  // Fully covered by discounts or account credit: nothing to collect, so grant now.
  if (invoice.status === 'paid') await fulfilPendingOrder(db, app, invoice.id, orderId);
  return db.one(sql`SELECT * FROM invoices WHERE id = ${invoice.id}`);
}

/** What the product invoice form offers: active products with their upfront prices, and redeemable coupons. */
export async function productInvoiceOptions(db: Db, app: App): Promise<{ products: any[]; coupons: any[] }> {
  const products = await db.many<any>(sql`SELECT id, key, name, kind, plan_type, subscriber_type FROM products WHERE status = 'active' ORDER BY kind, sort_order, name`);
  const prices = products.length
    ? await db.many<any>(sql`
        SELECT id, product_id, nickname, currency, type, interval, interval_count, pricing_model, unit_amount, intro_amount, intro_cycles, min_quantity, max_quantity,
               payment_count, after_last_payment, access_days
        FROM prices WHERE active AND pricing_model <> 'usage' AND product_id IN ${sql.in(products.map((p) => p.id))}
        ORDER BY currency, type, interval_count, unit_amount
      `)
    : [];
  const now = app.clock.now();
  const coupons = await db.many<any>(sql`
    SELECT id, code, name, discount_type, percent_off_bps, amount_off, currency, duration, duration_cycles, applies_to FROM coupons
    WHERE active AND batch_id IS NULL AND (starts_at IS NULL OR starts_at <= ${now}) AND (expires_at IS NULL OR expires_at > ${now})
      AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
    ORDER BY code
  `);
  return { products: products.map((p) => ({ ...p, prices: prices.filter((pr) => pr.product_id === p.id) })).filter((p) => p.prices.length > 0), coupons };
}
