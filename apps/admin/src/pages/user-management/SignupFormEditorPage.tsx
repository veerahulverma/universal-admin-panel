import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MoreHorizontal, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Button, Callout, Card, Checkbox, CodeBlock, ErrorState, Field, FormError, Input, Menu, PageHeader, PageSkeleton, Select, Switch, Textarea, useConfirm } from '../../components/ui';
import type { FormField, SignupForm, SignupFormOptions } from './types';

interface Draft {
  name: string;
  key: string;
  description: string;
  active: boolean;
  fields: FormField[];
  agreementId: string;
  planIds: string[];
  redirectUrl: string;
  tags: string;
}

function draftOf(f: SignupForm): Draft {
  return {
    name: f.name,
    key: f.key,
    description: f.description,
    active: f.active,
    fields: f.fields,
    agreementId: f.agreementId ?? '',
    planIds: f.planIds,
    redirectUrl: f.redirectUrl ?? '',
    tags: f.tags.join(', '),
  };
}

function payload(d: Draft) {
  return {
    name: d.name,
    key: d.key,
    description: d.description,
    active: d.active,
    fields: d.fields.map((f) => ({ ...f, label: f.label?.trim() || undefined, helpText: f.helpText?.trim() || undefined })),
    agreementId: d.agreementId || null,
    planIds: d.planIds,
    redirectUrl: d.redirectUrl.trim() || null,
    tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
  };
}

function FieldRow({ field, label, typeLabel, locked, onChange, onMove, onRemove, first, last, readOnly }: {
  field: FormField;
  label: string;
  typeLabel: string;
  /** Required for every customer (a required custom field): cannot be optional or removed. */
  locked: boolean;
  onChange: (f: FormField) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  first: boolean;
  last: boolean;
  readOnly: boolean;
}) {
  const consent = field.type === 'profile' && field.key === 'marketingConsent';
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">
          {label} <Badge>{typeLabel}</Badge>
        </span>
        <Checkbox
          checked={field.required || locked}
          disabled={readOnly || consent || locked}
          onChange={(e) => onChange({ ...field, required: e.target.checked })}
          label="Required"
        />
        {!readOnly && (
          <span className="flex items-center">
            <Button variant="ghost" size="icon-sm" aria-label={`Move ${label} up`} disabled={first} onClick={() => onMove(-1)}>
              <ArrowUp className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Move ${label} down`} disabled={last} onClick={() => onMove(1)}>
              <ArrowDown className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${label}`} disabled={locked} onClick={onRemove}>
              <X className="size-4" />
            </Button>
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label={`Label for ${label}`} value={field.label ?? ''} placeholder={`Label (default: ${label})`} disabled={readOnly} onChange={(e) => onChange({ ...field, label: e.target.value })} maxLength={100} />
        <Input aria-label={`Help text for ${label}`} value={field.helpText ?? ''} placeholder="Help text (optional)" disabled={readOnly} onChange={(e) => onChange({ ...field, helpText: e.target.value })} maxLength={300} />
      </div>
      {consent && <p className="text-xs text-muted-foreground">Consent is always optional and starts unchecked.</p>}
    </li>
  );
}

export default function SignupFormEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const readOnly = !can('customers.forms.manage');
  const form = useQuery({ queryKey: ['signup-form', id], queryFn: () => api.get<SignupForm>(`/api/admin/signup-forms/${id}`) });
  const options = useQuery({ queryKey: ['signup-form-options'], queryFn: () => api.get<SignupFormOptions>('/api/admin/signup-forms/options') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (form.data) setDraft(draftOf(form.data));
  }, [form.data]);

  const dirty = useMemo(() => Boolean(form.data && draft && JSON.stringify(payload(draft)) !== JSON.stringify(payload(draftOf(form.data)))), [form.data, draft]);
  const save = useAction(() => api.patch<SignupForm>(`/api/admin/signup-forms/${id}`, payload(draft!)), {
    success: 'Signup form saved',
    invalidate: [['signup-form', id], ['signup-forms']],
    onSuccess: () => setError(null),
    onError: (err) => setError(errorMessage(err)),
  });
  const remove = useAction(() => api.delete(`/api/admin/signup-forms/${id}`), {
    success: 'Signup form deleted',
    invalidate: [['signup-forms']],
    onSuccess: () => navigate('/customers/signup-forms'),
  });

  if (form.isLoading || options.isLoading || (form.data && !draft)) return <PageSkeleton />;
  if (form.error || options.error || !form.data || !options.data || !draft) return <ErrorState error={form.error ?? options.error} onRetry={() => void form.refetch()} />;
  const opts = options.data;
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const describe = (f: FormField) => {
    if (f.type === 'profile') return { label: opts.profileFields.find((p) => p.key === f.key)?.label ?? f.key, typeLabel: 'profile', locked: false };
    const def = opts.customFields.find((c) => c.key === f.key);
    return { label: def?.label ?? f.key, typeLabel: def ? `custom · ${def.type}` : 'missing field', locked: Boolean(def?.required) };
  };
  const unused = [
    { label: 'Profile', options: opts.profileFields.filter((p) => !draft.fields.some((f) => f.type === 'profile' && f.key === p.key)).map((p) => ({ value: `profile:${p.key}`, label: p.label })) },
    { label: 'Custom fields', options: opts.customFields.filter((c) => !draft.fields.some((f) => f.type === 'custom' && f.key === c.key)).map((c) => ({ value: `custom:${c.key}`, label: c.label })) },
  ].filter((g) => g.options.length);
  const moveField = (i: number, delta: number) => {
    const fields = [...draft.fields];
    [fields[i], fields[i + delta]] = [fields[i + delta], fields[i]];
    set({ fields });
  };
  const missingRequired = opts.customFields.filter((c) => c.required && !draft.fields.some((f) => f.type === 'custom' && f.key === c.key));
  const example = JSON.stringify(
    {
      email: 'customer@example.com',
      password: '…',
      formKey: draft.key,
      fields: Object.fromEntries(draft.fields.map((f) => [f.key, f.key === 'marketingConsent' ? false : '…'])),
      ...(draft.agreementId ? { agreementVersionId: 'agreement.versionId from the form' } : {}),
      ...(draft.planIds.length ? { plan: 'a plan key from the form' } : {}),
      ip: 'the customer’s IP address',
    },
    null,
    2,
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Signup forms', to: '/customers/signup-forms' }, { label: form.data.name }]}
        title={form.data.name}
        meta={
          <>
            <code className="font-mono text-xs text-muted-foreground">{form.data.key}</code>
            {form.data.active ? <Badge tone="success" dot>active</Badge> : <Badge dot>inactive</Badge>}
          </>
        }
        actions={
          !readOnly && (
            <>
              <Button variant="outline" disabled={!dirty} onClick={() => setDraft(draftOf(form.data!))}>
                Discard
              </Button>
              <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
              <Menu
                trigger={
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
                items={[
                  {
                    label: 'Delete form',
                    icon: <Trash2 className="size-4" />,
                    danger: true,
                    onSelect: async () => {
                      if ((await confirm({ title: `Delete ${form.data!.name}?`, description: 'Apps using this form key can no longer register customers with it. Customers who signed up keep the form key in their metadata.', tone: 'danger', confirmLabel: 'Delete' })).confirmed) remove.mutate();
                    },
                  },
                ]}
              />
            </>
          )
        }
      />
      <div className="mb-4">
        <FormError message={error} />
      </div>
      {missingRequired.length > 0 && (
        <div className="mb-4">
          <Callout tone="warning" title="Required custom fields are missing">
            {missingRequired.map((c) => c.label).join(', ')} must be on every signup form. Add {missingRequired.length === 1 ? 'it' : 'them'} before saving.
          </Callout>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Details">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="sf-name" required>
                <Input id="sf-name" value={draft.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Key" htmlFor="sf-key" required hint="Changing it breaks apps that use the old key">
                <Input id="sf-key" className="font-mono" value={draft.key} disabled={readOnly} onChange={(e) => set({ key: e.target.value })} />
              </Field>
              <Field label="Description" htmlFor="sf-desc" className="sm:col-span-2" hint="Your app can show it above the form">
                <Textarea id="sf-desc" rows={2} value={draft.description} disabled={readOnly} onChange={(e) => set({ description: e.target.value })} />
              </Field>
              <Field label="After signup, go to" htmlFor="sf-redirect" hint="Returned to your app with the registration">
                <Input id="sf-redirect" type="url" value={draft.redirectUrl} disabled={readOnly} onChange={(e) => set({ redirectUrl: e.target.value })} placeholder="https://app.example.com/welcome" />
              </Field>
              <Field label="Tag new customers" htmlFor="sf-tags" hint="Comma separated">
                <Input id="sf-tags" value={draft.tags} disabled={readOnly} onChange={(e) => set({ tags: e.target.value })} placeholder="e.g. partner" />
              </Field>
              <div className="sm:col-span-2">
                <Switch checked={draft.active} disabled={readOnly} onCheckedChange={(active) => set({ active })} label="Active" description="Inactive forms are not served and registrations through them are refused." />
              </div>
            </div>
          </Card>
          <Card
            title="Fields"
            description="Email is always asked for (and a password when built-in sign-in is on)."
            padded={false}
            actions={
              !readOnly &&
              unused.length > 0 && (
                <Select
                  aria-label="Add a field"
                  className="w-auto"
                  value=""
                  placeholder="Add a field…"
                  options={unused}
                  onChange={(e) => {
                    const [type, key] = e.target.value.split(':') as [FormField['type'], string];
                    if (key) set({ fields: [...draft.fields, { type, key, required: false }] });
                  }}
                />
              )
            }
          >
            <ul className="divide-y">
              <li className="flex items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="font-medium">
                  Email <Badge>profile</Badge>
                </span>
                <span className="text-xs text-muted-foreground">Always required</span>
              </li>
              {draft.fields.map((f, i) => {
                const d = describe(f);
                return (
                  <FieldRow
                    key={`${f.type}:${f.key}`}
                    field={f}
                    {...d}
                    readOnly={readOnly}
                    first={i === 0}
                    last={i === draft.fields.length - 1}
                    onChange={(next) => set({ fields: draft.fields.map((x, j) => (j === i ? next : x)) })}
                    onMove={(delta) => moveField(i, delta)}
                    onRemove={() => set({ fields: draft.fields.filter((_, j) => j !== i) })}
                  />
                );
              })}
            </ul>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Agreement" description="Customers must accept it to sign up; the acceptance is recorded with their IP address.">
            <Select aria-label="Agreement" value={draft.agreementId} disabled={readOnly} onChange={(e) => set({ agreementId: e.target.value })} placeholder="None" options={opts.agreements.map((a) => ({ value: a.id, label: a.title }))} />
          </Card>
          <Card title="Plans" description="Offered on the pricing step. None selected: your public plans.">
            {opts.plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">No plans in the catalog.</p>
            ) : (
              <div className="space-y-2">
                {opts.plans.map((p) => (
                  <Checkbox
                    key={p.id}
                    checked={draft.planIds.includes(p.id)}
                    disabled={readOnly}
                    onChange={(e) => set({ planIds: e.target.checked ? [...draft.planIds, p.id] : draft.planIds.filter((x) => x !== p.id) })}
                    label={
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {p.name}
                        {!p.public && <Badge>hidden</Badge>}
                        {p.status !== 'active' && <Badge tone="warning">{p.status}</Badge>}
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </Card>
          <Card title="Use it in your app">
            <div className="space-y-3">
              <Field label="Load the form">
                <CodeBlock code={`GET /api/public/signup-forms/${draft.key}`} />
              </Field>
              <Field label="Register (built-in sign-in)">
                <CodeBlock code={`POST /api/v1/identity/register\n${example}`} />
              </Field>
              <p className="text-xs text-muted-foreground">Apps with their own sign-in send the same formKey, agreementVersionId and plan to POST /api/v1/users.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
