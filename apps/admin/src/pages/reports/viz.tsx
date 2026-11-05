import { useState } from 'react';
import clsx from 'clsx';
import type { Point } from '../../components/ui';

/**
 * Chart helpers shared by Reports and Usage. They follow the same spec as the
 * kit's charts: one series colour (--series-1), bars at most 24px thick with a
 * 4px rounded data-end and a square baseline, text in text tokens, values at
 * the bar tip, a hover/focus highlight, and a table twin rendered by the page.
 */

export const RANGE_PRESETS = [
  { days: 7, label: '7D', name: 'Last 7 days' },
  { days: 30, label: '30D', name: 'Last 30 days' },
  { days: 90, label: '90D', name: 'Last 90 days' },
  { days: 365, label: '12M', name: 'Last 12 months' },
];

/** Segmented control for date-range presets; sits in the single filter row above the charts. */
export function RangePresets({ days, onChange, custom, onCustom }: { days: number | null; onChange: (d: number) => void; custom?: boolean; onCustom?: () => void }) {
  return (
    <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-ui-sm border bg-surface p-0.5 shadow-ui">
      {RANGE_PRESETS.map((r) => (
        <button
          key={r.days}
          type="button"
          role="radio"
          aria-checked={!custom && days === r.days}
          title={r.name}
          onClick={() => onChange(r.days)}
          className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-1 text-sm font-medium tabular transition-colors', !custom && days === r.days ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {r.label}
        </button>
      ))}
      {onCustom && (
        <button
          type="button"
          role="radio"
          aria-checked={Boolean(custom)}
          onClick={onCustom}
          className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-1 text-sm font-medium transition-colors', custom ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          Custom
        </button>
      )}
    </div>
  );
}

const DAY = 86_400_000;

/** Daily points from `from` (inclusive) to `to` (exclusive), zero-filled where no row exists (flows, not levels). */
export function fillDays(rows: { day: string; value: number }[], from: Date, to: Date): Point[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const key = r.day.slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(r.value));
  }
  const out: Point[] = [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let t = start; t < to.getTime(); t += DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push({ date: key, value: byDay.get(key) ?? 0 });
  }
  return out;
}

/**
 * Horizontal bars for categorical comparisons (revenue by product, MRR by
 * plan). Negative values extend left of a shared baseline.
 */
export function CategoryBars({ rows, format, label, max = 15 }: { rows: { label: string; value: number }[]; format: (v: number) => string; label: string; max?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const shown = rows.slice(0, max);
  const hi = Math.max(0, ...shown.map((r) => r.value));
  const lo = Math.min(0, ...shown.map((r) => r.value));
  const span = hi - lo || 1;
  const zero = (-lo / span) * 100; // baseline position, % from the left
  return (
    <figure className="px-2 py-1">
      <ul role="list" aria-label={label} className="space-y-2" onMouseLeave={() => setActive(null)}>
        {shown.map((r, i) => {
          const width = (Math.abs(r.value) / span) * 100;
          const negative = r.value < 0;
          return (
            <li
              key={`${r.label}-${i}`}
              tabIndex={0}
              aria-label={`${r.label}: ${format(r.value)}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="grid grid-cols-[minmax(5rem,32%)_1fr] items-center gap-3 rounded-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span className="truncate text-xs text-muted-foreground" title={r.label}>
                {r.label}
              </span>
              {/* The margins keep room for the value label beyond the longest bar, so it is never clipped. */}
              <span className="relative block h-6" style={{ marginRight: hi > 0 ? '6.5rem' : 0, marginLeft: lo < 0 ? '6.5rem' : 0 }}>
                {lo < 0 && <span className="absolute inset-y-0 w-px bg-[var(--chart-axis)]" style={{ left: `${zero}%` }} aria-hidden="true" />}
                <span
                  className="absolute top-1 h-4 transition-opacity"
                  style={{
                    left: negative ? `${zero - width}%` : `${zero}%`,
                    width: `max(${width}%, ${r.value === 0 ? 0 : 2}px)`,
                    background: 'var(--series-1)',
                    borderRadius: negative ? '4px 0 0 4px' : '0 4px 4px 0',
                    opacity: active === null || active === i ? 1 : 0.55,
                  }}
                  aria-hidden="true"
                />
                <span
                  className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-xs font-medium tabular text-foreground"
                  style={negative ? { right: `calc(${100 - (zero - width)}% + 6px)` } : { left: `calc(${zero + width}% + 6px)` }}
                >
                  {format(r.value)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {rows.length > max && <figcaption className="mt-2 text-xs text-muted-foreground">Showing the first {max} of {rows.length}; the table below lists all.</figcaption>}
    </figure>
  );
}
