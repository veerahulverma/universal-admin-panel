import { ShieldAlert } from 'lucide-react';
import type { JsonSchema } from '../../components/SchemaForm';
import { Badge } from '../../components/ui';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  type: 'extension' | 'payment_gateway' | 'integration' | 'theme';
  engine: string;
  main: string;
  permissions: string[];
  dependencies: Record<string, string>;
  settingsSchema?: JsonSchema;
  secrets: { key: string; label: string; required: boolean }[];
  adminPages: { id: string; title: string; path: string }[];
}

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  source: 'bundled' | 'upload' | 'marketplace';
  status: 'installed' | 'active' | 'inactive' | 'error';
  manifest: PluginManifest;
  settings: Record<string, unknown>;
  granted_permissions: string[];
  sandboxed: boolean;
  error_count: number;
  last_error: string | null;
  last_error_at: string | null;
  installed_at: string;
  activated_at: string | null;
  updated_at: string;
  running: boolean;
  hooks: { name: string; description: string | null }[];
  updateAvailable?: string | null;
}

export interface PluginDetail extends PluginRow {
  versions: { version: string; sha256: string; installed_at: string }[];
  logs: PluginLog[];
  secrets: { name: string; last4: string | null }[];
  routes: { method: string; path: string; auth?: string }[];
}

export interface PluginLog {
  id?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  context: Record<string, unknown>;
  created_at: string;
}

export type HookCatalog = Record<string, { description: string; requires?: string }>;

const TYPE_LABEL: Record<string, string> = { extension: 'Extension', payment_gateway: 'Payment gateway', integration: 'Integration', theme: 'Theme' };

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

/** What a requested permission lets the plugin do, in plain words. */
export function describePermission(p: string, hooks: HookCatalog = {}): { label: string; detail: string; sensitive: boolean } {
  if (p === 'settings') return { label: 'Read its settings', detail: 'Reads the settings you configure for this plugin.', sensitive: false };
  if (p === 'secrets') return { label: 'Read its credentials', detail: 'Decrypts the credentials entered for this plugin (only its own).', sensitive: true };
  if (p === 'kv') return { label: 'Private storage', detail: 'Keeps data in its own key/value store.', sensitive: false };
  if (p === 'users:read') return { label: 'Read customer profiles', detail: 'Looks up users: ID, email, name, status and plan.', sensitive: true };
  if (p === 'routes') return { label: 'Serve HTTP endpoints', detail: 'Answers requests under /api/plugins/<id>/; endpoints are public unless the plugin marks them admin-only.', sensitive: true };
  if (p === 'jobs') return { label: 'Run scheduled tasks', detail: 'Runs code periodically in the background.', sensitive: false };
  if (p === 'gateway') return { label: 'Process payments', detail: 'Registers a payment gateway used for checkouts, renewals and refunds.', sensitive: true };
  if (p.startsWith('http:')) {
    const host = p.slice(5);
    return { label: `Connect to ${host}`, detail: host.startsWith('*.') ? `Outbound HTTPS to ${host.slice(2)} and any of its subdomains.` : `Outbound HTTPS to ${host} only.`, sensitive: true };
  }
  if (p.startsWith('events:')) {
    const pattern = p.slice(7);
    return { label: `Receive ${pattern} events`, detail: 'Is notified of matching events, including their data.', sensitive: pattern.includes('*') || pattern.startsWith('user') || pattern.startsWith('payment') };
  }
  if (p.startsWith('hooks:')) {
    const name = p.slice(6);
    return { label: `Extend “${name}”`, detail: hooks[name]?.description ?? 'Transforms an extension point.', sensitive: Boolean(hooks[name]?.requires) };
  }
  return { label: p, detail: 'Unrecognized permission', sensitive: true };
}

export function PermissionList({ permissions, hooks, granted }: { permissions: string[]; hooks?: HookCatalog; granted?: string[] }) {
  if (!permissions.length) return <p className="text-sm text-muted-foreground">This plugin requests no permissions.</p>;
  return (
    <ul className="divide-y rounded-ui border">
      {permissions.map((p) => {
        const d = describePermission(p, hooks);
        const isNew = granted && !granted.includes(p);
        return (
          <li key={p} className="flex items-start gap-3 px-3 py-2.5">
            {d.sensitive ? <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Sensitive" /> : <span className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {d.label}
                <code className="font-mono text-xs font-normal text-muted-foreground">{p}</code>
                {isNew && <Badge tone="warning">new</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">{d.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PluginStatus({ plugin }: { plugin: Pick<PluginRow, 'status' | 'running'> }) {
  if (plugin.status === 'active') return <Badge tone={plugin.running ? 'success' : 'warning'} dot>{plugin.running ? 'active' : 'active · not running'}</Badge>;
  if (plugin.status === 'error') return <Badge tone="danger" dot>error</Badge>;
  if (plugin.status === 'installed') return <Badge tone="info" dot>not activated</Badge>;
  return <Badge dot>inactive</Badge>;
}
