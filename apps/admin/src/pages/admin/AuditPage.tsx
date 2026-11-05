import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Filter, ScrollText, ShieldCheck, ShieldX, X } from 'lucide-react';
import { api, download, errorMessage, type Page } from '../../lib/api';
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
  Input,
  JsonView,
  KeyValue,
  Modal,
  Mono,
  PageHeader,
  Pagination,
  Popover,
  SearchInput,
  Select,
  Toolbar,
  When,
  useToast,
  type Column,
  type Tone,
} from '../../components/ui';
import { describeAgent, targetHref } from './shared';
import type { AuditEntry, ChainVerification } from './types';

const DEFAULTS = { q: '', actorType: '', actorId: '', action: '', targetType: '', targetId: '', from: '', to: '', page: 1, pageSize: 50 };
const FILTERS = ['actorType', 'actorId', 'action', 'targetType', 'targetId', 'from', 'to'] as const;

const ACTOR_TONE: Record<AuditEntry['actor_type'], Tone> = { admin: 'primary', system: 'neutral', api_key: 'info', user: 'success', plugin: 'warning' };
const ACTOR_LABEL: Record<AuditEntry['actor_type'], string> = { admin: 'Admin', system: 'System', api_key: 'API key', user: 'Customer', plugin: 'Plugin' };

function actorHref(e: AuditEntry): string | null {
  if (!e.actor_id) return null;
  if (e.actor_type === 'admin') return `/admin/team/${e.actor_id}`;
  if (e.actor_type === 'user') return `/customers/users/${e.actor_id}`;
  return null;
}

/** `metadata.changes` is `{ field: [before, after] }` (see the server's diff helper). */
function changesOf(metadata: Record<string, unknown>): [string, unknown, unknown][] {
  const changes = metadata?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  return Object.entries(changes as Record<string, unknown>)
    .filter(([, v]) => Array.isArray(v) && v.length === 2)
    .map(([k, v]) => [k, (v as unknown[])[0], (v as unknown[])[1]]);
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function EntryDialog({ entry, onClose, onFilter }: { entry: AuditEntry; onClose: () => void; onFilter: (patch: Record<string, string>) => void }) {
  const changes = changesOf(entry.metadata);
  const rest = Object.fromEntries(Object.entries(entry.metadata ?? {}).filter(([k]) => k !== 'changes' || !changes.length));
  const href = targetHref(entry.target_type, entry.target_id);
  const actor = actorHref(entry);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={<code className="font-mono">{entry.action}</code>} description={`Entry #${entry.seq} · ${dateTime(entry.created_at)}`} size="lg">
      <div className="space-y-4">
        <KeyValue
          items={[
            {
              label: 'Actor',
              value: (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Badge tone={ACTOR_TONE[entry.actor_type]}>{ACTOR_LABEL[entry.actor_type] ?? entry.actor_type}</Badge>
                  {actor ? <Link className="text-primary hover:underline" to={actor}>{entry.actor_label ?? entry.actor_id}</Link> : entry.actor_label ?? entry.actor_id ?? '—'}
                </span>
              ),
            },
            { label: 'Target', value: entry.target_type ? (href ? <Link className="text-primary hover:underline" to={href}>{entry.target_type} {entry.target_id}</Link> : `${entry.target_type} ${entry.target_id ?? ''}`) : null },
            { label: 'Organization', value: entry.org_id ? <Link className="text-primary hover:underline" to={`/customers/organizations/${entry.org_id}`}>{entry.org_id}</Link> : null, hidden: !entry.org_id },
            { label: 'IP address', value: entry.ip ? <code className="font-mono text-xs">{entry.ip}</code> : null },
            { label: 'Client', value: entry.user_agent ? <span title={entry.user_agent}>{describeAgent(entry.user_agent)}</span> : null },
            { label: 'Entry ID', value: <Mono copy>{entry.id}</Mono> },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {entry.actor_id && (
            <Button size="sm" variant="outline" icon={<Filter className="size-3.5" />} onClick={() => onFilter({ actorType: entry.actor_type, actorId: entry.actor_id! })}>
              More by this actor
            </Button>
          )}
          {entry.target_type && entry.target_id && (
            <Button size="sm" variant="outline" icon={<Filter className="size-3.5" />} onClick={() => onFilter({ targetType: entry.target_type!, targetId: entry.target_id! })}>
              History of this {entry.target_type.replace(/_/g, ' ')}
            </Button>
          )}
        </div>
        {changes.length > 0 && (
          <Field label="Changes">
            <div className="overflow-x-auto rounded-ui border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Field</th>
                    <th className="px-3 py-2 font-medium">Before</th>
                    <th className="px-3 py-2 font-medium">After</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map(([field, before, after]) => (
                    <tr key={field} className="border-t align-top">
                      <td className="px-3 py-2 font-mono text-xs">{field}</td>
                      <td className="max-w-56 break-words px-3 py-2 text-danger">{show(before)}</td>
                      <td className="max-w-56 break-words px-3 py-2 text-success">{show(after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Field>
        )}
        {Object.keys(rest).length > 0 && (
          <Field label={changes.length ? 'Other details' : 'Details'}>
            <JsonView value={rest} />
          </Field>
        )}
        <p className="text-xs text-muted-foreground">Audit entries are append-only and hash-chained: each entry's hash covers the previous one, so edits or deletions are detected by integrity verification.</p>
      </div>
    </Modal>
  );
}

export default function AuditPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const debounced = useDebounced(search.trim(), 300);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (debounced !== (state.q ?? '')) setState({ q: debounced });
    // Only the debounced search box drives this; URL changes elsewhere reset the box directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const filters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of ['q', ...FILTERS] as const) {
      const v = String(state[k] ?? '');
      if (!v) continue;
      // Dates from the pickers are whole days: "to" includes the selected day.
      out[k] = k === 'from' ? new Date(`${v}T00:00:00`).toISOString() : k === 'to' ? new Date(`${v}T23:59:59.999`).toISOString() : v;
    }
    return out;
  }, [state]);
  const query = { ...filters, page: state.page, pageSize: state.pageSize };
  const list = useQuery({ queryKey: ['audit-logs', query], queryFn: ({ signal }) => api.get<Page<AuditEntry>>('/api/admin/audit-logs', query, signal), placeholderData: keepPreviousData });
  const verify = useAction(() => api.get<ChainVerification>('/api/admin/audit-logs/verify'), { onSuccess: setVerification });

  const active = FILTERS.filter((k) => state[k]);
  const chips: { key: string; label: string; clear: Record<string, undefined> }[] = [];
  if (state.actorId) chips.push({ key: 'actor', label: `Actor: ${state.actorType ? `${state.actorType} ` : ''}${state.actorId}`, clear: { actorId: undefined, actorType: undefined } });
  if (state.targetId || state.targetType) chips.push({ key: 'target', label: `Target: ${state.targetType ?? ''} ${state.targetId ?? ''}`.trim(), clear: { targetType: undefined, targetId: undefined } });

  const columns: Column<AuditEntry>[] = [
    { key: 'created_at', header: 'When', cell: (e) => <span className="whitespace-nowrap" title={dateTime(e.created_at)}><When value={e.created_at} /></span> },
    {
      key: 'actor',
      header: 'Actor',
      cell: (e) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge tone={ACTOR_TONE[e.actor_type]}>{ACTOR_LABEL[e.actor_type] ?? e.actor_type}</Badge>
          <span className="truncate">{e.actor_label ?? e.actor_id ?? '—'}</span>
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      cell: (e) => (
        <button type="button" className="text-left" onClick={() => setOpen(e)}>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:underline">{e.action}</code>
        </button>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      cell: (e) => {
        if (!e.target_type) return <span className="text-muted-foreground">—</span>;
        const href = targetHref(e.target_type, e.target_id);
        const label = (
          <>
            {e.target_type.replace(/_/g, ' ')} <span className="font-mono text-xs text-muted-foreground">{e.target_id}</span>
          </>
        );
        return href ? (
          <Link to={href} className="hover:underline">
            {label}
          </Link>
        ) : (
          <span>{label}</span>
        );
      },
    },
    { key: 'ip', header: 'IP', priority: 'low', cell: (e) => (e.ip ? <code className="font-mono text-xs">{e.ip}</code> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'details',
      header: <span className="sr-only">Details</span>,
      align: 'right',
      cell: (e) => (
        <Button size="sm" variant="ghost" onClick={() => setOpen(e)}>
          Details
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every administrative and security-relevant action, who performed it, from where and what changed. Entries cannot be edited or deleted."
        actions={
          <>
            <Button variant="outline" icon={<ShieldCheck className="size-4" />} loading={verify.isPending} onClick={() => verify.mutate()}>
              Verify integrity
            </Button>
            {can('security.audit.view') && (
              <Button
                variant="outline"
                icon={<Download className="size-4" />}
                loading={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    await download('/api/admin/audit-logs/export.csv', filters, 'audit-log.csv');
                  } catch (err) {
                    toast.error('Export failed', errorMessage(err));
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                Export CSV
              </Button>
            )}
          </>
        }
      />
      {verification && (
        <div className="mb-4">
          {verification.ok ? (
            <Callout tone="success" title="Audit log intact" action={<Button size="sm" variant="ghost" onClick={() => setVerification(null)} aria-label="Dismiss"><X className="size-4" /></Button>}>
              All {num(verification.checked)} retained entries were re-hashed and the chain is unbroken: nothing has been modified, removed or reordered since it was written.
            </Callout>
          ) : (
            <Callout tone="danger" title="Tampering detected" action={<Button size="sm" variant="ghost" onClick={() => setVerification(null)} aria-label="Dismiss"><X className="size-4" /></Button>}>
              <span className="inline-flex items-center gap-1.5">
                <ShieldX className="size-4" aria-hidden="true" /> The chain breaks at entry #{verification.brokenAtSeq}: {verification.reason}. {num(verification.checked)} entries before it verified correctly. Preserve database backups and investigate who had direct database access.
              </span>
            </Callout>
          )}
        </div>
      )}
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search action, actor or target ID…" className="w-full sm:w-72" />
          <Select
            aria-label="Actor type"
            className="w-auto"
            value={String(state.actorType)}
            onChange={(e) => setState({ actorType: e.target.value })}
            placeholder="Any actor"
            options={[
              { value: 'admin', label: 'Administrators' },
              { value: 'user', label: 'Customers' },
              { value: 'api_key', label: 'API keys' },
              { value: 'system', label: 'System' },
              { value: 'plugin', label: 'Plugins' },
            ]}
          />
          <Popover
            align="start"
            className="w-[min(22rem,calc(100vw-2rem))] p-4"
            trigger={
              <Button variant="outline" icon={<Filter className="size-4" />}>
                Filters{active.length > 0 && <Badge tone="primary">{active.length}</Badge>}
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Action" htmlFor="f-action" hint='Exact, or a prefix such as "role.*"' className="col-span-2">
                <Input id="f-action" className="font-mono" defaultValue={String(state.action)} onBlur={(e) => setState({ action: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && setState({ action: e.currentTarget.value.trim() })} placeholder="billing.*" />
              </Field>
              <Field label="Target type" htmlFor="f-ttype">
                <Input id="f-ttype" defaultValue={String(state.targetType)} onBlur={(e) => setState({ targetType: e.target.value.trim() })} placeholder="user" />
              </Field>
              <Field label="Target ID" htmlFor="f-tid">
                <Input id="f-tid" className="font-mono" defaultValue={String(state.targetId)} onBlur={(e) => setState({ targetId: e.target.value.trim() })} />
              </Field>
              <Field label="From" htmlFor="f-from">
                <Input id="f-from" type="date" value={String(state.from)} onChange={(e) => setState({ from: e.target.value })} />
              </Field>
              <Field label="To" htmlFor="f-to">
                <Input id="f-to" type="date" value={String(state.to)} onChange={(e) => setState({ to: e.target.value })} />
              </Field>
            </div>
          </Popover>
          {chips.map((c) => (
            <span key={c.key} className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 py-1 pl-2.5 pr-1 text-xs font-medium text-primary">
              <span className="truncate">{c.label}</span>
              <button type="button" className="rounded-full p-0.5 hover:bg-primary/20" aria-label={`Clear ${c.key} filter`} onClick={() => setState(c.clear)}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          {(active.length > 0 || state.q) && (
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
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Audit log entries"
            columns={columns}
            rows={list.data?.data}
            rowKey={(e) => e.id}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={<EmptyState icon={<ScrollText />} title={active.length || state.q ? 'No entries match these filters' : 'No audit entries yet'} />}
          />
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      {open && (
        <EntryDialog
          entry={open}
          onClose={() => setOpen(null)}
          onFilter={(patch) => {
            setOpen(null);
            setSearch('');
            setState({ q: undefined, actorType: undefined, actorId: undefined, action: undefined, targetType: undefined, targetId: undefined, ...patch });
          }}
        />
      )}
    </>
  );
}
