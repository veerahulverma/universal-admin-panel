import { useId, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Info, Plus, X } from 'lucide-react';
import clsx from 'clsx';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { Badge, Checkbox, Input, Spinner, Tip } from '../../components/ui';
import type { PermissionDef, Role } from './types';

// ---- Permission patterns (same rules as the server's core/permissions.ts) -------------

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

/**
 * Mirrors the server's privilege-escalation guard so the UI can explain up
 * front why a role cannot be granted. The server enforces it regardless.
 */
export function canGrant(catalog: readonly PermissionDef[], granter: readonly string[], target: readonly string[]): { ok: boolean; missing: string[] } {
  const unrestricted = granter.includes('*') && !granter.some((g) => g.startsWith('!'));
  if (target.includes('*') && !unrestricted) return { ok: false, missing: ['*'] };
  const missing = catalog.map((d) => d.key).filter((k) => isAllowed(target, k) && !isAllowed(granter, k));
  return { ok: missing.length === 0, missing };
}

/** "Full access", "Full access except 2", "14 permissions". */
export function describeGrants(patterns: readonly string[], catalog: readonly PermissionDef[] | undefined): string {
  const denies = patterns.filter((p) => p.startsWith('!')).length;
  if (patterns.includes('*')) return denies ? `Full access except ${denies}` : 'Full access';
  if (!catalog) return `${patterns.length} pattern${patterns.length === 1 ? '' : 's'}`;
  const n = catalog.filter((d) => isAllowed(patterns, d.key)).length;
  return `${n} of ${catalog.length} permissions`;
}

const NAMESPACE_LABELS: Record<string, string> = {
  iam: 'Team & roles',
  system: 'System',
  security: 'Security',
  customers: 'Customers',
  billing: 'Billing',
  catalog: 'Catalog',
  usage: 'Usage & credits',
  reports: 'Reports',
  developers: 'Developers',
  plugins: 'Plugins',
  themes: 'Themes',
  affiliates: 'Affiliates',
  support: 'Support',
  email: 'Email',
  notifications: 'Notifications',
  marketing: 'Marketing',
  identity: 'Identity',
};

export function namespaceLabel(ns: string): string {
  return NAMESPACE_LABELS[ns] ?? ns.charAt(0).toUpperCase() + ns.slice(1).replace(/_/g, ' ');
}

/** Group permission definitions by their first key segment (the unit "billing.*" grants). */
export function groupByNamespace<T extends { key: string }>(defs: readonly T[]): { ns: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const d of defs) {
    const ns = d.key.split('.')[0];
    map.set(ns, [...(map.get(ns) ?? []), d]);
  }
  return [...map.entries()].sort(([a], [b]) => namespaceLabel(a).localeCompare(namespaceLabel(b))).map(([ns, items]) => ({ ns, items }));
}

export function usePermissionCatalog(enabled = true) {
  return useQuery({ queryKey: ['permission-catalog'], queryFn: () => api.get<{ data: PermissionDef[] }>('/api/admin/permissions'), enabled, staleTime: 10 * 60_000 });
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/api/admin/roles'), enabled, staleTime: 60_000 });
}

// ---- Links, devices, IP caveat ------------------------------------------------------------

const TARGET_ROUTES: Record<string, (id: string) => string> = {
  user: (id) => `/customers/users/${id}`,
  organization: (id) => `/customers/organizations/${id}`,
  admin: (id) => `/admin/team/${id}`,
  role: (id) => `/admin/roles/${id}`,
  ticket: (id) => `/customers/support/${id}`,
  invoice: (id) => `/revenue/invoices/${id}`,
  payment: (id) => `/revenue/payments/${id}`,
  subscription: (id) => `/revenue/subscriptions/${id}`,
  product: (id) => `/catalog/products/${id}`,
  affiliate: (id) => `/growth/affiliates/${id}`,
  campaign: (id) => `/growth/campaigns/${id}`,
};

/** Admin-console URL for an audited or alerted object, when it has a page. */
export function targetHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  return TARGET_ROUTES[type]?.(id) ?? null;
}

export function describeAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python|okhttp/i.test(ua) ? 'Script / API client' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function IpCaveat({ className }: { className?: string }) {
  return (
    <span className={clsx('flex items-start gap-1.5 text-xs text-muted-foreground', className)}>
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>IP addresses can be shared (offices, mobile carriers, VPNs) or change over time. Treat them as a signal to investigate, never as proof of who someone is.</span>
    </span>
  );
}

// ---- Role picker ------------------------------------------------------------------------

/**
 * Checkbox list of roles. Roles that would grant permissions the signed-in
 * administrator does not hold are disabled with an explanation.
 */
export function RolePicker({ roles, catalog, value, onChange, disabled }: { roles: Role[]; catalog: PermissionDef[] | undefined; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { me } = useAuth();
  const grants = me?.grants ?? [];
  return (
    <div className="max-h-72 space-y-1 overflow-y-auto rounded-ui-sm border p-2">
      {roles.map((r) => {
        const check = catalog ? canGrant(catalog, grants, r.permissions) : { ok: true, missing: [] };
        const blocked = !check.ok && !value.includes(r.id);
        return (
          <div key={r.id} className={clsx('rounded-ui-sm px-1.5 py-1', blocked && 'opacity-60')}>
            <Checkbox
              checked={value.includes(r.id)}
              disabled={disabled || blocked}
              onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((id) => id !== r.id))}
              label={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {r.name}
                  {r.is_system ? <Badge>system</Badge> : <Badge tone="primary">custom</Badge>}
                  {blocked && (
                    <Tip content={`Grants permissions you do not hold${check.missing[0] === '*' ? ' (full access)' : `: ${check.missing.slice(0, 4).join(', ')}${check.missing.length > 4 ? '…' : ''}`}`}>
                      <span className="text-xs font-normal text-muted-foreground underline decoration-dotted">not grantable</span>
                    </Tip>
                  )}
                </span>
              }
              description={r.description || undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---- Organization scope -------------------------------------------------------------------

interface OrgLite {
  id: string;
  name: string;
  slug: string;
}

/** Display names for organization IDs (small lists: one cached request per organization). */
export function useOrgNames(ids: readonly string[]): Record<string, string> {
  const { can } = useAuth();
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['organization-name', id],
      queryFn: () => api.get<OrgLite>(`/api/admin/organizations/${id}`),
      enabled: can('customers.organizations.view'),
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    const name = results[i]?.data?.name;
    if (name) out[id] = name;
  });
  return out;
}

export function OrgScopeSummary({ scope }: { scope: string[] | null }) {
  const names = useOrgNames(scope ?? []);
  if (!scope) return <span>All organizations</span>;
  if (!scope.length) return <span className="text-warning">No organizations (no customer data)</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {scope.map((id) => (
        <Badge key={id} tone="info">
          {names[id] ?? id}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Data scope for an administrator: everything, or only selected organizations
 * (tenant isolation for agencies, resellers and regional teams).
 */
export function OrgScopeField({ value, onChange, disabled }: { value: string[] | null; onChange: (v: string[] | null) => void; disabled?: boolean }) {
  const { can } = useAuth();
  const canSearch = can('customers.organizations.view');
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const names = useOrgNames(value ?? []);
  const search = useQuery({
    queryKey: ['org-scope-search', debounced],
    queryFn: () => api.get<Page<OrgLite>>('/api/admin/organizations', { q: debounced || undefined, pageSize: 8, sort: 'name', order: 'asc' }),
    enabled: value !== null && canSearch && !disabled,
    staleTime: 30_000,
  });
  const selected = value ?? [];
  const radioName = useId();

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">Data access</legend>
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input type="radio" name={radioName} className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={value === null} onChange={() => onChange(null)} />
        <span>
          <span className="font-medium">All organizations</span>
          <span className="block text-sm text-muted-foreground">Sees every customer the roles allow.</span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input type="radio" name={radioName} className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={value !== null} onChange={() => onChange(value ?? [])} />
        <span>
          <span className="font-medium">Only selected organizations</span>
          <span className="block text-sm text-muted-foreground">Customer data, billing and reports are limited to these organizations.</span>
        </span>
      </label>
      {value !== null && (
        <div className="space-y-2 rounded-ui-sm border p-2.5">
          {selected.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {selected.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-info/10 py-0.5 pl-2 pr-1 text-xs font-medium text-info">
                  {names[id] ?? id}
                  <button type="button" className="rounded-full p-0.5 hover:bg-info/20" aria-label={`Remove ${names[id] ?? id}`} onClick={() => onChange(selected.filter((x) => x !== id))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-warning">No organizations selected: this administrator will not see any customer data.</p>
          )}
          {canSearch ? (
            <>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search organizations to add…" aria-label="Search organizations" />
              {search.isFetching && !search.data ? (
                <Spinner />
              ) : (
                <ul className="max-h-40 overflow-y-auto">
                  {(search.data?.data ?? [])
                    .filter((o) => !selected.includes(o.id))
                    .map((o) => (
                      <li key={o.id}>
                        <button type="button" className="flex w-full items-center gap-2 rounded-ui-sm px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => onChange([...selected, o.id])}>
                          <Plus className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">{o.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{o.slug}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </>
          ) : (
            <Input
              aria-label="Organization IDs"
              placeholder="Organization IDs, comma separated"
              defaultValue={selected.join(', ')}
              onBlur={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}
