import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderLock, Plus, UsersRound, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Select, Skeleton, Switch, When, useConfirm } from '../../components/ui';
import { StateBadge, decisionDetail, kindMeta, type Decision, type DecisionState, type ProductRef, type ResourceKind, type UserGroup } from './shared';

interface UserGroupMembership {
  id: string;
  name: string;
  description: string;
  autoProducts: ProductRef[];
  membership: { manual: boolean; automatic: boolean; since: string };
}

interface ContentItem extends Decision {
  id: string;
  kind: ResourceKind;
  title: string;
  path: string | null;
  status: string;
}

const ORDER: DecisionState[] = ['available', 'scheduled', 'ended', 'inactive', 'disabled', 'locked'];

function GroupsCard({ userId }: { userId: string }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('customers.groups.manage');
  const [choice, setChoice] = useState('');
  const groups = useQuery({ queryKey: ['user-access-groups', userId], queryFn: () => api.get<{ data: UserGroupMembership[] }>('/api/admin/user-groups', { userId }) });
  const all = useQuery({ queryKey: ['user-groups', ''], queryFn: () => api.get<{ data: UserGroup[] }>('/api/admin/user-groups'), enabled: manage });
  const invalidate = [['user-access-groups', userId], ['user-access-content', userId], ['user-groups'], ['user-group'], ['user-group-members']];
  const add = useAction((groupId: string) => api.post(`/api/admin/user-groups/${groupId}/members`, { users: [userId] }), {
    success: 'Added to the group',
    invalidate,
    onSuccess: () => setChoice(''),
  });
  const remove = useAction((groupId: string) => api.delete(`/api/admin/user-groups/${groupId}/members/${userId}`), { success: 'Removed from the group', invalidate });

  const member = new Set((groups.data?.data ?? []).filter((g) => g.membership.manual).map((g) => g.id));
  const addable = (all.data?.data ?? []).filter((g) => !member.has(g.id));

  return (
    <Card title="User groups" description="Added by hand, or automatically while they hold a group’s product." padded={false}>
      {groups.isLoading ? (
        <div className="p-4">
          <Skeleton className="h-16" />
        </div>
      ) : groups.error ? (
        <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
      ) : groups.data!.data.length === 0 ? (
        <EmptyState icon={<UsersRound />} title="Not in any group" className="py-8" />
      ) : (
        <ul className="divide-y">
          {groups.data!.data.map((g) => (
            <li key={g.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <Link to={`/customers/groups/${g.id}`} className="block truncate text-sm font-medium hover:underline">
                  {g.name}
                </Link>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {g.membership.manual && <Badge tone="primary">added</Badge>}
                  {g.membership.automatic && <Badge tone="info">automatic{g.autoProducts.length ? ` · ${g.autoProducts.map((p) => p.name ?? p.key).join(', ')}` : ''}</Badge>}
                  <span>
                    since <When value={g.membership.since} />
                  </span>
                </span>
              </span>
              {manage && g.membership.manual && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove from ${g.name}`}
                  onClick={async () => {
                    const res = await confirm({
                      title: `Remove from ${g.name}?`,
                      description: g.membership.automatic ? 'They stay in the group automatically while they hold its product.' : 'They lose the content this group unlocks for them.',
                      confirmLabel: 'Remove',
                      tone: 'danger',
                    });
                    if (res.confirmed) remove.mutate(g.id);
                  }}
                >
                  <X className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && addable.length > 0 && (
        <form
          className="flex flex-wrap items-center gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (choice) add.mutate(choice);
          }}
        >
          <Select aria-label="Group" className="min-w-0 flex-1 sm:flex-none sm:w-64" value={choice} onChange={(e) => setChoice(e.target.value)} placeholder="Add to a group…" options={addable.map((g) => ({ value: g.id, label: g.name }))} />
          <Button type="submit" variant="outline" icon={<Plus className="size-4" />} loading={add.isPending} disabled={!choice}>
            Add
          </Button>
        </form>
      )}
    </Card>
  );
}

function ContentCard({ userId }: { userId: string }) {
  const [showLocked, setShowLocked] = useState(false);
  const content = useQuery({
    queryKey: ['user-access-content', userId],
    queryFn: () => api.get<{ inactive: boolean; data: ContentItem[] }>(`/api/admin/access/users/${userId}/content`),
  });
  const items = (content.data?.data ?? []).filter((i) => showLocked || i.state !== 'locked').sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  const locked = (content.data?.data ?? []).filter((i) => i.state === 'locked').length;

  return (
    <Card
      title="Protected content"
      description="What this customer can open now, what opens for them later, and what has ended."
      padded={false}
      actions={locked > 0 && <Switch checked={showLocked} onCheckedChange={setShowLocked} label={`Show locked (${locked})`} />}
    >
      {content.isLoading ? (
        <div className="p-4">
          <Skeleton className="h-24" />
        </div>
      ) : content.error ? (
        <ErrorState error={content.error} onRetry={() => void content.refetch()} />
      ) : (
        <>
          {content.data!.inactive && (
            <div className="p-3">
              <Callout tone="warning">This account is suspended, banned or unverified, so it cannot open any protected content.</Callout>
            </div>
          )}
          {items.length === 0 ? (
            <EmptyState icon={<FolderLock />} title={content.data!.data.length ? 'Nothing open for this customer' : 'No protected content yet'} className="py-8" />
          ) : (
            <ul className="divide-y">
              {items.map((i) => {
                const Icon = kindMeta(i.kind).icon;
                return (
                  <li key={i.id}>
                    <Link to={`/content/resources/${i.id}`} className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{i.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{decisionDetail(i)}</span>
                      </span>
                      <StateBadge state={i.state} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * A customer's groups (add or remove them) and the protected content they can
 * open now or later. Mount it on the user page; each part shows only with its
 * permission (customers.groups.view, access.resources.view).
 */
export function UserAccessPanel({ userId }: { userId: string }) {
  const { can } = useAuth();
  const showGroups = can('customers.groups.view');
  const showContent = can('access.resources.view');
  if (!showGroups && !showContent) return null;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {showGroups && <GroupsCard userId={userId} />}
      {showContent && <ContentCard userId={userId} />}
    </div>
  );
}
