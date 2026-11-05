import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeySquare, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Button, Callout, Card, CodeBlock, DataTable, EmptyState, ErrorState, Field, FormError, Input, Menu, Modal, PageHeader, PasswordInput, Select, Switch, Textarea, When, useConfirm, useToast, type Column } from '../../components/ui';

type ProviderType = 'google' | 'github' | 'microsoft' | 'oidc';

interface Provider {
  id: string;
  key: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  secretLast4: string | null;
  scopes: string[];
  issuer: string | null;
  tenant: string | null;
  trustEmail: boolean;
  allowSignup: boolean;
  redirectUrls: string[];
  updatedAt: string;
}

const TYPES: { value: ProviderType; label: string; setup: string }[] = [
  { value: 'google', label: 'Google', setup: 'Google Cloud console → APIs & Services → Credentials → OAuth client ID (web application).' },
  { value: 'github', label: 'GitHub', setup: 'GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.' },
  { value: 'microsoft', label: 'Microsoft', setup: 'Microsoft Entra admin center → App registrations → New registration (web platform), then a client secret.' },
  { value: 'oidc', label: 'OpenID Connect', setup: 'Any provider with OpenID Connect discovery (Okta, Auth0, Keycloak…): register a web client and note its issuer URL.' },
];

function ProviderDialog({ provider, onClose }: { provider?: Provider; onClose: () => void }) {
  const [form, setForm] = useState({
    type: provider?.type ?? ('google' as ProviderType),
    key: provider?.key ?? '',
    name: provider?.name ?? '',
    clientId: provider?.clientId ?? '',
    clientSecret: '',
    issuer: provider?.issuer ?? '',
    tenant: provider?.tenant ?? '',
    trustEmail: provider?.trustEmail ?? false,
    scopes: provider?.scopes.join(' ') ?? '',
    redirectUrls: provider?.redirectUrls.join('\n') ?? '',
    allowSignup: provider?.allowSignup ?? true,
    enabled: provider?.enabled ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = useAction(
    () => {
      const body = {
        name: form.name.trim() || undefined,
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim() || undefined,
        issuer: form.type === 'oidc' ? form.issuer.trim() || undefined : undefined,
        tenant: form.type === 'microsoft' ? form.tenant.trim() || undefined : undefined,
        trustEmail: form.trustEmail,
        scopes: form.scopes.split(/[\s,]+/).filter(Boolean),
        redirectUrls: form.redirectUrls.split('\n').map((u) => u.trim()).filter(Boolean),
        allowSignup: form.allowSignup,
        enabled: form.enabled,
      };
      return provider ? api.patch(`/api/admin/identity/providers/${provider.id}`, body) : api.post('/api/admin/identity/providers', { ...body, type: form.type, key: form.key.trim() || undefined });
    },
    { success: provider ? 'Provider updated' : 'Provider added', invalidate: [['identity-providers']], onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
  );
  const type = TYPES.find((x) => x.value === form.type)!;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={provider ? `Edit ${provider.name}` : 'Add a sign-in provider'}
      description={type.setup}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="identity-provider" loading={save.isPending}>
            {provider ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form
        id="identity-provider"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Provider" htmlFor="idp-type">
          <Select id="idp-type" value={form.type} disabled={Boolean(provider)} onChange={(e) => set({ type: e.target.value as ProviderType })} options={TYPES.map(({ value, label }) => ({ value, label }))} />
        </Field>
        <Field label="Key" htmlFor="idp-key" required={form.type === 'oidc'} hint={provider ? 'Used in the API paths; it cannot change' : form.type === 'oidc' ? 'Used in the API paths, e.g. acme-sso' : `Defaults to ${form.type}`}>
          <Input id="idp-key" className="font-mono" value={form.key} disabled={Boolean(provider)} onChange={(e) => set({ key: e.target.value })} />
        </Field>
        <Field label="Button label" htmlFor="idp-name" hint="Shown to customers">
          <Input id="idp-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={type.label} />
        </Field>
        <Field label="Client ID" htmlFor="idp-client" required>
          <Input id="idp-client" value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} required autoComplete="off" />
        </Field>
        <Field label="Client secret" htmlFor="idp-secret" required={!provider} hint={provider?.hasSecret ? `Stored encrypted (ends in ${provider.secretLast4 ?? '••••'}); leave empty to keep it` : 'Stored encrypted; never shown again'}>
          <PasswordInput id="idp-secret" value={form.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} required={!provider} autoComplete="new-password" />
        </Field>
        {form.type === 'oidc' && (
          <Field label="Issuer URL" htmlFor="idp-issuer" required hint="Its /.well-known/openid-configuration is read">
            <Input id="idp-issuer" type="url" value={form.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://login.example.com" required />
          </Field>
        )}
        {form.type === 'microsoft' && (
          <Field label="Tenant" htmlFor="idp-tenant" hint="Directory ID, or common / organizations / consumers">
            <Input id="idp-tenant" value={form.tenant} onChange={(e) => set({ tenant: e.target.value })} placeholder="common" />
          </Field>
        )}
        <Field label="Scopes" htmlFor="idp-scopes" hint="Leave empty for the provider’s defaults">
          <Input id="idp-scopes" value={form.scopes} onChange={(e) => set({ scopes: e.target.value })} placeholder="openid email profile" />
        </Field>
        <Field label="Your app’s callback URLs" htmlFor="idp-redirects" required className="sm:col-span-2" hint="One per line. Register the same URLs with the provider; sign-ins may only return to these.">
          <Textarea id="idp-redirects" rows={3} className="font-mono" value={form.redirectUrls} onChange={(e) => set({ redirectUrls: e.target.value })} placeholder="https://app.example.com/auth/callback" required />
        </Field>
        <div className="space-y-3 sm:col-span-2">
          {(form.type === 'microsoft' || form.type === 'oidc') && (
            <Switch
              checked={form.trustEmail}
              onCheckedChange={(trustEmail) => set({ trustEmail })}
              label="Trust email addresses from this provider"
              description="Accounts are linked by email only when the address is verified. Turn this on only for a single directory you control; addresses in other tenants are set by their administrators."
            />
          )}
          <Switch checked={form.allowSignup} onCheckedChange={(allowSignup) => set({ allowSignup })} label="Create accounts for new customers" description="Off: only customers who already have an account can sign in this way." />
          <Switch checked={form.enabled} onCheckedChange={(enabled) => set({ enabled })} label="Enabled" />
        </div>
      </form>
    </Modal>
  );
}

const FLOW = `1. POST /api/v1/identity/social/{key}/start
   { "redirectUri": "https://app.example.com/auth/callback" }
   → redirect the browser to authorizationUrl, keep state in the session

2. The provider returns to your callback with ?code=…&state=…

3. POST /api/v1/identity/social/{key}/callback
   { "code": "…", "state": "…", "ip": "<customer IP>", "userAgent": "…" }
   → { user, session, created, linkedBy }`;

export default function SocialSignInPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const q = useQuery({ queryKey: ['identity-providers'], queryFn: () => api.get<{ data: Provider[] }>('/api/admin/identity/providers') });
  const manage = can('identity.providers.manage');
  const toggle = useAction((p: Provider) => api.patch(`/api/admin/identity/providers/${p.id}`, { enabled: !p.enabled }), {
    success: (_r, p) => (p.enabled ? `${p.name} disabled` : `${p.name} enabled`),
    invalidate: [['identity-providers']],
  });
  const remove = useAction((p: Provider) => api.delete(`/api/admin/identity/providers/${p.id}`), { success: 'Provider removed', invalidate: [['identity-providers']] });
  const check = useAction((p: Provider) => api.post<{ endpoints: { authorization: string } }>(`/api/admin/identity/providers/${p.id}/check`), {
    onSuccess: (r) => toast.success('Configuration looks right', `Customers will be sent to ${new URL(r.endpoints.authorization).host}`),
  });

  const columns: Column<Provider>[] = [
    {
      key: 'name',
      header: 'Provider',
      cell: (p) => (
        <span className="min-w-0">
          <span className="block truncate font-medium">{p.name}</span>
          <code className="block truncate font-mono text-xs text-muted-foreground">{p.key}</code>
        </span>
      ),
    },
    { key: 'type', header: 'Type', cell: (p) => TYPES.find((x) => x.value === p.type)?.label ?? p.type },
    { key: 'status', header: 'Status', cell: (p) => (p.enabled ? <Badge tone="success" dot>enabled</Badge> : <Badge dot>disabled</Badge>) },
    { key: 'signup', header: 'New customers', priority: 'low', cell: (p) => (p.allowSignup ? 'Can sign up' : 'Existing accounts only') },
    { key: 'secret', header: 'Secret', priority: 'low', cell: (p) => (p.hasSecret ? <code className="font-mono text-xs">••••{p.secretLast4 ?? ''}</code> : <Badge tone="warning">missing</Badge>) },
    { key: 'updated', header: 'Updated', priority: 'low', cell: (p) => <When value={p.updatedAt} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <Menu
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          }
          items={[
            { label: 'Check configuration', icon: <ShieldCheck className="size-4" />, onSelect: () => check.mutate(p) },
            { label: 'Edit', icon: <Pencil className="size-4" />, hidden: !manage, onSelect: () => setEditing(p) },
            { label: p.enabled ? 'Disable' : 'Enable', icon: <KeySquare className="size-4" />, hidden: !manage, onSelect: () => toggle.mutate(p) },
            {
              label: 'Remove',
              icon: <Trash2 className="size-4" />,
              danger: true,
              hidden: !manage,
              onSelect: async () => {
                if ((await confirm({ title: `Remove ${p.name}?`, description: 'Customers who sign in with it lose that option and must use a password or another provider. Their accounts are kept.', tone: 'danger', confirmLabel: 'Remove' })).confirmed) remove.mutate(p);
              },
            },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Social sign-in"
        description="Let customers sign in to your app with Google, GitHub, Microsoft or any OpenID Connect provider, through the built-in sign-in."
        actions={
          manage && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Add provider
            </Button>
          )
        }
      />
      <div className="space-y-4">
        <Callout tone="warning" title="Needs credentials from each provider">
          Register an OAuth application with the provider, add your app’s callback URL there, and enter its client ID and secret here. Nothing works until those credentials are in place and the provider is enabled.
        </Callout>
        <Card padded={false}>
          {q.error ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <DataTable
              caption="Sign-in providers"
              columns={columns}
              rows={q.data?.data}
              rowKey={(p) => p.id}
              loading={q.isLoading}
              empty={<EmptyState icon={<KeySquare />} title="No providers yet" description="Add Google, GitHub, Microsoft or an OpenID Connect provider." action={manage ? <Button onClick={() => setEditing('new')}>Add provider</Button> : undefined} />}
            />
          )}
        </Card>
        <Card title="How your app uses it" description="Accounts are matched by the provider identity, then by email only when the provider verified the address.">
          <CodeBlock code={FLOW} />
        </Card>
      </div>
      {editing && <ProviderDialog provider={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
