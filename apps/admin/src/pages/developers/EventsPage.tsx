import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { RadioTower } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  JsonView,
  KeyValue,
  Modal,
  Mono,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Tabs,
  Toolbar,
  When,
  type Column,
} from '../../components/ui';
import { eventGroup, useEventTypes, type EventTypeDef } from './shared';

interface DomainEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  user_id: string | null;
  org_id: string | null;
  created_at: string;
  dispatched_at: string | null;
}

const DEFAULTS = { tab: 'log', type: '', userId: '', orgId: '', page: 1, pageSize: 25 };

function EventDialog({ event, description, onClose }: { event: DomainEvent | null; description?: string; onClose: () => void }) {
  return (
    <Modal open={Boolean(event)} onOpenChange={(o) => !o && onClose()} size="lg" title={event ? <span className="font-mono text-base">{event.type}</span> : ''} description={description}>
      {event && (
        <div className="space-y-4">
          <KeyValue
            items={[
              { label: 'Event ID', value: <Mono copy>{event.id}</Mono> },
              { label: 'Created', value: dateTime(event.created_at) },
              { label: 'User', value: event.user_id ? <Link className="font-mono text-xs text-primary hover:underline" to={`/customers/users/${event.user_id}`}>{event.user_id}</Link> : '—' },
              { label: 'Organization', value: event.org_id ? <Link className="font-mono text-xs text-primary hover:underline" to={`/customers/organizations/${event.org_id}`}>{event.org_id}</Link> : '—' },
              { label: 'Dispatched to handlers', value: event.dispatched_at ? dateTime(event.dispatched_at) : 'Queued' },
            ]}
          />
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Data</p>
            <JsonView value={event.data} className="max-h-96 overflow-y-auto" />
          </div>
          <p className="text-xs text-muted-foreground">
            Webhook endpoints subscribed to this type receive <code className="font-mono">{'{ id, type, created, apiVersion, data, userId, orgId }'}</code>; your backend can also poll <code className="font-mono">GET /api/v1/events</code>.
          </p>
        </div>
      )}
    </Modal>
  );
}

function EventLog({ state, setState, types }: { state: Record<string, string | number | undefined>; setState: (p: Record<string, string | number | undefined>, o?: { resetPage?: boolean }) => void; types: EventTypeDef[] }) {
  const [detail, setDetail] = useState<DomainEvent | null>(null);
  const [userId, setUserId] = useState(String(state.userId ?? ''));
  const [orgId, setOrgId] = useState(String(state.orgId ?? ''));
  const u = useDebounced(userId.trim(), 400);
  const o = useDebounced(orgId.trim(), 400);
  const query = { type: state.type || undefined, userId: u || undefined, orgId: o || undefined, page: Number(state.page) || 1, pageSize: Number(state.pageSize) || 25 };
  const events = useQuery({
    queryKey: ['developers', 'events', query],
    queryFn: ({ signal }) => api.get<Page<DomainEvent>>('/api/admin/events', query, signal),
    placeholderData: keepPreviousData,
  });
  const descriptions = useMemo(() => new Map(types.map((t) => [t.type, t.description])), [types]);
  const typeOptions = useMemo(() => {
    const groups = [...new Set(types.map((t) => eventGroup(t.type)))].sort();
    return [...groups.map((g) => ({ value: `${g}.*`, label: `${g}.* (all)` })), ...types.map((t) => ({ value: t.type, label: t.type }))];
  }, [types]);
  const filtered = Boolean(state.type || u || o);

  const columns: Column<DomainEvent>[] = [
    {
      key: 'type',
      header: 'Event',
      cell: (e) => (
        <button type="button" className="block min-w-0 max-w-full text-left" onClick={() => setDetail(e)}>
          <span className="block truncate font-mono text-xs font-medium hover:underline">{e.type}</span>
          {descriptions.get(e.type) && <span className="block truncate text-xs text-muted-foreground">{descriptions.get(e.type)}</span>}
        </button>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      cell: (e) =>
        e.user_id ? (
          <Link className="font-mono text-xs text-primary hover:underline" to={`/customers/users/${e.user_id}`}>{e.user_id}</Link>
        ) : e.org_id ? (
          <Link className="font-mono text-xs text-primary hover:underline" to={`/customers/organizations/${e.org_id}`}>{e.org_id}</Link>
        ) : (
          <span className="text-muted-foreground">system</span>
        ),
    },
    { key: 'dispatched', header: 'Handlers', cell: (e) => (e.dispatched_at ? <Badge tone="success">dispatched</Badge> : <Badge tone="info">queued</Badge>) },
    { key: 'created', header: 'Created', cell: (e) => <When value={e.created_at} /> },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select aria-label="Event type" className="w-auto max-w-full" value={String(state.type ?? '')} onChange={(e) => setState({ type: e.target.value })} placeholder="All event types" options={typeOptions} />
        <Input
          aria-label="User ID"
          className="w-48 font-mono"
          placeholder="usr_…"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setState({ userId: e.target.value.trim() || undefined });
          }}
        />
        <Input
          aria-label="Organization ID"
          className="w-48 font-mono"
          placeholder="org_…"
          value={orgId}
          onChange={(e) => {
            setOrgId(e.target.value);
            setState({ orgId: e.target.value.trim() || undefined });
          }}
        />
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setUserId('');
              setOrgId('');
              setState({ type: undefined, userId: undefined, orgId: undefined });
            }}
          >
            Clear
          </Button>
        )}
      </Toolbar>
      {events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <DataTable
          caption="Domain events"
          columns={columns}
          rows={events.data?.data}
          rowKey={(e) => e.id}
          loading={events.isLoading}
          fetching={events.isFetching && !events.isLoading}
          empty={<EmptyState icon={<RadioTower />} title={filtered ? 'No events match' : 'No events yet'} description={filtered ? undefined : 'Events are recorded whenever users, billing, usage and other modules change state.'} />}
        />
      )}
      {events.data && <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      <EventDialog event={detail} description={detail ? descriptions.get(detail.type) : undefined} onClose={() => setDetail(null)} />
    </Card>
  );
}

function EventTypes({ types, onShow, canView }: { types: EventTypeDef[]; onShow: (type: string) => void; canView: boolean }) {
  const [q, setQ] = useState('');
  const lower = q.trim().toLowerCase();
  const rows = types.filter((t) => !lower || t.type.includes(lower) || t.description.toLowerCase().includes(lower) || t.module.includes(lower));
  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Search event types…" className="w-full sm:w-72" />
        <span className="text-xs text-muted-foreground">{types.length} types from enabled modules. Plugins can add more.</span>
      </Toolbar>
      <DataTable
        caption="Event types"
        rows={rows}
        rowKey={(t) => t.type}
        empty={<EmptyState title="No event types match" />}
        columns={[
          { key: 'type', header: 'Type', cell: (t) => <code className="font-mono text-xs font-medium">{t.type}</code> },
          { key: 'description', header: 'Description', cell: (t) => t.description },
          { key: 'module', header: 'Module', cell: (t) => <Badge>{t.module}</Badge> },
          {
            key: 'show',
            header: <span className="sr-only">Actions</span>,
            align: 'right',
            cell: (t) =>
              canView ? (
                <Button size="sm" variant="ghost" onClick={() => onShow(t.type)}>
                  View events
                </Button>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}

export default function EventsPage() {
  const { can } = useAuth();
  const [state, setState] = useUrlState(DEFAULTS);
  const types = useEventTypes();
  const canView = can('system.events.view');
  const tab = canView ? String(state.tab ?? 'log') : 'types';
  const list = types.data?.data ?? [];
  return (
    <>
      <PageHeader title="Event log" description="Everything that happens on the platform as typed domain events: the source for webhooks, automations, plugins and the event polling API." />
      {types.error ? (
        <ErrorState error={types.error} onRetry={() => void types.refetch()} />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => setState({ tab: v === 'log' ? undefined : v })}
          tabs={[
            { value: 'log', label: 'Events', hidden: !canView, content: tab === 'log' && <EventLog state={state} setState={setState} types={list} /> },
            { value: 'types', label: 'Event types', count: list.length || undefined, content: tab === 'types' && <EventTypes types={list} canView={canView} onShow={(type) => setState({ tab: undefined, type })} /> },
          ]}
        />
      )}
    </>
  );
}
