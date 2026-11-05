import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { money } from '../../lib/format';
import { Button, Callout, Field, FormError, Input, Modal, Select, Switch } from '../../components/ui';
import { MoneyInput, useCurrencies, useFormErrors, useMeters, type Price, type ProductDetail, type Tier } from './shared';

type Model = Price['pricingModel'];

const MODELS: { value: Model; label: string; hint: string }[] = [
  { value: 'flat', label: 'Flat rate', hint: 'One fixed amount.' },
  { value: 'per_seat', label: 'Per seat', hint: 'Amount × number of seats (quantity).' },
  { value: 'usage', label: 'Usage-based', hint: 'Billed in arrears from a usage meter.' },
  { value: 'tiered', label: 'Tiered', hint: 'Unit price changes with volume (seats or metered units).' },
];

interface TierRow {
  upTo: string;
  unitAmount: number | null;
  flatAmount: number | null;
}

/** Prices are immutable once created; this dialog only adds new ones. */
export function PriceDialog({ product, open, onOpenChange }: { product: ProductDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { base, all } = useCurrencies();
  const meters = useMeters();
  const oneTimeOnly = product.kind === 'one_time' || product.kind === 'credit_pack';
  const [currency, setCurrency] = useState(base);
  const [nickname, setNickname] = useState('');
  const [type, setType] = useState<'recurring' | 'one_time'>(oneTimeOnly ? 'one_time' : 'recurring');
  const [interval, setInterval] = useState<'day' | 'week' | 'month' | 'year'>('month');
  const [intervalCount, setIntervalCount] = useState('1');
  const [model, setModel] = useState<Model>('flat');
  const [unitAmount, setUnitAmount] = useState<number | null>(null);
  const [meterKey, setMeterKey] = useState('');
  const [includedUnits, setIncludedUnits] = useState('0');
  const [packageSize, setPackageSize] = useState('');
  const [tierMode, setTierMode] = useState<'graduated' | 'volume'>('graduated');
  const [tiers, setTiers] = useState<TierRow[]>([
    { upTo: '10', unitAmount: null, flatAmount: null },
    { upTo: '', unitAmount: null, flatAmount: null },
  ]);
  const [taxBehavior, setTaxBehavior] = useState<'exclusive' | 'inclusive'>('exclusive');
  const [intro, setIntro] = useState(false);
  const [introAmount, setIntroAmount] = useState<number | null>(null);
  const [introCycles, setIntroCycles] = useState('3');
  const [minQuantity, setMinQuantity] = useState('1');
  const [maxQuantity, setMaxQuantity] = useState('');
  const [paymentCount, setPaymentCount] = useState('');
  const [afterLastPayment, setAfterLastPayment] = useState<Price['afterLastPayment']>('end_access');
  const [accessDays, setAccessDays] = useState('');
  const [stockLimit, setStockLimit] = useState('');
  // MoneyInputs keep their own text; remount them when the currency changes.
  const [moneyKey, setMoneyKey] = useState(0);
  const errors = useFormErrors();
  const installments = type === 'recurring' && model !== 'usage';
  const timed = type === 'one_time' && product.kind !== 'credit_pack';
  const payments = Number(paymentCount) || 0;

  const body = () => {
    const b: Record<string, unknown> = {
      nickname: nickname.trim() || undefined,
      currency,
      type,
      pricingModel: model,
      unitAmount: model === 'tiered' ? 0 : unitAmount ?? 0,
      taxBehavior,
      minQuantity: Number(minQuantity) || 1,
      maxQuantity: maxQuantity ? Number(maxQuantity) : undefined,
      stockLimit: stockLimit.trim() ? Number(stockLimit) : undefined,
    };
    if (type === 'recurring') {
      b.interval = interval;
      b.intervalCount = Number(intervalCount) || 1;
      if (intro) {
        b.introAmount = introAmount ?? 0;
        b.introCycles = Number(introCycles) || 1;
      }
    }
    if (installments && payments) {
      b.paymentCount = payments;
      b.afterLastPayment = afterLastPayment;
    }
    if (timed && accessDays.trim()) b.accessDays = Number(accessDays);
    if (model === 'usage') {
      b.meterKey = meterKey || undefined;
      b.includedUnits = Number(includedUnits) || 0;
      if (packageSize) b.packageSize = Number(packageSize);
    }
    if (model === 'tiered') {
      if (meterKey) b.meterKey = meterKey;
      b.tierMode = tierMode;
      b.tiers = tiers.map<Tier>((t, i) => ({ upTo: i === tiers.length - 1 || t.upTo.trim() === '' ? null : Number(t.upTo), unitAmount: t.unitAmount ?? 0, flatAmount: t.flatAmount ?? 0 }));
    }
    return b;
  };

  const create = useAction(() => api.post<Price>(`/api/admin/products/${product.id}/prices`, body()), {
    success: 'Price added',
    invalidate: [['product', product.id], ['products']],
    onSuccess: () => onOpenChange(false),
    onError: (err) => errors.set(err, ['unitAmount', 'interval', 'meterKey', 'tiers', 'introCycles', 'introAmount', 'currency', 'type', 'maxQuantity', 'paymentCount', 'accessDays', 'stockLimit']),
  });

  const meterOptions = (meters.data?.data ?? []).map((m) => ({ value: m.key, label: `${m.name} (${m.unit})` }));
  const selectedMeter = meters.data?.data.find((m) => m.key === meterKey);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Add a price to ${product.name}`}
      description="Prices can't be edited after creation. To change an amount, add a new price and archive the old one."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="price-form" loading={create.isPending}>
            Add price
          </Button>
        </>
      }
    >
      <form
        id="price-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          create.mutate();
        }}
      >
        <FormError message={errors.general} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Currency" htmlFor="pr-currency" error={errors.fields.currency}>
            <Select
              id="pr-currency"
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setMoneyKey((k) => k + 1);
                setUnitAmount(null);
                setIntroAmount(null);
                setTiers((ts) => ts.map((t) => ({ ...t, unitAmount: null, flatAmount: null })));
              }}
              options={all}
            />
          </Field>
          <Field label="Billing" htmlFor="pr-type" error={errors.fields.type}>
            <Select
              id="pr-type"
              value={type}
              disabled={oneTimeOnly}
              onChange={(e) => {
                const next = e.target.value as typeof type;
                setType(next);
                if (next === 'one_time' && model === 'usage') setModel('flat');
              }}
              options={[{ value: 'recurring', label: 'Recurring' }, { value: 'one_time', label: 'One-time' }]}
            />
          </Field>
          <Field label="Nickname" htmlFor="pr-nick" hint="Optional, e.g. Launch price">
            <Input id="pr-nick" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </Field>
        </div>
        {type === 'recurring' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Every" htmlFor="pr-count" error={errors.fields.interval}>
              <Input id="pr-count" type="number" min={1} max={36} value={intervalCount} onChange={(e) => setIntervalCount(e.target.value)} />
            </Field>
            <Field label="Interval" htmlFor="pr-interval" className="sm:col-span-2">
              <Select id="pr-interval" value={interval} onChange={(e) => setInterval(e.target.value as typeof interval)} options={[{ value: 'month', label: 'Month(s)' }, { value: 'year', label: 'Year(s)' }, { value: 'week', label: 'Week(s)' }, { value: 'day', label: 'Day(s)' }]} />
            </Field>
          </div>
        )}

        <fieldset>
          <legend className="mb-2 text-sm font-medium">Pricing model</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODELS.filter((m) => !(type === 'one_time' && m.value === 'usage')).map((m) => (
              <label key={m.value} className={`flex cursor-pointer gap-2.5 rounded-ui-sm border p-2.5 text-sm ${model === m.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
                <input type="radio" name="model" value={m.value} checked={model === m.value} onChange={() => setModel(m.value)} className="mt-0.5 accent-[var(--color-primary)]" />
                <span>
                  <span className="block font-medium">{m.label}</span>
                  <span className="block text-xs text-muted-foreground">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {(model === 'flat' || model === 'per_seat') && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={model === 'per_seat' ? 'Price per seat' : 'Price'} htmlFor="pr-amount" error={errors.fields.unitAmount} required>
              <MoneyInput key={moneyKey} id="pr-amount" value={unitAmount} currency={currency} onChange={setUnitAmount} required />
            </Field>
            {model === 'per_seat' && (
              <>
                <Field label="Minimum seats" htmlFor="pr-min">
                  <Input id="pr-min" type="number" min={1} value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} />
                </Field>
                <Field label="Maximum seats" htmlFor="pr-max" hint="Empty: no maximum" error={errors.fields.maxQuantity}>
                  <Input id="pr-max" type="number" min={1} value={maxQuantity} onChange={(e) => setMaxQuantity(e.target.value)} />
                </Field>
              </>
            )}
          </div>
        )}

        {model === 'usage' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Meter" htmlFor="pr-meter" error={errors.fields.meterKey} required>
              <Select id="pr-meter" value={meterKey} onChange={(e) => setMeterKey(e.target.value)} placeholder="Choose a meter" options={meterOptions} required />
            </Field>
            <Field label={`Price per ${packageSize && Number(packageSize) > 1 ? `${packageSize} ` : ''}${selectedMeter?.unit ?? 'unit'}`} htmlFor="pr-uamount" error={errors.fields.unitAmount} required>
              <MoneyInput key={moneyKey} id="pr-uamount" value={unitAmount} currency={currency} onChange={setUnitAmount} required />
            </Field>
            <Field label="Included units" htmlFor="pr-included" hint="Free units each period before billing starts">
              <Input id="pr-included" type="number" min={0} value={includedUnits} onChange={(e) => setIncludedUnits(e.target.value)} />
            </Field>
            <Field label="Package size" htmlFor="pr-package" hint="Bill per block of units (e.g. per 1,000). Empty: per unit">
              <Input id="pr-package" type="number" min={1} value={packageSize} onChange={(e) => setPackageSize(e.target.value)} />
            </Field>
          </div>
        )}

        {model === 'tiered' && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tier mode" htmlFor="pr-tiermode" hint={tierMode === 'graduated' ? 'Each unit is priced by the tier it falls into.' : 'All units are priced at the tier the total reaches.'}>
                <Select id="pr-tiermode" value={tierMode} onChange={(e) => setTierMode(e.target.value as typeof tierMode)} options={[{ value: 'graduated', label: 'Graduated' }, { value: 'volume', label: 'Volume' }]} />
              </Field>
              <Field label="Metered by" htmlFor="pr-tmeter" hint="Empty: tiers apply to the seat quantity">
                <Select id="pr-tmeter" value={meterKey} onChange={(e) => setMeterKey(e.target.value)} placeholder="Seats (quantity)" options={meterOptions} />
              </Field>
            </div>
            <div className="rounded-ui-sm border">
              <div className="hidden grid-cols-[1fr_1fr_1fr_2.25rem] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                <span>Up to (units)</span>
                <span>Unit price</span>
                <span>Flat fee</span>
                <span />
              </div>
              <ul className="divide-y">
                {tiers.map((t, i) => {
                  const last = i === tiers.length - 1;
                  return (
                    <li key={i} className="grid grid-cols-2 gap-2 px-3 py-2 sm:grid-cols-[1fr_1fr_1fr_2.25rem]">
                      <Input aria-label={`Tier ${i + 1} up to`} type={last ? 'text' : 'number'} min={1} required={!last} value={last ? '∞ and above' : t.upTo} disabled={last} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))} />
                      <MoneyInput key={`u${moneyKey}-${i}`} value={t.unitAmount} currency={currency} onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, unitAmount: v } : x)))} />
                      <MoneyInput key={`f${moneyKey}-${i}`} value={t.flatAmount} currency={currency} onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, flatAmount: v } : x)))} />
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove tier ${i + 1}`} disabled={tiers.length <= 1} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t px-3 py-2">
                <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setTiers([...tiers.slice(0, -1), { upTo: '', unitAmount: null, flatAmount: null }, tiers[tiers.length - 1]])} disabled={tiers.length >= 20}>
                  Add tier
                </Button>
              </div>
            </div>
            {errors.fields.tiers && <p className="text-xs text-danger">{errors.fields.tiers}</p>}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tax" htmlFor="pr-tax" hint="Inclusive prices already contain the tax.">
            <Select id="pr-tax" value={taxBehavior} onChange={(e) => setTaxBehavior(e.target.value as typeof taxBehavior)} options={[{ value: 'exclusive', label: 'Tax added on top' }, { value: 'inclusive', label: 'Tax included in the price' }]} />
          </Field>
          <Field label="Units for sale at this price" htmlFor="pr-stock" hint="Empty: unlimited. Change it later from the price menu." error={errors.fields.stockLimit}>
            <Input id="pr-stock" type="number" min={0} value={stockLimit} onChange={(e) => setStockLimit(e.target.value)} placeholder="Unlimited" />
          </Field>
        </div>

        {timed && (
          <Field label="Access period (days)" htmlFor="pr-access" hint="Empty: access for good. Buying again extends access from its current end." error={errors.fields.accessDays}>
            <Input id="pr-access" type="number" min={1} max={36500} value={accessDays} onChange={(e) => setAccessDays(e.target.value)} placeholder="For good" className="sm:max-w-48" />
          </Field>
        )}

        {installments && (
          <div className="grid gap-3 rounded-ui-sm border p-3 sm:grid-cols-2">
            <Field
              label="Number of payments"
              htmlFor="pr-payments"
              error={errors.fields.paymentCount}
              hint={payments && model === 'flat' && unitAmount && !intro ? `${payments} × ${money(unitAmount, currency)} = ${money(unitAmount * payments, currency)} in all` : 'Empty: renews until cancelled. Set it to sell in installments.'}
            >
              <Input id="pr-payments" type="number" min={1} max={600} value={paymentCount} onChange={(e) => setPaymentCount(e.target.value)} placeholder="Until cancelled" />
            </Field>
            {payments > 0 && (
              <Field label="After the last payment" htmlFor="pr-after">
                <Select
                  id="pr-after"
                  value={afterLastPayment}
                  onChange={(e) => setAfterLastPayment(e.target.value as Price['afterLastPayment'])}
                  options={[
                    { value: 'end_access', label: 'Access ends with the last paid period' },
                    { value: 'keep_access', label: 'The customer keeps the product' },
                  ]}
                />
              </Field>
            )}
          </div>
        )}

        {type === 'recurring' && model !== 'usage' && (
          <div className="space-y-3 rounded-ui-sm border p-3">
            <Switch checked={intro} onCheckedChange={setIntro} label="Introductory price" description="Charge a different amount for the first billing cycles." />
            {intro && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Intro amount" htmlFor="pr-intro" error={errors.fields.introAmount}>
                  <MoneyInput key={`i${moneyKey}`} id="pr-intro" value={introAmount} currency={currency} onChange={setIntroAmount} />
                </Field>
                <Field label="For how many cycles" htmlFor="pr-introcycles" error={errors.fields.introCycles}>
                  <Input id="pr-introcycles" type="number" min={1} max={36} value={introCycles} onChange={(e) => setIntroCycles(e.target.value)} />
                </Field>
              </div>
            )}
          </div>
        )}
        {product.kind === 'plan' && product.trial_days > 0 && type === 'recurring' && (
          <Callout>New subscribers get the plan's {product.trial_days}-day trial before the first charge.</Callout>
        )}
      </form>
    </Modal>
  );
}
