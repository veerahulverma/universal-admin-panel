import type { ZodType } from 'zod';
import { sql } from './sql.js';
import type { Db } from './db.js';
import type { Actor, App } from './types.js';
import { writeAudit } from './audit.js';
import { diff } from './json.js';
import { validationError } from './errors.js';

export interface SettingDef<T = any> {
  key: string;
  module: string;
  label: string;
  description?: string;
  schema: ZodType<T>;
  defaults: T;
  /** Permission needed to change this section (viewing needs system.settings.view). */
  permission?: string;
  /** Sections that may be overridden per organization (tenant-specific configuration). */
  tenantOverridable?: boolean;
}

/**
 * Settings live in memory and are refreshed from the database periodically, so
 * reads are synchronous and safe anywhere, including inside transactions.
 */
export class SettingsService {
  private readonly defs = new Map<string, SettingDef>();
  private stored = new Map<string, Record<string, unknown>>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly app: App) {}

  define<T>(def: SettingDef<T>): void {
    this.defs.set(def.key, def);
  }

  definitions(): SettingDef[] {
    return [...this.defs.values()];
  }

  private storeKey(scope: string, key: string): string {
    return `${scope}|${key}`;
  }

  async load(db: Db = this.app.db): Promise<void> {
    const rows = await db.many<{ scope: string; key: string; value: Record<string, unknown> }>(
      sql`SELECT scope, key, value FROM settings`,
    );
    const next = new Map<string, Record<string, unknown>>();
    for (const r of rows) next.set(this.storeKey(r.scope, r.key), r.value);
    this.stored = next;
  }

  startRefresh(intervalMs = 15_000): void {
    this.timer = setInterval(() => {
      this.load().catch((err) => this.app.log.warn({ err }, 'settings refresh failed'));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get<T = any>(key: string, scope = 'global'): T {
    const def = this.defs.get(key);
    if (!def) throw new Error(`Unknown settings section "${key}"`);
    return this.effective<T>(def, scope);
  }

  /**
   * Defaults, then global values, then the tenant override. `pending` applies a
   * write that is not committed yet, so a transaction can return what it stored.
   */
  private effective<T>(def: SettingDef, scope: string, pending?: { scope: string; value: Record<string, unknown> | null }): T {
    const storedFor = (s: string) => (pending && pending.scope === s ? pending.value : this.stored.get(this.storeKey(s, def.key))) ?? {};
    const merged = {
      ...(def.defaults as object),
      ...storedFor('global'),
      ...(scope !== 'global' && def.tenantOverridable ? storedFor(scope) : {}),
    };
    const parsed = def.schema.safeParse(merged);
    if (parsed.success) return parsed.data as T;
    this.app.log.warn({ key: def.key, issues: parsed.error.issues }, 'stored settings invalid; using defaults');
    return def.defaults as T;
  }

  /** Raw override stored for a scope (without defaults), for tenant settings screens. */
  getStored(key: string, scope = 'global'): Record<string, unknown> | null {
    return this.stored.get(this.storeKey(scope, key)) ?? null;
  }

  async update<T = any>(db: Db, key: string, patch: Partial<T>, actor: Actor, scope = 'global'): Promise<T> {
    const def = this.defs.get(key);
    if (!def) throw validationError([{ path: ['key'], message: `Unknown settings section "${key}"` }]);
    if (scope !== 'global' && !def.tenantOverridable) {
      throw validationError([{ path: ['scope'], message: `Settings section "${key}" cannot be overridden per tenant` }]);
    }
    const before = this.stored.get(this.storeKey(scope, key)) ?? {};
    const candidate = { ...before, ...(patch as object) };
    const check = def.schema.safeParse({ ...(def.defaults as object), ...candidate });
    if (!check.success) throw validationError(check.error.issues.map((i) => ({ path: i.path, message: i.message })));
    // Persist only keys the schema knows about so stale fields never accumulate.
    const known = check.data as Record<string, unknown>;
    const value = Object.fromEntries(Object.keys(candidate).filter((k) => k in known).map((k) => [k, known[k]]));
    await db.exec(sql`
      INSERT INTO settings (scope, key, value, updated_by, updated_at)
      VALUES (${scope}, ${key}, ${sql.json(value)}, ${actor.id}, ${this.app.clock.now()})
      ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    `);
    await writeAudit(db, this.app, {
      actor,
      action: 'settings.update',
      targetType: 'settings',
      targetId: scope === 'global' ? key : `${scope}:${key}`,
      metadata: { changes: diff(before, value) },
    });
    db.onCommit(() => this.stored.set(this.storeKey(scope, key), value));
    return this.effective<T>(def, scope, { scope, value });
  }

  /** Drop the stored values for a scope: global falls back to the defaults, an organization to the global values. */
  async reset<T = any>(db: Db, key: string, actor: Actor, scope = 'global'): Promise<T> {
    const def = this.defs.get(key);
    if (!def) throw validationError([{ path: ['key'], message: `Unknown settings section "${key}"` }]);
    const before = this.stored.get(this.storeKey(scope, key)) ?? {};
    await db.exec(sql`DELETE FROM settings WHERE scope = ${scope} AND key = ${key}`);
    await writeAudit(db, this.app, {
      actor,
      action: 'settings.reset',
      targetType: 'settings',
      targetId: scope === 'global' ? key : `${scope}:${key}`,
      metadata: { changes: diff(before, {}) },
    });
    db.onCommit(() => this.stored.delete(this.storeKey(scope, key)));
    return this.effective<T>(def, scope, { scope, value: null });
  }
}
