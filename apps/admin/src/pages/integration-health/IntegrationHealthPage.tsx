import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, CircleMinus, OctagonX, RefreshCw, Settings2, TriangleAlert, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { num, pct, titleCase } from '../../lib/format';
import { Badge, Button, ButtonLink, Callout, Card, ErrorState, PageHeader, PageSkeleton, Stat, Switch, When, type Tone } from '../../components/ui';

type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown' | 'disabled';
type Kind = 'gateway' | 'email' | 'webhook' | 'plugin' | 'api_key' | 'jobs';

interface Check {
  key: string;
  kind: Kind;
  name: string;
  status: HealthStatus;
  summary: string;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  metrics: Record<string, any>;
  link: string;
  since: string | null;
}

interface Group {
  kind: Kind;
  label: string;
  note: string | null;
  checks: Check[];
}

interface Report {
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  lastRunAt: string | null;
  scoped: boolean;
  counts: Record<HealthStatus, number>;
  groups: Group[];
}

interface RunResult extends Report {
  changes: { key: string; change: 'unhealthy' | 'recovered'; status: HealthStatus }[];
}

const STATUS: Record<HealthStatus, { label: string; tone: Tone; icon: LucideIcon; color: string }> = {
  ok: { label: 'Healthy', tone: 'success', icon: CircleCheck, color: 'text-success' },
  degraded: { label: 'Needs attention', tone: 'warning', icon: TriangleAlert, color: 'text-warning' },
  down: { label: 'Down', tone: 'danger', icon: OctagonX, color: 'text-danger' },
  unknown: { label: 'No data yet', tone: 'neutral', icon: CircleDashed, color: 'text-muted-foreground' },
  disabled: { label: 'Off', tone: 'neutral', icon: CircleMinus, color: 'text-muted-foreground' },
};

const GROUP_HELP: Record<Kind, string> = {
  gateway: 'Connection tests, webhooks received from each gateway and refunds sent to it.',
  email: 'Each provider’s latest sends and bounce rate, and the delivery queue.',
  webhook: 'Recent deliveries and retries per endpoint, and the delivery queue.',
  plugin: 'Crashed plugins, failing calls and plugins that are switched off.',
  api_key: 'Requests rejected in the last 24 hours, and revoked or expiring keys still in use.',
  jobs: 'Background jobs that failed for good, are stuck or are waiting too long.',
};

const unhealthy = (s: HealthStatus) => s === 'degraded' || s === 'down';

const when = (label: string, value: string | null | undefined, relative = true) =>
  value ? (
    <>
      {label} <When value={value} relative={relative} />
    </>
  ) : null;

/** The few numbers that explain a check, per kind of integration. */
function facts(c: Check): ReactNode[] {
  const m = c.metrics;
  switch (c.kind) {
    case 'gateway':
      return [
        `${titleCase(m.adapter)} · ${m.mode}`,
        when('Last webhook', m.lastWebhookAt) ?? 'No webhooks received yet',
        when('Last payment', m.lastPaymentAt),
        m.failedPayments24h ? `${num(m.failedPayments24h)} declined payments in 24h` : null,
      ];
    case 'email':
      if (c.key === 'email:queue') {
        return [`${num(m.queued)} queued`, m.retrying ? `${num(m.retrying)} retrying` : null, `${num(m.failed24h)} failed in 24h`, m.waitingOverHour ? `${num(m.waitingOverHour)} waiting over an hour` : null];
      }
      return [
        String(m.type).toUpperCase(),
        when('Last sent', m.lastSentAt) ?? 'Nothing sent in 7 days',
        m.sent7d ? `Bounce rate ${pct(m.bounceRate)} of ${num(m.sent7d)} sent in 7 days` : null,
        m.complained7d ? `${num(m.complained7d)} spam complaints in 7 days` : null,
      ];
    case 'webhook':
      if (c.key.startsWith('webhooks:queue')) {
        return [`${num(m.pending)} pending`, `${num(m.retrying)} retrying`, m.overdue ? `${num(m.overdue)} overdue` : null, when('Next attempt', m.nextAttemptAt)];
      }
      return [`${num(m.delivered24h)} delivered in 24h`, m.failed24h ? `${num(m.failed24h)} failed` : null, m.retrying ? `${num(m.retrying)} retrying` : null, when('Last success', c.lastSuccessAt)];
    case 'plugin':
      return [`v${m.version}`, titleCase(m.state), m.errorLogs24h ? `${num(m.errorLogs24h)} errors logged in 24h` : null];
    case 'api_key':
      if (c.key === 'api_keys:unknown') return [`${num(m.invalid24h)} with an unknown key`, `${num(m.missing24h)} without a key`];
      return [
        <code key="prefix" className="font-mono">{m.prefix}…</code>,
        m.mode,
        `${num(m.requests24h)} requests in 24h`,
        m.rejected24h
          ? `${num(m.rejected24h)} rejected (${Object.entries(m.rejectedBy as Record<string, number>)
              .map(([code, n]) => `${code.replace(/_/g, ' ')} ${n}`)
              .join(', ')})`
          : null,
        when('Expires', m.expiresAt, false),
      ];
    case 'jobs':
      return [
        `${num(m.pending)} queued`,
        `${num(m.running)} running`,
        `${num(m.dead24h)} failed in 24h`,
        m.stuck ? `${num(m.stuck)} stuck` : null,
        m.overdue ? `${num(m.overdue)} overdue` : null,
        Object.keys(m.deadByType ?? {}).length
          ? `Failing: ${Object.entries(m.deadByType as Record<string, number>)
              .map(([type, n]) => `${type} (${n})`)
              .join(', ')}`
          : null,
      ];
    default:
      return [];
  }
}

function CheckRow({ check }: { check: Check }) {
  const s = STATUS[check.status];
  const Icon = s.icon;
  const items = facts(check).filter(Boolean);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon className={clsx('mt-0.5 size-4 shrink-0', s.color)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={check.link} className="min-w-0 break-words text-sm font-medium hover:underline">
            {check.name}
          </Link>
          <Badge tone={s.tone}>{s.label}</Badge>
          {check.since && (
            <span className="text-xs text-muted-foreground">
              since <When value={check.since} />
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{check.summary}</p>
        {items.length > 0 && (
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {items.map((f, i) => (
              <span key={i}>{f}</span>
            ))}
          </p>
        )}
        {check.lastError && (
          <p className="break-words rounded-ui-sm bg-muted/60 px-2 py-1 font-mono text-xs">
            <span className="font-sans text-muted-foreground">Last error{check.lastErrorAt && <> <When value={check.lastErrorAt} /></>}: </span>
            {check.lastError}
          </p>
        )}
      </div>
    </li>
  );
}

function GroupCard({ group, problemsOnly }: { group: Group; problemsOnly: boolean }) {
  const issues = group.checks.filter((c) => unhealthy(c.status)).length;
  const shown = problemsOnly ? group.checks.filter((c) => unhealthy(c.status)) : group.checks;
  return (
    <Card
      title={group.label}
      description={GROUP_HELP[group.kind]}
      padded={false}
      actions={issues ? <Badge tone="warning">{issues} to fix</Badge> : group.checks.some((c) => c.status === 'ok') ? <Badge tone="success">Healthy</Badge> : null}
    >
      {shown.length ? (
        <ul className="divide-y">
          {shown.map((c) => (
            <CheckRow key={c.key} check={c} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-4 text-sm text-muted-foreground">{problemsOnly && group.checks.length ? 'No problems here.' : (group.note ?? 'Nothing to check yet.')}</p>
      )}
    </Card>
  );
}

function Summary({ report }: { report: Report }) {
  const c = report.counts;
  const issues = c.degraded + c.down;
  return (
    <div className="space-y-4">
      {report.status === 'ok' ? (
        <Callout tone="success" title="All integrations are healthy">
          Checked <When value={report.checkedAt} />.
        </Callout>
      ) : (
        <Callout tone={report.status === 'down' ? 'danger' : 'warning'} title={`${issues} integration${issues === 1 ? '' : 's'} need${issues === 1 ? 's' : ''} attention`}>
          {report.groups
            .flatMap((g) => g.checks)
            .filter((x) => unhealthy(x.status))
            .map((x) => x.name)
            .join(', ')}
        </Callout>
      )}
      {report.scoped && (
        <Callout title="Your organizations only">
          You see the webhook endpoints and API keys of your organizations. Payment gateways, email delivery, plugins and the job queue are visible to administrators without an organization scope.
        </Callout>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <Stat label="Healthy" value={num(c.ok)} />
        </Card>
        <Card>
          <Stat label="Need attention" value={<span className={c.degraded ? 'text-warning' : undefined}>{num(c.degraded)}</span>} />
        </Card>
        <Card>
          <Stat label="Down" value={<span className={c.down ? 'text-danger' : undefined}>{num(c.down)}</span>} />
        </Card>
        <Card>
          <Stat label="Off or no data" value={num(c.disabled + c.unknown)} />
        </Card>
      </div>
    </div>
  );
}

const DEFAULTS = { problems: '' };

export default function IntegrationHealthPage() {
  const { can } = useAuth();
  const client = useQueryClient();
  const [state, setState] = useUrlState(DEFAULTS);
  const problemsOnly = state.problems === '1';
  const health = useQuery({ queryKey: ['integration-health'], queryFn: () => api.get<Report>('/api/admin/integration-health'), refetchInterval: 60_000 });
  const run = useAction(() => api.post<RunResult>('/api/admin/integration-health/run'), {
    success: (r) => (r.changes.length ? `${r.changes.length} change${r.changes.length === 1 ? '' : 's'} recorded; administrators were alerted` : 'Checked: nothing changed since the last run'),
    onSuccess: (r) => client.setQueryData(['integration-health'], r),
  });

  return (
    <>
      <PageHeader
        title="Integration health"
        description="Payment gateways, email delivery, webhooks, plugins, API keys and the job queue. A monitor checks them every 5 minutes and alerts administrators when one fails or recovers."
        actions={
          <>
            {can('system.settings.view') && (
              <ButtonLink to="/platform/settings/integrationHealth" icon={<Settings2 className="size-4" />}>
                Alert settings
              </ButtonLink>
            )}
            {can('developers.health.manage') && (
              <Button icon={<RefreshCw className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>
                Check now
              </Button>
            )}
          </>
        }
      />
      {health.isLoading ? (
        <PageSkeleton />
      ) : health.error || !health.data ? (
        <ErrorState error={health.error} onRetry={() => void health.refetch()} />
      ) : (
        <div className="space-y-4">
          <Summary report={health.data} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {health.data.lastRunAt ? (
                <>
                  The monitor last ran <When value={health.data.lastRunAt} />.
                </>
              ) : (
                'The monitor has not run yet; it runs every 5 minutes.'
              )}
            </p>
            <Switch checked={problemsOnly} onCheckedChange={(v) => setState({ problems: v ? '1' : '' }, { resetPage: false })} label="Only problems" />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {health.data.groups.map((g) => (
              <GroupCard key={g.kind} group={g} problemsOnly={problemsOnly} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
