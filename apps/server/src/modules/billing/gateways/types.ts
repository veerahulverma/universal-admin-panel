import type { ZodType } from 'zod';

/**
 * The contract every payment gateway plugin implements. Billing core only talks
 * to gateways through this interface, so adding a gateway never touches the
 * billing engine. Gateways must declare what they can do: the platform never
 * assumes refunds, saved payment methods or a given currency are available.
 */
export interface GatewayCapabilities {
  /** Hosted checkout / redirect flow for first payments. */
  checkout: boolean;
  /** Can save a payment method during checkout for later off-session charges. */
  savePaymentMethod: boolean;
  /** Can charge a saved method without the customer present (automatic renewals). */
  offSessionCharge: boolean;
  refunds: boolean;
  partialRefunds: boolean;
  webhooks: boolean;
  /** ISO currency codes, or '*' for any. */
  currencies: string[] | '*';
  paymentMethods: string[];
}

export interface SecretField {
  key: string;
  label: string;
  required: boolean;
  help?: string;
}

export interface GatewayContext {
  gatewayId: string;
  mode: 'test' | 'live';
  config: Record<string, any>;
  secrets: Record<string, string>;
  appUrl: string;
  /** Where the gateway should POST webhooks. */
  webhookUrl: string;
  /** Base for customer return/callback URLs handled by `handleReturn`. */
  returnUrl: string;
  /** HTTP client (injectable for tests). */
  fetch: typeof fetch;
  log: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
}

export interface CheckoutRequest {
  checkoutId: string;
  amount: number;
  currency: string;
  description: string;
  lineItems: { description: string; amount: number; quantity: number }[];
  customer: { id: string; email: string | null; name: string | null; gatewayCustomerRef: string | null };
  successUrl: string;
  cancelUrl: string;
  savePaymentMethod: boolean;
  metadata: Record<string, string>;
}

export interface CheckoutResult {
  url: string;
  gatewaySessionId: string;
}

export interface ChargeRequest {
  invoiceId: string;
  amount: number;
  currency: string;
  customerRef: string | null;
  paymentMethodRef: string;
  description: string;
  idempotencyKey: string;
}

export type ChargeResult =
  | { status: 'succeeded'; gatewayPaymentId: string; method?: PaymentMethodInfo; fee?: number | null }
  | { status: 'requires_action'; gatewayPaymentId: string; actionUrl?: string }
  | { status: 'failed'; gatewayPaymentId: string | null; failureCode: string; failureMessage: string };

export interface RefundRequest {
  gatewayPaymentId: string;
  amount: number;
  currency: string;
  reason: string | null;
  idempotencyKey: string;
}

export type RefundResult = { status: 'succeeded' | 'pending'; gatewayRefundId: string } | { status: 'failed'; failureMessage: string };

export interface PaymentMethodInfo {
  type: string;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
}

/** Gateway events normalized into the platform's vocabulary. */
export type GatewayEvent =
  | {
      type: 'payment.succeeded';
      eventId: string;
      checkoutId?: string | null;
      invoiceId?: string | null;
      gatewayPaymentId: string;
      amount: number;
      currency: string;
      method?: PaymentMethodInfo;
      customerRef?: string | null;
      paymentMethodRef?: string | null;
      fee?: number | null;
    }
  | {
      type: 'payment.failed';
      eventId: string;
      checkoutId?: string | null;
      invoiceId?: string | null;
      gatewayPaymentId?: string | null;
      failureCode: string;
      failureMessage: string;
    }
  | { type: 'refund.succeeded'; eventId: string; gatewayPaymentId: string; gatewayRefundId: string; amount: number; currency: string }
  | { type: 'refund.failed'; eventId: string; gatewayRefundId: string; failureMessage: string }
  | { type: 'dispute.created'; eventId: string; gatewayPaymentId: string; gatewayDisputeId: string; amount: number; currency: string; reason: string | null; evidenceDueBy?: Date | null }
  | { type: 'dispute.closed'; eventId: string; gatewayDisputeId: string; outcome: 'won' | 'lost' }
  | { type: 'ignored'; eventId: string; reason: string };

export interface WebhookRequest {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
}

export interface GatewayAdapter {
  key: string;
  name: string;
  description: string;
  capabilities: GatewayCapabilities;
  /** Non-secret configuration (shown in the admin form). */
  configSchema?: ZodType;
  secretFields: SecretField[];
  testConnection(ctx: GatewayContext): Promise<{ ok: boolean; message: string }>;
  createCheckout(ctx: GatewayContext, req: CheckoutRequest): Promise<CheckoutResult>;
  chargeSaved?(ctx: GatewayContext, req: ChargeRequest): Promise<ChargeResult>;
  refund?(ctx: GatewayContext, req: RefundRequest): Promise<RefundResult>;
  /** Verify the signature and normalize. Must throw on an invalid signature. */
  parseWebhook(ctx: GatewayContext, req: WebhookRequest): Promise<GatewayEvent[]>;
  /** Customer returning from the gateway (some gateways settle here, e.g. PayPal capture). */
  handleReturn?(ctx: GatewayContext, query: Record<string, string>): Promise<{ events: GatewayEvent[]; checkoutId: string | null }>;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
