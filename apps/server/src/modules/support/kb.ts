import { z } from 'zod';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { hmacSha256 } from '../../core/crypto.js';
import { likePattern, paginate, type Page } from '../../core/validation.js';
import { excerptOf, htmlToPlainText, sanitizeHtml } from './html.js';
import { settingsOf } from './service.js';

export type KbVisibility = 'public' | 'customers' | 'products';

/**
 * Who is reading. Anonymous visitors see public articles; signed-in customers
 * also see articles for customers and for the products they can use; staff
 * see everything, drafts included.
 */
export type KbReader = { kind: 'public' } | { kind: 'customer'; userId: string; productIds: string[] } | { kind: 'staff' };

export const KB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugField = z.string().trim().toLowerCase().max(120).regex(KB_SLUG, 'Use lowercase letters, digits and dashes');

export interface ArticleRow {
  id: string;
  category_id: string | null;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  body_text: string;
  tags: string[];
  status: 'draft' | 'published';
  visibility: KbVisibility;
  product_ids: string[];
  position: number;
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
  published_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const categoryInput = z.object({
  name: z.string().trim().min(1).max(100),
  slug: slugField.optional(),
  description: z.string().trim().max(1000).default(''),
  position: z.number().int().min(-10_000).max(10_000).default(0),
});

export const articleInput = z.object({
  title: z.string().trim().min(1).max(200),
  slug: slugField.optional(),
  categoryId: z.string().max(100).nullable().optional(),
  body: z.string().max(200_000).default(''),
  /** Shown in lists and suggestions; generated from the body when empty. */
  excerpt: z.string().trim().max(500).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  status: z.enum(['draft', 'published']).default('draft'),
  visibility: z.enum(['public', 'customers', 'products']).default('public'),
  productIds: z.array(z.string().max(100)).max(50).default([]),
  position: z.number().int().min(-10_000).max(10_000).default(0),
});
export type ArticleInput = z.infer<typeof articleInput>;

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || 'article'
  );
}

/** A free slug: the requested one (409 when taken) or one derived from the title with a numeric suffix. */
export async function resolveSlug(db: Db, table: 'kb_articles' | 'kb_categories', input: { requested?: string; from: string; exceptId?: string }): Promise<string> {
  const taken = async (slug: string) => Boolean(await db.maybe(sql`SELECT 1 FROM ${sql.ident(table)} WHERE slug = ${slug} ${input.exceptId ? sql`AND id <> ${input.exceptId}` : sql.empty}`));
  if (input.requested) {
    if (await taken(input.requested)) throw conflict(`The slug "${input.requested}" is already used`, 'slug_taken');
    return input.requested;
  }
  const base = slugify(input.from);
  for (let n = 1; n < 500; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${base}-${newId('s').slice(-6)}`;
}

// ---- Access -------------------------------------------------------------------------------------

type ResolveFn = (db: Db, subject: { type: 'user' | 'organization'; id: string }) => Promise<{ plans: { productId: string }[] }>;

/** Products a customer can use now: their own, and those of organizations they are an active member of. */
export async function customerProductIds(db: Db, app: App, userId: string): Promise<string[]> {
  const resolve = app.services['catalog.resolve'] as ResolveFn | undefined;
  if (!resolve || !app.modules.isEnabled('catalog')) return [];
  const orgs = await db.many<{ org_id: string }>(sql`SELECT org_id FROM memberships WHERE user_id = ${userId} AND status = 'active'`);
  const ids = new Set<string>();
  for (const subject of [{ type: 'user' as const, id: userId }, ...orgs.map((o) => ({ type: 'organization' as const, id: o.org_id }))]) {
    for (const plan of (await resolve(db, subject)).plans) ids.add(plan.productId);
  }
  return [...ids];
}

export async function customerReader(db: Db, app: App, userId: string): Promise<KbReader> {
  // Entitlements are only resolved when a product-restricted article could be shown.
  const gated = await db.maybe(sql`SELECT 1 FROM kb_articles WHERE status = 'published' AND visibility = 'products' LIMIT 1`);
  return { kind: 'customer', userId, productIds: gated ? await customerProductIds(db, app, userId) : [] };
}

/** SQL condition: articles (alias `a`) the reader may see. */
export function visibleTo(reader: KbReader): Sql {
  if (reader.kind === 'staff') return sql`TRUE`;
  if (reader.kind === 'public') return sql`a.status = 'published' AND a.visibility = 'public'`;
  return sql`a.status = 'published' AND (a.visibility IN ('public', 'customers') OR (a.visibility = 'products' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(a.product_ids) p(id) WHERE p.id IN ${sql.in(reader.productIds)}
  )))`;
}

// ---- Writing --------------------------------------------------------------------------------------

/** Keep the full-text index in step with the article (title weighs most, then tags and excerpt, then the body). */
export async function refreshSearchVector(db: Db, id: string): Promise<void> {
  await db.exec(sql`
    UPDATE kb_articles SET search_vector =
      setweight(to_tsvector('english', title), 'A') ||
      setweight(to_tsvector('english', (SELECT coalesce(string_agg(t, ' '), '') FROM jsonb_array_elements_text(tags) t)), 'B') ||
      setweight(to_tsvector('english', excerpt), 'B') ||
      setweight(to_tsvector('english', body_text), 'C')
    WHERE id = ${id}
  `);
}

/** Sanitized body, its plain text and the excerpt (generated when the author left it empty). */
export function articleContent(body: string, excerpt: string): { body: string; body_text: string; excerpt: string } {
  const clean = sanitizeHtml(body);
  const text = htmlToPlainText(clean);
  return { body: clean, body_text: text, excerpt: excerpt.trim() || excerptOf(text) };
}

export async function assertVisibility(db: Db, app: App, visibility: KbVisibility, productIds: string[]): Promise<string[]> {
  if (visibility !== 'products') return [];
  const ids = [...new Set(productIds)];
  if (!ids.length) throw validationError([{ path: ['productIds'], message: 'Choose at least one product' }]);
  if (!app.modules.isEnabled('catalog')) throw validationError([{ path: ['visibility'], message: 'Product-restricted articles need the catalog module' }]);
  const found = await db.many<{ id: string }>(sql`SELECT id FROM products WHERE id IN ${sql.in(ids)}`);
  const missing = ids.filter((id) => !found.some((p) => p.id === id));
  if (missing.length) throw validationError([{ path: ['productIds'], message: `Unknown product: ${missing.join(', ')}` }]);
  return ids;
}

export async function assertKbCategory(db: Db, id: string | null | undefined): Promise<void> {
  if (id && !(await db.maybe(sql`SELECT 1 FROM kb_categories WHERE id = ${id}`))) throw validationError([{ path: ['categoryId'], message: 'Unknown category' }]);
}

export async function getArticle(db: Db, idOrSlug: string): Promise<ArticleRow> {
  const row = await db.maybe<ArticleRow>(sql`SELECT * FROM kb_articles WHERE id = ${idOrSlug} OR slug = ${idOrSlug}`);
  if (!row) throw notFound('Article');
  return row;
}

// ---- Reading ----------------------------------------------------------------------------------------

export function articleUrl(app: App, slug: string): string | null {
  const template = settingsOf(app).kbArticleUrl;
  return template ? template.replace('{slug}', encodeURIComponent(slug)) : null;
}

interface ListedArticle {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  tags: string[];
  category_id: string | null;
  category_slug: string | null;
  category_name: string | null;
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
  published_at: Date | null;
  updated_at: Date;
  body?: string;
}

/** The shape customers' apps receive (no drafts, product ids or authors). */
export function presentArticle(app: App, a: ListedArticle) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    excerpt: a.excerpt,
    tags: a.tags,
    category: a.category_id ? { id: a.category_id, slug: a.category_slug, name: a.category_name } : null,
    ...(a.body !== undefined ? { body: a.body } : {}),
    url: articleUrl(app, a.slug),
    helpful: { yes: a.helpful_count, no: a.not_helpful_count },
    views: a.view_count,
    publishedAt: a.published_at,
    updatedAt: a.updated_at,
  };
}

const LISTED = sql`a.id, a.slug, a.title, a.excerpt, a.tags, a.category_id, c.slug AS category_slug, c.name AS category_name,
  a.view_count, a.helpful_count, a.not_helpful_count, a.published_at, a.updated_at`;

export async function searchArticles(
  db: Db,
  reader: KbReader,
  q: { q?: string; category?: string; tag?: string; page: number; pageSize: number },
): Promise<Page<ListedArticle>> {
  const term = q.q?.trim();
  const query = term ? sql`websearch_to_tsquery('english', ${term})` : null;
  return paginate<ListedArticle>(db, {
    select: LISTED,
    from: sql`kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id`,
    where: sql.where([
      visibleTo(reader),
      reader.kind === 'staff' && sql`a.status = 'published'`,
      q.category && sql`(c.id = ${q.category} OR c.slug = ${q.category})`,
      q.tag && sql`a.tags ? ${q.tag}`,
      query && sql`(a.search_vector @@ ${query} OR a.title ILIKE ${likePattern(term!)})`,
    ]),
    orderBy: query ? sql`ORDER BY ts_rank_cd(a.search_vector, ${query}) DESC, a.view_count DESC, a.id` : sql`ORDER BY c.position NULLS LAST, a.position, a.title`,
    page: q.page,
    pageSize: q.pageSize,
  });
}

/** Up to 12 distinct words of a ticket subject, OR-ed, so any of them can match (stop words are ignored by Postgres). */
export function suggestionQuery(subject: string): string | null {
  const words = [...new Set(subject.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 12);
  return words.length ? words.join(' | ') : null;
}

/** Published articles that match what the customer is about to ask, best match first. */
export async function suggestArticles(db: Db, reader: KbReader, subject: string, limit = 5): Promise<ListedArticle[]> {
  const terms = suggestionQuery(subject);
  if (!terms) return [];
  const query = sql`to_tsquery('english', ${terms})`;
  return db.many<ListedArticle>(sql`
    SELECT ${LISTED} FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id
    WHERE ${visibleTo(reader)} AND a.status = 'published' AND a.search_vector @@ ${query}
    ORDER BY ts_rank_cd(a.search_vector, ${query}) DESC, (a.helpful_count - a.not_helpful_count) DESC, a.view_count DESC
    LIMIT ${limit}
  `);
}

/** One article the reader may see (404 otherwise, so restricted articles are indistinguishable from missing ones). */
export async function readArticle(db: Db, reader: KbReader, slug: string, opts: { countView: boolean }): Promise<ListedArticle> {
  const row = await db.maybe<ListedArticle>(sql`
    SELECT ${LISTED}, a.body FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id
    WHERE (a.slug = ${slug} OR a.id = ${slug}) AND ${visibleTo(reader)} AND a.status = 'published'
  `);
  if (!row) throw notFound('Article');
  if (opts.countView) {
    await db.exec(sql`UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ${row.id}`);
    row.view_count += 1;
  }
  return row;
}

export async function categoriesFor(db: Db, reader: KbReader) {
  return db.many<{ id: string; slug: string; name: string; description: string; articles: number }>(sql`
    SELECT c.id, c.slug, c.name, c.description, count(a.id)::int AS articles
    FROM kb_categories c JOIN kb_articles a ON a.category_id = c.id AND ${visibleTo(reader)} AND a.status = 'published'
    GROUP BY c.id ORDER BY c.position, c.name
  `);
}

// ---- Feedback -------------------------------------------------------------------------------------

/** Anonymous readers vote once per address; the address is stored only as a keyed hash. */
export function anonymousVoter(app: App, ip: string): string {
  return `ip:${hmacSha256(app.config.encryptionKeys, `kb-voter:${ip}`).slice(0, 32)}`;
}

export async function voteOnArticle(db: Db, app: App, articleId: string, voter: string, helpful: boolean): Promise<{ yes: number; no: number }> {
  const now = app.clock.now();
  await db.exec(sql`
    INSERT INTO kb_article_votes (article_id, voter, helpful, created_at, updated_at) VALUES (${articleId}, ${voter}, ${helpful}, ${now}, ${now})
    ON CONFLICT (article_id, voter) DO UPDATE SET helpful = EXCLUDED.helpful, updated_at = EXCLUDED.updated_at
  `);
  const counts = await db.one<{ helpful_count: number; not_helpful_count: number }>(sql`
    UPDATE kb_articles SET
      helpful_count = (SELECT count(*)::int FROM kb_article_votes v WHERE v.article_id = ${articleId} AND v.helpful),
      not_helpful_count = (SELECT count(*)::int FROM kb_article_votes v WHERE v.article_id = ${articleId} AND NOT v.helpful)
    WHERE id = ${articleId} RETURNING helpful_count, not_helpful_count
  `);
  return { yes: counts.helpful_count, no: counts.not_helpful_count };
}
