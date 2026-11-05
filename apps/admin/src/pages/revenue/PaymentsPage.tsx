import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { api, download, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { money } from '../../lib/format';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Tabs,
  Toolbar,
  When,
  useToast,
  type Column,
} from '../../components/ui';
import { PAYMENT_STATUSES, REFUND_STATUSES, SubjectIcon, cleanQuery, dayEnd, dayStart, methodText, statusOptions, useGateways } from './shared';

export interface PaymentRow {
  id: string;
  subject_type: 'user' | 'organization';
  subject_id: string;
  invoice_id: string | null;
  order_id: string | null;
  gateway_id: string | null;
  gateway_payment_id: string | null;
  amount: number;
  currency: string;
  status: string;
  method_type: string | null;
  method_details: Record<string, unknown>;
  amount_refunded: number;
  fee_amount: number | null;
  failure_code: string | null;
  failure_message: string | null;
  manual_reference: string | null;
  created_at: string;
  succeeded_at: string | null;
  gateway_name: string | null;
  invoice_number: string | null;
  customer_label: string | null;
}

interface RefundRow {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  reason: string | null;
  status: string;
  failure_message: string | null;
  approval_id: string | null;
  credit_note_number: string | null;
  revoke_access: boolean;
  created_at: string;
  processed_at: string | null;
  subject_type: string;
  subject_id: string;
}

const DEFAULTS = { tab: 'payments', q: '', status: '', gatewayId: '', from: '', to: '', userId: '', orgId: '', refundStatus: '', page: 1, pageSize: 25 };

function PaymentsTable({ state, setState, reset }: { state: Record<string, string | number | undefined>; setState: (p: Record<string, string | number | undefined>, o?: { resetPage?: boolean }) => void; reset: () => void }) {
  const gateways = useGateways();
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
  }, [q]);

  const query = useMemo(() => {
    const out = cleanQuery(state, ['tab', 'refundStatus', 'from', 'to']);
    const from = dayStart(state.from);
    const to = dayEnd(state.to);
    if (from) out.from = from;
    if (to) out.to = to;
    return out;
  }, [state]);

  const list = useQuery({
    queryKey: ['payments', query],
    queryFn: ({ signal }) => api.get<Page<PaymentRow>>('/api/admin/payments', query, signal),
    placeholderData: keepPreviousData,
  });
  const scoped = Boolean(state.userId || state.orgId);
  const filtered = Boolean(state.q || state.status || state.gatewayId || state.from || state.to || scoped);

  const columns: Column<PaymentRow>[] = [
    {
      key: 'amount',
      header: 'Amount',
      cell: (p) => (
        <span className="tabular">
          {money(p.amount, p.currency)}
          {p.amount_refunded > 0 && <span className="block text-xs font-normal text-muted-foreground">−{money(p.amount_refunded, p.currency)} refunded</span>}
        </span>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          <SubjectIcon type={p.subject_type} />
          <span className="truncate">{p.customer_label ?? p.subject_id}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={p.status} />
          {p.status === 'failed' && p.failure_message && <span className="max-w-56 truncate text-xs text-muted-foreground" title={p.failure_message}>{p.failure_message}</span>}
        </span>
      ),
    },
    { key: 'method', header: 'Method', cell: (p) => <span className="capitalize">{methodText(p.method_type, p.method_details)}</span> },
    { key: 'invoice', header: 'Invoice', priority: 'low', cell: (p) => (p.invoice_number ? <span className="font-mono text-xs">{p.invoice_number}</span> : '—') },
    { key: 'gateway', header: 'Gateway', priority: 'low', cell: (p) => p.gateway_name ?? '—' },
    { key: 'date', header: 'Date', cell: (p) => <When value={p.created_at} /> },
  ];

  return (
    <>
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Payment ID, gateway ID, email, invoice…" className="w-full sm:w-72" />
        <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={statusOptions(PAYMENT_STATUSES)} />
        {gateways.data && gateways.data.data.length > 1 && (
          <Select aria-label="Gateway" className="w-auto" value={String(state.gatewayId)} onChange={(e) => setState({ gatewayId: e.target.value })} placeholder="Any gateway" options={gateways.data.data.map((g) => ({ value: g.id, label: g.name }))} />
        )}
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          From
          <Input type="date" aria-label="From date" className="w-auto" value={String(state.from)} max={String(state.to || '') || undefined} onChange={(e) => setState({ from: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          to
          <Input type="date" aria-label="To date" className="w-auto" value={String(state.to)} min={String(state.from || '') || undefined} onChange={(e) => setState({ to: e.target.value })} />
        </label>
        {scoped && (
          <Badge tone="primary" className="gap-1.5">
            One customer
            <button type="button" aria-label="Remove the customer filter" onClick={() => setState({ userId: '', orgId: '' })}>
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
          caption="Payments"
          columns={columns}
          rows={list.data?.data}
          rowKey={(p) => p.id}
          rowHref={(p) => `/revenue/payments/${p.id}`}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={filtered ? <EmptyState title="No payments match these filters" /> : <EmptyState title="No payments yet" description="Payments appear when customers pay checkouts or invoices." />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </>
  );
}

function RefundsTable({ state, setState }: { state: Record<string, string | number | undefined>; setState: (p: Record<string, string | number | undefined>, o?: { resetPage?: boolean }) => void }) {
  const query = useMemo(() => {
    const out: Record<string, string | number> = { page: Number(state.page) || 1, pageSize: Number(state.pageSize) || 25 };
    if (state.refundStatus) out.status = String(state.refundStatus);
    return out;
  }, [state]);
  const list = useQuery({
    queryKey: ['refunds', query],
    queryFn: ({ signal }) => api.get<Page<RefundRow>>('/api/admin/refunds', query, signal),
    placeholderData: keepPreviousData,
  });
  const columns: Column<RefundRow>[] = [
    { key: 'amount', header: 'Amount', cell: (r) => <span className="tabular">{money(r.amount, r.currency)}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={r.status} />
          {r.failure_message && <span className="max-w-56 truncate text-xs text-muted-foreground">{r.failure_message}</span>}
        </span>
      ),
    },
    { key: 'reason', header: 'Reason', cell: (r) => <span className="block max-w-xs truncate">{r.reason ?? '—'}</span> },
    {
      key: 'flags',
      header: 'Details',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.approval_id && <Badge tone="info">approved by a second admin</Badge>}
          {r.revoke_access && <Badge tone="warning">access revoked</Badge>}
          {r.credit_note_number && <Badge>{r.credit_note_number}</Badge>}
          {!r.approval_id && !r.revoke_access && !r.credit_note_number && <span className="text-muted-foreground">—</span>}
        </span>
      ),
    },
    { key: 'created', header: 'Requested', cell: (r) => <When value={r.created_at} /> },
    { key: 'processed', header: 'Processed', priority: 'low', cell: (r) => <When value={r.processed_at} /> },
  ];
  return (
    <>
      <Toolbar>
        <Select aria-label="Refund status" className="w-auto" value={String(state.refundStatus)} onChange={(e) => setState({ refundStatus: e.target.value })} placeholder="Any status" options={statusOptions(REFUND_STATUSES)} />
        <p className="text-sm text-muted-foreground">Refunds above the approval threshold wait under Administration → Approvals until a second administrator approves them.</p>
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Refunds"
          columns={columns}
          rows={list.data?.data}
          rowKey={(r) => r.id}
          rowHref={(r) => `/revenue/payments/${r.payment_id}`}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={<EmptyState title="No refunds" description="Refunds are issued from a payment's page." />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </>
  );
}

export default function PaymentsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const tab = String(state.tab || 'payments');

  const exportCsv = () => {
    const query: Record<string, string> = {};
    const from = dayStart(state.from);
    const to = dayEnd(state.to);
    if (from) query.from = from;
    if (to) query.to = to;
    download('/api/admin/payments/export.csv', query, 'payments.csv').catch((err) => toast.error('Export failed', errorMessage(err)));
  };

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every charge, its method, refunds and failures. Open a payment to refund it."
        actions={
          can('billing.payments.export') && (
            <Button variant="outline" icon={<Download className="size-4" />} onClick={exportCsv} title="Exports the selected date range (all payments when no dates are set)">
              Export CSV
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setState({ tab: v === 'payments' ? undefined : v, page: undefined })}
        tabs={[
          {
            value: 'payments',
            label: 'Payments',
            content: (
              <Card padded={false}>
                <PaymentsTable state={state} setState={setState} reset={reset} />
              </Card>
            ),
          },
          {
            value: 'refunds',
            label: 'Refunds',
            content: tab === 'refunds' && (
              <Card padded={false}>
                <RefundsTable state={state} setState={setState} />
              </Card>
            ),
          },
        ]}
      />
    </>
  );
}
