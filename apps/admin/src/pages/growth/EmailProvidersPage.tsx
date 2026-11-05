import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CircleCheck, CircleX, MoreHorizontal, Pencil, Plug, Plus, Send, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { SchemaForm, SecretFields, type JsonSchema, type SecretField } from '../../components/SchemaForm';
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Menu,
  Modal,
  PageHeader,
  PageSkeleton,
  Select,
  Switch,
  When,
  useConfirm,
  useToast,
} from '../../components/ui';
import { useSaveSettings, useSettingsSection } from './shared';

interface Provider {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  priority: number;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  config: Record<string, unknown>;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  secrets: { name: string; last4: string | null }[];
  webhookUrl: string;
}

interface ProviderType {
  type: string;
  name: string;
  description: string;
  secretFields: SecretField[];
  configSchema: JsonSchema;
}

interface ProvidersResponse {
  data: Provider[];
  available: ProviderType[];
}

/** Errors under `config.*` belong to the schema form, which addresses fields from its own root. */
function scoped(errors: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(`${prefix}.`)).map(([k, v]) => [k.slice(prefix.length + 1), v]));
}

function ProviderDialog({ provider, types, open, onOpenChange }: { provider: Provider | null; types: ProviderType[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [type, setType] = useState(provider?.type ?? types.find((t) => t.type !== 'log')?.type ?? types[0]?.type ?? 'smtp');
  const def = types.find((t) => t.type === type);
  const [form, setForm] = useState({
    name: provider?.name ?? '',
    fromEmail: provider?.from_email ?? '',
    fromName: provider?.from_name ?? '',
    replyTo: provider?.reply_to ?? '',
    priority: String(provider?.priority ?? 0),
    enabled: provider?.enabled ?? true,
  });
  const [config, setConfig] = useState<Record<string, unknown>>(provider?.config ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => {
      const body = {
        name: form.name,
        fromEmail: form.fromEmail,
        fromName: form.fromName || null,
        replyTo: form.replyTo || null,
        priority: Number(form.priority) || 0,
        enabled: form.enabled,
        config,
        secrets,
      };
      return provider ? api.patch(`/api/admin/email/providers/${provider.id}`, body) : api.post('/api/admin/email/providers', { ...body, type });
    },
    {
      success: provider ? 'Provider updated' : 'Provider connected. Test the connection next.',
      invalidate: [['email-providers']],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `Edit ${provider.name}` : 'Connect an email provider'}
      description="Credentials are encrypted at rest and never shown again after saving."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="provider-form" loading={save.isPending}>
            {provider ? 'Save provider' : 'Connect provider'}
          </Button>
        </>
      }
    >
      <form
        id="provider-form"
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        {!provider && (
          <Field label="Provider" htmlFor="pv-type" hint={def?.description}>
            <Select
              id="pv-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setConfig({});
                setSecrets({});
              }}
              options={types.map((t) => ({ value: t.type, label: t.name }))}
            />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="pv-name" error={errors.name} required>
            <Input id="pv-name" value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={100} placeholder={def ? `${def.name} (primary)` : undefined} />
          </Field>
          <Field label="Priority" htmlFor="pv-priority" hint="Higher is tried first; failures fall back to the next" error={errors.priority}>
            <Input id="pv-priority" type="number" min={-1000} max={1000} step={1} value={form.priority} onChange={(e) => set('priority', e.target.value)} />
          </Field>
          <Field label="From address" htmlFor="pv-from" error={errors.fromEmail} hint="Must be a domain verified with this provider (SPF/DKIM)" required>
            <Input id="pv-from" type="email" value={form.fromEmail} onChange={(e) => set('fromEmail', e.target.value)} required />
          </Field>
          <Field label="From name" htmlFor="pv-from-name" error={errors.fromName} hint="Defaults to your app name">
            <Input id="pv-from-name" value={form.fromName} onChange={(e) => set('fromName', e.target.value)} maxLength={100} />
          </Field>
          <Field label="Reply-to" htmlFor="pv-reply" error={errors.replyTo}>
            <Input id="pv-reply" type="email" value={form.replyTo} onChange={(e) => set('replyTo', e.target.value)} />
          </Field>
          <div className="flex items-end pb-1">
            <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} label="Enabled" description="Disabled providers are skipped" />
          </div>
        </div>
        {def && Object.keys(def.configSchema.properties ?? {}).length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Connection</legend>
            <SchemaForm schema={def.configSchema} value={config} onChange={setConfig} errors={scoped(errors, 'config')} />
          </fieldset>
        )}
        {def && def.secretFields.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Credentials</legend>
            {errors.secrets && <p className="text-xs text-danger">{errors.secrets}</p>}
            <SecretFields fields={def.secretFields} configured={provider?.secrets.map((s) => s.name) ?? []} value={secrets} onChange={setSecrets} />
          </fieldset>
        )}
      </form>
    </Modal>
  );
}

function TestEmailDialog({ providers, open, onOpenChange }: { providers: Provider[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [to, setTo] = useState(me?.admin.email ?? '');
  const [providerId, setProviderId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = useAction(() => api.post<{ ok: boolean; messageId: string; error: string | null }>('/api/admin/email/test', { to, providerId: providerId || undefined }), {
    invalidate: [['email-providers'], ['email-messages']],
    onSuccess: (r) => {
      if (r.ok) {
        toast.success('Test email sent', `Handed to the provider for ${to}. Check the inbox (and spam folder).`);
        onOpenChange(false);
      } else setError(r.error ?? 'Not sent');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Send a test email"
      description="Sends right away and reports the provider’s answer."
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!to} icon={<Send className="size-4" />}>
            Send test
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={error} />
        <Field label="Send to" htmlFor="te-to">
          <Input id="te-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
        </Field>
        <Field label="Through" htmlFor="te-provider">
          <Select id="te-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} options={[{ value: '', label: 'Normal delivery (priority order with fallback)' }, ...providers.map((p) => ({ value: p.id, label: `${p.name} only` }))]} />
        </Field>
      </div>
    </Modal>
  );
}

// ---- Sending defaults (settings section "email") ------------------------------------------------------

const EMAIL_SETTING_LABELS: Record<string, { title: string; description?: string }> = {
  defaultFromEmail: { title: 'Default sender address', description: 'Used when a provider has no from address' },
  defaultLocale: { title: 'Default language', description: 'For recipients whose language has no translation' },
  brandColor: { title: 'Button color' },
  footerText: { title: 'Footer text', description: 'Company name and postal address (required for marketing in many countries)' },
  maxAttempts: { title: 'Delivery attempts', description: 'Retries with backoff before an email is marked failed' },
  devLogFallback: { title: 'Log emails when no provider is configured', description: 'Development and staging only; production always needs a provider' },
  autoReceipts: { title: 'Payment receipts' },
  autoPaymentFailed: { title: 'Failed payment notices' },
  autoTrialEnding: { title: 'Trial ending reminders' },
  autoSubscriptionCanceled: { title: 'Subscription ended emails' },
  autoUsageAlerts: { title: 'Usage limit alerts' },
  autoCheckoutRecovery: { title: 'Abandoned checkout reminders' },
  checkoutRecoveryUrl: { title: 'Checkout recovery link', description: 'Your pricing page; defaults to the app URL' },
};

/**
 * `z.string().email().or(z.literal(''))` arrives as anyOf[string, const ""]; present it as one
 * optional text field, and add friendly titles.
 */
function presentSchema(schema: JsonSchema, labels: Record<string, { title: string; description?: string }>): { schema: JsonSchema; blankAllowed: string[] } {
  const properties: Record<string, JsonSchema> = {};
  const blankAllowed: string[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let p = prop;
    const variants = p.anyOf ?? p.oneOf;
    if (variants && variants.every((v) => v.type === 'string')) {
      const main = variants.find((v) => v.const === undefined) ?? variants[0];
      p = { type: 'string', format: main.format, maxLength: main.maxLength, pattern: main.pattern };
      if (variants.some((v) => v.const === '')) blankAllowed.push(key);
    }
    properties[key] = { ...p, ...(labels[key] ?? {}) };
  }
  return { schema: { ...schema, properties, required: (schema.required ?? []).filter((k) => !blankAllowed.includes(k)) }, blankAllowed };
}

function SendingDefaults() {
  const { can } = useAuth();
  const settings = useSettingsSection('email');
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useSaveSettings('email', {
    onSuccess: () => {
      setErrors({});
      setValue(null);
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors());
    },
  });
  const presented = useMemo(() => (settings.section ? presentSchema(settings.section.schema, EMAIL_SETTING_LABELS) : null), [settings.section]);
  if (!settings.allowed) return null;
  if (settings.isLoading) return <PageSkeleton />;
  if (settings.error || !settings.section || !presented) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const editable = can('email.providers.manage');
  const current = value ?? settings.section.value;
  // A cleared optional field must be sent as '' (a missing key would keep the stored value).
  const payload = () => ({ ...current, ...Object.fromEntries(presented.blankAllowed.filter((k) => current[k] === undefined).map((k) => [k, ''])) });
  return (
    <Card
      title="Sending defaults and automatic emails"
      description={settings.section.description ?? undefined}
      actions={
        editable && (
          <Button size="sm" onClick={() => save.mutate(payload())} loading={save.isPending} disabled={!value}>
            Save
          </Button>
        )
      }
    >
      <SchemaForm schema={presented.schema} value={current} onChange={setValue} errors={errors} disabled={!editable} />
    </Card>
  );
}

// ---- Page -------------------------------------------------------------------------------------

export default function EmailProvidersPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [testing, setTesting] = useState(false);
  const q = useQuery({ queryKey: ['email-providers'], queryFn: () => api.get<ProvidersResponse>('/api/admin/email/providers') });
  const manage = can('email.providers.manage');

  const update = useAction((v: { id: string; body: Record<string, unknown> }) => api.patch(`/api/admin/email/providers/${v.id}`, v.body), { invalidate: [['email-providers']] });
  const test = useAction((id: string) => api.post<{ ok: boolean; message: string }>(`/api/admin/email/providers/${id}/test`), {
    invalidate: [['email-providers']],
    onSuccess: (r) => (r.ok ? toast.success('Connection works', r.message) : toast.error('Connection failed', r.message)),
  });
  const remove = useAction((id: string) => api.delete(`/api/admin/email/providers/${id}`), { success: 'Provider removed', invalidate: [['email-providers']] });
  const reorder = useAction(
    async (ordered: Provider[]) => {
      // Spread priorities so the chosen order is explicit; only changed rows are written.
      const n = ordered.length;
      for (const [i, p] of ordered.entries()) {
        const priority = (n - i) * 10;
        if (p.priority !== priority) await api.patch(`/api/admin/email/providers/${p.id}`, { priority });
      }
    },
    { success: 'Delivery order updated', invalidate: [['email-providers']] },
  );

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const providers = q.data.data;
  const types = q.data.available;
  const typeName = (t: string) => types.find((x) => x.type === t)?.name ?? t;
  const move = (index: number, dir: -1 | 1) => {
    const next = [...providers];
    const [p] = next.splice(index, 1);
    next.splice(index + dir, 0, p);
    reorder.mutate(next);
  };
  const enabledCount = providers.filter((p) => p.enabled).length;

  return (
    <>
      <PageHeader
        title="Email delivery"
        description="Providers that send your email, tried in order with automatic fallback, plus sending defaults."
        actions={
          <>
            {manage && (
              <Button variant="outline" icon={<Send className="size-4" />} onClick={() => setTesting(true)}>
                Send test email
              </Button>
            )}
            {manage && (
              <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                Add provider
              </Button>
            )}
          </>
        }
      />

      {enabledCount === 0 && (
        <div className="mb-4">
          <Callout tone="warning" title="No email provider is active">
            In development, emails are recorded in the <Link to="/growth/email/messages" className="text-primary hover:underline">email log</Link> without being sent. Production needs at least one provider.
          </Callout>
        </div>
      )}

      {providers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Plug />}
            title="Connect your first provider"
            description="SMTP works with any relay (Amazon SES, Mailgun, Google Workspace). Resend, Postmark and SendGrid connect through their APIs. Add a second provider for automatic failover."
            action={
              manage && (
                <Button onClick={() => setEditing('new')} icon={<Plus className="size-4" />}>
                  Add provider
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <ol className="space-y-3" aria-label="Providers in delivery order">
          {providers.map((p, i) => (
            <li key={p.id}>
              <Card padded={false}>
                <div className="flex flex-wrap items-start gap-4 p-4">
                  <div className="flex flex-col items-center gap-0.5 pt-0.5">
                    <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular" aria-label={`Position ${i + 1}`}>
                      {i + 1}
                    </span>
                    {manage && providers.length > 1 && (
                      <span className="flex flex-col">
                        <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)} aria-label={`Move ${p.name} up`}>
                          <ArrowUp className="size-3.5" />
                        </button>
                        <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === providers.length - 1 || reorder.isPending} onClick={() => move(i, 1)} aria-label={`Move ${p.name} down`}>
                          <ArrowDown className="size-3.5" />
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">{p.name}</h2>
                      <Badge>{typeName(p.type)}</Badge>
                      {!p.enabled && <Badge tone="warning">disabled</Badge>}
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      From {p.from_name ? `${p.from_name} <${p.from_email}>` : p.from_email}
                      {p.reply_to && ` · reply-to ${p.reply_to}`}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs">
                      {p.last_test_ok === null ? (
                        <span className="text-muted-foreground">Connection not tested yet</span>
                      ) : p.last_test_ok ? (
                        <>
                          <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
                          <span>
                            Connection OK <span className="text-muted-foreground">· <When value={p.last_test_at} /></span>
                          </span>
                        </>
                      ) : (
                        <>
                          <CircleX className="size-3.5 text-danger" aria-hidden="true" />
                          <span className="min-w-0 truncate text-danger" title={p.last_test_message ?? undefined}>
                            {p.last_test_message ?? 'Connection failed'}
                          </span>
                        </>
                      )}
                    </p>
                    {p.type !== 'log' && p.type !== 'smtp' && (
                      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <span className="shrink-0">Event webhook:</span>
                        <code className="min-w-0 truncate font-mono">{p.webhookUrl}</code>
                        <CopyButton value={p.webhookUrl} label="Copy webhook URL" />
                      </div>
                    )}
                  </div>
                  {manage && (
                    <div className="flex items-center gap-2">
                      <Switch checked={p.enabled} onCheckedChange={(enabled) => update.mutate({ id: p.id, body: { enabled } })} label={<span className="sr-only">Enabled</span>} />
                      <Button size="sm" variant="outline" onClick={() => test.mutate(p.id)} loading={test.isPending && test.variables === p.id}>
                        Test connection
                      </Button>
                      <Menu
                        trigger={
                          <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${p.name}`}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                        items={[
                          { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(p) },
                          {
                            label: 'Remove',
                            icon: <Trash2 className="size-4" />,
                            danger: true,
                            onSelect: async () => {
                              const r = await confirm({ title: `Remove ${p.name}?`, description: enabledCount === 1 && p.enabled ? 'This is your only active provider; email will stop being delivered.' : 'Its stored credentials are deleted.', tone: 'danger', confirmLabel: 'Remove provider' });
                              if (r.confirmed) remove.mutate(p.id);
                            },
                          },
                        ]}
                      />
                    </div>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-3 text-xs text-muted-foreground">Bounces and spam complaints reported through provider webhooks suppress the address automatically.</p>

      <div className="mt-6">
        <SendingDefaults />
      </div>

      {editing && <ProviderDialog key={editing === 'new' ? 'new' : editing.id} provider={editing === 'new' ? null : editing} types={types} open onOpenChange={(o) => !o && setEditing(null)} />}
      {testing && <TestEmailDialog providers={providers} open={testing} onOpenChange={setTesting} />}
    </>
  );
}
