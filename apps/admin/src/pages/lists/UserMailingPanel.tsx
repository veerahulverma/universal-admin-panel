import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Select, StatusBadge, When, useConfirm, useToast } from '../../components/ui';
import { STOP_REASONS, triggerLabel } from '../autoresponders/shared';
import { BLOCK_LABEL, SOURCE_LABEL, useMailingLists } from './shared';

interface Membership {
  list_id: string;
  key: string;
  name: string;
  visibility: 'public' | 'hidden';
  status: 'pending' | 'subscribed' | 'unsubscribed';
  source: string;
  consented_at: string | null;
  subscribed_at: string | null;
  unsubscribed_at: string | null;
  blocked_reason: string | null;
}

interface Enrollment {
  id: string;
  sequence_id: string;
  name: string;
  trigger_type: string;
  status: 'active' | 'completed' | 'stopped';
  stop_reason: string | null;
  steps_sent: number;
  next_run_at: string | null;
  enrolled_at: string;
}

function MembershipsCard({ userId }: { userId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can('marketing.lists.manage');
  const memberships = useQuery({ queryKey: ['user-mailing-lists', userId], queryFn: () => api.get<{ data: Membership[] }>('/api/admin/lists/memberships', { userId }) });
  const lists = useMailingLists(manage);
  const invalidate = [['user-mailing-lists', userId], ['mailing-lists']];
  const add = useAction((listId: string) => api.post<{ results: { status?: string; error?: string }[] }>(`/api/admin/lists/${listId}/members`, { userIds: [userId] }), {
    invalidate,
    onSuccess: (r) => (r.results[0]?.error ? toast.error('Not added', r.results[0].error) : toast.success(r.results[0]?.status === 'pending' ? 'Confirmation email sent' : 'Added to the list')),
  });
  const remove = useAction((listId: string) => api.delete(`/api/admin/lists/${listId}/members/${userId}`), { success: 'Unsubscribed from the list', invalidate });
  const rows = memberships.data?.data ?? [];
  const joinable = (lists.data?.data ?? []).filter((l) => !rows.some((m) => m.list_id === l.id));
  return (
    <Card
      title="Mailing lists"
      padded={false}
      actions={
        manage &&
        joinable.length > 0 && (
          <Select aria-label="Add to a list" className="w-auto" value="" onChange={(e) => e.target.value && add.mutate(e.target.value)} placeholder="Add to a list…" options={joinable.map((l) => ({ value: l.id, label: l.name }))} />
        )
      }
    >
      {memberships.error ? (
        <ErrorState error={memberships.error} onRetry={() => void memberships.refetch()} />
      ) : (
        <DataTable
          caption="Mailing lists"
          rows={memberships.data?.data}
          loading={memberships.isLoading}
          rowKey={(m) => m.list_id}
          rowHref={(m) => `/growth/lists/${m.list_id}`}
          empty={<EmptyState title="Not on any mailing list" />}
          columns={[
            { key: 'name', header: 'List', cell: (m) => m.name },
            { key: 'status', header: 'Status', cell: (m) => <Badge tone={m.status === 'subscribed' ? 'success' : m.status === 'pending' ? 'info' : 'neutral'}>{m.status}</Badge> },
            { key: 'source', header: 'Joined by', priority: 'low', cell: (m) => SOURCE_LABEL[m.source] ?? m.source },
            {
              key: 'reach',
              header: 'List email',
              cell: (m) => (m.status !== 'subscribed' ? <span className="text-muted-foreground">—</span> : m.blocked_reason ? <Badge tone="warning">{BLOCK_LABEL[m.blocked_reason] ?? m.blocked_reason}</Badge> : <Badge tone="success">Receives it</Badge>),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (m) =>
                manage && m.status !== 'unsubscribed' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if ((await confirm({ title: `Unsubscribe from ${m.name}?`, description: 'Recorded in the list’s consent record; only the customer can join again.', tone: 'danger', confirmLabel: 'Unsubscribe' })).confirmed) remove.mutate(m.list_id);
                    }}
                  >
                    Unsubscribe
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </Card>
  );
}

function EnrollmentsCard({ userId }: { userId: string }) {
  const enrollments = useQuery({ queryKey: ['user-sequence-enrollments', userId], queryFn: () => api.get<{ data: Enrollment[] }>('/api/admin/email/sequences/enrollments', { userId }) });
  return (
    <Card title="Autoresponders" padded={false}>
      {enrollments.error ? (
        <ErrorState error={enrollments.error} onRetry={() => void enrollments.refetch()} />
      ) : (
        <DataTable
          caption="Autoresponder enrolments"
          rows={enrollments.data?.data}
          loading={enrollments.isLoading}
          rowKey={(e) => e.id}
          rowHref={(e) => `/growth/email/autoresponders/${e.sequence_id}`}
          empty={<EmptyState title="Not in any autoresponder" />}
          columns={[
            {
              key: 'name',
              header: 'Autoresponder',
              cell: (e) => (
                <span className="block min-w-0">
                  <span className="block truncate">{e.name}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">{triggerLabel(e.trigger_type)}</span>
                </span>
              ),
            },
            { key: 'status', header: 'Status', cell: (e) => (e.status === 'stopped' ? <Badge tone="warning">{STOP_REASONS[e.stop_reason ?? ''] ?? 'stopped'}</Badge> : <StatusBadge status={e.status === 'active' ? 'running' : 'completed'} />) },
            { key: 'sent', header: 'Emails sent', align: 'right', cell: (e) => <span className="tabular">{e.steps_sent}</span> },
            { key: 'next', header: 'Next email', priority: 'low', cell: (e) => (e.next_run_at ? <When value={e.next_run_at} /> : <span className="text-muted-foreground">—</span>) },
            { key: 'enrolled', header: 'Enrolled', cell: (e) => <When value={e.enrolled_at} /> },
          ]}
        />
      )}
    </Card>
  );
}

/**
 * For the user profile: the customer's mailing lists (with consent and whether list email reaches
 * them) and their autoresponder enrolments. Each part shows only with its permission.
 */
export function UserMailingPanel({ userId }: { userId: string }) {
  const { can } = useAuth();
  const lists = can('marketing.lists.view');
  const sequences = can('email.autoresponders.view');
  if (!lists && !sequences) return null;
  return (
    <div className="space-y-4">
      {lists && <MembershipsCard userId={userId} />}
      {sequences && <EnrollmentsCard userId={userId} />}
      <p className="text-xs text-muted-foreground">
        General marketing consent and suppressions are on the Email tab; lists are managed under <Link to="/growth/lists" className="text-primary hover:underline">Marketing → Mailing lists</Link>.
      </p>
    </div>
  );
}
