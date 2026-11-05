import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { escapeHtml, renderTemplate } from '../../core/template.js';
import type { EmailSettings } from './settings.js';

export type EmailCategory = 'transactional' | 'security' | 'billing' | 'marketing';

export interface TemplateDefinition {
  key: string;
  locale?: string;
  name: string;
  description: string;
  category: EmailCategory;
  subject: string;
  html: string;
  text?: string;
  variables: string[];
  sampleData: Record<string, unknown>;
}

const button = (urlVar: string, label: string) =>
  `<p style="margin:28px 0"><a href="{{${urlVar}}}" style="background:{{brandColor}};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">${label}</a></p>`;
const small = (html: string) => `<p style="color:#6b7280;font-size:13px">${html}</p>`;

/** Default copy for every email the platform sends. Administrators can edit any of them. */
export const SYSTEM_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'admin.invitation',
    name: 'Admin invitation',
    description: 'Sent when someone is invited to the admin team.',
    category: 'security',
    subject: '{{inviterName}} invited you to {{appName}}',
    html: `<h1 style="font-size:20px">You're invited</h1><p><strong>{{inviterName}}</strong> invited you to join the {{appName}} admin team.</p>${button('link', 'Accept invitation')}${small('This invitation expires in 7 days. If you were not expecting it, you can ignore this email.')}`,
    variables: ['inviterName', 'link'],
    sampleData: { inviterName: 'Ada Lovelace', link: 'https://admin.example.com/accept-invite?token=example' },
  },
  {
    key: 'admin.password_reset',
    name: 'Admin password reset',
    description: 'Password reset link for administrators.',
    category: 'security',
    subject: 'Reset your {{appName}} admin password',
    html: `<p>Hi {{name}},</p><p>Someone (hopefully you) asked to reset the password for your admin account.</p>${button('link', 'Choose a new password')}${small('The link expires in 1 hour. If you did not ask for this, ignore this email; your password stays the same.')}`,
    variables: ['name', 'link'],
    sampleData: { name: 'Ada', link: 'https://admin.example.com/reset-password?token=example' },
  },
  {
    key: 'privacy.export_ready',
    name: 'Data export ready',
    description: 'Confirms a personal data export request was fulfilled.',
    category: 'security',
    subject: 'Your {{appName}} data export is ready',
    html: `<p>Hello,</p><p>We have prepared the copy of your personal data you requested (reference <strong>{{requestId}}</strong>).</p><p>Reply to this email or contact {{supportEmail}} to receive it securely.</p>`,
    variables: ['requestId'],
    sampleData: { requestId: 'prq_example' },
  },
  {
    key: 'organization.invitation',
    name: 'Organization invitation',
    description: 'Invitation to join an organization or workspace.',
    category: 'transactional',
    subject: "You're invited to join {{orgName}} on {{appName}}",
    html: `<p>Hello,</p><p>You have been invited to join <strong>{{orgName}}</strong> as <strong>{{role}}</strong>.</p><p>Your invitation code:</p><p style="font-family:monospace;font-size:15px;background:#f3f4f6;padding:10px 14px;border-radius:6px;word-break:break-all">{{token}}</p>${button('appUrl', 'Open {{appName}}')}`,
    variables: ['orgName', 'role', 'token'],
    sampleData: { orgName: 'Acme Inc.', role: 'member', token: 'inv_example' },
  },
  {
    key: 'billing.invoice',
    name: 'Invoice issued',
    description: 'A new invoice is due.',
    category: 'billing',
    subject: 'Invoice {{number}} from {{appName}}',
    html: `<p>Hello,</p><p>Invoice <strong>{{number}}</strong> for <strong>{{amount}}</strong> is due{{#if dueDate}} on {{dueDate}}{{/if}}.</p>${button('payUrl', 'Pay invoice')}`,
    variables: ['number', 'amount', 'dueDate', 'payUrl'],
    sampleData: { number: 'INV-2026-000042', amount: '$49.00', dueDate: '2026-06-01', payUrl: 'https://admin.example.com/pay/invoice/inv_example' },
  },
  {
    key: 'billing.receipt',
    name: 'Payment receipt',
    description: 'Sent after a successful payment.',
    category: 'billing',
    subject: 'Receipt for invoice {{number}}',
    html: `<p>Thank you for your payment.</p><table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0"><tr><td style="padding:6px 0;color:#6b7280">Invoice</td><td style="text-align:right">{{number}}</td></tr><tr><td style="padding:6px 0;color:#6b7280">Amount paid</td><td style="text-align:right"><strong>{{amount}}</strong></td></tr><tr><td style="padding:6px 0;color:#6b7280">Date</td><td style="text-align:right">{{paidAt}}</td></tr></table>${small('Keep this email for your records.')}`,
    variables: ['number', 'amount', 'paidAt'],
    sampleData: { number: 'INV-2026-000042', amount: '$49.00', paidAt: '2026-05-01' },
  },
  {
    key: 'billing.payment_failed',
    name: 'Payment failed',
    description: 'A renewal payment failed (dunning).',
    category: 'billing',
    subject: 'Action needed: payment for invoice {{number}} failed',
    html: `<p>Hello,</p><p>We could not collect <strong>{{amount}}</strong> for invoice {{number}}{{#if reason}} ({{reason}}){{/if}}.</p><p>Please update your payment method or pay the invoice to keep your subscription active.{{#if nextAttemptAt}} We will retry automatically on {{nextAttemptAt}}.{{/if}}</p>${button('payUrl', 'Pay now')}`,
    variables: ['number', 'amount', 'payUrl', 'nextAttemptAt', 'reason'],
    sampleData: { number: 'INV-2026-000042', amount: '$49.00', payUrl: 'https://admin.example.com/pay/invoice/inv_example', nextAttemptAt: '2026-05-04', reason: 'card declined' },
  },
  {
    key: 'subscription.trial_will_end',
    name: 'Trial ending soon',
    description: 'Reminder a few days before a trial ends.',
    category: 'billing',
    subject: 'Your {{productName}} trial ends on {{trialEnd}}',
    html: `<p>Hello,</p><p>Your free trial of <strong>{{productName}}</strong> ends on <strong>{{trialEnd}}</strong>.</p><p>To keep access without interruption, make sure your billing details are up to date.</p>${button('appUrl', 'Manage subscription')}`,
    variables: ['productName', 'trialEnd'],
    sampleData: { productName: 'Pro', trialEnd: '2026-05-15' },
  },
  {
    key: 'subscription.canceled',
    name: 'Subscription ended',
    description: 'Confirms a subscription has ended.',
    category: 'billing',
    subject: 'Your {{productName}} subscription has ended',
    html: `<p>Hello,</p><p>Your <strong>{{productName}}</strong> subscription ended on {{endedAt}}. We're sorry to see you go.</p><p>You can resubscribe at any time.</p>${button('appUrl', 'Resubscribe')}`,
    variables: ['productName', 'endedAt'],
    sampleData: { productName: 'Pro', endedAt: '2026-05-31' },
  },
  {
    key: 'account.welcome',
    name: 'Welcome',
    description: 'Sent when someone signs up (Settings → Email: welcome email).',
    category: 'transactional',
    subject: 'Welcome to {{appName}}',
    html: `<h1 style="font-size:20px">Welcome{{#if name}}, {{name}}{{/if}}!</h1><p>Thanks for signing up for {{appName}}. Your account is ready.</p>${button('appUrl', 'Get started')}${small('Questions? Just reply to this email or write to {{supportEmail}}.')}`,
    variables: ['name'],
    sampleData: { name: 'Grace' },
  },
  {
    key: 'subscription.renewal_reminder',
    name: 'Renewal reminder',
    description: 'Sent a few days before a paid subscription renews (Settings → Email: renewal reminders).',
    category: 'billing',
    subject: 'Your {{productName}} subscription renews on {{renewsAt}}',
    html: `<p>Hello,</p><p>Your <strong>{{productName}}</strong> subscription renews automatically on <strong>{{renewsAt}}</strong>{{#if amount}} for <strong>{{amount}}</strong>{{/if}}.</p><p>Nothing to do if you'd like to continue. To change or cancel your plan, manage your subscription before that date.</p>${button('appUrl', 'Manage subscription')}`,
    variables: ['productName', 'renewsAt', 'amount'],
    sampleData: { productName: 'Pro', renewsAt: '2026-06-01', amount: '$20.00' },
  },
  {
    key: 'access.expiring',
    name: 'Access ending soon',
    description: 'Sent before access ends: the last period of a cancelled subscription or a time-limited grant (Settings → Email: expiry notices).',
    category: 'transactional',
    subject: 'Your access to {{productName}} ends on {{endsAt}}',
    html: `<p>Hello,</p><p>Your access to <strong>{{productName}}</strong> ends on <strong>{{endsAt}}</strong>.</p><p>To keep using it without interruption, renew before then.</p>${button('appUrl', 'Renew')}`,
    variables: ['productName', 'endsAt'],
    sampleData: { productName: 'Pro', endsAt: '2026-06-30' },
  },
  {
    key: 'access.expired',
    name: 'Access ended',
    description: 'Sent when time-limited access to a product has ended (subscriptions use "Subscription ended").',
    category: 'transactional',
    subject: 'Your access to {{productName}} has ended',
    html: `<p>Hello,</p><p>Your access to <strong>{{productName}}</strong> ended on {{endedAt}}.</p><p>You can get it back at any time.</p>${button('appUrl', 'Renew access')}`,
    variables: ['productName', 'endedAt'],
    sampleData: { productName: 'Pro', endedAt: '2026-06-30' },
  },
  {
    key: 'usage.limit_warning',
    name: 'Usage approaching limit',
    description: 'A quota crossed its warning threshold.',
    category: 'transactional',
    subject: "You've used {{percent}}% of your {{featureName}}",
    html: `<p>Hello,</p><p>You have used <strong>{{used}}</strong> of <strong>{{limit}}</strong> {{featureName}} ({{percent}}%){{#if resetsAt}}; usage resets on {{resetsAt}}{{/if}}.</p><p>Upgrade your plan to avoid interruptions.</p>${button('appUrl', 'View usage')}`,
    variables: ['featureName', 'used', 'limit', 'percent', 'resetsAt'],
    sampleData: { featureName: 'API calls', used: 800, limit: 1000, percent: 80, resetsAt: '2026-06-01' },
  },
  {
    key: 'usage.limit_reached',
    name: 'Usage limit reached',
    description: 'A quota was reached.',
    category: 'transactional',
    subject: "You've reached your {{featureName}} limit",
    html: `<p>Hello,</p><p>You have reached your limit of <strong>{{limit}}</strong> {{featureName}}{{#if resetsAt}}. It resets on {{resetsAt}}{{/if}}.</p>${button('appUrl', 'Upgrade plan')}`,
    variables: ['featureName', 'used', 'limit', 'resetsAt'],
    sampleData: { featureName: 'API calls', used: 1000, limit: 1000, resetsAt: '2026-06-01' },
  },
  {
    key: 'identity.verify_email',
    name: 'Verify email address',
    description: 'Email verification for built-in authentication.',
    category: 'security',
    subject: 'Confirm your email address for {{appName}}',
    html: `<p>Hi {{name}},</p><p>Please confirm your email address to finish setting up your account.</p>${button('link', 'Confirm email')}${small('If you did not create an account, ignore this email.')}`,
    variables: ['name', 'link'],
    sampleData: { name: 'Grace', link: 'https://app.example.com/verify?token=example' },
  },
  {
    key: 'identity.password_reset',
    name: 'Password reset',
    description: 'Password reset for built-in authentication.',
    category: 'security',
    subject: 'Reset your {{appName}} password',
    html: `<p>Hi {{name}},</p><p>Use the button below to choose a new password.</p>${button('link', 'Reset password')}${small('The link expires soon. If you did not ask for a reset, ignore this email.')}`,
    variables: ['name', 'link'],
    sampleData: { name: 'Grace', link: 'https://app.example.com/reset?token=example' },
  },
  {
    key: 'checkout.recovery',
    name: 'Abandoned checkout recovery',
    description: 'Reminder for a checkout that was started but not completed.',
    category: 'marketing',
    subject: 'Still thinking about {{productName}}?',
    html: `<p>Hello,</p><p>You started checking out <strong>{{productName}}</strong>{{#if amount}} ({{amount}}){{/if}} but did not finish. Pick up where you left off whenever you're ready.</p>${button('checkoutUrl', 'Complete purchase')}`,
    variables: ['productName', 'amount', 'checkoutUrl'],
    sampleData: { productName: 'Pro', amount: '$20.00', checkoutUrl: 'https://app.example.com/pricing' },
  },
  {
    key: 'reports.scheduled',
    name: 'Scheduled report',
    description: 'Delivery of a scheduled report.',
    category: 'transactional',
    subject: 'Your report: {{reportName}}',
    html: `<p>Your scheduled report <strong>{{reportName}}</strong> is ready ({{rows}} rows).</p>${button('link', 'Open report')}`,
    variables: ['reportName', 'link', 'rows'],
    sampleData: { reportName: 'Weekly revenue', link: 'https://admin.example.com/reports', rows: 12 },
  },
  {
    key: 'admin.notification',
    name: 'Admin notification copy',
    description: 'A copy of an administrator notification, sent to the admin address and copy list in Settings → Email.',
    category: 'transactional',
    subject: '[{{appName}}] {{title}}',
    html: `<p><strong>{{title}}</strong></p>{{#if body}}<p>{{body}}</p>{{/if}}{{#if link}}<p><a href="{{link}}">Open in the admin console</a></p>{{/if}}`,
    variables: ['title', 'body', 'link', 'severity'],
    sampleData: { title: 'Payment failed for Acme Inc.', body: 'The card was declined; the next retry is in 3 days.', link: 'https://admin.example.com/revenue/payments', severity: 'warning' },
  },
  {
    key: 'email.test',
    name: 'Test email',
    description: 'Used by "send test email" to check provider configuration.',
    category: 'transactional',
    subject: 'Test email from {{appName}}',
    html: `<p>This is a test email from {{appName}}.</p><p>{{message}}</p>`,
    variables: ['message'],
    sampleData: { message: 'If you can read this, email delivery works.' },
  },
];

/**
 * Insert system templates, refreshing ones nobody has edited (so upgrades ship
 * better copy) while never overwriting an administrator's changes.
 */
export async function upsertSystemTemplates(db: Db, app: App, templates: readonly TemplateDefinition[]): Promise<void> {
  const now = app.clock.now();
  for (const t of templates) {
    await db.exec(sql`
      INSERT INTO email_templates (id, key, locale, name, description, category, subject, html, text, variables, sample_data, is_system, edited, version, created_at, updated_at)
      VALUES (${newId('etpl')}, ${t.key}, ${t.locale ?? 'en'}, ${t.name}, ${t.description}, ${t.category}, ${t.subject}, ${t.html}, ${t.text ?? null},
              ${sql.json(t.variables)}, ${sql.json(t.sampleData)}, TRUE, FALSE, 1, ${now}, ${now})
      ON CONFLICT (key, locale) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category,
        subject = EXCLUDED.subject, html = EXCLUDED.html, text = EXCLUDED.text, variables = EXCLUDED.variables, sample_data = EXCLUDED.sample_data,
        is_system = TRUE, updated_at = EXCLUDED.updated_at
      WHERE email_templates.edited = FALSE AND email_templates.is_system
    `);
  }
}

export function systemTemplate(key: string, locale = 'en', extra: readonly TemplateDefinition[] = []): TemplateDefinition | undefined {
  return [...SYSTEM_TEMPLATES, ...extra].find((t) => t.key === key && (t.locale ?? 'en') === locale);
}

export interface TemplateRow {
  id: string;
  key: string;
  locale: string;
  name: string;
  category: EmailCategory;
  subject: string;
  html: string;
  text: string | null;
  variables: string[];
  sample_data: Record<string, unknown>;
  is_system: boolean;
  edited: boolean;
}

/** Locale candidates in order: exact, language only (pt-BR -> pt), then the defaults. */
export function localeChain(...candidates: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const lc = c.trim();
    if (lc && !out.includes(lc)) out.push(lc);
    const lang = lc.split(/[-_]/)[0];
    if (lang && !out.includes(lang)) out.push(lang);
  }
  if (!out.includes('en')) out.push('en');
  return out;
}

export async function findTemplate(db: Db, key: string, locales: string[]): Promise<TemplateRow | null> {
  const rows = await db.many<TemplateRow>(sql`SELECT * FROM email_templates WHERE key = ${key}`);
  if (!rows.length) return null;
  for (const l of locales) {
    const hit = rows.find((r) => r.locale.toLowerCase() === l.toLowerCase());
    if (hit) return hit;
  }
  return rows.find((r) => r.locale === 'en') ?? rows[0];
}

/** Variables every template can use. */
export function commonVariables(app: App, recipient: { email: string; name: string | null }): Record<string, unknown> {
  const general = app.settings.get<{ appName: string; appUrl: string; supportEmail: string; logoUrl: string }>('general');
  const email = app.settings.get<EmailSettings>('email');
  return {
    appName: general.appName,
    appUrl: general.appUrl || app.config.appUrl,
    supportEmail: general.supportEmail || email.defaultFromEmail,
    logoUrl: general.logoUrl,
    brandColor: email.brandColor,
    year: app.clock.now().getUTCFullYear(),
    recipient,
  };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      const url = href.replace(/&amp;/g, '&');
      return text && text !== url ? `${text} (${url})` : url;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|div|tr|li|table)>/gi, '\n\n')
    .replace(/<td[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Add query parameters (UTM tags) to every http(s) link in rendered HTML, except ones `skip` excludes. */
export function addLinkParams(html: string, params: Record<string, string>, skip: (url: string) => boolean): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, raw: string) => {
    const decoded = raw.replace(/&amp;/g, '&');
    if (skip(decoded)) return match;
    try {
      const url = new URL(decoded);
      for (const [k, v] of Object.entries(params)) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
      return `href="${url.toString().replace(/&/g, '&amp;')}"`;
    } catch {
      return match;
    }
  });
}

/** Wrap a rendered body in the branded, table-based layout most email clients render consistently. */
export function wrapLayout(app: App, body: string, opts: { unsubscribeUrl?: string | null; preheader?: string | null }): string {
  const general = app.settings.get<{ appName: string; logoUrl: string; supportEmail: string }>('general');
  const email = app.settings.get<EmailSettings>('email');
  const brand = general.logoUrl
    ? `<img src="${escapeHtml(general.logoUrl)}" alt="${escapeHtml(general.appName)}" style="max-height:36px;border:0">`
    : `<span style="font-size:18px;font-weight:700;color:${escapeHtml(email.brandColor)}">${escapeHtml(general.appName)}</span>`;
  const footer = [
    escapeHtml(email.footerText || general.appName),
    general.supportEmail ? `Questions? <a href="mailto:${escapeHtml(general.supportEmail)}" style="color:#6b7280">${escapeHtml(general.supportEmail)}</a>` : '',
    opts.unsubscribeUrl ? `<a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a> from these emails.` : '',
  ]
    .filter(Boolean)
    .join('<br>');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(opts.preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;border:1px solid #e5e7eb">
<tr><td style="padding:24px 32px 8px">${brand}</td></tr>
<tr><td style="padding:8px 32px 24px;font-size:15px;line-height:1.6;color:#1f2328">${body}</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #f0f1f3;color:#6b7280;font-size:12px;line-height:1.6">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * Render a template. HTML bodies escape every variable (user names, ticket
 * subjects...) so data cannot inject markup; subjects are plain text with line
 * breaks removed so data cannot inject headers.
 */
export function renderEmail(
  app: App,
  tpl: { subject: string; html: string; text: string | null },
  data: Record<string, unknown>,
  opts: { unsubscribeUrl?: string | null } = {},
): RenderedEmail {
  const subject = renderTemplate(tpl.subject, data, { escape: false }).replace(/[\r\n]+/g, ' ').trim().slice(0, 998);
  const body = renderTemplate(tpl.html, data, { escape: true });
  const html = wrapLayout(app, body, { unsubscribeUrl: opts.unsubscribeUrl, preheader: null });
  let text = tpl.text ? renderTemplate(tpl.text, data, { escape: false }) : htmlToText(body);
  if (opts.unsubscribeUrl) text += `\n\n--\nUnsubscribe: ${opts.unsubscribeUrl}`;
  return { subject, html, text };
}
