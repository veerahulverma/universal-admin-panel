import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LifeBuoy, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { num, pct } from '../../lib/format';
import {
  Button,
  Callout,
  Card,
  ChartCard,
  Checkbox,
  CodeBlock,
  ColumnChart,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Modal,
  PageHeader,
  PageSkeleton,
  Pagination,
  SearchInput,
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
import { FilePicker, PRIORITIES, PriorityBadge, SlaBadge, STATUS_LABEL, TICKET_STATUSES, UserPicker, minutes, toAttachments, useAgents, useCategories, type PickedUser, type TicketCategory } from './shared';
import { AgentChecklist, AssignmentTab, TicketFieldInputs, TicketFieldsEditor, fieldValues, type CategoryWithRules, type TicketField } from '../helpdesk/shared';

export interface TicketListRow {
  id: string;
  number: string;
  user_id: string | null;
  org_id: string | null;
  requester_email: string;
  requester_name: string | null;
  subject: string;
  status: string;
  priority: string;
  category_id: string | null;
  assignee_id: string | null;
  channel: string;
  tags: string[];
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
  sla_breached_at: string | null;
  escalated_at: string | null;
  csat_rating: number | null;
  created_at: string;
  updated_at: string;
  assignee_name: string | null;
  category_name: string | null;
  message_count: number;
}

interface SavedReply {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  category_id: string | null;
  updated_at: string;
}

const VIEWS = [
  { value: 'active', label: 'Active' },
  { value: 'mine', label: 'Mine' },
  { value: 'watching', label: 'Watching' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'breached', label: 'SLA breached' },
  { value: 'all', label: 'All' },
];

const DEFAULTS = { view: 'active', q: '', status: '', priority: '', categoryId: '', assigneeId: '', tag: '', sort: 'created_at', order: 'desc', page: 1, pageSize: 25 };

// ---- New ticket --------------------------------------------------------------------------------

function NewTicketDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const agents = useAgents(open);
  const categories = useCategories(open);
  const [user, setUser] = useState<PickedUser | null>(null);
  const [form, setForm] = useState({ email: '', name: '', subject: '', body: '', priority: '', categoryId: '', assigneeId: '', tags: '', authorType: 'customer' });
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const category = (categories.data?.data as CategoryWithRules[] | undefined)?.find((c) => c.id === form.categoryId);
  const fields: TicketField[] = category?.fields ?? [];
  const create = useAction(
    async () =>
      api.post<{ id: string; number: string }>('/api/admin/support/tickets', {
        userId: user?.id,
        email: user ? undefined : form.email || undefined,
        name: user ? undefined : form.name || undefined,
        subject: form.subject,
        body: form.body,
        priority: form.priority || undefined,
        categoryId: form.categoryId || undefined,
        assigneeId: form.assigneeId || undefined,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        customFields: fields.length ? fieldValues(fields, custom) : undefined,
        authorType: form.authorType,
        attachments: files.length ? await toAttachments(files) : undefined,
      }),
    {
      success: (t) => `Ticket ${t.number} created`,
      invalidate: [['tickets']],
      onSuccess: (t) => {
        onOpenChange(false);
        navigate(`/customers/support/${t.id}`);
      },
      onError: (e) => {
        setError(errorMessage(e));
        setFieldErrors(e instanceof ApiError ? e.fieldErrors() : {});
      },
    },
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New ticket"
      description="Log a request received by phone or chat, or start a conversation with a customer."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-ticket" loading={create.isPending}>
            Create ticket
          </Button>
        </>
      }
    >
      <form
        id="new-ticket"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!user && !form.email) return setError('Choose a customer or enter an email address');
          create.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        {can('customers.users.view') && (
          <Field label="Customer" htmlFor="nt-user" hint={user ? undefined : 'Or enter an email below for someone without an account.'} className="sm:col-span-2">
            <UserPicker id="nt-user" value={user} onChange={setUser} />
          </Field>
        )}
        {!user && (
          <>
            <Field label="Email" htmlFor="nt-email">
              <Input id="nt-email" type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Name" htmlFor="nt-name">
              <Input id="nt-name" value={form.name} onChange={set('name')} />
            </Field>
          </>
        )}
        <Field label="Subject" htmlFor="nt-subject" className="sm:col-span-2" required>
          <Input id="nt-subject" value={form.subject} onChange={set('subject')} maxLength={300} required />
        </Field>
        <Field label="Who wrote the first message?" htmlFor="nt-author" className="sm:col-span-2">
          <Select
            id="nt-author"
            value={form.authorType}
            onChange={set('authorType')}
            options={[
              { value: 'customer', label: 'The customer (logged on their behalf)' },
              { value: 'admin', label: 'Our team (outreach, emailed to the customer)' },
            ]}
          />
        </Field>
        <Field label="Message" htmlFor="nt-body" className="sm:col-span-2" required>
          <Textarea id="nt-body" rows={5} value={form.body} onChange={set('body')} required />
        </Field>
        <Field label="Priority" htmlFor="nt-priority">
          <Select id="nt-priority" value={form.priority} onChange={set('priority')} placeholder="Category default" options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
        </Field>
        <Field label="Category" htmlFor="nt-category">
          <Select id="nt-category" value={form.categoryId} onChange={set('categoryId')} placeholder="None" options={(categories.data?.data ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label="Assignee" htmlFor="nt-assignee" hint={form.assigneeId ? undefined : 'Empty: the category’s default agent or the round-robin rotation'}>
          <Select id="nt-assignee" value={form.assigneeId} onChange={set('assigneeId')} placeholder="Assign automatically" options={(agents.data?.data ?? []).map((a) => ({ value: a.id, label: a.name }))} />
        </Field>
        {fields.length > 0 && <TicketFieldInputs fields={fields} value={custom} onChange={setCustom} idPrefix="nt-field" errors={fieldErrors} />}
        <Field label="Tags" htmlFor="nt-tags" hint="Comma separated">
          <Input id="nt-tags" value={form.tags} onChange={set('tags')} />
        </Field>
        <div className="sm:col-span-2">
          <FilePicker id="nt-files" files={files} onChange={setFiles} />
        </div>
      </form>
    </Modal>
  );
}

// ---- Tickets -----------------------------------------------------------------------------------

function TicketsTab() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can('support.tickets.manage');
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const agents = useAgents();
  const categories = useCategories();

  // Keep the URL in sync with the debounced search box.
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = useMemo(() => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(state)) if (v !== '' && v !== undefined) out[k] = v as string | number;
    return out;
  }, [state]);

  const tickets = useQuery({
    queryKey: ['tickets', query],
    queryFn: ({ signal }) => api.get<Page<TicketListRow>>('/api/admin/support/tickets', query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const bulk = useAction((body: { action: string; value: string | null }) => api.post<{ succeeded: number; failed: { id: string; error?: string }[]; total: number }>('/api/admin/support/tickets/bulk', { ids: [...selected], ...body }), {
    invalidate: [['tickets']],
    onSuccess: (r) => {
      if (r.failed.length) toast.error(`${r.succeeded} of ${r.total} tickets updated`, r.failed[0]?.error);
      else toast.success(`${r.succeeded} ticket${r.succeeded === 1 ? '' : 's'} updated`);
      setSelected(new Set());
    },
  });

  const runTag = async (action: 'tag' | 'untag') => {
    const r = await confirm({ title: action === 'tag' ? `Tag ${selected.size} tickets` : `Remove a tag from ${selected.size} tickets`, confirmLabel: action === 'tag' ? 'Add tag' : 'Remove tag', reason: { label: 'Tag', required: true, placeholder: 'e.g. billing-bug' } });
    if (r.confirmed && r.reason) bulk.mutate({ action, value: r.reason });
  };

  const filtersActive = ['q', 'status', 'priority', 'categoryId', 'assigneeId', 'tag'].some((k) => state[k] !== '' && state[k] !== undefined);
  const view = String(state.view);

  const columns: Column<TicketListRow>[] = [
    {
      key: 'subject',
      header: 'Ticket',
      cell: (t) => (
        <span className="block min-w-0 max-w-md">
          <span className="block truncate">
            <span className="font-mono text-xs text-muted-foreground">{t.number}</span> {t.subject}
          </span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{t.requester_name ? `${t.requester_name} · ${t.requester_email}` : t.requester_email}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
    { key: 'priority', header: 'Priority', sortable: true, cell: (t) => <PriorityBadge priority={t.priority} /> },
    { key: 'due', header: 'SLA', sortable: true, cell: (t) => <SlaBadge ticket={t} compact /> },
    { key: 'assignee', header: 'Assignee', cell: (t) => t.assignee_name ?? <span className="text-muted-foreground">Unassigned</span> },
    { key: 'category', header: 'Category', priority: 'low', cell: (t) => t.category_name ?? <span className="text-muted-foreground">—</span> },
    { key: 'updated_at', header: 'Updated', sortable: true, cell: (t) => <When value={t.updated_at} /> },
  ];

  return (
    <Card padded={false}>
      <div className="flex gap-1 overflow-x-auto border-b px-3 pt-2 [scrollbar-width:none]" role="radiogroup" aria-label="Ticket views">
        {VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            role="radio"
            aria-checked={view === v.value}
            onClick={() => setState({ view: v.value })}
            className={clsx('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium', view === v.value ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {v.label}
          </button>
        ))}
      </div>
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search subject, number, email…" className="w-full sm:w-64" />
        <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={TICKET_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
        <Select aria-label="Priority" className="w-auto" value={String(state.priority)} onChange={(e) => setState({ priority: e.target.value })} placeholder="Any priority" options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
        {(categories.data?.data ?? []).length > 0 && (
          <Select aria-label="Category" className="w-auto" value={String(state.categoryId)} onChange={(e) => setState({ categoryId: e.target.value })} placeholder="Any category" options={categories.data!.data.map((c) => ({ value: c.id, label: c.name }))} />
        )}
        {view !== 'mine' && view !== 'unassigned' && (agents.data?.data ?? []).length > 0 && (
          <Select aria-label="Assignee" className="w-auto" value={String(state.assigneeId)} onChange={(e) => setState({ assigneeId: e.target.value })} placeholder="Any assignee" options={agents.data!.data.map((a) => ({ value: a.id, label: a.name }))} />
        )}
        <Input aria-label="Tag" className="w-28" value={String(state.tag)} onChange={(e) => setState({ tag: e.target.value })} placeholder="Tag" />
        <Select
          aria-label="Sort"
          className="w-auto"
          value={`${state.sort}:${state.order}`}
          onChange={(e) => {
            const [sort, order] = e.target.value.split(':');
            setState({ sort, order });
          }}
          options={[
            { value: 'created_at:desc', label: 'Newest first' },
            { value: 'created_at:asc', label: 'Oldest first' },
            { value: 'updated_at:desc', label: 'Recently updated' },
            { value: 'updated_at:asc', label: 'Least recently updated' },
            { value: 'due:asc', label: 'SLA due soonest' },
            { value: 'due:desc', label: 'SLA due latest' },
            { value: 'priority:desc', label: 'Highest priority' },
            { value: 'priority:asc', label: 'Lowest priority' },
          ]}
        />
        {filtersActive && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              reset();
            }}
          >
            Clear
          </Button>
        )}
      </Toolbar>

      {selected.size > 0 && manage && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium">{selected.size} selected</span>
          <Select
            aria-label="Assign selected tickets"
            className="w-auto"
            value=""
            onChange={(e) => e.target.value && bulk.mutate({ action: 'assign', value: e.target.value === '__none' ? null : e.target.value })}
            placeholder="Assign to…"
            options={[{ value: '__none', label: 'Unassigned' }, ...(agents.data?.data ?? []).map((a) => ({ value: a.id, label: a.name }))]}
          />
          <Select aria-label="Set status of selected tickets" className="w-auto" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'status', value: e.target.value })} placeholder="Set status…" options={TICKET_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
          <Select aria-label="Set priority of selected tickets" className="w-auto" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'priority', value: e.target.value })} placeholder="Set priority…" options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
          <Button size="sm" variant="outline" onClick={() => void runTag('tag')}>
            Tag
          </Button>
          <Button size="sm" variant="outline" onClick={() => void runTag('untag')}>
            Untag
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {tickets.error ? (
        <ErrorState error={tickets.error} onRetry={() => void tickets.refetch()} />
      ) : (
        <DataTable
          caption="Support tickets"
          columns={columns}
          rows={tickets.data?.data}
          rowKey={(t) => t.id}
          rowHref={(t) => `/customers/support/${t.id}`}
          loading={tickets.isLoading}
          fetching={tickets.isFetching && !tickets.isLoading}
          sort={String(state.sort)}
          order={state.order as 'asc' | 'desc'}
          onSort={(sort, order) => setState({ sort, order })}
          selectable={manage}
          selected={selected}
          onSelectedChange={setSelected}
          empty={
            filtersActive ? (
              <EmptyState
                title="No tickets match these filters"
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch('');
                      reset();
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<LifeBuoy />}
                title={view === 'mine' ? 'Nothing assigned to you' : view === 'watching' ? 'You are not watching any open tickets' : view === 'breached' ? 'No SLA breaches' : 'No tickets here'}
                description={view === 'watching' ? 'Watch a ticket from its page, or become a watcher of a category to follow every ticket in it.' : 'Tickets arrive from your application (SDK or API), from inbound email, or are logged here.'}
              />
            )
          }
        />
      )}
      {tickets.data && <Pagination page={tickets.data.page} pageSize={tickets.data.pageSize} total={tickets.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </Card>
  );
}

// ---- Saved replies -----------------------------------------------------------------------------

function SavedReplyDialog({ reply, categories, onClose }: { reply: SavedReply | 'new'; categories: TicketCategory[]; onClose: () => void }) {
  const isNew = reply === 'new';
  const [form, setForm] = useState({ title: isNew ? '' : reply.title, shortcut: isNew ? '' : reply.shortcut ?? '', categoryId: isNew ? '' : reply.category_id ?? '', body: isNew ? '' : reply.body });
  const [error, setError] = useState<string | null>(null);
  const body = { title: form.title, body: form.body, shortcut: form.shortcut || undefined, categoryId: form.categoryId || null };
  const save = useAction(() => (isNew ? api.post('/api/admin/support/saved-replies', body) : api.patch(`/api/admin/support/saved-replies/${reply.id}`, body)), {
    success: isNew ? 'Saved reply created' : 'Saved reply updated',
    invalidate: [['saved-replies']],
    onSuccess: onClose,
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'New saved reply' : 'Edit saved reply'}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="saved-reply" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="saved-reply"
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
        <Field label="Title" htmlFor="sr-title" required>
          <Input id="sr-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required />
        </Field>
        <Field label="Shortcut" htmlFor="sr-shortcut" hint="Optional, e.g. refund">
          <Input id="sr-shortcut" value={form.shortcut} onChange={(e) => setForm({ ...form, shortcut: e.target.value })} maxLength={40} />
        </Field>
        <Field label="Category" htmlFor="sr-category" className="sm:col-span-2">
          <Select id="sr-category" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} placeholder="Any category" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field
          label="Reply"
          htmlFor="sr-body"
          className="sm:col-span-2"
          hint={
            <>
              Variables: <code className="font-mono">{'{{ customer.name }}'}</code>, <code className="font-mono">{'{{ ticket.number }}'}</code>, <code className="font-mono">{'{{ ticket.subject }}'}</code>, <code className="font-mono">{'{{ agent.name }}'}</code>
            </>
          }
          required
        >
          <Textarea id="sr-body" rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
        </Field>
      </form>
    </Modal>
  );
}

function SavedRepliesTab() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('support.tickets.manage');
  const [editing, setEditing] = useState<SavedReply | 'new' | null>(null);
  const replies = useQuery({ queryKey: ['saved-replies'], queryFn: () => api.get<{ data: SavedReply[] }>('/api/admin/support/saved-replies') });
  const categories = useCategories();
  const remove = useAction((id: string) => api.delete(`/api/admin/support/saved-replies/${id}`), { success: 'Saved reply deleted', invalidate: [['saved-replies']] });
  const catName = new Map((categories.data?.data ?? []).map((c) => [c.id, c.name]));
  return (
    <Card
      title="Saved replies"
      description="Reusable answers agents insert into replies. Variables are filled in for each ticket."
      padded={false}
      actions={
        manage && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New saved reply
          </Button>
        )
      }
    >
      {replies.error ? (
        <ErrorState error={replies.error} onRetry={() => void replies.refetch()} />
      ) : (
        <DataTable
          caption="Saved replies"
          rows={replies.data?.data}
          loading={replies.isLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No saved replies" description="Create answers for common questions to reply faster and more consistently." />}
          columns={[
            {
              key: 'title',
              header: 'Title',
              cell: (r) => (
                <span className="block min-w-0 max-w-lg">
                  <span className="block truncate font-medium">{r.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{r.body.replace(/\s+/g, ' ')}</span>
                </span>
              ),
            },
            { key: 'shortcut', header: 'Shortcut', cell: (r) => (r.shortcut ? <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{r.shortcut}</code> : <span className="text-muted-foreground">—</span>) },
            { key: 'category', header: 'Category', priority: 'low', cell: (r) => (r.category_id ? catName.get(r.category_id) ?? '—' : 'Any') },
            { key: 'updated', header: 'Updated', cell: (r) => <When value={r.updated_at} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (r) =>
                manage ? (
                  <span className="inline-flex gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.title}`} onClick={() => setEditing(r)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${r.title}`}
                      onClick={async () => {
                        if ((await confirm({ title: `Delete “${r.title}”?`, tone: 'danger', confirmLabel: 'Delete' })).confirmed) remove.mutate(r.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      )}
      {editing && <SavedReplyDialog reply={editing} categories={categories.data?.data ?? []} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ---- Categories & SLAs ------------------------------------------------------------------------------

function CategoryDialog({ category, onClose }: { category: CategoryWithRules | 'new'; onClose: () => void }) {
  const isNew = category === 'new';
  const agents = useAgents();
  const [form, setForm] = useState({
    name: isNew ? '' : category.name,
    description: isNew ? '' : category.description,
    defaultPriority: isNew ? 'normal' : category.default_priority,
    firstResponseMinutes: isNew || category.first_response_minutes === null ? '' : String(category.first_response_minutes),
    resolutionMinutes: isNew || category.resolution_minutes === null ? '' : String(category.resolution_minutes),
    active: isNew ? true : category.active,
    position: isNew ? '0' : String(category.position),
    defaultAssigneeId: isNew ? '' : category.default_assignee_id ?? '',
  });
  const [fields, setFields] = useState<TicketField[]>(isNew ? [] : category.fields ?? []);
  const [watcherIds, setWatcherIds] = useState<string[]>(isNew ? [] : category.watcher_ids ?? []);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const body = {
    name: form.name,
    description: form.description,
    defaultPriority: form.defaultPriority,
    firstResponseMinutes: form.firstResponseMinutes ? Number(form.firstResponseMinutes) : null,
    resolutionMinutes: form.resolutionMinutes ? Number(form.resolutionMinutes) : null,
    active: form.active,
    position: Number(form.position) || 0,
    fields,
    defaultAssigneeId: form.defaultAssigneeId || null,
    watcherIds,
  };
  const save = useAction(() => (isNew ? api.post('/api/admin/support/categories', body) : api.patch(`/api/admin/support/categories/${category.id}`, body)), {
    success: isNew ? 'Category created' : 'Category updated',
    invalidate: [['support-categories']],
    onSuccess: onClose,
    onError: (e) => {
      setError(errorMessage(e));
      setErrors(e instanceof ApiError ? e.fieldErrors() : {});
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'New category' : `Edit ${category.name}`}
      description="Categories route tickets, ask category-specific questions and can override the SLA targets set per priority in Settings → Support."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="ticket-category" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="ticket-category"
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
        <Field label="Name" htmlFor="tc-name" required>
          <Input id="tc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required />
        </Field>
        <Field label="Default priority" htmlFor="tc-priority">
          <Select id="tc-priority" value={form.defaultPriority} onChange={(e) => setForm({ ...form, defaultPriority: e.target.value })} options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
        </Field>
        <Field label="Description" htmlFor="tc-desc" className="sm:col-span-2">
          <Textarea id="tc-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} />
        </Field>
        <Field label="First response target (minutes)" htmlFor="tc-frt" hint="Empty uses the priority default">
          <Input id="tc-frt" type="number" min={1} step={1} value={form.firstResponseMinutes} onChange={(e) => setForm({ ...form, firstResponseMinutes: e.target.value })} />
        </Field>
        <Field label="Resolution target (minutes)" htmlFor="tc-rt" hint="Empty uses the priority default">
          <Input id="tc-rt" type="number" min={1} step={1} value={form.resolutionMinutes} onChange={(e) => setForm({ ...form, resolutionMinutes: e.target.value })} />
        </Field>
        <Field label="Position" htmlFor="tc-position">
          <Input id="tc-position" type="number" step={1} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} label="Active" description="Inactive categories cannot be chosen for new tickets." />
        </div>
        <fieldset className="space-y-3 border-t pt-3 sm:col-span-2">
          <legend className="text-sm font-semibold">Assignment</legend>
          <Field label="Default agent" htmlFor="tc-assignee" hint="New tickets in this category go to this agent unless someone is chosen when the ticket is opened" error={errors.defaultAssigneeId}>
            <Select id="tc-assignee" value={form.defaultAssigneeId} onChange={(e) => setForm({ ...form, defaultAssigneeId: e.target.value })} placeholder="None (round-robin, if on)" options={(agents.data?.data ?? []).map((a) => ({ value: a.id, label: a.name }))} />
          </Field>
          <Field label="Watchers" hint="Notified about every new ticket and customer reply in this category" error={errors.watcherIds}>
            <AgentChecklist value={watcherIds} onChange={setWatcherIds} label="Category watchers" />
          </Field>
        </fieldset>
        <fieldset className="space-y-3 border-t pt-3 sm:col-span-2">
          <legend className="text-sm font-semibold">Custom fields</legend>
          <TicketFieldsEditor value={fields} onChange={setFields} errors={errors} />
        </fieldset>
      </form>
    </Modal>
  );
}

function CategoriesTab() {
  const { can } = useAuth();
  const manage = can('support.settings.manage');
  const [editing, setEditing] = useState<CategoryWithRules | 'new' | null>(null);
  const categories = useCategories();
  const agents = useAgents();
  const agentName = new Map((agents.data?.data ?? []).map((a) => [a.id, a.name]));
  const rows = categories.data?.data as CategoryWithRules[] | undefined;
  return (
    <Card
      title="Categories & SLA targets"
      description="Default SLA targets per priority are configured in Settings → Support; a category can override them."
      padded={false}
      actions={
        manage && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New category
          </Button>
        )
      }
    >
      {categories.error ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        <DataTable
          caption="Ticket categories"
          rows={rows}
          loading={categories.isLoading}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No categories" description="Categories help route tickets, report volume by topic and apply specific SLAs." />}
          columns={[
            {
              key: 'name',
              header: 'Category',
              cell: (c) => (
                <span className="block min-w-0 max-w-md">
                  <span className="block truncate font-medium">{c.name}</span>
                  {c.description && <span className="block truncate text-xs text-muted-foreground">{c.description}</span>}
                </span>
              ),
            },
            { key: 'priority', header: 'Default priority', cell: (c) => <PriorityBadge priority={c.default_priority} /> },
            { key: 'frt', header: 'First response', cell: (c) => (c.first_response_minutes ? minutes(c.first_response_minutes) : <span className="text-muted-foreground">priority default</span>) },
            { key: 'rt', header: 'Resolution', cell: (c) => (c.resolution_minutes ? minutes(c.resolution_minutes) : <span className="text-muted-foreground">priority default</span>) },
            { key: 'agent', header: 'Default agent', priority: 'low', cell: (c) => (c.default_assignee_id ? agentName.get(c.default_assignee_id) ?? 'Unavailable agent' : <span className="text-muted-foreground">—</span>) },
            { key: 'fields', header: 'Fields', priority: 'low', cell: (c) => (c.fields?.length ? `${c.fields.length} ${c.fields.length === 1 ? 'field' : 'fields'}` : <span className="text-muted-foreground">—</span>) },
            { key: 'active', header: 'Status', cell: (c) => <StatusBadge status={c.active ? 'active' : 'inactive'} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (c) =>
                manage ? (
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                    <Pencil className="size-4" />
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {editing && <CategoryDialog category={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ---- Insights -------------------------------------------------------------------------------------

interface SupportReport {
  from: string;
  to: string;
  volume: { created: number; solved: number };
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
  slaBreachRate: number;
  csat: { responses: number; average: number | null; satisfiedRate: number | null; distribution: { rating: number; count: number }[] };
  byCategory: { category: string; tickets: number }[];
  byAgent: { id: string; name: string; assigned: number; solved: number; avg_first_response_minutes: number | null; csat: number | null }[];
  daily: { day: string; created: number; solved: number }[];
  backlog: { priority: string; open: number }[];
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-ui border bg-surface p-4 shadow-ui">
      <p className="truncate text-sm text-muted-foreground">{label}</p>
      <p className="mt-1.5 whitespace-nowrap text-2xl font-semibold tracking-tight tabular">{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function InsightsTab() {
  const [days, setDays] = useState(30);
  const report = useQuery({
    queryKey: ['support-report', days],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      return api.get<SupportReport>('/api/admin/support/reports', { from: from.toISOString(), to: to.toISOString() });
    },
    placeholderData: keepPreviousData,
  });
  if (report.isLoading) return <PageSkeleton />;
  if (report.error || !report.data) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  const r = report.data;
  const fetching = report.isFetching && !report.isLoading;
  const created = r.daily.map((d) => ({ date: String(d.day).slice(0, 10), value: d.created }));
  const solved = r.daily.map((d) => ({ date: String(d.day).slice(0, 10), value: d.solved }));
  const backlog = PRIORITIES.map((p) => ({ priority: p, open: r.backlog.find((b) => b.priority === p)?.open ?? 0 })).reverse();
  return (
    <div className={clsx('space-y-4 transition-opacity', fetching && 'opacity-60')}>
      <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-ui-sm border bg-surface p-0.5 shadow-ui">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={days === d}
            onClick={() => setDays(d)}
            className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-1 text-sm font-medium tabular', days === d ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {d}D
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Metric label="Tickets created" value={num(r.volume.created)} />
        <Metric label="Tickets solved" value={num(r.volume.solved)} />
        <Metric label="Avg. first response" value={minutes(r.avgFirstResponseMinutes)} />
        <Metric label="Avg. resolution" value={minutes(r.avgResolutionMinutes)} />
        <Metric label="SLA breach rate" value={pct(r.slaBreachRate)} hint="of tickets created" />
        <Metric label="CSAT" value={r.csat.average === null ? '—' : `${r.csat.average.toFixed(1)} / 5`} hint={r.csat.responses ? `${pct(r.csat.satisfiedRate)} satisfied · ${num(r.csat.responses)} ratings` : 'No ratings yet'} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Tickets created" description="Per day" data={created} format={(v) => num(v)} fetching={fetching}>
          <ColumnChart data={created} format={(v) => num(v)} label="Tickets created per day" />
        </ChartCard>
        <ChartCard title="Tickets solved" description="Per day" data={solved} format={(v) => num(v)} fetching={fetching}>
          <ColumnChart data={solved} format={(v) => num(v)} label="Tickets solved per day" />
        </ChartCard>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Open backlog" description="By priority" padded={false}>
          <ul className="divide-y">
            {backlog.map((b) => (
              <li key={b.priority} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <PriorityBadge priority={b.priority} />
                <span className="font-semibold tabular">{num(b.open)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="By category" padded={false}>
          {r.byCategory.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No tickets in this period.</p>
          ) : (
            <ul className="divide-y">
              {r.byCategory.map((c) => (
                <li key={c.category} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="truncate">{c.category}</span>
                  <span className="font-semibold tabular">{num(c.tickets)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="CSAT ratings" padded={false}>
          {r.csat.responses === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No ratings in this period.</p>
          ) : (
            <ul className="divide-y">
              {[5, 4, 3, 2, 1].map((rating) => {
                const count = r.csat.distribution.find((d) => d.rating === rating)?.count ?? 0;
                return (
                  <li key={rating} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="w-10 tabular">{rating} / 5</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <span className="block h-full rounded-full bg-[var(--series-1)]" style={{ width: `${(count / r.csat.responses) * 100}%` }} />
                    </span>
                    <span className="w-10 text-right font-semibold tabular">{num(count)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Agents" padded={false}>
        <DataTable
          caption="Agent performance"
          rows={r.byAgent}
          rowKey={(a) => a.id}
          empty={<EmptyState title="No assigned tickets in this period" />}
          columns={[
            { key: 'name', header: 'Agent', cell: (a) => a.name },
            { key: 'assigned', header: 'Assigned', align: 'right', cell: (a) => <span className="tabular">{num(a.assigned)}</span> },
            { key: 'solved', header: 'Solved', align: 'right', cell: (a) => <span className="tabular">{num(a.solved)}</span> },
            { key: 'frt', header: 'Avg. first response', align: 'right', cell: (a) => minutes(a.avg_first_response_minutes) },
            { key: 'csat', header: 'CSAT', align: 'right', cell: (a) => (a.csat === null ? '—' : `${a.csat.toFixed(1)} / 5`) },
          ]}
        />
      </Card>
    </div>
  );
}

// ---- Inbound email -----------------------------------------------------------------------------------

function InboundTab() {
  const confirm = useConfirm();
  const [info, setInfo] = useState<{ url: string; payload?: string } | null>(null);
  const reveal = useAction(() => api.get<{ url: string; payload: string }>('/api/admin/support/inbound'), { onSuccess: setInfo });
  const rotate = useAction(() => api.post<{ url: string }>('/api/admin/support/inbound/rotate'), {
    success: 'Inbound address rotated. Update your email provider.',
    onSuccess: (r) => setInfo((cur) => ({ ...cur, url: r.url })),
  });
  return (
    <Card title="Email to ticket" description="Point your email provider's inbound webhook (Postmark, SendGrid Inbound Parse, Mailgun routes…) at this secret URL. Replies are threaded onto existing tickets.">
      {info ? (
        <div className="space-y-4">
          <Field label="Inbound webhook URL" hint="Treat it like a password: anyone with the URL can create tickets.">
            <CodeBlock code={info.url} />
          </Field>
          {info.payload && (
            <Field label="Expected JSON payload">
              <CodeBlock code={info.payload} />
            </Field>
          )}
          <Button
            variant="outline"
            icon={<RefreshCw className="size-4" />}
            loading={rotate.isPending}
            onClick={async () => {
              const r = await confirm({ title: 'Rotate the inbound address?', description: 'The current URL stops working immediately. Update your email provider right after.', tone: 'danger', confirmLabel: 'Rotate' });
              if (r.confirmed) rotate.mutate();
            }}
          >
            Rotate address
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Callout>The address is secret, so revealing it asks you to confirm your identity.</Callout>
          <Button onClick={() => reveal.mutate()} loading={reveal.isPending}>
            Reveal inbound address
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---- Page -----------------------------------------------------------------------------------------------

export default function SupportPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('tickets');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Support"
        description="Customer tickets with SLAs, custom fields, automatic assignment, internal notes, saved replies and satisfaction ratings."
        actions={
          can('support.tickets.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New ticket
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'tickets', label: 'Tickets', content: <TicketsTab /> },
          { value: 'replies', label: 'Saved replies', content: tab === 'replies' && <SavedRepliesTab /> },
          { value: 'categories', label: 'Categories & SLAs', content: tab === 'categories' && <CategoriesTab /> },
          { value: 'assignment', label: 'Assignment', content: tab === 'assignment' && <AssignmentTab /> },
          { value: 'insights', label: 'Insights', hidden: !can('support.reports.view'), content: tab === 'insights' && <InsightsTab /> },
          { value: 'inbound', label: 'Inbound email', hidden: !can('support.settings.manage'), content: tab === 'inbound' && <InboundTab /> },
        ]}
      />
      {creating && <NewTicketDialog open={creating} onOpenChange={setCreating} />}
    </>
  );
}
