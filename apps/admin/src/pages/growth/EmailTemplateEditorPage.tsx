import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Languages, MoreHorizontal, RotateCcw, Send, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { titleCase } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorState,
  Field,
  FormError,
  Input,
  Menu,
  Modal,
  PageHeader,
  PageSkeleton,
  Select,
  Textarea,
  When,
  useConfirm,
  useToast,
  type MenuItem,
} from '../../components/ui';
import { PreviewPanel } from './email-preview';
import { reasonLabel } from './shared';
import { CATEGORY_HELP, templateState, type TemplateFull, type TemplateSummary } from './template-utils';

/** Variables every template can use (see commonVariables on the server). */
const COMMON_VARIABLES = ['appName', 'appUrl', 'supportEmail', 'logoUrl', 'brandColor', 'year', 'recipient.email', 'recipient.name'];
const MANDATORY = ['transactional', 'security', 'billing'];

type Target = 'subject' | 'html' | 'text';

function TestSendDialog({ template, open, onOpenChange }: { template: TemplateFull; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [to, setTo] = useState(me?.admin.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const send = useAction(() => api.post<{ id: string; status: string; reason: string | null }>(`/api/admin/email/templates/${template.id}/send-test`, { to }), {
    onSuccess: (r) => {
      if (r.status === 'queued') toast.success('Test email queued', `The saved version goes to ${to} with the sample data.`);
      else toast.error('Test not sent', reasonLabel(r.reason));
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Send a test"
      description="Sends the saved version with the sample data. Save your changes first to test them."
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!to} icon={<Send className="size-4" />}>
            Send test
          </Button>
        </>
      }
    >
      <FormError message={error} />
      <Field label="Send to" htmlFor="tt-to">
        <Input id="tt-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
      </Field>
    </Modal>
  );
}

function TranslationDialog({ template, open, onOpenChange }: { template: TemplateFull; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [locale, setLocale] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    () =>
      api.post<{ id: string }>('/api/admin/email/templates', {
        key: template.key,
        locale: locale.trim(),
        name: template.name,
        description: template.description,
        category: template.category,
        subject: template.subject,
        html: template.html,
        text: template.text,
        variables: template.variables,
        sampleData: template.sample_data,
      }),
    {
      success: 'Translation created from the current wording; translate it next',
      invalidate: [['email-templates']],
      onSuccess: (t) => {
        onOpenChange(false);
        navigate(`/growth/email/templates/${t.id}`);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a translation"
      description={`Recipients whose language matches receive this version of “${template.name}”. Others get the closest match, then English.`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!locale.trim()}>
            Create translation
          </Button>
        </>
      }
    >
      <FormError message={error} />
      <Field label="Language code" htmlFor="tr-locale" hint="For example de, fr, pt-BR">
        <Input id="tr-locale" value={locale} onChange={(e) => setLocale(e.target.value)} maxLength={10} autoFocus />
      </Field>
    </Modal>
  );
}

function TemplateEditor({ t }: { t: TemplateFull }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const editable = can('email.templates.manage');
  const initial = useMemo(
    () => ({
      name: t.name,
      description: t.description,
      category: t.category as string,
      subject: t.subject,
      html: t.html,
      text: t.text ?? '',
      variables: (t.variables ?? []).join(', '),
      sample: JSON.stringify(t.sample_data ?? {}, null, 2),
    }),
    [t],
  );
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const refs = { subject: useRef<HTMLInputElement>(null), html: useRef<HTMLTextAreaElement>(null), text: useRef<HTMLTextAreaElement>(null) };
  const lastTarget = useRef<Target>('html');
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const sample = useMemo((): { value: Record<string, unknown> | null; error: string | null } => {
    try {
      const parsed = JSON.parse(form.sample || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { value: parsed, error: null } : { value: null, error: 'Sample data must be a JSON object' };
    } catch {
      return { value: null, error: 'Sample data is not valid JSON' };
    }
  }, [form.sample]);

  // Leaving with unsaved edits asks first (in-app navigation and closing the tab).
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirm({ title: 'Discard unsaved changes?', description: 'Your edits to this template have not been saved.', tone: 'danger', confirmLabel: 'Discard changes' }).then((r) => {
      const b = blockerRef.current;
      if (b.state !== 'blocked') return;
      if (r.confirmed) b.proceed();
      else b.reset();
    });
  }, [blocker.state, confirm]);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const translations = useQuery({
    queryKey: ['email-templates', { key: t.key }],
    queryFn: () => api.get<{ data: TemplateSummary[] }>('/api/admin/email/templates', { key: t.key }),
  });

  const save = useAction(
    () =>
      api.patch<TemplateFull>(`/api/admin/email/templates/${t.id}`, {
        name: form.name,
        description: form.description,
        category: form.category,
        subject: form.subject,
        html: form.html,
        text: form.text.trim() ? form.text : null,
        variables: form.variables.split(',').map((v) => v.trim()).filter(Boolean),
        sampleData: sample.value ?? {},
      }),
    {
      success: 'Template saved',
      invalidate: [['email-template', t.id], ['email-templates']],
      onSuccess: () => setErrors({}),
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );
  const reset = useAction(() => api.post(`/api/admin/email/templates/${t.id}/reset`), { success: 'Restored the default wording', invalidate: [['email-template', t.id], ['email-templates']] });
  const remove = useAction(() => api.delete(`/api/admin/email/templates/${t.id}`), {
    success: 'Template deleted',
    invalidate: [['email-templates']],
    onSuccess: () => navigate('/growth/email/templates'),
  });

  const insert = (variable: string) => {
    const target = lastTarget.current;
    const el = refs[target].current;
    const token = `{{${variable}}}`;
    const current = form[target];
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    set(target, current.slice(0, start) + token + current.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const variables = [...new Set([...form.variables.split(',').map((v) => v.trim()).filter(Boolean), ...COMMON_VARIABLES, ...(MANDATORY.includes(form.category) ? [] : ['unsubscribeUrl'])])];
  const otherLocales = (translations.data?.data ?? []).filter((x) => x.id !== t.id);

  const menu: MenuItem[] = [
    { label: 'Send a test', icon: <Send className="size-4" />, onSelect: () => setTesting(true), hidden: !editable },
    { label: 'Add a translation', icon: <Languages className="size-4" />, onSelect: () => setTranslating(true), hidden: !editable },
    { separator: true, label: '', hidden: !editable },
    {
      label: 'Restore default wording',
      icon: <RotateCcw className="size-4" />,
      hidden: !editable || !t.is_system || !t.edited,
      onSelect: async () => {
        if ((await confirm({ title: 'Restore the default wording?', description: 'Your edits to the subject and content are replaced by the shipped version.', tone: 'danger', confirmLabel: 'Restore default' })).confirmed) reset.mutate();
      },
    },
    {
      label: 'Delete template',
      icon: <Trash2 className="size-4" />,
      danger: true,
      hidden: !editable || t.is_system,
      onSelect: async () => {
        if ((await confirm({ title: `Delete “${t.name}” (${t.locale})?`, description: 'Integrations that send this key in this language fall back to another translation, or fail if none exists.', tone: 'danger', confirmLabel: 'Delete' })).confirmed) remove.mutate();
      },
    },
  ];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (sample.error) return setError(sample.error);
        save.mutate();
      }}
    >
      <PageHeader
        breadcrumbs={[{ label: 'Email templates', to: '/growth/email/templates' }, { label: t.name }]}
        title={t.name}
        meta={
          <>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{t.key}</code>
            <Badge>{t.locale}</Badge>
            <Badge tone={t.category === 'marketing' ? 'primary' : 'neutral'}>{t.category}</Badge>
            {templateState(t)}
            <span className="text-xs text-muted-foreground">
              Version {t.version} · updated <When value={t.updated_at} />
            </span>
          </>
        }
        actions={
          <>
            {editable && (
              <Button type="submit" loading={save.isPending} disabled={!dirty}>
                {dirty ? 'Save changes' : 'Saved'}
              </Button>
            )}
            <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>} items={menu} />
          </>
        }
      />

      {(otherLocales.length > 0 || t.is_system) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          {otherLocales.length > 0 && (
            <>
              <span className="text-muted-foreground">Other languages:</span>
              {otherLocales.map((x) => (
                <Link key={x.id} to={`/growth/email/templates/${x.id}`} className="rounded-full border px-2 py-0.5 hover:bg-muted">
                  {x.locale}
                </Link>
              ))}
            </>
          )}
          {t.is_system && <span className="text-muted-foreground">{otherLocales.length ? '· ' : ''}This email is sent automatically by the platform; your edits are kept across upgrades.</span>}
        </div>
      )}

      <div className="mb-4">
        <FormError message={error} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Card title="Content">
            <div className="space-y-3">
              <Field label="Subject" htmlFor="tpl-subject" error={errors.subject}>
                <Input id="tpl-subject" ref={refs.subject} value={form.subject} onChange={(e) => set('subject', e.target.value)} onFocus={() => (lastTarget.current = 'subject')} disabled={!editable} maxLength={500} required />
              </Field>
              <Field label="HTML body" htmlFor="tpl-html" error={errors.html} hint="The branded header, footer and (for marketing) unsubscribe link are added around it.">
                <Textarea id="tpl-html" ref={refs.html} rows={16} value={form.html} onChange={(e) => set('html', e.target.value)} onFocus={() => (lastTarget.current = 'html')} disabled={!editable} className="font-mono text-xs" spellCheck={false} required />
              </Field>
              <Field label="Plain-text version" htmlFor="tpl-text" error={errors.text} hint="Optional; generated from the HTML when empty">
                <Textarea id="tpl-text" ref={refs.text} rows={5} value={form.text} onChange={(e) => set('text', e.target.value)} onFocus={() => (lastTarget.current = 'text')} disabled={!editable} className="font-mono text-xs" />
              </Field>
              <div>
                <p className="mb-1.5 text-sm font-medium">Insert a variable</p>
                <div className="flex flex-wrap gap-1.5">
                  {variables.map((v) => (
                    <button key={v} type="button" disabled={!editable} onClick={() => insert(v)} className="rounded-full border px-2 py-0.5 font-mono text-xs hover:bg-muted disabled:opacity-50">
                      {v}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  <code className="font-mono">{'{{name}}'}</code> inserts a value (escaped) · <code className="font-mono">{'{{#if x}}…{{else}}…{{/if}}'}</code> conditional · <code className="font-mono">{'{{#each items}}{{this.name}}{{/each}}'}</code> list
                </p>
              </div>
            </div>
          </Card>
          <Card title="Settings">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="tpl-name" error={errors.name}>
                <Input id="tpl-name" value={form.name} onChange={(e) => set('name', e.target.value)} disabled={!editable} maxLength={120} required />
              </Field>
              <Field label="Category" htmlFor="tpl-cat" hint={CATEGORY_HELP[form.category]} error={errors.category}>
                <Select id="tpl-cat" value={form.category} onChange={(e) => set('category', e.target.value)} disabled={!editable} options={Object.keys(CATEGORY_HELP).map((c) => ({ value: c, label: titleCase(c) }))} />
              </Field>
              <Field label="Description" htmlFor="tpl-desc" className="sm:col-span-2" error={errors.description}>
                <Input id="tpl-desc" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={!editable} maxLength={500} />
              </Field>
              <Field label="Variables provided by the sender" htmlFor="tpl-vars" className="sm:col-span-2" hint="Comma separated; documents what the code passes in" error={errors.variables}>
                <Input id="tpl-vars" value={form.variables} onChange={(e) => set('variables', e.target.value)} disabled={!editable} className="font-mono text-xs" />
              </Field>
              <Field label="Sample data (JSON)" htmlFor="tpl-sample" className="sm:col-span-2" hint="Used for the preview and test sends" error={sample.error ?? errors.sampleData}>
                <Textarea id="tpl-sample" rows={6} value={form.sample} onChange={(e) => set('sample', e.target.value)} disabled={!editable} invalid={Boolean(sample.error)} className="font-mono text-xs" spellCheck={false} />
              </Field>
            </div>
          </Card>
          {form.category === 'marketing' && <Callout>Marketing email only reaches people who consented, and always carries a one-click unsubscribe link.</Callout>}
        </div>
        <div className="xl:sticky xl:top-20 xl:self-start">
          <PreviewPanel input={{ subject: form.subject, html: form.html, text: form.text.trim() ? form.text : null, category: form.category, data: sample.value ?? {} }} description={dirty ? 'Unsaved draft, rendered with the sample data' : undefined} />
        </div>
      </div>

      {testing && <TestSendDialog template={t} open={testing} onOpenChange={setTesting} />}
      {translating && <TranslationDialog template={t} open={translating} onOpenChange={setTranslating} />}
    </form>
  );
}

export default function EmailTemplateEditorPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['email-template', id], queryFn: () => api.get<TemplateFull>(`/api/admin/email/templates/${id}`) });
  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <TemplateEditor key={`${q.data.id}:${q.data.version}`} t={q.data} />;
}
