import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useBlocker } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Save, Send, TriangleAlert, Undo2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Button, Callout, Card, Checkbox, FormError, Input, Select, Skeleton, Switch, Textarea, useConfirm } from '../../components/ui';

interface SettingsSection {
  key: string;
  label: string;
  permission: string;
  value: Record<string, unknown>;
}

type ProviderType = 'log' | 'smtp' | 'ses' | 'resend' | 'postmark' | 'sendgrid' | 'mailgun' | 'mailjet';
type Method = ProviderType | 'disabled' | '';

interface ProviderRow {
  id: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  priority: number;
  config: Record<string, unknown>;
  secrets: { name: string; last4: string | null }[];
}

interface EmailValues {
  adminEmail: string;
  technicalEmail: string;
  defaultFromEmail: string;
  fromName: string;
  sendingDisabled: boolean;
  throttlePerMinute: number;
  notificationUnsubscribeLinks: boolean;
  adminNotificationCopies: string[];
  defaultLocale: string;
  brandColor: string;
  footerText: string;
  maxAttempts: number;
  devLogFallback: boolean;
  autoReceipts: boolean;
  autoPaymentFailed: boolean;
  autoTrialEnding: boolean;
  autoSubscriptionCanceled: boolean;
  autoUsageAlerts: boolean;
  autoCheckoutRecovery: boolean;
  checkoutRecoveryUrl: string;
  autoWelcome: boolean;
  signupExcludedSources: string[];
  autoRenewalReminder: boolean;
  renewalReminderDays: number;
  autoExpiryNotices: boolean;
  expiryReminderDays: number;
}

const METHODS: { value: Method; label: string }[] = [
  { value: 'smtp', label: 'SMTP' },
  { value: 'ses', label: 'Amazon SES' },
  { value: 'sendgrid', label: 'SendGrid (Web API v3)' },
  { value: 'postmark', label: 'Postmark' },
  { value: 'mailgun', label: 'Mailgun' },
  { value: 'mailjet', label: 'Mailjet' },
  { value: 'resend', label: 'Resend' },
  { value: 'log', label: 'Log only (for testing; nothing is sent)' },
  { value: 'disabled', label: 'Disabled (send no email)' },
];

const SES_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
  'eu-central-2', 'eu-north-1', 'eu-south-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'ap-northeast-3', 'me-south-1', 'af-south-1', 'il-central-1',
];

/** Starting configuration when switching to a sending method. */
const DEFAULT_CONFIG: Record<ProviderType, Record<string, unknown>> = {
  log: {},
  smtp: { host: '', port: 587, secure: false, requireTls: true, username: '', authMethod: '', pooled: false },
  ses: { region: 'us-east-1', username: '', pooled: false },
  sendgrid: {},
  postmark: { messageStream: 'outbound' },
  resend: {},
  mailgun: { domain: '', region: 'us' },
  mailjet: {},
};

/** Credentials each method needs (stored encrypted; never shown again). */
const SECRETS: Record<ProviderType, { key: string; label: string; hint?: string }[]> = {
  log: [],
  smtp: [{ key: 'password', label: 'SMTP password' }],
  ses: [{ key: 'password', label: 'SMTP password', hint: 'The SMTP password SES generated with the username (not your AWS secret key).' }],
  sendgrid: [{ key: 'api_key', label: 'API key', hint: 'Starts with SG. and needs the Mail Send permission.' }],
  postmark: [{ key: 'server_token', label: 'Server API token' }],
  resend: [{ key: 'api_key', label: 'API key', hint: 'Starts with re_.' }],
  mailgun: [{ key: 'api_key', label: 'Private API key' }],
  mailjet: [
    { key: 'api_key', label: 'API key' },
    { key: 'secret_key', label: 'Secret key' },
  ],
};

type Security = 'starttls' | 'ssl' | 'none';
const securityOf = (c: Record<string, unknown>): Security => (c.secure ? 'ssl' : c.requireTls === false ? 'none' : 'starttls');

/** The configuration the server stores: empty optional values left out, numbers as numbers. */
function cleanConfig(type: ProviderType, c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k in DEFAULT_CONFIG[type] && !(typeof v === 'string' && v.trim() === '' && (k === 'username' || k === 'authMethod'))) out[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (type === 'smtp') out.port = Number(out.port) || 587;
  return out;
}

const list = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** One setting: label and help on the left, the control on the right (stacked on small screens). */
function Row({ label, hint, htmlFor, error, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 py-3.5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:gap-6">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
        ) : (
          <span className="text-sm font-medium">{label}</span>
        )}
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 sm:pt-0.5">
        {children}
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function EmailSettingsForm({ section, retention }: { section: SettingsSection; retention: SettingsSection | null }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can(section.permission);
  const canRetention = Boolean(retention && can(retention.permission));
  const providers = useQuery({ queryKey: ['email-providers'], queryFn: () => api.get<{ data: ProviderRow[] }>('/api/admin/email/providers'), enabled: can('email.providers.view') });

  if (providers.isLoading) return <Skeleton className="h-96" />;
  if (providers.error) return <Callout tone="danger" title="Email providers could not be loaded">{errorMessage(providers.error)}</Callout>;
  // Fresh state whenever the saved providers change (the parent does the same for the settings).
  return <EmailForm key={JSON.stringify(providers.data?.data ?? [])} section={section} retention={retention} providers={providers.data?.data ?? []} manage={manage} canRetention={canRetention} confirm={confirm} />;
}

function EmailForm({
  section,
  retention,
  providers,
  manage,
  canRetention,
  confirm,
}: {
  section: SettingsSection;
  retention: SettingsSection | null;
  providers: ProviderRow[];
  manage: boolean;
  canRetention: boolean;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const saved = section.value as unknown as EmailValues;
  const primary = providers.find((p) => p.enabled) ?? null;
  const savedMethod: Method = saved.sendingDisabled ? 'disabled' : (primary?.type ?? '');
  const savedLogDays = Number(retention?.value.emailLogDays ?? 180);

  const [values, setValues] = useState<EmailValues>(saved);
  const [copies, setCopies] = useState(saved.adminNotificationCopies.join(', '));
  const [excluded, setExcluded] = useState(saved.signupExcludedSources.join(', '));
  const [method, setMethod] = useState<Method>(savedMethod);
  const [config, setConfig] = useState<Record<string, unknown>>(primary ? { ...DEFAULT_CONFIG[primary.type], ...primary.config } : {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [logDays, setLogDays] = useState(String(savedLogDays));
  const [throttleOn, setThrottleOn] = useState(saved.throttlePerMinute > 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const providerType = method !== '' && method !== 'disabled' ? method : null;
  const reusesPrimary = Boolean(providerType && primary?.type === providerType);
  const set = <K extends keyof EmailValues>(key: K, v: EmailValues[K]) => setValues((prev) => ({ ...prev, [key]: v }));
  const setCfg = (key: string, v: unknown) => setConfig((prev) => ({ ...prev, [key]: v }));

  // What would be saved, compared with what is stored.
  const next: EmailValues = {
    ...values,
    sendingDisabled: method === 'disabled' ? true : providerType ? false : values.sendingDisabled,
    throttlePerMinute: throttleOn ? Math.max(0, Math.round(Number(values.throttlePerMinute) || 0)) : 0,
    adminNotificationCopies: list(copies),
    signupExcludedSources: list(excluded),
  };
  const changedSettings = (Object.keys(next) as (keyof EmailValues)[]).filter((k) => {
    const a = next[k];
    const b = saved[k];
    return Array.isArray(a) && Array.isArray(b) ? !sameList(a as string[], b as string[]) : a !== b;
  });
  const providerChanged =
    providerType !== null &&
    (!reusesPrimary || JSON.stringify(cleanConfig(providerType, config)) !== JSON.stringify(cleanConfig(providerType, { ...DEFAULT_CONFIG[providerType], ...primary!.config })) || Object.values(secrets).some(Boolean));
  const logChanged = canRetention && Number(logDays) !== savedLogDays;
  const dirty = changedSettings.length > 0 || providerChanged || logChanged;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirm({ title: 'Discard unsaved changes?', description: 'Your edits to the email settings have not been saved.', confirmLabel: 'Discard', tone: 'danger' }).then((r) =>
      r.confirmed ? blockerRef.current.proceed?.() : blockerRef.current.reset?.(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);

  const save = useAction(
    async () => {
      if (providerChanged && providerType) {
        // The sender comes from the addresses above, so the primary provider keeps none of its own.
        const body = { config: cleanConfig(providerType, config), secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)), fromEmail: '', fromName: null, enabled: true };
        try {
          if (reusesPrimary) await api.patch(`/api/admin/email/providers/${primary!.id}`, body);
          else {
            const top = Math.max(0, ...providers.map((p) => p.priority)) + 1;
            await api.post('/api/admin/email/providers', { ...body, type: providerType, name: METHODS.find((m) => m.value === providerType)!.label.replace(/ \(.*\)$/, ''), priority: Math.min(1000, top) });
          }
        } catch (err) {
          throw prefixed(err, 'provider');
        }
      }
      if (changedSettings.length) {
        await api.patch('/api/admin/settings/email', Object.fromEntries(changedSettings.map((k) => [k, next[k]])));
      }
      if (logChanged) {
        try {
          await api.patch('/api/admin/settings/retention', { emailLogDays: Number(logDays) });
        } catch (err) {
          throw prefixed(err, 'retention');
        }
      }
    },
    {
      success: 'Email settings saved',
      invalidate: [['settings'], ['email-providers']],
      onSuccess: () => {
        setErrors({});
        setError(null);
        setSecrets({});
      },
      onError: (err) => {
        const fields = err instanceof ApiError ? err.fieldErrors() : {};
        setErrors(fields);
        setError(Object.keys(fields).length ? 'Check the highlighted fields.' : errorMessage(err));
      },
    },
  );

  const sendTest = useAction(() => api.post<{ ok: boolean; error: string | null }>('/api/admin/email/test', { to: testTo.trim() }), {
    onSuccess: (r) => setTestResult(r.ok ? { ok: true, message: `Sent to ${testTo.trim()}. Check that inbox (and its spam folder).` } : { ok: false, message: r.error ?? 'The email was not sent.' }),
    onError: (err) => setTestResult({ ok: false, message: errorMessage(err) }),
  });

  const discard = () => {
    setValues(saved);
    setCopies(saved.adminNotificationCopies.join(', '));
    setExcluded(saved.signupExcludedSources.join(', '));
    setMethod(savedMethod);
    setConfig(primary ? { ...DEFAULT_CONFIG[primary.type], ...primary.config } : {});
    setSecrets({});
    setLogDays(String(savedLogDays));
    setThrottleOn(saved.throttlePerMinute > 0);
    setErrors({});
    setError(null);
  };

  const chooseMethod = (m: Method) => {
    setMethod(m);
    setSecrets({});
    if (m !== '' && m !== 'disabled') setConfig(primary?.type === m ? { ...DEFAULT_CONFIG[m], ...primary.config } : { ...DEFAULT_CONFIG[m] });
  };
  const savedSecret = (key: string) => (reusesPrimary ? primary!.secrets.find((s) => s.name === key) : undefined);
  const fallbacks = providers.filter((p) => p.enabled && p.id !== primary?.id).length;
  const err = (key: string) => errors[key] ?? null;

  const text = (id: string, key: keyof EmailValues, opts: { type?: string; placeholder?: string } = {}) => (
    <Input id={id} type={opts.type ?? 'text'} value={String(values[key] ?? '')} onChange={(e) => set(key, e.target.value as never)} placeholder={opts.placeholder} invalid={Boolean(err(key))} disabled={!manage} />
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate();
      }}
    >
      {!manage && <Callout tone="warning">You can view these settings; changing them needs the {section.permission} permission.</Callout>}
      <FormError message={error} />

      <Card title="Email addresses" description="Who email comes from, and where administrators are reached.">
        <div className="divide-y">
          <Row label="Admin email address" hint="Receives a copy of every admin notification, and is the sender when the outgoing address below is empty." htmlFor="em-admin" error={err('adminEmail')}>
            {text('em-admin', 'adminEmail', { type: 'email', placeholder: 'admin@example.com' })}
          </Row>
          <Row label="Technical email address" hint="Shown on payment and unsubscribe pages to people who need help. If empty, the admin address is used." htmlFor="em-tech" error={err('technicalEmail')}>
            {text('em-tech', 'technicalEmail', { type: 'email', placeholder: 'support@example.com' })}
          </Row>
          <Row label="Outgoing email address" hint="The From address of email to customers. If empty, the admin address is used." htmlFor="em-from" error={err('defaultFromEmail')}>
            {text('em-from', 'defaultFromEmail', { type: 'email', placeholder: 'hello@example.com' })}
          </Row>
          <Row label="Email sender name" hint="The name customers see as the sender. If empty, the application name is used." htmlFor="em-name" error={err('fromName')}>
            {text('em-name', 'fromName', { placeholder: 'Acme' })}
          </Row>
        </div>
      </Card>

      <Card title="Email system configuration" description="How email leaves the platform. Credentials are stored encrypted and never shown again.">
        <div className="divide-y">
          <Row label="Email sending method" hint={method === '' ? 'Nothing is set up yet: choose a method to start sending.' : undefined} htmlFor="em-method">
            <Select
              id="em-method"
              value={method}
              onChange={(e) => chooseMethod(e.target.value as Method)}
              disabled={!manage}
              options={[...(method === '' ? [{ value: '', label: 'Choose a sending method…' }] : []), ...METHODS.map((m) => ({ value: m.value, label: m.label }))]}
            />
            {providerType && !reusesPrimary && primary && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Saving makes {METHODS.find((m) => m.value === providerType)?.label} the primary method; {primary.name} stays as a fallback until you turn it off under{' '}
                <Link to="/growth/email/providers" className="text-primary hover:underline">
                  Email delivery
                </Link>
                .
              </p>
            )}
            {method === 'disabled' && <p className="mt-1.5 text-xs text-muted-foreground">No email is sent. Messages are kept in the email log as not sent, so nothing is lost silently.</p>}
          </Row>

          {providerType === 'smtp' && (
            <>
              <Row label="SMTP hostname" htmlFor="em-host" error={errors['provider.config.host'] ?? null}>
                <Input id="em-host" value={String(config.host ?? '')} onChange={(e) => setCfg('host', e.target.value)} placeholder="smtp.example.com" disabled={!manage} invalid={Boolean(errors['provider.config.host'])} />
              </Row>
              <Row label="SMTP port" htmlFor="em-port" error={errors['provider.config.port'] ?? null}>
                <Input id="em-port" type="number" min={1} max={65535} value={String(config.port ?? 587)} onChange={(e) => setCfg('port', e.target.value)} className="max-w-32" disabled={!manage} />
              </Row>
              <Row label="SMTP security" hint="STARTTLS on port 587 is the usual choice; SSL/TLS normally uses port 465." htmlFor="em-security">
                <Select
                  id="em-security"
                  value={securityOf(config)}
                  disabled={!manage}
                  onChange={(e) => {
                    const s = e.target.value as Security;
                    const port = Number(config.port);
                    setConfig((c) => ({ ...c, secure: s === 'ssl', requireTls: s === 'starttls', port: s === 'ssl' && port === 587 ? 465 : s !== 'ssl' && port === 465 ? 587 : c.port }));
                  }}
                  options={[
                    { value: 'starttls', label: 'STARTTLS (required)' },
                    { value: 'ssl', label: 'SSL/TLS' },
                    { value: 'none', label: 'None (only on a trusted network)' },
                  ]}
                />
              </Row>
              <Row label="Authentication type" htmlFor="em-auth">
                <Select
                  id="em-auth"
                  value={String(config.authMethod ?? '')}
                  onChange={(e) => setCfg('authMethod', e.target.value)}
                  disabled={!manage}
                  options={[
                    { value: '', label: 'Automatic' },
                    { value: 'PLAIN', label: 'PLAIN' },
                    { value: 'LOGIN', label: 'LOGIN' },
                    { value: 'CRAM-MD5', label: 'CRAM-MD5' },
                  ]}
                />
              </Row>
              <Row label="SMTP username" htmlFor="em-user">
                <Input id="em-user" value={String(config.username ?? '')} onChange={(e) => setCfg('username', e.target.value)} autoComplete="off" disabled={!manage} />
              </Row>
            </>
          )}

          {providerType === 'ses' && (
            <>
              <Row label="SES region" hint="The region where your sending identity is verified." htmlFor="em-region">
                <Select id="em-region" value={String(config.region ?? 'us-east-1')} onChange={(e) => setCfg('region', e.target.value)} disabled={!manage} options={SES_REGIONS.map((r) => ({ value: r, label: r }))} />
              </Row>
              <Row label="SMTP username" hint="From SES → SMTP settings → Create SMTP credentials." htmlFor="em-user" error={errors['provider.config.username'] ?? null}>
                <Input id="em-user" value={String(config.username ?? '')} onChange={(e) => setCfg('username', e.target.value)} autoComplete="off" disabled={!manage} invalid={Boolean(errors['provider.config.username'])} />
              </Row>
            </>
          )}

          {providerType === 'mailgun' && (
            <>
              <Row label="Sending domain" hint="The domain verified in Mailgun, e.g. mg.example.com." htmlFor="em-domain" error={errors['provider.config.domain'] ?? null}>
                <Input id="em-domain" value={String(config.domain ?? '')} onChange={(e) => setCfg('domain', e.target.value)} placeholder="mg.example.com" disabled={!manage} invalid={Boolean(errors['provider.config.domain'])} />
              </Row>
              <Row label="Mailgun region" htmlFor="em-mg-region">
                <Select id="em-mg-region" value={String(config.region ?? 'us')} onChange={(e) => setCfg('region', e.target.value)} disabled={!manage} options={[{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }]} />
              </Row>
            </>
          )}

          {providerType === 'postmark' && (
            <Row label="Message stream" hint="Usually outbound (transactional)." htmlFor="em-stream">
              <Input id="em-stream" value={String(config.messageStream ?? 'outbound')} onChange={(e) => setCfg('messageStream', e.target.value)} className="max-w-60" disabled={!manage} />
            </Row>
          )}

          {providerType &&
            SECRETS[providerType].map((s) => {
              const stored = savedSecret(s.key);
              return (
                <Row key={s.key} label={s.label} hint={s.hint} htmlFor={`em-secret-${s.key}`} error={errors['provider.secrets'] ?? null}>
                  <Input
                    id={`em-secret-${s.key}`}
                    type="password"
                    autoComplete="new-password"
                    value={secrets[s.key] ?? ''}
                    onChange={(e) => setSecrets((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    // Passwords show no characters at all; API keys show their last four, like most providers do.
                    placeholder={stored ? `Saved${stored.last4 && s.key !== 'password' ? ` (ends ${stored.last4})` : ''}; leave blank to keep` : ''}
                    disabled={!manage}
                  />
                </Row>
              );
            })}

          {(providerType === 'smtp' || providerType === 'ses') && (
            <Row label="Use a new connection for each message" hint="Turn off to keep connections open and reuse them, which is faster for large volumes. Keep on if your server limits each session.">
              <Checkbox checked={!config.pooled} onChange={(e) => setCfg('pooled', !e.target.checked)} disabled={!manage} label="New connection for each message" />
            </Row>
          )}

          {fallbacks > 0 && (
            <p className="pt-3 text-xs text-muted-foreground">
              {fallbacks} more provider{fallbacks === 1 ? '' : 's'} take{fallbacks === 1 ? 's' : ''} over if this one fails; manage the order under{' '}
              <Link to="/growth/email/providers" className="text-primary hover:underline">
                Email delivery
              </Link>
              .
            </p>
          )}

          <Row label="Test email settings" hint={dirty ? 'Save your changes first: the test uses the saved settings.' : 'Sends a test message through the saved configuration.'} htmlFor="em-test">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="em-test" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Email address to send to" className="sm:max-w-80" disabled={!manage} />
              <Button type="button" variant="outline" icon={<Send className="size-4" />} loading={sendTest.isPending} disabled={!manage || dirty || !testTo.trim()} onClick={() => sendTest.mutate()}>
                Send test email
              </Button>
            </div>
            {testResult && (
              <p role="status" className={`mt-2 flex items-start gap-1.5 text-sm ${testResult.ok ? 'text-success' : 'text-danger'}`}>
                {testResult.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
                <span className="min-w-0 break-words">{testResult.message}</span>
              </p>
            )}
          </Row>
        </div>
      </Card>

      <Card title="Delivery and logging">
        <div className="divide-y">
          <Row
            label="Log outgoing email for … days"
            hint={canRetention ? 'Older entries in the email log are deleted automatically.' : 'Changing this needs permission to manage the data retention settings.'}
            htmlFor="em-log"
            error={errors['retention.emailLogDays'] ?? errors.emailLogDays ?? null}
          >
            <Input id="em-log" type="number" min={7} max={3650} value={logDays} onChange={(e) => setLogDays(e.target.value)} className="max-w-32" disabled={!manage || !canRetention} />
          </Row>
          <Row label="Use email throttle queue" hint="For providers or hosts that cap how fast you may send. Messages over the limit wait for the next minute." error={err('throttlePerMinute')}>
            <div className="flex flex-wrap items-center gap-3">
              <Checkbox checked={throttleOn} onChange={(e) => setThrottleOn(e.target.checked)} disabled={!manage} label="Limit sending speed" />
              {throttleOn && (
                <span className="flex items-center gap-2 text-sm">
                  <Input aria-label="Emails per minute" type="number" min={1} max={100000} value={String(values.throttlePerMinute || '')} onChange={(e) => set('throttlePerMinute', Number(e.target.value))} className="w-28" disabled={!manage} />
                  emails per minute
                </span>
              )}
            </div>
          </Row>
          <Row
            label="Do not include unsubscribe links in notification emails"
            hint="Applies to optional notifications such as usage alerts. Marketing email always includes an unsubscribe link, as the law and your customers' consent require; receipts and security email never need one."
          >
            <Checkbox checked={!values.notificationUnsubscribeLinks} onChange={(e) => set('notificationUnsubscribeLinks', !e.target.checked)} disabled={!manage} label="Leave out of notifications" />
          </Row>
          <Row label="Send a copy of all admin notifications" hint="To these addresses as well as the admin address (comma separated)." htmlFor="em-copies" error={Object.entries(errors).find(([k]) => k.startsWith('adminNotificationCopies'))?.[1] ?? null}>
            <Input id="em-copies" value={copies} onChange={(e) => setCopies(e.target.value)} placeholder="ops@example.com, cto@example.com" disabled={!manage} />
          </Row>
        </div>
      </Card>

      <Card title="Automatic emails" description="Messages the platform sends to customers on its own. Turn off any your application already sends.">
        <div className="grid gap-4 md:grid-cols-2">
          <Switch checked={values.autoReceipts} onCheckedChange={(v) => set('autoReceipts', v)} disabled={!manage} label="Payment receipts" description="After every successful payment." />
          <Switch checked={values.autoPaymentFailed} onCheckedChange={(v) => set('autoPaymentFailed', v)} disabled={!manage} label="Failed payments" description="When a charge fails, with a link to pay." />
          <Switch checked={values.autoTrialEnding} onCheckedChange={(v) => set('autoTrialEnding', v)} disabled={!manage} label="Trial ending" description="A few days before a trial ends." />
          <Switch checked={values.autoSubscriptionCanceled} onCheckedChange={(v) => set('autoSubscriptionCanceled', v)} disabled={!manage} label="Cancellations" description="When a subscription is cancelled." />
          <Switch checked={values.autoUsageAlerts} onCheckedChange={(v) => set('autoUsageAlerts', v)} disabled={!manage} label="Usage alerts" description="When a quota is nearly or fully used." />
          <Switch checked={values.autoWelcome} onCheckedChange={(v) => set('autoWelcome', v)} disabled={!manage} label="Welcome email" description="When a customer signs up (never for imported users)." />
          <Switch checked={values.autoRenewalReminder} onCheckedChange={(v) => set('autoRenewalReminder', v)} disabled={!manage} label="Renewal reminders" description="Before a paid subscription renews." />
          <Switch checked={values.autoExpiryNotices} onCheckedChange={(v) => set('autoExpiryNotices', v)} disabled={!manage} label="Access ending notices" description="Before and when access ends." />
          <Switch checked={values.autoCheckoutRecovery} onCheckedChange={(v) => set('autoCheckoutRecovery', v)} disabled={!manage} label="Abandoned checkout recovery" description="Reminds customers who left checkout." />
        </div>
        <div className="mt-4 divide-y border-t pt-1">
          {values.autoCheckoutRecovery && (
            <Row label="Checkout recovery link" hint="Where the reminder sends people, e.g. your pricing page. Empty uses the application URL." htmlFor="em-recovery" error={err('checkoutRecoveryUrl')}>
              {text('em-recovery', 'checkoutRecoveryUrl', { type: 'url', placeholder: 'https://example.com/pricing' })}
            </Row>
          )}
          {values.autoWelcome && (
            <Row label="No welcome email for these sources" hint="Registration sources that are not real signups (comma separated)." htmlFor="em-excluded">
              <Input id="em-excluded" value={excluded} onChange={(e) => setExcluded(e.target.value)} disabled={!manage} />
            </Row>
          )}
          {values.autoRenewalReminder && (
            <Row label="Renewal reminder" hint="Days before the renewal date." htmlFor="em-renew" error={err('renewalReminderDays')}>
              <Input id="em-renew" type="number" min={1} max={60} value={String(values.renewalReminderDays)} onChange={(e) => set('renewalReminderDays', Number(e.target.value))} className="max-w-32" disabled={!manage} />
            </Row>
          )}
          {values.autoExpiryNotices && (
            <Row label="Access ending notice" hint="Days before access ends; 0 sends only the notice once it has ended." htmlFor="em-expiry" error={err('expiryReminderDays')}>
              <Input id="em-expiry" type="number" min={0} max={60} value={String(values.expiryReminderDays)} onChange={(e) => set('expiryReminderDays', Number(e.target.value))} className="max-w-32" disabled={!manage} />
            </Row>
          )}
        </div>
      </Card>

      <Card title="Appearance and delivery policy">
        <div className="divide-y">
          <Row label="Default language" hint="Templates in this language are used when a customer has none set." htmlFor="em-locale" error={err('defaultLocale')}>
            <Input id="em-locale" value={values.defaultLocale} onChange={(e) => set('defaultLocale', e.target.value)} className="max-w-32" disabled={!manage} />
          </Row>
          <Row label="Brand color" htmlFor="em-color" error={err('brandColor')}>
            <div className="flex items-center gap-2">
              <input type="color" aria-label="Pick brand color" value={/^#[0-9a-f]{6}$/i.test(values.brandColor) ? values.brandColor : '#4f46e5'} onChange={(e) => set('brandColor', e.target.value)} disabled={!manage} className="h-9 w-12 cursor-pointer rounded-ui-sm border bg-surface p-1" />
              <Input id="em-color" value={values.brandColor} onChange={(e) => set('brandColor', e.target.value)} className="max-w-32 font-mono" disabled={!manage} invalid={Boolean(err('brandColor'))} />
            </div>
          </Row>
          <Row label="Footer text" hint="Shown at the bottom of every email, e.g. your postal address." htmlFor="em-footer" error={err('footerText')}>
            <Textarea id="em-footer" rows={2} value={values.footerText} onChange={(e) => set('footerText', e.target.value)} disabled={!manage} />
          </Row>
          <Row label="Delivery attempts" hint="How many times a message is tried before it is marked failed." htmlFor="em-attempts" error={err('maxAttempts')}>
            <Input id="em-attempts" type="number" min={1} max={20} value={String(values.maxAttempts)} onChange={(e) => set('maxAttempts', Number(e.target.value))} className="max-w-32" disabled={!manage} />
          </Row>
          <Row label="Development fallback" hint="Outside production, record email in the log when no sending method is set up.">
            <Checkbox checked={values.devLogFallback} onChange={(e) => set('devLogFallback', e.target.checked)} disabled={!manage} label="Log instead of failing" />
          </Row>
        </div>
      </Card>

      {manage && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-ui sm:border sm:bg-surface/95">
          {dirty && <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>}
          <Button variant="outline" icon={<Undo2 className="size-4" />} disabled={!dirty || save.isPending} onClick={discard}>
            Discard
          </Button>
          <Button type="submit" icon={<Save className="size-4" />} loading={save.isPending} disabled={!dirty}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  );
}

/** Field errors from a nested request, keyed under a prefix so the form can tell them apart. */
function prefixed(err: unknown, prefix: string): unknown {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return err;
  const details = (err.details as { path?: (string | number)[]; message?: string }[]).map((d) => ({ ...d, path: [prefix, ...(d.path ?? []).filter((p) => p !== 'body')] }));
  return new ApiError(err.status, err.code, err.message, details, err.requestId);
}
