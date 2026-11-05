import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';

export interface SecurityEventInput {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  subjectType?: 'admin' | 'user' | 'ip' | 'api_key' | null;
  subjectId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Record a security event; warnings and critical events also emit `security.alert`, which notifies administrators. */
export async function raiseSecurityEvent(db: Db, app: App, e: SecurityEventInput): Promise<string> {
  const id = newId('sev');
  await db.exec(sql.insert('security_events', {
    id,
    type: e.type,
    severity: e.severity,
    subject_type: e.subjectType ?? null,
    subject_id: e.subjectId ?? null,
    ip: e.ip ?? null,
    details: e.details ?? {},
    status: 'open',
    created_at: app.clock.now(),
  }, ''));
  if (e.severity !== 'info') {
    await app.events.emit(db, 'security.alert', { securityEventId: id, type: e.type, severity: e.severity, subjectType: e.subjectType ?? null, subjectId: e.subjectId ?? null });
  }
  return id;
}
