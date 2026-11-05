import { useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, FileText, FolderLock, Globe, Link2, X, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { api, type Page } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { date, dateTime } from '../../lib/format';
import { Avatar, Badge, Input, Spinner, type Tone } from '../../components/ui';

// ---- Types (mirroring apps/server/src/modules/access) ----------------------------------------

export type ResourceKind = 'url' | 'folder' | 'page' | 'link' | 'file';
export type LimitPeriod = 'day' | 'week' | 'month' | 'year' | 'lifetime';
export type DecisionState = 'available' | 'scheduled' | 'ended' | 'locked' | 'disabled' | 'inactive';

export interface ProductRef {
  id: string;
  key: string | null;
  name: string | null;
  kind: string | null;
}

export interface Rules {
  products: ProductRef[];
  groups: { id: string; name: string | null }[];
  anyCustomer: boolean;
}

export interface Release {
  mode: 'immediate' | 'days' | 'date';
  days: number | null;
  date: string | null;
}

export interface Resource {
  id: string;
  kind: ResourceKind;
  title: string;
  description: string;
  path: string | null;
  url: string | null;
  body?: string | null;
  status: 'active' | 'disabled';
  showLocked: boolean;
  position: number;
  rules: Rules;
  release: Release;
  windowDays: number | null;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccessFile {
  id: string;
  title: string;
  description: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  downloadLimit: number | null;
  limitPeriod: LimitPeriod;
  createdAt: string;
  updatedAt: string;
  usage?: { downloads30d: number; downloadsTotal: number; customers: number };
  resourceCount?: number;
}

export interface ResourceDetail extends Resource {
  files: AccessFile[];
  activity: { allowed30d: number; denied30d: number; lastAccessAt: string | null };
}

export interface MatchedBy {
  type: 'plan' | 'product' | 'group' | 'any_customer';
  id: string | null;
  name: string;
}

export interface Decision {
  allowed: boolean;
  state: DecisionState;
  reason: string;
  availableAt: string | null;
  availableUntil: string | null;
  matchedBy: MatchedBy | null;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string;
  autoProducts: ProductRef[];
  members: { total: number; manual: number; automatic: number };
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductOption {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
}

export interface AccessOptions {
  products: ProductOption[];
  groups: { id: string; name: string }[];
  files: { id: string; title: string; filename: string; size: number }[];
}

export interface AccessSettings {
  maxFileBytes: number;
  linkTtlMinutes: number;
  defaultDownloadLimit: number | null;
  defaultLimitPeriod: LimitPeriod;
  logRetentionDays: number;
}

// ---- Labels ---------------------------------------------------------------------------------

export const KINDS: { value: ResourceKind; label: string; icon: LucideIcon; hint: string }[] = [
  { value: 'url', label: 'URL', icon: Globe, hint: 'One exact path in your app' },
  { value: 'folder', label: 'Folder', icon: FolderLock, hint: 'A path and everything below it' },
  { value: 'page', label: 'Page', icon: FileText, hint: 'Members-only content your app displays' },
  { value: 'link', label: 'Link', icon: Link2, hint: 'An external URL shown only to members' },
  { value: 'file', label: 'Downloads', icon: Download, hint: 'Protected files with download limits' },
];

export const kindMeta = (kind: ResourceKind) => KINDS.find((k) => k.value === kind) ?? KINDS[0];

export const PERIODS: { value: LimitPeriod; label: string }[] = [
  { value: 'day', label: 'per day' },
  { value: 'week', label: 'per week' },
  { value: 'month', label: 'per 30 days' },
  { value: 'year', label: 'per year' },
  { value: 'lifetime', label: 'in total' },
];

export function limitLabel(limit: number | null, period: LimitPeriod): string {
  if (limit === null) return 'Unlimited';
  return `${limit} ${PERIODS.find((p) => p.value === period)?.label ?? period}`;
}

/** Plain-language versions of the reasons the server returns. */
export const REASONS: Record<string, string> = {
  plan: 'Allowed by plan',
  product: 'Allowed by product',
  group: 'Allowed by group',
  any_customer: 'Any signed-in customer',
  unprotected: 'Not protected',
  no_access: 'No matching plan, product or group',
  not_yet_available: 'Scheduled to open later',
  access_ended: 'Access window has ended',
  resource_disabled: 'Resource is disabled',
  account_inactive: 'Account is suspended, banned or unverified',
  download_limit_reached: 'Download limit reached',
  link_expired: 'Download link expired',
  invalid_link: 'Invalid or altered link',
  file_removed: 'File no longer offered',
  file_missing: 'File missing from storage',
};

export const reasonLabel = (reason: string) => REASONS[reason] ?? reason.replace(/_/g, ' ');

const STATE: Record<DecisionState, { label: string; tone: Tone }> = {
  available: { label: 'open', tone: 'success' },
  scheduled: { label: 'scheduled', tone: 'info' },
  ended: { label: 'ended', tone: 'neutral' },
  locked: { label: 'locked', tone: 'neutral' },
  disabled: { label: 'disabled', tone: 'warning' },
  inactive: { label: 'account inactive', tone: 'warning' },
};

export function StateBadge({ state }: { state: DecisionState }) {
  const s = STATE[state];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

/** One line explaining a decision: what matched, when it opens or when it ended. */
export function decisionDetail(d: Decision): string {
  if (d.state === 'available') {
    const via = d.matchedBy ? (d.matchedBy.type === 'any_customer' ? 'Any signed-in customer' : `Via ${d.matchedBy.name}`) : reasonLabel(d.reason);
    return d.availableUntil ? `${via} · until ${dateTime(d.availableUntil)}` : via;
  }
  if (d.state === 'scheduled' && d.availableAt) return `Opens ${dateTime(d.availableAt)}${d.matchedBy ? ` (via ${d.matchedBy.name})` : ''}`;
  if (d.state === 'ended' && d.availableUntil) return `Ended ${dateTime(d.availableUntil)}`;
  return reasonLabel(d.reason);
}

export function releaseSummary(release: Release, windowDays: number | null): string {
  const opens =
    release.mode === 'days' ? (release.days ? `${release.days} day${release.days === 1 ? '' : 's'} after access starts` : 'When access starts') : release.mode === 'date' && release.date ? `From ${date(release.date)}` : 'Immediately';
  return windowDays ? `${opens}, for ${windowDays} day${windowDays === 1 ? '' : 's'}` : opens;
}

export function ProductKindLabel({ kind }: { kind: string | null }) {
  return <>{kind === 'plan' ? 'Plan' : kind === 'addon' ? 'Add-on' : kind === 'one_time' ? 'One-time' : kind === 'credit_pack' ? 'Credit pack' : 'Product'}</>;
}

/** Who may open a resource, as compact chips. */
export function RulesSummary({ rules, empty = 'Nobody yet' }: { rules: Rules; empty?: ReactNode }) {
  const chips = [
    ...rules.products.map((p) => ({ key: p.id, label: p.name ?? p.key ?? p.id, tone: (p.kind === 'plan' ? 'primary' : 'info') as Tone })),
    ...rules.groups.map((g) => ({ key: g.id, label: g.name ?? g.id, tone: 'success' as Tone })),
    ...(rules.anyCustomer ? [{ key: 'any', label: 'Any customer', tone: 'neutral' as Tone }] : []),
  ];
  if (!chips.length) return <span className="text-sm text-warning">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <Badge key={c.key} tone={c.tone}>
          {c.label}
        </Badge>
      ))}
    </span>
  );
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// ---- Data hooks ------------------------------------------------------------------------------

export function useAccessOptions(enabled = true) {
  return useQuery({
    queryKey: ['access-options'],
    queryFn: () => api.get<AccessOptions>('/api/admin/access/options'),
    enabled,
    staleTime: 60_000,
  });
}

export function useGroupProductOptions(enabled = true) {
  return useQuery({
    queryKey: ['user-group-options'],
    queryFn: () => api.get<{ products: ProductOption[] }>('/api/admin/user-groups/options'),
    enabled,
    staleTime: 60_000,
  });
}

// ---- User search -------------------------------------------------------------------------------

export interface PickedUser {
  id: string;
  email: string;
  name: string | null;
  status?: string;
}

/**
 * Search-as-you-type user finder. Results render in the normal flow (not a
 * floating layer) so it works inside scrolling dialogs and on small screens.
 */
export function UserSearch({ onPick, excludeIds = [], id, placeholder = 'Search by name, email or ID…', disabled }: { onPick: (u: PickedUser) => void; excludeIds?: string[]; id?: string; placeholder?: string; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const term = useDebounced(q.trim(), 250);
  const results = useQuery({
    queryKey: ['access-user-search', term],
    queryFn: ({ signal }) => api.get<Page<PickedUser>>('/api/admin/users', { q: term, pageSize: 8 }, signal),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
  });
  const options = (results.data?.data ?? []).filter((u) => !excludeIds.includes(u.id));
  const pick = (u: PickedUser) => {
    onPick(u);
    setQ('');
    setActive(0);
  };
  const listId = `${id ?? 'user-search'}-results`;
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
              pick(options[active]);
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={term.length >= 2}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        {results.isFetching && <Spinner className="absolute right-2.5 top-1/2 -translate-y-1/2" />}
      </div>
      {term.length >= 2 && (
        <ul id={listId} role="listbox" className="max-h-56 overflow-y-auto rounded-ui-sm border bg-surface p-1">
          {options.length === 0 ? (
            <li className="px-2.5 py-2 text-sm text-muted-foreground">{results.isFetching ? 'Searching…' : results.error ? 'Search is unavailable' : 'No matching users'}</li>
          ) : (
            options.map((u, i) => (
              <li
                key={u.id}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(u)}
                className={clsx('flex cursor-pointer items-center gap-2.5 rounded-ui-sm px-2.5 py-1.5', i === active && 'bg-muted')}
              >
                <Avatar name={u.name} email={u.email} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{u.name || u.email}</span>
                  {u.name && <span className="block truncate text-xs text-muted-foreground">{u.email}</span>}
                </span>
                {u.status && u.status !== 'active' && <Badge>{u.status}</Badge>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** A picked user shown as a removable chip. */
export function UserChip({ user, onRemove }: { user: PickedUser; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-surface py-0.5 pl-1 pr-2 text-sm">
      <Avatar name={user.name} email={user.email} size="sm" />
      <span className="truncate">{user.name || user.email}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${user.email}`}>
          <X className="size-3.5" />
        </button>
      )}
    </span>
  );
}
