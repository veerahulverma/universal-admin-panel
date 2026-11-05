import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { Subject } from '../catalog/entitlements.js';
import { createInvoiceCheckout } from './checkout.js';
import { createProductInvoice, type ProductInvoiceItem } from './product-invoices.js';
import { scopeOfSubject } from './engine.js';

/*
 * Shopping cart: several prices in one purchase. The cart becomes a product invoice (one order,
 * reserved in stock, nothing granted yet) and the customer pays it through a gateway checkout for
 * that invoice. Paying it, by that checkout or any other way, fulfils the order: plans start and
 * products are granted. A cart whose checkout expires unpaid is voided, which releases its stock.
 */

export interface CartInput {
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  items: ProductInvoiceItem[];
  couponCode?: string | null;
  gatewayId?: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
}

export interface CartCheckout {
  /** Gateway checkout session; null when nothing is left to pay. */
  id: string | null;
  status: 'open' | 'completed';
  url: string | null;
  invoiceId: string;
  orderId: string;
  amount: { subtotal: number; discount: number; tax: number; total: number; balanceApplied: number; amountDue: number; currency: string };
}

export async function checkoutCart(db: Db, app: App, input: CartInput): Promise<CartCheckout> {
  const invoice = await createProductInvoice(db, app, {
    subject: input.subject,
    userId: input.userId,
    orgId: input.orgId,
    items: input.items,
    couponCode: input.couponCode ?? null,
    firstDiscount: 0,
    renewalDiscount: 0,
    dueDays: 0,
    source: 'cart',
  });
  const amount = {
    subtotal: invoice.subtotal,
    discount: invoice.discount_total,
    tax: invoice.tax_total,
    total: invoice.total,
    balanceApplied: invoice.balance_applied,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
  };
  // Covered by discounts or account credit: the order was fulfilled when the invoice was issued.
  if (invoice.status === 'paid') return { id: null, status: 'completed', url: input.successUrl ?? null, invoiceId: invoice.id, orderId: invoice.order_id, amount };
  const checkout = await createInvoiceCheckout(db, app, invoice.id, { gatewayId: input.gatewayId, successUrl: input.successUrl, cancelUrl: input.cancelUrl });
  await app.events.emit(db, 'checkout.created', { checkoutId: checkout.id, priceId: null, invoiceId: invoice.id, kind: 'cart', total: amount.amountDue, currency: amount.currency }, scopeOfSubject(input.subject));
  return { id: checkout.id, status: 'open', url: checkout.url, invoiceId: invoice.id, orderId: invoice.order_id, amount };
}
