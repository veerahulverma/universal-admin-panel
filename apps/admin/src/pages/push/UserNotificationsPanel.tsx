import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bell, Monitor, Send, Smartphone } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { Badge, Button, ButtonLink, Callout, Card, DataTable, EmptyState, ErrorState, Pagination, Skeleton, When } from '../../components/ui';
import { browserName, type PushChannels } from './shared';

interface UserNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  read_at: string | null;
  created_at: string;
  push_sent: number;
  push_failed: number;
  push_pending: number;
}

function PushOutcome({ n }: { n: UserNotification }) {
  if (n.push_pending) return <Badge tone="info">Sending</Badge>;
  if (n.push_sent) return <Badge tone="success">{n.push_sent === 1 ? 'Pushed' : `Pushed to ${n.push_sent}`}</Badge>;
  if (n.push_failed) return <Badge tone="danger">Push failed</Badge>;
  return <span className="text-muted-foreground">Not pushed</span>;
}

/** A customer's notifications and the push channels that reach them (user page tab). */
export function UserNotificationsPanel({ userId, canSend, onSend }: { userId: string; canSend: boolean; onSend: () => void }) {
  const [page, setPage] = useState(1);
  const channels = useQuery({ queryKey: ['user-push-channels', userId], queryFn: () => api.get<PushChannels>(`/api/admin/users/${userId}/push-channels`) });
  const list = useQuery({
    queryKey: ['user-notifications', userId, page],
    queryFn: ({ signal }) => api.get<Page<UserNotification>>('/api/admin/user-notifications', { userId, page, pageSize: 10 }, signal),
    placeholderData: keepPreviousData,
  });
  const c = channels.data;
  const appProviders = c?.providers.filter((p) => p.targets === 'users') ?? [];

  return (
    <div className="space-y-4">
      <Card title="Push channels" description="Where push notifications reach this customer.">
        {channels.isLoading ? (
          <Skeleton className="h-16" />
        ) : channels.error ? (
          <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
        ) : c ? (
          <div className="space-y-3">
            {!c.pushEnabled && (
              <Callout tone="warning" action={<ButtonLink to="/platform/settings/notifications" size="sm">Settings</ButtonLink>}>
                Push notifications are turned off; notifications only appear in the notification center.
              </Callout>
            )}
            {c.browsers.length === 0 && c.devices.length === 0 && appProviders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No browser or app is subscribed yet. Notifications still appear in the customer's notification center.</p>
            ) : (
              <ul className="divide-y rounded-ui-sm border">
                {c.browsers.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{browserName(b.userAgent)}</span>
                    <span className="text-xs text-muted-foreground">{b.lastSuccessAt ? <>Last push <When value={b.lastSuccessAt} /></> : <>Subscribed <When value={b.createdAt} /></>}</span>
                  </li>
                ))}
                {c.devices.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate capitalize">
                      {d.platform} app <span className="normal-case text-muted-foreground">via {d.provider}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{d.lastSuccessAt ? <>Last push <When value={d.lastSuccessAt} /></> : <>Registered <When value={d.createdAt} /></>}</span>
                  </li>
                ))}
                {appProviders.map((p) => (
                  <li key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{p.name}</span>
                    <span className="text-xs text-muted-foreground">Reaches the customer's apps by their id</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Card>

      <Card
        title="Notifications"
        description="Sent to this customer by you, by automatic alerts and by push campaigns."
        padded={false}
        actions={
          canSend && (
            <Button size="sm" icon={<Send className="size-4" />} onClick={onSend}>
              Send notification
            </Button>
          )
        }
      >
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Notifications"
              rows={list.data?.data}
              rowKey={(n) => n.id}
              loading={list.isLoading}
              fetching={list.isFetching && !list.isLoading}
              empty={<EmptyState icon={<Bell />} title="No notifications yet" description="Send one, or turn on automatic notifications for payments and renewals in Settings → Notifications." />}
              columns={[
                {
                  key: 'title',
                  header: 'Notification',
                  cell: (n) => (
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{n.title}</span>
                      {n.body && <span className="block truncate text-xs text-muted-foreground">{n.body}</span>}
                    </span>
                  ),
                },
                { key: 'push', header: 'Push', cell: (n) => <PushOutcome n={n} /> },
                { key: 'read', header: 'Read', cell: (n) => (n.read_at ? <When value={n.read_at} /> : <span className="text-muted-foreground">Unread</span>) },
                { key: 'sent', header: 'Sent', cell: (n) => <When value={n.created_at} /> },
              ]}
            />
            {list.data && list.data.total > list.data.pageSize && <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </div>
  );
}
