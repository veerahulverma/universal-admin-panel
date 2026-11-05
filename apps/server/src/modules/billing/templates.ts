import type { TemplateDefinition } from '../email/templates.js';

/** Emails the billing module sends itself; registered with the email module so administrators can edit them. */
export const BILLING_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'billing.card_expiring',
    name: 'Card expiring soon',
    description: 'Sent before a saved card that pays a subscription expires, so the customer can update it.',
    category: 'billing',
    subject: 'Your {{brand}} card ending in {{last4}} expires soon',
    html: `<p>Hello,</p><p>Your {{brand}} card ending in <strong>{{last4}}</strong> expires at the end of <strong>{{expiry}}</strong>. It pays for {{subscriptions}}.</p><p>Please add a new card before then so your subscription continues without interruption.</p><p style="margin:28px 0"><a href="{{appUrl}}" style="background:{{brandColor}};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">Update payment method</a></p>`,
    text: `Your {{brand}} card ending in {{last4}} expires at the end of {{expiry}}. It pays for {{subscriptions}}.\n\nPlease add a new card before then so your subscription continues without interruption: {{appUrl}}`,
    variables: ['brand', 'last4', 'expiry', 'subscriptions'],
    sampleData: { brand: 'Visa', last4: '4242', expiry: '06/2026', subscriptions: 'Pro' },
  },
];
