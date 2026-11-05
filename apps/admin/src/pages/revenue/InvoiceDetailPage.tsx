import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Ban, CircleCheck, CreditCard, Download, ExternalLink, FileCheck2, FileText, Link2, Mail, MoreHorizontal, TriangleAlert } from 'lucide-react';
import { api, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { date, dateTime, fromMinor, money } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Menu,
  Modal,
  Mono,
  PageHeader,
  PageSkeleton,
  Select,
  StatusBadge,
  When,
  buttonClass,
  useConfirm,
  useToast,
  type MenuItem,
} from '../../components/ui';
import { AmountInput, CustomerBillingCard, TotalRow, methodText, minorOrNull, useGateways } from './shared';
import { REASONS, isOverdue, type InvoiceRow } from './InvoicesPage';

interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface InvoiceDetail extends InvoiceRow {
  user_id: string | null;
  org_id: string | null;
  order_id: string | null;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  balance_applied: number;
  period_start: string | null;
  period_end: string | null;
  voided_at: string | null;
  customer_details: { name?: string | null; email?: string | null; company?: string | null; taxId?: string | null; address?: Address | string | null };
  seller_details: { name?: string; email?: string; taxId?: string; address?: Address | string; country?: string };
  tax_note: string | null;
  notes: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  lines: { id: string; type: string; description: string; quantity: number; unit_amount: number; amount: number; discount_amount: number; tax_rate_bps: number; tax_amount: number; tax_inclusive: boolean; period_start: string | null; period_end: string | null }[];
  payments: { id: string; amount: number; amount_refunded: number; currency: string; status: string; method_type: string | null; method_details: Record<string, unknown>; manual_reference: string | null; created_at: string }[];
  creditNotes: { id: string; number: string; refund_id: string | null; amount: number; currency: string; reason: string | null; created_at: string }[];
  payUrl: string | null;
}

function addressText(a: Address | string | null | undefined): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(' '), a.state, a.country].filter(Boolean).join('\n');
}

function Party({ title, name, company, email, taxId, address }: { title: string; name?: string | null; company?: string | null; email?: string | null; taxId?: string | null; address?: Address | string | null }) {
  const addr = addressText(address);
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="mt-1 space-y-0.5 text-sm">
        {company && <p className="font-medium">{company}</p>}
        {name && <p className={company ? undefined : 'font-medium'}>{name}</p>}
        {email && <p className="break-all text-muted-foreground">{email}</p>}
        {addr && <p className="whitespace-pre-line text-muted-foreground">{addr}</p>}
        {taxId && (
          <p className="text-muted-foreground">
            Tax ID <span className="font-mono">{taxId}</span>
          </p>
        )}
        {!company && !name && !email && !addr && <p className="text-muted-foreground">—</p>}
      </div>
    </div>
  );
}

function MarkPaidDialog({ inv, open, onOpenChange }: { inv: InvoiceDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const remaining = inv.amount_due - inv.amount_paid;
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState(fromMinor(remaining, inv.currency));
  const [error, setError] = useState<string | null>(null);
  const submit = useAction(
    async () => {
      const minor = minorOrNull(amount, inv.currency);
      if (!minor || minor <= 0) throw new Error('Enter the amount received');
      return api.post<InvoiceRow>(`/api/admin/invoices/${inv.id}/mark-paid`, { method, reference: reference.trim() || undefined, amount: minor });
    },
    {
      success: (r) => (r.status === 'paid' ? 'Invoice marked as paid' : 'Partial payment recorded'),
      invalidate: [['invoice', inv.id], ['invoices']],
      onSuccess: () => onOpenChange(false),
      onError: (e) => setError(errorMessage(e)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Record an offline payment"
      description="For money received outside a payment gateway (bank transfer, cash, cheque). A payment record is added and the invoice settles when fully paid."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="mark-paid" loading={submit.isPending}>
            Record payment
          </Button>
        </>
      }
    >
      <form
        id="mark-paid"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          submit.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Method" htmlFor="mp-method">
          <Select
            id="mp-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            options={[
              { value: 'bank_transfer', label: 'Bank transfer' },
              { value: 'cash', label: 'Cash' },
              { value: 'check', label: 'Cheque' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </Field>
        <Field label="Amount received" htmlFor="mp-amount" hint={`Balance due ${money(remaining, inv.currency)}`}>
          <AmountInput id="mp-amount" value={amount} onChange={setAmount} currency={inv.currency} required />
        </Field>
        <Field label="Reference" htmlFor="mp-ref" hint="Bank reference or receipt number" className="sm:col-span-2">
          <Input id="mp-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
        </Field>
      </form>
    </Modal>
  );
}

function CheckoutDialog({ inv, open, onOpenChange }: { inv: InvoiceDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const gateways = useGateways();
  const [gatewayId, setGatewayId] = useState('');
  const [result, setResult] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useAction(() => api.post<{ id: string; url: string }>(`/api/admin/invoices/${inv.id}/checkout`, { gatewayId: gatewayId || undefined }), {
    onSuccess: setResult,
    onError: (e) => setError(errorMessage(e)),
  });
  const options = (gateways.data?.data ?? []).filter((g) => g.enabled).map((g) => ({ value: g.id, label: `${g.name}${g.mode === 'test' ? ' (test)' : ''}` }));
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Collect payment through a gateway" description="Creates a hosted checkout for this invoice. Share the link with the customer; the invoice is settled when the payment succeeds.">
      {result ? (
        <div className="space-y-3">
          <CodeBlock code={result.url} />
          <a href={result.url} target="_blank" rel="noreferrer" className={buttonClass('primary')}>
            <ExternalLink className="size-4" /> Open checkout
          </a>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <FormError message={error} />
          <Field label="Gateway" htmlFor="co-gateway" hint="Leave on default to use the best gateway for this currency.">
            <Select id="co-gateway" value={gatewayId} onChange={(e) => setGatewayId(e.target.value)} placeholder="Default for the currency" options={options} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create checkout
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [dialog, setDialog] = useState<'paid' | 'checkout' | null>(null);
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<InvoiceDetail>(`/api/admin/invoices/${id}`) });
  const invalidate = [['invoice', id], ['invoices']];

  const act = useAction(({ action }: { action: 'finalize' | 'void' | 'send' | 'mark-uncollectible'; label: string }) => api.post<{ emailed?: boolean }>(`/api/admin/invoices/${q.data?.id ?? id}/${action}`), {
    invalidate,
    onSuccess: (r, v) => {
      if (v.action === 'send') {
        if (r.emailed) toast.success('Invoice emailed to the customer');
        else toast.error('Not sent', 'The invoice has no customer email address, or email is not configured.');
      } else toast.success(v.label);
    },
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const inv = q.data;
  const manage = can('billing.invoices.manage');
  const remaining = inv.amount_due - inv.amount_paid;
  const overdue = isOverdue(inv);
  const title = inv.number ?? 'Draft invoice';
  const customerLabel = inv.customer_details?.company || inv.customer_details?.name || inv.customer_details?.email || inv.subject_id;
  const pdfUrl = `/api/admin/invoices/${inv.id}/pdf`;

  const run = async (action: 'finalize' | 'void' | 'send' | 'mark-uncollectible', opts: { title: string; description: string; label: string; tone?: 'danger'; confirmText: string }) => {
    const r = await confirm({ title: opts.title, description: opts.description, confirmLabel: opts.confirmText, tone: opts.tone });
    if (r.confirmed) act.mutate({ action, label: opts.label });
  };

  const actions: MenuItem[] = [
    {
      label: 'Finalize and issue',
      icon: <FileCheck2 className="size-4" />,
      hidden: !manage || inv.status !== 'draft',
      onSelect: () => void run('finalize', { title: 'Finalize this invoice?', description: 'It gets its permanent number, becomes visible to the customer and payable.', label: 'Invoice finalized', confirmText: 'Finalize' }),
    },
    { label: 'Email to customer', icon: <Mail className="size-4" />, hidden: !manage || inv.status !== 'open', onSelect: () => act.mutate({ action: 'send', label: 'Invoice emailed' }) },
    { label: 'Collect through a gateway…', icon: <CreditCard className="size-4" />, hidden: !manage || inv.status !== 'open', onSelect: () => setDialog('checkout') },
    { label: 'Record offline payment…', icon: <CircleCheck className="size-4" />, hidden: !manage || inv.status !== 'open', onSelect: () => setDialog('paid') },
    { separator: true, label: '', hidden: !manage || (inv.status !== 'open' && inv.status !== 'draft') },
    {
      label: 'Mark uncollectible',
      icon: <TriangleAlert className="size-4" />,
      danger: true,
      hidden: !manage || inv.status !== 'open',
      onSelect: () => void run('mark-uncollectible', { title: 'Mark as uncollectible?', description: 'Stops payment retries and reminders. Use this to write off a debt you do not expect to receive.', label: 'Marked uncollectible', tone: 'danger', confirmText: 'Mark uncollectible' }),
    },
    {
      label: inv.status === 'draft' ? 'Delete draft (void)' : 'Void invoice',
      icon: <Ban className="size-4" />,
      danger: true,
      hidden: !manage || !(inv.status === 'draft' || (inv.status === 'open' && inv.amount_paid === 0)),
      onSelect: () => void run('void', { title: 'Void this invoice?', description: 'The invoice is cancelled and can no longer be paid. Any account credit it used is returned. This cannot be undone.', label: 'Invoice voided', tone: 'danger', confirmText: 'Void invoice' }),
    },
  ];
  const hasActions = actions.some((a) => !a.hidden && !a.separator);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Invoices', to: '/revenue/invoices' }, { label: title }]}
        title={title}
        description={`${money(inv.total, inv.currency)} · ${customerLabel}`}
        meta={
          <>
            <StatusBadge status={inv.status} />
            {overdue && <Badge tone="danger">overdue</Badge>}
            <Badge>{REASONS[inv.billing_reason] ?? inv.billing_reason}</Badge>
          </>
        }
        actions={
          <>
            {inv.status !== 'draft' && (
              <>
                <a href={pdfUrl} target="_blank" rel="noreferrer" className={buttonClass('outline')}>
                  <FileText className="size-4" /> View PDF
                </a>
                <Button variant="outline" size="icon" aria-label="Download PDF" onClick={() => download(pdfUrl, undefined, `${title}.pdf`).catch((err) => toast.error('Download failed', errorMessage(err)))}>
                  <Download className="size-4" />
                </Button>
              </>
            )}
            {hasActions && <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>} items={actions} />}
          </>
        }
      />

      <div className="mb-4 space-y-3">
        {inv.status === 'draft' && <Callout title="Draft">Not numbered and not visible to the customer. Finalize it to issue it.</Callout>}
        {overdue && (
          <Callout tone="danger" title={`Overdue since ${date(inv.due_at)}`}>
            {money(remaining, inv.currency)} outstanding. {inv.attempt_count > 0 ? `${inv.attempt_count} collection attempt(s).` : ''} {inv.next_attempt_at ? `Next retry ${dateTime(inv.next_attempt_at)}.` : ''}
          </Callout>
        )}
        {inv.status === 'uncollectible' && <Callout tone="warning" title="Written off">Marked uncollectible: no more reminders or retries.</Callout>}
        {inv.status === 'void' && <Callout title="Voided">Voided {dateTime(inv.voided_at)}. It cannot be paid.</Callout>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="grid gap-5 sm:grid-cols-2">
              <Party title="Bill to" name={inv.customer_details?.name} company={inv.customer_details?.company} email={inv.customer_details?.email} taxId={inv.customer_details?.taxId} address={inv.customer_details?.address} />
              <Party title="From" name={inv.seller_details?.name} email={inv.seller_details?.email} taxId={inv.seller_details?.taxId} address={inv.seller_details?.address} />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Issued</dt>
                <dd>{date(inv.issued_at)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Due</dt>
                <dd>{date(inv.due_at)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Paid</dt>
                <dd>{date(inv.paid_at)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Period</dt>
                <dd>{inv.period_start ? `${date(inv.period_start)} – ${date(inv.period_end)}` : '—'}</dd>
              </div>
            </dl>
          </Card>

          <Card title="Line items" padded={false}>
            <DataTable
              caption="Invoice lines"
              rows={inv.lines}
              rowKey={(l) => l.id}
              empty={<EmptyState title="No lines" />}
              columns={[
                {
                  key: 'description',
                  header: 'Description',
                  cell: (l) => (
                    <span className="block min-w-0">
                      <span className="block">{l.description}</span>
                      {l.period_start && (
                        <span className="block text-xs text-muted-foreground">
                          {date(l.period_start)} – {date(l.period_end)}
                        </span>
                      )}
                    </span>
                  ),
                },
                { key: 'qty', header: 'Qty', align: 'right', cell: (l) => <span className="tabular">{l.quantity}</span> },
                { key: 'unit', header: 'Unit price', align: 'right', cell: (l) => <span className="tabular">{money(l.unit_amount, inv.currency)}</span> },
                { key: 'discount', header: 'Discount', align: 'right', priority: 'low', cell: (l) => (l.discount_amount ? <span className="tabular">−{money(l.discount_amount, inv.currency)}</span> : '—') },
                { key: 'tax', header: 'Tax', align: 'right', cell: (l) => (l.tax_rate_bps ? <span className="tabular">{money(l.tax_amount, inv.currency)} <span className="text-muted-foreground">({(l.tax_rate_bps / 100).toFixed(2).replace(/\.?0+$/, '')}%{l.tax_inclusive ? ' incl.' : ''})</span></span> : '—') },
                { key: 'amount', header: 'Amount', align: 'right', cell: (l) => <span className="font-medium tabular">{money(l.amount, inv.currency)}</span> },
              ]}
            />
            <dl className="ml-auto max-w-sm border-t px-4 py-3">
              <TotalRow label="Subtotal" value={money(inv.subtotal, inv.currency)} />
              {inv.discount_total > 0 && <TotalRow label="Discount" value={`−${money(inv.discount_total, inv.currency)}`} />}
              <TotalRow label="Tax" value={money(inv.tax_total, inv.currency)} />
              <TotalRow label="Total" value={money(inv.total, inv.currency)} strong />
              {inv.balance_applied > 0 && <TotalRow label="Account credit applied" value={`−${money(inv.balance_applied, inv.currency)}`} muted />}
              <TotalRow label="Amount due" value={money(inv.amount_due, inv.currency)} />
              <TotalRow label="Paid" value={money(inv.amount_paid, inv.currency)} muted />
              {inv.amount_refunded > 0 && <TotalRow label="Refunded" value={money(inv.amount_refunded, inv.currency)} muted />}
              {inv.status === 'open' && <TotalRow label="Balance due" value={money(remaining, inv.currency)} strong />}
            </dl>
            {(inv.tax_note || inv.notes) && (
              <div className="space-y-1 border-t px-4 py-3 text-sm text-muted-foreground">
                {inv.tax_note && <p>{inv.tax_note}</p>}
                {inv.notes && <p className="whitespace-pre-line">{inv.notes}</p>}
              </div>
            )}
          </Card>

          <Card title="Payments" padded={false}>
            <DataTable
              caption="Payments for this invoice"
              rows={inv.payments}
              rowKey={(p) => p.id}
              rowHref={(p) => `/revenue/payments/${p.id}`}
              empty={<EmptyState title="No payments yet" />}
              columns={[
                { key: 'amount', header: 'Amount', cell: (p) => <span className="tabular">{money(p.amount, p.currency)}</span> },
                { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
                { key: 'method', header: 'Method', cell: (p) => (p.manual_reference ? `${methodText(p.method_type, p.method_details)} · ${p.manual_reference}` : methodText(p.method_type, p.method_details)) },
                { key: 'date', header: 'Date', cell: (p) => <When value={p.created_at} /> },
              ]}
            />
          </Card>

          {inv.creditNotes.length > 0 && (
            <Card title="Credit notes" description="Issued for refunds against this invoice" padded={false}>
              <DataTable
                caption="Credit notes"
                rows={inv.creditNotes}
                rowKey={(c) => c.id}
                columns={[
                  { key: 'number', header: 'Number', cell: (c) => <span className="font-mono text-xs">{c.number}</span> },
                  { key: 'amount', header: 'Amount', align: 'right', cell: (c) => <span className="tabular">{money(c.amount, c.currency)}</span> },
                  { key: 'reason', header: 'Reason', cell: (c) => c.reason ?? '—' },
                  { key: 'date', header: 'Date', cell: (c) => <When value={c.created_at} /> },
                ]}
              />
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {inv.payUrl && (
            <Card title="Payment link" description="Secure link the customer can use to pay this invoice">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Mono copy>{inv.payUrl}</Mono>
                </div>
                <a href={inv.payUrl} target="_blank" rel="noreferrer" className={buttonClass('outline', 'sm')}>
                  <ExternalLink className="size-3.5" /> Open payment page
                </a>
              </div>
            </Card>
          )}
          <CustomerBillingCard type={inv.subject_type} id={inv.subject_id} label={customerLabel} currency={inv.currency} />
          {(inv.subscription_id || inv.order_id) && (
            <Card title="Related">
              <ul className="space-y-2 text-sm">
                {inv.subscription_id && (
                  <li>
                    <Link to={`/revenue/subscriptions/${inv.subscription_id}`} className="text-primary hover:underline">
                      Subscription
                    </Link>{' '}
                    <span className="font-mono text-xs text-muted-foreground">{inv.subscription_id}</span>
                  </li>
                )}
                {inv.order_id && (
                  <li>
                    <Link to={`/revenue/orders?q=${encodeURIComponent(inv.order_id)}`} className="text-primary hover:underline">
                      Order
                    </Link>{' '}
                    <span className="font-mono text-xs text-muted-foreground">{inv.order_id}</span>
                  </li>
                )}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {dialog === 'paid' && <MarkPaidDialog inv={inv} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog === 'checkout' && <CheckoutDialog inv={inv} open onOpenChange={(o) => !o && setDialog(null)} />}
    </>
  );
}
