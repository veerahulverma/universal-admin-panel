import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Pencil, Trash2, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced } from '../../lib/hooks';
import { num } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Modal,
  PageHeader,
  PageSkeleton,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Textarea,
  Toolbar,
  When,
  useConfirm,
  useToast,
  type Column,
} from '../../components/ui';
import { GroupDialog } from './GroupDialog';
import { RulesSummary, UserChip, UserSearch, kindMeta, type PickedUser, type ResourceKind, type UserGroup } from './shared';

interface GroupDetail extends UserGroup {
  resources: { id: string; kind: ResourceKind; title: string; status: string }[];
}

interface Member {
  id: string;
  email: string;
  name: string | null;
  status: string;
  manual: boolean;
  automatic: boolean;
  addedAt: string | null;
  automaticSince: string | null;
}

interface AddResult {
  added: string[];
  skipped: { value: string; reason: 'not_found' | 'already_member' }[];
}

const MAX_ADD = 500;

function AddMembersDialog({ group, onClose }: { group: GroupDetail; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [picked, setPicked] = useState<PickedUser[]>([]);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const values = [...new Set([...picked.map((u) => u.id), ...pasted.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)])];
  const add = useAction(() => api.post<AddResult>(`/api/admin/user-groups/${group.id}/members`, { users: values }), {
    invalidate: [['user-group-members', group.id], ['user-group', group.id], ['user-groups'], ['user-access-groups']],
    onSuccess: (r) => {
      const notFound = r.skipped.filter((s) => s.reason === 'not_found');
      const already = r.skipped.length - notFound.length;
      const notes = [already ? `${already} already in the group` : '', notFound.length ? `not found: ${notFound.map((s) => s.value).slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}` : ''].filter(Boolean).join(' · ');
      if (r.added.length) toast.success(`Added ${r.added.length} member${r.added.length === 1 ? '' : 's'}`, notes || undefined);
      else toast.info('Nobody was added', notes || undefined);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Add members to ${group.name}`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-members" loading={add.isPending} disabled={!values.length}>
            {values.length ? `Add ${values.length}` : 'Add'}
          </Button>
        </>
      }
    >
      <form
        id="add-members"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (values.length > MAX_ADD) return setError(`Add at most ${MAX_ADD} people at a time`);
          add.mutate();
        }}
      >
        <FormError message={error} />
        {can('customers.users.view') && (
          <Field label="Find customers" htmlFor="add-member-search">
            <UserSearch id="add-member-search" excludeIds={picked.map((u) => u.id)} onPick={(u) => setPicked((list) => [...list, u])} />
          </Field>
        )}
        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {picked.map((u) => (
              <UserChip key={u.id} user={u} onRemove={() => setPicked((list) => list.filter((x) => x.id !== u.id))} />
            ))}
          </div>
        )}
        <Field label={can('customers.users.view') ? 'Or paste emails or user IDs' : 'Emails or user IDs'} htmlFor="add-member-paste" hint="One per line, or separated by commas or spaces.">
          <Textarea id="add-member-paste" rows={4} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'ann@example.com\nusr_01j…'} className="font-mono" />
        </Field>
      </form>
    </Modal>
  );
}

function Members({ group, canEditMembers }: { group: GroupDetail; canEditMembers: boolean }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [source, setSource] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => setPage(1), [q, source]);

  const members = useQuery({
    queryKey: ['user-group-members', group.id, q, source, page],
    queryFn: ({ signal }) => api.get<Page<Member>>(`/api/admin/user-groups/${group.id}/members`, { q: q || undefined, source, page, pageSize: 25 }, signal),
    placeholderData: keepPreviousData,
  });

  const remove = useAction((userIds: string[]) => api.post<{ removed: string[] }>(`/api/admin/user-groups/${group.id}/members/remove`, { userIds }), {
    invalidate: [['user-group-members', group.id], ['user-group', group.id], ['user-groups'], ['user-access-groups']],
    onSuccess: (r, ids) => {
      setSelected(new Set());
      const stayed = ids.length - r.removed.length;
      toast.success(`Removed ${r.removed.length} member${r.removed.length === 1 ? '' : 's'}`, stayed ? `${stayed} joined automatically and stay while they hold the product.` : undefined);
    },
  });

  const removeSelected = async () => {
    const rows = (members.data?.data ?? []).filter((m) => selected.has(m.id));
    const automaticOnly = rows.filter((m) => !m.manual).length;
    const res = await confirm({
      title: `Remove ${selected.size} from ${group.name}?`,
      description: automaticOnly ? `${automaticOnly} of them joined automatically through a product and stay in the group while they hold it.` : 'They lose any content this group unlocks for them.',
      tone: 'danger',
      confirmLabel: 'Remove',
    });
    if (res.confirmed) remove.mutate([...selected]);
  };

  const columns: Column<Member>[] = [
    {
      key: 'user',
      header: 'Customer',
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={m.name} email={m.email} size="sm" />
          <span className="min-w-0">
            <span className="block truncate">{m.name || m.email}</span>
            {m.name && <span className="block truncate text-xs font-normal text-muted-foreground">{m.email}</span>}
          </span>
        </span>
      ),
    },
    {
      key: 'how',
      header: 'Membership',
      cell: (m) => (
        <span className="flex flex-wrap gap-1">
          {m.manual && <Badge tone="primary">added</Badge>}
          {m.automatic && <Badge tone="info">automatic</Badge>}
        </span>
      ),
    },
    { key: 'since', header: 'Since', cell: (m) => <When value={m.addedAt ?? m.automaticSince} /> },
    { key: 'status', header: 'Account', cell: (m) => <StatusBadge status={m.status} /> },
  ];

  return (
    <Card
      padded={false}
      title="Members"
      description={`${num(group.members.total)} in total · ${num(group.members.manual)} added · ${num(group.members.automatic)} automatic`}
      actions={
        canEditMembers && (
          <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
            Add members
          </Button>
        )
      }
    >
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or email…" className="w-full sm:w-64" />
        <Select
          aria-label="Membership"
          className="w-auto"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'manual', label: 'Added by hand' },
            { value: 'automatic', label: 'Automatic' },
          ]}
        />
      </Toolbar>
      {selected.size > 0 && canEditMembers && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" icon={<UserMinus className="size-4" />} loading={remove.isPending} onClick={() => void removeSelected()}>
            Remove from group
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}
      {members.error ? (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <DataTable
          caption={`Members of ${group.name}`}
          columns={columns}
          rows={members.data?.data}
          rowKey={(m) => m.id}
          rowHref={(m) => `/customers/users/${m.id}`}
          loading={members.isLoading}
          fetching={members.isFetching && !members.isLoading}
          selectable={canEditMembers}
          selected={selected}
          onSelectedChange={setSelected}
          empty={
            q || source !== 'all' ? (
              <EmptyState title="No members match" />
            ) : (
              <EmptyState icon={<UsersRound />} title="Nobody is in this group yet" description={group.autoProducts.length ? 'Customers join automatically when they subscribe to or are granted one of its products.' : 'Add customers by hand, or edit the group to add them automatically by product.'} />
            )
          }
        />
      )}
      {members.data && <Pagination page={members.data.page} pageSize={members.data.pageSize} total={members.data.total} onPage={setPage} />}
      {adding && <AddMembersDialog group={group} onClose={() => setAdding(false)} />}
    </Card>
  );
}

export default function GroupDetailPage() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const manage = can('customers.groups.manage') && !me?.admin.orgScope;
  const group = useQuery({ queryKey: ['user-group', id], queryFn: () => api.get<GroupDetail>(`/api/admin/user-groups/${id}`) });
  const remove = useAction(() => api.delete(`/api/admin/user-groups/${id}`), {
    success: 'Group deleted',
    error: 'Could not delete the group',
    invalidate: [['user-groups']],
    onSuccess: () => navigate('/customers/groups'),
  });

  if (group.isLoading) return <PageSkeleton />;
  if (group.error) return <ErrorState error={group.error} onRetry={() => void group.refetch()} />;
  const g = group.data!;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'User groups', to: '/customers/groups' }, { label: g.name }]}
        title={g.name}
        description={g.description || undefined}
        actions={
          manage && (
            <>
              <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                variant="outline"
                icon={<Trash2 className="size-4" />}
                onClick={async () => {
                  const res = await confirm({
                    title: `Delete “${g.name}”?`,
                    description: g.resourceCount ? 'Content rules still use this group; remove it from them first.' : 'Members lose whatever this group unlocked. Their accounts are not affected.',
                    tone: 'danger',
                    confirmLabel: 'Delete group',
                  });
                  if (res.confirmed) remove.mutate();
                }}
              >
                Delete
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <Members group={g} canEditMembers={can('customers.groups.manage')} />
        </div>
        <div className="space-y-4">
          <Card title="Automatic membership">
            {g.autoProducts.length ? (
              <div className="space-y-2">
                <RulesSummary rules={{ products: g.autoProducts, groups: [], anyCustomer: false }} />
                <p className="text-sm text-muted-foreground">Customers belong to the group while they, or an organization they are a member of, have an active subscription to or a grant of one of these products.</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Members are added by hand.{manage ? ' Edit the group to add customers automatically by product.' : ''}</p>
            )}
          </Card>
          <Card title="Unlocks" padded={false}>
            {g.resources.length ? (
              <ul className="divide-y">
                {g.resources.map((r) => {
                  const Icon = kindMeta(r.kind).icon;
                  const body = (
                    <>
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      {r.status !== 'active' && <StatusBadge status={r.status} />}
                    </>
                  );
                  return (
                    <li key={r.id}>
                      {can('access.resources.view') ? (
                        <Link to={`/content/resources/${r.id}`} className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/40">
                          {body}
                        </Link>
                      ) : (
                        <span className="flex items-center gap-2 px-4 py-2.5 text-sm">{body}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="space-y-3 p-4">
                <p className="text-sm text-muted-foreground">No protected content names this group yet.</p>
                {can('access.resources.manage') && (
                  <ButtonLink to="/content/resources/new" size="sm">
                    Protect content
                  </ButtonLink>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
      {editing && <GroupDialog group={g} onClose={() => setEditing(false)} />}
    </>
  );
}
