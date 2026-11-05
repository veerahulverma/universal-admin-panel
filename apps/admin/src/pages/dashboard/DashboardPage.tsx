import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CircleCheck, CircleX, LayoutGrid } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { money, num, pct } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ChartCard,
  Checkbox,
  ColumnChart,
  EmptyState,
  ErrorState,
  KpiTile,
  LineChart,
  Modal,
  PageHeader,
  PageSkeleton,
  StatusBadge,
  When,
  type Point,
} from '../../components/ui';

interface Kpi {
  key: string;
  label: string;
  value: number;
  previous: number | null;
  format: 'number' | 'money' | 'percent';
  module: string;
}

interface DashboardData {
  currency: string;
  range: { from: string; to: string };
  kpis: Kpi[];
  /** Only the series this admin may see (none for organization-scoped admins). */
  series: Partial<Record<'revenue' | 'signups' | 'mrr', Point[]>>;
  scoped?: boolean;
  recent: {
    users: { id: string; email: string; name: string | null; created_at: string }[];
    payments: { id: string; amount: number; currency: string; status: string; created_at: string; customer_label: string | null }[];
    security: { id: string; type: string; severity: string; subject_type: string | null; subject_id: string | null; created_at: string }[];
    logins: { id: string; subject_type: string; email: string | null; success: boolean; ip: string | null; country: string | null; created_at: string }[];
  };
  system: { jobs: Record<string, number>; checks: { name: string; status: string; detail?: string }[] };
}

interface Widget {
  id: string;
  type: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  config?: Record<string, unknown>;
}

const RANGES = [
  { days: 7, label: '7D', name: 'Last 7 days' },
  { days: 30, label: '30D', name: 'Last 30 days' },
  { days: 90, label: '90D', name: 'Last 90 days' },
  { days: 365, label: '12M', name: 'Last 12 months' },
];

/** Metrics where a rise is bad news (the delta colour flips). */
const DOWN_IS_GOOD = new Set(['refunds', 'cancellations', 'failed_payments', 'chargebacks', 'suspended_users', 'rate_limited', 'open_security_events', 'outstanding_invoices', 'limit_hits']);

const SECTIONS: { id: string; label: string }[] = [
  { id: 'chart:revenue', label: 'Net revenue chart' },
  { id: 'chart:signups', label: 'Registrations chart' },
  { id: 'chart:mrr', label: 'MRR trend' },
  { id: 'list:payments', label: 'Recent payments' },
  { id: 'list:users', label: 'Newest users' },
  { id: 'list:security', label: 'Security events & sign-ins' },
  { id: 'system', label: 'System health' },
  { id: 'more', label: 'Other metrics' },
];

const DEFAULT_KPIS = ['mrr', 'revenue', 'active_subscriptions', 'new_users', 'total_users', 'trialing', 'failed_payments', 'open_security_events'];
const DEFAULT_LAYOUT: Widget[] = [...DEFAULT_KPIS.map((id) => ({ id: `kpi:${id}`, type: 'kpi' })), ...SECTIONS.map((s) => ({ id: s.id, type: 'section' }))];

/** Long ranges are shown weekly so columns stay readable (flows are summed, levels keep the last value). */
function bucket(points: Point[] | undefined, days: number, mode: 'sum' | 'last'): Point[] {
  if (!points) return [];
  if (days <= 120) return points;
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += 7) {
    const chunk = points.slice(i, i + 7);
    out.push({ date: chunk[0].date, value: mode === 'sum' ? chunk.reduce((s, p) => s + p.value, 0) : chunk[chunk.length - 1].value });
  }
  return out;
}

function RangePicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-ui-sm border bg-surface p-0.5 shadow-ui">
      {RANGES.map((r) => (
        <button
          key={r.days}
          type="button"
          role="radio"
          aria-checked={days === r.days}
          title={r.name}
          onClick={() => onChange(r.days)}
          className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-1 text-sm font-medium tabular transition-colors', days === r.days ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function CustomizeDialog({ open, onOpenChange, layout, kpis, onSave, saving }: { open: boolean; onOpenChange: (o: boolean) => void; layout: Widget[]; kpis: Kpi[]; onSave: (w: Widget[]) => void; saving: boolean }) {
  const [draft, setDraft] = useState<Widget[]>(layout);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDraft(layout);
  }
  const all: { id: string; label: string; type: string }[] = [
    ...kpis.map((k) => ({ id: `kpi:${k.key}`, label: k.label, type: 'kpi' })),
    ...SECTIONS.map((s) => ({ ...s, type: 'section' })),
  ];
  const ordered = [...draft.map((w) => all.find((a) => a.id === w.id)).filter((x): x is (typeof all)[number] => Boolean(x)), ...all.filter((a) => !draft.some((w) => w.id === a.id))];
  const enabled = new Set(draft.map((w) => w.id));
  const toggle = (id: string, type: string) => setDraft((d) => (enabled.has(id) ? d.filter((w) => w.id !== id) : [...d, { id, type }]));
  const move = (id: string, dir: -1 | 1) =>
    setDraft((d) => {
      const i = d.findIndex((w) => w.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.length || d[j].type !== d[i].type) return d;
      const next = [...d];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const group = (type: string, title: string) => (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</legend>
      {ordered
        .filter((o) => o.type === type)
        .map((o) => (
          <div key={o.id} className="flex items-center gap-2 rounded-ui-sm px-1 py-1 hover:bg-muted/50">
            <Checkbox checked={enabled.has(o.id)} onChange={() => toggle(o.id, o.type)} label={o.label} className="flex-1" />
            {enabled.has(o.id) && (
              <span className="flex">
                <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => move(o.id, -1)} aria-label={`Move ${o.label} up`}>
                  <ArrowUp className="size-3.5" />
                </button>
                <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => move(o.id, 1)} aria-label={`Move ${o.label} down`}>
                  <ArrowDown className="size-3.5" />
                </button>
              </span>
            )}
          </div>
        ))}
    </fieldset>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Customize dashboard"
      description="Choose and order the metrics and panels you see. This layout is saved to your account."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => setDraft(DEFAULT_LAYOUT)}>
            Reset to default
          </Button>
          <Button onClick={() => onSave(draft)} loading={saving}>
            Save layout
          </Button>
        </>
      }
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {group('kpi', 'Metric tiles')}
        {group('section', 'Panels')}
      </div>
    </Modal>
  );
}

export default function DashboardPage() {
  const { me, can } = useAuth();
  const [state, setState] = useUrlState({ days: 30 });
  const days = Number(state.days) || 30;
  const [customizing, setCustomizing] = useState(false);

  const q = useQuery({
    queryKey: ['dashboard', days],
    queryFn: ({ signal }) => api.get<DashboardData>('/api/admin/dashboard', { days }, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });
  const layoutQ = useQuery({ queryKey: ['dashboard-layout'], queryFn: () => api.get<{ widgets: Widget[] | null }>('/api/admin/dashboard/layout'), staleTime: Infinity });
  const saveLayout = useAction((widgets: Widget[]) => api.put('/api/admin/dashboard/layout', { widgets }), {
    success: 'Dashboard layout saved',
    invalidate: [['dashboard-layout']],
    onSuccess: () => setCustomizing(false),
  });

  const layout = layoutQ.data?.widgets ?? DEFAULT_LAYOUT;
  const d = q.data;
  const currency = d?.currency ?? 'USD';
  const fetching = q.isFetching && !q.isLoading;

  const series = useMemo(
    () => ({
      revenue: bucket(d?.series.revenue, days, 'sum'),
      signups: bucket(d?.series.signups, days, 'sum'),
      mrr: bucket(d?.series.mrr, days, 'last'),
    }),
    [d, days],
  );

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const kpiByKey = new Map(d.kpis.map((k) => [k.key, k]));
  const tiles = layout.filter((w) => w.type === 'kpi').map((w) => kpiByKey.get(w.id.slice(4))).filter((k): k is Kpi => Boolean(k));
  const sections = layout.filter((w) => w.type === 'section').map((w) => w.id);
  const shown = new Set(sections);
  const others = d.kpis.filter((k) => !tiles.includes(k));
  // Headline money drops the cents once it reaches four figures.
  const fmt = (k: Pick<Kpi, 'format' | 'value'>) => (k.format === 'money' ? money(k.value, currency, { whole: Math.abs(k.value) >= 100_000 }) : k.format === 'percent' ? pct(k.value) : num(k.value));
  const trends: Record<string, number[]> = { mrr: series.mrr.map((p) => p.value), revenue: series.revenue.map((p) => p.value), new_users: series.signups.map((p) => p.value) };
  const rangeName = RANGES.find((r) => r.days === days)?.name.toLowerCase() ?? `last ${days} days`;
  const mrrHasHistory = series.mrr.filter((p) => p.value > 0).length >= 2;
  const moneyFmt = (v: number) => money(v, currency);
  const moneyTick = (v: number) => money(v, currency, { compact: true, whole: true });
  const firstName = me?.admin.name?.split(' ')[0];

  const panels: Record<string, React.ReactNode> = {
    'chart:revenue': d.series.revenue && (
      <ChartCard key="chart:revenue" title="Net revenue" description={`Payments minus refunds, ${days > 120 ? 'weekly' : 'daily'} · ${currency}`} data={series.revenue} format={moneyFmt} fetching={fetching}>
        <ColumnChart data={series.revenue} format={moneyFmt} tickFormat={moneyTick} label="Net revenue" />
      </ChartCard>
    ),
    'chart:signups': d.series.signups && (
      <ChartCard key="chart:signups" title="New registrations" description={days > 120 ? 'Weekly sign-ups' : 'Daily sign-ups'} data={series.signups} format={(v) => num(v)} fetching={fetching}>
        <ColumnChart data={series.signups} format={(v) => num(v)} label="New registrations" />
      </ChartCard>
    ),
    'chart:mrr': d.series.mrr && (
      <ChartCard key="chart:mrr" title="Monthly recurring revenue" description="From daily snapshots" data={series.mrr} format={moneyFmt} fetching={fetching}>
        {mrrHasHistory ? (
          <LineChart data={series.mrr} format={moneyFmt} tickFormat={moneyTick} label="Monthly recurring revenue" />
        ) : (
          <EmptyState title="Not enough history yet" description="MRR is captured every few hours; the trend appears after the second snapshot." className="h-[220px]" />
        )}
      </ChartCard>
    ),
    'list:payments':
      d.recent.payments.length || can('billing.payments.view') ? (
        <Card key="list:payments" title="Recent payments" padded={false} actions={can('billing.payments.view') && <Link to="/revenue/payments" className="text-sm text-primary hover:underline">View all</Link>}>
          {d.recent.payments.length === 0 ? (
            <EmptyState title="No payments yet" />
          ) : (
            <ul className="divide-y">
              {d.recent.payments.map((p) => (
                <li key={p.id}>
                  <Link to={`/revenue/payments/${p.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{p.customer_label ?? 'Unknown customer'}</span>
                      <span className="text-xs text-muted-foreground">
                        <When value={p.created_at} />
                      </span>
                    </span>
                    <StatusBadge status={p.status} />
                    <span className="w-24 text-right text-sm font-medium tabular">{money(p.amount, p.currency)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null,
    'list:users': can('customers.users.view') && (
      <Card key="list:users" title="Newest users" padded={false} actions={<Link to="/customers/users" className="text-sm text-primary hover:underline">View all</Link>}>
        {d.recent.users.length === 0 ? (
          <EmptyState title="No users yet" description="Users appear here when your application registers them through the API or SDK." />
        ) : (
          <ul className="divide-y">
            {d.recent.users.map((u) => (
              <li key={u.id}>
                <Link to={`/customers/users/${u.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
                  <Avatar name={u.name} email={u.email} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{u.name || u.email}</span>
                    {u.name && <span className="block truncate text-xs text-muted-foreground">{u.email}</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <When value={u.created_at} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    ),
    'list:security': can('security.events.view') ? (
      <Card key="list:security" title="Security" padded={false} actions={<Link to="/admin/security" className="text-sm text-primary hover:underline">Open security center</Link>}>
        <div className="grid divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
          <div>
            <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Events</p>
            {d.recent.security.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No security events.</p>
            ) : (
              <ul>
                {d.recent.security.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 px-4 py-2">
                    <Badge tone={s.severity === 'critical' ? 'danger' : s.severity === 'warning' ? 'warning' : 'neutral'}>{s.severity}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm">{s.type.replace(/[._]/g, ' ')}</span>
                    <span className="text-xs text-muted-foreground">
                      <When value={s.created_at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sign-ins</p>
            {d.recent.logins.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No sign-ins recorded.</p>
            ) : (
              <ul>
                {d.recent.logins.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-4 py-2">
                    {l.success ? <CircleCheck className="size-4 shrink-0 text-success" aria-label="Succeeded" /> : <CircleX className="size-4 shrink-0 text-danger" aria-label="Failed" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{l.email ?? 'unknown'}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {l.subject_type} · {l.ip ?? '—'}
                        {l.country ? ` · ${l.country}` : ''}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <When value={l.created_at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    ) : null,
    system: (
      <Card key="system" title="System health" actions={can('system.jobs.view') && <Link to="/platform/system" className="text-sm text-primary hover:underline">Details</Link>}>
        <div className="grid grid-cols-3 gap-3 text-center">
          {(['pending', 'running', 'dead'] as const).map((s) => (
            <div key={s} className="rounded-ui-sm bg-muted/50 px-2 py-2.5">
              <p className={clsx('text-lg font-semibold tabular', s === 'dead' && (d.system.jobs.dead ?? 0) > 0 && 'text-danger')}>{num(d.system.jobs[s] ?? 0)}</p>
              <p className="text-xs text-muted-foreground">{s === 'dead' ? 'failed jobs' : `${s} jobs`}</p>
            </div>
          ))}
        </div>
        {d.system.checks.length > 0 && (
          <ul className="mt-3 divide-y">
            {d.system.checks.map((c) => (
              <li key={c.name} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{c.name}</span>
                  {c.detail && <span className="block truncate text-xs text-muted-foreground">{c.detail}</span>}
                </span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    ),
    more: others.length ? (
      <Card key="more" title="Other metrics" description={`For the ${rangeName}`}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {others.map((k) => (
            <div key={k.key} className="min-w-0">
              <dt className="truncate text-xs text-muted-foreground">{k.label}</dt>
              <dd className="text-base font-semibold tabular">{fmt(k)}</dd>
            </div>
          ))}
        </dl>
      </Card>
    ) : null,
  };

  const charts = sections.filter((s) => s.startsWith('chart:')).map((s) => panels[s]).filter(Boolean);
  const rest = sections.filter((s) => !s.startsWith('chart:')).map((s) => panels[s]).filter(Boolean);

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Dashboard'}
        documentTitle="Dashboard"
        description={`Key numbers for the ${rangeName}, compared with the period before.`}
        actions={
          <>
            <RangePicker days={days} onChange={(v) => setState({ days: v })} />
            <Button variant="outline" icon={<LayoutGrid className="size-4" />} onClick={() => setCustomizing(true)}>
              Customize
            </Button>
          </>
        }
      />

      {d.scoped && (
        <div className="mb-4">
          <Callout title="Platform-wide metrics are hidden">Your access is limited to specific organizations, so totals across all customers are not shown. Use Customers, Revenue and Support for your organizations' records.</Callout>
        </div>
      )}

      {tiles.length > 0 && (
        <div className={clsx('grid grid-cols-1 gap-3 transition-opacity min-[420px]:grid-cols-2 lg:grid-cols-4', fetching && 'opacity-60')}>
          {tiles.map((k) => (
            <KpiTile key={k.key} label={k.label} value={k.value} previous={k.previous} display={fmt(k)} upIsGood={!DOWN_IS_GOOD.has(k.key)} trend={trends[k.key]} />
          ))}
        </div>
      )}

      {charts.length > 0 && <div className={clsx('mt-4 grid gap-4', charts.length > 1 && 'xl:grid-cols-2')}>{charts}</div>}
      {rest.length > 0 && <div className="mt-4 grid gap-4 xl:grid-cols-2">{rest}</div>}
      {shown.size === 0 && tiles.length === 0 && <EmptyState title="Your dashboard is empty" description="Use Customize to add metrics and panels." />}

      <CustomizeDialog open={customizing} onOpenChange={setCustomizing} layout={layout} kpis={d.kpis} onSave={(w) => saveLayout.mutate(w)} saving={saveLayout.isPending} />
    </>
  );
}
