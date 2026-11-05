import { describe, expect, it } from 'vitest';
import { hmacSha256 } from '../../../core/crypto.js';
import { stripeForm, stripeGateway, verifyStripeSignature } from './stripe.js';
import { razorpayGateway, verifyRazorpayCallback, verifyRazorpayWebhook } from './razorpay.js';
import { paypalGateway } from './paypal.js';
import type { GatewayContext } from './types.js';

type Call = { url: string; init: RequestInit };

/** Gateway context with a scripted fetch, so adapters are tested without network access. */
function ctx(secrets: Record<string, string>, responses: ((call: Call) => { status?: number; body: unknown }) | Record<string, unknown>[], mode: 'test' | 'live' = 'test') {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const r = typeof responses === 'function' ? responses(call) : { status: 200, body: responses[i++] };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const context: GatewayContext = {
    gatewayId: 'gw_test',
    mode,
    config: {},
    secrets,
    appUrl: 'https://admin.example.com',
    webhookUrl: 'https://admin.example.com/api/public/gateways/gw_test/webhook',
    returnUrl: 'https://admin.example.com/api/public/gateways/gw_test/return',
    fetch: fetchImpl,
    log: { info() {}, warn() {} },
  };
  return { context, calls };
}

describe('Stripe', () => {
  it('encodes nested form parameters the way Stripe expects', () => {
    const body = stripeForm({ a: 1, line_items: [{ price_data: { currency: 'usd', unit_amount: 500 } }], metadata: { x: 'y' }, skip: undefined }).toString();
    expect(decodeURIComponent(body)).toBe('a=1&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=500&metadata[x]=y');
  });

  it('verifies webhook signatures and rejects tampering and replays', () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = '{"id":"evt_1"}';
    const header = `t=${now},v1=${hmacSha256('whsec_x', `${now}.${payload}`)}`;
    expect(verifyStripeSignature(payload, header, 'whsec_x', now)).toBe(true);
    expect(verifyStripeSignature(payload + ' ', header, 'whsec_x', now)).toBe(false);
    expect(verifyStripeSignature(payload, header, 'whsec_other', now)).toBe(false);
    expect(verifyStripeSignature(payload, header, 'whsec_x', now + 3600)).toBe(false);
  });

  it('creates checkout sessions with the checkout reference and saved-card intent', async () => {
    const { context, calls } = ctx({ secret_key: 'sk_test_1' }, [{ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }]);
    const res = await stripeGateway.createCheckout(context, {
      checkoutId: 'chk_1',
      amount: 2000,
      currency: 'USD',
      description: 'Pro',
      lineItems: [],
      customer: { id: 'usr_1', email: 'a@example.com', name: 'A', gatewayCustomerRef: null },
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
      savePaymentMethod: true,
      metadata: {},
    });
    expect(res).toEqual({ url: 'https://checkout.stripe.com/c/cs_1', gatewaySessionId: 'cs_1' });
    const sent = decodeURIComponent(String(calls[0].init.body));
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_1');
    expect(sent).toContain('client_reference_id=chk_1');
    expect(sent).toContain('payment_intent_data[setup_future_usage]=off_session');
    expect(sent).toContain('line_items[0][price_data][unit_amount]=2000');
  });

  it('normalizes checkout.session.completed with the saved payment method', async () => {
    const { context } = ctx({ secret_key: 'sk', webhook_secret: 'whsec_x' }, [
      { id: 'pi_1', payment_method: { id: 'pm_1', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }, latest_charge: { balance_transaction: { fee: 88 } } },
    ]);
    const body = JSON.stringify({ id: 'evt_9', type: 'checkout.session.completed', data: { object: { payment_status: 'paid', client_reference_id: 'chk_1', payment_intent: 'pi_1', amount_total: 2000, currency: 'usd', customer: 'cus_1' } } });
    const now = Math.floor(Date.now() / 1000);
    const events = await stripeGateway.parseWebhook(context, { rawBody: body, headers: { 'stripe-signature': `t=${now},v1=${hmacSha256('whsec_x', `${now}.${body}`)}` }, query: {} });
    expect(events).toEqual([
      expect.objectContaining({ type: 'payment.succeeded', eventId: 'evt_9', checkoutId: 'chk_1', gatewayPaymentId: 'pi_1', amount: 2000, currency: 'USD', customerRef: 'cus_1', paymentMethodRef: 'pm_1', fee: 88 }),
    ]);
  });

  it('maps declines from off-session charges', async () => {
    const { context } = ctx({ secret_key: 'sk' }, () => ({ status: 402, body: { error: { code: 'card_declined', message: 'Your card was declined.', payment_intent: { id: 'pi_x' } } } }));
    const res = await stripeGateway.chargeSaved!(context, { invoiceId: 'inv_1', amount: 100, currency: 'USD', customerRef: 'cus', paymentMethodRef: 'pm', description: 'x', idempotencyKey: 'k' });
    expect(res).toEqual({ status: 'failed', gatewayPaymentId: 'pi_x', failureCode: 'card_declined', failureMessage: 'Your card was declined.' });
  });
});

describe('Razorpay', () => {
  it('verifies webhook and payment-link callback signatures', () => {
    const body = '{"event":"payment_link.paid"}';
    expect(verifyRazorpayWebhook(body, hmacSha256('wh', body), 'wh')).toBe(true);
    expect(verifyRazorpayWebhook(body, hmacSha256('other', body), 'wh')).toBe(false);
    const q = { razorpay_payment_link_id: 'plink_1', razorpay_payment_link_reference_id: 'chk_1', razorpay_payment_link_status: 'paid', razorpay_payment_id: 'pay_1' };
    const signature = hmacSha256('key_secret', 'plink_1|chk_1|paid|pay_1');
    expect(verifyRazorpayCallback({ ...q, razorpay_signature: signature }, 'key_secret')).toBe(true);
    expect(verifyRazorpayCallback({ ...q, razorpay_payment_link_status: 'cancelled', razorpay_signature: signature }, 'key_secret')).toBe(false);
  });

  it('normalizes paid payment links and refunds', async () => {
    const { context } = ctx({ webhook_secret: 'wh' }, []);
    const paid = JSON.stringify({ event: 'payment_link.paid', created_at: 1, payload: { payment_link: { entity: { reference_id: 'chk_1', notes: { checkout_id: 'chk_1' } } }, payment: { entity: { id: 'pay_1', amount: 49900, currency: 'INR', method: 'upi' } } } });
    const [event] = await razorpayGateway.parseWebhook(context, { rawBody: paid, headers: { 'x-razorpay-signature': hmacSha256('wh', paid), 'x-razorpay-event-id': 'rzp_evt_1' }, query: {} });
    expect(event).toMatchObject({ type: 'payment.succeeded', eventId: 'rzp_evt_1', checkoutId: 'chk_1', gatewayPaymentId: 'pay_1', amount: 49900, currency: 'INR' });
    const refund = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 1000, currency: 'INR' } } } });
    const [r] = await razorpayGateway.parseWebhook(context, { rawBody: refund, headers: { 'x-razorpay-signature': hmacSha256('wh', refund) }, query: {} });
    expect(r).toMatchObject({ type: 'refund.succeeded', gatewayRefundId: 'rfnd_1', amount: 1000 });
  });
});

describe('PayPal', () => {
  it('only trusts webhooks PayPal itself verifies', async () => {
    const body = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1', custom_id: 'chk_1', amount: { value: '19.99', currency_code: 'USD' } } });
    const verified = ctx({ client_id: 'id', client_secret: 's', webhook_id: 'WH' }, (call) =>
      call.url.endsWith('/oauth2/token') ? { body: { access_token: 'tok', expires_in: 3600 } } : { body: { verification_status: 'SUCCESS' } },
    );
    const [event] = await paypalGateway.parseWebhook(verified.context, { rawBody: body, headers: {}, query: {} });
    expect(event).toMatchObject({ type: 'payment.succeeded', checkoutId: 'chk_1', gatewayPaymentId: 'CAP-1', amount: 1999, currency: 'USD' });
    expect(verified.calls.some((c) => c.url.includes('sandbox.paypal.com/v1/notifications/verify-webhook-signature'))).toBe(true);

    const rejected = ctx({ client_id: 'id2', client_secret: 's', webhook_id: 'WH' }, (call) =>
      call.url.endsWith('/oauth2/token') ? { body: { access_token: 'tok', expires_in: 3600 } } : { body: { verification_status: 'FAILURE' } },
    );
    rejected.context.gatewayId = 'gw_other';
    await expect(paypalGateway.parseWebhook(rejected.context, { rawBody: body, headers: {}, query: {} })).rejects.toThrow(/signature/i);
  });
});
