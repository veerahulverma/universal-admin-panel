import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, fromMinor, money } from '../../lib/format';
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
  Modal,
  Mono,
  PageHeader,
  PageSkeleton,
  StatusBadge,
  When,
  useToast,
} from '../../components/ui';
import { AmountInput, CustomerLink, methodText, minorOrNull } from './shared';
import type { PaymentRow } from './PaymentsPage';

interface PaymentDetail extends Omit<PaymentRow, 'invoice_number' | 'customer_label'> {
  user_id: string | null;
  org_id: string | null;
  recorded_by: string | null;
  adapter: string | null;
  refunds: { id: string; amount: number; currency: string; reason: string | null; status: string; gateway_refund_id: string | null; failure_message: string | null; approval_id: string | null; credit_note_id: string | null; revoke_access: boolean; created_at: string; processed_at: string | null }[];
  disputes: { id: string; amount: number; currency: string; reason: string | null; status: string; evidence_due_by: string | null; gateway_dispute_id: string; created_at: string; closed_at: string | null }[];
  refundable: boolean;
  partialRefunds: boolean;
}

type RefundResult = { status: 'requires_approval'; approvalId: string } | { status: string; refund: { id: string; status: string; failure_message: string | null } };

function RefundDialog({ p, open, onOpenChange, onResult }: { p: PaymentDetail; open: boolean; onOpenChange: (o: boolean) => void; onResult: (r: RefundResult) => void }) {
  const remaining = p.amount - p.amount_refunded;
  const [amount, setAmount] = useState(fromMinor(remaining, p.currency));
  const [reason, setReason] = useState('');
  const [revokeAccess, setRevokeAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minor = minorOrNull(amount, p.currency);
  const full = minor === remaining;
  const endsPayment = minor !== null && p.amount_refunded + minor >= p.amount;

  const submit = useAction(
    async () => {
      if (!minor || minor <= 0 || minor > remaining) throw new Error(`Enter an amount between ${money(1, p.currency)} and ${money(remaining, p.currency)}`);
      return api.post<RefundResult>(`/api/admin/payments/${p.id}/refunds`, { amount: minor, reason: reason.trim(), revokeAccess: revokeAccess && endsPayment });
    },
    {
      invalidate: [['payment', p.id], ['payments'], ['refunds']],
      onSuccess: (r) => {
        onResult(r);
        onOpenChange(false);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Refund payment"
      description={`Up to ${money(remaining, p.currency)} can be refunded to the original payment method. Every completed refund gets a credit note.`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" form="refund-form" loading={submit.isPending} disabled={reason.trim().length < 3}>
            Refund {minor && minor > 0 ? money(minor, p.currency) : ''}
          </Button>
        </>
      }
    >
      <form
        id="refund-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          submit.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Amount" htmlFor="rf-amount" hint={p.partialRefunds ? (full ? 'Full refund of the remaining amount' : 'Partial refund') : 'This gateway only supports refunding the full remaining amount'}>
          <AmountInput id="rf-amount" value={amount} onChange={setAmount} currency={p.currency} disabled={!p.partialRefunds} required />
        </Field>
        <Field label="Reason" htmlFor="rf-reason" hint="Required. Recorded on the refund, the credit note and in the audit log.">
          <Input id="rf-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="e.g. Duplicate charge, service outage credit" />
        </Field>
        <Checkbox checked={revokeAccess && endsPayment} disabled={!endsPayment} onChange={(e) => setRevokeAccess(e.target.checked)} label="Revoke access" description={endsPayment ? "Once refunded in full, cancel the subscription immediately or withdraw the one-time purchase this payment bought." : "Only available when the payment is refunded in full."} />
        <Callout tone="warning">Refunds move real money and cannot be undone. Large refunds are held until a second administrator approves them.</Callout>
      </form>
    </Modal>
  );
}

export default function PaymentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [refunding, setRefunding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['payment', id], queryFn: () => api.get<PaymentDetail>(`/api/admin/payments/${id}`) });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const remaining = p.amount - p.amount_refunded;
  const canRefundStatus = ['succeeded', 'partially_refunded', 'disputed'].includes(p.status) && remaining > 0;
  const showRefund = can('billing.refunds.create') && canRefundStatus;
  const openDisputes = p.disputes.filter((d) => d.status === 'needs_response');

  const onResult = (r: RefundResult) => {
    if (r.status === 'requires_approval' && 'approvalId' in r) {
      setPending(r.approvalId);
      toast.info('Refund sent for approval', 'A second administrator must approve it before money is returned.');
    } else if ('refund' in r) {
      if (r.refund.status === 'succeeded') toast.success('Refund completed');
      else if (r.refund.status === 'pending') toast.info('Refund submitted', 'The gateway is processing it; the status updates automatically.');
      else toast.error('Refund failed', r.refund.failure_message ?? undefined);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Payments', to: '/revenue/payments' }, { label: p.id }]}
        documentTitle={`Payment ${money(p.amount, p.currency)}`}
        title={money(p.amount, p.currency)}
        description={p.amount_refunded > 0 ? `${money(p.amount_refunded, p.currency)} refunded · ${money(remaining, p.currency)} net` : undefined}
        meta={
          <>
            <StatusBadge status={p.status} />
            <Badge className="capitalize">{methodText(p.method_type, p.method_details)}</Badge>
            {p.gateway_name && <Badge>{p.gateway_name}</Badge>}
          </>
        }
        actions={
          showRefund &&
          p.refundable && (
            <Button variant="outline" icon={<Undo2 className="size-4" />} onClick={() => setRefunding(true)}>
              Refund
            </Button>
          )
        }
      />

      <div className="mb-4 space-y-3">
        {pending && (
          <Callout
            tone="info"
            title="Refund waiting for approval"
            action={
              can('iam.approvals.view') ? (
                <ButtonLink to="/admin/approvals" size="sm">
                  Open approvals
                </ButtonLink>
              ) : undefined
            }
          >
            Request {pending}. Nothing is refunded until another administrator with the refund-approval permission approves it.
          </Callout>
        )}
        {showRefund && !p.refundable && (
          <Callout title="Refund outside the console">
            {p.adapter === 'manual' || !p.adapter ? 'This payment was recorded manually (offline). Return the money the same way it was received.' : 'This gateway does not support refunds through the API. Refund it in the gateway dashboard; the refund syncs back through webhooks.'}
          </Callout>
        )}
        {p.status === 'failed' && (
          <Callout tone="danger" title="Payment failed">
            {p.failure_message ?? 'The gateway declined this payment.'}
            {p.failure_code ? ` (${p.failure_code})` : ''}
          </Callout>
        )}
        {openDisputes.length > 0 && (
          <Callout tone="danger" title="Disputed by the cardholder">
            {openDisputes.map((d) => `${money(d.amount, d.currency)}${d.evidence_due_by ? `, evidence due ${dateTime(d.evidence_due_by)}` : ''}`).join(' · ')}. Respond in the gateway dashboard.
          </Callout>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Details">
            <KeyValue
              items={[
                { label: 'Amount', value: money(p.amount, p.currency) },
                { label: 'Refunded', value: money(p.amount_refunded, p.currency) },
                { label: 'Gateway fee', value: p.fee_amount !== null ? money(p.fee_amount, p.currency) : null, hidden: p.fee_amount === null },
                { label: 'Method', value: <span className="capitalize">{methodText(p.method_type, p.method_details)}</span> },
                { label: 'Gateway', value: p.gateway_name ? `${p.gateway_name}${p.adapter ? ` (${p.adapter})` : ''}` : null },
                { label: 'Gateway payment ID', value: <Mono copy>{p.gateway_payment_id}</Mono> },
                { label: 'Offline reference', value: p.manual_reference, hidden: !p.manual_reference },
                { label: 'Created', value: dateTime(p.created_at) },
                { label: 'Succeeded', value: dateTime(p.succeeded_at), hidden: !p.succeeded_at },
                { label: 'Payment ID', value: <Mono copy>{p.id}</Mono> },
              ]}
            />
          </Card>

          <Card title="Refunds" padded={false}>
            <DataTable
              caption="Refunds of this payment"
              rows={p.refunds}
              rowKey={(r) => r.id}
              empty={<EmptyState title="No refunds" />}
              columns={[
                { key: 'amount', header: 'Amount', cell: (r) => <span className="tabular">{money(r.amount, r.currency)}</span> },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'reason', header: 'Reason', cell: (r) => <span className="block max-w-xs truncate">{r.reason ?? '—'}{r.failure_message ? ` — ${r.failure_message}` : ''}</span> },
                {
                  key: 'flags',
                  header: 'Details',
                  cell: (r) => (
                    <span className="flex flex-wrap gap-1">
                      {r.approval_id && <Badge tone="info">approved</Badge>}
                      {r.revoke_access && <Badge tone="warning">access revoked</Badge>}
                      {r.credit_note_id && <Badge>credit note</Badge>}
                    </span>
                  ),
                },
                { key: 'date', header: 'Requested', cell: (r) => <When value={r.created_at} /> },
              ]}
            />
          </Card>

          {p.disputes.length > 0 && (
            <Card title="Disputes" padded={false}>
              <DataTable
                caption="Disputes on this payment"
                rows={p.disputes}
                rowKey={(d) => d.id}
                columns={[
                  { key: 'amount', header: 'Amount', cell: (d) => <span className="tabular">{money(d.amount, d.currency)}</span> },
                  { key: 'status', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
                  { key: 'reason', header: 'Reason', cell: (d) => d.reason ?? '—' },
                  { key: 'due', header: 'Evidence due', cell: (d) => (d.status === 'needs_response' ? dateTime(d.evidence_due_by) : '—') },
                  { key: 'opened', header: 'Opened', cell: (d) => <When value={d.created_at} /> },
                ]}
              />
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card title="Customer">
            <CustomerLink type={p.subject_type} id={p.subject_id} />
          </Card>
          {(p.invoice_id || p.order_id) && (
            <Card title="Related">
              <ul className="space-y-2 text-sm">
                {p.invoice_id && (
                  <li>
                    <Link to={`/revenue/invoices/${p.invoice_id}`} className="text-primary hover:underline">
                      Invoice
                    </Link>{' '}
                    <span className="break-all font-mono text-xs text-muted-foreground">{p.invoice_id}</span>
                  </li>
                )}
                {p.order_id && (
                  <li>
                    <Link to={`/revenue/orders?q=${encodeURIComponent(p.order_id)}`} className="text-primary hover:underline">
                      Order
                    </Link>{' '}
                    <span className="break-all font-mono text-xs text-muted-foreground">{p.order_id}</span>
                  </li>
                )}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {refunding && <RefundDialog p={p} open={refunding} onOpenChange={setRefunding} onResult={onResult} />}
    </>
  );
}
