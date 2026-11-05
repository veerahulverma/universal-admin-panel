import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarClock, ChartLine, Download, MoreHorizontal, Pencil, Play, Save, Send, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { date, dateTime, money, num, pct } from '../../lib/format';
import { useBootstrap } from '../../components/layout/AppShell';
import {
  Badge,
  Button,
  Callout,
  Card,
  ChartCard,
  Checkbox,
  ColumnChart,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  LineChart,
  Menu,
  Modal,
  PageHeader,
  PageSkeleton,
  Select,
  Tabs,
  Textarea,
  When,
  useConfirm,
  useToast,
  type Column,
  type Point,
} from '../../components/ui';
import { CategoryBars, RangePresets } from './viz';

type Format = 'number' | 'money' | 'percent' | 'date' | 'text';

interface ReportInfo {
  key: string;
  name: string;
  description: string;
  module: string;
  category: string;
}

interface ReportResult {
  key: string;
  name: string;
  range: { from: string; to: string };
  columns: { key: string; label: string; format?: Format }[];
  rows: Record<string, unknown>[];
  chart?: { type: 'line' | 'bar'; x: string; series: string[] };
  currency?: string;
  notes?: string;
}

interface SavedReport {
  id: string;
  name: string;
  report_key: string;
  params: Record<string, string | number>;
  shared: boolean;
  schedule: 'none' | 'daily' | 'weekly' | 'monthly';
  recipients: string[];
  last_sent_at: string | null;
  next_send_at: string | null;
  created_at: string;
}

const CATEGORIES: { id: string; label: string }[] = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'customers', label: 'Customers' },
  { id: 'growth', label: 'Growth' },
  { id: 'usage', label: 'Usage' },
  { id: 'developers', label: 'Developers' },
  { id: 'support', label: 'Support' },
];

const SCHEDULES = [
  { value: 'none', label: 'Not scheduled' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Day-aligned (UTC) range so the query key stays stable through the day:
 * presets end at the start of tomorrow; custom ranges include their last day.
 */
function resolveRange(days: number, from: string, to: string): { from: string; to: string; custom: boolean } {
  if (from && to) return { from, to: isoDay(Date.parse(`${to}T00:00:00Z`) + DAY), custom: true };
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY;
  return { from: isoDay(end - days * DAY), to: isoDay(end), custom: false };
}

function formatter(format: Format | undefined, currency: string): (v: number) => string {
  switch (format) {
    case 'money':
      return (v) => money(v, currency);
    case 'percent':
      return (v) => pct(v);
    default:
      return (v) => num(v, { digits: 2 });
  }
}

function tickFormatter(format: Format | undefined, currency: string): (v: number) => string {
  switch (format) {
    case 'money':
      return (v) => money(v, currency, { compact: true, whole: true });
    case 'percent':
      return (v) => pct(v, 0);
    default:
      return (v) => num(v, { compact: true });
  }
}

function formatCell(value: unknown, format: Format | undefined, currency: string): React.ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>;
  if (format === 'date') return date(String(value));
  if (typeof value === 'number' || (format && format !== 'text' && !Number.isNaN(Number(value)))) {
    const n = Number(value);
    return <span className="tabular">{format === 'money' ? money(n, currency) : format === 'percent' ? pct(n) : num(n, { digits: 2 })}</span>;
  }
  return String(value);
}

// ---- Save / edit dialog ---------------------------------------------------------------------

function SavedReportDialog({ saved, report, params, onClose }: { saved?: SavedReport; report?: ReportInfo; params?: Record<string, string | number>; onClose: () => void }) {
  const editing = Boolean(saved);
  const [name, setName] = useState(saved?.name ?? report?.name ?? '');
  const [schedule, setSchedule] = useState<SavedReport['schedule']>(saved?.schedule ?? 'none');
  const [recipients, setRecipients] = useState((saved?.recipients ?? []).join('\n'));
  const [shared, setShared] = useState(saved?.shared ?? false);
  const [error, setError] = useState<string | null>(null);
  const list = recipients.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
  const save = useAction(
    () =>
      editing
        ? api.patch(`/api/admin/saved-reports/${saved!.id}`, { name, schedule, recipients: list, shared })
        : api.post('/api/admin/saved-reports', { name, reportKey: report!.key, params: params ?? {}, schedule, recipients: list, shared }),
    {
      success: editing ? 'Saved report updated' : schedule === 'none' ? 'Report saved' : 'Report saved and scheduled',
      invalidate: [['saved-reports']],
      onSuccess: onClose,
      onError: (err) => setError(errorMessage(err)),
    },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={editing ? `Edit ${saved!.name}` : `Save ${report?.name ?? 'report'}`}
      description="Saved reports keep their grouping and filters. Scheduled reports are emailed as a CSV download link that expires after 7 days."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="saved-report-form" loading={save.isPending}>
            {editing ? 'Save changes' : 'Save report'}
          </Button>
        </>
      }
    >
      <form
        id="saved-report-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Name" htmlFor="sr-name">
          <Input id="sr-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Email schedule" htmlFor="sr-schedule" hint="Daily, weekly and monthly emails cover the last 1, 7 or 31 days.">
          <Select id="sr-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value as SavedReport['schedule'])} options={SCHEDULES} />
        </Field>
        <Field label="Recipients" htmlFor="sr-recipients" hint={schedule === 'none' ? 'Optional; needed to send the report by email' : 'One email address per line'}>
          <Textarea id="sr-recipients" rows={3} value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="finance@example.com" />
        </Field>
        <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} label="Share with other administrators" description="Shared reports appear in everyone's saved list." />
      </form>
    </Modal>
  );
}

// ---- Report runner -------------------------------------------------------------------------------

function ReportCharts({ result, currency, fetching }: { result: ReportResult; currency: string; fetching: boolean }) {
  const chart = result.chart;
  if (!chart || !result.rows.length) return null;
  const xCol = result.columns.find((c) => c.key === chart.x);
  const byDate = xCol?.format === 'date';
  const panels = chart.series.map((s) => {
    const col = result.columns.find((c) => c.key === s);
    const fmt = formatter(col?.format, currency);
    const label = col?.label ?? s;
    if (byDate) {
      const points: Point[] = result.rows.map((r) => ({ date: String(r[chart.x]).slice(0, 10), value: Number(r[s] ?? 0) }));
      return (
        <ChartCard key={s} title={label} description={result.name} data={points} format={fmt} fetching={fetching}>
          {chart.type === 'bar' ? <ColumnChart data={points} format={fmt} tickFormat={tickFormatter(col?.format, currency)} label={label} /> : <LineChart data={points} format={fmt} tickFormat={tickFormatter(col?.format, currency)} label={label} />}
        </ChartCard>
      );
    }
    return (
      <section key={s} className={clsx('rounded-ui border bg-surface shadow-ui transition-opacity', fetching && 'opacity-60')}>
        <header className="px-4 pt-3.5">
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="text-xs text-muted-foreground">By {xCol?.label.toLowerCase() ?? chart.x}</p>
        </header>
        <div className="p-3">
          <CategoryBars rows={result.rows.map((r) => ({ label: String(r[chart.x] ?? '—'), value: Number(r[s] ?? 0) }))} format={fmt} label={`${label} by ${xCol?.label ?? chart.x}`} />
        </div>
      </section>
    );
  });
  // Several series are shown as small multiples, one chart each (never a shared or dual axis).
  return <div className={clsx('grid gap-4', panels.length > 1 && 'xl:grid-cols-2')}>{panels}</div>;
}

function ReportRunner({ report, state, setState, base }: { report: ReportInfo; state: Record<string, string | number | undefined>; setState: (p: Record<string, string | number | undefined>) => void; base: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const meters = useQuery({ queryKey: ['meters', false], queryFn: () => api.get<{ data: { key: string; name: string }[] }>('/api/admin/meters'), enabled: report.key === 'usage' && can('catalog.products.view'), staleTime: 60_000 });
  const [customOpen, setCustomOpen] = useState(Boolean(state.from && state.to));
  const [saving, setSaving] = useState(false);
  const days = Number(state.days) || 30;
  const range = resolveRange(days, String(state.from ?? ''), String(state.to ?? ''));
  const params = {
    from: range.from,
    to: range.to,
    groupBy: String(state.groupBy || 'day'),
    meter: report.key === 'usage' ? String(state.meter || '') || undefined : undefined,
    limit: report.key === 'top_customers' ? Number(state.limit) || 100 : undefined,
  };
  const result = useQuery({
    queryKey: ['report', report.key, params],
    queryFn: ({ signal }) => api.get<ReportResult>(`/api/admin/reports/${report.key}`, params, signal),
    placeholderData: keepPreviousData,
  });
  const r = result.data && result.data.key === report.key ? result.data : undefined;
  const currency = r?.currency ?? base;
  const fetching = result.isFetching && !result.isLoading;
  const hasPeriod = !r || r.columns.some((c) => c.key === 'period');
  const savedParams = Object.fromEntries(Object.entries({ groupBy: params.groupBy, meter: params.meter, limit: params.limit, days: range.custom ? undefined : days }).filter(([, v]) => v !== undefined)) as Record<string, string | number>;

  const rows = useMemo(() => (r?.rows ?? []).map((row, i) => ({ ...row, __key: i })), [r]);
  const columns: Column<Record<string, unknown>>[] = (r?.columns ?? []).map((c, i) => ({
    key: c.key,
    header: c.label,
    align: c.format === 'money' || c.format === 'number' || c.format === 'percent' ? 'right' : undefined,
    priority: i === 0 ? 'primary' : undefined,
    cell: (row) => {
      const content = formatCell(row[c.key], c.format ?? (typeof row[c.key] === 'number' ? (row.format as Format | undefined) : undefined), currency);
      // Rows about a user (top customers) link to the customer profile.
      return i === 0 && typeof row.id === 'string' && row.id.startsWith('usr_') ? (
        <Link to={`/customers/users/${row.id}`} className="text-primary hover:underline">
          {content}
        </Link>
      ) : (
        content
      );
    },
  }));

  return (
    <div className="space-y-4">
      <Card
        title={report.name}
        description={report.description}
        actions={
          <>
            {can('reports.reports.export') && (
              <Button
                variant="outline"
                size="sm"
                icon={<Download className="size-4" />}
                onClick={() => download(`/api/admin/reports/${report.key}/export.csv`, params, `${report.key}.csv`).catch((err) => toast.error('Export failed', errorMessage(err)))}
              >
                CSV
              </Button>
            )}
            {can('reports.schedules.manage') && (
              <Button variant="outline" size="sm" icon={<Save className="size-4" />} onClick={() => setSaving(true)}>
                Save
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-end gap-2">
          <RangePresets
            days={days}
            custom={customOpen}
            onChange={(v) => {
              setCustomOpen(false);
              setState({ days: v, from: undefined, to: undefined });
            }}
            onCustom={() => setCustomOpen(true)}
          />
          {customOpen && (
            <>
              <Input aria-label="From" type="date" className="w-auto" value={String(state.from ?? '')} max={String(state.to || '') || undefined} onChange={(e) => setState({ from: e.target.value })} />
              <span className="pb-2 text-sm text-muted-foreground">to</span>
              <Input aria-label="To" type="date" className="w-auto" value={String(state.to ?? '')} min={String(state.from || '') || undefined} onChange={(e) => setState({ to: e.target.value })} />
            </>
          )}
          {hasPeriod && (
            <Select aria-label="Group by" className="w-auto" value={params.groupBy} onChange={(e) => setState({ groupBy: e.target.value })} options={[{ value: 'day', label: 'By day' }, { value: 'week', label: 'By week' }, { value: 'month', label: 'By month' }]} />
          )}
          {report.key === 'usage' && meters.data && (
            <Select aria-label="Meter" className="w-auto" value={String(state.meter ?? '')} onChange={(e) => setState({ meter: e.target.value })} placeholder="All meters" options={meters.data.data.map((m) => ({ value: m.key, label: m.name }))} />
          )}
          {report.key === 'top_customers' && (
            <Select aria-label="Number of customers" className="w-auto" value={String(params.limit)} onChange={(e) => setState({ limit: Number(e.target.value) })} options={['10', '25', '50', '100', '500'].map((n) => ({ value: n, label: `Top ${n}` }))} />
          )}
          {r && (
            <span className="ml-auto pb-1.5 text-xs text-muted-foreground">
              {date(r.range.from)} – {date(new Date(new Date(r.range.to).getTime() - 1))}
            </span>
          )}
        </div>
        {customOpen && !(state.from && state.to) && <p className="mt-2 text-xs text-muted-foreground">Pick both dates to run the report for a custom range.</p>}
      </Card>

      {result.isLoading ? (
        <PageSkeleton />
      ) : result.error ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : r ? (
        <>
          <ReportCharts result={r} currency={currency} fetching={fetching} />
          {r.notes && <Callout>{r.notes}</Callout>}
          <Card padded={false} title={`${num(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}`}>
            <DataTable caption={r.name} columns={columns} rows={rows} rowKey={(row) => String(row.__key)} fetching={fetching} empty={<EmptyState icon={<ChartLine />} title="No data in this range" description="Try a longer date range." />} />
          </Card>
        </>
      ) : null}

      {saving && <SavedReportDialog report={report} params={savedParams} onClose={() => setSaving(false)} />}
    </div>
  );
}

// ---- Saved reports ---------------------------------------------------------------------------------

function SavedReportsTab({ catalog, onOpen }: { catalog: ReportInfo[]; onOpen: (s: SavedReport) => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<SavedReport | null>(null);
  const saved = useQuery({ queryKey: ['saved-reports'], queryFn: () => api.get<{ data: SavedReport[] }>('/api/admin/saved-reports') });
  const manage = can('reports.schedules.manage');
  const sendNow = useAction((s: SavedReport) => api.post<{ recipients: number }>(`/api/admin/saved-reports/${s.id}/send-now`), {
    success: (res) => `Sent to ${res.recipients} recipient${res.recipients === 1 ? '' : 's'}`,
    invalidate: [['saved-reports']],
  });
  const remove = useAction((id: string) => api.delete(`/api/admin/saved-reports/${id}`), { success: 'Saved report deleted', invalidate: [['saved-reports']] });
  const reportName = (key: string) => catalog.find((c) => c.key === key)?.name ?? key;

  if (saved.error) return <ErrorState error={saved.error} onRetry={() => void saved.refetch()} />;
  return (
    <Card padded={false}>
      <DataTable
        caption="Saved reports"
        rows={saved.data?.data}
        loading={saved.isLoading}
        rowKey={(s) => s.id}
        empty={<EmptyState icon={<CalendarClock />} title="No saved reports" description="Run a report, then use Save to keep its settings or email it on a schedule." />}
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (s) => (
              <button type="button" className="min-w-0 text-left" onClick={() => onOpen(s)}>
                <span className="block truncate font-medium text-primary hover:underline">{s.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{reportName(s.report_key)}</span>
              </button>
            ),
          },
          { key: 'schedule', header: 'Schedule', cell: (s) => (s.schedule === 'none' ? <span className="text-muted-foreground">—</span> : <Badge tone="info">{s.schedule}</Badge>) },
          { key: 'recipients', header: 'Recipients', cell: (s) => (s.recipients.length ? <span className="block max-w-56 truncate text-xs" title={s.recipients.join(', ')}>{s.recipients.join(', ')}</span> : <span className="text-muted-foreground">—</span>) },
          { key: 'last', header: 'Last sent', priority: 'low', cell: (s) => <When value={s.last_sent_at} /> },
          { key: 'next', header: 'Next send', cell: (s) => (s.next_send_at && s.schedule !== 'none' ? dateTime(s.next_send_at) : <span className="text-muted-foreground">—</span>) },
          { key: 'shared', header: 'Shared', priority: 'low', cell: (s) => (s.shared ? 'Yes' : 'No') },
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right',
            cell: (s) => (
              <Menu
                trigger={
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
                items={[
                  { label: 'Open', icon: <Play className="size-4" />, onSelect: () => onOpen(s) },
                  { label: 'Edit', icon: <Pencil className="size-4" />, hidden: !manage, onSelect: () => setEditing(s) },
                  {
                    label: 'Send now',
                    icon: <Send className="size-4" />,
                    hidden: !manage,
                    disabled: !s.recipients.length,
                    onSelect: async () => {
                      const r = await confirm({ title: `Email ${s.name} now?`, description: `Sends a CSV link to ${s.recipients.length} recipient${s.recipients.length === 1 ? '' : 's'}.`, confirmLabel: 'Send' });
                      if (r.confirmed) sendNow.mutate(s);
                    },
                  },
                  { separator: true, label: '', hidden: !manage },
                  {
                    label: 'Delete',
                    icon: <Trash2 className="size-4" />,
                    danger: true,
                    hidden: !manage,
                    onSelect: async () => {
                      const r = await confirm({ title: `Delete ${s.name}?`, description: s.schedule !== 'none' ? 'Scheduled emails stop.' : undefined, confirmLabel: 'Delete', tone: 'danger' });
                      if (r.confirmed) remove.mutate(s.id);
                    },
                  },
                ]}
              />
            ),
          },
        ]}
      />
      {editing && <SavedReportDialog saved={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ---- Page ---------------------------------------------------------------------------------------------

const DEFAULTS = { tab: 'run', report: '', days: 30, from: '', to: '', groupBy: 'day', meter: '', limit: 100 };

export default function ReportsPage() {
  const boot = useBootstrap();
  const base = boot.data?.locale.currency ?? 'USD';
  const [state, setState] = useUrlState(DEFAULTS);
  const catalog = useQuery({ queryKey: ['reports-catalog'], queryFn: () => api.get<{ data: ReportInfo[] }>('/api/admin/reports'), staleTime: 5 * 60_000 });
  const reports = catalog.data?.data ?? [];
  const selected = reports.find((r) => r.key === state.report) ?? reports[0];
  const groups = CATEGORIES.map((c) => ({ ...c, items: reports.filter((r) => r.category === c.id) })).filter((g) => g.items.length);

  const pick = (key: string) => setState({ report: key, meter: undefined, limit: undefined });
  const openSaved = (s: SavedReport) =>
    setState({
      tab: 'run',
      report: s.report_key,
      groupBy: s.params.groupBy ? String(s.params.groupBy) : undefined,
      meter: s.params.meter ? String(s.params.meter) : undefined,
      limit: s.params.limit ? Number(s.params.limit) : undefined,
      days: s.params.days ? Number(s.params.days) : undefined,
      from: undefined,
      to: undefined,
    });

  if (catalog.isLoading) return <PageSkeleton />;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />;

  const runner = selected ? (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Reports" className="hidden lg:block">
        <Card padded={false}>
          {groups.map((g) => (
            <div key={g.id} className="border-b px-2 py-2 last:border-0">
              <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</p>
              <ul className="space-y-0.5">
                {g.items.map((r) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      onClick={() => pick(r.key)}
                      aria-current={r.key === selected.key ? 'page' : undefined}
                      className={clsx('w-full rounded-ui-sm px-2 py-1.5 text-left text-md transition-colors', r.key === selected.key ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      </nav>
      <div className="min-w-0 space-y-4">
        <div className="lg:hidden">
          <Select aria-label="Report" value={selected.key} onChange={(e) => pick(e.target.value)} options={reports.map((r) => ({ value: r.key, label: r.name }))} />
        </div>
        <ReportRunner key={selected.key} report={selected} state={state} setState={setState} base={base} />
      </div>
    </div>
  ) : (
    <EmptyState icon={<ChartLine />} title="No reports available" description="Reports come from enabled modules (billing, usage, developers…)." />
  );

  return (
    <>
      <PageHeader title="Reports" description="Revenue, growth, retention and usage reports with CSV export. Save the ones you use and email them on a schedule." />
      <Tabs
        value={String(state.tab)}
        onValueChange={(tab) => setState({ tab })}
        tabs={[
          { value: 'run', label: 'Reports', content: runner },
          { value: 'saved', label: 'Saved & scheduled', content: <SavedReportsTab catalog={reports} onOpen={openSaved} /> },
        ]}
      />
    </>
  );
}
