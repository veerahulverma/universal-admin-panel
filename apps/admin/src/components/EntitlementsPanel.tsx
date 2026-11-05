import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/mutations';
import { dateTime, num } from '../lib/format';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, Select, Skeleton, Switch, Textarea, When, useConfirm } from './ui';

/** Whose entitlements: a user or an organization. */
export type EntitlementSubject = { userId: string; orgId?: never } | { orgId: string; userId?: never };

interface ResolvedFeature {
  key: string;
  name: string;
  type: 'boolean' | 'quota' | 'config';
  enabled: boolean;
  limit: number | null;
  unlimited: boolean;
  unit: string | null;
  config: unknown;
  sources: string[];
}

interface Grant {
  id: string;
  product_name: string;
  kind: string;
  quantity: number;
  source: string;
  reason: string | null;
  starts_at: string;
  ends_at: string | null;
  revoked_at: string | null;
}

interface Override {
  id: string;
  feature_key: string;
  feature_name: string;
  mode: 'set' | 'add';
  enabled: boolean | null;
  limit_value: number | null;
  unlimited: boolean | null;
  enforcement: string | null;
  config_value: unknown;
  reason: string;
  starts_at: string;
  expires_at: string | null;
}

interface EntitlementsResponse {
  plans: { productId: string; name: string; kind: string; origin: string; status: string; quantity: number }[];
  resolved: Record<string, ResolvedFeature>;
  grants: Grant[];
  overrides: Override[];
}

interface FeatureOption {
  key: string;
  name: string;
  type: 'boolean' | 'quota' | 'config';
  unit: string | null;
}

function access(f: ResolvedFeature): React.ReactNode {
  if (!f.enabled) return <Badge>off</Badge>;
  if (f.type === 'boolean') return <Badge tone="success">on</Badge>;
  if (f.type === 'config') return <code className="font-mono text-xs">{JSON.stringify(f.config)}</code>;
  return f.unlimited ? <Badge tone="primary">unlimited</Badge> : <span className="tabular">{num(f.limit)} {f.unit ?? ''}</span>;
}

function overrideValue(o: Override): string {
  if (o.enabled === false) return 'Turned off';
  if (o.unlimited) return 'Unlimited';
  if (o.limit_value !== null) return o.mode === 'add' ? `+${num(o.limit_value)}` : `Set to ${num(o.limit_value)}`;
  if (o.config_value !== null && o.config_value !== undefined) return `Value ${JSON.stringify(o.config_value)}`;
  return o.enabled ? 'Turned on' : 'Changed';
}

function windowText(starts: string, ends: string | null): string {
  const started = new Date(starts) <= new Date();
  if (!started) return `from ${dateTime(starts)}${ends ? ` until ${dateTime(ends)}` : ''}`;
  return ends ? `until ${dateTime(ends)}` : 'no end date';
}

const toIso = (d: string) => (d ? new Date(d).toISOString() : undefined);

function GrantDialog({ subject, open, onOpenChange, onDone }: { subject: EntitlementSubject; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const products = useQuery({ queryKey: ['products', 'active'], queryFn: () => api.get<{ data: { id: string; name: string; kind: string }[] }>('/api/admin/products', { status: 'active' }), enabled: open });
  const [form, setForm] = useState({ productId: '', quantity: '1', endsAt: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const grant = useAction(() => api.post('/api/admin/entitlement-grants', { ...subject, productId: form.productId, quantity: Number(form.quantity) || 1, endsAt: toIso(form.endsAt), reason: form.reason }), {
    success: 'Product granted',
    onSuccess: () => {
      onDone();
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Grant a product"
      description="Gives the features and limits of a plan, add-on or pack without a payment (complimentary access, lifetime deals, compensation)."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="grant-form" loading={grant.isPending} disabled={!form.productId}>
            Grant
          </Button>
        </>
      }
    >
      <form
        id="grant-form"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          grant.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Product" htmlFor="grant-product" className="sm:col-span-2" required>
          <Select id="grant-product" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} placeholder="Choose…" options={(products.data?.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.kind.replace('_', ' ')})` }))} />
        </Field>
        <Field label="Quantity" htmlFor="grant-qty" hint="Seats or packs">
          <Input id="grant-qty" type="number" min={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
        </Field>
        <Field label="Ends" htmlFor="grant-ends" hint="Leave empty for permanent access">
          <Input id="grant-ends" type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
        </Field>
        <Field label="Reason" htmlFor="grant-reason" className="sm:col-span-2" hint="Recorded in the audit log" required>
          <Textarea id="grant-reason" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} minLength={3} required />
        </Field>
      </form>
    </Modal>
  );
}

function OverrideDialog({ subject, open, onOpenChange, onDone }: { subject: EntitlementSubject; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const features = useQuery({ queryKey: ['features'], queryFn: () => api.get<{ data: FeatureOption[] }>('/api/admin/features'), enabled: open });
  const [form, setForm] = useState({ featureKey: '', mode: 'add' as 'set' | 'add', enabled: true, limit: '', unlimited: false, enforcement: '', config: '', startsAt: '', expiresAt: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const feature = features.data?.data.find((f) => f.key === form.featureKey);
  const save = useAction(
    () => {
      const body: Record<string, unknown> = { ...subject, featureKey: form.featureKey, reason: form.reason, startsAt: toIso(form.startsAt), expiresAt: toIso(form.expiresAt) };
      if (feature?.type === 'boolean') Object.assign(body, { mode: 'set', enabled: form.enabled });
      else if (feature?.type === 'config') Object.assign(body, { mode: 'set', config: form.config ? JSON.parse(form.config) : null });
      else Object.assign(body, { mode: form.unlimited ? 'set' : form.mode, unlimited: form.unlimited || undefined, limit: form.unlimited ? undefined : Number(form.limit), enforcement: form.enforcement || undefined });
      return api.post('/api/admin/entitlement-overrides', body);
    },
    {
      success: 'Override added',
      onSuccess: () => {
        onDone();
        onOpenChange(false);
      },
      onError: (e) => setError(e instanceof SyntaxError ? 'The value is not valid JSON' : errorMessage(e)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Override a feature or limit"
      description="Applies on top of the customer's plans. Give it an end date for a temporary increase."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="override-form" loading={save.isPending} disabled={!feature}>
            Add override
          </Button>
        </>
      }
    >
      <form
        id="override-form"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Feature" htmlFor="ovr-feature" className="sm:col-span-2" required>
          <Select id="ovr-feature" value={form.featureKey} onChange={(e) => setForm({ ...form, featureKey: e.target.value })} placeholder="Choose…" options={(features.data?.data ?? []).map((f) => ({ value: f.key, label: `${f.name} (${f.type})` }))} />
        </Field>
        {feature?.type === 'boolean' && (
          <div className="sm:col-span-2">
            <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} label={form.enabled ? 'Turn the feature on' : 'Turn the feature off'} />
          </div>
        )}
        {feature?.type === 'quota' && (
          <>
            <Field label="Change" htmlFor="ovr-mode">
              <Select id="ovr-mode" value={form.mode} disabled={form.unlimited} onChange={(e) => setForm({ ...form, mode: e.target.value as 'set' | 'add' })} options={[{ value: 'add', label: 'Add to the plan limit' }, { value: 'set', label: 'Replace the limit' }]} />
            </Field>
            <Field label={`Amount${feature.unit ? ` (${feature.unit})` : ''}`} htmlFor="ovr-limit">
              <Input id="ovr-limit" type="number" min={form.mode === 'add' ? 1 : 0} value={form.limit} disabled={form.unlimited} onChange={(e) => setForm({ ...form, limit: e.target.value })} required={!form.unlimited} />
            </Field>
            <Checkbox checked={form.unlimited} onChange={(e) => setForm({ ...form, unlimited: e.target.checked })} label="Unlimited" />
            <Field label="Enforcement" htmlFor="ovr-enf" hint="Optional">
              <Select id="ovr-enf" value={form.enforcement} onChange={(e) => setForm({ ...form, enforcement: e.target.value })} placeholder="Keep the plan's" options={[{ value: 'hard', label: 'Hard limit' }, { value: 'soft', label: 'Soft (warn only)' }, { value: 'overage', label: 'Allow overage' }]} />
            </Field>
          </>
        )}
        {feature?.type === 'config' && (
          <Field label="Value (JSON)" htmlFor="ovr-config" className="sm:col-span-2" hint='For example "priority" or {"seats": 25}'>
            <Input id="ovr-config" className="font-mono" value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} />
          </Field>
        )}
        <Field label="Starts" htmlFor="ovr-start" hint="Optional; defaults to now">
          <Input id="ovr-start" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
        </Field>
        <Field label="Expires" htmlFor="ovr-end" hint="Optional; leave empty to keep it">
          <Input id="ovr-end" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        </Field>
        <Field label="Reason" htmlFor="ovr-reason" className="sm:col-span-2" hint="Recorded in the audit log" required>
          <Textarea id="ovr-reason" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} minLength={3} required />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * What a customer can use and why: plan features merged with manual grants and
 * administrator overrides (temporary increases), as resolved by the server.
 */
export function EntitlementsPanel({ subject }: { subject: EntitlementSubject }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('catalog.entitlements.manage');
  const id = subject.userId ?? subject.orgId;
  const q = useQuery({ queryKey: ['entitlements', id], queryFn: () => api.get<EntitlementsResponse>('/api/admin/entitlements', subject) });
  const [granting, setGranting] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const refresh = () => void q.refetch();
  const revoke = useAction((grantId: string) => api.post(`/api/admin/entitlement-grants/${grantId}/revoke`), { success: 'Grant revoked', onSuccess: refresh });
  const remove = useAction((overrideId: string) => api.delete(`/api/admin/entitlement-overrides/${overrideId}`), { success: 'Override removed', onSuccess: refresh });

  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={refresh} />;
  const features = Object.values(q.data.resolved);
  const now = new Date();
  const grants = q.data.grants;
  const overrides = q.data.overrides;

  return (
    <div className="space-y-4">
      <Card title="Effective access" description={q.data.plans.length ? `From ${q.data.plans.map((p) => p.name).join(', ')} plus grants and overrides` : 'No plan; defaults plus grants and overrides'} padded={false}>
        <DataTable
          rows={features}
          rowKey={(f) => f.key}
          empty={<EmptyState title="No features defined" />}
          columns={[
            { key: 'feature', header: 'Feature', cell: (f) => <span>{f.name} <span className="font-mono text-xs text-muted-foreground">{f.key}</span></span> },
            { key: 'access', header: 'Access', cell: access },
            { key: 'sources', header: 'Granted by', cell: (f) => (f.sources?.length ? [...new Set(f.sources.map((src) => src.split(':')[0]))].join(', ') : <span className="text-muted-foreground">—</span>) },
          ]}
        />
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Manual grants" actions={manage && <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => setGranting(true)}>Grant product</Button>} padded={false}>
          {grants.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No manual grants.</p>
          ) : (
            <ul className="divide-y">
              {grants.map((g) => {
                const ended = g.revoked_at || (g.ends_at && new Date(g.ends_at) < now);
                return (
                  <li key={g.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {g.product_name}
                        {g.quantity > 1 && ` × ${g.quantity}`} {g.revoked_at ? <Badge>revoked</Badge> : ended ? <Badge>ended</Badge> : <Badge tone="success">active</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {g.source} · {windowText(g.starts_at, g.ends_at)}
                        {g.reason ? ` · ${g.reason}` : ''}
                      </p>
                    </div>
                    {manage && !ended && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        onClick={async () => {
                          if ((await confirm({ title: `Revoke ${g.product_name}?`, description: 'The customer loses what this grant gave them immediately.', tone: 'danger', confirmLabel: 'Revoke' })).confirmed) revoke.mutate(g.id);
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Overrides" description="Applied last, on top of plans and grants" actions={manage && <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => setOverriding(true)}>Add override</Button>} padded={false}>
          {overrides.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No overrides.</p>
          ) : (
            <ul className="divide-y">
              {overrides.map((o) => {
                const expired = o.expires_at && new Date(o.expires_at) < now;
                return (
                  <li key={o.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {o.feature_name}: {overrideValue(o)} {expired ? <Badge>expired</Badge> : new Date(o.starts_at) > now ? <Badge tone="info">scheduled</Badge> : <Badge tone="success">active</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {windowText(o.starts_at, o.expires_at)} · {o.reason}
                        {o.enforcement ? ` · ${o.enforcement} limit` : ''}
                      </p>
                    </div>
                    {manage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        onClick={async () => {
                          if ((await confirm({ title: `Remove the ${o.feature_name} override?`, tone: 'danger', confirmLabel: 'Remove' })).confirmed) remove.mutate(o.id);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Changes take effect immediately and notify your application through the <code className="font-mono">entitlements.updated</code> webhook. Last refreshed <When value={new Date()} />.
      </p>

      {granting && <GrantDialog subject={subject} open={granting} onOpenChange={setGranting} onDone={refresh} />}
      {overriding && <OverrideDialog subject={subject} open={overriding} onOpenChange={setOverriding} onDone={refresh} />}
    </div>
  );
}
