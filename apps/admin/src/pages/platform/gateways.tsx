import { useMemo, useState } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import { SchemaForm, SecretFields, type JsonSchema, type SecretField } from '../../components/SchemaForm';
import { Badge, Checkbox, Field, FormError, Input, Select, Switch } from '../../components/ui';
import { dateTime } from '../../lib/format';
import { normalizeSchema } from './shared';

export interface Capabilities {
  checkout: boolean;
  savePaymentMethod: boolean;
  offSessionCharge: boolean;
  refunds: boolean;
  partialRefunds: boolean;
  webhooks: boolean;
  currencies: string[] | '*';
  paymentMethods: string[];
}

export interface GatewayRow {
  id: string;
  adapter: string;
  name: string;
  mode: 'test' | 'live';
  enabled: boolean;
  is_default: boolean;
  priority: number;
  config: Record<string, unknown>;
  currencies: string[] | null;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
  adapterName: string;
  available: boolean;
  capabilities: Capabilities | null;
  secrets: { name: string; last4: string | null }[];
  webhookUrl: string;
}

export interface AdapterInfo {
  key: string;
  name: string;
  description: string;
  owner: string;
  capabilities: Capabilities;
  secretFields: SecretField[];
  configSchema: JsonSchema | null;
}

export interface GatewaysResponse {
  data: GatewayRow[];
  available: AdapterInfo[];
}

const CAPABILITY_LABELS: [keyof Capabilities, string][] = [
  ['checkout', 'Hosted checkout'],
  ['savePaymentMethod', 'Saves payment methods'],
  ['offSessionCharge', 'Automatic renewals'],
  ['refunds', 'Refunds'],
  ['partialRefunds', 'Partial refunds'],
  ['webhooks', 'Webhooks'],
];

export function CapabilityList({ caps, compact }: { caps: Capabilities | null; compact?: boolean }) {
  if (!caps) return <span className="text-sm text-muted-foreground">Adapter not installed</span>;
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1.5" aria-label="Capabilities">
        {CAPABILITY_LABELS.filter(([k]) => !compact || caps[k]).map(([k, label]) => (
          <li key={k}>
            <Badge tone={caps[k] ? 'success' : 'neutral'} className={caps[k] ? undefined : 'line-through opacity-70'}>
              {caps[k] ? <CircleCheck className="size-3" aria-hidden="true" /> : <CircleX className="size-3" aria-hidden="true" />}
              {label}
              <span className="sr-only">{caps[k] ? ' supported' : ' not supported'}</span>
            </Badge>
          </li>
        ))}
      </ul>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          Methods: {caps.paymentMethods.map((m) => m.replace(/_/g, ' ')).join(', ')} · Currencies: {caps.currencies === '*' ? 'any' : caps.currencies.join(', ')}
        </p>
      )}
    </div>
  );
}

export function ModeBadge({ mode }: { mode: 'test' | 'live' }) {
  return mode === 'live' ? (
    <Badge tone="success" dot>
      live
    </Badge>
  ) : (
    <Badge tone="warning" dot>
      test mode
    </Badge>
  );
}

export function TestResult({ gw }: { gw: GatewayRow }) {
  if (gw.last_test_ok === null) return <span className="text-xs text-muted-foreground">Connection not tested yet</span>;
  return (
    <span className={gw.last_test_ok ? 'text-xs text-success' : 'text-xs text-danger'}>
      {gw.last_test_ok ? 'Connected' : 'Failed'}: {gw.last_test_message} · {dateTime(gw.last_test_at)}
    </span>
  );
}

export interface GatewayDraft {
  name: string;
  mode: 'test' | 'live';
  priority: string;
  currencies: string;
  isDefault: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export function draftFrom(gw: GatewayRow | null, adapter: AdapterInfo): GatewayDraft {
  return {
    name: gw?.name ?? adapter.name,
    mode: gw?.mode ?? 'test',
    priority: String(gw?.priority ?? 0),
    currencies: (gw?.currencies ?? []).join(', '),
    isDefault: gw?.is_default ?? false,
    enabled: gw?.enabled ?? true,
    config: gw?.config ?? {},
    secrets: {},
  };
}

export function parseCurrencies(text: string): string[] | null {
  const list = text
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : null;
}

/** Shared create/edit form: settings, adapter configuration (JSON Schema) and write-only credentials. */
export function GatewayFields({
  adapter,
  gateway,
  draft,
  onChange,
  errors,
  error,
  disabled,
}: {
  adapter: AdapterInfo;
  gateway: GatewayRow | null;
  draft: GatewayDraft;
  onChange: (d: GatewayDraft) => void;
  errors: Record<string, string>;
  error: string | null;
  disabled?: boolean;
}) {
  const schema = useMemo(() => (adapter.configSchema ? normalizeSchema(adapter.configSchema) : null), [adapter.configSchema]);
  const [showOptional, setShowOptional] = useState(false);
  const stored = new Map((gateway?.secrets ?? []).map((s) => [s.name, s.last4]));
  const fields = adapter.secretFields.map((f) => ({
    ...f,
    help: stored.has(f.key) ? `${f.help ? `${f.help} ` : ''}Stored encrypted${stored.get(f.key) ? `, ends in …${stored.get(f.key)}` : ''}. Replace to rotate it.` : f.help,
  }));
  const set = (patch: Partial<GatewayDraft>) => onChange({ ...draft, ...patch });
  const sandbox = adapter.key === 'sandbox';
  const scoped = (prefix: string) => Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(`${prefix}.`)).map(([k, v]) => [k.slice(prefix.length + 1), v]));
  const configErrors = scoped('config');
  const secretErrors = [errors.secrets, ...Object.entries(scoped('secrets')).map(([k, v]) => `${adapter.secretFields.find((f) => f.key === k)?.label ?? k}: ${v}`)].filter(Boolean);

  return (
    <div className="space-y-5">
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" htmlFor="gw-name" error={errors.name} required>
          <Input id="gw-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} required disabled={disabled} />
        </Field>
        <Field label="Mode" htmlFor="gw-mode" error={errors.mode} hint={sandbox ? 'The sandbox only runs in test mode.' : 'Test mode uses the provider’s test credentials; no real money moves.'}>
          <Select
            id="gw-mode"
            value={draft.mode}
            disabled={disabled || sandbox}
            onChange={(e) => set({ mode: e.target.value as 'test' | 'live' })}
            options={[
              { value: 'test', label: 'Test' },
              { value: 'live', label: 'Live' },
            ]}
          />
        </Field>
        <Field label="Accepted currencies" htmlFor="gw-currencies" error={errors.currencies} hint={`Leave empty for every currency the gateway supports${adapter.capabilities.currencies === '*' ? '' : ` (${adapter.capabilities.currencies.join(', ')})`}.`}>
          <Input id="gw-currencies" value={draft.currencies} onChange={(e) => set({ currencies: e.target.value })} placeholder="USD, EUR" disabled={disabled} />
        </Field>
        <Field label="Priority" htmlFor="gw-priority" error={errors.priority} hint="Higher priority gateways are offered first.">
          <Input id="gw-priority" type="number" step={1} value={draft.priority} onChange={(e) => set({ priority: e.target.value })} disabled={disabled} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Switch checked={draft.enabled} onCheckedChange={(v) => set({ enabled: v })} label="Enabled" description="Offer this gateway at checkout." disabled={disabled} />
        <Checkbox checked={draft.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} label="Default gateway" description="Used when a checkout does not ask for a specific gateway." disabled={disabled} />
      </div>

      {fields.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Credentials</h3>
            <p className="text-xs text-muted-foreground">Encrypted at rest and never shown again. Leave a stored field untouched to keep it.</p>
          </div>
          <SecretFields fields={fields} configured={[...stored.keys()]} value={draft.secrets} onChange={(secrets) => set({ secrets })} disabled={disabled} />
          {secretErrors.map((m) => (
            <p key={m} className="text-xs text-danger" role="alert">
              {m}
            </p>
          ))}
        </section>
      )}

      {schema && Object.keys(schema.properties ?? {}).length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{adapter.name} options</h3>
            {!gateway && (
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowOptional((v) => !v)}>
                {showOptional ? 'Hide options' : 'Show options'}
              </button>
            )}
          </div>
          {(gateway || showOptional || Object.keys(configErrors).length > 0) && <SchemaForm schema={schema} value={draft.config} onChange={(config) => set({ config })} errors={configErrors} disabled={disabled} />}
        </section>
      )}
    </div>
  );
}

/** Build the PATCH/POST body; credentials are sent only when entered. */
export function gatewayBody(draft: GatewayDraft) {
  return {
    name: draft.name.trim(),
    mode: draft.mode,
    priority: Number.parseInt(draft.priority, 10) || 0,
    currencies: parseCurrencies(draft.currencies),
    isDefault: draft.isDefault,
    enabled: draft.enabled,
    config: draft.config,
    secrets: draft.secrets,
  };
}
