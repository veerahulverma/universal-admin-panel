import { z } from 'zod';
import { randomBase62 } from '../../../core/ids.js';
import type { GatewayAdapter } from './types.js';

/**
 * Offline payments (bank transfer, cash, cheque). Checkout shows payment
 * instructions; an administrator records the payment when funds arrive.
 * Refunds are recorded here and paid back outside the platform.
 */
export const manualGateway: GatewayAdapter = {
  key: 'manual',
  name: 'Manual / bank transfer',
  description: 'Customers pay offline using your instructions; administrators mark invoices as paid.',
  capabilities: {
    checkout: true,
    savePaymentMethod: false,
    offSessionCharge: false,
    refunds: true,
    partialRefunds: true,
    webhooks: false,
    currencies: '*',
    paymentMethods: ['bank_transfer', 'cash', 'check', 'other'],
  },
  configSchema: z.object({
    instructions: z.string().max(5000).default('Please transfer the amount due to our bank account and include the reference shown below.'),
    bankDetails: z.string().max(5000).default(''),
  }),
  secretFields: [],
  async testConnection() {
    return { ok: true, message: 'Manual payments need no connection' };
  },
  async createCheckout(ctx, req) {
    return { url: `${ctx.appUrl}/pay/manual/${ctx.gatewayId}/${req.checkoutId}`, gatewaySessionId: `man_${req.checkoutId}` };
  },
  async refund() {
    return { status: 'succeeded', gatewayRefundId: `man_re_${randomBase62(16)}` };
  },
  async parseWebhook() {
    throw new Error('Manual payments do not send webhooks');
  },
};
