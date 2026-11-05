import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, Lock } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Card, EmptyState, ErrorState, PageHeader, PageSkeleton, SearchInput, Select, Switch, Toolbar, useConfirm } from '../../components/ui';
import { refreshShell } from './shared';

interface ModuleState {
  id: string;
  name: string;
  description: string;
  version: string;
  required: boolean;
  enabled: boolean;
  dependencies: string[];
  dependents: string[];
  nav: { id: string; label: string; path: string }[];
}

export default function ModulesPage() {
  const { can } = useAuth();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const modules = useQuery({ queryKey: ['modules'], queryFn: () => api.get<{ data: ModuleState[] }>('/api/admin/modules') });

  const toggle = useAction((m: { id: string; enable: boolean }) => api.post<{ data: ModuleState }>(`/api/admin/modules/${m.id}/${m.enable ? 'enable' : 'disable'}`), {
    success: (r, v) => `${r.data?.name ?? v.id} ${v.enable ? 'enabled' : 'disabled'}`,
    invalidate: [['modules']],
    onSuccess: () => refreshShell(client),
  });

  const list = modules.data?.data ?? [];
  const byId = useMemo(() => new Map(list.map((m) => [m.id, m])), [list]);
  const visible = list.filter(
    (m) => (!q || `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(q.toLowerCase())) && (!status || (status === 'enabled' ? m.enabled : !m.enabled)),
  );
  const manage = can('system.modules.manage');

  if (modules.isLoading) return <PageSkeleton />;
  if (modules.error) return <ErrorState error={modules.error} onRetry={() => void modules.refetch()} />;

  const onToggle = async (m: ModuleState, enable: boolean) => {
    if (!enable) {
      const { confirmed } = await confirm({
        title: `Disable ${m.name}?`,
        description: `Its pages, API routes and background jobs stop (API calls answer 403 module_disabled). Data is kept and comes back when you enable the module again.`,
        confirmLabel: 'Disable module',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    toggle.mutate({ id: m.id, enable });
  };

  const enabledCount = list.filter((m) => m.enabled).length;

  return (
    <>
      <PageHeader
        title="Modules"
        description="Turn platform features on or off. Core modules are always on; others can be disabled without losing data."
        meta={
          <span className="text-sm text-muted-foreground">
            {enabledCount} of {list.length} enabled
          </span>
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Search modules…" className="w-full sm:w-72" />
          <Select aria-label="Status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All modules" options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
        </Toolbar>
        {visible.length === 0 ? (
          <EmptyState icon={<Blocks />} title="No modules match" />
        ) : (
          <ul className="divide-y">
            {visible.map((m) => {
              const missing = m.dependencies.filter((d) => !byId.get(d)?.enabled);
              const activeDependents = m.dependents.filter((d) => byId.get(d)?.enabled);
              const blockedReason = m.required
                ? 'Core module: always enabled'
                : !m.enabled && missing.length
                  ? `Enable first: ${missing.map((d) => byId.get(d)?.name ?? d).join(', ')}`
                  : m.enabled && activeDependents.length
                    ? `Used by: ${activeDependents.map((d) => byId.get(d)?.name ?? d).join(', ')}`
                    : null;
              const locked = m.required || (!m.enabled && missing.length > 0) || (m.enabled && activeDependents.length > 0);
              return (
                <li key={m.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">{m.name}</h2>
                      <span className="font-mono text-xs text-muted-foreground">
                        {m.id} · v{m.version}
                      </span>
                      {m.required && (
                        <Badge tone="neutral">
                          <Lock className="size-3" aria-hidden="true" /> core
                        </Badge>
                      )}
                      <Badge tone={m.enabled ? 'success' : 'neutral'} dot>
                        {m.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{m.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                      {m.dependencies.length > 0 && (
                        <span className="flex flex-wrap items-center gap-1">
                          Requires
                          {m.dependencies.map((d) => (
                            <Badge key={d} tone={byId.get(d)?.enabled ? 'neutral' : 'warning'} className="font-mono">
                              {d}
                            </Badge>
                          ))}
                        </span>
                      )}
                      {m.nav.length > 0 && <span>Pages: {m.nav.map((n) => n.label).join(', ')}</span>}
                    </div>
                    {blockedReason && !m.required && <p className={clsx('mt-1.5 text-xs', missing.length ? 'text-warning' : 'text-muted-foreground')}>{blockedReason}</p>}
                  </div>
                  <div className="shrink-0">
                    <Switch
                      checked={m.enabled}
                      disabled={!manage || locked || (toggle.isPending && toggle.variables?.id === m.id)}
                      onCheckedChange={(v) => void onToggle(m, v)}
                      label={<span className="sr-only">{m.enabled ? `Disable ${m.name}` : `Enable ${m.name}`}</span>}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {!manage && <p className="mt-3 text-sm text-muted-foreground">You can view modules; changing them needs the “Enable and disable modules” permission.</p>}
    </>
  );
}
