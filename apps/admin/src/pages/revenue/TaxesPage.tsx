import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime } from '../../lib/format';
import { Badge, Button, Callout, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Select, Switch, When, type Column } from '../../components/ui';
import { useCurrencies } from './shared';

interface TaxRate {
  id: string;
  name: string;
  country: string;
  region: string | null;
  rate_bps: number;
  tax_type: 'vat' | 'gst' | 'sales_tax' | 'other';
  reverse_charge_b2b: boolean;
  active: boolean;
  created_at: string;
}

interface ExchangeRate {
  base: string;
  quote: string;
  rate: number;
  source: string;
  updated_at: string;
}

const TAX_TYPES: Record<TaxRate['tax_type'], string> = { vat: 'VAT', gst: 'GST', sales_tax: 'Sales tax', other: 'Other' };

const percent = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

function TaxRateDialog({ rate, onClose }: { rate: TaxRate | null; onClose: () => void }) {
  const [form, setForm] = useState({
    name: rate?.name ?? 'VAT',
    country: rate?.country ?? '',
    region: rate?.region ?? '',
    ratePercent: rate ? String(rate.rate_bps / 100) : '',
    taxType: rate?.tax_type ?? 'vat',
    reverseChargeB2b: rate?.reverse_charge_b2b ?? false,
    active: rate?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    async () => {
      const ratePercent = Number(form.ratePercent);
      if (form.ratePercent.trim() === '' || Number.isNaN(ratePercent) || ratePercent < 0 || ratePercent > 100) throw new Error('Enter a rate between 0 and 100 percent');
      const body = { name: form.name.trim(), country: form.country.trim().toUpperCase(), region: form.region.trim() || null, ratePercent, taxType: form.taxType, reverseChargeB2b: form.reverseChargeB2b, active: form.active };
      return rate ? api.patch(`/api/admin/tax-rates/${rate.id}`, body) : api.post('/api/admin/tax-rates', body);
    },
    { success: rate ? 'Tax rate updated' : 'Tax rate added', invalidate: [['tax-rates']], onSuccess: onClose, onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={rate ? 'Edit tax rate' : 'Add a tax rate'}
      description="Applied to invoices for customers whose billing country (and region, when set) matches."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="tax-rate-form" loading={save.isPending}>
            {rate ? 'Save' : 'Add rate'}
          </Button>
        </>
      }
    >
      <form
        id="tax-rate-form"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Name" htmlFor="tr-name" hint="Printed on invoices">
          <Input id="tr-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required />
        </Field>
        <Field label="Type" htmlFor="tr-type">
          <Select id="tr-type" value={form.taxType} onChange={(e) => setForm({ ...form, taxType: e.target.value as TaxRate['tax_type'] })} options={Object.entries(TAX_TYPES).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Country" htmlFor="tr-country" hint="Two-letter code, e.g. DE">
          <Input id="tr-country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase().slice(0, 2) })} minLength={2} maxLength={2} required />
        </Field>
        <Field label="Region" htmlFor="tr-region" hint="Optional: state or province for regional taxes">
          <Input id="tr-region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} maxLength={50} />
        </Field>
        <Field label="Rate (%)" htmlFor="tr-rate">
          <Input id="tr-rate" type="number" inputMode="decimal" min={0} max={100} step="0.01" value={form.ratePercent} onChange={(e) => setForm({ ...form, ratePercent: e.target.value })} required />
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <Checkbox checked={form.reverseChargeB2b} onChange={(e) => setForm({ ...form, reverseChargeB2b: e.target.checked })} label="Reverse charge for businesses" description="Business customers here who give a tax ID are not charged tax when you sell from another country; their invoices carry a reverse-charge note." />
          <Checkbox checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} label="Active" />
        </div>
      </form>
    </Modal>
  );
}

function ExchangeRateDialog({ rate, onClose }: { rate: ExchangeRate | null; onClose: () => void }) {
  const { base, list } = useCurrencies();
  const [form, setForm] = useState({ base: rate?.base ?? list.find((c) => c !== base) ?? 'EUR', quote: rate?.quote ?? base, rate: rate ? String(rate.rate) : '' });
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    async () => {
      const value = Number(form.rate);
      if (!(value > 0)) throw new Error('Enter a positive rate');
      if (form.base === form.quote) throw new Error('Choose two different currencies');
      return api.put('/api/admin/exchange-rates', { rates: [{ base: form.base, quote: form.quote, rate: value }] });
    },
    { success: 'Exchange rate saved', invalidate: [['exchange-rates']], onSuccess: onClose, onError: (e) => setError(errorMessage(e)) },
  );
  const currencies = [...new Set([...list, form.base, form.quote])];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={rate ? `${rate.base} → ${rate.quote}` : 'Set an exchange rate'}
      description="Used to report revenue from other currencies in the base currency. Customers are always charged in their own currency."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="fx-form" loading={save.isPending}>
            Save rate
          </Button>
        </>
      }
    >
      <form
        id="fx-form"
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-3">
          <FormError message={error} />
        </div>
        <Field label="1 unit of" htmlFor="fx-base">
          <Select id="fx-base" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} options={currencies} disabled={Boolean(rate)} />
        </Field>
        <Field label="equals" htmlFor="fx-rate">
          <Input id="fx-rate" type="number" inputMode="decimal" min={0} step="any" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} required autoFocus />
        </Field>
        <Field label="of" htmlFor="fx-quote">
          <Select id="fx-quote" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} options={currencies} disabled={Boolean(rate)} />
        </Field>
      </form>
    </Modal>
  );
}

export default function TaxesPage() {
  const { can } = useAuth();
  const manage = can('billing.taxes.manage');
  const { base, list } = useCurrencies();
  const [editingTax, setEditingTax] = useState<TaxRate | 'new' | null>(null);
  const [editingFx, setEditingFx] = useState<ExchangeRate | 'new' | null>(null);
  const taxes = useQuery({ queryKey: ['tax-rates'], queryFn: () => api.get<{ data: TaxRate[] }>('/api/admin/tax-rates') });
  const fx = useQuery({ queryKey: ['exchange-rates'], queryFn: () => api.get<{ data: ExchangeRate[] }>('/api/admin/exchange-rates') });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ data: { key: string; value: Record<string, unknown> }[] }>('/api/admin/settings'),
    enabled: can('system.settings.view'),
    staleTime: 60_000,
  });
  const billing = settings.data?.data.find((s) => s.key === 'billing')?.value as { taxEnabled?: boolean; baseCurrency?: string } | undefined;
  const reportingCurrency = billing?.baseCurrency ?? base;

  const toggle = useAction((r: TaxRate) => api.patch(`/api/admin/tax-rates/${r.id}`, { active: !r.active }), {
    success: (_res, r) => (r.active ? `${r.name} ${r.country} deactivated` : `${r.name} ${r.country} activated`),
    invalidate: [['tax-rates']],
  });

  const taxColumns: Column<TaxRate>[] = [
    { key: 'name', header: 'Name', cell: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'where', header: 'Country / region', cell: (r) => `${r.country}${r.region ? ` · ${r.region}` : ''}` },
    { key: 'rate', header: 'Rate', align: 'right', cell: (r) => <span className="tabular">{percent(r.rate_bps)}</span> },
    { key: 'type', header: 'Type', cell: (r) => TAX_TYPES[r.tax_type] ?? r.tax_type },
    { key: 'b2b', header: 'B2B', cell: (r) => (r.reverse_charge_b2b ? <Badge tone="info">reverse charge</Badge> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'active',
      header: 'Active',
      cell: (r) => (manage ? <Switch checked={r.active} onCheckedChange={() => toggle.mutate(r)} disabled={toggle.isPending} label={<span className="sr-only">{r.active ? 'Deactivate' : 'Activate'} {r.name} {r.country}</span>} /> : r.active ? <Badge tone="success">active</Badge> : <Badge>inactive</Badge>),
    },
    {
      key: 'edit',
      header: <span className="sr-only">Edit</span>,
      align: 'right',
      cell: (r) =>
        manage ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.name} ${r.country}`} onClick={() => setEditingTax(r)}>
            <Pencil className="size-4" />
          </Button>
        ) : null,
    },
  ];

  const fxColumns: Column<ExchangeRate>[] = [
    { key: 'pair', header: 'Pair', cell: (r) => <span className="font-mono text-xs font-medium">{r.base} → {r.quote}</span> },
    { key: 'rate', header: 'Rate', align: 'right', cell: (r) => <span className="tabular">1 {r.base} = {Number(r.rate).toLocaleString(undefined, { maximumFractionDigits: 6 })} {r.quote}</span> },
    { key: 'source', header: 'Source', cell: (r) => r.source },
    { key: 'updated', header: 'Updated', cell: (r) => <When value={r.updated_at} /> },
    {
      key: 'edit',
      header: <span className="sr-only">Edit</span>,
      align: 'right',
      cell: (r) =>
        manage ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.base} to ${r.quote}`} onClick={() => setEditingFx(r)}>
            <Pencil className="size-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Taxes & currencies" description="Tax rates applied to invoices, and the exchange rates used to report revenue in one currency." />

      {billing && billing.taxEnabled === false && (
        <div className="mb-4">
          <Callout
            tone="warning"
            title="Tax calculation is turned off"
            action={
              <Link to="/platform/settings/billing" className="whitespace-nowrap text-sm font-medium text-primary hover:underline">
                Billing settings
              </Link>
            }
          >
            The rates below are not added to new invoices until tax is enabled in the billing settings.
          </Callout>
        </div>
      )}

      <div className="space-y-4">
        <Card
          title="Tax rates"
          description="VAT, GST and sales tax by customer country. Prices can be tax-inclusive or exclusive (set per price in the catalog)."
          padded={false}
          actions={
            manage && (
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEditingTax('new')}>
                Add rate
              </Button>
            )
          }
        >
          {taxes.error ? (
            <ErrorState error={taxes.error} onRetry={() => void taxes.refetch()} />
          ) : (
            <DataTable caption="Tax rates" columns={taxColumns} rows={taxes.data?.data} rowKey={(r) => r.id} loading={taxes.isLoading} empty={<EmptyState title="No tax rates" description="Add the rates for the countries you sell to." />} />
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card
            title="Exchange rates"
            description={`Revenue in other currencies is converted to ${reportingCurrency} for dashboards and reports.`}
            padded={false}
            className="lg:col-span-2"
            actions={
              manage && (
                <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => setEditingFx('new')}>
                  Set rate
                </Button>
              )
            }
          >
            {fx.error ? (
              <ErrorState error={fx.error} onRetry={() => void fx.refetch()} />
            ) : (
              <DataTable caption="Exchange rates" columns={fxColumns} rows={fx.data?.data} rowKey={(r) => `${r.base}-${r.quote}`} loading={fx.isLoading} empty={<EmptyState title="No exchange rates" description={`Without rates, other currencies are reported unconverted.`} />} />
            )}
          </Card>
          <Card title="Currencies">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reporting currency</dt>
                <dd className="mt-0.5 font-semibold">{reportingCurrency}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Enabled currencies</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {list.map((c) => (
                    <Badge key={c} tone={c === base ? 'primary' : 'neutral'}>
                      {c}
                    </Badge>
                  ))}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              Each price in the catalog has its own currency. Change the enabled currencies in{' '}
              <Link to="/platform/settings/general" className="text-primary hover:underline">
                settings
              </Link>
              .
            </p>
          </Card>
        </div>
        {fx.data && fx.data.data.length > 0 && <p className="text-xs text-muted-foreground">Last change {dateTime(fx.data.data.reduce((a, r) => (r.updated_at > a ? r.updated_at : a), fx.data.data[0].updated_at))}.</p>}
      </div>

      {editingTax && <TaxRateDialog rate={editingTax === 'new' ? null : editingTax} onClose={() => setEditingTax(null)} />}
      {editingFx && <ExchangeRateDialog rate={editingFx === 'new' ? null : editingFx} onClose={() => setEditingFx(null)} />}
    </>
  );
}
