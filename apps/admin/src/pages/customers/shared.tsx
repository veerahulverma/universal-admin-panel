import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Clock, X } from 'lucide-react';
import clsx from 'clsx';
import { api, type Page } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { ago, dateTime } from '../../lib/format';
import { Avatar, Badge, Checkbox, Field, Input, Select, Spinner, type Tone } from '../../components/ui';

// ---- User picker ------------------------------------------------------------------------------

export interface PickedUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Search-as-you-type user selector. Results render in the normal flow (not a
 * floating layer) so it also works inside scrolling dialogs.
 */
export function UserPicker({ value, onChange, id, placeholder = 'Search by name, email or ID…', excludeIds = [], disabled }: { value: PickedUser | null; onChange: (u: PickedUser | null) => void; id?: string; placeholder?: string; excludeIds?: string[]; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const term = useDebounced(q.trim(), 250);
  const results = useQuery({
    queryKey: ['user-picker', term],
    // Pickers look for a specific person, so archived (long-inactive) customers are included.
    queryFn: ({ signal }) => api.get<Page<PickedUser & { status: string; archived_at: string | null }>>('/api/admin/users', { q: term, pageSize: 8, archived: 'include' }, signal),
    enabled: term.length >= 2 && !value,
    placeholderData: keepPreviousData,
  });
  const options = (results.data?.data ?? []).filter((u) => !excludeIds.includes(u.id));

  if (value) {
    return (
      <div className="flex items-center gap-2.5 rounded-ui-sm border bg-surface px-2.5 py-1.5 shadow-ui">
        <Avatar name={value.name} email={value.email} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{value.name || value.email}</span>
          {value.name && <span className="block truncate text-xs text-muted-foreground">{value.email}</span>}
        </span>
        {!disabled && (
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Clear selected user" onClick={() => onChange(null)}>
            <X className="size-4" />
          </button>
        )}
      </div>
    );
  }

  const listId = `${id ?? 'user-picker'}-results`;
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Input
          id={id}
          value={q}
          disabled={disabled}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter' && options[active]) {
              e.preventDefault();
              onChange(options[active]);
              setQ('');
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        {results.isFetching && <Spinner className="absolute right-2.5 top-1/2 -translate-y-1/2" />}
      </div>
      {term.length >= 2 && (
        <ul id={listId} role="listbox" className="max-h-56 overflow-y-auto rounded-ui-sm border bg-surface p-1">
          {options.length === 0 ? (
            <li className="px-2.5 py-2 text-sm text-muted-foreground">{results.isFetching ? 'Searching…' : 'No matching users'}</li>
          ) : (
            options.map((u, i) => (
              <li
                key={u.id}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(u);
                  setQ('');
                }}
                className={clsx('flex cursor-pointer items-center gap-2.5 rounded-ui-sm px-2.5 py-1.5', i === active && 'bg-muted')}
              >
                <Avatar name={u.name} email={u.email} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{u.name || u.email}</span>
                  {u.name && <span className="block truncate text-xs text-muted-foreground">{u.email}</span>}
                </span>
                {u.status !== 'active' && <Badge>{u.status}</Badge>}
                {u.archived_at && <Badge>archived</Badge>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ---- Custom fields ----------------------------------------------------------------------------

export interface CustomFieldDef {
  id: string;
  entity: 'user' | 'organization';
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'date' | 'url';
  options: string[];
  required: boolean;
  show_in_list: boolean;
  position: number;
  created_at: string;
}

export function useCustomFieldDefs(entity: 'user' | 'organization', enabled = true) {
  return useQuery({
    queryKey: ['custom-fields', entity],
    queryFn: () => api.get<{ data: CustomFieldDef[] }>('/api/admin/custom-fields', { entity }),
    enabled,
    staleTime: 60_000,
  });
}

/** Inputs for the custom fields defined for an entity (validated again on the server). */
export function CustomFieldInputs({ defs, value, onChange, idPrefix = 'cf' }: { defs: CustomFieldDef[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; idPrefix?: string }) {
  if (!defs.length) return null;
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === '' || v === undefined || v === null) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <>
      {defs.map((d) => {
        const id = `${idPrefix}-${d.key}`;
        const current = value[d.key];
        if (d.type === 'boolean') {
          return (
            <div key={d.key} className="sm:col-span-2">
              <Checkbox id={id} checked={Boolean(current)} onChange={(e) => set(d.key, e.target.checked)} label={d.label} />
            </div>
          );
        }
        return (
          <Field key={d.key} label={d.label} htmlFor={id} required={d.required}>
            {d.type === 'select' ? (
              <Select id={id} value={current === undefined || current === null ? '' : String(current)} onChange={(e) => set(d.key, e.target.value)} placeholder={d.required ? undefined : 'Not set'} options={d.options} />
            ) : (
              <Input
                id={id}
                type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : d.type === 'url' ? 'url' : 'text'}
                value={current === undefined || current === null ? '' : String(current)}
                onChange={(e) => set(d.key, d.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
                required={d.required}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

export function formatCustomValue(def: CustomFieldDef | undefined, v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (def?.type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- Support helpers ------------------------------------------------------------------------------

export const TICKET_STATUSES = ['open', 'pending', 'on_hold', 'solved', 'closed'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const STATUS_LABEL: Record<string, string> = { open: 'Open', pending: 'Pending (waiting on customer)', on_hold: 'On hold', solved: 'Solved', closed: 'Closed' };

const PRIORITY_TONE: Record<string, Tone> = { urgent: 'danger', high: 'warning', normal: 'neutral', low: 'neutral' };

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'} className={priority === 'low' ? 'opacity-70' : undefined}>
      {priority}
    </Badge>
  );
}

interface SlaFields {
  status: string;
  sla_breached_at: string | null;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
}

/** The SLA clock that matters now: first response until answered, then resolution. */
export function slaTarget(t: SlaFields): { label: string; due: string } | null {
  if (t.status === 'solved' || t.status === 'closed') return null;
  if (!t.first_responded_at && t.first_response_due_at) return { label: 'First response', due: t.first_response_due_at };
  if (t.resolution_due_at) return { label: 'Resolution', due: t.resolution_due_at };
  return null;
}

export function SlaBadge({ ticket, compact, hideEmpty }: { ticket: SlaFields; compact?: boolean; hideEmpty?: boolean }) {
  if (ticket.sla_breached_at && ticket.status !== 'solved' && ticket.status !== 'closed') {
    return (
      <Badge tone="danger" dot>
        SLA breached
      </Badge>
    );
  }
  const target = slaTarget(ticket);
  if (!target) return hideEmpty ? null : <span className="text-muted-foreground">—</span>;
  const ms = new Date(target.due).getTime() - Date.now();
  const tone: Tone = ms < 0 ? 'danger' : ms < 60 * 60 * 1000 ? 'warning' : 'neutral';
  return (
    <span title={`${target.label} due ${dateTime(target.due)}`}>
      <Badge tone={tone}>
        <Clock className="size-3" aria-hidden="true" />
        {compact ? ago(target.due) : `${target.label} ${ms < 0 ? 'overdue' : 'due'} ${ago(target.due)}`}
      </Badge>
    </span>
  );
}

/** Minutes as "45 min", "4 h", "2 d 3 h". */
export function minutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export interface Agent {
  id: string;
  name: string;
  email: string;
}

export function useAgents(enabled = true) {
  return useQuery({ queryKey: ['support-agents'], queryFn: () => api.get<{ data: Agent[] }>('/api/admin/support/agents'), enabled, staleTime: 5 * 60_000 });
}

export interface TicketCategory {
  id: string;
  name: string;
  description: string;
  default_priority: string;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  active: boolean;
  position: number;
}

export function useCategories(enabled = true) {
  return useQuery({ queryKey: ['support-categories'], queryFn: () => api.get<{ data: TicketCategory[] }>('/api/admin/support/categories'), enabled, staleTime: 60_000 });
}

/** Read files as base64 for the JSON attachment API. */
export async function toAttachments(files: File[]): Promise<{ filename: string; contentType: string; data: string }[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<{ filename: string; contentType: string; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', data: String(reader.result).split(',')[1] ?? '' });
          reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
          reader.readAsDataURL(file);
        }),
    ),
  );
}

/** Attachment chooser that lists picked files with a remove button. */
export function FilePicker({ files, onChange, id, disabled }: { files: File[]; onChange: (f: File[]) => void; id: string; disabled?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={clsx('inline-flex cursor-pointer items-center gap-1.5 text-sm text-primary hover:underline', disabled && 'pointer-events-none opacity-50')}>
        Attach files
      </label>
      <input
        id={id}
        type="file"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          onChange([...files, ...Array.from(e.target.files ?? [])].slice(0, 10));
          e.target.value = '';
        }}
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
              <span className="truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} className="rounded-full p-0.5 text-muted-foreground hover:text-foreground" onClick={() => onChange(files.filter((_, j) => j !== i))}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RoleField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <Input id={id} list={`${id}-roles`} value={value} onChange={(e) => onChange(e.target.value)} maxLength={50} required />
      <datalist id={`${id}-roles`}>
        {['admin', 'member', 'billing', 'viewer'].map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </>
  );
}
