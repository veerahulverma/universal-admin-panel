import type { ModuleDefinition } from '../../core/modules.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';
import { likePattern } from '../../core/validation.js';
import { registerApiScopes } from '../developers/keys.js';
import { addSearchProvider } from '../core/routes.js';
import { accessMigrations } from './migrations.js';
import { accessDefaults, accessSettingsSchema, groupsOfUser, settingsOf, type GroupMembership } from './service.js';
import { signingKey } from './downloads.js';
import { registerGroupRoutes } from './routes-groups.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerApiRoutes } from './routes-api.js';

/** Content protection: user groups, protected resources and downloads, drip release and access checks. */
export const accessModule: ModuleDefinition = {
  id: 'access',
  name: 'Content & access',
  description: 'Protect pages, URLs, folders and files by plan, product or user group, with drip release, protected downloads and access checks for your apps.',
  version: '1.0.0',
  dependencies: ['core', 'customers', 'developers', 'catalog'],
  migrations: accessMigrations,
  permissions: [
    { key: 'customers.groups.view', label: 'View user groups and their members' },
    { key: 'customers.groups.manage', label: 'Create, rename and delete user groups; add and remove members' },
    { key: 'access.resources.view', label: 'View protected content, access rules and what customers can open' },
    { key: 'access.resources.manage', label: 'Protect URLs and folders; publish members-only pages, links and downloads; edit rules and drip schedules' },
    { key: 'access.files.view', label: 'View protected downloads, download limits and the download log' },
    { key: 'access.files.manage', label: 'Upload, replace and delete protected downloads; change download limits and settings' },
    { key: 'access.log.view', label: 'View the access log' },
  ],
  nav: [
    { id: 'user-groups', label: 'User groups', path: '/customers/groups', icon: 'users-round', section: 'customers', permission: 'customers.groups.view', order: 15 },
    { id: 'access-resources', label: 'Protected content', path: '/content/resources', icon: 'folder-lock', section: 'content', permission: 'access.resources.view', order: 10 },
    { id: 'access-files', label: 'Downloads', path: '/content/files', icon: 'download', section: 'content', permission: 'access.files.view', order: 20 },
    { id: 'access-log', label: 'Access log', path: '/content/log', icon: 'scroll-text', section: 'content', permission: 'access.log.view', order: 30 },
  ],
  events: [
    { type: 'user_group.created', description: 'A user group was created' },
    { type: 'user_group.updated', description: 'A user group was renamed or its automatic membership changed' },
    { type: 'user_group.deleted', description: 'A user group was deleted' },
    { type: 'user_group.member_added', description: 'A user was added to a group' },
    { type: 'user_group.member_removed', description: 'A user was removed from a group' },
    { type: 'access_resource.created', description: 'A URL, folder, page, link or download was put behind access rules' },
    { type: 'access_resource.updated', description: 'A protected resource, its rules or its release schedule changed' },
    { type: 'access_resource.deleted', description: 'A protected resource was deleted' },
    { type: 'access_file.uploaded', description: 'A protected download was uploaded' },
    { type: 'access_file.updated', description: 'A protected download was renamed, re-limited or replaced' },
    { type: 'access_file.deleted', description: 'A protected download was deleted' },
    { type: 'access_file.downloaded', description: 'A customer downloaded a protected file' },
  ],
  setup(app) {
    app.settings.define({
      key: 'access',
      module: 'access',
      label: 'Content protection',
      description: 'Protected download size limit, download link lifetime, default download limit and access log retention.',
      schema: accessSettingsSchema,
      defaults: accessDefaults,
      permission: 'access.files.manage',
    });
    registerApiScopes(app, 'access', [{ scope: 'access:read', description: 'Check access to protected content and list what a user can open' }]);

    // For other modules: groupsOfUser(db, userId) -> the user's groups, by hand or automatic.
    app.services['access.groupsOfUser'] = (db: Db, userId: string): Promise<GroupMembership[]> =>
      app.modules.isEnabled('access') ? groupsOfUser(db, app, userId) : Promise.resolve([]);

    addSearchProvider(app, 'access', 'access.resources.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; kind: string; title: string; path: string | null }>(sql`
        SELECT id, kind, title, path FROM access_resources WHERE title ILIKE ${likePattern(q)} OR path ILIKE ${likePattern(q)} ORDER BY lower(title) LIMIT 5
      `);
      return rows.map((r) => ({ type: 'access_resource', id: r.id, title: r.title, subtitle: r.path ? `${r.kind} · ${r.path}` : r.kind, url: `/content/resources/${r.id}` }));
    });
    addSearchProvider(app, 'access', 'customers.groups.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; name: string; description: string }>(sql`
        SELECT id, name, description FROM user_groups WHERE name ILIKE ${likePattern(q)} ORDER BY lower(name) LIMIT 5
      `);
      return rows.map((g) => ({ type: 'user_group', id: g.id, title: g.name, subtitle: g.description || 'User group', url: `/customers/groups/${g.id}` }));
    });

    app.hooks.addFilter('privacy.export', 'access', async (data: Record<string, unknown>, ctx: { db: Db; userId: string }) => ({
      ...data,
      access: {
        groups: (await groupsOfUser(ctx.db, app, ctx.userId)).map((g) => ({ name: g.name, manual: g.manual, automatic: g.automatic, since: g.since })),
        downloads: await ctx.db.many(sql`
          SELECT af.title AS file, d.ip, d.created_at FROM access_downloads d JOIN access_files af ON af.id = d.file_id WHERE d.user_id = ${ctx.userId} ORDER BY d.created_at
        `),
      },
    }));

    // Erasure: group memberships and outstanding links go; download and access records lose their network details.
    app.hooks.addFilter('privacy.anonymize', 'access', async (_v: unknown, ctx: { db: Db; userId: string }) => {
      await ctx.db.exec(sql`DELETE FROM user_group_members WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`DELETE FROM access_download_links WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`UPDATE access_downloads SET ip = NULL, user_agent = NULL WHERE user_id = ${ctx.userId}`);
      await ctx.db.exec(sql`UPDATE access_log SET ip = NULL WHERE user_id = ${ctx.userId}`);
      return null;
    });

    app.hooks.addFilter('system.retention', 'access', async (_v: unknown, ctx: { before: (days: number) => Date }) => {
      if (!app.modules.isEnabled('access')) return null;
      await app.db.exec(sql`DELETE FROM access_log WHERE created_at < ${ctx.before(settingsOf(app).logRetentionDays)}`);
      await app.db.exec(sql`DELETE FROM access_download_links WHERE expires_at < ${new Date(app.clock.now().getTime() - DAY)}`);
      return null;
    });
  },
  async start(app) {
    // Create the link-signing key once at boot, so concurrent first downloads never race to create it.
    await app.db.tx((tx) => signingKey(app, tx));
  },
  routes(r, app) {
    registerGroupRoutes(r, app);
    registerAdminRoutes(r, app);
    registerApiRoutes(r, app);
  },
};
