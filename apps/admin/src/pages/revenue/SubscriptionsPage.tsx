import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { date } from '../../lib/format';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Toolbar,
  When,
  type Column,
} from '../../components/ui';
import { CustomerPicker, SUBSCRIPTION_STATUSES, SubjectIcon, cleanQuery, dayEnd, priceText, statusOptions, subjectBody, type PickedCustomer } from './shared';

export interface SubscriptionRow {
  id: string;
  subject_type: 'user' | 'organization';
  subject_id: string;
  status: string;
  quantity: number;
  currency: string;
  collection_method: string;
  current_period_start: string;
  current_period_end: string;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  ended_at: string | null;
  paused_at: string | null;
  scheduled_change: { priceId: string; quantity: number } | null;
  created_at: string;
  product_name: string;
  product_key: string;
  unit_amount: number;
  interval: string | null;
  interval_count: number;
  pricing_model: string;
  customer_label: string | null;
}

interface ProductOption {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
}

interface PriceOption {
  id: string;
  nickname: string | null;
  currency: string;
  type: string;
  interval: string | null;
  intervalCount: number;
  pricingModel: string;
  unitAmount: number;
  minQuantity: number;
  maxQuantity: number | null;
  active: boolean;
}

const DEFAULTS = { q: '', status: '', productId: '', renewingBefore: '', userId: '', orgId: '', page: 1, pageSize: 25 };

/** "Renews", "Trial ends", "Ends", "Ended" for the current period boundary. */
export function periodLabel(s: Pick<SubscriptionRow, 'status' | 'cancel_at_period_end' | 'ended_at'>): string {
  if (s.status === 'canceled') return 'Ended';
  if (s.status === 'trialing') return 'Trial ends';
  if (s.cancel_at_period_end) return 'Ends';
  if (s.status === 'paused') return 'Paused';
  return 'Renews';
}

export function usePlanProducts(enabled = true) {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['products', 'recurring-options'],
    queryFn: async () => {
      const [plans, addons] = await Promise.all([
        api.get<{ data: ProductOption[] }>('/api/admin/products', { kind: 'plan' }),
        api.get<{ data: ProductOption[] }>('/api/admin/products', { kind: 'addon' }),
      ]);
      return [...plans.data, ...addons.data].filter((p) => p.status !== 'archived');
    },
    enabled: enabled && can('catalog.products.view'),
    staleTime: 5 * 60_000,
  });
}

export function useRecurringPrices(productId: string | null | undefined) {
  return useQuery({
    queryKey: ['revenue-product', productId],
    queryFn: () => api.get<{ id: string; name: string; prices: PriceOption[] }>(`/api/admin/products/${productId}`),
    enabled: Boolean(productId),
    select: (p) => p.prices.filter((pr) => pr.active && pr.type === 'recurring'),
  });
}

export function priceOptionLabel(p: PriceOption): string {
  const base = priceText({ unit_amount: p.unitAmount, currency: p.currency, interval: p.interval, interval_count: p.intervalCount, pricing_model: p.pricingModel });
  const text = p.pricingModel === 'per_seat' ? base.replace(/ · 1 seat$/, ' per seat') : base;
  return p.nickname ? `${p.nickname} — ${text}` : text;
}

function CreateSubscriptionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const products = usePlanProducts(open);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [form, setForm] = useState({ productId: '', priceId: '', quantity: '1', collectionMethod: 'complimentary', trialDays: '0', couponCode: '', reason: '' });
  const prices = useRecurringPrices(form.productId || null);
  const price = prices.data?.find((p) => p.id === form.priceId);
  const [error, setError] = useState<string | null>(null);

  const create = useAction(
    async () => {
      if (!customer) throw new Error('Choose the customer to subscribe');
      return api.post<{ id: string }>('/api/admin/subscriptions', {
        ...subjectBody(customer),
        priceId: form.priceId,
        quantity: Number(form.quantity) || 1,
        collectionMethod: form.collectionMethod,
        trialDays: Number(form.trialDays) || 0,
        couponCode: form.couponCode.trim() || undefined,
        reason: form.reason.trim() || undefined,
      });
    },
    {
      success: 'Subscription created',
      invalidate: [['subscriptions']],
      onSuccess: (s) => {
        onOpenChange(false);
        navigate(`/revenue/subscriptions/${s.id}`);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New subscription"
      description="Grant a plan directly: complimentary (no charge) or billed by invoice. Self-serve purchases go through checkout instead."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-subscription" loading={create.isPending} disabled={!customer || !form.priceId}>
            Create subscription
          </Button>
        </>
      }
    >
      <form
        id="create-subscription"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Customer" required>
          <CustomerPicker value={customer} onChange={setCustomer} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan or add-on" htmlFor="ns-product" required>
            <Select
              id="ns-product"
              value={form.productId}
              onChange={(e) => setForm({ ...form, productId: e.target.value, priceId: '' })}
              placeholder={products.isLoading ? 'Loading…' : 'Choose a product'}
              options={(products.data ?? []).map((p) => ({ value: p.id, label: `${p.name}${p.kind === 'addon' ? ' (add-on)' : ''}${p.status === 'draft' ? ' — draft' : ''}` }))}
              required
            />
          </Field>
          <Field label="Price" htmlFor="ns-price" required>
            <Select
              id="ns-price"
              value={form.priceId}
              onChange={(e) => setForm({ ...form, priceId: e.target.value })}
              placeholder={!form.productId ? 'Choose a product first' : prices.isLoading ? 'Loading…' : prices.data?.length ? 'Choose a price' : 'No recurring prices'}
              options={(prices.data ?? []).map((p) => ({ value: p.id, label: priceOptionLabel(p) }))}
              disabled={!form.productId}
              required
            />
          </Field>
          <Field label="Quantity" htmlFor="ns-qty" hint={price?.pricingModel === 'per_seat' ? 'Number of seats' : undefined}>
            <Input id="ns-qty" type="number" min={price?.minQuantity ?? 1} max={price?.maxQuantity ?? undefined} step={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </Field>
          <Field label="Billing" htmlFor="ns-collection">
            <Select
              id="ns-collection"
              value={form.collectionMethod}
              onChange={(e) => setForm({ ...form, collectionMethod: e.target.value })}
              options={[
                { value: 'complimentary', label: 'Complimentary (no charge)' },
                { value: 'send_invoice', label: 'Send invoices' },
              ]}
            />
          </Field>
          <Field label="Trial days" htmlFor="ns-trial">
            <Input id="ns-trial" type="number" min={0} max={365} step={1} value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
          </Field>
          <Field label="Coupon code" htmlFor="ns-coupon" hint="Optional">
            <Input id="ns-coupon" value={form.couponCode} onChange={(e) => setForm({ ...form, couponCode: e.target.value })} className="font-mono uppercase" />
          </Field>
          <Field label="Internal reason" htmlFor="ns-reason" hint="Recorded in the audit log, e.g. partner deal or support goodwill" className="sm:col-span-2">
            <Input id="ns-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={500} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

export default function SubscriptionsPage() {
  const { can } = useAuth();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  const [creating, setCreating] = useState(false);
  const products = usePlanProducts();

  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
  }, [q]);

  const query = useMemo(() => {
    const out = cleanQuery(state, ['renewingBefore']);
    const before = dayEnd(state.renewingBefore);
    if (before) out.renewingBefore = before;
    return out;
  }, [state]);

  const list = useQuery({
    queryKey: ['subscriptions', query],
    queryFn: ({ signal }) => api.get<Page<SubscriptionRow>>('/api/admin/subscriptions', query, signal),
    placeholderData: keepPreviousData,
  });

  const scoped = Boolean(state.userId || state.orgId);
  const filtered = Boolean(state.q || state.status || state.productId || state.renewingBefore || scoped);

  const columns: Column<SubscriptionRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-2">
          <SubjectIcon type={s.subject_type} />
          <span className="truncate">{s.customer_label ?? s.subject_id}</span>
        </span>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      cell: (s) => (
        <span>
          {s.product_name}
          {s.quantity > 1 && <span className="text-muted-foreground"> × {s.quantity}</span>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge status={s.status} />
          {s.cancel_at_period_end && s.status !== 'canceled' && <Badge tone="warning">cancels</Badge>}
          {s.scheduled_change && <Badge tone="info">change scheduled</Badge>}
        </span>
      ),
    },
    { key: 'price', header: 'Price', align: 'right', cell: (s) => <span className="tabular whitespace-nowrap">{s.collection_method === 'complimentary' ? <Badge>complimentary</Badge> : priceText(s, s.quantity)}</span> },
    {
      key: 'period',
      header: 'Period ends',
      cell: (s) => (
        <span className="whitespace-nowrap">
          <span className="text-xs text-muted-foreground">{periodLabel(s)} </span>
          {date(s.status === 'canceled' ? s.ended_at : s.current_period_end)}
        </span>
      ),
    },
    { key: 'created_at', header: 'Started', priority: 'low', cell: (s) => <When value={s.created_at} /> },
  ];

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Recurring plans and add-ons, their status, renewals and cancellations."
        actions={
          can('billing.subscriptions.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New subscription
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search email, organization or ID…" className="w-full sm:w-72" />
          <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={statusOptions(SUBSCRIPTION_STATUSES)} />
          {products.data && products.data.length > 0 && (
            <Select aria-label="Plan" className="w-auto max-w-48" value={String(state.productId)} onChange={(e) => setState({ productId: e.target.value })} placeholder="Any plan" options={products.data.map((p) => ({ value: p.id, label: p.name }))} />
          )}
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="whitespace-nowrap">Renewing by</span>
            <Input type="date" aria-label="Renewing by date" className="w-auto" value={String(state.renewingBefore)} onChange={(e) => setState({ renewingBefore: e.target.value })} />
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
            caption="Subscriptions"
            columns={columns}
            rows={list.data?.data}
            rowKey={(s) => s.id}
            rowHref={(s) => `/revenue/subscriptions/${s.id}`}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={
              filtered ? (
                <EmptyState title="No subscriptions match these filters" action={<Button variant="outline" onClick={() => { setSearch(''); reset(); }}>Clear filters</Button>} />
              ) : (
                <EmptyState title="No subscriptions yet" description="Subscriptions are created when customers complete checkout, or by an administrator." />
              )
            }
          />
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      {creating && <CreateSubscriptionDialog open={creating} onOpenChange={setCreating} />}
    </>
  );
}
