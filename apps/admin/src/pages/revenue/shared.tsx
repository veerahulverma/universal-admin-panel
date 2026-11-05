import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Building2, CreditCard, Pencil, Plus, User, X } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced } from '../../lib/hooks';
import { decimals, interval, money, toMinor } from '../../lib/format';
import { useBootstrap } from '../../components/layout/AppShell';
import { Avatar, Badge, Button, Card, Checkbox, Field, FormError, Input, Modal, SearchInput, Select, Skeleton, Spinner } from '../../components/ui';

/** Statuses as stored by the billing module (filters and badges). */
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete', 'canceled'];
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'];
export const PAYMENT_STATUSES = ['succeeded', 'pending', 'failed', 'partially_refunded', 'refunded', 'disputed'];
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed', 'canceled'];
export const ORDER_STATUSES = ['pending', 'paid', 'failed', 'canceled', 'partially_refunded', 'refunded'];
export const CHECKOUT_STATUSES = ['open', 'completed', 'expired', 'canceled', 'failed'];
export const DISPUTE_STATUSES = ['needs_response', 'won', 'lost'];

export const statusOptions = (list: string[]) => list.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));

export type SubjectType = 'user' | 'organization';

/** Where a billing subject (user or organization) lives in the console. */
export function subjectHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  return type === 'organization' ? `/customers/organizations/${id}` : `/customers/users/${id}`;
}

/** Customer link for detail pages (lists show plain text: their rows are already links). */
export function CustomerLink({ type, id, label }: { type: string; id: string; label?: string | null }) {
  const Icon = type === 'organization' ? Building2 : User;
  return (
    <Link to={subjectHref(type, id)!} className="inline-flex max-w-full items-center gap-1.5 text-primary hover:underline">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label || id}</span>
    </Link>
  );
}

export function SubjectIcon({ type }: { type: string }) {
  const Icon = type === 'organization' ? Building2 : User;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={type === 'organization' ? 'Organization' : 'User'} />;
}

/** "US$20.00/month", "US$30.00/month · 3 seats", "Usage-based". */
export function priceText(p: { unit_amount: number; currency: string; interval?: string | null; interval_count?: number | null; pricing_model?: string | null }, quantity = 1): string {
  const every = interval(p.interval, p.interval_count ?? 1);
  if (p.pricing_model === 'per_seat') return `${money(p.unit_amount * quantity, p.currency)}${every} · ${quantity} seat${quantity === 1 ? '' : 's'}`;
  if (p.pricing_model === 'usage') return `Usage-based (${money(p.unit_amount, p.currency)} per unit)`;
  if (p.pricing_model === 'tiered') return 'Tiered pricing';
  return `${money(p.unit_amount, p.currency)}${every}`;
}

export function methodText(type: string | null | undefined, details: Record<string, unknown> | null | undefined): string {
  const d = details ?? {};
  if (d.brand && d.last4) return `${String(d.brand)} •••• ${String(d.last4)}`;
  if (d.last4) return `•••• ${String(d.last4)}`;
  return (type ?? '—').replace(/_/g, ' ');
}

/** Turn YYYY-MM-DD filter values into an inclusive local-day range for the API. */
export function dayStart(day: string | number | undefined): string | undefined {
  return day ? new Date(`${day}T00:00:00`).toISOString() : undefined;
}
export function dayEnd(day: string | number | undefined): string | undefined {
  return day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined;
}

/** Non-empty URL state values (page, filters) as API query parameters. */
export function cleanQuery(state: Record<string, unknown>, omit: string[] = []): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(state)) if (!omit.includes(k) && v !== '' && v !== undefined && v !== null) out[k] = v as string | number;
  return out;
}

export function useCurrencies(): { base: string; list: string[] } {
  const boot = useBootstrap();
  const base = boot.data?.locale.currency ?? 'USD';
  const list = boot.data?.locale.currencies?.length ? boot.data.locale.currencies : [base];
  return { base, list: list.includes(base) ? list : [base, ...list] };
}

export interface GatewayRow {
  id: string;
  name: string;
  adapter: string;
  enabled: boolean;
  mode: 'test' | 'live';
}

export function useGateways() {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['gateways'],
    queryFn: () => api.get<{ data: GatewayRow[] }>('/api/admin/gateways'),
    enabled: can('billing.gateways.view'),
    staleTime: 5 * 60_000,
  });
}

/** Amount typed in major units ("12.50"), converted to minor units by the caller with toMinor. */
export function AmountInput({ id, value, onChange, currency, disabled, required, invalid, label }: { id?: string; value: string; onChange: (v: string) => void; currency: string; disabled?: boolean; required?: boolean; invalid?: boolean; label?: string }) {
  const step = decimals(currency) === 0 ? '1' : (1 / 10 ** decimals(currency)).toFixed(decimals(currency));
  return (
    <div className="relative">
      <Input id={id} aria-label={label} type="number" inputMode="decimal" min={0} step={step} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={required} invalid={invalid} className="pr-14 tabular" />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">{currency}</span>
    </div>
  );
}

export function minorOrNull(value: string, currency: string): number | null {
  if (value.trim() === '') return null;
  return toMinor(value, currency);
}

// ---- Customer picker ---------------------------------------------------------------------

export interface PickedCustomer {
  type: SubjectType;
  id: string;
  label: string;
  sublabel?: string | null;
}

export function subjectBody(c: PickedCustomer): { userId?: string; orgId?: string } {
  return c.type === 'organization' ? { orgId: c.id } : { userId: c.id };
}

/** Search users or organizations to bill. */
export function CustomerPicker({ value, onChange, locked }: { value: PickedCustomer | null; onChange: (c: PickedCustomer | null) => void; locked?: boolean }) {
  const { can } = useAuth();
  const canUsers = can('customers.users.view');
  const canOrgs = can('customers.organizations.view');
  const [type, setType] = useState<SubjectType>(canUsers ? 'user' : 'organization');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const users = useQuery({
    queryKey: ['revenue-pick-users', dq],
    queryFn: ({ signal }) => api.get<Page<{ id: string; email: string; name: string | null; avatar_url: string | null }>>('/api/admin/users', { q: dq || undefined, pageSize: 8 }, signal),
    enabled: !value && type === 'user' && canUsers,
  });
  const orgs = useQuery({
    queryKey: ['revenue-pick-orgs', dq],
    queryFn: ({ signal }) => api.get<Page<{ id: string; name: string; slug: string; member_count?: number }>>('/api/admin/organizations', { q: dq || undefined, pageSize: 8 }, signal),
    enabled: !value && type === 'organization' && canOrgs,
  });

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-ui-sm border bg-muted/30 px-3 py-2">
        {value.type === 'organization' ? <Building2 className="size-4 text-muted-foreground" aria-hidden="true" /> : <Avatar name={value.label} email={value.sublabel} size="sm" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{value.label}</span>
          {value.sublabel && <span className="block truncate text-xs text-muted-foreground">{value.sublabel}</span>}
        </span>
        {!locked && (
          <Button variant="ghost" size="icon-sm" aria-label="Choose another customer" onClick={() => onChange(null)}>
            <X className="size-4" />
          </Button>
        )}
      </div>
    );
  }

  const results =
    type === 'user'
      ? (users.data?.data ?? []).map((u) => ({ id: u.id, label: u.name || u.email, sublabel: u.name ? u.email : null }))
      : (orgs.data?.data ?? []).map((o) => ({ id: o.id, label: o.name, sublabel: o.slug }));
  const loading = type === 'user' ? users.isFetching : orgs.isFetching;
  const allowed = type === 'user' ? canUsers : canOrgs;

  return (
    <div className="space-y-2">
      {canUsers && canOrgs && (
        <div role="radiogroup" aria-label="Customer type" className="inline-flex rounded-ui-sm border bg-surface p-0.5">
          {(['user', 'organization'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-1 text-sm font-medium', type === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {t === 'user' ? 'User' : 'Organization'}
            </button>
          ))}
        </div>
      )}
      {allowed ? (
        <>
          <SearchInput value={q} onChange={setQ} placeholder={type === 'user' ? 'Search users by email or name…' : 'Search organizations…'} />
          <ul className="max-h-56 divide-y overflow-y-auto rounded-ui-sm border" role="listbox" aria-label="Matching customers">
            {loading && results.length === 0 && (
              <li className="flex justify-center p-4">
                <Spinner />
              </li>
            )}
            {!loading && results.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No matches</li>}
            {results.map((r) => (
              <li key={r.id} role="option" aria-selected={false}>
                <button type="button" className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/50" onClick={() => onChange({ type, id: r.id, label: r.label, sublabel: r.sublabel })}>
                  {type === 'organization' ? <Building2 className="size-4 text-muted-foreground" aria-hidden="true" /> : <Avatar name={r.label} email={r.sublabel} size="sm" />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{r.label}</span>
                    {r.sublabel && <span className="block truncate text-xs text-muted-foreground">{r.sublabel}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">You do not have access to browse {type === 'user' ? 'users' : 'organizations'}.</p>
      )}
    </div>
  );
}

// ---- Customer billing card (profile, payment methods, account credit) ---------------------

interface BillingProfile {
  subject: { type: SubjectType; id: string };
  profile: {
    name: string | null;
    company: string | null;
    email: string | null;
    address: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
    tax_id: string | null;
    tax_id_type: string | null;
    tax_exempt: boolean;
    preferred_currency: string | null;
  } | null;
  paymentMethods: { id: string; gateway_id: string; type: string; brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; is_default: boolean; created_at: string }[];
  balances: { currency: string; balance: number }[];
}

function subjectQuery(type: string, id: string) {
  return type === 'organization' ? { orgId: id } : { userId: id };
}

function EditProfileDialog({ type, id, data, open, onOpenChange }: { type: string; id: string; data: BillingProfile; open: boolean; onOpenChange: (o: boolean) => void }) {
  const p = data.profile;
  const [form, setForm] = useState({
    name: p?.name ?? '',
    company: p?.company ?? '',
    email: p?.email ?? '',
    line1: p?.address?.line1 ?? '',
    line2: p?.address?.line2 ?? '',
    city: p?.address?.city ?? '',
    state: p?.address?.state ?? '',
    postalCode: p?.address?.postalCode ?? '',
    country: p?.address?.country ?? '',
    taxId: p?.tax_id ?? '',
    taxIdType: p?.tax_id_type ?? '',
    taxExempt: Boolean(p?.tax_exempt),
    preferredCurrency: p?.preferred_currency ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const { list } = useCurrencies();
  const save = useAction(
    () =>
      api.put('/api/admin/billing-profile', {
        ...subjectQuery(type, id),
        name: form.name || null,
        company: form.company || null,
        email: form.email || null,
        address: {
          line1: form.line1 || undefined,
          line2: form.line2 || undefined,
          city: form.city || undefined,
          state: form.state || undefined,
          postalCode: form.postalCode || undefined,
          country: form.country ? form.country.toUpperCase() : undefined,
        },
        taxId: form.taxId || null,
        taxIdType: form.taxIdType || null,
        taxExempt: form.taxExempt,
        preferredCurrency: form.preferredCurrency || undefined,
      }),
    { success: 'Billing details saved', invalidate: [['billing-profile', type, id]], onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Billing details"
      description="Printed on invoices and used for tax (country, tax ID, exemption)."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="billing-profile-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="billing-profile-form"
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
        <Field label="Name" htmlFor="bp-name">
          <Input id="bp-name" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Company" htmlFor="bp-company">
          <Input id="bp-company" value={form.company} onChange={set('company')} />
        </Field>
        <Field label="Billing email" htmlFor="bp-email" className="sm:col-span-2">
          <Input id="bp-email" type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Address line 1" htmlFor="bp-l1" className="sm:col-span-2">
          <Input id="bp-l1" value={form.line1} onChange={set('line1')} />
        </Field>
        <Field label="Address line 2" htmlFor="bp-l2" className="sm:col-span-2">
          <Input id="bp-l2" value={form.line2} onChange={set('line2')} />
        </Field>
        <Field label="City" htmlFor="bp-city">
          <Input id="bp-city" value={form.city} onChange={set('city')} />
        </Field>
        <Field label="State / region" htmlFor="bp-state">
          <Input id="bp-state" value={form.state} onChange={set('state')} />
        </Field>
        <Field label="Postal code" htmlFor="bp-zip">
          <Input id="bp-zip" value={form.postalCode} onChange={set('postalCode')} />
        </Field>
        <Field label="Country" htmlFor="bp-country" hint="Two-letter code; decides the tax rate">
          <Input id="bp-country" value={form.country} onChange={set('country')} maxLength={2} />
        </Field>
        <Field label="Tax ID" htmlFor="bp-taxid" hint="VAT/GST number for B2B reverse charge">
          <Input id="bp-taxid" value={form.taxId} onChange={set('taxId')} />
        </Field>
        <Field label="Tax ID type" htmlFor="bp-taxtype" hint="e.g. eu_vat, gb_vat, in_gst">
          <Input id="bp-taxtype" value={form.taxIdType} onChange={set('taxIdType')} />
        </Field>
        <Field label="Preferred currency" htmlFor="bp-cur">
          <Select id="bp-cur" value={form.preferredCurrency} onChange={set('preferredCurrency')} placeholder="Not set" options={list} />
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox checked={form.taxExempt} onChange={(e) => setForm((f) => ({ ...f, taxExempt: e.target.checked }))} label="Tax exempt" description="No tax is added to this customer's invoices." />
        </div>
      </form>
    </Modal>
  );
}

function CreditDialog({ type, id, open, onOpenChange, defaultCurrency }: { type: string; id: string; open: boolean; onOpenChange: (o: boolean) => void; defaultCurrency: string }) {
  const { list } = useCurrencies();
  const [form, setForm] = useState({ direction: 'add', currency: defaultCurrency, amount: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = useAction(
    () => {
      const minor = minorOrNull(form.amount, form.currency);
      if (!minor || minor <= 0) throw new Error('Enter an amount greater than zero');
      return api.post<{ balance: number }>('/api/admin/customer-balance', { ...subjectQuery(type, id), currency: form.currency, amount: form.direction === 'add' ? minor : -minor, reason: form.reason });
    },
    {
      success: (r) => `Account credit is now ${money(r.balance, form.currency)}`,
      invalidate: [['billing-profile', type, id]],
      onSuccess: () => onOpenChange(false),
      onError: (e) => setError(errorMessage(e)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust account credit"
      description="Credit is applied automatically to the customer's next invoices in the same currency."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="credit-form" loading={submit.isPending}>
            {form.direction === 'add' ? 'Add credit' : 'Remove credit'}
          </Button>
        </>
      }
    >
      <form
        id="credit-form"
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
        <Field label="Action" htmlFor="cr-dir">
          <Select id="cr-dir" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })} options={[{ value: 'add', label: 'Add credit' }, { value: 'remove', label: 'Remove credit' }]} />
        </Field>
        <Field label="Currency" htmlFor="cr-cur">
          <Select id="cr-cur" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} options={list} />
        </Field>
        <Field label="Amount" htmlFor="cr-amt" className="sm:col-span-2">
          <AmountInput id="cr-amt" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} currency={form.currency} required />
        </Field>
        <Field label="Reason" htmlFor="cr-reason" hint="Recorded in the balance history and audit log" className="sm:col-span-2">
          <Input id="cr-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} minLength={3} required />
        </Field>
      </form>
    </Modal>
  );
}

/** Billing profile, saved payment methods and account credit of the subject a record belongs to. */
export function CustomerBillingCard({ type, id, label, currency }: { type: string; id: string; label?: string | null; currency: string }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const q = useQuery({ queryKey: ['billing-profile', type, id], queryFn: () => api.get<BillingProfile>('/api/admin/billing-profile', subjectQuery(type, id)), enabled: can('billing.subscriptions.view') });
  const p = q.data?.profile;
  const address = p ? [p.address?.line1, p.address?.line2, [p.address?.postalCode, p.address?.city].filter(Boolean).join(' '), p.address?.state, p.address?.country].filter(Boolean).join(', ') : '';
  return (
    <Card
      title="Customer"
      actions={
        can('billing.subscriptions.manage') && q.data ? (
          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
            Billing details
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <CustomerLink type={type} id={id} label={label} />
        {q.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : q.data ? (
          <>
            {p && (p.company || p.email || address || p.tax_id) ? (
              <dl className="space-y-1.5 text-sm">
                {p.company && (
                  <div>
                    <dt className="sr-only">Company</dt>
                    <dd className="font-medium">{p.company}</dd>
                  </div>
                )}
                {p.email && (
                  <div>
                    <dt className="sr-only">Billing email</dt>
                    <dd>{p.email}</dd>
                  </div>
                )}
                {address && (
                  <div>
                    <dt className="sr-only">Address</dt>
                    <dd className="text-muted-foreground">{address}</dd>
                  </div>
                )}
                {p.tax_id && (
                  <div>
                    <dt className="sr-only">Tax ID</dt>
                    <dd>
                      Tax ID <span className="font-mono">{p.tax_id}</span>
                      {p.tax_id_type ? ` (${p.tax_id_type})` : ''}
                    </dd>
                  </div>
                )}
                {p.tax_exempt && <Badge tone="warning">tax exempt</Badge>}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No billing details on file.</p>
            )}
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Payment methods</p>
              {q.data.paymentMethods.length === 0 ? (
                <p className="text-sm text-muted-foreground">None saved.</p>
              ) : (
                <ul className="space-y-1.5">
                  {q.data.paymentMethods.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 text-sm">
                      <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
                      <span className="capitalize">{m.brand ?? m.type}</span>
                      {m.last4 && <span className="font-mono">•••• {m.last4}</span>}
                      {m.exp_month && m.exp_year && (
                        <span className="text-muted-foreground">
                          {String(m.exp_month).padStart(2, '0')}/{String(m.exp_year).slice(-2)}
                        </span>
                      )}
                      {m.is_default && <Badge tone="primary">default</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Account credit</p>
                {can('billing.refunds.create') && (
                  <Button size="sm" variant="link" icon={<Plus className="size-3.5" />} onClick={() => setCrediting(true)}>
                    Adjust
                  </Button>
                )}
              </div>
              {q.data.balances.filter((b) => b.balance > 0).length === 0 ? (
                <p className="text-sm text-muted-foreground">No credit.</p>
              ) : (
                <ul className="space-y-1">
                  {q.data.balances
                    .filter((b) => b.balance > 0)
                    .map((b) => (
                      <li key={b.currency} className="flex justify-between text-sm">
                        <span>{b.currency}</span>
                        <span className="font-semibold tabular">{money(b.balance, b.currency)}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
      {editing && q.data && <EditProfileDialog type={type} id={id} data={q.data} open={editing} onOpenChange={setEditing} />}
      {crediting && <CreditDialog type={type} id={id} open={crediting} onOpenChange={setCrediting} defaultCurrency={currency} />}
    </Card>
  );
}

/** A labelled total row for invoice and order breakdowns. */
export function TotalRow({ label, value, strong, muted }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <div className={clsx('flex items-center justify-between gap-4 py-1 text-sm', strong && 'border-t pt-2 font-semibold', muted && 'text-muted-foreground')}>
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
