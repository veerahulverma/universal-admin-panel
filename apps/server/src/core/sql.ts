/**
 * Minimal, injection-safe SQL builder based on tagged templates.
 *
 *   sql`SELECT * FROM users WHERE id = ${id}`   -> parameterized ($1)
 *
 * Interpolated values are always bound as parameters. Only `sql.raw` and
 * `sql.ident` inject text, and `sql.ident` validates identifiers. Plain objects
 * and arrays passed through `sql.insert` / `sql.set` / `sql.json` are stored as
 * JSONB (the schema uses JSONB rather than Postgres arrays throughout).
 */
export class Sql {
  constructor(
    readonly parts: readonly string[],
    readonly values: readonly unknown[],
  ) {}
}

class Raw {
  constructor(readonly text: string) {}
}

class JsonParam {
  constructor(readonly value: unknown) {}
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isPlainJson(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (v instanceof Date || Buffer.isBuffer(v) || v instanceof Uint8Array) return false;
  if (v instanceof Sql || v instanceof Raw || v instanceof JsonParam) return false;
  return true;
}

function toParam(v: unknown): unknown {
  return isPlainJson(v) ? new JsonParam(v) : v;
}

function renderValue(v: unknown, out: unknown[]): string {
  if (v instanceof Sql) return render(v, out);
  if (v instanceof Raw) return v.text;
  if (v instanceof JsonParam) {
    out.push(v.value === undefined ? null : JSON.stringify(v.value));
    return `$${out.length}::jsonb`;
  }
  if (v === undefined) throw new Error('Undefined value interpolated into SQL; pass null explicitly');
  out.push(v);
  return `$${out.length}`;
}

function render(q: Sql, out: unknown[]): string {
  let text = q.parts[0];
  for (let i = 0; i < q.values.length; i++) {
    text += renderValue(q.values[i], out) + q.parts[i + 1];
  }
  return text;
}

export function compile(q: Sql): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const text = render(q, values);
  return { text, values };
}

/** A condition that may be absent: falsy values from `cond && sql\`...\`` are skipped. */
export type Fragment = Sql | false | null | undefined | '' | 0;

export interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): Sql;
  raw(text: string): Raw;
  ident(name: string): Raw;
  json(value: unknown): JsonParam;
  join(items: readonly Sql[], separator?: string): Sql;
  empty: Sql;
  in(values: readonly unknown[]): Sql;
  and(conditions: readonly Fragment[]): Sql;
  or(conditions: readonly Fragment[]): Sql;
  where(conditions: readonly Fragment[]): Sql;
  insert(table: string, row: Record<string, unknown>, returning?: string): Sql;
  insertMany(table: string, rows: readonly Record<string, unknown>[], returning?: string): Sql;
  set(row: Record<string, unknown>): Sql;
  orderBy(column: string, direction: 'asc' | 'desc', allowed: Record<string, string>): Sql;
}

export const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => new Sql(strings, values)) as SqlTag;

sql.raw = (text: string) => new Raw(text);

sql.ident = (name: string) => {
  const segments = name.split('.');
  for (const s of segments) if (!IDENT.test(s)) throw new Error(`Invalid SQL identifier: ${name}`);
  return new Raw(segments.map((s) => `"${s}"`).join('.'));
};

sql.json = (value: unknown) => new JsonParam(value);

sql.join = (items: readonly Sql[], separator = ', ') => {
  if (items.length === 0) return sql.empty;
  const parts: string[] = [''];
  const values: unknown[] = [];
  items.forEach((item, i) => {
    if (i > 0) parts[parts.length - 1] += separator;
    values.push(item);
    parts.push('');
  });
  return new Sql(parts, values);
};

sql.empty = new Sql([''], []);

sql.in = (values: readonly unknown[]) => {
  if (values.length === 0) return sql`(NULL)`;
  return sql`(${sql.join(values.map((v) => sql`${v}`))})`;
};

function combine(conditions: readonly Fragment[], op: 'AND' | 'OR', fallback: string): Sql {
  const present = conditions.filter((c): c is Sql => c instanceof Sql);
  if (present.length === 0) return new Sql([fallback], []);
  return sql.join(
    present.map((c) => sql`(${c})`),
    ` ${op} `,
  );
}

sql.and = (conditions) => combine(conditions, 'AND', 'TRUE');
sql.or = (conditions) => combine(conditions, 'OR', 'FALSE');
sql.where = (conditions) => {
  const present = conditions.filter((c): c is Sql => c instanceof Sql);
  return present.length ? sql`WHERE ${sql.and(present)}` : sql.empty;
};

sql.insert = (table, row, returning = '*') => {
  const entries = Object.entries(row).filter(([, v]) => v !== undefined);
  const cols = sql.join(entries.map(([k]) => sql`${sql.ident(k)}`));
  const vals = sql.join(entries.map(([, v]) => sql`${toParam(v)}`));
  const ret = returning ? sql` RETURNING ${sql.raw(returning)}` : sql.empty;
  return sql`INSERT INTO ${sql.ident(table)} (${cols}) VALUES (${vals})${ret}`;
};

sql.insertMany = (table, rows, returning = '*') => {
  if (rows.length === 0) throw new Error('insertMany requires at least one row');
  const columns = Object.keys(rows[0]);
  const cols = sql.join(columns.map((k) => sql`${sql.ident(k)}`));
  const tuples = sql.join(rows.map((r) => sql`(${sql.join(columns.map((c) => sql`${toParam(r[c] ?? null)}`))})`));
  const ret = returning ? sql` RETURNING ${sql.raw(returning)}` : sql.empty;
  return sql`INSERT INTO ${sql.ident(table)} (${cols}) VALUES ${tuples}${ret}`;
};

sql.set = (row) => {
  const entries = Object.entries(row).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw new Error('sql.set requires at least one column');
  return sql.join(entries.map(([k, v]) => sql`${sql.ident(k)} = ${toParam(v)}`));
};

/** ORDER BY from user input, restricted to an allowlist mapping public keys to columns. */
sql.orderBy = (column, direction, allowed) => {
  const col = allowed[column];
  if (!col) throw new Error(`Sorting by "${column}" is not allowed`);
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
  return sql`ORDER BY ${sql.raw(col)} ${sql.raw(dir)} NULLS LAST`;
};
