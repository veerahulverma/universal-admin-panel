import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building2, Coins, MoreHorizontal, RotateCcw, Search, SlidersHorizontal, User, X } from 'lucide-react';
import clsx from 'clsx';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { dateTime, num } from '../../lib/format';
import { UsageMeters, type MeterUsage } from '../../components/UsagePanel';
import {
  Badge,
  Button,
  Card,
  ChartCard,
  ColumnChart,
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
  Pagination,
  Select,
  Tabs,
  Toolbar,
  When,
  useConfirm,
} from '../../components/ui';
import { RangePresets, fillDays } from '../reports/viz';
import { useFormErrors, useMeters, type Meter } from './shared';

interface Overview {
  since: string;
  daily: { day: string; meter_key: string; quantity: number }[];
  totals: { meter_key: string; quantity: number; subjects: number }[];
  top: { subject_type: 'user' | 'organization'; subject_id: string; meter_key: string; quantity: number; label: string | null }[];
  atLimit: number;
}

interface UsageEvent {
  id: string;
  subject_type: 'user' | 'organization';
  subject_id: string;
  user_id: string | null;
  org_id: string | null;
  meter_key: string;
  quantity: number;
  raw_quantity: number;
  dimensions: Record<string, string>;
  idempotency_key: string | null;
  source: string;
  reason: string | null;
  created_at: string;
}

interface LedgerRow {
  id: string;
  credit_type: string;
  amount: number;
  balance_after: number;
  remaining: number | null;
  reason: string | null;
  source: string;
  expires_at: string | null;
  created_at: string;
}

interface Subject {
  type: 'user' | 'organization';
  id: string;
  label: string;
}

const subjectHref = (type: string, id: string) => (type === 'organization' ? `/customers/organizations/${id}` : `/customers/users/${id}`);
const subjectQuery = (s: Pick<Subject, 'type' | 'id'>) => (s.type === 'organization' ? { orgId: s.id } : { userId: s.id });

// ---- Customer picker ---------------------------------------------------------------------------

function CustomerPicker({ onSelect }: { onSelect: (s: Subject) => void }) {
  const { can } = useAuth();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const users = useQuery({
    queryKey: ['usage-picker', 'users', q],
    queryFn: () => api.get<Page<{ id: string; email: string; name: string | null }>>('/api/admin/users', { q, pageSize: 6 }),
    enabled: q.length >= 2 && can('customers.users.view'),
  });
  const orgs = useQuery({
    queryKey: ['usage-picker', 'orgs', q],
    queryFn: () => api.get<Page<{ id: string; name: string; slug: string }>>('/api/admin/organizations', { q, pageSize: 6 }),
    enabled: q.length >= 2 && can('customers.organizations.view'),
  });
  const results: Subject[] = [
    ...(users.data?.data ?? []).map((u) => ({ type: 'user' as const, id: u.id, label: u.name ? `${u.name} (${u.email})` : u.email })),
    ...(orgs.data?.data ?? []).map((o) => ({ type: 'organization' as const, id: o.id, label: o.name })),
  ];
  return (
    <Card title="Find a customer" description="Look up a user or organization to see its quotas, usage and credits.">
      <div className="relative max-w-lg">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Email, name, organization or ID…" aria-label="Find a customer" className="pl-8" autoFocus />
      </div>
      {q.length >= 2 && (
        <ul className="mt-3 max-w-lg divide-y rounded-ui-sm border">
          {results.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">{users.isFetching || orgs.isFetching ? 'Searching…' : 'No customers found'}</li>}
          {results.map((r) => (
            <li key={`${r.type}:${r.id}`}>
              <button type="button" onClick={() => onSelect(r)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted/50">
                {r.type === 'organization' ? <Building2 className="size-4 text-muted-foreground" aria-hidden="true" /> : <User className="size-4 text-muted-foreground" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <Badge>{r.type === 'organization' ? 'organization' : 'user'}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- Dialogs ---------------------------------------------------------------------------------------

function AdjustDialog({ subject, meters, initialMeter, onClose }: { subject: Subject; meters: MeterUsage[]; initialMeter: string; onClose: () => void }) {
  const [meter, setMeter] = useState(initialMeter);
  const [direction, setDirection] = useState<'add' | 'remove'>('remove');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const errors = useFormErrors();
  const current = meters.find((m) => m.meter === meter);
  const adjust = useAction(() => api.post('/api/admin/usage/adjust', { ...subjectQuery(subject), meter, quantity: (direction === 'remove' ? -1 : 1) * Math.trunc(Number(quantity)), reason }), {
    success: 'Usage adjusted',
    invalidate: [['usage-subject'], ['usage-overview'], ['usage-events']],
    onSuccess: onClose,
    onError: (err) => errors.set(err, ['quantity', 'reason', 'meter']),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Adjust usage"
      description={`Correct the recorded usage for ${subject.label}. The change is logged as an admin event with your reason.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="adjust-form" loading={adjust.isPending}>
            Apply adjustment
          </Button>
        </>
      }
    >
      <form
        id="adjust-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          adjust.mutate();
        }}
      >
        <FormError message={errors.general} />
        <Field label="Meter" htmlFor="adj-meter" hint={current ? `Currently ${num(current.used)}${current.unit ? ` ${current.unit}` : ''} used this period` : undefined}>
          <Select id="adj-meter" value={meter} onChange={(e) => setMeter(e.target.value)} options={meters.map((m) => ({ value: m.meter, label: m.name }))} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Direction" htmlFor="adj-dir">
            <Select id="adj-dir" value={direction} onChange={(e) => setDirection(e.target.value as 'add' | 'remove')} options={[{ value: 'remove', label: 'Remove usage (credit back)' }, { value: 'add', label: 'Add usage' }]} />
          </Field>
          <Field label="Quantity" htmlFor="adj-qty" error={errors.fields.quantity}>
            <Input id="adj-qty" type="number" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </Field>
        </div>
        <Field label="Reason" htmlFor="adj-reason" error={errors.fields.reason} hint="Required; stored in the audit log">
          <Input id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required placeholder="e.g. Failed batch re-run, ticket #4821" />
        </Field>
      </form>
    </Modal>
  );
}

function CreditsDialog({ subject, creditTypes, onClose }: { subject: Subject; creditTypes: string[]; onClose: () => void }) {
  const [action, setAction] = useState<'grant' | 'deduct'>('grant');
  const [creditType, setCreditType] = useState(creditTypes[0] ?? 'credits');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const errors = useFormErrors();
  const submit = useAction(
    () =>
      api.post(`/api/admin/credits/${action}`, {
        ...subjectQuery(subject),
        creditType,
        amount: Math.trunc(Number(amount)),
        reason,
        expiresAt: action === 'grant' && expiresAt ? new Date(expiresAt).toISOString() : undefined,
      }),
    { success: action === 'grant' ? 'Credits granted' : 'Credits deducted', invalidate: [['usage-subject'], ['usage-credits']], onSuccess: onClose, onError: (err) => errors.set(err, ['amount', 'reason', 'creditType', 'expiresAt']) },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Adjust credits"
      description={`Grant complimentary credits to ${subject.label}, or deduct credits. Every change is recorded in the credit ledger.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="credits-form" variant={action === 'deduct' ? 'danger' : 'primary'} loading={submit.isPending}>
            {action === 'grant' ? 'Grant credits' : 'Deduct credits'}
          </Button>
        </>
      }
    >
      <form
        id="credits-form"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          submit.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={errors.general} />
        </div>
        <Field label="Action" htmlFor="cr-action">
          <Select id="cr-action" value={action} onChange={(e) => setAction(e.target.value as 'grant' | 'deduct')} options={[{ value: 'grant', label: 'Grant (complimentary)' }, { value: 'deduct', label: 'Deduct' }]} />
        </Field>
        <Field label="Credit type" htmlFor="cr-type" error={errors.fields.creditType}>
          <Input id="cr-type" value={creditType} onChange={(e) => setCreditType(e.target.value)} className="font-mono" list="credit-types" required />
          <datalist id="credit-types">
            {creditTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field label="Amount" htmlFor="cr-amount" error={errors.fields.amount}>
          <Input id="cr-amount" type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        {action === 'grant' && (
          <Field label="Expires" htmlFor="cr-exp" hint="Optional" error={errors.fields.expiresAt}>
            <Input id="cr-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        )}
        <Field label="Reason" htmlFor="cr-reason" className="sm:col-span-2" error={errors.fields.reason} hint="Required; recorded in the ledger and audit log">
          <Input id="cr-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
        </Field>
      </form>
    </Modal>
  );
}

// ---- Tabs ------------------------------------------------------------------------------------------

function OverviewTab({ days, meter, setState, onInspect }: { days: number; meter: string; setState: (p: Record<string, string | number | undefined>) => void; onInspect: (s: Subject) => void }) {
  const meters = useMeters(true);
  const overview = useQuery({
    queryKey: ['usage-overview', days, meter],
    queryFn: ({ signal }) => api.get<Overview>('/api/admin/usage/overview', { days, meter: meter || undefined }, signal),
    placeholderData: keepPreviousData,
  });
  const byKey = useMemo(() => new Map((meters.data?.data ?? []).map((m) => [m.key, m])), [meters.data]);
  const d = overview.data;
  const fetching = overview.isFetching && !overview.isLoading;
  const series = useMemo(() => {
    if (!d) return [];
    const from = new Date(d.since);
    const to = new Date();
    const keys = meter ? [meter] : d.totals.slice(0, 4).map((t) => t.meter_key);
    return keys.map((key) => ({ key, points: fillDays(d.daily.filter((x) => x.meter_key === key).map((x) => ({ day: x.day, value: x.quantity })), from, to) }));
  }, [d, meter]);

  const name = (key: string) => byKey.get(key)?.name ?? key;
  const unit = (key: string) => byKey.get(key)?.unit;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <RangePresets days={days} onChange={(v) => setState({ days: v })} />
        <Select aria-label="Meter" className="w-auto" value={meter} onChange={(e) => setState({ meter: e.target.value })} placeholder="All meters" options={(meters.data?.data ?? []).map((m) => ({ value: m.key, label: m.name }))} />
      </div>
      {overview.isLoading ? (
        <PageSkeleton />
      ) : overview.error || !d ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <>
          <div className={clsx('grid grid-cols-1 gap-3 transition-opacity min-[420px]:grid-cols-2 lg:grid-cols-4', fetching && 'opacity-60')}>
            {d.totals.slice(0, 3).map((t) => (
              <div key={t.meter_key} className="rounded-ui border bg-surface p-4 shadow-ui">
                <p className="truncate text-sm text-muted-foreground">{name(t.meter_key)}</p>
                <p className="mt-1.5 text-2xl font-semibold tracking-tight">
                  {num(t.quantity, { compact: true })}
                  {unit(t.meter_key) && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit(t.meter_key)}</span>}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {num(t.subjects)} customer{t.subjects === 1 ? '' : 's'}
                </p>
              </div>
            ))}
            <div className="rounded-ui border bg-surface p-4 shadow-ui">
              <p className="truncate text-sm text-muted-foreground">Limits reached</p>
              <p className="mt-1.5 text-2xl font-semibold tracking-tight">{num(d.atLimit)}</p>
              <p className="mt-1 text-xs text-muted-foreground">quota counters that hit their limit</p>
            </div>
          </div>
          {series.length === 0 ? (
            <Card>
              <EmptyState title="No usage recorded in this period" description="Usage appears when your application records it through the API or SDK." />
            </Card>
          ) : (
            <div className={clsx('grid gap-4', series.length > 1 && 'xl:grid-cols-2')}>
              {series.map((s) => {
                const fmt = (v: number) => `${num(v)}${unit(s.key) ? ` ${unit(s.key)}` : ''}`;
                return (
                  <ChartCard key={s.key} title={name(s.key)} description={`Daily consumption${unit(s.key) ? ` · ${unit(s.key)}` : ''}`} data={s.points} format={fmt} fetching={fetching}>
                    <ColumnChart data={s.points} format={fmt} label={`Daily ${name(s.key)}`} />
                  </ChartCard>
                );
              })}
            </div>
          )}
          <Card title="Top consumers" description="Highest usage in the selected period" padded={false}>
            <DataTable
              caption="Top consumers"
              rows={d.top}
              rowKey={(r) => `${r.subject_type}:${r.subject_id}:${r.meter_key}`}
              empty={<EmptyState title="No consumers yet" />}
              columns={[
                {
                  key: 'customer',
                  header: 'Customer',
                  cell: (r) => (
                    <Link to={subjectHref(r.subject_type, r.subject_id)} className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
                      {r.subject_type === 'organization' ? <Building2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                      <span className="truncate">{r.label ?? r.subject_id}</span>
                    </Link>
                  ),
                },
                { key: 'meter', header: 'Meter', cell: (r) => name(r.meter_key) },
                { key: 'quantity', header: 'Usage', align: 'right', cell: (r) => <span className="tabular">{num(r.quantity)}</span> },
                {
                  key: 'inspect',
                  header: <span className="sr-only">Inspect</span>,
                  align: 'right',
                  cell: (r) => (
                    <Button variant="ghost" size="sm" onClick={() => onInspect({ type: r.subject_type, id: r.subject_id, label: r.label ?? r.subject_id })}>
                      Inspect
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}

function EventsTab({ state, setState, subject, onClearSubject, meters }: { state: Record<string, string | number | undefined>; setState: (p: Record<string, string | number | undefined>, o?: { resetPage?: boolean }) => void; subject: Subject | null; onClearSubject: () => void; meters: Meter[] }) {
  const query = { page: Number(state.page) || 1, pageSize: 50, meter: state.meter || undefined, ...(subject ? subjectQuery(subject) : {}) };
  const events = useQuery({
    queryKey: ['usage-events', query],
    queryFn: ({ signal }) => api.get<Page<UsageEvent>>('/api/admin/usage/events', query as Record<string, string | number | undefined>, signal),
    placeholderData: keepPreviousData,
  });
  const name = (key: string) => meters.find((m) => m.key === key)?.name ?? key;
  return (
    <Card padded={false}>
      <Toolbar>
        <Select aria-label="Meter" className="w-auto" value={String(state.meter ?? '')} onChange={(e) => setState({ meter: e.target.value })} placeholder="All meters" options={meters.map((m) => ({ value: m.key, label: m.name }))} />
        {subject ? (
          <Badge tone="primary" className="gap-1.5 py-1">
            {subject.label}
            <button type="button" aria-label="Show all customers" onClick={onClearSubject} className="rounded hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">All customers · use the Customer tab to filter by one</span>
        )}
      </Toolbar>
      {events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <DataTable
          caption="Usage events"
          rows={events.data?.data}
          loading={events.isLoading}
          fetching={events.isFetching && !events.isLoading}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No usage events" description="Events appear as your application records usage." />}
          columns={[
            { key: 'when', header: 'Recorded', cell: (e) => <When value={e.created_at} /> },
            {
              key: 'customer',
              header: 'Customer',
              cell: (e) => (
                <Link to={subjectHref(e.subject_type, e.subject_id)} className="font-mono text-xs text-primary hover:underline">
                  {e.subject_id}
                </Link>
              ),
            },
            { key: 'meter', header: 'Meter', cell: (e) => name(e.meter_key) },
            {
              key: 'quantity',
              header: 'Quantity',
              align: 'right',
              cell: (e) => (
                <span className={clsx('tabular', e.quantity < 0 && 'text-danger')} title={Number(e.raw_quantity) !== e.quantity ? `Recorded ${num(Number(e.raw_quantity), { digits: 4 })} before weights` : undefined}>
                  {num(e.quantity)}
                </span>
              ),
            },
            { key: 'source', header: 'Source', cell: (e) => <Badge tone={e.source === 'admin' ? 'warning' : 'neutral'}>{e.source}</Badge> },
            {
              key: 'details',
              header: 'Details',
              priority: 'low',
              cell: (e) => (
                <span className="block max-w-xs truncate text-xs text-muted-foreground">
                  {[e.reason, ...Object.entries(e.dimensions ?? {}).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join(' · ') || '—'}
                </span>
              ),
            },
            { key: 'idem', header: 'Idempotency key', priority: 'low', cell: (e) => <Mono>{e.idempotency_key}</Mono> },
          ]}
        />
      )}
      {events.data && <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </Card>
  );
}

function CustomerTab({ subject, onSelect, onClear }: { subject: Subject | null; onSelect: (s: Subject) => void; onClear: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [ledgerPage, setLedgerPage] = useState(1);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const usage = useQuery({
    queryKey: ['usage-subject', subject?.type, subject?.id],
    queryFn: () => api.get<{ meters: MeterUsage[]; credits: { type: string; balance: number }[] }>('/api/admin/usage', subjectQuery(subject!)),
    enabled: Boolean(subject),
  });
  const credits = useQuery({
    queryKey: ['usage-credits', subject?.type, subject?.id, ledgerPage],
    queryFn: () => api.get<{ balances: { type: string; balance: number }[]; ledger: Page<LedgerRow> }>('/api/admin/credits', { ...subjectQuery(subject!), page: ledgerPage, pageSize: 20 }),
    enabled: Boolean(subject) && can('usage.credits.view'),
    placeholderData: keepPreviousData,
  });
  const reset = useAction(({ meter, reason }: { meter: string; reason: string }) => api.post('/api/admin/usage/reset', { ...subjectQuery(subject!), meter, reason }), {
    success: 'Usage reset for the current period',
    invalidate: [['usage-subject'], ['usage-overview'], ['usage-events']],
  });

  if (!subject) return <CustomerPicker onSelect={onSelect} />;
  const meters = usage.data?.meters ?? [];
  const canAdjust = can('usage.adjust.manage');

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {subject.type === 'organization' ? <Building2 className="size-5 text-muted-foreground" aria-hidden="true" /> : <User className="size-5 text-muted-foreground" aria-hidden="true" />}
            <div className="min-w-0">
              <p className="truncate font-medium">{subject.label}</p>
              <p className="font-mono text-xs text-muted-foreground">{subject.id}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link to={subjectHref(subject.type, subject.id)} className="inline-flex h-8 items-center rounded-ui-sm border px-2.5 text-sm font-medium shadow-ui hover:bg-muted/60">
              Open profile
            </Link>
            <Button variant="ghost" size="sm" onClick={onClear}>
              Change customer
            </Button>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Quotas and usage" description="Current period, as enforced by the server" className="lg:col-span-2">
          {usage.isLoading ? (
            <PageSkeleton />
          ) : usage.error ? (
            <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
          ) : meters.length === 0 ? (
            <UsageMeters meters={[]} />
          ) : (
            <ul className="space-y-4">
              {meters.map((m) => (
                <li key={m.meter} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <UsageMeters meters={[m]} />
                  </div>
                  {canAdjust && (
                    <Menu
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.name}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      }
                      items={[
                        { label: 'Adjust usage…', icon: <SlidersHorizontal className="size-4" />, onSelect: () => setAdjusting(m.meter) },
                        {
                          label: 'Reset this period',
                          icon: <RotateCcw className="size-4" />,
                          danger: true,
                          disabled: m.used === 0,
                          onSelect: async () => {
                            const r = await confirm({
                              title: `Reset ${m.name} to zero?`,
                              description: `Clears ${num(m.used)}${m.unit ? ` ${m.unit}` : ''} of usage for the current period and lifts the limit warnings. Recorded as an admin adjustment.`,
                              confirmLabel: 'Reset usage',
                              tone: 'danger',
                              reason: { label: 'Reason (audit log)', required: true, placeholder: 'e.g. Goodwill after incident' },
                            });
                            if (r.confirmed && r.reason) reset.mutate({ meter: m.meter, reason: r.reason });
                          },
                        },
                      ]}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {can('usage.credits.view') && (
          <Card
            title="Credits"
            actions={
              can('usage.credits.manage') && (
                <Button size="sm" variant="outline" icon={<Coins className="size-4" />} onClick={() => setCreditsOpen(true)}>
                  Adjust
                </Button>
              )
            }
          >
            {(credits.data?.balances ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No credit balance.</p>
            ) : (
              <ul className="divide-y">
                {credits.data!.balances.map((b) => (
                  <li key={b.type} className="flex items-center justify-between py-2 text-sm">
                    <span className="font-mono text-xs">{b.type}</span>
                    <span className="font-semibold tabular">{num(b.balance)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
      {can('usage.credits.view') && (
        <Card title="Credit ledger" description="Every grant, purchase, consumption and expiry" padded={false}>
          <DataTable
            caption="Credit ledger"
            rows={credits.data?.ledger.data}
            loading={credits.isLoading}
            fetching={credits.isFetching && !credits.isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState title="No credit activity" />}
            columns={[
              { key: 'when', header: 'When', cell: (r) => <When value={r.created_at} /> },
              { key: 'type', header: 'Type', cell: (r) => <span className="font-mono text-xs">{r.credit_type}</span> },
              { key: 'amount', header: 'Change', align: 'right', cell: (r) => <span className={clsx('tabular font-medium', r.amount < 0 ? 'text-danger' : 'text-success')}>{r.amount > 0 ? '+' : ''}{num(r.amount)}</span> },
              { key: 'balance', header: 'Balance', align: 'right', cell: (r) => <span className="tabular">{num(r.balance_after)}</span> },
              { key: 'source', header: 'Source', cell: (r) => <Badge>{r.source}</Badge> },
              { key: 'reason', header: 'Reason', priority: 'low', cell: (r) => <span className="block max-w-xs truncate text-xs">{r.reason ?? '—'}</span> },
              { key: 'expires', header: 'Expires', priority: 'low', cell: (r) => (r.expires_at ? dateTime(r.expires_at) : '—') },
            ]}
          />
          {credits.data && <Pagination page={credits.data.ledger.page} pageSize={credits.data.ledger.pageSize} total={credits.data.ledger.total} onPage={setLedgerPage} />}
        </Card>
      )}
      {adjusting && <AdjustDialog subject={subject} meters={meters} initialMeter={adjusting} onClose={() => setAdjusting(null)} />}
      {creditsOpen && <CreditsDialog subject={subject} creditTypes={(credits.data?.balances ?? []).map((b) => b.type)} onClose={() => setCreditsOpen(false)} />}
    </div>
  );
}

// ---- Page ----------------------------------------------------------------------------------------

const DEFAULTS = { tab: 'overview', days: 30, meter: '', page: 1, userId: '', orgId: '', who: '' };

export default function UsagePage() {
  const [state, setState] = useUrlState(DEFAULTS);
  const meters = useMeters(true);
  const subject: Subject | null = state.orgId ? { type: 'organization', id: String(state.orgId), label: String(state.who || state.orgId) } : state.userId ? { type: 'user', id: String(state.userId), label: String(state.who || state.userId) } : null;
  const select = (s: Subject, tab = 'customer') => setState({ tab, userId: s.type === 'user' ? s.id : undefined, orgId: s.type === 'organization' ? s.id : undefined, who: s.label });
  const clear = () => setState({ userId: undefined, orgId: undefined, who: undefined });

  return (
    <>
      <PageHeader title="Usage" description="Consumption across every meter, the raw usage events, and per-customer quotas, adjustments and credits." />
      <Tabs
        value={String(state.tab)}
        onValueChange={(tab) => setState({ tab })}
        tabs={[
          { value: 'overview', label: 'Overview', content: <OverviewTab days={Number(state.days) || 30} meter={String(state.meter ?? '')} setState={setState} onInspect={(s) => select(s)} /> },
          { value: 'events', label: 'Events', content: <EventsTab state={state} setState={setState} subject={subject} onClearSubject={clear} meters={meters.data?.data ?? []} /> },
          { value: 'customer', label: 'Customer', content: <CustomerTab subject={subject} onSelect={(s) => select(s)} onClear={clear} /> },
        ]}
      />
    </>
  );
}
