import { z } from 'zod';
import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { diff } from '../../core/json.js';
import { sniffImage } from '../themes/module.js';
import { currentTier, settingsOf, type AffiliateRow } from './service.js';

/**
 * Marketing materials: banners (an uploaded image or an https URL), text links and downloadable files.
 * Each produces a tracking link with the affiliate's own code. A material can be limited to affiliate
 * groups and tiers; it is then visible to affiliates in any of them.
 */
export const MATERIAL_TYPES = ['banner', 'text_link', 'file'] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];

export const BANNER_MAX_BYTES = 2 * 1024 * 1024;
export const FILE_MAX_BYTES = 20 * 1024 * 1024;

export interface MaterialRow {
  id: string;
  type: MaterialType;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  landing_path: string | null;
  link_text: string | null;
  image_url: string | null;
  file_id: string | null;
  width: number | null;
  height: number | null;
  group_ids: string[];
  tier_ids: string[];
  sort_order: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MaterialWithFile extends MaterialRow {
  filename: string | null;
  content_type: string | null;
  size: number | null;
}

const materialFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  /** Where the tracking link lands: a path on your site or a URL on an allowed redirect host. */
  landingPath: z.string().trim().max(2000).nullable().optional(),
  /** Text links: the link text. Banners: the image's alt text. Files: the download label. */
  linkText: z.string().trim().max(200).nullable().optional(),
  /** Banners hosted elsewhere; an uploaded image replaces it. */
  imageUrl: z.string().trim().url().max(2000).refine((u) => u.startsWith('https://'), 'Use an https:// image URL').nullable().optional(),
  width: z.number().int().min(1).max(4000).nullable().optional(),
  height: z.number().int().min(1).max(4000).nullable().optional(),
  groupIds: z.array(z.string().max(60)).max(50).optional(),
  tierIds: z.array(z.string().max(60)).max(50).optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
};

export const createMaterialBody = z.object({ type: z.enum(MATERIAL_TYPES), ...materialFields });
export const updateMaterialBody = z.object(materialFields).partial();
export type CreateMaterialInput = z.infer<typeof createMaterialBody>;
export type UpdateMaterialInput = z.infer<typeof updateMaterialBody>;

const unique = (ids: string[]) => [...new Set(ids)];

/** Material links follow the same rule as `?to=` on tracking links: a same-site path or an allowlisted host. */
export function landingPathFor(app: App, value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  try {
    const url = new URL(value);
    const allowed = settingsOf(app).allowedRedirectHosts.map((h) => h.toLowerCase());
    if ((url.protocol === 'https:' || url.protocol === 'http:') && allowed.includes(url.hostname.toLowerCase())) return url.toString();
  } catch {
    /* not a URL */
  }
  throw validationError([{ path: ['landingPath'], message: 'Use a path on your site (like /pricing) or a URL on an allowed redirect host' }]);
}

/**
 * Deleting a group or tier that materials are limited to would quietly hide them from everyone (or, if the
 * reference were dropped, show them to everyone); refuse until the materials are changed.
 */
export async function assertNotTargeted(db: Db, column: 'group_ids' | 'tier_ids', id: string): Promise<void> {
  const rows = await db.many<{ name: string }>(sql`SELECT name FROM affiliate_materials WHERE ${sql.ident(column)} ? ${id} ORDER BY name LIMIT 6`);
  if (!rows.length) return;
  const names = rows.slice(0, 5).map((r) => r.name).join(', ') + (rows.length > 5 ? ', …' : '');
  throw conflict(`Marketing materials are limited to it (${names}). Change those materials first.`, 'in_use', { materials: rows.map((r) => r.name) });
}

async function assertTargets(db: Db, groupIds: string[], tierIds: string[]): Promise<void> {
  if (groupIds.length) {
    const found = await db.many(sql`SELECT id FROM affiliate_groups WHERE id IN ${sql.in(groupIds)}`);
    if (found.length !== groupIds.length) throw validationError([{ path: ['groupIds'], message: 'Choose existing affiliate groups' }]);
  }
  if (tierIds.length) {
    const found = await db.many(sql`SELECT id FROM affiliate_tiers WHERE id IN ${sql.in(tierIds)}`);
    if (found.length !== tierIds.length) throw validationError([{ path: ['tierIds'], message: 'Choose existing commission tiers' }]);
  }
}

/** Rules that depend on the material type, checked on the merged result of a create or an update. */
function assertShape(m: { type: MaterialType; link_text: string | null; image_url: string | null }): void {
  if (m.type === 'text_link' && !m.link_text) throw validationError([{ path: ['linkText'], message: 'Enter the text of the link' }]);
  if (m.type !== 'banner' && m.image_url) throw validationError([{ path: ['imageUrl'], message: 'Only banners have an image' }]);
}

export async function getMaterial(db: Db, id: string, opts: { lock?: boolean } = {}): Promise<MaterialRow> {
  const row = await db.maybe<MaterialRow>(sql`SELECT * FROM affiliate_materials WHERE id = ${id} ${opts.lock ? sql`FOR UPDATE` : sql.empty}`);
  if (!row) throw notFound('Marketing material');
  return row;
}

export async function createMaterial(db: Db, app: App, input: CreateMaterialInput, actor: Actor): Promise<MaterialRow> {
  const groupIds = unique(input.groupIds ?? []);
  const tierIds = unique(input.tierIds ?? []);
  await assertTargets(db, groupIds, tierIds);
  const banner = input.type === 'banner';
  const row = {
    id: newId('amat'),
    type: input.type,
    name: input.name,
    description: input.description || null,
    status: input.status ?? 'active',
    landing_path: landingPathFor(app, input.landingPath),
    link_text: input.linkText || null,
    image_url: input.imageUrl || null,
    width: banner ? (input.width ?? null) : null,
    height: banner ? (input.height ?? null) : null,
    group_ids: groupIds,
    tier_ids: tierIds,
    sort_order: input.sortOrder ?? 0,
    created_by: actor.id,
    created_at: app.clock.now(),
    updated_at: app.clock.now(),
  };
  assertShape(row);
  await db.exec(sql.insert('affiliate_materials', row, ''));
  await writeAudit(db, app, { actor, action: 'affiliate.material_create', targetType: 'affiliate_material', targetId: row.id, metadata: { type: row.type, name: row.name, groupIds, tierIds } });
  await app.events.emit(db, 'affiliate_material.created', { materialId: row.id, type: row.type, name: row.name });
  return getMaterial(db, row.id);
}

/** Returns the storage keys of files the update dropped, to remove once the transaction commits. */
export async function updateMaterial(db: Db, app: App, id: string, input: UpdateMaterialInput, actor: Actor): Promise<{ material: MaterialRow; removedKeys: string[] }> {
  const before = await getMaterial(db, id, { lock: true });
  const groupIds = input.groupIds === undefined ? undefined : unique(input.groupIds);
  const tierIds = input.tierIds === undefined ? undefined : unique(input.tierIds);
  await assertTargets(db, groupIds ?? [], tierIds ?? []);
  const banner = before.type === 'banner';
  const patch = {
    name: input.name,
    description: input.description === undefined ? undefined : input.description || null,
    status: input.status,
    landing_path: input.landingPath === undefined ? undefined : landingPathFor(app, input.landingPath),
    link_text: input.linkText === undefined ? undefined : input.linkText || null,
    image_url: input.imageUrl === undefined ? undefined : input.imageUrl || null,
    width: banner ? input.width : undefined,
    height: banner ? input.height : undefined,
    group_ids: groupIds,
    tier_ids: tierIds,
    sort_order: input.sortOrder,
  };
  const merged = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as MaterialRow;
  assertShape(merged);
  // A hosted image URL and an uploaded image are alternatives: choosing a URL drops the upload.
  const dropFile = banner && Boolean(patch.image_url) && before.file_id !== null;
  await db.exec(sql`UPDATE affiliate_materials SET ${sql.set({ ...patch, file_id: dropFile ? null : undefined, updated_at: app.clock.now() })} WHERE id = ${id}`);
  const removed = dropFile ? await deleteFileRow(db, before.file_id!) : null;
  await writeAudit(db, app, { actor, action: 'affiliate.material_update', targetType: 'affiliate_material', targetId: id, metadata: { changes: diff(before as unknown as Record<string, unknown>, merged as unknown as Record<string, unknown>) } });
  await app.events.emit(db, 'affiliate_material.updated', { materialId: id, type: before.type, name: merged.name, status: merged.status });
  return { material: await getMaterial(db, id), removedKeys: removed ? [removed] : [] };
}

async function deleteFileRow(db: Db, fileId: string): Promise<string | null> {
  const file = await db.maybe<{ storage_key: string }>(sql`DELETE FROM files WHERE id = ${fileId} AND owner_type = 'affiliate_material' RETURNING storage_key`);
  return file?.storage_key ?? null;
}

/** Delete a material and its stored file. Returns storage keys to remove once the transaction commits. */
export async function deleteMaterial(db: Db, app: App, id: string, actor: Actor): Promise<string[]> {
  const before = await getMaterial(db, id, { lock: true });
  await db.exec(sql`DELETE FROM affiliate_materials WHERE id = ${id}`);
  const keys = (await db.many<{ storage_key: string }>(sql`
    DELETE FROM files WHERE owner_type = 'affiliate_material' AND owner_id = ${id} RETURNING storage_key
  `)).map((f) => f.storage_key);
  await writeAudit(db, app, { actor, action: 'affiliate.material_delete', targetType: 'affiliate_material', targetId: id, metadata: { type: before.type, name: before.name } });
  await app.events.emit(db, 'affiliate_material.deleted', { materialId: id, type: before.type, name: before.name });
  return keys;
}

/** Identify an uploaded file by its bytes; the declared type and file name are not trusted. */
export function sniffMaterialFile(type: MaterialType, data: Buffer): string | null {
  const image = sniffImage(data);
  if (image && image !== 'image/x-icon') return image;
  if (type === 'banner') return null;
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05) && (data[3] === 0x04 || data[3] === 0x06)) return 'application/zip';
  if (data.length >= 12 && data.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  // Plain text (email swipes, copy): valid UTF-8 without NUL bytes. `stream` tolerates a character cut at the boundary.
  const head = data.subarray(0, 4096);
  if (head.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return 'text/plain';
  } catch {
    return null;
  }
}

export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._-]+/, '');
  return cleaned.slice(-100) || 'file';
}

/**
 * Attach a stored upload to a material, replacing any previous file (and, for banners, a hosted image URL).
 * Returns the storage key of the replaced file, to remove once the transaction commits.
 */
export async function attachMaterialFile(
  db: Db,
  app: App,
  id: string,
  file: { fileId: string; filename: string; contentType: string; size: number; sha256: string; storageKey: string; uploadedBy: string | null },
  actor: Actor,
): Promise<{ material: MaterialRow; replacedKey: string | null }> {
  const before = await getMaterial(db, id, { lock: true });
  if (before.type === 'text_link') throw validationError([{ path: ['file'], message: 'Text links have no file' }]);
  await db.exec(sql.insert('files', {
    id: file.fileId,
    owner_type: 'affiliate_material',
    owner_id: id,
    filename: file.filename,
    content_type: file.contentType,
    size: file.size,
    sha256: file.sha256,
    storage_key: file.storageKey,
    uploaded_by_type: 'admin',
    uploaded_by_id: file.uploadedBy,
    created_at: app.clock.now(),
  }, ''));
  await db.exec(sql`UPDATE affiliate_materials SET file_id = ${file.fileId}, image_url = NULL, updated_at = ${app.clock.now()} WHERE id = ${id}`);
  const replacedKey = before.file_id ? await deleteFileRow(db, before.file_id) : null;
  await writeAudit(db, app, { actor, action: 'affiliate.material_upload', targetType: 'affiliate_material', targetId: id, metadata: { fileId: file.fileId, contentType: file.contentType, size: file.size } });
  await app.events.emit(db, 'affiliate_material.updated', { materialId: id, type: before.type, name: before.name, status: before.status });
  return { material: await getMaterial(db, id), replacedKey };
}

// ---- Presentation ----------------------------------------------------------------------------

export const bannerAssetUrl = (app: App, fileId: string) => `${app.config.appUrl}/api/public/affiliate-assets/${fileId}`;

/** The image a banner shows: its uploaded file, else its hosted URL. */
export function bannerImage(app: App, m: Pick<MaterialRow, 'type' | 'file_id' | 'image_url'>): string | null {
  if (m.type !== 'banner') return null;
  return m.file_id ? bannerAssetUrl(app, m.file_id) : m.image_url;
}

export function presentMaterial(app: App, m: MaterialWithFile & { clicks_30d?: number }) {
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    description: m.description,
    status: m.status,
    landingPath: m.landing_path,
    linkText: m.link_text,
    imageUrl: m.image_url,
    previewUrl: bannerImage(app, m),
    width: m.width,
    height: m.height,
    groupIds: m.group_ids,
    tierIds: m.tier_ids,
    sortOrder: m.sort_order,
    file: m.file_id ? { id: m.file_id, filename: m.filename, contentType: m.content_type, size: m.size } : null,
    clicks30d: m.clicks_30d ?? 0,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The affiliate's tracking link for a material: their code, the material's landing page and the material id. */
export function materialLink(app: App, code: string, m: Pick<MaterialRow, 'id' | 'landing_path'>): string {
  const url = new URL(`/r/${encodeURIComponent(code)}`, app.config.appUrl);
  if (m.landing_path) url.searchParams.set('to', m.landing_path);
  url.searchParams.set('m', m.id);
  return url.toString();
}

export interface MaterialView {
  id: string;
  type: MaterialType;
  name: string;
  description: string | null;
  trackingLink: string;
  linkText: string | null;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  /** Ready-to-paste HTML (banners and text links); affiliate links are marked rel="sponsored". */
  embedHtml: string | null;
  file: { filename: string; contentType: string; size: number } | null;
  updatedAt: Date;
}

function viewFor(app: App, aff: Pick<AffiliateRow, 'code'>, m: MaterialWithFile): MaterialView {
  const link = materialLink(app, aff.code, m);
  const image = bannerImage(app, m);
  let embedHtml: string | null = null;
  if (m.type === 'banner' && image) {
    const size = `${m.width ? ` width="${m.width}"` : ''}${m.height ? ` height="${m.height}"` : ''}`;
    embedHtml = `<a href="${escapeHtml(link)}" rel="sponsored"><img src="${escapeHtml(image)}" alt="${escapeHtml(m.link_text ?? m.name)}"${size}></a>`;
  } else if (m.type === 'text_link') {
    embedHtml = `<a href="${escapeHtml(link)}" rel="sponsored">${escapeHtml(m.link_text ?? m.name)}</a>`;
  }
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    description: m.description,
    trackingLink: link,
    linkText: m.link_text,
    imageUrl: image,
    width: m.width,
    height: m.height,
    embedHtml,
    file: m.type === 'file' && m.file_id ? { filename: m.filename!, contentType: m.content_type!, size: m.size! } : null,
    updatedAt: m.updated_at,
  };
}

/**
 * Active materials an affiliate may use: unrestricted ones, plus those limited to the affiliate's group
 * or current tier. Materials still missing their image or file are left out.
 */
async function visibleMaterials(db: Db, app: App, aff: AffiliateRow, id?: string): Promise<MaterialWithFile[]> {
  const tier = await currentTier(db, app, aff.id);
  return db.many<MaterialWithFile>(sql`
    SELECT m.*, f.filename, f.content_type, f.size FROM affiliate_materials m LEFT JOIN files f ON f.id = m.file_id
    WHERE m.status = 'active' ${id ? sql`AND m.id = ${id}` : sql.empty}
      AND ((m.group_ids = '[]'::jsonb AND m.tier_ids = '[]'::jsonb) OR m.group_ids ? ${aff.group_id ?? ''} OR m.tier_ids ? ${tier?.id ?? ''})
      AND (m.type = 'text_link' OR m.file_id IS NOT NULL OR (m.type = 'banner' AND m.image_url IS NOT NULL))
    ORDER BY m.sort_order, m.created_at DESC
  `);
}

export async function materialsFor(db: Db, app: App, aff: AffiliateRow): Promise<MaterialView[]> {
  return (await visibleMaterials(db, app, aff)).map((m) => viewFor(app, aff, m));
}

/** The stored file of a material the affiliate may use (for downloads). */
export async function materialFileFor(db: Db, app: App, aff: AffiliateRow, id: string): Promise<{ filename: string; contentType: string; storageKey: string }> {
  const [m] = await visibleMaterials(db, app, aff, id);
  if (!m?.file_id) throw notFound('Marketing material');
  const file = await db.one<{ filename: string; content_type: string; storage_key: string }>(sql`SELECT filename, content_type, storage_key FROM files WHERE id = ${m.file_id}`);
  return { filename: file.filename, contentType: file.content_type, storageKey: file.storage_key };
}
