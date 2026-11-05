/**
 * The server returns the admin's expanded permission keys in /auth/me, so the
 * app only needs an exact lookup. The backend enforces every permission again;
 * hiding actions here is purely for a cleaner UI.
 */
export function can(permissions: readonly string[] | null | undefined, key: string): boolean {
  return Boolean(permissions?.includes(key));
}

export function canAny(permissions: readonly string[] | null | undefined, keys: readonly string[]): boolean {
  return keys.some((k) => can(permissions, k));
}

export const PERMISSIONS = {
  dashboard: 'reports.dashboard.view',
  usersView: 'customers.users.view',
  usersSuspend: 'customers.users.suspend',
  usersBan: 'customers.users.ban',
  sessionsRevoke: 'customers.sessions.revoke',
  subscriptionsView: 'billing.subscriptions.view',
  subscriptionsManage: 'billing.subscriptions.manage',
  paymentsView: 'billing.payments.view',
  refundsCreate: 'billing.refunds.create',
  securityView: 'security.events.view',
  securityManage: 'security.events.manage',
  auditView: 'security.audit.view',
} as const;
