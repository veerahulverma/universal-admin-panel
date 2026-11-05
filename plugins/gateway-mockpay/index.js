// Example payment gateway plugin. A real provider integration replaces the
// simulated parts with calls through `gctx.fetch` (inside adapter methods) to
// the provider's API, and verifies the provider's real webhook signature scheme.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('hex');

export async function activate(ctx) {
  await ctx.gateways.register({
    key: 'mockpay',
    name: 'MockPay',
    description: 'Simulated provider registered by a plugin.',
    capabilities: {
      checkout: true,
      savePaymentMethod: false,
      offSessionCharge: false,
      refunds: true,
      partialRefunds: false,
      webhooks: true,
      currencies: ['USD', 'EUR'],
      paymentMethods: ['card'],
    },
    secretFields: [{ key: 'signing_secret', label: 'Signing secret', required: true }],

    async testConnection(gctx) {
      return gctx.secrets.signing_secret ? { ok: true, message: 'MockPay configured' } : { ok: false, message: 'Missing signing secret' };
    },

    async createCheckout(gctx, req) {
      const session = `mp_${randomUUID()}`;
      await ctx.kv.set(session, { checkoutId: req.checkoutId, amount: req.amount, currency: req.currency, gatewayId: gctx.gatewayId });
      return { url: `${gctx.appUrl}/api/plugins/gateway-mockpay/pay?session=${session}`, gatewaySessionId: session };
    },

    async refund(_gctx, req) {
      return req.amount > 0 ? { status: 'succeeded', gatewayRefundId: `mp_re_${randomUUID()}` } : { status: 'failed', failureMessage: 'Invalid amount' };
    },

    async parseWebhook(gctx, req) {
      const signature = req.headers['x-mockpay-signature'];
      const expected = sign(gctx.secrets.signing_secret ?? '', req.rawBody);
      if (typeof signature !== 'string' || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        const err = new Error('Invalid MockPay signature');
        err.name = 'WebhookSignatureError';
        throw err;
      }
      const body = JSON.parse(req.rawBody);
      return [
        {
          type: 'payment.succeeded',
          eventId: body.id,
          checkoutId: body.checkoutId,
          gatewayPaymentId: body.paymentId,
          amount: body.amount,
          currency: body.currency,
          method: { type: 'card', brand: 'mock', last4: '0000' },
        },
      ];
    },
  });

  await ctx.routes.register({
    method: 'GET',
    path: '/pay',
    handler: async (req) => {
      const s = await ctx.kv.get(String(req.query.session ?? ''));
      if (!s) return { status: 404, body: 'Unknown session' };
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><meta charset="utf-8"><title>MockPay</title><body style="font:15px system-ui;padding:32px">
          <h1>MockPay</h1><p>Amount: ${(s.amount / 100).toFixed(2)} ${s.currency}</p>
          <p>This page simulates a provider's hosted checkout. A real plugin would redirect to the provider.</p></body>`,
      };
    },
  });
}
