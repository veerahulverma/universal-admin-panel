import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, Upload } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { Button, Card, DataTable, EmptyState, ErrorState, Field, FormError, Input, PageHeader, Pagination, SearchInput, Select, Skeleton, Switch, Tabs, Toolbar, When, useToast, type Column } from '../../components/ui';
import { DownloadLog } from './DownloadLog';
import { PERIODS, fileSize, limitLabel, type AccessFile, type AccessSettings, type LimitPeriod } from './shared';

const DEFAULTS = { tab: 'files', q: '', page: 1, pageSize: 25 };
const MB = 1024 * 1024;

function UploadButton() {
  const toast = useToast();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const uploadAll = async (files: File[]) => {
    setBusy(true);
    let done = 0;
    try {
      for (const file of files) {
        const form = new FormData();
        form.append('title', file.name);
        form.append('file', file);
        await api.upload<AccessFile>('/api/admin/access/files', form);
        done++;
      }
      toast.success(done === 1 ? `${files[0].name} uploaded` : `${done} files uploaded`, 'Add them to a protected resource to offer them to customers.');
    } catch (err) {
      toast.error(done ? `Uploaded ${done} of ${files.length} files` : 'Upload failed', errorMessage(err));
    } finally {
      setBusy(false);
      await Promise.all([client.invalidateQueries({ queryKey: ['access-files'] }), client.invalidateQueries({ queryKey: ['access-options'] })]);
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void uploadAll(files);
        }}
      />
      <Button icon={<Upload className="size-4" />} loading={busy} onClick={() => input.current?.click()}>
        Upload files
      </Button>
    </>
  );
}

function FilesTab({ state, setState }: { state: Record<string, string | number | undefined>; setState: (patch: Record<string, string | number | undefined>, opts?: { resetPage?: boolean }) => void }) {
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const query = useMemo(() => ({ q: String(state.q ?? '') || undefined, page: Number(state.page), pageSize: Number(state.pageSize) }), [state.q, state.page, state.pageSize]);
  const files = useQuery({
    queryKey: ['access-files', query],
    queryFn: ({ signal }) => api.get<Page<AccessFile>>('/api/admin/access/files', query, signal),
    placeholderData: keepPreviousData,
  });
  const columns: Column<AccessFile>[] = [
    {
      key: 'title',
      header: 'File',
      cell: (f) => (
        <span className="block min-w-0 max-w-md">
          <span className="block truncate">{f.title}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {f.filename} · {fileSize(f.size)}
          </span>
        </span>
      ),
    },
    { key: 'limit', header: 'Limit per customer', cell: (f) => limitLabel(f.downloadLimit, f.limitPeriod) },
    { key: 'downloads', header: 'Downloads (30 days)', align: 'right', cell: (f) => <span className="tabular">{num(f.usage?.downloads30d ?? 0)}</span> },
    { key: 'customers', header: 'Customers', align: 'right', cell: (f) => <span className="tabular">{num(f.usage?.customers ?? 0)}</span> },
    { key: 'resources', header: 'Offered in', cell: (f) => (f.resourceCount ? `${f.resourceCount} resource${f.resourceCount === 1 ? '' : 's'}` : <span className="text-warning">Not offered</span>) },
    { key: 'created', header: 'Uploaded', priority: 'low', cell: (f) => <When value={f.createdAt} /> },
  ];
  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search title or file name…" className="w-full sm:w-72" />
      </Toolbar>
      {files.error ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : (
        <DataTable
          caption="Protected files"
          columns={columns}
          rows={files.data?.data}
          rowKey={(f) => f.id}
          rowHref={(f) => `/content/files/${f.id}`}
          loading={files.isLoading}
          fetching={files.isFetching && !files.isLoading}
          empty={state.q ? <EmptyState title="No files match your search" /> : <EmptyState icon={<FileDown />} title="No protected files yet" description="Upload files, then offer them through a Downloads resource restricted to the right plans or groups." />}
        />
      )}
      {files.data && <Pagination page={files.data.page} pageSize={files.data.pageSize} total={files.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </Card>
  );
}

function SettingsTab({ editable }: { editable: boolean }) {
  const settings = useQuery({ queryKey: ['access-settings'], queryFn: () => api.get<AccessSettings>('/api/admin/access/settings') });
  if (settings.isLoading) return <Skeleton className="h-64" />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  return <SettingsForm key={JSON.stringify(settings.data)} settings={settings.data!} editable={editable} />;
}

function SettingsForm({ settings, editable }: { settings: AccessSettings; editable: boolean }) {
  const [maxMb, setMaxMb] = useState(String(Math.round((settings.maxFileBytes / MB) * 10) / 10));
  const [ttl, setTtl] = useState(String(settings.linkTtlMinutes));
  const [limited, setLimited] = useState(settings.defaultDownloadLimit !== null);
  const [limit, setLimit] = useState(String(settings.defaultDownloadLimit ?? 10));
  const [period, setPeriod] = useState<LimitPeriod>(settings.defaultLimitPeriod);
  const [retention, setRetention] = useState(String(settings.logRetentionDays));
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () =>
      api.patch<AccessSettings>('/api/admin/access/settings', {
        maxFileBytes: Math.round(Number(maxMb) * MB),
        linkTtlMinutes: Number(ttl),
        defaultDownloadLimit: limited ? Number(limit) : null,
        defaultLimitPeriod: period,
        logRetentionDays: Number(retention),
      }),
    { success: 'Settings saved', invalidate: [['access-settings']], onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Card title="Download settings" description="Apply to every protected file. Limits of files already uploaded are changed on each file.">
      <form
        className="grid max-w-2xl gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Largest upload" htmlFor="set-max" hint="Up to 512 MB">
          <div className="flex items-center gap-2">
            <Input id="set-max" type="number" min={0.001} max={512} step="any" inputMode="decimal" className="w-28" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} disabled={!editable} />
            <span className="text-sm text-muted-foreground">MB</span>
          </div>
        </Field>
        <Field label="Download links stay valid for" htmlFor="set-ttl" hint="Customers request a new link after it expires">
          <div className="flex items-center gap-2">
            <Input id="set-ttl" type="number" min={1} max={1440} inputMode="numeric" className="w-28" value={ttl} onChange={(e) => setTtl(e.target.value)} disabled={!editable} />
            <span className="text-sm text-muted-foreground">minutes</span>
          </div>
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <Switch checked={limited} onCheckedChange={setLimited} disabled={!editable} label="Limit downloads of new files" description="Per customer; counted over a rolling period." />
          {limited && (
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Downloads" type="number" min={1} max={100000} inputMode="numeric" className="w-28" value={limit} onChange={(e) => setLimit(e.target.value)} disabled={!editable} />
              <Select aria-label="Period" className="w-auto" value={period} onChange={(e) => setPeriod(e.target.value as LimitPeriod)} disabled={!editable} options={PERIODS.map((p) => ({ value: p.value, label: `downloads ${p.label}` }))} />
            </div>
          )}
        </div>
        <Field label="Keep the access log for" htmlFor="set-retention">
          <div className="flex items-center gap-2">
            <Input id="set-retention" type="number" min={7} max={3650} inputMode="numeric" className="w-28" value={retention} onChange={(e) => setRetention(e.target.value)} disabled={!editable} />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </Field>
        {editable && (
          <div className="sm:col-span-2">
            <Button type="submit" loading={save.isPending}>
              Save settings
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

export default function FilesPage() {
  const { can, me } = useAuth();
  const manage = can('access.files.manage') && !me?.admin.orgScope;
  const [state, setState] = useUrlState(DEFAULTS);
  const tab = String(state.tab);
  return (
    <>
      <PageHeader
        title="Downloads"
        description="Files offered only to customers with access, through short-lived signed links, with a download limit per customer."
        actions={manage && <UploadButton />}
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setState({ tab: v, q: undefined })}
        tabs={[
          { value: 'files', label: 'Files', content: tab === 'files' && <FilesTab state={state} setState={setState} /> },
          {
            value: 'log',
            label: 'Download log',
            content: tab === 'log' && (
              <Card padded={false}>
                <DownloadLog />
              </Card>
            ),
          },
          { value: 'settings', label: 'Settings', content: tab === 'settings' && <SettingsTab editable={manage} /> },
        ]}
      />
    </>
  );
}
