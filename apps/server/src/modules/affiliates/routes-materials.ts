import { z } from 'zod';
import type { RouteContext, Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { DAY } from '../../core/clock.js';
import { getAffiliate } from './service.js';
import { ownAffiliate } from './routes.js';
import {
  BANNER_MAX_BYTES,
  FILE_MAX_BYTES,
  MATERIAL_TYPES,
  assertNotTargeted,
  attachMaterialFile,
  createMaterial,
  createMaterialBody,
  deleteMaterial,
  getMaterial,
  materialFileFor,
  materialsFor,
  presentMaterial,
  safeFilename,
  sniffMaterialFile,
  updateMaterial,
  updateMaterialBody,
} from './materials.js';

/** A material with its file details and recent clicks, as administrators see it. */
async function materialDetail(db: Db, app: App, id: string) {
  const row = await db.maybe<any>(sql`
    SELECT m.*, f.filename, f.content_type, f.size,
      (SELECT count(*)::int FROM affiliate_clicks k WHERE k.material_id = m.id AND k.created_at >= ${new Date(app.clock.now().getTime() - 30 * DAY)}) AS clicks_30d
    FROM affiliate_materials m LEFT JOIN files f ON f.id = m.file_id WHERE m.id = ${id}
  `);
  if (!row) throw notFound('Marketing material');
  return presentMaterial(app, row);
}

function sendFile(c: RouteContext, file: { filename: string; contentType: string; data: Buffer }) {
  return c.reply
    .header('content-type', file.contentType)
    .header('content-disposition', `attachment; filename="${safeFilename(file.filename)}"`)
    .header('cache-control', 'private, no-store')
    .send(file.data);
}

const groupBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).nullable().optional() });

export function registerMaterialRoutes(r: Router, app: App): void {
  // ---- Admin: affiliate groups ----------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/affiliate-groups',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Affiliate groups (used to target marketing materials)',
    tags: ['Affiliates'],
    handler: async () => ({
      data: await app.db.many(sql`
        SELECT g.*, (SELECT count(*)::int FROM affiliates a WHERE a.group_id = g.id) AS affiliates,
               (SELECT count(*)::int FROM affiliate_materials m WHERE m.group_ids ? g.id) AS materials
        FROM affiliate_groups g ORDER BY lower(g.name)
      `),
    }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliate-groups',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Create an affiliate group',
    tags: ['Affiliates'],
    body: groupBody,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        if (await tx.maybe(sql`SELECT 1 FROM affiliate_groups WHERE lower(name) = ${c.body.name.toLowerCase()}`)) throw conflict('A group with this name already exists', 'group_exists');
        const now = app.clock.now();
        const row = await tx.one(sql.insert('affiliate_groups', { id: newId('agrp'), name: c.body.name, description: c.body.description || null, created_at: now, updated_at: now }));
        await c.audit(tx, 'affiliate.group_create', { type: 'affiliate_group', id: row.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/affiliate-groups/:id',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Rename or describe an affiliate group',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: groupBody.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        if (c.body.name && (await tx.maybe(sql`SELECT 1 FROM affiliate_groups WHERE lower(name) = ${c.body.name.toLowerCase()} AND id <> ${c.params.id}`))) {
          throw conflict('A group with this name already exists', 'group_exists');
        }
        const row = await tx.maybe(sql`
          UPDATE affiliate_groups SET ${sql.set({ name: c.body.name, description: c.body.description === undefined ? undefined : c.body.description || null, updated_at: app.clock.now() })}
          WHERE id = ${c.params.id} RETURNING *
        `);
        if (!row) throw notFound('Affiliate group');
        await c.audit(tx, 'affiliate.group_update', { type: 'affiliate_group', id: c.params.id }, c.body);
        return row;
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/affiliate-groups/:id',
    auth: 'admin',
    permission: 'affiliates.program.manage',
    summary: 'Delete an affiliate group (its affiliates leave it; not while marketing materials are limited to it)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        await assertNotTargeted(tx, 'group_ids', c.params.id);
        const n = await tx.exec(sql`DELETE FROM affiliate_groups WHERE id = ${c.params.id}`);
        if (!n) throw notFound('Affiliate group');
        await c.audit(tx, 'affiliate.group_delete', { type: 'affiliate_group', id: c.params.id });
      });
    },
  });

  // ---- Admin: marketing materials -------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/affiliate-materials',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'Marketing materials with their targeting and clicks in the last 30 days',
    tags: ['Affiliates'],
    query: z.object({ type: z.enum(MATERIAL_TYPES).optional(), status: z.enum(['active', 'archived']).optional() }),
    handler: async (c) => {
      const since = new Date(app.clock.now().getTime() - 30 * DAY);
      const rows = await app.db.many<any>(sql`
        SELECT m.*, f.filename, f.content_type, f.size,
          (SELECT count(*)::int FROM affiliate_clicks k WHERE k.material_id = m.id AND k.created_at >= ${since}) AS clicks_30d
        FROM affiliate_materials m LEFT JOIN files f ON f.id = m.file_id
        ${sql.where([c.query.type && sql`m.type = ${c.query.type}`, c.query.status && sql`m.status = ${c.query.status}`])}
        ORDER BY m.status, m.sort_order, m.created_at DESC
      `);
      return { data: rows.map((m) => presentMaterial(app, m)) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliate-materials',
    auth: 'admin',
    permission: 'affiliates.materials.manage',
    summary: 'Create a banner, text link or downloadable file (upload the image or file next)',
    tags: ['Affiliates'],
    body: createMaterialBody,
    handler: async (c) => {
      const id = await app.db.tx(async (tx) => (await createMaterial(tx, app, c.body, c.actor)).id);
      return materialDetail(app.db, app, id);
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/affiliate-materials/:id',
    auth: 'admin',
    permission: 'affiliates.materials.manage',
    summary: 'Update a marketing material (archive it to hide it from affiliates; existing banner embeds keep working)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    body: updateMaterialBody,
    handler: async (c) => {
      const { removedKeys } = await app.db.tx((tx) => updateMaterial(tx, app, c.params.id, c.body, c.actor));
      for (const key of removedKeys) await app.storage.delete(key);
      return materialDetail(app.db, app, c.params.id);
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/affiliate-materials/:id',
    auth: 'admin',
    permission: 'affiliates.materials.manage',
    summary: 'Delete a marketing material and its stored file (banner embeds stop showing the image)',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const keys = await app.db.tx((tx) => deleteMaterial(tx, app, c.params.id, c.actor));
      for (const key of keys) await app.storage.delete(key);
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/affiliate-materials/:id/file',
    auth: 'admin',
    permission: 'affiliates.materials.manage',
    summary: 'Upload the image of a banner (PNG, JPEG, GIF, WebP or SVG, up to 2 MB) or the file of a download (up to 20 MB)',
    description: 'Multipart form with one `file` field. The type is detected from the content; a new upload replaces the previous one.',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    bodyLimit: FILE_MAX_BYTES + 1024 * 1024,
    handler: async (c) => {
      const material = await getMaterial(app.db, c.params.id);
      if (material.type === 'text_link') throw validationError([{ path: ['file'], message: 'Text links have no file' }]);
      const banner = material.type === 'banner';
      const max = banner ? BANNER_MAX_BYTES : FILE_MAX_BYTES;
      const upload = await c.req.file({ limits: { fileSize: max + 1 } });
      if (!upload) throw validationError([{ path: ['file'], message: 'Attach a file' }]);
      const data = await upload.toBuffer();
      if (!data.length) throw validationError([{ path: ['file'], message: 'The file is empty' }]);
      if (data.length > max) throw validationError([{ path: ['file'], message: banner ? 'Banner images must be 2 MB or smaller' : 'Files must be 20 MB or smaller' }]);
      const contentType = sniffMaterialFile(material.type, data);
      if (!contentType) {
        throw validationError([{ path: ['file'], message: banner ? 'Upload a PNG, JPEG, GIF, WebP or SVG image' : 'Upload an image, PDF, ZIP, MP4 or plain-text file' }]);
      }
      const fileId = newId('file');
      const stored = await app.storage.put(`affiliate-materials/${material.id}/${fileId}`, data);
      let replacedKey: string | null;
      try {
        ({ replacedKey } = await app.db.tx((tx) =>
          attachMaterialFile(tx, app, material.id, {
            fileId,
            filename: safeFilename(upload.filename || 'file'),
            contentType,
            size: stored.size,
            sha256: stored.sha256,
            storageKey: stored.key,
            uploadedBy: c.admin().adminId,
          }, c.actor),
        ));
      } catch (err) {
        await app.storage.delete(stored.key);
        throw err;
      }
      if (replacedKey) await app.storage.delete(replacedKey);
      return materialDetail(app.db, app, material.id);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/affiliate-materials/:id/file',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: "Download a material's stored file",
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const material = await getMaterial(app.db, c.params.id);
      const file = material.file_id ? await app.db.maybe<{ filename: string; content_type: string; storage_key: string }>(sql`SELECT filename, content_type, storage_key FROM files WHERE id = ${material.file_id}`) : null;
      const data = file ? await app.storage.get(file.storage_key) : null;
      if (!file || !data) throw notFound('File');
      return sendFile(c, { filename: file.filename, contentType: file.content_type, data });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/affiliates/:id/materials',
    auth: 'admin',
    permission: 'affiliates.program.view',
    summary: 'The marketing materials an affiliate sees, with their personal tracking links',
    tags: ['Affiliates'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const aff = await getAffiliate(app.db, c.params.id);
      return { data: await materialsFor(app.db, app, aff) };
    },
  });

  // ---- Public: banner images (embedded on affiliates' sites) ------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/public/affiliate-assets/:id',
    auth: 'public',
    hidden: true,
    params: z.object({ id: z.string().max(60) }),
    handler: async (c) => {
      // Only banner images are public; downloadable files go through the affiliate's own session.
      const file = await app.db.maybe<{ content_type: string; storage_key: string; sha256: string }>(sql`
        SELECT f.content_type, f.storage_key, f.sha256 FROM files f JOIN affiliate_materials m ON m.file_id = f.id AND m.type = 'banner'
        WHERE f.id = ${c.params.id} AND f.owner_type = 'affiliate_material'
      `);
      const data = file ? await app.storage.get(file.storage_key) : null;
      if (!file || !data) throw notFound('Banner');
      return c.reply
        .header('content-type', file.content_type)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('etag', `"${file.sha256.slice(0, 32)}"`)
        .header('cross-origin-resource-policy', 'cross-origin')
        // An SVG can carry script: banners never run code, even when opened directly.
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .send(data);
    },
  });

  // ---- Client: the affiliate's materials ------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/client/affiliate/materials',
    auth: 'client',
    summary: 'Banners, text links and files you can promote, each with your tracking link and embed code',
    tags: ['Client'],
    handler: async (c) => {
      const aff = await ownAffiliate(app, c.customer().userId);
      if (aff.status !== 'approved') throw conflict('Your affiliate account is not active', 'affiliate_inactive');
      return { data: await materialsFor(app.db, app, aff) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/affiliate/materials/:id/download',
    auth: 'client',
    summary: 'Download the file of a marketing material available to you',
    tags: ['Client'],
    params: z.object({ id: z.string().max(60) }),
    handler: async (c) => {
      const aff = await ownAffiliate(app, c.customer().userId);
      if (aff.status !== 'approved') throw conflict('Your affiliate account is not active', 'affiliate_inactive');
      const file = await materialFileFor(app.db, app, aff, c.params.id);
      const data = await app.storage.get(file.storageKey);
      if (!data) throw notFound('File');
      return sendFile(c, { filename: file.filename, contentType: file.contentType, data });
    },
  });
}
