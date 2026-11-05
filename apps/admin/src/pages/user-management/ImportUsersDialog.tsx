import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp } from 'lucide-react';
import clsx from 'clsx';
import { api, download, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { num } from '../../lib/format';
import { Badge, Button, Callout, Checkbox, DataTable, EmptyState, Field, FormError, Input, Modal, Select, StatusBadge, When, useToast } from '../../components/ui';
import type { ImportMapping, UploadedImport, UserImport } from './types';

type Step = 'upload' | 'map' | 'review' | 'run';

const STEPS: { id: Step; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'map', label: 'Match columns' },
  { id: 'review', label: 'Check' },
  { id: 'run', label: 'Import' },
];

const PROFILE_TARGETS: { key: Exclude<keyof ImportMapping, 'customFields' | 'email'>; label: string; hint?: string }[] = [
  { key: 'name', label: 'Full name' },
  { key: 'firstName', label: 'First name', hint: 'Combined with the last name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'phone', label: 'Phone' },
  { key: 'locale', label: 'Language' },
  { key: 'timezone', label: 'Time zone', hint: 'Names like Europe/Berlin' },
  { key: 'country', label: 'Country', hint: 'Two-letter codes' },
  { key: 'tags', label: 'Tags', hint: 'Separated by | , or ;' },
  { key: 'externalId', label: 'External ID', hint: 'Your application’s user ID' },
  { key: 'marketingConsent', label: 'Marketing consent', hint: 'Only an explicit yes grants consent' },
];

const RESULT_TONES = { created: 'success', updated: 'info', unchanged: 'neutral', skipped: 'neutral', failed: 'danger' } as const;

function Stepper({ step }: { step: Step }) {
  const index = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label="Import steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className={clsx('flex items-center gap-1.5', i === index ? 'font-medium text-foreground' : 'text-muted-foreground')} aria-current={i === index ? 'step' : undefined}>
          <span className={clsx('inline-flex size-5 items-center justify-center rounded-full text-2xs', i <= index ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{i + 1}</span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function Counts({ summary }: { summary: Partial<Record<keyof typeof RESULT_TONES, number>> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(RESULT_TONES) as (keyof typeof RESULT_TONES)[]).map((k) => (
        <Badge key={k} tone={summary[k] ? RESULT_TONES[k] : 'neutral'}>
          {num(summary[k] ?? 0)} {k === 'created' ? 'new' : k}
        </Badge>
      ))}
    </div>
  );
}

function problemsCsv(errors: UserImport['errors']): string {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return ['row,email,problem', ...errors.map((e) => [e.row, e.email, e.message].map(cell).join(','))].join('\n');
}

export function ImportUsersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const client = useQueryClient();
  const scoped = Boolean(me?.admin.orgScope);
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<UploadedImport | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({ email: '', customFields: {} });
  const [options, setOptions] = useState({ updateExisting: false, tags: '', orgId: '', markEmailVerified: false });
  const [checked, setChecked] = useState<UserImport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recent = useQuery({ queryKey: ['user-imports'], queryFn: () => api.get<Page<UserImport>>('/api/admin/users/imports', { pageSize: 5 }), enabled: open && step === 'upload' });
  const orgs = useQuery({
    queryKey: ['organizations', 'import-options'],
    queryFn: () => api.get<Page<{ id: string; name: string }>>('/api/admin/organizations', { pageSize: 100, sort: 'name', order: 'asc' }),
    enabled: open && step === 'map' && can('customers.organizations.view'),
    staleTime: 60_000,
  });
  const running = useQuery({
    queryKey: ['user-import', checked?.id],
    queryFn: () => api.get<UserImport>(`/api/admin/users/imports/${checked!.id}`),
    enabled: open && step === 'run' && Boolean(checked),
    refetchInterval: (q) => (q.state.data && ['completed', 'failed'].includes(q.state.data.status) ? false : 1500),
  });
  const run = running.data;

  useEffect(() => {
    if (run?.status === 'completed') void client.invalidateQueries({ queryKey: ['users'] });
  }, [run?.status, client]);

  const reset = () => {
    setStep('upload');
    setFile(null);
    setUploaded(null);
    setMapping({ email: '', customFields: {} });
    setOptions({ updateExisting: false, tags: '', orgId: '', markEmailVerified: false });
    setChecked(null);
    setError(null);
  };
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) reset();
  };

  const upload = useAction(
    () => {
      const form = new FormData();
      form.append('file', file!);
      return api.upload<UploadedImport>('/api/admin/users/imports', form);
    },
    {
      onSuccess: (res) => {
        setUploaded(res);
        setMapping({ email: '', customFields: {}, ...res.suggestedMapping });
        setError(null);
        setStep('map');
      },
      onError: (err) => setError(errorMessage(err)),
    },
  );

  const body = () => ({
    mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== '' && v !== undefined)),
    options: {
      updateExisting: options.updateExisting,
      orgId: options.orgId || undefined,
      tags: options.tags.split(',').map((t) => t.trim()).filter(Boolean),
      markEmailVerified: options.markEmailVerified,
    },
  });
  const dryRun = useAction(() => api.post<UserImport>(`/api/admin/users/imports/${uploaded!.id}/dry-run`, body()), {
    onSuccess: (res) => {
      setChecked(res);
      setError(null);
      setStep('review');
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const commit = useAction(() => api.post<UserImport>(`/api/admin/users/imports/${uploaded!.id}/commit`), {
    invalidate: [['user-imports']],
    onSuccess: (res) => {
      setChecked(res);
      setStep('run');
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const headers = uploaded?.headers ?? [];
  const sampleFor = (header: string | undefined) => {
    if (!header || !uploaded) return null;
    const i = headers.indexOf(header);
    return uploaded.sample.map((r) => r[i]).find(Boolean) ?? null;
  };
  const columnSelect = (id: string, value: string | undefined, onChange: (v: string) => void, required = false) => (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={required ? 'Choose a column' : 'Don’t import'} options={headers} />
  );
  const importable = useMemo(() => (checked?.summary ? checked.summary.created + checked.summary.updated + checked.summary.unchanged : 0), [checked]);

  let content: React.ReactNode;
  let footer: React.ReactNode;
  if (step === 'upload') {
    content = (
      <div className="space-y-4">
        <Field label="CSV file" htmlFor="import-file" hint="One customer per row with a header row. Up to 10,000 rows and 10 MB; comma, semicolon and tab separated files work.">
          <Input id="import-file" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Callout>Nothing is imported until you have matched the columns and checked the result.</Callout>
        {(recent.data?.data.length ?? 0) > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-medium">Recent imports</p>
            <ul className="divide-y rounded-ui border">
              {recent.data!.data.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{i.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      <When value={i.createdAt} /> · {num(i.rowCount)} rows{i.status === 'completed' && ` · ${num(i.progress.created)} new, ${num(i.progress.updated)} updated, ${num(i.progress.failed)} failed`}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={i.status} />
                    {(i.status === 'completed' || i.status === 'failed') && (
                      <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => download(`/api/admin/users/imports/${i.id}/results.csv`, undefined, 'results.csv').catch((err) => toast.error('Download failed', errorMessage(err)))}>
                        Results
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => close(false)}>
          Cancel
        </Button>
        <Button icon={<FileUp className="size-4" />} disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}>
          Upload
        </Button>
      </>
    );
  } else if (step === 'map' && uploaded) {
    content = (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {uploaded.filename} · {num(uploaded.rowCount)} rows. Match each customer field to a column. Empty cells never overwrite what is stored.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="map-email" required hint={sampleFor(mapping.email) ? `e.g. ${sampleFor(mapping.email)}` : 'Customers are matched by email address'}>
            {columnSelect('map-email', mapping.email, (v) => setMapping((m) => ({ ...m, email: v })), true)}
          </Field>
          {PROFILE_TARGETS.map((t) => {
            const disabled = (t.key === 'name' && Boolean(mapping.firstName || mapping.lastName)) || ((t.key === 'firstName' || t.key === 'lastName') && Boolean(mapping.name));
            const sample = sampleFor(mapping[t.key]);
            return (
              <Field key={t.key} label={t.label} htmlFor={`map-${t.key}`} hint={sample ? `e.g. ${sample}` : t.hint}>
                <Select
                  id={`map-${t.key}`}
                  value={mapping[t.key] ?? ''}
                  disabled={disabled}
                  onChange={(e) => setMapping((m) => ({ ...m, [t.key]: e.target.value || undefined }))}
                  placeholder="Don’t import"
                  options={headers}
                />
              </Field>
            );
          })}
          {uploaded.customFields.map((d) => (
            <Field key={d.key} label={d.label} htmlFor={`map-cf-${d.key}`} required={d.required} hint={sampleFor(mapping.customFields[d.key]) ? `e.g. ${sampleFor(mapping.customFields[d.key])}` : `Custom field (${d.type})`}>
              <Select
                id={`map-cf-${d.key}`}
                value={mapping.customFields[d.key] ?? ''}
                onChange={(e) =>
                  setMapping((m) => {
                    const customFields = { ...m.customFields };
                    if (e.target.value) customFields[d.key] = e.target.value;
                    else delete customFields[d.key];
                    return { ...m, customFields };
                  })
                }
                placeholder="Don’t import"
                options={headers}
              />
            </Field>
          ))}
        </div>
        <div className="space-y-3 rounded-ui border p-3">
          {can('customers.users.edit') && (
            <Checkbox
              checked={options.updateExisting}
              onChange={(e) => setOptions((o) => ({ ...o, updateExisting: e.target.checked }))}
              label="Update customers who already exist"
              description="Matched by email. Only filled cells are applied; tags are added, never removed."
            />
          )}
          <Checkbox
            checked={options.markEmailVerified}
            onChange={(e) => setOptions((o) => ({ ...o, markEmailVerified: e.target.checked }))}
            label="Mark new customers’ email addresses as verified"
            description="Only if the system you are importing from verified them."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Add tags" htmlFor="import-tags" hint="Comma separated, added to every imported customer">
              <Input id="import-tags" value={options.tags} onChange={(e) => setOptions((o) => ({ ...o, tags: e.target.value }))} placeholder="e.g. migrated-2026" />
            </Field>
            {orgs.data && (
              <Field label="Organization" htmlFor="import-org" required={scoped} hint="Every imported customer becomes a member">
                <Select id="import-org" value={options.orgId} onChange={(e) => setOptions((o) => ({ ...o, orgId: e.target.value }))} placeholder={scoped ? 'Choose an organization' : 'None'} options={orgs.data.data.map((o) => ({ value: o.id, label: o.name }))} />
              </Field>
            )}
          </div>
        </div>
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep('upload')}>
          Back
        </Button>
        <Button disabled={!mapping.email || (scoped && !options.orgId)} loading={dryRun.isPending} onClick={() => dryRun.mutate()}>
          Check file
        </Button>
      </>
    );
  } else if (step === 'review' && checked?.summary) {
    content = (
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-sm font-medium">What the import will do</p>
          <Counts summary={checked.summary} />
        </div>
        {checked.summary.failed > 0 ? (
          <>
            <Callout tone="warning" title={`${num(checked.summary.failed)} row${checked.summary.failed === 1 ? '' : 's'} will be skipped`}>
              Fix them in the file and import it again, or continue without them. {checked.errors.length < checked.summary.failed && `The first ${num(checked.errors.length)} are listed.`}
            </Callout>
            <div className="max-h-72 overflow-y-auto rounded-ui border">
              <DataTable
                caption="Rows with problems"
                rows={checked.errors}
                rowKey={(e) => String(e.row)}
                columns={[
                  { key: 'row', header: 'Row', cell: (e) => <span className="tabular">{e.row}</span>, width: '4rem' },
                  { key: 'email', header: 'Email', cell: (e) => <span className="block max-w-48 truncate">{e.email ?? '—'}</span> },
                  { key: 'message', header: 'Problem', cell: (e) => <span className="text-danger">{e.message}</span> },
                ]}
              />
            </div>
          </>
        ) : (
          <Callout tone="success">Every row can be imported.</Callout>
        )}
      </div>
    );
    footer = (
      <>
        {checked.errors.length > 0 && (
          <Button
            variant="ghost"
            icon={<Download className="size-4" />}
            onClick={() => {
              const url = URL.createObjectURL(new Blob([problemsCsv(checked.errors)], { type: 'text/csv' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = 'import-problems.csv';
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Problems
          </Button>
        )}
        <Button variant="outline" onClick={() => setStep('map')}>
          Back
        </Button>
        <Button disabled={!importable} loading={commit.isPending} onClick={() => commit.mutate()}>
          Import {num(importable)} customer{importable === 1 ? '' : 's'}
        </Button>
      </>
    );
  } else {
    const total = run?.rowCount ?? checked?.rowCount ?? 0;
    const processed = run?.progress.processed ?? 0;
    const finished = run?.status === 'completed' || run?.status === 'failed';
    content = (
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span className="font-medium">{run?.status === 'completed' ? 'Import finished' : run?.status === 'failed' ? 'Import stopped' : 'Importing…'}</span>
            <span className="tabular text-muted-foreground">
              {num(processed)} / {num(total)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={processed}>
            <div className="h-full bg-primary transition-[width]" style={{ width: `${total ? Math.round((processed / total) * 100) : 0}%` }} />
          </div>
        </div>
        {run && <Counts summary={run.progress} />}
        {run?.status === 'failed' && <Callout tone="danger" title="The import stopped">{run.error ?? 'An unexpected error occurred.'} Rows already processed are listed in the results.</Callout>}
        {!finished && <p className="text-sm text-muted-foreground">You can close this window; the import continues in the background and appears under recent imports.</p>}
      </div>
    );
    footer = (
      <>
        {finished && (
          <Button variant="outline" icon={<Download className="size-4" />} onClick={() => download(`/api/admin/users/imports/${checked!.id}/results.csv`, undefined, 'results.csv').catch((err) => toast.error('Download failed', errorMessage(err)))}>
            Download results
          </Button>
        )}
        <Button onClick={() => close(false)}>{finished ? 'Done' : 'Close'}</Button>
      </>
    );
  }

  return (
    <Modal open={open} onOpenChange={close} size="lg" title="Import customers" description="Create customers from a CSV file, and optionally update the ones that already exist." footer={footer}>
      <Stepper step={step} />
      <FormError message={error} />
      {content ?? <EmptyState title="Nothing to show" />}
    </Modal>
  );
}
