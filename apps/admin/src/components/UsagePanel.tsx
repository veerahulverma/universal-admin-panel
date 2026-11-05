import clsx from 'clsx';
import { dateTime, num } from '../lib/format';
import { Badge, EmptyState } from './ui';

export interface MeterUsage {
  meter: string;
  name: string;
  unit: string | null;
  kind: string;
  feature: string | null;
  used: number;
  reserved: number;
  limit: number | null;
  unlimited: boolean;
  remaining: number | null;
  overage: number;
  enforcement: string | null;
  resetPeriod: string | null;
  periodStart: string;
  periodEnd: string | null;
  forecast: { projected: number; limitReachedAt: string | null } | null;
}

/** Quota meters as labelled bars: used / limit, with reservations, overage and the forecast. */
export function UsageMeters({ meters }: { meters: MeterUsage[] }) {
  if (!meters.length) return <EmptyState title="No metered usage" description="Meters appear once usage is recorded or a plan grants a quota." />;
  return (
    <ul className="space-y-4">
      {meters.map((m) => {
        const ratio = m.limit && m.limit > 0 ? Math.min(1, (m.used + m.reserved) / m.limit) : 0;
        const over = m.limit !== null && m.used > m.limit;
        const warn = !over && ratio >= 0.8;
        const unit = m.unit ? ` ${m.unit}` : '';
        return (
          <li key={m.meter}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium">
                {m.name} <span className="font-mono text-xs text-muted-foreground">{m.meter}</span>
              </p>
              <p className="text-sm tabular">
                <span className="font-semibold">{num(m.used)}</span>
                {m.unlimited ? <span className="text-muted-foreground"> used · unlimited</span> : m.limit !== null ? <span className="text-muted-foreground"> / {num(m.limit)}{unit}</span> : <span className="text-muted-foreground">{unit}</span>}
              </p>
            </div>
            {m.limit !== null && !m.unlimited && (
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={m.limit} aria-valuenow={m.used} aria-label={`${m.name} usage`}>
                <div className={clsx('h-full rounded-full', over ? 'bg-danger' : warn ? 'bg-warning' : 'bg-primary')} style={{ width: `${Math.max(ratio * 100, m.used > 0 ? 1.5 : 0)}%` }} />
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {m.resetPeriod && m.resetPeriod !== 'none' && <span>Resets {m.periodEnd ? dateTime(m.periodEnd) : m.resetPeriod}</span>}
              {m.reserved > 0 && <span>{num(m.reserved)} reserved</span>}
              {m.overage > 0 && <Badge tone="warning">{num(m.overage)} overage</Badge>}
              {m.enforcement && <span>{m.enforcement} limit</span>}
              {m.forecast?.limitReachedAt && <Badge tone="warning">Limit expected {dateTime(m.forecast.limitReachedAt)}</Badge>}
              {m.forecast && !m.forecast.limitReachedAt && m.forecast.projected > 0 && <span>Projected {num(Math.round(m.forecast.projected))} this period</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
