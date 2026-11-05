// Paddle Billing gateway plugin. Paddle is the merchant of record: the customer pays
// on Paddle Checkout (opened by Paddle.js on the account's default payment link page)
// and Paddle reports the result through signed webhooks. Steward stays the source of
// truth for invoices and renewals, so every checkout is a one-off transaction with a
// non-catalog price; Paddle subscriptions are not used, and Paddle offers no way to
// charge a saved payment method off-session outside them.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = { live: 'https://api.paddle.com', test: 'https://sandbox-api.paddle.com' };
// Paddle's SDKs allow 5 seconds; a wider window tolerates clock drift, and event ids dedupe replays.
const SIGNATURE_TOLERANCE_SEC = 300;
const REQUIRED_PERMISSIONS = ['transaction.write', 'adjustment.write'];

const header = (headers, name) => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const signatureError = (message) => Object.assign(new Error(message), { name: 'WebhookSignatureError' });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Paddle-Signature: ts=<unix seconds>;h1=<hex HMAC-SHA256 of "<ts>:<raw body>">`, with more h1 values while a secret rotates. */
function verifySignature(rawBody, signature, secret, nowSec) {
  if (!signature || !secret) return false;
  const parts = signature.split(';').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
  const ts = Number(parts.find(([k]) => k === 'ts')?.[1]);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  return parts.some(([k, v]) => k === 'h1' && safeEqual(v, expected));
}

async function paddle(gctx, method, path, body) {
  const res = await gctx.fetch(`${API[gctx.mode]}${path}`, {
    method,
    headers: { authorization: `Bearer ${gctx.secrets.api_key}`, 'content-type': 'application/json', 'paddle-version': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json?.error?.detail ?? `Paddle error ${res.status}`);
  return json.data;
}

// Paddle amounts are integer strings in the minor unit. A missing or malformed amount becomes 0,
// which billing core reports as an amount mismatch instead of fulfilling the checkout.
const minor = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
};

function methodOf(payment) {
  const m = payment?.method_details;
  if (!m) return undefined;
  return { type: m.type, brand: m.card?.type ?? null, last4: m.card?.last4 ?? null };
}

export async function activate(ctx) {
  await ctx.gateways.register({
    key: 'paddle',
    name: 'Paddle',
    description: 'Paddle Billing as merchant of record: cards, PayPal, wallets and local methods on Paddle Checkout, with sales tax handled by Paddle.',
    capabilities: {
      checkout: true,
      savePaymentMethod: false,
      offSessionCharge: false,
      refunds: true,
      partialRefunds: true,
      webhooks: true,
      currencies: ['USD', 'EUR', 'GBP', 'ARS', 'AUD', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK', 'HKD', 'HUF', 'ILS', 'INR', 'JPY', 'KRW', 'MXN', 'NOK', 'NZD', 'PEN', 'PLN', 'RUB', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'VND', 'ZAR'],
      paymentMethods: ['card', 'paypal', 'apple_pay', 'google_pay', 'ideal', 'bancontact', 'blik', 'mb_way', 'alipay', 'wechat_pay', 'kakao_pay', 'naver_pay', 'samsung_pay', 'payco', 'south_korea_local_card'],
    },
    secretFields: [
      {
        key: 'api_key',
        label: 'API key',
        required: true,
        help: 'Paddle > Developer tools > Authentication, with the transaction.write and adjustment.write permissions. Sandbox keys (pdl_sdbx_apikey_...) work in test mode only, live keys in live mode only.',
      },
      {
        key: 'webhook_secret',
        label: 'Webhook secret key',
        required: true,
        help: 'The secret key (pdl_ntfset_...) of a notification destination that sends transaction.completed, transaction.payment_failed, adjustment.created and adjustment.updated to this gateway’s webhook URL.',
      },
    ],

    async testConnection(gctx) {
      try {
        const root = await paddle(gctx, 'GET', '/');
        if (!root?.caller?.account) return { ok: false, message: 'Paddle did not accept the API key' };
        // Legacy keys (created before May 2025) have no permission list and can do everything.
        const granted = root.caller.permissions ?? [];
        const missing = granted.length ? REQUIRED_PERMISSIONS.filter((p) => !granted.includes(p)) : [];
        if (missing.length) return { ok: false, message: `The API key is missing these permissions: ${missing.join(', ')}` };
        return { ok: true, message: `Connected to Paddle (${root.api?.environment ?? gctx.mode}) as ${root.caller.account.name}` };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    },

    async createCheckout(gctx, req) {
      const name = req.description.trim().slice(0, 150) || 'Payment';
      // Opens on the default payment link (Paddle > Checkout > Checkout settings), a page on an
      // approved domain that loads Paddle.js; Paddle.js opens the checkout from the _ptxn parameter.
      const txn = await paddle(gctx, 'POST', '/transactions', {
        items: [
          {
            quantity: 1,
            price: {
              description: `Steward checkout ${req.checkoutId}`,
              name,
              // Steward's totals already include tax, so Paddle takes its tax out of this amount.
              tax_mode: 'internal',
              unit_price: { amount: String(req.amount), currency_code: req.currency },
              // Without this the customer could change the quantity in the overlay checkout.
              quantity: { minimum: 1, maximum: 1 },
              product: { name, tax_category: 'standard' },
            },
          },
        ],
        currency_code: req.currency,
        collection_mode: 'automatic',
        custom_data: { ...req.metadata, checkout_id: req.checkoutId },
      });
      if (!txn?.checkout?.url) throw new Error('Paddle returned no checkout URL: set a default payment link in Paddle > Checkout > Checkout settings');
      return { url: txn.checkout.url, gatewaySessionId: txn.id };
    },

    async refund(gctx, req) {
      try {
        const txn = await paddle(gctx, 'GET', `/transactions/${encodeURIComponent(req.gatewayPaymentId)}`);
        const full = req.amount >= Number(txn.details?.totals?.grand_total);
        const item = txn.details?.line_items?.[0];
        if (!full && !item) return { status: 'failed', failureMessage: 'The Paddle transaction has no line item to refund against' };
        // Partial amounts are tax-inclusive, matching the tax-inclusive price the checkout used.
        const adj = await paddle(gctx, 'POST', '/adjustments', {
          action: 'refund',
          transaction_id: req.gatewayPaymentId,
          reason: req.reason || 'Refund requested by the merchant',
          ...(full ? { type: 'full' } : { type: 'partial', items: [{ item_id: item.id, type: 'partial', amount: String(req.amount) }] }),
        });
        if (adj.status === 'rejected') return { status: 'failed', failureMessage: 'Paddle rejected the refund' };
        return { status: adj.status === 'approved' ? 'succeeded' : 'pending', gatewayRefundId: adj.id };
      } catch (err) {
        return { status: 'failed', failureMessage: err.message };
      }
    },

    async parseWebhook(gctx, req) {
      if (!verifySignature(req.rawBody, header(req.headers, 'paddle-signature'), gctx.secrets.webhook_secret, Math.floor(Date.now() / 1000))) {
        throw signatureError('Invalid Paddle signature');
      }
      const evt = JSON.parse(req.rawBody);
      const d = evt.data ?? {};
      const eventId = evt.event_id;
      switch (evt.event_type) {
        case 'transaction.completed': {
          const totals = d.details?.totals ?? {};
          const payment = (d.payments ?? []).find((p) => p.status === 'captured') ?? d.payments?.[0];
          return [
            {
              type: 'payment.succeeded',
              eventId,
              checkoutId: d.custom_data?.checkout_id ?? null,
              gatewayPaymentId: d.id,
              amount: minor(totals.grand_total),
              currency: d.currency_code,
              method: methodOf(payment),
              customerRef: d.customer_id ?? null,
              fee: totals.fee == null ? null : minor(totals.fee),
            },
          ];
        }
        case 'transaction.payment_failed': {
          // payments[] is newest first: the attempt that just failed.
          const code = d.payments?.[0]?.error_code ?? 'payment_failed';
          return [{ type: 'payment.failed', eventId, checkoutId: d.custom_data?.checkout_id ?? null, gatewayPaymentId: d.id, failureCode: code, failureMessage: `Paddle payment failed (${code})` }];
        }
        case 'adjustment.created':
        case 'adjustment.updated':
          switch (d.action) {
            case 'refund':
              if (d.status === 'approved') {
                return [{ type: 'refund.succeeded', eventId, gatewayPaymentId: d.transaction_id, gatewayRefundId: d.id, amount: minor(d.totals?.total), currency: d.currency_code }];
              }
              if (d.status === 'rejected') return [{ type: 'refund.failed', eventId, gatewayRefundId: d.id, failureMessage: 'Paddle rejected the refund' }];
              return [{ type: 'ignored', eventId, reason: `refund ${d.status}` }];
            // Paddle settles chargebacks itself. A transaction is charged back once, and the reversal
            // only names the transaction, so the transaction id identifies the dispute.
            case 'chargeback':
              return [{ type: 'dispute.created', eventId, gatewayPaymentId: d.transaction_id, gatewayDisputeId: d.transaction_id, amount: minor(d.totals?.total), currency: d.currency_code, reason: d.reason ?? null }];
            case 'chargeback_reverse':
              return [{ type: 'dispute.closed', eventId, gatewayDisputeId: d.transaction_id, outcome: 'won' }];
            default:
              return [{ type: 'ignored', eventId, reason: `adjustment action ${d.action}` }];
          }
        default:
          return [{ type: 'ignored', eventId, reason: `unhandled ${evt.event_type}` }];
      }
    },
  });
}
