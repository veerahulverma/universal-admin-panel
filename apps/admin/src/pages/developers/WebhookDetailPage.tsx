import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Pencil, Power, PowerOff, RotateCw, Send, Trash2 } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { dateTime, num } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  DataTable,
  EmptyState,
  ErrorState,
  JsonView,
  KeyValue,
  Menu,
  Modal,
  Mono,
  PageHeader,
  PageSkeleton,
  Pagination,
  Select,
  Skeleton,
  StatusBadge,
  Toolbar,
  When,
  useConfirm,
  useToast,
  type Column,
} from '../../components/ui';
import { HttpStatus, ms, SecretOnceDialog, useEventTypes } from './shared';
import { EndpointFormDialog, type Endpoint } from './webhook-form';
import { EndpointState } from './WebhooksPage';

interface Delivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryDetail extends Delivery {
  endpoint_url: string;
  endpoint_enabled: boolean;
  endpoint_org_id: string | null;
  payload: Record<string, unknown> | null;
}

type AttemptResult = { ok?: boolean; status?: number | null; error?: string | null } | null;

const DEFAULTS = { status: '', eventType: '', page: 1, pageSize: 20 };

function describeAttempt(r: AttemptResult): { ok: boolean; message: string } {
  if (!r || r.ok === undefined) return { ok: false, message: 'Not sent: the endpoint is disabled or has no signing secret.' };
  if (r.ok) return { ok: true, message: `Your endpoint answered HTTP ${r.status}.` };
  return { ok: false, message: r.error ?? `HTTP ${r.status}` };
}

function DeliveryDialog({ deliveryId, onClose, endpointEnabled }: { deliveryId: string | null; onClose: () => void; endpointEnabled: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const d = useQuery({ queryKey: ['developers', 'delivery', deliveryId], queryFn: () => api.get<DeliveryDetail>(`/api/admin/webhook-deliveries/${deliveryId}`), enabled: Boolean(deliveryId) });
  const retry = useAction(() => api.post<AttemptResult>(`/api/admin/webhook-deliveries/${deliveryId}/retry`), {
    invalidate: [['developers', 'deliveries'], ['developers', 'delivery', deliveryId], ['developers', 'webhook']],
    onSuccess: (r) => {
      const { ok, message } = describeAttempt(r);
      if (ok) toast.success('Redelivered', message);
      else toast.error('Redelivery failed', message);
    },
  });
  const v = d.data;
  return (
    <Modal
      open={Boolean(deliveryId)}
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={v ? <span className="font-mono text-base">{v.event_type}</span> : 'Delivery'}
      description={v ? `Delivery ${v.id}` : undefined}
      footer={
        can('developers.webhooks.manage') && v ? (
          <Button
            icon={<RotateCw className="size-4" />}
            loading={retry.isPending}
            disabled={v.status === 'pending' || !endpointEnabled}
            title={!endpointEnabled ? 'Enable the endpoint first' : v.status === 'pending' ? 'A retry is already scheduled' : undefined}
            onClick={() => retry.mutate()}
          >
            {v.status === 'succeeded' ? 'Send again' : 'Retry now'}
          </Button>
        ) : undefined
      }
    >
      {d.isLoading ? (
        <Skeleton className="h-64" />
      ) : d.error || !v ? (
        <ErrorState error={d.error} onRetry={() => void d.refetch()} />
      ) : (
        <div className="space-y-5">
          {v.error && (
            <Callout tone="danger" title="Last attempt failed">
              {v.error}
            </Callout>
          )}
          <KeyValue
            columns={3}
            items={[
              { label: 'Status', value: <StatusBadge status={v.status} /> },
              { label: 'Response', value: <HttpStatus status={v.response_status} /> },
              { label: 'Attempts', value: num(v.attempts) },
              { label: 'Duration', value: ms(v.duration_ms) },
              { label: 'Created', value: dateTime(v.created_at) },
              { label: v.delivered_at ? 'Delivered' : 'Next attempt', value: dateTime(v.delivered_at ?? v.next_attempt_at) },
              { label: 'Event ID', value: <Mono copy>{v.event_id}</Mono> },
              { label: 'Endpoint', value: <span className="break-all font-mono text-xs">{v.endpoint_url}</span> },
            ]}
          />
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Request</p>
            <CodeBlock
              code={[
                `POST ${v.endpoint_url}`,
                'Content-Type: application/json',
                `Steward-Event-Id: ${v.event_id}`,
                `Steward-Event-Type: ${v.event_type}`,
                `Steward-Delivery-Id: ${v.id}`,
                'Steward-Signature: t=<timestamp>,v1=<HMAC-SHA256, computed for each attempt>',
              ].join('\n')}
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Payload</p>
            {v.payload ? <JsonView value={v.payload} className="max-h-80 overflow-y-auto" /> : <p className="text-sm text-muted-foreground">The event was removed by the retention policy.</p>}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Response body {v.response_body ? '(first 2,000 characters)' : ''}</p>
            {v.response_body ? <CodeBlock code={v.response_body} className="max-h-60 overflow-y-auto" /> : <p className="text-sm text-muted-foreground">No response body.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function WebhookDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const [state, setState] = useUrlState(DEFAULTS);
  const [editing, setEditing] = useState(false);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const types = useEventTypes();
  const manage = can('developers.webhooks.manage');

  const ep = useQuery({ queryKey: ['developers', 'webhook', id], queryFn: () => api.get<Endpoint>(`/api/admin/webhooks/${id}`) });
  const deliveryQuery = { status: state.status || undefined, eventType: state.eventType || undefined, page: Number(state.page) || 1, pageSize: Number(state.pageSize) || 20 };
  const deliveries = useQuery({
    queryKey: ['developers', 'deliveries', id, deliveryQuery],
    queryFn: ({ signal }) => api.get<Page<Delivery>>(`/api/admin/webhooks/${id}/deliveries`, deliveryQuery, signal),
    placeholderData: keepPreviousData,
    // Pending retries settle in the background; keep the list fresh while some are scheduled.
    refetchInterval: (q) => (q.state.data?.data.some((d) => d.status === 'pending') ? 15_000 : false),
  });
  const invalidate = [['developers', 'webhook', id], ['developers', 'webhooks'], ['developers', 'deliveries', id]];

  const test = useAction(() => api.post<{ deliveryId: string } & AttemptResult>(`/api/admin/webhooks/${id}/test`), {
    invalidate,
    onSuccess: (r) => {
      const { ok, message } = describeAttempt(r);
      if (ok) toast.success('Test event delivered', message);
      else toast.error('Test event failed', message);
    },
  });
  const setEnabled = useAction((enabled: boolean) => api.patch(`/api/admin/webhooks/${id}`, { enabled }), { success: (_r, enabled) => (enabled ? 'Endpoint enabled' : 'Endpoint disabled'), invalidate });
  const rotate = useAction(() => api.post<{ secret: string }>(`/api/admin/webhooks/${id}/rotate-secret`), { onSuccess: (r) => setSecret(r.secret) });
  const remove = useAction(() => api.delete(`/api/admin/webhooks/${id}`), {
    success: 'Endpoint deleted',
    invalidate: [['developers', 'webhooks']],
    onSuccess: () => navigate('/developers/webhooks', { replace: true }),
  });

  if (ep.isLoading) return <PageSkeleton />;
  if (ep.error || !ep.data) return <ErrorState error={ep.error} onRetry={() => void ep.refetch()} />;
  const e = ep.data;
  const host = (() => {
    try {
      return new URL(e.url).host;
    } catch {
      return e.url;
    }
  })();
  const descriptions = new Map((types.data?.data ?? []).map((t) => [t.type, t.description]));

  const columns: Column<Delivery>[] = [
    {
      key: 'event',
      header: 'Event',
      cell: (d) => (
        <button type="button" className="min-w-0 text-left" onClick={() => setDelivery(d.id)}>
          <span className="block truncate font-mono text-xs font-medium hover:underline">{d.event_type}</span>
          <span className="block truncate font-mono text-2xs text-muted-foreground">{d.event_id}</span>
        </button>
      ),
    },
    { key: 'status', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
    { key: 'response', header: 'Response', cell: (d) => <HttpStatus status={d.response_status} error={d.error} /> },
    { key: 'attempts', header: 'Attempts', align: 'right', cell: (d) => <span className="tabular">{d.attempts}</span> },
    { key: 'duration', header: 'Duration', align: 'right', priority: 'low', cell: (d) => <span className="tabular">{ms(d.duration_ms)}</span> },
    {
      key: 'when',
      header: 'Delivered / next try',
      cell: (d) => (d.delivered_at ? <When value={d.delivered_at} /> : d.next_attempt_at ? <span className="text-warning">retry <When value={d.next_attempt_at} /></span> : <When value={d.updated_at} />),
    },
    { key: 'created', header: 'Created', priority: 'low', cell: (d) => <When value={d.created_at} /> },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Webhooks', to: '/developers/webhooks' }, { label: host }]}
        documentTitle={`Webhook ${host}`}
        title={<span className="block truncate">{e.description ? e.description : host}</span>}
        meta={
          <>
            <EndpointState endpoint={e} />
            <span className="max-w-full truncate font-mono text-xs text-muted-foreground">{e.url}</span>
          </>
        }
        actions={
          manage && (
            <>
              <Button variant="outline" icon={<Send className="size-4" />} loading={test.isPending} disabled={!e.enabled} title={!e.enabled ? 'Enable the endpoint first' : undefined} onClick={() => test.mutate()}>
                Send test event
              </Button>
              <Menu
                trigger={
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
                items={[
                  { label: 'Edit endpoint', icon: <Pencil className="size-4" />, onSelect: () => setEditing(true) },
                  e.enabled
                    ? {
                        label: 'Disable',
                        icon: <PowerOff className="size-4" />,
                        onSelect: async () => {
                          if ((await confirm({ title: 'Disable this endpoint?', description: 'New events are not delivered while it is disabled. Re-enable it at any time.', confirmLabel: 'Disable' })).confirmed) setEnabled.mutate(false);
                        },
                      }
                    : { label: 'Enable', icon: <Power className="size-4" />, onSelect: () => setEnabled.mutate(true) },
                  {
                    label: 'Roll signing secret',
                    icon: <KeyRound className="size-4" />,
                    onSelect: async () => {
                      const r = await confirm({ title: 'Roll the signing secret?', description: 'Deliveries are signed with the new secret immediately. Deliveries your application rejects until you update it are retried automatically.', confirmLabel: 'Roll secret' });
                      if (r.confirmed) rotate.mutate();
                    },
                  },
                  { separator: true, label: '' },
                  {
                    label: 'Delete endpoint',
                    icon: <Trash2 className="size-4" />,
                    danger: true,
                    onSelect: async () => {
                      const r = await confirm({ title: 'Delete this endpoint?', description: 'It stops receiving events and its delivery history is deleted. This cannot be undone.', tone: 'danger', confirmLabel: 'Delete', typeToConfirm: host });
                      if (r.confirmed) remove.mutate();
                    },
                  },
                ]}
              />
            </>
          )
        }
      />

      {!e.enabled && (
        <div className="mb-4">
          <Callout
            tone={e.disabled_reason ? 'danger' : 'warning'}
            title={e.disabled_reason ? 'Disabled automatically' : 'Disabled'}
            action={
              manage && (
                <Button size="sm" variant="outline" icon={<Power className="size-4" />} loading={setEnabled.isPending} onClick={() => setEnabled.mutate(true)}>
                  Re-enable
                </Button>
              )
            }
          >
            {e.disabled_reason ?? 'Events are not being delivered to this endpoint.'} Re-enabling resets the failure counter; failed deliveries can be retried below.
          </Callout>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Deliveries, 24 h', num(e.deliveries_24h), false],
          ['Failed, 24 h', num(e.failed_24h), e.failed_24h > 0],
          ['Pending retries', num(e.pending ?? 0), false],
          ['Failed in a row', num(e.consecutive_failures), e.consecutive_failures > 0],
        ].map(([label, value, bad]) => (
          <div key={String(label)} className="rounded-ui border bg-surface p-4 shadow-ui">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className={bad ? 'mt-1 text-2xl font-semibold tabular text-danger' : 'mt-1 text-2xl font-semibold tabular'}>{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Deliveries" padded={false} className="xl:col-span-2">
          <Toolbar>
            <Select aria-label="Status" className="w-auto" value={String(state.status ?? '')} onChange={(ev) => setState({ status: ev.target.value })} placeholder="Any status" options={[{ value: 'succeeded', label: 'Succeeded' }, { value: 'pending', label: 'Pending retry' }, { value: 'failed', label: 'Failed' }]} />
            <Select
              aria-label="Event type"
              className="w-auto max-w-full"
              value={String(state.eventType ?? '')}
              onChange={(ev) => setState({ eventType: ev.target.value })}
              placeholder="Any event"
              options={(types.data?.data ?? []).map((t) => t.type)}
            />
          </Toolbar>
          {deliveries.error ? (
            <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} />
          ) : (
            <DataTable
              caption="Deliveries"
              columns={columns}
              rows={deliveries.data?.data}
              rowKey={(d) => d.id}
              loading={deliveries.isLoading}
              fetching={deliveries.isFetching && !deliveries.isLoading}
              empty={<EmptyState title={state.status || state.eventType ? 'No deliveries match' : 'No deliveries yet'} description={state.status || state.eventType ? undefined : 'Send a test event to check that your endpoint responds.'} />}
            />
          )}
          {deliveries.data && <Pagination page={deliveries.data.page} pageSize={deliveries.data.pageSize} total={deliveries.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
        </Card>

        <div className="space-y-4">
          <Card title="Details">
            <KeyValue
              columns={1}
              items={[
                { label: 'Endpoint ID', value: <Mono copy>{e.id}</Mono> },
                { label: 'URL', value: <span className="break-all font-mono text-xs">{e.url}</span> },
                { label: 'Organization', value: e.org_id ? <Link className="text-primary hover:underline" to={`/customers/organizations/${e.org_id}`}>{e.org_name ?? e.org_id}</Link> : 'All organizations' },
                { label: 'API version', value: <code className="font-mono text-xs">{e.api_version}</code> },
                { label: 'Last delivery', value: e.last_delivery_at ? dateTime(e.last_delivery_at) : 'None yet' },
                { label: 'Created', value: dateTime(e.created_at) },
              ]}
            />
          </Card>
          <Card title="Subscribed events" padded={false}>
            {e.events.includes('*') ? (
              <p className="px-4 py-3 text-sm">All events</p>
            ) : (
              <ul className="divide-y">
                {e.events.map((ev) => (
                  <li key={ev} className="px-4 py-2">
                    <code className="font-mono text-xs">{ev}</code>
                    {descriptions.get(ev) && <span className="block text-xs text-muted-foreground">{descriptions.get(ev)}</span>}
                    {ev.endsWith('.*') && <Badge className="ml-2">group</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {editing && <EndpointFormDialog open onOpenChange={setEditing} existing={e} />}
      <DeliveryDialog deliveryId={delivery} onClose={() => setDelivery(null)} endpointEnabled={e.enabled} />
      <SecretOnceDialog
        open={Boolean(secret)}
        onClose={() => setSecret(null)}
        title="New signing secret"
        description="Deliveries are now signed with this secret."
        secret={secret}
        note={<p className="text-sm text-muted-foreground">Update your application now. The Node SDK accepts <code className="font-mono">webhookSecret: [newSecret, oldSecret]</code>, so requests signed just before the switch still verify while you deploy.</p>}
      />
    </>
  );
}
