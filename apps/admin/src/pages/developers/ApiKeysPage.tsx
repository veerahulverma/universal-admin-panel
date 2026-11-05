import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { KeyRound, ListFilter, MoreHorizontal, Pencil, Plus, RotateCw, ShieldAlert } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { dateTime, num } from '../../lib/format';
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  Menu,
  Modal,
  Mono,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  Toolbar,
  When,
  useConfirm,
  type Column,
} from '../../components/ui';
import { OrgScopeField, SecretOnceDialog } from './shared';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  mode: 'live' | 'test';
  scopes: string[];
  orgId: string | null;
  orgName?: string | null;
  rateLimitPerMinute: number | null;
  allowedIps: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface ApiScope {
  scope: string;
  description: string;
  module: string;
}

interface CustomerKey {
  id: string;
  user_id: string | null;
  org_id: string | null;
  name: string;
  prefix: string;
  scopes: string[];
  rate_limit_per_minute: number | null;
  meter_key: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  created_at: string;
}

type Secret = { title: string; secret: string; note?: React.ReactNode };

const DEFAULTS = { tab: 'keys', q: '', mode: '', revoked: '' };
const WEEK = 7 * 86_400_000;

export function keyState(k: { revokedAt?: string | null; expiresAt?: string | null }): 'revoked' | 'expired' | 'active' {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

function useScopes() {
  return useQuery({ queryKey: ['developers', 'api-scopes'], queryFn: () => api.get<{ data: ApiScope[] }>('/api/admin/api-scopes'), staleTime: 10 * 60_000 });
}

function ScopeList({ scopes }: { scopes: string[] }) {
  if (scopes.includes('*')) return <Badge tone="warning">full access</Badge>;
  const shown = scopes.slice(0, 3);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((s) => (
        <code key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {s}
        </code>
      ))}
      {scopes.length > shown.length && <span className="text-xs text-muted-foreground">+{scopes.length - shown.length}</span>}
    </span>
  );
}

/** Scopes grouped by resource ("users:read" -> "users"); "users:*" selects the whole resource. */
function ScopePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const scopes = useScopes();
  const full = value.includes('*');
  const groups = useMemo(() => {
    const map = new Map<string, ApiScope[]>();
    for (const s of scopes.data?.data ?? []) {
      const g = s.scope.split(':')[0];
      map.set(g, [...(map.get(g) ?? []), s]);
    }
    return [...map.entries()];
  }, [scopes.data]);
  const set = new Set(value);
  const toggle = (scope: string, on: boolean) => {
    const next = new Set(value.filter((v) => v !== '*'));
    if (on) next.add(scope);
    else next.delete(scope);
    if (scope.endsWith(':*') && on) for (const v of [...next]) if (v !== scope && v.split(':')[0] === scope.slice(0, -2)) next.delete(v);
    onChange([...next]);
  };
  return (
    <div className="space-y-3">
      <Checkbox checked={full} onChange={(e) => onChange(e.target.checked ? ['*'] : [])} label="Full access" description="Every current and future scope. Prefer the narrowest set your integration needs." />
      {!full && (
        <div className="max-h-72 space-y-3 overflow-y-auto rounded-ui border p-3">
          {scopes.isLoading && <Skeleton className="h-24" />}
          {groups.map(([group, items]) => {
            const whole = set.has(`${group}:*`);
            return (
              <fieldset key={group}>
                <legend className="sr-only">{group} scopes</legend>
                <Checkbox checked={whole} onChange={(e) => toggle(`${group}:*`, e.target.checked)} label={<span className="font-mono text-xs">{group}:*</span>} description={`Everything for ${group.replace(/_/g, ' ')}`} />
                <div className="ml-6 mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  {items.map((s) => (
                    <Checkbox key={s.scope} checked={whole || set.has(s.scope)} disabled={whole} onChange={(e) => toggle(s.scope, e.target.checked)} label={<span className="font-mono text-xs font-normal">{s.scope}</span>} description={s.description} />
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
    </div>
  );
}

const ipList = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const dateInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const endOfDay = (d: string) => new Date(`${d}T23:59:59`).toISOString();

function KeyFormDialog({ open, onOpenChange, existing, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; existing?: ApiKey; onCreated?: (s: Secret) => void }) {
  const { me } = useAuth();
  const [form, setForm] = useState(() => ({
    name: existing?.name ?? '',
    mode: existing?.mode ?? 'test',
    orgId: existing?.orgId ?? (me?.admin.orgScope?.length === 1 ? me.admin.orgScope[0] : null),
    scopes: existing?.scopes ?? [],
    rateLimit: existing?.rateLimitPerMinute ? String(existing.rateLimitPerMinute) : '',
    allowedIps: existing?.allowedIps.join('\n') ?? '',
    expires: dateInput(existing?.expiresAt ?? null),
  }));
  const [error, setError] = useState<string | null>(null);
  const body = () => ({
    name: form.name.trim(),
    scopes: form.scopes,
    rateLimitPerMinute: form.rateLimit ? Number(form.rateLimit) : null,
    allowedIps: ipList(form.allowedIps),
    expiresAt: form.expires ? endOfDay(form.expires) : null,
  });
  const save = useAction<void, ApiKey & { secret?: string }>(
    () =>
      existing
        ? api.patch<ApiKey>(`/api/admin/api-keys/${existing.id}`, body())
        : api.post<ApiKey & { secret: string }>('/api/admin/api-keys', { ...body(), mode: form.mode, orgId: form.orgId }),
    {
      success: existing ? 'API key updated' : undefined,
      invalidate: [['developers', 'api-keys']],
      onSuccess: (key) => {
        onOpenChange(false);
        if (!existing && key.secret) onCreated?.({ title: `Your new ${key.mode} key`, secret: key.secret, note: <p className="text-sm text-muted-foreground">Use it from your backend as <code className="font-mono">Authorization: Bearer {key.prefix}…</code>. Never ship it in browser or mobile code.</p> });
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );
  const valid = form.name.trim() && form.scopes.length > 0;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={existing ? `Edit ${existing.name}` : 'Create an API key'}
      description={existing ? 'Changes apply to the next request made with this key.' : 'Secret keys authenticate your backend with the integration API (/api/v1).'}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="api-key-form" loading={save.isPending} disabled={!valid}>
            {existing ? 'Save changes' : 'Create key'}
          </Button>
        </>
      }
    >
      <form
        id="api-key-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="key-name" required hint="Where it is used, e.g. “Production backend”.">
            <Input id="key-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required autoFocus />
          </Field>
          {!existing && (
            <Field label="Environment" htmlFor="key-mode" hint="Test keys only see test-mode payments.">
              <Select id="key-mode" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'live' | 'test' })} options={[{ value: 'test', label: 'Test (sk_test_…)' }, { value: 'live', label: 'Live (sk_live_…)' }]} />
            </Field>
          )}
        </div>
        {!existing && (
          <Field label="Organization" htmlFor="key-org" hint="Limit the key to one organization's users and data (tenant isolation).">
            <OrgScopeField id="key-org" value={form.orgId} onChange={(orgId) => setForm({ ...form, orgId })} />
          </Field>
        )}
        <Field label="Scopes" required>
          <ScopePicker value={form.scopes} onChange={(scopes) => setForm({ ...form, scopes })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rate limit (requests / minute)" htmlFor="key-rate" hint="Empty uses the platform default.">
            <Input id="key-rate" type="number" min={1} max={100000} step={1} value={form.rateLimit} onChange={(e) => setForm({ ...form, rateLimit: e.target.value })} placeholder="Default" />
          </Field>
          <Field label="Expires" htmlFor="key-exp" hint="Optional. The key stops working at the end of this day.">
            <Input id="key-exp" type="date" value={form.expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
          </Field>
        </div>
        <Field label="Allowed IP addresses" htmlFor="key-ips" hint="One IP or CIDR range per line (e.g. 203.0.113.10 or 10.0.0.0/8). Empty allows any address.">
          <Textarea id="key-ips" rows={3} className="font-mono text-xs" value={form.allowedIps} onChange={(e) => setForm({ ...form, allowedIps: e.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}

function RollDialog({ apiKey, open, onOpenChange, onRolled }: { apiKey: ApiKey; open: boolean; onOpenChange: (o: boolean) => void; onRolled: (s: Secret) => void }) {
  const [hours, setHours] = useState('24');
  const roll = useAction(() => api.post<ApiKey & { secret: string; previousKeyExpiresAt: string }>(`/api/admin/api-keys/${apiKey.id}/roll`, { expireOldInHours: Number(hours) }), {
    invalidate: [['developers', 'api-keys']],
    onSuccess: (k) => {
      onOpenChange(false);
      onRolled({
        title: `New secret for ${k.name}`,
        secret: k.secret,
        note: (
          <p className="text-sm text-muted-foreground">
            {Number(hours) === 0 ? 'The previous key stopped working immediately.' : <>The previous key ({apiKey.prefix}…) keeps working until {dateTime(k.previousKeyExpiresAt)} so you can deploy the new one.</>}
          </p>
        ),
      });
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Roll ${apiKey.name}?`}
      description="Issues a replacement secret with the same scopes and limits. Deploy it, then let the old key expire."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => roll.mutate()} loading={roll.isPending} icon={<RotateCw className="size-4" />}>
            Roll key
          </Button>
        </>
      }
    >
      <Field label="Keep the old key working for" htmlFor="roll-grace">
        <Select
          id="roll-grace"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          options={[
            { value: '0', label: 'Expire immediately' },
            { value: '1', label: '1 hour' },
            { value: '24', label: '24 hours' },
            { value: '72', label: '3 days' },
            { value: '168', label: '7 days' },
          ]}
        />
      </Field>
    </Modal>
  );
}

function KeyUsage({ keyId }: { keyId: string }) {
  const [now] = useState(() => Date.now());
  const usage = useQuery({
    queryKey: ['developers', 'key-usage', keyId],
    queryFn: async () => {
      const count = (q: Record<string, string>) => api.get<Page<unknown>>('/api/admin/api-requests', { keyId, pageSize: 1, ...q }).then((p) => p.total);
      const day = new Date(now - 86_400_000).toISOString();
      const week = new Date(now - WEEK).toISOString();
      const [d, w, c4, c5, rl] = await Promise.all([count({ from: day }), count({ from: week }), count({ from: week, status: '4xx' }), count({ from: week, status: '5xx' }), count({ from: week, status: '429' })]);
      return { d, w, c4, c5, rl };
    },
  });
  if (usage.isLoading) return <Skeleton className="h-16" />;
  if (usage.error) return <p className="text-sm text-muted-foreground">Request statistics are unavailable ({errorMessage(usage.error)}).</p>;
  const u = usage.data!;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        ['Requests, 24 h', num(u.d)],
        ['Requests, 7 days', num(u.w)],
        ['Client errors, 7 days', num(u.c4)],
        ['Server errors, 7 days', num(u.c5)],
      ].map(([label, value]) => (
        <div key={label} className="rounded-ui-sm bg-muted/50 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-base font-semibold tabular">{value}</dd>
        </div>
      ))}
      {u.rl > 0 && (
        <div className="col-span-full">
          <Badge tone="warning">{num(u.rl)} rate-limited requests this week</Badge>
        </div>
      )}
    </dl>
  );
}

function KeyDetailDialog({ apiKey, onClose, onEdit, onRoll, onRevoke }: { apiKey: ApiKey | null; onClose: () => void; onEdit: (k: ApiKey) => void; onRoll: (k: ApiKey) => void; onRevoke: (k: ApiKey) => void }) {
  const { can } = useAuth();
  const scopes = useScopes();
  const descriptions = new Map((scopes.data?.data ?? []).map((s) => [s.scope, s.description]));
  const k = apiKey;
  const active = k ? keyState(k) === 'active' : false;
  return (
    <Modal
      open={Boolean(k)}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={k?.name ?? ''}
      description={k ? `${k.mode === 'live' ? 'Live' : 'Test'} secret key` : undefined}
      footer={
        k && (
          <>
            <ButtonLink to={`/developers/logs?keyId=${k.id}`} variant="ghost" icon={<ListFilter className="size-4" />}>
              Request log
            </ButtonLink>
            {can('developers.keys.manage') && active && (
              <>
                <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => onEdit(k)}>
                  Edit
                </Button>
                <Button variant="outline" icon={<RotateCw className="size-4" />} onClick={() => onRoll(k)}>
                  Roll
                </Button>
                <Button variant="danger" onClick={() => onRevoke(k)}>
                  Revoke
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {k && (
        <div className="space-y-5">
          {keyState(k) !== 'active' && (
            <Callout tone="danger" title={keyState(k) === 'revoked' ? 'Revoked' : 'Expired'}>
              {keyState(k) === 'revoked' ? `Revoked ${dateTime(k.revokedAt)}. Requests with this key are rejected.` : `Expired ${dateTime(k.expiresAt)}.`}
            </Callout>
          )}
          <KeyValue
            items={[
              { label: 'Key', value: <Mono>{`${k.prefix}…`}</Mono> },
              { label: 'Key ID', value: <Mono copy>{k.id}</Mono> },
              { label: 'Organization', value: k.orgId ? <Link className="text-primary hover:underline" to={`/customers/organizations/${k.orgId}`}>{k.orgName ?? k.orgId}</Link> : 'All organizations' },
              { label: 'Rate limit', value: k.rateLimitPerMinute ? `${num(k.rateLimitPerMinute)} / minute` : 'Platform default' },
              { label: 'Allowed IPs', value: k.allowedIps.length ? <span className="font-mono text-xs">{k.allowedIps.join(', ')}</span> : 'Any address' },
              { label: 'Expires', value: k.expiresAt ? dateTime(k.expiresAt) : 'Never' },
              { label: 'Last used', value: k.lastUsedAt ? `${dateTime(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'Never' },
              { label: 'Created', value: dateTime(k.createdAt) },
            ]}
          />
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Scopes</p>
            {k.scopes.includes('*') ? (
              <Callout tone="warning" title="Full access">This key can call every integration API endpoint, including ones added later.</Callout>
            ) : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {k.scopes.map((s) => (
                  <li key={s} className="text-sm">
                    <code className="font-mono text-xs">{s}</code>
                    {descriptions.get(s) && <span className="block text-xs text-muted-foreground">{descriptions.get(s)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Usage</p>
            <KeyUsage keyId={k.id} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function SecretKeysTab({ state, setState, onSecret }: { state: Record<string, string | number | undefined>; setState: (p: Record<string, string | undefined>) => void; onSecret: (s: Secret) => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<ApiKey | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [rolling, setRolling] = useState<ApiKey | null>(null);
  const keys = useQuery({
    queryKey: ['developers', 'api-keys', state.revoked === 'true'],
    queryFn: () => api.get<{ data: ApiKey[] }>('/api/admin/api-keys', { includeRevoked: state.revoked === 'true' ? 'true' : undefined }),
    placeholderData: keepPreviousData,
  });
  const revoke = useAction((k: ApiKey) => api.delete(`/api/admin/api-keys/${k.id}`), { success: 'API key revoked', invalidate: [['developers', 'api-keys']], onSuccess: () => setDetail(null) });

  const askRevoke = async (k: ApiKey) => {
    const { confirmed } = await confirm({
      title: `Revoke ${k.name}?`,
      description: 'Requests using this key are rejected immediately. This cannot be undone; create or roll a key to restore access.',
      tone: 'danger',
      confirmLabel: 'Revoke key',
      typeToConfirm: k.mode === 'live' ? k.prefix : undefined,
    });
    if (confirmed) revoke.mutate(k);
  };

  const q = String(state.q ?? '').toLowerCase();
  const rows = (keys.data?.data ?? []).filter((k) => (!state.mode || k.mode === state.mode) && (!q || k.name.toLowerCase().includes(q) || k.prefix.toLowerCase().includes(q) || (k.orgName ?? '').toLowerCase().includes(q)));
  const manage = can('developers.keys.manage');

  const columns: Column<ApiKey>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (k) => (
        <button type="button" className="min-w-0 text-left" onClick={() => setDetail(k)}>
          <span className="block truncate font-medium hover:underline">{k.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{k.orgId ? (k.orgName ?? k.orgId) : 'All organizations'}</span>
        </button>
      ),
    },
    { key: 'key', header: 'Key', cell: (k) => <code className="font-mono text-xs">{k.prefix}…</code> },
    { key: 'mode', header: 'Mode', cell: (k) => <Badge tone={k.mode === 'live' ? 'success' : 'warning'}>{k.mode}</Badge> },
    { key: 'scopes', header: 'Scopes', cell: (k) => <ScopeList scopes={k.scopes} /> },
    { key: 'limit', header: 'Rate limit', priority: 'low', cell: (k) => (k.rateLimitPerMinute ? `${num(k.rateLimitPerMinute)}/min` : <span className="text-muted-foreground">default</span>) },
    { key: 'used', header: 'Last used', cell: (k) => (k.lastUsedAt ? <When value={k.lastUsedAt} /> : <span className="text-muted-foreground">never</span>) },
    {
      key: 'status',
      header: 'Status',
      cell: (k) => {
        const s = keyState(k);
        const soon = s === 'active' && k.expiresAt && new Date(k.expiresAt).getTime() - Date.now() < WEEK;
        return (
          <span className="flex flex-wrap items-center gap-1">
            <StatusBadge status={s} />
            {soon && <Badge tone="warning">expires <When value={k.expiresAt} /></Badge>}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (k) => (
        <Menu
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${k.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          }
          items={[
            { label: 'Details & usage', onSelect: () => setDetail(k) },
            { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(k), hidden: !manage || keyState(k) !== 'active' },
            { label: 'Roll secret', icon: <RotateCw className="size-4" />, onSelect: () => setRolling(k), hidden: !manage || keyState(k) !== 'active' },
            { separator: true, label: '', hidden: !manage || keyState(k) !== 'active' },
            { label: 'Revoke', danger: true, onSelect: () => void askRevoke(k), hidden: !manage || keyState(k) !== 'active' },
          ]}
        />
      ),
    },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={String(state.q ?? '')} onChange={(v) => setState({ q: v })} placeholder="Search name, prefix, organization…" className="w-full sm:w-72" />
        <Select aria-label="Environment" className="w-auto" value={String(state.mode ?? '')} onChange={(e) => setState({ mode: e.target.value })} placeholder="Live and test" options={[{ value: 'live', label: 'Live' }, { value: 'test', label: 'Test' }]} />
        <Checkbox className="ml-1" checked={state.revoked === 'true'} onChange={(e) => setState({ revoked: e.target.checked ? 'true' : undefined })} label="Show revoked" />
      </Toolbar>
      {keys.error ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : (
        <DataTable
          caption="API keys"
          columns={columns}
          rows={rows}
          rowKey={(k) => k.id}
          loading={keys.isLoading}
          fetching={keys.isFetching && !keys.isLoading}
          empty={<EmptyState icon={<KeyRound />} title={q || state.mode ? 'No keys match' : 'No API keys yet'} description={q || state.mode ? undefined : 'Create a key so your backend can register users, check entitlements and record usage.'} />}
        />
      )}
      <KeyDetailDialog apiKey={detail} onClose={() => setDetail(null)} onEdit={(k) => { setDetail(null); setEditing(k); }} onRoll={(k) => { setDetail(null); setRolling(k); }} onRevoke={(k) => void askRevoke(k)} />
      {editing && <KeyFormDialog open onOpenChange={(o) => !o && setEditing(null)} existing={editing} />}
      {rolling && <RollDialog apiKey={rolling} open onOpenChange={(o) => !o && setRolling(null)} onRolled={onSecret} />}
    </Card>
  );
}

function CustomerKeysTab() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [filter, setFilter] = useState('');
  const f = filter.trim();
  const query = f.startsWith('org_') ? { orgId: f } : f ? { userId: f } : {};
  const keys = useQuery({ queryKey: ['developers', 'customer-keys', query], queryFn: () => api.get<{ data: CustomerKey[] }>('/api/admin/customer-keys', query), placeholderData: keepPreviousData });
  const revoke = useAction((id: string) => api.delete(`/api/admin/customer-keys/${id}`), { success: 'Customer key revoked', invalidate: [['developers', 'customer-keys']] });
  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by user ID (usr_…) or organization ID (org_…)" className="w-full sm:w-96" />
        <span className="text-xs text-muted-foreground">Keys your customers create to use your product's API. Showing the latest 200.</span>
      </Toolbar>
      {keys.error ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : (
        <DataTable
          caption="Customer API keys"
          rows={keys.data?.data}
          loading={keys.isLoading}
          fetching={keys.isFetching && !keys.isLoading}
          rowKey={(k) => k.id}
          empty={<EmptyState icon={<KeyRound />} title="No customer keys" description="Your backend issues them with the customer_keys:write scope (steward.customerKeys.issue)." />}
          columns={[
            { key: 'name', header: 'Name', cell: (k) => <span className="font-medium">{k.name}</span> },
            { key: 'prefix', header: 'Key', cell: (k) => <code className="font-mono text-xs">{k.prefix}…</code> },
            {
              key: 'owner',
              header: 'Owner',
              cell: (k) =>
                k.org_id ? (
                  <Link className="font-mono text-xs text-primary hover:underline" to={`/customers/organizations/${k.org_id}`}>{k.org_id}</Link>
                ) : k.user_id ? (
                  <Link className="font-mono text-xs text-primary hover:underline" to={`/customers/users/${k.user_id}`}>{k.user_id}</Link>
                ) : (
                  '—'
                ),
            },
            { key: 'scopes', header: 'Scopes', priority: 'low', cell: (k) => (k.scopes.length ? <ScopeList scopes={k.scopes} /> : <span className="text-muted-foreground">—</span>) },
            { key: 'meter', header: 'Billed meter', priority: 'low', cell: (k) => (k.meter_key ? <code className="font-mono text-xs">{k.meter_key}</code> : <span className="text-muted-foreground">—</span>) },
            { key: 'used', header: 'Last used', cell: (k) => (k.last_used_at ? <When value={k.last_used_at} /> : <span className="text-muted-foreground">never</span>) },
            { key: 'status', header: 'Status', cell: (k) => <StatusBadge status={keyState({ revokedAt: k.revoked_at, expiresAt: k.expires_at })} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (k) =>
                can('developers.customer_keys.manage') && keyState({ revokedAt: k.revoked_at, expiresAt: k.expires_at }) === 'active' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-danger"
                    onClick={async () => {
                      const { confirmed } = await confirm({ title: `Revoke ${k.name}?`, description: "The customer's integration using this key stops working immediately.", tone: 'danger', confirmLabel: 'Revoke' });
                      if (confirmed) revoke.mutate(k.id);
                    }}
                  >
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </Card>
  );
}

export default function ApiKeysPage() {
  const { can, me } = useAuth();
  const [state, setState] = useUrlState(DEFAULTS);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const tab = String(state.tab ?? 'keys');

  return (
    <>
      <PageHeader
        title="API keys"
        description="Secret keys your backend uses to call the integration API. Keep them on your servers, never in browser or mobile code."
        actions={
          can('developers.keys.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Create key
            </Button>
          )
        }
      />
      {me?.admin.orgScope && (
        <div className="mb-4">
          <Callout tone="info" title="Organization-scoped access">You only see keys limited to your organizations, and new keys must be limited to one of them.</Callout>
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={(v) => setState({ tab: v === 'keys' ? undefined : v, q: undefined, mode: undefined })}
        tabs={[
          { value: 'keys', label: 'Secret keys', content: tab === 'keys' && <SecretKeysTab state={state} setState={setState} onSecret={setSecret} /> },
          { value: 'customer', label: 'Customer keys', hidden: !can('developers.customer_keys.view'), content: tab === 'customer' && <CustomerKeysTab /> },
        ]}
      />
      <Card className="mt-4" title="Using a key">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Send the key as a bearer token. Each request is checked against the key's scopes, IP allowlist and rate limit, and logged under{' '}
              <Link to="/developers/logs" className="text-primary hover:underline">
                API logs
              </Link>
              .
            </p>
            <p className="flex items-start gap-1.5">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              Roll a key immediately if it may have leaked; the old secret keeps working only for the grace period you choose.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-ui border bg-muted/50 p-3 font-mono text-xs leading-relaxed">{`curl ${window.location.origin}/api/v1/ping \\
  -H "Authorization: Bearer $STEWARD_API_KEY"`}</pre>
        </div>
      </Card>
      {creating && <KeyFormDialog open onOpenChange={setCreating} onCreated={setSecret} />}
      <SecretOnceDialog open={Boolean(secret)} onClose={() => setSecret(null)} title={secret?.title ?? ''} secret={secret?.secret ?? null} note={secret?.note} />
    </>
  );
}
