import { z } from 'zod';
import { sql, type Sql } from './sql.js';
import type { Db } from './db.js';

/** Query-string boolean ("true"/"false"/"1"/"0"); z.coerce.boolean would treat "false" as true. */
export const qBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const qInt = (min = 0, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);

export const qDate = z.coerce.date();

/** Comma-separated or repeated query parameter -> string[]. */
export const qList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

export const pageQuery = {
  page: qInt(1).default(1),
  pageSize: qInt(1, 200).default(25),
};

export const sortQuery = <T extends readonly [string, ...string[]]>(keys: T, defaultKey: T[number]) => ({
  sort: z.enum(keys).default(defaultKey as any),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const idParams = z.object({ id: z.string().min(1).max(100) });

export const email = z.string().trim().toLowerCase().email().max(254);

export const metadataSchema = z
  .record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 50, 'At most 50 metadata keys');

export const currencyCode = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase());

export const slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'Use lowercase letters, numbers, dashes and underscores');

export const keySlug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/, 'Use lowercase letters, numbers, dots, dashes and underscores; start with a letter');

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export async function paginate<T>(
  db: Db,
  q: { select: Sql; from: Sql; where?: Sql; orderBy?: Sql; page: number; pageSize: number },
): Promise<Page<T>> {
  const where = q.where ?? sql.empty;
  const offset = (q.page - 1) * q.pageSize;
  const rows = await db.many<T>(sql`SELECT ${q.select} FROM ${q.from} ${where} ${q.orderBy ?? sql.empty} LIMIT ${q.pageSize} OFFSET ${offset}`);
  const count = await db.one<{ total: number }>(sql`SELECT count(*)::int AS total FROM ${q.from} ${where}`);
  return { data: rows, page: q.page, pageSize: q.pageSize, total: count.total };
}

/** Escape LIKE wildcards in user search input. */
export function likePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
