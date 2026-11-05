import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, CheckCheck, CircleCheck, CircleX, Eye, Laptop, MoreHorizontal, Plus, ShieldAlert, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { dateTime, num } from '../../lib/format';
import {
  Badge,
  Button,
  ButtonLink,
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
  Menu,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
  Tabs,
  Toolbar,
  When,
  useConfirm,
  useToast,
  type Column,
  type Tone,
} from '../../components/ui';
import { IpCaveat, describeAgent } from './shared';
import type { IpRule, LoginEvent, SecurityEvent, SecurityOverview, TeamSession } from './types';
import { AccountSharingTab } from '../user-management/AccountSharingTab';
import { SHARING_ACTIONS } from '../user-management/types';

const DEFAULTS = {
  tab: 'events',
  status: 'open',
  severity: '',
  type: '',
  subjectType: '',
  page: 1,
  who: '',
  result: '',
  ip: '',
  from: '',
  lpage: 1,
};

const EVENT_LABELS: Record<string, string> = {
  'login.new_device': 'Sign-in from a new device or network',
  'login.unusual_location': 'Sign-in from an unusual location',
  'ip.auto_blocked': 'IP blocked after repeated failed sign-ins',
  'admin.locked_out': 'Administrator locked out after failed sign-ins',
  'admin.2fa_disabled': 'Administrator turned off two-factor authentication',
  'admin.2fa_reset': "Administrator's two-factor authentication was reset",
  'admin.recovery_code_used': 'Administrator signed in with a recovery code',
  'account_sharing.suspected': 'Possible account sharing (many IP addresses)',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const SEVERITY_TONE: Record<SecurityEvent['severity'], Tone> = { critical: 'danger', warning: 'warning', info: 'neutral' };
const EVENT_STATUS_TONE: Record<SecurityEvent['status'], Tone> = { open: 'info', acknowledged: 'warning', resolved: 'success' };

function subjectHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === 'admin') return `/admin/team/${id}`;
  if (type === 'user') return `/customers/users/${id}`;
  if (type === 'api_key') return '/developers/api-keys';
  return null;
}

// ---- Overview -------------------------------------------------------------------------------

function OverviewStats() {
  const q = useQuery({ queryKey: ['security-overview'], queryFn: () => api.get<SecurityOverview>('/api/admin/security/overview'), refetchInterval: 60_000 });
  if (q.isLoading) {
    return (
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }
  if (!q.data) return null;
  const o = q.data;
  const open = (o.openEvents.critical ?? 0) + (o.openEvents.warning ?? 0) + (o.openEvents.info ?? 0);
  const tiles: { label: string; value: number | null; hint: string; alert?: boolean }[] = [
    { label: 'Open alerts', value: open, hint: [o.openEvents.critical && `${o.openEvents.critical} critical`, o.openEvents.warning && `${o.openEvents.warning} warning`, o.openEvents.info && `${o.openEvents.info} info`].filter(Boolean).join(' · ') || 'Nothing open', alert: Boolean(o.openEvents.critical) },
    { label: 'Failed sign-ins (24h)', value: o.failedLogins24h, hint: o.lockedAdmins === null ? 'Your organizations’ customers' : 'Administrators and customers' },
    { label: 'Blocked networks', value: o.blockedIps, hint: 'Active block rules' },
    { label: 'Locked administrators', value: o.lockedAdmins, hint: 'After repeated failures', alert: (o.lockedAdmins ?? 0) > 0 },
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.filter((t) => t.value !== null).map((t) => (
        <div key={t.label} className="rounded-ui border bg-surface p-4 shadow-ui">
          <p className="truncate text-sm text-muted-foreground">{t.label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular ${t.alert ? 'text-danger' : ''}`}>{num(t.value)}</p>
          <p className="truncate text-xs text-muted-foreground">{t.hint}</p>
        </div>
      ))}
    </div>
  );
}

// ---- IP rule dialog ---------------------------------------------------------------------------

const EXPIRY = [
  { value: '', label: 'Never' },
  { value: '1', label: '1 hour' },
  { value: '24', label: '24 hours' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
];

export function IpRuleDialog({ initial, onClose }: { initial?: { cidr?: string; action?: 'block' | 'allow'; scope?: IpRule['scope']; reason?: string }; onClose: () => void }) {
  const [cidr, setCidr] = useState(initial?.cidr ?? '');
  const [action, setAction] = useState<'block' | 'allow'>(initial?.action ?? 'block');
  const [scope, setScope] = useState<IpRule['scope']>(initial?.scope ?? 'auth');
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [hours, setHours] = useState(initial?.action === 'allow' ? '' : '24');
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () =>
      api.post('/api/admin/security/ip-rules', {
        cidr: cidr.trim(),
        action,
        scope,
        reason: reason.trim() || undefined,
        expiresAt: hours ? new Date(Date.now() + Number(hours) * 3_600_000).toISOString() : undefined,
      }),
    { success: action === 'block' ? 'Block rule added' : 'Allow rule added', invalidate: [['ip-rules'], ['security-overview']], onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={action === 'block' ? 'Block a network' : 'Allow a network'}
      description="Rules take effect within seconds on every server. Allow rules win over block rules."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="ip-rule" variant={action === 'block' ? 'danger' : 'primary'} loading={save.isPending}>
            {action === 'block' ? 'Block' : 'Allow'}
          </Button>
        </>
      }
    >
      <form
        id="ip-rule"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="IP address or CIDR range" htmlFor="ip-cidr" required className="sm:col-span-2">
            <Input id="ip-cidr" className="font-mono" value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="198.51.100.7 or 198.51.100.0/24" required autoFocus />
          </Field>
          <Field label="Rule" htmlFor="ip-action">
            <Select id="ip-action" value={action} onChange={(e) => setAction(e.target.value as 'block' | 'allow')} options={[{ value: 'block', label: 'Block' }, { value: 'allow', label: 'Allow (always permit)' }]} />
          </Field>
          <Field label="Applies to" htmlFor="ip-scope">
            <Select
              id="ip-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as IpRule['scope'])}
              options={[
                { value: 'auth', label: 'Sign-in only' },
                { value: 'api', label: 'Public API' },
                { value: 'admin', label: 'Admin console' },
                { value: 'all', label: 'Everything' },
              ]}
            />
          </Field>
          <Field label="Expires" htmlFor="ip-expiry" hint="Temporary blocks are safer for addresses that may be shared.">
            <Select id="ip-expiry" value={hours} onChange={(e) => setHours(e.target.value)} options={EXPIRY} />
          </Field>
          <Field label="Reason" htmlFor="ip-reason" hint="Recorded in the audit log">
            <Input id="ip-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. credential stuffing" />
          </Field>
        </div>
        {action === 'block' && (
          <Callout tone="warning">
            Blocking can lock out unrelated people who share the address (offices, universities, mobile carriers, VPN exit nodes). Prefer the narrowest scope and a short expiry. The server refuses rules that would block your own current address from the console.
          </Callout>
        )}
      </form>
    </Modal>
  );
}

// ---- Events ------------------------------------------------------------------------------------

function EventDialog({ event, onClose, onBlock, onShowSignIns }: { event: SecurityEvent; onClose: () => void; onBlock: (ip: string) => void; onShowSignIns: (ip: string) => void }) {
  const { can } = useAuth();
  const update = useAction((status: SecurityEvent['status']) => api.patch(`/api/admin/security/events/${event.id}`, { status }), {
    success: (_r, s) => (s === 'resolved' ? 'Marked as resolved' : s === 'acknowledged' ? 'Acknowledged' : 'Reopened'),
    invalidate: [['security-events'], ['security-overview']],
    onSuccess: onClose,
  });
  const href = subjectHref(event.subject_type, event.subject_id);
  const manage = can('security.events.manage');
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={eventLabel(event.type)}
      description={<code className="font-mono text-xs">{event.type}</code>}
      size="lg"
      footer={
        manage ? (
          <>
            {event.status !== 'open' && (
              <Button variant="ghost" onClick={() => update.mutate('open')} disabled={update.isPending}>
                Reopen
              </Button>
            )}
            {event.status === 'open' && (
              <Button variant="outline" onClick={() => update.mutate('acknowledged')} loading={update.isPending && update.variables === 'acknowledged'}>
                Acknowledge
              </Button>
            )}
            {event.status !== 'resolved' && (
              <Button onClick={() => update.mutate('resolved')} loading={update.isPending && update.variables === 'resolved'}>
                Resolve
              </Button>
            )}
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <KeyValue
          items={[
            { label: 'Severity', value: <Badge tone={SEVERITY_TONE[event.severity]}>{event.severity}</Badge> },
            { label: 'Status', value: <Badge tone={EVENT_STATUS_TONE[event.status]}>{event.status}</Badge> },
            { label: 'Detected', value: dateTime(event.created_at) },
            { label: 'Resolved', value: event.resolved_at ? dateTime(event.resolved_at) : null, hidden: !event.resolved_at },
            { label: 'Subject', value: event.subject_type ? (href ? <Link className="text-primary hover:underline" to={href}>{event.subject_type} {event.subject_id}</Link> : `${event.subject_type} ${event.subject_id ?? ''}`) : null },
            { label: 'IP address', value: event.ip ? <code className="font-mono text-xs">{event.ip}</code> : null },
          ]}
        />
        {event.ip && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" icon={<Eye className="size-3.5" />} onClick={() => onShowSignIns(event.ip!)}>
              Sign-ins from this IP
            </Button>
            {can('security.ip_rules.manage') && (
              <Button size="sm" variant="outline" icon={<Ban className="size-3.5" />} onClick={() => onBlock(event.ip!)}>
                Block this IP…
              </Button>
            )}
          </div>
        )}
        {event.ip && <IpCaveat />}
        <Field label="Details">
          <JsonView value={event.details} />
        </Field>
      </div>
    </Modal>
  );
}

function EventsTab({ state, setState, onBlock, onShowSignIns }: { state: Record<string, string | number | undefined>; setState: (p: Record<string, string | number | undefined>, o?: { resetPage?: boolean }) => void; onBlock: (ip: string) => void; onShowSignIns: (ip: string) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<SecurityEvent | null>(null);
  const query = {
    status: state.status === 'all' ? undefined : (state.status as string),
    severity: state.severity || undefined,
    type: state.type || undefined,
    subjectType: state.subjectType || undefined,
    page: state.page,
    pageSize: 25,
  };
  const events = useQuery({ queryKey: ['security-events', query], queryFn: ({ signal }) => api.get<Page<SecurityEvent>>('/api/admin/security/events', query, signal), placeholderData: keepPreviousData });
  const types = useQuery({ queryKey: ['security-event-types'], queryFn: () => api.get<{ data: { type: string; count: number }[] }>('/api/admin/security/event-types'), staleTime: 60_000 });
  const bulk = useAction(
    async (status: SecurityEvent['status']) => {
      const ids = [...selected];
      let failed = 0;
      for (const id of ids) await api.patch(`/api/admin/security/events/${id}`, { status }).catch(() => failed++);
      return { done: ids.length - failed, failed };
    },
    {
      invalidate: [['security-events'], ['security-overview']],
      onSuccess: (r) => {
        if (r.failed) toast.error(`${r.done} updated, ${r.failed} failed`);
        else toast.success(`${r.done} event${r.done === 1 ? '' : 's'} updated`);
        setSelected(new Set());
      },
    },
  );

  const columns: Column<SecurityEvent>[] = [
    {
      key: 'type',
      header: 'Event',
      cell: (e) => (
        <button type="button" className="min-w-0 text-left" onClick={() => setOpen(e)}>
          <span className="block truncate font-medium hover:underline">{eventLabel(e.type)}</span>
          <code className="block truncate font-mono text-xs text-muted-foreground">{e.type}</code>
        </button>
      ),
    },
    { key: 'severity', header: 'Severity', cell: (e) => <Badge tone={SEVERITY_TONE[e.severity]} dot>{e.severity}</Badge> },
    {
      key: 'subject',
      header: 'Subject',
      cell: (e) => {
        const href = subjectHref(e.subject_type, e.subject_id);
        if (!e.subject_type) return <span className="text-muted-foreground">—</span>;
        return href ? (
          <Link className="text-primary hover:underline" to={href}>
            {e.subject_type}
          </Link>
        ) : (
          <span>{e.subject_type === 'ip' ? <code className="font-mono text-xs">{e.subject_id}</code> : e.subject_type}</span>
        );
      },
    },
    { key: 'ip', header: 'IP', priority: 'low', cell: (e) => (e.ip ? <code className="font-mono text-xs">{e.ip}</code> : <span className="text-muted-foreground">—</span>) },
    { key: 'status', header: 'Status', cell: (e) => <Badge tone={EVENT_STATUS_TONE[e.status]}>{e.status}</Badge> },
    { key: 'created_at', header: 'Detected', cell: (e) => <When value={e.created_at} /> },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select
          aria-label="Status"
          className="w-auto"
          value={String(state.status)}
          onChange={(e) => setState({ status: e.target.value })}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'acknowledged', label: 'Acknowledged' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'Any status' },
          ]}
        />
        <Select aria-label="Severity" className="w-auto" value={String(state.severity)} onChange={(e) => setState({ severity: e.target.value })} placeholder="Any severity" options={[{ value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }]} />
        <Select
          aria-label="Event type"
          className="w-auto max-w-64"
          value={String(state.type)}
          onChange={(e) => setState({ type: e.target.value })}
          placeholder="Any type"
          options={(types.data?.data ?? []).map((t) => ({ value: t.type, label: `${eventLabel(t.type)} (${t.count})` }))}
        />
        <Select aria-label="Subject" className="w-auto" value={String(state.subjectType)} onChange={(e) => setState({ subjectType: e.target.value })} placeholder="Any subject" options={[{ value: 'admin', label: 'Administrators' }, { value: 'user', label: 'Customers' }, { value: 'ip', label: 'IP addresses' }, { value: 'api_key', label: 'API keys' }]} />
      </Toolbar>
      {selected.size > 0 && can('security.events.manage') && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" loading={bulk.isPending && bulk.variables === 'acknowledged'} onClick={() => bulk.mutate('acknowledged')}>
            Acknowledge
          </Button>
          <Button size="sm" variant="outline" icon={<CheckCheck className="size-3.5" />} loading={bulk.isPending && bulk.variables === 'resolved'} onClick={() => bulk.mutate('resolved')}>
            Resolve
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}
      {events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <DataTable
          caption="Security events"
          columns={columns}
          rows={events.data?.data}
          rowKey={(e) => e.id}
          loading={events.isLoading}
          fetching={events.isFetching && !events.isLoading}
          selectable={can('security.events.manage')}
          selected={selected}
          onSelectedChange={setSelected}
          empty={<EmptyState icon={<ShieldCheck />} title={state.status === 'open' ? 'No open security alerts' : 'No security events match'} description="Alerts are raised for new devices, unusual locations, lockouts, automatic IP blocks and changes to two-factor authentication." />}
        />
      )}
      {events.data && <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      {open && <EventDialog event={open} onClose={() => setOpen(null)} onBlock={(ip) => { setOpen(null); onBlock(ip); }} onShowSignIns={(ip) => { setOpen(null); onShowSignIns(ip); }} />}
    </Card>
  );
}

// ---- Sign-ins -----------------------------------------------------------------------------------

function SignInsTab({ state, setState, onBlock }: { state: Record<string, string | number | undefined>; setState: (p: Record<string, string | number | undefined>, o?: { resetPage?: boolean }) => void; onBlock: (ip: string) => void }) {
  const { can } = useAuth();
  const [ipDraft, setIpDraft] = useState(String(state.ip ?? ''));
  const query = {
    subjectType: state.who || undefined,
    success: state.result === 'success' ? 'true' : state.result === 'failure' ? 'false' : undefined,
    ip: state.ip || undefined,
    from: state.from ? new Date(String(state.from)).toISOString() : undefined,
    page: state.lpage,
    pageSize: 25,
  };
  const logins = useQuery({ queryKey: ['login-events', query], queryFn: ({ signal }) => api.get<Page<LoginEvent>>('/api/admin/security/login-events', query, signal), placeholderData: keepPreviousData });
  const set = (patch: Record<string, string | number | undefined>) => setState({ ...patch, lpage: undefined });

  const columns: Column<LoginEvent>[] = [
    {
      key: 'result',
      header: 'Result',
      cell: (l) =>
        l.success ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CircleCheck className="size-4" aria-hidden="true" /> Success
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-danger">
            <CircleX className="size-4" aria-hidden="true" /> {(l.failure_reason ?? 'failed').replace(/_/g, ' ')}
          </span>
        ),
    },
    {
      key: 'who',
      header: 'Account',
      cell: (l) => {
        const href = subjectHref(l.subject_type, l.subject_id);
        const label = l.email ?? 'unknown';
        return (
          <span className="min-w-0">
            {href ? (
              <Link className="block truncate text-primary hover:underline" to={href}>
                {label}
              </Link>
            ) : (
              <span className="block truncate">{label}</span>
            )}
            <span className="text-xs text-muted-foreground">{l.subject_type === 'admin' ? 'Administrator' : 'Customer'} · {l.method.replace(/_/g, ' ')}</span>
          </span>
        );
      },
    },
    {
      key: 'ip',
      header: 'IP / location',
      cell: (l) => (
        <span>
          <button type="button" className="font-mono text-xs hover:underline" title="Show sign-ins from this IP" onClick={() => { setIpDraft(l.ip ?? ''); set({ ip: l.ip ?? '' }); }}>
            {l.ip ?? '—'}
          </button>
          {l.country && <span className="ml-1.5 text-xs text-muted-foreground">{l.country}</span>}
        </span>
      ),
    },
    { key: 'device', header: 'Device', priority: 'low', cell: (l) => <span className="block max-w-56 truncate" title={l.user_agent ?? undefined}>{describeAgent(l.user_agent)}</span> },
    { key: 'when', header: 'When', cell: (l) => <When value={l.created_at} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (l) =>
        l.ip && can('security.ip_rules.manage') ? (
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label="Actions">
                <MoreHorizontal className="size-4" />
              </Button>
            }
            items={[
              { label: 'Show sign-ins from this IP', icon: <Eye className="size-4" />, onSelect: () => { setIpDraft(l.ip!); set({ ip: l.ip! }); } },
              { label: 'Block this IP…', icon: <Ban className="size-4" />, danger: true, onSelect: () => onBlock(l.ip!) },
            ]}
          />
        ) : null,
    },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select aria-label="Account type" className="w-auto" value={String(state.who)} onChange={(e) => set({ who: e.target.value })} placeholder="Everyone" options={[{ value: 'admin', label: 'Administrators' }, { value: 'user', label: 'Customers' }]} />
        <Select aria-label="Result" className="w-auto" value={String(state.result)} onChange={(e) => set({ result: e.target.value })} placeholder="Any result" options={[{ value: 'failure', label: 'Failed' }, { value: 'success', label: 'Succeeded' }]} />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            set({ ip: ipDraft.trim() });
          }}
        >
          <Input aria-label="IP address" className="w-44 font-mono" value={ipDraft} onChange={(e) => setIpDraft(e.target.value)} placeholder="Exact IP address" />
          <Button type="submit" variant="outline">
            Filter
          </Button>
        </form>
        <Input aria-label="Since" type="date" className="w-auto" value={String(state.from)} onChange={(e) => set({ from: e.target.value })} />
        {(state.who || state.result || state.ip || state.from) && (
          <Button
            variant="ghost"
            onClick={() => {
              setIpDraft('');
              set({ who: undefined, result: undefined, ip: undefined, from: undefined });
            }}
          >
            Clear
          </Button>
        )}
      </Toolbar>
      <div className="border-b px-4 py-2">
        <IpCaveat />
      </div>
      {logins.error ? (
        <ErrorState error={logins.error} onRetry={() => void logins.refetch()} />
      ) : (
        <DataTable
          caption="Sign-in attempts"
          columns={columns}
          rows={logins.data?.data}
          rowKey={(l) => l.id}
          loading={logins.isLoading}
          fetching={logins.isFetching && !logins.isLoading}
          empty={<EmptyState title="No sign-in attempts match" />}
        />
      )}
      {logins.data && <Pagination page={logins.data.page} pageSize={logins.data.pageSize} total={logins.data.total} onPage={(p) => setState({ lpage: p }, { resetPage: false })} />}
    </Card>
  );
}

// ---- IP rules -----------------------------------------------------------------------------------

function IpRulesTab({ onAdd }: { onAdd: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const rules = useQuery({ queryKey: ['ip-rules'], queryFn: () => api.get<{ data: IpRule[] }>('/api/admin/security/ip-rules') });
  const remove = useAction((id: string) => api.delete(`/api/admin/security/ip-rules/${id}`), { success: 'Rule removed', invalidate: [['ip-rules'], ['security-overview']] });
  const scopeLabel: Record<IpRule['scope'], string> = { auth: 'Sign-in', api: 'Public API', admin: 'Admin console', all: 'Everything' };
  const columns: Column<IpRule>[] = [
    { key: 'cidr', header: 'Network', cell: (r) => <code className="font-mono text-xs">{r.cidr}</code> },
    { key: 'action', header: 'Rule', cell: (r) => (r.action === 'block' ? <Badge tone="danger">block</Badge> : <Badge tone="success">allow</Badge>) },
    { key: 'scope', header: 'Applies to', cell: (r) => scopeLabel[r.scope] },
    { key: 'reason', header: 'Reason', cell: (r) => <span className="line-clamp-2 max-w-xs text-sm">{r.reason ?? <span className="text-muted-foreground">—</span>}</span> },
    { key: 'expires', header: 'Expires', cell: (r) => (r.expires_at ? <When value={r.expires_at} /> : <span className="text-muted-foreground">Never</span>) },
    { key: 'created', header: 'Added', priority: 'low', cell: (r) => <span>{r.created_by ? <Link className="text-primary hover:underline" to={`/admin/team/${r.created_by}`}>admin</Link> : 'automatic'} · <When value={r.created_at} /></span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        can('security.ip_rules.manage') ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove rule for ${r.cidr}`}
            loading={remove.isPending && remove.variables === r.id}
            onClick={async () => {
              const { confirmed } = await confirm({ title: `Remove the ${r.action} rule for ${r.cidr}?`, confirmLabel: 'Remove', tone: r.action === 'allow' ? 'danger' : 'default' });
              if (confirmed) remove.mutate(r.id);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null,
    },
  ];
  if (!can('security.ip_rules.view')) return <EmptyState title="You cannot view IP rules" description="Ask an administrator for the security.ip_rules.view permission." />;
  return (
    <Card
      padded={false}
      title="Active rules"
      description="Expired rules are removed automatically. Automatic blocks come from repeated failed sign-ins (configurable in the security settings)."
      actions={
        can('security.ip_rules.manage') && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={onAdd}>
            Add rule
          </Button>
        )
      }
    >
      {rules.error ? (
        <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
      ) : (
        <DataTable caption="IP rules" columns={columns} rows={rules.data?.data} rowKey={(r) => r.id} loading={rules.isLoading} empty={<EmptyState icon={<ShieldAlert />} title="No IP rules" description="Block abusive networks or always allow trusted ones such as your office." />} />
      )}
    </Card>
  );
}

// ---- Admin sessions -------------------------------------------------------------------------------

function SessionsTab() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const sessions = useQuery({ queryKey: ['team-sessions'], queryFn: () => api.get<{ data: TeamSession[] }>('/api/admin/team/sessions'), enabled: can('iam.admins.view') });
  const revoke = useAction((id: string) => api.delete(`/api/admin/team/sessions/${id}`), { success: 'Session signed out', invalidate: [['team-sessions'], ['team']] });
  if (!can('iam.admins.view')) return <EmptyState title="You cannot view administrator sessions" description="This requires the iam.admins.view permission." />;
  const columns: Column<TeamSession>[] = [
    {
      key: 'admin',
      header: 'Administrator',
      cell: (s) => (
        <Link to={`/admin/team/${s.admin_id}`} className="min-w-0 hover:underline">
          <span className="block truncate">{s.admin_name}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{s.admin_email}</span>
        </Link>
      ),
    },
    {
      key: 'device',
      header: 'Device',
      cell: (s) => (
        <span className="inline-flex items-center gap-1.5">
          {s.client === 'mobile' ? <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" /> : <Laptop className="size-4 text-muted-foreground" aria-hidden="true" />}
          {s.client === 'mobile' ? 'Mobile app' : describeAgent(s.user_agent)}
          {s.current && <Badge tone="success">you</Badge>}
        </span>
      ),
    },
    { key: 'ip', header: 'IP', cell: (s) => <code className="font-mono text-xs">{s.ip ?? '—'}</code> },
    { key: '2fa', header: '2FA', priority: 'low', cell: (s) => (s.mfa_verified ? <Badge tone="success">verified</Badge> : <Badge tone="warning">pending</Badge>) },
    { key: 'seen', header: 'Last active', cell: (s) => <When value={s.last_seen_at} /> },
    { key: 'expires', header: 'Expires', priority: 'low', cell: (s) => <When value={s.expires_at} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (s) =>
        can('iam.admins.manage') && !s.current ? (
          <Button
            size="sm"
            variant="outline"
            loading={revoke.isPending && revoke.variables === s.id}
            onClick={async () => {
              const { confirmed } = await confirm({ title: `Sign out ${s.admin_name} on this device?`, description: 'They will need to sign in again there.', confirmLabel: 'Sign out' });
              if (confirmed) revoke.mutate(s.id);
            }}
          >
            Sign out
          </Button>
        ) : null,
    },
  ];
  return (
    <Card padded={false} title="Signed-in administrators" description={<IpCaveat />}>
      {sessions.error ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : (
        <DataTable caption="Administrator sessions" columns={columns} rows={sessions.data?.data} rowKey={(s) => s.id} loading={sessions.isLoading} empty={<EmptyState title="No active sessions" />} />
      )}
    </Card>
  );
}

// ---- Policies -----------------------------------------------------------------------------------------

interface SettingsSection {
  key: string;
  label: string;
  description: string | null;
  value: Record<string, unknown>;
}

function PoliciesTab() {
  const { can } = useAuth();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ data: SettingsSection[] }>('/api/admin/settings'), enabled: can('system.settings.view') });
  const auth = settings.data?.data.find((s) => s.key === 'auth')?.value as Record<string, any> | undefined;
  const sec = settings.data?.data.find((s) => s.key === 'security')?.value as Record<string, any> | undefined;
  const sharing = settings.data?.data.find((s) => s.key === 'accountSharing')?.value as Record<string, any> | undefined;
  if (!can('system.settings.view')) return <EmptyState title="You cannot view settings" description="This requires the system.settings.view permission." />;
  if (settings.isLoading) return <Skeleton className="h-48" />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const yes = (v: unknown) => (v ? 'On' : 'Off');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Admin sign-in & sessions" actions={<ButtonLink to="/platform/settings/auth" size="sm">Edit</ButtonLink>}>
        {auth ? (
          <KeyValue
            items={[
              { label: 'Two-factor required for admins', value: auth.require2fa ? <Badge tone="success">Required</Badge> : <Badge tone="warning">Optional</Badge> },
              { label: 'Lockout', value: `${auth.lockoutThreshold} failed attempts → ${auth.lockoutMinutes} min` },
              { label: 'Idle timeout', value: `${auth.sessionIdleMinutes} min` },
              { label: 'Maximum session', value: `${auth.sessionMaxHours} h (mobile ${auth.mobileSessionDays} days)` },
              { label: 'Password policy', value: `${auth.passwordMinLength}+ characters${auth.passwordRequireMixed ? ', mixed character types' : ''}` },
              { label: 'Re-confirm identity for sensitive actions', value: `every ${auth.reauthWindowMinutes} min` },
              { label: 'Console IP allowlist', value: auth.ipAllowlist?.length ? `${auth.ipAllowlist.length} network(s)` : 'Any network' },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Not available.</p>
        )}
      </Card>
      <Card title="Abuse prevention & alerts" actions={<ButtonLink to="/platform/settings/security" size="sm">Edit</ButtonLink>}>
        {sec ? (
          <KeyValue
            items={[
              { label: 'Automatic IP blocking', value: sec.autoBlockEnabled ? `${sec.autoBlockThreshold} failures in ${sec.autoBlockWindowMinutes} min → blocked ${sec.autoBlockMinutes} min` : 'Off' },
              { label: 'Customer lockout', value: `${sec.userLockoutThreshold} failed attempts → ${sec.userLockoutMinutes} min` },
              { label: 'New-device alerts', value: yes(sec.alertOnNewDevice) },
              { label: 'Country header', value: sec.geoCountryHeader ? <code className="font-mono text-xs">{sec.geoCountryHeader}</code> : 'Not configured (no geolocation)' },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Not available.</p>
        )}
      </Card>
      <Card title="Account sharing" actions={<ButtonLink to="/platform/settings/accountSharing" size="sm">Edit</ButtonLink>}>
        {sharing ? (
          <KeyValue
            items={[
              { label: 'Detection', value: sharing.enabled ? `More than ${sharing.maxAddresses} ${sharing.countBy === 'network' ? 'networks' : 'addresses'} in ${sharing.windowHours} h` : 'Off' },
              { label: 'When flagged', value: `${SHARING_ACTIONS[sharing.action as keyof typeof SHARING_ACTIONS] ?? sharing.action}${sharing.action === 'block_logins' ? ` for ${sharing.cooldownMinutes} min` : ''}` },
              { label: 'Trusted networks', value: sharing.trustedNetworks?.length ? `${sharing.trustedNetworks.length} network(s)` : 'None' },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Not available.</p>
        )}
      </Card>
    </div>
  );
}

// ---- Page ------------------------------------------------------------------------------------------------

export default function SecurityPage() {
  const { can } = useAuth();
  const [state, setState] = useUrlState(DEFAULTS);
  const [ruleDialog, setRuleDialog] = useState<null | { cidr?: string; action?: 'block' | 'allow'; reason?: string }>(null);
  const tab = String(state.tab);
  const block = (ip: string) => setRuleDialog({ cidr: ip, action: 'block', reason: '' });
  const showSignIns = (ip: string) => setState({ tab: 'signins', ip, who: undefined, result: undefined, from: undefined, lpage: undefined });

  return (
    <>
      <PageHeader
        title="Security"
        description="Alerts, sign-in activity, network rules and signed-in administrators."
        actions={
          <>
            {can('security.audit.view') && <ButtonLink to="/admin/audit">Audit log</ButtonLink>}
            {can('security.ip_rules.manage') && (
              <Button icon={<Ban className="size-4" />} onClick={() => setRuleDialog({})}>
                Block or allow IP
              </Button>
            )}
          </>
        }
      />
      <OverviewStats />
      <Tabs
        value={tab}
        onValueChange={(t) => setState({ tab: t }, { resetPage: false })}
        tabs={[
          { value: 'events', label: 'Alerts', content: tab === 'events' && <EventsTab state={state} setState={setState} onBlock={block} onShowSignIns={showSignIns} /> },
          { value: 'signins', label: 'Sign-ins', content: tab === 'signins' && <SignInsTab state={state} setState={setState} onBlock={block} /> },
          { value: 'sharing', label: 'Account sharing', hidden: !can('security.sharing.view'), content: tab === 'sharing' && <AccountSharingTab /> },
          { value: 'ip-rules', label: 'IP rules', hidden: !can('security.ip_rules.view'), content: tab === 'ip-rules' && <IpRulesTab onAdd={() => setRuleDialog({})} /> },
          { value: 'sessions', label: 'Admin sessions', hidden: !can('iam.admins.view'), content: tab === 'sessions' && <SessionsTab /> },
          { value: 'policies', label: 'Policies', hidden: !can('system.settings.view'), content: tab === 'policies' && <PoliciesTab /> },
        ]}
      />
      {ruleDialog && <IpRuleDialog initial={ruleDialog} onClose={() => setRuleDialog(null)} />}
    </>
  );
}
