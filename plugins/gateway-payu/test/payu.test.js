import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createMockContext } from '@steward/plugin-sdk';
import { activate } from '../index.js';

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const SECRETS = { merchant_key: 'testkey', merchant_salt: 'testsalt' };
const API = 'https://test.payu.in/merchant/postservice.php?form=2';
const sha512 = (s) => createHash('sha512').update(s).digest('hex');

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
      calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body ?? '')) });
      const r = responses.shift() ?? { status: 500, body: { msg: 'unexpected request' } };
      return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
    },
  });
  await activate(ctx);
  const gctx = (mode = 'test', secrets = SECRETS) => ({
    gatewayId: 'gw_payu',
    mode,
    config: {},
    secrets,
    appUrl: 'https://admin.example.com',
    webhookUrl: 'https://admin.example.com/api/public/gateways/gw_payu/webhook',
    returnUrl: 'https://admin.example.com/api/public/gateways/gw_payu/return',
    fetch: async (url, init = {}) => {
      const r = await ctx.http.fetch(String(url), init);
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
  });
  return { ctx, adapter: ctx.registered.gateways[0], gctx, calls };
}

const checkoutRequest = {
  checkoutId: 'chk_123',
  amount: 49900,
  currency: 'INR',
  description: 'Pro plan | yearly',
  lineItems: [{ description: 'Pro plan', amount: 49900, quantity: 1 }],
  customer: { id: 'usr_1', email: 'asha@example.com', name: 'Asha Rao', gatewayCustomerRef: null },
  successUrl: 'https://app.example.com/ok',
  cancelUrl: 'https://app.example.com/cancel',
  savePaymentMethod: false,
  metadata: { checkout_id: 'chk_123' },
};

const formFields = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));

/**
 * What PayU posts back (surl/furl and payment webhooks), signed with the documented reverse hash:
 * [additional_charges|]SALT|status|[splitInfo|]|||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
 */
function payuResponse(fields, { salt = SECRETS.merchant_salt, charges, splitInfo } = {}) {
  const f = { key: 'testkey', txnid: 'stwtxn1', amount: '499.00', productinfo: 'Pro plan', firstname: 'Asha', email: 'asha@example.com', udf1: 'chk_123', udf2: 'gw_payu', udf3: '', udf4: '', udf5: '', mihpayid: '403993715531', mode: 'UPI', ...fields };
  const tail = `||||||${f.udf5}|${f.udf4}|${f.udf3}|${f.udf2}|${f.udf1}|${f.email}|${f.firstname}|${f.productinfo}|${f.amount}|${f.txnid}|${f.key}`;
  const signedString = `${charges ? `${charges}|` : ''}${salt}|${f.status}${splitInfo ? `|${splitInfo}` : ''}${tail}`;
  return { ...f, ...(charges ? { additionalCharges: charges } : {}), ...(splitInfo ? { splitInfo } : {}), hash: sha512(signedString) };
}

const webhook = (fields, contentType = 'application/x-www-form-urlencoded') => ({
  rawBody: contentType.includes('json') ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
  headers: { 'content-type': contentType },
  query: {},
});

test('declares INR hosted checkout without saved methods and asks only for the key and salt', async () => {
  const { adapter } = await setup();
  assert.equal(adapter.key, 'payu');
  assert.deepEqual(adapter.capabilities.currencies, ['INR']);
  assert.equal(adapter.capabilities.offSessionCharge, false);
  assert.equal(adapter.capabilities.savePaymentMethod, false);
  assert.deepEqual(adapter.secretFields.map((f) => [f.key, f.required]), [['merchant_key', true], ['merchant_salt', true]]);
});

test('creates a checkout page that posts a correctly hashed form to PayU', async () => {
  const { ctx, adapter, gctx } = await setup();
  const res = await adapter.createCheckout(gctx(), checkoutRequest);
  const url = new URL(res.url);
  assert.equal(url.origin + url.pathname, 'https://admin.example.com/api/plugins/gateway-payu/pay');
  assert.ok(!res.url.includes('asha'), 'no personal data in the URL');
  assert.match(res.gatewaySessionId, /^[A-Za-z0-9]{1,25}$/);

  const page = await ctx.request('GET', '/pay', { query: { t: url.searchParams.get('t') } });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(page.body, /<form method="post" action="https:\/\/test\.payu\.in\/_payment">/);
  assert.match(page.body, /<input id="phone" name="phone" type="tel"[^>]* required/);
  // Browsers compile pattern attributes with the "v" flag and ignore patterns that are invalid there.
  const pattern = page.body.match(/pattern="([^"]+)"/)[1];
  assert.ok(new RegExp(`^(?:${pattern})$`, 'v').test('+91 98765 43210'));
  assert.ok(!new RegExp(`^(?:${pattern})$`, 'v').test('call me'));
  const fields = formFields(page.body);
  assert.deepEqual(Object.keys(fields).sort(), ['amount', 'email', 'firstname', 'furl', 'hash', 'key', 'productinfo', 'surl', 'txnid', 'udf1', 'udf2']);
  assert.equal(fields.key, 'testkey');
  assert.equal(fields.txnid, res.gatewaySessionId);
  assert.equal(fields.amount, '499.00');
  assert.equal(fields.productinfo, 'Pro plan   yearly');
  assert.equal(fields.firstname, 'Asha Rao');
  assert.equal(fields.email, 'asha@example.com');
  assert.equal(fields.udf1, 'chk_123');
  assert.equal(fields.udf2, 'gw_payu');
  assert.equal(fields.surl, 'https://admin.example.com/api/plugins/gateway-payu/return');
  assert.equal(fields.furl, fields.surl);
  // key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
  assert.equal(fields.hash, sha512(`testkey|${fields.txnid}|499.00|Pro plan   yearly|Asha Rao|asha@example.com|chk_123|gw_payu|||||||||testsalt`));
});

test('posts to the live checkout in live mode, trims names for the test environment and rejects other currencies', async () => {
  const { ctx, adapter, gctx } = await setup();
  const live = await adapter.createCheckout(gctx('live'), { ...checkoutRequest, customer: { ...checkoutRequest.customer, name: 'Asha Rao Venkataraman Iyer' } });
  const livePage = await ctx.request('GET', '/pay', { query: { t: new URL(live.url).searchParams.get('t') } });
  assert.match(livePage.body, /action="https:\/\/secure\.payu\.in\/_payment"/);
  assert.equal(formFields(livePage.body).firstname, 'Asha Rao Venkataraman Iyer');
  const test = await adapter.createCheckout(gctx('test'), { ...checkoutRequest, customer: { ...checkoutRequest.customer, name: 'Asha Rao Venkataraman Iyer' } });
  const testPage = await ctx.request('GET', '/pay', { query: { t: new URL(test.url).searchParams.get('t') } });
  assert.equal(formFields(testPage.body).firstname, 'Asha Rao Venkatarama');
  await assert.rejects(adapter.createCheckout(gctx(), { ...checkoutRequest, currency: 'USD' }), /INR only/);
});

test('refuses forged, missing and expired checkout tokens', async (t) => {
  const { ctx, adapter, gctx } = await setup();
  assert.equal((await ctx.request('GET', '/pay', { query: { t: 'forged' } })).status, 404);
  assert.equal((await ctx.request('GET', '/pay', { query: {} })).status, 404);
  const token = new URL((await adapter.createCheckout(gctx(), checkoutRequest)).url).searchParams.get('t');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 25 * 60 * 60 * 1000);
  assert.equal((await ctx.request('GET', '/pay', { query: { t: token } })).status, 410);
});

test('hands the customer from PayU to Steward’s return URL without trusting the post', async () => {
  const { ctx } = await setup();
  const res = await ctx.request('POST', '/return', { body: payuResponse({ status: 'success' }) });
  assert.equal(res.status, 200);
  assert.match(res.body, /<form method="get" action="\.\.\/\.\.\/public\/gateways\/gw_payu\/return">/);
  assert.deepEqual(formFields(res.body), { checkout: 'chk_123', txnid: 'stwtxn1' });
  assert.ok(!res.body.includes('asha@example.com'));
  assert.equal((await ctx.request('POST', '/return', { body: { udf2: '../../evil', udf1: 'chk_1', txnid: 't' } })).status, 400);
  assert.equal((await ctx.request('POST', '/return', { body: null })).status, 400);
});

test('confirms the payment with the Verify Payment API on return', async () => {
  const { adapter, gctx, calls } = await setup([
    {
      body: {
        status: 1,
        msg: '1 out of 1 Transactions Fetched Successfully',
        transaction_details: { stwtxn1: { mihpayid: '403993715531', txnid: 'stwtxn1', status: 'success', unmappedstatus: 'captured', amt: '499.00', mode: 'CC', card_type: 'VISA', card_no: '512345XXXXXX2346', udf1: 'chk_123' } },
      },
    },
  ]);
  const res = await adapter.handleReturn(gctx(), { checkout: 'chk_123', txnid: 'stwtxn1' });
  assert.deepEqual(res, {
    checkoutId: 'chk_123',
    events: [
      { type: 'payment.succeeded', eventId: 'payu:payment:403993715531:success', checkoutId: 'chk_123', gatewayPaymentId: '403993715531', amount: 49900, currency: 'INR', method: { type: 'card', brand: 'VISA', last4: '2346' } },
    ],
  });
  assert.equal(calls[0].url, API);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(calls[0].form, { key: 'testkey', command: 'verify_payment', var1: 'stwtxn1', hash: sha512('testkey|verify_payment|stwtxn1|testsalt') });
});

test('reports failed payments on return and ignores pending or unknown transactions', async () => {
  const { adapter, gctx, calls } = await setup([
    { body: { status: 1, transaction_details: { stwtxn2: { mihpayid: '4039937155', txnid: 'stwtxn2', status: 'failure', error_code: 'E308', error_Message: 'Bank declined', udf1: 'chk_9' } } } },
    { body: { status: 1, transaction_details: { stwtxn3: { mihpayid: '4039937156', txnid: 'stwtxn3', status: 'pending', unmappedstatus: 'pending', udf1: 'chk_8' } } } },
    { body: { status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { nope: { mihpayid: 'Not Found', status: 'Not Found' } } } },
  ]);
  assert.deepEqual((await adapter.handleReturn(gctx(), { checkout: 'chk_9', txnid: 'stwtxn2' })).events, [
    { type: 'payment.failed', eventId: 'payu:payment:4039937155:failure', checkoutId: 'chk_9', gatewayPaymentId: '4039937155', failureCode: 'E308', failureMessage: 'Bank declined' },
  ]);
  assert.deepEqual(await adapter.handleReturn(gctx(), { checkout: 'chk_8', txnid: 'stwtxn3' }), { events: [], checkoutId: 'chk_8' });
  assert.deepEqual(await adapter.handleReturn(gctx(), { checkout: 'chk_x', txnid: 'nope' }), { events: [], checkoutId: 'chk_x' });
  assert.deepEqual(await adapter.handleReturn(gctx(), { checkout: 'chk_y', txnid: '../x' }), { events: [], checkoutId: 'chk_y' });
  assert.equal(calls.length, 3);
});

test('reports a missing amount as 0 so billing core flags a mismatch instead of fulfilling', async () => {
  const { adapter, gctx } = await setup([{ body: { status: 1, transaction_details: { stwtxn4: { mihpayid: '4039937157', txnid: 'stwtxn4', status: 'success', mode: 'UPI', udf1: 'chk_7' } } } }]);
  assert.equal((await adapter.handleReturn(gctx(), { checkout: 'chk_7', txnid: 'stwtxn4' })).events[0].amount, 0);
});

test('verifies payment webhook hashes and rejects tampering, other salts and unsigned posts', async () => {
  const { adapter, gctx } = await setup();
  const ok = payuResponse({ status: 'success' });
  assert.equal((await adapter.parseWebhook(gctx(), webhook(ok)))[0].type, 'payment.succeeded');
  await assert.rejects(adapter.parseWebhook(gctx(), webhook({ ...ok, amount: '1.00' })), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), webhook({ ...ok, status: 'failure' })), { name: 'WebhookSignatureError' });
  await assert.rejects(adapter.parseWebhook(gctx(), webhook(payuResponse({ status: 'success' }, { salt: 'othersalt' }))), { name: 'WebhookSignatureError' });
  const { hash: _hash, ...unsigned } = ok;
  await assert.rejects(adapter.parseWebhook(gctx(), webhook(unsigned)), { name: 'WebhookSignatureError' });
});

test('accepts the documented hash variants with additional charges and split info', async () => {
  const { adapter, gctx } = await setup();
  const accepted = async (fields) => (await adapter.parseWebhook(gctx(), webhook(fields)))[0].type;
  assert.equal(await accepted(payuResponse({ status: 'success' }, { charges: '11.80' })), 'payment.succeeded');
  assert.equal(await accepted({ ...payuResponse({ status: 'success' }), additional_charges: '0.00' }), 'payment.succeeded');
  const splitInfo = '{"splitStatus":"splitNotReceived","splitSegments":[]}';
  assert.equal(await accepted(payuResponse({ status: 'success' }, { splitInfo })), 'payment.succeeded');
  assert.equal(await accepted({ ...payuResponse({ status: 'success' }), splitInfo }), 'payment.succeeded');
  await assert.rejects(adapter.parseWebhook(gctx(), webhook({ ...payuResponse({ status: 'success' }, { charges: '11.80' }), additionalCharges: '0.01' })), { name: 'WebhookSignatureError' });
});

test('normalizes successful and failed payment webhooks', async () => {
  const { adapter, gctx } = await setup();
  assert.deepEqual(await adapter.parseWebhook(gctx(), webhook(payuResponse({ status: 'success' }))), [
    { type: 'payment.succeeded', eventId: 'payu:payment:403993715531:success', checkoutId: 'chk_123', gatewayPaymentId: '403993715531', amount: 49900, currency: 'INR', method: { type: 'upi', brand: null, last4: null } },
  ]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), webhook(payuResponse({ status: 'failure', error: 'E1605', error_Message: 'Transaction failed due to customer pressing cancel button.' }))), [
    { type: 'payment.failed', eventId: 'payu:payment:403993715531:failure', checkoutId: 'chk_123', gatewayPaymentId: '403993715531', failureCode: 'E1605', failureMessage: 'Transaction failed due to customer pressing cancel button.' },
  ]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), webhook(payuResponse({ status: 'pending' }))), [{ type: 'ignored', eventId: 'payu:payment:403993715531:pending', reason: 'payment pending' }]);
});

test('queues refunds with the refund API', async () => {
  const { adapter, gctx, calls } = await setup([
    { body: { status: 1, msg: 'Refund Request Queued', request_id: '130245627', bank_ref_num: null, mihpayid: 403993715531, error_code: 102 } },
    { body: { status: 0, msg: 'Refund amount is greater than the remaining amount', error_code: 105 } },
  ]);
  assert.deepEqual(await adapter.refund(gctx(), { gatewayPaymentId: '403993715531', amount: 10000, currency: 'INR', reason: null, idempotencyKey: 'ref_01JABCDEFGHJKMNPQRSTVWXYZ0' }), { status: 'pending', gatewayRefundId: '130245627' });
  assert.deepEqual(calls[0].form, {
    key: 'testkey',
    command: 'cancel_refund_transaction',
    var1: '403993715531',
    var2: 'JABCDEFGHJKMNPQRSTVWXYZ0'.slice(-23),
    var3: '100.00',
    var5: 'https://admin.example.com/api/public/gateways/gw_payu/webhook',
    hash: sha512('testkey|cancel_refund_transaction|403993715531|testsalt'),
  });
  assert.equal(calls[0].form.var2.length, 23);
  assert.deepEqual(await adapter.refund(gctx(), { gatewayPaymentId: '403993715531', amount: 99999900, currency: 'INR', reason: null, idempotencyKey: 'ref_2' }), {
    status: 'failed',
    failureMessage: 'Refund amount is greater than the remaining amount',
  });
});

test('confirms refund callbacks with PayU before reporting them', async () => {
  const status = (s) => ({ body: { status: 1, msg: 'Transaction Fetched Successfully', transaction_details: { 130245627: { 130245627: { mihpayid: ' 403993715531 ', request_id: '130245627', amt: '100.00', action: 'refund', status: s } } } } });
  const { adapter, gctx, calls } = await setup([status('success'), status('failure'), status('queued'), { body: { status: 0, msg: 'Invalid request id', transaction_details: {} } }]);
  // Unsigned JSON from PayU: only the request id is used, and only to ask PayU.
  const callback = webhook({ mihpayid: '403993715531', request_id: '130245627', token: 'x', amt: '999999.00', action: 'refund', status: 'success' }, 'application/json');
  assert.deepEqual(await adapter.parseWebhook(gctx(), callback), [
    { type: 'refund.succeeded', eventId: 'payu:refund:130245627:success', gatewayPaymentId: '403993715531', gatewayRefundId: '130245627', amount: 10000, currency: 'INR' },
  ]);
  assert.deepEqual(calls[0].form, { key: 'testkey', command: 'check_action_status', var1: '130245627', hash: sha512('testkey|check_action_status|130245627|testsalt') });
  assert.deepEqual(await adapter.parseWebhook(gctx(), callback), [{ type: 'refund.failed', eventId: 'payu:refund:130245627:failure', gatewayRefundId: '130245627', failureMessage: 'PayU could not process the refund' }]);
  assert.deepEqual(await adapter.parseWebhook(gctx(), callback), [{ type: 'ignored', eventId: 'payu:refund:130245627:queued', reason: 'refund queued' }]);
  // A made-up request id is unknown to PayU, so nothing is recorded.
  assert.deepEqual(await adapter.parseWebhook(gctx(), webhook({ action: 'refund', request_id: '999', status: 'success' }, 'application/json')), []);
});

test('records nothing for unsigned dispute notifications', async () => {
  const { adapter, gctx, calls } = await setup();
  const dispute = webhook({ type: 'payments', event: 'dispute', cb_id: '991', cb_status: 'open', txn_id: '403993715531', updated_at: '2026-11-04 10:00:00' }, 'application/json');
  assert.deepEqual(await adapter.parseWebhook(gctx(), dispute), []);
  assert.equal(calls.length, 0);
});

test('tests the connection with a Verify Payment call', async () => {
  const { adapter, gctx } = await setup([
    { body: { status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { x: { mihpayid: 'Not Found', status: 'Not Found' } } } },
    { body: { status: 0, msg: 'Invalid Hash.' } },
    { body: '<html>Bad gateway</html>', status: 502 },
  ]);
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: true, message: 'Connected to PayU (test)' });
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: false, message: 'Invalid Hash.' });
  assert.deepEqual(await adapter.testConnection(gctx()), { ok: false, message: 'PayU returned an unexpected response (HTTP 502)' });
});
