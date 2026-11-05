import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CalendarPlus, CirclePause, CirclePlay, CircleX, MoreHorizontal, RefreshCw, RotateCcw } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { date, dateTime, money } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  JsonView,
  KeyValue,
  Menu,
  Modal,
  Mono,
  PageHeader,
  PageSkeleton,
  Select,
  StatusBadge,
  When,
  useConfirm,
  useToast,
  type MenuItem,
} from '../../components/ui';
import { CustomerBillingCard, priceText } from './shared';
import { periodLabel, priceOptionLabel, usePlanProducts, useRecurringPrices, type SubscriptionRow } from './SubscriptionsPage';

interface SubscriptionDetail extends SubscriptionRow {
  user_id: string | null;
  org_id: string | null;
  product_id: string;
  price_id: string;
  gateway_id: string | null;
  payment_method_id: string | null;
  trial_start: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  resume_at: string | null;
  grace_until: string | null;
  discount_cycles_remaining: number | null;
  intro_cycles_remaining: number | null;
  next_payment_attempt_at: string | null;
  payment_attempts: number;
  checkout_id: string | null;
  metadata: Record<string, unknown>;
  price_currency: string;
  pm_brand: string | null;
  pm_last4: string | null;
  pm_exp_month: number | null;
  pm_exp_year: number | null;
  /** Installment plans: payments in all (null = renews until cancelled). */
  payment_count: number | null;
  after_last_payment: 'end_access' | 'keep_access';
  installments_paid: number;
  coupon_code: string | null;
  invoices: { id: string; number: string | null; status: string; total: number; amount_due: number; amount_paid: number; currency: string; period_start: string | null; period_end: string | null; created_at: string }[];
  history: { id: string; type: string; data: Record<string, unknown>; created_at: string }[];
}

const COLLECTION: Record<string, string> = { charge_automatically: 'Charged automatically', send_invoice: 'Invoiced (pay by link)', complimentary: 'Complimentary' };

/** Name of the price a scheduled change moves to (looked up across plans and add-ons). */
function useScheduledPriceLabel(priceId: string | null | undefined) {
  const products = usePlanProducts(Boolean(priceId));
  return useQuery({
    queryKey: ['revenue-price-label', priceId],
    enabled: Boolean(priceId && products.data),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      for (const p of products.data ?? []) {
        const d = await api.get<{ name: string; prices: Parameters<typeof priceOptionLabel>[0][] }>(`/api/admin/products/${p.id}`);
        const pr = d.prices.find((x) => x.id === priceId);
        if (pr) return `${d.name} — ${priceOptionLabel(pr)}`;
      }
      return null;
    },
  });
}

function ChangePlanDialog({ sub, open, onOpenChange }: { sub: SubscriptionDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const toast = useToast();
  const products = usePlanProducts(open);
  const [form, setForm] = useState({ productId: sub.product_id, priceId: sub.price_id, quantity: String(sub.quantity), timing: 'auto', prorate: '' });
  const prices = useRecurringPrices(form.productId || null);
  const choices = (prices.data ?? []).filter((p) => p.currency === sub.currency);
  const price = choices.find((p) => p.id === form.priceId);
  const [error, setError] = useState<string | null>(null);
  const unchanged = form.priceId === sub.price_id && Number(form.quantity) === sub.quantity;

  const change = useAction(
    () =>
      api.post<{ subscription: SubscriptionRow; invoice: { number: string | null; total: number; currency: string; status: string } | null; scheduled: boolean }>(`/api/admin/subscriptions/${sub.id}/change`, {
        priceId: form.priceId !== sub.price_id ? form.priceId : undefined,
        quantity: Number(form.quantity) !== sub.quantity ? Number(form.quantity) : undefined,
        timing: form.timing,
        prorate: form.prorate === '' ? undefined : form.prorate === 'true',
      }),
    {
      invalidate: [['subscription', sub.id], ['subscriptions']],
      onSuccess: (r) => {
        if (r.scheduled) toast.success('Change scheduled', `It takes effect when the current period ends on ${date(sub.current_period_end)}.`);
        else if (r.invoice) toast.success('Plan changed', `Invoice ${r.invoice.number ?? ''} for ${money(r.invoice.total, r.invoice.currency)} is ${r.invoice.status}.`);
        else toast.success('Plan changed', 'No charge was due; any unused value was added as account credit.');
        onOpenChange(false);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Change plan or quantity"
      description={`Currently ${sub.product_name}, ${priceText(sub, sub.quantity)}.`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="change-plan" loading={change.isPending} disabled={!form.priceId || unchanged}>
            Apply change
          </Button>
        </>
      }
    >
      <form
        id="change-plan"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          change.mutate();
        }}
      >
        <FormError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan or add-on" htmlFor="cp-product">
            <Select
              id="cp-product"
              value={form.productId}
              onChange={(e) => setForm({ ...form, productId: e.target.value, priceId: '' })}
              placeholder={products.isLoading ? 'Loading…' : undefined}
              options={(products.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
          </Field>
          <Field label="Price" htmlFor="cp-price" hint={`Only ${sub.currency} prices: changing currency needs a new subscription.`}>
            <Select id="cp-price" value={form.priceId} onChange={(e) => setForm({ ...form, priceId: e.target.value })} placeholder={prices.isLoading ? 'Loading…' : choices.length ? 'Choose a price' : 'No matching prices'} options={choices.map((p) => ({ value: p.id, label: `${priceOptionLabel(p)}${p.id === sub.price_id ? ' (current)' : ''}` }))} />
          </Field>
          <Field label="Quantity" htmlFor="cp-qty" hint={price?.pricingModel === 'per_seat' ? 'Seats' : undefined}>
            <Input id="cp-qty" type="number" min={price?.minQuantity ?? 1} max={price?.maxQuantity ?? undefined} step={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </Field>
          <Field label="When" htmlFor="cp-timing">
            <Select
              id="cp-timing"
              value={form.timing}
              onChange={(e) => setForm({ ...form, timing: e.target.value })}
              options={[
                { value: 'auto', label: 'Automatic (upgrades now, downgrades at period end)' },
                { value: 'immediate', label: 'Immediately' },
                { value: 'period_end', label: 'At the end of the current period' },
              ]}
            />
          </Field>
          <Field label="Proration" htmlFor="cp-prorate">
            <Select
              id="cp-prorate"
              value={form.prorate}
              onChange={(e) => setForm({ ...form, prorate: e.target.value })}
              options={[
                { value: '', label: 'Use the billing settings default' },
                { value: 'true', label: 'Prorate (credit unused time)' },
                { value: 'false', label: 'No proration' },
              ]}
            />
          </Field>
        </div>
        <Callout title="What happens">
          {sub.status === 'trialing'
            ? 'During a trial the new plan applies right away and nothing is charged until the trial ends.'
            : 'Immediate changes credit the unused time of the current plan and charge the remaining time on the new one, which may create an invoice now. A negative difference becomes account credit. Changes at period end are scheduled and can be seen on this page.'}
        </Callout>
      </form>
    </Modal>
  );
}

function CancelDialog({ sub, open, onOpenChange }: { sub: SubscriptionDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [atPeriodEnd, setAtPeriodEnd] = useState(sub.status !== 'paused');
  const [reason, setReason] = useState('');
  const [creditUnused, setCreditUnused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useAction(() => api.post(`/api/admin/subscriptions/${sub.id}/cancel`, { atPeriodEnd, reason: reason.trim() || undefined, creditUnused: !atPeriodEnd && creditUnused }), {
    success: atPeriodEnd ? `Subscription will end on ${date(sub.current_period_end)}` : 'Subscription canceled',
    invalidate: [['subscription', sub.id], ['subscriptions']],
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel subscription"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep subscription
          </Button>
          <Button variant="danger" type="submit" form="cancel-sub" loading={cancel.isPending}>
            {atPeriodEnd ? 'Cancel at period end' : 'Cancel now'}
          </Button>
        </>
      }
    >
      <form
        id="cancel-sub"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          cancel.mutate();
        }}
      >
        <FormError message={error} />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">When</legend>
          {sub.status !== 'paused' && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-ui-sm border p-3 text-sm has-[:checked]:border-primary">
              <input type="radio" name="when" className="mt-0.5 accent-[var(--color-primary)]" checked={atPeriodEnd} onChange={() => setAtPeriodEnd(true)} />
              <span>
                <span className="font-medium">At the end of the period</span>
                <span className="block text-sm text-muted-foreground">Access continues until {date(sub.current_period_end)}; no further charges. Can be undone until then.</span>
              </span>
            </label>
          )}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-ui-sm border p-3 text-sm has-[:checked]:border-primary">
            <input type="radio" name="when" className="mt-0.5 accent-[var(--color-primary)]" checked={!atPeriodEnd} onChange={() => setAtPeriodEnd(false)} />
            <span>
              <span className="font-medium">Immediately</span>
              <span className="block text-sm text-muted-foreground">Access ends now and unpaid open invoices of this subscription are voided. This cannot be undone.</span>
            </span>
          </label>
        </fieldset>
        {!atPeriodEnd && sub.status === 'active' && sub.collection_method !== 'complimentary' && (
          <Checkbox checked={creditUnused} onChange={(e) => setCreditUnused(e.target.checked)} label="Credit unused time" description="Adds the unused part of the current period as account credit (not a refund)." />
        )}
        <Field label="Reason" htmlFor="cancel-reason" hint="Shown in the subscription history and churn reports">
          <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. too expensive, switched provider" />
        </Field>
      </form>
    </Modal>
  );
}

function PauseDialog({ sub, open, onOpenChange }: { sub: SubscriptionDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [resumeAt, setResumeAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pause = useAction(() => api.post(`/api/admin/subscriptions/${sub.id}/pause`, { resumeAt: resumeAt ? new Date(`${resumeAt}T00:00:00`).toISOString() : undefined }), {
    success: 'Subscription paused',
    invalidate: [['subscription', sub.id], ['subscriptions']],
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Pause subscription"
      description="Billing and access stop while paused. Resuming starts a new billing period and charges it."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="pause-sub" loading={pause.isPending}>
            Pause
          </Button>
        </>
      }
    >
      <form
        id="pause-sub"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          pause.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Resume automatically on" htmlFor="pause-resume" hint="Optional. Leave empty to resume manually.">
          <Input id="pause-resume" type="date" value={resumeAt} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setResumeAt(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function ExtendDialog({ sub, open, onOpenChange }: { sub: SubscriptionDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const n = Number(days) || 0;
  const newEnd = new Date(new Date(sub.current_period_end).getTime() + n * 86_400_000);
  const extend = useAction(() => api.post(`/api/admin/subscriptions/${sub.id}/extend`, { days: n, reason }), {
    success: `Extended to ${date(newEnd)}`,
    invalidate: [['subscription', sub.id], ['subscriptions']],
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={sub.status === 'trialing' ? 'Extend trial' : 'Extend current period'}
      description="Free time: the next renewal moves later. Nothing is charged for the extra days."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="extend-sub" loading={extend.isPending} disabled={n < 1}>
            Extend
          </Button>
        </>
      }
    >
      <form
        id="extend-sub"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          extend.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Days" htmlFor="ext-days" hint={n > 0 ? `New end: ${date(newEnd)}` : undefined}>
          <Input id="ext-days" type="number" min={1} max={3650} step={1} value={days} onChange={(e) => setDays(e.target.value)} required />
        </Field>
        <Field label="Reason" htmlFor="ext-reason" hint="Recorded in the audit log">
          <Input id="ext-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />
        </Field>
      </form>
    </Modal>
  );
}

function historyDetail(e: SubscriptionDetail['history'][number]): string | null {
  const d = e.data ?? {};
  const parts: string[] = [];
  if (typeof d.change === 'string') parts.push(d.change.replace(/_/g, ' '));
  if (typeof d.status === 'string') parts.push(`status ${d.status.replace(/_/g, ' ')}`);
  if (typeof d.quantity === 'number') parts.push(`quantity ${d.quantity}`);
  if (typeof d.reason === 'string' && d.reason) parts.push(`reason: ${d.reason}`);
  if (typeof d.endsAt === 'string') parts.push(`ends ${date(d.endsAt)}`);
  if (typeof d.effectiveAt === 'string') parts.push(`effective ${date(d.effectiveAt)}`);
  if (typeof d.periodEnd === 'string') parts.push(`period ends ${date(d.periodEnd)}`);
  if (typeof d.resumeAt === 'string') parts.push(`resumes ${date(d.resumeAt)}`);
  return parts.length ? parts.join(' · ') : null;
}

export default function SubscriptionDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [dialog, setDialog] = useState<'change' | 'cancel' | 'pause' | 'extend' | null>(null);
  const q = useQuery({ queryKey: ['subscription', id], queryFn: () => api.get<SubscriptionDetail>(`/api/admin/subscriptions/${id}`) });
  const scheduledLabel = useScheduledPriceLabel(q.data?.scheduled_change?.priceId);
  const invalidate = [['subscription', id], ['subscriptions']];

  const reactivate = useAction(() => api.post(`/api/admin/subscriptions/${id}/reactivate`), { success: 'Cancellation undone', invalidate });
  const resume = useAction(() => api.post<{ invoice: { number: string | null; total: number; currency: string; status: string } | null }>(`/api/admin/subscriptions/${id}/resume`), {
    invalidate,
    onSuccess: (r) => toast.success('Subscription resumed', r.invoice ? `Invoice ${r.invoice.number ?? ''} for ${money(r.invoice.total, r.invoice.currency)} is ${r.invoice.status}.` : undefined),
  });
  const renew = useAction(() => api.post<{ action: string; invoiceId?: string; outcome?: { status: string; message?: string } }>(`/api/admin/subscriptions/${id}/renew-now`), {
    invalidate,
    onSuccess: (r) => {
      if (r.action === 'skipped') toast.info('Nothing to renew', 'The current period has not ended yet, or its last installment is still due.');
      else if (r.action === 'ended') toast.success('Subscription ended', 'It was scheduled to cancel at period end.');
      else if (r.action === 'completed') toast.success('Paid in full', 'Every installment was paid, so the subscription ended.');
      else toast.success('Renewed', r.outcome ? `Payment ${r.outcome.status}${r.outcome.message ? `: ${r.outcome.message}` : ''}` : undefined);
    },
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const manage = can('billing.subscriptions.manage');
  const live = ['active', 'trialing', 'past_due'].includes(s.status);
  const periodOver = new Date(s.current_period_end).getTime() <= Date.now();
  const customerLabel = s.customer_label ?? s.subject_id;
  // Installment plans keep their price and run to their last payment.
  const changeable = live && !s.payment_count;

  const actions: MenuItem[] = [
    { label: 'Change plan or quantity', icon: <ArrowLeftRight className="size-4" />, onSelect: () => setDialog('change'), hidden: !manage || !changeable },
    { label: s.status === 'trialing' ? 'Extend trial' : 'Extend period', icon: <CalendarPlus className="size-4" />, onSelect: () => setDialog('extend'), hidden: !manage || !live },
    { label: 'Pause', icon: <CirclePause className="size-4" />, onSelect: () => setDialog('pause'), hidden: !manage || s.status !== 'active' || Boolean(s.payment_count) },
    { label: 'Resume now', icon: <CirclePlay className="size-4" />, hidden: !manage || s.status !== 'paused', onSelect: async () => {
      const r = await confirm({ title: 'Resume this subscription?', description: s.collection_method === 'complimentary' ? 'A new period starts today.' : 'A new period starts today and is charged now.', confirmLabel: 'Resume' });
      if (r.confirmed) resume.mutate();
    } },
    { label: 'Renew now', icon: <RefreshCw className="size-4" />, hidden: !manage || !live || !periodOver, onSelect: () => renew.mutate() },
    { separator: true, label: '', hidden: !manage },
    { label: 'Undo cancellation', icon: <RotateCcw className="size-4" />, hidden: !manage || !s.cancel_at_period_end || s.status === 'canceled', onSelect: () => reactivate.mutate() },
    { label: 'Cancel subscription…', icon: <CircleX className="size-4" />, danger: true, hidden: !manage || s.status === 'canceled' || (s.cancel_at_period_end && s.status !== 'paused'), onSelect: () => setDialog('cancel') },
  ];
  const visibleActions = actions.filter((a) => !a.hidden && !a.separator);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Subscriptions', to: '/revenue/subscriptions' }, { label: s.id }]}
        documentTitle={`${s.product_name} · ${customerLabel}`}
        title={s.product_name}
        description={customerLabel}
        meta={
          <>
            <StatusBadge status={s.status} />
            {s.cancel_at_period_end && s.status !== 'canceled' && <Badge tone="warning">cancels {date(s.current_period_end)}</Badge>}
            <Badge>{COLLECTION[s.collection_method] ?? s.collection_method}</Badge>
            <Mono copy>{s.id}</Mono>
          </>
        }
        actions={
          <>
            {manage && changeable && (
              <Button variant="outline" icon={<ArrowLeftRight className="size-4" />} onClick={() => setDialog('change')}>
                Change plan
              </Button>
            )}
            {visibleActions.length > 0 && <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>} items={actions} />}
          </>
        }
      />

      <div className="mb-4 space-y-3">
        {s.scheduled_change && (
          <Callout title="Change scheduled for the end of the period">
            Moves to {scheduledLabel.data ?? <Mono>{s.scheduled_change.priceId}</Mono>}
            {` with quantity ${s.scheduled_change.quantity} on ${date(s.current_period_end)}.`}
          </Callout>
        )}
        {s.status === 'past_due' && (
          <Callout tone="warning" title="Payment failed">
            {s.payment_attempts} attempt{s.payment_attempts === 1 ? '' : 's'} so far.
            {s.next_payment_attempt_at ? ` Next retry ${dateTime(s.next_payment_attempt_at)}.` : ''}
            {s.grace_until ? ` Access continues until ${dateTime(s.grace_until)} (grace period).` : ''}
          </Callout>
        )}
        {s.status === 'paused' && (
          <Callout tone="warning" title="Paused">
            Paused {dateTime(s.paused_at)}. {s.resume_at ? `Resumes automatically on ${date(s.resume_at)}.` : 'Resume it manually from the actions menu.'}
          </Callout>
        )}
        {s.status === 'canceled' &&
          (s.cancel_reason === 'installments_completed' ? (
            <Callout tone="success" title="Paid in full">
              All {s.installments_paid} installments were paid; the subscription ended {dateTime(s.ended_at)}.{' '}
              {s.after_last_payment === 'keep_access' ? 'The customer keeps the product.' : 'Access ended with the last paid period.'}
            </Callout>
          ) : (
            <Callout tone="info" title="Canceled">
              Ended {dateTime(s.ended_at)}{s.cancel_reason ? ` — ${s.cancel_reason}` : ''}.
            </Callout>
          ))}
        {s.cancel_at_period_end && s.status !== 'canceled' && s.cancel_reason && (
          <Callout tone="warning" title="Cancellation requested">
            Reason: {s.cancel_reason}
          </Callout>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Details">
            <KeyValue
              items={[
                { label: 'Price', value: s.collection_method === 'complimentary' ? `${priceText(s, s.quantity)} (not charged)` : priceText(s, s.quantity) },
                { label: 'Quantity', value: s.quantity },
                { label: 'Current period', value: `${date(s.current_period_start)} – ${date(s.current_period_end)}` },
                { label: periodLabel(s), value: dateTime(s.status === 'canceled' ? s.ended_at : s.current_period_end) },
                { label: 'Trial', value: s.trial_start ? `${date(s.trial_start)} – ${date(s.trial_end)}` : null, hidden: !s.trial_start },
                {
                  label: 'Installments',
                  value: s.payment_count
                    ? `${s.installments_paid} of ${s.payment_count} paid · ${s.after_last_payment === 'keep_access' ? 'the customer keeps the product after the last one' : 'access ends after the last paid period'}`
                    : null,
                  hidden: !s.payment_count,
                },
                {
                  label: 'Payment method',
                  value:
                    s.pm_brand || s.pm_last4
                      ? `${s.pm_brand ?? 'Card'} •••• ${s.pm_last4 ?? ''}${s.pm_exp_month && s.pm_exp_year ? ` · expires ${String(s.pm_exp_month).padStart(2, '0')}/${s.pm_exp_year}` : ''}`
                      : s.collection_method === 'charge_automatically'
                        ? 'None on file'
                        : '—',
                },
                { label: 'Coupon', value: s.coupon_code ? <span className="font-mono">{s.coupon_code}{s.discount_cycles_remaining !== null ? ` · ${s.discount_cycles_remaining} cycle(s) left` : ''}</span> : null, hidden: !s.coupon_code },
                { label: 'Introductory price', value: s.intro_cycles_remaining ? `${s.intro_cycles_remaining} cycle(s) left` : null, hidden: !s.intro_cycles_remaining },
                { label: 'Started', value: dateTime(s.created_at) },
                { label: 'Cancellation requested', value: dateTime(s.canceled_at), hidden: !s.canceled_at },
              ]}
            />
          </Card>

          <Card title="Invoices" padded={false}>
            <DataTable
              caption="Invoices for this subscription"
              rows={s.invoices}
              rowKey={(i) => i.id}
              rowHref={(i) => `/revenue/invoices/${i.id}`}
              empty={<EmptyState title="No invoices yet" description={s.status === 'trialing' ? 'The first invoice is issued when the trial ends.' : undefined} />}
              columns={[
                { key: 'number', header: 'Number', cell: (i) => i.number ?? 'Draft' },
                { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
                { key: 'period', header: 'Period', cell: (i) => (i.period_start ? `${date(i.period_start)} – ${date(i.period_end)}` : '—') },
                { key: 'total', header: 'Total', align: 'right', cell: (i) => <span className="tabular">{money(i.total, i.currency)}</span> },
                { key: 'created', header: 'Issued', cell: (i) => <When value={i.created_at} /> },
              ]}
            />
          </Card>

          <Card title="History" padded={false}>
            {s.history.length === 0 ? (
              <EmptyState title="No history recorded" />
            ) : (
              <ol className="divide-y">
                {s.history.map((e) => {
                  const detail = historyDetail(e);
                  return (
                    <li key={e.id} className="flex gap-3 px-4 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{e.type.replace('subscription.', '').replace(/_/g, ' ')}</span>
                        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <When value={e.created_at} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <CustomerBillingCard type={s.subject_type} id={s.subject_id} label={customerLabel} currency={s.currency} />
          {Object.keys(s.metadata ?? {}).length > 0 && (
            <Card title="Metadata">
              <JsonView value={s.metadata} />
            </Card>
          )}
        </div>
      </div>

      {dialog === 'change' && <ChangePlanDialog sub={s} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog === 'cancel' && <CancelDialog sub={s} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog === 'pause' && <PauseDialog sub={s} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog === 'extend' && <ExtendDialog sub={s} open onOpenChange={(o) => !o && setDialog(null)} />}
    </>
  );
}
