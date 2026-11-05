import { sql } from './sql.js';
import type { Db } from './db.js';
import type { Actor, App } from './types.js';
import { newId } from './ids.js';
import { sha256 } from './crypto.js';
import { stableStringify } from './json.js';

export interface AuditEntry {
  actor: Actor;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  orgId?: string | null;
  metadata?: Record<string, unknown>;
}

const AUDIT_LOCK = 72_710_001;

function entryHash(prevHash: string, row: Record<string, unknown>): string {
  return sha256(prevHash + stableStringify(row));
}

/**
 * Append to the audit log. Entries form a hash chain (each hash covers the
 * previous hash), so deleting or editing a row is detectable by
 * `verifyAuditChain`. Writes are serialized with a transaction-scoped advisory
 * lock and commit atomically with the change they describe.
 */
export async function writeAudit(db: Db, app: Pick<App, 'clock'>, entry: AuditEntry): Promise<void> {
  const write = async (tx: Db) => {
    await tx.query(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`);
    const prev = await tx.maybe<{ hash: string }>(sql`SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1`);
    const row = {
      id: newId('aud'),
      actor_type: entry.actor.type,
      actor_id: entry.actor.id ?? null,
      actor_label: entry.actor.label ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      org_id: entry.orgId ?? null,
      ip: entry.actor.ip ?? null,
      user_agent: entry.actor.userAgent?.slice(0, 500) ?? null,
      metadata: entry.metadata ?? {},
      created_at: app.clock.now(),
    };
    const prevHash = prev?.hash ?? 'genesis';
    await tx.exec(sql.insert('audit_logs', { ...row, prev_hash: prevHash, hash: entryHash(prevHash, row) }, ''));
  };
  if (db.inTransaction) await write(db);
  else await db.tx(write);
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * Walk the chain and recompute every hash. Retention legitimately removes the
 * oldest rows, so the chain is anchored at the oldest retained entry; any
 * removal or edit after that point is detected.
 */
export async function verifyAuditChain(db: Db, batchSize = 2000): Promise<ChainVerification> {
  let prevHash: string | null = null;
  let lastSeq = 0;
  let checked = 0;
  for (;;) {
    const rows = await db.many<Record<string, any>>(
      sql`SELECT * FROM audit_logs WHERE seq > ${lastSeq} ORDER BY seq ASC LIMIT ${batchSize}`,
    );
    if (!rows.length) return { ok: true, checked };
    for (const r of rows) {
      const { seq, prev_hash, hash, ...rest } = r;
      if (prevHash === null) prevHash = prev_hash as string;
      if (prev_hash !== prevHash) return { ok: false, checked, brokenAtSeq: seq, reason: 'previous hash mismatch (row removed or reordered)' };
      if (entryHash(prev_hash, rest) !== hash) return { ok: false, checked, brokenAtSeq: seq, reason: 'content hash mismatch (row modified)' };
      prevHash = hash;
      lastSeq = seq;
      checked++;
    }
  }
}
