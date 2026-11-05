import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Archive, Eye, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, num } from '../../lib/format';
import { Badge, Button, Card, CodeBlock, DataTable, EmptyState, ErrorState, Field, FormError, Input, Menu, Modal, PageHeader, PageSkeleton, Pagination, Select, Switch, Textarea, Toolbar, When, useConfirm, type Column, type Tone } from '../../components/ui';
import { describeAgent } from '../admin/shared';
import { isoFromLocal } from './AgreementsPage';
import { SOURCE_LABELS, type Acceptance, type AgreementDetail } from './types';

type Version = AgreementDetail['versionList'][number];

function localValue(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function VersionDialog({ agreement, version, onClose }: { agreement: AgreementDetail; version?: Version; onClose: () => void }) {
  const [form, setForm] = useState({ title: version?.title ?? agreement.title, body: version?.body ?? agreement.versionList[0]?.body ?? '', summary: version?.summary ?? '', effectiveAt: version ? localValue(version.effectiveAt) : '' });
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => {
      const body = { title: form.title, body: form.body, summary: form.summary || undefined, effectiveAt: isoFromLocal(form.effectiveAt) };
      return version ? api.patch(`/api/admin/agreement-versions/${version.versionId}`, body) : api.post(`/api/admin/agreements/${agreement.id}/versions`, body);
    },
    { success: version ? 'Version updated' : 'Version published', invalidate: [['agreement', agreement.id], ['agreements']], onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={version ? `Edit version ${version.version}` : 'Publish a new version'}
      description={agreement.required ? 'Customers will be asked to accept this version once it takes effect.' : 'Customers who sign up after it takes effect accept this version.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="agreement-version" loading={save.isPending}>
            {version ? 'Save' : 'Publish'}
          </Button>
        </>
      }
    >
      <form
        id="agreement-version"
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
        <Field label="Title" htmlFor="ver-title" required>
          <Input id="ver-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
        </Field>
        <Field label="Takes effect" htmlFor="ver-effective" hint="Leave empty for now; a later date schedules the version">
          <Input id="ver-effective" type="datetime-local" value={form.effectiveAt} onChange={(e) => setForm((f) => ({ ...f, effectiveAt: e.target.value }))} />
        </Field>
        <Field label="What changed" htmlFor="ver-summary" className="sm:col-span-2" hint="Shown to customers next to the new text">
          <Input id="ver-summary" value={form.summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} />
        </Field>
        <Field label="Text" htmlFor="ver-body" required className="sm:col-span-2">
          <Textarea id="ver-body" rows={12} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} required />
        </Field>
      </form>
    </Modal>
  );
}

function versionState(agreement: AgreementDetail, v: Version): 'current' | 'scheduled' | 'superseded' {
  if (agreement.current?.versionId === v.versionId) return 'current';
  return new Date(v.effectiveAt) > new Date() ? 'scheduled' : 'superseded';
}

const STATE_TONE: Record<ReturnType<typeof versionState>, Tone> = { current: 'success', scheduled: 'info', superseded: 'neutral' };

function Acceptances({ agreement }: { agreement: AgreementDetail }) {
  const [versionId, setVersionId] = useState('');
  const [page, setPage] = useState(1);
  const query = { versionId: versionId || undefined, page, pageSize: 25 };
  const q = useQuery({ queryKey: ['agreement-acceptances', agreement.id, query], queryFn: () => api.get<Page<Acceptance>>(`/api/admin/agreements/${agreement.id}/acceptances`, query), placeholderData: keepPreviousData });
  const columns: Column<Acceptance>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (a) => (
        <Link to={`/customers/users/${a.user_id}`} className="min-w-0 hover:underline">
          <span className="block truncate">{a.name || a.email}</span>
          {a.name && <span className="block truncate text-xs font-normal text-muted-foreground">{a.email}</span>}
        </Link>
      ),
    },
    { key: 'version', header: 'Version', cell: (a) => `v${a.version}` },
    { key: 'when', header: 'Accepted', cell: (a) => <When value={a.accepted_at} /> },
    { key: 'ip', header: 'IP address', cell: (a) => (a.ip ? <code className="font-mono text-xs">{a.ip}</code> : <span className="text-muted-foreground">—</span>) },
    { key: 'source', header: 'Through', cell: (a) => SOURCE_LABELS[a.source] ?? a.source },
    { key: 'device', header: 'Device', priority: 'low', cell: (a) => describeAgent(a.user_agent) },
  ];
  return (
    <Card title="Acceptances" padded={false}>
      <Toolbar>
        <Select
          aria-label="Version"
          className="w-auto"
          value={versionId}
          onChange={(e) => {
            setVersionId(e.target.value);
            setPage(1);
          }}
          placeholder="Every version"
          options={agreement.versionList.map((v) => ({ value: v.versionId, label: `Version ${v.version}` }))}
        />
      </Toolbar>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable caption="Acceptances" columns={columns} rows={q.data?.data} rowKey={(a) => a.id} loading={q.isLoading} fetching={q.isFetching && !q.isLoading} empty={<EmptyState title="Nobody has accepted this yet" />} />
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
    </Card>
  );
}

export default function AgreementDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Version | 'new' | null>(null);
  const [reading, setReading] = useState<Version | null>(null);
  const q = useQuery({ queryKey: ['agreement', id], queryFn: () => api.get<AgreementDetail>(`/api/admin/agreements/${id}`) });
  const invalidate = [['agreement', id], ['agreements']];
  const update = useAction((body: { required?: boolean; archived?: boolean }) => api.patch(`/api/admin/agreements/${id}`, body), { success: 'Agreement updated', invalidate });
  const withdraw = useAction((versionId: string) => api.delete(`/api/admin/agreement-versions/${versionId}`), { success: 'Version withdrawn', invalidate });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const a = q.data;
  const manage = can('customers.agreements.manage');
  const latest = a.versionList[0];

  const columns: Column<Version>[] = [
    {
      key: 'version',
      header: 'Version',
      cell: (v) => (
        <button type="button" className="min-w-0 text-left" onClick={() => setReading(v)}>
          <span className="block truncate font-medium hover:underline">
            v{v.version} · {v.title}
          </span>
          {v.summary && <span className="block truncate text-xs text-muted-foreground">{v.summary}</span>}
        </button>
      ),
    },
    { key: 'state', header: 'Status', cell: (v) => <Badge tone={STATE_TONE[versionState(a, v)]}>{versionState(a, v)}</Badge> },
    { key: 'effective', header: 'Takes effect', cell: (v) => dateTime(v.effectiveAt) },
    { key: 'acceptances', header: 'Accepted', align: 'right', cell: (v) => <span className="tabular">{num(v.acceptances)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (v) => {
        const editable = manage && versionState(a, v) === 'scheduled' && v.acceptances === 0;
        return (
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for version ${v.version}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            }
            items={[
              { label: 'Read text', icon: <Eye className="size-4" />, onSelect: () => setReading(v) },
              { label: 'Edit', icon: <Pencil className="size-4" />, hidden: !editable, onSelect: () => setEditing(v) },
              {
                label: 'Withdraw',
                icon: <Trash2 className="size-4" />,
                danger: true,
                hidden: !editable || v.versionId !== latest?.versionId || a.versionList.length < 2,
                onSelect: async () => {
                  if ((await confirm({ title: `Withdraw version ${v.version}?`, description: 'It will not take effect.', tone: 'danger', confirmLabel: 'Withdraw' })).confirmed) withdraw.mutate(v.versionId);
                },
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Agreements', to: '/customers/agreements' }, { label: a.title }]}
        title={a.title}
        description={a.description || undefined}
        meta={
          <>
            <code className="font-mono text-xs text-muted-foreground">{a.key}</code>
            {a.required ? <Badge tone="primary">required for every customer</Badge> : <Badge>accepted at signup only</Badge>}
            {a.archivedAt && <Badge>archived</Badge>}
          </>
        }
        actions={
          manage && (
            <>
              {!a.archivedAt && (
                <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                  New version
                </Button>
              )}
              <Menu
                trigger={
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
                items={[
                  a.archivedAt
                    ? { label: 'Restore', icon: <RotateCcw className="size-4" />, onSelect: () => update.mutate({ archived: false }) }
                    : {
                        label: 'Archive',
                        icon: <Archive className="size-4" />,
                        onSelect: async () => {
                          if ((await confirm({ title: `Archive ${a.title}?`, description: 'Customers are no longer asked to accept it. Acceptance records are kept.', confirmLabel: 'Archive' })).confirmed) update.mutate({ archived: true });
                        },
                      },
                ]}
              />
            </>
          )
        }
      />
      <div className="space-y-4">
        <Card>
          <Switch
            checked={a.required}
            disabled={!manage || Boolean(a.archivedAt) || update.isPending}
            onCheckedChange={(required) => update.mutate({ required })}
            label="Every customer must accept the current version"
            description="Your app lists required agreements the customer has not accepted (GET /api/client/agreements) and records acceptance. Optional agreements are accepted on signup forms."
          />
          <div className="mt-4">
            <p className="mb-1.5 text-sm font-medium">Public text</p>
            <CodeBlock code={`GET /api/public/agreements/${a.key}`} />
          </div>
        </Card>
        <Card title="Versions" padded={false}>
          <DataTable caption="Versions" columns={columns} rows={a.versionList} rowKey={(v) => v.versionId} empty={<EmptyState title="No versions" />} />
        </Card>
        <Acceptances agreement={a} />
      </div>
      {editing && <VersionDialog agreement={a} version={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {reading && (
        <Modal open onOpenChange={(o) => !o && setReading(null)} size="lg" title={`${reading.title} · version ${reading.version}`} description={`Takes effect ${dateTime(reading.effectiveAt)}`}>
          {reading.summary && <p className="mb-3 text-sm font-medium">{reading.summary}</p>}
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{reading.body}</div>
        </Modal>
      )}
    </>
  );
}
