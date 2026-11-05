import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText, X } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, Select, Toolbar, When, type Column } from '../../components/ui';
import { reasonLabel } from './shared';

interface LogRow {
  id: string;
  event: 'check' | 'view' | 'link' | 'download';
  source: 'api' | 'client' | 'public';
  resource_id: string | null;
  resource_title: string | null;
  file_id: string | null;
  path: string | null;
  user_id: string | null;
  org_id: string | null;
  allowed: boolean;
  reason: string;
  ip: string | null;
  created_at: string;
  user_email: string | null;
  user_name: string | null;
}

const EVENTS: Record<LogRow['event'], string> = {
  check: 'Access check',
  view: 'Opened',
  link: 'Download link',
  download: 'Download',
};

const SOURCES: Record<LogRow['source'], string> = {
  api: 'Your backend',
  client: 'Customer app',
  public: 'Signed link',
};

const DEFAULTS = { q: '', event: '', outcome: '', userId: '', resourceId: '', page: 1, pageSize: 50 };

export default function AccessLogPage() {
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);

  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = useMemo(() => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(state)) if (v !== '' && v !== undefined) out[k] = v as string | number;
    return out;
  }, [state]);

  const log = useQuery({
    queryKey: ['access-log', query],
    queryFn: ({ signal }) => api.get<Page<LogRow>>('/api/admin/access/log', query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const filtered = ['q', 'event', 'outcome', 'userId', 'resourceId'].some((k) => state[k] !== '' && state[k] !== undefined);
  const columns: Column<LogRow>[] = [
    { key: 'when', header: 'When', cell: (l) => <When value={l.created_at} /> },
    {
      key: 'customer',
      header: 'Customer',
      cell: (l) =>
        l.user_id ? (
          <Link to={`/customers/users/${l.user_id}`} className="block max-w-56 truncate hover:underline">
            {l.user_name || l.user_email || l.user_id}
          </Link>
        ) : l.org_id ? (
          <Link to={`/customers/organizations/${l.org_id}`} className="block max-w-56 truncate font-mono text-xs hover:underline">
            {l.org_id}
          </Link>
        ) : (
          <span className="text-muted-foreground">Unknown</span>
        ),
    },
    {
      key: 'what',
      header: 'Resource',
      cell: (l) => (
        <span className="block min-w-0 max-w-sm">
          {l.resource_id ? (
            <Link to={`/content/resources/${l.resource_id}`} className="block truncate hover:underline">
              {l.resource_title ?? l.resource_id}
            </Link>
          ) : (
            <span className="block truncate text-muted-foreground">{l.path ? 'Unprotected path' : '—'}</span>
          )}
          {l.path && <span className="block truncate font-mono text-xs text-muted-foreground">{l.path}</span>}
        </span>
      ),
    },
    { key: 'event', header: 'Event', cell: (l) => <span className="whitespace-nowrap">{EVENTS[l.event]}</span> },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (l) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge tone={l.allowed ? 'success' : 'danger'} dot>
            {l.allowed ? 'allowed' : 'refused'}
          </Badge>
          <span className="text-xs text-muted-foreground">{reasonLabel(l.reason)}</span>
        </span>
      ),
    },
    { key: 'source', header: 'From', priority: 'low', cell: (l) => SOURCES[l.source] },
    { key: 'ip', header: 'IP address', priority: 'low', cell: (l) => <span className="font-mono text-xs">{l.ip ?? '—'}</span> },
  ];

  const chip = (label: string, key: 'userId' | 'resourceId') =>
    state[key] ? (
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-surface py-0.5 pl-2.5 pr-1 text-sm">
        <span className="truncate">
          {label} <span className="font-mono text-xs">{String(state[key])}</span>
        </span>
        <button type="button" onClick={() => setState({ [key]: undefined })} className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove ${label.toLowerCase()} filter`}>
          <X className="size-3.5" />
        </button>
      </span>
    ) : null;

  return (
    <>
      <PageHeader title="Access log" description="Access checks from your backend, content opened in customers' apps, download links and downloads, allowed or refused, with the reason." />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search email, resource, path or IP…" className="w-full sm:w-72" />
          <Select
            aria-label="Event"
            className="w-auto"
            value={String(state.event)}
            onChange={(e) => setState({ event: e.target.value })}
            placeholder="Any event"
            options={Object.entries(EVENTS).map(([value, label]) => ({ value, label }))}
          />
          <Select
            aria-label="Outcome"
            className="w-auto"
            value={String(state.outcome)}
            onChange={(e) => setState({ outcome: e.target.value })}
            placeholder="Any outcome"
            options={[
              { value: 'allowed', label: 'Allowed' },
              { value: 'denied', label: 'Refused' },
            ]}
          />
          {chip('Customer', 'userId')}
          {chip('Resource', 'resourceId')}
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                reset();
              }}
            >
              Clear
            </Button>
          )}
        </Toolbar>
        {log.error ? (
          <ErrorState error={log.error} onRetry={() => void log.refetch()} />
        ) : (
          <DataTable
            caption="Access log"
            columns={columns}
            rows={log.data?.data}
            rowKey={(l) => l.id}
            loading={log.isLoading}
            fetching={log.isFetching && !log.isLoading}
            empty={filtered ? <EmptyState title="No entries match these filters" /> : <EmptyState icon={<ScrollText />} title="No access recorded yet" description="Entries appear when your app checks access, customers open content or download files." />}
          />
        )}
        {log.data && <Pagination page={log.data.page} pageSize={log.data.pageSize} total={log.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
    </>
  );
}
