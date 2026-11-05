import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Field, FormError, Input, Select, Switch } from '../../components/ui';
import { ENFORCEMENT_OPTIONS, FEATURE_TYPE_LABEL, MoneyInput, RESET_OPTIONS, useCurrencies, useFeatures, useFormErrors, type Enforcement, type ProductDetail, type ProductFeatureRow, type ResetPeriod } from './shared';

interface Row {
  featureKey: string;
  name: string;
  type: ProductFeatureRow['type'];
  unit: string | null;
  enabled: boolean;
  limit: string;
  unlimited: boolean;
  resetPeriod: ResetPeriod;
  rollingHours: string;
  enforcement: Enforcement;
  warnAtPercent: string;
  graceUnits: string;
  overageUnitAmount: number | null;
  perSeat: boolean;
  config: string;
}

function toRow(f: ProductFeatureRow): Row {
  return {
    featureKey: f.key,
    name: f.name,
    type: f.type,
    unit: f.unit,
    enabled: f.enabled,
    limit: f.limit_value === null ? '' : String(f.limit_value),
    unlimited: f.unlimited,
    resetPeriod: f.reset_period,
    rollingHours: f.rolling_window_seconds ? String(Math.round((f.rolling_window_seconds / 3600) * 100) / 100) : '24',
    enforcement: f.enforcement,
    warnAtPercent: String(f.warn_at_percent),
    graceUnits: String(f.grace_units),
    overageUnitAmount: f.overage_unit_amount,
    perSeat: f.per_seat,
    config: f.config_value === null || f.config_value === undefined ? '' : typeof f.config_value === 'string' ? f.config_value : JSON.stringify(f.config_value),
  };
}

/** Config values: JSON when it parses (numbers, booleans, objects), otherwise a plain string. */
function parseConfig(text: string): unknown {
  const t = text.trim();
  if (t === '') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function toBody(r: Row) {
  const base = { featureKey: r.featureKey, enabled: r.enabled };
  if (r.type === 'boolean') return base;
  if (r.type === 'config') return { ...base, config: parseConfig(r.config) };
  return {
    ...base,
    unlimited: r.unlimited,
    limit: r.unlimited || r.limit.trim() === '' ? null : Math.trunc(Number(r.limit)),
    resetPeriod: r.resetPeriod,
    rollingWindowSeconds: r.resetPeriod === 'rolling' ? Math.round(Number(r.rollingHours) * 3600) || null : null,
    enforcement: r.enforcement,
    warnAtPercent: Math.min(100, Math.max(1, Math.trunc(Number(r.warnAtPercent)) || 80)),
    graceUnits: Math.max(0, Math.trunc(Number(r.graceUnits)) || 0),
    overageUnitAmount: r.enforcement === 'overage' ? r.overageUnitAmount : null,
    perSeat: r.perSeat,
  };
}

/**
 * Which features a product unlocks and the limits that apply. The server
 * replaces the whole set on save, so edits are made locally and saved together.
 */
export function FeatureLimitsEditor({ product }: { product: ProductDetail }) {
  const { can } = useAuth();
  const editable = can('catalog.products.manage');
  const features = useFeatures();
  const { base } = useCurrencies();
  const original = useMemo(() => product.features.map(toRow), [product.features]);
  const [rows, setRows] = useState<Row[]>(original);
  const [adding, setAdding] = useState('');
  const errors = useFormErrors();
  const dirty = JSON.stringify(rows.map(toBody)) !== JSON.stringify(original.map(toBody));

  // New server data (after a save, or another admin's change) replaces the local edits; a refetch of identical data does not.
  const serverKey = JSON.stringify(product.features);
  const [synced, setSynced] = useState(serverKey);
  if (synced !== serverKey) {
    setSynced(serverKey);
    setRows(product.features.map(toRow));
  }

  const save = useAction(() => api.put(`/api/admin/products/${product.id}/features`, { features: rows.map(toBody) }), {
    success: 'Features and limits saved',
    invalidate: [['product', product.id], ['products'], ['features']],
    onError: (err) => errors.set(err, ['features']),
  });

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const available = (features.data?.data ?? []).filter((f) => !rows.some((r) => r.featureKey === f.key));
  const rowError = (i: number) => Object.entries(errors.fields).find(([k]) => k.startsWith(`features.${i}.`) || k === `features.${i}`)?.[1];

  const add = (key: string) => {
    const f = features.data?.data.find((x) => x.key === key);
    if (!f) return;
    setRows((rs) => [
      ...rs,
      {
        featureKey: f.key,
        name: f.name,
        type: f.type,
        unit: f.unit,
        enabled: true,
        limit: '',
        unlimited: false,
        resetPeriod: 'month',
        rollingHours: '24',
        enforcement: 'hard',
        warnAtPercent: '80',
        graceUnits: '0',
        overageUnitAmount: null,
        perSeat: false,
        config: '',
      },
    ]);
    setAdding('');
  };

  return (
    <div className="space-y-4">
      <FormError message={errors.general} />
      {rows.length === 0 ? (
        <Card>
          <EmptyState title="No features yet" description="Add the features this product unlocks: on/off capabilities, quotas on usage meters, or configuration values." />
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {rows.map((r, i) => {
            const err = rowError(i);
            return (
              <section key={r.featureKey} className={clsx('rounded-ui border bg-surface shadow-ui', !r.enabled && 'opacity-75', err && 'border-danger/50')} aria-label={r.name}>
                <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {r.name}
                      <Badge>{FEATURE_TYPE_LABEL[r.type]}</Badge>
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">{r.featureKey}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch checked={r.enabled} onCheckedChange={(v) => update(i, { enabled: v })} disabled={!editable} label={<span className="sr-only">Included in {r.name}</span>} />
                    {editable && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${r.name}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </header>
                <div className="space-y-3 p-4">
                  {err && <p className="text-xs text-danger">{err}</p>}
                  {r.type === 'boolean' && <p className="text-sm text-muted-foreground">{r.enabled ? 'Included in this product.' : 'Listed, but turned off for this product.'}</p>}
                  {r.type === 'config' && (
                    <Field label="Value" htmlFor={`cfg-${i}`} hint="Text, a number, true/false, or JSON">
                      <Input id={`cfg-${i}`} value={r.config} disabled={!editable} onChange={(e) => update(i, { config: e.target.value })} className="font-mono" />
                    </Field>
                  )}
                  {r.type === 'quota' && (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={`Limit${r.unit ? ` (${r.unit})` : ''}`} htmlFor={`lim-${i}`}>
                          <Input id={`lim-${i}`} type="number" min={0} value={r.unlimited ? '' : r.limit} placeholder={r.unlimited ? 'Unlimited' : undefined} disabled={!editable || r.unlimited} onChange={(e) => update(i, { limit: e.target.value })} />
                        </Field>
                        <div className="flex items-end pb-2">
                          <Checkbox checked={r.unlimited} disabled={!editable} onChange={(e) => update(i, { unlimited: e.target.checked })} label="Unlimited" />
                        </div>
                        <Field label="Resets" htmlFor={`reset-${i}`}>
                          <Select id={`reset-${i}`} value={r.resetPeriod} disabled={!editable} onChange={(e) => update(i, { resetPeriod: e.target.value as ResetPeriod })} options={RESET_OPTIONS} />
                        </Field>
                        {r.resetPeriod === 'rolling' && (
                          <Field label="Window (hours)" htmlFor={`win-${i}`}>
                            <Input id={`win-${i}`} type="number" min={0.02} step="any" value={r.rollingHours} disabled={!editable} onChange={(e) => update(i, { rollingHours: e.target.value })} />
                          </Field>
                        )}
                        <Field label="When the limit is reached" htmlFor={`enf-${i}`} hint={ENFORCEMENT_OPTIONS.find((o) => o.value === r.enforcement)?.hint}>
                          <Select id={`enf-${i}`} value={r.enforcement} disabled={!editable} onChange={(e) => update(i, { enforcement: e.target.value as Enforcement })} options={ENFORCEMENT_OPTIONS} />
                        </Field>
                        {r.enforcement === 'overage' && (
                          <Field label="Price per extra unit" htmlFor={`ovg-${i}`} hint="Charged in the subscription's currency">
                            <MoneyInput id={`ovg-${i}`} value={r.overageUnitAmount} currency={base} onChange={(v) => update(i, { overageUnitAmount: v })} />
                          </Field>
                        )}
                        <Field label="Warn at (%)" htmlFor={`warn-${i}`}>
                          <Input id={`warn-${i}`} type="number" min={1} max={100} value={r.warnAtPercent} disabled={!editable} onChange={(e) => update(i, { warnAtPercent: e.target.value })} />
                        </Field>
                        {r.enforcement === 'hard' && (
                          <Field label="Grace units" htmlFor={`grace-${i}`} hint="Allowed beyond a hard limit">
                            <Input id={`grace-${i}`} type="number" min={0} value={r.graceUnits} disabled={!editable} onChange={(e) => update(i, { graceUnits: e.target.value })} />
                          </Field>
                        )}
                      </div>
                      <Checkbox checked={r.perSeat} disabled={!editable} onChange={(e) => update(i, { perSeat: e.target.checked })} label="Per seat" description="Multiply the limit by the number of seats on the subscription." />
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Feature to add" className="w-auto min-w-56" value={adding} onChange={(e) => add(e.target.value)} placeholder={available.length ? 'Add a feature…' : 'All features added'} disabled={!available.length} options={available.map((f) => ({ value: f.key, label: `${f.name} (${FEATURE_TYPE_LABEL[f.type]})` }))} />
          <Link to="/catalog/features" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <Plus className="size-3.5" /> Define a new feature
          </Link>
        </div>
      )}

      {editable && dirty && (
        <div className="sticky bottom-3 z-10">
          <Callout
            tone="warning"
            title="Unsaved changes"
            action={
              <span className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => setRows(original)}>
                  Discard
                </Button>
                <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
                  Save features
                </Button>
              </span>
            }
          >
            Customers on this product get the new limits as soon as you save.
          </Callout>
        </div>
      )}
    </div>
  );
}
