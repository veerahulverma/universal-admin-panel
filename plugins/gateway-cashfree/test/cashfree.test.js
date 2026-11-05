import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createMockContext } from '@steward/plugin-sdk';
import { activate } from '../index.js';

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const SECRETS = { client_id: 'TEST_APP_ID', client_secret: 'cfsk_ma_test_secret' };

/**
 * Activate the plugin with exactly its declared permissions and scripted HTTP responses (no network).
 * The gateway context's fetch goes through ctx.http.fetch, like the host's permission-checked fetch.
 */
async function setup(responses = []) {
  const calls = [];
  const ctx = createMockContext({
    id: manifest.id,
    permissions: manifest.permissions,
    fetch: async (url, init = {}) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      const r = responses.shift() ?? { status: 500, body: { message: 'unexpected request', code: 'api_error', type: 'api_error' } };
      return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body) };
    },
  });
  await activate(ctx);
  const gctx = (mode = 'test', secrets = SECRETS) => ({
    gatewayId: 'gw_cashfree',
    mode,
    config: {},
    secrets,
    appUrl: 'https://admin.example.com',
    webhookUrl: 'https://admin.example.com/api/public/gateways/gw_cashfree/webhook',
    returnUrl: 'https://admin.example.com/api/public/gateways/gw_cashfree/return',
    fetch: async (url, init = {}) => {
      const r = await ctx.http.fetch(String(url), init);
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
  });
  return { adapter: ctx.registered.gateways[0], gctx, calls };
}

const checkoutRequest = {
  checkoutId: 'chk_01JCASHFREE',
  amount: 49950,
  currency: 'INR',
  description: 'Pro plan',
  lineItems: [{ description: 'Pro plan', amount: 49950, quantity: 1 }],
  customer: { id: 'usr_1', email: 'asha@example.com', name: 'Asha Rao', gatewayCustomerRef: null },
  successUrl: 'https://app.example.com/ok',
  cancelUrl: 'https://app.example.com/cancel',
  savePaymentMethod: false,
  metadata: { checkout_id: 'chk_01JCASHFREE' },
};

/** A webhook as Cashfree sends it: x-webhook-signature = Base64(HMAC-SHA256(secret, timestamp + raw body)). */
function signed(payload, secret = SECRETS.client_secret, timestamp = String(Date.now())) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
  return { rawBody, headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp, 'x-webhook-version': '2025-01-01', 'content-type': 'application/json' }, query: {} };
}

const order = { order_id: 'CFPay_g47u3888d0k0_tblfm766qc', order_amount: 499.5, order_currency: 'INR', order_tags: { cf_link_id: '13746255', link_id: 'chk_01JCASHFREE' } };
const cardPayment = {
  cf_payment_id: '1504280029',
  payment_status: 'SUCCESS',
  payment_amount: 499.5,
  payment_currency: 'INR',
  payment_message: 'Transaction successful',
  payment_group: 'credit_card',
  payment_method: { card: { channel: null, card_number: 'XXXXXXXXXXXX4738', card_network: 'visa', card_type: 'credit_card', card_bank_name: 'HDFC Bank' } },
};

test('declares what Cashfree payment links support and asks for the API keys', async () => {
  const { adapter } = await setup();
  assert.equal(adapter.key, 'cashfree');
  assert.deepEqual(adapter.capabilities.currencies, ['INR']);
  assert.equal(adapter.capabilities.offSessionCharge, false);
  assert.equal(adapter.capabilities.savePaymentMethod, false);
  assert.deepEqual(adapter.secretFields.map((f) => [f.key, f.required]), [['client_id', true], ['client_secret', true]]);
});

test('creates a payment link keyed by the checkout and returns its hosted URL', async () => {
  const { adapter, gctx, calls } = await setup([
    { body: { cf_link_id: 1576977, link_id: 'chk_01JCASHFREE', link_status: 'ACTIVE', link_url: 'https://payments-test.cashfree.com/links/o1tf1nvcvjhg', link_amount: 499.5, link_currency: 'INR' } },
  ]);
  const res = await adapter.createCheckout(gctx(), checkoutRequest);
  assert.deepEqual(res, { url: 'https://payments-test.cashfree.com/links/o1tf1nvcvjhg', gatewaySessionId: 'chk_01JCASHFREE' });
  assert.equal(calls[0].url, 'https://sandbox.cashfree.com/pg/links');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-client-id'], 'TEST_APP_ID');
  assert.equal(calls[0].init.headers['x-client-secret'], 'cfsk_ma_test_secret');
  assert.equal(calls[0].init.headers['x-api-version'], '2025-01-01');
  assert.deepEqual(calls[0].body, {
    link_id: 'chk_01JCASHFREE',
    link_amount: 499.5,
    link_currency: 'INR',
    link_purpose: 'Pro plan',
    customer_details: { customer_phone: '9999999999', customer_email: 'asha@example.com', customer_name: 'Asha Rao' },
    link_notify: { send_sms: false, send_email: false },
    link_meta: { return_url: 'https://admin.example.com/api/public/gateways/gw_cashfree/return?checkout=chk_01JCASHFREE' },
    link_notes: { checkout_id: 'chk_01JCASHFREE' },
  });
});

test('uses the production API in live mode and surfaces API errors', async () => {
  const { adapter, gctx, calls } = await setup([{ status: 409, body: { message: 'link_id already exists', code: 'link_post_failed', type: 'invalid_request_error' } }]);
  await assert.rejects(adapter.createCheckout(gctx('live'), checkoutRequest), /link_id already exists/);
  assert.equal(calls[0].url, 'https://api.cashfree.com/pg/links');
});

test('verifies webhook signatures and rejects tampering, other secrets and unsigned posts', async () => {
  const { adapter, gctx } = await setup();
  const ok = signed({ data: { order, payment: cardPayment }, event_time: '2026-11-04T10:00:00+05:30', type: 'PAYMENT_SUCCESS_WEBHOOK' });
  assert.equal((await adapter.parseWebhook(gctx(), ok))[0].type, 'payment.succeeded');
  await assert.rejects(adapter.parseWebhook(gctx(), { ...ok, rawBody: ok.rawBody.replace('499.5', '1.5') }), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), { ...ok, headers: { ...ok.headers, 'x-webhook-timestamp': '1' } }), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), signed(JSON.parse(ok.rawBody), 'other_secret')), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), { rawBody: ok.rawBody, headers: {}, query: {} }), { name: 'WebhookSignatureError' });
});

test('normalizes successful, failed and abandoned payments', async () => {
  const { adapter, gctx } = await setup();
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed({ data: { order, payment: cardPayment }, type: 'PAYMENT_SUCCESS_WEBHOOK' })), [
    {
      type: 'payment.succeeded',
      eventId: 'cashfree:payment:1504280029:SUCCESS',
      checkoutId: 'chk_01JCASHFREE',
      gatewayPaymentId: 'CFPay_g47u3888d0k0_tblfm766qc',
      amount: 49950,
      currency: 'INR',
      method: { type: 'card', brand: 'visa', last4: '4738' },
    },
  ]);
  const failed = {
    data: {
      order,
      payment: { cf_payment_id: '1504280030', payment_status: 'FAILED', payment_amount: 499.5, payment_currency: 'INR', payment_message: 'AMOUNT SHOULD BE WITHIN RANGE', payment_group: 'net_banking', payment_method: { netbanking: { netbanking_bank_code: '3054' } } },
      error_details: { error_code: 'TRANSACTION_DECLINED', error_description: 'issuer bank or payment service provider declined the transaction', error_reason: 'auth_declined', error_source: 'customer' },
    },
    type: 'PAYMENT_FAILED_WEBHOOK',
  };
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(failed)), [
    {
      type: 'payment.failed',
      eventId: 'cashfree:payment:1504280030:FAILED',
      checkoutId: 'chk_01JCASHFREE',
      gatewayPaymentId: 'CFPay_g47u3888d0k0_tblfm766qc',
      failureCode: 'TRANSACTION_DECLINED',
      failureMessage: 'issuer bank or payment service provider declined the transaction',
    },
  ]);
  const dropped = { data: { order, payment: { cf_payment_id: '1504280031', payment_status: 'USER_DROPPED', payment_group: 'upi' } }, type: 'PAYMENT_USER_DROPPED_WEBHOOK' };
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(dropped)), [{ type: 'ignored', eventId: 'cashfree:payment:1504280031:USER_DROPPED', reason: 'customer left the payment page' }]);
});

test('reports a missing amount as 0 so billing core flags a mismatch instead of fulfilling', async () => {
  const { adapter, gctx } = await setup();
  const { payment_amount: _amount, ...withoutAmount } = cardPayment;
  const [event] = await adapter.parseWebhook(gctx(), signed({ data: { order, payment: withoutAmount }, type: 'PAYMENT_SUCCESS_WEBHOOK' }));
  assert.equal(event.amount, 0);
});

test('normalizes refund status webhooks', async () => {
  const { adapter, gctx } = await setup();
  const refund = (refund_status) => ({
    data: { refund: { cf_refund_id: 7871, cf_payment_id: 1504280029, refund_id: 'ref_01JREFUND', order_id: order.order_id, refund_amount: 100, refund_currency: 'INR', refund_type: 'MERCHANT_INITIATED', refund_status, status_description: refund_status === 'CANCELLED' ? 'Refund cancelled by bank' : 'Refund processed' } },
    type: 'REFUND_STATUS_WEBHOOK',
  });
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(refund('SUCCESS'))), [
    { type: 'refund.succeeded', eventId: 'cashfree:refund:7871:SUCCESS', gatewayPaymentId: order.order_id, gatewayRefundId: '7871', amount: 10000, currency: 'INR' },
  ]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(refund('CANCELLED'))), [{ type: 'refund.failed', eventId: 'cashfree:refund:7871:CANCELLED', gatewayRefundId: '7871', failureMessage: 'Refund cancelled by bank' }]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(refund('ONHOLD'))), [{ type: 'ignored', eventId: 'cashfree:refund:7871:ONHOLD', reason: 'refund onhold' }]);
});

test('normalizes chargebacks', async () => {
  const { adapter, gctx } = await setup();
  const dispute = (type, dispute_status) => ({
    data: {
      dispute: { dispute_id: '433475257', dispute_type: 'CHARGEBACK', reason_code: '4855', reason_description: 'Goods or Services Not Provided', dispute_amount: 499.5, respond_by: '2026-11-08T00:00:00+05:30', dispute_status, dispute_amount_currency: 'INR' },
      order_details: { order_id: order.order_id, order_amount: 499.5, order_currency: 'INR', cf_payment_id: 1504280029, payment_amount: 499.5, payment_currency: 'INR' },
    },
    type,
  });
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(dispute('DISPUTE_CREATED', 'CHARGEBACK_CREATED'))), [
    {
      type: 'dispute.created',
      eventId: 'cashfree:dispute:433475257:CHARGEBACK_CREATED',
      gatewayPaymentId: order.order_id,
      gatewayDisputeId: '433475257',
      amount: 49950,
      currency: 'INR',
      reason: 'Goods or Services Not Provided',
      evidenceDueBy: new Date('2026-11-08T00:00:00+05:30'),
    },
  ]);
  assert.equal((await adapter.parseWebhook(gctx(), signed(dispute('DISPUTE_CLOSED', 'CHARGEBACK_MERCHANT_WON'))))[0].outcome, 'won');
  assert.equal((await adapter.parseWebhook(gctx(), signed(dispute('DISPUTE_CLOSED', 'CHARGEBACK_REVERSAL'))))[0].outcome, 'won');
  assert.equal((await adapter.parseWebhook(gctx(), signed(dispute('DISPUTE_CLOSED', 'CHARGEBACK_MERCHANT_LOST'))))[0].outcome, 'lost');
  assert.equal((await adapter.parseWebhook(gctx(), signed(dispute('DISPUTE_CLOSED', 'CHARGEBACK_MERCHANT_ACCEPTED'))))[0].outcome, 'lost');
  assert.equal((await adapter.parseWebhook(gctx(), signed(dispute('DISPUTE_UPDATED', 'CHARGEBACK_DOCS_RECEIVED'))))[0].type, 'ignored');
});

test('refunds against the link’s order, fully or partially', async () => {
  const { adapter, gctx, calls } = await setup([
    { body: { cf_refund_id: '7871', refund_id: 'ref_01JREFUND', order_id: order.order_id, refund_amount: 100, refund_currency: 'INR', refund_status: 'PENDING' } },
    { body: { cf_refund_id: '7872', refund_id: 'ref_01JREFUND2', order_id: order.order_id, refund_amount: 399.5, refund_currency: 'INR', refund_status: 'SUCCESS' } },
    { status: 400, body: { message: 'refund_amount : amount should be less than or equal to the remaining amount', code: 'refund_amount_invalid', type: 'invalid_request_error' } },
  ]);
  assert.deepEqual(await adapter.refund(gctx(), { gatewayPaymentId: order.order_id, amount: 10000, currency: 'INR', reason: 'Goodwill', idempotencyKey: 'ref_01JREFUND' }), { status: 'pending', gatewayRefundId: '7871' });
  assert.equal(calls[0].url, `https://sandbox.cashfree.com/pg/orders/${order.order_id}/refunds`);
  assert.deepEqual(calls[0].body, { refund_amount: 100, refund_id: 'ref_01JREFUND', refund_note: 'Goodwill' });
  assert.deepEqual(await adapter.refund(gctx(), { gatewayPaymentId: order.order_id, amount: 39950, currency: 'INR', reason: null, idempotencyKey: 'ref_01JREFUND2' }), { status: 'succeeded', gatewayRefundId: '7872' });
  assert.deepEqual(calls[1].body, { refund_amount: 399.5, refund_id: 'ref_01JREFUND2' });
  assert.deepEqual(await adapter.refund(gctx(), { gatewayPaymentId: order.order_id, amount: 999900, currency: 'INR', reason: null, idempotencyKey: 'ref_3' }), {
    status: 'failed',
    failureMessage: 'refund_amount : amount should be less than or equal to the remaining amount',
  });
});

test('confirms the payment with Cashfree when the customer returns', async () => {
  const { adapter, gctx, calls } = await setup([
    { body: [{ cf_order_id: '2149460581', order_id: order.order_id, order_status: 'PAID', order_amount: 499.5, order_currency: 'INR' }] },
    { body: [{ ...cardPayment, cf_payment_id: '1504280028', payment_status: 'FAILED' }, cardPayment] },
    { body: [] },
  ]);
  assert.deepEqual(await adapter.handleReturn(gctx(), { checkout: 'chk_01JCASHFREE' }), {
    checkoutId: 'chk_01JCASHFREE',
    events: [
      { type: 'payment.succeeded', eventId: 'cashfree:payment:1504280029:SUCCESS', checkoutId: 'chk_01JCASHFREE', gatewayPaymentId: order.order_id, amount: 49950, currency: 'INR', method: { type: 'card', brand: 'visa', last4: '4738' } },
    ],
  });
  assert.equal(calls[0].url, 'https://sandbox.cashfree.com/pg/links/chk_01JCASHFREE/orders?status=PAID');
  assert.equal(calls[1].url, `https://sandbox.cashfree.com/pg/orders/${order.order_id}/payments`);
  assert.deepEqual(await adapter.handleReturn(gctx(), { checkout: 'chk_01JUNPAID' }), { events: [], checkoutId: 'chk_01JUNPAID' });
  assert.deepEqual(await adapter.handleReturn(gctx(), { checkout: '../../orders' }), { events: [], checkoutId: '../../orders' });
  assert.equal(calls.length, 3);
});

test('tests the connection with the stored keys', async () => {
  const { adapter, gctx, calls } = await setup([
    { status: 404, body: { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' } },
    { status: 401, body: { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' } },
  ]);
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: true, message: 'Connected to Cashfree (sandbox)' });
  assert.equal(calls[0].url, 'https://sandbox.cashfree.com/pg/orders/steward_connection_test');
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: false, message: 'authentication Failed' });
});
