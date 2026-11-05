import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Lock, MoreHorizontal, Paperclip, Pencil, Star } from 'lucide-react';
import clsx from 'clsx';
import { api, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { bytes, dateTime } from '../../lib/format';
import { useBootstrap } from '../../components/layout/AppShell';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  Menu,
  Modal,
  Money,
  PageHeader,
  PageSkeleton,
  Select,
  StatusBadge,
  Textarea,
  When,
  useToast,
} from '../../components/ui';
import { FilePicker, PRIORITIES, PriorityBadge, SlaBadge, STATUS_LABEL, TICKET_STATUSES, toAttachments, useAgents, useCategories } from './shared';
import { SuggestedArticles, TicketFieldsCard, WatchersField, type TicketField } from '../helpdesk/shared';

interface Message {
  id: string;
  author_type: 'customer' | 'admin' | 'system';
  author_id: string | null;
  author_name: string | null;
  body: string;
  is_internal: boolean;
  channel: string;
  created_at: string;
}

interface Attachment {
  id: string;
  message_id: string | null;
  is_internal: boolean;
  uploaded_by_type: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

interface TicketDetail {
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
  solved_at: string | null;
  closed_at: string | null;
  sla_breached_at: string | null;
  escalated_at: string | null;
  csat_rating: number | null;
  csat_comment: string | null;
  csat_at: string | null;
  custom_fields: Record<string, unknown>;
  category_fields: TicketField[];
  watcher_ids: string[];
  watchers: { id: string; name: string; email: string }[];
  created_at: string;
  updated_at: string;
  messages: Message[];
  attachments: Attachment[];
  requester: { id: string; email: string; name: string | null; status: string; created_at: string; lifetime_revenue: number } | null;
  otherTickets: { id: string; number: string; subject: string; status: string; created_at: string }[];
}

interface SavedReply {
  id: string;
  title: string;
  shortcut: string | null;
  category_id: string | null;
}

// ---- Conversation --------------------------------------------------------------------------------

function AttachmentList({ items }: { items: Attachment[] }) {
  const toast = useToast();
  if (!items.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {items.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => download(`/api/admin/support/attachments/${a.id}`, undefined, a.filename).catch((err) => toast.error('Download failed', errorMessage(err)))}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 text-xs hover:bg-muted"
            title={`${a.filename} · ${a.content_type}`}
          >
            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{a.filename}</span>
            <span className="shrink-0 text-muted-foreground">{bytes(a.size)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Conversation({ ticket }: { ticket: TicketDetail }) {
  const byMessage = new Map<string, Attachment[]>();
  const loose: Attachment[] = [];
  for (const a of ticket.attachments) {
    if (a.message_id) byMessage.set(a.message_id, [...(byMessage.get(a.message_id) ?? []), a]);
    else loose.push(a);
  }
  if (!ticket.messages.length) return <EmptyState title="No messages yet" />;
  return (
    <ol className="space-y-3" aria-label="Conversation">
      {ticket.messages.map((m) => {
        if (m.author_type === 'system') {
          return (
            <li key={m.id} className="px-2 text-center text-xs text-muted-foreground">
              <span className="whitespace-pre-wrap break-words">{m.body}</span> · <When value={m.created_at} />
            </li>
          );
        }
        const customer = m.author_type === 'customer';
        const name = customer ? ticket.requester_name || ticket.requester_email : m.author_name || 'Agent';
        return (
          <li key={m.id} className={clsx('flex gap-3', !customer && 'flex-row-reverse')}>
            <Avatar name={name} email={customer ? ticket.requester_email : undefined} size="sm" />
            <div
              className={clsx(
                'min-w-0 max-w-[min(42rem,100%)] flex-1 rounded-ui border px-3.5 py-2.5',
                customer && 'bg-muted/50',
                !customer && !m.is_internal && 'border-primary/25 bg-primary/5',
                m.is_internal && 'border-dashed border-warning/50 bg-warning/5',
              )}
            >
              <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-medium">{name}</span>
                {m.is_internal && (
                  <Badge tone="warning">
                    <Lock className="size-3" aria-hidden="true" />
                    Internal note
                  </Badge>
                )}
                {m.channel === 'email' && <Badge>via email</Badge>}
                <span className="text-muted-foreground" title={dateTime(m.created_at)}>
                  <When value={m.created_at} />
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.body}</p>
              <AttachmentList items={byMessage.get(m.id) ?? []} />
            </div>
          </li>
        );
      })}
      {loose.length > 0 && (
        <li className="rounded-ui border px-3.5 py-2.5">
          <p className="text-xs font-medium">Other attachments</p>
          <AttachmentList items={loose} />
        </li>
      )}
    </ol>
  );
}

function Composer({ ticket }: { ticket: TicketDetail }) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [statusAfter, setStatusAfter] = useState('pending');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const replies = useQuery({ queryKey: ['saved-replies'], queryFn: () => api.get<{ data: SavedReply[] }>('/api/admin/support/saved-replies'), staleTime: 60_000 });
  const send = useAction(
    async () => {
      const attachments = files.length ? await toAttachments(files) : undefined;
      return mode === 'reply'
        ? api.post(`/api/admin/support/tickets/${ticket.id}/reply`, { body, status: statusAfter, attachments })
        : api.post(`/api/admin/support/tickets/${ticket.id}/notes`, { body, attachments });
    },
    {
      success: mode === 'reply' ? 'Reply sent to the customer' : 'Internal note added',
      invalidate: [['ticket', ticket.id], ['tickets']],
      onSuccess: () => {
        setBody('');
        setFiles([]);
        setError(null);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );

  const insertSaved = async (id: string) => {
    try {
      const r = await api.get<{ body: string }>(`/api/admin/support/saved-replies/${id}/render`, { ticketId: ticket.id });
      setBody((b) => (b.trim() ? `${b.trimEnd()}\n\n${r.body}` : r.body));
    } catch (err) {
      toast.error('Could not insert the saved reply', errorMessage(err));
    }
  };

  const submit = () => {
    if (!body.trim()) return setError(mode === 'reply' ? 'Write a reply first' : 'Write a note first');
    setError(null);
    send.mutate();
  };

  const relevant = (replies.data?.data ?? []).filter((r) => !r.category_id || r.category_id === ticket.category_id);

  return (
    <Card padded={false} className={clsx(mode === 'note' && 'border-warning/50')}>
      <div className="flex items-center gap-1 border-b px-3 pt-2" role="radiogroup" aria-label="Message type">
        {(
          [
            ['reply', 'Reply to customer'],
            ['note', 'Internal note'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => setMode(value)}
            className={clsx('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium', mode === value ? (value === 'note' ? 'border-warning text-foreground' : 'border-primary text-foreground') : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {value === 'note' && <Lock className="size-3.5" aria-hidden="true" />}
            {label}
          </button>
        ))}
      </div>
      <form
        className="space-y-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormError message={error} />
        {mode === 'reply' && relevant.length > 0 && (
          <Select
            aria-label="Insert a saved reply"
            className="w-full sm:w-72"
            value=""
            onChange={(e) => e.target.value && void insertSaved(e.target.value)}
            placeholder="Insert a saved reply…"
            options={relevant.map((r) => ({ value: r.id, label: r.shortcut ? `${r.title} (${r.shortcut})` : r.title }))}
          />
        )}
        <Textarea
          aria-label={mode === 'reply' ? 'Reply' : 'Internal note'}
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={mode === 'reply' ? 'Write to the customer. They receive it by email.' : 'Only your team can see internal notes.'}
          className={mode === 'note' ? 'bg-warning/5' : undefined}
        />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <FilePicker id="composer-files" files={files} onChange={setFiles} />
          <div className="flex flex-wrap items-center gap-2">
            {mode === 'reply' && (
              <Select
                aria-label="Status after replying"
                className="w-auto"
                value={statusAfter}
                onChange={(e) => setStatusAfter(e.target.value)}
                options={[
                  { value: 'pending', label: 'Then set: pending (awaiting customer)' },
                  { value: 'open', label: 'Then set: open' },
                  { value: 'on_hold', label: 'Then set: on hold' },
                  { value: 'solved', label: 'Then set: solved' },
                ]}
              />
            )}
            <Button type="submit" loading={send.isPending} variant={mode === 'note' ? 'secondary' : 'primary'}>
              {mode === 'reply' ? 'Send reply' : 'Add note'}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Ctrl/⌘ + Enter to send.</p>
      </form>
    </Card>
  );
}

// ---- Sidebar ---------------------------------------------------------------------------------------

function Properties({ ticket }: { ticket: TicketDetail }) {
  const { me, can } = useAuth();
  const manage = can('support.tickets.manage');
  const agents = useAgents();
  const categories = useCategories();
  // Re-sync the field only when the saved tags change (not on every background refetch).
  const savedTags = ticket.tags.join(', ');
  const [tags, setTags] = useState(savedTags);
  const [prevSaved, setPrevSaved] = useState(savedTags);
  if (prevSaved !== savedTags) {
    setPrevSaved(savedTags);
    setTags(savedTags);
  }
  const patch = useAction((body: Record<string, unknown>) => api.patch(`/api/admin/support/tickets/${ticket.id}`, body), {
    success: 'Ticket updated',
    invalidate: [['ticket', ticket.id], ['tickets']],
  });
  const closed = ticket.status === 'closed';
  const statusOptions = TICKET_STATUSES.filter((s) => s !== 'closed' || ticket.status === 'solved' || closed).map((s) => ({ value: s, label: STATUS_LABEL[s] }));
  const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
  const tagsChanged = tagList.join('|') !== ticket.tags.join('|');

  return (
    <Card title="Properties">
      <div className="space-y-3">
        <Field label="Status" htmlFor="tp-status" hint={ticket.status === 'solved' ? 'Solved tickets close automatically after the configured number of days.' : closed ? 'Closed tickets cannot be reopened.' : undefined}>
          <Select id="tp-status" value={ticket.status} disabled={!manage || closed || patch.isPending} onChange={(e) => patch.mutate({ status: e.target.value })} options={statusOptions} />
        </Field>
        <Field label="Priority" htmlFor="tp-priority">
          <Select id="tp-priority" value={ticket.priority} disabled={!manage || closed || patch.isPending} onChange={(e) => patch.mutate({ priority: e.target.value })} options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
        </Field>
        <Field label="Assignee" htmlFor="tp-assignee">
          <Select
            id="tp-assignee"
            value={ticket.assignee_id ?? ''}
            disabled={!manage || closed || patch.isPending}
            onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })}
            placeholder="Unassigned"
            options={(agents.data?.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
          />
          {manage && !closed && me && ticket.assignee_id !== me.admin.id && (agents.data?.data ?? []).some((a) => a.id === me.admin.id) && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => patch.mutate({ assigneeId: me.admin.id })}>
              Assign to me
            </button>
          )}
        </Field>
        <Field label="Category" htmlFor="tp-category">
          <Select
            id="tp-category"
            value={ticket.category_id ?? ''}
            disabled={!manage || closed || patch.isPending}
            onChange={(e) => patch.mutate({ categoryId: e.target.value || null })}
            placeholder="None"
            options={(categories.data?.data ?? []).filter((c) => c.active || c.id === ticket.category_id).map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="Tags" htmlFor="tp-tags" hint="Comma separated">
          <div className="flex gap-2">
            <Input id="tp-tags" value={tags} disabled={!manage || closed} onChange={(e) => setTags(e.target.value)} className="min-w-0 flex-1" />
            {tagsChanged && (
              <Button variant="outline" onClick={() => patch.mutate({ tags: tagList })} loading={patch.isPending}>
                Save
              </Button>
            )}
          </div>
        </Field>
        <WatchersField ticket={ticket} />
      </div>
    </Card>
  );
}

function SlaCard({ ticket }: { ticket: TicketDetail }) {
  const met = (due: string | null, at: string | null) => (due && at ? new Date(at) <= new Date(due) : null);
  const firstMet = met(ticket.first_response_due_at, ticket.first_responded_at);
  const resolvedAt = ticket.solved_at ?? ticket.closed_at;
  const resolutionMet = met(ticket.resolution_due_at, resolvedAt);
  return (
    <Card title="Service level">
      <KeyValue
        columns={1}
        items={[
          {
            label: 'First response',
            value: ticket.first_responded_at ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {dateTime(ticket.first_responded_at)}
                {firstMet !== null && <Badge tone={firstMet ? 'success' : 'danger'}>{firstMet ? 'within target' : 'late'}</Badge>}
              </span>
            ) : ticket.first_response_due_at ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                due {dateTime(ticket.first_response_due_at)}
                <SlaBadge ticket={ticket} compact />
              </span>
            ) : (
              'No target'
            ),
          },
          {
            label: 'Resolution',
            value: resolvedAt ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {dateTime(resolvedAt)}
                {resolutionMet !== null && <Badge tone={resolutionMet ? 'success' : 'danger'}>{resolutionMet ? 'within target' : 'late'}</Badge>}
              </span>
            ) : ticket.resolution_due_at ? (
              `due ${dateTime(ticket.resolution_due_at)}`
            ) : (
              'No target'
            ),
          },
          { label: 'SLA breached', value: ticket.sla_breached_at ? <span className="text-danger">{dateTime(ticket.sla_breached_at)}</span> : 'No', hidden: !ticket.sla_breached_at },
          { label: 'Escalated', value: dateTime(ticket.escalated_at), hidden: !ticket.escalated_at },
        ]}
      />
    </Card>
  );
}

function RequesterCard({ ticket }: { ticket: TicketDetail }) {
  const boot = useBootstrap();
  const { can } = useAuth();
  const r = ticket.requester;
  return (
    <Card title="Requester">
      <div className="flex items-center gap-3">
        <Avatar name={r?.name ?? ticket.requester_name} email={ticket.requester_email} />
        <div className="min-w-0">
          {r && can('customers.users.view') ? (
            <Link to={`/customers/users/${r.id}`} className="block truncate text-sm font-medium text-primary hover:underline">
              {r.name || r.email}
            </Link>
          ) : (
            <p className="truncate text-sm font-medium">{ticket.requester_name || ticket.requester_email}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">{ticket.requester_email}</p>
        </div>
      </div>
      {r ? (
        <div className="mt-3">
          <KeyValue
            columns={1}
            items={[
              { label: 'Account', value: <StatusBadge status={r.status} /> },
              { label: 'Customer since', value: dateTime(r.created_at) },
              { label: 'Lifetime revenue', value: <Money amount={r.lifetime_revenue} currency={boot.data?.locale.currency ?? 'USD'} /> },
              {
                label: 'Organization',
                hidden: !ticket.org_id,
                value: (
                  <Link to={`/customers/organizations/${ticket.org_id}`} className="text-primary hover:underline">
                    View organization
                  </Link>
                ),
              },
            ]}
          />
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No user account matches this email.</p>
      )}
    </Card>
  );
}

function SubjectDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const [subject, setSubject] = useState(ticket.subject);
  const save = useAction(() => api.patch(`/api/admin/support/tickets/${ticket.id}`, { subject }), { success: 'Subject updated', invalidate: [['ticket', ticket.id], ['tickets']], onSuccess: onClose });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit subject"
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="ticket-subject" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="ticket-subject"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Subject" htmlFor="ts-subject">
          <Input id="ts-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} required autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

// ---- Page ----------------------------------------------------------------------------------------------

export default function TicketPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [editingSubject, setEditingSubject] = useState(false);
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api.get<TicketDetail>(`/api/admin/support/tickets/${id}`), refetchInterval: 30_000 });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const t = q.data;
  const manage = can('support.tickets.manage');
  const closed = t.status === 'closed';

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Support', to: '/customers/support' }, { label: t.number }]}
        documentTitle={`${t.number} · ${t.subject}`}
        title={t.subject}
        meta={
          <>
            <span className="font-mono text-xs text-muted-foreground">{t.number}</span>
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            <SlaBadge ticket={t} hideEmpty />
            <Badge>via {t.channel}</Badge>
            {t.tags.map((tag) => (
              <Badge key={tag} tone="primary">
                {tag}
              </Badge>
            ))}
          </>
        }
        actions={
          manage &&
          !closed && (
            <Menu
              trigger={
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              }
              items={[{ label: 'Edit subject', icon: <Pencil className="size-4" />, onSelect: () => setEditingSubject(true) }]}
            />
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {t.csat_rating !== null && (
            <Callout tone={t.csat_rating >= 4 ? 'success' : t.csat_rating <= 2 ? 'danger' : 'info'} title={`Rated ${t.csat_rating} / 5 by the customer`}>
              <span className="inline-flex items-center gap-0.5" aria-hidden="true">
                {Array.from({ length: 5 }, (_, i) => (
                  <Star key={i} className={clsx('size-3.5', i < t.csat_rating! ? 'fill-current' : 'opacity-30')} />
                ))}
              </span>
              {t.csat_comment && <span className="mt-1 block whitespace-pre-wrap break-words">“{t.csat_comment}”</span>}
            </Callout>
          )}
          <Conversation ticket={t} />
          {manage && !closed && <Composer ticket={t} />}
          {closed && <Callout title="This ticket is closed">Closed tickets cannot receive replies. If the customer writes again, a new ticket is opened.</Callout>}
        </div>
        <aside className="space-y-4" aria-label="Ticket details">
          <Properties ticket={t} />
          <TicketFieldsCard ticket={t} />
          <SlaCard ticket={t} />
          <RequesterCard ticket={t} />
          {can('support.kb.view') && !closed && <SuggestedArticles subject={t.subject} />}
          {t.otherTickets.length > 0 && (
            <Card title="Other tickets from this requester" padded={false}>
              <ul className="divide-y">
                {t.otherTickets.map((o) => (
                  <li key={o.id}>
                    <Link to={`/customers/support/${o.id}`} className="flex items-center gap-2 px-4 py-2.5 hover:bg-muted/40">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{o.subject}</span>
                        <span className="text-xs text-muted-foreground">
                          {o.number} · <When value={o.created_at} />
                        </span>
                      </span>
                      <StatusBadge status={o.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="px-1 text-xs text-muted-foreground">
            Opened {dateTime(t.created_at)} · updated <When value={t.updated_at} />
          </p>
        </aside>
      </div>
      {editingSubject && <SubjectDialog ticket={t} onClose={() => setEditingSubject(false)} />}
    </>
  );
}
