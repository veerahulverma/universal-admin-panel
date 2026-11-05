import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Save, Zap } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  JsonView,
  KeyValue,
  Modal,
  PageHeader,
  PageSkeleton,
  Pagination,
  Select,
  StatusBadge,
  Tabs,
  Toolbar,
  When,
  useConfirm,
  useToast,
} from '../../components/ui';
import { CapabilityList, GatewayFields, ModeBadge, TestResult, draftFrom, gatewayBody, type GatewayDraft, type GatewayRow, type GatewaysResponse } from './gateways';
import { fieldErrors } from './shared';

interface GatewayEvent {
  id: string;
  gateway_id: string;
  event_id: string;
  type: string;
  payload: unknown;
  status: string;
  error: string | null;
  attempts: number;
  received_at: string;
  processed_at: string | null;
}

/** Where to register the webhook in each provider's dashboard. */
const WEBHOOK_HELP: Record<string, string> = {
  stripe: 'In the Stripe dashboard, add an endpoint under Developers → Webhooks with this URL, then paste its signing secret (whsec_…) into the credentials.',
  paypal: 'In the PayPal developer dashboard, add a webhook for your app with this URL and paste the webhook ID into the credentials.',
  razorpay: 'In the Razorpay dashboard, add a webhook under Settings → Webhooks with this URL and the same secret you entered here.',
  sandbox: 'The sandbox signs its simulated webhooks with the secret above; nothing to register.',
};

function ConfigurationTab({ gw, adapters }: { gw: GatewayRow; adapters: GatewaysResponse['available'] }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const adapter = adapters.find((a) => a.key === gw.adapter);
  const [draft, setDraft] = useState<GatewayDraft | null>(adapter ? draftFrom(gw, adapter) : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const manage = can('billing.gateways.manage');
  const save = useAction((body: Record<string, unknown>) => api.patch<GatewayRow>(`/api/admin/gateways/${gw.id}`, body), {
    success: 'Gateway saved',
    invalidate: [['gateways']],
    onSuccess: (updated) => {
      setErrors({});
      setError(null);
      if (adapter) setDraft(draftFrom(updated, adapter));
    },
    onError: (err) => {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    },
  });

  if (!adapter || !draft) {
    return (
      <Callout tone="danger" title="The adapter for this gateway is not installed">
        It was provided by a plugin that is no longer active. Re-activate the plugin, or disable this gateway.
      </Callout>
    );
  }

  const submit = async () => {
    const body = gatewayBody(draft);
    if (body.mode === 'live' && gw.mode !== 'live') {
      const { confirmed } = await confirm({ title: `Switch ${gw.name} to live mode?`, description: 'Customers will be charged real money. Make sure the live credentials and webhook are in place.', confirmLabel: 'Go live', tone: 'danger', typeToConfirm: 'LIVE' });
      if (!confirmed) return;
    }
    if (Object.keys(body.secrets).length && gw.secrets.length) {
      const { confirmed } = await confirm({ title: 'Replace stored credentials?', description: `New values replace: ${Object.keys(body.secrets).join(', ')}. The old values cannot be recovered.`, confirmLabel: 'Replace' });
      if (!confirmed) return;
    }
    save.mutate(body);
  };

  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <GatewayFields adapter={adapter} gateway={gw} draft={draft} onChange={setDraft} errors={errors} error={error} disabled={!manage || save.isPending} />
        {manage && (
          <div className="mt-5 flex justify-end gap-2 border-t pt-4">
            <Button variant="outline" onClick={() => setDraft(draftFrom(gw, adapter))} disabled={save.isPending}>
              Discard changes
            </Button>
            <Button type="submit" icon={<Save className="size-4" />} loading={save.isPending}>
              Save gateway
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function EventsTab({ gw }: { gw: GatewayRow }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<GatewayEvent | null>(null);
  const query = { gatewayId: gw.id, status: status || undefined, page, pageSize: 25 };
  const events = useQuery({ queryKey: ['gateway-events', query], queryFn: ({ signal }) => api.get<Page<GatewayEvent>>('/api/admin/gateway-events', query, signal), placeholderData: keepPreviousData });
  return (
    <div className="space-y-4">
      <Card title="Webhook endpoint" description={WEBHOOK_HELP[gw.adapter] ?? 'Register this URL with the provider so payment updates reach the platform.'}>
        <div className="flex items-center gap-2 rounded-ui-sm border bg-muted/40 px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs">{gw.webhookUrl}</code>
          <CopyButton value={gw.webhookUrl} label="Copy webhook URL" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Signatures are verified with the stored secret, and each event is processed once even if the provider retries it.</p>
      </Card>
      <Card title="Received events" padded={false}>
        <Toolbar>
          <Select
            aria-label="Status"
            className="w-auto"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            placeholder="Any status"
            options={['received', 'processed', 'failed', 'ignored'].map((s) => ({ value: s, label: s }))}
          />
        </Toolbar>
        {events.error ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : (
          <DataTable
            caption="Gateway webhook events"
            rows={events.data?.data}
            loading={events.isLoading}
            fetching={events.isFetching && !events.isLoading}
            rowKey={(e) => e.id}
            empty={<EmptyState title="No webhook events yet" description="Events appear here when the provider calls the endpoint above." />}
            columns={[
              { key: 'type', header: 'Event', cell: (e) => <span className="font-mono text-xs">{e.type}</span> },
              { key: 'status', header: 'Status', cell: (e) => <StatusBadge status={e.status === 'received' ? 'pending' : e.status} /> },
              { key: 'attempts', header: 'Attempts', align: 'right', cell: (e) => e.attempts },
              { key: 'received', header: 'Received', cell: (e) => <When value={e.received_at} /> },
              {
                key: 'view',
                header: <span className="sr-only">Details</span>,
                align: 'right',
                cell: (e) => (
                  <Button variant="ghost" size="sm" onClick={() => setOpen(e)}>
                    View
                  </Button>
                ),
              },
            ]}
          />
        )}
        {events.data && <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={setPage} />}
      </Card>
      <Modal open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)} title={open?.type ?? 'Event'} size="lg">
        {open && (
          <div className="space-y-4">
            <KeyValue
              items={[
                { label: 'Provider event ID', value: <span className="break-all font-mono text-xs">{open.event_id}</span> },
                { label: 'Status', value: <StatusBadge status={open.status === 'received' ? 'pending' : open.status} /> },
                { label: 'Received', value: dateTime(open.received_at) },
                { label: 'Processed', value: open.processed_at ? dateTime(open.processed_at) : null },
              ]}
            />
            {open.error && <Callout tone="danger" title="Processing error">{open.error}</Callout>}
            <Field label="Payload">
              <JsonView value={open.payload} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function GatewayDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const manage = can('billing.gateways.manage');
  const [tab, setTab] = useState('configuration');
  const q = useQuery({ queryKey: ['gateways'], queryFn: () => api.get<GatewaysResponse>('/api/admin/gateways') });
  const test = useAction(() => api.post<{ ok: boolean; message: string }>(`/api/admin/gateways/${id}/test`), {
    success: (r) => (r.ok ? `Connected: ${r.message}` : null),
    invalidate: [['gateways']],
    onSuccess: (r) => {
      if (!r.ok) toast.error('Connection failed', r.message);
    },
  });
  const update = useAction((body: Record<string, unknown>) => api.patch<GatewayRow>(`/api/admin/gateways/${id}`, body), { success: 'Gateway updated', invalidate: [['gateways']] });
  const remove = useAction(() => api.delete(`/api/admin/gateways/${id}`), {
    success: 'Gateway removed',
    invalidate: [['gateways']],
    onSuccess: () => navigate('/platform/gateways'),
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const gw = q.data.data.find((g) => g.id === id);
  if (!gw) return <EmptyState title="Gateway not found" description="It may have been removed." />;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Payment gateways', to: '/platform/gateways' }, { label: gw.name }]}
        title={gw.name}
        description={`${gw.adapterName} · connected ${dateTime(gw.created_at)}`}
        meta={
          <>
            <ModeBadge mode={gw.mode} />
            {gw.is_default && <Badge tone="primary">default</Badge>}
            <Badge tone={gw.enabled ? 'success' : 'neutral'} dot>
              {gw.enabled ? 'enabled' : 'disabled'}
            </Badge>
            <TestResult gw={gw} />
          </>
        }
        actions={
          manage && (
            <>
              <Button variant="outline" icon={<Zap className="size-4" />} loading={test.isPending} onClick={() => test.mutate()} disabled={!gw.available}>
                Test connection
              </Button>
              {!gw.is_default && gw.enabled && (
                <Button variant="outline" onClick={() => update.mutate({ isDefault: true })} loading={update.isPending}>
                  Make default
                </Button>
              )}
              <Button
                variant="outline"
                onClick={async () => {
                  if (gw.enabled) {
                    const { confirmed } = await confirm({ title: `Disable ${gw.name}?`, description: 'New checkouts stop using it, and renewals charged through it fail until it is enabled again.', confirmLabel: 'Disable', tone: 'danger' });
                    if (!confirmed) return;
                  }
                  update.mutate({ enabled: !gw.enabled });
                }}
              >
                {gw.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button
                variant="ghost"
                className="text-danger"
                onClick={async () => {
                  const { confirmed } = await confirm({ title: `Remove ${gw.name}?`, description: 'Only possible when the gateway never processed a payment. Stored credentials are deleted.', confirmLabel: 'Remove', tone: 'danger', typeToConfirm: gw.name });
                  if (confirmed) remove.mutate();
                }}
              >
                Remove
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'configuration', label: 'Configuration', content: <ConfigurationTab key={gw.updated_at} gw={gw} adapters={q.data.available} /> },
            { value: 'webhooks', label: 'Webhooks & events', content: tab === 'webhooks' && <EventsTab gw={gw} /> },
          ]}
        />
        <aside className="space-y-4 xl:pt-[52px]">
          <Card title="Capabilities">
            <CapabilityList caps={gw.capabilities} />
          </Card>
          <Card title="Details">
            <KeyValue
              columns={1}
              items={[
                { label: 'Gateway ID', value: <span className="break-all font-mono text-xs">{gw.id}</span> },
                { label: 'Adapter', value: gw.adapter },
                { label: 'Priority', value: gw.priority },
                { label: 'Currencies', value: gw.currencies?.join(', ') ?? 'All supported' },
                { label: 'Updated', value: dateTime(gw.updated_at) },
              ]}
            />
          </Card>
        </aside>
      </div>
    </>
  );
}
