import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, ButtonLink, Callout, EmptyState, ErrorState, PageHeader, PageSkeleton } from '../../components/ui';
import type { PluginDetail } from './plugins';

/**
 * Admin pages contributed by plugins. The page is served by the plugin under
 * /api/plugins/<id>/… with a sandbox CSP and rendered here in a sandboxed
 * iframe without same-origin access: plugin markup and scripts never run in
 * the console's own document and cannot read its session or call its API.
 */
export default function PluginAdminPage() {
  const { id = '', pageId = '' } = useParams();
  const [reload, setReload] = useState(0);
  const q = useQuery({ queryKey: ['plugin', id], queryFn: () => api.get<PluginDetail>(`/api/admin/plugins/${id}`) });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const plugin = q.data;
  const adminPage = plugin.manifest.adminPages.find((p) => p.id === pageId);
  if (!adminPage) return <EmptyState title="Page not found" description={`${plugin.name} does not provide this page.`} action={<ButtonLink to={`/platform/plugins/${plugin.id}`}>Open plugin</ButtonLink>} />;

  const src = `/api/plugins/${encodeURIComponent(plugin.id)}${adminPage.path}`;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Plugins', to: '/platform/plugins' }, { label: plugin.name, to: `/platform/plugins/${plugin.id}` }, { label: adminPage.title }]}
        title={adminPage.title}
        description={`Provided by the ${plugin.name} plugin (v${plugin.version}).`}
        actions={
          <Button variant="outline" icon={<RefreshCw className="size-4" />} onClick={() => setReload((n) => n + 1)}>
            Reload
          </Button>
        }
      />
      {plugin.status !== 'active' || !plugin.running ? (
        <Callout tone="warning" title="The plugin is not running" action={<ButtonLink to={`/platform/plugins/${plugin.id}`} size="sm">Manage plugin</ButtonLink>}>
          Activate {plugin.name} to use this page.
        </Callout>
      ) : (
        <iframe
          key={reload}
          src={src}
          title={adminPage.title}
          // No allow-same-origin: the page cannot touch the console's cookies, storage or DOM.
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-[calc(100dvh-13rem)] min-h-[28rem] w-full rounded-ui border bg-white shadow-ui"
        />
      )}
    </>
  );
}
