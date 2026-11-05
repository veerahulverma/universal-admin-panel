import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Webhook } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { Badge, Button, Card, CodeBlock, DataTable, EmptyState, ErrorState, PageHeader, SearchInput, Select, Tabs, Toolbar, When, type Column } from '../../components/ui';
import { describeEvents, SecretOnceDialog, truncate } from './shared';
import { EndpointFormDialog, type Endpoint } from './webhook-form';

const DEFAULTS = { q: '', state: '' };

export function EndpointState({ endpoint }: { endpoint: Pick<Endpoint, 'enabled' | 'disabled_reason'> }) {
  if (endpoint.enabled) return <Badge tone="success" dot>active</Badge>;
  return (
    <Badge tone={endpoint.disabled_reason ? 'danger' : 'neutral'} dot>
      {endpoint.disabled_reason ? 'auto-disabled' : 'disabled'}
    </Badge>
  );
}

const NODE_VERIFY = `import express from 'express';
import { Steward } from '@steward/node';

const steward = new Steward({
  apiKey: process.env.STEWARD_API_KEY!,
  baseUrl: process.env.STEWARD_URL!,
  webhookSecret: process.env.STEWARD_WEBHOOK_SECRET!, // or [newSecret, oldSecret] while rotating
});

// Use the raw body: the signature covers the exact bytes that were sent.
app.post('/webhooks/steward', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = steward.webhooks.verify(req.body, req.header('steward-signature'));
    // event.id is unique: store it to ignore retries you already processed.
    handle(event.type, event.data);
    res.sendStatus(200);
  } catch {
    res.sendStatus(400); // bad or stale signature
  }
});`;

const MANUAL_VERIFY = `// Steward-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300; // reject replays older than 5 minutes
const valid = fresh && crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));`;

export default function WebhooksPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useUrlState(DEFAULTS);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const endpoints = useQuery({ queryKey: ['developers', 'webhooks'], queryFn: () => api.get<{ data: Endpoint[] }>('/api/admin/webhooks') });

  const q = String(state.q ?? '').toLowerCase();
  const rows = (endpoints.data?.data ?? []).filter(
    (e) =>
      (!q || e.url.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.events.some((ev) => ev.includes(q))) &&
      (!state.state || (state.state === 'active' ? e.enabled : !e.enabled)),
  );

  const columns: Column<Endpoint>[] = [
    {
      key: 'url',
      header: 'Endpoint',
      cell: (e) => (
        <span className="block min-w-0 max-w-md">
          <span className="block truncate font-mono text-xs">{e.url}</span>
          {e.description && <span className="block truncate text-xs font-normal text-muted-foreground">{truncate(e.description, 80)}</span>}
        </span>
      ),
    },
    { key: 'events', header: 'Events', cell: (e) => <span className="text-sm">{describeEvents(e.events)}</span> },
    { key: 'status', header: 'Status', cell: (e) => <EndpointState endpoint={e} /> },
    {
      key: 'health',
      header: 'Last 24 h',
      cell: (e) => (
        <span className="text-sm tabular">
          {num(e.deliveries_24h)} sent
          {e.failed_24h > 0 && <span className="text-danger"> · {num(e.failed_24h)} failed</span>}
        </span>
      ),
    },
    { key: 'org', header: 'Organization', priority: 'low', cell: (e) => (e.org_id ? <code className="font-mono text-xs">{e.org_id}</code> : <span className="text-muted-foreground">all</span>) },
    { key: 'created', header: 'Created', priority: 'low', cell: (e) => <When value={e.created_at} /> },
  ];

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Signed HTTP callbacks to your application when something happens: a user signs up, a payment succeeds, a quota is reached…"
        actions={
          can('developers.webhooks.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Add endpoint
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={String(state.q ?? '')} onChange={(v) => setState({ q: v })} placeholder="Search URL, description, event…" className="w-full sm:w-72" />
          <Select aria-label="Status" className="w-auto" value={String(state.state ?? '')} onChange={(e) => setState({ state: e.target.value })} placeholder="Any status" options={[{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }]} />
        </Toolbar>
        {endpoints.error ? (
          <ErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
        ) : (
          <DataTable
            caption="Webhook endpoints"
            columns={columns}
            rows={rows}
            rowKey={(e) => e.id}
            rowHref={(e) => `/developers/webhooks/${e.id}`}
            loading={endpoints.isLoading}
            empty={
              <EmptyState
                icon={<Webhook />}
                title={q || state.state ? 'No endpoints match' : 'No webhook endpoints yet'}
                description={q || state.state ? undefined : 'Add an endpoint to be notified about users, subscriptions, payments, usage limits and more.'}
                action={
                  !q && !state.state && can('developers.webhooks.manage') ? (
                    <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                      Add endpoint
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </Card>

      <Card className="mt-4" title="Verifying signatures" description="Every delivery carries a Steward-Signature header. Reject requests whose signature or timestamp does not check out.">
        <Tabs
          tabs={[
            { value: 'node', label: 'Node SDK', content: <CodeBlock code={NODE_VERIFY} /> },
            { value: 'manual', label: 'Any language', content: <CodeBlock code={MANUAL_VERIFY} /> },
          ]}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          Failed deliveries are retried with backoff (1 min, 5 min, 30 min, 2 h, 5 h, 10 h, 24 h). Respond with a 2xx status within the timeout; do slow work after responding. Endpoints that keep failing are disabled automatically and administrators are notified.
        </p>
      </Card>

      {creating && <EndpointFormDialog open onOpenChange={setCreating} onCreated={setCreated} />}
      <SecretOnceDialog
        open={Boolean(created)}
        onClose={() => {
          const id = created?.id;
          setCreated(null);
          if (id) navigate(`/developers/webhooks/${id}`);
        }}
        title="Endpoint added: signing secret"
        description="Configure this secret in your application to verify deliveries."
        secret={created?.secret ?? null}
      />
    </>
  );
}
