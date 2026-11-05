// PayU India gateway plugin (PayU Hosted Checkout, the v1 `_payment` form). PayU needs
// the customer's mobile number, which Steward does not store, so this plugin serves a
// one-field page that adds it to a hash-signed form and posts that form to PayU. PayU
// posts the result back to /return, which sends the customer on to Steward's return URL,
// where the payment is confirmed server to server with the Verify Payment API before
// anything is fulfilled. Payment webhooks carry PayU's reverse hash; refund callbacks
// are unsigned, so they only prompt a status check with PayU.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CHECKOUT = { test: 'https://test.payu.in/_payment', live: 'https://secure.payu.in/_payment' };
const API = { test: 'https://test.payu.in/merchant/postservice.php?form=2', live: 'https://info.payu.in/merchant/postservice.php?form=2' };
const PAGE_TTL_MS = 24 * 60 * 60 * 1000;
const UDF = ['udf1', 'udf2', 'udf3', 'udf4', 'udf5'];
const METHOD = { CC: 'card', DC: 'card', NB: 'netbanking', UPI: 'upi', QR: 'upi', SBQR: 'upi', CASH: 'wallet', EMI: 'emi', CLEMI: 'emi', BNPL: 'paylater', NEFTRTGS: 'bank_transfer' };
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const sha512 = (s) => createHash('sha512').update(s, 'utf8').digest('hex');
const rupees = (paise) => (paise / 100).toFixed(2);
// A missing or malformed amount becomes 0, which billing core reports as an amount mismatch instead of fulfilling.
const toPaise = (amount) => {
  const n = Math.round(Number(amount) * 100);
  return Number.isFinite(n) ? n : 0;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// PayU joins hashed fields with "|", so keep it (and control characters) out of free text.
const clean = (s, max) => String(s ?? '').replace(/[|\p{Cc}]/gu, ' ').trim().slice(0, max);

const header = (headers, name) => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const signatureError = (message) => Object.assign(new Error(message), { name: 'WebhookSignatureError' });

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Request hash: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT). */
function requestHash(f, salt) {
  return sha512([f.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email, ...UDF.map((u) => f[u] ?? ''), '', '', '', '', '', salt].join('|'));
}

/**
 * Reverse hashes PayU may use on a response:
 * sha512([additional_charges|]SALT|status|[splitInfo|]|||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key).
 * PayU sends splitInfo and charge fields on payments it signs without them, so every documented form is accepted.
 */
function responseHashes(f, salt) {
  const tail = [...[...UDF].reverse().map((u) => f[u]), f.email, f.firstname, f.productinfo, f.amount, f.txnid, f.key].map((v) => v ?? '');
  const bases = [[salt, f.status ?? '', '', '', '', '', '', ...tail]];
  if (f.splitInfo) bases.push([salt, f.status ?? '', f.splitInfo, '', '', '', '', '', ...tail]);
  const charges = f.additional_charges ?? f.additionalCharges;
  return (charges ? [...bases.map((b) => [charges, ...b]), ...bases] : bases).map((parts) => sha512(parts.join('|')));
}

/** PayU's command API (verify_payment, cancel_refund_transaction, check_action_status): hash = sha512(key|command|var1|SALT). */
async function command(gctx, name, var1, extra = {}) {
  const { merchant_key: key, merchant_salt: salt } = gctx.secrets;
  const body = new URLSearchParams({ key, command: name, var1, ...extra, hash: sha512(`${key}|${name}|${var1}|${salt}`) }).toString();
  const res = await gctx.fetch(API[gctx.mode], {
    method: 'POST',
    // An explicit length stops the host's HTTP client from sending the form chunked.
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PayU returned an unexpected response (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(json?.msg ?? `PayU error ${res.status}`);
  return json;
}

/** Normalize a payment as PayU reports it (Verify Payment entry, or a hash-verified webhook). */
function paymentEvents(txn, checkoutId) {
  const status = String(txn.status ?? '').toLowerCase();
  const mihpayid = String(txn.mihpayid ?? '').trim();
  if (status === 'success') {
    const mode = String(txn.mode ?? '').toUpperCase();
    return [
      {
        type: 'payment.succeeded',
        eventId: `payu:payment:${mihpayid}:success`,
        checkoutId,
        gatewayPaymentId: mihpayid,
        amount: toPaise(txn.amt ?? txn.amount),
        currency: 'INR',
        method: { type: METHOD[mode] ?? (mode.toLowerCase() || 'unknown'), brand: txn.card_type || null, last4: String(txn.card_no || txn.cardnum || '').slice(-4) || null },
      },
    ];
  }
  if (status === 'failure' || status === 'failed') {
    return [
      {
        type: 'payment.failed',
        eventId: `payu:payment:${mihpayid || txn.txnid}:failure`,
        checkoutId,
        gatewayPaymentId: mihpayid || null,
        failureCode: String(txn.error_code || txn.error || txn.unmappedstatus || 'payment_failed'),
        failureMessage: String(txn.error_Message || txn.field9 || 'Payment failed'),
      },
    ];
  }
  return [];
}

/** Refund callbacks carry no signature: ask PayU for the refund's status instead of trusting the body. */
async function refundEvents(gctx, requestId) {
  const res = await command(gctx, 'check_action_status', requestId);
  const entry = res?.transaction_details?.[requestId];
  const r = entry?.[requestId] ?? (entry?.status ? entry : null);
  // Unknown to PayU, so not a real callback: record nothing.
  if (!r) return [];
  const status = String(r.status ?? '').toLowerCase();
  if (status === 'success') {
    return [{ type: 'refund.succeeded', eventId: `payu:refund:${requestId}:success`, gatewayPaymentId: String(r.mihpayid).trim(), gatewayRefundId: requestId, amount: toPaise(r.amt), currency: 'INR' }];
  }
  if (status === 'failure' || status === 'failed') {
    return [{ type: 'refund.failed', eventId: `payu:refund:${requestId}:failure`, gatewayRefundId: requestId, failureMessage: String(r.remark || r.message || 'PayU could not process the refund') }];
  }
  return [{ type: 'ignored', eventId: `payu:refund:${requestId}:${status || 'pending'}`, reason: `refund ${status || 'pending'}` }];
}

function parseBody(req) {
  const raw = req.rawBody ?? '';
  if (String(header(req.headers, 'content-type') ?? '').includes('json') || raw.trimStart().startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function page(title, content) {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#5d6470;--border:#d5d9e0}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--card:#171a1f;--fg:#eceef2;--muted:#9aa1ad;--border:#2a2f37}}
body{margin:0;padding:32px 16px;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:380px;margin:0 auto;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
h1{font-size:22px;margin:0}.muted{color:var(--muted)}label{display:block;font-weight:600;margin:16px 0 4px}
input{box-sizing:border-box;width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font:inherit;font-weight:600;cursor:pointer}
</style></head><body><main>${content}</main></body></html>`,
  };
}

const hidden = (fields) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');

export async function activate(ctx) {
  // Checkout pages carry their form (it includes the customer's name and e-mail) encrypted in
  // the URL, so no per-checkout storage is needed and nothing personal reaches access logs.
  let stored = await ctx.kv.get('page_key');
  if (!stored) {
    stored = randomBytes(32).toString('base64');
    await ctx.kv.set('page_key', stored);
  }
  const pageKey = Buffer.from(stored, 'base64');
  const seal = (data) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', pageKey, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
  };
  const unseal = (token) => {
    try {
      const buf = Buffer.from(String(token), 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', pageKey, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  };
  const routeBase = (gctx) => `${gctx.appUrl}/api/plugins/${ctx.plugin.id}`;

  await ctx.gateways.register({
    key: 'payu',
    name: 'PayU',
    description: 'UPI, cards, netbanking and wallets for India through PayU Hosted Checkout.',
    capabilities: {
      checkout: true,
      savePaymentMethod: false,
      offSessionCharge: false,
      refunds: true,
      partialRefunds: true,
      webhooks: true,
      currencies: ['INR'],
      paymentMethods: ['upi', 'card', 'netbanking', 'wallet', 'emi', 'paylater'],
    },
    secretFields: [
      { key: 'merchant_key', label: 'Merchant key', required: true, help: 'PayU Dashboard > Developers > API keys. Test mode and live mode have different keys.' },
      { key: 'merchant_salt', label: 'Merchant salt', required: true, help: 'The salt shown with the merchant key. It signs checkout forms and verifies PayU’s responses; it never reaches the browser.' },
    ],

    async testConnection(gctx) {
      try {
        const res = await command(gctx, 'verify_payment', `stwtest${Date.now()}`);
        if (res?.transaction_details) return { ok: true, message: `Connected to PayU (${gctx.mode})` };
        return { ok: false, message: res?.msg ?? 'PayU rejected the merchant key or salt' };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    },

    async createCheckout(gctx, req) {
      if (req.currency.toUpperCase() !== 'INR') throw new Error('PayU hosted checkout accepts INR only');
      const txnid = `stw${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
      const fields = {
        key: gctx.secrets.merchant_key,
        txnid,
        amount: rupees(req.amount),
        productinfo: clean(req.description, 100) || 'Payment',
        firstname: clean(req.customer.name, gctx.mode === 'test' ? 20 : 60) || 'Customer',
        email: clean(req.customer.email, 254),
        surl: `${routeBase(gctx)}/return`,
        furl: `${routeBase(gctx)}/return`,
        udf1: req.checkoutId,
        udf2: gctx.gatewayId,
      };
      fields.hash = requestHash(fields, gctx.secrets.merchant_salt);
      const token = seal({ mode: gctx.mode, exp: Date.now() + PAGE_TTL_MS, fields });
      return { url: `${routeBase(gctx)}/pay?t=${token}`, gatewaySessionId: txnid };
    },

    async refund(gctx, req) {
      try {
        const res = await command(gctx, 'cancel_refund_transaction', req.gatewayPaymentId, {
          var2: req.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(-23),
          var3: rupees(req.amount),
          var5: gctx.webhookUrl,
        });
        if (Number(res.status) !== 1 || !res.request_id) return { status: 'failed', failureMessage: res.msg ?? 'PayU refused the refund' };
        return { status: 'pending', gatewayRefundId: String(res.request_id) };
      } catch (err) {
        return { status: 'failed', failureMessage: err.message };
      }
    },

    async parseWebhook(gctx, req) {
      const f = parseBody(req);
      if (String(f.action ?? '').toLowerCase() === 'refund' && ID.test(String(f.request_id ?? ''))) return refundEvents(gctx, String(f.request_id));
      // Dispute notifications are only signed when PayU enables it per account, so they are not processed.
      if (f.event === 'dispute' || f.cb_id) return [];
      if (!f.hash || !responseHashes(f, gctx.secrets.merchant_salt ?? '').some((h) => safeEqual(h, f.hash))) throw signatureError('Invalid PayU hash');
      const events = paymentEvents(f, f.udf1 || null);
      return events.length ? events : [{ type: 'ignored', eventId: `payu:payment:${f.mihpayid || f.txnid}:${f.status}`, reason: `payment ${f.status}` }];
    },

    async handleReturn(gctx, query) {
      const checkoutId = query.checkout ?? null;
      const txnid = String(query.txnid ?? '');
      if (!ID.test(txnid)) return { events: [], checkoutId };
      const res = await command(gctx, 'verify_payment', txnid);
      const txn = res?.transaction_details?.[txnid];
      if (!txn || txn.status === 'Not Found') return { events: [], checkoutId };
      const fromPayu = txn.udf1 || checkoutId;
      return { checkoutId: fromPayu, events: paymentEvents(txn, fromPayu) };
    },
  });

  // Step one of the checkout: the customer adds a mobile number (not part of the hash) and the
  // browser posts the sealed, hash-signed form to PayU.
  await ctx.routes.register({
    method: 'GET',
    path: '/pay',
    handler: async (req) => {
      const data = unseal(req.query.t ?? '');
      if (!data || !CHECKOUT[data.mode]) return { status: 404, body: 'Unknown checkout' };
      if (data.exp < Date.now()) return { status: 410, body: 'This checkout link has expired. Start the payment again.' };
      return page(
        'Pay with PayU',
        `<h1>₹${esc(data.fields.amount)}</h1><p class="muted">${esc(data.fields.productinfo)}</p>
<form method="post" action="${esc(CHECKOUT[data.mode])}">${hidden(data.fields)}
<label for="phone">Mobile number</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20" pattern="\\+?[0-9 ]{8,20}">
<p class="muted" style="font-size:13px">PayU requires a mobile number for every payment.</p><button type="submit">Continue to PayU</button></form>`,
      );
    },
  });

  // PayU posts the result here (surl/furl). Nothing in the post is trusted: the customer continues
  // to Steward's return URL for this gateway, where handleReturn asks PayU for the verified status.
  await ctx.routes.register({
    method: 'POST',
    path: '/return',
    handler: async (req) => {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const fields = { checkout: String(b.udf1 ?? ''), txnid: String(b.txnid ?? '') };
      const gatewayId = String(b.udf2 ?? '');
      if (![gatewayId, fields.checkout, fields.txnid].every((v) => ID.test(v))) return { status: 400, body: 'Invalid PayU response' };
      // Relative to /api/plugins/<id>/return, so it also works when Steward is served under a path prefix.
      return page(
        'Checking your payment',
        `<form method="get" action="../../public/gateways/${esc(gatewayId)}/return">${hidden(fields)}<p>Checking your payment…</p><button type="submit">Continue</button></form><script>document.forms[0].submit()</script>`,
      );
    },
  });
}
