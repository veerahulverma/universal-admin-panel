import { isIP } from 'node:net';
import { z } from 'zod';
import type { Router, RouteContext } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { AppError, notFound, validationError } from '../../core/errors.js';
import {
  ACCESS_FILE_COLUMNS,
  downloadHeaders,
  downloadUsage,
  issueLink,
  presentUsage,
  recordDownload,
  verifyLinkToken,
  type AccessFileRow,
  type DownloadLinkRow,
  type DownloadUsage,
} from './downloads.js';
import {
  UNPROTECTED,
  evaluate,
  findTarget,
  getResource,
  loadProfile,
  loadResources,
  logAccess,
  presentDecision,
  viewerFor,
  visibleToCustomer,
  type AccessLogEntry,
  type Decision,
  type ResourceRow,
  type Viewer,
} from './service.js';

const REFUSALS: Record<string, string> = {
  no_access: 'Your plan does not include this content',
  not_yet_available: 'This content is not available yet',
  access_ended: 'Your access to this content has ended',
  resource_disabled: 'This content is not available',
  account_inactive: 'Your account cannot open content right now',
};

/** 403 whose code is the refusal reason, so apps can show "opens on …" or an upgrade prompt. */
function refusal(d: Decision): AppError {
  return new AppError(403, d.reason, REFUSALS[d.reason] ?? 'You cannot open this content', { availableAt: d.availableAt, availableUntil: d.availableUntil });
}

function limitReached(u: DownloadUsage, now: Date): AppError {
  const retryAfter = u.resetsAt ? Math.max(1, Math.ceil((u.resetsAt.getTime() - now.getTime()) / 1000)) : undefined;
  return new AppError(
    429,
    'download_limit_reached',
    u.resetsAt ? 'You have reached the download limit for this file; try again later' : 'You have reached the download limit for this file',
    { limit: u.limit, period: u.period, resetsAt: u.resetsAt },
    retryAfter ? { 'retry-after': String(retryAfter) } : undefined,
  );
}

function presentForCustomer(r: ResourceRow, d: Decision) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    description: r.description,
    path: r.kind === 'url' || r.kind === 'folder' ? r.path : null,
    ...(r.kind === 'file' ? { fileCount: r.file_count } : {}),
    state: d.state,
    allowed: d.allowed,
    reason: d.reason,
    availableAt: d.availableAt,
    availableUntil: d.availableUntil,
  };
}

async function attachedFile(db: Db, resourceId: string, fileId: string): Promise<AccessFileRow | null> {
  return db.maybe<AccessFileRow>(sql`
    SELECT ${ACCESS_FILE_COLUMNS} FROM access_resource_files rf JOIN access_files af ON af.id = rf.file_id JOIN files f ON f.id = af.file_id
    WHERE rf.resource_id = ${resourceId} AND rf.file_id = ${fileId}
  `);
}

const customerViewer = (c: RouteContext): Viewer => {
  const p = c.customer();
  return { userId: p.userId, orgId: p.orgId };
};

export function registerApiRoutes(r: Router, app: App): void {
  // ---- Integration API ---------------------------------------------------------------------
  r.route({
    method: 'POST',
    url: '/api/v1/access/check',
    auth: 'api',
    scope: 'access:read',
    summary: 'May this user (or organization) open a resource or path right now?',
    description:
      'Pass a resource ID or the path your app is about to serve. Paths are matched against protected URLs (exact) and folders (prefix, deepest wins); a path no resource protects is allowed with reason "unprotected". Refusals carry a reason (no_access, not_yet_available with availableAt, access_ended, resource_disabled, account_inactive). Every check is recorded in the access log.',
    tags: ['Access'],
    body: z
      .object({
        userId: z.string().max(100).optional(),
        orgId: z.string().max(100).optional(),
        resource: z.string().trim().min(1).max(2000),
        /** The end user's IP address, recorded in the access log. */
        ip: z.string().trim().max(64).optional(),
      })
      .refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
    handler: async (c) => {
      if (c.body.ip && !isIP(c.body.ip)) throw validationError([{ path: ['ip'], message: 'Enter an IPv4 or IPv6 address' }]);
      const viewer = await viewerFor(app.db, c.body, c.orgScope());
      const target = await findTarget(app.db, c.body.resource);
      const decision = target.resource ? evaluate(target.resource, await loadProfile(app.db, app, viewer), app.clock.now()) : UNPROTECTED;
      await logAccess(app.db, app, {
        event: 'check',
        source: 'api',
        resource: target.resource,
        path: target.path,
        userId: viewer.userId,
        orgId: viewer.orgId,
        allowed: decision.allowed,
        reason: decision.reason,
        ip: c.body.ip ?? c.ip,
      });
      const resource = target.resource;
      return {
        allowed: decision.allowed,
        reason: decision.reason,
        availableAt: decision.availableAt,
        availableUntil: decision.availableUntil,
        resource: resource ? { id: resource.id, kind: resource.kind, title: resource.title, ...(resource.kind === 'link' && decision.allowed ? { url: resource.url } : {}) } : null,
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/v1/access/resources',
    auth: 'api',
    scope: 'access:read',
    summary: "Every protected resource with its state for a user: open, scheduled (availableAt), ended or locked",
    tags: ['Access'],
    query: z.object({ userId: z.string().max(100).optional(), orgId: z.string().max(100).optional() }).refine((q) => q.userId || q.orgId, 'userId or orgId is required'),
    handler: async (c) => {
      const viewer = await viewerFor(app.db, c.query, c.orgScope());
      const profile = await loadProfile(app.db, app, viewer);
      const now = app.clock.now();
      const resources = await loadResources(app.db, null);
      return {
        data: resources.map((res) => {
          const d = evaluate(res, profile, now);
          return {
            id: res.id,
            kind: res.kind,
            title: res.title,
            description: res.description,
            path: res.path,
            url: res.kind === 'link' && d.allowed ? res.url : null,
            ...presentDecision(d),
          };
        }),
      };
    },
  });

  // ---- Customer (client) API -------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/client/content',
    auth: 'client',
    summary: 'Your content: what you can open now and what is locked or opens later (availableAt)',
    tags: ['Client'],
    handler: async (c) => {
      const profile = await loadProfile(app.db, app, customerViewer(c));
      const now = app.clock.now();
      const resources = await loadResources(app.db, sql`r.status = 'active'`);
      const data = [];
      for (const res of resources) {
        const d = evaluate(res, profile, now);
        if (visibleToCustomer(res, d)) data.push(presentForCustomer(res, d));
      }
      return { data };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/content/:id',
    auth: 'client',
    summary: 'Open a content item: the page body, the link, or the files you can download',
    tags: ['Client'],
    params: z.object({ id: z.string().max(100) }),
    handler: async (c) => {
      const viewer = customerViewer(c);
      const resource = (await loadResources(app.db, sql`r.id = ${c.params.id} AND r.status = 'active'`, { withBody: true }))[0];
      if (!resource) throw notFound('Content');
      const now = app.clock.now();
      const decision = evaluate(resource, await loadProfile(app.db, app, viewer), now);
      await logAccess(app.db, app, { event: 'view', source: 'client', resource, userId: viewer.userId, orgId: viewer.orgId, allowed: decision.allowed, reason: decision.reason, ip: c.ip });
      if (!decision.allowed) throw visibleToCustomer(resource, decision) ? refusal(decision) : notFound('Content');
      const base = presentForCustomer(resource, decision);
      if (resource.kind === 'page') return { ...base, body: resource.body };
      if (resource.kind === 'link') return { ...base, url: resource.url };
      if (resource.kind !== 'file') return base;
      const files = await app.db.many<AccessFileRow>(sql`
        SELECT ${ACCESS_FILE_COLUMNS} FROM access_resource_files rf JOIN access_files af ON af.id = rf.file_id JOIN files f ON f.id = af.file_id
        WHERE rf.resource_id = ${resource.id} ORDER BY rf.position, lower(af.title)
      `);
      const presented = [];
      for (const f of files) {
        presented.push({
          id: f.id,
          title: f.title,
          description: f.description,
          filename: f.filename,
          contentType: f.content_type,
          size: f.size,
          download: presentUsage(await downloadUsage(app.db, now, viewer.userId!, f)),
        });
      }
      return { ...base, files: presented };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/content/:id/files/:fileId/link',
    auth: 'client',
    summary: 'A signed, short-lived download URL for one of the files in a content item',
    description: 'The URL works without credentials until it expires (see expiresAt). Each download through it counts against your download limit for the file.',
    tags: ['Client'],
    rateLimit: { max: 60, windowSec: 60, by: 'principal' },
    params: z.object({ id: z.string().max(100), fileId: z.string().max(100) }),
    handler: async (c) => {
      const viewer = customerViewer(c);
      const resource = (await loadResources(app.db, sql`r.id = ${c.params.id} AND r.status = 'active' AND r.kind = 'file'`))[0];
      if (!resource) throw notFound('Content');
      const now = app.clock.now();
      const decision = evaluate(resource, await loadProfile(app.db, app, viewer), now);
      const entry: AccessLogEntry = { event: 'link', source: 'client', resource, fileId: c.params.fileId, userId: viewer.userId, orgId: viewer.orgId, allowed: false, reason: decision.reason, ip: c.ip };
      if (!decision.allowed) {
        await logAccess(app.db, app, entry);
        throw visibleToCustomer(resource, decision) ? refusal(decision) : notFound('Content');
      }
      const file = await attachedFile(app.db, resource.id, c.params.fileId);
      if (!file) throw notFound('File');
      const usage = await downloadUsage(app.db, now, viewer.userId!, file);
      if (usage.remaining === 0) {
        await logAccess(app.db, app, { ...entry, reason: 'download_limit_reached' });
        throw limitReached(usage, now);
      }
      const link = await app.db.tx(async (tx) => {
        const issued = await issueLink(tx, app, { fileId: file.id, resourceId: resource.id, userId: viewer.userId!, orgId: viewer.orgId, ip: c.ip });
        await logAccess(tx, app, { ...entry, allowed: true });
        return issued;
      });
      return { url: link.url, expiresAt: link.expiresAt, file: { id: file.id, title: file.title, filename: file.filename, size: file.size }, download: presentUsage(usage) };
    },
  });

  // ---- Public: signed download links ----------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/public/downloads/:token',
    auth: 'public',
    summary: 'Download a protected file through a signed link',
    description: 'Access is checked again when the link is used, and the download counts against the customer’s limit. Altered links answer 404, expired ones 410.',
    tags: ['Access'],
    rateLimit: { max: 120, windowSec: 60 },
    params: z.object({ token: z.string().max(200) }),
    handler: async (c) => {
      const base: AccessLogEntry = { event: 'download', source: 'public', allowed: false, reason: 'invalid_link', ip: c.ip };
      const linkId = await verifyLinkToken(app, c.params.token);
      const link = linkId
        ? await app.db.maybe<DownloadLinkRow>(sql`SELECT id, file_id, resource_id, user_id, org_id, expires_at, download_count FROM access_download_links WHERE id = ${linkId}`)
        : null;
      if (!link) {
        await logAccess(app.db, app, base);
        throw notFound('Download link');
      }
      const resource = await getResource(app.db, link.resource_id);
      const entry: AccessLogEntry = { ...base, resource, fileId: link.file_id, userId: link.user_id, orgId: link.org_id };
      const now = app.clock.now();
      if (link.expires_at.getTime() <= now.getTime()) {
        await logAccess(app.db, app, { ...entry, reason: 'link_expired' });
        throw new AppError(410, 'link_expired', 'This download link has expired; request a new one');
      }
      const decision = evaluate(resource, await loadProfile(app.db, app, { userId: link.user_id, orgId: link.org_id }), now);
      if (!decision.allowed) {
        await logAccess(app.db, app, { ...entry, reason: decision.reason });
        throw refusal(decision);
      }
      const file = await attachedFile(app.db, resource.id, link.file_id);
      if (!file) {
        await logAccess(app.db, app, { ...entry, reason: 'file_removed' });
        throw notFound('File');
      }
      // HEAD (download managers probing the size) is answered without counting a download.
      const counted = c.req.method !== 'HEAD';
      if (counted) {
        const usage = await downloadUsage(app.db, now, link.user_id, file);
        if (usage.remaining === 0) {
          await logAccess(app.db, app, { ...entry, reason: 'download_limit_reached' });
          throw limitReached(usage, now);
        }
      }
      const data = await app.storage.get(file.storage_key);
      if (!data) {
        await logAccess(app.db, app, { ...entry, reason: 'file_missing' });
        throw notFound('File contents');
      }
      if (counted) {
        const recorded = await app.db.tx(async (tx) => {
          const usage = await recordDownload(tx, app, { link, file, resourceId: resource.id, ip: c.ip, userAgent: c.userAgent || null });
          if (!usage) return false;
          await logAccess(tx, app, { ...entry, allowed: true, reason: decision.reason });
          await app.events.emit(tx, 'access_file.downloaded', { fileId: file.id, resourceId: resource.id, userId: link.user_id, bytes: file.size }, { userId: link.user_id, orgId: link.org_id });
          return true;
        });
        if (!recorded) {
          await logAccess(app.db, app, { ...entry, reason: 'download_limit_reached' });
          throw limitReached(await downloadUsage(app.db, now, link.user_id, file), now);
        }
      }
      return c.reply.headers(downloadHeaders(file)).send(data);
    },
  });
}
