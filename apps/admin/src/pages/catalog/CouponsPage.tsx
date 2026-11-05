import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, Download, Layers, MoreHorizontal, Plus, RotateCcw, Shuffle, TicketPercent } from 'lucide-react';
import { api, download, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { dateTime, money, num } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  Menu,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Toolbar,
  When,
  useConfirm,
  useToast,
  type Column,
} from '../../components/ui';
import { MoneyInput, useCurrencies, useFormErrors, useProductList } from './shared';

interface Coupon {
  id: string;
  code: string;
  name: string;
  discount_type: 'percent' | 'fixed';
  percent_off_bps: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  duration_cycles: number | null;
  max_redemptions: number | null;
  redeemed_count: number;
  max_per_customer: number;
  applies_to: string[];
  first_purchase_only: boolean;
  min_amount: number | null;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  campaign: string | null;
  affiliate_id: string | null;
  batch_id: string | null;
  created_at: string;
}

/** A batch of single-use codes; the terms are those every code in it shares. */
interface CouponBatch {
  id: string;
  name: string;
  prefix: string;
  count: number;
  campaign: string | null;
  created_at: string;
  codes: number;
  redeemed: number;
  active_codes: number;
  discount_type: Coupon['discount_type'];
  percent_off_bps: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: Coupon['duration'];
  duration_cycles: number | null;
  starts_at: string | null;
  expires_at: string | null;
}

interface Redemption {
  id: string;
  user_id: string | null;
  org_id: string | null;
  order_id: string | null;
  subscription_id: string | null;
  discount_amount: number | null;
  currency: string | null;
  user_email: string | null;
  created_at: string;
}

type Terms = Pick<Coupon, 'discount_type' | 'percent_off_bps' | 'amount_off' | 'currency' | 'duration' | 'duration_cycles'>;

const discountText = (c: Terms) => (c.discount_type === 'percent' ? `${num((c.percent_off_bps ?? 0) / 100, { digits: 2 })}% off` : `${money(c.amount_off, c.currency ?? 'USD')} off`);
const durationText = (c: Terms) => (c.duration === 'once' ? 'First payment' : c.duration === 'forever' ? 'Every payment' : `${c.duration_cycles} billing cycles`);

/** The state a customer would experience right now. */
function couponState(c: Coupon, now = Date.now()): string {
  if (!c.active) return 'inactive';
  if (c.expires_at && new Date(c.expires_at).getTime() <= now) return 'expired';
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return 'scheduled';
  if (c.max_redemptions !== null && c.redeemed_count >= c.max_redemptions) return 'exhausted';
  return 'active';
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

// ---- Terms shared by single coupons and generated batches --------------------------------

interface TermsForm {
  discountType: 'percent' | 'fixed';
  percentOff: string;
  amountOff: number | null;
  currency: string;
  duration: Coupon['duration'];
  durationCycles: string;
  appliesTo: string[];
  firstPurchaseOnly: boolean;
  minAmount: number | null;
  startsAt: string;
  expiresAt: string;
  campaign: string;
}

const TERM_FIELDS = ['percentOff', 'amountOff', 'durationCycles', 'minAmount', 'startsAt', 'expiresAt', 'campaign', 'appliesTo'];

function initialTerms(currency: string): TermsForm {
  return { discountType: 'percent', percentOff: '20', amountOff: null, currency, duration: 'once', durationCycles: '3', appliesTo: [], firstPurchaseOnly: false, minAmount: null, startsAt: '', expiresAt: '', campaign: '' };
}

function termsBody(f: TermsForm) {
  return {
    discountType: f.discountType,
    percentOff: f.discountType === 'percent' ? Number(f.percentOff) : undefined,
    amountOff: f.discountType === 'fixed' ? f.amountOff ?? undefined : undefined,
    currency: f.discountType === 'fixed' ? f.currency : undefined,
    duration: f.duration,
    durationCycles: f.duration === 'repeating' ? Number(f.durationCycles) : undefined,
    appliesTo: f.appliesTo,
    firstPurchaseOnly: f.firstPurchaseOnly,
    minAmount: f.minAmount ?? undefined,
    startsAt: fromLocalInput(f.startsAt),
    expiresAt: fromLocalInput(f.expiresAt),
    campaign: f.campaign.trim() || undefined,
  };
}

/** Discount, duration, validity and product restrictions. */
function TermsFields({ id, terms, onChange, errors }: { id: string; terms: TermsForm; onChange: (t: TermsForm) => void; errors: Record<string, string> }) {
  const { base, all } = useCurrencies();
  const products = useProductList();
  const [moneyKey, setMoneyKey] = useState(0);
  const set = <K extends keyof TermsForm>(k: K, v: TermsForm[K]) => onChange({ ...terms, [k]: v });
  const sellable = (products.data?.data ?? []).filter((p) => p.status !== 'archived');
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Discount" htmlFor={`${id}-type`}>
          <Select id={`${id}-type`} value={terms.discountType} onChange={(e) => set('discountType', e.target.value as TermsForm['discountType'])} options={[{ value: 'percent', label: 'Percentage' }, { value: 'fixed', label: 'Fixed amount' }]} />
        </Field>
        {terms.discountType === 'percent' ? (
          <Field label="Percent off" htmlFor={`${id}-pct`} error={errors.percentOff} required>
            <Input id={`${id}-pct`} type="number" min={0.01} max={100} step="0.01" value={terms.percentOff} onChange={(e) => set('percentOff', e.target.value)} required />
          </Field>
        ) : (
          <>
            <Field label="Currency" htmlFor={`${id}-cur`}>
              <Select
                id={`${id}-cur`}
                value={terms.currency}
                onChange={(e) => {
                  onChange({ ...terms, currency: e.target.value, amountOff: null });
                  setMoneyKey((k) => k + 1);
                }}
                options={all}
              />
            </Field>
            <Field label="Amount off" htmlFor={`${id}-amt`} error={errors.amountOff} required>
              <MoneyInput key={moneyKey} id={`${id}-amt`} value={terms.amountOff} currency={terms.currency} onChange={(v) => set('amountOff', v)} required />
            </Field>
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Applies to" htmlFor={`${id}-duration`} hint="For subscriptions">
          <Select id={`${id}-duration`} value={terms.duration} onChange={(e) => set('duration', e.target.value as Coupon['duration'])} options={[{ value: 'once', label: 'First payment only' }, { value: 'repeating', label: 'Several billing cycles' }, { value: 'forever', label: 'Every payment' }]} />
        </Field>
        {terms.duration === 'repeating' && (
          <Field label="Billing cycles" htmlFor={`${id}-cycles`} error={errors.durationCycles}>
            <Input id={`${id}-cycles`} type="number" min={1} max={120} value={terms.durationCycles} onChange={(e) => set('durationCycles', e.target.value)} />
          </Field>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Minimum order" htmlFor={`${id}-min`} hint="Optional" error={errors.minAmount}>
          <MoneyInput id={`${id}-min`} value={terms.minAmount} currency={base} onChange={(v) => set('minAmount', v)} placeholder="None" />
        </Field>
        <Field label="Campaign" htmlFor={`${id}-campaign`} hint="For reporting">
          <Input id={`${id}-campaign`} value={terms.campaign} onChange={(e) => set('campaign', e.target.value)} />
        </Field>
        <Field label="Starts" htmlFor={`${id}-start`} hint="Empty: immediately" error={errors.startsAt}>
          <Input id={`${id}-start`} type="datetime-local" value={terms.startsAt} onChange={(e) => set('startsAt', e.target.value)} />
        </Field>
        <Field label="Expires" htmlFor={`${id}-exp`} hint="Empty: never" error={errors.expiresAt}>
          <Input id={`${id}-exp`} type="datetime-local" value={terms.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Restrict to products</legend>
        <p className="text-xs text-muted-foreground">Leave all unchecked to allow every product.</p>
        <div className="grid max-h-44 gap-x-4 gap-y-2 overflow-y-auto rounded-ui-sm border p-3 sm:grid-cols-2">
          {sellable.map((p) => (
            <Checkbox
              key={p.id}
              label={p.name}
              description={p.key}
              checked={terms.appliesTo.includes(p.id)}
              onChange={(e) => set('appliesTo', e.target.checked ? [...terms.appliesTo, p.id] : terms.appliesTo.filter((x) => x !== p.id))}
            />
          ))}
          {!sellable.length && <p className="text-sm text-muted-foreground">No products yet.</p>}
        </div>
      </fieldset>
      <Checkbox checked={terms.firstPurchaseOnly} onChange={(e) => set('firstPurchaseOnly', e.target.checked)} label="First purchase only" description="Only customers who have never paid before can use it." />
    </>
  );
}

function CreateCouponDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { base } = useCurrencies();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [maxPerCustomer, setMaxPerCustomer] = useState('1');
  const [terms, setTerms] = useState(() => initialTerms(base));
  const errors = useFormErrors();
  const create = useAction(
    () =>
      api.post<Coupon>('/api/admin/coupons', {
        code: code.trim(),
        name: name.trim(),
        ...termsBody(terms),
        maxRedemptions: maxRedemptions ? Number(maxRedemptions) : undefined,
        maxPerCustomer: Number(maxPerCustomer) || 1,
      }),
    {
      success: (c) => `Coupon ${c.code} created`,
      invalidate: [['coupons']],
      onSuccess: () => onOpenChange(false),
      onError: (err) => errors.set(err, ['code', 'name', 'maxRedemptions', 'maxPerCustomer', ...TERM_FIELDS]),
    },
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New coupon"
      description="Customers enter the code at checkout. Discounts are validated and applied on the server."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="coupon-form" loading={create.isPending}>
            Create coupon
          </Button>
        </>
      }
    >
      <form
        id="coupon-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          create.mutate();
        }}
      >
        <FormError message={errors.general} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" htmlFor="cp-code" required error={errors.fields.code} hint="Letters, numbers, dashes and underscores">
            <div className="flex gap-2">
              <Input id="cp-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="flex-1 font-mono" required autoFocus />
              <Button variant="outline" size="icon" aria-label="Generate a random code" onClick={() => setCode(randomCode())}>
                <Shuffle className="size-4" />
              </Button>
            </div>
          </Field>
          <Field label="Internal name" htmlFor="cp-name" required error={errors.fields.name}>
            <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring launch 20%" required />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Total redemptions" htmlFor="cp-max" hint="Empty: unlimited" error={errors.fields.maxRedemptions}>
            <Input id="cp-max" type="number" min={1} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
          </Field>
          <Field label="Per customer" htmlFor="cp-per" error={errors.fields.maxPerCustomer}>
            <Input id="cp-per" type="number" min={1} max={1000} value={maxPerCustomer} onChange={(e) => setMaxPerCustomer(e.target.value)} />
          </Field>
        </div>
        <TermsFields id="cp" terms={terms} onChange={setTerms} errors={errors.fields} />
      </form>
    </Modal>
  );
}

function BatchDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (b: CouponBatch) => void }) {
  const { base } = useCurrencies();
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [count, setCount] = useState('100');
  const [codeLength, setCodeLength] = useState('8');
  const [terms, setTerms] = useState(() => initialTerms(base));
  const errors = useFormErrors();
  const length = Number(codeLength) || 8;
  const create = useAction(
    () => api.post<CouponBatch>('/api/admin/coupon-batches', { name: name.trim(), prefix: prefix.trim(), count: Number(count) || 0, codeLength: length, ...termsBody(terms) }),
    {
      success: (b) => `${num(b.codes)} codes generated`,
      invalidate: [['coupon-batches'], ['coupons']],
      onSuccess: (b) => {
        onOpenChange(false);
        onCreated(b);
      },
      onError: (err) => errors.set(err, ['name', 'prefix', 'count', 'codeLength', ...TERM_FIELDS]),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Generate coupon codes"
      description="Every code gets the same discount and can be redeemed once, by one customer. Export the codes to send them out."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="batch-form" loading={create.isPending}>
            Generate {num(Number(count) || 0)} codes
          </Button>
        </>
      }
    >
      <form
        id="batch-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          create.mutate();
        }}
      >
        <FormError message={errors.general} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Batch name" htmlFor="cb-name" required error={errors.fields.name} hint="Also the internal name of every code">
            <Input id="cb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring mailer" required autoFocus />
          </Field>
          <Field label="Number of codes" htmlFor="cb-count" required error={errors.fields.count} hint="Up to 5,000 per batch">
            <Input id="cb-count" type="number" min={1} max={5000} value={count} onChange={(e) => setCount(e.target.value)} required />
          </Field>
          <Field label="Prefix" htmlFor="cb-prefix" error={errors.fields.prefix} hint={`Codes look like ${(prefix.trim() || '').toUpperCase()}${'X'.repeat(Math.min(Math.max(length, 6), 16))}`}>
            <Input id="cb-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="SPRING-" maxLength={20} className="font-mono" />
          </Field>
          <Field label="Random characters" htmlFor="cb-length" error={errors.fields.codeLength}>
            <Input id="cb-length" type="number" min={6} max={16} value={codeLength} onChange={(e) => setCodeLength(e.target.value)} />
          </Field>
        </div>
        <TermsFields id="cb" terms={terms} onChange={setTerms} errors={errors.fields} />
      </form>
    </Modal>
  );
}

function BatchesCard({ onShow }: { onShow: (batch: CouponBatch) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const batches = useQuery({ queryKey: ['coupon-batches'], queryFn: () => api.get<{ data: CouponBatch[] }>('/api/admin/coupon-batches') });
  const toggle = useAction(({ batch, active }: { batch: CouponBatch; active: boolean }) => api.patch<CouponBatch>(`/api/admin/coupon-batches/${batch.id}`, { active }), {
    success: (_r, v) => (v.active ? `${v.batch.name} reactivated` : `${v.batch.name} deactivated`),
    invalidate: [['coupon-batches'], ['coupons']],
  });
  const exportCodes = async (b: CouponBatch) => {
    try {
      await download(`/api/admin/coupon-batches/${b.id}/codes.csv`, undefined, 'coupon-codes.csv');
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : undefined);
    }
  };
  if (!batches.data?.data.length) return null;
  const columns: Column<CouponBatch>[] = [
    {
      key: 'name',
      header: 'Batch',
      cell: (b) => (
        <span className="min-w-0">
          <span className="block">{b.name}</span>
          <span className="block font-mono text-xs text-muted-foreground">{b.prefix ? `${b.prefix}…` : 'No prefix'}</span>
        </span>
      ),
    },
    { key: 'discount', header: 'Discount', cell: (b) => discountText(b) },
    { key: 'redeemed', header: 'Redeemed', align: 'right', cell: (b) => <span className="tabular">{num(b.redeemed)} / {num(b.codes)}</span> },
    { key: 'status', header: 'Status', cell: (b) => (b.active_codes === 0 ? <StatusBadge status="inactive" /> : b.expires_at && new Date(b.expires_at).getTime() <= Date.now() ? <StatusBadge status="expired" /> : <StatusBadge status="active" />) },
    { key: 'created', header: 'Created', priority: 'low', cell: (b) => <When value={b.created_at} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (b) => (
        <Menu
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${b.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          }
          items={[
            { label: 'Show codes', icon: <Layers className="size-4" />, onSelect: () => onShow(b) },
            { label: 'Export CSV', icon: <Download className="size-4" />, onSelect: () => void exportCodes(b) },
            {
              label: 'Deactivate all codes',
              icon: <Ban className="size-4" />,
              danger: true,
              hidden: !can('catalog.coupons.manage') || b.active_codes === 0,
              onSelect: async () => {
                const r = await confirm({ title: `Deactivate ${b.name}?`, description: 'None of its codes can be redeemed any more. Discounts already applied are not changed.', confirmLabel: 'Deactivate', tone: 'danger' });
                if (r.confirmed) toggle.mutate({ batch: b, active: false });
              },
            },
            { label: 'Reactivate codes', icon: <RotateCcw className="size-4" />, hidden: !can('catalog.coupons.manage') || b.active_codes > 0, onSelect: () => toggle.mutate({ batch: b, active: true }) },
          ]}
        />
      ),
    },
  ];
  return (
    <Card title="Code batches" description="Single-use codes generated from one set of terms." padded={false}>
      <DataTable caption="Code batches" columns={columns} rows={batches.data.data} rowKey={(b) => b.id} />
    </Card>
  );
}

function CouponDialog({ coupon, onOpenChange }: { coupon: Coupon; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const products = useProductList();
  const manage = can('catalog.coupons.manage');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(coupon.name);
  const [expiresAt, setExpiresAt] = useState(toLocalInput(coupon.expires_at));
  const [maxRedemptions, setMaxRedemptions] = useState(coupon.max_redemptions ? String(coupon.max_redemptions) : '');
  const errors = useFormErrors();
  const redemptions = useQuery({ queryKey: ['coupon-redemptions', coupon.id], queryFn: () => api.get<{ data: Redemption[] }>(`/api/admin/coupons/${coupon.id}/redemptions`) });
  const update = useAction((body: Record<string, unknown>) => api.patch<Coupon>(`/api/admin/coupons/${coupon.id}`, body), {
    success: (_r, b) => (b.active === false ? 'Coupon deactivated' : b.active === true ? 'Coupon reactivated' : 'Coupon updated'),
    invalidate: [['coupons'], ['coupon-batches']],
    onSuccess: () => setEditing(false),
    onError: (err) => errors.set(err, ['name', 'expiresAt', 'maxRedemptions']),
  });
  const productName = (id: string) => products.data?.data.find((p) => p.id === id)?.name ?? id;
  const state = couponState(coupon);

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{coupon.code}</span>
          <CopyButton value={coupon.code} label="Copy code" />
          <StatusBadge status={state} />
        </span>
      }
      description={coupon.name}
      size="lg"
      footer={
        manage && (
          <>
            {coupon.active ? (
              <Button
                variant="outline"
                className="text-danger"
                onClick={async () => {
                  const r = await confirm({ title: `Deactivate ${coupon.code}?`, description: 'Customers can no longer redeem it. Discounts already applied to subscriptions are not changed.', confirmLabel: 'Deactivate', tone: 'danger' });
                  if (r.confirmed) update.mutate({ active: false });
                }}
              >
                Deactivate
              </Button>
            ) : (
              <Button variant="outline" onClick={() => update.mutate({ active: true })}>
                Reactivate
              </Button>
            )}
            {editing ? (
              <Button
                loading={update.isPending}
                onClick={() => {
                  errors.clear();
                  update.mutate({ name: name.trim(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null });
                }}
              >
                Save changes
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-5">
        <FormError message={errors.general} />
        {editing ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Internal name" htmlFor="ce-name" error={errors.fields.name}>
              <Input id="ce-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Expires" htmlFor="ce-exp" hint="Empty: never" error={errors.fields.expiresAt}>
              <Input id="ce-exp" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
            <Field label="Total redemptions" htmlFor="ce-max" hint="Empty: unlimited" error={errors.fields.maxRedemptions}>
              <Input id="ce-max" type="number" min={1} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
            </Field>
          </div>
        ) : (
          <KeyValue
            columns={3}
            items={[
              { label: 'Discount', value: discountText(coupon) },
              { label: 'Duration', value: durationText(coupon) },
              { label: 'Redeemed', value: `${num(coupon.redeemed_count)}${coupon.max_redemptions ? ` of ${num(coupon.max_redemptions)}` : ''}` },
              { label: 'Per customer', value: num(coupon.max_per_customer) },
              { label: 'Minimum order', value: coupon.min_amount ? money(coupon.min_amount, coupon.currency ?? undefined) : 'None' },
              { label: 'First purchase only', value: coupon.first_purchase_only ? 'Yes' : 'No' },
              { label: 'Starts', value: coupon.starts_at ? dateTime(coupon.starts_at) : 'Immediately' },
              { label: 'Expires', value: coupon.expires_at ? dateTime(coupon.expires_at) : 'Never' },
              { label: 'Campaign', value: coupon.campaign },
              { label: 'Products', value: coupon.applies_to.length ? coupon.applies_to.map(productName).join(', ') : 'All products' },
              { label: 'Affiliate', value: coupon.affiliate_id ? <Link className="text-primary hover:underline" to={`/growth/affiliates/${coupon.affiliate_id}`}>View affiliate</Link> : null, hidden: !coupon.affiliate_id },
              { label: 'Batch', value: 'Generated single-use code', hidden: !coupon.batch_id },
              { label: 'Created', value: dateTime(coupon.created_at) },
            ]}
          />
        )}
        <div>
          <p className="mb-2 text-sm font-semibold">Redemptions</p>
          <div className="rounded-ui border">
            <DataTable
              caption="Redemptions"
              rows={redemptions.data?.data}
              loading={redemptions.isLoading}
              rowKey={(r) => r.id}
              empty={<EmptyState title="Not redeemed yet" />}
              columns={[
                {
                  key: 'customer',
                  header: 'Customer',
                  cell: (r) =>
                    r.user_id ? (
                      <Link className="text-primary hover:underline" to={`/customers/users/${r.user_id}`}>
                        {r.user_email ?? r.user_id}
                      </Link>
                    ) : r.org_id ? (
                      <Link className="text-primary hover:underline" to={`/customers/organizations/${r.org_id}`}>
                        Organization
                      </Link>
                    ) : (
                      '—'
                    ),
                },
                { key: 'discount', header: 'Discount', align: 'right', cell: (r) => (r.discount_amount !== null ? money(r.discount_amount, r.currency ?? 'USD') : '—') },
                { key: 'on', header: 'On', cell: (r) => (r.subscription_id ? <Link className="text-primary hover:underline" to={`/revenue/subscriptions/${r.subscription_id}`}>Subscription</Link> : r.order_id ? 'Order' : '—') },
                { key: 'when', header: 'When', cell: (r) => <When value={r.created_at} /> },
              ]}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

const DEFAULTS = { q: '', active: '', coupon: '', batch: '', page: 1, pageSize: 25 };

export default function CouponsPage() {
  const { can } = useAuth();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
  }, [q]); // only the debounced search text drives the URL

  const query = useMemo(
    () => ({ q: state.q || undefined, active: state.active || undefined, batchId: state.batch || undefined, page: state.page, pageSize: state.pageSize }),
    [state.q, state.active, state.batch, state.page, state.pageSize],
  );
  const coupons = useQuery({
    queryKey: ['coupons', query],
    queryFn: ({ signal }) => api.get<Page<Coupon>>('/api/admin/coupons', query, signal),
    placeholderData: keepPreviousData,
  });
  const batches = useQuery({ queryKey: ['coupon-batches'], queryFn: () => api.get<{ data: CouponBatch[] }>('/api/admin/coupon-batches') });
  const shownBatch = batches.data?.data.find((b) => b.id === state.batch);
  const open = coupons.data?.data.find((c) => c.id === state.coupon);
  const filtered = Boolean(state.q || state.active || state.batch);
  const manage = can('catalog.coupons.manage');

  const columns: Column<Coupon>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (c) => (
        <span className="min-w-0">
          <span className="block font-mono">{c.code}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{c.name}</span>
        </span>
      ),
    },
    { key: 'discount', header: 'Discount', cell: (c) => discountText(c) },
    { key: 'duration', header: 'Duration', priority: 'low', cell: (c) => durationText(c) },
    { key: 'redeemed', header: 'Redeemed', align: 'right', cell: (c) => <span className="tabular">{num(c.redeemed_count)}{c.max_redemptions ? ` / ${num(c.max_redemptions)}` : ''}</span> },
    { key: 'expires', header: 'Expires', cell: (c) => (c.expires_at ? <When value={c.expires_at} relative={false} /> : <span className="text-muted-foreground">Never</span>) },
    { key: 'campaign', header: 'Campaign', priority: 'low', cell: (c) => (c.batch_id ? <Badge>batch</Badge> : c.campaign ?? <span className="text-muted-foreground">—</span>) },
    { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={couponState(c)} /> },
  ];

  return (
    <>
      <PageHeader
        title="Coupons"
        description="Discount codes for checkout: percentage or fixed amounts, one-off or recurring, with redemption limits and validity windows."
        actions={
          manage && (
            <>
              <Button variant="outline" icon={<Layers className="size-4" />} onClick={() => setGenerating(true)}>
                Generate codes
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New coupon
              </Button>
            </>
          )
        }
      />
      <div className="space-y-4">
        {state.batch && (
          <Callout
            title={`Codes of ${shownBatch?.name ?? 'a batch'}`}
            action={
              <Button variant="outline" size="sm" onClick={() => setState({ batch: undefined })}>
                Show all coupons
              </Button>
            }
          >
            {shownBatch ? `${num(shownBatch.redeemed)} of ${num(shownBatch.codes)} codes redeemed.` : null}
          </Callout>
        )}
        <Card padded={false}>
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} placeholder="Search code, name or campaign…" className="w-full sm:w-72" />
            <Select aria-label="Status" className="w-auto" value={String(state.active)} onChange={(e) => setState({ active: e.target.value })} placeholder="Active and inactive" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
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
          {coupons.error ? (
            <ErrorState error={coupons.error} onRetry={() => void coupons.refetch()} />
          ) : (
            <DataTable
              caption="Coupons"
              columns={columns}
              rows={coupons.data?.data}
              rowKey={(c) => c.id}
              rowHref={(c) =>
                `?${new URLSearchParams({
                  ...(state.q ? { q: String(state.q) } : {}),
                  ...(state.active ? { active: String(state.active) } : {}),
                  ...(state.batch ? { batch: String(state.batch) } : {}),
                  ...(Number(state.page) > 1 ? { page: String(state.page) } : {}),
                  coupon: c.id,
                })}`
              }
              loading={coupons.isLoading}
              fetching={coupons.isFetching && !coupons.isLoading}
              empty={filtered ? <EmptyState title="No coupons match" /> : <EmptyState icon={<TicketPercent />} title="No coupons yet" description="Create discount codes for launches, win-back campaigns or partners." />}
            />
          )}
          {coupons.data && <Pagination page={coupons.data.page} pageSize={coupons.data.pageSize} total={coupons.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
        </Card>
        <BatchesCard
          onShow={(b) => {
            setSearch('');
            setState({ batch: b.id, q: undefined, active: undefined });
          }}
        />
      </div>
      {creating && <CreateCouponDialog open={creating} onOpenChange={setCreating} />}
      {generating && <BatchDialog open={generating} onOpenChange={setGenerating} onCreated={(b) => setState({ batch: b.id })} />}
      {open && <CouponDialog key={open.id} coupon={open} onOpenChange={(o) => !o && setState({ coupon: undefined }, { resetPage: false })} />}
    </>
  );
}
