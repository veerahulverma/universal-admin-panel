import { z } from 'zod';
import { currencyDecimals, toDecimalString } from '../money.js';
import { header, WebhookSignatureError, type GatewayAdapter, type GatewayContext, type GatewayEvent } from './types.js';

const BASE = { live: 'https://api-m.paypal.com', test: 'https://api-m.sandbox.paypal.com' };
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

const toMinor = (value: string, currency: string) => Math.round(Number(value) * 10 ** currencyDecimals(currency));

async function token(ctx: GatewayContext): Promise<string> {
  const cached = tokenCache.get(ctx.gatewayId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const auth = Buffer.from(`${ctx.secrets.client_id}:${ctx.secrets.client_secret}`).toString('base64');
  const res = await ctx.fetch(`${BASE[ctx.mode]}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(json?.error_description ?? `PayPal auth failed (${res.status})`);
  tokenCache.set(ctx.gatewayId, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

async function paypal(ctx: GatewayContext, method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<any> {
  const res = await ctx.fetch(`${BASE[ctx.mode]}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token(ctx)}`,
      'content-type': 'application/json',
      ...(requestId ? { 'paypal-request-id': requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json: any = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json?.details?.[0]?.description ?? json?.message ?? `PayPal error ${res.status}`);
  return json;
}

export const paypalGateway: GatewayAdapter = {
  key: 'paypal',
  name: 'PayPal',
  description: 'PayPal wallet and cards through PayPal Checkout (Orders v2).',
  capabilities: {
    checkout: true,
    savePaymentMethod: false,
    offSessionCharge: false,
    refunds: true,
    partialRefunds: true,
    webhooks: true,
    currencies: ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'SGD', 'HKD', 'NZD', 'MXN', 'BRL'],
    paymentMethods: ['paypal', 'card'],
  },
  configSchema: z.object({ brandName: z.string().max(127).optional() }),
  secretFields: [
    { key: 'client_id', label: 'Client ID', required: true },
    { key: 'client_secret', label: 'Client secret', required: true },
    { key: 'webhook_id', label: 'Webhook ID', required: true, help: 'The ID PayPal shows for the webhook you register; used to verify signatures.' },
  ],
  async testConnection(ctx) {
    try {
      await token(ctx);
      return { ok: true, message: `Connected to PayPal (${ctx.mode})` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },
  async createCheckout(ctx, req) {
    const order = await paypal(
      ctx,
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: req.checkoutId, custom_id: req.checkoutId, description: req.description.slice(0, 127), amount: { currency_code: req.currency, value: toDecimalString(req.amount, req.currency) } }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: ctx.config.brandName,
              user_action: 'PAY_NOW',
              return_url: `${ctx.returnUrl}?checkout=${encodeURIComponent(req.checkoutId)}`,
              cancel_url: req.cancelUrl,
            },
          },
        },
      },
      `checkout-${req.checkoutId}`,
    );
    const approve = order.links?.find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
    return { url: approve?.href, gatewaySessionId: order.id };
  },
  async refund(ctx, req) {
    try {
      const r = await paypal(ctx, 'POST', `/v2/payments/captures/${req.gatewayPaymentId}/refund`, { amount: { value: toDecimalString(req.amount, req.currency), currency_code: req.currency }, note_to_payer: req.reason ?? undefined }, req.idempotencyKey);
      return { status: r.status === 'COMPLETED' ? 'succeeded' : 'pending', gatewayRefundId: r.id };
    } catch (err) {
      return { status: 'failed', failureMessage: (err as Error).message };
    }
  },
  async parseWebhook(ctx, req) {
    const evt = JSON.parse(req.rawBody);
    // PayPal verifies signatures server-side; we never trust an unverified body.
    const verification = await paypal(ctx, 'POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: header(req.headers, 'paypal-auth-algo'),
      cert_url: header(req.headers, 'paypal-cert-url'),
      transmission_id: header(req.headers, 'paypal-transmission-id'),
      transmission_sig: header(req.headers, 'paypal-transmission-sig'),
      transmission_time: header(req.headers, 'paypal-transmission-time'),
      webhook_id: ctx.secrets.webhook_id,
      webhook_event: evt,
    });
    if (verification.verification_status !== 'SUCCESS') throw new WebhookSignatureError();
    const r = evt.resource ?? {};
    switch (evt.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        return [{ type: 'payment.succeeded', eventId: evt.id, checkoutId: r.custom_id ?? null, gatewayPaymentId: r.id, amount: toMinor(r.amount.value, r.amount.currency_code), currency: r.amount.currency_code, method: { type: 'paypal' }, fee: r.seller_receivable_breakdown?.paypal_fee ? toMinor(r.seller_receivable_breakdown.paypal_fee.value, r.amount.currency_code) : null }];
      case 'PAYMENT.CAPTURE.DENIED':
        return [{ type: 'payment.failed', eventId: evt.id, checkoutId: r.custom_id ?? null, gatewayPaymentId: r.id, failureCode: 'capture_denied', failureMessage: 'PayPal denied the capture' }];
      case 'PAYMENT.CAPTURE.REFUNDED': {
        const captureLink = (r.links ?? []).find((l: any) => l.rel === 'up')?.href ?? '';
        return [{ type: 'refund.succeeded', eventId: evt.id, gatewayPaymentId: captureLink.split('/').pop() ?? '', gatewayRefundId: r.id, amount: toMinor(r.amount.value, r.amount.currency_code), currency: r.amount.currency_code }];
      }
      case 'CUSTOMER.DISPUTE.CREATED':
        return [{ type: 'dispute.created', eventId: evt.id, gatewayPaymentId: r.disputed_transactions?.[0]?.seller_transaction_id ?? '', gatewayDisputeId: r.dispute_id, amount: toMinor(r.dispute_amount.value, r.dispute_amount.currency_code), currency: r.dispute_amount.currency_code, reason: r.reason ?? null }];
      case 'CUSTOMER.DISPUTE.RESOLVED':
        return [{ type: 'dispute.closed', eventId: evt.id, gatewayDisputeId: r.dispute_id, outcome: r.dispute_outcome?.outcome_code === 'RESOLVED_SELLER_FAVOUR' ? 'won' : 'lost' }];
      default:
        return [{ type: 'ignored', eventId: evt.id, reason: `unhandled ${evt.event_type}` } satisfies GatewayEvent];
    }
  },
  async handleReturn(ctx, query) {
    const checkoutId = query.checkout ?? null;
    if (!query.token) return { events: [], checkoutId };
    const order = await paypal(ctx, 'POST', `/v2/checkout/orders/${query.token}/capture`, {}, `capture-${query.token}`);
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (order.status !== 'COMPLETED' || !capture) return { events: [], checkoutId };
    return {
      checkoutId,
      events: [{ type: 'payment.succeeded', eventId: `return:${capture.id}`, checkoutId: capture.custom_id ?? checkoutId, gatewayPaymentId: capture.id, amount: toMinor(capture.amount.value, capture.amount.currency_code), currency: capture.amount.currency_code, method: { type: 'paypal' } }],
    };
  },
};
