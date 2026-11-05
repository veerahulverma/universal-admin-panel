import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { Badge, Button, Callout, Checkbox, CodeBlock, Input, Modal, SearchInput, Select, Skeleton, type Tone } from '../../components/ui';

// ---- Formatting -------------------------------------------------------------------------------

const METHOD_TONES: Record<string, Tone> = { GET: 'info', POST: 'success', PUT: 'warning', PATCH: 'warning', DELETE: 'danger' };

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  return (
    <Badge tone={METHOD_TONES[m] ?? 'neutral'} className="w-16 justify-center font-mono text-2xs tracking-wide">
      {m}
    </Badge>
  );
}

export function statusTone(status: number | null | undefined): Tone {
  if (!status) return 'neutral';
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  if (status >= 300) return 'info';
  return 'success';
}

export function HttpStatus({ status, error }: { status: number | null | undefined; error?: string | null }) {
  if (!status) return error ? <Badge tone="danger">{truncate(error, 40)}</Badge> : <span className="text-muted-foreground">—</span>;
  return (
    <Badge tone={statusTone(status)} className="font-mono">
      {status}
    </Badge>
  );
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${n} ms`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---- One-time secrets -------------------------------------------------------------------------

/**
 * Shows a newly issued secret exactly once. The secret only lives in the
 * caller's component state; closing the dialog discards it.
 */
export function SecretOnceDialog({ open, onClose, title, secret, description, note }: { open: boolean; onClose: () => void; title: string; secret: string | null; description?: string; note?: React.ReactNode }) {
  const [saved, setSaved] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setSaved(false);
          onClose();
        }
      }}
      title={title}
      description={description}
      footer={
        <Button
          disabled={!saved}
          onClick={() => {
            setSaved(false);
            onClose();
          }}
        >
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        <Callout tone="warning" title="Copy this secret now">
          For security it is stored only as a hash and will not be shown again. If you lose it, roll a new one.
        </Callout>
        {secret && <CodeBlock code={secret} className="break-all" />}
        {note}
        <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} label="I have stored this secret somewhere safe" />
      </div>
    </Modal>
  );
}

// ---- Organization scoping -----------------------------------------------------------------------

interface OrgOption {
  id: string;
  name: string;
}

/**
 * Pick the organization a key or endpoint is limited to. Organization-scoped
 * admins must choose one of their organizations (the server enforces this).
 */
export function OrgScopeField({ value, onChange, id, allowAll = true }: { value: string | null; onChange: (v: string | null) => void; id?: string; allowAll?: boolean }) {
  const { me, can } = useAuth();
  const scoped = Boolean(me?.admin.orgScope);
  const [q, setQ] = useState('');
  const search = useDebounced(q, 250);
  const orgs = useQuery({
    queryKey: ['developers', 'org-options', search],
    queryFn: () => api.get<Page<OrgOption>>('/api/admin/organizations', { q: search || undefined, pageSize: 50, sort: 'name', order: 'asc' }),
    enabled: can('customers.organizations.view'),
    staleTime: 60_000,
  });
  const options = useMemo(() => {
    const list = (orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }));
    if (value && !list.some((o) => o.value === value)) list.unshift({ value, label: value });
    return list;
  }, [orgs.data, value]);

  if (!can('customers.organizations.view')) {
    return <Input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value.trim() || null)} placeholder={scoped ? 'Organization ID (required)' : 'Organization ID (optional)'} className="font-mono" />;
  }
  return (
    <div className="space-y-2">
      <SearchInput value={q} onChange={setQ} placeholder="Find an organization…" />
      <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder={allowAll && !scoped ? 'All organizations (platform-wide)' : 'Choose an organization'} options={options} />
      {orgs.isLoading && <Skeleton className="h-4 w-40" />}
    </div>
  );
}

// ---- Event type picker -----------------------------------------------------------------------------

export interface EventTypeDef {
  type: string;
  description: string;
  module: string;
}

export function useEventTypes() {
  return useQuery({ queryKey: ['developers', 'event-types'], queryFn: () => api.get<{ data: EventTypeDef[] }>('/api/admin/event-types'), staleTime: 10 * 60_000 });
}

/** "user.created" -> "user" */
export const eventGroup = (type: string) => type.split('.')[0];

/**
 * Event subscriptions use the same patterns the server matches: "*" (all),
 * "user.*" (a whole resource) or exact types.
 */
export function EventPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const types = useEventTypes();
  const [q, setQ] = useState('');
  const all = value.includes('*');
  // webhook.* events (endpoint health, tests) are never fanned out to endpoints.
  const list = useMemo(() => (types.data?.data ?? []).filter((t) => !t.type.startsWith('webhook.')), [types.data]);
  const groups = useMemo(() => {
    const lower = q.trim().toLowerCase();
    const map = new Map<string, EventTypeDef[]>();
    for (const t of list) {
      if (lower && !t.type.includes(lower) && !t.description.toLowerCase().includes(lower)) continue;
      const g = eventGroup(t.type);
      map.set(g, [...(map.get(g) ?? []), t]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list, q]);
  const set = new Set(value);

  const toggle = (pattern: string, on: boolean) => {
    const next = new Set(value.filter((v) => v !== '*'));
    if (on) next.add(pattern);
    else next.delete(pattern);
    // Selecting a whole group replaces its individual types.
    if (pattern.endsWith('.*') && on) for (const v of [...next]) if (v !== pattern && eventGroup(v) === pattern.slice(0, -2)) next.delete(v);
    onChange([...next]);
  };

  return (
    <div className="space-y-3">
      <Checkbox checked={all} onChange={(e) => onChange(e.target.checked ? ['*'] : [])} label="All events" description="Including event types added later by modules and plugins." />
      {!all && (
        <div className="rounded-ui border">
          <div className="border-b p-2">
            <SearchInput value={q} onChange={setQ} placeholder="Filter event types…" />
          </div>
          <div className="max-h-72 space-y-3 overflow-y-auto p-3">
            {types.isLoading && <Skeleton className="h-24" />}
            {groups.map(([group, items]) => {
              const whole = set.has(`${group}.*`);
              return (
                <fieldset key={group}>
                  <legend className="sr-only">{group} events</legend>
                  <Checkbox checked={whole} onChange={(e) => toggle(`${group}.*`, e.target.checked)} label={<span className="font-mono text-xs">{group}.*</span>} description={`All ${group} events`} />
                  <div className="ml-6 mt-1.5 space-y-1.5">
                    {items.map((t) => (
                      <Checkbox
                        key={t.type}
                        checked={whole || set.has(t.type)}
                        disabled={whole}
                        onChange={(e) => toggle(t.type, e.target.checked)}
                        label={<span className="font-mono text-xs font-normal">{t.type}</span>}
                        description={t.description}
                      />
                    ))}
                  </div>
                </fieldset>
              );
            })}
            {!types.isLoading && groups.length === 0 && <p className="text-sm text-muted-foreground">No event types match.</p>}
          </div>
        </div>
      )}
      {!all && value.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <TriangleAlert className="size-3.5" aria-hidden="true" /> Choose at least one event.
        </p>
      )}
    </div>
  );
}

export function describeEvents(events: string[]): string {
  if (events.includes('*')) return 'All events';
  if (events.length <= 2) return events.join(', ');
  return `${events.slice(0, 2).join(', ')} +${events.length - 2}`;
}
