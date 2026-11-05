import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { useDebounced } from '../../lib/hooks';
import { bytes, toMinor } from '../../lib/format';
import { Button, Checkbox, Field, FormError, Input, Modal, SearchInput, Select, Spinner, Textarea, useToast } from '../../components/ui';

export interface OverrideForm {
  commissionType: string;
  rate: string;
  fixed: string;
  recurring: string;
  recurringMonths: string;
}

/** Form values -> API body. `null` clears an override so the tier or program default applies again. */
export function commissionOverrideBody(form: OverrideForm, currency: string) {
  return {
    commissionType: form.commissionType ? (form.commissionType as 'percent' | 'fixed') : null,
    ratePercent: form.commissionType === 'percent' && form.rate !== '' ? Number(form.rate) : null,
    fixedAmount: form.commissionType === 'fixed' && form.fixed !== '' ? toMinor(form.fixed, currency) : null,
    recurring: form.recurring === '' ? null : form.recurring === 'yes',
    recurringMonths: form.recurring === 'yes' && form.recurringMonths !== '' ? Number(form.recurringMonths) : null,
  };
}

export function CommissionOverrideFields({ form, set, currency, disabled }: { form: OverrideForm; set: (k: keyof OverrideForm, v: string) => void; currency: string; disabled?: boolean }) {
  return (
    <fieldset className="grid gap-3 rounded-ui border p-3 sm:col-span-2 sm:grid-cols-2">
      <legend className="px-1 text-sm font-semibold">Commission override</legend>
      <p className="-mt-1 text-xs text-muted-foreground sm:col-span-2">Leave on “Program default” to follow the program terms and tiers.</p>
      <Field label="Commission" htmlFor="ov-type">
        <Select id="ov-type" value={form.commissionType} onChange={(e) => set('commissionType', e.target.value)} disabled={disabled} options={[{ value: '', label: 'Program default' }, { value: 'percent', label: 'Percentage' }, { value: 'fixed', label: 'Fixed amount' }]} />
      </Field>
      {form.commissionType === 'percent' && (
        <Field label="Rate (%)" htmlFor="ov-rate">
          <Input id="ov-rate" type="number" min={0} max={100} step="0.01" value={form.rate} onChange={(e) => set('rate', e.target.value)} disabled={disabled} required />
        </Field>
      )}
      {form.commissionType === 'fixed' && (
        <Field label={`Amount per paid invoice (${currency})`} htmlFor="ov-fixed">
          <Input id="ov-fixed" type="number" min={0} step="0.01" value={form.fixed} onChange={(e) => set('fixed', e.target.value)} disabled={disabled} required />
        </Field>
      )}
      <Field label="Recurring" htmlFor="ov-rec">
        <Select id="ov-rec" value={form.recurring} onChange={(e) => set('recurring', e.target.value)} disabled={disabled} options={[{ value: '', label: 'Program default' }, { value: 'yes', label: 'Yes, on renewals too' }, { value: 'no', label: 'First payment only' }]} />
      </Field>
      {form.recurring === 'yes' && (
        <Field label="For months" hint="0 = lifetime; empty = program default" htmlFor="ov-months">
          <Input id="ov-months" type="number" min={0} max={120} step={1} value={form.recurringMonths} onChange={(e) => set('recurringMonths', e.target.value)} disabled={disabled} />
        </Field>
      )}
    </fieldset>
  );
}

// ---- Upline (multi-level) --------------------------------------------------------------------

export interface AffiliateOption {
  id: string;
  name: string;
  code: string;
}

/** Search-as-you-type affiliate selection, for choosing who recruited an affiliate. */
export function AffiliatePicker({ value, onChange, exclude, id }: { value: AffiliateOption | null; onChange: (a: AffiliateOption | null) => void; exclude?: string; id?: string }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const results = useQuery({
    queryKey: ['affiliate-picker', term],
    queryFn: ({ signal }) => api.get<Page<AffiliateOption>>('/api/admin/affiliates', { q: term, pageSize: 8 }, signal),
    enabled: term.length >= 2,
  });
  if (value) {
    return (
      <div id={id} className="flex items-center gap-2 rounded-ui-sm border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm">
          {value.name} <span className="font-mono text-xs text-muted-foreground">{value.code}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Remove
        </Button>
      </div>
    );
  }
  const options = (results.data?.data ?? []).filter((a) => a.id !== exclude);
  return (
    <div className="space-y-1.5">
      <SearchInput value={q} onChange={setQ} placeholder="Search affiliates by name, email or code" />
      {term.length >= 2 && (
        <ul className="max-h-56 overflow-y-auto rounded-ui-sm border" aria-label="Matching affiliates">
          {results.isLoading && (
            <li className="flex justify-center p-3">
              <Spinner />
            </li>
          )}
          {results.data && options.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matching affiliates.</li>}
          {options.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => onChange({ id: a.id, name: a.name, code: a.code })} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
                <span className="min-w-0 truncate">{a.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{a.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Mirrors the server limit: levels 2 to 6 can earn on a sale. */
export const MAX_UPLINE_LEVELS = 5;

/** Upline rates as percentages, one per level starting at level 2. */
export function UplineRatesField({ rates, onChange, disabled }: { rates: string[]; onChange: (rates: string[]) => void; disabled?: boolean }) {
  return (
    <div className="space-y-3">
      {rates.length === 0 && <p className="text-sm text-muted-foreground">Off: only the affiliate who referred the customer earns a commission.</p>}
      {rates.map((rate, i) => (
        <div key={i} className="flex items-end gap-2">
          <Field label={`Level ${i + 2} (%)`} htmlFor={`upline-${i}`} className="flex-1">
            <Input id={`upline-${i}`} type="number" min={0} max={100} step="0.01" value={rate} onChange={(e) => onChange(rates.map((r, j) => (j === i ? e.target.value : r)))} disabled={disabled} required />
          </Field>
          {!disabled && (
            <Button variant="ghost" size="icon" aria-label={`Remove level ${i + 2}`} onClick={() => onChange(rates.slice(0, i).concat(rates.slice(i + 1)))}>
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      ))}
      {!disabled && rates.length < MAX_UPLINE_LEVELS && (
        <Button variant="outline" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...rates, ''])}>
          Add level {rates.length + 2}
        </Button>
      )}
    </div>
  );
}

// ---- Groups --------------------------------------------------------------------------------------

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  affiliates: number;
  materials: number;
}

export function GroupDialog({ group, open, onOpenChange }: { group: GroupRow | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => {
      const body = { name, description: description || null };
      return group ? api.patch(`/api/admin/affiliate-groups/${group.id}`, body) : api.post('/api/admin/affiliate-groups', body);
    },
    { success: group ? 'Group updated' : 'Group created', invalidate: [['affiliate-groups']], onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={group ? 'Edit group' : 'New group'}
      description="Groups organise affiliates (influencers, agencies, resellers…) and decide which marketing materials they see."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="group-form" loading={save.isPending}>
            {group ? 'Save group' : 'Create group'}
          </Button>
        </>
      }
    >
      <form
        id="group-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Name" htmlFor="group-name" required>
          <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Influencers" />
        </Field>
        <Field label="Description" htmlFor="group-description" hint="For administrators only">
          <Textarea id="group-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
      </form>
    </Modal>
  );
}

// ---- Marketing materials -----------------------------------------------------------------------

export type MaterialType = 'banner' | 'text_link' | 'file';

export interface MaterialRow {
  id: string;
  type: MaterialType;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  landingPath: string | null;
  linkText: string | null;
  imageUrl: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  groupIds: string[];
  tierIds: string[];
  sortOrder: number;
  file: { id: string; filename: string; contentType: string; size: number } | null;
  clicks30d: number;
  createdAt: string;
  updatedAt: string;
}

export interface TierOption {
  id: string;
  name: string;
}

export const MATERIAL_TYPES: { value: MaterialType; label: string }[] = [
  { value: 'banner', label: 'Banner' },
  { value: 'text_link', label: 'Text link' },
  { value: 'file', label: 'Downloadable file' },
];

const BANNER_MAX = 2 * 1024 * 1024;
const FILE_MAX = 20 * 1024 * 1024;

function TargetChecklist({ legend, items, selected, onChange, empty }: { legend: string; items: { id: string; name: string }[]; selected: string[]; onChange: (ids: string[]) => void; empty: string }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {items.length === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
      {items.map((item) => (
        <Checkbox
          key={item.id}
          checked={selected.includes(item.id)}
          onChange={(e) => onChange(e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
          label={<span className="font-normal">{item.name}</span>}
        />
      ))}
    </fieldset>
  );
}

/**
 * Create or edit a material. Images and files are uploaded right after the material is saved; if the
 * upload fails the material is kept and saving again retries the upload.
 */
export function MaterialDialog({ material, open, onOpenChange, groups, tiers }: { material: MaterialRow | null; open: boolean; onOpenChange: (o: boolean) => void; groups: GroupRow[]; tiers: TierOption[] }) {
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    type: material?.type ?? ('banner' as MaterialType),
    name: material?.name ?? '',
    description: material?.description ?? '',
    landingPath: material?.landingPath ?? '',
    linkText: material?.linkText ?? '',
    imageSource: material?.imageUrl ? 'url' : 'upload',
    imageUrl: material?.imageUrl ?? '',
    width: material?.width ? String(material.width) : '',
    height: material?.height ? String(material.height) : '',
    sortOrder: String(material?.sortOrder ?? 0),
    groupIds: material?.groupIds ?? [],
    tierIds: material?.tierIds ?? [],
  }));
  const [file, setFile] = useState<File | null>(null);
  const [savedId, setSavedId] = useState<string | null>(material?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const banner = form.type === 'banner';
  const takesUpload = form.type === 'file' || (banner && form.imageSource === 'upload');

  const save = useAction(
    async () => {
      const body = {
        name: form.name,
        description: form.description || null,
        landingPath: form.landingPath || null,
        linkText: form.linkText || null,
        sortOrder: Math.round(Number(form.sortOrder) || 0),
        groupIds: form.groupIds,
        tierIds: form.tierIds,
        ...(banner
          ? {
              // Choosing a URL replaces an uploaded image; keeping "upload" leaves the stored image alone.
              imageUrl: form.imageSource === 'url' ? form.imageUrl || null : undefined,
              width: form.width ? Number(form.width) : null,
              height: form.height ? Number(form.height) : null,
            }
          : {}),
      };
      let id = savedId;
      if (id) {
        await api.patch(`/api/admin/affiliate-materials/${id}`, body);
      } else {
        id = (await api.post<MaterialRow>('/api/admin/affiliate-materials', { type: form.type, ...body })).id;
        setSavedId(id);
      }
      if (file && takesUpload) {
        const data = new FormData();
        data.append('file', file);
        await api.upload(`/api/admin/affiliate-materials/${id}/file`, data);
      }
    },
    {
      success: material ? 'Material updated' : 'Material created',
      invalidate: [['affiliate-materials']],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(errorMessage(e));
        void client.invalidateQueries({ queryKey: ['affiliate-materials'] });
      },
    },
  );

  const chooseFile = (f: File | null) => {
    if (f && f.size > (banner ? BANNER_MAX : FILE_MAX)) {
      toast.error('File too large', banner ? 'Banner images can be up to 2 MB.' : 'Files can be up to 20 MB.');
      return;
    }
    setFile(f);
  };

  const textLabel = form.type === 'text_link' ? 'Link text' : form.type === 'banner' ? 'Image description (alt text)' : 'Download label';
  const current = material?.file;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={material ? `Edit ${material.name}` : 'New marketing material'}
      description="Each affiliate gets it with their own tracking link. Leave the audience empty to offer it to every affiliate."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="material-form" loading={save.isPending}>
            {material ? 'Save material' : 'Create material'}
          </Button>
        </>
      }
    >
      <form
        id="material-form"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Type" htmlFor="mat-type">
          <Select id="mat-type" value={form.type} onChange={(e) => set('type', e.target.value as MaterialType)} disabled={Boolean(savedId)} options={MATERIAL_TYPES} />
        </Field>
        <Field label="Name" htmlFor="mat-name" required hint="Shown to affiliates">
          <Input id="mat-name" value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} placeholder={banner ? 'Leaderboard 728×90' : form.type === 'file' ? 'Brand kit' : 'Free trial link'} />
        </Field>
        <Field label={textLabel} htmlFor="mat-text" required={form.type === 'text_link'} className="sm:col-span-2">
          <Input id="mat-text" value={form.linkText} onChange={(e) => set('linkText', e.target.value)} maxLength={200} required={form.type === 'text_link'} />
        </Field>
        <Field label="Landing page" htmlFor="mat-landing" hint="A path on your site such as /pricing, or a URL on an allowed redirect host. Empty: the program landing page.">
          <Input id="mat-landing" value={form.landingPath} onChange={(e) => set('landingPath', e.target.value)} maxLength={2000} placeholder="/pricing" />
        </Field>
        <Field label="Position" htmlFor="mat-position" hint="Affiliates see lower numbers first">
          <Input id="mat-position" type="number" min={-10000} max={10000} step={1} value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
        </Field>
        {banner && (
          <fieldset className="space-y-3 rounded-ui border p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-semibold">Image</legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="mat-source" checked={form.imageSource === 'upload'} onChange={() => set('imageSource', 'upload')} className="accent-[var(--color-primary)]" />
                Upload an image
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="mat-source" checked={form.imageSource === 'url'} onChange={() => set('imageSource', 'url')} className="accent-[var(--color-primary)]" />
                Use an image URL
              </label>
            </div>
            {form.imageSource === 'url' ? (
              <Field label="Image URL" htmlFor="mat-image" hint="https only; affiliates embed it from there">
                <Input id="mat-image" type="url" value={form.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} maxLength={2000} placeholder="https://cdn.example.com/banner.png" required />
              </Field>
            ) : (
              <Field label="Image file" htmlFor="mat-upload" hint={current ? `Current: ${current.filename} (${bytes(current.size)}). Choose a file to replace it.` : 'PNG, JPEG, GIF, WebP or SVG, up to 2 MB'}>
                <input id="mat-upload" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} className="block w-full text-sm file:mr-3 file:rounded-ui-sm file:border file:bg-surface file:px-3 file:py-1.5 file:text-sm" />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Width (px)" htmlFor="mat-width">
                <Input id="mat-width" type="number" min={1} max={4000} value={form.width} onChange={(e) => set('width', e.target.value)} />
              </Field>
              <Field label="Height (px)" htmlFor="mat-height">
                <Input id="mat-height" type="number" min={1} max={4000} value={form.height} onChange={(e) => set('height', e.target.value)} />
              </Field>
            </div>
          </fieldset>
        )}
        {form.type === 'file' && (
          <Field label="File" htmlFor="mat-file" className="sm:col-span-2" hint={current ? `Current: ${current.filename} (${bytes(current.size)}). Choose a file to replace it.` : 'PDF, ZIP (including Office files), image, MP4 or plain text, up to 20 MB'}>
            <input
              id="mat-file"
              type="file"
              accept="application/pdf,application/zip,image/*,video/mp4,text/plain,.docx,.xlsx,.pptx"
              onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-ui-sm file:border file:bg-surface file:px-3 file:py-1.5 file:text-sm"
            />
          </Field>
        )}
        <Field label="Notes for affiliates" htmlFor="mat-description" className="sm:col-span-2">
          <Textarea id="mat-description" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} placeholder="Where it works best, wording to avoid…" />
        </Field>
        <div className="grid gap-4 rounded-ui border p-3 sm:col-span-2 sm:grid-cols-2">
          <p className="text-xs text-muted-foreground sm:col-span-2">Audience: affiliates in any selected group or tier. Nothing selected offers it to every affiliate.</p>
          <TargetChecklist legend="Groups" items={groups} selected={form.groupIds} onChange={(ids) => set('groupIds', ids)} empty="No groups yet; create them under Groups." />
          <TargetChecklist legend="Tiers" items={tiers} selected={form.tierIds} onChange={(ids) => set('tierIds', ids)} empty="No tiers yet." />
        </div>
      </form>
    </Modal>
  );
}
