import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import { sql } from '../../core/sql.js';
import { likePattern } from '../../core/validation.js';
import { customerMigrations } from './migrations.js';
import { registerUserRoutes } from './routes-users.js';
import { registerOrgRoutes } from './routes-orgs.js';
import { registerApiRoutes } from './routes-api.js';
import { registerImportJob, registerImportRoutes } from './import.js';
import { registerMergeRoutes } from './merge.js';
import { registerAgreementRoutes } from './agreements.js';
import { registerSignupFormRoutes } from './signup-forms.js';
import { archiveInactiveUsers } from './archive.js';
import { addSearchProvider } from '../core/routes.js';
import { userScopeSql, orgScopeSql } from './service.js';

export const customerSettings = z.object({
  /** Where admins land when impersonating: your app URL with a {token} placeholder. */
  impersonationUrl: z.string().max(500).refine((v) => !v || (/^https?:\/\//.test(v) && v.includes('{token}')), 'Must be an http(s) URL containing {token}'),
  impersonationMinutes: z.number().int().min(1).max(240),
  allowWriteImpersonation: z.boolean(),
  privacyRequestDueDays: z.number().int().min(1).max(90),
  archiveInactive: z
    .boolean()
    .describe('Archive customers who have been inactive for the number of days below and hold no subscription (other than cancelled) or access grant, directly or through an organization. Archived customers are hidden from the default user list and restored when they sign in.'),
  archiveAfterDays: z.number().int().min(30).max(3650).describe('Days without activity or sign-in before a customer is archived'),
});

export const customersModule: ModuleDefinition = {
  id: 'customers',
  name: 'Customers',
  description: 'Users, organizations, memberships, notes, custom fields, privacy requests, impersonation, imports, merges, signup forms and agreements.',
  version: '1.0.0',
  required: true,
  dependencies: ['core', 'security', 'iam'],
  migrations: customerMigrations,
  permissions: [
    { key: 'customers.users.view', label: 'View users' },
    { key: 'customers.users.create', label: 'Create users' },
    { key: 'customers.users.edit', label: 'Edit users, tags and custom fields' },
    { key: 'customers.users.suspend', label: 'Suspend and reactivate users' },
    { key: 'customers.users.ban', label: 'Ban users', dangerous: true },
    { key: 'customers.users.delete', label: 'Delete and anonymize users', dangerous: true },
    { key: 'customers.users.export', label: 'Export user data' },
    { key: 'customers.users.import', label: 'Import users from CSV files', dangerous: true },
    { key: 'customers.users.merge', label: 'Merge duplicate accounts', dangerous: true },
    { key: 'customers.users.impersonate', label: 'Impersonate users', dangerous: true },
    { key: 'customers.sessions.view', label: 'View user sessions' },
    { key: 'customers.sessions.revoke', label: 'Revoke user sessions' },
    { key: 'customers.notes.view', label: 'View internal notes' },
    { key: 'customers.notes.manage', label: 'Write internal notes' },
    { key: 'customers.fields.manage', label: 'Manage custom fields' },
    { key: 'customers.forms.view', label: 'View signup forms' },
    { key: 'customers.forms.manage', label: 'Create and edit signup forms' },
    { key: 'customers.agreements.view', label: 'View agreements and who accepted them' },
    { key: 'customers.agreements.manage', label: 'Publish agreements and new versions' },
    { key: 'customers.privacy.manage', label: 'Handle privacy (export/erasure) requests', dangerous: true },
    { key: 'customers.organizations.view', label: 'View organizations' },
    { key: 'customers.organizations.manage', label: 'Manage organizations and members' },
    { key: 'customers.organizations.delete', label: 'Delete organizations', dangerous: true },
  ],
  nav: [
    { id: 'users', label: 'Users', path: '/customers/users', icon: 'users', section: 'customers', permission: 'customers.users.view', order: 0 },
    { id: 'organizations', label: 'Organizations', path: '/customers/organizations', icon: 'building-2', section: 'customers', permission: 'customers.organizations.view', order: 10 },
    { id: 'signup-forms', label: 'Signup forms', path: '/customers/signup-forms', icon: 'file-pen', section: 'customers', permission: 'customers.forms.view', order: 40 },
    { id: 'agreements', label: 'Agreements', path: '/customers/agreements', icon: 'signature', section: 'customers', permission: 'customers.agreements.view', order: 45 },
    { id: 'privacy', label: 'Privacy requests', path: '/customers/privacy', icon: 'file-lock-2', section: 'customers', permission: 'customers.privacy.manage', order: 80 },
  ],
  events: [
    { type: 'user.created', description: 'A user was created' },
    { type: 'user.updated', description: 'A user profile changed' },
    { type: 'user.suspended', description: 'A user was suspended' },
    { type: 'user.banned', description: 'A user was banned' },
    { type: 'user.reactivated', description: 'A suspended or banned user was reactivated' },
    { type: 'user.deleted', description: 'A user was deleted' },
    { type: 'user.restored', description: 'A deleted user was restored' },
    { type: 'user.anonymized', description: "A user's personal data was erased" },
    { type: 'user.archived', description: 'A user was archived (inactive; hidden from default lists)' },
    { type: 'user.unarchived', description: 'An archived user was restored (signed in, became active or restored by an admin)' },
    { type: 'user.merged', description: 'A duplicate account was merged into this user; the source id no longer exists as a separate account' },
    { type: 'user.email_verified', description: 'An email address was verified' },
    { type: 'user.sessions_revoked', description: 'All sessions of a user must end (sign the user out)' },
    { type: 'user.password_reset_requested', description: 'An admin requested a password reset (external auth apps should send one)' },
    { type: 'user.impersonation_started', description: 'An admin started impersonating a user' },
    { type: 'user.impersonation_ended', description: 'An impersonation session ended' },
    { type: 'agreement.version_published', description: 'A new agreement version was published (it takes effect at effectiveAt)' },
    { type: 'agreement.accepted', description: 'A customer accepted an agreement version' },
    { type: 'organization.created', description: 'An organization was created' },
    { type: 'organization.updated', description: 'An organization changed' },
    { type: 'organization.suspended', description: 'An organization was suspended' },
    { type: 'organization.reactivated', description: 'An organization was reactivated' },
    { type: 'organization.deleted', description: 'An organization was deleted' },
    { type: 'organization.member_added', description: 'A member joined an organization' },
    { type: 'organization.member_updated', description: "A member's role or status changed" },
    { type: 'organization.member_removed', description: 'A member left an organization' },
    { type: 'organization.ownership_transferred', description: 'Organization ownership changed' },
    { type: 'organization.invitation_created', description: 'Someone was invited to an organization' },
  ],
  setup(app) {
    app.settings.define({
      key: 'customers',
      module: 'customers',
      label: 'Customers',
      description: 'Impersonation, privacy request handling and archiving of inactive customers.',
      schema: customerSettings,
      defaults: { impersonationUrl: '', impersonationMinutes: 15, allowWriteImpersonation: false, privacyRequestDueDays: 30, archiveInactive: false, archiveAfterDays: 365 },
    });

    addSearchProvider(app, 'customers', 'customers.users.view', async ({ q, orgScope }) => {
      const users = await app.db.many<{ id: string; email: string; name: string | null; status: string; archived_at: Date | null }>(sql`
        SELECT u.id, u.email, u.name, u.status, u.archived_at FROM users u
        ${sql.where([sql`u.deleted_at IS NULL`, sql`(u.email ILIKE ${likePattern(q)} OR u.name ILIKE ${likePattern(q)} OR u.id = ${q} OR u.external_id = ${q})`, userScopeSql(orgScope)])}
        ORDER BY u.last_active_at DESC NULLS LAST LIMIT 8
      `);
      const orgs = await app.db.many<{ id: string; name: string; slug: string }>(sql`
        SELECT o.id, o.name, o.slug FROM organizations o
        ${sql.where([sql`o.deleted_at IS NULL`, sql`(o.name ILIKE ${likePattern(q)} OR o.slug ILIKE ${likePattern(q)} OR o.id = ${q})`, orgScopeSql(orgScope)])}
        LIMIT 5
      `);
      return [
        ...users.map((u) => {
          const state = u.archived_at ? `${u.status} · archived` : u.status;
          return { type: 'user', id: u.id, title: u.name || u.email, subtitle: u.name ? `${u.email} · ${state}` : state, url: `/customers/users/${u.id}` };
        }),
        ...orgs.map((o) => ({ type: 'organization', id: o.id, title: o.name, subtitle: o.slug, url: `/customers/organizations/${o.id}` })),
      ];
    });

    // Timed suspensions lift themselves.
    app.jobs.register('customers.lift_suspensions', async (_p, { app }) => {
      const due = await app.db.many<{ id: string }>(sql`SELECT id FROM users WHERE status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until <= ${app.clock.now()}`);
      for (const u of due) {
        await app.db.tx(async (tx) => {
          await tx.exec(sql`UPDATE users SET status = 'active', status_reason = NULL, suspended_until = NULL, updated_at = ${app.clock.now()} WHERE id = ${u.id}`);
          await app.events.emit(tx, 'user.reactivated', { userId: u.id, reason: 'suspension_expired' }, { userId: u.id });
        });
      }
    });
    app.jobs.schedule({ key: 'customers.lift_suspensions', jobType: 'customers.lift_suspensions', intervalSeconds: 300, description: 'Reactivate users whose timed suspension ended', module: 'customers' });

    app.jobs.register('customers.archive_inactive', async (_p, { app }) => {
      await archiveInactiveUsers(app);
    });
    app.jobs.schedule({
      key: 'customers.archive_inactive',
      jobType: 'customers.archive_inactive',
      intervalSeconds: 6 * 3600,
      description: 'Archive customers inactive longer than the configured number of days (off unless enabled in the customer settings)',
      module: 'customers',
    });

    registerImportJob(app);
  },
  routes(r, app) {
    registerUserRoutes(r, app);
    registerImportRoutes(r, app);
    registerMergeRoutes(r, app);
    registerOrgRoutes(r, app);
    registerAgreementRoutes(r, app);
    registerSignupFormRoutes(r, app);
    registerApiRoutes(r, app);
  },
};
