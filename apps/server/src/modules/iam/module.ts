import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import { sql } from '../../core/sql.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { adminAuthenticator } from './auth.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerTeamRoutes } from './routes-team.js';
import { addSearchProvider } from '../core/routes.js';
import { likePattern } from '../../core/validation.js';
import { notifyAdmins } from './notify.js';

export const authSettings = z.object({
  sessionIdleMinutes: z.number().int().min(5).max(10080),
  sessionMaxHours: z.number().int().min(1).max(2160),
  mobileSessionDays: z.number().int().min(1).max(90),
  require2fa: z.boolean(),
  lockoutThreshold: z.number().int().min(3).max(50),
  lockoutMinutes: z.number().int().min(1).max(1440),
  passwordMinLength: z.number().int().min(8).max(128),
  passwordRequireMixed: z.boolean(),
  reauthWindowMinutes: z.number().int().min(1).max(120),
  ipAllowlist: z.array(z.string()).max(200),
});
export type AuthSettings = z.infer<typeof authSettings>;

/**
 * Default roles. System roles are refreshed from this list on every boot (so
 * upgrades can add permissions) and cannot be edited; clone one to customize.
 */
export const SYSTEM_ROLES: { key: string; name: string; description: string; permissions: string[] }[] = [
  { key: 'super_admin', name: 'Super administrator', description: 'Unrestricted access, including the admin team, roles and security settings.', permissions: ['*'] },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Runs the business day to day. Cannot change roles or delete administrators.',
    permissions: ['*', '!iam.roles.manage', '!iam.admins.delete'],
  },
  {
    key: 'billing_manager',
    name: 'Billing manager',
    description: 'Subscriptions, invoices, payments, refunds, taxes and gateways.',
    permissions: ['billing.*', 'catalog.*', 'customers.users.view', 'customers.organizations.view', 'usage.*.view', 'usage.credits.manage', 'reports.*', 'affiliates.*.view', 'iam.approvals.view', 'developers.health.view'],
  },
  {
    key: 'support',
    name: 'Customer support',
    description: 'Helps customers: profiles, notes, sessions, tickets. Read-only billing.',
    permissions: ['customers.users.view', 'customers.users.edit', 'customers.users.suspend', 'customers.notes.*', 'customers.sessions.*', 'customers.organizations.view', 'customers.groups.view', 'customers.agreements.view', 'support.*', 'billing.*.view', 'usage.*.view', 'catalog.*.view', 'notifications.messages.view', 'email.messages.view', 'access.*.view'],
  },
  {
    key: 'developer',
    name: 'Developer',
    description: 'API keys, webhooks, plugins, modules and system health.',
    permissions: ['developers.*', 'plugins.*', 'system.modules.view', 'system.jobs.*', 'system.events.view', 'system.settings.view', 'usage.*.view', 'catalog.*.view', 'themes.*'],
  },
  {
    key: 'marketing_manager',
    name: 'Marketing manager',
    description: 'Campaigns, email, coupons, segments and themes.',
    permissions: ['marketing.*', 'email.*', 'notifications.*', 'catalog.coupons.*', 'catalog.products.view', 'customers.users.view', 'reports.*.view', 'themes.*', 'developers.health.view'],
  },
  {
    key: 'affiliate_manager',
    name: 'Affiliate manager',
    description: 'Affiliate program: approvals, commissions and payouts.',
    permissions: ['affiliates.*', 'customers.users.view', 'reports.*.view', 'iam.approvals.view'],
  },
  { key: 'analyst', name: 'Read-only analyst', description: 'Can view everything and run reports, but change nothing.', permissions: ['*.*.view', 'reports.*'] },
];

export const iamModule: ModuleDefinition = {
  id: 'iam',
  name: 'Admin team & access',
  description: 'Administrator accounts, roles and permissions, sessions, two-factor authentication and approvals.',
  version: '1.0.0',
  required: true,
  dependencies: ['core', 'security'],
  migrations: [
    {
      version: '001',
      name: 'admins, roles, sessions',
      up: `
        CREATE TABLE admins (
          id text PRIMARY KEY,
          email text NOT NULL,
          name text NOT NULL,
          password_hash text,
          status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          totp_secret_enc text,
          totp_pending_secret_enc text,
          totp_enabled boolean NOT NULL DEFAULT false,
          totp_last_counter bigint,
          recovery_codes jsonb NOT NULL DEFAULT '[]',
          failed_login_count int NOT NULL DEFAULT 0,
          locked_until timestamptz,
          allowed_ips jsonb NOT NULL DEFAULT '[]',
          org_scope jsonb,
          avatar_url text,
          last_login_at timestamptz,
          last_login_ip text,
          password_changed_at timestamptz,
          created_by text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX admins_email_uq ON admins (lower(email));

        CREATE TABLE roles (
          id text PRIMARY KEY,
          key text NOT NULL UNIQUE,
          name text NOT NULL,
          description text NOT NULL DEFAULT '',
          permissions jsonb NOT NULL DEFAULT '[]',
          limits jsonb NOT NULL DEFAULT '{}',
          is_system boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );

        CREATE TABLE admin_roles (
          admin_id text NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          role_id text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          PRIMARY KEY (admin_id, role_id)
        );
        CREATE INDEX admin_roles_role_idx ON admin_roles (role_id);

        CREATE TABLE admin_sessions (
          id text PRIMARY KEY,
          admin_id text NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          token_hash text NOT NULL UNIQUE,
          csrf_token text NOT NULL,
          client text NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'mobile')),
          ip text,
          user_agent text,
          mfa_verified boolean NOT NULL DEFAULT false,
          reauth_at timestamptz,
          created_at timestamptz NOT NULL,
          last_seen_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz,
          revoked_reason text
        );
        CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id, created_at DESC);

        CREATE TABLE admin_invitations (
          id text PRIMARY KEY,
          email text NOT NULL,
          role_ids jsonb NOT NULL DEFAULT '[]',
          org_scope jsonb,
          token_hash text NOT NULL UNIQUE,
          invited_by text REFERENCES admins(id) ON DELETE SET NULL,
          expires_at timestamptz NOT NULL,
          accepted_at timestamptz,
          revoked_at timestamptz,
          created_at timestamptz NOT NULL
        );

        CREATE TABLE admin_password_resets (
          id text PRIMARY KEY,
          admin_id text NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          token_hash text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL
        );

        CREATE TABLE approval_requests (
          id text PRIMARY KEY,
          action text NOT NULL,
          approve_permission text NOT NULL,
          target_type text,
          target_id text,
          summary text NOT NULL,
          payload jsonb NOT NULL DEFAULT '{}',
          amount bigint,
          currency text,
          status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
          requested_by text NOT NULL REFERENCES admins(id),
          reason text,
          decided_by text REFERENCES admins(id),
          decided_at timestamptz,
          decision_note text,
          result jsonb,
          error text,
          created_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL
        );
        CREATE INDEX approval_requests_status_idx ON approval_requests (status, created_at DESC);
      `,
    },
  ],
  permissions: [
    { key: 'iam.admins.view', label: 'View administrators' },
    { key: 'iam.admins.manage', label: 'Invite and edit administrators', dangerous: true },
    { key: 'iam.admins.delete', label: 'Remove administrators', dangerous: true },
    { key: 'iam.roles.view', label: 'View roles' },
    { key: 'iam.roles.manage', label: 'Create and edit roles', dangerous: true },
    { key: 'iam.approvals.view', label: 'View approval requests' },
  ],
  nav: [
    { id: 'team', label: 'Team', path: '/admin/team', icon: 'users-round', section: 'admin', permission: 'iam.admins.view', order: 0 },
    { id: 'roles', label: 'Roles', path: '/admin/roles', icon: 'key-round', section: 'admin', permission: 'iam.roles.view', order: 10 },
    { id: 'approvals', label: 'Approvals', path: '/admin/approvals', icon: 'stamp', section: 'admin', permission: 'iam.approvals.view', order: 15 },
  ],
  events: [
    { type: 'admin.invited', description: 'An administrator was invited' },
    { type: 'approval.requested', description: 'An action is waiting for a second approver' },
  ],
  setup(app) {
    app.settings.define({
      key: 'auth',
      module: 'iam',
      label: 'Admin sign-in & sessions',
      description: 'Session lifetime, two-factor policy, lockout and IP restrictions for the admin panel.',
      schema: authSettings,
      defaults: {
        sessionIdleMinutes: 120,
        sessionMaxHours: 72,
        mobileSessionDays: 30,
        require2fa: false,
        lockoutThreshold: 5,
        lockoutMinutes: 15,
        passwordMinLength: 12,
        passwordRequireMixed: true,
        reauthWindowMinutes: 10,
        ipAllowlist: [],
      },
      permission: 'iam.roles.manage',
    });
    app.authenticators.admin = adminAuthenticator(app);

    addSearchProvider(app, 'iam', 'iam.admins.view', async ({ q }) => {
      const rows = await app.db.many<{ id: string; name: string; email: string }>(sql`
        SELECT id, name, email FROM admins WHERE email ILIKE ${likePattern(q)} OR name ILIKE ${likePattern(q)} LIMIT 5
      `);
      return rows.map((r) => ({ type: 'admin', id: r.id, title: r.name, subtitle: r.email, url: `/admin/team/${r.id}` }));
    });

    // Security alerts reach admins who can act on them.
    app.events.subscribe('iam.notify-security', 'security.alert', async (event) => {
      await app.db.tx((tx) =>
        notifyAdmins(tx, app, {
          permission: 'security.events.view',
          type: 'security.alert',
          title: `Security: ${String(event.data.type).replace(/[._]/g, ' ')}`,
          body: event.data.subjectId ? `Subject: ${event.data.subjectType} ${event.data.subjectId}` : undefined,
          link: '/admin/security',
          severity: event.data.severity === 'critical' ? 'critical' : 'warning',
        }),
      );
    }, { module: 'iam' });

    app.jobs.register('iam.cleanup', async (_p, { app }) => {
      const now = app.clock.now();
      await app.db.exec(sql`DELETE FROM admin_sessions WHERE (expires_at < ${now} OR revoked_at IS NOT NULL) AND created_at < ${new Date(now.getTime() - 30 * 86_400_000)}`);
      await app.db.exec(sql`UPDATE approval_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ${now}`);
    });
    app.jobs.schedule({ key: 'iam.cleanup', jobType: 'iam.cleanup', intervalSeconds: 3600, description: 'Expire approvals and purge old admin sessions', module: 'iam' });
  },
  async start(app) {
    const now = app.clock.now();
    for (const role of SYSTEM_ROLES) {
      await app.db.exec(sql`
        INSERT INTO roles (id, key, name, description, permissions, is_system, created_at, updated_at)
        VALUES (${newId('role')}, ${role.key}, ${role.name}, ${role.description}, ${sql.json(role.permissions)}, TRUE, ${now}, ${now})
        ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
          permissions = EXCLUDED.permissions, is_system = TRUE, updated_at = EXCLUDED.updated_at
      `);
    }
    const admins = await app.db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM admins`);
    if (admins.count === 0) {
      const token = app.config.setupToken ?? randomBase62(24);
      app.services['iam.setupToken'] = token;
      if (!app.config.isTest) {
        app.log.warn(
          `No administrators exist yet. Open ${app.config.adminUrl}/setup and use this one-time setup token: ${token}`,
        );
      }
    }
  },
  routes(r, app) {
    registerAuthRoutes(r, app);
    registerTeamRoutes(r, app);
  },
};
