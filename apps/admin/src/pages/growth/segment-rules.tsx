import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { fromMinor, money, toMinor } from '../../lib/format';
import { Button, Input, SearchInput, Select, Spinner } from '../../components/ui';

/**
 * Segment rules mirror the server allowlist (modules/marketing/segments.ts):
 * only these fields and operators exist, and values are validated again on the server.
 */
export interface Condition {
  field: string;
  op: string;
  value?: unknown;
}

export interface SegmentRules {
  match: 'all' | 'any';
  conditions: Condition[];
}

export interface Segment {
  id: string;
  name: string;
  description: string;
  rules: SegmentRules;
  created_at: string;
  updated_at: string;
}

type InputKind = 'plan' | 'subscription_status' | 'country' | 'text' | 'created' | 'activity' | 'money' | 'boolean' | 'user_status' | 'organization' | 'locale';

const OP_LABELS: Record<string, string> = {
  is: 'is',
  is_not: 'is not',
  in: 'is one of',
  has: 'has',
  not_has: 'does not have',
  before: 'is before',
  after: 'is on or after',
  within_days: 'in the last … days',
  older_than_days: 'more than … days ago',
  never: 'never',
  gte: 'at least',
  lte: 'at most',
  member_of: 'is a member of',
};

export const FIELDS: { key: string; label: string; ops: string[]; input: InputKind }[] = [
  { key: 'plan', label: 'Plan', ops: ['is', 'is_not'], input: 'plan' },
  { key: 'subscription_status', label: 'Subscription status', ops: ['is', 'is_not'], input: 'subscription_status' },
  { key: 'country', label: 'Country', ops: ['is', 'is_not', 'in'], input: 'country' },
  { key: 'tag', label: 'Tag', ops: ['has', 'not_has'], input: 'text' },
  { key: 'created_at', label: 'Signed up', ops: ['within_days', 'older_than_days', 'before', 'after'], input: 'created' },
  { key: 'last_active_at', label: 'Last active', ops: ['within_days', 'older_than_days', 'never'], input: 'activity' },
  { key: 'lifetime_revenue', label: 'Lifetime revenue', ops: ['gte', 'lte'], input: 'money' },
  { key: 'marketing_consent', label: 'Marketing consent', ops: ['is'], input: 'boolean' },
  { key: 'email_verified', label: 'Email verified', ops: ['is'], input: 'boolean' },
  { key: 'status', label: 'Account status', ops: ['is', 'is_not'], input: 'user_status' },
  { key: 'organization', label: 'Organization', ops: ['member_of'], input: 'organization' },
  { key: 'locale', label: 'Language', ops: ['is'], input: 'locale' },
  { key: 'registration_source', label: 'Signup source', ops: ['is'], input: 'text' },
];

const SUB_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled', 'unpaid', 'none'];
const USER_STATUSES = ['active', 'suspended', 'banned', 'pending'];

export function fieldDef(key: string) {
  return FIELDS.find((f) => f.key === key) ?? FIELDS[0];
}

/** A sensible starting value whenever the field or operator changes. */
export function defaultValue(field: string, op: string): unknown {
  const def = fieldDef(field);
  switch (def.input) {
    case 'subscription_status':
      return 'active';
    case 'user_status':
      return 'active';
    case 'boolean':
      return true;
    case 'money':
      return 0;
    case 'country':
      return op === 'in' ? [] : '';
    case 'created':
      return op === 'before' || op === 'after' ? new Date().toISOString().slice(0, 10) : 30;
    case 'activity':
      return op === 'never' ? undefined : 30;
    case 'locale':
      return 'en';
    default:
      return '';
  }
}

export function newCondition(field = 'plan'): Condition {
  const op = fieldDef(field).ops[0];
  return { field, op, value: defaultValue(field, op) };
}

function OrganizationSelect({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const allowed = can('customers.organizations.view');
  const current = useQuery({
    queryKey: ['org-name', value],
    queryFn: () => api.get<Page<{ id: string; name: string }>>('/api/admin/organizations', { q: value, pageSize: 1 }),
    enabled: allowed && Boolean(value),
    staleTime: 5 * 60_000,
  });
  const results = useQuery({
    queryKey: ['org-picker', term],
    queryFn: ({ signal }) => api.get<Page<{ id: string; name: string; slug: string }>>('/api/admin/organizations', { q: term, pageSize: 6 }, signal),
    enabled: allowed && term.length >= 2,
  });
  if (!allowed) return <Input value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="Organization ID (org_…)" disabled={disabled} aria-label="Organization ID" />;
  if (value) {
    const name = current.data?.data.find((o) => o.id === value)?.name;
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate rounded-ui-sm border px-3 py-1.5 text-sm">{name ?? value}</span>
        {!disabled && (
          <Button size="sm" variant="ghost" onClick={() => onChange('')}>
            Change
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="relative min-w-0 flex-1">
      <SearchInput value={q} onChange={setQ} placeholder="Find an organization" />
      {term.length >= 2 && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-ui-sm border bg-surface shadow-lg">
          {results.isLoading && (
            <li className="flex justify-center p-2">
              <Spinner />
            </li>
          )}
          {results.data?.data.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matches.</li>}
          {results.data?.data.map((o) => (
            <li key={o.id}>
              <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => onChange(o.id)}>
                {o.name} <span className="text-xs text-muted-foreground">{o.slug}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ValueInput({ condition, onChange, disabled, currency, plans, invalid }: { condition: Condition; onChange: (v: unknown) => void; disabled?: boolean; currency: string; plans: { key: string; name: string }[] | null; invalid?: boolean }) {
  const def = fieldDef(condition.field);
  const v = condition.value;
  const common = { disabled, invalid, 'aria-label': `${def.label} value` };
  switch (def.input) {
    case 'plan':
      return plans ? (
        <Select {...common} value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="Choose a plan" options={plans.map((p) => ({ value: p.key, label: p.name }))} />
      ) : (
        <Input {...common} value={String(v ?? '')} onChange={(e) => onChange(e.target.value.trim())} placeholder="Plan key, e.g. pro" />
      );
    case 'subscription_status':
      return <Select {...common} value={String(v ?? 'active')} onChange={(e) => onChange(e.target.value)} options={SUB_STATUSES.map((s) => ({ value: s, label: s === 'none' ? 'No subscription' : s.replace('_', ' ') }))} />;
    case 'user_status':
      return <Select {...common} value={String(v ?? 'active')} onChange={(e) => onChange(e.target.value)} options={USER_STATUSES} />;
    case 'boolean':
      return <Select {...common} value={v ? 'true' : 'false'} onChange={(e) => onChange(e.target.value === 'true')} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />;
    case 'country':
      return condition.op === 'in' ? (
        <Input {...common} value={Array.isArray(v) ? v.join(', ') : ''} onChange={(e) => onChange(e.target.value.split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))} placeholder="DE, FR, NL" />
      ) : (
        <Input {...common} value={String(v ?? '')} onChange={(e) => onChange(e.target.value.trim().toUpperCase().slice(0, 2))} placeholder="DE" maxLength={2} />
      );
    case 'created':
      return condition.op === 'before' || condition.op === 'after' ? (
        <Input {...common} type="date" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input {...common} type="number" min={0} step={1} value={v === undefined ? '' : String(v)} onChange={(e) => onChange(e.target.value === '' ? undefined : Math.round(Number(e.target.value)))} placeholder="days" />
      );
    case 'activity':
      return condition.op === 'never' ? null : <Input {...common} type="number" min={0} step={1} value={v === undefined ? '' : String(v)} onChange={(e) => onChange(e.target.value === '' ? undefined : Math.round(Number(e.target.value)))} placeholder="days" />;
    case 'money':
      return (
        <div className="flex items-center gap-1.5">
          <Input {...common} type="number" min={0} step="0.01" value={typeof v === 'number' ? fromMinor(v, currency) : ''} onChange={(e) => onChange(toMinor(e.target.value || '0', currency) ?? 0)} />
          <span className="text-xs text-muted-foreground">{currency}</span>
        </div>
      );
    case 'organization':
      return <OrganizationSelect value={String(v ?? '')} onChange={onChange} disabled={disabled} />;
    case 'locale':
      return <Input {...common} value={String(v ?? '')} onChange={(e) => onChange(e.target.value.trim())} placeholder="en, de, pt-BR" maxLength={10} />;
    default:
      return <Input {...common} value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} maxLength={100} />;
  }
}

export function ConditionRow({ condition, onChange, onRemove, disabled, error, currency, plans }: { condition: Condition; onChange: (c: Condition) => void; onRemove: () => void; disabled?: boolean; error?: string; currency: string; plans: { key: string; name: string }[] | null }) {
  const def = fieldDef(condition.field);
  return (
    <li className="rounded-ui border bg-surface p-2.5">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-center">
        <Select
          aria-label="Field"
          value={condition.field}
          disabled={disabled}
          onChange={(e) => {
            const field = e.target.value;
            const op = fieldDef(field).ops[0];
            onChange({ field, op, value: defaultValue(field, op) });
          }}
          options={FIELDS.map((f) => ({ value: f.key, label: f.label }))}
        />
        <Select
          aria-label="Operator"
          value={condition.op}
          disabled={disabled}
          onChange={(e) => {
            const op = e.target.value;
            // Keep a compatible value (e.g. days stay days), otherwise start fresh.
            const sameShape = typeof defaultValue(condition.field, op) === typeof condition.value && Array.isArray(defaultValue(condition.field, op)) === Array.isArray(condition.value);
            onChange({ ...condition, op, value: sameShape ? condition.value : defaultValue(condition.field, op) });
          }}
          options={def.ops.map((o) => ({ value: o, label: OP_LABELS[o] ?? o }))}
        />
        <div className="min-w-0">
          <ValueInput condition={condition} onChange={(value) => onChange({ ...condition, value })} disabled={disabled} currency={currency} plans={plans} invalid={Boolean(error)} />
        </div>
        {!disabled && (
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove condition" className="justify-self-end">
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {error && (
        <p className="mt-1.5 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** One-line description of the rules, for lists ("All of: Plan is pro · Country is one of DE, FR"). */
export function describeRules(rules: SegmentRules | null | undefined, currency: string): string {
  const conditions = rules?.conditions ?? [];
  if (!conditions.length) return 'Everyone (no conditions)';
  const parts = conditions.map((c) => {
    const def = fieldDef(c.field);
    const op = OP_LABELS[c.op] ?? c.op;
    let value: string;
    if (c.op === 'never') return `${def.label} never`;
    if (def.input === 'money') value = money(Number(c.value ?? 0), currency);
    else if (def.input === 'boolean') value = c.value ? 'yes' : 'no';
    else if (Array.isArray(c.value)) value = c.value.join(', ');
    else value = String(c.value ?? '');
    if (c.op === 'within_days') return `${def.label} in the last ${value} days`;
    if (c.op === 'older_than_days') return `${def.label} more than ${value} days ago`;
    return `${def.label} ${op} ${value}`;
  });
  return `${rules?.match === 'any' ? 'Any of' : 'All of'}: ${parts.join(' · ')}`;
}
