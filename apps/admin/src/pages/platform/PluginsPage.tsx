import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Download, Package, Puzzle, ShieldCheck, Upload } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { bytes } from '../../lib/format';
import { Badge, Button, ButtonLink, Callout, Card, EmptyState, ErrorState, FormError, Modal, PageHeader, PageSkeleton, Tabs, When } from '../../components/ui';
import { PermissionList, PluginStatus, typeLabel, type HookCatalog, type PluginRow } from './plugins';

interface MarketplaceEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  type?: string;
  permissions?: string[];
  sha256: string;
}

function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useAction(
    () => {
      const form = new FormData();
      form.append('package', file!);
      return api.upload<{ plugin: PluginRow; updated: boolean }>('/api/admin/plugins/upload', form);
    },
    {
      success: (r) => (r.updated ? `${r.plugin.name} updated to ${r.plugin.version}` : `${r.plugin.name} installed. Review its permissions to activate it.`),
      invalidate: [['plugins']],
      onSuccess: (r) => {
        onOpenChange(false);
        navigate(`/platform/plugins/${r.plugin.id}`);
      },
      onError: (err) => setError(errorMessage(err)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Upload a plugin"
      description="A .tgz package as produced by npm pack, with a plugin.json manifest. Uploaded plugins run in an isolated process with only the permissions you grant."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button icon={<Upload className="size-4" />} disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}>
            Upload
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={error} />
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-ui border border-dashed px-4 py-8 text-center hover:bg-muted/40">
          <Package className="size-6 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium">{file ? file.name : 'Choose a package file'}</span>
          <span className="text-xs text-muted-foreground">{file ? bytes(file.size) : '.tgz, up to 10 MB'}</span>
          <input
            ref={input}
            type="file"
            accept=".tgz,.tar.gz,application/gzip,application/x-gzip"
            className="sr-only"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground">Nothing runs until you review and grant the plugin’s permissions on the next screen.</p>
      </div>
    </Modal>
  );
}

function InstalledTab({ plugins }: { plugins: PluginRow[] }) {
  if (!plugins.length) return <EmptyState icon={<Puzzle />} title="No plugins installed" description="Upload a package or install one from the marketplace." />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {plugins.map((p) => {
        const newPermissions = p.manifest.permissions.filter((x) => !p.granted_permissions.includes(x));
        return (
          <Card key={p.id}>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded-ui-sm bg-muted p-2 text-muted-foreground" aria-hidden="true">
                <Puzzle className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/platform/plugins/${p.id}`} className="text-sm font-semibold hover:underline">
                    {p.name}
                  </Link>
                  <span className="font-mono text-xs text-muted-foreground">v{p.version}</span>
                  <PluginStatus plugin={p} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{p.manifest.description || 'No description.'}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge>{typeLabel(p.manifest.type)}</Badge>
                  <Badge>{p.source}</Badge>
                  <Badge tone={p.sandboxed ? 'success' : 'neutral'}>{p.sandboxed ? 'isolated process' : 'built-in'}</Badge>
                  {p.updateAvailable && <Badge tone="info">update {p.updateAvailable}</Badge>}
                  {p.manifest.author && <span className="text-xs text-muted-foreground">by {p.manifest.author}</span>}
                </div>
                {p.status === 'error' && p.last_error && (
                  <div className="mt-3">
                    <Callout tone="danger" title="Stopped after errors">
                      {p.last_error}
                    </Callout>
                  </div>
                )}
                {p.status !== 'active' && p.status !== 'error' && p.last_error && newPermissions.length > 0 && (
                  <div className="mt-3">
                    <Callout tone="warning" title="Waiting for permission review">
                      {p.last_error}
                    </Callout>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
              <ButtonLink to={`/platform/plugins/${p.id}`} size="sm" variant={p.status === 'active' ? 'outline' : 'primary'}>
                {p.status === 'active' ? 'Manage' : 'Review & activate'}
              </ButtonLink>
              <span className="ml-auto text-xs text-muted-foreground">
                {p.manifest.permissions.length} permission{p.manifest.permissions.length === 1 ? '' : 's'} · installed <When value={p.installed_at} />
              </span>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function MarketplaceTab({ installed, hooks }: { installed: PluginRow[]; hooks: HookCatalog }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const market = useQuery({ queryKey: ['plugin-marketplace'], queryFn: () => api.get<{ configured: boolean; signed?: boolean; data: MarketplaceEntry[] }>('/api/admin/plugins/marketplace') });
  const [review, setReview] = useState<MarketplaceEntry | null>(null);
  const install = useAction((e: MarketplaceEntry) => api.post<{ plugin: PluginRow; updated: boolean }>('/api/admin/plugins/marketplace/install', { id: e.id, version: e.version }), {
    success: (r) => (r.updated ? `${r.plugin.name} updated to ${r.plugin.version}` : `${r.plugin.name} installed`),
    invalidate: [['plugins'], ['plugin-marketplace']],
    onSuccess: (r) => {
      setReview(null);
      navigate(`/platform/plugins/${r.plugin.id}`);
    },
  });

  if (market.isLoading) return <PageSkeleton />;
  if (market.error || !market.data) return <ErrorState error={market.error} onRetry={() => void market.refetch()} />;
  if (!market.data.configured) {
    return (
      <EmptyState
        icon={<Download />}
        title="The marketplace is not configured"
        description="Set MARKETPLACE_URL (and MARKETPLACE_PUBLIC_KEY to require signed packages) on the server to browse and install plugins from a catalog. You can still upload packages."
      />
    );
  }
  const byId = new Map(installed.map((p) => [p.id, p]));
  return (
    <div className="space-y-4">
      <Callout tone={market.data.signed ? 'success' : 'warning'} title={market.data.signed ? 'Signed packages required' : 'Checksums verified, signatures not required'}>
        {market.data.signed
          ? 'Every download must match its published SHA-256 checksum and carry a valid Ed25519 signature from the marketplace key.'
          : 'Downloads must match their published SHA-256 checksum. Configure MARKETPLACE_PUBLIC_KEY to also require signatures.'}
      </Callout>
      {market.data.data.length === 0 ? (
        <EmptyState title="The marketplace catalog is empty" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {market.data.data.map((e) => {
            const current = byId.get(e.id);
            const label = !current ? 'Install' : current.version === e.version ? 'Installed' : 'Update';
            return (
              <Card key={`${e.id}@${e.version}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{e.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">v{e.version}</span>
                  {e.type && <Badge>{typeLabel(e.type)}</Badge>}
                  {current && <Badge tone="success">installed v{current.version}</Badge>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{e.description || 'No description.'}</p>
                <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5" aria-hidden="true" /> sha256 <code className="font-mono">{e.sha256.slice(0, 16)}…</code>
                  {e.author && <> · by {e.author}</>}
                </p>
                <div className="mt-3 flex justify-end border-t pt-3">
                  <Button size="sm" variant={label === 'Install' ? 'primary' : 'outline'} disabled={label === 'Installed' || !can('plugins.manage.install')} onClick={() => setReview(e)}>
                    {label}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Modal
        open={Boolean(review)}
        onOpenChange={(o) => !o && setReview(null)}
        title={review ? `Install ${review.name} ${review.version}?` : ''}
        description="The package is downloaded and verified on the server. It is installed inactive: you grant permissions before it runs."
        footer={
          <>
            <Button variant="outline" onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button loading={install.isPending} onClick={() => review && install.mutate(review)}>
              Download & install
            </Button>
          </>
        }
      >
        {review && (
          <div className="space-y-2">
            <p className="text-sm font-medium">It will ask for:</p>
            <PermissionList permissions={review.permissions ?? []} hooks={hooks} />
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function PluginsPage() {
  const { can } = useAuth();
  const [state, setState] = useUrlState({ tab: 'installed' });
  const tab = String(state.tab || 'installed');
  const [uploading, setUploading] = useState(false);
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.get<{ data: PluginRow[]; hooks: HookCatalog }>('/api/admin/plugins') });

  if (plugins.isLoading) return <PageSkeleton />;
  if (plugins.error || !plugins.data) return <ErrorState error={plugins.error} onRetry={() => void plugins.refetch()} />;
  const list = plugins.data.data;
  const active = list.filter((p) => p.status === 'active').length;
  const failing = list.filter((p) => p.status === 'error');

  return (
    <>
      <PageHeader
        title="Plugins"
        description="Extend the platform with gateways, integrations and features. Plugins only get the permissions you grant, and uploaded plugins run isolated from the application."
        meta={
          <span className="text-sm text-muted-foreground">
            {active} active of {list.length} installed
          </span>
        }
        actions={
          can('plugins.manage.install') && (
            <Button icon={<Upload className="size-4" />} onClick={() => setUploading(true)}>
              Upload plugin
            </Button>
          )
        }
      />
      {failing.length > 0 && (
        <div className="mb-4">
          <Callout tone="danger" title={`${failing.length} plugin${failing.length === 1 ? ' was' : 's were'} stopped after repeated errors`}>
            {failing.map((p) => p.name).join(', ')}. A plugin is disabled automatically when it keeps failing, so it cannot affect the rest of the platform.
          </Callout>
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={(v) => setState({ tab: v })}
        tabs={[
          { value: 'installed', label: 'Installed', count: list.length, content: <InstalledTab plugins={list} /> },
          { value: 'marketplace', label: 'Marketplace', content: tab === 'marketplace' && <MarketplaceTab installed={list} hooks={plugins.data.hooks} /> },
        ]}
      />
      {uploading && <UploadDialog open onOpenChange={setUploading} />}
    </>
  );
}
