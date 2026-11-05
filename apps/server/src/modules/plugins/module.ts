import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { pageQuery, paginate } from '../../core/validation.js';
import { writeAudit } from '../../core/audit.js';
import { manifestSchema, PLUGIN_HOOKS, type PluginManifest } from './manifest.js';
import { compareVersions, satisfies } from './semver.js';
import { parseTgz, stripPackagePrefix, writeEntries } from './tar.js';
import { PluginHost, type PluginRow } from './host.js';

export const BUNDLED_PLUGINS_DIR = path.resolve(process.env.BUNDLED_PLUGINS_DIR ?? path.join(import.meta.dirname, '../../../../../plugins'));

export function pluginHost(app: App): PluginHost {
  let host = app.services['plugins.host'] as PluginHost | undefined;
  if (!host) {
    host = new PluginHost(app);
    app.services['plugins.host'] = host;
  }
  return host;
}

/** Validate settings against the subset of JSON Schema plugins use (object of typed properties). */
export function validateSettings(schema: Record<string, any> | undefined, value: Record<string, unknown>): { path: string[]; message: string }[] {
  if (!schema) return Object.keys(value).length ? [{ path: ['settings'], message: 'This plugin has no settings' }] : [];
  const issues: { path: string[]; message: string }[] = [];
  const props: Record<string, any> = schema.properties ?? {};
  for (const req of schema.required ?? []) if (value[req] === undefined || value[req] === '') issues.push({ path: [req], message: 'Required' });
  for (const [k, v] of Object.entries(value)) {
    const p = props[k];
    if (!p) {
      issues.push({ path: [k], message: 'Unknown setting' });
      continue;
    }
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const expected = p.type === 'integer' ? 'number' : p.type;
    if (expected && type !== expected) issues.push({ path: [k], message: `Expected ${p.type}` });
    else if (p.enum && !p.enum.includes(v)) issues.push({ path: [k], message: `One of: ${p.enum.join(', ')}` });
    else if (typeof v === 'string' && p.maxLength && v.length > p.maxLength) issues.push({ path: [k], message: `At most ${p.maxLength} characters` });
    else if (typeof v === 'number' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) issues.push({ path: [k], message: 'Out of range' });
  }
  return issues;
}

async function readManifestFromDir(dir: string): Promise<PluginManifest> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
  return manifestSchema.parse(raw);
}

/**
 * Install (or update) a plugin from package contents. Files are written to an
 * immutable versioned folder, so updating keeps older versions for rollback.
 */
export async function installPackage(app: App, archive: Buffer, opts: { source: 'upload' | 'marketplace'; actor: any }): Promise<{ plugin: PluginRow; updated: boolean }> {
  let entries;
  try {
    entries = stripPackagePrefix(parseTgz(archive));
  } catch (err) {
    throw validationError([{ path: ['package'], message: `Not a valid plugin package: ${(err as Error).message}` }]);
  }
  const manifestEntry = entries.find((e) => e.path === 'plugin.json');
  if (!manifestEntry) throw validationError([{ path: ['package'], message: 'plugin.json is missing' }]);
  const parsed = manifestSchema.safeParse(JSON.parse(manifestEntry.data.toString('utf8')));
  if (!parsed.success) throw validationError(parsed.error.issues.map((i) => ({ path: ['plugin.json', ...i.path.map(String)], message: i.message })));
  const manifest = parsed.data;
  if (!entries.some((e) => e.path === path.posix.normalize(manifest.main))) throw validationError([{ path: ['main'], message: `${manifest.main} is not in the package` }]);
  if (!satisfies(app.config.version, manifest.engine)) throw new AppError(409, 'incompatible_plugin', `${manifest.name} requires platform version ${manifest.engine} (this is ${app.config.version})`);
  const existing = await app.db.maybe<PluginRow>(sql`SELECT * FROM plugins WHERE id = ${manifest.id}`);
  if (existing?.source === 'bundled') throw conflict('A bundled plugin with this id exists', 'plugin_id_reserved');
  if (existing && compareVersions(manifest.version, existing.version) === 0) throw conflict(`Version ${manifest.version} is already installed`, 'plugin_version_exists');

  const sha = createHash('sha256').update(archive).digest('hex');
  const dir = path.join(app.config.pluginsDir, manifest.id, manifest.version);
  await fs.rm(dir, { recursive: true, force: true });
  await writeEntries(dir, entries);

  const host = pluginHost(app);
  const wasActive = existing?.status === 'active';
  const now = app.clock.now();
  await app.db.tx(async (tx) => {
    await tx.exec(sql`
      INSERT INTO plugin_versions (plugin_id, version, manifest, path, sha256, installed_at) VALUES (${manifest.id}, ${manifest.version}, ${sql.json(manifest)}, ${dir}, ${sha}, ${now})
      ON CONFLICT (plugin_id, version) DO UPDATE SET manifest = EXCLUDED.manifest, path = EXCLUDED.path, sha256 = EXCLUDED.sha256, installed_at = EXCLUDED.installed_at
    `);
    if (!existing) {
      await tx.exec(sql.insert('plugins', {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        source: opts.source,
        status: 'installed',
        manifest,
        settings: {},
        granted_permissions: [],
        sandboxed: true,
        installed_at: now,
        updated_at: now,
      }, ''));
    }
    await writeAudit(tx, app, { actor: opts.actor, action: existing ? 'plugin.update' : 'plugin.install', targetType: 'plugin', targetId: manifest.id, metadata: { version: manifest.version, from: existing?.version ?? null, sha256: sha, source: opts.source } });
  });

  if (existing) {
    // Swap to the new version; on failure fall back to the previous one.
    const previous = existing.version;
    if (wasActive) await host.stop(manifest.id);
    const newPerms = manifest.permissions.filter((p) => !existing.granted_permissions.includes(p));
    await app.db.exec(sql`UPDATE plugins SET version = ${manifest.version}, name = ${manifest.name}, manifest = ${sql.json(manifest)}, updated_at = ${now} WHERE id = ${manifest.id}`);
    if (wasActive) {
      if (newPerms.length) {
        // New permissions need fresh consent: leave the plugin inactive until an admin re-approves.
        await app.db.exec(sql`UPDATE plugins SET status = 'inactive', last_error = ${`Update requests new permissions: ${newPerms.join(', ')}`} WHERE id = ${manifest.id}`);
      } else {
        try {
          await host.start(manifest.id);
        } catch (err) {
          await app.db.exec(sql`UPDATE plugins SET version = ${previous}, manifest = (SELECT manifest FROM plugin_versions WHERE plugin_id = ${manifest.id} AND version = ${previous}) WHERE id = ${manifest.id}`);
          await host.start(manifest.id).catch(() => undefined);
          throw new AppError(422, 'plugin_update_failed', `Update failed and was rolled back to ${previous}: ${(err as Error).message}`);
        }
      }
    }
  }
  return { plugin: await host.row(manifest.id), updated: Boolean(existing) };
}

/** Register plugins shipped in the repository's plugins/ folder (trusted, run in-process). */
async function discoverBundled(app: App): Promise<void> {
  if (!fsSync.existsSync(BUNDLED_PLUGINS_DIR)) return;
  for (const name of await fs.readdir(BUNDLED_PLUGINS_DIR)) {
    const dir = path.join(BUNDLED_PLUGINS_DIR, name);
    if (!fsSync.existsSync(path.join(dir, 'plugin.json'))) continue;
    let manifest: PluginManifest;
    try {
      manifest = await readManifestFromDir(dir);
    } catch (err) {
      app.log.warn({ err, dir }, 'invalid bundled plugin manifest');
      continue;
    }
    const now = app.clock.now();
    await app.db.exec(sql`
      INSERT INTO plugin_versions (plugin_id, version, manifest, path, sha256, installed_at) VALUES (${manifest.id}, ${manifest.version}, ${sql.json(manifest)}, ${dir}, 'bundled', ${now})
      ON CONFLICT (plugin_id, version) DO UPDATE SET manifest = EXCLUDED.manifest, path = EXCLUDED.path
    `);
    await app.db.exec(sql`
      INSERT INTO plugins (id, name, version, source, status, manifest, settings, granted_permissions, sandboxed, installed_at, updated_at)
      VALUES (${manifest.id}, ${manifest.name}, ${manifest.version}, 'bundled', 'installed', ${sql.json(manifest)}, '{}', '[]', FALSE, ${now}, ${now})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, manifest = EXCLUDED.manifest
      WHERE plugins.source = 'bundled'
    `);
  }
}

interface MarketplaceEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  type?: string;
  permissions?: string[];
  download: string;
  sha256: string;
  signature?: string;
}

async function marketplaceIndex(app: App): Promise<MarketplaceEntry[] | null> {
  if (!app.config.marketplaceUrl) return null;
  const res = await fetch(app.config.marketplaceUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AppError(502, 'marketplace_unavailable', `Marketplace returned ${res.status}`);
  const json: any = await res.json();
  return Array.isArray(json?.plugins) ? json.plugins : [];
}

function verifyMarketplacePackage(app: App, entry: MarketplaceEntry, archive: Buffer): void {
  const sha = createHash('sha256').update(archive).digest('hex');
  if (sha !== entry.sha256) throw new AppError(422, 'checksum_mismatch', 'Downloaded package does not match its published checksum');
  if (app.config.marketplacePublicKey) {
    if (!entry.signature) throw new AppError(422, 'signature_missing', 'Marketplace package is not signed');
    const pem = app.config.marketplacePublicKey.includes('BEGIN') ? app.config.marketplacePublicKey : `-----BEGIN PUBLIC KEY-----\n${app.config.marketplacePublicKey}\n-----END PUBLIC KEY-----`;
    const ok = verifySignature(null, Buffer.from(sha), createPublicKey(pem), Buffer.from(entry.signature, 'base64'));
    if (!ok) throw new AppError(422, 'signature_invalid', 'Marketplace package signature is invalid');
  }
}

async function dependentsOf(db: Db, id: string): Promise<string[]> {
  const rows = await db.many<{ id: string; manifest: PluginManifest }>(sql`SELECT id, manifest FROM plugins WHERE status = 'active' AND id <> ${id}`);
  return rows.filter((r) => Object.keys(r.manifest.dependencies ?? {}).includes(id)).map((r) => r.id);
}

function present(row: PluginRow & Record<string, any>, host: PluginHost) {
  return {
    ...row,
    running: host.isRunning(row.id),
    hooks: row.manifest.permissions.filter((p) => p.startsWith('hooks:')).map((p) => ({ name: p.slice(6), description: PLUGIN_HOOKS[p.slice(6)]?.description ?? null })),
  };
}

export const pluginsModule: ModuleDefinition = {
  id: 'plugins',
  name: 'Plugins',
  description: 'Install, configure and isolate plugins: payment gateways, integrations and extensions.',
  version: '1.0.0',
  required: true,
  dependencies: ['core', 'iam'],
  migrations: [
    {
      version: '001',
      name: 'plugins',
      up: `
        CREATE TABLE plugins (
          id text PRIMARY KEY,
          name text NOT NULL,
          version text NOT NULL,
          source text NOT NULL CHECK (source IN ('bundled', 'upload', 'marketplace')),
          status text NOT NULL CHECK (status IN ('installed', 'active', 'inactive', 'error')),
          manifest jsonb NOT NULL,
          settings jsonb NOT NULL DEFAULT '{}',
          granted_permissions jsonb NOT NULL DEFAULT '[]',
          sandboxed boolean NOT NULL DEFAULT true,
          error_count int NOT NULL DEFAULT 0,
          last_error text,
          last_error_at timestamptz,
          installed_at timestamptz NOT NULL,
          activated_at timestamptz,
          updated_at timestamptz NOT NULL
        );

        CREATE TABLE plugin_versions (
          plugin_id text NOT NULL,
          version text NOT NULL,
          manifest jsonb NOT NULL,
          path text NOT NULL,
          sha256 text NOT NULL,
          installed_at timestamptz NOT NULL,
          PRIMARY KEY (plugin_id, version)
        );

        CREATE TABLE plugin_logs (
          id text PRIMARY KEY,
          plugin_id text NOT NULL,
          level text NOT NULL,
          message text NOT NULL,
          context jsonb NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL
        );
        CREATE INDEX plugin_logs_plugin_idx ON plugin_logs (plugin_id, created_at DESC);

        CREATE TABLE plugin_kv (
          plugin_id text NOT NULL,
          key text NOT NULL,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL,
          PRIMARY KEY (plugin_id, key)
        );
      `,
    },
  ],
  permissions: [
    { key: 'plugins.manage.view', label: 'View plugins and their logs' },
    { key: 'plugins.manage.install', label: 'Install, update, activate and remove plugins', dangerous: true },
    { key: 'plugins.manage.configure', label: 'Change plugin settings and credentials' },
  ],
  nav: [{ id: 'plugins', label: 'Plugins', path: '/platform/plugins', icon: 'puzzle', section: 'platform', permission: 'plugins.manage.view', order: 10 }],
  setup(app) {
    const host = pluginHost(app);
    app.services['plugins.stop'] = () => host.stopAll();
    app.hooks.addFilter('admin.nav', 'plugins', async (items: unknown[]) => {
      const rows = await app.db.many<{ id: string; name: string; manifest: PluginManifest }>(sql`SELECT id, name, manifest FROM plugins WHERE status = 'active'`);
      const extra = rows.flatMap((r) =>
        r.manifest.adminPages.map((p) => ({ id: `plugin-${r.id}-${p.id}`, label: p.title, path: `/platform/plugins/${r.id}/pages/${p.id}`, icon: 'puzzle', section: 'platform', module: 'plugins', order: 100, permission: 'plugins.manage.view' })),
      );
      return [...items, ...extra];
    });
    app.hooks.addFilter('system.health', 'plugins', async (checks: any[]) => {
      const rows = await app.db.many<{ name: string; status: string; last_error: string | null }>(sql`SELECT name, status, last_error FROM plugins WHERE status IN ('active', 'error')`);
      return [...checks, ...rows.map((r) => ({ name: `Plugin: ${r.name}`, status: r.status === 'error' ? 'down' : 'ok', detail: r.status === 'error' ? r.last_error ?? 'Error' : 'Running' }))];
    });
    app.hooks.addFilter('system.retention', 'plugins', async (_v: unknown, ctx: { before: (d: number) => Date }) => {
      await app.db.exec(sql`DELETE FROM plugin_logs WHERE created_at < ${ctx.before(30)}`);
    });
  },
  async start(app) {
    await discoverBundled(app);
    const host = pluginHost(app);
    const active = await app.db.many<{ id: string }>(sql`SELECT id FROM plugins WHERE status = 'active' ORDER BY installed_at`);
    for (const p of active) {
      try {
        await host.start(p.id);
      } catch (err) {
        app.log.error({ err, plugin: p.id }, 'plugin failed to start');
        await app.db.exec(sql`UPDATE plugins SET status = 'error', last_error = ${(err as Error).message}, last_error_at = ${app.clock.now()} WHERE id = ${p.id}`);
      }
    }
  },
  routes(r, app) {
    const host = pluginHost(app);

    r.route({
      method: 'GET',
      url: '/api/admin/plugins',
      auth: 'admin',
      permission: 'plugins.manage.view',
      summary: 'Installed plugins (with available updates when a marketplace is configured)',
      tags: ['Plugins'],
      handler: async () => {
        const rows = await app.db.many<PluginRow & Record<string, any>>(sql`SELECT * FROM plugins ORDER BY name`);
        let updates: Record<string, string> = {};
        try {
          const index = await marketplaceIndex(app);
          if (index) updates = Object.fromEntries(index.filter((e) => rows.some((r) => r.id === e.id && compareVersions(e.version, r.version) > 0)).map((e) => [e.id, e.version]));
        } catch {
          /* marketplace offline: no update hints */
        }
        return { data: rows.map((row) => ({ ...present(row, host), updateAvailable: updates[row.id] ?? null })), hooks: PLUGIN_HOOKS };
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/plugins/:id',
      auth: 'admin',
      permission: 'plugins.manage.view',
      summary: 'Plugin details: permissions, versions, settings and recent logs',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const row = await app.db.maybe<PluginRow & Record<string, any>>(sql`SELECT * FROM plugins WHERE id = ${c.params.id}`);
        if (!row) throw notFound('Plugin');
        const [versions, logs, secrets] = await Promise.all([
          app.db.many(sql`SELECT version, sha256, installed_at FROM plugin_versions WHERE plugin_id = ${row.id} ORDER BY installed_at DESC`),
          app.db.many(sql`SELECT level, message, context, created_at FROM plugin_logs WHERE plugin_id = ${row.id} ORDER BY created_at DESC LIMIT 50`),
          app.secrets.describe(app.db, 'plugin', row.id),
        ]);
        return { ...present(row, host), versions, logs, secrets: secrets.map((s) => ({ name: s.name, last4: s.last4 })), routes: host.routes.get(row.id) ?? [] };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/plugins/upload',
      auth: 'admin',
      permission: 'plugins.manage.install',
      sensitive: true,
      summary: 'Upload a plugin package (.tgz, the format produced by `npm pack`)',
      tags: ['Plugins'],
      bodyLimit: 12 * 1024 * 1024,
      handler: async (c) => {
        const file = await c.req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
        if (!file) throw validationError([{ path: ['package'], message: 'Attach a .tgz package' }]);
        const archive = await file.toBuffer();
        return installPackage(app, archive, { source: 'upload', actor: c.actor });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/plugins/marketplace',
      auth: 'admin',
      permission: 'plugins.manage.view',
      summary: 'Browse the plugin marketplace',
      tags: ['Plugins'],
      handler: async () => {
        const index = await marketplaceIndex(app);
        if (!index) return { configured: false, data: [] };
        return { configured: true, signed: Boolean(app.config.marketplacePublicKey), data: index.map(({ download: _d, signature: _s, ...rest }) => rest) };
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/plugins/marketplace/install',
      auth: 'admin',
      permission: 'plugins.manage.install',
      sensitive: true,
      summary: 'Install or update a plugin from the marketplace (checksum and signature verified)',
      tags: ['Plugins'],
      body: z.object({ id: z.string(), version: z.string().optional() }),
      handler: async (c) => {
        const index = await marketplaceIndex(app);
        if (!index) throw new AppError(503, 'marketplace_unconfigured', 'Set MARKETPLACE_URL to enable the marketplace');
        const entry = index.filter((e) => e.id === c.body.id && (!c.body.version || e.version === c.body.version)).sort((a, b) => compareVersions(b.version, a.version))[0];
        if (!entry) throw notFound('Marketplace plugin');
        const res = await fetch(entry.download, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new AppError(502, 'download_failed', `Download failed (${res.status})`);
        const archive = Buffer.from(await res.arrayBuffer());
        if (archive.length > 10 * 1024 * 1024) throw new AppError(422, 'package_too_large', 'Package exceeds 10MB');
        verifyMarketplacePackage(app, entry, archive);
        return installPackage(app, archive, { source: 'marketplace', actor: c.actor });
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/plugins/:id/activate',
      auth: 'admin',
      permission: 'plugins.manage.install',
      sensitive: true,
      summary: 'Activate a plugin, granting exactly the permissions it declares (explicit consent)',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      body: z.object({ grantPermissions: z.array(z.string()) }),
      handler: async (c) => {
        const row = await host.row(c.params.id);
        const declared = [...row.manifest.permissions].sort();
        const granted = [...new Set(c.body.grantPermissions)].sort();
        if (JSON.stringify(declared) !== JSON.stringify(granted)) {
          throw validationError([{ path: ['grantPermissions'], message: `Review and grant exactly the declared permissions: ${declared.join(', ') || '(none)'}` }]);
        }
        for (const [dep, range] of Object.entries(row.manifest.dependencies ?? {})) {
          const d = await app.db.maybe<{ version: string; status: string }>(sql`SELECT version, status FROM plugins WHERE id = ${dep}`);
          if (!d || d.status !== 'active') throw conflict(`Activate the "${dep}" plugin first`, 'plugin_dependency');
          if (!satisfies(d.version, range)) throw conflict(`"${dep}" ${d.version} does not satisfy ${range}`, 'plugin_dependency');
        }
        await app.db.exec(sql`UPDATE plugins SET granted_permissions = ${sql.json(granted)} WHERE id = ${row.id}`);
        if (host.isRunning(row.id)) await host.stop(row.id);
        try {
          await host.start(row.id);
        } catch (err) {
          await app.db.exec(sql`UPDATE plugins SET status = 'error', last_error = ${(err as Error).message}, last_error_at = ${app.clock.now()} WHERE id = ${row.id}`);
          throw err;
        }
        await app.db.tx(async (tx) => {
          await tx.exec(sql`UPDATE plugins SET status = 'active', activated_at = ${app.clock.now()}, last_error = NULL, updated_at = ${app.clock.now()} WHERE id = ${row.id}`);
          await c.audit(tx, 'plugin.activate', { type: 'plugin', id: row.id }, { version: row.version, permissions: granted });
        });
        return present(await host.row(row.id) as any, host);
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/plugins/:id/deactivate',
      auth: 'admin',
      permission: 'plugins.manage.install',
      summary: 'Deactivate a plugin',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const row = await host.row(c.params.id);
        const dependents = await dependentsOf(app.db, row.id);
        if (dependents.length) throw conflict(`Deactivate dependent plugins first: ${dependents.join(', ')}`, 'plugin_dependents');
        await host.stop(row.id);
        await app.db.tx(async (tx) => {
          await tx.exec(sql`UPDATE plugins SET status = 'inactive', updated_at = ${app.clock.now()} WHERE id = ${row.id}`);
          await c.audit(tx, 'plugin.deactivate', { type: 'plugin', id: row.id });
        });
        return present(await host.row(row.id) as any, host);
      },
    });

    r.route({
      method: 'POST',
      url: '/api/admin/plugins/:id/rollback',
      auth: 'admin',
      permission: 'plugins.manage.install',
      sensitive: true,
      summary: 'Switch to a previously installed version',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      body: z.object({ version: z.string() }),
      handler: async (c) => {
        const row = await host.row(c.params.id);
        const target = await app.db.maybe<{ manifest: PluginManifest }>(sql`SELECT manifest FROM plugin_versions WHERE plugin_id = ${row.id} AND version = ${c.body.version}`);
        if (!target) throw notFound('Plugin version');
        const wasActive = row.status === 'active';
        if (wasActive) await host.stop(row.id);
        await app.db.exec(sql`UPDATE plugins SET version = ${c.body.version}, manifest = ${sql.json(target.manifest)}, updated_at = ${app.clock.now()} WHERE id = ${row.id}`);
        if (wasActive) {
          const extra = target.manifest.permissions.filter((p) => !row.granted_permissions.includes(p));
          if (extra.length) await app.db.exec(sql`UPDATE plugins SET status = 'inactive' WHERE id = ${row.id}`);
          else await host.start(row.id);
        }
        await writeAudit(app.db, app, { actor: c.actor, action: 'plugin.rollback', targetType: 'plugin', targetId: row.id, metadata: { from: row.version, to: c.body.version } });
        return present(await host.row(row.id) as any, host);
      },
    });

    r.route({
      method: 'PUT',
      url: '/api/admin/plugins/:id/settings',
      auth: 'admin',
      permission: 'plugins.manage.configure',
      summary: 'Update plugin settings (validated against the plugin settings schema)',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      body: z.object({ settings: z.record(z.string(), z.unknown()) }),
      handler: async (c) => {
        const row = await host.row(c.params.id);
        const issues = validateSettings(row.manifest.settingsSchema as any, c.body.settings);
        if (issues.length) throw validationError(issues);
        await app.db.tx(async (tx) => {
          await tx.exec(sql`UPDATE plugins SET settings = ${sql.json(c.body.settings)}, updated_at = ${app.clock.now()} WHERE id = ${row.id}`);
          await c.audit(tx, 'plugin.settings_update', { type: 'plugin', id: row.id }, { keys: Object.keys(c.body.settings) });
        });
        return { ok: true };
      },
    });

    r.route({
      method: 'PUT',
      url: '/api/admin/plugins/:id/secrets',
      auth: 'admin',
      permission: 'plugins.manage.configure',
      sensitive: true,
      summary: 'Set plugin credentials (encrypted at rest; never returned)',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      body: z.object({ secrets: z.record(z.string(), z.string().max(5000)) }),
      handler: async (c) => {
        const row = await host.row(c.params.id);
        const allowed = new Set(row.manifest.secrets.map((s) => s.key));
        const unknown = Object.keys(c.body.secrets).filter((k) => !allowed.has(k));
        if (unknown.length) throw validationError([{ path: ['secrets'], message: `Unknown credentials: ${unknown.join(', ')}` }]);
        await app.db.tx(async (tx) => {
          for (const [k, v] of Object.entries(c.body.secrets)) {
            if (v) await app.secrets.set(tx, 'plugin', row.id, k, v);
            else await app.secrets.delete(tx, 'plugin', row.id, k);
          }
          await c.audit(tx, 'plugin.secrets_update', { type: 'plugin', id: row.id }, { keys: Object.keys(c.body.secrets) });
        });
        return { ok: true };
      },
    });

    r.route({
      method: 'DELETE',
      url: '/api/admin/plugins/:id',
      auth: 'admin',
      permission: 'plugins.manage.install',
      sensitive: true,
      summary: 'Uninstall a plugin (removes files, settings, credentials and storage)',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      handler: async (c) => {
        const row = await host.row(c.params.id);
        if (row.source === 'bundled') throw conflict('Bundled plugins can be deactivated but not uninstalled', 'plugin_bundled');
        const dependents = await dependentsOf(app.db, row.id);
        if (dependents.length) throw conflict(`Remove dependent plugins first: ${dependents.join(', ')}`, 'plugin_dependents');
        await host.stop(row.id);
        await app.db.tx(async (tx) => {
          await tx.exec(sql`DELETE FROM plugin_kv WHERE plugin_id = ${row.id}`);
          await tx.exec(sql`DELETE FROM plugin_versions WHERE plugin_id = ${row.id}`);
          await tx.exec(sql`DELETE FROM plugins WHERE id = ${row.id}`);
          await app.secrets.delete(tx, 'plugin', row.id);
          await c.audit(tx, 'plugin.uninstall', { type: 'plugin', id: row.id }, { version: row.version });
        });
        await fs.rm(path.join(app.config.pluginsDir, row.id), { recursive: true, force: true });
      },
    });

    r.route({
      method: 'GET',
      url: '/api/admin/plugins/:id/logs',
      auth: 'admin',
      permission: 'plugins.manage.view',
      summary: 'Plugin logs',
      tags: ['Plugins'],
      params: z.object({ id: z.string() }),
      query: z.object({ ...pageQuery, level: z.enum(['info', 'warn', 'error']).optional() }),
      handler: (c) =>
        paginate(app.db, {
          select: sql`*`,
          from: sql`plugin_logs`,
          where: sql.where([sql`plugin_id = ${c.params.id}`, c.query.level && sql`level = ${c.query.level}`]),
          orderBy: sql`ORDER BY created_at DESC`,
          page: c.query.page,
          pageSize: c.query.pageSize,
        }),
    });

    // ---- Plugin HTTP routes and admin pages ------------------------------------------------------
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      r.route({
        method,
        url: '/api/plugins/:pluginId/*',
        auth: 'public',
        hidden: true,
        params: z.object({ pluginId: z.string(), '*': z.string().default('') }),
        handler: async (c) => {
          const routePath = `/${c.params['*']}`;
          const reg = (host.routes.get(c.params.pluginId) ?? []).find((x) => x.method === method && x.path === routePath);
          if (!reg || !host.isRunning(c.params.pluginId)) throw notFound('Plugin route');
          let admin: { id: string; email: string } | null = null;
          if (reg.auth === 'admin') {
            const p = await app.authenticators.admin!(c.req, 'admin');
            if (p.kind !== 'admin') throw notFound('Plugin route');
            admin = { id: p.adminId, email: p.email };
          }
          const headers = Object.fromEntries(['content-type', 'user-agent', 'accept'].map((h) => [h, String(c.req.headers[h] ?? '')]));
          const res = (await host.invoke(c.params.pluginId, 'route', reg.handlerId, [{ method, path: routePath, query: c.req.query, body: c.req.body ?? null, rawBody: c.req.rawBody ?? null, headers, admin }])) as { status?: number; headers?: Record<string, string>; body?: unknown } | null;
          const status = res?.status ?? 200;
          const out = res?.headers ?? {};
          const contentType = out['content-type'] ?? (typeof res?.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
          // Plugin pages render inside a sandboxed iframe in the admin UI; scripts may not reach the admin origin.
          c.reply.header('content-type', contentType).header('x-frame-options', 'SAMEORIGIN').header('content-security-policy', "sandbox allow-scripts allow-forms; default-src 'self' 'unsafe-inline' data: https:; frame-ancestors 'self'");
          return c.reply.status(status).send(typeof res?.body === 'string' ? res.body : JSON.stringify(res?.body ?? null));
        },
      });
    }
  },
};
