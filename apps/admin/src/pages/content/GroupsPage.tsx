import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, UsersRound } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { Button, Card, DataTable, EmptyState, ErrorState, PageHeader, SearchInput, Toolbar, When, type Column } from '../../components/ui';
import { GroupDialog } from './GroupDialog';
import { RulesSummary, type UserGroup } from './shared';

const DEFAULTS = { q: '' };

export default function GroupsPage() {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  // Group definitions are shared by every organization, so organization-scoped administrators only manage members.
  const manage = can('customers.groups.manage') && !me?.admin.orgScope;
  const [state, setState] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const groups = useQuery({
    queryKey: ['user-groups', state.q],
    queryFn: ({ signal }) => api.get<{ data: UserGroup[] }>('/api/admin/user-groups', { q: String(state.q ?? '') || undefined }, signal),
    placeholderData: keepPreviousData,
  });

  const columns: Column<UserGroup>[] = [
    {
      key: 'name',
      header: 'Group',
      cell: (g) => (
        <span className="block min-w-0 max-w-md">
          <span className="block truncate">{g.name}</span>
          {g.description && <span className="block truncate text-xs font-normal text-muted-foreground">{g.description}</span>}
        </span>
      ),
    },
    {
      key: 'members',
      header: 'Members',
      cell: (g) => (
        <span className="tabular">
          {num(g.members.total)}
          {g.members.automatic > 0 && <span className="text-xs text-muted-foreground"> · {num(g.members.automatic)} automatic</span>}
        </span>
      ),
    },
    {
      key: 'auto',
      header: 'Joins automatically with',
      cell: (g) => (g.autoProducts.length ? <RulesSummary rules={{ products: g.autoProducts, groups: [], anyCustomer: false }} /> : <span className="text-muted-foreground">Added by hand only</span>),
    },
    { key: 'resources', header: 'Unlocks', cell: (g) => (g.resourceCount ? `${num(g.resourceCount)} resource${g.resourceCount === 1 ? '' : 's'}` : <span className="text-muted-foreground">—</span>) },
    { key: 'updated', header: 'Updated', priority: 'low', cell: (g) => <When value={g.updatedAt} /> },
  ];

  return (
    <>
      <PageHeader
        title="User groups"
        description="Collect customers into groups and use the groups in content rules. Add members by hand, or let a product add them automatically while they hold it."
        actions={
          manage && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New group
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search groups…" className="w-full sm:w-72" />
        </Toolbar>
        {groups.error ? (
          <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
        ) : (
          <DataTable
            caption="User groups"
            columns={columns}
            rows={groups.data?.data}
            rowKey={(g) => g.id}
            rowHref={(g) => `/customers/groups/${g.id}`}
            loading={groups.isLoading}
            fetching={groups.isFetching && !groups.isLoading}
            empty={
              state.q ? (
                <EmptyState title="No groups match your search" />
              ) : (
                <EmptyState
                  icon={<UsersRound />}
                  title="No user groups yet"
                  description="Create a group such as “Beta testers” or “Partners”, then use it in the rules of protected content."
                  action={
                    manage && (
                      <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                        New group
                      </Button>
                    )
                  }
                />
              )
            }
          />
        )}
      </Card>
      {creating && <GroupDialog group={null} onClose={() => setCreating(false)} onSaved={(g) => navigate(`/customers/groups/${g.id}`)} />}
    </>
  );
}
