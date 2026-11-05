import { z } from 'zod';
import { hmacSha256, safeEqual } from '../../../core/crypto.js';
import { header, WebhookSignatureError, type GatewayAdapter, type GatewayContext, type GatewayEvent, type PaymentMethodInfo } from './types.js';

const API = 'https://api.stripe.com/v1';

/** Stripe-style form encoding: nested objects and arrays become a[b][0][c]=v. */
export function stripeForm(params: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? stripeForm(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') stripeForm(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

class StripeApiError extends Error {
  constructor(readonly code: string, message: string, readonly paymentIntent?: string) {
    super(message);
  }
}

async function stripe(ctx: GatewayContext, method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<any> {
  const res = await ctx.fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.secrets.secret_key}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: method === 'POST' && params ? stripeForm(params).toString() : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new StripeApiError(json?.error?.code ?? json?.error?.type ?? 'stripe_error', json?.error?.message ?? `Stripe error ${res.status}`, json?.error?.payment_intent?.id);
  return json;
}

/**
 * Verify a `Stripe-Signature` header (t=timestamp,v1=hmac). Rejects stale
 * timestamps to prevent replays.
 */
export function verifyStripeSignature(payload: string, sigHeader: string | undefined, secret: string, nowSec: number, toleranceSec = 300): boolean {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=') as [string, string]));
  const ts = Number(parts.t);
  if (!ts || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = hmacSha256(secret, `${ts}.${payload}`);
  return sigHeader
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .some((p) => safeEqual(p.slice(3), expected));
}

function methodInfo(pm: any): PaymentMethodInfo | undefined {
  if (!pm || typeof pm !== 'object') return undefined;
  return { type: pm.type, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null, expMonth: pm.card?.exp_month ?? null, expYear: pm.card?.exp_year ?? null };
}

export const stripeGateway: GatewayAdapter = {
  key: 'stripe',
  name: 'Stripe',
  description: 'Cards, wallets and local payment methods via Stripe Checkout, with saved cards for automatic renewals.',
  capabilities: {
    checkout: true,
    savePaymentMethod: true,
    offSessionCharge: true,
    refunds: true,
    partialRefunds: true,
    webhooks: true,
    currencies: '*',
    paymentMethods: ['card', 'link', 'apple_pay', 'google_pay', 'sepa_debit', 'ideal'],
  },
  configSchema: z.object({ statementDescriptor: z.string().max(22).optional() }),
  secretFields: [
    { key: 'secret_key', label: 'Secret key (sk_live_... / sk_test_...)', required: true },
    { key: 'webhook_secret', label: 'Webhook signing secret (whsec_...)', required: true, help: 'From the webhook endpoint you create in the Stripe dashboard.' },
  ],
  async testConnection(ctx) {
    try {
      await stripe(ctx, 'GET', '/balance');
      return { ok: true, message: 'Connected to Stripe' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },
  async createCheckout(ctx, req) {
    const session = await stripe(
      ctx,
      'POST',
      '/checkout/sessions',
      {
        mode: 'payment',
        client_reference_id: req.checkoutId,
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        customer: req.customer.gatewayCustomerRef ?? undefined,
        customer_email: req.customer.gatewayCustomerRef ? undefined : req.customer.email ?? undefined,
        customer_creation: req.customer.gatewayCustomerRef ? undefined : 'always',
        line_items: [{ quantity: 1, price_data: { currency: req.currency.toLowerCase(), unit_amount: req.amount, product_data: { name: req.description } } }],
        payment_intent_data: {
          setup_future_usage: req.savePaymentMethod ? 'off_session' : undefined,
          statement_descriptor: ctx.config.statementDescriptor,
          metadata: { checkout_id: req.checkoutId, ...req.metadata },
        },
        metadata: { checkout_id: req.checkoutId },
      },
      `checkout_${req.checkoutId}`,
    );
    return { url: session.url, gatewaySessionId: session.id };
  },
  async chargeSaved(ctx, req) {
    try {
      const pi = await stripe(
        ctx,
        'POST',
        '/payment_intents',
        {
          amount: req.amount,
          currency: req.currency.toLowerCase(),
          customer: req.customerRef ?? undefined,
          payment_method: req.paymentMethodRef,
          off_session: true,
          confirm: true,
          description: req.description,
          metadata: { invoice_id: req.invoiceId },
          expand: ['payment_method', 'latest_charge.balance_transaction'],
        },
        req.idempotencyKey,
      );
      if (pi.status === 'succeeded') return { status: 'succeeded', gatewayPaymentId: pi.id, method: methodInfo(pi.payment_method), fee: pi.latest_charge?.balance_transaction?.fee ?? null };
      if (pi.status === 'requires_action') return { status: 'requires_action', gatewayPaymentId: pi.id };
      return { status: 'failed', gatewayPaymentId: pi.id, failureCode: pi.status, failureMessage: `Payment ${pi.status}` };
    } catch (err) {
      const e = err as StripeApiError;
      return { status: 'failed', gatewayPaymentId: e.paymentIntent ?? null, failureCode: e.code ?? 'stripe_error', failureMessage: e.message };
    }
  },
  async refund(ctx, req) {
    try {
      const r = await stripe(ctx, 'POST', '/refunds', { payment_intent: req.gatewayPaymentId, amount: req.amount, metadata: { reason: req.reason ?? '' } }, req.idempotencyKey);
      return { status: r.status === 'succeeded' ? 'succeeded' : 'pending', gatewayRefundId: r.id };
    } catch (err) {
      return { status: 'failed', failureMessage: (err as Error).message };
    }
  },
  async parseWebhook(ctx, req) {
    if (!verifyStripeSignature(req.rawBody, header(req.headers, 'stripe-signature'), ctx.secrets.webhook_secret, Math.floor(Date.now() / 1000))) {
      throw new WebhookSignatureError();
    }
    const evt = JSON.parse(req.rawBody);
    const obj = evt.data?.object ?? {};
    const out: GatewayEvent[] = [];
    switch (evt.type) {
      case 'checkout.session.completed': {
        if (obj.payment_status !== 'paid') return [{ type: 'ignored', eventId: evt.id, reason: `payment_status ${obj.payment_status}` }];
        let method: PaymentMethodInfo | undefined;
        let paymentMethodRef: string | null = null;
        let fee: number | null = null;
        if (obj.payment_intent) {
          try {
            const pi = await stripe(ctx, 'GET', `/payment_intents/${obj.payment_intent}?expand[]=payment_method&expand[]=latest_charge.balance_transaction`);
            method = methodInfo(pi.payment_method);
            paymentMethodRef = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id ?? null;
            fee = pi.latest_charge?.balance_transaction?.fee ?? null;
          } catch (err) {
            ctx.log.warn({ err }, 'could not expand Stripe payment intent');
          }
        }
        out.push({
          type: 'payment.succeeded',
          eventId: evt.id,
          checkoutId: obj.client_reference_id ?? obj.metadata?.checkout_id ?? null,
          gatewayPaymentId: obj.payment_intent ?? obj.id,
          amount: obj.amount_total,
          currency: String(obj.currency).toUpperCase(),
          customerRef: obj.customer ?? null,
          paymentMethodRef,
          method,
          fee,
        });
        break;
      }
      case 'payment_intent.succeeded':
        if (!obj.metadata?.invoice_id) return [{ type: 'ignored', eventId: evt.id, reason: 'handled by checkout.session.completed' }];
        out.push({ type: 'payment.succeeded', eventId: evt.id, invoiceId: obj.metadata.invoice_id, gatewayPaymentId: obj.id, amount: obj.amount_received ?? obj.amount, currency: String(obj.currency).toUpperCase(), customerRef: obj.customer ?? null });
        break;
      case 'payment_intent.payment_failed':
        out.push({
          type: 'payment.failed',
          eventId: evt.id,
          invoiceId: obj.metadata?.invoice_id ?? null,
          checkoutId: obj.metadata?.checkout_id ?? null,
          gatewayPaymentId: obj.id,
          failureCode: obj.last_payment_error?.code ?? 'payment_failed',
          failureMessage: obj.last_payment_error?.message ?? 'Payment failed',
        });
        break;
      case 'charge.refunded':
        for (const r of obj.refunds?.data ?? []) {
          if (r.status !== 'succeeded') continue;
          out.push({ type: 'refund.succeeded', eventId: `${evt.id}:${r.id}`, gatewayPaymentId: obj.payment_intent, gatewayRefundId: r.id, amount: r.amount, currency: String(r.currency).toUpperCase() });
        }
        break;
      case 'charge.dispute.created':
        out.push({
          type: 'dispute.created',
          eventId: evt.id,
          gatewayPaymentId: obj.payment_intent,
          gatewayDisputeId: obj.id,
          amount: obj.amount,
          currency: String(obj.currency).toUpperCase(),
          reason: obj.reason ?? null,
          evidenceDueBy: obj.evidence_details?.due_by ? new Date(obj.evidence_details.due_by * 1000) : null,
        });
        break;
      case 'charge.dispute.closed':
        out.push({ type: 'dispute.closed', eventId: evt.id, gatewayDisputeId: obj.id, outcome: obj.status === 'won' ? 'won' : 'lost' });
        break;
      default:
        out.push({ type: 'ignored', eventId: evt.id, reason: `unhandled type ${evt.type}` });
    }
    return out;
  },
};
