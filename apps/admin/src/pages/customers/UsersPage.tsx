import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Archive, Download, Filter, Plus, RotateCcw, Upload, UserPlus } from 'lucide-react';
import { api, download, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { useBootstrap } from '../../components/layout/AppShell';
import { SavedViews } from '../../components/SavedViews';
import { ImportUsersDialog } from '../user-management/ImportUsersDialog';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Popover,
  SearchInput,
  Select,
  StatusBadge,
  Toolbar,
  When,
  Money,
  useConfirm,
  useToast,
  type Column,
} from '../../components/ui';

export interface UserRow {
  id: string;
  external_id: string | null;
  email: string;
  email_verified_at: string | null;
  name: string | null;
  avatar_url: string | null;
  status: string;
  status_reason: string | null;
  country: string | null;
  registration_source: string | null;
  tags: string[];
  lifetime_revenue: number;
  last_active_at: string | null;
  created_at: string;
  deleted_at: string | null;
  archived_at: string | null;
  archived_reason: string | null;
  merged_into_id: string | null;
  merged_at: string | null;
  plan?: { name: string; key: string; status: string };
}

const DEFAULTS = {
  q: '',
  status: '',
  plan: '',
  subscriptionStatus: '',
  verified: '',
  country: '',
  source: '',
  tag: '',
  activeWithinDays: '',
  inactiveForDays: '',
  createdFrom: '',
  createdTo: '',
  archived: '',
  sort: 'created_at',
  order: 'desc',
  page: 1,
  pageSize: 25,
};
const FILTER_KEYS = ['status', 'plan', 'subscriptionStatus', 'verified', 'country', 'source', 'tag', 'activeWithinDays', 'inactiveForDays', 'createdFrom', 'createdTo', 'archived'] as const;

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', name: '', externalId: '', country: '', tags: '', marketingConsent: false, emailVerified: false });
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    () =>
      api.post<{ id: string }>('/api/admin/users', {
        email: form.email,
        name: form.name || undefined,
        externalId: form.externalId || undefined,
        country: form.country || undefined,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        marketingConsent: form.marketingConsent,
        emailVerified: form.emailVerified,
      }),
    {
      success: 'User created',
      invalidate: [['users']],
      onSuccess: (u) => {
        onOpenChange(false);
        navigate(`/customers/users/${u.id}`);
      },
      onError: (err) => setError(errorMessage(err)),
    },
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New user"
      description="Users normally arrive from your application through the API or SDK. Create one here for support or testing."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-user" loading={create.isPending}>
            Create user
          </Button>
        </>
      }
    >
      <form
        id="create-user"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Email" htmlFor="cu-email" required>
          <Input id="cu-email" type="email" value={form.email} onChange={set('email')} required autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="cu-name">
            <Input id="cu-name" value={form.name} onChange={set('name')} />
          </Field>
          <Field label="External ID" htmlFor="cu-ext" hint="Your application's own user ID">
            <Input id="cu-ext" value={form.externalId} onChange={set('externalId')} />
          </Field>
          <Field label="Country" htmlFor="cu-country" hint="Two-letter code, e.g. DE">
            <Input id="cu-country" value={form.country} onChange={set('country')} maxLength={2} />
          </Field>
          <Field label="Tags" htmlFor="cu-tags" hint="Comma separated">
            <Input id="cu-tags" value={form.tags} onChange={set('tags')} />
          </Field>
        </div>
        <Checkbox checked={form.emailVerified} onChange={set('emailVerified')} label="Email address already verified" />
        <Checkbox checked={form.marketingConsent} onChange={set('marketingConsent')} label="Consented to marketing email" description="Only tick this if the customer gave consent." />
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const { can } = useAuth();
  const boot = useBootstrap();
  const toast = useToast();
  const confirm = useConfirm();
  const currency = boot.data?.locale.currency ?? 'USD';
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  // Two-way sync between the debounced search box and the URL (typing, back/forward, saved views).
  const pushed = useRef(String(state.q ?? ''));
  useEffect(() => {
    if (q === pushed.current) return;
    pushed.current = q;
    setState({ q });
  }, [q, setState]);
  useEffect(() => {
    const fromUrl = String(state.q ?? '');
    if (fromUrl === pushed.current) return;
    pushed.current = fromUrl;
    setSearch(fromUrl);
  }, [state.q]);

  const query = useMemo(() => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(state)) if (v !== '' && v !== undefined) out[k] = v as string | number;
    return out;
  }, [state]);

  const users = useQuery({
    queryKey: ['users', query],
    queryFn: ({ signal }) => api.get<Page<UserRow>>('/api/admin/users', query, signal),
    placeholderData: keepPreviousData,
  });
  const plans = useQuery({
    queryKey: ['products', 'plan'],
    queryFn: () => api.get<{ data: { key: string; name: string }[] }>('/api/admin/products', { kind: 'plan' }),
    enabled: can('catalog.products.view'),
    staleTime: 5 * 60_000,
  });

  const bulk = useAction((body: { action: string; tag?: string; reason?: string }) => api.post<{ succeeded: number; failed: { id: string; error?: string }[]; total: number }>('/api/admin/users/bulk', { ids: [...selected], ...body }), {
    invalidate: [['users']],
    onSuccess: (r) => {
      if (r.failed.length) toast.error(`${r.succeeded} of ${r.total} updated`, r.failed[0]?.error);
      else toast.success(`${r.succeeded} user${r.succeeded === 1 ? '' : 's'} updated`);
      setSelected(new Set());
    },
  });

  const runBulk = async (action: string, label: string, opts: { reason?: boolean; tag?: boolean; danger?: boolean } = {}) => {
    const n = selected.size;
    const { confirmed, reason } = await confirm({
      title: `${label} ${n} user${n === 1 ? '' : 's'}?`,
      tone: opts.danger ? 'danger' : 'default',
      confirmLabel: label,
      reason: opts.tag ? { label: 'Tag', required: true, placeholder: 'e.g. vip' } : opts.reason ? { label: 'Reason (recorded in the audit log)', required: true } : undefined,
    });
    if (!confirmed) return;
    bulk.mutate(opts.tag ? { action, tag: reason } : { action, reason });
  };

  const activeFilters = FILTER_KEYS.filter((k) => state[k] !== '' && state[k] !== undefined);

  const columns: Column<UserRow>[] = [
    {
      key: 'name',
      header: 'User',
      sortable: true,
      cell: (u) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={u.name} email={u.email} src={u.avatar_url} size="sm" />
          <span className="min-w-0">
            <span className="block truncate">{u.name || u.email}</span>
            {u.name && <span className="block truncate text-xs font-normal text-muted-foreground">{u.email}</span>}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge status={u.merged_into_id ? 'merged' : u.deleted_at ? 'deleted' : u.status} />
          {u.archived_at && !u.deleted_at && <StatusBadge status="archived" />}
        </span>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      cell: (u) =>
        u.plan ? (
          <span className="flex items-center gap-1.5">
            {u.plan.name}
            {u.plan.status !== 'active' && <StatusBadge status={u.plan.status} />}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'lifetime_revenue', header: 'Revenue', sortable: true, align: 'right', cell: (u) => <Money amount={u.lifetime_revenue} currency={currency} /> },
    { key: 'country', header: 'Country', priority: 'low', cell: (u) => u.country ?? <span className="text-muted-foreground">—</span> },
    { key: 'created_at', header: 'Signed up', sortable: true, cell: (u) => <When value={u.created_at} /> },
    { key: 'last_active_at', header: 'Last active', sortable: true, priority: 'low', cell: (u) => <When value={u.last_active_at} /> },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone registered in your application, with plan, revenue and activity."
        actions={
          <>
            {can('customers.users.export') && (
              <Button
                variant="outline"
                icon={<Download className="size-4" />}
                onClick={() => {
                  const { page: _p, pageSize: _s, ...filters } = query;
                  download('/api/admin/users/export.csv', filters, 'users.csv').catch((err) => toast.error('Export failed', errorMessage(err)));
                }}
              >
                Export CSV
              </Button>
            )}
            {can('customers.users.import') && (
              <Button variant="outline" icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>
                Import
              </Button>
            )}
            {can('customers.users.create') && (
              <Button icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>
                New user
              </Button>
            )}
          </>
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, email, ID…" className="w-full sm:w-72" />
          <Select
            aria-label="Status"
            className="w-auto"
            value={String(state.status)}
            onChange={(e) => setState({ status: e.target.value })}
            placeholder="Any status"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'pending', label: 'Pending' },
              { value: 'suspended', label: 'Suspended' },
              { value: 'banned', label: 'Banned' },
              { value: 'deleted', label: 'Deleted' },
            ]}
          />
          {plans.data && plans.data.data.length > 0 && (
            <Select aria-label="Plan" className="w-auto" value={String(state.plan)} onChange={(e) => setState({ plan: e.target.value })} placeholder="Any plan" options={plans.data.data.map((p) => ({ value: p.key, label: p.name }))} />
          )}
          <Popover
            align="start"
            className="w-[min(22rem,calc(100vw-2rem))] p-4"
            trigger={
              <Button variant="outline" icon={<Filter className="size-4" />}>
                More filters{activeFilters.length > 0 && <Badge tone="primary">{activeFilters.length}</Badge>}
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email verified" htmlFor="f-verified">
                <Select id="f-verified" value={String(state.verified)} onChange={(e) => setState({ verified: e.target.value })} placeholder="Any" options={[{ value: 'true', label: 'Verified' }, { value: 'false', label: 'Not verified' }]} />
              </Field>
              <Field label="Subscription" htmlFor="f-sub">
                <Select
                  id="f-sub"
                  value={String(state.subscriptionStatus)}
                  onChange={(e) => setState({ subscriptionStatus: e.target.value })}
                  placeholder="Any"
                  options={['trialing', 'active', 'past_due', 'paused', 'canceled', 'unpaid'].map((s) => ({ value: s, label: s.replace('_', ' ') }))}
                />
              </Field>
              <Field label="Country" htmlFor="f-country">
                <Input id="f-country" value={String(state.country)} onChange={(e) => setState({ country: e.target.value.toUpperCase().slice(0, 2) })} placeholder="DE" />
              </Field>
              <Field label="Tag" htmlFor="f-tag">
                <Input id="f-tag" value={String(state.tag)} onChange={(e) => setState({ tag: e.target.value })} placeholder="vip" />
              </Field>
              <Field label="Source" htmlFor="f-source" className="col-span-2">
                <Input id="f-source" value={String(state.source)} onChange={(e) => setState({ source: e.target.value })} placeholder="e.g. google, referral" />
              </Field>
              <Field label="Active in last (days)" htmlFor="f-active">
                <Input id="f-active" type="number" min={1} value={String(state.activeWithinDays)} onChange={(e) => setState({ activeWithinDays: e.target.value })} />
              </Field>
              <Field label="Inactive for (days)" htmlFor="f-inactive">
                <Input id="f-inactive" type="number" min={1} value={String(state.inactiveForDays)} onChange={(e) => setState({ inactiveForDays: e.target.value })} />
              </Field>
              <Field label="Signed up from" htmlFor="f-from">
                <Input id="f-from" type="date" value={String(state.createdFrom)} onChange={(e) => setState({ createdFrom: e.target.value })} />
              </Field>
              <Field label="Signed up to" htmlFor="f-to">
                <Input id="f-to" type="date" value={String(state.createdTo)} onChange={(e) => setState({ createdTo: e.target.value })} />
              </Field>
              <Field label="Archived customers" htmlFor="f-archived" className="col-span-2" hint="Long-inactive customers are archived and hidden unless you include them">
                <Select
                  id="f-archived"
                  value={String(state.archived)}
                  onChange={(e) => setState({ archived: e.target.value })}
                  placeholder="Hide archived"
                  options={[
                    { value: 'include', label: 'Include archived' },
                    { value: 'only', label: 'Only archived' },
                  ]}
                />
              </Field>
            </div>
          </Popover>
          {(activeFilters.length > 0 || state.q) && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                reset();
              }}
            >
              Clear
            </Button>
          )}
          <div className="ml-auto">
            <SavedViews
              resource="users"
              state={state}
              onApply={(v) => {
                setSearch(String(v.q ?? ''));
                setState(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, v[k] ?? undefined])));
              }}
            />
          </div>
        </Toolbar>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
            <span className="font-medium">{selected.size} selected</span>
            {can('customers.users.suspend') && (
              <>
                <Button size="sm" variant="outline" onClick={() => void runBulk('suspend', 'Suspend', { reason: true })}>
                  Suspend
                </Button>
                <Button size="sm" variant="outline" onClick={() => void runBulk('reactivate', 'Reactivate')}>
                  Reactivate
                </Button>
              </>
            )}
            {can('customers.users.ban') && (
              <Button size="sm" variant="outline" onClick={() => void runBulk('ban', 'Ban', { reason: true, danger: true })}>
                Ban
              </Button>
            )}
            {can('customers.users.edit') && (
              <>
                <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => void runBulk('tag', 'Add tag', { tag: true })}>
                  Tag
                </Button>
                <Button size="sm" variant="outline" onClick={() => void runBulk('untag', 'Remove tag', { tag: true })}>
                  Untag
                </Button>
                {state.archived === 'only' ? (
                  <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={() => void runBulk('unarchive', 'Restore')}>
                    Restore
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" icon={<Archive className="size-3.5" />} onClick={() => void runBulk('archive', 'Archive')}>
                    Archive
                  </Button>
                )}
              </>
            )}
            {can('customers.sessions.revoke') && (
              <Button size="sm" variant="outline" onClick={() => void runBulk('revoke_sessions', 'Sign out')}>
                Sign out everywhere
              </Button>
            )}
            {can('customers.users.delete') && (
              <Button size="sm" variant="outline" className="text-danger" onClick={() => void runBulk('delete', 'Delete', { danger: true })}>
                Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {users.error ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <DataTable
            caption="Users"
            columns={columns}
            rows={users.data?.data}
            rowKey={(u) => u.id}
            rowHref={(u) => `/customers/users/${u.id}`}
            loading={users.isLoading}
            fetching={users.isFetching && !users.isLoading}
            sort={String(state.sort)}
            order={state.order as 'asc' | 'desc'}
            onSort={(sort, order) => setState({ sort, order })}
            selectable={can('customers.users.edit') || can('customers.users.suspend')}
            selected={selected}
            onSelectedChange={setSelected}
            empty={
              activeFilters.length || state.q ? (
                <EmptyState title="No users match these filters" action={<Button variant="outline" onClick={() => { setSearch(''); reset(); }}>Clear filters</Button>} />
              ) : (
                <EmptyState title="No users yet" description="Register users from your application with the SDK or the /api/v1/users endpoint." />
              )
            }
          />
        )}
        {users.data && <Pagination page={users.data.page} pageSize={users.data.pageSize} total={users.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      <ImportUsersDialog open={importing} onOpenChange={setImporting} />
    </>
  );
}
