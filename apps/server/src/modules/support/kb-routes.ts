import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { notFound } from '../../core/errors.js';
import { likePattern, pageQuery, paginate } from '../../core/validation.js';
import { excerptOf } from './html.js';
import {
  articleContent,
  articleInput,
  assertKbCategory,
  assertVisibility,
  categoriesFor,
  categoryInput,
  customerReader,
  presentArticle,
  readArticle,
  refreshSearchVector,
  resolveSlug,
  searchArticles,
  suggestArticles,
  voteOnArticle,
  anonymousVoter,
  articleUrl,
  type ArticleRow,
  type KbReader,
} from './kb.js';

const ARTICLE_COLUMNS = sql`a.id, a.category_id, a.title, a.slug, a.excerpt, a.body, a.body_text, a.tags, a.status, a.visibility, a.product_ids, a.position,
  a.view_count, a.helpful_count, a.not_helpful_count, a.published_at, a.created_by, a.updated_by, a.created_at, a.updated_at`;

const readerQuery = z.object({
  ...pageQuery,
  q: z.string().trim().max(200).optional(),
  category: z.string().max(120).optional(),
  tag: z.string().max(40).optional(),
});
const suggestionQuery = z.object({ subject: z.string().trim().min(1).max(300), limit: z.coerce.number().int().min(1).max(10).default(5) });
const slugParams = z.object({ slug: z.string().max(120) });
const voteBody = z.object({ helpful: z.boolean() });

/** An excerpt the author did not write (it is regenerated when the body changes). */
function generatedExcerpt(row: Pick<ArticleRow, 'excerpt' | 'body_text'>): boolean {
  return row.excerpt === excerptOf(row.body_text);
}

async function adminArticle(db: Db, app: App, id: string) {
  const row = await db.maybe<ArticleRow & { category_name: string | null }>(sql`
    SELECT ${ARTICLE_COLUMNS}, c.name AS category_name FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id WHERE a.id = ${id} OR a.slug = ${id}
  `);
  if (!row) throw notFound('Article');
  const products = row.product_ids.length ? await db.many<{ id: string; key: string; name: string }>(sql`SELECT id, key, name FROM products WHERE id IN ${sql.in(row.product_ids)}`) : [];
  const { body_text: _text, ...rest } = row;
  return { ...rest, excerpt_generated: generatedExcerpt(row), products, url: articleUrl(app, row.slug) };
}

export function registerKbRoutes(r: Router, app: App): void {
  // ---- Admin: categories ----------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/support/kb/categories',
    auth: 'admin',
    permission: 'support.kb.view',
    summary: 'Knowledge base categories with article counts',
    tags: ['Support'],
    handler: async () => ({
      data: await app.db.many(sql`
        SELECT c.*, count(a.id)::int AS articles, count(a.id) FILTER (WHERE a.status = 'published')::int AS published
        FROM kb_categories c LEFT JOIN kb_articles a ON a.category_id = c.id GROUP BY c.id ORDER BY c.position, c.name
      `),
    }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/kb/categories',
    auth: 'admin',
    permission: 'support.kb.manage',
    summary: 'Create a knowledge base category',
    tags: ['Support'],
    body: categoryInput,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const now = app.clock.now();
        const slug = await resolveSlug(tx, 'kb_categories', { requested: c.body.slug, from: c.body.name });
        const row = await tx.one(sql.insert('kb_categories', { id: newId('kbc'), name: c.body.name, slug, description: c.body.description, position: c.body.position, created_at: now, updated_at: now }));
        await c.audit(tx, 'kb_category.create', { type: 'kb_category', id: row.id }, { name: c.body.name, slug });
        return row;
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/support/kb/categories/:id',
    auth: 'admin',
    permission: 'support.kb.manage',
    summary: 'Update a knowledge base category',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    body: categoryInput.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await tx.maybe<{ id: string; slug: string }>(sql`SELECT id, slug FROM kb_categories WHERE id = ${c.params.id} FOR UPDATE`);
        if (!before) throw notFound('Category');
        const slug = c.body.slug && c.body.slug !== before.slug ? await resolveSlug(tx, 'kb_categories', { requested: c.body.slug, from: c.body.slug, exceptId: before.id }) : undefined;
        const row = await tx.one(sql`
          UPDATE kb_categories SET ${sql.set({ name: c.body.name, slug, description: c.body.description, position: c.body.position, updated_at: app.clock.now() })}
          WHERE id = ${before.id} RETURNING *
        `);
        await c.audit(tx, 'kb_category.update', { type: 'kb_category', id: before.id }, { fields: Object.keys(c.body) });
        return row;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/support/kb/categories/:id',
    auth: 'admin',
    permission: 'support.kb.manage',
    summary: 'Delete a category (its articles become uncategorized)',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const row = await tx.maybe<{ name: string }>(sql`DELETE FROM kb_categories WHERE id = ${c.params.id} RETURNING name`);
        if (!row) throw notFound('Category');
        await c.audit(tx, 'kb_category.delete', { type: 'kb_category', id: c.params.id }, { name: row.name });
      });
    },
  });

  // ---- Admin: articles ---------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/support/kb/articles',
    auth: 'admin',
    permission: 'support.kb.view',
    summary: 'Knowledge base articles (drafts included) with search and filters',
    tags: ['Support'],
    query: z.object({
      ...pageQuery,
      q: z.string().trim().max(200).optional(),
      status: z.enum(['draft', 'published']).optional(),
      visibility: z.enum(['public', 'customers', 'products']).optional(),
      categoryId: z.string().max(100).optional(),
      sort: z.enum(['updated_at', 'title', 'views', 'helpful']).default('updated_at'),
      order: z.enum(['asc', 'desc']).default('desc'),
    }),
    handler: (c) => {
      const q = c.query;
      const term = q.q ? sql`websearch_to_tsquery('english', ${q.q})` : null;
      return paginate(app.db, {
        select: sql`a.id, a.title, a.slug, a.excerpt, a.status, a.visibility, a.category_id, c.name AS category_name, a.tags, a.position,
          a.view_count, a.helpful_count, a.not_helpful_count, a.published_at, a.updated_at`,
        from: sql`kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id`,
        where: sql.where([
          term && sql`(a.search_vector @@ ${term} OR a.title ILIKE ${likePattern(q.q!)} OR a.slug ILIKE ${likePattern(q.q!)})`,
          q.status && sql`a.status = ${q.status}`,
          q.visibility && sql`a.visibility = ${q.visibility}`,
          q.categoryId === 'none' ? sql`a.category_id IS NULL` : q.categoryId && sql`a.category_id = ${q.categoryId}`,
        ]),
        orderBy: sql.orderBy(q.sort, q.order, {
          updated_at: 'a.updated_at',
          title: 'lower(a.title)',
          views: 'a.view_count',
          helpful: 'a.helpful_count - a.not_helpful_count',
        }),
        page: q.page,
        pageSize: q.pageSize,
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/support/kb/articles/:id',
    auth: 'admin',
    permission: 'support.kb.view',
    summary: 'One article with its content, audience and feedback',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    handler: (c) => adminArticle(app.db, app, c.params.id),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/kb/articles',
    auth: 'admin',
    permission: 'support.kb.manage',
    summary: 'Write an article (HTML is sanitized; scripts, styles and unsafe links are removed)',
    tags: ['Support'],
    bodyLimit: 1024 * 1024,
    body: articleInput,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const b = c.body;
        await assertKbCategory(tx, b.categoryId);
        const productIds = await assertVisibility(tx, app, b.visibility, b.productIds);
        const slug = await resolveSlug(tx, 'kb_articles', { requested: b.slug, from: b.title });
        const now = app.clock.now();
        const id = newId('kba');
        const me = c.admin().adminId;
        await tx.exec(sql.insert('kb_articles', {
          id,
          category_id: b.categoryId ?? null,
          title: b.title,
          slug,
          ...articleContent(b.body, b.excerpt),
          tags: [...new Set(b.tags)],
          status: b.status,
          visibility: b.visibility,
          product_ids: productIds,
          position: b.position,
          published_at: b.status === 'published' ? now : null,
          created_by: me,
          updated_by: me,
          created_at: now,
          updated_at: now,
        }, ''));
        await refreshSearchVector(tx, id);
        await c.audit(tx, 'kb_article.create', { type: 'kb_article', id }, { title: b.title, slug, status: b.status, visibility: b.visibility });
        if (b.status === 'published') await app.events.emit(tx, 'kb.article_published', { articleId: id, slug, title: b.title, visibility: b.visibility });
        c.reply.status(201);
        return adminArticle(tx, app, id);
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/support/kb/articles/:id',
    auth: 'admin',
    permission: 'support.kb.manage',
    summary: 'Edit, publish or unpublish an article',
    tags: ['Support'],
    bodyLimit: 1024 * 1024,
    params: z.object({ id: z.string() }),
    body: articleInput.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await tx.maybe<ArticleRow>(sql`SELECT ${ARTICLE_COLUMNS} FROM kb_articles a WHERE a.id = ${c.params.id} FOR UPDATE`);
        if (!before) throw notFound('Article');
        const b = c.body;
        if (b.categoryId !== undefined) await assertKbCategory(tx, b.categoryId);
        const visibility = b.visibility ?? before.visibility;
        const productIds = b.visibility !== undefined || b.productIds !== undefined ? await assertVisibility(tx, app, visibility, b.productIds ?? before.product_ids) : undefined;
        const slug = b.slug && b.slug !== before.slug ? await resolveSlug(tx, 'kb_articles', { requested: b.slug, from: b.slug, exceptId: before.id }) : undefined;
        // An excerpt generated from the old body follows the new body; one the author wrote is kept.
        const excerpt = b.excerpt ?? (b.body !== undefined && generatedExcerpt(before) ? '' : before.excerpt);
        const content = b.body !== undefined || b.excerpt !== undefined ? articleContent(b.body ?? before.body, excerpt) : {};
        const now = app.clock.now();
        const publishing = b.status === 'published' && before.status !== 'published';
        const unpublishing = b.status === 'draft' && before.status === 'published';
        await tx.exec(sql`
          UPDATE kb_articles SET ${sql.set({
            title: b.title,
            slug,
            category_id: b.categoryId,
            ...content,
            tags: b.tags ? [...new Set(b.tags)] : undefined,
            status: b.status,
            visibility: b.visibility,
            product_ids: productIds,
            position: b.position,
            published_at: publishing ? before.published_at ?? now : undefined,
            updated_by: c.admin().adminId,
            updated_at: now,
          })} WHERE id = ${before.id}
        `);
        await refreshSearchVector(tx, before.id);
        await c.audit(tx, 'kb_article.update', { type: 'kb_article', id: before.id }, { fields: Object.keys(b), status: b.status ?? before.status });
        const fresh = await adminArticle(tx, app, before.id);
        if (publishing) await app.events.emit(tx, 'kb.article_published', { articleId: before.id, slug: fresh.slug, title: fresh.title, visibility: fresh.visibility });
        if (unpublishing) await app.events.emit(tx, 'kb.article_unpublished', { articleId: before.id, slug: before.slug, title: before.title });
        return fresh;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/support/kb/articles/:id',
    auth: 'admin',
    permission: 'support.kb.manage',
    summary: 'Delete an article',
    tags: ['Support'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const row = await tx.maybe<{ id: string; slug: string; title: string; status: string }>(sql`DELETE FROM kb_articles WHERE id = ${c.params.id} RETURNING id, slug, title, status`);
        if (!row) throw notFound('Article');
        await c.audit(tx, 'kb_article.delete', { type: 'kb_article', id: row.id }, { title: row.title, slug: row.slug });
        if (row.status === 'published') await app.events.emit(tx, 'kb.article_unpublished', { articleId: row.id, slug: row.slug, title: row.title, deleted: true });
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/support/kb/preview',
    auth: 'admin',
    permission: 'support.kb.view',
    summary: 'Sanitize a draft body exactly as saving would (nothing is stored)',
    tags: ['Support'],
    bodyLimit: 1024 * 1024,
    body: z.object({ body: z.string().max(200_000), excerpt: z.string().max(500).default('') }),
    handler: (c) => {
      const content = articleContent(c.body.body, c.body.excerpt);
      return { html: content.body, text: content.body_text, excerpt: content.excerpt };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/support/kb/suggestions',
    auth: 'admin',
    permission: 'support.kb.view',
    summary: 'Published articles matching a ticket subject (to point customers at an answer)',
    tags: ['Support'],
    query: suggestionQuery,
    handler: async (c) => ({ data: (await suggestArticles(app.db, { kind: 'staff' }, c.query.subject, c.query.limit)).map((a) => presentArticle(app, a)) }),
  });

  // ---- Public and customer reading -----------------------------------------------------------------
  const reading = (surface: 'public' | 'client', reader: (c: { customer(): { userId: string } }) => Promise<KbReader>) => {
    const base = surface === 'public' ? '/api/public/kb' : '/api/client/kb';
    const auth = surface === 'public' ? ('public' as const) : ('client' as const);
    const tags = surface === 'public' ? ['Knowledge base'] : ['Client'];
    const audience = surface === 'public' ? 'public articles' : 'articles this customer may read (public, for customers, and for products they have)';
    const limit = surface === 'public' ? { by: 'ip' as const } : { by: 'principal' as const };

    r.route({
      method: 'GET',
      url: `${base}/categories`,
      auth,
      summary: `Knowledge base categories that contain ${audience}`,
      tags,
      rateLimit: { max: 300, windowSec: 60, ...limit },
      handler: async (c) => ({ data: await categoriesFor(app.db, await reader(c)) }),
    });

    r.route({
      method: 'GET',
      url: `${base}/articles`,
      auth,
      summary: `Browse or search ${audience}`,
      tags,
      rateLimit: { max: 300, windowSec: 60, ...limit },
      query: readerQuery,
      handler: async (c) => {
        const page = await searchArticles(app.db, await reader(c), c.query);
        return { ...page, data: page.data.map((a) => presentArticle(app, a)) };
      },
    });

    r.route({
      method: 'GET',
      url: `${base}/articles/:slug`,
      auth,
      summary: `One article with its sanitized HTML body (${audience}; counts a view)`,
      tags,
      rateLimit: { max: 300, windowSec: 60, ...limit },
      params: slugParams,
      handler: async (c) => presentArticle(app, await readArticle(app.db, await reader(c), c.params.slug, { countView: true })),
    });

    r.route({
      method: 'POST',
      url: `${base}/articles/:slug/vote`,
      auth,
      summary: 'Was this article helpful? (one vote per reader; voting again changes it)',
      tags,
      rateLimit: { max: 30, windowSec: 600, ...limit },
      params: slugParams,
      body: voteBody,
      handler: async (c) => {
        const viewer = await reader(c);
        const voter = viewer.kind === 'customer' ? `usr:${viewer.userId}` : anonymousVoter(app, c.ip);
        return app.db.tx(async (tx) => {
          const article = await readArticle(tx, viewer, c.params.slug, { countView: false });
          return { helpful: await voteOnArticle(tx, app, article.id, voter, c.body.helpful) };
        });
      },
    });

    r.route({
      method: 'GET',
      url: `${base}/suggestions`,
      auth,
      summary: `Articles that may answer a question before a ticket is opened (${audience})`,
      tags,
      rateLimit: { max: 120, windowSec: 60, ...limit },
      query: suggestionQuery,
      handler: async (c) => ({ data: (await suggestArticles(app.db, await reader(c), c.query.subject, c.query.limit)).map((a) => presentArticle(app, a)) }),
    });
  };

  reading('public', async () => ({ kind: 'public' }));
  reading('client', (c) => customerReader(app.db, app, c.customer().userId));
}
