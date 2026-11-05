import { useState } from 'react';
import { Archive, Gauge, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, ToggleRight } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, FormError, Input, Menu, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, Toolbar, useConfirm } from '../../components/ui';
import { FEATURE_TYPE_LABEL, describeWeights, slugify, useFeatures, useFormErrors, useMeters, type Feature, type Meter } from './shared';

const TYPE_HELP: Record<Feature['type'], string> = {
  boolean: 'A capability that is on or off, such as SSO or custom domains.',
  quota: 'A limit on a usage meter, such as API calls per month or number of projects.',
  config: 'A value your application reads, such as a support tier or maximum file size.',
};

// ---- Feature dialog -------------------------------------------------------------------------

function FeatureDialog({ open, onOpenChange, feature, meters }: { open: boolean; onOpenChange: (o: boolean) => void; feature?: Feature; meters: Meter[] }) {
  const editing = Boolean(feature);
  const [name, setName] = useState(feature?.name ?? '');
  const [key, setKey] = useState(feature?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(editing);
  const [description, setDescription] = useState(feature?.description ?? '');
  const [type, setType] = useState<Feature['type']>(feature?.type ?? 'boolean');
  const [meterKey, setMeterKey] = useState('');
  const [unit, setUnit] = useState(feature?.unit ?? '');
  const errors = useFormErrors();
  const free = meters.filter((m) => !m.feature_key && !m.archived);
  const save = useAction(
    () =>
      editing
        ? api.patch(`/api/admin/features/${feature!.id}`, { name, description, unit: unit || undefined })
        : api.post('/api/admin/features', { key, name, description, type, meterKey: type === 'quota' ? meterKey : undefined, unit: unit || undefined }),
    {
      success: editing ? 'Feature updated' : 'Feature created',
      invalidate: [['features'], ['meters']],
      onSuccess: () => onOpenChange(false),
      onError: (err) => errors.set(err, ['key', 'name', 'meterKey', 'unit']),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${feature!.name}` : 'New feature'}
      description={editing ? 'The key and type are fixed once products use the feature.' : 'Features are what plans unlock. Assign them to products with limits on the product page.'}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="feature-form" loading={save.isPending}>
            {editing ? 'Save' : 'Create feature'}
          </Button>
        </>
      }
    >
      <form
        id="feature-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          save.mutate();
        }}
      >
        <FormError message={errors.general} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="ft-name" error={errors.fields.name} required>
            <Input
              id="ft-name"
              value={name}
              required
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Key" htmlFor="ft-key" error={errors.fields.key} required hint={editing ? undefined : 'Your application checks entitlements by this key'}>
            <Input
              id="ft-key"
              value={key}
              disabled={editing}
              className="font-mono"
              required
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
          </Field>
        </div>
        {!editing && (
          <Field label="Type" htmlFor="ft-type" hint={TYPE_HELP[type]}>
            <Select id="ft-type" value={type} onChange={(e) => setType(e.target.value as Feature['type'])} options={(['boolean', 'quota', 'config'] as const).map((t) => ({ value: t, label: FEATURE_TYPE_LABEL[t] }))} />
          </Field>
        )}
        {!editing && type === 'quota' && (
          <Field label="Meter" htmlFor="ft-meter" error={errors.fields.meterKey} required hint={free.length ? 'Each meter can be limited by one feature.' : 'Every meter already has a feature. Create a meter first.'}>
            <Select id="ft-meter" value={meterKey} onChange={(e) => setMeterKey(e.target.value)} placeholder="Choose a meter" options={free.map((m) => ({ value: m.key, label: `${m.name} (${m.unit})` }))} required />
          </Field>
        )}
        {(type !== 'boolean' || editing) && (
          <Field label="Unit" htmlFor="ft-unit" hint="Shown next to limits, e.g. calls or GB" error={errors.fields.unit}>
            <Input id="ft-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </Field>
        )}
        <Field label="Description" htmlFor="ft-desc">
          <Textarea id="ft-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

// ---- Meter dialog ---------------------------------------------------------------------------

interface WeightRow {
  dimension: string;
  value: string;
  weight: string;
}

function weightRows(weights: Meter['weights'] | undefined): WeightRow[] {
  return Object.entries(weights ?? {}).flatMap(([dimension, values]) => Object.entries(values).map(([value, weight]) => ({ dimension, value, weight: String(weight) })));
}

function MeterDialog({ open, onOpenChange, meter }: { open: boolean; onOpenChange: (o: boolean) => void; meter?: Meter }) {
  const editing = Boolean(meter);
  const [name, setName] = useState(meter?.name ?? '');
  const [key, setKey] = useState(meter?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(editing);
  const [description, setDescription] = useState(meter?.description ?? '');
  const [unit, setUnit] = useState(meter?.unit ?? 'units');
  const [kind, setKind] = useState<Meter['kind']>(meter?.kind ?? 'counter');
  const [weights, setWeights] = useState<WeightRow[]>(weightRows(meter?.weights));
  const [credits, setCredits] = useState(Boolean(meter?.credit_type));
  const [creditType, setCreditType] = useState(meter?.credit_type ?? 'credits');
  const [creditsPerUnit, setCreditsPerUnit] = useState(meter?.credits_per_unit ? String(meter.credits_per_unit) : '1');
  const errors = useFormErrors();

  const weightMap = () => {
    const out: Meter['weights'] = {};
    for (const w of weights) {
      if (!w.dimension.trim() || !w.value.trim() || !(Number(w.weight) > 0)) continue;
      (out[w.dimension.trim()] ??= {})[w.value.trim()] = Number(w.weight);
    }
    return out;
  };
  const body = () => ({
    name,
    description,
    unit: unit || 'units',
    weights: weightMap(),
    creditType: credits ? creditType : null,
    creditsPerUnit: credits ? Number(creditsPerUnit) : null,
  });
  const save = useAction(() => (editing ? api.patch(`/api/admin/meters/${meter!.id}`, body()) : api.post('/api/admin/meters', { key, kind, ...body() })), {
    success: editing ? 'Meter updated' : 'Meter created',
    invalidate: [['meters'], ['features']],
    onSuccess: () => onOpenChange(false),
    onError: (err) => errors.set(err, ['key', 'name', 'unit', 'creditsPerUnit', 'weights']),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${meter!.name}` : 'New meter'}
      description="A meter measures any resource your application consumes. Usage is recorded through the API or SDK and validated on the server."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="meter-form" loading={save.isPending}>
            {editing ? 'Save' : 'Create meter'}
          </Button>
        </>
      }
    >
      <form
        id="meter-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          save.mutate();
        }}
      >
        <FormError message={errors.general} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" htmlFor="mt-name" required error={errors.fields.name}>
            <Input
              id="mt-name"
              value={name}
              required
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Key" htmlFor="mt-key" required error={errors.fields.key} hint={editing ? undefined : 'Sent with each usage record'}>
            <Input
              id="mt-key"
              value={key}
              disabled={editing}
              className="font-mono"
              required
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
          </Field>
          <Field label="Unit" htmlFor="mt-unit" error={errors.fields.unit}>
            <Input id="mt-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="calls, tokens, GB…" />
          </Field>
        </div>
        {!editing && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">How usage adds up</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { value: 'counter', label: 'Counter', hint: 'Each record adds to the period total (API calls, messages, tokens).' },
                  { value: 'gauge', label: 'Gauge', hint: 'Records set the current level (seats, projects, storage).' },
                ] as const
              ).map((k) => (
                <label key={k.value} className={`flex cursor-pointer gap-2.5 rounded-ui-sm border p-2.5 text-sm ${kind === k.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
                  <input type="radio" name="meter-kind" checked={kind === k.value} onChange={() => setKind(k.value)} className="mt-0.5 accent-[var(--color-primary)]" />
                  <span>
                    <span className="block font-medium">{k.label}</span>
                    <span className="block text-xs text-muted-foreground">{k.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <Field label="Description" htmlFor="mt-desc">
          <Textarea id="mt-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div className="space-y-2">
          <p className="text-sm font-medium">Weights</p>
          <p className="text-xs text-muted-foreground">Multiply recorded quantities by a dimension value, e.g. model = large counts 5× more than small.</p>
          {weights.length > 0 && (
            <ul className="space-y-2">
              {weights.map((w, i) => (
                <li key={i} className="grid grid-cols-[1fr_1fr_6rem_2.25rem] gap-2">
                  <Input aria-label="Dimension" placeholder="Dimension (model)" value={w.dimension} onChange={(e) => setWeights(weights.map((x, j) => (j === i ? { ...x, dimension: e.target.value } : x)))} />
                  <Input aria-label="Value" placeholder="Value (large)" value={w.value} onChange={(e) => setWeights(weights.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <Input aria-label="Multiplier" type="number" min={0.0001} step="any" value={w.weight} onChange={(e) => setWeights(weights.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))} />
                  <Button variant="ghost" size="icon-sm" aria-label="Remove weight" onClick={() => setWeights(weights.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setWeights([...weights, { dimension: '', value: '', weight: '1' }])}>
            Add weight
          </Button>
        </div>

        <div className="space-y-3 rounded-ui-sm border p-3">
          <Checkbox checked={credits} onChange={(e) => setCredits(e.target.checked)} label="Consume prepaid credits" description="Each unit also spends credits from the customer's balance; usage is denied when the balance runs out." />
          {credits && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Credit type" htmlFor="mt-ctype">
                <Input id="mt-ctype" value={creditType} onChange={(e) => setCreditType(e.target.value)} className="font-mono" required />
              </Field>
              <Field label="Credits per unit" htmlFor="mt-cpu" error={errors.fields.creditsPerUnit}>
                <Input id="mt-cpu" type="number" min={0.000001} step="any" value={creditsPerUnit} onChange={(e) => setCreditsPerUnit(e.target.value)} required />
              </Field>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ---- Page -------------------------------------------------------------------------------------

const DEFAULTS = { tab: 'features', archived: '' };

export default function FeaturesPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('catalog.products.manage');
  const [state, setState] = useUrlState(DEFAULTS);
  const features = useFeatures();
  const meters = useMeters(state.archived === 'true');
  const [featureDialog, setFeatureDialog] = useState<{ feature?: Feature } | null>(null);
  const [meterDialog, setMeterDialog] = useState<{ meter?: Meter } | null>(null);

  const removeFeature = useAction((id: string) => api.delete(`/api/admin/features/${id}`), { success: 'Feature deleted', invalidate: [['features'], ['meters']] });
  const archiveMeter = useAction(({ id, archived }: { id: string; archived: boolean }) => api.patch(`/api/admin/meters/${id}`, { archived }), {
    success: (_r, v) => (v.archived ? 'Meter archived' : 'Meter restored'),
    invalidate: [['meters']],
  });
  const meterName = (key: string | null) => meters.data?.data.find((m) => m.key === key)?.name ?? key;

  const featureTab = (
    <Card padded={false}>
      {features.error ? (
        <ErrorState error={features.error} onRetry={() => void features.refetch()} />
      ) : (
        <DataTable
          caption="Features"
          rows={features.data?.data}
          loading={features.isLoading}
          rowKey={(f) => f.id}
          empty={<EmptyState icon={<ToggleRight />} title="No features yet" description="Define what your plans unlock: on/off capabilities, quotas and settings." action={manage && <Button onClick={() => setFeatureDialog({})}>New feature</Button>} />}
          columns={[
            {
              key: 'name',
              header: 'Feature',
              cell: (f) => (
                <span className="min-w-0">
                  <span className="block font-medium">{f.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{f.key}</span>
                </span>
              ),
            },
            { key: 'type', header: 'Type', cell: (f) => <Badge tone={f.type === 'quota' ? 'primary' : 'neutral'}>{FEATURE_TYPE_LABEL[f.type]}</Badge> },
            { key: 'meter', header: 'Meter', cell: (f) => (f.meter_key ? meterName(f.meter_key) : <span className="text-muted-foreground">—</span>) },
            { key: 'unit', header: 'Unit', priority: 'low', cell: (f) => f.unit ?? <span className="text-muted-foreground">—</span> },
            { key: 'products', header: 'Used by', align: 'right', cell: (f) => <span className="tabular">{num(f.product_count)} product{f.product_count === 1 ? '' : 's'}</span> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (f) =>
                manage ? (
                  <Menu
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${f.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    }
                    items={[
                      { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setFeatureDialog({ feature: f }) },
                      {
                        label: f.product_count ? `Delete (used by ${f.product_count})` : 'Delete',
                        icon: <Trash2 className="size-4" />,
                        danger: true,
                        disabled: f.product_count > 0,
                        onSelect: async () => {
                          const r = await confirm({ title: `Delete ${f.name}?`, description: 'Entitlement checks for this key will answer unknown_feature. This cannot be undone.', tone: 'danger', confirmLabel: 'Delete', typeToConfirm: f.key });
                          if (r.confirmed) removeFeature.mutate(f.id);
                        },
                      },
                    ]}
                  />
                ) : null,
            },
          ]}
        />
      )}
    </Card>
  );

  const meterTab = (
    <Card padded={false}>
      <Toolbar>
        <Checkbox checked={state.archived === 'true'} onChange={(e) => setState({ archived: e.target.checked ? 'true' : '' })} label="Show archived meters" />
      </Toolbar>
      {meters.error ? (
        <ErrorState error={meters.error} onRetry={() => void meters.refetch()} />
      ) : (
        <DataTable
          caption="Meters"
          rows={meters.data?.data}
          loading={meters.isLoading}
          rowKey={(m) => m.id}
          empty={<EmptyState icon={<Gauge />} title="No meters yet" description="Meters measure what customers consume: API calls, tokens, storage, seats, exports…" action={manage && <Button onClick={() => setMeterDialog({})}>New meter</Button>} />}
          columns={[
            {
              key: 'name',
              header: 'Meter',
              cell: (m) => (
                <span className="min-w-0">
                  <span className="block font-medium">{m.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{m.key}</span>
                </span>
              ),
            },
            { key: 'kind', header: 'Kind', cell: (m) => <Badge>{m.kind}</Badge> },
            { key: 'unit', header: 'Unit', cell: (m) => m.unit },
            { key: 'weights', header: 'Weights', priority: 'low', cell: (m) => (Object.keys(m.weights ?? {}).length ? <span className="text-xs">{describeWeights(m.weights)}</span> : <span className="text-muted-foreground">—</span>) },
            { key: 'credits', header: 'Credits', cell: (m) => (m.credit_type ? <span className="text-xs">{num(Number(m.credits_per_unit), { digits: 6 })} {m.credit_type} / {m.unit === 'units' ? 'unit' : m.unit}</span> : <span className="text-muted-foreground">—</span>) },
            { key: 'feature', header: 'Limited by', cell: (m) => (m.feature_key ? <span className="font-mono text-xs">{m.feature_key}</span> : <span className="text-muted-foreground">No feature</span>) },
            { key: 'status', header: 'Status', priority: 'low', cell: (m) => <StatusBadge status={m.archived ? 'archived' : 'active'} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (m) =>
                manage ? (
                  <Menu
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    }
                    items={[
                      { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setMeterDialog({ meter: m }) },
                      {
                        label: 'Archive',
                        icon: <Archive className="size-4" />,
                        danger: true,
                        hidden: m.archived,
                        onSelect: async () => {
                          const r = await confirm({ title: `Archive ${m.name}?`, description: 'The meter is hidden from lists. Recorded usage history is kept.', confirmLabel: 'Archive', tone: 'danger' });
                          if (r.confirmed) archiveMeter.mutate({ id: m.id, archived: true });
                        },
                      },
                      { label: 'Restore', icon: <RotateCcw className="size-4" />, hidden: !m.archived, onSelect: () => archiveMeter.mutate({ id: m.id, archived: false }) },
                    ]}
                  />
                ) : null,
            },
          ]}
        />
      )}
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Features & meters"
        description="Features are what plans unlock. Meters measure what customers consume; a quota feature puts a limit on a meter."
        actions={
          manage && (
            <>
              <Button variant="outline" icon={<Plus className="size-4" />} onClick={() => setMeterDialog({})}>
                New meter
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setFeatureDialog({})}>
                New feature
              </Button>
            </>
          )
        }
      />
      <Tabs
        value={String(state.tab)}
        onValueChange={(tab) => setState({ tab })}
        tabs={[
          { value: 'features', label: 'Features', count: features.data?.data.length, content: featureTab },
          { value: 'meters', label: 'Meters', count: meters.data?.data.length, content: meterTab },
        ]}
      />
      {featureDialog && <FeatureDialog open onOpenChange={(o) => !o && setFeatureDialog(null)} feature={featureDialog.feature} meters={meters.data?.data ?? []} />}
      {meterDialog && <MeterDialog open onOpenChange={(o) => !o && setMeterDialog(null)} meter={meterDialog.meter} />}
    </>
  );
}
