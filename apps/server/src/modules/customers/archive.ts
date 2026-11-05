import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { writeAudit } from '../../core/audit.js';
import { DAY } from '../../core/clock.js';
import { SYSTEM_ACTOR } from '../../core/types.js';
import { getUser, type UserRow } from './service.js';

export interface ArchiveSettings {
  archiveInactive: boolean;
  archiveAfterDays: number;
}

const BATCH = 500;
const MAX_BATCHES_PER_RUN = 20;

/**
 * Archiving hides a customer from the default directory views without
 * changing what they may do: an archived customer can still sign in, and
 * signing in restores them.
 */
export async function archiveUser(db: Db, app: App, id: string, reason: string, actor: Actor, scope: string[] | null): Promise<UserRow> {
  const user = await getUser(db, id, scope, { lock: true });
  if (user.archived_at) return user;
  const now = app.clock.now();
  await db.exec(sql`UPDATE users SET archived_at = ${now}, archived_reason = ${reason}, updated_at = ${now} WHERE id = ${id}`);
  await writeAudit(db, app, { actor, action: 'user.archive', targetType: 'user', targetId: id, metadata: { reason } });
  await app.events.emit(db, 'user.archived', { userId: id, reason }, { userId: id });
  return getUser(db, id, null);
}

export async function unarchiveUser(db: Db, app: App, id: string, reason: string, actor: Actor, scope: string[] | null): Promise<UserRow> {
  const user = await getUser(db, id, scope, { lock: true });
  if (!user.archived_at) return user;
  await restore(db, app, id, reason, actor);
  return getUser(db, id, null);
}

/** Called wherever a customer signs in (built-in identity, social sign-in, logins reported by your app). */
export async function restoreIfArchived(db: Db, app: App, userId: string, via: string): Promise<boolean> {
  const row = await db.maybe<{ archived_at: Date | null }>(sql`SELECT archived_at FROM users WHERE id = ${userId} FOR UPDATE`);
  if (!row?.archived_at) return false;
  await restore(db, app, userId, via, { type: 'user', id: userId });
  return true;
}

async function restore(db: Db, app: App, id: string, reason: string, actor: Actor): Promise<void> {
  await db.exec(sql`UPDATE users SET archived_at = NULL, archived_reason = NULL, updated_at = ${app.clock.now()} WHERE id = ${id}`);
  await writeAudit(db, app, { actor, action: 'user.unarchive', targetType: 'user', targetId: id, metadata: { reason } });
  await app.events.emit(db, 'user.unarchived', { userId: id, reason }, { userId: id });
}

async function tableExists(db: Db, table: string): Promise<boolean> {
  const row = await db.one<{ found: boolean }>(sql`SELECT to_regclass(${table}) IS NOT NULL AS found`);
  return row.found;
}

/**
 * A customer still holding anything that grants access, directly or through an
 * organization they belong to, is never archived. Subscriptions count unless
 * cancelled (trials, unpaid and paused ones included) so a customer in dunning
 * is not hidden from the team chasing payment.
 */
async function accessConditions(db: Db, now: Date): Promise<Sql[]> {
  const subjects = sql`
    ((x.subject_type = 'user' AND x.subject_id = u.id)
      OR (x.subject_type = 'organization' AND x.subject_id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = u.id AND m.status = 'active')))
  `;
  const out: Sql[] = [];
  if (await tableExists(db, 'subscriptions')) {
    out.push(sql`NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.status <> 'canceled' AND ${subjects})`);
  }
  if (await tableExists(db, 'entitlement_grants')) {
    out.push(sql`NOT EXISTS (SELECT 1 FROM entitlement_grants x WHERE x.revoked_at IS NULL AND x.starts_at <= ${now} AND (x.ends_at IS NULL OR x.ends_at > ${now}) AND ${subjects})`);
  }
  return out;
}

/** Customers eligible for archiving: inactive for `days` and holding no subscription or grant. */
export async function inactiveCandidates(db: Db, app: App, days: number, limit = BATCH): Promise<string[]> {
  const now = app.clock.now();
  const cutoff = new Date(now.getTime() - days * DAY);
  const rows = await db.many<{ id: string }>(sql`
    SELECT u.id FROM users u
    ${sql.where([
      sql`u.deleted_at IS NULL`,
      sql`u.archived_at IS NULL`,
      sql`greatest(u.created_at, u.last_active_at, u.last_login_at) < ${cutoff}`,
      ...(await accessConditions(db, now)),
    ])}
    ORDER BY u.id LIMIT ${limit}
  `);
  return rows.map((r) => r.id);
}

/** Scheduled job: archive customers who have been inactive longer than the configured number of days. */
export async function archiveInactiveUsers(app: App): Promise<number> {
  const s = app.settings.get<ArchiveSettings>('customers');
  if (!s.archiveInactive) return 0;
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    const archived = await app.db.tx(async (tx) => {
      const ids = await inactiveCandidates(tx, app, s.archiveAfterDays);
      if (!ids.length) return [];
      const now = app.clock.now();
      const rows = await tx.many<{ id: string }>(sql`
        UPDATE users SET archived_at = ${now}, archived_reason = 'inactive', updated_at = ${now}
        WHERE id IN ${sql.in(ids)} AND archived_at IS NULL RETURNING id
      `);
      for (const r of rows) await app.events.emit(tx, 'user.archived', { userId: r.id, reason: 'inactive', inactiveDays: s.archiveAfterDays }, { userId: r.id });
      if (rows.length) {
        await writeAudit(tx, app, {
          actor: SYSTEM_ACTOR,
          action: 'user.archive_inactive',
          metadata: { count: rows.length, inactiveDays: s.archiveAfterDays, userIds: rows.slice(0, 100).map((r) => r.id) },
        });
      }
      return rows;
    });
    total += archived.length;
    if (archived.length < BATCH) break;
  }
  return total;
}
