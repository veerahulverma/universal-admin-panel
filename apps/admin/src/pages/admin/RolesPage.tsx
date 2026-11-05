import { useMemo } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { Badge, ButtonLink, Card, DataTable, EmptyState, ErrorState, PageHeader, SearchInput, Toolbar, type Column } from '../../components/ui';
import { useUrlState } from '../../lib/hooks';
import { describeGrants, usePermissionCatalog, useRoles } from './shared';
import type { Role } from './types';

const DEFAULTS = { q: '' };

export default function RolesPage() {
  const { can } = useAuth();
  const [state, setState] = useUrlState(DEFAULTS);
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const q = String(state.q ?? '').trim().toLowerCase();
  const rows = useMemo(
    () => (roles.data?.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.key.includes(q) || r.description.toLowerCase().includes(q)),
    [roles.data, q],
  );

  const columns: Column<Role>[] = [
    {
      key: 'name',
      header: 'Role',
      cell: (r) => (
        <span className="min-w-0">
          <span className="block truncate">{r.name}</span>
          <code className="block truncate font-mono text-xs font-normal text-muted-foreground">{r.key}</code>
        </span>
      ),
    },
    { key: 'description', header: 'Description', priority: 'low', cell: (r) => <span className="line-clamp-2 max-w-md text-sm text-muted-foreground">{r.description || '—'}</span> },
    { key: 'permissions', header: 'Access', cell: (r) => <span className="whitespace-nowrap">{describeGrants(r.permissions, catalog.data?.data)}</span> },
    { key: 'admins', header: 'Administrators', align: 'right', cell: (r) => <span className="tabular">{r.admin_count}</span> },
    { key: 'type', header: 'Type', cell: (r) => (r.is_system ? <Badge>system</Badge> : <Badge tone="primary">custom</Badge>) },
  ];

  return (
    <>
      <PageHeader
        title="Roles"
        description="Roles bundle permissions. System roles are maintained by the platform and update automatically; duplicate one to customize it."
        actions={
          can('iam.roles.manage') && (
            <ButtonLink to="/admin/roles/new" variant="primary" icon={<Plus className="size-4" />}>
              New role
            </ButtonLink>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={String(state.q ?? '')} onChange={(v) => setState({ q: v })} placeholder="Search roles…" className="w-full sm:w-72" />
        </Toolbar>
        {roles.error ? (
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        ) : (
          <DataTable
            caption="Roles"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowHref={(r) => `/admin/roles/${r.id}`}
            loading={roles.isLoading}
            empty={<EmptyState icon={<KeyRound />} title={q ? 'No roles match' : 'No roles'} />}
          />
        )}
      </Card>
    </>
  );
}
