import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Mail, Plus } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { titleCase } from '../../lib/format';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, SearchInput, Select, Toolbar, When } from '../../components/ui';
import { CATEGORY_HELP, templateState, type TemplateFull, type TemplateSummary } from './template-utils';

const BLANK_HTML = '<p>Hi{{#if recipient.name}} {{recipient.name}}{{/if}},</p>\n<p>Write your message here.</p>';

function NewTemplateDialog({ open, onOpenChange, templates }: { open: boolean; onOpenChange: (o: boolean) => void; templates: TemplateSummary[] }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ key: '', locale: 'en', name: '', category: 'transactional', description: '', copyFrom: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    async () => {
      let content: Pick<TemplateFull, 'subject' | 'html' | 'text' | 'variables' | 'sample_data'> = { subject: form.name, html: BLANK_HTML, text: null, variables: [], sample_data: {} };
      if (form.copyFrom) content = await api.get<TemplateFull>(`/api/admin/email/templates/${form.copyFrom}`);
      return api.post<{ id: string }>('/api/admin/email/templates', {
        key: form.key.trim(),
        locale: form.locale.trim(),
        name: form.name,
        category: form.category,
        description: form.description,
        subject: content.subject,
        html: content.html,
        text: content.text,
        variables: content.variables,
        sampleData: content.sample_data,
      });
    },
    {
      success: 'Template created',
      invalidate: [['email-templates']],
      onSuccess: (t) => {
        onOpenChange(false);
        navigate(`/growth/email/templates/${t.id}`);
      },
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New email template"
      description="Custom templates are sent by your own integrations (SDK or API) or used for campaigns. To translate an existing email, use the same key with another language."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-template" loading={create.isPending}>
            Create template
          </Button>
        </>
      }
    >
      <form
        id="new-template"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Name" htmlFor="nt-name" error={errors.name} required>
          <Input id="nt-name" value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} autoFocus />
        </Field>
        <Field label="Key" htmlFor="nt-key" error={errors.key} hint="How code refers to it, e.g. onboarding.day3" required>
          <Input id="nt-key" value={form.key} onChange={(e) => set('key', e.target.value.toLowerCase())} required className="font-mono" placeholder="onboarding.day3" />
        </Field>
        <Field label="Language" htmlFor="nt-locale" error={errors.locale} hint="en, de, pt-BR…">
          <Input id="nt-locale" value={form.locale} onChange={(e) => set('locale', e.target.value)} required maxLength={10} />
        </Field>
        <Field label="Category" htmlFor="nt-cat" hint={CATEGORY_HELP[form.category]}>
          <Select id="nt-cat" value={form.category} onChange={(e) => set('category', e.target.value)} options={Object.keys(CATEGORY_HELP).map((c) => ({ value: c, label: titleCase(c) }))} />
        </Field>
        <Field label="Description" htmlFor="nt-desc" className="sm:col-span-2">
          <Input id="nt-desc" value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={500} placeholder="When it is sent" />
        </Field>
        <Field label="Start from" htmlFor="nt-copy" className="sm:col-span-2" hint="Copy the content of an existing template (for a translation, keep the same key)">
          <Select
            id="nt-copy"
            value={form.copyFrom}
            onChange={(e) => {
              const src = templates.find((t) => t.id === e.target.value);
              setForm((f) => ({ ...f, copyFrom: e.target.value, ...(src && !f.key ? { key: src.key, category: src.category, name: f.name || src.name } : {}) }));
            }}
            options={[{ value: '', label: 'Blank template' }, ...templates.map((t) => ({ value: t.id, label: `${t.name} (${t.key}, ${t.locale})` }))]}
          />
        </Field>
      </form>
    </Modal>
  );
}

const DEFAULTS = { q: '', category: '' };

export default function EmailTemplatesPage() {
  const { can } = useAuth();
  const [state, setState] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
  }, [q]);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['email-templates', { q: String(state.q), category: String(state.category) }],
    queryFn: ({ signal }) => api.get<{ data: TemplateSummary[] }>('/api/admin/email/templates', { q: String(state.q), category: String(state.category) }, signal),
    placeholderData: keepPreviousData,
  });
  const all = useQuery({ queryKey: ['email-templates', { all: true }], queryFn: () => api.get<{ data: TemplateSummary[] }>('/api/admin/email/templates'), enabled: creating });

  return (
    <>
      <PageHeader
        title="Email templates"
        description="The wording of every email the platform sends. Your edits survive upgrades; translations are picked per recipient language."
        actions={
          can('email.templates.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New template
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, key or subject…" className="w-full sm:w-72" />
          <Select aria-label="Category" className="w-auto" value={String(state.category)} onChange={(e) => setState({ category: e.target.value })} placeholder="All categories" options={Object.keys(CATEGORY_HELP).map((c) => ({ value: c, label: titleCase(c) }))} />
        </Toolbar>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Email templates"
            rows={list.data?.data}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            rowKey={(t) => t.id}
            rowHref={(t) => `/growth/email/templates/${t.id}`}
            empty={<EmptyState icon={<Mail />} title="No templates match" />}
            columns={[
              {
                key: 'name',
                header: 'Template',
                cell: (t) => (
                  <span className="min-w-0">
                    <span className="block truncate">{t.name}</span>
                    <span className="block truncate font-mono text-xs font-normal text-muted-foreground">{t.key}</span>
                  </span>
                ),
              },
              { key: 'locale', header: 'Language', cell: (t) => <Badge>{t.locale}</Badge> },
              { key: 'category', header: 'Category', cell: (t) => <Badge tone={t.category === 'marketing' ? 'primary' : 'neutral'}>{t.category}</Badge> },
              { key: 'subject', header: 'Subject', priority: 'low', cell: (t) => <span className="block max-w-sm truncate text-sm">{t.subject}</span> },
              { key: 'state', header: 'State', cell: (t) => templateState(t) },
              { key: 'updated', header: 'Updated', cell: (t) => <When value={t.updated_at} /> },
            ]}
          />
        )}
      </Card>
      {creating && <NewTemplateDialog open={creating} onOpenChange={setCreating} templates={all.data?.data ?? []} />}
    </>
  );
}
