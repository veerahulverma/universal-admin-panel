import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { validationError } from '../../core/errors.js';
import { isAllowed } from '../../core/permissions.js';
import { flattenPermissions, rolePermissionsSql } from '../iam/auth.js';

const ROTATION_LOCK = 72_710_420;

interface AgentRow {
  id: string;
  name: string;
  email: string;
  perms: string[][] | null;
}

/** Active administrators among `ids` who hold `permission` (order of `ids` is kept). */
export async function agentsWith(db: Db, ids: readonly string[], permission: string): Promise<AgentRow[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.many<AgentRow>(sql`
    SELECT a.id, a.name, a.email, ${rolePermissionsSql('a.id')} AS perms FROM admins a WHERE a.id IN ${sql.in(unique)} AND a.status = 'active'
  `);
  const allowed = new Map(rows.filter((a) => isAllowed(flattenPermissions(a.perms), permission)).map((a) => [a.id, a]));
  return unique.map((id) => allowed.get(id)).filter((a): a is AgentRow => Boolean(a));
}

/** Reject administrator ids that are unknown or inactive (watchers, default assignees, the round-robin pool). */
export async function assertActiveAdmins(db: Db, ids: readonly (string | null | undefined)[], field: string): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return;
  const found = await db.many<{ id: string }>(sql`SELECT id FROM admins WHERE id IN ${sql.in(wanted)} AND status = 'active'`);
  const missing = wanted.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw validationError([{ path: [field], message: `Unknown or inactive administrator: ${missing.join(', ')}` }]);
}

/**
 * Next agent from the round-robin pool: whoever was auto-assigned least
 * recently (never-assigned agents first, in pool order). Agents who were
 * deactivated or lost ticket permissions are skipped. Serialized with an
 * advisory lock so concurrent tickets go to different agents.
 */
export async function nextRoundRobinAgent(db: Db, app: App, pool: readonly string[]): Promise<string | null> {
  if (!pool.length) return null;
  await db.query(sql`SELECT pg_advisory_xact_lock(${ROTATION_LOCK})`);
  const eligible = await agentsWith(db, pool, 'support.tickets.manage');
  if (!eligible.length) return null;
  const last = new Map(
    (await db.many<{ admin_id: string; last_assigned_at: Date }>(sql`
      SELECT admin_id, last_assigned_at FROM ticket_assignment_rotation WHERE admin_id IN ${sql.in(eligible.map((a) => a.id))}
    `)).map((r) => [r.admin_id, r.last_assigned_at.getTime()]),
  );
  const order = (id: string) => last.get(id) ?? Number.NEGATIVE_INFINITY;
  const pick = [...eligible].sort((a, b) => {
    const diff = order(a.id) - order(b.id);
    return Number.isNaN(diff) || diff === 0 ? pool.indexOf(a.id) - pool.indexOf(b.id) : diff;
  })[0];
  await db.exec(sql`
    INSERT INTO ticket_assignment_rotation (admin_id, last_assigned_at) VALUES (${pick.id}, ${app.clock.now()})
    ON CONFLICT (admin_id) DO UPDATE SET last_assigned_at = EXCLUDED.last_assigned_at
  `);
  return pick.id;
}

export interface AgentNotification {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'critical';
  data?: Record<string, unknown>;
}

/**
 * In-app notifications for particular agents (assignee, watchers). Recipients
 * who were deactivated or can no longer see tickets are skipped, and the agent
 * who caused the change is not notified about it.
 */
export async function notifyAgents(db: Db, app: App, recipients: readonly (string | null | undefined)[], n: AgentNotification, opts: { exclude?: string | null } = {}): Promise<number> {
  const ids = recipients.filter((id): id is string => Boolean(id) && id !== opts.exclude);
  const agents = await agentsWith(db, ids, 'support.tickets.view');
  const now = app.clock.now();
  for (const a of agents) {
    await db.exec(sql.insert('notifications', {
      id: newId('ntf'),
      recipient_type: 'admin',
      recipient_id: a.id,
      type: n.type,
      title: n.title.slice(0, 300),
      body: n.body ?? null,
      link: n.link ?? null,
      severity: n.severity ?? 'info',
      data: n.data ?? {},
      created_at: now,
    }, ''));
  }
  return agents.length;
}
