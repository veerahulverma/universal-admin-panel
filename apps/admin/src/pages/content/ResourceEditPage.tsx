import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CircleCheck, CircleX, FlaskConical, Trash2, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, num } from '../../lib/format';
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  PageHeader,
  PageSkeleton,
  Select,
  Switch,
  Textarea,
  When,
  useConfirm,
  useToast,
  type OptionGroup,
} from '../../components/ui';
import {
  KINDS,
  ProductKindLabel,
  UserChip,
  UserSearch,
  decisionDetail,
  fileSize,
  kindMeta,
  limitLabel,
  useAccessOptions,
  type AccessFile,
  type AccessOptions,
  type Decision,
  type PickedUser,
  type ResourceDetail,
  type ResourceKind,
} from './shared';

interface FormState {
  kind: ResourceKind;
  title: string;
  description: string;
  path: string;
  url: string;
  body: string;
  active: boolean;
  showLocked: boolean;
  productIds: string[];
  groupIds: string[];
  anyCustomer: boolean;
  releaseMode: 'immediate' | 'days' | 'date';
  releaseDays: string;
  releaseDate: string;
  windowEnabled: boolean;
  windowDays: string;
  fileIds: string[];
}

/** ISO timestamp -> value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function initialState(r: ResourceDetail | null): FormState {
  return {
    kind: r?.kind ?? 'folder',
    title: r?.title ?? '',
    description: r?.description ?? '',
    path: r?.path ?? '',
    url: r?.url ?? '',
    body: r?.body ?? '',
    active: (r?.status ?? 'active') === 'active',
    showLocked: r?.showLocked ?? false,
    productIds: r?.rules.products.map((p) => p.id) ?? [],
    groupIds: r?.rules.groups.map((g) => g.id) ?? [],
    anyCustomer: r?.rules.anyCustomer ?? false,
    releaseMode: r?.release.mode ?? 'immediate',
    releaseDays: r?.release.days !== null && r?.release.days !== undefined ? String(r.release.days) : '7',
    releaseDate: toLocalInput(r?.release.date ?? null),
    windowEnabled: Boolean(r?.windowDays),
    windowDays: r?.windowDays ? String(r.windowDays) : '30',
    fileIds: r?.files.map((f) => f.id) ?? [],
  };
}

function requestBody(f: FormState, isNew: boolean): { body?: Record<string, unknown>; error?: string } {
  const days = Number(f.releaseDays);
  const window = Number(f.windowDays);
  if (f.releaseMode === 'days' && (!Number.isInteger(days) || days < 0)) return { error: 'Enter the number of days after which the content opens' };
  if (f.releaseMode === 'date' && !fromLocalInput(f.releaseDate)) return { error: 'Choose the date the content opens' };
  if (f.windowEnabled && (!Number.isInteger(window) || window < 1)) return { error: 'Enter how many days access lasts' };
  return {
    body: {
      ...(isNew ? { kind: f.kind } : {}),
      title: f.title,
      description: f.description,
      ...(f.kind === 'url' || f.kind === 'folder' ? { path: f.path } : {}),
      ...(f.kind === 'page' ? { body: f.body } : {}),
      ...(f.kind === 'link' ? { url: f.url } : {}),
      ...(f.kind === 'file' ? { fileIds: f.fileIds } : {}),
      status: f.active ? 'active' : 'disabled',
      showLocked: f.showLocked,
      rules: { productIds: f.productIds, groupIds: f.groupIds, anyCustomer: f.anyCustomer },
      release: f.releaseMode === 'days' ? { mode: 'days', days } : f.releaseMode === 'date' ? { mode: 'date', date: fromLocalInput(f.releaseDate) } : { mode: 'immediate' },
      windowDays: f.windowEnabled ? window : null,
    },
  };
}

// ---- Rules -------------------------------------------------------------------------------------

function RulesEditor({ form, set, options, resource, disabled, error }: { form: FormState; set: (patch: Partial<FormState>) => void; options: AccessOptions | undefined; resource: ResourceDetail | null; disabled: boolean; error?: string }) {
  const products = new Map<string, { name: string; kind: string | null }>();
  for (const p of resource?.rules.products ?? []) products.set(p.id, { name: p.name ?? p.key ?? p.id, kind: p.kind });
  for (const p of options?.products ?? []) products.set(p.id, { name: p.name, kind: p.kind });
  const groups = new Map<string, string>();
  for (const g of resource?.rules.groups ?? []) groups.set(g.id, g.name ?? g.id);
  for (const g of options?.groups ?? []) groups.set(g.id, g.name);

  const available = (options?.products ?? []).filter((p) => p.status !== 'archived' && !form.productIds.includes(p.id));
  const choices: OptionGroup[] = [
    { label: 'Plans', options: available.filter((p) => p.kind === 'plan').map((p) => ({ value: `product:${p.id}`, label: p.name })) },
    { label: 'Add-ons and other products', options: available.filter((p) => p.kind !== 'plan').map((p) => ({ value: `product:${p.id}`, label: p.name })) },
    { label: 'User groups', options: (options?.groups ?? []).filter((g) => !form.groupIds.includes(g.id)).map((g) => ({ value: `group:${g.id}`, label: g.name })) },
  ].filter((g) => g.options.length > 0);

  const chips: { key: string; label: string; detail: ReactNode; remove: () => void }[] = [
    ...form.productIds.map((id) => ({
      key: id,
      label: products.get(id)?.name ?? id,
      detail: <ProductKindLabel kind={products.get(id)?.kind ?? null} />,
      remove: () => set({ productIds: form.productIds.filter((x) => x !== id) }),
    })),
    ...form.groupIds.map((id) => ({ key: id, label: groups.get(id) ?? id, detail: 'Group', remove: () => set({ groupIds: form.groupIds.filter((x) => x !== id) }) })),
  ];

  return (
    <div className="space-y-4">
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <li key={c.key} className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-surface py-1 pl-3 pr-1.5 text-sm">
              <span className="truncate font-medium">{c.label}</span>
              <span className="text-xs text-muted-foreground">{c.detail}</span>
              {!disabled && (
                <button type="button" onClick={c.remove} className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove ${c.label}`}>
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && choices.length > 0 && (
        <Select
          aria-label="Add a plan, product or group"
          value=""
          placeholder="Add a plan, product or group…"
          options={choices}
          onChange={(e) => {
            const [type, id] = e.target.value.split(':');
            if (type === 'product') set({ productIds: [...form.productIds, id] });
            if (type === 'group') set({ groupIds: [...form.groupIds, id] });
          }}
        />
      )}
      <Switch checked={form.anyCustomer} onCheckedChange={(v) => set({ anyCustomer: v })} disabled={disabled} label="Any signed-in customer" description="Everyone with an account, whatever their plan." />
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      {!chips.length && !form.anyCustomer && <Callout tone="warning">Nobody can open this until you add a plan, product or group, or allow any signed-in customer.</Callout>}
      <p className="text-xs text-muted-foreground">Any matching rule grants access. Access follows the customer’s current subscriptions and grants, so it ends when they cancel, a grant expires or they leave the group.</p>
    </div>
  );
}

// ---- Release ---------------------------------------------------------------------------------

function RadioRow({ name, checked, onChange, label, description, disabled, children }: { name: string; checked: boolean; onChange: () => void; label: string; description?: string; disabled?: boolean; children?: ReactNode }) {
  return (
    <label className={clsx('flex cursor-pointer items-start gap-2.5 rounded-ui-sm border p-3', checked && 'border-primary bg-primary/5', disabled && 'cursor-default opacity-80')}>
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]" />
      <span className="min-w-0 flex-1 space-y-2">
        <span className="block text-sm">
          <span className="font-medium">{label}</span>
          {description && <span className="block text-muted-foreground">{description}</span>}
        </span>
        {checked && children}
      </span>
    </label>
  );
}

function ReleaseEditor({ form, set, disabled, errors }: { form: FormState; set: (patch: Partial<FormState>) => void; disabled: boolean; errors: Record<string, string> }) {
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="When it opens" className="space-y-2">
        <RadioRow name="release" checked={form.releaseMode === 'immediate'} onChange={() => set({ releaseMode: 'immediate' })} disabled={disabled} label="Immediately" description="As soon as the customer has access." />
        <RadioRow name="release" checked={form.releaseMode === 'days'} onChange={() => set({ releaseMode: 'days' })} disabled={disabled} label="A number of days after access starts" description="Counted from when the customer’s current subscription or grant began, or when they joined the group (drip).">
          <div className="flex items-center gap-2">
            <Input aria-label="Days after access starts" type="number" min={0} max={3650} inputMode="numeric" className="w-24" value={form.releaseDays} onChange={(e) => set({ releaseDays: e.target.value })} disabled={disabled} invalid={Boolean(errors['release.days'])} />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </RadioRow>
        <RadioRow name="release" checked={form.releaseMode === 'date'} onChange={() => set({ releaseMode: 'date' })} disabled={disabled} label="On a date" description="The same moment for every customer with access.">
          <Input aria-label="Opens on" type="datetime-local" className="w-full sm:w-64" value={form.releaseDate} onChange={(e) => set({ releaseDate: e.target.value })} disabled={disabled} invalid={Boolean(errors['release.date'])} />
        </RadioRow>
      </div>
      <div className="space-y-2 rounded-ui-sm border p-3">
        <Switch checked={form.windowEnabled} onCheckedChange={(v) => set({ windowEnabled: v })} disabled={disabled} label="Limit how long it stays available" description="Access ends a number of days after the content opened for the customer." />
        {form.windowEnabled && (
          <div className="flex items-center gap-2">
            <Input aria-label="Days available" type="number" min={1} max={3650} inputMode="numeric" className="w-24" value={form.windowDays} onChange={(e) => set({ windowDays: e.target.value })} disabled={disabled} invalid={Boolean(errors.windowDays)} />
            <span className="text-sm text-muted-foreground">days after it opens</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Files ----------------------------------------------------------------------------------

function FilesEditor({ form, set, options, attached, disabled, error }: { form: FormState; set: (patch: Partial<FormState>) => void; options: AccessOptions | undefined; attached: AccessFile[]; disabled: boolean; error?: string }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const canUpload = can('access.files.manage') && !me?.admin.orgScope && !disabled;
  const known = new Map<string, { title: string; detail: string }>();
  for (const f of options?.files ?? []) known.set(f.id, { title: f.title, detail: `${f.filename} · ${fileSize(f.size)}` });
  for (const f of attached) known.set(f.id, { title: f.title, detail: `${f.filename} · ${fileSize(f.size)} · ${limitLabel(f.downloadLimit, f.limitPeriod)}` });
  const library = (options?.files ?? []).filter((f) => !form.fileIds.includes(f.id));

  const uploadFile = useAction(
    (file: File) => {
      const data = new FormData();
      data.append('title', file.name);
      data.append('file', file);
      return api.upload<AccessFile>('/api/admin/access/files', data);
    },
    {
      invalidate: [['access-options'], ['access-files']],
      onSuccess: (f) => {
        set({ fileIds: [...form.fileIds, f.id] });
        toast.success(`${f.filename} uploaded`, 'Save the resource to offer it here.');
      },
      error: 'Upload failed',
    },
  );

  const move = (i: number, by: number) => {
    const next = [...form.fileIds];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item);
    set({ fileIds: next });
  };

  return (
    <div className="space-y-3">
      {form.fileIds.length ? (
        <ul className="divide-y rounded-ui-sm border">
          {form.fileIds.map((id, i) => (
            <li key={id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{known.get(id)?.title ?? id}</span>
                <span className="block truncate text-xs text-muted-foreground">{known.get(id)?.detail}</span>
              </span>
              {!disabled && (
                <span className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === form.fileIds.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Remove file" onClick={() => set({ fileIds: form.fileIds.filter((x) => x !== id) })}>
                    <X className="size-4" />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No files yet. Add files from Downloads or upload one.</p>
      )}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          {library.length > 0 && (
            <Select
              aria-label="Add a file from Downloads"
              className="w-full sm:w-72"
              value=""
              placeholder="Add a file from Downloads…"
              options={library.map((f) => ({ value: f.id, label: `${f.title} (${fileSize(f.size)})` }))}
              onChange={(e) => e.target.value && set({ fileIds: [...form.fileIds, e.target.value] })}
            />
          )}
          {canUpload && (
            <>
              <input
                ref={input}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadFile.mutate(file);
                  e.target.value = '';
                }}
              />
              <Button variant="outline" icon={<Upload className="size-4" />} loading={uploadFile.isPending} onClick={() => input.current?.click()}>
                Upload a file
              </Button>
            </>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Customers get short-lived signed links; each download counts against the file’s limit. Limits are set per file in{' '}
        <Link to="/content/files" className="text-primary hover:underline">
          Downloads
        </Link>
        .
      </p>
    </div>
  );
}

// ---- Test access ------------------------------------------------------------------------------

interface TestResult extends Decision {
  path: string | null;
  resource: { id: string; kind: ResourceKind; title: string; path: string | null } | null;
  profile: {
    inactive: boolean;
    customerSince: string;
    products: { id: string; key: string; name: string; kind: string; since: string }[];
    groups: { id: string; name: string; manual: boolean; automatic: boolean; since: string }[];
  };
}

function TestAccess({ resource }: { resource: ResourceDetail }) {
  const { can } = useAuth();
  const [user, setUser] = useState<PickedUser | null>(null);
  const [userId, setUserId] = useState('');
  const [path, setPath] = useState('');
  const [result, setResult] = useState<TestResult | null>(null);
  const protectsPath = resource.kind === 'url' || resource.kind === 'folder';
  const subject = user?.id ?? userId.trim();
  const test = useAction(() => api.post<TestResult>('/api/admin/access/check', { userId: subject, resource: path.trim() || resource.id }), {
    error: 'Could not test access',
    onSuccess: setResult,
    onError: () => setResult(null),
  });

  return (
    <Card title="Test access for a customer" description="Shows what they would get right now, and why. Tests are not logged.">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (subject) test.mutate();
        }}
      >
        {can('customers.users.view') ? (
          user ? (
            <div className="flex items-center justify-between gap-2">
              <UserChip
                user={user}
                onRemove={() => {
                  setUser(null);
                  setResult(null);
                }}
              />
            </div>
          ) : (
            <UserSearch
              id="test-user"
              placeholder="Find a customer…"
              onPick={(u) => {
                setUser(u);
                setResult(null);
              }}
            />
          )
        ) : (
          <Field label="User ID" htmlFor="test-user-id">
            <Input id="test-user-id" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="usr_…" className="font-mono" />
          </Field>
        )}
        {protectsPath && (
          <Field label="Path" htmlFor="test-path" hint={resource.kind === 'folder' ? 'Optional: a path inside the folder' : undefined}>
            <Input id="test-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder={resource.kind === 'folder' ? `${resource.path === '/' ? '' : resource.path}/…` : resource.path ?? ''} className="font-mono" />
          </Field>
        )}
        <Button type="submit" variant="outline" icon={<FlaskConical className="size-4" />} loading={test.isPending} disabled={!subject}>
          Test access
        </Button>
      </form>
      {result && (
        <div className="mt-4 space-y-3 border-t pt-4" aria-live="polite">
          <div className="flex items-start gap-2">
            {result.allowed ? <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" /> : <CircleX className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />}
            <div className="min-w-0">
              <p className="font-medium">{result.allowed ? 'Can open it' : 'Cannot open it'}</p>
              <p className="text-sm text-muted-foreground">{decisionDetail(result)}</p>
              {result.resource && result.resource.id !== resource.id && (
                <p className="mt-1 text-sm">
                  This path is decided by{' '}
                  <Link to={`/content/resources/${result.resource.id}`} className="text-primary hover:underline">
                    {result.resource.title}
                  </Link>
                  .
                </p>
              )}
            </div>
          </div>
          {result.profile.inactive && <Callout tone="warning">This account is suspended, banned or not verified, so it cannot open any content.</Callout>}
          <KeyValue
            columns={1}
            items={[
              { label: 'Plans and products now', value: result.profile.products.length ? result.profile.products.map((p) => `${p.name} (since ${dateTime(p.since)})`).join(', ') : 'None' },
              { label: 'Groups', value: result.profile.groups.length ? result.profile.groups.map((g) => `${g.name}${g.automatic && !g.manual ? ' (automatic)' : ''}`).join(', ') : 'None' },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

// ---- Page --------------------------------------------------------------------------------------

function KindChooser({ value, onChange }: { value: ResourceKind; onChange: (k: ResourceKind) => void }) {
  return (
    <div role="radiogroup" aria-label="What to protect" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {KINDS.map((k) => {
        const Icon = k.icon;
        const selected = value === k.value;
        return (
          <button
            key={k.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(k.value)}
            className={clsx('flex items-start gap-2.5 rounded-ui-sm border p-3 text-left transition-colors', selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/40')}
          >
            <Icon className={clsx('mt-0.5 size-4 shrink-0', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{k.label}</span>
              <span className="block text-xs text-muted-foreground">{k.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ResourceForm({ resource }: { resource: ResourceDetail | null }) {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const editable = can('access.resources.manage') && !me?.admin.orgScope;
  const initial = useMemo(() => initialState(resource), [resource]);
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const options = useAccessOptions();
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const dirty = !resource || JSON.stringify(form) !== JSON.stringify(initial);
  const kind = form.kind;

  const save = useAction(
    () => {
      const { body, error: invalid } = requestBody(form, !resource);
      if (invalid) throw new Error(invalid);
      return resource ? api.patch<ResourceDetail>(`/api/admin/access/resources/${resource.id}`, body) : api.post<ResourceDetail>('/api/admin/access/resources', body);
    },
    {
      success: resource ? 'Saved' : 'Resource created',
      invalidate: [['access-resources'], ['access-resource'], ['access-options'], ['user-access-content']],
      onSuccess: (saved) => {
        setErrors({});
        if (!resource) navigate(`/content/resources/${saved.id}`, { replace: true });
      },
      onError: (e) => {
        setError(errorMessage(e));
        setErrors(e instanceof ApiError ? e.fieldErrors() : {});
      },
    },
  );
  const remove = useAction(() => api.delete(`/api/admin/access/resources/${resource!.id}`), {
    success: 'Resource deleted',
    invalidate: [['access-resources'], ['user-access-content']],
    onSuccess: () => navigate('/content/resources'),
  });

  const content: ReactNode =
    kind === 'url' || kind === 'folder' ? (
      <Field
        label={kind === 'url' ? 'Path' : 'Folder path'}
        htmlFor="res-path"
        error={errors.path}
        required
        hint={kind === 'url' ? 'One exact path in your app, e.g. /reports/annual. Query strings are ignored.' : 'Protects this path and everything below it, e.g. /members. A more specific URL or folder inside it takes precedence.'}
      >
        <Input id="res-path" value={form.path} onChange={(e) => set({ path: e.target.value })} disabled={!editable} required placeholder={kind === 'url' ? '/reports/annual' : '/members'} className="font-mono" invalid={Boolean(errors.path)} />
      </Field>
    ) : kind === 'link' ? (
      <Field label="URL" htmlFor="res-url" error={errors.url} required hint="Only customers with access receive this address (for example a community invite or a private video).">
        <Input id="res-url" type="url" value={form.url} onChange={(e) => set({ url: e.target.value })} disabled={!editable} required placeholder="https://" invalid={Boolean(errors.url)} />
      </Field>
    ) : kind === 'page' ? (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="res-body" className="text-sm font-medium">
            Content (HTML)<span className="text-danger"> *</span>
          </label>
          <Button variant="ghost" size="sm" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
        </div>
        {preview ? (
          <iframe
            title="Page preview"
            sandbox=""
            srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:0.875rem/1.6 system-ui,sans-serif;margin:1rem;color:#1f2937}img,video{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:0.25rem 0.5rem}</style>${form.body}`}
            className="h-80 w-full rounded-ui-sm border bg-white"
          />
        ) : (
          <Textarea id="res-body" rows={14} value={form.body} onChange={(e) => set({ body: e.target.value })} disabled={!editable} className="font-mono text-sm" invalid={Boolean(errors.body)} placeholder={'<h2>Welcome</h2>\n<p>…</p>'} />
        )}
        {errors.body ? (
          <p className="text-xs text-danger" role="alert">
            {errors.body}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Your app receives this HTML from the API. Scripts, styles, forms, embedded frames and unsafe links are removed when you save.</p>
        )}
      </div>
    ) : (
      <FilesEditor form={form} set={set} options={options.data} attached={resource?.files ?? []} disabled={!editable} error={errors.fileIds} />
    );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <PageHeader
        breadcrumbs={[{ label: 'Protected content', to: '/content/resources' }, { label: resource?.title ?? 'New' }]}
        title={resource ? resource.title : 'Protect content'}
        meta={
          resource && (
            <>
              <Badge>{kindMeta(resource.kind).label}</Badge>
              {resource.status !== 'active' && <Badge tone="warning">disabled</Badge>}
            </>
          )
        }
        actions={
          editable && (
            <>
              {resource && (
                <Button
                  variant="outline"
                  icon={<Trash2 className="size-4" />}
                  onClick={async () => {
                    const res = await confirm({
                      title: `Delete “${resource.title}”?`,
                      description: resource.kind === 'url' || resource.kind === 'folder' ? `${resource.path} will no longer be protected.` : 'Customers lose access to it. Files stay in Downloads.',
                      tone: 'danger',
                      confirmLabel: 'Delete',
                    });
                    if (res.confirmed) remove.mutate();
                  }}
                >
                  Delete
                </Button>
              )}
              <Button type="submit" loading={save.isPending} disabled={!dirty}>
                {resource ? 'Save changes' : 'Create'}
              </Button>
            </>
          )
        }
      />
      <div className="mb-4">
        <FormError message={error} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          {!resource && (
            <Card title="What do you want to protect?">
              <KindChooser value={kind} onChange={(k) => set({ kind: k })} />
            </Card>
          )}
          <Card title="Details">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Title" htmlFor="res-title" error={errors.title} required className="sm:col-span-2">
                <Input id="res-title" value={form.title} onChange={(e) => set({ title: e.target.value })} disabled={!editable} required maxLength={200} invalid={Boolean(errors.title)} />
              </Field>
              <Field label="Description" htmlFor="res-description" error={errors.description} hint="Shown to customers in their content list, also while it is locked." className="sm:col-span-2">
                <Textarea id="res-description" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} disabled={!editable} maxLength={2000} />
              </Field>
              <div className="space-y-3 sm:col-span-2">
                <Switch checked={form.active} onCheckedChange={(v) => set({ active: v })} disabled={!editable} label="Active" description="While disabled, nobody can open it (protected paths stay closed)." />
                <Switch checked={form.showLocked} onCheckedChange={(v) => set({ showLocked: v })} disabled={!editable} label="Show to customers without access" description="Listed as locked (title and description only), for example to invite an upgrade." />
              </div>
            </div>
          </Card>
          <Card title={kind === 'file' ? 'Files' : kind === 'page' ? 'Page' : kind === 'link' ? 'Link' : 'Protected path'}>{content}</Card>
          <Card title="Who can open it">
            <RulesEditor form={form} set={set} options={options.data} resource={resource} disabled={!editable} error={errors['rules.productIds'] ?? errors['rules.groupIds']} />
          </Card>
          <Card title="When it opens">
            <ReleaseEditor form={form} set={set} disabled={!editable} errors={errors} />
          </Card>
        </div>
        <div className="space-y-4">
          {resource ? (
            <>
              <TestAccess resource={resource} />
              <Card title="Last 30 days">
                <KeyValue
                  columns={1}
                  items={[
                    { label: 'Allowed', value: <span className="tabular">{num(resource.activity.allowed30d)}</span> },
                    { label: 'Refused', value: <span className="tabular">{num(resource.activity.denied30d)}</span> },
                    { label: 'Last access attempt', value: <When value={resource.activity.lastAccessAt} /> },
                  ]}
                />
                {can('access.log.view') && (
                  <ButtonLink to={`/content/log?resourceId=${resource.id}`} size="sm" className="mt-3">
                    View access log
                  </ButtonLink>
                )}
              </Card>
            </>
          ) : (
            <Callout title="How customers reach it">
              URLs and folders are checked by your app through the access API before it serves a page. Pages, links and downloads are listed and opened through the customer API, which only returns them to customers with access.
            </Callout>
          )}
        </div>
      </div>
    </form>
  );
}

export default function ResourceEditPage() {
  const { id } = useParams();
  const resource = useQuery({
    queryKey: ['access-resource', id],
    queryFn: () => api.get<ResourceDetail>(`/api/admin/access/resources/${id}`),
    enabled: Boolean(id),
  });
  if (!id) return <ResourceForm resource={null} />;
  if (resource.isLoading) return <PageSkeleton />;
  if (resource.error) {
    if (resource.error instanceof ApiError && resource.error.status === 404) {
      return <EmptyState title="Resource not found" description="It may have been deleted." action={<ButtonLink to="/content/resources">All protected content</ButtonLink>} />;
    }
    return <ErrorState error={resource.error} onRetry={() => void resource.refetch()} />;
  }
  const r = resource.data!;
  return <ResourceForm key={`${r.id}:${r.updatedAt}`} resource={r} />;
}

