import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, Mail, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { num } from '../../lib/format';
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KpiTile,
  PageHeader,
  PageSkeleton,
  Pagination,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  Toolbar,
  When,
  useConfirm,
  useToast,
} from '../../components/ui';
import { PreviewPanel } from '../growth/email-preview';
import { ProductChecklist } from '../lists/shared';
import { STOP_REASONS, TRIGGERS, describeDelay, splitDelay, toMinutes, type DelayUnit, type SequenceDetail, type SequenceTrigger, type StepRow } from './shared';

interface StepDraft {
  id?: string;
  amount: string;
  unit: DelayUnit;
  mode: 'custom' | 'template';
  templateKey: string;
  subject: string;
  html: string;
  text: string;
  stats?: StepRow['stats'];
}

const STARTER_HTML = '<p>Hi{{#if recipient.name}} {{recipient.name}}{{/if}},</p>\n<p>Write your message here.</p>\n<p><a href="{{appUrl}}">Open {{appName}}</a></p>';

const newStep = (first: boolean): StepDraft => ({ amount: first ? '0' : '2', unit: 'days', mode: 'custom', templateKey: '', subject: '', html: STARTER_HTML, text: '' });

function toDraft(s: StepRow): StepDraft {
  const { amount, unit } = splitDelay(s.delay_minutes);
  return { id: s.id, amount: String(amount), unit, mode: s.template_key ? 'template' : 'custom', templateKey: s.template_key ?? '', subject: s.subject, html: s.html, text: s.text ?? '', stats: s.stats };
}

function toInput(d: StepDraft) {
  const delayMinutes = toMinutes(Number(d.amount) || 0, d.unit);
  return d.mode === 'template'
    ? { id: d.id, delayMinutes, templateKey: d.templateKey || null }
    : { id: d.id, delayMinutes, templateKey: null, subject: d.subject, html: d.html, text: d.text || null };
}

/** Sample values for the variables a sequence email can use. */
const SAMPLE = { productName: 'Pro', renewsAt: '2026-06-01', endedAt: '2026-05-31' };

function StepCard({
  step,
  index,
  count,
  editable,
  sequenceName,
  templates,
  errors,
  onChange,
  onMove,
  onRemove,
  onTest,
}: {
  step: StepDraft;
  index: number;
  count: number;
  editable: boolean;
  sequenceName: string;
  templates: { key: string; name: string }[];
  errors: Record<string, string>;
  onChange: (s: StepDraft) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onTest?: () => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  const err = (k: string) => errors[`steps.${index}.${k}`];
  const set = (patch: Partial<StepDraft>) => onChange({ ...step, ...patch });
  const minutes = toMinutes(Number(step.amount) || 0, step.unit);
  return (
    <Card
      title={`Email ${index + 1}`}
      description={describeDelay(minutes, index === 0)}
      actions={
        <span className="inline-flex flex-wrap gap-1">
          {step.mode === 'custom' && (
            <Button size="icon-sm" variant="ghost" aria-label={previewing ? 'Hide preview' : 'Preview'} aria-pressed={previewing} onClick={() => setPreviewing((p) => !p)}>
              <Eye className="size-4" />
            </Button>
          )}
          {onTest && (
            <Button size="icon-sm" variant="ghost" aria-label="Send this email to yourself" onClick={onTest}>
              <Mail className="size-4" />
            </Button>
          )}
          {editable && (
            <>
              <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
                <ArrowUp className="size-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
                <ArrowDown className="size-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove email ${index + 1}`} onClick={onRemove}>
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </span>
      }
    >
      <div className="space-y-3">
        {step.stats && (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{num(step.stats.queued)} sent</span>
            {step.stats.suppressed > 0 && <span>{num(step.stats.suppressed)} not sent (consent or opt-out)</span>}
            {step.stats.failed > 0 && <span className="text-danger">{num(step.stats.failed)} failed</span>}
            <span>{num(step.stats.opened)} opened</span>
            <span>{num(step.stats.clicked)} clicked</span>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-[8rem_9rem_minmax(0,1fr)]">
          <Field label="Wait" htmlFor={`st-amount-${index}`} error={err('delayMinutes')}>
            <Input id={`st-amount-${index}`} type="number" min={0} step={1} value={step.amount} disabled={!editable} onChange={(e) => set({ amount: e.target.value })} />
          </Field>
          <Field label="Unit" htmlFor={`st-unit-${index}`}>
            <Select id={`st-unit-${index}`} value={step.unit} disabled={!editable} onChange={(e) => set({ unit: e.target.value as DelayUnit })} options={[{ value: 'days', label: 'days' }, { value: 'hours', label: 'hours' }, { value: 'minutes', label: 'minutes' }]} />
          </Field>
          <Field label="Content" htmlFor={`st-mode-${index}`}>
            <Select id={`st-mode-${index}`} value={step.mode} disabled={!editable} onChange={(e) => set({ mode: e.target.value as StepDraft['mode'] })} options={[{ value: 'custom', label: 'Written here' }, { value: 'template', label: 'An email template' }]} />
          </Field>
        </div>
        {step.mode === 'template' ? (
          <Field label="Template" htmlFor={`st-template-${index}`} error={err('templateKey') ?? err('html')} hint="Translations are picked per recipient language; edit the wording in Email templates">
            <Select id={`st-template-${index}`} value={step.templateKey} disabled={!editable} onChange={(e) => set({ templateKey: e.target.value })} placeholder="Choose a template" options={templates.map((t) => ({ value: t.key, label: `${t.name} (${t.key})` }))} />
          </Field>
        ) : (
          <>
            <Field label="Subject" htmlFor={`st-subject-${index}`} error={err('subject')}>
              <Input id={`st-subject-${index}`} value={step.subject} disabled={!editable} maxLength={500} onChange={(e) => set({ subject: e.target.value })} />
            </Field>
            <Field
              label="HTML body"
              htmlFor={`st-html-${index}`}
              error={err('html')}
              hint="Variables: {{recipient.name}}, {{appName}}, {{appUrl}}, {{productName}}, {{renewsAt}}, {{endedAt}}. The unsubscribe footer is added automatically."
            >
              <Textarea id={`st-html-${index}`} rows={8} value={step.html} disabled={!editable} onChange={(e) => set({ html: e.target.value })} className="font-mono text-xs" spellCheck={false} />
            </Field>
            <Field label="Plain-text version" htmlFor={`st-text-${index}`} hint="Optional; generated from the HTML when empty" error={err('text')}>
              <Textarea id={`st-text-${index}`} rows={3} value={step.text} disabled={!editable} onChange={(e) => set({ text: e.target.value })} className="font-mono text-xs" />
            </Field>
            {previewing && (
              <PreviewPanel input={step.html ? { subject: step.subject, html: step.html, text: step.text || null, category: 'marketing', data: { ...SAMPLE, sequence: { name: sequenceName } } } : null} description="Rendered with sample data; unsaved changes included" />
            )}
          </>
        )}
      </div>
    </Card>
  );
}

interface EnrollmentRow {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  trigger_ref: string;
  status: 'active' | 'completed' | 'stopped';
  stop_reason: string | null;
  steps_sent: number;
  next_run_at: string | null;
  enrolled_at: string;
  finished_at: string | null;
}

function PeopleTab({ seq }: { seq: SequenceDetail }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const rows = useQuery({
    queryKey: ['sequence-enrollments', seq.id, status, page],
    queryFn: () => api.get<Page<EnrollmentRow>>(`/api/admin/email/sequences/${seq.id}/enrollments`, { status, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const stop = useAction((enrollmentId: string) => api.post(`/api/admin/email/sequences/${seq.id}/enrollments/${enrollmentId}/stop`), {
    success: 'Taken out of the autoresponder',
    invalidate: [['sequence-enrollments', seq.id], ['email-sequence', seq.id]],
  });
  return (
    <Card padded={false}>
      <Toolbar>
        <Select
          aria-label="Status"
          className="w-auto"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          placeholder="Everyone"
          options={[
            { value: 'active', label: 'In progress' },
            { value: 'completed', label: 'Completed' },
            { value: 'stopped', label: 'Stopped' },
          ]}
        />
      </Toolbar>
      {rows.error ? (
        <ErrorState error={rows.error} onRetry={() => void rows.refetch()} />
      ) : (
        <DataTable
          caption="Enrolled people"
          rows={rows.data?.data}
          loading={rows.isLoading}
          fetching={rows.isFetching && !rows.isLoading}
          rowKey={(e) => e.id}
          empty={<EmptyState title="Nobody enrolled yet" description={seq.status === 'active' ? 'People are enrolled when the trigger happens.' : 'Activate the autoresponder to start enrolling people.'} />}
          columns={[
            {
              key: 'person',
              header: 'Person',
              cell: (e) => (
                <Link to={`/customers/users/${e.user_id}`} className="block min-w-0 hover:underline">
                  <span className="block truncate">{e.name || e.email}</span>
                  {e.name && <span className="block truncate text-xs text-muted-foreground">{e.email}</span>}
                </Link>
              ),
            },
            { key: 'status', header: 'Status', cell: (e) => (e.status === 'stopped' ? <Badge tone="warning">{STOP_REASONS[e.stop_reason ?? ''] ?? e.stop_reason ?? 'stopped'}</Badge> : <StatusBadge status={e.status === 'active' ? 'running' : 'completed'} />) },
            { key: 'sent', header: 'Emails sent', align: 'right', cell: (e) => <span className="tabular">{num(e.steps_sent)}</span> },
            { key: 'next', header: 'Next email', cell: (e) => (e.next_run_at ? <When value={e.next_run_at} /> : <span className="text-muted-foreground">—</span>) },
            { key: 'enrolled', header: 'Enrolled', priority: 'low', cell: (e) => <When value={e.enrolled_at} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (e) =>
                can('email.autoresponders.manage') && e.status === 'active' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if ((await confirm({ title: `Stop sending to ${e.email}?`, description: 'They receive no more emails from this autoresponder for this enrolment.', confirmLabel: 'Stop' })).confirmed) stop.mutate(e.id);
                    }}
                  >
                    Stop
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {rows.data && <Pagination page={rows.data.page} pageSize={rows.data.pageSize} total={rows.data.total} onPage={setPage} />}
    </Card>
  );
}

function SequenceForm({ seq }: { seq: SequenceDetail | null }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const editable = can('email.autoresponders.manage');
  const [tab, setTab] = useState('emails');
  const [form, setForm] = useState({
    name: seq?.name ?? '',
    description: seq?.description ?? '',
    trigger: (seq?.trigger_type ?? 'signup') as SequenceTrigger,
    productIds: seq?.product_ids ?? [],
    daysBefore: String(seq?.days_before ?? 7),
  });
  const [steps, setSteps] = useState<StepDraft[]>(seq ? seq.steps.map(toDraft) : [newStep(true)]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ['email-templates', { category: 'marketing' }],
    queryFn: () => api.get<{ data: { key: string; name: string }[] }>('/api/admin/email/templates', { category: 'marketing' }),
    enabled: can('email.templates.view'),
  });
  const uniqueTemplates = [...new Map((templates.data?.data ?? []).map((t) => [t.key, t])).values()];
  const productTrigger = form.trigger !== 'signup';

  const body = useMemo(
    () => ({
      name: form.name,
      description: form.description,
      trigger: form.trigger,
      productIds: productTrigger ? form.productIds : [],
      daysBefore: form.trigger === 'renewal_upcoming' ? Number(form.daysBefore) || null : null,
      steps: steps.map(toInput),
    }),
    [form, steps, productTrigger],
  );
  const saved = useMemo(
    () =>
      seq && {
        name: seq.name,
        description: seq.description,
        trigger: seq.trigger_type,
        productIds: seq.trigger_type !== 'signup' ? seq.product_ids : [],
        daysBefore: seq.trigger_type === 'renewal_upcoming' ? seq.days_before : null,
        steps: seq.steps.map(toDraft).map(toInput),
      },
    [seq],
  );
  const dirty = !seq || JSON.stringify(body) !== JSON.stringify(saved);

  const save = useAction(() => (seq ? api.put<SequenceDetail>(`/api/admin/email/sequences/${seq.id}`, body) : api.post<SequenceDetail>('/api/admin/email/sequences', body)), {
    success: seq ? 'Autoresponder saved' : 'Autoresponder created as a draft',
    invalidate: [['email-sequences'], ['email-sequence']],
    onSuccess: (s) => {
      setErrors({});
      setError(null);
      if (!seq) navigate(`/growth/email/autoresponders/${s.id}`, { replace: true });
    },
    onError: (e) => {
      setError(errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors());
    },
  });
  const setStatus = useAction((status: 'active' | 'paused') => api.post(`/api/admin/email/sequences/${seq!.id}/status`, { status }), {
    success: (_r, status) => (status === 'active' ? 'Autoresponder is active' : 'Autoresponder paused'),
    invalidate: [['email-sequences'], ['email-sequence']],
  });
  const remove = useAction(() => api.delete(`/api/admin/email/sequences/${seq!.id}`), { success: 'Autoresponder deleted', invalidate: [['email-sequences']], onSuccess: () => navigate('/growth/email/autoresponders') });
  const test = useAction((stepId: string) => api.post<{ status: string; reason: string | null }>(`/api/admin/email/sequences/${seq!.id}/test`, { stepId }), {
    onSuccess: (r) => (r.status === 'queued' ? toast.success('Test email sent to you', 'Saved version, sample data, marked as a test.') : toast.error('Test not sent', r.reason ?? undefined)),
  });

  const move = (i: number, dir: -1 | 1) =>
    setSteps((list) => {
      const next = [...list];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      return next;
    });

  const editor = (
    <div className="space-y-4">
      <Card title="Trigger">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="sq-name" error={errors.name} required>
            <Input id="sq-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!editable} maxLength={200} required placeholder="Onboarding" />
          </Field>
          <Field label="Starts when someone…" htmlFor="sq-trigger" error={errors.trigger} hint={TRIGGERS.find((x) => x.value === form.trigger)?.description}>
            <Select id="sq-trigger" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value as SequenceTrigger })} disabled={!editable} options={TRIGGERS.map((x) => ({ value: x.value, label: x.label }))} />
          </Field>
          {form.trigger === 'renewal_upcoming' && (
            <Field label="Days before the renewal" htmlFor="sq-days" error={errors.daysBefore}>
              <Input id="sq-days" type="number" min={1} max={365} step={1} value={form.daysBefore} onChange={(e) => setForm({ ...form, daysBefore: e.target.value })} disabled={!editable} />
            </Field>
          )}
          <Field label="Description" htmlFor="sq-desc" className="sm:col-span-2">
            <Textarea id="sq-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!editable} maxLength={1000} />
          </Field>
          {productTrigger && (
            <Field label="Only for these products" className="sm:col-span-2" hint="Leave empty for any product" error={errors.productIds}>
              <ProductChecklist value={form.productIds} onChange={(ids) => setForm({ ...form, productIds: ids })} disabled={!editable} label="Products that start this autoresponder" />
            </Field>
          )}
        </div>
      </Card>
      {errors.steps && <Callout tone="danger">{errors.steps}</Callout>}
      {steps.map((s, i) => (
        <StepCard
          key={s.id ?? `new-${i}`}
          step={s}
          index={i}
          count={steps.length}
          editable={editable}
          sequenceName={form.name}
          templates={uniqueTemplates}
          errors={errors}
          onChange={(next) => setSteps((list) => list.map((x, j) => (j === i ? next : x)))}
          onMove={(dir) => move(i, dir)}
          onRemove={() => setSteps((list) => list.filter((_, j) => j !== i))}
          onTest={seq && s.id && editable ? () => test.mutate(s.id!) : undefined}
        />
      ))}
      {editable && steps.length < 20 && (
        <Button variant="outline" icon={<Plus className="size-4" />} onClick={() => setSteps((list) => [...list, newStep(list.length === 0)])}>
          Add email
        </Button>
      )}
      {seq && seq.status !== 'draft' && <p className="text-xs text-muted-foreground">Edits apply to people who have not reached that email yet. An email keeps its history when reworded, so nobody receives it twice.</p>}
    </div>
  );

  const counts = seq?.enrollments ?? {};
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <PageHeader
        breadcrumbs={[{ label: 'Autoresponders', to: '/growth/email/autoresponders' }, { label: seq?.name ?? 'New autoresponder' }]}
        title={seq ? seq.name : 'New autoresponder'}
        meta={seq && <StatusBadge status={seq.status} />}
        actions={
          editable && (
            <>
              {seq && seq.status !== 'active' && (
                <Button variant="outline" icon={<Play className="size-4" />} loading={setStatus.isPending} disabled={dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => setStatus.mutate('active')}>
                  Activate
                </Button>
              )}
              {seq && seq.status === 'active' && (
                <Button variant="outline" icon={<Pause className="size-4" />} loading={setStatus.isPending} onClick={() => setStatus.mutate('paused')}>
                  Pause
                </Button>
              )}
              {seq && (
                <Button
                  variant="outline"
                  icon={<Trash2 className="size-4" />}
                  onClick={async () => {
                    const r = await confirm({ title: `Delete “${seq.name}”?`, description: 'Everyone in it stops receiving its emails. Emails already sent stay in the email log.', tone: 'danger', confirmLabel: 'Delete' });
                    if (r.confirmed) remove.mutate();
                  }}
                >
                  Delete
                </Button>
              )}
              <Button type="submit" loading={save.isPending} disabled={!dirty}>
                {seq ? (dirty ? 'Save changes' : 'Saved') : 'Create draft'}
              </Button>
            </>
          )
        }
      />
      <div className="mb-4 space-y-3">
        <FormError message={error} />
        {seq?.status === 'draft' && <Callout title="Draft">Nobody is enrolled until you activate it.</Callout>}
        {seq?.status === 'paused' && <Callout tone="warning" title="Paused">No new enrolments and no emails until you activate it again; people already in it wait where they are.</Callout>}
      </div>
      {seq ? (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
            <KpiTile label="In progress" value={counts.active ?? 0} display={num(counts.active ?? 0)} />
            <KpiTile label="Completed" value={counts.completed ?? 0} display={num(counts.completed ?? 0)} />
            <KpiTile label="Stopped" value={counts.stopped ?? 0} display={num(counts.stopped ?? 0)} hint={seq.stopReasons.slice(0, 2).map((r) => `${num(r.count)} ${(STOP_REASONS[r.reason] ?? r.reason).toLowerCase()}`).join(' · ') || undefined} />
          </div>
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: 'emails', label: 'Emails', content: editor },
              { value: 'people', label: 'People', content: tab === 'people' && <PeopleTab seq={seq} /> },
            ]}
          />
        </>
      ) : (
        editor
      )}
    </form>
  );
}

export default function SequenceEditorPage() {
  const { id } = useParams();
  const seq = useQuery({ queryKey: ['email-sequence', id], queryFn: () => api.get<SequenceDetail>(`/api/admin/email/sequences/${id}`), enabled: Boolean(id) });
  if (!id) return <SequenceForm seq={null} />;
  if (seq.isLoading) return <PageSkeleton />;
  if (seq.error instanceof ApiError && seq.error.status === 404) {
    return <EmptyState title="Autoresponder not found" description="It may have been deleted." action={<ButtonLink to="/growth/email/autoresponders">All autoresponders</ButtonLink>} />;
  }
  if (seq.error || !seq.data) return <ErrorState error={seq.error} onRetry={() => void seq.refetch()} />;
  return <SequenceForm key={`${seq.data.id}:${seq.data.updated_at}:${seq.data.status}`} seq={seq.data} />;
}
