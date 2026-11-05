import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced } from '../../lib/hooks';
import { num } from '../../lib/format';
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CodeBlock,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  PageHeader,
  PageSkeleton,
  Select,
  Skeleton,
  StatusBadge,
  Textarea,
  When,
  useConfirm,
} from '../../components/ui';
import { ProductChecklist } from '../lists/shared';
import { VISIBILITY_LABEL, helpfulness, useKbCategories, type KbArticle, type KbVisibility } from './shared';

const STARTER = `<p>Short answer first: what the reader should do.</p>
<h2>Steps</h2>
<ol>
  <li>Open <strong>Settings</strong>.</li>
  <li>Choose …</li>
</ol>
<p>Still stuck? <a href="mailto:support@example.com">Contact support</a>.</p>`;

const PREVIEW_STYLE = `<style>body{margin:16px;font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2328;background:#fff}
h1,h2,h3,h4{line-height:1.3;margin:1.2em 0 .4em}img{max-width:100%;height:auto}a{color:#4f46e5}
pre{overflow:auto;background:#f6f8fa;padding:10px;border-radius:6px}code{font-family:ui-monospace,monospace;font-size:.9em}
table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:4px 8px}blockquote{margin:0;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}</style>`;

interface Sanitized {
  html: string;
  text: string;
  excerpt: string;
}

/** The body exactly as it will be stored (sanitized on the server), rendered in a sandbox without scripts. */
function ArticlePreview({ body, excerpt }: { body: string; excerpt: string }) {
  const key = JSON.stringify({ body, excerpt });
  const debounced = useDebounced(key, 450);
  const preview = useQuery({
    queryKey: ['kb-preview', debounced],
    queryFn: () => api.post<Sanitized>('/api/admin/support/kb/preview', JSON.parse(debounced)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const stale = preview.isFetching || key !== debounced;
  return (
    <Card title="Preview" description="As customers' apps receive it: scripts, styles and unsafe links removed">
      {preview.isLoading ? (
        <Skeleton className="h-72" />
      ) : preview.error ? (
        <Callout tone="warning">{errorMessage(preview.error)}</Callout>
      ) : preview.data ? (
        <div className={clsx('space-y-3 transition-opacity', stale && 'opacity-60')}>
          <div className="rounded-ui-sm border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Excerpt: </span>
            {preview.data.excerpt || <em className="text-muted-foreground">empty</em>}
          </div>
          <iframe title="Article preview" sandbox="" srcDoc={`<!doctype html><meta charset="utf-8">${PREVIEW_STYLE}${preview.data.html}`} className="h-[28rem] w-full rounded-ui-sm border bg-white" />
        </div>
      ) : null}
    </Card>
  );
}

function ArticleForm({ article }: { article: KbArticle | null }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const editable = can('support.kb.manage');
  const categories = useKbCategories();
  const [form, setForm] = useState({
    title: article?.title ?? '',
    slug: article?.slug ?? '',
    categoryId: article?.category_id ?? '',
    tags: article?.tags.join(', ') ?? '',
    status: article?.status ?? 'draft',
    visibility: (article?.visibility ?? 'public') as KbVisibility,
    productIds: article?.product_ids ?? [],
    excerpt: article && !article.excerpt_generated ? article.excerpt : '',
    body: article?.body ?? STARTER,
    position: String(article?.position ?? 0),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const body = useMemo(
    () => ({
      title: form.title,
      slug: form.slug || undefined,
      categoryId: form.categoryId || null,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      status: form.status,
      visibility: form.visibility,
      productIds: form.visibility === 'products' ? form.productIds : [],
      excerpt: form.excerpt,
      body: form.body,
      position: Number(form.position) || 0,
    }),
    [form],
  );
  const dirty =
    !article ||
    JSON.stringify(body) !==
      JSON.stringify({
        title: article.title,
        slug: article.slug,
        categoryId: article.category_id,
        tags: article.tags,
        status: article.status,
        visibility: article.visibility,
        productIds: article.visibility === 'products' ? article.product_ids : [],
        excerpt: article.excerpt_generated ? '' : article.excerpt,
        body: article.body,
        position: article.position,
      });

  const save = useAction(() => (article ? api.patch<KbArticle>(`/api/admin/support/kb/articles/${article.id}`, body) : api.post<KbArticle>('/api/admin/support/kb/articles', body)), {
    success: (a) => (a.status === 'published' ? 'Article saved and published' : 'Draft saved'),
    invalidate: [['kb-articles'], ['kb-article'], ['kb-categories']],
    onSuccess: (a) => {
      setErrors({});
      setError(null);
      if (!article) navigate(`/customers/kb/${a.id}`, { replace: true });
    },
    onError: (e) => {
      setError(errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors());
    },
  });
  const remove = useAction(() => api.delete(`/api/admin/support/kb/articles/${article!.id}`), {
    success: 'Article deleted',
    invalidate: [['kb-articles'], ['kb-categories']],
    onSuccess: () => navigate('/customers/kb'),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <PageHeader
        breadcrumbs={[{ label: 'Knowledge base', to: '/customers/kb' }, { label: article?.title ?? 'New article' }]}
        title={article ? article.title : 'New article'}
        meta={article && (
          <>
            <StatusBadge status={article.status} />
            <Badge>{VISIBILITY_LABEL[article.visibility]}</Badge>
            <span className="text-sm text-muted-foreground">
              Updated <When value={article.updated_at} />
            </span>
          </>
        )}
        actions={
          editable && (
            <>
              {article && (
                <Button
                  variant="outline"
                  icon={<Trash2 className="size-4" />}
                  onClick={async () => {
                    if ((await confirm({ title: `Delete “${article.title}”?`, description: 'Links to it stop working.', tone: 'danger', confirmLabel: 'Delete article' })).confirmed) remove.mutate();
                  }}
                >
                  Delete
                </Button>
              )}
              <Button type="submit" loading={save.isPending} disabled={!dirty}>
                {article ? (dirty ? 'Save changes' : 'Saved') : 'Create article'}
              </Button>
            </>
          )
        }
      />
      <div className="mb-4">
        <FormError message={error} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card title="Article">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Title" htmlFor="kba-title" className="sm:col-span-2" error={errors.title} required>
                <Input id="kba-title" value={form.title} onChange={(e) => set('title', e.target.value)} disabled={!editable} maxLength={200} required autoFocus={!article} />
              </Field>
              <Field label="Slug" htmlFor="kba-slug" error={errors.slug} hint={article ? 'Part of the article’s link; changing it breaks old links' : 'Generated from the title when empty'}>
                <Input id="kba-slug" value={form.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} disabled={!editable} maxLength={120} className="font-mono" />
              </Field>
              <Field label="Category" htmlFor="kba-category" error={errors.categoryId}>
                <Select id="kba-category" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} disabled={!editable} placeholder="None" options={(categories.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
              </Field>
              <Field label="Tags" htmlFor="kba-tags" hint="Comma separated; searched along with the title" error={errors.tags}>
                <Input id="kba-tags" value={form.tags} onChange={(e) => set('tags', e.target.value)} disabled={!editable} />
              </Field>
              <Field label="Position" htmlFor="kba-position" hint="Order within the category">
                <Input id="kba-position" type="number" step={1} value={form.position} onChange={(e) => set('position', e.target.value)} disabled={!editable} />
              </Field>
              <Field label="Excerpt" htmlFor="kba-excerpt" className="sm:col-span-2" error={errors.excerpt} hint="Shown in lists and suggestions; leave empty to use the first lines of the article">
                <Textarea id="kba-excerpt" rows={2} value={form.excerpt} onChange={(e) => set('excerpt', e.target.value)} disabled={!editable} maxLength={500} />
              </Field>
              <Field label="Body (HTML)" htmlFor="kba-body" className="sm:col-span-2" error={errors.body} hint="Headings, lists, links, images, tables and code. Scripts, styles, forms and unsafe links are removed when you save.">
                <Textarea id="kba-body" rows={16} value={form.body} onChange={(e) => set('body', e.target.value)} disabled={!editable} className="font-mono text-xs" spellCheck={false} />
              </Field>
            </div>
          </Card>
          <Card title="Publishing">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Status" htmlFor="kba-status">
                <Select id="kba-status" value={form.status} onChange={(e) => set('status', e.target.value as 'draft' | 'published')} disabled={!editable} options={[{ value: 'draft', label: 'Draft (only your team sees it)' }, { value: 'published', label: 'Published' }]} />
              </Field>
              <Field label="Who can read it" htmlFor="kba-visibility" error={errors.visibility}>
                <Select id="kba-visibility" value={form.visibility} onChange={(e) => set('visibility', e.target.value as KbVisibility)} disabled={!editable} options={Object.entries(VISIBILITY_LABEL).map(([value, label]) => ({ value, label }))} />
              </Field>
              {form.visibility === 'products' && (
                <Field label="Products" className="sm:col-span-2" error={errors.productIds} hint="Customers who can use any of these (directly or through their organization) can read it">
                  <ProductChecklist value={form.productIds} onChange={(ids) => set('productIds', ids)} disabled={!editable} label="Products that unlock this article" />
                </Field>
              )}
            </div>
          </Card>
        </div>
        <div className="space-y-4">
          <ArticlePreview body={form.body} excerpt={form.excerpt} />
          {article && (
            <Card title="Readers">
              <KeyValue
                items={[
                  { label: 'Views', value: <span className="tabular">{num(article.view_count)}</span> },
                  {
                    label: 'Was it helpful?',
                    value: (
                      <span className="inline-flex flex-wrap items-center gap-3">
                        <span className="inline-flex items-center gap-1 tabular">
                          <ThumbsUp className="size-3.5 text-success" aria-label="Yes" /> {num(article.helpful_count)}
                        </span>
                        <span className="inline-flex items-center gap-1 tabular">
                          <ThumbsDown className="size-3.5 text-danger" aria-label="No" /> {num(article.not_helpful_count)}
                        </span>
                        <span className="text-muted-foreground">{helpfulness(article)}</span>
                      </span>
                    ),
                  },
                  { label: 'First published', value: article.published_at ? <When value={article.published_at} relative={false} /> : 'Not yet' },
                ]}
              />
              {article.url ? (
                <div className="mt-3">
                  <Field label="Link in your help center">
                    <CodeBlock code={article.url} />
                  </Field>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">Set the article link pattern in Settings → Support to show links here and in ticket suggestions.</p>
              )}
            </Card>
          )}
        </div>
      </div>
    </form>
  );
}

export default function ArticleEditorPage() {
  const { id } = useParams();
  const article = useQuery({ queryKey: ['kb-article', id], queryFn: () => api.get<KbArticle>(`/api/admin/support/kb/articles/${id}`), enabled: Boolean(id) });
  if (!id) return <ArticleForm article={null} />;
  if (article.isLoading) return <PageSkeleton />;
  if (article.error instanceof ApiError && article.error.status === 404) {
    return <EmptyState title="Article not found" description="It may have been deleted." action={<ButtonLink to="/customers/kb">All articles</ButtonLink>} />;
  }
  if (article.error || !article.data) return <ErrorState error={article.error} onRetry={() => void article.refetch()} />;
  return <ArticleForm key={`${article.data.id}:${article.data.updated_at}`} article={article.data} />;
}
