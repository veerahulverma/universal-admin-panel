import { hmacSha256, safeEqual } from '../../../core/crypto.js';
import { header, WebhookSignatureError, type GatewayAdapter, type GatewayContext, type GatewayEvent } from './types.js';

const API = 'https://api.razorpay.com/v1';

async function razorpay(ctx: GatewayContext, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const auth = Buffer.from(`${ctx.secrets.key_id}:${ctx.secrets.key_secret}`).toString('base64');
  const res = await ctx.fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(json?.error?.description ?? `Razorpay error ${res.status}`);
  return json;
}

export function verifyRazorpayWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {
  return Boolean(signature && secret && safeEqual(signature, hmacSha256(secret, rawBody)));
}

/** Payment link callback signature: HMAC(key_secret, link_id|reference_id|status|payment_id). */
export function verifyRazorpayCallback(q: Record<string, string>, keySecret: string): boolean {
  const payload = `${q.razorpay_payment_link_id}|${q.razorpay_payment_link_reference_id}|${q.razorpay_payment_link_status}|${q.razorpay_payment_id}`;
  return Boolean(q.razorpay_signature && keySecret && safeEqual(q.razorpay_signature, hmacSha256(keySecret, payload)));
}

/**
 * Razorpay (India): UPI, cards, netbanking and wallets via Payment Links.
 * Off-session renewals are not offered here (they need e-mandates), so
 * renewals fall back to emailed invoices with a payment link.
 */
export const razorpayGateway: GatewayAdapter = {
  key: 'razorpay',
  name: 'Razorpay',
  description: 'UPI, cards, netbanking and wallets for India via Razorpay Payment Links.',
  capabilities: {
    checkout: true,
    savePaymentMethod: false,
    offSessionCharge: false,
    refunds: true,
    partialRefunds: true,
    webhooks: true,
    currencies: ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED'],
    paymentMethods: ['upi', 'card', 'netbanking', 'wallet'],
  },
  secretFields: [
    { key: 'key_id', label: 'Key ID', required: true },
    { key: 'key_secret', label: 'Key secret', required: true },
    { key: 'webhook_secret', label: 'Webhook secret', required: true },
  ],
  async testConnection(ctx) {
    try {
      await razorpay(ctx, 'GET', '/payments?count=1');
      return { ok: true, message: 'Connected to Razorpay' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },
  async createCheckout(ctx, req) {
    const link = await razorpay(ctx, 'POST', '/payment_links', {
      amount: req.amount,
      currency: req.currency,
      description: req.description.slice(0, 2048),
      reference_id: req.checkoutId.slice(0, 40),
      customer: { name: req.customer.name ?? undefined, email: req.customer.email ?? undefined },
      notify: { email: false, sms: false },
      reminder_enable: false,
      callback_url: `${ctx.returnUrl}?checkout=${encodeURIComponent(req.checkoutId)}`,
      callback_method: 'get',
      notes: { checkout_id: req.checkoutId },
    });
    return { url: link.short_url, gatewaySessionId: link.id };
  },
  async refund(ctx, req) {
    try {
      const r = await razorpay(ctx, 'POST', `/payments/${req.gatewayPaymentId}/refund`, { amount: req.amount, notes: { reason: req.reason ?? '' } });
      return { status: r.status === 'processed' ? 'succeeded' : 'pending', gatewayRefundId: r.id };
    } catch (err) {
      return { status: 'failed', failureMessage: (err as Error).message };
    }
  },
  async parseWebhook(ctx, req) {
    if (!verifyRazorpayWebhook(req.rawBody, header(req.headers, 'x-razorpay-signature'), ctx.secrets.webhook_secret)) throw new WebhookSignatureError();
    const evt = JSON.parse(req.rawBody);
    const eventId = header(req.headers, 'x-razorpay-event-id') ?? `${evt.event}:${evt.created_at}:${evt.payload?.payment?.entity?.id ?? evt.payload?.refund?.entity?.id ?? ''}`;
    const payment = evt.payload?.payment?.entity;
    switch (evt.event) {
      case 'payment_link.paid':
        return [{
          type: 'payment.succeeded',
          eventId,
          checkoutId: evt.payload?.payment_link?.entity?.notes?.checkout_id ?? evt.payload?.payment_link?.entity?.reference_id ?? null,
          gatewayPaymentId: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          method: { type: payment.method, brand: payment.card?.network ?? null, last4: payment.card?.last4 ?? null },
          fee: payment.fee ?? null,
        }];
      case 'payment.failed':
        return [{ type: 'payment.failed', eventId, checkoutId: payment?.notes?.checkout_id ?? null, gatewayPaymentId: payment?.id ?? null, failureCode: payment?.error_code ?? 'payment_failed', failureMessage: payment?.error_description ?? 'Payment failed' }];
      case 'refund.processed': {
        const r = evt.payload.refund.entity;
        return [{ type: 'refund.succeeded', eventId, gatewayPaymentId: r.payment_id, gatewayRefundId: r.id, amount: r.amount, currency: r.currency }];
      }
      case 'payment.dispute.created': {
        const d = evt.payload.dispute.entity;
        return [{ type: 'dispute.created', eventId, gatewayPaymentId: d.payment_id, gatewayDisputeId: d.id, amount: d.amount, currency: d.currency, reason: d.reason_code ?? null, evidenceDueBy: d.respond_by ? new Date(d.respond_by * 1000) : null }];
      }
      case 'payment.dispute.won':
      case 'payment.dispute.lost':
        return [{ type: 'dispute.closed', eventId, gatewayDisputeId: evt.payload.dispute.entity.id, outcome: evt.event.endsWith('won') ? 'won' : 'lost' }];
      default:
        return [{ type: 'ignored', eventId, reason: `unhandled ${evt.event}` } satisfies GatewayEvent];
    }
  },
  async handleReturn(ctx, query) {
    const checkoutId = query.checkout ?? null;
    if (query.razorpay_payment_link_status !== 'paid' || !verifyRazorpayCallback(query, ctx.secrets.key_secret)) return { events: [], checkoutId };
    const payment = await razorpay(ctx, 'GET', `/payments/${query.razorpay_payment_id}`);
    return {
      checkoutId,
      events: [{
        type: 'payment.succeeded',
        eventId: `return:${query.razorpay_payment_id}`,
        checkoutId,
        gatewayPaymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        method: { type: payment.method, brand: payment.card?.network ?? null, last4: payment.card?.last4 ?? null },
      }],
    };
  },
};
