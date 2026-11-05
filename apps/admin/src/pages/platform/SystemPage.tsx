import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleCheck, Play, RefreshCw, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { dateTime, num } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  JsonView,
  KeyValue,
  Modal,
  PageHeader,
  PageSkeleton,
  Pagination,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
  Toolbar,
  When,
  type Column,
} from '../../components/ui';
import { intervalLabel } from './shared';

interface Health {
  version: string;
  environment: string;
  database: { dialect: string; latencyMs: number };
  queue: Record<string, number>;
  deadJobs24h: number;
  oldestDueJobAt: string | null;
  pendingEvents: number;
  workerId: string;
  checks: { name: string; status: string; detail?: string }[];
}

interface Job {
  id: string;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ScheduledTask {
  key: string;
  job_type: string;
  interval_seconds: number;
  description: string;
  module: string | null;
  payload: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
}

const JOB_STATUS: Record<string, string> = { pending: 'queued', running: 'running', completed: 'completed', failed: 'failed', dead: 'dead' };

function HealthTab() {
  const { can } = useAuth();
  const health = useQuery({ queryKey: ['system-health'], queryFn: () => api.get<Health>('/api/admin/system/health'), refetchInterval: 30_000 });
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAtSeq?: number; reason?: string } | null>(null);
  const runVerify = useAction(() => api.get<{ ok: boolean; checked: number; brokenAtSeq?: number; reason?: string }>('/api/admin/audit-logs/verify'), { onSuccess: setVerify });

  if (health.isLoading) return <PageSkeleton />;
  if (health.error || !health.data) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  const h = health.data;
  const problems = h.checks.filter((c) => c.status === 'down' || c.status === 'degraded');

  return (
    <div className="space-y-4">
      {problems.length > 0 ? (
        <Callout tone={problems.some((p) => p.status === 'down') ? 'danger' : 'warning'} title={`${problems.length} check${problems.length === 1 ? '' : 's'} need attention`}>
          {problems.map((p) => p.name).join(', ')}
        </Callout>
      ) : (
        <Callout tone="success" title="All systems operational">
          Checked <When value={new Date(health.dataUpdatedAt)} />.
        </Callout>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <Stat label="Database" value={`${h.database.latencyMs} ms`} hint={h.database.dialect} />
        </Card>
        <Card>
          <Stat label="Queued jobs" value={num(h.queue.pending ?? 0)} hint={h.oldestDueJobAt ? <>oldest due <When value={h.oldestDueJobAt} /></> : 'no backlog'} />
        </Card>
        <Card>
          <Stat label="Failed jobs (24h)" value={<span className={h.deadJobs24h ? 'text-danger' : undefined}>{num(h.deadJobs24h)}</span>} hint={`${num(h.queue.dead ?? 0)} dead in total`} />
        </Card>
        <Card>
          <Stat label="Undispatched events" value={num(h.pendingEvents)} hint="transactional outbox" />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Health checks"
          className="lg:col-span-2"
          padded={false}
          actions={
            <Button variant="ghost" size="sm" icon={<RefreshCw className="size-3.5" />} loading={health.isFetching} onClick={() => void health.refetch()}>
              Refresh
            </Button>
          }
        >
          <ul className="divide-y">
            {h.checks.map((c) => (
              <li key={c.name} className="flex items-center gap-3 px-4 py-2.5">
                {c.status === 'ok' ? <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" /> : <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{c.name}</span>
                  {c.detail && <span className="block text-xs text-muted-foreground">{c.detail}</span>}
                </span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-4">
          <Card title="Runtime">
            <KeyValue
              columns={1}
              items={[
                { label: 'Version', value: h.version },
                { label: 'Environment', value: <Badge tone={h.environment === 'production' ? 'success' : 'warning'}>{h.environment}</Badge> },
                { label: 'Worker', value: <span className="break-all font-mono text-xs">{h.workerId}</span> },
                { label: 'Queue', value: Object.entries(h.queue).map(([k, v]) => `${num(v)} ${k}`).join(' · ') || 'empty' },
              ]}
            />
          </Card>
          {can('security.audit.view') && (
            <Card title="Audit log integrity" description="Recomputes the hash chain to detect edited or removed entries.">
              {verify && (
                <div className="mb-3">
                  {verify.ok ? (
                    <Callout tone="success" title="Chain intact">
                      {num(verify.checked)} entries verified.
                    </Callout>
                  ) : (
                    <Callout tone="danger" title="Tampering detected">
                      Entry #{verify.brokenAtSeq}: {verify.reason}
                    </Callout>
                  )}
                </div>
              )}
              <Button variant="outline" size="sm" icon={<ShieldCheck className="size-4" />} loading={runVerify.isPending} onClick={() => runVerify.mutate()}>
                Verify now
              </Button>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function JobsTab() {
  const { can } = useAuth();
  const [state, setState] = useUrlState({ tab: 'jobs', status: '', type: '', page: 1, pageSize: 25 });
  const [type, setType] = useState(String(state.type ?? ''));
  const debounced = useDebounced(type, 300);
  const [open, setOpen] = useState<Job | null>(null);
  useEffect(() => {
    if (debounced !== (state.type ?? '')) setState({ type: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = { status: state.status || undefined, type: state.type || undefined, page: state.page, pageSize: state.pageSize };
  const jobs = useQuery({
    queryKey: ['jobs', query],
    queryFn: ({ signal }) => api.get<Page<Job>>('/api/admin/jobs', query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const retry = useAction((id: string) => api.post(`/api/admin/jobs/${id}/retry`), { success: 'Job queued for another attempt', invalidate: [['jobs'], ['system-health']], onSuccess: () => setOpen(null) });

  const columns: Column<Job>[] = [
    { key: 'type', header: 'Job', cell: (j) => <span className="font-mono text-xs">{j.type}</span> },
    { key: 'status', header: 'Status', cell: (j) => <StatusBadge status={j.status === 'pending' ? 'queued' : j.status} /> },
    { key: 'attempts', header: 'Attempts', align: 'right', cell: (j) => <span className="tabular">{j.attempts}/{j.max_attempts}</span> },
    { key: 'error', header: 'Last error', priority: 'low', cell: (j) => (j.last_error ? <span className="block max-w-xs truncate text-danger">{j.last_error}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'run_at', header: 'Run at', cell: (j) => <When value={j.run_at} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (j) => (
        <span className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setOpen(j)}>
            Details
          </Button>
          {(j.status === 'dead' || j.status === 'failed') && can('system.jobs.manage') && (
            <Button variant="outline" size="sm" icon={<RotateCcw className="size-3.5" />} loading={retry.isPending && retry.variables === j.id} onClick={() => retry.mutate(j.id)}>
              Retry
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={type} onChange={setType} placeholder="Job type, e.g. billing.dunning" className="w-full sm:w-72" />
        <Select
          aria-label="Status"
          className="w-auto"
          value={String(state.status)}
          onChange={(e) => setState({ status: e.target.value })}
          placeholder="Any status"
          options={Object.entries(JOB_STATUS).map(([value, label]) => ({ value, label }))}
        />
      </Toolbar>
      {jobs.error ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : (
        <DataTable
          caption="Background jobs"
          columns={columns}
          rows={jobs.data?.data}
          rowKey={(j) => j.id}
          loading={jobs.isLoading}
          fetching={jobs.isFetching && !jobs.isLoading}
          empty={<EmptyState title="No jobs match" description="Jobs appear here as the worker processes them; completed jobs are cleaned up after the retention period." />}
        />
      )}
      {jobs.data && <Pagination page={jobs.data.page} pageSize={jobs.data.pageSize} total={jobs.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      <Modal
        open={Boolean(open)}
        onOpenChange={(o) => !o && setOpen(null)}
        title={open?.type ?? 'Job'}
        size="lg"
        footer={
          open && (open.status === 'dead' || open.status === 'failed') && can('system.jobs.manage') ? (
            <Button icon={<RotateCcw className="size-4" />} loading={retry.isPending} onClick={() => retry.mutate(open.id)}>
              Retry job
            </Button>
          ) : undefined
        }
      >
        {open && (
          <div className="space-y-4">
            <KeyValue
              items={[
                { label: 'Status', value: <StatusBadge status={open.status === 'pending' ? 'queued' : open.status} /> },
                { label: 'Attempts', value: `${open.attempts} of ${open.max_attempts}` },
                { label: 'Queue', value: open.queue },
                { label: 'Job ID', value: <span className="break-all font-mono text-xs">{open.id}</span> },
                { label: 'Created', value: dateTime(open.created_at) },
                { label: 'Run at', value: dateTime(open.run_at) },
                { label: 'Completed', value: open.completed_at ? dateTime(open.completed_at) : null },
              ]}
            />
            {open.last_error && (
              <Field label="Last error">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-ui-sm border border-danger/30 bg-danger/5 p-3 font-mono text-xs text-danger">{open.last_error}</pre>
              </Field>
            )}
            <Field label="Payload">
              <JsonView value={open.payload} />
            </Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}

const UNITS = [
  { value: '60', label: 'minutes' },
  { value: '3600', label: 'hours' },
  { value: '86400', label: 'days' },
];

function IntervalDialog({ task, onClose }: { task: ScheduledTask; onClose: () => void }) {
  const unit = task.interval_seconds % 86_400 === 0 ? 86_400 : task.interval_seconds % 3_600 === 0 ? 3_600 : 60;
  const [amount, setAmount] = useState(String(Math.max(1, Math.round(task.interval_seconds / unit))));
  const [mult, setMult] = useState(String(unit));
  const [error, setError] = useState<string | null>(null);
  const seconds = Math.round(Number(amount) * Number(mult));
  const save = useAction(() => api.patch(`/api/admin/scheduled-tasks/${task.key}`, { intervalSeconds: seconds }), {
    success: 'Schedule updated',
    invalidate: [['scheduled-tasks']],
    onSuccess: onClose,
    onError: () => setError('The interval must be between 10 seconds and 30 days'),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Change interval"
      description={task.description || task.key}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!(seconds >= 10 && seconds <= 30 * 86_400)} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <FormError message={error} />
      <div className="flex items-end gap-2">
        <Field label="Run every" htmlFor="interval-amount" className="flex-1">
          <Input id="interval-amount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Select aria-label="Unit" className="w-32" value={mult} onChange={(e) => setMult(e.target.value)} options={UNITS} />
      </div>
    </Modal>
  );
}

function ScheduledTab() {
  const { can } = useAuth();
  const tasks = useQuery({ queryKey: ['scheduled-tasks'], queryFn: () => api.get<{ data: ScheduledTask[] }>('/api/admin/scheduled-tasks'), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const manage = can('system.jobs.manage');
  const setEnabled = useAction((v: { key: string; enabled: boolean }) => api.patch(`/api/admin/scheduled-tasks/${v.key}`, { enabled: v.enabled }), {
    success: (_r, v) => (v.enabled ? 'Task enabled' : 'Task paused'),
    invalidate: [['scheduled-tasks']],
  });
  const run = useAction((key: string) => api.post<{ jobId: string }>(`/api/admin/scheduled-tasks/${key}/run`), { success: 'Queued to run now', invalidate: [['jobs'], ['scheduled-tasks']] });

  const columns: Column<ScheduledTask>[] = [
    {
      key: 'task',
      header: 'Task',
      cell: (t) => (
        <span className="block min-w-0">
          <span className="block">{t.description || t.key}</span>
          <span className="block font-mono text-xs text-muted-foreground">{t.key}</span>
        </span>
      ),
    },
    { key: 'module', header: 'Module', cell: (t) => (t.module ? <Badge>{t.module}</Badge> : '—') },
    {
      key: 'interval',
      header: 'Schedule',
      cell: (t) =>
        manage ? (
          <button type="button" className="text-left text-primary hover:underline" onClick={() => setEditing(t)}>
            {intervalLabel(t.interval_seconds)}
          </button>
        ) : (
          intervalLabel(t.interval_seconds)
        ),
    },
    { key: 'last', header: 'Last run', cell: (t) => <When value={t.last_run_at} /> },
    { key: 'next', header: 'Next run', priority: 'low', cell: (t) => (t.enabled ? <When value={t.next_run_at} /> : <span className="text-muted-foreground">paused</span>) },
    {
      key: 'enabled',
      header: 'Enabled',
      cell: (t) => <Switch checked={t.enabled} disabled={!manage} onCheckedChange={(v) => setEnabled.mutate({ key: t.key, enabled: v })} label={<span className="sr-only">{t.enabled ? `Pause ${t.key}` : `Enable ${t.key}`}</span>} />,
    },
    {
      key: 'run',
      header: <span className="sr-only">Run now</span>,
      align: 'right',
      cell: (t) =>
        manage ? (
          <Button variant="outline" size="sm" icon={<Play className="size-3.5" />} loading={run.isPending && run.variables === t.key} onClick={() => run.mutate(t.key)}>
            Run now
          </Button>
        ) : null,
    },
  ];

  if (tasks.error) return <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />;
  return (
    <Card padded={false}>
      <DataTable caption="Scheduled tasks" columns={columns} rows={tasks.data?.data} rowKey={(t) => t.key} loading={tasks.isLoading} empty={<EmptyState title="No scheduled tasks" />} />
      {editing && <IntervalDialog task={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

export default function SystemPage() {
  const [state, setState] = useUrlState({ tab: 'health' });
  const tab = String(state.tab || 'health');
  return (
    <>
      <PageHeader title="Jobs & health" description="System health, the background job queue and scheduled maintenance tasks." />
      <Tabs
        value={tab}
        onValueChange={(v) => setState({ tab: v, status: undefined, type: undefined, page: undefined })}
        tabs={[
          { value: 'health', label: 'Health', content: tab === 'health' && <HealthTab /> },
          { value: 'jobs', label: 'Background jobs', content: tab === 'jobs' && <JobsTab /> },
          { value: 'scheduled', label: 'Scheduled tasks', content: tab === 'scheduled' && <ScheduledTab /> },
        ]}
      />
    </>
  );
}
