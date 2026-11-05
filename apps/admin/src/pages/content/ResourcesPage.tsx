import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FolderLock, Plus } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { Badge, Button, ButtonLink, Card, CodeBlock, DataTable, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, Select, StatusBadge, Toolbar, type Column } from '../../components/ui';
import { KINDS, RulesSummary, kindMeta, releaseSummary, type Resource } from './shared';

const DEFAULTS = { q: '', kind: '', status: '', page: 1, pageSize: 25 };

const CHECK_EXAMPLE = `POST /api/v1/access/check
Authorization: Bearer sk_live_…   (scope access:read)

{ "userId": "usr_…", "resource": "/members/reports/2026", "ip": "203.0.113.7" }

→ { "allowed": false, "reason": "not_yet_available", "availableAt": "2026-03-09T09:00:00Z" }`;

function target(r: Resource): string | null {
  if (r.kind === 'url' || r.kind === 'folder') return r.kind === 'folder' && r.path !== '/' ? `${r.path}/…` : r.path;
  if (r.kind === 'link') return r.url;
  if (r.kind === 'file') return `${r.fileCount} file${r.fileCount === 1 ? '' : 's'}`;
  return r.description || null;
}

export default function ResourcesPage() {
  const { can, me } = useAuth();
  const manage = can('access.resources.manage') && !me?.admin.orgScope;
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

  const resources = useQuery({
    queryKey: ['access-resources', query],
    queryFn: ({ signal }) => api.get<Page<Resource>>('/api/admin/access/resources', query, signal),
    placeholderData: keepPreviousData,
  });

  const filtered = Boolean(state.q || state.kind || state.status);
  const columns: Column<Resource>[] = [
    {
      key: 'title',
      header: 'Resource',
      cell: (r) => {
        const Icon = kindMeta(r.kind).icon;
        const sub = target(r);
        return (
          <span className="flex min-w-0 max-w-md items-start gap-2">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block truncate">{r.title}</span>
              {sub && <span className="block truncate font-mono text-xs font-normal text-muted-foreground">{sub}</span>}
            </span>
          </span>
        );
      },
    },
    { key: 'kind', header: 'Type', cell: (r) => <Badge>{kindMeta(r.kind).label}</Badge> },
    { key: 'rules', header: 'Who can open it', cell: (r) => <RulesSummary rules={r.rules} /> },
    { key: 'release', header: 'Available', cell: (r) => <span className="text-sm">{releaseSummary(r.release, r.windowDays)}</span> },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Protected content"
        description="Put URLs and folders of your app behind plans, products or user groups, publish members-only pages, links and downloads, and release them on a schedule."
        actions={
          manage && (
            <ButtonLink to="/content/resources/new" variant="primary" icon={<Plus className="size-4" />}>
              Protect content
            </ButtonLink>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search title, path or URL…" className="w-full sm:w-72" />
          <Select aria-label="Type" className="w-auto" value={String(state.kind)} onChange={(e) => setState({ kind: e.target.value })} placeholder="Any type" options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
          <Select
            aria-label="Status"
            className="w-auto"
            value={String(state.status)}
            onChange={(e) => setState({ status: e.target.value })}
            placeholder="Any status"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
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
        {resources.error ? (
          <ErrorState error={resources.error} onRetry={() => void resources.refetch()} />
        ) : (
          <DataTable
            caption="Protected content"
            columns={columns}
            rows={resources.data?.data}
            rowKey={(r) => r.id}
            rowHref={(r) => `/content/resources/${r.id}`}
            loading={resources.isLoading}
            fetching={resources.isFetching && !resources.isLoading}
            empty={
              filtered ? (
                <EmptyState title="Nothing matches these filters" />
              ) : (
                <EmptyState
                  icon={<FolderLock />}
                  title="Nothing is protected yet"
                  description="Protect a folder such as /members, publish a members-only page, or offer downloads to a plan."
                  action={
                    manage && (
                      <ButtonLink to="/content/resources/new" variant="primary" icon={<Plus className="size-4" />}>
                        Protect content
                      </ButtonLink>
                    )
                  }
                />
              )
            }
          />
        )}
        {resources.data && <Pagination page={resources.data.page} pageSize={resources.data.pageSize} total={resources.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      <Card className="mt-4" title="Checking access from your app" description="Your backend asks before serving a protected path; customers' apps list and open content with a customer session (GET /api/client/content).">
        <CodeBlock code={CHECK_EXAMPLE} />
      </Card>
    </>
  );
}
