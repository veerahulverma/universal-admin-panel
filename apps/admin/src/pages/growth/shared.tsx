import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Smartphone } from 'lucide-react';
import clsx from 'clsx';
import { api, type Page } from '../../lib/api';
import { useBootstrap } from '../../components/layout/AppShell';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced } from '../../lib/hooks';
import { money } from '../../lib/format';
import type { JsonSchema } from '../../components/SchemaForm';
import { Avatar, Badge, Button, SearchInput, Spinner, StatusBadge, type Tone } from '../../components/ui';

/** Tabs kept in the URL (?tab=...) so links and the back button work; switching tabs clears the other tab's filters. */
export function useTabParam(defaultTab: string): [string, (tab: string) => void] {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? defaultTab;
  const setTab = (next: string) => setParams(next === defaultTab ? new URLSearchParams() : new URLSearchParams({ tab: next }), { replace: true });
  return [tab, setTab];
}

/** Statuses the shared StatusBadge does not know (email, commissions, campaign recipients). */
const EXTRA_TONES: Record<string, Tone> = {
  sending: 'info',
  queued: 'info',
  complained: 'danger',
  bounced: 'danger',
  reversed: 'warning',
  converted: 'success',
  skipped: 'neutral',
};

export function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const tone = EXTRA_TONES[status];
  if (!tone) return <StatusBadge status={status} />;
  return (
    <Badge tone={tone} dot>
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

export interface Amount {
  currency: string;
  amount: number;
}

/** `{ USD: 1200, EUR: 500 }` -> `[{ currency, amount }]` */
export function amountsFromMap(map: Record<string, number | string> | null | undefined): Amount[] {
  return Object.entries(map ?? {}).map(([currency, amount]) => ({ currency, amount: Number(amount) }));
}

/** Amounts in several currencies are never added together; each is shown in its own currency. */
export function MoneyList({ items, empty = '—', className }: { items: Amount[]; empty?: ReactNode; className?: string }) {
  const shown = items.filter((i) => i.amount !== 0);
  if (!shown.length) return <span className="text-muted-foreground">{empty}</span>;
  return <span className={clsx('tabular whitespace-nowrap', className)}>{shown.map((i) => money(i.amount, i.currency)).join(' · ')}</span>;
}

/** Why an address did not receive an email (consent and suppression reasons). */
export const DELIVERY_REASONS: Record<string, string> = {
  no_consent: 'No marketing consent',
  unsubscribed: 'Unsubscribed from this category',
  inactive_recipient: 'Account deleted or banned',
  hard_bounce: 'Address bounced (suppressed)',
  complaint: 'Marked as spam (suppressed)',
  unsubscribe: 'Unsubscribed (suppressed)',
  manual: 'Suppressed by an administrator',
  template_not_found: 'Template missing',
  render_error: 'Template could not be rendered',
};

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return '—';
  return DELIVERY_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

/**
 * Rendered email HTML. It runs in a sandboxed iframe with an opaque origin (no
 * scripts, forms, popups or navigation of this page), so template markup never
 * touches the admin DOM.
 */
export function HtmlPreview({ html, title = 'Email preview', height = 520 }: { html: string; title?: string; height?: number }) {
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop');
  // Links open nowhere: popups are blocked by the sandbox, so <base target> keeps clicks inside harmlessly.
  const doc = `<base target="_blank">${html}`;
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <div role="radiogroup" aria-label="Preview width" className="inline-flex rounded-ui-sm border bg-surface p-0.5">
          {(
            [
              ['desktop', 'Desktop', Monitor],
              ['mobile', 'Phone', Smartphone],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={clsx('inline-flex items-center gap-1 rounded-[calc(var(--radius)-3px)] px-2 py-1 text-xs font-medium', mode === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-center overflow-hidden rounded-ui border bg-muted/40 p-2">
        <iframe title={title} sandbox="" srcDoc={doc} style={{ height }} className={clsx('rounded-ui-sm border bg-white transition-[width]', mode === 'mobile' ? 'w-[375px] max-w-full' : 'w-full')} />
      </div>
    </div>
  );
}

/** Search-as-you-type user selection (for manual referral credit). */
export function UserPicker({ value, onChange }: { value: { id: string; email: string; name?: string | null } | null; onChange: (u: { id: string; email: string; name?: string | null } | null) => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const results = useQuery({
    queryKey: ['user-picker', term],
    queryFn: ({ signal }) => api.get<Page<{ id: string; email: string; name: string | null }>>('/api/admin/users', { q: term, pageSize: 6 }, signal),
    enabled: term.length >= 2,
  });
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-ui-sm border px-3 py-2">
        <Avatar name={value.name} email={value.email} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm">{value.name ? `${value.name} · ${value.email}` : value.email}</span>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <SearchInput value={q} onChange={setQ} placeholder="Search customers by name or email" />
      {term.length >= 2 && (
        <ul className="max-h-56 overflow-y-auto rounded-ui-sm border" aria-label="Matching customers">
          {results.isLoading && (
            <li className="flex justify-center p-3">
              <Spinner />
            </li>
          )}
          {results.data?.data.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matching customers.</li>}
          {results.data?.data.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => onChange(u)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
                <Avatar name={u.name} email={u.email} size="sm" />
                <span className="min-w-0 truncate">{u.name ? `${u.name} · ${u.email}` : u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Settings sections ------------------------------------------------------------------

export interface SettingsSection {
  key: string;
  module: string;
  label: string;
  description: string | null;
  schema: JsonSchema;
  defaults: Record<string, unknown>;
  value: Record<string, unknown>;
}

/** One settings section (affiliate program, email defaults...). Reading settings needs system.settings.view. */
export function useSettingsSection(key: string) {
  const { can } = useAuth();
  const allowed = can('system.settings.view');
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ data: SettingsSection[] }>('/api/admin/settings'), enabled: allowed, staleTime: 30_000 });
  return { ...query, allowed, section: query.data?.data.find((s) => s.key === key) ?? null };
}

export function useSaveSettings(key: string, opts: { onError?: (err: unknown) => void; onSuccess?: () => void } = {}) {
  return useAction((value: Record<string, unknown>) => api.patch(`/api/admin/settings/${key}`, value), {
    success: 'Settings saved',
    invalidate: [['settings']],
    onError: opts.onError,
    onSuccess: opts.onSuccess,
  });
}

/** Base currency for revenue figures (billing settings when readable, else the console default). */
export function useBaseCurrency(): string {
  const boot = useBootstrap();
  const billing = useSettingsSection('billing');
  return String(billing.section?.value.baseCurrency ?? boot.data?.locale.currency ?? 'USD');
}

// ---- Periods ---------------------------------------------------------------------------------

export const PERIODS = [
  { days: 7, label: '7D', name: 'Last 7 days' },
  { days: 30, label: '30D', name: 'Last 30 days' },
  { days: 90, label: '90D', name: 'Last 90 days' },
];

export function PeriodPicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Period" className="inline-flex rounded-ui-sm border bg-surface p-0.5 shadow-ui">
      {PERIODS.map((p) => (
        <button
          key={p.days}
          type="button"
          role="radio"
          aria-checked={days === p.days}
          title={p.name}
          onClick={() => onChange(p.days)}
          className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-1 text-sm font-medium tabular transition-colors', days === p.days ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** Date -> value for <input type="datetime-local"> in the viewer's time zone. */
export function toLocalInput(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Server days ("2026-10-04T00:00:00.000Z") -> chart dates ("2026-10-04"). */
export const dayKey = (value: string) => String(value).slice(0, 10);
