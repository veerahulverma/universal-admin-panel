import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, FileLock2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, download, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  Toolbar,
  When,
  useConfirm,
  useToast,
  type Column,
} from '../../components/ui';
import { UserPicker, type CustomFieldDef, type PickedUser } from './shared';

interface PrivacyRequest {
  id: string;
  user_id: string;
  email: string;
  type: 'export' | 'delete';
  status: 'pending' | 'processing' | 'completed' | 'rejected';
  source: 'admin' | 'api' | 'user';
  requested_by: string | null;
  notes: string | null;
  file_id: string | null;
  due_at: string;
  completed_at: string | null;
  created_at: string;
}

const TYPE_LABEL = { export: 'Data export', delete: 'Erasure' } as const;
const REQUEST_DEFAULTS = { status: 'pending', page: 1, pageSize: 25 };

// ---- Requests --------------------------------------------------------------------------------

function NewRequestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [user, setUser] = useState<PickedUser | null>(null);
  const [type, setType] = useState<'export' | 'delete'>('export');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction(() => api.post('/api/admin/privacy-requests', { userId: user!.id, type, notes: notes.trim() || undefined }), {
    success: 'Request logged',
    invalidate: [['privacy-requests']],
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Log a privacy request"
      description="Record a data export (access/portability) or erasure request received from a customer. The due date follows the response deadline set in Settings → Customers."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-privacy" loading={create.isPending} disabled={!user}>
            Log request
          </Button>
        </>
      }
    >
      <form
        id="new-privacy"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Customer" htmlFor="pr-user" required>
          <UserPicker id="pr-user" value={user} onChange={setUser} />
        </Field>
        <Field label="Request type" htmlFor="pr-type">
          <Select
            id="pr-type"
            value={type}
            onChange={(e) => setType(e.target.value as 'export' | 'delete')}
            options={[
              { value: 'export', label: 'Data export: send the customer a copy of their data' },
              { value: 'delete', label: 'Erasure: anonymize the customer’s personal data' },
            ]}
          />
        </Field>
        <Field label="Notes" htmlFor="pr-notes" hint="How the request arrived, identity verification performed, ticket number…">
          <Textarea id="pr-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
      </form>
    </Modal>
  );
}

function RequestsTab() {
  const confirm = useConfirm();
  const toast = useToast();
  const [state, setState] = useUrlState(REQUEST_DEFAULTS);
  const [creating, setCreating] = useState(false);
  const status = String(state.status);
  const requests = useQuery({
    queryKey: ['privacy-requests', status, state.page],
    queryFn: ({ signal }) => api.get<Page<PrivacyRequest>>('/api/admin/privacy-requests', { status: status === 'all' ? undefined : status, page: state.page, pageSize: state.pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const act = useAction((v: { id: string; action: 'complete' | 'reject'; notes?: string }) => api.post<PrivacyRequest>(`/api/admin/privacy-requests/${v.id}/${v.action}`, { notes: v.notes }), {
    success: (r, v) => (v.action === 'reject' ? 'Request rejected' : r.type === 'export' ? 'Export generated; the customer was emailed' : 'Personal data erased'),
    invalidate: [['privacy-requests']],
  });

  const complete = async (r: PrivacyRequest) => {
    const res =
      r.type === 'delete'
        ? await confirm({
            title: `Erase personal data of ${r.email}?`,
            description: 'Name, email and profile data are irreversibly anonymized across modules (support messages, affiliate records…). Financial records are kept where the law requires them.',
            tone: 'danger',
            confirmLabel: 'Erase data',
            typeToConfirm: 'ERASE',
            reason: { label: 'Notes (optional)' },
          })
        : await confirm({ title: `Generate the data export for ${r.email}?`, description: 'A JSON file with the customer’s data from every module is stored, and the customer is emailed that it is ready.', confirmLabel: 'Generate export', reason: { label: 'Notes (optional)' } });
    if (res.confirmed) act.mutate({ id: r.id, action: 'complete', notes: res.reason });
  };

  const reject = async (r: PrivacyRequest) => {
    const res = await confirm({ title: 'Reject this request?', description: 'Use this when the request cannot be verified or is not valid. Explain why; the note is kept with the request.', tone: 'danger', confirmLabel: 'Reject', reason: { label: 'Reason', required: true } });
    if (res.confirmed) act.mutate({ id: r.id, action: 'reject', notes: res.reason });
  };

  const now = Date.now();
  const columns: Column<PrivacyRequest>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) => (
        <Link to={`/customers/users/${r.user_id}`} className="block max-w-[16rem] truncate font-medium hover:underline">
          {r.email}
        </Link>
      ),
    },
    { key: 'type', header: 'Type', cell: (r) => <Badge tone={r.type === 'delete' ? 'danger' : 'info'}>{TYPE_LABEL[r.type]}</Badge> },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'due',
      header: 'Due',
      cell: (r) => {
        const open = r.status === 'pending' || r.status === 'processing';
        const overdue = open && new Date(r.due_at).getTime() < now;
        return open ? (
          <span className={overdue ? 'font-medium text-danger' : undefined} title={dateTime(r.due_at)}>
            {overdue ? 'Overdue · ' : ''}
            <When value={r.due_at} />
          </span>
        ) : (
          <span className="text-muted-foreground" title={dateTime(r.completed_at)}>
            Done <When value={r.completed_at} />
          </span>
        );
      },
    },
    { key: 'source', header: 'Source', priority: 'low', cell: (r) => <Badge>{r.source}</Badge> },
    { key: 'notes', header: 'Notes', priority: 'low', cell: (r) => <span className="block max-w-xs truncate text-muted-foreground" title={r.notes ?? undefined}>{r.notes ?? '—'}</span> },
    { key: 'created', header: 'Received', cell: (r) => <When value={r.created_at} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <span className="inline-flex flex-wrap justify-end gap-1.5">
          {(r.status === 'pending' || r.status === 'processing') && (
            <>
              <Button size="sm" variant={r.type === 'delete' ? 'danger' : 'primary'} onClick={() => void complete(r)} loading={act.isPending && act.variables?.id === r.id && act.variables.action === 'complete'}>
                {r.type === 'delete' ? 'Erase' : 'Export'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void reject(r)}>
                Reject
              </Button>
            </>
          )}
          {r.file_id && (
            <Button
              size="sm"
              variant="outline"
              icon={<Download className="size-3.5" />}
              onClick={() => download(`/api/admin/files/${r.file_id}`, undefined, `user-${r.user_id}.json`).catch((err) => toast.error('Download failed', errorMessage(err)))}
            >
              Download
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select
          aria-label="Status"
          className="w-auto"
          value={status}
          onChange={(e) => setState({ status: e.target.value })}
          options={[
            { value: 'pending', label: 'Open' },
            { value: 'completed', label: 'Completed' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'all', label: 'All requests' },
          ]}
        />
        <div className="ml-auto">
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Log request
          </Button>
        </div>
      </Toolbar>
      {requests.error ? (
        <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
      ) : (
        <DataTable
          caption="Privacy requests"
          columns={columns}
          rows={requests.data?.data}
          rowKey={(r) => r.id}
          loading={requests.isLoading}
          fetching={requests.isFetching && !requests.isLoading}
          empty={
            <EmptyState
              icon={<FileLock2 />}
              title={status === 'pending' ? 'No open requests' : 'No requests'}
              description="Data export and erasure requests appear here with their legal due date."
            />
          }
        />
      )}
      {requests.data && <Pagination page={requests.data.page} pageSize={requests.data.pageSize} total={requests.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      {creating && <NewRequestDialog open={creating} onOpenChange={setCreating} />}
    </Card>
  );
}

// ---- Custom fields -----------------------------------------------------------------------------

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'select', label: 'Choice list' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
];

function FieldDialog({ field, onClose }: { field: CustomFieldDef | 'new'; onClose: () => void }) {
  const isNew = field === 'new';
  const [form, setForm] = useState({
    entity: isNew ? 'user' : field.entity,
    key: isNew ? '' : field.key,
    label: isNew ? '' : field.label,
    type: isNew ? 'text' : field.type,
    options: isNew ? '' : field.options.join('\n'),
    required: isNew ? false : field.required,
    showInList: isNew ? false : field.show_in_list,
    position: isNew ? '0' : String(field.position),
  });
  const [error, setError] = useState<string | null>(null);
  const options = form.options.split('\n').map((o) => o.trim()).filter(Boolean);
  const save = useAction(
    () =>
      isNew
        ? api.post('/api/admin/custom-fields', { entity: form.entity, key: form.key, label: form.label, type: form.type, options, required: form.required, showInList: form.showInList, position: Number(form.position) || 0 })
        : api.patch(`/api/admin/custom-fields/${field.id}`, { label: form.label, options, required: form.required, showInList: form.showInList, position: Number(form.position) || 0 }),
    { success: isNew ? 'Custom field created' : 'Custom field updated', invalidate: [['custom-fields']], onSuccess: onClose, onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'New custom field' : `Edit “${field.label}”`}
      description={isNew ? 'Custom fields add your own attributes to users or organizations. They are validated on the server and available through the API.' : 'The key, type and entity cannot change after creation.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="custom-field" loading={save.isPending}>
            {isNew ? 'Create field' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        id="custom-field"
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
        <Field label="Applies to" htmlFor="cf-entity">
          <Select id="cf-entity" value={form.entity} disabled={!isNew} onChange={(e) => setForm({ ...form, entity: e.target.value as 'user' | 'organization' })} options={[{ value: 'user', label: 'Users' }, { value: 'organization', label: 'Organizations' }]} />
        </Field>
        <Field label="Type" htmlFor="cf-type">
          <Select id="cf-type" value={form.type} disabled={!isNew} onChange={(e) => setForm({ ...form, type: e.target.value as CustomFieldDef['type'] })} options={FIELD_TYPES} />
        </Field>
        <Field label="Label" htmlFor="cf-label" required>
          <Input id="cf-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required maxLength={80} />
        </Field>
        <Field label="Key" htmlFor="cf-key" hint="Lowercase letters, digits and underscores; used in the API" required>
          <Input id="cf-key" className="font-mono" value={form.key} disabled={!isNew} onChange={(e) => setForm({ ...form, key: e.target.value })} required pattern="[a-z][a-z0-9_]{0,39}" placeholder="industry" />
        </Field>
        {form.type === 'select' && (
          <Field label="Choices" htmlFor="cf-options" hint="One per line" className="sm:col-span-2" required>
            <Textarea id="cf-options" rows={4} value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} />
          </Field>
        )}
        <Field label="Position" htmlFor="cf-position" hint="Lower numbers are shown first">
          <Input id="cf-position" type="number" step={1} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <Checkbox checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} label="Required" description="Records cannot be created or saved without a value." />
          <Checkbox checked={form.showInList} onChange={(e) => setForm({ ...form, showInList: e.target.checked })} label="Show in lists" />
        </div>
      </form>
    </Modal>
  );
}

function CustomFieldsTab() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('customers.fields.manage');
  const [editing, setEditing] = useState<CustomFieldDef | 'new' | null>(null);
  const fields = useQuery({ queryKey: ['custom-fields', 'all'], queryFn: () => api.get<{ data: CustomFieldDef[] }>('/api/admin/custom-fields') });
  const remove = useAction((id: string) => api.delete(`/api/admin/custom-fields/${id}`), { success: 'Custom field deleted', invalidate: [['custom-fields']] });

  const columns: Column<CustomFieldDef>[] = [
    {
      key: 'label',
      header: 'Field',
      cell: (f) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{f.label}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{f.key}</span>
        </span>
      ),
    },
    { key: 'entity', header: 'Applies to', cell: (f) => <Badge tone={f.entity === 'user' ? 'info' : 'primary'}>{f.entity === 'user' ? 'Users' : 'Organizations'}</Badge> },
    { key: 'type', header: 'Type', cell: (f) => FIELD_TYPES.find((t) => t.value === f.type)?.label ?? f.type },
    { key: 'options', header: 'Choices', priority: 'low', cell: (f) => (f.options.length ? <span className="block max-w-xs truncate" title={f.options.join(', ')}>{f.options.join(', ')}</span> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'flags',
      header: 'Rules',
      cell: (f) => (
        <span className="flex flex-wrap gap-1">
          {f.required && <Badge tone="warning">required</Badge>}
          {f.show_in_list && <Badge>in lists</Badge>}
          {!f.required && !f.show_in_list && <span className="text-muted-foreground">—</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (f) =>
        manage ? (
          <span className="inline-flex gap-1">
            <Button size="icon-sm" variant="ghost" aria-label={`Edit ${f.label}`} onClick={() => setEditing(f)}>
              <Pencil className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${f.label}`}
              onClick={async () => {
                const r = await confirm({ title: `Delete the “${f.label}” field?`, description: 'The definition is removed from forms and validation. Values already stored on records are kept.', tone: 'danger', confirmLabel: 'Delete field' });
                if (r.confirmed) remove.mutate(f.id);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <Card
      title="Custom fields"
      description="Extra attributes your team and your application store on users and organizations."
      padded={false}
      actions={
        manage && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New field
          </Button>
        )
      }
    >
      {fields.error ? (
        <ErrorState error={fields.error} onRetry={() => void fields.refetch()} />
      ) : (
        <DataTable caption="Custom fields" columns={columns} rows={fields.data?.data} rowKey={(f) => f.id} loading={fields.isLoading} empty={<EmptyState title="No custom fields" description="Add fields such as industry, account manager or contract renewal date." />} />
      )}
      {editing && <FieldDialog field={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

export default function PrivacyPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('customers.privacy.manage') ? 'requests' : 'fields');
  return (
    <>
      <PageHeader title="Privacy requests" description="Handle data access and erasure requests within their legal deadline, and manage the customer data model." />
      <div className="mb-4">
        <Callout title="Verify identity before acting">
          Exports and erasures act on real personal data. Confirm the request came from the account holder (for example by replying from the account’s email address) and note how you verified it.
        </Callout>
      </div>
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'requests', label: 'Requests', hidden: !can('customers.privacy.manage'), content: <RequestsTab /> },
          { value: 'fields', label: 'Custom fields', hidden: !can('customers.users.view'), content: tab === 'fields' && <CustomFieldsTab /> },
        ]}
      />
    </>
  );
}
