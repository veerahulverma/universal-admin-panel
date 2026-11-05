import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ListFilter, ScrollText } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { dateTime, num, pct } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KeyValue,
  KpiTile,
  Modal,
  Mono,
  PageHeader,
  Pagination,
  Popover,
  SearchInput,
  Select,
  Skeleton,
  Switch,
  Toolbar,
  When,
  type Column,
} from '../../components/ui';
import { HttpStatus, MethodBadge, ms } from './shared';
import type { ApiKey } from './ApiKeysPage';

interface RequestRow {
  id: string;
  api_key_id: string | null;
  surface: 'v1' | 'client';
  org_id: string | null;
  method: string;
  route: string;
  path: string;
  status: number;
  duration_ms: number;
  ip: string | null;
  error_code: string | null;
  request_id: string | null;
  created_at: string;
  key_name: string | null;
  key_prefix: string | null;
}

interface Stats {
  since: string;
  totals: { requests: number; server_errors: number; client_errors: number; rate_limited: number; avg_ms: number; p95_ms: number };
  byRoute: { method: string; route: string; requests: number; errors: number; avg_ms: number }[];
  byKey: { api_key_id: string | null; name: string | null; requests: number }[];
}

const RANGES: { value: string; label: string; hours: number }[] = [
  { value: '1h', label: 'Last hour', hours: 1 },
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 168 },
  { value: '30d', label: 'Last 30 days', hours: 720 },
  { value: '90d', label: 'Last 90 days', hours: 2160 },
];

const DEFAULTS = { range: '24h', q: '', method: '', status: '', surface: '', keyId: '', route: '', minMs: '', from: '', to: '', page: 1, pageSize: 50 };
const FILTERS = ['q', 'method', 'status', 'surface', 'keyId', 'route', 'minMs', 'from', 'to'] as const;

function RequestDialog({ row, onClose }: { row: RequestRow | null; onClose: () => void }) {
  return (
    <Modal open={Boolean(row)} onOpenChange={(o) => !o && onClose()} size="lg" title={row ? <span className="flex items-center gap-2"><MethodBadge method={row.method} /><span className="truncate font-mono text-md">{row.route}</span></span> : ''} description={row ? `Request ${row.id}` : undefined}>
      {row && (
        <div className="space-y-4">
          <KeyValue
            items={[
              { label: 'Path', value: <span className="break-all font-mono text-xs">{row.path}</span> },
              { label: 'Status', value: <span className="inline-flex items-center gap-2"><HttpStatus status={row.status} />{row.error_code && <code className="font-mono text-xs">{row.error_code}</code>}</span> },
              { label: 'Duration', value: ms(row.duration_ms) },
              { label: 'Time', value: dateTime(row.created_at) },
              { label: 'API', value: row.surface === 'v1' ? 'Integration API (secret key)' : 'Client API (customer session)' },
              { label: 'API key', value: row.api_key_id ? <span>{row.key_name ?? 'Deleted key'} <code className="font-mono text-xs text-muted-foreground">{row.key_prefix ? `${row.key_prefix}…` : row.api_key_id}</code></span> : row.surface === 'v1' ? 'None or invalid' : 'Customer session' },
              { label: 'Organization', value: row.org_id ? <Link className="font-mono text-xs text-primary hover:underline" to={`/customers/organizations/${row.org_id}`}>{row.org_id}</Link> : '—' },
              { label: 'IP address', value: row.ip ?? '—' },
              { label: 'Request ID', value: <Mono copy>{row.request_id}</Mono> },
            ]}
          />
          <Callout tone="info">
            Request and response bodies are not stored. Search the server logs by request ID for details. IP addresses can be shared or changed by proxies and VPNs; treat them as a signal, not proof of identity.
          </Callout>
        </div>
      )}
    </Modal>
  );
}

function StatsPanel({ hours, live, onRoute, onKey }: { hours: number; live: boolean; onRoute: (route: string, method: string) => void; onKey: (keyId: string) => void }) {
  const stats = useQuery({
    queryKey: ['developers', 'api-stats', hours],
    queryFn: () => api.get<Stats>('/api/admin/api-requests/stats', { hours }),
    placeholderData: keepPreviousData,
    refetchInterval: live ? 10_000 : false,
  });
  if (stats.isLoading) return <Skeleton className="h-28" />;
  if (stats.error || !stats.data) return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  const t = stats.data.totals;
  const errors = t.client_errors + t.server_errors;
  return (
    <div className={stats.isFetching && !stats.isLoading ? 'space-y-4 opacity-60 transition-opacity' : 'space-y-4 transition-opacity'}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Requests" value={t.requests} display={num(t.requests)} />
        <KpiTile label="Error rate" value={errors} display={t.requests ? pct(errors / t.requests) : '—'} hint={`${num(errors)} errors`} />
        <KpiTile label="Server errors (5xx)" value={t.server_errors} display={num(t.server_errors)} />
        <KpiTile label="Rate limited (429)" value={t.rate_limited} display={num(t.rate_limited)} />
        <KpiTile label="Average latency" value={t.avg_ms} display={ms(t.avg_ms)} />
        <KpiTile label="p95 latency" value={t.p95_ms} display={ms(t.p95_ms)} />
      </div>
      {stats.data.byRoute.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card title="Busiest endpoints" padded={false} className="xl:col-span-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Busiest endpoints</caption>
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Endpoint</th>
                    <th className="px-3 py-2 text-right font-medium">Requests</th>
                    <th className="px-3 py-2 text-right font-medium">Errors</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.byRoute.slice(0, 10).map((r) => (
                    <tr key={`${r.method} ${r.route}`} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2">
                        <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => onRoute(r.route, r.method)} title="Show these requests">
                          <MethodBadge method={r.method} />
                          <span className="truncate font-mono text-xs hover:underline">{r.route}</span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right tabular">{num(r.requests)}</td>
                      <td className="px-3 py-2 text-right tabular">{r.errors ? <span className="text-danger">{num(r.errors)} ({pct(r.errors / r.requests)})</span> : '0'}</td>
                      <td className="hidden px-3 py-2 text-right tabular sm:table-cell">{ms(r.avg_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Top keys" padded={false}>
            <ul className="divide-y">
              {stats.data.byKey.map((k) => (
                <li key={k.api_key_id ?? 'none'}>
                  {k.api_key_id ? (
                    <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/40" onClick={() => onKey(k.api_key_id!)}>
                      <span className="truncate text-sm">{k.name ?? k.api_key_id}</span>
                      <span className="text-sm tabular text-muted-foreground">{num(k.requests)}</span>
                    </button>
                  ) : (
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="text-sm text-muted-foreground">No valid key / customer sessions</span>
                      <span className="text-sm tabular text-muted-foreground">{num(k.requests)}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function LogsPage() {
  const { can } = useAuth();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);
  const [live, setLive] = useState(false);
  const [detail, setDetail] = useState<RequestRow | null>(null);
  // Push the debounced search box into the URL (only when the box changes).
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const range = RANGES.find((r) => r.value === state.range);
  const keys = useQuery({
    queryKey: ['developers', 'api-keys', true],
    queryFn: () => api.get<{ data: ApiKey[] }>('/api/admin/api-keys', { includeRevoked: 'true' }),
    enabled: can('developers.keys.view'),
    staleTime: 60_000,
  });

  const params = useMemo(
    () => ({
      range: String(state.range),
      q: String(state.q ?? ''),
      method: String(state.method ?? ''),
      status: String(state.status ?? ''),
      surface: String(state.surface ?? ''),
      keyId: String(state.keyId ?? ''),
      route: String(state.route ?? ''),
      minMs: String(state.minMs ?? ''),
      from: String(state.from ?? ''),
      to: String(state.to ?? ''),
      page: Number(state.page) || 1,
      pageSize: Number(state.pageSize) || 50,
    }),
    [state],
  );

  const logs = useQuery({
    queryKey: ['developers', 'api-requests', params],
    queryFn: ({ signal }) => {
      const hours = RANGES.find((r) => r.value === params.range)?.hours;
      // Relative ranges are resolved when the request is made, so refreshes move the window forward.
      const from = hours ? new Date(Date.now() - hours * 3_600_000).toISOString() : params.from ? new Date(`${params.from}T00:00:00`).toISOString() : undefined;
      const to = !hours && params.to ? new Date(`${params.to}T23:59:59.999`).toISOString() : undefined;
      return api.get<Page<RequestRow>>(
        '/api/admin/api-requests',
        {
          q: params.q || undefined,
          method: params.method || undefined,
          status: params.status || undefined,
          surface: params.surface || undefined,
          keyId: params.keyId || undefined,
          route: params.route || undefined,
          minDurationMs: params.minMs || undefined,
          from,
          to,
          page: params.page,
          pageSize: params.pageSize,
        },
        signal,
      );
    },
    placeholderData: keepPreviousData,
    refetchInterval: live ? 5_000 : false,
  });

  const active = FILTERS.filter((k) => state[k] !== '' && state[k] !== undefined);
  const keyName = (id: string) => keys.data?.data.find((k) => k.id === id)?.name ?? id;

  const columns: Column<RequestRow>[] = [
    { key: 'time', header: 'Time', cell: (r) => <When value={r.created_at} /> },
    { key: 'method', header: 'Method', cell: (r) => <MethodBadge method={r.method} /> },
    {
      key: 'path',
      header: 'Path',
      cell: (r) => (
        <button type="button" className="block min-w-0 max-w-full text-left md:max-w-[28rem]" onClick={() => setDetail(r)}>
          <span className="block truncate font-mono text-xs hover:underline">{r.path}</span>
          {r.route !== r.path && <span className="block truncate font-mono text-2xs text-muted-foreground">{r.route}</span>}
        </button>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <HttpStatus status={r.status} />
          {r.error_code && <code className="font-mono text-2xs text-muted-foreground">{r.error_code}</code>}
        </span>
      ),
    },
    { key: 'duration', header: 'Duration', align: 'right', cell: (r) => <span className={r.duration_ms >= 1000 ? 'tabular text-warning' : 'tabular'}>{ms(r.duration_ms)}</span> },
    { key: 'key', header: 'Key', cell: (r) => (r.api_key_id ? <span className="block max-w-40 truncate">{r.key_name ?? r.key_prefix ?? r.api_key_id}</span> : <span className="text-muted-foreground">{r.surface === 'client' ? 'session' : '—'}</span>) },
    { key: 'ip', header: 'IP', priority: 'low', cell: (r) => <span className="font-mono text-xs">{r.ip ?? '—'}</span> },
  ];

  return (
    <>
      <PageHeader
        title="API logs"
        description="Every call to the integration and client APIs, including rejected ones. Bodies are never stored."
        actions={<Switch checked={live} onCheckedChange={setLive} label="Live" description="Refresh every few seconds" />}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Time range" className="w-auto" value={String(state.range)} onChange={(e) => setState({ range: e.target.value, from: undefined, to: undefined })} options={[...RANGES.map((r) => ({ value: r.value, label: r.label })), { value: 'custom', label: 'Custom dates' }]} />
        {state.range === 'custom' && (
          <>
            <Input type="date" aria-label="From" className="w-auto" value={String(state.from ?? '')} onChange={(e) => setState({ from: e.target.value })} />
            <span className="text-muted-foreground">to</span>
            <Input type="date" aria-label="To" className="w-auto" value={String(state.to ?? '')} onChange={(e) => setState({ to: e.target.value })} />
          </>
        )}
      </div>
      {range ? (
        <div className="mb-4">
          <StatsPanel hours={range.hours} live={live} onRoute={(route, method) => setState({ route, method })} onKey={(keyId) => setState({ keyId })} />
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">Summary figures are available for the preset ranges.</p>
      )}

      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search path (e.g. a user ID)…" className="w-full sm:w-72" />
          <Select aria-label="Status" className="w-auto" value={String(state.status ?? '')} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={[{ value: '2xx', label: '2xx success' }, { value: '4xx', label: '4xx client error' }, { value: '429', label: '429 rate limited' }, { value: '5xx', label: '5xx server error' }]} />
          <Select aria-label="Method" className="w-auto" value={String(state.method ?? '')} onChange={(e) => setState({ method: e.target.value })} placeholder="Any method" options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE']} />
          <Popover
            align="start"
            className="w-[min(22rem,calc(100vw-2rem))] p-4"
            trigger={
              <Button variant="outline" icon={<ListFilter className="size-4" />}>
                More filters{active.filter((k) => !['q', 'status', 'method'].includes(k)).length > 0 && <Badge tone="primary">{active.filter((k) => !['q', 'status', 'method'].includes(k)).length}</Badge>}
              </Button>
            }
          >
            <div className="grid gap-3">
              <Field label="API key" htmlFor="f-key">
                {can('developers.keys.view') ? (
                  <Select id="f-key" value={String(state.keyId ?? '')} onChange={(e) => setState({ keyId: e.target.value })} placeholder="Any key" options={(keys.data?.data ?? []).map((k) => ({ value: k.id, label: `${k.name} (${k.prefix}…)${k.revokedAt ? ' · revoked' : ''}` }))} />
                ) : (
                  <Input id="f-key" value={String(state.keyId ?? '')} onChange={(e) => setState({ keyId: e.target.value.trim() })} placeholder="key_…" className="font-mono" />
                )}
              </Field>
              <Field label="API" htmlFor="f-surface">
                <Select id="f-surface" value={String(state.surface ?? '')} onChange={(e) => setState({ surface: e.target.value })} placeholder="Both" options={[{ value: 'v1', label: 'Integration API (secret keys)' }, { value: 'client', label: 'Client API (customer sessions)' }]} />
              </Field>
              <Field label="Endpoint" htmlFor="f-route" hint="Route template, e.g. /api/v1/users/:id">
                <Input id="f-route" value={String(state.route ?? '')} onChange={(e) => setState({ route: e.target.value.trim() })} className="font-mono" />
              </Field>
              <Field label="Slower than" htmlFor="f-slow">
                <Select id="f-slow" value={String(state.minMs ?? '')} onChange={(e) => setState({ minMs: e.target.value })} placeholder="Any duration" options={[{ value: '100', label: '100 ms' }, { value: '500', label: '500 ms' }, { value: '1000', label: '1 s' }, { value: '5000', label: '5 s' }]} />
              </Field>
            </div>
          </Popover>
          {state.keyId && (
            <Badge tone="primary" className="gap-1.5">
              key: {keyName(String(state.keyId))}
              <button type="button" aria-label="Remove key filter" onClick={() => setState({ keyId: undefined })}>
                ×
              </button>
            </Badge>
          )}
          {state.route && (
            <Badge tone="primary" className="gap-1.5 font-mono">
              {String(state.route)}
              <button type="button" aria-label="Remove endpoint filter" onClick={() => setState({ route: undefined })}>
                ×
              </button>
            </Badge>
          )}
          {active.length > 0 && (
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
        {logs.error ? (
          <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
        ) : (
          <DataTable
            caption="API requests"
            columns={columns}
            rows={logs.data?.data}
            rowKey={(r) => r.id}
            loading={logs.isLoading}
            fetching={logs.isFetching && !logs.isLoading && !live}
            empty={<EmptyState icon={<ScrollText />} title={active.length ? 'No requests match these filters' : 'No API requests in this period'} description={active.length ? undefined : 'Requests appear here as soon as your backend calls the API with a key.'} />}
          />
        )}
        {logs.data && <Pagination page={logs.data.page} pageSize={logs.data.pageSize} total={logs.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      <RequestDialog row={detail} onClose={() => setDetail(null)} />
    </>
  );
}
