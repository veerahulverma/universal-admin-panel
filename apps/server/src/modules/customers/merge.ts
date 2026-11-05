import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { Actor, App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, forbidden, validationError } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { getUser, type UserRow } from './service.js';

/**
 * Merging duplicate accounts.
 *
 * Every row in any module that points at the duplicate (source) account is
 * re-pointed at the account being kept (target), in one transaction. The
 * references are discovered from the database catalog at merge time rather
 * than listed here, so tables added later by modules or plugins move too:
 *
 *  - columns named `user_id` or `*_user_id`, and any column with a foreign
 *    key to users(id);
 *  - polymorphic pairs `<x>_type` / `<x>_id` where `<x>_type = 'user'`
 *    (subscriptions, invoices, grants, credits, usage, login history...).
 *
 * A row that would collide with one the target already has (a unique index
 * such as one balance per currency, or one membership per organization) is
 * resolved by a merge policy: balances and counters are added together,
 * per-customer preferences keep the target's choice, and anything without a
 * policy stays with the source account and is reported.
 */

export type MergePolicy =
  /** Fold the source row into the target's row (numbers added, earliest/latest kept), then drop it. */
  | { kind: 'combine'; sum?: string[]; min?: string[]; max?: string[] }
  /** The target's row wins; the source's colliding row is dropped. */
  | { kind: 'keep_target' }
  | { kind: 'custom'; resolve: (tx: Db, ctx: { app: App; sourceId: string; targetId: string }) => Promise<number> };

export interface MergeHookContext {
  db: Db;
  app: App;
  sourceId: string;
  targetId: string;
}

type BeforeMerge = (ctx: MergeHookContext) => Promise<void>;

/**
 * Run inside the merge transaction before any row moves, for state that must
 * not follow the customer (one-time links sent to the old address, ...).
 * Errors abort the merge, so it is all or nothing.
 */
export function onBeforeMerge(app: App, owner: string, fn: BeforeMerge): void {
  const map = (app.services['customers.beforeMerge'] as Map<string, BeforeMerge> | undefined) ?? new Map<string, BeforeMerge>();
  map.set(owner, fn);
  app.services['customers.beforeMerge'] = map;
}

/** Tables never rewritten, with the reason shown in the preview. */
const EXCLUDED: Record<string, string> = {
  users: 'the accounts themselves',
  audit_logs: 'the audit log is append-only',
  secrets: 'secrets are encrypted for their owner',
  user_merges: 'merge history',
};

const IDENT = /^[a-z_][a-z0-9_]*$/;

const BUILTIN_POLICIES: Record<string, MergePolicy> = {
  // Usage and billing balances: the merged customer keeps everything they had on both accounts.
  credit_balances: { kind: 'combine', sum: ['balance'], max: ['updated_at'] },
  customer_balances: { kind: 'combine', sum: ['balance'], max: ['updated_at'] },
  usage_counters: { kind: 'combine', sum: ['used', 'reserved', 'overage'], max: ['updated_at'] },
  customer_ip_addresses: { kind: 'combine', sum: ['hits'], min: ['first_seen_at'], max: ['last_seen_at'] },
  // Choices the customer made on the account being kept win.
  email_preferences: { kind: 'keep_target' },
  memberships: {
    kind: 'custom',
    // Both accounts in the same organization: keep one membership with the stronger role.
    resolve: async (tx, { app, sourceId, targetId }) => {
      const rows = await tx.many<{ org_id: string; role: string; status: string }>(sql`
        SELECT s.org_id, s.role, s.status FROM memberships s
        JOIN memberships t ON t.org_id = s.org_id AND t.user_id = ${targetId} WHERE s.user_id = ${sourceId}
      `);
      const rank = (role: string) => ({ owner: 3, admin: 2, member: 1 })[role] ?? 0;
      for (const s of rows) {
        await tx.exec(sql`
          UPDATE memberships SET role = CASE WHEN ${rank(s.role)} > (CASE role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'member' THEN 1 ELSE 0 END) THEN ${s.role} ELSE role END,
            status = CASE WHEN ${s.status} = 'active' THEN 'active' ELSE status END, updated_at = ${app.clock.now()}
          WHERE org_id = ${s.org_id} AND user_id = ${targetId}
        `);
        await tx.exec(sql`DELETE FROM memberships WHERE org_id = ${s.org_id} AND user_id = ${sourceId}`);
      }
      return rows.length;
    },
  },
};

function policies(app: App): Map<string, MergePolicy> {
  let map = app.services['customers.mergePolicies'] as Map<string, MergePolicy> | undefined;
  if (!map) {
    map = new Map(Object.entries(BUILTIN_POLICIES));
    app.services['customers.mergePolicies'] = map;
  }
  return map;
}

/** Modules and plugins describe how their per-customer rows combine when two accounts merge. */
export function registerMergePolicy(app: App, table: string, policy: MergePolicy): void {
  policies(app).set(table, policy);
}

interface Reference {
  table: string;
  column: string;
  /** Polymorphic references: the `<x>_type` column that must equal 'user'. */
  typeColumn: string | null;
  module: string | null;
}

interface UniqueIndex {
  table_name: string;
  columns: string[];
  predicate: string | null;
  has_expressions: boolean;
}

const id = (name: string) => sql.ident(name);

/** Which module created each table, read from the migrations (for the preview). */
function tableOwners(app: App): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of app.modules.defs) {
    for (const migration of m.migrations ?? []) {
      for (const match of migration.up.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) out.set(match[1].toLowerCase(), m.id);
    }
  }
  return out;
}

export async function discoverReferences(db: Db, app: App): Promise<Reference[]> {
  const columns = await db.many<{ table_name: string; column_name: string }>(sql`
    SELECT c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.data_type IN ('text', 'character varying')
    ORDER BY c.table_name, c.ordinal_position
  `);
  const foreignKeys = await db.many<{ table_name: string; column_name: string }>(sql`
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema() AND ccu.table_name = 'users' AND ccu.column_name = 'id'
  `);
  const fk = new Set(foreignKeys.map((f) => `${f.table_name}.${f.column_name}`));
  const byTable = new Map<string, string[]>();
  for (const c of columns) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
  const owners = tableOwners(app);
  const out: Reference[] = [];
  for (const [table, cols] of byTable) {
    if (table in EXCLUDED || !IDENT.test(table)) continue;
    const names = new Set(cols);
    for (const column of cols) {
      if (!IDENT.test(column)) continue;
      const prefix = column.endsWith('_id') ? column.slice(0, -3) : null;
      if (column === 'user_id' || column.endsWith('_user_id') || fk.has(`${table}.${column}`)) {
        out.push({ table, column, typeColumn: null, module: owners.get(table) ?? null });
      } else if (prefix && names.has(`${prefix}_type`)) {
        out.push({ table, column, typeColumn: `${prefix}_type`, module: owners.get(table) ?? null });
      }
    }
  }
  return out;
}

async function uniqueIndexes(db: Db, tables: string[]): Promise<Map<string, UniqueIndex[]>> {
  if (!tables.length) return new Map();
  const rows = await db.many<UniqueIndex>(sql`
    SELECT t.relname AS table_name,
      (SELECT json_agg(a.attname::text ORDER BY k.ord) FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS columns,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
      ix.indexprs IS NOT NULL AS has_expressions
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema() AND ix.indisunique AND t.relname IN ${sql.in(tables)}
  `);
  const out = new Map<string, UniqueIndex[]>();
  for (const r of rows) out.set(r.table_name, [...(out.get(r.table_name) ?? []), { ...r, columns: r.columns ?? [] }]);
  return out;
}

function matches(ref: Reference, alias: string, userId: string): Sql {
  const a = sql.raw(alias);
  return sql.and([sql`${a}.${id(ref.column)} = ${userId}`, ref.typeColumn && sql`${a}.${id(ref.typeColumn)} = 'user'`]);
}

/**
 * Whether the row aliased `t` would collide with a row of the target under a
 * unique index. Partial indexes only collide inside their predicate; the
 * predicate text from the catalog is evaluated once for the row itself and
 * once inside the subquery, where its bare column names resolve to `x`.
 */
function collides(ref: Reference, ix: UniqueIndex, targetId: string): Sql {
  const pred = ix.predicate ? sql`(${sql.raw(ix.predicate)})` : null;
  const keys = ix.columns.filter((c) => c !== ref.column).map((c) => sql`x.${id(c)} = t.${id(c)}`);
  return sql.and([pred, sql`EXISTS (SELECT 1 FROM ${id(ref.table)} x WHERE ${sql.and([sql`x.${id(ref.column)} = ${targetId}`, ...keys, pred])})`]);
}

/**
 * Unique indexes over plain columns that include the reference. Expression
 * indexes cannot be evaluated generically; a collision on one makes the
 * update fail, which aborts the whole merge with the table named.
 */
function relevantIndexes(ref: Reference, indexes: Map<string, UniqueIndex[]>): UniqueIndex[] {
  return (indexes.get(ref.table) ?? []).filter((ix) => !ix.has_expressions && ix.columns.includes(ref.column));
}

function conflictSql(ref: Reference, indexes: Map<string, UniqueIndex[]>, targetId: string): Sql | null {
  const relevant = relevantIndexes(ref, indexes);
  return relevant.length ? sql.or(relevant.map((ix) => collides(ref, ix, targetId))) : null;
}

async function singleColumnPrimaryKey(db: Db, table: string): Promise<string | null> {
  const rows = await db.many<{ column_name: string }>(sql`
    SELECT kcu.column_name FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema() AND tc.table_name = ${table}
  `);
  return rows.length === 1 ? rows[0].column_name : null;
}

async function referencingColumns(db: Db, table: string, column: string): Promise<{ table_name: string; column_name: string }[]> {
  return db.many(sql`
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema() AND ccu.table_name = ${table} AND ccu.column_name = ${column}
  `);
}

/**
 * Resolve the source rows that still collide after the move, index by index:
 * combine values into the target's row, point other tables' foreign keys at
 * the target's row, and drop the source row.
 */
async function resolveCollisions(tx: Db, ref: Reference, indexes: Map<string, UniqueIndex[]>, policy: Extract<MergePolicy, { kind: 'combine' | 'keep_target' }>, sourceId: string, targetId: string): Promise<number> {
  const columns = new Set((await tx.many<{ column_name: string }>(sql`
    SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${ref.table}
  `)).map((c) => c.column_name));
  const pk = await singleColumnPrimaryKey(tx, ref.table);
  const refs = pk ? await referencingColumns(tx, ref.table, pk) : [];
  let resolved = 0;
  for (const ix of relevantIndexes(ref, indexes)) {
    // Row pairs (s = source row, x = target row) that collide under this index; ctid lets the
    // catalog's predicate text be evaluated for each side without ambiguous column names.
    const keys = ix.columns.filter((c) => c !== ref.column).map((c) => sql`x.${id(c)} = s.${id(c)}`);
    const pred = (alias: string) => (ix.predicate ? sql`EXISTS (SELECT 1 FROM ${id(ref.table)} p WHERE p.ctid = ${sql.raw(alias)}.ctid AND ${sql.raw(`(${ix.predicate})`)})` : null);
    const pair = sql.and([matches(ref, 's', sourceId), sql`x.${id(ref.column)} = ${targetId}`, ...keys, pred('s'), pred('x')]);
    if (policy.kind === 'combine') {
      const set = [
        ...(policy.sum ?? []).filter((c) => columns.has(c)).map((c) => sql`${id(c)} = x.${id(c)} + s.${id(c)}`),
        ...(policy.min ?? []).filter((c) => columns.has(c)).map((c) => sql`${id(c)} = LEAST(x.${id(c)}, s.${id(c)})`),
        ...(policy.max ?? []).filter((c) => columns.has(c)).map((c) => sql`${id(c)} = GREATEST(x.${id(c)}, s.${id(c)})`),
      ];
      if (set.length) await tx.exec(sql`UPDATE ${id(ref.table)} AS x SET ${sql.join(set)} FROM ${id(ref.table)} AS s WHERE ${pair}`);
    }
    for (const r of refs) {
      await tx.exec(sql`
        UPDATE ${id(r.table_name)} AS f SET ${id(r.column_name)} = x.${id(pk!)}
        FROM ${id(ref.table)} AS s, ${id(ref.table)} AS x WHERE f.${id(r.column_name)} = s.${id(pk!)} AND ${pair}
      `);
    }
    resolved += await tx.exec(sql`DELETE FROM ${id(ref.table)} AS s USING ${id(ref.table)} AS x WHERE ${pair}`);
  }
  return resolved;
}

export interface MergeEntry {
  table: string;
  column: string;
  module: string | null;
  rows: number;
  /** Rows that collide with a row the target already has. */
  conflicts: number;
  resolution: 'move' | 'combine' | 'keep_target' | 'custom' | 'keep_source';
}

export interface MergeResult {
  mergeId: string;
  sourceId: string;
  targetId: string;
  moved: (MergeEntry & { moved: number; resolved: number; kept: number })[];
  filled: string[];
}

function resolutionOf(app: App, table: string): MergeEntry['resolution'] {
  const policy = policies(app).get(table);
  return policy ? policy.kind : 'keep_source';
}

/** Profile fields the target is missing and the source has; the target's own values always win. */
function profileFill(target: UserRow & { password_hash: string | null }, source: UserRow & { password_hash: string | null }) {
  const blank = (v: unknown) => v === null || v === undefined || v === '';
  const patch: Record<string, unknown> = {};
  const filled: string[] = [];
  for (const key of ['name', 'phone', 'avatar_url', 'locale', 'timezone', 'country', 'registration_source', 'referral_code', 'external_id'] as const) {
    if (blank(target[key]) && !blank(source[key])) {
      patch[key] = source[key];
      filled.push(key);
    }
  }
  if (!target.password_hash && source.password_hash) {
    patch.password_hash = source.password_hash;
    filled.push('password');
  }
  if (!Object.keys(target.utm ?? {}).length && Object.keys(source.utm ?? {}).length) {
    patch.utm = source.utm;
    filled.push('utm');
  }
  const customFields = { ...target.custom_fields };
  for (const [k, v] of Object.entries(source.custom_fields ?? {})) {
    if (blank(customFields[k]) && !blank(v)) {
      customFields[k] = v;
      filled.push(`custom_fields.${k}`);
    }
  }
  patch.custom_fields = customFields;
  patch.metadata = { ...source.metadata, ...target.metadata };
  const tags = [...new Set([...target.tags, ...source.tags])];
  if (tags.length !== target.tags.length) filled.push('tags');
  patch.tags = tags;
  const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : a ?? b);
  patch.last_active_at = later(target.last_active_at, source.last_active_at);
  if (source.last_login_at && (!target.last_login_at || source.last_login_at > target.last_login_at)) {
    patch.last_login_at = source.last_login_at;
    patch.last_login_ip = source.last_login_ip;
  }
  patch.lifetime_revenue = Number(target.lifetime_revenue) + Number(source.lifetime_revenue);
  return { patch, filled };
}

async function loadPair(db: Db, targetId: string, sourceId: string, scope: string[] | null, lock: boolean) {
  if (targetId === sourceId) throw validationError([{ path: ['sourceId'], message: 'Choose a different account to merge' }]);
  const target = await getUser(db, targetId, scope, { lock });
  const source = await getUser(db, sourceId, scope, { lock });
  if (scope) {
    const outside = await db.maybe(sql`SELECT 1 FROM memberships WHERE user_id = ${source.id} AND org_id NOT IN ${sql.in(scope)}`);
    if (outside) throw forbidden('The duplicate account also belongs to organizations you do not manage', 'org_scope');
  }
  return { target, source };
}

async function withSecrets(db: Db, user: UserRow) {
  const row = await db.one<{ password_hash: string | null }>(sql`SELECT password_hash FROM users WHERE id = ${user.id}`);
  return { ...user, password_hash: row.password_hash };
}

/** What a merge would do, without changing anything. */
export async function previewMerge(app: App, targetId: string, sourceId: string, scope: string[] | null) {
  const { target, source } = await loadPair(app.db, targetId, sourceId, scope, false);
  const refs = await discoverReferences(app.db, app);
  const indexes = await uniqueIndexes(app.db, [...new Set(refs.map((r) => r.table))]);
  const entries: MergeEntry[] = [];
  for (const ref of refs) {
    const total = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM ${id(ref.table)} t WHERE ${matches(ref, 't', source.id)}`);
    if (!total.count) continue;
    const collision = conflictSql(ref, indexes, target.id);
    const conflicts = collision ? (await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM ${id(ref.table)} t WHERE ${matches(ref, 't', source.id)} AND ${collision}`)).count : 0;
    entries.push({ table: ref.table, column: ref.column, module: ref.module, rows: total.count, conflicts, resolution: conflicts ? resolutionOf(app, ref.table) : 'move' });
  }
  const { filled } = profileFill(await withSecrets(app.db, target), await withSecrets(app.db, source));
  return {
    target: { id: target.id, email: target.email, name: target.name, createdAt: target.created_at },
    source: { id: source.id, email: source.email, name: source.name, createdAt: source.created_at },
    entries,
    filled,
    excluded: Object.entries(EXCLUDED).map(([table, reason]) => ({ table, reason })),
  };
}

export async function mergeUsers(app: App, input: { targetId: string; sourceId: string; adminId: string | null }, actor: Actor, scope: string[] | null): Promise<MergeResult> {
  return app.db.tx(async (tx) => {
    const { target, source } = await loadPair(tx, input.targetId, input.sourceId, scope, true);
    // Runs even for disabled modules: their data still moves, so it must be made safe first.
    const before = (app.services['customers.beforeMerge'] as Map<string, BeforeMerge> | undefined) ?? new Map<string, BeforeMerge>();
    for (const fn of before.values()) await fn({ db: tx, app, sourceId: source.id, targetId: target.id });

    const refs = await discoverReferences(tx, app);
    const indexes = await uniqueIndexes(tx, [...new Set(refs.map((r) => r.table))]);
    const moved: MergeResult['moved'] = [];
    const customDone = new Set<string>();
    for (const ref of refs) {
      const total = await tx.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM ${id(ref.table)} t WHERE ${matches(ref, 't', source.id)}`);
      if (!total.count) continue;
      try {
        const collision = conflictSql(ref, indexes, target.id);
        const count = await tx.exec(sql`
          UPDATE ${id(ref.table)} AS t SET ${id(ref.column)} = ${target.id}
          WHERE ${matches(ref, 't', source.id)} ${collision ? sql`AND NOT (${collision})` : sql.empty}
        `);
        let resolved = 0;
        const conflicts = total.count - count;
        const policy = policies(app).get(ref.table);
        if (conflicts && policy?.kind === 'custom' && !customDone.has(ref.table)) {
          customDone.add(ref.table);
          resolved = await policy.resolve(tx, { app, sourceId: source.id, targetId: target.id });
        } else if (conflicts && (policy?.kind === 'combine' || policy?.kind === 'keep_target')) {
          resolved = await resolveCollisions(tx, ref, indexes, policy, source.id, target.id);
        }
        moved.push({
          table: ref.table,
          column: ref.column,
          module: ref.module,
          rows: total.count,
          conflicts,
          resolution: conflicts ? resolutionOf(app, ref.table) : 'move',
          moved: count,
          resolved,
          kept: conflicts - resolved,
        });
      } catch (err) {
        throw conflict(`Could not move ${ref.table}.${ref.column}: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`, 'merge_failed', { table: ref.table, column: ref.column });
      }
    }

    // Older merges into the source now point at the target, so every merged id resolves in one step.
    await tx.exec(sql`UPDATE users SET merged_into_id = ${target.id} WHERE merged_into_id = ${source.id}`);
    const now = app.clock.now();
    // The source leaves the directory first, which frees unique values (external ID) for the target.
    await tx.exec(sql`UPDATE users SET deleted_at = ${now}, merged_into_id = ${target.id}, merged_at = ${now}, updated_at = ${now} WHERE id = ${source.id}`);
    const { patch, filled } = profileFill(await withSecrets(tx, target), await withSecrets(tx, source));
    await tx.exec(sql`UPDATE users SET ${sql.set({ ...patch, updated_at: now })} WHERE id = ${target.id}`);

    const mergeId = newId('umrg');
    const summary = moved.map((m) => ({ table: m.table, column: m.column, module: m.module, rows: m.moved + m.resolved }));
    const kept = moved.filter((m) => m.kept > 0).map((m) => ({ table: m.table, column: m.column, rows: m.kept }));
    await tx.exec(sql.insert('user_merges', { id: mergeId, source_id: source.id, target_id: target.id, admin_id: input.adminId, moved: summary, kept, filled, created_at: now }, ''));
    const metadata = { mergeId, sourceId: source.id, sourceEmail: source.email, targetId: target.id, targetEmail: target.email, moved: summary, kept, filled };
    await writeAudit(tx, app, { actor, action: 'user.merge', targetType: 'user', targetId: target.id, metadata });
    await writeAudit(tx, app, { actor, action: 'user.merged_into', targetType: 'user', targetId: source.id, metadata });
    await app.events.emit(tx, 'user.merged', { userId: target.id, sourceId: source.id, targetId: target.id, mergeId, moved: Object.fromEntries(summary.map((m) => [`${m.table}.${m.column}`, m.rows])) }, { userId: target.id });
    if (app.events.catalog().some((e) => e.type === 'entitlements.updated')) {
      await app.events.emit(tx, 'entitlements.updated', { subjectType: 'user', subjectId: target.id, reason: 'merge' }, { userId: target.id });
    }
    return { mergeId, sourceId: source.id, targetId: target.id, moved, filled };
  });
}

export function registerMergeRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/merge-preview',
    auth: 'admin',
    permission: 'customers.users.merge',
    summary: 'Preview merging a duplicate account into this one: every record that would move, and conflicts',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    query: z.object({ sourceId: z.string().min(1) }),
    handler: (c) => previewMerge(app, c.params.id, c.query.sourceId, c.orgScope()),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/users/:id/merge',
    auth: 'admin',
    permission: 'customers.users.merge',
    sensitive: true,
    summary: 'Merge a duplicate account into this one (irreversible)',
    description:
      'Moves every record that references the duplicate (subscriptions, invoices, payments, orders, grants, credits, usage, tickets, notes, memberships, sessions and any other table with a user reference) to this account in one transaction. This account keeps its profile; blank fields are filled from the duplicate, which is then marked as merged.',
    tags: ['Users'],
    params: z.object({ id: z.string() }),
    body: z.object({ sourceId: z.string().min(1), confirm: z.literal('MERGE') }),
    handler: (c) => mergeUsers(app, { targetId: c.params.id, sourceId: c.body.sourceId, adminId: c.admin().adminId }, c.actor, c.orgScope()),
  });
}
