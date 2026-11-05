import { z } from 'zod';
import type { ModuleDefinition } from '../../core/modules.js';
import { coreMigrations } from './migrations.js';
import { registerCoreRoutes } from './routes.js';
import { sql } from '../../core/sql.js';
import { DAY } from '../../core/clock.js';

export const generalSettings = z.object({
  appName: z.string().min(1).max(80),
  appUrl: z.string().url().or(z.literal('')),
  supportEmail: z.string().email().or(z.literal('')),
  logoUrl: z.string().url().or(z.literal('')),
  faviconUrl: z.string().url().or(z.literal('')),
  locale: z.string().min(2).max(10),
  timezone: z.string().min(1).max(64),
  dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'D MMM YYYY']),
  defaultCurrency: z.string().length(3),
  currencies: z.array(z.string().length(3)).min(1).max(50),
});
export type GeneralSettings = z.infer<typeof generalSettings>;

export const retentionSettings = z.object({
  auditLogDays: z.number().int().min(30).max(3650),
  loginEventDays: z.number().int().min(7).max(3650),
  apiRequestLogDays: z.number().int().min(1).max(365),
  webhookDeliveryDays: z.number().int().min(1).max(365),
  eventDays: z.number().int().min(1).max(365),
  completedJobDays: z.number().int().min(1).max(90),
  emailLogDays: z.number().int().min(7).max(3650),
});
export type RetentionSettings = z.infer<typeof retentionSettings>;

export const coreModule: ModuleDefinition = {
  id: 'core',
  name: 'Core platform',
  description: 'Settings, secrets, audit trail, events, background jobs and system health.',
  version: '1.0.0',
  required: true,
  migrations: coreMigrations,
  permissions: [
    { key: 'system.settings.view', label: 'View system settings' },
    { key: 'system.settings.manage', label: 'Change system settings', dangerous: true },
    { key: 'system.modules.view', label: 'View modules' },
    { key: 'system.modules.manage', label: 'Enable and disable modules', dangerous: true },
    { key: 'system.jobs.view', label: 'View background jobs and health' },
    { key: 'system.jobs.manage', label: 'Retry jobs and manage scheduled tasks' },
    { key: 'system.events.view', label: 'View the domain event log' },
    { key: 'security.audit.view', label: 'View the audit log' },
  ],
  nav: [
    { id: 'dashboard', label: 'Dashboard', path: '/', icon: 'layout-dashboard', section: 'overview', order: 0 },
    { id: 'modules', label: 'Modules', path: '/platform/modules', icon: 'blocks', section: 'platform', permission: 'system.modules.view', order: 20 },
    { id: 'jobs', label: 'Jobs & health', path: '/platform/system', icon: 'activity', section: 'admin', permission: 'system.jobs.view', order: 50 },
    { id: 'settings', label: 'Settings', path: '/platform/settings', icon: 'settings', section: 'admin', permission: 'system.settings.view', order: 90 },
    { id: 'audit', label: 'Audit log', path: '/admin/audit', icon: 'scroll-text', section: 'admin', permission: 'security.audit.view', order: 30 },
  ],
  setup(app) {
    app.settings.define({
      key: 'general',
      module: 'core',
      label: 'General',
      description: 'Application identity, locale and currencies.',
      schema: generalSettings,
      defaults: {
        appName: 'Steward',
        appUrl: '',
        supportEmail: '',
        logoUrl: '',
        faviconUrl: '',
        locale: 'en',
        timezone: 'UTC',
        dateFormat: 'D MMM YYYY',
        defaultCurrency: 'USD',
        currencies: ['USD', 'EUR', 'GBP', 'INR'],
      },
      tenantOverridable: true,
    });
    app.settings.define({
      key: 'retention',
      module: 'core',
      label: 'Data retention',
      description: 'How long logs and operational records are kept before automatic deletion.',
      schema: retentionSettings,
      defaults: {
        auditLogDays: 730,
        loginEventDays: 180,
        apiRequestLogDays: 30,
        webhookDeliveryDays: 30,
        eventDays: 90,
        completedJobDays: 14,
        emailLogDays: 180,
      },
    });

    app.jobs.register('events.handle', async ({ eventId, handlerId }, { app }) => {
      await app.events.runHandler(eventId, handlerId);
    });

    app.jobs.register('system.retention', async (_payload, { app }) => {
      const r = app.settings.get<RetentionSettings>('retention');
      const now = app.clock.now().getTime();
      const before = (days: number) => new Date(now - days * DAY);
      await app.rateLimiter.purgeExpired();
      await app.db.exec(sql`DELETE FROM jobs WHERE status = 'completed' AND completed_at < ${before(r.completedJobDays)}`);
      await app.db.exec(sql`DELETE FROM events WHERE dispatched_at IS NOT NULL AND created_at < ${before(r.eventDays)}`);
      await app.db.tx(async (tx) => {
        await tx.query(sql`SELECT set_config('steward.audit_retention', 'on', true)`);
        await tx.exec(sql`DELETE FROM audit_logs WHERE created_at < ${before(r.auditLogDays)}`);
      });
      // Other modules purge their own tables when this hook fires.
      await app.hooks.apply('system.retention', null, { before, settings: r });
    });
    app.jobs.schedule({
      key: 'system.retention',
      jobType: 'system.retention',
      intervalSeconds: 6 * 3600,
      description: 'Delete logs and records older than the retention policy',
      module: 'core',
    });
  },
  routes: registerCoreRoutes,
};
