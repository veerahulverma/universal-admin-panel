import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { isAllowed } from '../../core/permissions.js';
import { flattenPermissions, rolePermissionsSql } from './auth.js';

export interface AdminNotification {
  /** Only admins holding this permission receive the notification. */
  permission: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  severity?: 'info' | 'success' | 'warning' | 'critical';
  data?: Record<string, unknown>;
  excludeAdminId?: string;
}

/** Fan a notification out to every active admin allowed to see it. */
export async function notifyAdmins(db: Db, app: App, n: AdminNotification): Promise<number> {
  const admins = await db.many<{ id: string; perms: string[][] }>(sql`
    SELECT a.id, ${rolePermissionsSql('a.id')} AS perms FROM admins a WHERE a.status = 'active'
  `);
  const now = app.clock.now();
  let count = 0;
  for (const a of admins) {
    if (a.id === n.excludeAdminId || !isAllowed(flattenPermissions(a.perms), n.permission)) continue;
    await db.exec(sql.insert('notifications', {
      id: newId('ntf'),
      recipient_type: 'admin',
      recipient_id: a.id,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
      severity: n.severity ?? 'info',
      data: n.data ?? {},
      created_at: now,
    }, ''));
    count++;
  }
  // Other modules can relay it too (the email module sends copies to the addresses in Settings → Email).
  await app.hooks.apply('admin.notified', null, { db, notification: n });
  return count;
}
