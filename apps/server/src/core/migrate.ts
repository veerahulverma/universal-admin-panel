import { sql } from './sql.js';
import type { Db } from './db.js';
import { sha256 } from './crypto.js';
import type { Logger } from './types.js';

export interface Migration {
  /** Sortable version, e.g. "001". Versions are scoped per module. */
  version: string;
  name: string;
  up: string;
}

const MIGRATION_LOCK = 72_710_000;

/**
 * Apply pending migrations for the given modules (already in dependency order)
 * in one transaction under an advisory lock, so concurrent deploys cannot race
 * and a failed migration leaves the schema untouched (Postgres DDL is transactional).
 */
export async function runMigrations(
  db: Db,
  modules: readonly { id: string; migrations?: readonly Migration[] }[],
  log?: Logger,
): Promise<number> {
  await db.script(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module text NOT NULL,
      version text NOT NULL,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (module, version)
    );
  `);
  return db.tx(async (tx) => {
    await tx.query(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    const applied = new Map(
      (await tx.many<{ module: string; version: string; checksum: string }>(sql`SELECT module, version, checksum FROM schema_migrations`)).map(
        (r) => [`${r.module}:${r.version}`, r.checksum],
      ),
    );
    let count = 0;
    for (const mod of modules) {
      const migrations = [...(mod.migrations ?? [])].sort((a, b) => a.version.localeCompare(b.version));
      for (const m of migrations) {
        const key = `${mod.id}:${m.version}`;
        const checksum = sha256(m.up);
        const existing = applied.get(key);
        if (existing) {
          if (existing !== checksum) log?.warn({ migration: key }, 'applied migration has changed since it ran; write a new migration instead');
          continue;
        }
        log?.info({ migration: key, name: m.name }, 'applying migration');
        await tx.script(m.up);
        await tx.exec(sql`INSERT INTO schema_migrations (module, version, name, checksum) VALUES (${mod.id}, ${m.version}, ${m.name}, ${checksum})`);
        count++;
      }
    }
    return count;
  });
}
