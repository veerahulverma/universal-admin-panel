import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { Actor, App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import type { JobContext } from '../../core/jobs.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { pageQuery, paginate } from '../../core/validation.js';
import { writeAudit } from '../../core/audit.js';
import { toCsv } from '../../core/csv.js';
import { stableStringify } from '../../core/json.js';
import { MINUTE } from '../../core/clock.js';
import { CsvError, parseCsv } from './csv-parse.js';
import {
  USER_COLUMNS,
  addMember,
  checkCustomFields,
  createUser,
  getOrganization,
  getUser,
  loadFieldDefs,
  updateUser,
  type FieldDef,
  type UserInput,
  type UserRow,
} from './service.js';

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;
const IMPORT_MAX_COLUMNS = 100;
const MAX_REPORTED_ERRORS = 500;
/** One job run handles a slice of the file, then queues the next, so no run outlives the worker's stuck-job timeout. */
const ROWS_PER_RUN = 1000;
const RUN_BUDGET_MS = 3 * MINUTE;

const column = z.string().trim().min(1).max(200).optional();

export const importMappingSchema = z.object({
  email: z.string().trim().min(1, 'Choose the column that holds email addresses').max(200),
  name: column,
  firstName: column,
  lastName: column,
  phone: column,
  locale: column,
  timezone: column,
  country: column,
  tags: column,
  externalId: column,
  marketingConsent: column,
  customFields: z.record(z.string(), z.string().trim().min(1).max(200)).default({}),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

export const importOptionsSchema = z.object({
  /** Update customers that already exist (matched by email). Blank cells never overwrite stored values. */
  updateExisting: z.boolean().default(false),
  /** Add every imported customer to this organization. Required for organization-scoped administrators. */
  orgId: z.string().max(100).optional(),
  /** Tags added to every imported customer, e.g. the name of the source system. */
  tags: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  /** Mark new customers' email addresses as verified (only when the source system verified them). */
  markEmailVerified: z.boolean().default(false),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;

type RowResult = 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';

interface ImportValues {
  email: string;
  name?: string;
  phone?: string;
  locale?: string;
  timezone?: string;
  country?: string;
  externalId?: string;
  tags: string[];
  /** Only ever true: a file can record an opt-in, never withdraw or assume consent. */
  marketingConsent?: true;
  customFields: Record<string, unknown>;
}

type PlannedRow = { rowNumber: number; email: string | null; values: ImportValues | null; error: string | null };

interface ImportRow {
  id: string;
  filename: string;
  file_id: string;
  status: 'uploaded' | 'validated' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  delimiter: string;
  headers: string[];
  row_count: number;
  mapping: ImportMapping | null;
  options: ImportOptions | null;
  summary: Record<string, number> | null;
  errors: { row: number; email: string | null; message: string }[];
  processed: number;
  created_by: string;
  actor_label: string | null;
  org_scope: string[] | null;
  [key: string]: unknown;
}

const OPT_IN = new Set(['yes', 'y', 'true', '1', 'x', 'opted in', 'opted-in', 'opt in', 'opt-in', 'subscribed', 'consented']);
const OPT_OUT = new Set(['no', 'n', 'false', '0', 'opted out', 'opted-out', 'opt out', 'opt-out', 'unsubscribed', 'none']);

const emailSchema = z.string().trim().toLowerCase().email().max(254);

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Header-name heuristics for the first mapping proposal; the administrator confirms every column. */
export function suggestMapping(headers: string[], defs: readonly FieldDef[]): Partial<ImportMapping> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (...names: string[]) => headers.find((h) => names.includes(norm(h)));
  const out: Partial<ImportMapping> = {
    email: find('email', 'emailaddress', 'mail', 'email1', 'primaryemail'),
    name: find('name', 'fullname', 'customername', 'displayname'),
    firstName: find('firstname', 'givenname', 'first'),
    lastName: find('lastname', 'surname', 'familyname', 'last'),
    phone: find('phone', 'phonenumber', 'mobile', 'telephone', 'tel'),
    locale: find('locale', 'language', 'lang'),
    timezone: find('timezone', 'tz'),
    country: find('country', 'countrycode'),
    tags: find('tags', 'tag', 'labels'),
    externalId: find('externalid', 'externaluserid', 'customerid', 'memberid'),
    marketingConsent: find('marketingconsent', 'newsletter', 'optin', 'acceptsmarketing', 'emailoptin', 'subscribed'),
  };
  if (out.name) {
    delete out.firstName;
    delete out.lastName;
  }
  const customFields: Record<string, string> = {};
  for (const d of defs) {
    const header = find(norm(d.key), norm(d.label));
    if (header && !Object.values(out).includes(header)) customFields[d.key] = header;
  }
  out.customFields = customFields;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Partial<ImportMapping>;
}

function coerceCustom(def: FieldDef, raw: string): unknown {
  switch (def.type) {
    case 'number': {
      const n = Number(raw.replace(/\s/g, ''));
      if (!Number.isFinite(n)) throw new Error(`${def.label}: "${raw}" is not a number`);
      return n;
    }
    case 'boolean': {
      const v = raw.toLowerCase();
      if (OPT_IN.has(v)) return true;
      if (OPT_OUT.has(v)) return false;
      throw new Error(`${def.label}: use yes or no`);
    }
    case 'select':
      return def.options.find((o) => o.toLowerCase() === raw.toLowerCase()) ?? raw;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw;
    default:
      return raw;
  }
}

/** Turn one CSV row into profile values, or explain what is wrong with it. Blank cells are simply absent. */
function readRow(headers: string[], row: string[], mapping: ImportMapping, options: ImportOptions, defs: readonly FieldDef[]): ImportValues {
  const cell = (header: string | undefined) => (header ? row[headers.indexOf(header)] ?? '' : '');
  const problems: string[] = [];
  const rawEmail = cell(mapping.email);
  const email = emailSchema.safeParse(rawEmail);
  if (!rawEmail) problems.push('Email is missing');
  else if (!email.success) problems.push(`"${rawEmail}" is not a valid email address`);

  const name = mapping.name ? cell(mapping.name) : [cell(mapping.firstName), cell(mapping.lastName)].filter(Boolean).join(' ');
  const out: ImportValues = { email: email.success ? email.data : '', tags: [...options.tags], customFields: {} };
  const text = (label: string, value: string, max: number, key: 'name' | 'phone' | 'locale' | 'externalId') => {
    if (!value) return;
    if (value.length > max) problems.push(`${label} is longer than ${max} characters`);
    else out[key] = value;
  };
  text('Name', name, 200, 'name');
  text('Phone', cell(mapping.phone), 40, 'phone');
  text('Locale', cell(mapping.locale), 10, 'locale');
  text('External ID', cell(mapping.externalId), 200, 'externalId');

  const tz = cell(mapping.timezone);
  if (tz) {
    if (validTimezone(tz)) out.timezone = tz;
    else problems.push(`"${tz}" is not a time zone (use names like Europe/Berlin)`);
  }
  const country = cell(mapping.country);
  if (country) {
    if (/^[A-Za-z]{2}$/.test(country)) out.country = country.toUpperCase();
    else problems.push(`Country "${country}" must be a two-letter code`);
  }
  const tags = cell(mapping.tags)
    .split(/[|,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.some((t) => t.length > 50)) problems.push('Tags may be at most 50 characters each');
  out.tags = [...new Set([...out.tags, ...tags])];
  if (out.tags.length > 50) problems.push('At most 50 tags per customer');

  const consent = cell(mapping.marketingConsent).toLowerCase();
  if (consent && OPT_IN.has(consent)) out.marketingConsent = true;
  else if (consent && !OPT_OUT.has(consent)) problems.push(`Marketing consent "${consent}" must be yes or no`);

  const custom: Record<string, unknown> = {};
  for (const [key, header] of Object.entries(mapping.customFields)) {
    const def = defs.find((d) => d.key === key);
    const raw = cell(header);
    if (!def || !raw) continue;
    try {
      custom[key] = coerceCustom(def, raw);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  const checked = checkCustomFields(defs, custom, { partial: true });
  problems.push(...checked.issues.map((i) => i.message));
  out.customFields = checked.values;

  if (problems.length) throw new Error(problems.join('; '));
  return out;
}

/** Parse every row up front: values, row-level problems and duplicate emails (the first occurrence wins). */
function planRows(headers: string[], rows: string[][], mapping: ImportMapping, options: ImportOptions, defs: readonly FieldDef[]): PlannedRow[] {
  const firstRow = new Map<string, number>();
  return rows.map((row, i) => {
    const rowNumber = i + 2; // spreadsheet numbering: row 1 is the header
    try {
      const values = readRow(headers, row, mapping, options, defs);
      const first = firstRow.get(values.email);
      if (first) return { rowNumber, email: values.email, values: null, error: `Duplicate of row ${first}` };
      firstRow.set(values.email, rowNumber);
      return { rowNumber, email: values.email, values, error: null };
    } catch (err) {
      const raw = mapping.email ? row[headers.indexOf(mapping.email)] : '';
      return { rowNumber, email: raw || null, values: null, error: (err as Error).message };
    }
  });
}

/**
 * Custom fields are checked like any other creation path: when the mapping
 * includes custom fields, required ones must have a value; when it maps none,
 * they are left for the customer or your app to fill in.
 */
function createInput(v: ImportValues, options: ImportOptions, mapsCustomFields: boolean): UserInput {
  return {
    email: v.email,
    name: v.name,
    phone: v.phone,
    locale: v.locale,
    timezone: v.timezone,
    country: v.country,
    externalId: v.externalId,
    tags: v.tags.length ? v.tags : undefined,
    marketingConsent: v.marketingConsent,
    customFields: mapsCustomFields ? v.customFields : undefined,
    emailVerified: options.markEmailVerified || undefined,
    registrationSource: 'import',
  };
}

/** Only fields the file fills and that differ; blank cells never reach this point, so nothing is cleared. */
function updatePatch(user: UserRow, v: ImportValues): Partial<UserInput> {
  const patch: Partial<UserInput> = {};
  if (v.name && v.name !== user.name) patch.name = v.name;
  if (v.phone && v.phone !== user.phone) patch.phone = v.phone;
  if (v.locale && v.locale !== user.locale) patch.locale = v.locale;
  if (v.timezone && v.timezone !== user.timezone) patch.timezone = v.timezone;
  if (v.country && v.country !== user.country) patch.country = v.country;
  if (v.externalId && v.externalId !== user.external_id) patch.externalId = v.externalId;
  const tags = [...new Set([...user.tags, ...v.tags])];
  if (tags.length !== user.tags.length) patch.tags = tags;
  const custom = Object.fromEntries(Object.entries(v.customFields).filter(([k, val]) => stableStringify(user.custom_fields[k] ?? null) !== stableStringify(val)));
  if (Object.keys(custom).length) patch.customFields = custom;
  if (v.marketingConsent && !user.marketing_consent) patch.marketingConsent = true;
  return patch;
}

function errorText(err: unknown): string {
  if (err instanceof AppError) {
    const details = Array.isArray(err.details) ? (err.details as { message?: string }[]).map((d) => d.message).filter(Boolean) : [];
    return details.length ? details.join('; ') : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function checkMappingColumns(headers: string[], mapping: ImportMapping, defs: readonly FieldDef[]): void {
  const issues: { path: string[]; message: string }[] = [];
  const check = (path: string[], header: string | undefined) => {
    if (header && !headers.includes(header)) issues.push({ path, message: `The file has no column "${header}"` });
  };
  for (const key of ['email', 'name', 'firstName', 'lastName', 'phone', 'locale', 'timezone', 'country', 'tags', 'externalId', 'marketingConsent'] as const) {
    check(['mapping', key], mapping[key]);
  }
  for (const [key, header] of Object.entries(mapping.customFields)) {
    if (!defs.some((d) => d.key === key)) issues.push({ path: ['mapping', 'customFields', key], message: 'Unknown custom field' });
    check(['mapping', 'customFields', key], header);
  }
  if (mapping.name && (mapping.firstName || mapping.lastName)) issues.push({ path: ['mapping', 'name'], message: 'Map either a full name column or first and last name columns' });
  if (issues.length) throw validationError(issues);
}

async function loadImport(db: Db, id: string, adminId: string, scope: string[] | null, opts: { lock?: boolean } = {}): Promise<ImportRow> {
  const row = await db.maybe<ImportRow>(sql`
    SELECT * FROM user_imports WHERE id = ${id} ${scope ? sql`AND created_by = ${adminId}` : sql.empty} ${opts.lock ? sql`FOR UPDATE` : sql.empty}
  `);
  if (!row) throw notFound('Import');
  return row;
}

async function readFile(app: App, db: Db, imp: ImportRow) {
  const file = await db.maybe<{ storage_key: string }>(sql`SELECT storage_key FROM files WHERE id = ${imp.file_id}`);
  const data = file ? await app.storage.get(file.storage_key) : null;
  if (!data) throw new AppError(410, 'import_file_missing', 'The uploaded file is no longer available; upload it again');
  return parseCsv(data, { maxRows: IMPORT_MAX_ROWS, maxColumns: IMPORT_MAX_COLUMNS });
}

async function checkOrgOption(db: Db, options: ImportOptions, scope: string[] | null): Promise<void> {
  if (scope && (!options.orgId || !scope.includes(options.orgId))) {
    throw forbidden('Choose an organization you manage; imported customers are added to it', 'org_scope');
  }
  if (options.orgId) await getOrganization(db, options.orgId, scope);
}

function present(imp: ImportRow) {
  return {
    id: imp.id,
    filename: imp.filename,
    status: imp.status,
    delimiter: imp.delimiter,
    headers: imp.headers,
    rowCount: imp.row_count,
    mapping: imp.mapping,
    options: imp.options,
    summary: imp.summary,
    errors: imp.errors,
    progress: {
      processed: imp.processed,
      created: imp.created_count,
      updated: imp.updated_count,
      unchanged: imp.unchanged_count,
      skipped: imp.skipped_count,
      failed: imp.failed_count,
    },
    error: imp.error,
    createdBy: imp.created_by,
    createdByLabel: imp.actor_label,
    validatedAt: imp.validated_at,
    startedAt: imp.started_at,
    completedAt: imp.completed_at,
    createdAt: imp.created_at,
  };
}

type ExistingUser = UserRow & { visible: boolean; in_org: boolean };

/** What committing would do to each row, without writing anything. */
async function dryRun(db: Db, planned: PlannedRow[], options: ImportOptions, scope: string[] | null, mapsCustomFields: boolean, defs: readonly FieldDef[]) {
  const emails = planned.filter((p) => p.values).map((p) => p.values!.email);
  const existing = new Map<string, ExistingUser>();
  for (let i = 0; i < emails.length; i += 1000) {
    const chunk = emails.slice(i, i + 1000);
    const rows = await db.many<ExistingUser>(sql`
      SELECT ${USER_COLUMNS},
        ${scope ? sql`EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id IN ${sql.in(scope)})` : sql`TRUE`} AS visible,
        ${options.orgId ? sql`EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id = ${options.orgId})` : sql`TRUE`} AS in_org
      FROM users u WHERE lower(u.email) IN ${sql.in(chunk)} AND u.deleted_at IS NULL
    `);
    for (const r of rows) existing.set(r.email.toLowerCase(), r);
  }
  const externalIds = planned.flatMap((p) => (p.values?.externalId ? [p.values.externalId] : []));
  const externalOwner = new Map<string, string>();
  for (let i = 0; i < externalIds.length; i += 1000) {
    const rows = await db.many<{ id: string; external_id: string }>(sql`
      SELECT id, external_id FROM users WHERE external_id IN ${sql.in(externalIds.slice(i, i + 1000))} AND deleted_at IS NULL
    `);
    for (const r of rows) externalOwner.set(r.external_id, r.id);
  }
  const counts: Record<RowResult, number> = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const errors: { row: number; email: string | null; message: string }[] = [];
  const fail = (p: PlannedRow, message: string) => {
    counts.failed++;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row: p.rowNumber, email: p.email, message });
  };
  for (const p of planned) {
    if (!p.values) {
      fail(p, p.error ?? 'Invalid row');
      continue;
    }
    const v = p.values;
    const user = existing.get(v.email);
    const owner = v.externalId ? externalOwner.get(v.externalId) : undefined;
    if (owner && owner !== user?.id) {
      fail(p, `External ID ${v.externalId} already belongs to another customer`);
      continue;
    }
    if (!user) {
      if (mapsCustomFields) {
        const required = checkCustomFields(defs, v.customFields, { partial: false });
        if (required.issues.length) {
          fail(p, required.issues.map((i) => i.message).join('; '));
          continue;
        }
      }
      counts.created++;
    } else if (!user.visible) fail(p, OUTSIDE_SCOPE);
    else if (!options.updateExisting) counts.skipped++;
    else counts[Object.keys(updatePatch(user, v)).length || !user.in_org ? 'updated' : 'unchanged']++;
  }
  return { counts, errors };
}

const OUTSIDE_SCOPE = 'A customer with this email exists outside your organizations';

/** Apply one planned row in its own transaction, recording the outcome next to the change. */
async function applyRow(app: App, imp: ImportRow, p: PlannedRow, actor: Actor, mapsCustomFields: boolean): Promise<void> {
  const options = imp.options!;
  const scope = imp.org_scope;
  const record = async (db: Db, result: RowResult, userId: string | null, message: string | null) => {
    const inserted = await db.exec(sql`
      INSERT INTO user_import_rows (import_id, row_number, email, result, user_id, message, created_at)
      VALUES (${imp.id}, ${p.rowNumber}, ${p.email}, ${result}, ${userId}, ${message}, ${app.clock.now()})
      ON CONFLICT (import_id, row_number) DO NOTHING
    `);
    if (!inserted) return;
    await db.exec(sql`
      UPDATE user_imports SET processed = processed + 1, ${sql.raw(`${result}_count`)} = ${sql.raw(`${result}_count`)} + 1, updated_at = ${app.clock.now()}
      WHERE id = ${imp.id}
    `);
  };
  if (!p.values) {
    await app.db.tx((tx) => record(tx, 'failed', null, p.error));
    return;
  }
  const v = p.values;
  try {
    await app.db.tx(async (tx) => {
      const done = await tx.maybe(sql`SELECT 1 FROM user_import_rows WHERE import_id = ${imp.id} AND row_number = ${p.rowNumber}`);
      if (done) return;
      const existing = await tx.maybe<{ id: string }>(sql`SELECT id FROM users WHERE lower(email) = ${v.email} AND deleted_at IS NULL FOR UPDATE`);
      if (!existing) {
        const user = await createUser(tx, app, createInput(v, options, mapsCustomFields), actor, { orgId: options.orgId ?? null });
        await record(tx, 'created', user.id, null);
        return;
      }
      if (scope && !(await tx.maybe(sql`SELECT 1 FROM memberships WHERE user_id = ${existing.id} AND org_id IN ${sql.in(scope)}`))) {
        throw conflict(OUTSIDE_SCOPE, 'org_scope');
      }
      const user = await getUser(tx, existing.id, null);
      if (!options.updateExisting) {
        await record(tx, 'skipped', user.id, 'Already exists; updating existing customers was off');
        return;
      }
      const patch = updatePatch(user, v);
      let changed = Object.keys(patch).length > 0;
      if (changed) await updateUser(tx, app, user.id, patch, actor, scope);
      if (options.orgId && !(await tx.maybe(sql`SELECT 1 FROM memberships WHERE org_id = ${options.orgId} AND user_id = ${user.id}`))) {
        await addMember(tx, app, options.orgId, user.id, 'member', actor);
        changed = true;
      }
      await record(tx, changed ? 'updated' : 'unchanged', user.id, null);
    });
  } catch (err) {
    await app.db.tx((tx) => record(tx, 'failed', null, errorText(err)));
  }
}

/**
 * Background job. Each run processes a slice of rows and queues the next run;
 * rows already recorded are skipped, so a retried or overlapping run never
 * applies a row twice (the row record and the change commit together).
 */
async function runImport(app: App, importId: string, ctx: JobContext): Promise<void> {
  const imp = await app.db.maybe<ImportRow>(sql`SELECT * FROM user_imports WHERE id = ${importId}`);
  if (!imp || (imp.status !== 'queued' && imp.status !== 'running')) return;
  const actor: Actor = { type: 'admin', id: imp.created_by, label: imp.actor_label };
  try {
    if (imp.status === 'queued') {
      await app.db.exec(sql`UPDATE user_imports SET status = 'running', started_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${imp.id}`);
    }
    const csv = await readFile(app, app.db, imp);
    const defs = await loadFieldDefs(app.db, 'user');
    const planned = planRows(csv.headers, csv.rows, imp.mapping!, imp.options!, defs);
    const done = new Set((await app.db.many<{ row_number: number }>(sql`SELECT row_number FROM user_import_rows WHERE import_id = ${imp.id}`)).map((r) => r.row_number));
    const mapsCustomFields = Object.keys(imp.mapping!.customFields).length > 0;
    const started = Date.now();
    let handled = 0;
    for (const p of planned) {
      if (done.has(p.rowNumber)) continue;
      if (handled >= ROWS_PER_RUN || Date.now() - started > RUN_BUDGET_MS) {
        await app.jobs.enqueue(app.db, 'customers.user_import', { importId }, { idempotencyKey: `user-import:${importId}:${done.size + handled}`, maxAttempts: 5 });
        return;
      }
      await applyRow(app, imp, p, actor, mapsCustomFields);
      handled++;
    }
    await app.db.tx(async (tx) => {
      const final = await tx.one<ImportRow>(sql`
        UPDATE user_imports SET status = 'completed', completed_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${imp.id} RETURNING *
      `);
      await writeAudit(tx, app, {
        actor,
        action: 'user.import_complete',
        targetType: 'user_import',
        targetId: imp.id,
        metadata: { filename: imp.filename, ...present(final).progress },
      });
    });
  } catch (err) {
    if (ctx.job.attempts >= ctx.job.max_attempts) {
      await app.db.exec(sql`UPDATE user_imports SET status = 'failed', error = ${errorText(err).slice(0, 2000)}, updated_at = ${app.clock.now()} WHERE id = ${imp.id}`);
    }
    throw err;
  }
}

export function registerImportJob(app: App): void {
  app.jobs.register('customers.user_import', (payload: { importId: string }, ctx) => runImport(app, payload.importId, ctx), { module: 'customers', timeoutMs: 10 * MINUTE });
}

export function registerImportRoutes(r: Router, app: App): void {
  r.route({
    method: 'POST',
    url: '/api/admin/users/imports',
    auth: 'admin',
    permission: 'customers.users.import',
    summary: 'Upload a CSV file of customers (multipart field "file"); returns its columns and a suggested mapping',
    description: `Up to ${IMPORT_MAX_ROWS.toLocaleString('en')} rows and ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Comma, semicolon and tab delimiters are detected. Nothing is imported until you run a dry run and commit.`,
    tags: ['Users'],
    bodyLimit: IMPORT_MAX_BYTES + 512 * 1024,
    handler: async (c) => {
      const file = await c.req.file({ limits: { fileSize: IMPORT_MAX_BYTES + 1 } });
      if (!file) throw validationError([{ path: ['file'], message: 'Attach a CSV file' }]);
      const data = await file.toBuffer();
      if (data.length > IMPORT_MAX_BYTES) throw validationError([{ path: ['file'], message: `Files may be at most ${IMPORT_MAX_BYTES / 1024 / 1024} MB` }]);
      let csv;
      try {
        csv = parseCsv(data, { maxRows: IMPORT_MAX_ROWS, maxColumns: IMPORT_MAX_COLUMNS });
      } catch (err) {
        if (err instanceof CsvError) throw validationError([{ path: ['file'], message: err.message }]);
        throw err;
      }
      const id = newId('uimp');
      const fileId = newId('file');
      const filename = (file.filename || 'users.csv').replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 120);
      const stored = await app.storage.put(`imports/users/${id}.csv`, data);
      const defs = await loadFieldDefs(app.db, 'user');
      const admin = c.admin();
      const now = app.clock.now();
      const row = await app.db.tx(async (tx) => {
        await tx.exec(sql.insert('files', {
          id: fileId,
          owner_type: 'user_import',
          owner_id: id,
          filename,
          content_type: 'text/csv',
          size: stored.size,
          sha256: stored.sha256,
          storage_key: stored.key,
          uploaded_by_type: 'admin',
          uploaded_by_id: admin.adminId,
          created_at: now,
        }, ''));
        const created = await tx.one<ImportRow>(sql.insert('user_imports', {
          id,
          filename,
          file_id: fileId,
          status: 'uploaded',
          delimiter: csv.delimiter,
          headers: csv.headers,
          row_count: csv.rows.length,
          created_by: admin.adminId,
          actor_label: admin.email,
          org_scope: admin.orgScope,
          created_at: now,
          updated_at: now,
        }));
        await c.audit(tx, 'user.import_upload', { type: 'user_import', id }, { filename, rows: csv.rows.length });
        return created;
      });
      return {
        ...present(row),
        sample: csv.rows.slice(0, 5),
        suggestedMapping: suggestMapping(csv.headers, defs),
        customFields: defs.map((d) => ({ key: d.key, label: d.label, type: d.type, required: d.required })),
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/imports',
    auth: 'admin',
    permission: 'customers.users.import',
    summary: 'Recent user imports',
    tags: ['Users'],
    query: z.object(pageQuery),
    handler: async (c) => {
      const scope = c.orgScope();
      const page = await paginate<ImportRow>(app.db, {
        select: sql`*`,
        from: sql`user_imports`,
        where: sql.where([scope && sql`created_by = ${c.admin().adminId}`]),
        orderBy: sql`ORDER BY created_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      return { ...page, data: page.data.map(present) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/imports/:id',
    auth: 'admin',
    permission: 'customers.users.import',
    summary: 'Import status, dry-run summary and progress',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => present(await loadImport(app.db, c.params.id, c.admin().adminId, c.orgScope())),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/imports/:id/dry-run',
    auth: 'admin',
    permission: 'customers.users.import',
    summary: 'Validate every row against a column mapping without changing anything',
    description: 'Returns what committing would do (create, update, unchanged, skip) and the problems found per row. The mapping and options are kept for the commit.',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ mapping: importMappingSchema, options: importOptionsSchema.default({ updateExisting: false, tags: [], markEmailVerified: false }) }),
    handler: async (c) => {
      const { mapping, options } = c.body;
      if (options.updateExisting && !c.can('customers.users.edit')) throw forbidden('Updating existing customers requires the customers.users.edit permission');
      const scope = c.orgScope();
      const imp = await loadImport(app.db, c.params.id, c.admin().adminId, scope);
      if (imp.status !== 'uploaded' && imp.status !== 'validated') throw conflict('This import has already been committed', 'import_committed');
      await checkOrgOption(app.db, options, scope);
      const defs = await loadFieldDefs(app.db, 'user');
      checkMappingColumns(imp.headers, mapping, defs);
      const csv = await readFile(app, app.db, imp);
      const planned = planRows(csv.headers, csv.rows, mapping, options, defs);
      const result = await dryRun(app.db, planned, options, scope, Object.keys(mapping.customFields).length > 0, defs);
      const updated = await app.db.one<ImportRow>(sql`
        UPDATE user_imports SET status = 'validated', mapping = ${sql.json(mapping)}, options = ${sql.json(options)}, summary = ${sql.json(result.counts)},
          errors = ${sql.json(result.errors)}, validated_at = ${app.clock.now()}, updated_at = ${app.clock.now()}
        WHERE id = ${imp.id} RETURNING *
      `);
      return present(updated);
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/imports/:id/commit',
    auth: 'admin',
    permission: 'customers.users.import',
    summary: 'Run the import with the mapping from the last dry run (in the background)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const scope = c.orgScope();
      return app.db.tx(async (tx) => {
        const imp = await loadImport(tx, c.params.id, c.admin().adminId, scope, { lock: true });
        if (imp.status !== 'validated') throw conflict(imp.status === 'uploaded' ? 'Run a dry run first' : 'This import has already been committed', 'import_not_validated');
        if (imp.options?.updateExisting && !c.can('customers.users.edit')) throw forbidden('Updating existing customers requires the customers.users.edit permission');
        const summary = imp.summary ?? {};
        if (!summary.created && !summary.updated && !summary.unchanged) throw conflict('No row can be imported; fix the file and upload it again', 'import_nothing_to_do');
        const updated = await tx.one<ImportRow>(sql`
          UPDATE user_imports SET status = 'queued', created_by = ${c.admin().adminId}, actor_label = ${c.admin().email}, org_scope = ${sql.json(scope)},
            updated_at = ${app.clock.now()} WHERE id = ${imp.id} RETURNING *
        `);
        await app.jobs.enqueue(tx, 'customers.user_import', { importId: imp.id }, { idempotencyKey: `user-import:${imp.id}:0`, maxAttempts: 5 });
        await c.audit(tx, 'user.import', { type: 'user_import', id: imp.id }, { filename: imp.filename, rows: imp.row_count, options: imp.options, dryRun: imp.summary });
        return present(updated);
      });
    },
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/users/imports/:id',
    auth: 'admin',
    permission: 'customers.users.import',
    summary: 'Discard an import that has not been committed (the uploaded file is deleted)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const storageKey = await app.db.tx(async (tx) => {
        const imp = await loadImport(tx, c.params.id, c.admin().adminId, c.orgScope(), { lock: true });
        if (imp.status !== 'uploaded' && imp.status !== 'validated') throw conflict('Committed imports are kept as a record', 'import_committed');
        const file = await tx.maybe<{ storage_key: string }>(sql`DELETE FROM files WHERE id = ${imp.file_id} RETURNING storage_key`);
        await tx.exec(sql`UPDATE user_imports SET status = 'cancelled', updated_at = ${app.clock.now()} WHERE id = ${imp.id}`);
        await c.audit(tx, 'user.import_cancel', { type: 'user_import', id: imp.id }, { filename: imp.filename });
        return file?.storage_key ?? null;
      });
      if (storageKey) await app.storage.delete(storageKey);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/imports/:id/results.csv',
    auth: 'admin',
    permission: 'customers.users.import',
    summary: 'Download the outcome of every row (created, updated, unchanged, skipped or failed with the reason)',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const imp = await loadImport(app.db, c.params.id, c.admin().adminId, c.orgScope());
      if (imp.status === 'uploaded' || imp.status === 'validated' || imp.status === 'cancelled') throw conflict('This import has not run yet', 'import_not_run');
      const rows = await app.db.many<{ row_number: number; email: string | null; result: string; user_id: string | null; message: string | null }>(sql`
        SELECT row_number, email, result, user_id, message FROM user_import_rows WHERE import_id = ${imp.id} ORDER BY row_number
      `);
      await writeAudit(app.db, app, { actor: c.actor, action: 'user.import_results_download', targetType: 'user_import', targetId: imp.id });
      const csv = toCsv(rows, [
        { header: 'row', value: (r) => r.row_number },
        { header: 'email', value: (r) => r.email },
        { header: 'result', value: (r) => r.result },
        { header: 'user_id', value: (r) => r.user_id },
        { header: 'message', value: (r) => r.message },
      ]);
      const base = imp.filename.replace(/\.csv$/i, '');
      return c.reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${base}-results.csv"`)
        .send(csv);
    },
  });
}
