import { z } from 'zod';
import { isValidRange, parseVersion } from './semver.js';

/**
 * Permissions a plugin can request. Nothing is granted implicitly: an admin
 * reviews the list before activation and the host enforces it on every call.
 *
 *   settings                 read the plugin's own settings
 *   secrets                  read the plugin's own encrypted credentials
 *   kv                       plugin-scoped key/value storage
 *   users:read               look up users (id, email, name, status, plan)
 *   http:<host>              outbound HTTPS to a host (http:*.example.com for subdomains)
 *   events:<pattern>         receive domain events (e.g. events:order.paid, events:user.*)
 *   hooks:<name>             transform an extension point (see PLUGIN_HOOKS)
 *   routes                   serve HTTP endpoints under /api/plugins/<id>/
 *   jobs                     run scheduled tasks
 *   gateway                  register a payment gateway adapter
 *   push                     register a push notification provider (delivery to customers' apps)
 */
export const PLUGIN_HOOKS: Record<string, { description: string; requires?: string }> = {
  'entitlements.resolve': { description: 'Adjust the resolved entitlements of a user or organization', requires: 'users:read' },
  'admin.nav': { description: 'Add navigation items (e.g. links to plugin admin pages)' },
  'reports.dashboard.kpis': { description: 'Add KPIs to the dashboard' },
  'system.health': { description: 'Report integration health' },
  'marketing.list_providers': { description: 'Report a newsletter service the plugin keeps in sync with mailing lists, and whether it is connected' },
};

const permission = z.string().regex(/^(settings|secrets|kv|users:read|routes|jobs|gateway|push|http:(\*\.)?[a-z0-9.-]+|events:[a-z0-9_.*]+|hooks:[a-z0-9_.]+)$/, 'Unknown permission');

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,48}[a-z0-9]$/, 'Lowercase letters, numbers and dashes'),
  name: z.string().min(1).max(80),
  version: z.string().refine((v) => parseVersion(v) !== null, 'Use semantic versioning (1.2.3)'),
  description: z.string().max(500).default(''),
  author: z.string().max(120).default(''),
  homepage: z.string().url().optional(),
  type: z.enum(['extension', 'payment_gateway', 'integration', 'theme']).default('extension'),
  engine: z.string().refine(isValidRange, 'Invalid version range').default('*'),
  main: z.string().regex(/^[A-Za-z0-9_./-]+\.m?js$/, 'main must be a .js or .mjs file').default('index.js'),
  permissions: z.array(permission).max(50).default([]),
  dependencies: z.record(z.string(), z.string().refine(isValidRange, 'Invalid version range')).default({}),
  settingsSchema: z.record(z.string(), z.unknown()).optional(),
  secrets: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string().max(100), required: z.boolean().default(false) })).max(20).default([]),
  adminPages: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), title: z.string().max(60), path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/) })).max(10).default([]),
});
export type PluginManifest = z.infer<typeof manifestSchema>;

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Is a permission granted (with wildcard handling for http and events)? */
export function permits(granted: readonly string[], needed: string): boolean {
  if (granted.includes(needed)) return true;
  if (needed.startsWith('http:')) {
    const host = needed.slice(5);
    return granted.some((g) => g.startsWith('http:*.') && (host.endsWith(g.slice(6)) || host === g.slice(7)));
  }
  if (needed.startsWith('events:')) {
    const pattern = needed.slice(7);
    return granted.some((g) => {
      if (!g.startsWith('events:')) return false;
      const p = g.slice(7);
      if (p === '*') return true;
      if (p.endsWith('.*')) return pattern === p || pattern.startsWith(p.slice(0, -1));
      return p === pattern;
    });
  }
  return false;
}
