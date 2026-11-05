import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FilePen, Plus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { num } from '../../lib/format';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, When, type Column } from '../../components/ui';
import { keyFrom } from './AgreementsPage';
import type { SignupForm, SignupFormOptions } from './types';

function CreateFormDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useQuery({ queryKey: ['signup-form-options'], queryFn: () => api.get<SignupFormOptions>('/api/admin/signup-forms/options'), enabled: open });
  // Custom fields every customer must have start on the form; the server refuses forms without them.
  const fields = [{ type: 'profile', key: 'name', required: true }, ...(options.data?.customFields ?? []).filter((d) => d.required).map((d) => ({ type: 'custom', key: d.key, required: true }))];
  const create = useAction(() => api.post<SignupForm>('/api/admin/signup-forms', { name, key, fields, active: false }), {
    success: 'Signup form created',
    invalidate: [['signup-forms']],
    onSuccess: (f) => {
      onOpenChange(false);
      navigate(`/customers/signup-forms/${f.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New signup form"
      description="Start with a name; choose the fields, agreement and plans next. The form stays inactive until you turn it on."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-signup-form" loading={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="create-signup-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Name" htmlFor="sf-name" required>
          <Input
            id="sf-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyEdited) setKey(keyFrom(e.target.value));
            }}
            required
            autoFocus
          />
        </Field>
        <Field label="Key" htmlFor="sf-key" required hint="Your app loads the form with this key">
          <Input
            id="sf-key"
            className="font-mono"
            value={key}
            onChange={(e) => {
              setKeyEdited(true);
              setKey(e.target.value);
            }}
            required
          />
        </Field>
      </form>
    </Modal>
  );
}

export default function SignupFormsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['signup-forms'], queryFn: () => api.get<{ data: SignupForm[] }>('/api/admin/signup-forms') });
  const columns: Column<SignupForm>[] = [
    {
      key: 'name',
      header: 'Form',
      cell: (f) => (
        <span className="min-w-0">
          <span className="block truncate">{f.name}</span>
          <code className="block truncate font-mono text-xs font-normal text-muted-foreground">{f.key}</code>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (f) => (f.active ? <Badge tone="success" dot>active</Badge> : <Badge dot>inactive</Badge>) },
    { key: 'fields', header: 'Fields', cell: (f) => `${f.fields.length + 1} (${f.fields.filter((x) => x.required).length + 1} required)` },
    { key: 'agreement', header: 'Agreement', priority: 'low', cell: (f) => f.agreementTitle ?? <span className="text-muted-foreground">—</span> },
    { key: 'plans', header: 'Plans', priority: 'low', cell: (f) => (f.planIds.length ? num(f.planIds.length) : <span className="text-muted-foreground">Public plans</span>) },
    { key: 'signups', header: 'Sign-ups', align: 'right', cell: (f) => <span className="tabular">{num(f.signups ?? 0)}</span> },
    { key: 'updated', header: 'Updated', priority: 'low', cell: (f) => <When value={f.updatedAt} /> },
  ];
  return (
    <>
      <PageHeader
        title="Signup forms"
        description="What your app asks for at registration: fields, the agreement to accept, the plans offered and where to go next. Registrations are validated against the form on the server."
        actions={
          can('customers.forms.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New form
            </Button>
          )
        }
      />
      <Card padded={false}>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <DataTable
            caption="Signup forms"
            columns={columns}
            rows={q.data?.data}
            rowKey={(f) => f.id}
            rowHref={(f) => `/customers/signup-forms/${f.id}`}
            loading={q.isLoading}
            empty={
              <EmptyState
                icon={<FilePen />}
                title="No signup forms yet"
                description="Define a form, then render it in your app from GET /api/public/signup-forms/:key."
                action={can('customers.forms.manage') ? <Button onClick={() => setCreating(true)}>New form</Button> : undefined}
              />
            }
          />
        )}
      </Card>
      <CreateFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
