import { z } from 'zod';
import type { Router, RouteContext } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { DAY } from '../../core/clock.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { likePattern, pageQuery, paginate, qDate } from '../../core/validation.js';
import { getUser } from '../customers/service.js';
import { sanitizeHtml, safeUrl } from './html.js';
import {
  ACCESS_FILE_COLUMNS,
  checkUpload,
  discardStored,
  downloadHeaders,
  getAccessFile,
  insertFileRow,
  storeObject,
  type AccessFileRow,
  type UploadedFile,
} from './downloads.js';
import {
  LIMIT_PERIODS,
  RESOURCE_COLUMNS,
  RESOURCE_KINDS,
  accessSettingsSchema,
  attachRules,
  evaluate,
  findTarget,
  getResource,
  groupsOfUser,
  loadProfile,
  loadResources,
  normalizePath,
  presentDecision,
  settingsOf,
  tenantScopeSql,
  viewerFor,
  UNPROTECTED,
  type AccessSettings,
  type ResourceKind,
  type ResourceRow,
  type RuleRow,
} from './service.js';
import { requireUnscoped } from './routes-groups.js';

// ---- Presenters -------------------------------------------------------------------------------

export function presentRules(rules: RuleRow[]) {
  return {
    products: rules.filter((r) => r.kind === 'product').map((r) => ({ id: r.product_id!, key: r.product_key, name: r.product_name, kind: r.product_kind })),
    groups: rules.filter((r) => r.kind === 'group').map((r) => ({ id: r.group_id!, name: r.group_name })),
    anyCustomer: rules.some((r) => r.kind === 'any_customer'),
  };
}

function presentResource(r: ResourceRow) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    description: r.description,
    path: r.path,
    url: r.url,
    ...(r.body !== undefined ? { body: r.body } : {}),
    status: r.status,
    showLocked: r.show_locked,
    position: r.position,
    rules: presentRules(r.rules),
    release: { mode: r.release_mode, days: r.release_days, date: r.release_at },
    windowDays: r.window_days,
    fileCount: r.file_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type FileStats = { downloads_30d?: number; downloads_total?: number; customers?: number; resource_count?: number };

function presentFile(f: AccessFileRow & FileStats) {
  return {
    id: f.id,
    title: f.title,
    description: f.description,
    filename: f.filename,
    contentType: f.content_type,
    size: f.size,
    sha256: f.sha256,
    downloadLimit: f.download_limit,
    limitPeriod: f.limit_period,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    ...(f.downloads_total !== undefined
      ? { usage: { downloads30d: f.downloads_30d ?? 0, downloadsTotal: f.downloads_total, customers: f.customers ?? 0 }, resourceCount: f.resource_count ?? 0 }
      : {}),
  };
}

// ---- Resource input ---------------------------------------------------------------------------

const rulesSchema = z.object({
  /** Plans and other products, by id or key. */
  productIds: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  groupIds: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  anyCustomer: z.boolean().default(false),
});

const releaseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('immediate') }),
  z.object({ mode: z.literal('days'), days: z.number().int().min(0).max(3650) }),
  z.object({ mode: z.literal('date'), date: z.coerce.date() }),
]);

const resourceFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  /** url and folder resources: the path to protect (an http(s) URL is reduced to its path). */
  path: z.string().trim().min(1).max(2000).optional(),
  /** page resources: HTML, sanitized on save. */
  body: z.string().max(500_000).optional(),
  /** link resources: the external URL revealed to customers with access. */
  url: z.string().trim().min(1).max(2000).optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  /** List the resource as locked to customers without access (title and description only). */
  showLocked: z.boolean().default(false),
  rules: rulesSchema.default({ productIds: [], groupIds: [], anyCustomer: false }),
  release: releaseSchema.default({ mode: 'immediate' }),
  /** Access ends this many days after the resource opened for the customer. */
  windowDays: z.number().int().min(1).max(3650).nullable().default(null),
  position: z.number().int().min(0).max(1_000_000).default(0),
  /** file resources: protected downloads offered, in order. */
  fileIds: z.array(z.string().min(1).max(100)).max(50).default([]),
};

const createBody = z.object({ kind: z.enum(RESOURCE_KINDS), ...resourceFields });
const updateBody = z.object(resourceFields).partial();
type ResourceInput = Partial<z.infer<typeof updateBody>>;

/** Columns for the fields present in `input`, validated for the resource kind. */
function resourceColumns(kind: ResourceKind, input: ResourceInput, creating: boolean): Record<string, unknown> {
  const errors: { path: string[]; message: string }[] = [];
  const cols: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    status: input.status,
    show_locked: input.showLocked,
    position: input.position,
    window_days: input.windowDays,
  };
  const protectsPath = kind === 'url' || kind === 'folder';
  if (input.path !== undefined) {
    if (!protectsPath) errors.push({ path: ['path'], message: 'Only URL and folder resources have a path' });
    const path = normalizePath(input.path);
    if (!path) errors.push({ path: ['path'], message: 'Enter a path starting with "/" (or a full http(s) URL)' });
    else cols.path = path;
  } else if (creating && protectsPath) errors.push({ path: ['path'], message: 'Enter the path to protect' });
  if (input.body !== undefined) {
    if (kind !== 'page') errors.push({ path: ['body'], message: 'Only pages have a body' });
    else cols.body = sanitizeHtml(input.body);
  } else if (creating && kind === 'page') errors.push({ path: ['body'], message: 'Write the page content' });
  if (input.url !== undefined) {
    if (kind !== 'link') errors.push({ path: ['url'], message: 'Only links have a URL' });
    else if (!/^https?:\/\//i.test(input.url) || !safeUrl(input.url) || !URL.canParse(input.url)) errors.push({ path: ['url'], message: 'Enter a full http(s) URL' });
    else cols.url = input.url;
  } else if (creating && kind === 'link') errors.push({ path: ['url'], message: 'Enter the URL to reveal' });
  if (input.fileIds !== undefined && input.fileIds.length && kind !== 'file') errors.push({ path: ['fileIds'], message: 'Only file resources have downloads' });
  if (input.release !== undefined) {
    cols.release_mode = input.release.mode;
    cols.release_days = input.release.mode === 'days' ? input.release.days : null;
    cols.release_at = input.release.mode === 'date' ? input.release.date : null;
  }
  if (errors.length) throw validationError(errors);
  return cols;
}

async function assertPathFree(db: Db, kind: ResourceKind, path: unknown, exceptId: string | null): Promise<void> {
  if (typeof path !== 'string') return;
  const taken = await db.maybe<{ title: string }>(sql`SELECT title FROM access_resources WHERE kind = ${kind} AND path = ${path} ${exceptId ? sql`AND id <> ${exceptId}` : sql.empty}`);
  if (taken) throw conflict(`"${taken.title}" already protects ${path}`, 'path_taken');
}

async function replaceRules(db: Db, resourceId: string, rules: z.infer<typeof rulesSchema>, now: Date): Promise<void> {
  const productRefs = [...new Set(rules.productIds)];
  const groupIds = [...new Set(rules.groupIds)];
  const products = productRefs.length ? await db.many<{ id: string; key: string }>(sql`SELECT id, key FROM products WHERE id IN ${sql.in(productRefs)} OR key IN ${sql.in(productRefs)}`) : [];
  const missingProducts = productRefs.filter((ref) => !products.some((p) => p.id === ref || p.key === ref));
  const groups = groupIds.length ? await db.many<{ id: string }>(sql`SELECT id FROM user_groups WHERE id IN ${sql.in(groupIds)}`) : [];
  const missingGroups = groupIds.filter((id) => !groups.some((g) => g.id === id));
  const errors = [
    ...(missingProducts.length ? [{ path: ['rules', 'productIds'], message: `Unknown products: ${missingProducts.join(', ')}` }] : []),
    ...(missingGroups.length ? [{ path: ['rules', 'groupIds'], message: `Unknown groups: ${missingGroups.join(', ')}` }] : []),
  ];
  if (errors.length) throw validationError(errors);
  await db.exec(sql`DELETE FROM access_rules WHERE resource_id = ${resourceId}`);
  const rows = [
    ...[...new Set(products.map((p) => p.id))].map((product_id) => ({ kind: 'product', product_id, group_id: null })),
    ...groups.map((g) => ({ kind: 'group', product_id: null, group_id: g.id })),
    ...(rules.anyCustomer ? [{ kind: 'any_customer', product_id: null, group_id: null }] : []),
  ];
  if (rows.length) {
    await db.exec(sql.insertMany('access_rules', rows.map((r) => ({ id: newId('rul'), resource_id: resourceId, ...r, created_at: now })), ''));
  }
}

async function replaceFiles(db: Db, resourceId: string, fileIds: string[]): Promise<void> {
  const ids = [...new Set(fileIds)];
  const found = ids.length ? await db.many<{ id: string }>(sql`SELECT id FROM access_files WHERE id IN ${sql.in(ids)}`) : [];
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw validationError([{ path: ['fileIds'], message: `Unknown files: ${missing.join(', ')}` }]);
  await db.exec(sql`DELETE FROM access_resource_files WHERE resource_id = ${resourceId}`);
  if (ids.length) await db.exec(sql.insertMany('access_resource_files', ids.map((file_id, position) => ({ resource_id: resourceId, file_id, position })), ''));
}

async function resourceFiles(db: Db, resourceId: string): Promise<AccessFileRow[]> {
  return db.many<AccessFileRow>(sql`
    SELECT ${ACCESS_FILE_COLUMNS} FROM access_resource_files rf JOIN access_files af ON af.id = rf.file_id JOIN files f ON f.id = af.file_id
    WHERE rf.resource_id = ${resourceId} ORDER BY rf.position, lower(af.title)
  `);
}

// ---- Uploads --------------------------------------------------------------------------------

/**
 * Read a multipart upload. The route body limit does not apply to multipart
 * streams; the size setting is enforced while streaming instead (the part is
 * cut off at the limit and rejected), so oversized files are never buffered.
 */
async function readUpload(app: App, c: RouteContext): Promise<{ upload: UploadedFile; fields: Record<string, string> }> {
  if (!c.req.isMultipart()) throw validationError([{ path: ['file'], message: 'Send the file as multipart/form-data' }]);
  const part = await c.req.file({ limits: { fileSize: settingsOf(app).maxFileBytes, files: 1 }, throwFileSizeLimit: false });
  if (!part) throw validationError([{ path: ['file'], message: 'Attach a file' }]);
  const data = await part.toBuffer();
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(part.fields)) {
    if (value && !Array.isArray(value) && value.type === 'field' && typeof value.value === 'string') fields[name] = value.value;
  }
  return { upload: checkUpload(app, { filename: part.filename, mimetype: part.mimetype, data, truncated: part.file.truncated }), fields };
}

// ---- Routes ---------------------------------------------------------------------------------

const idParams = z.object({ id: z.string().max(100) });

export function registerAdminRoutes(r: Router, app: App): void {
  // ---- Protected resources ----
  r.route({
    method: 'GET',
    url: '/api/admin/access/resources',
    auth: 'admin',
    permission: 'access.resources.view',
    summary: 'Protected URLs, folders, pages, links and files with their access rules',
    tags: ['Access'],
    query: z.object({
      ...pageQuery,
      q: z.string().trim().max(200).optional(),
      kind: z.enum(RESOURCE_KINDS).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      groupId: z.string().max(100).optional(),
      productId: z.string().max(100).optional(),
    }),
    handler: async (c) => {
      const q = c.query;
      const page = await paginate<Omit<ResourceRow, 'rules'>>(app.db, {
        select: RESOURCE_COLUMNS,
        from: sql`access_resources r`,
        where: sql.where([
          q.q && sql`(r.title ILIKE ${likePattern(q.q)} OR r.path ILIKE ${likePattern(q.q)} OR r.url ILIKE ${likePattern(q.q)} OR r.id = ${q.q})`,
          q.kind && sql`r.kind = ${q.kind}`,
          q.status && sql`r.status = ${q.status}`,
          q.groupId && sql`EXISTS (SELECT 1 FROM access_rules ru WHERE ru.resource_id = r.id AND ru.group_id = ${q.groupId})`,
          q.productId && sql`EXISTS (SELECT 1 FROM access_rules ru WHERE ru.resource_id = r.id AND ru.product_id = ${q.productId})`,
        ]),
        orderBy: sql`ORDER BY r.position, lower(r.title), r.id`,
        page: q.page,
        pageSize: q.pageSize,
      });
      return { ...page, data: (await attachRules(app.db, page.data)).map(presentResource) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/access/options',
    auth: 'admin',
    permission: 'access.resources.view',
    summary: 'Plans, products, user groups and files that access rules can use',
    tags: ['Access'],
    handler: async () => {
      const [products, groups, files] = await Promise.all([
        app.db.many(sql`SELECT id, key, name, kind, status FROM products ORDER BY CASE kind WHEN 'plan' THEN 0 ELSE 1 END, sort_order, name`),
        app.db.many(sql`SELECT id, name FROM user_groups ORDER BY lower(name)`),
        app.db.many(sql`SELECT af.id, af.title, f.filename, f.size FROM access_files af JOIN files f ON f.id = af.file_id ORDER BY lower(af.title)`),
      ]);
      return { products, groups, files };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/access/resources',
    auth: 'admin',
    permission: 'access.resources.manage',
    summary: 'Protect a URL or folder, or publish a members-only page, link or download',
    tags: ['Access'],
    body: createBody,
    handler: async (c) => {
      requireUnscoped(c, 'protected content');
      const b = c.body;
      const cols = resourceColumns(b.kind, b, true);
      const id = await app.db.tx(async (tx) => {
        await assertPathFree(tx, b.kind, cols.path, null);
        const now = app.clock.now();
        const id = newId('res');
        await tx.exec(sql.insert('access_resources', { id, kind: b.kind, ...cols, created_by: c.admin().adminId, created_at: now, updated_at: now }, ''));
        await replaceRules(tx, id, b.rules, now);
        if (b.kind === 'file') await replaceFiles(tx, id, b.fileIds);
        await c.audit(tx, 'access_resource.create', { type: 'access_resource', id }, { kind: b.kind, title: b.title, path: cols.path ?? null, rules: b.rules, release: b.release, windowDays: b.windowDays });
        await app.events.emit(tx, 'access_resource.created', { resourceId: id, kind: b.kind, title: b.title });
        return id;
      });
      c.reply.status(201);
      return presentResource(await getResource(app.db, id, { withBody: true }));
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/access/resources/:id',
    auth: 'admin',
    permission: 'access.resources.view',
    summary: 'A protected resource with its rules, release schedule, files and recent activity',
    tags: ['Access'],
    params: idParams,
    handler: async (c) => {
      const resource = await getResource(app.db, c.params.id, { withBody: true });
      const since = new Date(app.clock.now().getTime() - 30 * DAY);
      const [files, activity] = await Promise.all([
        resourceFiles(app.db, resource.id),
        app.db.one<{ allowed: number; denied: number; last_at: Date | null }>(sql`
          SELECT count(*) FILTER (WHERE l.allowed)::int AS allowed, count(*) FILTER (WHERE NOT l.allowed)::int AS denied, max(l.created_at) AS last_at
          FROM access_log l ${sql.where([sql`l.resource_id = ${resource.id}`, sql`l.created_at >= ${since}`, tenantScopeSql(c.orgScope(), 'l')])}
        `),
      ]);
      return { ...presentResource(resource), files: files.map(presentFile), activity: { allowed30d: activity.allowed, denied30d: activity.denied, lastAccessAt: activity.last_at } };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/access/resources/:id',
    auth: 'admin',
    permission: 'access.resources.manage',
    summary: 'Edit a resource; rules and fileIds, when sent, replace the current ones',
    tags: ['Access'],
    params: idParams,
    body: updateBody,
    handler: async (c) => {
      requireUnscoped(c, 'protected content');
      await app.db.tx(async (tx) => {
        const before = await tx.maybe<{ id: string; kind: ResourceKind; title: string }>(sql`SELECT id, kind, title FROM access_resources WHERE id = ${c.params.id} FOR UPDATE`);
        if (!before) throw notFound('Resource');
        const b = c.body;
        const cols = resourceColumns(before.kind, b, false);
        await assertPathFree(tx, before.kind, cols.path, before.id);
        const now = app.clock.now();
        await tx.exec(sql`UPDATE access_resources SET ${sql.set({ ...cols, updated_at: now })} WHERE id = ${before.id}`);
        if (b.rules) await replaceRules(tx, before.id, b.rules, now);
        if (b.fileIds && before.kind === 'file') await replaceFiles(tx, before.id, b.fileIds);
        const changed = Object.keys(b);
        await c.audit(tx, 'access_resource.update', { type: 'access_resource', id: before.id }, { changed, rules: b.rules, release: b.release, windowDays: b.windowDays, status: b.status });
        await app.events.emit(tx, 'access_resource.updated', { resourceId: before.id, kind: before.kind, title: b.title ?? before.title, changes: changed });
      });
      return presentResource(await getResource(app.db, c.params.id, { withBody: true }));
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/access/resources/:id',
    auth: 'admin',
    permission: 'access.resources.manage',
    summary: 'Delete a resource (its files stay in the download library)',
    tags: ['Access'],
    params: idParams,
    handler: async (c) => {
      requireUnscoped(c, 'protected content');
      await app.db.tx(async (tx) => {
        const row = await tx.maybe<{ id: string; kind: string; title: string; path: string | null }>(sql`DELETE FROM access_resources WHERE id = ${c.params.id} RETURNING id, kind, title, path`);
        if (!row) throw notFound('Resource');
        await c.audit(tx, 'access_resource.delete', { type: 'access_resource', id: row.id }, { kind: row.kind, title: row.title, path: row.path });
        await app.events.emit(tx, 'access_resource.deleted', { resourceId: row.id, kind: row.kind, title: row.title });
      });
    },
  });

  // ---- Testing access ----
  r.route({
    method: 'POST',
    url: '/api/admin/access/check',
    auth: 'admin',
    permission: 'access.resources.view',
    summary: 'Test whether a user (or organization) can open a resource or path now, and why',
    description: 'Not recorded in the access log.',
    tags: ['Access'],
    body: z
      .object({ userId: z.string().max(100).optional(), orgId: z.string().max(100).optional(), resource: z.string().trim().min(1).max(2000) })
      .refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
    handler: async (c) => {
      const viewer = await viewerFor(app.db, c.body, c.orgScope());
      const target = await findTarget(app.db, c.body.resource);
      const profile = await loadProfile(app.db, app, viewer);
      const decision = target.resource ? evaluate(target.resource, profile, app.clock.now()) : UNPROTECTED;
      const productIds = [...profile.products.keys()];
      const products = productIds.length ? await app.db.many<{ id: string; key: string; name: string; kind: string }>(sql`SELECT id, key, name, kind FROM products WHERE id IN ${sql.in(productIds)}`) : [];
      const groups = viewer.userId ? await groupsOfUser(app.db, app, viewer.userId) : [];
      return {
        path: target.path,
        resource: target.resource ? { id: target.resource.id, kind: target.resource.kind, title: target.resource.title, path: target.resource.path } : null,
        ...presentDecision(decision),
        profile: {
          inactive: profile.inactive,
          customerSince: profile.since,
          products: products.map((p) => ({ ...p, since: profile.products.get(p.id) })),
          groups,
        },
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/access/users/:id/content',
    auth: 'admin',
    permission: 'access.resources.view',
    summary: "What a user can open now, what is scheduled to open for them, and what is locked",
    tags: ['Access'],
    params: idParams,
    query: z.object({ orgId: z.string().max(100).optional() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, c.orgScope());
      const viewer = await viewerFor(app.db, { userId: user.id, orgId: c.query.orgId }, c.orgScope());
      const profile = await loadProfile(app.db, app, viewer);
      const now = app.clock.now();
      const resources = await loadResources(app.db, null);
      return {
        inactive: profile.inactive,
        data: resources.map((r) => ({ id: r.id, kind: r.kind, title: r.title, path: r.path, status: r.status, ...presentDecision(evaluate(r, profile, now)) })),
      };
    },
  });

  // ---- Protected downloads ----
  r.route({
    method: 'GET',
    url: '/api/admin/access/files',
    auth: 'admin',
    permission: 'access.files.view',
    summary: 'Protected download files with limits and usage',
    tags: ['Access'],
    query: z.object({ ...pageQuery, q: z.string().trim().max(200).optional() }),
    handler: async (c) => {
      const scope = tenantScopeSql(c.orgScope(), 'd');
      const scoped = scope ? sql`AND ${scope}` : sql.empty;
      const since = new Date(app.clock.now().getTime() - 30 * DAY);
      const page = await paginate<AccessFileRow & FileStats>(app.db, {
        select: sql`${ACCESS_FILE_COLUMNS},
          (SELECT count(*)::int FROM access_downloads d WHERE d.file_id = af.id AND d.created_at >= ${since} ${scoped}) AS downloads_30d,
          (SELECT count(*)::int FROM access_downloads d WHERE d.file_id = af.id ${scoped}) AS downloads_total,
          (SELECT count(DISTINCT d.user_id)::int FROM access_downloads d WHERE d.file_id = af.id ${scoped}) AS customers,
          (SELECT count(*)::int FROM access_resource_files rf WHERE rf.file_id = af.id) AS resource_count`,
        from: sql`access_files af JOIN files f ON f.id = af.file_id`,
        where: sql.where([c.query.q && sql`(af.title ILIKE ${likePattern(c.query.q)} OR f.filename ILIKE ${likePattern(c.query.q)})`]),
        orderBy: sql`ORDER BY af.created_at DESC, af.id`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      return { ...page, data: page.data.map(presentFile) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/access/files',
    auth: 'admin',
    permission: 'access.files.manage',
    summary: 'Upload a protected download (multipart field "file"; optional "title" before it)',
    description: 'The size limit is the access.maxFileBytes setting. New files get the default download limit.',
    tags: ['Access'],
    handler: async (c) => {
      requireUnscoped(c, 'protected downloads');
      const { upload, fields } = await readUpload(app, c);
      const id = newId('dlf');
      const stored = await storeObject(app, id, upload);
      try {
        await app.db.tx(async (tx) => {
          const fileId = await insertFileRow(tx, app, id, upload, stored, c.actor);
          const s = settingsOf(app);
          const now = app.clock.now();
          const title = fields.title?.trim().slice(0, 200) || upload.filename;
          await tx.exec(sql.insert('access_files', {
            id,
            file_id: fileId,
            title,
            description: '',
            download_limit: s.defaultDownloadLimit,
            limit_period: s.defaultLimitPeriod,
            created_by: c.admin().adminId,
            created_at: now,
            updated_at: now,
          }, ''));
          await c.audit(tx, 'access_file.upload', { type: 'access_file', id }, { title, filename: upload.filename, size: stored.size, contentType: upload.contentType });
          await app.events.emit(tx, 'access_file.uploaded', { fileId: id, title, filename: upload.filename, size: stored.size });
        });
      } catch (err) {
        await discardStored(app, stored.key);
        throw err;
      }
      c.reply.status(201);
      return presentFile(await getAccessFile(app.db, id));
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/access/files/:id',
    auth: 'admin',
    permission: 'access.files.view',
    summary: 'A protected file with the resources offering it and its usage',
    tags: ['Access'],
    params: idParams,
    handler: async (c) => {
      const file = await getAccessFile(app.db, c.params.id);
      const scope = tenantScopeSql(c.orgScope(), 'd');
      const since = new Date(app.clock.now().getTime() - 30 * DAY);
      const [resources, usage] = await Promise.all([
        app.db.many(sql`
          SELECT r.id, r.title, r.status FROM access_resource_files rf JOIN access_resources r ON r.id = rf.resource_id WHERE rf.file_id = ${file.id} ORDER BY lower(r.title)
        `),
        app.db.one<{ downloads_30d: number; downloads_total: number; customers: number }>(sql`
          SELECT count(*) FILTER (WHERE d.created_at >= ${since})::int AS downloads_30d, count(*)::int AS downloads_total, count(DISTINCT d.user_id)::int AS customers
          FROM access_downloads d ${sql.where([sql`d.file_id = ${file.id}`, scope])}
        `),
      ]);
      return { ...presentFile({ ...file, ...usage, resource_count: resources.length }), resources };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/access/files/:id',
    auth: 'admin',
    permission: 'access.files.manage',
    summary: 'Rename a file or change its per-customer download limit',
    tags: ['Access'],
    params: idParams,
    body: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000),
      /** Downloads per customer per period; null for unlimited. */
      downloadLimit: z.number().int().min(1).max(100_000).nullable(),
      limitPeriod: z.enum(LIMIT_PERIODS),
    }).partial(),
    handler: async (c) => {
      requireUnscoped(c, 'protected downloads');
      await app.db.tx(async (tx) => {
        const before = await getAccessFile(tx, c.params.id, { lock: true });
        const b = c.body;
        await tx.exec(sql`
          UPDATE access_files SET ${sql.set({ title: b.title, description: b.description, download_limit: b.downloadLimit, limit_period: b.limitPeriod, updated_at: app.clock.now() })}
          WHERE id = ${before.id}
        `);
        await c.audit(tx, 'access_file.update', { type: 'access_file', id: before.id }, { ...b, previous: { downloadLimit: before.download_limit, limitPeriod: before.limit_period } });
        await app.events.emit(tx, 'access_file.updated', { fileId: before.id, title: b.title ?? before.title, changes: Object.keys(b) });
      });
      return presentFile(await getAccessFile(app.db, c.params.id));
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/access/files/:id/content',
    auth: 'admin',
    permission: 'access.files.manage',
    summary: 'Replace the contents of a file (a new version); links and limits are kept',
    tags: ['Access'],
    params: idParams,
    handler: async (c) => {
      requireUnscoped(c, 'protected downloads');
      await getAccessFile(app.db, c.params.id);
      const { upload } = await readUpload(app, c);
      const stored = await storeObject(app, c.params.id, upload);
      let previousKey: string;
      try {
        previousKey = await app.db.tx(async (tx) => {
          const before = await getAccessFile(tx, c.params.id, { lock: true });
          const fileId = await insertFileRow(tx, app, before.id, upload, stored, c.actor);
          await tx.exec(sql`UPDATE access_files SET file_id = ${fileId}, updated_at = ${app.clock.now()} WHERE id = ${before.id}`);
          await tx.exec(sql`DELETE FROM files WHERE id = ${before.file_id}`);
          await c.audit(tx, 'access_file.replace', { type: 'access_file', id: before.id }, { filename: upload.filename, size: stored.size, previous: { filename: before.filename, sha256: before.sha256 } });
          await app.events.emit(tx, 'access_file.updated', { fileId: before.id, title: before.title, changes: ['content'] });
          return before.storage_key;
        });
      } catch (err) {
        await discardStored(app, stored.key);
        throw err;
      }
      await discardStored(app, previousKey);
      return presentFile(await getAccessFile(app.db, c.params.id));
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/access/files/:id',
    auth: 'admin',
    permission: 'access.files.manage',
    summary: 'Delete a file and its download history (refused while a resource offers it)',
    tags: ['Access'],
    params: idParams,
    handler: async (c) => {
      requireUnscoped(c, 'protected downloads');
      const removed = await app.db.tx(async (tx) => {
        const file = await getAccessFile(tx, c.params.id, { lock: true });
        const resources = await tx.many<{ id: string; title: string }>(sql`
          SELECT r.id, r.title FROM access_resource_files rf JOIN access_resources r ON r.id = rf.resource_id WHERE rf.file_id = ${file.id} ORDER BY lower(r.title)
        `);
        if (resources.length) throw conflict(`Remove this file from ${resources.length === 1 ? `"${resources[0].title}"` : `${resources.length} resources`} first`, 'file_in_use', { resources });
        await tx.exec(sql`DELETE FROM access_files WHERE id = ${file.id}`);
        await tx.exec(sql`DELETE FROM files WHERE id = ${file.file_id}`);
        await c.audit(tx, 'access_file.delete', { type: 'access_file', id: file.id }, { title: file.title, filename: file.filename });
        await app.events.emit(tx, 'access_file.deleted', { fileId: file.id, title: file.title });
        return file;
      });
      await discardStored(app, removed.storage_key);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/access/files/:id/download',
    auth: 'admin',
    permission: 'access.files.view',
    summary: 'Download a protected file (administrators; not counted against any limit)',
    tags: ['Access'],
    params: idParams,
    handler: async (c) => {
      const file = await getAccessFile(app.db, c.params.id);
      const data = await app.storage.get(file.storage_key);
      if (!data) throw notFound('File contents');
      return c.reply.headers(downloadHeaders(file)).send(data);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/access/downloads',
    auth: 'admin',
    permission: 'access.files.view',
    summary: 'Download log',
    tags: ['Access'],
    query: z.object({ ...pageQuery, fileId: z.string().max(100).optional(), userId: z.string().max(100).optional(), from: qDate.optional(), to: qDate.optional() }),
    handler: async (c) => {
      const q = c.query;
      return paginate(app.db, {
        select: sql`d.id, d.file_id, af.title AS file_title, d.resource_id, r.title AS resource_title, d.user_id, u.email AS user_email, u.name AS user_name, d.org_id, d.ip, d.user_agent, d.bytes, d.created_at`,
        from: sql`access_downloads d JOIN access_files af ON af.id = d.file_id LEFT JOIN access_resources r ON r.id = d.resource_id LEFT JOIN users u ON u.id = d.user_id`,
        where: sql.where([
          q.fileId && sql`d.file_id = ${q.fileId}`,
          q.userId && sql`d.user_id = ${q.userId}`,
          q.from && sql`d.created_at >= ${q.from}`,
          q.to && sql`d.created_at <= ${q.to}`,
          tenantScopeSql(c.orgScope(), 'd'),
        ]),
        orderBy: sql`ORDER BY d.created_at DESC, d.id DESC`,
        page: q.page,
        pageSize: q.pageSize,
      });
    },
  });

  // ---- Access log ----
  r.route({
    method: 'GET',
    url: '/api/admin/access/log',
    auth: 'admin',
    permission: 'access.log.view',
    summary: 'Access checks, content views, download links and downloads, allowed or refused',
    tags: ['Access'],
    query: z.object({
      ...pageQuery,
      userId: z.string().max(100).optional(),
      resourceId: z.string().max(100).optional(),
      event: z.enum(['check', 'view', 'link', 'download']).optional(),
      outcome: z.enum(['allowed', 'denied']).optional(),
      reason: z.string().max(60).optional(),
      q: z.string().trim().max(200).optional(),
      from: qDate.optional(),
      to: qDate.optional(),
    }),
    handler: async (c) => {
      const q = c.query;
      return paginate(app.db, {
        select: sql`l.*, u.email AS user_email, u.name AS user_name`,
        from: sql`access_log l LEFT JOIN users u ON u.id = l.user_id`,
        where: sql.where([
          q.userId && sql`l.user_id = ${q.userId}`,
          q.resourceId && sql`l.resource_id = ${q.resourceId}`,
          q.event && sql`l.event = ${q.event}`,
          q.outcome && sql`l.allowed = ${q.outcome === 'allowed'}`,
          q.reason && sql`l.reason = ${q.reason}`,
          q.q && sql`(u.email ILIKE ${likePattern(q.q)} OR l.resource_title ILIKE ${likePattern(q.q)} OR l.path ILIKE ${likePattern(q.q)} OR l.ip = ${q.q})`,
          q.from && sql`l.created_at >= ${q.from}`,
          q.to && sql`l.created_at <= ${q.to}`,
          tenantScopeSql(c.orgScope(), 'l'),
        ]),
        orderBy: sql`ORDER BY l.created_at DESC, l.id DESC`,
        page: q.page,
        pageSize: q.pageSize,
      });
    },
  });

  // ---- Settings ----
  r.route({
    method: 'GET',
    url: '/api/admin/access/settings',
    auth: 'admin',
    permission: 'access.files.view',
    summary: 'Upload size limit, link lifetime, default download limit and log retention',
    tags: ['Access'],
    handler: () => settingsOf(app),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/access/settings',
    auth: 'admin',
    permission: 'access.files.manage',
    summary: 'Change content protection settings',
    tags: ['Access'],
    body: accessSettingsSchema.partial(),
    handler: async (c) => {
      requireUnscoped(c, 'content protection settings');
      return app.db.tx((tx) => app.settings.update<AccessSettings>(tx, 'access', c.body, c.actor));
    },
  });
}
