import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BookOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  Toolbar,
  When,
  useConfirm,
} from '../../components/ui';
import { VISIBILITY_LABEL, VISIBILITY_TONE, helpfulness, useKbCategories, type KbArticleRow, type KbCategory, type KbVisibility } from './shared';

const DEFAULTS = { q: '', status: '', visibility: '', categoryId: '', sort: 'updated_at', order: 'desc', page: 1, pageSize: 25 };

function ArticlesTab() {
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  const categories = useKbCategories();
  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = Object.fromEntries(Object.entries(state).filter(([, v]) => v !== '' && v !== undefined)) as Record<string, string | number>;
  const articles = useQuery({
    queryKey: ['kb-articles', query],
    queryFn: ({ signal }) => api.get<Page<KbArticleRow>>('/api/admin/support/kb/articles', query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = ['q', 'status', 'visibility', 'categoryId'].some((k) => state[k] !== '' && state[k] !== undefined);

  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search titles and content…" className="w-full sm:w-64" />
        <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={[{ value: 'published', label: 'Published' }, { value: 'draft', label: 'Draft' }]} />
        <Select aria-label="Audience" className="w-auto" value={String(state.visibility)} onChange={(e) => setState({ visibility: e.target.value })} placeholder="Any audience" options={Object.entries(VISIBILITY_LABEL).map(([value, label]) => ({ value, label }))} />
        {(categories.data?.data ?? []).length > 0 && (
          <Select
            aria-label="Category"
            className="w-auto"
            value={String(state.categoryId)}
            onChange={(e) => setState({ categoryId: e.target.value })}
            placeholder="Any category"
            options={[{ value: 'none', label: 'Uncategorized' }, ...categories.data!.data.map((c) => ({ value: c.id, label: c.name }))]}
          />
        )}
        <Select
          aria-label="Sort"
          className="w-auto"
          value={`${state.sort}:${state.order}`}
          onChange={(e) => {
            const [sort, order] = e.target.value.split(':');
            setState({ sort, order });
          }}
          options={[
            { value: 'updated_at:desc', label: 'Recently updated' },
            { value: 'title:asc', label: 'Title A–Z' },
            { value: 'views:desc', label: 'Most viewed' },
            { value: 'helpful:desc', label: 'Most helpful' },
            { value: 'helpful:asc', label: 'Least helpful' },
          ]}
        />
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              reset();
            }}
          >
            Clear
          </Button>
        )}
      </Toolbar>
      {articles.error ? (
        <ErrorState error={articles.error} onRetry={() => void articles.refetch()} />
      ) : (
        <DataTable
          caption="Knowledge base articles"
          rows={articles.data?.data}
          rowKey={(a) => a.id}
          rowHref={(a) => `/customers/kb/${a.id}`}
          loading={articles.isLoading}
          fetching={articles.isFetching && !articles.isLoading}
          empty={
            filtered ? (
              <EmptyState title="No articles match these filters" />
            ) : (
              <EmptyState icon={<BookOpen />} title="No articles yet" description="Answer common questions once. Customers see matching articles before they open a ticket." />
            )
          }
          columns={[
            {
              key: 'title',
              header: 'Article',
              cell: (a) => (
                <span className="block min-w-0 max-w-lg">
                  <span className="block truncate">{a.title}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">{a.excerpt || a.slug}</span>
                </span>
              ),
            },
            { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
            { key: 'visibility', header: 'Audience', cell: (a) => <Badge tone={VISIBILITY_TONE[a.visibility as KbVisibility]}>{VISIBILITY_LABEL[a.visibility as KbVisibility]}</Badge> },
            { key: 'category', header: 'Category', priority: 'low', cell: (a) => a.category_name ?? <span className="text-muted-foreground">—</span> },
            { key: 'views', header: 'Views', align: 'right', cell: (a) => <span className="tabular">{num(a.view_count)}</span> },
            { key: 'helpful', header: 'Helpful', cell: (a) => <span className="whitespace-nowrap text-sm">{helpfulness(a)}</span> },
            { key: 'updated', header: 'Updated', cell: (a) => <When value={a.updated_at} /> },
          ]}
        />
      )}
      {articles.data && <Pagination page={articles.data.page} pageSize={articles.data.pageSize} total={articles.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </Card>
  );
}

function CategoryDialog({ category, onClose }: { category: KbCategory | 'new'; onClose: () => void }) {
  const isNew = category === 'new';
  const [form, setForm] = useState({ name: isNew ? '' : category.name, slug: isNew ? '' : category.slug, description: isNew ? '' : category.description, position: isNew ? '0' : String(category.position) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const body = { name: form.name, slug: form.slug || undefined, description: form.description, position: Number(form.position) || 0 };
  const save = useAction(() => (isNew ? api.post('/api/admin/support/kb/categories', body) : api.patch(`/api/admin/support/kb/categories/${category.id}`, body)), {
    success: isNew ? 'Category created' : 'Category updated',
    invalidate: [['kb-categories'], ['kb-articles']],
    onSuccess: onClose,
    onError: (e) => {
      setError(errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors());
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'New category' : `Edit ${category.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="kb-category" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="kb-category"
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
        <Field label="Name" htmlFor="kbc-name" error={errors.name} required>
          <Input id="kbc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required autoFocus />
        </Field>
        <Field label="Slug" htmlFor="kbc-slug" error={errors.slug} hint={isNew ? 'Generated from the name when empty' : 'Changing it changes links to the category'}>
          <Input id="kbc-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} maxLength={120} className="font-mono" />
        </Field>
        <Field label="Description" htmlFor="kbc-desc" className="sm:col-span-2" error={errors.description}>
          <Textarea id="kbc-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} />
        </Field>
        <Field label="Position" htmlFor="kbc-position" hint="Lower numbers come first">
          <Input id="kbc-position" type="number" step={1} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}

function CategoriesTab() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('support.kb.manage');
  const [editing, setEditing] = useState<KbCategory | 'new' | null>(null);
  const categories = useKbCategories();
  const remove = useAction((id: string) => api.delete(`/api/admin/support/kb/categories/${id}`), { success: 'Category deleted', invalidate: [['kb-categories'], ['kb-articles']] });
  return (
    <Card
      title="Categories"
      description="Group articles for browsing in your help center."
      padded={false}
      actions={
        manage && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New category
          </Button>
        )
      }
    >
      {categories.error ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        <DataTable
          caption="Knowledge base categories"
          rows={categories.data?.data}
          loading={categories.isLoading}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No categories" description="Articles can live without one; categories help readers browse." />}
          columns={[
            {
              key: 'name',
              header: 'Category',
              cell: (c) => (
                <span className="block min-w-0 max-w-md">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{c.slug}</span>
                </span>
              ),
            },
            { key: 'articles', header: 'Articles', align: 'right', cell: (c) => <span className="tabular">{num(c.published)} published · {num(c.articles)} total</span> },
            { key: 'position', header: 'Position', align: 'right', priority: 'low', cell: (c) => <span className="tabular">{c.position}</span> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (c) =>
                manage ? (
                  <span className="inline-flex gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${c.name}`}
                      onClick={async () => {
                        const r = await confirm({ title: `Delete “${c.name}”?`, description: c.articles ? `Its ${c.articles} articles stay and become uncategorized.` : undefined, tone: 'danger', confirmLabel: 'Delete' });
                        if (r.confirmed) remove.mutate(c.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      )}
      {editing && <CategoryDialog category={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

export default function KnowledgeBasePage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('articles');
  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="Help articles for your customers: public, for signed-in customers, or for customers with particular products. Your app shows them through the API, and customers see matching ones before opening a ticket."
        actions={
          can('support.kb.manage') && (
            <ButtonLink to="/customers/kb/new" variant="primary" icon={<Plus className="size-4" />}>
              New article
            </ButtonLink>
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'articles', label: 'Articles', content: <ArticlesTab /> },
          { value: 'categories', label: 'Categories', content: tab === 'categories' && <CategoriesTab /> },
        ]}
      />
    </>
  );
}
