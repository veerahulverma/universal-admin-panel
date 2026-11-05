import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createMockContext } from '@steward/plugin-sdk';
import { activate } from '../index.js';

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const SECRETS = { api_key: 'pdl_sdbx_apikey_test', webhook_secret: 'pdl_ntfset_test_secret' };

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
      const r = responses.shift() ?? { status: 500, body: { error: { detail: 'unexpected request' } } };
      return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body) };
    },
  });
  await activate(ctx);
  const gctx = (mode = 'test', secrets = SECRETS) => ({
    gatewayId: 'gw_paddle',
    mode,
    config: {},
    secrets,
    appUrl: 'https://admin.example.com',
    webhookUrl: 'https://admin.example.com/api/public/gateways/gw_paddle/webhook',
    returnUrl: 'https://admin.example.com/api/public/gateways/gw_paddle/return',
    fetch: async (url, init = {}) => {
      const r = await ctx.http.fetch(String(url), init);
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
  });
  return { adapter: ctx.registered.gateways[0], gctx, calls };
}

const checkoutRequest = {
  checkoutId: 'chk_123',
  amount: 4900,
  currency: 'USD',
  description: 'Pro plan',
  lineItems: [{ description: 'Pro plan', amount: 4900, quantity: 1 }],
  customer: { id: 'usr_1', email: 'ada@example.com', name: 'Ada', gatewayCustomerRef: null },
  successUrl: 'https://app.example.com/ok',
  cancelUrl: 'https://app.example.com/cancel',
  savePaymentMethod: false,
  metadata: { checkout_id: 'chk_123', subject: 'user:usr_1' },
};

function signed(payload, secret = SECRETS.webhook_secret, ts = Math.floor(Date.now() / 1000)) {
  const rawBody = JSON.stringify(payload);
  const h1 = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  return { rawBody, headers: { 'paddle-signature': `ts=${ts};h1=${h1}` }, query: {} };
}

const completed = {
  event_id: 'evt_01completed',
  event_type: 'transaction.completed',
  occurred_at: '2026-11-04T10:00:00.000Z',
  notification_id: 'ntf_01',
  data: {
    id: 'txn_01abc',
    status: 'completed',
    customer_id: 'ctm_01xyz',
    currency_code: 'USD',
    custom_data: { checkout_id: 'chk_123' },
    details: { totals: { subtotal: '4455', tax: '445', total: '4900', grand_total: '4900', fee: '295', earnings: '4160', currency_code: 'USD' } },
    payments: [{ status: 'captured', amount: '4900', error_code: null, method_details: { type: 'card', card: { type: 'visa', last4: '4242', expiry_month: 1, expiry_year: 2030 } } }],
  },
};

const adjustment = (action, status, eventType = 'adjustment.created') => ({
  event_id: `evt_${action}_${status}`,
  event_type: eventType,
  data: { id: 'adj_01', action, type: 'full', status, transaction_id: 'txn_01abc', reason: 'fraud', currency_code: 'USD', totals: { total: '1000', currency_code: 'USD' } },
});

test('declares what Paddle supports and nothing it does not', async () => {
  const { adapter } = await setup();
  assert.equal(adapter.key, 'paddle');
  assert.equal(adapter.capabilities.offSessionCharge, false);
  assert.equal(adapter.capabilities.savePaymentMethod, false);
  assert.equal(adapter.capabilities.currencies.length, 33);
  assert.deepEqual(adapter.secretFields.map((f) => [f.key, f.required]), [['api_key', true], ['webhook_secret', true]]);
});

test('creates a one-off, tax-inclusive transaction and returns its checkout URL', async () => {
  const { adapter, gctx, calls } = await setup([
    { status: 201, body: { data: { id: 'txn_01abc', status: 'draft', checkout: { url: 'https://pay.example.com/checkout?_ptxn=txn_01abc' } } } },
  ]);
  const res = await adapter.createCheckout(gctx(), checkoutRequest);
  assert.deepEqual(res, { url: 'https://pay.example.com/checkout?_ptxn=txn_01abc', gatewaySessionId: 'txn_01abc' });
  assert.equal(calls[0].url, 'https://sandbox-api.paddle.com/transactions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer pdl_sdbx_apikey_test');
  assert.equal(calls[0].init.headers['paddle-version'], '1');
  assert.deepEqual(calls[0].body.items, [
    {
      quantity: 1,
      price: {
        description: 'Steward checkout chk_123',
        name: 'Pro plan',
        tax_mode: 'internal',
        unit_price: { amount: '4900', currency_code: 'USD' },
        quantity: { minimum: 1, maximum: 1 },
        product: { name: 'Pro plan', tax_category: 'standard' },
      },
    },
  ]);
  assert.equal(calls[0].body.currency_code, 'USD');
  assert.equal(calls[0].body.collection_mode, 'automatic');
  assert.deepEqual(calls[0].body.custom_data, { checkout_id: 'chk_123', subject: 'user:usr_1' });
});

test('uses the live API in live mode', async () => {
  const { adapter, gctx, calls } = await setup([{ status: 201, body: { data: { id: 'txn_live', checkout: { url: 'https://pay.example.com/?_ptxn=txn_live' } } } }]);
  await adapter.createCheckout(gctx('live', { ...SECRETS, api_key: 'pdl_live_apikey_test' }), checkoutRequest);
  assert.equal(calls[0].url, 'https://api.paddle.com/transactions');
});

test('surfaces Paddle errors such as a missing default payment link', async () => {
  const { adapter, gctx } = await setup([
    { status: 400, body: { error: { type: 'request_error', code: 'transaction_default_checkout_url_not_set', detail: 'A Default Checkout URL must be set on the account' } } },
    { status: 201, body: { data: { id: 'txn_01abc', checkout: null } } },
  ]);
  await assert.rejects(adapter.createCheckout(gctx(), checkoutRequest), /Default Checkout URL/);
  await assert.rejects(adapter.createCheckout(gctx(), checkoutRequest), /default payment link/);
});

test('verifies webhook signatures and rejects tampering, wrong secrets and stale timestamps', async () => {
  const { adapter, gctx } = await setup();
  const ok = signed(completed);
  assert.equal((await adapter.parseWebhook(gctx(), ok)).length, 1);
  await assert.rejects(adapter.parseWebhook(gctx(), { ...ok, rawBody: ok.rawBody.replace('"grand_total":"4900"', '"grand_total":"1"') }), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), signed(completed, 'pdl_ntfset_other')), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), signed(completed, SECRETS.webhook_secret, Math.floor(Date.now() / 1000) - 3600)), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), { rawBody: ok.rawBody, headers: {}, query: {} }), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), { ...ok, headers: { 'paddle-signature': 'garbage' } }), { name: 'WebhookSignatureError' });
});

test('accepts any matching h1 while the webhook secret rotates', async () => {
  const { adapter, gctx } = await setup();
  const ok = signed(completed);
  const rotating = ok.headers['paddle-signature'].replace(';h1=', `;h1=${'0'.repeat(64)};h1=`);
  assert.equal((await adapter.parseWebhook(gctx(), { ...ok, headers: { 'paddle-signature': rotating } })).length, 1);
});

test('normalizes transaction.completed into payment.succeeded', async () => {
  const { adapter, gctx } = await setup();
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(completed)), [
    {
      type: 'payment.succeeded',
      eventId: 'evt_01completed',
      checkoutId: 'chk_123',
      gatewayPaymentId: 'txn_01abc',
      amount: 4900,
      currency: 'USD',
      method: { type: 'card', brand: 'visa', last4: '4242' },
      customerRef: 'ctm_01xyz',
      fee: 295,
    },
  ]);
});

test('reports a missing amount as 0 so billing core flags a mismatch instead of fulfilling', async () => {
  const { adapter, gctx } = await setup();
  const broken = { ...completed, event_id: 'evt_broken', data: { ...completed.data, details: { totals: {} } } };
  const [event] = await adapter.parseWebhook(gctx(), signed(broken));
  assert.equal(event.amount, 0);
  assert.equal(event.fee, null);
});

test('normalizes transaction.payment_failed from the newest payment attempt', async () => {
  const { adapter, gctx } = await setup();
  const failed = {
    event_id: 'evt_01failed',
    event_type: 'transaction.payment_failed',
    data: {
      id: 'txn_01abc',
      status: 'ready',
      currency_code: 'USD',
      custom_data: { checkout_id: 'chk_123' },
      payments: [
        { status: 'error', error_code: 'declined', method_details: { type: 'card' } },
        { status: 'error', error_code: 'expired_card', method_details: { type: 'card' } },
      ],
    },
  };
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(failed)), [
    { type: 'payment.failed', eventId: 'evt_01failed', checkoutId: 'chk_123', gatewayPaymentId: 'txn_01abc', failureCode: 'declined', failureMessage: 'Paddle payment failed (declined)' },
  ]);
});

test('turns refund adjustments into refund events once Paddle approves or rejects them', async () => {
  const { adapter, gctx } = await setup();
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(adjustment('refund', 'approved', 'adjustment.updated'))), [
    { type: 'refund.succeeded', eventId: 'evt_refund_approved', gatewayPaymentId: 'txn_01abc', gatewayRefundId: 'adj_01', amount: 1000, currency: 'USD' },
  ]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(adjustment('refund', 'rejected', 'adjustment.updated'))), [
    { type: 'refund.failed', eventId: 'evt_refund_rejected', gatewayRefundId: 'adj_01', failureMessage: 'Paddle rejected the refund' },
  ]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(adjustment('refund', 'pending_approval'))), [{ type: 'ignored', eventId: 'evt_refund_pending_approval', reason: 'refund pending_approval' }]);
});

test('reports chargebacks and their reversals as disputes on the transaction', async () => {
  const { adapter, gctx } = await setup();
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(adjustment('chargeback', 'approved'))), [
    { type: 'dispute.created', eventId: 'evt_chargeback_approved', gatewayPaymentId: 'txn_01abc', gatewayDisputeId: 'txn_01abc', amount: 1000, currency: 'USD', reason: 'fraud' },
  ]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed(adjustment('chargeback_reverse', 'approved'))), [
    { type: 'dispute.closed', eventId: 'evt_chargeback_reverse_approved', gatewayDisputeId: 'txn_01abc', outcome: 'won' },
  ]);
  assert.equal((await adapter.parseWebhook(gctx(), signed(adjustment('credit', 'approved'))))[0].type, 'ignored');
  assert.deepEqual(await adapter.parseWebhook(gctx(), signed({ event_id: 'evt_x', event_type: 'customer.updated', data: {} })), [{ type: 'ignored', eventId: 'evt_x', reason: 'unhandled customer.updated' }]);
});

test('refunds the whole transaction with a full adjustment', async () => {
  const { adapter, gctx, calls } = await setup([
    { body: { data: { id: 'txn_01abc', status: 'completed', details: { totals: { grand_total: '4900' }, line_items: [{ id: 'txnitm_01' }] } } } },
    { status: 201, body: { data: { id: 'adj_01', status: 'pending_approval' } } },
  ]);
  const res = await adapter.refund(gctx(), { gatewayPaymentId: 'txn_01abc', amount: 4900, currency: 'USD', reason: null, idempotencyKey: 'ref_1' });
  assert.deepEqual(res, { status: 'pending', gatewayRefundId: 'adj_01' });
  assert.equal(calls[0].url, 'https://sandbox-api.paddle.com/transactions/txn_01abc');
  assert.equal(calls[1].url, 'https://sandbox-api.paddle.com/adjustments');
  assert.deepEqual(calls[1].body, { action: 'refund', transaction_id: 'txn_01abc', reason: 'Refund requested by the merchant', type: 'full' });
});

test('refunds part of a transaction against its line item', async () => {
  const { adapter, gctx, calls } = await setup([
    { body: { data: { id: 'txn_01abc', status: 'completed', details: { totals: { grand_total: '4900' }, line_items: [{ id: 'txnitm_01' }] } } } },
    { status: 201, body: { data: { id: 'adj_02', status: 'approved' } } },
  ]);
  const res = await adapter.refund(gctx(), { gatewayPaymentId: 'txn_01abc', amount: 1000, currency: 'USD', reason: 'Goodwill', idempotencyKey: 'ref_2' });
  assert.deepEqual(res, { status: 'succeeded', gatewayRefundId: 'adj_02' });
  assert.deepEqual(calls[1].body, { action: 'refund', transaction_id: 'txn_01abc', reason: 'Goodwill', type: 'partial', items: [{ item_id: 'txnitm_01', type: 'partial', amount: '1000' }] });
});

test('reports refund API errors as failed refunds', async () => {
  const { adapter, gctx } = await setup([
    { body: { data: { id: 'txn_01abc', details: { totals: { grand_total: '4900' }, line_items: [{ id: 'txnitm_01' }] } } } },
    { status: 400, body: { error: { type: 'request_error', code: 'adjustment_pending_refund_request', detail: 'A refund request is already pending for this transaction' } } },
  ]);
  const res = await adapter.refund(gctx(), { gatewayPaymentId: 'txn_01abc', amount: 100, currency: 'USD', reason: null, idempotencyKey: 'ref_3' });
  assert.deepEqual(res, { status: 'failed', failureMessage: 'A refund request is already pending for this transaction' });
});

test('tests the connection, including the API key’s permissions', async () => {
  const root = (permissions, account = { id: 'slr_01', name: 'Acme' }) => ({ body: { data: { api: { environment: 'sandbox' }, caller: { auth_type: account ? 'api_key' : null, account, permissions } } } });
  const { adapter, gctx, calls } = await setup([
    root(['transaction.write', 'adjustment.write', 'customer.read']),
    root(['transaction.read']),
    root([], null),
    { status: 403, body: { error: { type: 'request_error', code: 'invalid_token', detail: 'Authentication token is invalid.' } } },
  ]);
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: true, message: 'Connected to Paddle (sandbox) as Acme' });
  assert.equal(calls[0].url, 'https://sandbox-api.paddle.com/');
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: false, message: 'The API key is missing these permissions: transaction.write, adjustment.write' });
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: false, message: 'Paddle did not accept the API key' });
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: false, message: 'Authentication token is invalid.' });
});
