// Cashfree Payments gateway plugin (India). Each checkout is a Cashfree Payment Link: a
// Cashfree-hosted page the customer is redirected to, so neither Cashfree's JS SDK nor
// domain whitelisting is needed. Cashfree creates an order for the payment made on a
// link; refunds and webhooks refer to that order, so its id is the payment id Steward
// records. The link id is Steward's checkout id, which comes back in the order's tags.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = { live: 'https://api.cashfree.com/pg', test: 'https://sandbox.cashfree.com/pg' };
const API_VERSION = '2025-01-01';
// Cashfree requires a customer phone number and Steward does not collect one. Cashfree's API
// reference allows dummy customer details; link notifications are off, so nothing is sent to it.
const PLACEHOLDER_PHONE = '9999999999';
const ID = /^[A-Za-z0-9_-]{3,50}$/;
const GROUP = {
  credit_card: 'card',
  debit_card: 'card',
  prepaid_card: 'card',
  upi: 'upi',
  upi_credit_card: 'upi',
  upi_ppi: 'upi',
  upi_ppi_offline: 'upi',
  sbc_upi: 'upi',
  net_banking: 'netbanking',
  wallet: 'wallet',
  pay_later: 'paylater',
  cardless_emi: 'emi',
  credit_card_emi: 'emi',
  debit_card_emi: 'emi',
  bank_transfer: 'bank_transfer',
  paypal: 'paypal',
};
// Minor-unit exponents that differ from 2 (same table as Steward's billing core).
const DECIMALS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};
const decimals = (currency) => DECIMALS[String(currency).toUpperCase()] ?? 2;
const toMajor = (minor, currency) => minor / 10 ** decimals(currency);
// A missing or malformed amount becomes 0, which billing core reports as an amount mismatch instead of fulfilling.
const toMinor = (major, currency) => {
  const n = Math.round(Number(major) * 10 ** decimals(currency));
  return Number.isFinite(n) ? n : 0;
};

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

class CashfreeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function cashfree(gctx, method, path, body) {
  const res = await gctx.fetch(`${API[gctx.mode]}${path}`, {
    method,
    headers: {
      'x-client-id': gctx.secrets.client_id,
      'x-client-secret': gctx.secrets.client_secret,
      'x-api-version': API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new CashfreeError(res.status, json?.message ?? `Cashfree error ${res.status}`);
  return json;
}

function methodOf(payment) {
  const card = payment.payment_method?.card;
  return { type: GROUP[payment.payment_group] ?? payment.payment_group ?? 'unknown', brand: card?.card_network ?? null, last4: card?.card_number ? String(card.card_number).slice(-4) : null };
}

function paymentSucceeded(orderId, payment, checkoutId) {
  return {
    type: 'payment.succeeded',
    eventId: `cashfree:payment:${payment.cf_payment_id}:SUCCESS`,
    checkoutId,
    gatewayPaymentId: orderId,
    amount: toMinor(payment.payment_amount, payment.payment_currency),
    currency: payment.payment_currency,
    method: methodOf(payment),
  };
}

export async function activate(ctx) {
  await ctx.gateways.register({
    key: 'cashfree',
    name: 'Cashfree',
    description: 'UPI, cards, netbanking and wallets for India through Cashfree Payment Links.',
    capabilities: {
      checkout: true,
      savePaymentMethod: false,
      offSessionCharge: false,
      refunds: true,
      partialRefunds: true,
      webhooks: true,
      currencies: ['INR'],
      paymentMethods: ['upi', 'card', 'netbanking', 'wallet', 'paylater', 'emi'],
    },
    secretFields: [
      { key: 'client_id', label: 'App ID (client ID)', required: true, help: 'Cashfree Merchant Dashboard > Developers > API keys. Test and production keys differ.' },
      { key: 'client_secret', label: 'Secret key (client secret)', required: true, help: 'Also verifies webhook signatures: Cashfree signs webhooks with this key.' },
    ],

    async testConnection(gctx) {
      const connected = { ok: true, message: `Connected to Cashfree (${gctx.mode === 'live' ? 'production' : 'sandbox'})` };
      try {
        await cashfree(gctx, 'GET', '/orders/steward_connection_test');
        return connected;
      } catch (err) {
        // An unknown order means the keys were accepted; bad keys get a 401.
        return err.status === 404 ? connected : { ok: false, message: err.message };
      }
    },

    async createCheckout(gctx, req) {
      const link = await cashfree(gctx, 'POST', '/links', {
        link_id: req.checkoutId,
        link_amount: toMajor(req.amount, req.currency),
        link_currency: req.currency,
        link_purpose: req.description.trim().slice(0, 500) || 'Payment',
        customer_details: {
          customer_phone: PLACEHOLDER_PHONE,
          ...(req.customer.email ? { customer_email: req.customer.email } : {}),
          ...(req.customer.name ? { customer_name: req.customer.name.slice(0, 100) } : {}),
        },
        link_notify: { send_sms: false, send_email: false },
        link_meta: { return_url: `${gctx.returnUrl}?checkout=${encodeURIComponent(req.checkoutId)}` },
        link_notes: { checkout_id: req.checkoutId },
      });
      return { url: link.link_url, gatewaySessionId: link.link_id ?? req.checkoutId };
    },

    async refund(gctx, req) {
      try {
        const note = String(req.reason ?? '').trim().slice(0, 100);
        const r = await cashfree(gctx, 'POST', `/orders/${encodeURIComponent(req.gatewayPaymentId)}/refunds`, {
          refund_amount: toMajor(req.amount, req.currency),
          refund_id: req.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
          ...(note.length >= 3 ? { refund_note: note } : {}),
        });
        const status = String(r.refund_status ?? '').toUpperCase();
        if (status === 'CANCELLED' || status === 'REJECTED') return { status: 'failed', failureMessage: r.status_description ?? `Refund ${status.toLowerCase()}` };
        return { status: status === 'SUCCESS' ? 'succeeded' : 'pending', gatewayRefundId: String(r.cf_refund_id) };
      } catch (err) {
        return { status: 'failed', failureMessage: err.message };
      }
    },

    async parseWebhook(gctx, req) {
      // x-webhook-signature = Base64(HMAC-SHA256(client secret, x-webhook-timestamp + raw body)).
      const signature = header(req.headers, 'x-webhook-signature');
      const timestamp = header(req.headers, 'x-webhook-timestamp');
      const secret = gctx.secrets.client_secret;
      if (!signature || !timestamp || !secret || !safeEqual(signature, createHmac('sha256', secret).update(`${timestamp}${req.rawBody}`).digest('base64'))) {
        throw signatureError('Invalid Cashfree signature');
      }
      const evt = JSON.parse(req.rawBody);
      const d = evt.data ?? {};
      const order = d.order ?? {};
      const payment = d.payment ?? {};
      const checkoutId = order.order_tags?.link_id ?? null;
      switch (evt.type) {
        case 'PAYMENT_SUCCESS_WEBHOOK':
          return [paymentSucceeded(order.order_id, payment, checkoutId)];
        case 'PAYMENT_FAILED_WEBHOOK':
          return [
            {
              type: 'payment.failed',
              eventId: `cashfree:payment:${payment.cf_payment_id}:FAILED`,
              checkoutId,
              gatewayPaymentId: order.order_id ?? null,
              failureCode: d.error_details?.error_code ?? 'payment_failed',
              failureMessage: d.error_details?.error_description ?? payment.payment_message ?? 'Payment failed',
            },
          ];
        case 'PAYMENT_USER_DROPPED_WEBHOOK':
          return [{ type: 'ignored', eventId: `cashfree:payment:${payment.cf_payment_id}:USER_DROPPED`, reason: 'customer left the payment page' }];
        case 'REFUND_STATUS_WEBHOOK':
        case 'REFUND_SUCCESS_WEBHOOK': {
          const r = d.refund ?? {};
          const status = String(r.refund_status ?? '').toUpperCase();
          const eventId = `cashfree:refund:${r.cf_refund_id}:${status}`;
          if (status === 'SUCCESS') {
            return [{ type: 'refund.succeeded', eventId, gatewayPaymentId: r.order_id, gatewayRefundId: String(r.cf_refund_id), amount: toMinor(r.refund_amount, r.refund_currency), currency: r.refund_currency }];
          }
          if (status === 'CANCELLED' || status === 'REJECTED') {
            return [{ type: 'refund.failed', eventId, gatewayRefundId: String(r.cf_refund_id), failureMessage: r.status_description ?? `Refund ${status.toLowerCase()}` }];
          }
          return [{ type: 'ignored', eventId, reason: `refund ${status.toLowerCase() || 'pending'}` }];
        }
        case 'DISPUTE_CREATED': {
          const dispute = d.dispute ?? {};
          const orderDetails = d.order_details ?? {};
          const currency = dispute.dispute_amount_currency ?? orderDetails.order_currency;
          return [
            {
              type: 'dispute.created',
              eventId: `cashfree:dispute:${dispute.dispute_id}:${dispute.dispute_status}`,
              gatewayPaymentId: orderDetails.order_id,
              gatewayDisputeId: String(dispute.dispute_id),
              amount: toMinor(dispute.dispute_amount, currency),
              currency,
              reason: dispute.reason_description ?? dispute.reason_code ?? null,
              evidenceDueBy: dispute.respond_by ? new Date(dispute.respond_by) : null,
            },
          ];
        }
        case 'DISPUTE_CLOSED': {
          const dispute = d.dispute ?? {};
          // CHARGEBACK_MERCHANT_WON, CHARGEBACK_REVERSAL, ... are wins; _MERCHANT_LOST, _MERCHANT_ACCEPTED and _INSUFFICIENT_EVIDENCE are losses.
          const won = /_MERCHANT_WON$|_REVERSAL$/.test(String(dispute.dispute_status));
          return [{ type: 'dispute.closed', eventId: `cashfree:dispute:${dispute.dispute_id}:${dispute.dispute_status}`, gatewayDisputeId: String(dispute.dispute_id), outcome: won ? 'won' : 'lost' }];
        }
        default:
          return [{ type: 'ignored', eventId: header(req.headers, 'x-idempotency-key') ?? `cashfree:${evt.type}:${timestamp}`, reason: `unhandled ${evt.type}` }];
      }
    },

    async handleReturn(gctx, query) {
      const checkoutId = query.checkout ?? null;
      if (!checkoutId || !ID.test(checkoutId)) return { events: [], checkoutId };
      // The return is only a hint: ask Cashfree which order on this link was paid.
      const orders = await cashfree(gctx, 'GET', `/links/${encodeURIComponent(checkoutId)}/orders?status=PAID`);
      const order = (Array.isArray(orders) ? orders : []).find((o) => o.order_status === 'PAID');
      if (!order) return { events: [], checkoutId };
      const payments = await cashfree(gctx, 'GET', `/orders/${encodeURIComponent(order.order_id)}/payments`);
      const payment = (Array.isArray(payments) ? payments : []).find((p) => p.payment_status === 'SUCCESS');
      return { checkoutId, events: payment ? [paymentSucceeded(order.order_id, payment, checkoutId)] : [] };
    },
  });
}
