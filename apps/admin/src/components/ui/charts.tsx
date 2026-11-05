import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, Table2, ChartColumn } from 'lucide-react';
import clsx from 'clsx';

/**
 * Charts follow a fixed spec: thin marks (columns <= 24px with 4px rounded
 * data-ends, 2px lines), hairline recessive grid, a 2px surface gap between
 * adjacent bars, >= 8px end markers with a 2px surface ring, a hover/keyboard
 * layer, and a table view so no value is gated behind hover.
 */

export interface Point {
  date: string;
  value: number;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Clean axis ticks: 0 plus ~4 round steps covering the max. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return `${+n.toFixed(2)}`;
}

const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

interface ChartProps {
  data: Point[];
  height?: number;
  /** Format a value for tooltips/labels (e.g. money). */
  format?: (v: number) => string;
  /** Format axis ticks (defaults to compact numbers). */
  tickFormat?: (v: number) => string;
  label: string;
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), width - 70);
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-ui-sm border bg-surface px-2.5 py-1.5 text-xs shadow-lg" style={{ left, top: y - 8 }}>
      {children}
    </div>
  );
}

const PAD = { top: 12, right: 12, bottom: 24 };

/** Room for the widest y-axis label (11px tabular figures, about 6.6px each) plus the gap to the plot. */
function leftPad(ticks: number[], format: (v: number) => string): number {
  const longest = Math.max(...ticks.map((t) => format(t).length));
  return Math.max(28, Math.ceil(longest * 7.2) + 12);
}

export function ColumnChart({ data, height = 220, format = compact, tickFormat = compact, label }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const empty = data.every((d) => d.value === 0);
  const ticks = niceTicks(max);
  const padL = leftPad(ticks, tickFormat);
  const top = ticks[ticks.length - 1] || 1;
  const innerW = Math.max(0, width - padL - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const band = data.length ? innerW / data.length : 0;
  const barW = Math.max(1, Math.min(24, band - 2)); // 2px surface gap between adjacent bars
  const y = (v: number) => PAD.top + innerH - (Math.max(0, v) / top) * innerH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 64))));

  const onKey = (e: React.KeyboardEvent) => {
    if (!data.length) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min(data.length - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? data.length) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {empty && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No data in this period</p>}
      {width > 0 && !empty && (
        <svg width={width} height={height} role="img" aria-label={`${label}. Use left and right arrow keys to read values.`} tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)} onMouseLeave={() => setActive(null)} className="outline-none focus-visible:outline-2 focus-visible:outline-primary rounded">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--chart-muted)" className="tabular">
                {tickFormat(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + band * i + band / 2;
            const h = Math.max(0, y(0) - y(d.value));
            const r = Math.min(4, barW / 2, h);
            const x0 = cx - barW / 2;
            const yTop = y(d.value);
            // Rounded data-end, square at the baseline.
            const path = h <= 0 ? '' : `M${x0},${y(0)} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${y(0)} Z`;
            return (
              <g key={d.date} onMouseEnter={() => setActive(i)}>
                <rect x={padL + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" />
                {path && <path d={path} fill="var(--series-1)" opacity={active === null || active === i ? 1 : 0.55} />}
                {i % labelEvery === 0 && (
                  <text x={cx} y={height - 6} textAnchor="middle" fontSize={12} fill="var(--chart-muted)">
                    {shortDate(d.date)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {active !== null && data[active] && (
        <Tooltip x={padL + band * active + band / 2} y={y(data[active].value)} width={width}>
          <div className="font-semibold tabular">{format(data[active].value)}</div>
          <div className="text-muted-foreground">{shortDate(data[active].date)}</div>
        </Tooltip>
      )}
    </div>
  );
}

export function LineChart({ data, height = 220, format = compact, tickFormat = compact, label }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const empty = data.every((d) => d.value === 0);
  const ticks = niceTicks(max);
  const padL = leftPad(ticks, tickFormat);
  const top = ticks[ticks.length - 1] || 1;
  const innerW = Math.max(0, width - padL - PAD.right - 8);
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => padL + (data.length <= 1 ? innerW / 2 : (innerW * i) / (data.length - 1));
  const y = (v: number) => PAD.top + innerH - (Math.max(0, v) / top) * innerH;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const area = data.length ? `${line} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)} Z` : '';
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 64))));
  const last = data.length - 1;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!data.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const idx = Math.round(((px - padL) / Math.max(1, innerW)) * (data.length - 1));
    setActive(Math.min(data.length - 1, Math.max(0, idx)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(last, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? data.length) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {empty && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No data in this period</p>}
      {width > 0 && !empty && (
        <svg width={width} height={height} role="img" aria-label={`${label}. Use left and right arrow keys to read values.`} tabIndex={0} onMouseMove={onMove} onMouseLeave={() => setActive(null)} onKeyDown={onKey} onBlur={() => setActive(null)} className="outline-none focus-visible:outline-2 focus-visible:outline-primary rounded">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--chart-muted)" className="tabular">
                {tickFormat(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % labelEvery === 0 ? (
              <text key={d.date} x={x(i)} y={height - 6} textAnchor="middle" fontSize={12} fill="var(--chart-muted)">
                {shortDate(d.date)}
              </text>
            ) : null,
          )}
          {area && <path d={area} fill="var(--series-1)" opacity={0.1} />}
          {line && <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {active !== null && <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={y(0)} stroke="var(--chart-axis)" strokeWidth={1} />}
          {data.length > 0 && (
            <circle cx={x(active ?? last)} cy={y(data[active ?? last].value)} r={4} fill="var(--series-1)" stroke="var(--color-surface)" strokeWidth={2} />
          )}
        </svg>
      )}
      {active !== null && data[active] && (
        <Tooltip x={x(active)} y={y(data[active].value)} width={width}>
          <div className="font-semibold tabular">{format(data[active].value)}</div>
          <div className="text-muted-foreground">{shortDate(data[active].date)}</div>
        </Tooltip>
      )}
    </div>
  );
}

export function Sparkline({ values, height = 28, width = 96 }: { values: number[]; height?: number; width?: number }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--chart-muted)" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}

/** Stat tile: label, value, delta vs the previous period (colour = direction × whether up is good), optional trend. */
export function KpiTile({ label, value, previous, display, upIsGood = true, trend, hint }: { label: string; value: number; previous?: number | null; display: string; upIsGood?: boolean; trend?: number[]; hint?: string }) {
  let delta: ReactNode = null;
  if (previous !== null && previous !== undefined) {
    const diff = value - previous;
    const ratio = previous === 0 ? (value === 0 ? 0 : null) : diff / Math.abs(previous);
    const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    const good = dir === 'flat' ? null : (dir === 'up') === upIsGood;
    const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus;
    delta = (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium tabular" style={{ color: good === null ? 'var(--chart-muted)' : good ? 'var(--delta-up)' : 'var(--delta-down)' }}>
        <Icon className="size-3.5" aria-hidden="true" />
        {ratio === null ? 'new' : dir === 'flat' ? 'no change' : `${dir === 'down' ? '' : '+'}${(ratio * 100).toFixed(1)}%`}
        <span className="sr-only">{good === null ? 'unchanged' : good ? 'better than' : 'worse than'} the previous period</span>
      </span>
    );
  }
  return (
    <div className="flex min-w-0 flex-col justify-between rounded-ui border bg-surface p-4 shadow-ui">
      <p className="truncate text-sm text-muted-foreground">{label}</p>
      <p className="mt-1.5 whitespace-nowrap text-2xl font-semibold tracking-tight tabular">{display}</p>
      <div className="mt-1.5 flex min-h-7 items-end justify-between gap-2">
        <div className="min-w-0">
          {delta}
          {(delta || hint) && <p className="truncate text-xs text-muted-foreground">{hint ?? 'vs prior period'}</p>}
        </div>
        {trend && <Sparkline values={trend} width={72} />}
      </div>
    </div>
  );
}

/** Wraps a chart with a title and a chart/table toggle (the table keeps every value reachable without hover). */
export function ChartCard({ title, description, data, children, format = compact, fetching, actions }: { title: string; description?: string; data: Point[]; children: ReactNode; format?: (v: number) => string; fetching?: boolean; actions?: ReactNode }) {
  const [table, setTable] = useState(false);
  const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);
  return (
    <section className="rounded-ui border bg-surface shadow-ui">
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          <button type="button" onClick={() => setTable((t) => !t)} className="inline-flex items-center gap-1 rounded-ui-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" aria-pressed={table}>
            {table ? <ChartColumn className="size-3.5" /> : <Table2 className="size-3.5" />}
            {table ? 'Chart' : 'Table'}
          </button>
        </div>
      </header>
      <div className={clsx('px-2 pb-2 pt-1 transition-opacity', fetching && 'opacity-60')}>
        {table ? (
          <div className="max-h-[220px] overflow-y-auto px-2">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-2xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1.5 font-medium">Date</th>
                  <th className="py-1.5 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {data.map((d) => (
                  <tr key={d.date} className="border-t">
                    <td className="py-1">{shortDate(d.date)}</td>
                    <td className="py-1 text-right">{format(d.value)}</td>
                  </tr>
                ))}
                <tr className="border-t font-medium">
                  <td className="py-1">Total</td>
                  <td className="py-1 text-right">{format(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
