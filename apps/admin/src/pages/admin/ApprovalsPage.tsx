import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Stamp } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  JsonView,
  KeyValue,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Textarea,
  Toolbar,
  When,
  type Column,
} from '../../components/ui';
import { targetHref } from './shared';
import type { Approval } from './types';

const DEFAULTS = { status: 'pending', page: 1, pageSize: 25 };

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Waiting for approval' },
  { value: 'executed', label: 'Approved and executed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Approved, execution failed' },
  { value: 'expired', label: 'Expired' },
];

function humanAction(action: string): string {
  return action.replace(/[._]/g, ' ');
}

function ReviewDialog({ approval, onClose }: { approval: Approval; onClose: () => void }) {
  const { me } = useAuth();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const decide = useAction((decision: 'approve' | 'reject') => api.post<{ status: string; error?: string }>(`/api/admin/approvals/${approval.id}/${decision}`, { note: note.trim() || undefined }), {
    invalidate: [['approvals']],
    success: (r) => (r.status === 'executed' ? 'Approved and executed' : r.status === 'rejected' ? 'Request rejected' : null),
    onSuccess: (r) => {
      if (r.status === 'failed') setError(`Approved, but the action failed: ${r.error ?? 'unknown error'}`);
      else onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const mine = approval.requested_by === me?.admin.id;
  const pending = approval.status === 'pending';
  const expired = pending && new Date(approval.expires_at) <= new Date();
  const href = targetHref(approval.target_type, approval.target_id);

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={approval.summary}
      description={humanAction(approval.action)}
      size="lg"
      footer={
        pending && approval.canDecide && !expired ? (
          <>
            <Button variant="outline" className="text-danger" loading={decide.isPending && decide.variables === 'reject'} disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
              Reject
            </Button>
            <Button loading={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              Approve and execute
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        {pending && mine && (
          <Callout title="Waiting for a second administrator">
            You requested this. Separation of duties requires a different administrator with the <code className="font-mono text-xs">{approval.approve_permission}</code> permission to approve it.
          </Callout>
        )}
        {pending && !mine && !approval.canDecide && (
          <Callout tone="warning" title="You cannot decide this request">
            Approving requires the <code className="font-mono text-xs">{approval.approve_permission}</code> permission.
          </Callout>
        )}
        {expired && <Callout tone="warning" title="This request has expired">It can no longer be approved. Ask the requester to submit it again if it is still needed.</Callout>}
        {approval.status === 'failed' && approval.error && (
          <Callout tone="danger" title="Execution failed">
            {approval.error}
          </Callout>
        )}
        <KeyValue
          items={[
            { label: 'Status', value: <StatusBadge status={approval.status} /> },
            { label: 'Amount', value: approval.amount !== null ? money(approval.amount, approval.currency ?? 'USD') : null, hidden: approval.amount === null },
            { label: 'Requested by', value: <Link className="text-primary hover:underline" to={`/admin/team/${approval.requested_by}`}>{approval.requested_by_name}</Link> },
            { label: 'Requested', value: dateTime(approval.created_at) },
            { label: 'Reason given', value: approval.reason },
            { label: 'Target', value: approval.target_type ? (href ? <Link className="text-primary hover:underline" to={href}>{approval.target_type} {approval.target_id}</Link> : `${approval.target_type} ${approval.target_id ?? ''}`) : null, hidden: !approval.target_type },
            { label: pending ? 'Expires' : 'Decided', value: pending ? dateTime(approval.expires_at) : `${dateTime(approval.decided_at)}${approval.decided_by_name ? ` by ${approval.decided_by_name}` : ''}` },
            { label: 'Decision note', value: approval.decision_note, hidden: pending },
            { label: 'Approver permission', value: <code className="font-mono text-xs">{approval.approve_permission}</code> },
          ]}
        />
        <Field label="Request details">
          <JsonView value={approval.payload} />
        </Field>
        {approval.result && Object.keys(approval.result).length > 0 && (
          <Field label="Result">
            <JsonView value={approval.result} />
          </Field>
        )}
        {pending && approval.canDecide && !expired && (
          <Field label="Note" htmlFor="approval-note" hint="Optional. Saved with your decision in the audit log.">
            <Textarea id="approval-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export default function ApprovalsPage() {
  const { me } = useAuth();
  const [state, setState] = useUrlState(DEFAULTS);
  const [open, setOpen] = useState<Approval | null>(null);
  const query = { status: state.status === 'all' ? undefined : state.status, page: state.page, pageSize: state.pageSize };
  const list = useQuery({
    queryKey: ['approvals', query],
    queryFn: ({ signal }) => api.get<Page<Approval>>('/api/admin/approvals', query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: state.status === 'pending' ? 60_000 : false,
  });

  const columns: Column<Approval>[] = [
    {
      key: 'summary',
      header: 'Request',
      cell: (a) => (
        <span className="min-w-0">
          <span className="block truncate">{a.summary}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{humanAction(a.action)}</span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', cell: (a) => (a.amount !== null ? <span className="tabular">{money(a.amount, a.currency ?? 'USD')}</span> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'requested',
      header: 'Requested by',
      cell: (a) => (
        <span>
          {a.requested_by_name}
          {a.requested_by === me?.admin.id && <Badge className="ml-1.5">you</Badge>}
          <span className="block text-xs text-muted-foreground">
            <When value={a.created_at} />
          </span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
    {
      key: 'when',
      header: 'Expires / decided',
      priority: 'low',
      cell: (a) => (a.status === 'pending' ? <When value={a.expires_at} /> : <span>{a.decided_by_name ?? '—'} · <When value={a.decided_at} /></span>),
    },
    {
      key: 'review',
      header: <span className="sr-only">Review</span>,
      align: 'right',
      cell: (a) => (
        <Button size="sm" variant={a.canDecide ? 'primary' : 'outline'} onClick={() => setOpen(a)}>
          {a.canDecide ? 'Review' : 'View'}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Critical actions such as large refunds and affiliate payouts wait here until a second administrator approves them. Nobody can approve their own request."
      />
      <Card padded={false}>
        <Toolbar>
          <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} options={[...STATUS_OPTIONS, { value: 'all', label: 'All requests' }]} />
        </Toolbar>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Approval requests"
            columns={columns}
            rows={list.data?.data}
            rowKey={(a) => a.id}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={<EmptyState icon={<Stamp />} title={state.status === 'pending' ? 'Nothing is waiting for approval' : 'No requests'} description="Requests appear when an action exceeds an approval threshold, for example a refund above the configured limit." />}
          />
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      {open && <ReviewDialog approval={open} onClose={() => setOpen(null)} />}
    </>
  );
}
