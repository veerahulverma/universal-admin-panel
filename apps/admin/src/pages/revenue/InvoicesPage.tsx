import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { date, money } from '../../lib/format';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Toolbar,
  When,
  type Column,
} from '../../components/ui';
import { CreateInvoiceDialog } from './CreateInvoiceDialog';
import { INVOICE_STATUSES, SubjectIcon, cleanQuery, statusOptions } from './shared';

export interface InvoiceRow {
  id: string;
  number: string | null;
  status: string;
  billing_reason: string;
  currency: string;
  total: number;
  amount_due: number;
  amount_paid: number;
  amount_refunded: number;
  due_at: string | null;
  issued_at: string | null;
  paid_at: string | null;
  subject_type: 'user' | 'organization';
  subject_id: string;
  subscription_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  created_at: string;
}

const DEFAULTS = { q: '', status: '', overdue: '', subscriptionId: '', userId: '', orgId: '', page: 1, pageSize: 25 };

export const REASONS: Record<string, string> = { checkout: 'Checkout', subscription_cycle: 'Renewal', subscription_update: 'Plan change', manual: 'Manual' };

export function isOverdue(i: Pick<InvoiceRow, 'status' | 'due_at'>): boolean {
  return i.status === 'open' && Boolean(i.due_at) && new Date(i.due_at!).getTime() < Date.now();
}

export default function InvoicesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
  }, [q]);

  const query = useMemo(() => cleanQuery(state), [state]);
  const list = useQuery({
    queryKey: ['invoices', query],
    queryFn: ({ signal }) => api.get<Page<InvoiceRow>>('/api/admin/invoices', query, signal),
    placeholderData: keepPreviousData,
  });

  const scoped = state.subscriptionId || state.userId || state.orgId;
  const filtered = Boolean(state.q || state.status || state.overdue || scoped);

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'Number', cell: (i) => <span className="font-mono text-xs">{i.number ?? 'Draft'}</span> },
    {
      key: 'customer',
      header: 'Customer',
      cell: (i) => (
        <span className="flex min-w-0 items-center gap-2">
          <SubjectIcon type={i.subject_type} />
          <span className="min-w-0">
            <span className="block truncate">{i.customer_name || i.customer_email || i.subject_id}</span>
            {i.customer_name && i.customer_email && <span className="block truncate text-xs text-muted-foreground">{i.customer_email}</span>}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (i) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge status={i.status} />
          {isOverdue(i) && <Badge tone="danger">overdue</Badge>}
          {i.amount_refunded > 0 && <Badge tone="warning">refunded {money(i.amount_refunded, i.currency)}</Badge>}
        </span>
      ),
    },
    { key: 'total', header: 'Total', align: 'right', cell: (i) => <span className="tabular">{money(i.total, i.currency)}</span> },
    { key: 'balance', header: 'Balance due', align: 'right', cell: (i) => (i.status === 'open' ? <span className="font-medium tabular">{money(i.amount_due - i.amount_paid, i.currency)}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'due', header: 'Due', cell: (i) => (i.status === 'open' ? date(i.due_at) : '—') },
    { key: 'reason', header: 'Type', priority: 'low', cell: (i) => REASONS[i.billing_reason] ?? i.billing_reason },
    { key: 'issued', header: 'Issued', cell: (i) => <When value={i.issued_at ?? i.created_at} /> },
  ];

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Every invoice issued by subscriptions, checkouts and administrators, with its payment state."
        actions={
          can('billing.invoices.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New invoice
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search number or email…" className="w-full sm:w-64" />
          <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={statusOptions(INVOICE_STATUSES)} />
          <Checkbox checked={state.overdue === 'true'} onChange={(e) => setState({ overdue: e.target.checked ? 'true' : '' })} label="Overdue only" />
          {scoped && (
            <Badge tone="primary" className="gap-1.5">
              {state.subscriptionId ? 'One subscription' : 'One customer'}
              <button type="button" aria-label="Remove this filter" onClick={() => setState({ subscriptionId: '', userId: '', orgId: '' })}>
                <X className="size-3" />
              </button>
            </Badge>
          )}
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
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Invoices"
            columns={columns}
            rows={list.data?.data}
            rowKey={(i) => i.id}
            rowHref={(i) => `/revenue/invoices/${i.id}`}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={
              filtered ? (
                <EmptyState title="No invoices match these filters" action={<Button variant="outline" onClick={() => { setSearch(''); reset(); }}>Clear filters</Button>} />
              ) : (
                <EmptyState title="No invoices yet" description="Invoices are issued by checkouts, renewals and plan changes, or created here." />
              )
            }
          />
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      {creating && <CreateInvoiceDialog open={creating} onOpenChange={setCreating} onDone={(inv) => navigate(`/revenue/invoices/${inv.id}`)} />}
    </>
  );
}
