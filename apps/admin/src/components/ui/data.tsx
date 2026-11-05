import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Tabs as RTabs } from 'radix-ui';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ChevronsUpDown, Copy } from 'lucide-react';
import clsx from 'clsx';
import { Button } from './button';
import { EmptyState, Skeleton } from './feedback';
import { Tip } from './overlay';
import { ago, dateTime, initials, money } from '../../lib/format';
import { pageTitle } from '../../lib/theme';

export function Card({ children, className, title, description, actions, padded = true }: { children?: ReactNode; className?: string; title?: ReactNode; description?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={clsx('rounded-ui border bg-surface shadow-ui', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'p-4')}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, breadcrumbs, meta, documentTitle }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumbs?: { label: string; to?: string }[]; meta?: ReactNode; documentTitle?: string }) {
  const tabTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  useEffect(() => {
    if (tabTitle) pageTitle(tabTitle);
  }, [tabTitle]);
  return (
    <div className="mb-5 space-y-2">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5" aria-hidden="true" />}
              {b.to ? (
                <Link to={b.to} className="hover:text-foreground">
                  {b.label}
                </Link>
              ) : (
                <span aria-current="page">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-md text-muted-foreground">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  info: 'bg-info/10 text-info',
  primary: 'bg-primary/10 text-primary',
};

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-5 whitespace-nowrap', toneClass[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  active: 'success', paid: 'success', succeeded: 'success', completed: 'success', processed: 'success', approved: 'success', executed: 'success', sent: 'success', delivered: 'success', resolved: 'success', won: 'success', ok: 'success', solved: 'success', verified: 'success', enabled: 'success',
  trialing: 'info', open: 'info', pending: 'info', scheduled: 'info', running: 'info', held: 'info', queued: 'info', draft: 'neutral', installed: 'neutral', inactive: 'neutral', archived: 'neutral', closed: 'neutral', expired: 'neutral', ignored: 'neutral', void: 'neutral', released: 'neutral', committed: 'success',
  past_due: 'warning', suspended: 'warning', partially_refunded: 'warning', degraded: 'warning', needs_response: 'warning', acknowledged: 'warning', paused: 'warning', on_hold: 'warning', unconfigured: 'warning', warning: 'warning', requires_approval: 'warning', unpaid: 'warning',
  canceled: 'neutral', cancelled: 'neutral', refunded: 'neutral', uncollectible: 'danger', failed: 'danger', banned: 'danger', dead: 'danger', error: 'danger', disputed: 'danger', lost: 'danger', rejected: 'danger', down: 'danger', critical: 'danger', bounced: 'danger', suppressed: 'danger', deleted: 'danger', incomplete: 'warning',
};

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return null;
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} className={className} dot>
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

export function Avatar({ name, email, src, size = 'md' }: { name?: string | null; email?: string | null; src?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const dim = { sm: 'size-6 text-2xs', md: 'size-8 text-xs', lg: 'size-12 text-base' }[size];
  if (src) return <img src={src} alt="" className={clsx(dim, 'shrink-0 rounded-full object-cover')} />;
  return (
    <span className={clsx(dim, 'inline-flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary')} aria-hidden="true">
      {initials(name, email)}
    </span>
  );
}

export function KeyValue({ items, columns = 2 }: { items: { label: ReactNode; value: ReactNode; hidden?: boolean }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-3', columns === 1 && 'grid-cols-1', columns === 2 && 'grid-cols-1 sm:grid-cols-2', columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
      {items
        .filter((i) => !i.hidden)
        .map((item, i) => (
          <div key={i} className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.label}</dt>
            <dd className="mt-0.5 break-words text-sm">{item.value ?? '—'}</dd>
          </div>
        ))}
    </dl>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tip content={done ? 'Copied' : label}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
      >
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </Tip>
  );
}

export function Mono({ children, copy }: { children: string | null | undefined; copy?: boolean }) {
  if (!children) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>
      {copy && <CopyButton value={children} />}
    </span>
  );
}

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={clsx('relative rounded-ui border bg-muted/50', className)}>
      <div className="absolute right-1.5 top-1.5">
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-3 pr-9 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return <CodeBlock code={JSON.stringify(value, null, 2)} className={className} />;
}

export function Money({ amount, currency, className }: { amount: number | null | undefined; currency?: string | null; className?: string }) {
  return <span className={clsx('tabular whitespace-nowrap', className)}>{money(amount, currency ?? 'USD')}</span>;
}

export function When({ value, relative = true }: { value: string | Date | null | undefined; relative?: boolean }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={new Date(value).toISOString()} title={dateTime(value)} className="whitespace-nowrap">
      {relative ? ago(value) : dateTime(value)}
    </time>
  );
}

export function Tabs({ tabs, value, onValueChange, className }: { tabs: { value: string; label: ReactNode; content: ReactNode; hidden?: boolean; count?: number }[]; value?: string; onValueChange?: (v: string) => void; className?: string }) {
  const visible = tabs.filter((t) => !t.hidden);
  return (
    <RTabs.Root value={value} defaultValue={value ? undefined : visible[0]?.value} onValueChange={onValueChange} className={className}>
      <RTabs.List className="mb-4 flex gap-1 overflow-x-auto border-b [scrollbar-width:none]" aria-label="Sections">
        {visible.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
          >
            {t.label}
            {t.count ? <span className="rounded-full bg-muted px-1.5 text-2xs tabular">{t.count}</span> : null}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {visible.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className="focus-visible:outline-none">
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

// ---- Data table ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
  className?: string;
  /** Hidden below the md breakpoint in table mode; shown in the mobile card. */
  priority?: 'primary' | 'secondary' | 'low';
  width?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  fetching?: boolean;
  empty?: ReactNode;
  sort?: string;
  order?: 'asc' | 'desc';
  onSort?: (key: string, order: 'asc' | 'desc') => void;
  rowHref?: (row: T) => string;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  caption?: string;
}

/**
 * Responsive table: a dense table on wider screens, stacked cards on phones
 * (no horizontal page scroll). Sorting and pagination are server-side.
 */
export function DataTable<T>({ columns, rows, rowKey, loading, fetching, empty, sort, order, onSort, rowHref, selectable, selected, onSelectedChange, caption }: DataTableProps<T>) {
  const all = rows ?? [];
  const allSelected = selectable && all.length > 0 && all.every((r) => selected?.has(rowKey(r)));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange?.(next);
  };
  const toggleAll = () => onSelectedChange?.(allSelected ? new Set() : new Set(all.map(rowKey)));

  if (loading) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (!all.length) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;

  const primary = columns.filter((c) => c.priority !== 'low');
  return (
    <div className={clsx('transition-opacity', fetching && 'opacity-60')}>
      <div className="relative hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              {selectable && (
                <th className="w-10 px-3 py-2.5">
                  <input type="checkbox" aria-label="Select all" checked={Boolean(allSelected)} onChange={toggleAll} className="size-4 accent-[var(--color-primary)]" />
                </th>
              )}
              {columns.map((c) => {
                const active = sort === c.key;
                return (
                  <th key={c.key} style={c.width ? { width: c.width } : undefined} className={clsx('px-3 py-2.5 font-medium whitespace-nowrap', c.align === 'right' && 'text-right', c.priority === 'low' && 'hidden xl:table-cell')} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sortable && onSort ? (
                      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-foreground" onClick={() => onSort(c.key, active && order === 'desc' ? 'asc' : 'desc')}>
                        {c.header}
                        {active ? order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-50" />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {all.map((row) => {
              const id = rowKey(row);
              const href = rowHref?.(row);
              return (
                <tr key={id} className={clsx('border-b last:border-0 hover:bg-muted/40', selected?.has(id) && 'bg-primary/5')}>
                  {selectable && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label="Select row" checked={Boolean(selected?.has(id))} onChange={() => toggle(id)} className="size-4 accent-[var(--color-primary)]" />
                    </td>
                  )}
                  {columns.map((c, i) => (
                    <td key={c.key} className={clsx('px-3 py-2 align-middle', c.align === 'right' && 'text-right', c.priority === 'low' && 'hidden xl:table-cell', c.className)}>
                      {href && i === 0 ? (
                        <Link to={href} className="font-medium hover:underline">
                          {c.cell(row)}
                        </Link>
                      ) : (
                        c.cell(row)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="divide-y md:hidden">
        {all.map((row) => {
          const id = rowKey(row);
          const href = rowHref?.(row);
          const [first, ...rest] = primary;
          const body = (
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="font-medium">{first?.cell(row)}</div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                {rest.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{c.header}</dt>
                    <dd className="truncate">{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
          return (
            <li key={id} className="flex items-start gap-3 px-4 py-3">
              {selectable && <input type="checkbox" aria-label="Select row" checked={Boolean(selected?.has(id))} onChange={() => toggle(id)} className="mt-1 size-4 accent-[var(--color-primary)]" />}
              {href ? (
                <Link to={href} className="flex min-w-0 flex-1 items-start gap-2">
                  {body}
                  <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-sm text-muted-foreground">
      <span className="tabular">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="size-4" />
        </Button>
        <span className="tabular px-1">
          {page} / {pages}
        </span>
        <Button variant="ghost" size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Filter bar: a single row of controls above the content it scopes. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('flex flex-wrap items-center gap-2 border-b p-3', className)}>{children}</div>;
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
