import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Signature } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { date, num } from '../../lib/format';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Switch, Textarea, Toolbar, type Column } from '../../components/ui';
import type { Agreement } from './types';

export function keyFrom(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 64);
}

/** A datetime-local value (local time) to an ISO string, or undefined when empty. */
export function isoFromLocal(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function CreateAgreementDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: '', key: '', description: '', required: false, body: '', effectiveAt: '' });
  const [keyEdited, setKeyEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    () =>
      api.post<Agreement>('/api/admin/agreements', {
        title: form.title,
        key: form.key,
        description: form.description,
        required: form.required,
        body: form.body,
        effectiveAt: isoFromLocal(form.effectiveAt),
      }),
    {
      success: 'Agreement published',
      invalidate: [['agreements']],
      onSuccess: (a) => {
        onOpenChange(false);
        navigate(`/customers/agreements/${a.id}`);
      },
      onError: (err) => setError(errorMessage(err)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New agreement"
      description="Terms of service, privacy policy or any document customers accept. The text becomes version 1; later changes are published as new versions."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-agreement" loading={create.isPending}>
            Publish
          </Button>
        </>
      }
    >
      <form
        id="create-agreement"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Title" htmlFor="ag-title" required>
          <Input
            id="ag-title"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value, key: keyEdited ? f.key : keyFrom(e.target.value) }))}
            required
            autoFocus
          />
        </Field>
        <Field label="Key" htmlFor="ag-key" required hint="Used in the API, e.g. /api/public/agreements/terms">
          <Input
            id="ag-key"
            className="font-mono"
            value={form.key}
            onChange={(e) => {
              setKeyEdited(true);
              setForm((f) => ({ ...f, key: e.target.value }));
            }}
            required
          />
        </Field>
        <Field label="Description" htmlFor="ag-desc" className="sm:col-span-2" hint="For administrators; customers see the title and text">
          <Input id="ag-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
        <Field label="Text" htmlFor="ag-body" required className="sm:col-span-2">
          <Textarea id="ag-body" rows={10} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} required />
        </Field>
        <Field label="Takes effect" htmlFor="ag-effective" hint="Leave empty to publish now">
          <Input id="ag-effective" type="datetime-local" value={form.effectiveAt} onChange={(e) => setForm((f) => ({ ...f, effectiveAt: e.target.value }))} />
        </Field>
        <div className="sm:col-span-2">
          <Switch checked={form.required} onCheckedChange={(v) => setForm((f) => ({ ...f, required: v }))} label="Every customer must accept the current version" description="Your app lists it as pending (client API) until the customer accepts; a new version asks again." />
        </div>
      </form>
    </Modal>
  );
}

export default function AgreementsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState(false);
  const q = useQuery({ queryKey: ['agreements', archived], queryFn: () => api.get<{ data: Agreement[] }>('/api/admin/agreements', archived ? { archived: 'true' } : undefined) });

  const columns: Column<Agreement>[] = [
    {
      key: 'title',
      header: 'Agreement',
      cell: (a) => (
        <span className="min-w-0">
          <span className="block truncate">{a.title}</span>
          <code className="block truncate font-mono text-xs font-normal text-muted-foreground">{a.key}</code>
        </span>
      ),
    },
    {
      key: 'current',
      header: 'Current version',
      cell: (a) => (a.current ? `v${a.current.version} · since ${date(a.current.effectiveAt)}` : <span className="text-muted-foreground">Not in effect yet</span>),
    },
    { key: 'upcoming', header: 'Scheduled', priority: 'low', cell: (a) => (a.upcoming ? `v${a.upcoming.version} on ${date(a.upcoming.effectiveAt)}` : <span className="text-muted-foreground">—</span>) },
    {
      key: 'flags',
      header: 'Acceptance',
      cell: (a) => (
        <span className="flex flex-wrap gap-1">
          {a.required ? <Badge tone="primary">required</Badge> : <Badge>optional</Badge>}
          {a.archivedAt && <Badge>archived</Badge>}
        </span>
      ),
    },
    { key: 'acceptances', header: 'Accepted', align: 'right', cell: (a) => <span className="tabular">{num(a.acceptances)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Agreements"
        description="Versioned terms and policies, and a record of which version each customer accepted, when and from where."
        actions={
          can('customers.agreements.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New agreement
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <Checkbox checked={archived} onChange={(e) => setArchived(e.target.checked)} label="Show archived" />
        </Toolbar>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <DataTable
            caption="Agreements"
            columns={columns}
            rows={q.data?.data}
            rowKey={(a) => a.id}
            rowHref={(a) => `/customers/agreements/${a.id}`}
            loading={q.isLoading}
            empty={
              <EmptyState
                icon={<Signature />}
                title="No agreements yet"
                description="Publish your terms of service or privacy policy, require them on signup forms, and keep proof of acceptance."
                action={can('customers.agreements.manage') ? <Button onClick={() => setCreating(true)}>New agreement</Button> : undefined}
              />
            }
          />
        )}
      </Card>
      <CreateAgreementDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
