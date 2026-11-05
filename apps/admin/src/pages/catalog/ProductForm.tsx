import { useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { Button, Checkbox, Field, FormError, Input, Modal, Select, Switch, Textarea } from '../../components/ui';
import { KIND_OPTIONS, PLAN_TYPES, slugify, useFormErrors, type Product, type ProductKind } from './shared';

interface FormState {
  key: string;
  name: string;
  description: string;
  kind: ProductKind;
  planType: string;
  status: 'draft' | 'active' | 'archived';
  isPublic: boolean;
  subscriberType: 'user' | 'organization';
  sortOrder: string;
  trialDays: string;
  trialRequiresPaymentMethod: boolean;
  graceDays: string;
  creditType: string;
  creditAmount: string;
  creditsExpireDays: string;
  highlights: string;
}

function initial(p?: Product, kind: ProductKind = 'plan'): FormState {
  return {
    key: p?.key ?? '',
    name: p?.name ?? '',
    description: p?.description ?? '',
    kind: p?.kind ?? kind,
    planType: p?.plan_type ?? 'paid',
    status: p?.status ?? 'draft',
    isPublic: p?.is_public ?? true,
    subscriberType: p?.subscriber_type ?? 'user',
    sortOrder: String(p?.sort_order ?? 0),
    trialDays: String(p?.trial_days ?? 0),
    trialRequiresPaymentMethod: p?.trial_requires_payment_method ?? false,
    graceDays: String(p?.grace_days ?? 3),
    creditType: p?.credit_type ?? 'credits',
    creditAmount: p?.credit_amount ? String(p.credit_amount) : '',
    creditsExpireDays: p?.credits_expire_days ? String(p.credits_expire_days) : '',
    highlights: (p?.highlights ?? []).join('\n'),
  };
}

const int = (s: string) => (s.trim() === '' ? undefined : Math.trunc(Number(s)));

/**
 * Create or edit a product. Key and kind are fixed after creation (integrations
 * reference the key); everything else can change.
 */
export function ProductDialog({ open, onOpenChange, product, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; product?: Product; onSaved?: (p: Product) => void }) {
  const editing = Boolean(product);
  const [f, setF] = useState<FormState>(() => initial(product));
  const [keyTouched, setKeyTouched] = useState(editing);
  const errors = useFormErrors();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const body = () => {
    const common = {
      name: f.name,
      description: f.description,
      status: f.status,
      isPublic: f.isPublic,
      subscriberType: f.subscriberType,
      sortOrder: int(f.sortOrder) ?? 0,
      highlights: f.highlights.split('\n').map((h) => h.trim()).filter(Boolean),
    };
    const kindFields =
      f.kind === 'plan'
        ? { planType: f.planType, trialDays: int(f.trialDays) ?? 0, trialRequiresPaymentMethod: f.trialRequiresPaymentMethod, graceDays: int(f.graceDays) ?? 3 }
        : f.kind === 'addon'
          ? { graceDays: int(f.graceDays) ?? 3 }
          : f.kind === 'credit_pack'
            ? { creditType: f.creditType.trim() || null, creditAmount: int(f.creditAmount) ?? null, creditsExpireDays: int(f.creditsExpireDays) ?? null }
            : {};
    return editing ? { ...common, ...kindFields } : { key: f.key, kind: f.kind, ...common, ...kindFields };
  };

  const save = useAction(() => (editing ? api.patch<Product>(`/api/admin/products/${product!.id}`, body()) : api.post<Product>('/api/admin/products', body())), {
    success: editing ? 'Product updated' : 'Product created',
    invalidate: [['products'], ['product']],
    onSuccess: (p) => {
      onOpenChange(false);
      onSaved?.(p);
    },
    onError: (err) => errors.set(err, ['key', 'name', 'creditAmount', 'creditType', 'trialDays', 'graceDays', 'highlights']),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${product!.name}` : 'New product'}
      description={editing ? undefined : 'Create a plan, add-on, one-time product or credit pack. Add prices and features once it exists.'}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="product-form" loading={save.isPending}>
            {editing ? 'Save changes' : 'Create product'}
          </Button>
        </>
      }
    >
      <form
        id="product-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          save.mutate();
        }}
      >
        <FormError message={errors.general} />
        {!editing && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {KIND_OPTIONS.map((k) => (
                <label key={k.value} className={`flex cursor-pointer gap-2.5 rounded-ui-sm border p-3 text-sm ${f.kind === k.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
                  <input type="radio" name="kind" value={k.value} checked={f.kind === k.value} onChange={() => set('kind', k.value)} className="mt-0.5 accent-[var(--color-primary)]" />
                  <span>
                    <span className="block font-medium">{k.label}</span>
                    <span className="block text-xs text-muted-foreground">{k.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="pf-name" required error={errors.fields.name}>
            <Input
              id="pf-name"
              value={f.name}
              required
              autoFocus={!editing}
              onChange={(e) => {
                set('name', e.target.value);
                if (!keyTouched) set('key', slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Key" htmlFor="pf-key" required error={errors.fields.key} hint={editing ? 'Fixed: your application and API calls reference it.' : 'Used by your application and the API, e.g. pro or team_annual.'}>
            <Input
              id="pf-key"
              value={f.key}
              disabled={editing}
              required
              className="font-mono"
              onChange={(e) => {
                setKeyTouched(true);
                set('key', e.target.value);
              }}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="pf-desc">
          <Textarea id="pf-desc" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>

        {f.kind === 'plan' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Plan type" htmlFor="pf-plantype">
              <Select id="pf-plantype" value={f.planType} onChange={(e) => set('planType', e.target.value)} options={PLAN_TYPES} />
            </Field>
            <Field label="Subscribed by" htmlFor="pf-subscriber" hint="Organization plans are shared by all members.">
              <Select id="pf-subscriber" value={f.subscriberType} onChange={(e) => set('subscriberType', e.target.value as FormState['subscriberType'])} options={[{ value: 'user', label: 'Individual users' }, { value: 'organization', label: 'Organizations / teams' }]} />
            </Field>
            <Field label="Free trial (days)" htmlFor="pf-trial" error={errors.fields.trialDays} hint="0 for no trial">
              <Input id="pf-trial" type="number" min={0} max={365} value={f.trialDays} onChange={(e) => set('trialDays', e.target.value)} />
            </Field>
            <Field label="Grace period (days)" htmlFor="pf-grace" error={errors.fields.graceDays} hint="Access kept after a failed renewal payment">
              <Input id="pf-grace" type="number" min={0} max={90} value={f.graceDays} onChange={(e) => set('graceDays', e.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <Checkbox checked={f.trialRequiresPaymentMethod} onChange={(e) => set('trialRequiresPaymentMethod', e.target.checked)} label="Trial requires a payment method" description="Collect card details before the trial starts. The first period is charged at sign-up and begins when the trial ends." />
            </div>
          </div>
        )}
        {f.kind === 'addon' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Subscribed by" htmlFor="pf-subscriber">
              <Select id="pf-subscriber" value={f.subscriberType} onChange={(e) => set('subscriberType', e.target.value as FormState['subscriberType'])} options={[{ value: 'user', label: 'Individual users' }, { value: 'organization', label: 'Organizations / teams' }]} />
            </Field>
            <Field label="Grace period (days)" htmlFor="pf-grace">
              <Input id="pf-grace" type="number" min={0} max={90} value={f.graceDays} onChange={(e) => set('graceDays', e.target.value)} />
            </Field>
          </div>
        )}
        {f.kind === 'credit_pack' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Credit type" htmlFor="pf-ctype" required error={errors.fields.creditType} hint="Matches the meters that consume it">
              <Input id="pf-ctype" value={f.creditType} onChange={(e) => set('creditType', e.target.value)} className="font-mono" required />
            </Field>
            <Field label="Credits granted" htmlFor="pf-camount" required error={errors.fields.creditAmount}>
              <Input id="pf-camount" type="number" min={1} value={f.creditAmount} onChange={(e) => set('creditAmount', e.target.value)} required />
            </Field>
            <Field label="Expire after (days)" htmlFor="pf-cexp" hint="Empty: never expire">
              <Input id="pf-cexp" type="number" min={1} max={3650} value={f.creditsExpireDays} onChange={(e) => set('creditsExpireDays', e.target.value)} />
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status" htmlFor="pf-status" hint="Only active products can be purchased.">
            <Select
              id="pf-status"
              value={f.status}
              onChange={(e) => set('status', e.target.value as FormState['status'])}
              options={[{ value: 'draft', label: 'Draft' }, { value: 'active', label: 'Active' }, ...(editing ? [{ value: 'archived', label: 'Archived' }] : [])]}
            />
          </Field>
          <Field label="Display order" htmlFor="pf-sort" hint="Lower numbers appear first on pricing pages">
            <Input id="pf-sort" type="number" value={f.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
          </Field>
        </div>
        <Switch checked={f.isPublic} onCheckedChange={(v) => set('isPublic', v)} label="Listed publicly" description="Shown by the plans API for pricing pages. Hidden products can still be sold through the checkout API and granted manually." />
        <Field label="Highlights" htmlFor="pf-highlights" hint="One per line; shown on pricing tables" error={errors.fields.highlights}>
          <Textarea id="pf-highlights" rows={3} value={f.highlights} onChange={(e) => set('highlights', e.target.value)} placeholder={'Unlimited projects\nPriority support'} />
        </Field>
      </form>
    </Modal>
  );
}
