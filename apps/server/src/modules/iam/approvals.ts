import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { DAY } from '../../core/clock.js';
import { notifyAdmins } from './notify.js';

export interface ApprovalExecutor {
  /** Permission an approver must hold (the requester can never approve their own request). */
  approvePermission: string;
  execute(tx: Db, app: App, payload: Record<string, any>, approver: Actor): Promise<Record<string, unknown> | void>;
}

function executors(app: App): Map<string, ApprovalExecutor> {
  let map = app.services['iam.approvalExecutors'] as Map<string, ApprovalExecutor> | undefined;
  if (!map) {
    map = new Map();
    app.services['iam.approvalExecutors'] = map;
  }
  return map;
}

export function registerApprovalExecutor(app: App, action: string, executor: ApprovalExecutor): void {
  executors(app).set(action, executor);
}

export function approvalExecutor(app: App, action: string): ApprovalExecutor | undefined {
  return executors(app).get(action);
}

/**
 * Separation of duties: park a critical action (large refund, affiliate payout)
 * until a different admin with the approve permission signs off.
 */
export async function requestApproval(
  db: Db,
  app: App,
  input: {
    action: string;
    requestedBy: string;
    summary: string;
    payload: Record<string, unknown>;
    targetType?: string;
    targetId?: string;
    amount?: number;
    currency?: string;
    reason?: string;
  },
): Promise<{ id: string }> {
  const executor = approvalExecutor(app, input.action);
  if (!executor) throw new Error(`No approval executor registered for "${input.action}"`);
  const id = newId('apv');
  const now = app.clock.now();
  await db.exec(sql.insert('approval_requests', {
    id,
    action: input.action,
    approve_permission: executor.approvePermission,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    summary: input.summary,
    payload: input.payload,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    status: 'pending',
    requested_by: input.requestedBy,
    reason: input.reason ?? null,
    created_at: now,
    expires_at: new Date(now.getTime() + 7 * DAY),
  }, ''));
  await app.events.emit(db, 'approval.requested', { approvalId: id, action: input.action, summary: input.summary });
  await notifyAdmins(db, app, {
    permission: executor.approvePermission,
    type: 'approval.requested',
    title: 'Approval needed',
    body: input.summary,
    link: '/admin/approvals',
    severity: 'warning',
    excludeAdminId: input.requestedBy,
  });
  return { id };
}
