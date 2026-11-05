import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { PRESETS, sanitizeCss, themeAssets, themeCss, themeTokens, type ThemeTokens } from './tokens.js';

const ASSET_MAX_BYTES = 1024 * 1024;

/** Identify an uploaded brand image by its bytes; the declared type and file name are not trusted. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const sig = b.subarray(0, 12).toString('latin1');
  if (sig.startsWith('GIF87a') || sig.startsWith('GIF89a')) return 'image/gif';
  if (sig.startsWith('RIFF') && sig.slice(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = b.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

interface ThemeRow {
  id: string;
  key: string;
  name: string;
  description: string;
  source: 'preset' | 'custom' | 'upload';
  scope: string;
  is_active: boolean;
  published_revision_id: string | null;
}

interface RevisionRow {
  id: string;
  theme_id: string;
  version: number;
  tokens: ThemeTokens;
  custom_css: string;
  assets: Record<string, string>;
  status: 'draft' | 'published' | 'archived';
}

const scopeSchema = z.string().regex(/^(global|org:[a-z0-9_]+)$/).default('global');

export interface ResolvedTheme {
  themeId: string;
  name: string;
  revision: number;
  tokens: ThemeTokens;
  assets: Record<string, string>;
  css: string;
  scope: string;
}

/** The published theme for a scope, falling back to the global theme, then the default preset. */
export async function activeTheme(db: Db, scope = 'global'): Promise<ResolvedTheme> {
  const scopes = scope === 'global' ? ['global'] : [scope, 'global'];
  for (const s of scopes) {
    const row = await db.maybe<any>(sql`
      SELECT t.id, t.name, t.scope, r.version, r.tokens, r.custom_css, r.assets FROM themes t JOIN theme_revisions r ON r.id = t.published_revision_id
      WHERE t.is_active AND t.scope = ${s}
    `);
    if (row) return { themeId: row.id, name: row.name, revision: row.version, tokens: row.tokens, assets: row.assets, css: themeCss(row.tokens, row.custom_css), scope: row.scope };
  }
  const p = PRESETS[0];
  return { themeId: 'preset', name: p.name, revision: 0, tokens: p.tokens, assets: themeAssets.parse({}), css: themeCss(p.tokens), scope: 'global' };
}

/** Resolve a tenant scope from an org id, slug or custom domain. */
export async function scopeFor(db: Db, q: { org?: string; domain?: string }): Promise<string> {
  if (q.org) {
    const org = await db.maybe<{ id: string }>(sql`SELECT id FROM organizations WHERE (id = ${q.org} OR slug = ${q.org}) AND deleted_at IS NULL`);
    if (org) return `org:${org.id}`;
  }
  if (q.domain) {
    const org = await db.maybe<{ id: string }>(sql`SELECT id FROM organizations WHERE lower(custom_domain) = ${q.domain.toLowerCase()} AND deleted_at IS NULL`);
    if (org) return `org:${org.id}`;
  }
  return 'global';
}

async function theme(db: Db, id: string): Promise<ThemeRow> {
  const row = await db.maybe<ThemeRow>(sql`SELECT * FROM themes WHERE id = ${id} OR key = ${id}`);
  if (!row) throw notFound('Theme');
  return row;
}

async function nextVersion(db: Db, themeId: string): Promise<number> {
  const row = await db.one<{ v: number | null }>(sql`SELECT max(version) AS v FROM theme_revisions WHERE theme_id = ${themeId}`);
  return (row.v ?? 0) + 1;
}

function parseRevision(input: { tokens: unknown; customCss?: string; assets?: unknown }) {
  const tokens = themeTokens.safeParse(input.tokens);
  if (!tokens.success) throw validationError(tokens.error.issues.map((i) => ({ path: ['tokens', ...i.path.map(String)], message: i.message })));
  const assets = themeAssets.safeParse(input.assets ?? {});
  if (!assets.success) throw validationError(assets.error.issues.map((i) => ({ path: ['assets', ...i.path.map(String)], message: i.message })));
  return { tokens: tokens.data, assets: assets.data, customCss: sanitizeCss(input.customCss ?? '') };
}

async function createTheme(db: Db, app: App, input: { key: string; name: string; description: string; source: ThemeRow['source']; scope: string; tokens: ThemeTokens; customCss: string; assets: unknown; publish: boolean; createdBy: string | null }) {
  const id = newId('thm');
  const now = app.clock.now();
  await db.exec(sql.insert('themes', { id, key: input.key, name: input.name, description: input.description, source: input.source, scope: input.scope, is_active: false, created_at: now, updated_at: now }, ''));
  const revId = newId('thr');
  await db.exec(sql.insert('theme_revisions', {
    id: revId,
    theme_id: id,
    version: 1,
    tokens: input.tokens,
    custom_css: input.customCss,
    assets: input.assets ?? {},
    status: input.publish ? 'published' : 'draft',
    created_by: input.createdBy,
    created_at: now,
    published_at: input.publish ? now : null,
  }, ''));
  if (input.publish) await db.exec(sql`UPDATE themes SET published_revision_id = ${revId} WHERE id = ${id}`);
  return id;
}

export const themesModule: ModuleDefinition = {
  id: 'themes',
  name: 'Themes & white-label',
  description: 'Design tokens, presets, custom CSS, logos and tenant-specific branding with preview, publishing and rollback.',
  version: '1.0.0',
  dependencies: ['core', 'iam', 'customers'],
  migrations: [
    {
      version: '001',
      name: 'themes',
      up: `
        CREATE TABLE themes (
          id text PRIMARY KEY,
          key text NOT NULL UNIQUE,
          name text NOT NULL,
          description text NOT NULL DEFAULT '',
          source text NOT NULL CHECK (source IN ('preset', 'custom', 'upload')),
          scope text NOT NULL DEFAULT 'global',
          is_active boolean NOT NULL DEFAULT false,
          published_revision_id text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX themes_active_scope_uq ON themes (scope) WHERE is_active;

        CREATE TABLE theme_revisions (
          id text PRIMARY KEY,
          theme_id text NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
          version int NOT NULL,
          tokens jsonb NOT NULL,
          custom_css text NOT NULL DEFAULT '',
          assets jsonb NOT NULL DEFAULT '{}',
          status text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
          note text,
          created_by text,
          created_at timestamptz NOT NULL,
          published_at timestamptz,
          UNIQUE (theme_id, version)
        );
      `,
    },
  ],
  permissions: [
    { key: 'themes.themes.view', label: 'View themes' },
    { key: 'themes.themes.manage', label: 'Edit, publish and activate themes' },
  ],
  nav: [{ id: 'themes', label: 'Themes & branding', path: '/platform/themes', icon: 'palette', section: 'platform', permission: 'themes.themes.view', order: 40 }],
  events: [{ type: 'theme.published', description: 'A theme was published or activated' }],
  setup(app) {
    // The admin panel itself is white-labelled by the active global theme.
    app.hooks.addFilter('admin.theme', 'themes', async (value: unknown) => {
      if (!app.modules.isEnabled('themes')) return value;
      const t = await activeTheme(app.db, 'global');
      return { name: t.name, revision: t.revision, tokens: t.tokens, assets: t.assets, css: t.css };
    });
  },
  async start(app) {
    const now = app.clock.now();
    for (const p of PRESETS) {
      const exists = await app.db.maybe(sql`SELECT 1 FROM themes WHERE key = ${`preset-${p.key}`}`);
      if (exists) continue;
      await app.db.tx((tx) => createTheme(tx, app, { key: `preset-${p.key}`, name: p.name, description: p.description, source: 'preset', scope: 'global', tokens: p.tokens, customCss: '', assets: {}, publish: true, createdBy: null }));
    }
    const anyActive = await app.db.maybe(sql`SELECT 1 FROM themes WHERE is_active AND scope = 'global'`);
    if (!anyActive) await app.db.exec(sql`UPDATE themes SET is_active = TRUE, updated_at = ${now} WHERE key = 'preset-default'`);
  },
  routes(r, app) {
    r.route({
      method: 'GET',
      url: '/api/admin/themes',
      auth: 'admin',
      permission: 'themes.themes.view',
      summary: 'Themes and which one is active per scope',
      tags: ['Themes'],
      handler: async () => ({
        data: await app.db.many(sql`
          SELECT t.*, r.version AS published_version, r.tokens AS published_tokens,
            (SELECT max(version) FROM theme_revisions x WHERE x.theme_id = t.id AND x.status = 'draft') AS draft_version
          FROM themes t LEFT JOIN theme_revisions r ON r.id = t.published_revision_id ORDER BY t.source DESC, t.name
        `),
      }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/themes/:id',
      auth: 'admin',
      permission: 'themes.themes.view',
      summary: 'Theme with published revision, draft and history',
      tags: ['Themes'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const t = await theme(app.db, c.params.id);
        const revisions = await app.db.many<RevisionRow>(sql`SELECT * FROM theme_revisions WHERE theme_id = ${t.id} ORDER BY version DESC`);
        return { ...t, revisions, draft: revisions.find((x) => x.status === 'draft') ?? null, published: revisions.find((x) => x.id === t.published_revision_id) ?? null };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/themes',
      auth: 'admin',
      permission: 'themes.themes.manage',
      summary: 'Create a custom theme (optionally starting from another theme)',
      tags: ['Themes'],
      body: z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).default(''), basedOn: z.string().optional(), scope: scopeSchema }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          let tokens = PRESETS[0].tokens;
          let customCss = '';
          let assets = {};
          if (c.body.basedOn) {
            const src = await theme(tx, c.body.basedOn);
            const rev = await tx.maybe<RevisionRow>(sql`SELECT * FROM theme_revisions WHERE id = ${src.published_revision_id}`);
            if (rev) ({ tokens, custom_css: customCss, assets } = rev);
          }
          const key = `${c.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${newId('k').slice(-6)}`;
          const id = await createTheme(tx, app, { key, name: c.body.name, description: c.body.description, source: 'custom', scope: c.body.scope, tokens, customCss, assets, publish: false, createdBy: c.admin().adminId });
          await c.audit(tx, 'theme.create', { type: 'theme', id }, { basedOn: c.body.basedOn ?? null, scope: c.body.scope });
          return theme(tx, id);
        }),
    });

    r.route({
      method: 'PUT',
      url: '/api/admin/themes/:id/draft',
      auth: 'admin',
      permission: 'themes.themes.manage',
      summary: 'Save the draft (preview it before publishing)',
      tags: ['Themes'],
      params: z.object({ id: z.string() }),
      body: z.object({ tokens: z.unknown(), customCss: z.string().max(50_000).default(''), assets: z.unknown().optional(), note: z.string().max(300).optional() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const t = await theme(tx, c.params.id);
          if (t.source === 'preset') throw conflict('Presets are read-only; create a theme based on this preset to customize it', 'theme_preset');
          const parsed = parseRevision(c.body);
          const draft = await tx.maybe<{ id: string }>(sql`SELECT id FROM theme_revisions WHERE theme_id = ${t.id} AND status = 'draft'`);
          if (draft) {
            await tx.exec(sql`UPDATE theme_revisions SET tokens = ${sql.json(parsed.tokens)}, custom_css = ${parsed.customCss}, assets = ${sql.json(parsed.assets)}, note = ${c.body.note ?? null} WHERE id = ${draft.id}`);
          } else {
            await tx.exec(sql.insert('theme_revisions', { id: newId('thr'), theme_id: t.id, version: await nextVersion(tx, t.id), tokens: parsed.tokens, custom_css: parsed.customCss, assets: parsed.assets, status: 'draft', note: c.body.note ?? null, created_by: c.admin().adminId, created_at: app.clock.now() }, ''));
          }
          return { ok: true, css: themeCss(parsed.tokens, parsed.customCss) };
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/themes/:id/preview.css',
      auth: 'admin',
      permission: 'themes.themes.view',
      summary: 'CSS for previewing the draft (or a given revision)',
      tags: ['Themes'],
      params: z.object({ id: z.string() }),
      query: z.object({ revision: z.string().optional() }),
      handler: async (c) => {
        const t = await theme(app.db, c.params.id);
        const rev = await app.db.maybe<RevisionRow>(
          c.query.revision
            ? sql`SELECT * FROM theme_revisions WHERE id = ${c.query.revision} AND theme_id = ${t.id}`
            : sql`SELECT * FROM theme_revisions WHERE theme_id = ${t.id} ORDER BY (status = 'draft') DESC, version DESC LIMIT 1`,
        );
        if (!rev) throw notFound('Theme revision');
        return c.reply.header('content-type', 'text/css; charset=utf-8').send(themeCss(rev.tokens, rev.custom_css));
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/themes/:id/publish',
      auth: 'admin',
      permission: 'themes.themes.manage',
      summary: 'Publish the draft (or re-publish an older revision to roll back)',
      tags: ['Themes'],
      params: z.object({ id: z.string() }),
      body: z.object({ revisionId: z.string().optional() }).default({}),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const t = await theme(tx, c.params.id);
          const now = app.clock.now();
          let revisionId: string;
          if (c.body.revisionId) {
            // Rollback: copy the old revision forward as a new published version.
            const old = await tx.maybe<RevisionRow>(sql`SELECT * FROM theme_revisions WHERE id = ${c.body.revisionId} AND theme_id = ${t.id}`);
            if (!old) throw notFound('Theme revision');
            revisionId = newId('thr');
            await tx.exec(sql.insert('theme_revisions', { id: revisionId, theme_id: t.id, version: await nextVersion(tx, t.id), tokens: old.tokens, custom_css: old.custom_css, assets: old.assets, status: 'published', note: `Rollback to v${old.version}`, created_by: c.admin().adminId, created_at: now, published_at: now }, ''));
          } else {
            const draft = await tx.maybe<{ id: string }>(sql`SELECT id FROM theme_revisions WHERE theme_id = ${t.id} AND status = 'draft'`);
            if (!draft) throw conflict('There is no draft to publish', 'no_draft');
            await tx.exec(sql`UPDATE theme_revisions SET status = 'published', published_at = ${now} WHERE id = ${draft.id}`);
            revisionId = draft.id;
          }
          if (t.published_revision_id) await tx.exec(sql`UPDATE theme_revisions SET status = 'archived' WHERE id = ${t.published_revision_id}`);
          await tx.exec(sql`UPDATE themes SET published_revision_id = ${revisionId}, updated_at = ${now} WHERE id = ${t.id}`);
          await c.audit(tx, 'theme.publish', { type: 'theme', id: t.id }, { revisionId, rollback: Boolean(c.body.revisionId) });
          await app.events.emit(tx, 'theme.published', { themeId: t.id, revisionId, scope: t.scope });
          return theme(tx, t.id);
        }),
    });

    r.route({
      method: 'POST',
      url: '/api/admin/themes/:id/activate',
      auth: 'admin',
      permission: 'themes.themes.manage',
      summary: 'Make a published theme the active one for a scope (global or one organization)',
      tags: ['Themes'],
      params: z.object({ id: z.string() }),
      body: z.object({ scope: scopeSchema }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const t = await theme(tx, c.params.id);
          if (!t.published_revision_id) throw conflict('Publish the theme before activating it', 'theme_unpublished');
          if (c.body.scope !== 'global') {
            const orgId = c.body.scope.slice(4);
            const org = await tx.maybe(sql`SELECT 1 FROM organizations WHERE id = ${orgId} AND deleted_at IS NULL`);
            if (!org) throw notFound('Organization');
          }
          await tx.exec(sql`UPDATE themes SET is_active = FALSE WHERE scope = ${c.body.scope} AND is_active`);
          await tx.exec(sql`UPDATE themes SET is_active = TRUE, scope = ${c.body.scope}, updated_at = ${app.clock.now()} WHERE id = ${t.id}`);
          await c.audit(tx, 'theme.activate', { type: 'theme', id: t.id }, { scope: c.body.scope });
          await app.events.emit(tx, 'theme.published', { themeId: t.id, scope: c.body.scope, activated: true });
          return theme(tx, t.id);
        }),
    });

    r.route({
      method: 'GET',
      url: '/api/admin/themes/:id/export',
      auth: 'admin',
      permission: 'themes.themes.view',
      summary: 'Export a theme as a portable JSON package',
      tags: ['Themes'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const t = await theme(app.db, c.params.id);
        const rev = await app.db.maybe<RevisionRow>(sql`SELECT * FROM theme_revisions WHERE id = ${t.published_revision_id}`);
        if (!rev) throw conflict('Publish the theme before exporting it', 'theme_unpublished');
        return c.reply
          .header('content-disposition', `attachment; filename="${t.key}.theme.json"`)
          .send({ format: 'steward-theme', version: 1, name: t.name, description: t.description, tokens: rev.tokens, customCss: rev.custom_css, assets: rev.assets });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/themes/import',
      auth: 'admin',
      permission: 'themes.themes.manage',
      summary: 'Install a theme from a JSON package',
      tags: ['Themes'],
      body: z.object({ format: z.literal('steward-theme'), name: z.string().trim().min(1).max(80), description: z.string().max(300).default(''), tokens: z.unknown(), customCss: z.string().max(50_000).default(''), assets: z.unknown().optional() }),
      handler: async (c) =>
        app.db.tx(async (tx) => {
          const parsed = parseRevision(c.body);
          const key = `${c.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${newId('k').slice(-6)}`;
          const id = await createTheme(tx, app, { key, name: c.body.name, description: c.body.description, source: 'upload', scope: 'global', tokens: parsed.tokens, customCss: parsed.customCss, assets: parsed.assets, publish: true, createdBy: c.admin().adminId });
          await c.audit(tx, 'theme.import', { type: 'theme', id });
          return theme(tx, id);
        }),
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/themes/:id',
      auth: 'admin',
      permission: 'themes.themes.manage',
      summary: 'Delete an inactive custom theme',
      tags: ['Themes'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        await app.db.tx(async (tx) => {
          const t = await theme(tx, c.params.id);
          if (t.source === 'preset') throw conflict('Presets cannot be deleted', 'theme_preset');
          if (t.is_active) throw conflict('Activate another theme first', 'theme_active');
          await tx.exec(sql`DELETE FROM themes WHERE id = ${t.id}`);
          await c.audit(tx, 'theme.delete', { type: 'theme', id: t.id });
        });
      },
    });

    // ---- Brand assets ------------------------------------------------------------------------
    r.route({
      method: 'POST',
      url: '/api/admin/themes/assets',
      auth: 'admin',
      permission: 'themes.themes.manage',
      summary: 'Upload a logo, favicon or background image (PNG, JPEG, WebP, GIF, ICO or SVG, up to 1 MB); returns the URL to use in a theme',
      tags: ['Themes'],
      bodyLimit: 2 * 1024 * 1024,
      handler: async (c) => {
        const file = await c.req.file({ limits: { fileSize: ASSET_MAX_BYTES + 1 } });
        if (!file) throw validationError([{ path: ['file'], message: 'Attach an image' }]);
        const data = await file.toBuffer();
        if (data.length > ASSET_MAX_BYTES) throw validationError([{ path: ['file'], message: 'Images must be 1 MB or smaller' }]);
        const contentType = sniffImage(data);
        if (!contentType) throw validationError([{ path: ['file'], message: 'Upload a PNG, JPEG, WebP, GIF, ICO or SVG image' }]);
        const id = newId('file');
        const stored = await app.storage.put(`theme-assets/${id}`, data);
        await app.db.tx(async (tx) => {
          await tx.exec(sql.insert('files', {
            id,
            owner_type: 'theme_asset',
            owner_id: 'global',
            filename: (file.filename || 'asset').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100),
            content_type: contentType,
            size: stored.size,
            sha256: stored.sha256,
            storage_key: stored.key,
            uploaded_by_type: 'admin',
            uploaded_by_id: c.admin().adminId,
            created_at: app.clock.now(),
          }, ''));
          await c.audit(tx, 'theme.asset_upload', { type: 'file', id }, { contentType, size: stored.size });
        });
        return { id, url: `/api/public/theme-assets/${id}`, contentType, size: stored.size };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/public/theme-assets/:id',
      auth: 'public',
      hidden: true,
      params: z.object({ id: z.string().max(60) }),
      handler: async (c) => {
        const file = await app.db.maybe<{ content_type: string; storage_key: string; sha256: string }>(sql`
          SELECT content_type, storage_key, sha256 FROM files WHERE id = ${c.params.id} AND owner_type = 'theme_asset'
        `);
        const data = file ? await app.storage.get(file.storage_key) : null;
        if (!file || !data) throw notFound('Asset');
        return c.reply
          .header('content-type', file.content_type)
          .header('cache-control', 'public, max-age=31536000, immutable')
          .header('etag', `"${file.sha256.slice(0, 32)}"`)
          // An SVG can carry script: assets never run code, even when opened directly.
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
          .send(data);
      },
    });

    // ---- Public & client branding ---------------------------------------------------------
    r.route({
      method: 'GET',
      url: '/api/public/theme.css',
      auth: 'public',
      summary: 'Active theme CSS (global, per organization, or per custom domain)',
      tags: ['Themes'],
      query: z.object({ org: z.string().max(100).optional(), domain: z.string().max(253).optional() }),
      handler: async (c) => {
        const scope = await scopeFor(app.db, { org: c.query.org, domain: c.query.domain ?? (c.query.org ? undefined : c.req.hostname) });
        const t = await activeTheme(app.db, scope);
        const etag = `"${createHash('sha1').update(t.css).digest('hex').slice(0, 16)}"`;
        if (c.req.headers['if-none-match'] === etag) return c.reply.status(304).send();
        return c.reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=300').header('etag', etag).send(t.css);
      },
    });

    r.route({
      method: 'GET',
      url: '/api/public/branding',
      auth: 'public',
      summary: 'Branding (name, logos, colours) for login, checkout and email surfaces',
      tags: ['Themes'],
      query: z.object({ org: z.string().max(100).optional(), domain: z.string().max(253).optional() }),
      handler: async (c) => {
        const scope = await scopeFor(app.db, { org: c.query.org, domain: c.query.domain });
        const t = await activeTheme(app.db, scope);
        const general = app.settings.get('general');
        return { scope, appName: t.tokens.branding.appName || general.appName, assets: t.assets, colors: t.tokens.colors, dark: t.tokens.dark, appearance: t.tokens.appearance, branding: t.tokens.branding, cssUrl: `${app.config.appUrl}/api/public/theme.css${scope === 'global' ? '' : `?org=${scope.slice(4)}`}` };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/client/branding',
      auth: 'client',
      summary: "Branding for the signed-in customer's organization",
      tags: ['Client'],
      handler: async (c) => {
        const p = c.customer();
        const t = await activeTheme(app.db, p.orgId ? `org:${p.orgId}` : 'global');
        return { appName: t.tokens.branding.appName || app.settings.get('general').appName, assets: t.assets, colors: t.tokens.colors, dark: t.tokens.dark, css: t.css };
      },
    });
  },
};
