import { sql } from './sql.js';
import type { Db } from './db.js';
import type { Actor, App } from './types.js';
import type { Migration } from './migrate.js';
import type { PermissionDef } from './permissions.js';
import type { Router } from './http.js';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from './audit.js';
import { conflict, notFound } from './errors.js';

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: string;
  /**
   * Sidebar parent menu (labels live in apps/admin/src/components/layout/nav.ts): overview = top-level links,
   * customers = User Management, catalog = Products & Plans, revenue = Billing & Payments, platform = Integrations,
   * content = Content & Access, developers = Developers, growth = Marketing, email = Email, admin = System.
   */
  section: 'overview' | 'customers' | 'revenue' | 'catalog' | 'content' | 'growth' | 'email' | 'developers' | 'platform' | 'admin';
  permission?: string;
  order?: number;
}

export interface ModuleDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Required modules cannot be disabled; the platform depends on them. */
  required?: boolean;
  dependencies?: string[];
  defaultEnabled?: boolean;
  migrations?: Migration[];
  permissions?: Omit<PermissionDef, 'module'>[];
  nav?: NavItem[];
  events?: { type: string; description: string }[];
  /** Register settings, jobs, event handlers and hooks. Runs once at boot. */
  setup?(app: App): void | Promise<void>;
  /** Register HTTP routes. Routes of a disabled module answer 403 module_disabled. */
  routes?(router: Router, app: App): void;
  /** Low-level server hooks (CORS, hosted pages). */
  http?(server: FastifyInstance, app: App): void | Promise<void>;
  /** Runs after every module is set up, settings are loaded and routes exist (seed defaults, activate plugins). */
  start?(app: App): void | Promise<void>;
}

export interface ModuleState {
  id: string;
  name: string;
  description: string;
  version: string;
  required: boolean;
  enabled: boolean;
  dependencies: string[];
  dependents: string[];
  nav: NavItem[];
}

/** Topologically sort modules so dependencies come first; rejects cycles and unknown deps. */
export function sortModules(defs: readonly ModuleDefinition[]): ModuleDefinition[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: ModuleDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (d: ModuleDefinition, trail: string[]) => {
    const s = state.get(d.id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`Module dependency cycle: ${[...trail, d.id].join(' -> ')}`);
    state.set(d.id, 'visiting');
    for (const dep of d.dependencies ?? []) {
      const depDef = byId.get(dep);
      if (!depDef) throw new Error(`Module "${d.id}" depends on unknown module "${dep}"`);
      visit(depDef, [...trail, d.id]);
    }
    state.set(d.id, 'done');
    out.push(d);
  };
  for (const d of defs) visit(d, []);
  return out;
}

export class ModuleRegistry {
  readonly defs: ModuleDefinition[];
  private enabled = new Map<string, boolean>();

  constructor(
    private readonly app: App,
    defs: readonly ModuleDefinition[],
  ) {
    this.defs = sortModules(defs);
  }

  get(id: string): ModuleDefinition | undefined {
    return this.defs.find((d) => d.id === id);
  }

  isEnabled(id: string): boolean {
    const def = this.get(id);
    if (!def) return false;
    if (def.required) return true;
    return this.enabled.get(id) ?? def.defaultEnabled ?? true;
  }

  async load(db: Db = this.app.db): Promise<void> {
    const now = this.app.clock.now();
    for (const d of this.defs) {
      await db.exec(sql`
        INSERT INTO modules (id, enabled, version, installed_at, updated_at)
        VALUES (${d.id}, ${d.required ? true : d.defaultEnabled ?? true}, ${d.version}, ${now}, ${now})
        ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version
      `);
    }
    const rows = await db.many<{ id: string; enabled: boolean }>(sql`SELECT id, enabled FROM modules`);
    this.enabled = new Map(rows.map((r) => [r.id, r.enabled]));
  }

  dependentsOf(id: string): string[] {
    return this.defs.filter((d) => d.dependencies?.includes(id)).map((d) => d.id);
  }

  list(): ModuleState[] {
    return this.defs.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      version: d.version,
      required: Boolean(d.required),
      enabled: this.isEnabled(d.id),
      dependencies: d.dependencies ?? [],
      dependents: this.dependentsOf(d.id),
      nav: d.nav ?? [],
    }));
  }

  async setEnabled(db: Db, id: string, enabled: boolean, actor: Actor): Promise<void> {
    const def = this.get(id);
    if (!def) throw notFound('Module');
    if (def.required && !enabled) throw conflict(`"${def.name}" is a core module and cannot be disabled`, 'module_required');
    if (enabled) {
      const missing = (def.dependencies ?? []).filter((dep) => !this.isEnabled(dep));
      if (missing.length) throw conflict(`Enable required modules first: ${missing.join(', ')}`, 'module_dependency', { missing });
    } else {
      const active = this.dependentsOf(id).filter((dep) => this.isEnabled(dep));
      if (active.length) throw conflict(`Disable dependent modules first: ${active.join(', ')}`, 'module_dependents', { dependents: active });
    }
    await db.exec(sql`UPDATE modules SET enabled = ${enabled}, updated_at = ${this.app.clock.now()} WHERE id = ${id}`);
    await writeAudit(db, this.app, { actor, action: enabled ? 'module.enable' : 'module.disable', targetType: 'module', targetId: id });
    db.onCommit(() => this.enabled.set(id, enabled));
  }

  /** Re-read enabled flags (other instances may have changed them). */
  async refresh(db: Db = this.app.db): Promise<void> {
    const rows = await db.many<{ id: string; enabled: boolean }>(sql`SELECT id, enabled FROM modules`);
    this.enabled = new Map(rows.map((r) => [r.id, r.enabled]));
  }
}
