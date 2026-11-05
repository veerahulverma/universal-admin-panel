import { createHash } from 'node:crypto';
import { z, type ZodType } from 'zod';
import nodemailer from 'nodemailer';

export type ProviderType = 'log' | 'smtp' | 'ses' | 'resend' | 'postmark' | 'sendgrid' | 'mailgun' | 'mailjet';

export interface OutgoingEmail {
  /** Our message id (also sent as metadata so provider events can be matched back). */
  messageId: string;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface ProviderContext {
  config: Record<string, any>;
  secrets: Record<string, string>;
  fetch: typeof fetch;
  /** Injectable SMTP transport factory (tests); defaults to nodemailer. */
  smtpTransport: (options: Record<string, unknown>) => SmtpTransport;
}

export interface SmtpTransport {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }>;
  verify(): Promise<unknown>;
}

export interface EmailProviderAdapter {
  type: ProviderType;
  name: string;
  description: string;
  configSchema: ZodType;
  secretFields: { key: string; label: string; required: boolean; help?: string }[];
  send(ctx: ProviderContext, msg: OutgoingEmail): Promise<{ providerMessageId: string | null }>;
  test(ctx: ProviderContext): Promise<{ ok: boolean; message: string }>;
}

/** Thrown by adapters; the dispatcher falls back to the next provider either way. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function formatFrom(email: string, name: string | null): string {
  if (!name) return email;
  return `"${name.replace(/["\\\r\n]/g, '')}" <${email}>`;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function expectOk(res: Response, provider: string): Promise<any> {
  const body = await readJson(res);
  if (!res.ok) {
    const detail = body?.message ?? body?.Message ?? body?.errors?.[0]?.message ?? body?.raw ?? `HTTP ${res.status}`;
    throw new ProviderError(`${provider}: ${detail}`, res.status);
  }
  return body;
}

/** Development provider: the rendered message is already stored in the email log; nothing leaves the server. */
const logProvider: EmailProviderAdapter = {
  type: 'log',
  name: 'Log only (development)',
  description: 'Records messages in the email log without sending them. Use for development and staging.',
  configSchema: z.object({}),
  secretFields: [],
  async send(_ctx, msg) {
    return { providerMessageId: `log_${msg.messageId}` };
  },
  async test() {
    return { ok: true, message: 'Messages are recorded in the log and never sent' };
  },
};

const smtpProvider: EmailProviderAdapter = {
  type: 'smtp',
  name: 'SMTP',
  description: 'Any SMTP server or relay (Amazon SES SMTP, Mailgun SMTP, Google Workspace, your own MTA).',
  configSchema: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    requireTls: z.boolean().default(true),
    username: z.string().max(255).optional(),
    /** PLAIN, LOGIN or CRAM-MD5; unset lets client and server agree on one. */
    authMethod: z.enum(['PLAIN', 'LOGIN', 'CRAM-MD5']).optional(),
    /** Keep connections open and reuse them; off opens a new connection for each message. */
    pooled: z.boolean().default(false),
  }),
  secretFields: [{ key: 'password', label: 'SMTP password', required: false }],
  async send(ctx, msg) {
    return smtpSend(smtpTransportFor(ctx), msg, 'smtp');
  },
  async test(ctx) {
    try {
      await smtpTransportFor({ ...ctx, config: { ...ctx.config, pooled: false } }).verify();
      return { ok: true, message: `Connected to ${ctx.config.host}:${ctx.config.port}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },
};

/** Pooled transports, one per configuration (credentials included), per transport factory. */
const pools = new WeakMap<ProviderContext['smtpTransport'], Map<string, SmtpTransport>>();

function smtpTransportFor(ctx: ProviderContext, host: string = ctx.config.host): SmtpTransport {
  const options: Record<string, unknown> = {
    host,
    port: ctx.config.port ?? 587,
    secure: Boolean(ctx.config.secure),
    requireTLS: ctx.config.requireTls ?? true,
    auth: ctx.config.username ? { user: ctx.config.username, pass: ctx.secrets.password ?? '' } : undefined,
    ...(ctx.config.authMethod ? { authMethod: ctx.config.authMethod } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  };
  if (!ctx.config.pooled) return ctx.smtpTransport(options);
  let byConfig = pools.get(ctx.smtpTransport);
  if (!byConfig) pools.set(ctx.smtpTransport, (byConfig = new Map()));
  const key = createHash('sha256').update(JSON.stringify(options)).digest('hex');
  let transport = byConfig.get(key);
  if (!transport) byConfig.set(key, (transport = ctx.smtpTransport({ ...options, pool: true, maxConnections: 3 })));
  return transport;
}

async function smtpSend(transport: SmtpTransport, msg: OutgoingEmail, label: string): Promise<{ providerMessageId: string | null }> {
  try {
    const info = await transport.sendMail({
      from: formatFrom(msg.fromEmail, msg.fromName),
      to: msg.to,
      replyTo: msg.replyTo ?? undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers: { ...msg.headers, 'X-Steward-Message-Id': msg.messageId },
    });
    return { providerMessageId: info.messageId ?? null };
  } catch (err) {
    throw new ProviderError(`${label}: ${(err as Error).message}`);
  }
}

export const SES_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
  'eu-central-2', 'eu-north-1', 'eu-south-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'ap-northeast-3', 'me-south-1', 'af-south-1', 'il-central-1',
] as const;

const sesContext = (ctx: ProviderContext, pooled = Boolean(ctx.config.pooled)): ProviderContext => ({ ...ctx, config: { ...ctx.config, port: 587, secure: false, requireTls: true, pooled } });
const sesHost = (ctx: ProviderContext) => `email-smtp.${ctx.config.region}.amazonaws.com`;

/** Amazon SES through its SMTP interface, with the SMTP credentials SES issues (not an AWS access key pair). */
const sesProvider: EmailProviderAdapter = {
  type: 'ses',
  name: 'Amazon SES',
  description: 'Amazon Simple Email Service, with the SMTP credentials created in the SES console for the chosen region.',
  configSchema: z.object({
    region: z.enum(SES_REGIONS),
    username: z.string().min(1).max(255),
    pooled: z.boolean().default(false),
  }),
  secretFields: [{ key: 'password', label: 'SES SMTP password', required: true }],
  async send(ctx, msg) {
    return smtpSend(smtpTransportFor(sesContext(ctx), sesHost(ctx)), msg, 'ses');
  },
  async test(ctx) {
    try {
      await smtpTransportFor(sesContext(ctx, false), sesHost(ctx)).verify();
      return { ok: true, message: `Connected to ${sesHost(ctx)}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },
};

export function defaultSmtpTransport(options: Record<string, unknown>): SmtpTransport {
  return nodemailer.createTransport(options as any) as unknown as SmtpTransport;
}

const resendProvider: EmailProviderAdapter = {
  type: 'resend',
  name: 'Resend',
  description: 'Transactional email API by Resend.',
  configSchema: z.object({}),
  secretFields: [
    { key: 'api_key', label: 'API key (re_...)', required: true },
    { key: 'webhook_secret', label: 'Webhook signing secret (whsec_...)', required: false, help: 'For bounce and complaint events.' },
  ],
  async send(ctx, msg) {
    const res = await ctx.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.secrets.api_key}`, 'content-type': 'application/json', 'idempotency-key': msg.messageId },
      body: JSON.stringify({
        from: formatFrom(msg.fromEmail, msg.fromName),
        to: [msg.to],
        reply_to: msg.replyTo ?? undefined,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        headers: msg.headers,
        tags: [{ name: 'steward_message_id', value: msg.messageId }],
      }),
    });
    const body = await expectOk(res, 'resend');
    return { providerMessageId: body.id ?? null };
  },
  async test(ctx) {
    const res = await ctx.fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${ctx.secrets.api_key}` } });
    return res.ok ? { ok: true, message: 'Connected to Resend' } : { ok: false, message: `Resend responded ${res.status}` };
  },
};

const postmarkProvider: EmailProviderAdapter = {
  type: 'postmark',
  name: 'Postmark',
  description: 'Postmark transactional email (server API token).',
  configSchema: z.object({ messageStream: z.string().max(100).default('outbound') }),
  secretFields: [
    { key: 'server_token', label: 'Server API token', required: true },
    { key: 'webhook_secret', label: 'Webhook token', required: false, help: 'Append ?token=<value> to the webhook URL you configure in Postmark.' },
  ],
  async send(ctx, msg) {
    const res = await ctx.fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'x-postmark-server-token': ctx.secrets.server_token, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        From: formatFrom(msg.fromEmail, msg.fromName),
        To: msg.to,
        ReplyTo: msg.replyTo ?? undefined,
        Subject: msg.subject,
        HtmlBody: msg.html,
        TextBody: msg.text,
        MessageStream: ctx.config.messageStream ?? 'outbound',
        Headers: Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value })),
        Metadata: { steward_message_id: msg.messageId },
      }),
    });
    const body = await expectOk(res, 'postmark');
    if (body.ErrorCode) throw new ProviderError(`postmark: ${body.Message ?? `error ${body.ErrorCode}`}`, res.status);
    return { providerMessageId: body.MessageID ?? null };
  },
  async test(ctx) {
    const res = await ctx.fetch('https://api.postmarkapp.com/server', { headers: { 'x-postmark-server-token': ctx.secrets.server_token, accept: 'application/json' } });
    return res.ok ? { ok: true, message: 'Connected to Postmark' } : { ok: false, message: `Postmark responded ${res.status}` };
  },
};

const sendgridProvider: EmailProviderAdapter = {
  type: 'sendgrid',
  name: 'SendGrid',
  description: 'Twilio SendGrid v3 Mail Send API.',
  configSchema: z.object({}),
  secretFields: [
    { key: 'api_key', label: 'API key (SG....)', required: true },
    { key: 'webhook_public_key', label: 'Event webhook verification key', required: false, help: 'The public key SendGrid shows for the signed Event Webhook.' },
  ],
  async send(ctx, msg) {
    const res = await ctx.fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.secrets.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }], custom_args: { steward_message_id: msg.messageId } }],
        from: { email: msg.fromEmail, name: msg.fromName ?? undefined },
        reply_to: msg.replyTo ? { email: msg.replyTo } : undefined,
        subject: msg.subject,
        // SendGrid requires text/plain before text/html.
        content: [
          { type: 'text/plain', value: msg.text || ' ' },
          { type: 'text/html', value: msg.html },
        ],
        headers: Object.keys(msg.headers).length ? msg.headers : undefined,
      }),
    });
    if (!res.ok) await expectOk(res, 'sendgrid');
    return { providerMessageId: res.headers.get('x-message-id') };
  },
  async test(ctx) {
    const res = await ctx.fetch('https://api.sendgrid.com/v3/scopes', { headers: { authorization: `Bearer ${ctx.secrets.api_key}` } });
    return res.ok ? { ok: true, message: 'Connected to SendGrid' } : { ok: false, message: `SendGrid responded ${res.status}` };
  },
};

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const mailgunBase = (ctx: ProviderContext) => (ctx.config.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net');

const mailgunProvider: EmailProviderAdapter = {
  type: 'mailgun',
  name: 'Mailgun',
  description: 'Mailgun Messages API, for a sending domain verified in Mailgun (US or EU region).',
  configSchema: z.object({
    domain: z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, 'Use the sending domain, e.g. mg.example.com'),
    region: z.enum(['us', 'eu']).default('us'),
  }),
  secretFields: [{ key: 'api_key', label: 'Private API key', required: true }],
  async send(ctx, msg) {
    const form = new URLSearchParams({ from: formatFrom(msg.fromEmail, msg.fromName), to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, 'v:steward_message_id': msg.messageId });
    if (msg.replyTo) form.set('h:Reply-To', msg.replyTo);
    for (const [name, value] of Object.entries(msg.headers)) form.set(`h:${name}`, value);
    const res = await ctx.fetch(`${mailgunBase(ctx)}/v3/${encodeURIComponent(ctx.config.domain)}/messages`, {
      method: 'POST',
      headers: { authorization: basic('api', ctx.secrets.api_key ?? '') },
      body: form,
    });
    const body = await expectOk(res, 'mailgun');
    return { providerMessageId: body.id ?? null };
  },
  async test(ctx) {
    const res = await ctx.fetch(`${mailgunBase(ctx)}/v3/domains/${encodeURIComponent(ctx.config.domain)}`, { headers: { authorization: basic('api', ctx.secrets.api_key ?? '') } });
    return res.ok ? { ok: true, message: `Connected to Mailgun (${ctx.config.domain})` } : { ok: false, message: `Mailgun responded ${res.status}` };
  },
};

const mailjetProvider: EmailProviderAdapter = {
  type: 'mailjet',
  name: 'Mailjet',
  description: 'Mailjet Send API v3.1, with an API key and secret key.',
  configSchema: z.object({}),
  secretFields: [
    { key: 'api_key', label: 'API key', required: true },
    { key: 'secret_key', label: 'Secret key', required: true },
  ],
  async send(ctx, msg) {
    const res = await ctx.fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: { authorization: basic(ctx.secrets.api_key ?? '', ctx.secrets.secret_key ?? ''), 'content-type': 'application/json' },
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: msg.fromEmail, Name: msg.fromName ?? undefined },
            To: [{ Email: msg.to }],
            ReplyTo: msg.replyTo ? { Email: msg.replyTo } : undefined,
            Subject: msg.subject,
            HTMLPart: msg.html,
            TextPart: msg.text,
            Headers: Object.keys(msg.headers).length ? msg.headers : undefined,
            CustomID: msg.messageId,
          },
        ],
      }),
    });
    const body = await expectOk(res, 'mailjet');
    const result = body.Messages?.[0];
    if (result?.Status !== 'success') throw new ProviderError(`mailjet: ${result?.Errors?.[0]?.ErrorMessage ?? 'message rejected'}`, res.status);
    // MessageUUID is a string; the numeric MessageID can exceed what a JavaScript number holds exactly.
    const to = result.To?.[0];
    return { providerMessageId: to?.MessageUUID ?? (to?.MessageID != null ? String(to.MessageID) : null) };
  },
  async test(ctx) {
    const res = await ctx.fetch('https://api.mailjet.com/v3/REST/sender?Limit=1', { headers: { authorization: basic(ctx.secrets.api_key ?? '', ctx.secrets.secret_key ?? '') } });
    return res.ok ? { ok: true, message: 'Connected to Mailjet' } : { ok: false, message: `Mailjet responded ${res.status}` };
  },
};

export const emailProviders: Record<ProviderType, EmailProviderAdapter> = {
  log: logProvider,
  smtp: smtpProvider,
  ses: sesProvider,
  resend: resendProvider,
  postmark: postmarkProvider,
  sendgrid: sendgridProvider,
  mailgun: mailgunProvider,
  mailjet: mailjetProvider,
};
