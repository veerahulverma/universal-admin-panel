/**
 * Permission keys follow `module.resource.action`, e.g. `billing.refunds.create`.
 *
 * Grants are patterns:
 *   "*"                 everything
 *   "billing.*"         a trailing wildcard matches the rest of the key
 *   "*.*.view"          single-segment wildcards
 *   "!iam.roles.manage" explicit deny, which always wins over allows
 */
export interface PermissionDef {
  key: string;
  label: string;
  description?: string;
  module: string;
  /** Destructive or financially sensitive; the UI highlights these. */
  dangerous?: boolean;
}

export function permissionMatches(pattern: string, key: string): boolean {
  if (pattern === '*') return true;
  const p = pattern.split('.');
  const k = key.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' && i === p.length - 1) return k.length >= p.length;
    if (i >= k.length) return false;
    if (p[i] !== '*' && p[i] !== k[i]) return false;
  }
  return p.length === k.length;
}

export function isAllowed(granted: readonly string[], required: string): boolean {
  let allowed = false;
  for (const g of granted) {
    if (g.startsWith('!')) {
      if (permissionMatches(g.slice(1), required)) return false;
    } else if (!allowed && permissionMatches(g, required)) {
      allowed = true;
    }
  }
  return allowed;
}

export class PermissionCatalog {
  private readonly defs = new Map<string, PermissionDef>();

  register(module: string, defs: readonly Omit<PermissionDef, 'module'>[]): void {
    for (const d of defs) this.defs.set(d.key, { ...d, module });
  }

  list(): PermissionDef[] {
    return [...this.defs.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  has(key: string): boolean {
    return this.defs.has(key);
  }

  /** Concrete permission keys a set of grants allows. */
  expand(granted: readonly string[]): string[] {
    return this.list()
      .map((d) => d.key)
      .filter((k) => isAllowed(granted, k));
  }

  /**
   * Privilege-escalation guard: an admin may only grant permissions they hold.
   * A bare "*" can only be granted by someone who holds an unrestricted "*".
   */
  canGrant(granterGrants: readonly string[], targetGrants: readonly string[]): { ok: boolean; missing: string[] } {
    const granterUnrestricted = granterGrants.includes('*') && !granterGrants.some((g) => g.startsWith('!'));
    if (targetGrants.includes('*') && !granterUnrestricted) return { ok: false, missing: ['*'] };
    const missing = this.expand(targetGrants).filter((k) => !isAllowed(granterGrants, k));
    return { ok: missing.length === 0, missing };
  }

  /** Validate patterns reference something real (typos would silently grant nothing). */
  validatePatterns(patterns: readonly string[]): string[] {
    const keys = this.list().map((d) => d.key);
    return patterns.filter((p) => {
      const pattern = p.startsWith('!') ? p.slice(1) : p;
      if (pattern === '*') return false;
      return !keys.some((k) => permissionMatches(pattern, k));
    });
  }
}
