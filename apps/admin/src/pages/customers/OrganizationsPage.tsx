import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Pagination, SearchInput, Select, StatusBadge, Toolbar, When, type Column } from '../../components/ui';
import { CustomFieldInputs, UserPicker, useCustomFieldDefs, type PickedUser } from './shared';

export interface OrgRow {
  id: string;
  external_id: string | null;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  owner_user_id: string | null;
  billing_email: string | null;
  seat_limit: number | null;
  custom_domain: string | null;
  custom_fields: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  member_count?: number;
  owner_email?: string | null;
  owner_name?: string | null;
}

const DEFAULTS = { q: '', status: '', sort: 'created_at', order: 'desc', page: 1, pageSize: 25 };

function CreateOrganizationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const defs = useCustomFieldDefs('organization', open);
  const [form, setForm] = useState({ name: '', slug: '', externalId: '', billingEmail: '', seatLimit: '', customDomain: '', tags: '' });
  const [owner, setOwner] = useState<PickedUser | null>(null);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    () =>
      api.post<OrgRow>('/api/admin/organizations', {
        name: form.name,
        slug: form.slug || undefined,
        externalId: form.externalId || undefined,
        ownerUserId: owner?.id,
        billingEmail: form.billingEmail || undefined,
        seatLimit: form.seatLimit ? Number(form.seatLimit) : undefined,
        customDomain: form.customDomain || undefined,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        customFields: Object.keys(custom).length ? custom : undefined,
      }),
    {
      success: 'Organization created',
      invalidate: [['organizations']],
      onSuccess: (org) => {
        onOpenChange(false);
        navigate(`/customers/organizations/${org.id}`);
      },
      onError: (err) => setError(errorMessage(err)),
    },
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New organization"
      description="Organizations group users into a team or company account with shared billing, seats and usage."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-org" loading={create.isPending}>
            Create organization
          </Button>
        </>
      }
    >
      <form
        id="create-org"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Name" htmlFor="co-name" required>
          <Input id="co-name" value={form.name} onChange={set('name')} required autoFocus />
        </Field>
        <Field label="Slug" htmlFor="co-slug" hint="Generated from the name when empty">
          <Input id="co-slug" value={form.slug} onChange={set('slug')} placeholder="acme-inc" />
        </Field>
        {can('customers.users.view') && (
          <Field label="Owner" htmlFor="co-owner" hint="Optional. The owner becomes the first member." className="sm:col-span-2">
            <UserPicker id="co-owner" value={owner} onChange={setOwner} />
          </Field>
        )}
        <Field label="Billing email" htmlFor="co-billing">
          <Input id="co-billing" type="email" value={form.billingEmail} onChange={set('billingEmail')} />
        </Field>
        <Field label="Seat limit" htmlFor="co-seats" hint="Leave empty for unlimited">
          <Input id="co-seats" type="number" min={1} step={1} value={form.seatLimit} onChange={set('seatLimit')} />
        </Field>
        <Field label="External ID" htmlFor="co-ext" hint="Your application's own ID">
          <Input id="co-ext" value={form.externalId} onChange={set('externalId')} />
        </Field>
        <Field label="Custom domain" htmlFor="co-domain" hint="For white-label portals, e.g. app.acme.com">
          <Input id="co-domain" value={form.customDomain} onChange={set('customDomain')} />
        </Field>
        <Field label="Tags" htmlFor="co-tags" hint="Comma separated" className="sm:col-span-2">
          <Input id="co-tags" value={form.tags} onChange={set('tags')} />
        </Field>
        <CustomFieldInputs defs={defs.data?.data ?? []} value={custom} onChange={setCustom} idPrefix="co-cf" />
      </form>
    </Modal>
  );
}

export default function OrganizationsPage() {
  const { can } = useAuth();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);
  const [creating, setCreating] = useState(false);

  // Keep the URL in sync with the debounced search box.
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = useMemo(() => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(state)) if (v !== '' && v !== undefined) out[k] = v as string | number;
    return out;
  }, [state]);

  const orgs = useQuery({
    queryKey: ['organizations', query],
    queryFn: ({ signal }) => api.get<Page<OrgRow>>('/api/admin/organizations', query, signal),
    placeholderData: keepPreviousData,
  });

  const filtered = Boolean(state.q || state.status);

  const columns: Column<OrgRow>[] = [
    {
      key: 'name',
      header: 'Organization',
      sortable: true,
      cell: (o) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-ui-sm bg-primary/10 text-2xs font-semibold text-primary" aria-hidden="true">
            {o.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{o.name}</span>
            <span className="block truncate font-mono text-xs font-normal text-muted-foreground">{o.slug}</span>
          </span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
    {
      key: 'owner',
      header: 'Owner',
      cell: (o) =>
        o.owner_email ? (
          <span className="block min-w-0">
            <span className="block truncate">{o.owner_name || o.owner_email}</span>
            {o.owner_name && <span className="block truncate text-xs text-muted-foreground">{o.owner_email}</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'members',
      header: 'Members',
      sortable: true,
      align: 'right',
      cell: (o) => (
        <span className="tabular">
          {num(o.member_count ?? 0)}
          {o.seat_limit ? <span className="text-muted-foreground"> / {num(o.seat_limit)}</span> : null}
        </span>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      priority: 'low',
      cell: (o) =>
        o.tags.length ? (
          <span className="flex flex-wrap gap-1">
            {o.tags.slice(0, 3).map((t) => (
              <Badge key={t} tone="primary">
                {t}
              </Badge>
            ))}
            {o.tags.length > 3 && <Badge>+{o.tags.length - 3}</Badge>}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'created_at', header: 'Created', sortable: true, cell: (o) => <When value={o.created_at} /> },
  ];

  return (
    <>
      <PageHeader
        title="Organizations"
        description="Team and company accounts: members, seats, shared subscriptions and usage."
        actions={
          can('customers.organizations.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New organization
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, slug, ID…" className="w-full sm:w-72" />
          <Select
            aria-label="Status"
            className="w-auto"
            value={String(state.status)}
            onChange={(e) => setState({ status: e.target.value })}
            placeholder="Any status"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'suspended', label: 'Suspended' },
            ]}
          />
          {filtered && (
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
        </Toolbar>
        {orgs.error ? (
          <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />
        ) : (
          <DataTable
            caption="Organizations"
            columns={columns}
            rows={orgs.data?.data}
            rowKey={(o) => o.id}
            rowHref={(o) => `/customers/organizations/${o.id}`}
            loading={orgs.isLoading}
            fetching={orgs.isFetching && !orgs.isLoading}
            sort={String(state.sort)}
            order={state.order as 'asc' | 'desc'}
            onSort={(sort, order) => setState({ sort, order })}
            empty={
              filtered ? (
                <EmptyState
                  title="No organizations match these filters"
                  action={
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch('');
                        reset();
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={<Building2 />} title="No organizations yet" description="Organizations are created by your application through the API or SDK, or here." />
              )
            }
          />
        )}
        {orgs.data && <Pagination page={orgs.data.page} pageSize={orgs.data.pageSize} total={orgs.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      {creating && <CreateOrganizationDialog open={creating} onOpenChange={setCreating} />}
    </>
  );
}
