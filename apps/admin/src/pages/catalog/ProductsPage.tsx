import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Package, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, SearchInput, Select, StatusBadge, Toolbar, type Column } from '../../components/ui';
import { ProductDialog } from './ProductForm';
import { KIND_LABEL, KIND_OPTIONS, type Product } from './shared';

const DEFAULTS = { q: '', kind: '', status: '' };

export default function ProductsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
  }, [q]); // only the debounced search text drives the URL

  const query = useMemo(() => ({ q: state.q || undefined, kind: state.kind || undefined, status: state.status || undefined }), [state.q, state.kind, state.status]);
  const products = useQuery({
    queryKey: ['products', 'list', query],
    queryFn: ({ signal }) => api.get<{ data: Product[] }>('/api/admin/products', query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = Boolean(state.q || state.kind || state.status);

  const columns: Column<Product>[] = [
    {
      key: 'name',
      header: 'Product',
      cell: (p) => (
        <span className="min-w-0">
          <span className="block truncate">{p.name}</span>
          <span className="block truncate font-mono text-xs font-normal text-muted-foreground">{p.key}</span>
        </span>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={p.kind === 'plan' ? 'primary' : 'neutral'}>{KIND_LABEL[p.kind]}</Badge>
          {p.plan_type && p.plan_type !== 'paid' && <Badge>{p.plan_type}</Badge>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge status={p.status} />
          {!p.is_public && p.status !== 'archived' && <Badge>hidden</Badge>}
        </span>
      ),
    },
    { key: 'prices', header: 'Prices', align: 'right', cell: (p) => <span className="tabular">{num(p.price_count ?? 0)}</span> },
    { key: 'features', header: 'Features', align: 'right', priority: 'low', cell: (p) => <span className="tabular">{num(p.feature_count ?? 0)}</span> },
    { key: 'subscribers', header: 'Active subscribers', align: 'right', cell: (p) => <span className="tabular">{p.kind === 'plan' || p.kind === 'addon' ? num(p.active_subscriptions ?? 0) : '—'}</span> },
    { key: 'trial', header: 'Trial', priority: 'low', cell: (p) => (p.trial_days ? `${p.trial_days} days` : <span className="text-muted-foreground">—</span>) },
  ];

  return (
    <>
      <PageHeader
        title="Plans & products"
        description="Plans, add-ons, one-time products and credit packs, with their prices and the features and limits they unlock."
        actions={
          can('catalog.products.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New product
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name or key…" className="w-full sm:w-64" />
          <Select aria-label="Type" className="w-auto" value={String(state.kind)} onChange={(e) => setState({ kind: e.target.value })} placeholder="All types" options={KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label }))} />
          <Select
            aria-label="Status"
            className="w-auto"
            value={String(state.status)}
            onChange={(e) => setState({ status: e.target.value })}
            placeholder="Active and draft"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'draft', label: 'Draft' },
              { value: 'archived', label: 'Archived' },
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
        {products.error ? (
          <ErrorState error={products.error} onRetry={() => void products.refetch()} />
        ) : (
          <DataTable
            caption="Products"
            columns={columns}
            rows={products.data?.data}
            rowKey={(p) => p.id}
            rowHref={(p) => `/catalog/products/${p.id}`}
            loading={products.isLoading}
            fetching={products.isFetching && !products.isLoading}
            empty={
              filtered ? (
                <EmptyState title="No products match these filters" />
              ) : (
                <EmptyState
                  icon={<Package />}
                  title="No products yet"
                  description="Start with your plans (for example Free, Pro and Team), then add prices and the features each one includes."
                  action={can('catalog.products.manage') && <Button onClick={() => setCreating(true)}>Create your first plan</Button>}
                />
              )
            }
          />
        )}
      </Card>
      {creating && <ProductDialog open={creating} onOpenChange={setCreating} onSaved={(p) => navigate(`/catalog/products/${p.id}?tab=pricing`)} />}
    </>
  );
}
