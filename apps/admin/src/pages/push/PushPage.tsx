import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, Monitor, Plus, RadioTower, Settings, Smartphone } from 'lucide-react';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { num } from '../../lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Pagination, Select, Skeleton, Textarea, When, useConfirm } from '../../components/ui';
import { StatusPill } from '../growth/shared';
import { SEVERITIES, type Audience, type PushCampaign, type PushOverview } from './shared';

interface AudienceOptions {
  segments: { id: string; name: string }[];
  products: { id: string; name: string; kind: string }[];
}

const audienceOf = (value: string): Audience | null => {
  if (value === 'all') return { type: 'all' };
  const [type, id] = value.split(':');
  if (type === 'segment' && id) return { type: 'segment', segmentId: id };
  if (type === 'product' && id) return { type: 'product', productId: id };
  return null;
};

function ChannelsCard({ overview }: { overview: PushOverview }) {
  const connected = overview.providers.filter((p) => p.configured);
  return (
    <Card title="Delivery channels" description="Every push also appears in the customer's in-app notification center.">
      <div className="space-y-3">
        {!overview.pushEnabled && (
          <Callout tone="warning" action={<ButtonLink to="/platform/settings/notifications" size="sm">Settings</ButtonLink>}>
            Push notifications are turned off. Notifications only appear in the notification center until you turn them on.
          </Callout>
        )}
        <ul className="divide-y rounded-ui-sm border">
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
            <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">Browser push</span> <span className="text-muted-foreground">(built in)</span>
            </span>
            <span className="text-muted-foreground">
              {num(overview.browsers.customers)} customer{overview.browsers.customers === 1 ? '' : 's'}, {num(overview.browsers.subscriptions)} browser{overview.browsers.subscriptions === 1 ? '' : 's'}
            </span>
          </li>
          {overview.providers.map((p) => (
            <li key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{p.name}</span>
                {p.plugin && <span className="text-muted-foreground"> (plugin)</span>}
                <span className="block text-xs text-muted-foreground">{p.configured ? (p.targets === 'devices' ? `${num(p.devices)} registered app installs. ${p.message}` : p.message) : p.message}</span>
              </span>
              <Badge tone={p.configured ? 'success' : 'warning'} dot>
                {p.configured ? 'Connected' : 'Not set up'}
              </Badge>
              {p.plugin && (
                <ButtonLink to={`/platform/plugins/${p.plugin}`} size="sm" variant="ghost">
                  Configure
                </ButtonLink>
              )}
            </li>
          ))}
        </ul>
        {connected.length === 0 && (
          <p className="text-sm text-muted-foreground">
            To reach your customers' phones and apps, activate the <strong className="font-medium text-foreground">Push notifications</strong> plugin under Integrations → Plugins and add your OneSignal or
            Firebase credentials.{' '}
            <ButtonLink to="/platform/plugins/push-notifications" size="sm" variant="ghost" className="align-baseline">
              Open the plugin
            </ButtonLink>
          </p>
        )}
      </div>
    </Card>
  );
}

function NewPushDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const empty = { title: '', body: '', link: '', severity: 'info', kind: 'announcement', audience: 'all', when: 'now', scheduledAt: '' };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const options = useQuery({ queryKey: ['push-audience-options'], queryFn: () => api.get<AudienceOptions>('/api/admin/push/audience-options'), enabled: open });
  const audience = audienceOf(form.audience);
  const preview = useQuery({
    queryKey: ['push-audience-preview', form.audience, form.kind],
    queryFn: () => api.post<{ recipients: number; reachable: number }>('/api/admin/push/audience-preview', { audience, kind: form.kind }),
    enabled: open && Boolean(audience),
  });
  useEffect(() => {
    if (!open) {
      setForm(empty);
      setErrors({});
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useAction(
    () =>
      api.post<PushCampaign>('/api/admin/push/campaigns', {
        title: form.title.trim(),
        ...(form.body.trim() ? { body: form.body.trim() } : {}),
        ...(form.link.trim() ? { link: form.link.trim() } : {}),
        severity: form.severity,
        kind: form.kind,
        audience,
        ...(form.when === 'later' && form.scheduledAt ? { scheduledAt: new Date(form.scheduledAt).toISOString() } : {}),
      }),
    {
      success: (c) => (c.scheduledAt ? 'Push notification scheduled' : 'Push notification is being sent'),
      invalidate: [['push-campaigns']],
      onSuccess: () => onOpenChange(false),
      onError: (err) => {
        setError(errorMessage(err));
        if (err instanceof ApiError) setErrors(err.fieldErrors());
      },
    },
  );

  const audienceOptions = [
    { value: 'all', label: 'All customers' },
    ...(options.data?.segments.map((s) => ({ value: `segment:${s.id}`, label: `Segment: ${s.name}` })) ?? []),
    ...(options.data?.products.map((p) => ({ value: `product:${p.id}`, label: `Customers with ${p.name}` })) ?? []),
  ];
  const p = preview.data;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New push notification"
      description="Sent to every customer in the audience: as a push to their browsers and apps, and in their notification center."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-push" loading={create.isPending} disabled={!form.title.trim() || !audience || (form.when === 'later' && !form.scheduledAt)}>
            {form.when === 'later' ? 'Schedule' : 'Send now'}
          </Button>
        </>
      }
    >
      <form
        id="new-push"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setErrors({});
          create.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Title" htmlFor="np-title" error={errors.title} required>
          <Input id="np-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} autoFocus placeholder="New: export to Excel" />
        </Field>
        <Field label="Message" htmlFor="np-body" hint="Keep it short; phones show about two lines" error={errors.body}>
          <Textarea id="np-body" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={1000} />
        </Field>
        <Field label="Link" htmlFor="np-link" hint="Opened when the notification is tapped" error={errors.link}>
          <Input id="np-link" type="url" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://app.example.com/whats-new" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Audience" htmlFor="np-audience" error={errors['audience'] ?? errors['audience.segmentId'] ?? errors['audience.productId']} required>
            <Select id="np-audience" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} options={audienceOptions} />
          </Field>
          <Field label="Kind" htmlFor="np-kind" hint={form.kind === 'marketing' ? 'Only customers who consented to marketing' : 'Account and service news, to everyone in the audience'}>
            <Select
              id="np-kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              options={[
                { value: 'announcement', label: 'Announcement' },
                { value: 'marketing', label: 'Marketing (promotions)' },
              ]}
            />
          </Field>
          <Field label="Importance" htmlFor="np-severity">
            <Select id="np-severity" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} options={SEVERITIES} />
          </Field>
          <Field label="When" htmlFor="np-when">
            <Select id="np-when" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} options={[{ value: 'now', label: 'Send now' }, { value: 'later', label: 'Schedule for later' }]} />
          </Field>
          {form.when === 'later' && (
            <Field label="Send at" htmlFor="np-at" error={errors.scheduledAt} className="sm:col-span-2" required>
              <Input id="np-at" type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
            </Field>
          )}
        </div>
        <div role="status" className="rounded-ui-sm border bg-muted/40 px-3 py-2 text-sm">
          {preview.isLoading ? (
            <Skeleton className="h-5 w-2/3" />
          ) : preview.error ? (
            <span className="text-danger">{errorMessage(preview.error)}</span>
          ) : p ? (
            <>
              Reaches <strong>{num(p.recipients)}</strong> customer{p.recipients === 1 ? '' : 's'}; <strong>{num(p.reachable)}</strong> of them can get a push right now (a browser or app). Everyone else
              finds it in their notification center.
            </>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}

export default function PushPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const manage = can('notifications.campaigns.manage');
  const overview = useQuery({ queryKey: ['push-overview'], queryFn: () => api.get<PushOverview>('/api/admin/push/overview') });
  const list = useQuery({
    queryKey: ['push-campaigns', page],
    queryFn: ({ signal }) => api.get<Page<PushCampaign>>('/api/admin/push/campaigns', { page, pageSize: 25 }, signal),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.data.some((c) => c.status === 'sending' || c.status === 'scheduled' || c.stats.pushPending > 0) ? 10_000 : false),
  });
  const cancel = useAction((id: string) => api.post(`/api/admin/push/campaigns/${id}/cancel`), { success: 'Push notification cancelled', invalidate: [['push-campaigns']] });

  return (
    <>
      <PageHeader
        title="Push notifications"
        description="Send a push notification to many customers at once. Automatic notifications for payments, renewals and trials are set up in Settings → Notifications."
        actions={
          <>
            <ButtonLink to="/platform/settings/notifications" icon={<Settings className="size-4" />}>
              Automatic notifications
            </ButtonLink>
            {manage && (
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New push notification
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-4">
        {overview.isLoading ? <Skeleton className="h-32" /> : overview.error ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : overview.data && <ChannelsCard overview={overview.data} />}
        <Card title="Sent and scheduled" padded={false}>
          {list.error ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <>
              <DataTable
                caption="Push notifications"
                rows={list.data?.data}
                rowKey={(c) => c.id}
                loading={list.isLoading}
                fetching={list.isFetching && !list.isLoading}
                empty={<EmptyState icon={<RadioTower />} title="No push notifications yet" description="Announce a feature, a maintenance window or an offer to all customers, a segment, or the customers of a plan." />}
                columns={[
                  {
                    key: 'title',
                    header: 'Notification',
                    cell: (c) => (
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{c.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{c.audienceLabel}</span>
                      </span>
                    ),
                  },
                  { key: 'kind', header: 'Kind', cell: (c) => <Badge tone={c.kind === 'marketing' ? 'primary' : 'neutral'}>{c.kind === 'marketing' ? 'Marketing' : 'Announcement'}</Badge> },
                  { key: 'status', header: 'Status', cell: (c) => <StatusPill status={c.status} /> },
                  {
                    key: 'reach',
                    header: 'Delivered',
                    cell: (c) => (
                      <span className="text-sm tabular">
                        {num(c.stats.notified)} notified · {num(c.stats.pushSent)} pushed
                        {c.stats.pushFailed > 0 && <span className="text-danger"> · {num(c.stats.pushFailed)} failed</span>}
                        <span className="block text-xs text-muted-foreground">{num(c.stats.read)} read</span>
                      </span>
                    ),
                  },
                  {
                    key: 'when',
                    header: 'When',
                    cell: (c) =>
                      c.finishedAt && c.status === 'sent' ? (
                        <span>
                          Sent <When value={c.finishedAt} />
                        </span>
                      ) : c.status === 'scheduled' && c.scheduledAt ? (
                        <span>
                          Scheduled <When value={c.scheduledAt} relative={false} />
                        </span>
                      ) : (
                        <span>
                          Created <When value={c.createdAt} />
                        </span>
                      ),
                  },
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    align: 'right',
                    cell: (c) =>
                      manage && (c.status === 'scheduled' || c.status === 'sending') ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Ban className="size-4" />}
                          loading={cancel.isPending && cancel.variables === c.id}
                          onClick={async () => {
                            if ((await confirm({ title: `Cancel “${c.title}”?`, description: c.status === 'sending' ? 'Customers who already received it keep it; nobody else will.' : 'It will not be sent.', confirmLabel: 'Cancel it', tone: 'danger' })).confirmed) cancel.mutate(c.id);
                          }}
                        >
                          Cancel
                        </Button>
                      ) : null,
                  },
                ]}
              />
              {list.data && list.data.total > list.data.pageSize && <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
            </>
          )}
        </Card>
      </div>
      <NewPushDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
