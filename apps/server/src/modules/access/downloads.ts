import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { DAY } from '../../core/clock.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import { notFound, validationError } from '../../core/errors.js';
import type { StoredObject } from '../../core/storage.js';
import { settingsOf, type LimitPeriod } from './service.js';

/** Rolling window each limit period counts downloads over; lifetime limits never reset. */
export const PERIOD_MS: Record<LimitPeriod, number | null> = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY, lifetime: null };

export interface AccessFileRow {
  id: string;
  file_id: string;
  title: string;
  description: string;
  download_limit: number | null;
  limit_period: LimitPeriod;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  storage_key: string;
}

export const ACCESS_FILE_COLUMNS = sql`af.id, af.file_id, af.title, af.description, af.download_limit, af.limit_period, af.created_by, af.created_at, af.updated_at,
  f.filename, f.content_type, f.size, f.sha256, f.storage_key`;

export async function getAccessFile(db: Db, id: string, opts: { lock?: boolean } = {}): Promise<AccessFileRow> {
  const row = await db.maybe<AccessFileRow>(sql`
    SELECT ${ACCESS_FILE_COLUMNS} FROM access_files af JOIN files f ON f.id = af.file_id WHERE af.id = ${id}
    ${opts.lock ? sql`FOR UPDATE OF af` : sql.empty}
  `);
  if (!row) throw notFound('File');
  return row;
}

// ---- Uploads ---------------------------------------------------------------------------------

export interface UploadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._-]+/, '');
  return cleaned.slice(-100) || 'file';
}

function cleanContentType(value: string | undefined): string {
  const type = (value ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(type) ? type : 'application/octet-stream';
}

export function checkUpload(app: App, upload: { filename?: string; mimetype?: string; data: Buffer; truncated: boolean }): UploadedFile {
  const max = settingsOf(app).maxFileBytes;
  if (upload.truncated || upload.data.length > max) {
    throw validationError([{ path: ['file'], message: `Files must be ${formatBytes(max)} or smaller` }], 'The file is too large');
  }
  if (!upload.data.length) throw validationError([{ path: ['file'], message: 'The file is empty' }]);
  const filename = (upload.filename ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(-200) || 'file';
  return { filename, contentType: cleanContentType(upload.mimetype), data: upload.data };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * Put the bytes in storage, before any transaction opens (large writes should
 * not hold one). Storage is not transactional: callers remove the object again
 * with `discardStored` if their transaction fails.
 */
export async function storeObject(app: App, ownerId: string, upload: UploadedFile): Promise<StoredObject> {
  return app.storage.put(`access/files/${ownerId}/${newId('obj')}-${safeFilename(upload.filename)}`, upload.data);
}

/** Describe stored bytes with a core `files` row owned by the protected file. */
export async function insertFileRow(db: Db, app: App, ownerId: string, upload: UploadedFile, stored: StoredObject, actor: Actor): Promise<string> {
  const fileId = newId('file');
  await db.exec(sql.insert('files', {
    id: fileId,
    owner_type: 'access_file',
    owner_id: ownerId,
    org_id: null,
    filename: upload.filename,
    content_type: upload.contentType,
    size: stored.size,
    sha256: stored.sha256,
    storage_key: stored.key,
    uploaded_by_type: actor.type,
    uploaded_by_id: actor.id,
    created_at: app.clock.now(),
  }, ''));
  return fileId;
}

export async function discardStored(app: App, storageKey: string): Promise<void> {
  try {
    await app.storage.delete(storageKey);
  } catch (err) {
    app.log.warn({ err, storageKey }, 'could not delete a stored protected file');
  }
}

// ---- Limits ------------------------------------------------------------------------------------

export interface DownloadUsage {
  /** Downloads allowed per period; null means unlimited. */
  limit: number | null;
  period: LimitPeriod;
  /** Downloads counted in the current window. */
  used: number;
  remaining: number | null;
  /** When the next download becomes possible again (only while the limit is reached). */
  resetsAt: Date | null;
}

export async function downloadUsage(db: Db, now: Date, userId: string, file: Pick<AccessFileRow, 'id' | 'download_limit' | 'limit_period'>): Promise<DownloadUsage> {
  const windowMs = PERIOD_MS[file.limit_period];
  const counted = sql`user_id = ${userId} AND file_id = ${file.id} ${windowMs === null ? sql.empty : sql`AND created_at > ${new Date(now.getTime() - windowMs)}`}`;
  const { used } = await db.one<{ used: number }>(sql`SELECT count(*)::int AS used FROM access_downloads WHERE ${counted}`);
  if (file.download_limit === null) return { limit: null, period: file.limit_period, used, remaining: null, resetsAt: null };
  const remaining = Math.max(0, file.download_limit - used);
  let resetsAt: Date | null = null;
  if (remaining === 0 && windowMs !== null) {
    // A slot frees up when enough of the oldest counted downloads leave the window.
    const row = await db.maybe<{ created_at: Date }>(sql`
      SELECT created_at FROM access_downloads WHERE ${counted} ORDER BY created_at OFFSET ${used - file.download_limit} LIMIT 1
    `);
    resetsAt = row ? new Date(row.created_at.getTime() + windowMs) : null;
  }
  return { limit: file.download_limit, period: file.limit_period, used, remaining, resetsAt };
}

export function presentUsage(u: DownloadUsage) {
  return { limit: u.limit, period: u.period, used: u.used, remaining: u.remaining, resetsAt: u.resetsAt };
}

// ---- Signed links ------------------------------------------------------------------------------

const keyCache = new WeakMap<App, string>();

/** The HMAC key download links are signed with, created on first use and kept encrypted in secrets. */
export async function signingKey(app: App, db: Db = app.db): Promise<string> {
  const cached = keyCache.get(app);
  if (cached) return cached;
  const existing = await app.secrets.get(db, 'access', 'downloads', 'signing_key');
  if (existing) {
    keyCache.set(app, existing);
    return existing;
  }
  const key = randomBase62(48);
  await app.secrets.set(db, 'access', 'downloads', 'signing_key', key);
  db.onCommit(() => keyCache.set(app, key));
  return key;
}

const TOKEN = /^(dlk_[0-9a-z]{26})\.([0-9a-f]{64})$/;

export async function signLink(app: App, linkId: string): Promise<string> {
  return `${linkId}.${hmacSha256(await signingKey(app), `download:${linkId}`)}`;
}

/** The link id a token names, or null when the token was not issued by this server (or was altered). */
export async function verifyLinkToken(app: App, token: string): Promise<string | null> {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const expected = hmacSha256(await signingKey(app), `download:${m[1]}`);
  return safeEqual(m[2], expected) ? m[1] : null;
}

export interface DownloadLinkRow {
  id: string;
  file_id: string;
  resource_id: string;
  user_id: string;
  org_id: string | null;
  expires_at: Date;
  download_count: number;
}

export async function issueLink(
  db: Db,
  app: App,
  input: { fileId: string; resourceId: string; userId: string; orgId: string | null; ip: string | null },
): Promise<{ url: string; expiresAt: Date }> {
  const id = newId('dlk');
  const expiresAt = new Date(app.clock.now().getTime() + settingsOf(app).linkTtlMinutes * 60_000);
  await db.exec(sql.insert('access_download_links', {
    id,
    file_id: input.fileId,
    resource_id: input.resourceId,
    user_id: input.userId,
    org_id: input.orgId,
    ip: input.ip,
    expires_at: expiresAt,
    created_at: app.clock.now(),
  }, ''));
  return { url: `${app.config.appUrl}/api/public/downloads/${await signLink(app, id)}`, expiresAt };
}

const DOWNLOAD_LOCK = 72_710_401;

/**
 * Count a download against the customer's limit, atomically: concurrent
 * requests for the same customer and file are serialized, so a limit cannot be
 * overrun by downloading in parallel. Returns the usage before this download,
 * or null when the limit is already used up.
 */
export async function recordDownload(
  tx: Db,
  app: App,
  input: { link: DownloadLinkRow; file: AccessFileRow; resourceId: string; ip: string | null; userAgent: string | null },
): Promise<DownloadUsage | null> {
  const { link, file } = input;
  await tx.query(sql`SELECT pg_advisory_xact_lock(${DOWNLOAD_LOCK}, hashtext(${`${link.user_id}:${file.id}`}))`);
  const now = app.clock.now();
  const usage = await downloadUsage(tx, now, link.user_id, file);
  if (usage.remaining === 0) return null;
  await tx.exec(sql.insert('access_downloads', {
    id: newId('dld'),
    file_id: file.id,
    resource_id: input.resourceId,
    link_id: link.id,
    user_id: link.user_id,
    org_id: link.org_id,
    ip: input.ip,
    user_agent: input.userAgent?.slice(0, 500) ?? null,
    bytes: file.size,
    created_at: now,
  }, ''));
  await tx.exec(sql`UPDATE access_download_links SET download_count = download_count + 1 WHERE id = ${link.id}`);
  return usage;
}

/** Types a browser could render or run are always served as opaque bytes. */
const ACTIVE_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)$/;

export function downloadHeaders(file: Pick<AccessFileRow, 'filename' | 'content_type' | 'size' | 'sha256'>): Record<string, string> {
  const fallback = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(file.filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'content-type': ACTIVE_TYPES.test(file.content_type) ? 'application/octet-stream' : file.content_type,
    'content-length': String(file.size),
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-robots-tag': 'noindex',
    etag: `"${file.sha256.slice(0, 32)}"`,
  };
}
