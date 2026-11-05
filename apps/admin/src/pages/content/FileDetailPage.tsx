import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, num } from '../../lib/format';
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  Mono,
  PageHeader,
  PageSkeleton,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  useConfirm,
  useToast,
} from '../../components/ui';
import { DownloadLog } from './DownloadLog';
import { PERIODS, fileSize, limitLabel, type AccessFile, type LimitPeriod } from './shared';

interface FileDetail extends AccessFile {
  resources: { id: string; title: string; status: string }[];
}

function FileSettings({ file, editable }: { file: FileDetail; editable: boolean }) {
  const [title, setTitle] = useState(file.title);
  const [description, setDescription] = useState(file.description);
  const [limited, setLimited] = useState(file.downloadLimit !== null);
  const [limit, setLimit] = useState(String(file.downloadLimit ?? 10));
  const [period, setPeriod] = useState<LimitPeriod>(file.limitPeriod);
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => api.patch<AccessFile>(`/api/admin/access/files/${file.id}`, { title, description, downloadLimit: limited ? Number(limit) : null, limitPeriod: period }),
    { success: 'File saved', invalidate: [['access-file', file.id], ['access-files'], ['access-options']], onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Card title="Details and limit">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Title" htmlFor="file-title" hint="Shown to customers next to the download.">
          <Input id="file-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required disabled={!editable} />
        </Field>
        <Field label="Description" htmlFor="file-description">
          <Textarea id="file-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} disabled={!editable} />
        </Field>
        <div className="space-y-2">
          <Switch checked={limited} onCheckedChange={setLimited} disabled={!editable} label="Limit downloads per customer" description="Counted over a rolling period; customers see how many they have left and when more become available." />
          {limited && (
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Downloads allowed" type="number" min={1} max={100000} inputMode="numeric" className="w-28" value={limit} onChange={(e) => setLimit(e.target.value)} disabled={!editable} />
              <Select aria-label="Period" className="w-auto" value={period} onChange={(e) => setPeriod(e.target.value as LimitPeriod)} disabled={!editable} options={PERIODS.map((p) => ({ value: p.value, label: `downloads ${p.label}` }))} />
            </div>
          )}
        </div>
        {editable && (
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}

export default function FileDetailPage() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const manage = can('access.files.manage') && !me?.admin.orgScope;
  const file = useQuery({ queryKey: ['access-file', id], queryFn: () => api.get<FileDetail>(`/api/admin/access/files/${id}`) });

  const replace = useAction(
    (upload: File) => {
      const form = new FormData();
      form.append('file', upload);
      return api.upload<AccessFile>(`/api/admin/access/files/${id}/content`, form);
    },
    { success: (saved) => `Replaced with ${saved.filename}`, error: 'Could not replace the file', invalidate: [['access-file', id], ['access-files'], ['access-options']] },
  );
  const remove = useAction(() => api.delete(`/api/admin/access/files/${id}`), {
    success: 'File deleted',
    error: 'Could not delete the file',
    invalidate: [['access-files'], ['access-options']],
    onSuccess: () => navigate('/content/files'),
  });

  if (file.isLoading) return <PageSkeleton />;
  if (file.error) {
    if (file.error instanceof ApiError && file.error.status === 404) return <EmptyState title="File not found" description="It may have been deleted." action={<ButtonLink to="/content/files">All downloads</ButtonLink>} />;
    return <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  }
  const f = file.data!;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Downloads', to: '/content/files' }, { label: f.title }]}
        title={f.title}
        description={`${f.filename} · ${fileSize(f.size)} · ${limitLabel(f.downloadLimit, f.limitPeriod)} per customer`}
        actions={
          <>
            <Button
              variant="outline"
              icon={<Download className="size-4" />}
              onClick={() => download(`/api/admin/access/files/${f.id}/download`, undefined, f.filename).catch((err) => toast.error('Download failed', errorMessage(err)))}
            >
              Download
            </Button>
            {manage && (
              <>
                <input
                  ref={input}
                  type="file"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    e.target.value = '';
                    if (picked) replace.mutate(picked);
                  }}
                />
                <Button variant="outline" icon={<RefreshCw className="size-4" />} loading={replace.isPending} onClick={() => input.current?.click()}>
                  Replace file
                </Button>
                <Button
                  variant="outline"
                  icon={<Trash2 className="size-4" />}
                  onClick={async () => {
                    const res = await confirm({
                      title: `Delete “${f.title}”?`,
                      description: f.resources.length ? 'Resources still offer this file; remove it from them first.' : 'The file and its download history are deleted. Links already handed out stop working.',
                      tone: 'danger',
                      confirmLabel: 'Delete file',
                    });
                    if (res.confirmed) remove.mutate();
                  }}
                >
                  Delete
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <FileSettings key={f.updatedAt} file={f} editable={manage} />
          <Card title="Download log" padded={false}>
            <DownloadLog fileId={f.id} />
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Usage">
            <KeyValue
              columns={1}
              items={[
                { label: 'Downloads in the last 30 days', value: <span className="tabular">{num(f.usage?.downloads30d ?? 0)}</span> },
                { label: 'Downloads in total', value: <span className="tabular">{num(f.usage?.downloadsTotal ?? 0)}</span> },
                { label: 'Customers', value: <span className="tabular">{num(f.usage?.customers ?? 0)}</span> },
              ]}
            />
          </Card>
          <Card title="Offered in" padded={false}>
            {f.resources.length ? (
              <ul className="divide-y">
                {f.resources.map((r) => (
                  <li key={r.id}>
                    <Link to={`/content/resources/${r.id}`} className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/40">
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      {r.status !== 'active' && <StatusBadge status={r.status} />}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">Not offered yet. Add it to a Downloads resource so customers with access can get it.</p>
            )}
          </Card>
          <Card title="File">
            <KeyValue
              columns={1}
              items={[
                { label: 'File name', value: f.filename },
                { label: 'Type', value: f.contentType },
                { label: 'Size', value: fileSize(f.size) },
                { label: 'SHA-256', value: <Mono copy>{f.sha256}</Mono> },
                { label: 'Uploaded', value: dateTime(f.createdAt) },
                { label: 'Updated', value: dateTime(f.updatedAt) },
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
