import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, MoreHorizontal, Plug, Plus, Star, Zap } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Button, ButtonLink, Card, EmptyState, ErrorState, Menu, Modal, PageHeader, PageSkeleton, useConfirm, useToast, type MenuItem } from '../../components/ui';
import { CapabilityList, GatewayFields, ModeBadge, TestResult, draftFrom, gatewayBody, type AdapterInfo, type GatewayDraft, type GatewayRow, type GatewaysResponse } from './gateways';
import { fieldErrors } from './shared';

function AddGatewayDialog({ adapters, initial, open, onOpenChange }: { adapters: AdapterInfo[]; initial: AdapterInfo | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [adapter, setAdapter] = useState<AdapterInfo | null>(initial);
  const [draft, setDraft] = useState<GatewayDraft | null>(initial ? draftFrom(null, initial) : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useAction((body: ReturnType<typeof gatewayBody> & { adapter: string }) => api.post<GatewayRow>('/api/admin/gateways', body), {
    success: (gw) => `${gw.name} connected`,
    invalidate: [['gateways']],
    onSuccess: (gw) => {
      onOpenChange(false);
      navigate(`/platform/gateways/${gw.id}`);
    },
    onError: (err) => {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    },
  });

  const choose = (a: AdapterInfo) => {
    setAdapter(a);
    setDraft(draftFrom(null, a));
    setErrors({});
    setError(null);
  };

  const submit = async () => {
    if (!adapter || !draft) return;
    if (draft.mode === 'live') {
      const { confirmed } = await confirm({ title: 'Connect in live mode?', description: 'Customers will be charged real money through this gateway.', confirmLabel: 'Connect live gateway', tone: 'danger', typeToConfirm: 'LIVE' });
      if (!confirmed) return;
    }
    create.mutate({ adapter: adapter.key, ...gatewayBody(draft) });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={adapter ? `Connect ${adapter.name}` : 'Add a payment gateway'}
      description={adapter ? adapter.description : 'Choose a provider. Gateways installed by plugins appear here too.'}
      size="lg"
      footer={
        adapter && draft ? (
          <>
            {!initial && (
              <Button variant="ghost" className="mr-auto" onClick={() => setAdapter(null)}>
                Back
              </Button>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={create.isPending} onClick={() => void submit()}>
              Connect gateway
            </Button>
          </>
        ) : undefined
      }
    >
      {adapter && draft ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <GatewayFields adapter={adapter} gateway={null} draft={draft} onChange={setDraft} errors={errors} error={error} />
        </form>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {adapters.map((a) => (
            <li key={a.key}>
              <button type="button" onClick={() => choose(a)} className="flex h-full w-full flex-col gap-2 rounded-ui border p-3 text-left hover:border-primary/60 hover:bg-muted/40">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {a.name}
                  {a.owner !== 'billing' && <Badge tone="info">plugin</Badge>}
                </span>
                <span className="text-xs text-muted-foreground">{a.description}</span>
                <CapabilityList caps={a.capabilities} compact />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function GatewayCard({ gw, manage }: { gw: GatewayRow; manage: boolean }) {
  const confirm = useConfirm();
  const toast = useToast();
  const test = useAction(() => api.post<{ ok: boolean; message: string }>(`/api/admin/gateways/${gw.id}/test`), {
    success: (r) => (r.ok ? `Connected: ${r.message}` : null),
    invalidate: [['gateways']],
    onSuccess: (r) => {
      if (!r.ok) toast.error('Connection failed', r.message);
    },
  });
  const update = useAction((body: Record<string, unknown>) => api.patch<GatewayRow>(`/api/admin/gateways/${gw.id}`, body), { success: 'Gateway updated', invalidate: [['gateways']] });
  const remove = useAction(() => api.delete(`/api/admin/gateways/${gw.id}`), { success: 'Gateway removed', invalidate: [['gateways']] });

  const items: MenuItem[] = [
    { label: 'Make default', icon: <Star className="size-4" />, hidden: gw.is_default || !gw.enabled, onSelect: () => update.mutate({ isDefault: true }) },
    {
      label: gw.enabled ? 'Disable' : 'Enable',
      onSelect: async () => {
        if (gw.enabled) {
          const { confirmed } = await confirm({ title: `Disable ${gw.name}?`, description: 'New checkouts stop using it. Existing subscriptions billed through it will fail to renew until it is enabled again or customers switch payment method.', confirmLabel: 'Disable', tone: 'danger' });
          if (!confirmed) return;
        }
        update.mutate({ enabled: !gw.enabled });
      },
    },
    { separator: true, label: '' },
    {
      label: 'Remove',
      danger: true,
      onSelect: async () => {
        const { confirmed } = await confirm({ title: `Remove ${gw.name}?`, description: 'Only gateways that never processed a payment can be removed; otherwise disable it. Stored credentials are deleted.', confirmLabel: 'Remove gateway', tone: 'danger', typeToConfirm: gw.name });
        if (confirmed) remove.mutate();
      },
    },
  ];

  return (
    <Card className={gw.enabled ? undefined : 'opacity-75'}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-ui-sm bg-muted p-2 text-muted-foreground" aria-hidden="true">
          <CreditCard className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/platform/gateways/${gw.id}`} className="text-sm font-semibold hover:underline">
              {gw.name}
            </Link>
            <span className="text-xs text-muted-foreground">{gw.adapterName}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <ModeBadge mode={gw.mode} />
            {gw.is_default && <Badge tone="primary">default</Badge>}
            {!gw.enabled && <Badge>disabled</Badge>}
            {!gw.available && <Badge tone="danger">adapter missing</Badge>}
            {gw.currencies && <Badge>{gw.currencies.join(', ')}</Badge>}
          </div>
          <div className="mt-3">
            <CapabilityList caps={gw.capabilities} compact />
          </div>
          <div className="mt-3">
            <TestResult gw={gw} />
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
        <ButtonLink to={`/platform/gateways/${gw.id}`} size="sm" variant="outline">
          Configure
        </ButtonLink>
        {manage && (
          <>
            <Button size="sm" variant="ghost" icon={<Zap className="size-3.5" />} loading={test.isPending} onClick={() => test.mutate()} disabled={!gw.available}>
              Test connection
            </Button>
            <span className="ml-auto">
              <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${gw.name}`}><MoreHorizontal className="size-4" /></Button>} items={items} />
            </span>
          </>
        )}
      </div>
    </Card>
  );
}

export default function GatewaysPage() {
  const { can } = useAuth();
  const manage = can('billing.gateways.manage');
  const q = useQuery({ queryKey: ['gateways'], queryFn: () => api.get<GatewaysResponse>('/api/admin/gateways') });
  const [adding, setAdding] = useState<{ adapter: AdapterInfo | null } | null>(null);

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { data: gateways, available } = q.data;

  return (
    <>
      <PageHeader
        title="Payment gateways"
        description="Connect payment providers. Billing stays in this platform; gateways only move money, so you can switch or combine providers without migrating customers."
        actions={
          manage && (
            <Button icon={<Plus className="size-4" />} onClick={() => setAdding({ adapter: null })}>
              Add gateway
            </Button>
          )
        }
      />
      {gateways.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CreditCard />}
            title="No payment gateway connected"
            description="Start with the sandbox to test checkout, renewals and refunds without real money, then connect a live provider."
            action={manage && <Button onClick={() => setAdding({ adapter: available.find((a) => a.key === 'sandbox') ?? null })}>Connect the sandbox</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {gateways.map((gw) => (
            <GatewayCard key={gw.id} gw={gw} manage={manage} />
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold">Available integrations</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {available.map((a) => {
          const connected = gateways.filter((g) => g.adapter === a.key).length;
          return (
            <Card key={a.key}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {a.name}
                    {a.owner !== 'billing' && (
                      <Badge tone="info">
                        <Plug className="size-3" aria-hidden="true" /> {a.owner}
                      </Badge>
                    )}
                    {connected > 0 && <Badge tone="success">{connected} connected</Badge>}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{a.description}</p>
                </div>
                {manage && (
                  <Button size="sm" variant="outline" onClick={() => setAdding({ adapter: a })}>
                    Connect
                  </Button>
                )}
              </div>
              <div className="mt-3">
                <CapabilityList caps={a.capabilities} />
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        Need another provider? Install a payment gateway plugin from <Link to="/platform/plugins" className="text-primary hover:underline">Plugins</Link>; it appears here once active.
      </p>
      {adding && <AddGatewayDialog key={adding.adapter?.key ?? 'pick'} adapters={available} initial={adding.adapter} open onOpenChange={(o) => !o && setAdding(null)} />}
    </>
  );
}
