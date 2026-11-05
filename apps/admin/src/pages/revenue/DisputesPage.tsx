import { useMemo } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useUrlState } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { Badge, Callout, Card, DataTable, EmptyState, ErrorState, PageHeader, Pagination, Select, StatusBadge, Toolbar, When, type Column } from '../../components/ui';
import { DISPUTE_STATUSES, statusOptions } from './shared';

interface DisputeRow {
  id: string;
  payment_id: string | null;
  gateway_id: string;
  gateway_dispute_id: string;
  amount: number;
  currency: string;
  reason: string | null;
  status: 'needs_response' | 'won' | 'lost';
  evidence_due_by: string | null;
  created_at: string;
  closed_at: string | null;
  subject_type: string | null;
  subject_id: string | null;
  gateway_name: string | null;
}

const DEFAULTS = { status: '', page: 1, pageSize: 25 };
const DAY = 86_400_000;

function EvidenceDue({ d }: { d: DisputeRow }) {
  if (d.status !== 'needs_response') return <span className="text-muted-foreground">—</span>;
  if (!d.evidence_due_by) return <span className="text-muted-foreground">Not set</span>;
  const left = new Date(d.evidence_due_by).getTime() - Date.now();
  return (
    <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
      {dateTime(d.evidence_due_by)}
      {left < 0 ? <Badge tone="danger">past due</Badge> : left < 3 * DAY ? <Badge tone="warning">{Math.max(1, Math.ceil(left / DAY))}d left</Badge> : null}
    </span>
  );
}

export default function DisputesPage() {
  const [state, setState] = useUrlState(DEFAULTS);
  const query = useMemo(() => {
    const out: Record<string, string | number> = { page: Number(state.page) || 1, pageSize: Number(state.pageSize) || 25 };
    if (state.status) out.status = String(state.status);
    return out;
  }, [state]);
  const list = useQuery({
    queryKey: ['disputes', query],
    queryFn: ({ signal }) => api.get<Page<DisputeRow>>('/api/admin/disputes', query, signal),
    placeholderData: keepPreviousData,
  });

  const columns: Column<DisputeRow>[] = [
    { key: 'amount', header: 'Amount', cell: (d) => <span className="tabular">{money(d.amount, d.currency)}</span> },
    { key: 'status', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
    { key: 'reason', header: 'Reason', cell: (d) => (d.reason ? d.reason.replace(/_/g, ' ') : '—') },
    { key: 'due', header: 'Evidence due', cell: (d) => <EvidenceDue d={d} /> },
    { key: 'gateway', header: 'Gateway', priority: 'low', cell: (d) => d.gateway_name ?? d.gateway_id },
    { key: 'ref', header: 'Gateway case', priority: 'low', cell: (d) => <span className="font-mono text-xs">{d.gateway_dispute_id}</span> },
    { key: 'opened', header: 'Opened', cell: (d) => <When value={d.created_at} /> },
    { key: 'closed', header: 'Closed', priority: 'low', cell: (d) => <When value={d.closed_at} /> },
    {
      key: 'payment',
      header: 'Payment',
      cell: (d) =>
        d.payment_id ? (
          <Link to={`/revenue/payments/${d.payment_id}`} className="text-primary hover:underline">
            View payment
          </Link>
        ) : (
          <span className="text-muted-foreground">Unmatched</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader title="Disputes" description="Chargebacks reported by payment gateways, with the payment each one disputes." />
      <div className="mb-4">
        <Callout title="Responding to a dispute">
          Submit evidence in your payment gateway's dashboard before the due date. Outcomes (won or lost) arrive through the gateway's webhooks and update this list automatically. The billing settings decide whether a chargeback suspends the customer.
        </Callout>
      </div>
      <Card padded={false}>
        <Toolbar>
          <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={statusOptions(DISPUTE_STATUSES)} />
        </Toolbar>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Disputes"
            columns={columns}
            rows={list.data?.data}
            rowKey={(d) => d.id}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={<EmptyState icon={<ShieldAlert />} title={state.status ? 'No disputes with this status' : 'No disputes'} description={state.status ? undefined : 'Chargebacks appear here when a gateway reports them.'} />}
          />
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
    </>
  );
}
