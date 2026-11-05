import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Power, PowerOff, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime } from '../../lib/format';
import { SchemaForm, SecretFields } from '../../components/SchemaForm';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  JsonView,
  KeyValue,
  Modal,
  PageHeader,
  PageSkeleton,
  Pagination,
  Select,
  Tabs,
  Toolbar,
  When,
  useConfirm,
} from '../../components/ui';
import { PermissionList, PluginStatus, typeLabel, type HookCatalog, type PluginDetail, type PluginLog } from './plugins';
import { changedKeys, fieldErrors, normalizeSchema, refreshShell } from './shared';

function ActivateDialog({ plugin, hooks, open, onOpenChange }: { plugin: PluginDetail; hooks: HookCatalog; open: boolean; onOpenChange: (o: boolean) => void }) {
  const client = useQueryClient();
  const [agreed, setAgreed] = useState(false);
  const permissions = plugin.manifest.permissions;
  const activate = useAction(() => api.post(`/api/admin/plugins/${plugin.id}/activate`, { grantPermissions: permissions }), {
    success: `${plugin.name} activated`,
    invalidate: [['plugins'], ['plugin', plugin.id]],
    onSuccess: () => {
      onOpenChange(false);
      refreshShell(client);
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Activate ${plugin.name}?`}
      description="Review what this plugin may do. It receives exactly these permissions and nothing else; you can deactivate it at any time."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button icon={<ShieldCheck className="size-4" />} disabled={!agreed} loading={activate.isPending} onClick={() => activate.mutate()}>
            Grant and activate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <PermissionList permissions={permissions} hooks={hooks} granted={plugin.granted_permissions.length ? plugin.granted_permissions : undefined} />
        {Object.keys(plugin.manifest.dependencies ?? {}).length > 0 && (
          <Callout title="Requires other plugins">
            {Object.entries(plugin.manifest.dependencies).map(([id, range]) => `${id} ${range}`).join(', ')} must be active first.
          </Callout>
        )}
        <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} label={`I grant ${plugin.name} these ${permissions.length} permission${permissions.length === 1 ? '' : 's'}`} />
      </div>
    </Modal>
  );
}

function OverviewTab({ plugin, hooks }: { plugin: PluginDetail; hooks: HookCatalog }) {
  const m = plugin.manifest;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Permissions" description={plugin.status === 'active' ? 'Granted when the plugin was activated.' : 'Requested by the plugin; granted on activation.'}>
          <PermissionList permissions={m.permissions} hooks={hooks} granted={plugin.status === 'installed' ? undefined : plugin.granted_permissions} />
        </Card>
        {(plugin.routes.length > 0 || m.adminPages.length > 0) && (
          <Card title="Endpoints and pages" padded={false}>
            <ul className="divide-y">
              {m.adminPages.map((p) => (
                <li key={`page-${p.id}`} className="flex items-center gap-3 px-4 py-2.5">
                  <Badge tone="primary">admin page</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">{p.title}</span>
                  {plugin.status === 'active' && (
                    <Link to={`/platform/plugins/${plugin.id}/pages/${p.id}`} className="text-sm text-primary hover:underline">
                      Open
                    </Link>
                  )}
                </li>
              ))}
              {plugin.routes.map((r) => (
                <li key={`${r.method} ${r.path}`} className="flex items-center gap-3 px-4 py-2.5">
                  <Badge>{r.method}</Badge>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">
                    /api/plugins/{plugin.id}
                    {r.path}
                  </code>
                  <Badge tone={r.auth === 'admin' ? 'success' : 'warning'}>{r.auth === 'admin' ? 'admins only' : 'public'}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className="space-y-4">
        <Card title="About">
          <KeyValue
            columns={1}
            items={[
              { label: 'Type', value: typeLabel(m.type) },
              { label: 'Author', value: m.author || null },
              { label: 'Website', value: m.homepage ? <a href={m.homepage} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">{m.homepage.replace(/^https?:\/\//, '')}<ExternalLink className="size-3" aria-hidden="true" /></a> : null },
              { label: 'Compatible with', value: <code className="font-mono text-xs">{m.engine}</code> },
              { label: 'Source', value: plugin.source },
              {
                label: 'Isolation',
                value: plugin.sandboxed ? 'Separate process: no file writes or child processes; network only to permitted hosts' : 'Bundled with the platform (runs in-process)',
              },
              { label: 'Depends on', value: Object.keys(m.dependencies ?? {}).length ? Object.entries(m.dependencies).map(([id, r]) => `${id} ${r}`).join(', ') : null, hidden: !Object.keys(m.dependencies ?? {}).length },
              { label: 'Installed', value: dateTime(plugin.installed_at) },
              { label: 'Activated', value: plugin.activated_at ? dateTime(plugin.activated_at) : null },
            ]}
          />
        </Card>
        {plugin.hooks.length > 0 && (
          <Card title="Extension points">
            <ul className="space-y-2">
              {plugin.hooks.map((h) => (
                <li key={h.name}>
                  <code className="font-mono text-xs">{h.name}</code>
                  {h.description && <p className="text-xs text-muted-foreground">{h.description}</p>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function SettingsTab({ plugin }: { plugin: PluginDetail }) {
  const { can } = useAuth();
  const manage = can('plugins.manage.configure');
  const schema = useMemo(() => normalizeSchema(plugin.manifest.settingsSchema ?? null), [plugin.manifest.settingsSchema]);
  const [draft, setDraft] = useState<Record<string, unknown>>(plugin.settings ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const dirty = changedKeys(plugin.settings ?? {}, draft).length > 0;
  const saveSettings = useAction(() => api.put(`/api/admin/plugins/${plugin.id}/settings`, { settings: draft }), {
    success: 'Plugin settings saved',
    invalidate: [['plugin', plugin.id]],
    onSuccess: () => setErrors({}),
    onError: (err) => setErrors(fieldErrors(err)),
  });
  const saveSecrets = useAction(() => api.put(`/api/admin/plugins/${plugin.id}/secrets`, { secrets }), {
    success: 'Credentials saved',
    invalidate: [['plugin', plugin.id]],
    onSuccess: () => setSecrets({}),
  });
  const hasSettings = Object.keys(schema.properties ?? {}).length > 0;
  const declaresSettings = plugin.manifest.permissions.includes('settings');

  return (
    <div className="space-y-4">
      {!hasSettings && plugin.manifest.secrets.length === 0 && <EmptyState title="Nothing to configure" description="This plugin has no settings or credentials." />}
      {hasSettings && (
        <Card title="Settings" description={declaresSettings ? undefined : 'Note: the plugin does not request permission to read its settings.'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveSettings.mutate();
            }}
          >
            <SchemaForm schema={schema} value={draft} onChange={setDraft} errors={errors} disabled={!manage} />
            {manage && (
              <div className="mt-5 flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" disabled={!dirty} onClick={() => setDraft(plugin.settings ?? {})}>
                  Discard
                </Button>
                <Button type="submit" icon={<Save className="size-4" />} disabled={!dirty} loading={saveSettings.isPending}>
                  Save settings
                </Button>
              </div>
            )}
          </form>
        </Card>
      )}
      {plugin.manifest.secrets.length > 0 && (
        <Card title="Credentials" description="Encrypted at rest. The plugin can read them only with the “secrets” permission; they are never shown again here.">
          <SecretFields fields={plugin.manifest.secrets} configured={plugin.secrets.map((s) => s.name)} value={secrets} onChange={setSecrets} disabled={!manage} />
          {manage && (
            <div className="mt-5 flex justify-end border-t pt-4">
              <Button icon={<Save className="size-4" />} disabled={!Object.keys(secrets).length} loading={saveSecrets.isPending} onClick={() => saveSecrets.mutate()}>
                Save credentials
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function VersionsTab({ plugin }: { plugin: PluginDetail }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const rollback = useAction((version: string) => api.post(`/api/admin/plugins/${plugin.id}/rollback`, { version }), {
    success: (_r, v) => `Switched to version ${v}`,
    invalidate: [['plugin', plugin.id], ['plugins']],
  });
  return (
    <Card padded={false} title="Installed versions" description="Earlier versions stay available, so you can roll back a bad update.">
      <DataTable
        caption="Plugin versions"
        rows={plugin.versions}
        rowKey={(v) => v.version}
        empty={<EmptyState title="No versions recorded" />}
        columns={[
          { key: 'version', header: 'Version', cell: (v) => <span className="flex items-center gap-2 font-mono text-sm">{v.version}{v.version === plugin.version && <Badge tone="success">current</Badge>}</span> },
          { key: 'sha', header: 'SHA-256', cell: (v) => <code className="font-mono text-xs text-muted-foreground">{v.sha256 === 'bundled' ? 'bundled' : `${v.sha256.slice(0, 16)}…`}</code> },
          { key: 'installed', header: 'Installed', cell: (v) => <When value={v.installed_at} /> },
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right',
            cell: (v) =>
              v.version !== plugin.version && can('plugins.manage.install') ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<RotateCcw className="size-3.5" />}
                  loading={rollback.isPending && rollback.variables === v.version}
                  onClick={async () => {
                    const { confirmed } = await confirm({ title: `Switch ${plugin.name} to ${v.version}?`, description: 'If that version needs permissions that were not granted, the plugin stays inactive until you approve them.', confirmLabel: 'Switch version' });
                    if (confirmed) rollback.mutate(v.version);
                  }}
                >
                  Use this version
                </Button>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}

function LogsTab({ pluginId }: { pluginId: string }) {
  const [level, setLevel] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<PluginLog | null>(null);
  const query = { level: level || undefined, page, pageSize: 50 };
  const logs = useQuery({ queryKey: ['plugin-logs', pluginId, query], queryFn: ({ signal }) => api.get<Page<PluginLog>>(`/api/admin/plugins/${pluginId}/logs`, query, signal), placeholderData: keepPreviousData, refetchInterval: 20_000 });
  return (
    <Card padded={false}>
      <Toolbar>
        <Select
          aria-label="Level"
          className="w-auto"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(1);
          }}
          placeholder="All levels"
          options={['info', 'warn', 'error'].map((l) => ({ value: l, label: l }))}
        />
        <span className="text-xs text-muted-foreground">Logs are kept for 30 days.</span>
      </Toolbar>
      {logs.error ? (
        <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
      ) : (
        <DataTable
          caption="Plugin logs"
          rows={logs.data?.data}
          loading={logs.isLoading}
          fetching={logs.isFetching && !logs.isLoading}
          rowKey={(l) => l.id ?? `${l.created_at}${l.message}`}
          empty={<EmptyState title="No log entries" />}
          columns={[
            { key: 'level', header: 'Level', cell: (l) => <Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warning' : 'neutral'}>{l.level}</Badge> },
            { key: 'message', header: 'Message', cell: (l) => <span className="block max-w-xl truncate">{l.message}</span> },
            { key: 'when', header: 'When', cell: (l) => <When value={l.created_at} /> },
            {
              key: 'ctx',
              header: <span className="sr-only">Context</span>,
              align: 'right',
              cell: (l) =>
                Object.keys(l.context ?? {}).length ? (
                  <Button size="sm" variant="ghost" onClick={() => setOpen(l)}>
                    Details
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {logs.data && <Pagination page={logs.data.page} pageSize={logs.data.pageSize} total={logs.data.total} onPage={setPage} />}
      <Modal open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)} title="Log entry" size="lg">
        {open && (
          <div className="space-y-3">
            <p className="break-words text-sm">{open.message}</p>
            <p className="text-xs text-muted-foreground">{dateTime(open.created_at)}</p>
            <JsonView value={open.context} />
          </div>
        )}
      </Modal>
    </Card>
  );
}

export default function PluginDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [tab, setTab] = useState('overview');
  const [activating, setActivating] = useState(false);
  const q = useQuery({ queryKey: ['plugin', id], queryFn: () => api.get<PluginDetail>(`/api/admin/plugins/${id}`) });
  const list = useQuery({ queryKey: ['plugins'], queryFn: () => api.get<{ data: { id: string; updateAvailable?: string | null }[]; hooks: HookCatalog }>('/api/admin/plugins') });
  const deactivate = useAction(() => api.post(`/api/admin/plugins/${id}/deactivate`), {
    success: 'Plugin deactivated',
    invalidate: [['plugin', id], ['plugins']],
    onSuccess: () => refreshShell(client),
  });
  const uninstall = useAction(() => api.delete(`/api/admin/plugins/${id}`), {
    success: 'Plugin uninstalled',
    invalidate: [['plugins']],
    onSuccess: () => {
      refreshShell(client);
      navigate('/platform/plugins');
    },
  });
  const update = useAction((version: string) => api.post<{ plugin: { version: string } }>('/api/admin/plugins/marketplace/install', { id, version }), {
    success: (r) => `Updated to ${r.plugin.version}`,
    invalidate: [['plugin', id], ['plugins']],
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const install = can('plugins.manage.install');
  const hooks = list.data?.hooks ?? {};
  const updateAvailable = list.data?.data.find((x) => x.id === id)?.updateAvailable ?? null;
  const pendingPermissions = p.manifest.permissions.filter((x) => !p.granted_permissions.includes(x));
  const hasConfig = Object.keys(p.manifest.settingsSchema?.properties ?? {}).length > 0 || p.manifest.secrets.length > 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Plugins', to: '/platform/plugins' }, { label: p.name }]}
        title={p.name}
        description={p.manifest.description || undefined}
        meta={
          <>
            <PluginStatus plugin={p} />
            <span className="font-mono text-xs text-muted-foreground">
              {p.id} · v{p.version}
            </span>
            {updateAvailable && <Badge tone="info">update {updateAvailable} available</Badge>}
          </>
        }
        actions={
          install && (
            <>
              {updateAvailable && (
                <Button variant="outline" loading={update.isPending} onClick={() => update.mutate(updateAvailable)}>
                  Update to {updateAvailable}
                </Button>
              )}
              {p.status === 'active' ? (
                <Button
                  variant="outline"
                  icon={<PowerOff className="size-4" />}
                  loading={deactivate.isPending}
                  onClick={async () => {
                    const { confirmed } = await confirm({ title: `Deactivate ${p.name}?`, description: 'It stops receiving events and its endpoints, pages, jobs and gateway become unavailable. Settings and data are kept.', confirmLabel: 'Deactivate', tone: 'danger' });
                    if (confirmed) deactivate.mutate();
                  }}
                >
                  Deactivate
                </Button>
              ) : (
                <Button icon={<Power className="size-4" />} onClick={() => setActivating(true)}>
                  {p.status === 'error' ? 'Review & restart' : 'Review & activate'}
                </Button>
              )}
              {p.source !== 'bundled' && (
                <Button
                  variant="ghost"
                  className="text-danger"
                  icon={<Trash2 className="size-4" />}
                  loading={uninstall.isPending}
                  onClick={async () => {
                    const { confirmed } = await confirm({ title: `Uninstall ${p.name}?`, description: 'Removes its files, settings, credentials, stored data and every installed version. This cannot be undone.', confirmLabel: 'Uninstall', tone: 'danger', typeToConfirm: p.id });
                    if (confirmed) uninstall.mutate();
                  }}
                >
                  Uninstall
                </Button>
              )}
            </>
          )
        }
      />
      {p.status === 'error' && (
        <div className="mb-4">
          <Callout tone="danger" title="This plugin was stopped">
            {p.last_error ?? 'It failed repeatedly.'} {p.last_error_at && <>({dateTime(p.last_error_at)}, {p.error_count} error{p.error_count === 1 ? '' : 's'})</>}. Plugins that keep failing are switched off automatically so they cannot affect the platform. Check the logs, then restart it.
          </Callout>
        </div>
      )}
      {p.status !== 'active' && p.status !== 'error' && pendingPermissions.length > 0 && p.granted_permissions.length > 0 && (
        <div className="mb-4">
          <Callout tone="warning" title="This version asks for new permissions">
            {pendingPermissions.join(', ')}. It stays inactive until you review and grant them.
          </Callout>
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview', content: <OverviewTab plugin={p} hooks={hooks} /> },
          { value: 'settings', label: 'Settings', hidden: !hasConfig, content: <SettingsTab key={p.updated_at} plugin={p} /> },
          { value: 'versions', label: 'Versions', count: p.versions.length > 1 ? p.versions.length : undefined, content: <VersionsTab plugin={p} /> },
          { value: 'logs', label: 'Logs', content: tab === 'logs' && <LogsTab pluginId={p.id} /> },
        ]}
      />
      {activating && <ActivateDialog plugin={p} hooks={hooks} open onOpenChange={setActivating} />}
    </>
  );
}
