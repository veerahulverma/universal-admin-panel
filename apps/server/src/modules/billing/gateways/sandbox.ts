import { z } from 'zod';
import { hmacSha256, safeEqual } from '../../../core/crypto.js';
import { randomBase62 } from '../../../core/ids.js';
import { header, WebhookSignatureError, type GatewayAdapter, type GatewayEvent } from './types.js';

export const SANDBOX_DECLINE_METHOD = 'pm_sandbox_declined';

/** Build a signed sandbox webhook (used by the hosted test checkout and by tests). */
export function signSandboxEvent(secret: string, event: GatewayEvent): { body: string; signature: string } {
  const body = JSON.stringify({ event });
  return { body, signature: hmacSha256(secret, body) };
}

/**
 * Simulated gateway: hosted test checkout, saved methods, off-session charges,
 * refunds and signed webhooks, without moving money. Use it to exercise every
 * billing flow before connecting a real gateway.
 */
export const sandboxGateway: GatewayAdapter = {
  key: 'sandbox',
  name: 'Sandbox',
  description: 'Simulated payments for development and testing. Never moves real money.',
  capabilities: {
    checkout: true,
    savePaymentMethod: true,
    offSessionCharge: true,
    refunds: true,
    partialRefunds: true,
    webhooks: true,
    currencies: '*',
    paymentMethods: ['card'],
  },
  configSchema: z.object({ feePercent: z.number().min(0).max(20).default(2.9) }),
  secretFields: [{ key: 'webhook_secret', label: 'Webhook signing secret', required: true, help: 'Any random string; used to sign simulated webhooks.' }],
  async testConnection(ctx) {
    return ctx.secrets.webhook_secret ? { ok: true, message: 'Sandbox ready' } : { ok: false, message: 'Set a webhook signing secret' };
  },
  async createCheckout(ctx, req) {
    return { url: `${ctx.appUrl}/pay/sandbox/${ctx.gatewayId}/${req.checkoutId}`, gatewaySessionId: `sbx_cs_${req.checkoutId}` };
  },
  async chargeSaved(ctx, req) {
    // Any token starting with the decline marker simulates a card that stopped working.
    if (req.paymentMethodRef.startsWith(SANDBOX_DECLINE_METHOD)) {
      return { status: 'failed', gatewayPaymentId: `sbx_pi_${randomBase62(16)}`, failureCode: 'card_declined', failureMessage: 'Your card was declined (sandbox)' };
    }
    const fee = Math.round((req.amount * Number(ctx.config.feePercent ?? 2.9)) / 100);
    return { status: 'succeeded', gatewayPaymentId: `sbx_pi_${randomBase62(16)}`, method: { type: 'card', brand: 'visa', last4: '4242' }, fee };
  },
  async refund() {
    return { status: 'succeeded', gatewayRefundId: `sbx_re_${randomBase62(16)}` };
  },
  async parseWebhook(ctx, req) {
    const sig = header(req.headers, 'x-sandbox-signature');
    if (!sig || !ctx.secrets.webhook_secret || !safeEqual(sig, hmacSha256(ctx.secrets.webhook_secret, req.rawBody))) throw new WebhookSignatureError();
    const parsed = JSON.parse(req.rawBody) as { event: GatewayEvent };
    return [parsed.event];
  },
};
