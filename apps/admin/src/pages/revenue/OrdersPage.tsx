import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type Page } from '../../lib/api';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { Badge, Button, Card, CopyButton, DataTable, EmptyState, ErrorState, KeyValue, Modal, Mono, PageHeader, Pagination, SearchInput, Select, StatusBadge, Tabs, Toolbar, When, type Column } from '../../components/ui';
import { CHECKOUT_STATUSES, CustomerLink, ORDER_STATUSES, SubjectIcon, TotalRow, cleanQuery, statusOptions } from './shared';

interface OrderRow {
  id: string;
  number: string | null;
  subject_type: 'user' | 'organization';
  subject_id: string;
  type: 'subscription' | 'one_time' | 'manual';
  status: string;
  currency: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  coupon_id: string | null;
  checkout_id: string | null;
  invoice_id: string | null;
  subscription_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  paid_at: string | null;
  customer_label: string | null;
  items: string | null;
}

interface CheckoutRow {
  id: string;
  subject_type: 'user' | 'organization';
  subject_id: string;
  kind: 'purchase' | 'invoice';
  status: string;
  quantity: number;
  invoice_id: string | null;
  order_id: string | null;
  total: number;
  currency: string;
  trial_days: number;
  url: string | null;
  failure_message: string | null;
  expires_at: string;
  completed_at: string | null;
  recovery_email_sent_at: string | null;
  created_at: string;
  product_name: string | null;
  customer_label: string | null;
}

const DEFAULTS = { tab: 'orders', q: '', status: '', checkoutStatus: '', page: 1, pageSize: 25 };
const TYPES: Record<string, string> = { subscription: 'Subscription', one_time: 'One-time', manual: 'Manual' };

type SetState = (p: Record<string, string | number | undefined>, o?: { resetPage?: boolean }) => void;

function OrderDialog({ order, onClose }: { order: OrderRow; onClose: () => void }) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={order.number ?? 'Order'} description={order.items ?? undefined} size="lg">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={order.status} />
          <Badge>{TYPES[order.type] ?? order.type}</Badge>
        </div>
        <KeyValue
          items={[
            { label: 'Customer', value: <CustomerLink type={order.subject_type} id={order.subject_id} label={order.customer_label} /> },
            { label: 'Placed', value: dateTime(order.created_at) },
            { label: 'Paid', value: dateTime(order.paid_at), hidden: !order.paid_at },
            { label: 'Order ID', value: <Mono copy>{order.id}</Mono> },
            { label: 'Checkout', value: <Mono copy>{order.checkout_id}</Mono>, hidden: !order.checkout_id },
            { label: 'Coupon', value: <Mono>{order.coupon_id}</Mono>, hidden: !order.coupon_id },
          ]}
        />
        <dl className="max-w-sm rounded-ui border px-4 py-2">
          <TotalRow label="Subtotal" value={money(order.subtotal, order.currency)} />
          {order.discount_total > 0 && <TotalRow label="Discount" value={`−${money(order.discount_total, order.currency)}`} />}
          <TotalRow label="Tax" value={money(order.tax_total, order.currency)} />
          <TotalRow label="Total" value={money(order.total, order.currency)} strong />
        </dl>
        {(order.invoice_id || order.subscription_id) && (
          <div className="flex flex-wrap gap-3 text-sm">
            {order.invoice_id && (
              <Link to={`/revenue/invoices/${order.invoice_id}`} className="text-primary hover:underline" onClick={onClose}>
                View invoice
              </Link>
            )}
            {order.subscription_id && (
              <Link to={`/revenue/subscriptions/${order.subscription_id}`} className="text-primary hover:underline" onClick={onClose}>
                View subscription
              </Link>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function OrdersTable({ state, setState, reset }: { state: Record<string, string | number | undefined>; setState: SetState; reset: () => void }) {
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  const [open, setOpen] = useState<OrderRow | null>(null);
  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
  }, [q]);
  const query = useMemo(() => cleanQuery(state, ['tab', 'checkoutStatus']), [state]);
  const list = useQuery({
    queryKey: ['orders', query],
    queryFn: ({ signal }) => api.get<Page<OrderRow>>('/api/admin/orders', query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = Boolean(state.q || state.status);

  const columns: Column<OrderRow>[] = [
    {
      key: 'number',
      header: 'Order',
      cell: (o) => (
        <button type="button" className="font-mono text-xs font-medium text-primary hover:underline" onClick={() => setOpen(o)}>
          {o.number ?? o.id}
        </button>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (o) => (
        <span className="flex min-w-0 items-center gap-2">
          <SubjectIcon type={o.subject_type} />
          <span className="truncate">{o.customer_label ?? o.subject_id}</span>
        </span>
      ),
    },
    { key: 'items', header: 'Items', cell: (o) => <span className="block max-w-56 truncate">{o.items ?? '—'}</span> },
    { key: 'type', header: 'Type', priority: 'low', cell: (o) => TYPES[o.type] ?? o.type },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
    { key: 'total', header: 'Total', align: 'right', cell: (o) => <span className="tabular">{money(o.total, o.currency)}</span> },
    { key: 'date', header: 'Placed', cell: (o) => <When value={o.created_at} /> },
  ];

  return (
    <>
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Order number, ID or email…" className="w-full sm:w-72" />
        <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={statusOptions(ORDER_STATUSES)} />
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
          caption="Orders"
          columns={columns}
          rows={list.data?.data}
          rowKey={(o) => o.id}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={filtered ? <EmptyState title="No orders match these filters" /> : <EmptyState title="No orders yet" description="An order is recorded for every completed purchase." />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      {open && <OrderDialog order={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function CheckoutsTable({ state, setState }: { state: Record<string, string | number | undefined>; setState: SetState }) {
  const query = useMemo(() => {
    const out: Record<string, string | number> = { page: Number(state.page) || 1, pageSize: Number(state.pageSize) || 25 };
    if (state.checkoutStatus) out.status = String(state.checkoutStatus);
    return out;
  }, [state]);
  const list = useQuery({
    queryKey: ['checkouts', query],
    queryFn: ({ signal }) => api.get<Page<CheckoutRow>>('/api/admin/checkouts', query, signal),
    placeholderData: keepPreviousData,
  });

  const columns: Column<CheckoutRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-2">
          <SubjectIcon type={c.subject_type} />
          <span className="truncate">{c.customer_label ?? c.subject_id}</span>
        </span>
      ),
    },
    {
      key: 'what',
      header: 'For',
      cell: (c) =>
        c.kind === 'invoice' && c.invoice_id ? (
          <Link to={`/revenue/invoices/${c.invoice_id}`} className="text-primary hover:underline">
            Invoice payment
          </Link>
        ) : (
          <span>
            {c.product_name ?? 'Purchase'}
            {c.quantity > 1 && <span className="text-muted-foreground"> × {c.quantity}</span>}
            {c.trial_days > 0 && <span className="text-muted-foreground"> · {c.trial_days}-day trial</span>}
          </span>
        ),
    },
    { key: 'total', header: 'Total', align: 'right', cell: (c) => <span className="tabular">{money(c.total, c.currency)}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (c) => (
        <span className="flex flex-col items-start gap-0.5">
          <span className="flex flex-wrap items-center gap-1">
            <StatusBadge status={c.status} />
            {c.recovery_email_sent_at && <Badge tone="info">reminder sent</Badge>}
          </span>
          {c.failure_message && <span className="max-w-56 truncate text-xs text-muted-foreground" title={c.failure_message}>{c.failure_message}</span>}
        </span>
      ),
    },
    {
      key: 'link',
      header: 'Link',
      priority: 'low',
      cell: (c) => (c.status === 'open' && c.url ? <CopyButton value={c.url} label="Copy checkout link" /> : <span className="text-muted-foreground">—</span>),
    },
    { key: 'created', header: 'Started', cell: (c) => <When value={c.created_at} /> },
    { key: 'end', header: 'Completed / expires', priority: 'low', cell: (c) => (c.completed_at ? <When value={c.completed_at} /> : c.status === 'open' ? <span>expires <When value={c.expires_at} /></span> : '—') },
  ];

  return (
    <>
      <Toolbar>
        <Select aria-label="Checkout status" className="w-auto" value={String(state.checkoutStatus)} onChange={(e) => setState({ checkoutStatus: e.target.value })} placeholder="Any status" options={statusOptions(CHECKOUT_STATUSES)} />
        <p className="text-sm text-muted-foreground">Expired purchase checkouts are abandoned carts. When abandoned-checkout emails are on, customers who agreed to marketing email get one reminder.</p>
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Checkout sessions"
          columns={columns}
          rows={list.data?.data}
          rowKey={(c) => c.id}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={<EmptyState title="No checkouts" />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </>
  );
}

export default function OrdersPage() {
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const tab = String(state.tab || 'orders');
  return (
    <>
      <PageHeader title="Orders" description="Completed purchases, and every checkout session including abandoned ones." />
      <Tabs
        value={tab}
        onValueChange={(v) => setState({ tab: v === 'orders' ? undefined : v, page: undefined })}
        tabs={[
          {
            value: 'orders',
            label: 'Orders',
            content: (
              <Card padded={false}>
                <OrdersTable state={state} setState={setState} reset={reset} />
              </Card>
            ),
          },
          {
            value: 'checkouts',
            label: 'Checkouts',
            content: tab === 'checkouts' && (
              <Card padded={false}>
                <CheckoutsTable state={state} setState={setState} />
              </Card>
            ),
          },
        ]}
      />
    </>
  );
}
