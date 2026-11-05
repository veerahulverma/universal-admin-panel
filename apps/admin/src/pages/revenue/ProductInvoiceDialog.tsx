import { useState } from 'react';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { money, toMinor } from '../../lib/format';
import { Button, Callout, Field, FormError, Input, Modal, Select, Skeleton, Textarea, type OptionGroup } from '../../components/ui';
import { AmountInput, CustomerPicker, subjectBody, useCurrencies, type PickedCustomer } from './shared';
import { FollowUpFields, OutcomeModal, useFollowUp, type CreatedInvoice, type FollowUpOption, type Outcome } from './invoice-follow-up';

interface CatalogPrice {
  id: string;
  product_id: string;
  nickname: string | null;
  currency: string;
  type: 'recurring' | 'one_time';
  interval: string | null;
  interval_count: number;
  pricing_model: string;
  unit_amount: number;
  intro_amount: number | null;
  intro_cycles: number | null;
  min_quantity: number;
  max_quantity: number | null;
  payment_count: number | null;
  after_last_payment: 'end_access' | 'keep_access';
  access_days: number | null;
}

interface CatalogProduct {
  id: string;
  name: string;
  kind: string;
  subscriber_type: string;
  prices: CatalogPrice[];
}

interface CatalogCoupon {
  id: string;
  code: string;
  discount_type: 'percent' | 'fixed';
  percent_off_bps: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  duration_cycles: number | null;
  applies_to: string[];
}

const FOLLOW_UPS: FollowUpOption[] = [
  { value: 'pending', label: 'Just add a pending invoice', description: 'Open and unpaid. Access starts when it is paid.', submit: 'Add invoice' },
  { value: 'paid', label: 'Add the invoice and record a payment', description: 'For money already received offline. It is marked paid and access starts now.', submit: 'Add and record payment' },
  { value: 'email', label: 'Add a pending invoice and email the payment link', description: 'The customer gets the invoice with a secure link; access starts when they pay.', submit: 'Add and send link' },
  { value: 'link', label: 'Add a pending invoice and create a payment link', description: 'A hosted checkout on the gateway you choose, for you to share.', submit: 'Add and create link' },
];

const KIND: Record<string, string> = { plan: 'plan', addon: 'add-on', one_time: 'one-time product', credit_pack: 'credit pack' };

const seatsOf = (p: CatalogPrice) => Math.max(1, p.min_quantity);
const hasIntro = (p: CatalogPrice) => p.type === 'recurring' && p.intro_amount !== null && Boolean(p.intro_cycles);
/** Seats for per-seat prices, units for one-time prices; other prices are sold one at a time. */
const byQuantity = (p: CatalogPrice) => p.pricing_model === 'per_seat' || p.type === 'one_time';

/** "US$20.00 / month", "US$200.00 every 2 years", "US$299.00 one-time", plus seats, introductory pricing, installments and access period. */
export function priceLabel(p: CatalogPrice): string {
  const seats = seatsOf(p);
  const amount = p.pricing_model === 'tiered' ? 'Tiered pricing' : money(p.pricing_model === 'per_seat' ? p.unit_amount * seats : p.unit_amount, p.currency);
  const every = p.type === 'one_time' || !p.interval ? ' one-time' : p.interval_count > 1 ? ` every ${p.interval_count} ${p.interval}s` : ` / ${p.interval}`;
  const seatText = p.pricing_model === 'per_seat' ? ` · ${seats} seat${seats === 1 ? '' : 's'}` : '';
  const intro = hasIntro(p) ? ` · first ${p.intro_cycles === 1 ? 'payment' : `${p.intro_cycles} payments`} ${money(p.pricing_model === 'per_seat' ? p.intro_amount! * seats : p.intro_amount!, p.currency)}` : '';
  const installments = p.payment_count ? ` · ${p.payment_count} payment${p.payment_count === 1 ? '' : 's'}${p.after_last_payment === 'keep_access' ? ', then kept' : ''}` : '';
  const term = p.access_days ? ` · ${p.access_days} days of access` : '';
  return `${p.nickname ? `${p.nickname}: ` : ''}${amount}${every}${seatText}${intro}${installments}${term}`;
}

/** What the first invoice charges for a price; null when the server has to work it out (tiers). */
function firstAmount(p: CatalogPrice, quantity: number): number | null {
  if (p.pricing_model === 'tiered') return null;
  const unit = hasIntro(p) ? p.intro_amount! : p.unit_amount;
  if (byQuantity(p)) return unit * quantity;
  return unit;
}

function couponLabel(c: CatalogCoupon): string {
  const off = c.discount_type === 'percent' ? `${(c.percent_off_bps ?? 0) / 100}% off` : `${money(c.amount_off ?? 0, c.currency ?? 'USD')} off`;
  const lasts = c.duration === 'once' ? 'first payment' : c.duration === 'forever' ? 'every payment' : `${c.duration_cycles} payments`;
  return `${c.code}: ${off}, ${lasts}`;
}

interface LineDraft {
  key: number;
  priceId: string;
  /** Empty: the price's minimum. */
  quantity: string;
}

/**
 * Invoice a customer for catalog prices. Nothing is granted until the invoice is paid; then the
 * plan starts and products are granted, whether it was paid online or recorded here.
 */
export function ProductInvoiceDialog({ open, onOpenChange, customer, refresh = [], onDone }: { open: boolean; onOpenChange: (o: boolean) => void; customer: PickedCustomer; refresh?: QueryKey[]; onDone?: (invoice: CreatedInvoice) => void }) {
  const catalog = useQuery({
    queryKey: ['invoice-product-options'],
    queryFn: () => api.get<{ products: CatalogProduct[]; coupons: CatalogCoupon[] }>('/api/admin/invoices/product-options'),
    enabled: open,
  });
  const { base } = useCurrencies();
  const [lines, setLines] = useState<LineDraft[]>([{ key: 1, priceId: '', quantity: '' }]);
  const [couponId, setCouponId] = useState('');
  const [firstOff, setFirstOff] = useState('');
  const [renewalOff, setRenewalOff] = useState('');
  const [dueDays, setDueDays] = useState('14');
  const [notes, setNotes] = useState('');
  const follow = useFollowUp('pending');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Organization-only products cannot be sold to a user.
  const products = (catalog.data?.products ?? []).filter((p) => customer.type === 'organization' || p.subscriber_type !== 'organization');
  const byPrice = new Map(products.flatMap((product) => product.prices.map((price) => [price.id, { price, product }] as const)));
  const quantityOf = (l: LineDraft) => {
    const pick = byPrice.get(l.priceId);
    return pick && byQuantity(pick.price) ? Math.max(1, Math.trunc(Number(l.quantity)) || seatsOf(pick.price)) : 1;
  };
  const chosen = lines.flatMap((l) => (byPrice.has(l.priceId) ? [{ ...byPrice.get(l.priceId)!, quantity: quantityOf(l) }] : []));
  const currency = chosen[0]?.price.currency ?? base;
  const recurring = chosen.find((c) => c.price.type === 'recurring');
  const coupons = (catalog.data?.coupons ?? []).filter((c) => c.discount_type === 'percent' || c.currency === currency);
  const applies = (c: CatalogCoupon) => !c.applies_to.length || !chosen.length || chosen.some((x) => c.applies_to.includes(x.product.id));
  const coupon = coupons.find((c) => c.id === couponId && applies(c)) ?? null;

  // A preview only: the server works out the real amounts, and tax, when saving.
  const amounts = chosen.map((x) => ({ productId: x.product.id, amount: firstAmount(x.price, x.quantity) }));
  const exact = amounts.every((a) => a.amount !== null);
  const subtotal = amounts.reduce((sum, a) => sum + (a.amount ?? 0), 0);
  const targets = coupon ? amounts.filter((a) => !coupon.applies_to.length || coupon.applies_to.includes(a.productId)) : [];
  const couponOff = !coupon
    ? 0
    : coupon.discount_type === 'percent'
      ? targets.reduce((sum, a) => sum + Math.min(a.amount ?? 0, Math.round(((a.amount ?? 0) * (coupon.percent_off_bps ?? 0)) / 10_000)), 0)
      : Math.min(coupon.amount_off ?? 0, targets.reduce((sum, a) => sum + (a.amount ?? 0), 0));
  const extraOff = toMinor(firstOff || '0', currency) ?? 0;
  const renewalExtra = toMinor(renewalOff || '0', currency) ?? 0;

  const groupsFor = (key: number): OptionGroup[] => {
    const others = lines.filter((l) => l.key !== key).flatMap((l) => (byPrice.has(l.priceId) ? [byPrice.get(l.priceId)!] : []));
    const otherCurrency = others[0]?.price.currency;
    const otherRecurring = others.some((o) => o.price.type === 'recurring');
    return products.map((p) => ({
      label: `${p.name} (${KIND[p.kind] ?? p.kind})`,
      options: p.prices.map((pr) => ({
        value: pr.id,
        // The product name repeats here so a closed select still says what was picked.
        label: `${p.name} · ${priceLabel(pr)}`,
        disabled: (otherCurrency !== undefined && pr.currency !== otherCurrency) || (otherRecurring && pr.type === 'recurring'),
      })),
    }));
  };

  const option = FOLLOW_UPS.find((f) => f.value === follow.followUp)!;
  const finish = (invoice: CreatedInvoice) => {
    onOpenChange(false);
    onDone?.(invoice);
  };

  const create = useAction(
    async (): Promise<Outcome> => {
      if (!chosen.length || chosen.length !== lines.length) throw new Error('Choose a product and price on every line');
      const first = firstOff.trim() ? toMinor(firstOff, currency) : 0;
      const renewal = recurring && renewalOff.trim() ? toMinor(renewalOff, currency) : 0;
      if (first === null || renewal === null || first < 0 || renewal < 0) throw new Error('Enter discounts as amounts, for example 10.00');
      const invoice = await api.post<CreatedInvoice>('/api/admin/invoices/products', {
        ...subjectBody(customer),
        items: chosen.map((x) => ({ priceId: x.price.id, quantity: byQuantity(x.price) ? x.quantity : undefined })),
        couponCode: coupon?.code,
        discount: { first, renewal },
        dueDays: Number(dueDays) || 0,
        notes: notes.trim() || undefined,
        sendEmail: follow.followUp === 'email',
      });
      return follow.run(invoice);
    },
    {
      success: ({ invoice, problem }) => {
        if (problem) return null;
        if (invoice.status === 'paid' || follow.followUp === 'paid') return `Invoice ${invoice.number ?? ''} paid; access granted`;
        return `Invoice ${invoice.number ?? ''} added`;
      },
      invalidate: [['invoices'], ['orders'], ['subscriptions'], ...refresh],
      onSuccess: (result) => (result.url || result.problem ? setOutcome(result) : finish(result.invoice)),
      onError: (e) => setError(errorMessage(e)),
    },
  );

  if (outcome) return <OutcomeModal open={open} onOpenChange={onOpenChange} outcome={outcome} followUp={follow.followUp} onDone={() => finish(outcome.invoice)} />;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New invoice"
      description="Bill this customer for plans and products. The plan starts and products are granted once the invoice is paid."
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="product-invoice" loading={create.isPending} disabled={!chosen.length}>
            {option.submit}
          </Button>
        </>
      }
    >
      <form
        id="product-invoice"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Bill to">
          <CustomerPicker value={customer} onChange={() => undefined} locked />
        </Field>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">
            Products <span className="text-danger">*</span>
          </legend>
          {catalog.isLoading ? (
            <Skeleton className="h-9" />
          ) : catalog.error ? (
            <Callout tone="danger" title="Products could not be loaded">
              {errorMessage(catalog.error)}
            </Callout>
          ) : products.length === 0 ? (
            <Callout title="Nothing to invoice yet">Add prices to an active plan or product under Products & Plans first.</Callout>
          ) : (
            <>
              {lines.map((l, i) => {
                const pick = byPrice.get(l.priceId);
                const amount = pick ? firstAmount(pick.price, quantityOf(l)) : null;
                return (
                  <div key={l.key} className="grid grid-cols-[5rem_1fr_auto] items-center gap-2 sm:grid-cols-[1fr_5rem_7rem_2.25rem]">
                    <Select
                      aria-label={`Line ${i + 1} product and price`}
                      value={l.priceId}
                      onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, priceId: e.target.value, quantity: '' } : x)))}
                      placeholder="Choose a product and price"
                      options={groupsFor(l.key)}
                      className="col-span-3 sm:col-span-1"
                    />
                    {pick && byQuantity(pick.price) ? (
                      <Input
                        aria-label={`Line ${i + 1} ${pick.price.pricing_model === 'per_seat' ? 'seats' : 'quantity'}`}
                        type="number"
                        min={pick.price.min_quantity}
                        max={pick.price.max_quantity ?? undefined}
                        step={1}
                        value={l.quantity}
                        placeholder={String(seatsOf(pick.price))}
                        onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))}
                        className="tabular"
                      />
                    ) : (
                      <span aria-hidden="true" />
                    )}
                    <span className="text-sm tabular text-muted-foreground sm:text-right">{pick ? (amount === null ? 'Calculated on save' : money(amount, pick.price.currency)) : ''}</span>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="justify-self-end">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
              <Button variant="outline" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines((ls) => [...ls, { key: Date.now(), priceId: '', quantity: '' }])} disabled={lines.length >= 20}>
                Add product
              </Button>
              <p className="text-xs text-muted-foreground">Prices in one currency; at most one recurring price per invoice. Seats and one-time products take a quantity.</p>
            </>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Coupon" htmlFor="pi-coupon" hint={coupons.length ? 'Applies like it does at checkout, including how many payments it lasts.' : 'No coupons are available right now.'}>
            <Select
              id="pi-coupon"
              value={coupon?.id ?? ''}
              onChange={(e) => setCouponId(e.target.value)}
              placeholder="No coupon"
              options={coupons.map((c) => ({ value: c.id, label: couponLabel(c), disabled: !applies(c) }))}
              disabled={!coupons.length}
            />
          </Field>
          <Field label="Payment due in (days)" htmlFor="pi-due">
            <Input id="pi-due" type="number" min={0} max={365} step={1} value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Discount</legend>
          <p className="text-xs text-muted-foreground">An extra amount off, on top of any coupon.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First payment" htmlFor="pi-first">
              <AmountInput id="pi-first" value={firstOff} onChange={setFirstOff} currency={currency} />
            </Field>
            <Field label="Each renewal" htmlFor="pi-renewal" hint={recurring ? 'Taken off every renewal of the recurring price.' : 'Needs a recurring price.'}>
              <AmountInput id="pi-renewal" value={recurring ? renewalOff : ''} onChange={setRenewalOff} currency={currency} disabled={!recurring} />
            </Field>
          </div>
        </fieldset>

        {chosen.length > 0 && (
          <div className="ml-auto max-w-xs space-y-1 text-sm">
            <dl className="space-y-1">
              <div className="flex justify-between gap-6">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular">{money(subtotal, currency)}</dd>
              </div>
              {couponOff > 0 && (
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">Coupon {coupon?.code}</dt>
                  <dd className="tabular">−{money(couponOff, currency)}</dd>
                </div>
              )}
              {extraOff > 0 && (
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">Discount</dt>
                  <dd className="tabular">−{money(extraOff, currency)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-6 border-t pt-1 font-semibold">
                <dt>Total{exact ? '' : ' (estimate)'}</dt>
                <dd className="tabular">{money(Math.max(0, subtotal - couponOff - extraOff), currency)}</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">Before tax.{recurring && renewalExtra > 0 ? ` Renewals: ${money(renewalExtra, currency)} off each.` : ''}</p>
          </div>
        )}

        <Field label="Notes" htmlFor="pi-notes" hint="Printed on the invoice">
          <Textarea id="pi-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
        <FollowUpFields id="pi" options={FOLLOW_UPS} state={follow} />
      </form>
    </Modal>
  );
}
