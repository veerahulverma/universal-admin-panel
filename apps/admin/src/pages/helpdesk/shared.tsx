import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { pct } from '../../lib/format';
import { Badge, Button, Callout, Card, Checkbox, CopyButton, ErrorState, Field, FormError, Input, Select, Skeleton, Switch, When, type Tone } from '../../components/ui';
import { useAgents, type TicketCategory } from '../customers/shared';

// ---- Knowledge base ---------------------------------------------------------------------------

export type KbVisibility = 'public' | 'customers' | 'products';

export const VISIBILITY_LABEL: Record<KbVisibility, string> = {
  public: 'Everyone',
  customers: 'Signed-in customers',
  products: 'Customers with chosen products',
};

export const VISIBILITY_TONE: Record<KbVisibility, Tone> = { public: 'success', customers: 'info', products: 'primary' };

export interface KbCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  position: number;
  articles: number;
  published: number;
  created_at: string;
  updated_at: string;
}

export interface KbArticleRow {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  status: 'draft' | 'published';
  visibility: KbVisibility;
  category_id: string | null;
  category_name: string | null;
  tags: string[];
  position: number;
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
  published_at: string | null;
  updated_at: string;
}

export interface KbArticle extends Omit<KbArticleRow, 'category_name'> {
  body: string;
  product_ids: string[];
  products: { id: string; key: string; name: string }[];
  excerpt_generated: boolean;
  category_name: string | null;
  url: string | null;
  created_at: string;
}

export function useKbCategories(enabled = true) {
  return useQuery({ queryKey: ['kb-categories'], queryFn: () => api.get<{ data: KbCategory[] }>('/api/admin/support/kb/categories'), enabled, staleTime: 60_000 });
}

/** "83% helpful (12 votes)" from the yes/no counters. */
export function helpfulness(a: { helpful_count: number; not_helpful_count: number }): string {
  const votes = a.helpful_count + a.not_helpful_count;
  return votes ? `${pct(a.helpful_count / votes, 0)} of ${votes}` : 'No votes';
}

/** Customer-facing article shape (suggestions). */
export interface SuggestedArticle {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  url: string | null;
  helpful: { yes: number; no: number };
}

/** Published articles that may answer this ticket, so agents can point the customer at them. */
export function SuggestedArticles({ subject }: { subject: string }) {
  const suggestions = useQuery({
    queryKey: ['kb-suggestions', subject],
    queryFn: () => api.get<{ data: SuggestedArticle[] }>('/api/admin/support/kb/suggestions', { subject, limit: 3 }),
    staleTime: 5 * 60_000,
  });
  if (suggestions.isLoading || suggestions.error || !suggestions.data?.data.length) return null;
  return (
    <Card title="Knowledge base" description="Articles that match this ticket" padded={false}>
      <ul className="divide-y">
        {suggestions.data.data.map((a) => (
          <li key={a.id} className="flex items-start gap-2 px-4 py-2.5">
            <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <Link to={`/customers/kb/${a.id}`} className="block truncate text-sm text-primary hover:underline">
                {a.title}
              </Link>
              <span className="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</span>
            </span>
            {a.url && <CopyButton value={a.url} label="Copy the link to send to the customer" />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---- Custom ticket fields ---------------------------------------------------------------------------

export type TicketFieldType = 'text' | 'number' | 'url' | 'select';

export interface TicketField {
  key: string;
  label: string;
  type: TicketFieldType;
  options: string[];
  required: boolean;
  help: string;
}

/** Ticket categories as the server returns them now: with fields, default agent and watchers. */
export interface CategoryWithRules extends TicketCategory {
  fields: TicketField[];
  default_assignee_id: string | null;
  watcher_ids: string[];
}

const FIELD_TYPES: { value: TicketFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'url', label: 'Link (URL)' },
  { value: 'select', label: 'List of options' },
];

const keyFromLabel = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);

/** Editor for a category's extra questions (shown to customers on the contact form). */
export function TicketFieldsEditor({ value, onChange, disabled, errors }: { value: TicketField[]; onChange: (fields: TicketField[]) => void; disabled?: boolean; errors: Record<string, string> }) {
  const set = (i: number, patch: Partial<TicketField>) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-3">
      {value.length === 0 && <p className="text-sm text-muted-foreground">No extra fields. Add questions customers answer when they choose this category.</p>}
      {value.map((f, i) => {
        const err = (k: string) => errors[`fields.${i}.${k}`];
        return (
          <fieldset key={i} className="space-y-2 rounded-ui-sm border p-3">
            <legend className="sr-only">Field {i + 1}</legend>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto]">
              <Field label="Label" htmlFor={`tf-label-${i}`} error={err('label')}>
                <Input
                  id={`tf-label-${i}`}
                  value={f.label}
                  disabled={disabled}
                  maxLength={100}
                  onChange={(e) => set(i, { label: e.target.value, ...(f.key === keyFromLabel(f.label) || !f.key ? { key: keyFromLabel(e.target.value) } : {}) })}
                />
              </Field>
              <Field label="Key" htmlFor={`tf-key-${i}`} error={err('key')}>
                <Input id={`tf-key-${i}`} value={f.key} disabled={disabled} maxLength={40} className="font-mono" onChange={(e) => set(i, { key: e.target.value.toLowerCase() })} />
              </Field>
              <Field label="Type" htmlFor={`tf-type-${i}`}>
                <Select id={`tf-type-${i}`} value={f.type} disabled={disabled} onChange={(e) => set(i, { type: e.target.value as TicketFieldType })} options={FIELD_TYPES} />
              </Field>
              <div className="flex items-end pb-0.5">
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${f.label || 'field'}`} disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
            {f.type === 'select' && (
              <Field label="Options" htmlFor={`tf-options-${i}`} hint="Comma separated" error={err('options')}>
                <Input
                  id={`tf-options-${i}`}
                  value={f.options.join(', ')}
                  disabled={disabled}
                  onChange={(e) => set(i, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })}
                />
              </Field>
            )}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Field label="Help text" htmlFor={`tf-help-${i}`}>
                <Input id={`tf-help-${i}`} value={f.help} disabled={disabled} maxLength={300} onChange={(e) => set(i, { help: e.target.value })} placeholder="Shown under the field" />
              </Field>
              <Checkbox checked={f.required} disabled={disabled} onChange={(e) => set(i, { required: e.target.checked })} label="Required" className="pb-2" />
            </div>
          </fieldset>
        );
      })}
      {!disabled && value.length < 20 && (
        <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => onChange([...value, { key: '', label: '', type: 'text', options: [], required: false, help: '' }])}>
          Add field
        </Button>
      )}
    </div>
  );
}

/** Inputs for a category's fields (new ticket form, editing a ticket). Values are validated again on the server. */
export function TicketFieldInputs({ fields, value, onChange, idPrefix, errors = {} }: { fields: TicketField[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; idPrefix: string; errors?: Record<string, string> }) {
  const set = (key: string, v: string) => onChange({ ...value, [key]: v });
  return (
    <>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const current = value[f.key] === undefined || value[f.key] === null ? '' : String(value[f.key]);
        return (
          <Field key={f.key} label={f.label} htmlFor={id} required={f.required} hint={f.help || undefined} error={errors[`customFields.${f.key}`]}>
            {f.type === 'select' ? (
              <Select id={id} value={current} onChange={(e) => set(f.key, e.target.value)} placeholder={f.required ? 'Choose…' : 'Not set'} options={f.options} required={f.required} />
            ) : (
              <Input id={id} type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'} value={current} onChange={(e) => set(f.key, e.target.value)} required={f.required} />
            )}
          </Field>
        );
      })}
    </>
  );
}

/** Non-empty values only, numbers as numbers: what the API expects. */
export function fieldValues(fields: TicketField[], value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = value[f.key];
    if (v === undefined || v === null || v === '') continue;
    out[f.key] = f.type === 'number' && typeof v === 'string' ? Number(v) : v;
  }
  return out;
}

interface TicketWithFields {
  id: string;
  status: string;
  custom_fields: Record<string, unknown>;
  category_fields: TicketField[];
}

/** The category's questions and the answers given, editable by agents. */
export function TicketFieldsCard({ ticket }: { ticket: TicketWithFields }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(ticket.custom_fields);
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => {
      // Cleared fields are sent as null so the server removes them.
      const values = Object.fromEntries(ticket.category_fields.map((f) => [f.key, draft[f.key] === '' || draft[f.key] === undefined ? null : f.type === 'number' ? Number(draft[f.key]) : draft[f.key]]));
      return api.patch(`/api/admin/support/tickets/${ticket.id}`, { customFields: values });
    },
    {
      success: 'Fields saved',
      invalidate: [['ticket', ticket.id]],
      onSuccess: () => {
        setEditing(false);
        setError(null);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );
  const known = new Set(ticket.category_fields.map((f) => f.key));
  const other = Object.entries(ticket.custom_fields).filter(([k, v]) => !known.has(k) && v !== null && v !== '');
  if (!ticket.category_fields.length && !other.length) return null;
  const manage = can('support.tickets.manage') && ticket.status !== 'closed' && ticket.category_fields.length > 0;
  const shown = (v: unknown) => (v === undefined || v === null || v === '' ? <span className="text-muted-foreground">—</span> : String(v));
  return (
    <Card
      title="Details"
      actions={
        manage &&
        !editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(ticket.custom_fields);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <FormError message={error} />
          <TicketFieldInputs fields={ticket.category_fields} value={draft} onChange={setDraft} idPrefix="tfc" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <dl className="space-y-2.5">
          {ticket.category_fields.map((f) => (
            <div key={f.key} className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{f.label}</dt>
              <dd className="mt-0.5 break-words text-sm">
                {f.type === 'url' && typeof ticket.custom_fields[f.key] === 'string' ? (
                  <a href={String(ticket.custom_fields[f.key])} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {String(ticket.custom_fields[f.key])}
                  </a>
                ) : (
                  shown(ticket.custom_fields[f.key])
                )}
              </dd>
            </div>
          ))}
          {other.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 break-words text-sm">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

// ---- Watchers -----------------------------------------------------------------------------------------

/** Agents notified about customer activity on a ticket; anyone working tickets can watch or stop watching. */
export function WatchersField({ ticket }: { ticket: { id: string; status: string; watcher_ids: string[]; watchers: { id: string; name: string; email: string }[] } }) {
  const { me, can } = useAuth();
  const agents = useAgents();
  const manage = can('support.tickets.manage') && ticket.status !== 'closed';
  const save = useAction((watcherIds: string[]) => api.patch(`/api/admin/support/tickets/${ticket.id}`, { watcherIds }), { invalidate: [['ticket', ticket.id]] });
  const watching = Boolean(me && ticket.watcher_ids.includes(me.admin.id));
  const candidates = (agents.data?.data ?? []).filter((a) => !ticket.watcher_ids.includes(a.id));
  return (
    <Field label="Watchers" htmlFor="tp-watchers" hint="Notified about new replies from the customer">
      {ticket.watchers.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {ticket.watchers.map((w) => (
            <li key={w.id}>
              <Badge>
                {w.name}
                {manage && (
                  <button type="button" className="-mr-1 rounded-full px-1 hover:text-foreground" aria-label={`Stop ${w.name} watching`} onClick={() => save.mutate(ticket.watcher_ids.filter((id) => id !== w.id))}>
                    ×
                  </button>
                )}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nobody</p>
      )}
      {manage && (
        <div className="flex flex-wrap items-center gap-2">
          {me && (
            <Button
              size="sm"
              variant="outline"
              icon={watching ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              loading={save.isPending}
              onClick={() => save.mutate(watching ? ticket.watcher_ids.filter((id) => id !== me.admin.id) : [...ticket.watcher_ids, me.admin.id])}
            >
              {watching ? 'Stop watching' : 'Watch'}
            </Button>
          )}
          {candidates.length > 0 && (
            <Select id="tp-watchers" aria-label="Add a watcher" className="w-auto" value="" onChange={(e) => e.target.value && save.mutate([...ticket.watcher_ids, e.target.value])} placeholder="Add a watcher…" options={candidates.map((a) => ({ value: a.id, label: a.name }))} />
          )}
        </div>
      )}
    </Field>
  );
}

// ---- Round-robin assignment --------------------------------------------------------------------------

interface AssignmentConfig {
  roundRobinEnabled: boolean;
  agentIds: string[];
  lastAssigned: Record<string, string>;
}

/** Support → Assignment: rotate new unassigned tickets through chosen agents. */
export function AssignmentTab() {
  const { can } = useAuth();
  const manage = can('support.settings.manage');
  const agents = useAgents();
  const config = useQuery({ queryKey: ['support-assignment'], queryFn: () => api.get<AssignmentConfig>('/api/admin/support/assignment') });
  const [draft, setDraft] = useState<{ enabled: boolean; agentIds: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: { roundRobinEnabled: boolean; agentIds: string[] }) => api.put('/api/admin/support/assignment', body), {
    success: 'Assignment saved',
    invalidate: [['support-assignment']],
    onSuccess: () => {
      setDraft(null);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (config.isLoading || agents.isLoading) return <Skeleton className="h-48" />;
  if (config.error || !config.data) return <ErrorState error={config.error} onRetry={() => void config.refetch()} />;
  const current = draft ?? { enabled: config.data.roundRobinEnabled, agentIds: config.data.agentIds };
  const dirty = draft !== null && (draft.enabled !== config.data.roundRobinEnabled || draft.agentIds.join('|') !== config.data.agentIds.join('|'));
  const list = agents.data?.data ?? [];
  const toggleAgent = (id: string, on: boolean) => setDraft({ ...current, agentIds: on ? [...current.agentIds, id] : current.agentIds.filter((a) => a !== id) });
  return (
    <div className="space-y-4">
      <Callout title="How new tickets are assigned">
        An assignee chosen when the ticket is opened always wins. Otherwise the category’s default agent gets it (set per category under Categories &amp; SLAs). Tickets still unassigned then rotate through the agents below, if round-robin is on. Category watchers are notified about every new ticket and customer reply.
      </Callout>
      <Card
        title="Round-robin"
        description="Each new unassigned ticket goes to the agent in the rotation who was given one least recently. Deactivated agents and agents without ticket permissions are skipped."
        actions={
          manage && (
            <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ roundRobinEnabled: current.enabled, agentIds: current.agentIds })}>
              {dirty ? 'Save changes' : 'Saved'}
            </Button>
          )
        }
      >
        <div className="space-y-4">
          <FormError message={error} />
          <Switch checked={current.enabled} disabled={!manage} onCheckedChange={(enabled) => setDraft({ ...current, enabled })} label="Rotate new unassigned tickets" description={current.enabled ? `${current.agentIds.length} agents in the rotation` : 'Off: tickets without a default agent stay unassigned'} />
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active agents can work tickets yet.</p>
          ) : (
            <ul className="divide-y rounded-ui-sm border">
              {list.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <Checkbox checked={current.agentIds.includes(a.id)} disabled={!manage} onChange={(e) => toggleAgent(a.id, e.target.checked)} label={a.name} description={a.email} />
                  {config.data.lastAssigned[a.id] && (
                    <span className="text-xs text-muted-foreground">
                      Last auto-assigned <When value={config.data.lastAssigned[a.id]} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

/** Agents chosen from the support agent list (watchers of a category). */
export function AgentChecklist({ value, onChange, disabled, label }: { value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; label: string }) {
  const agents = useAgents();
  const list = agents.data?.data ?? [];
  if (agents.isLoading) return <Skeleton className="h-16" />;
  if (!list.length) return <p className="text-sm text-muted-foreground">No active agents can work tickets yet.</p>;
  return (
    <fieldset className="max-h-44 space-y-1.5 overflow-y-auto rounded-ui-sm border p-2.5" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {list.map((a) => (
        <Checkbox key={a.id} checked={value.includes(a.id)} onChange={(e) => onChange(e.target.checked ? [...value, a.id] : value.filter((v) => v !== a.id))} label={a.name} description={a.email} />
      ))}
    </fieldset>
  );
}
