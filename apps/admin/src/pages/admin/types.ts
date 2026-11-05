export interface RoleRef {
  id: string;
  key: string;
  name: string;
}

export interface AdminRow {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  totp_enabled: boolean;
  org_scope: string[] | null;
  allowed_ips: string[];
  last_login_at: string | null;
  last_login_ip: string | null;
  locked_until: string | null;
  created_at: string;
  roles: RoleRef[];
  active_sessions: number;
}

export interface AdminSessionRow {
  id: string;
  client: 'web' | 'mobile';
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface AdminDetail extends Omit<AdminRow, 'active_sessions'> {
  password_changed_at: string | null;
  /** Concrete permission keys the administrator's roles allow. */
  permissions: string[];
  sessions: AdminSessionRow[];
  activity: { id: string; action: string; target_type: string | null; target_id: string | null; ip: string | null; created_at: string }[];
}

export interface Invitation {
  id: string;
  email: string;
  role_ids: string[];
  org_scope: string[] | null;
  expires_at: string;
  created_at: string;
  invited_by_name: string | null;
}

export interface InviteResult {
  id: string;
  email: string;
  expiresAt: string;
  emailed: boolean;
  inviteLink: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  limits: Record<string, number>;
  is_system: boolean;
  created_at: string;
  updated_at: string;
  admin_count: number;
}

export interface PermissionDef {
  key: string;
  label: string;
  description?: string;
  module: string;
  dangerous?: boolean;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface Approval {
  id: string;
  action: string;
  approve_permission: string;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
  amount: number | null;
  currency: string | null;
  status: ApprovalStatus;
  requested_by: string;
  requested_by_name: string;
  reason: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  expires_at: string;
  canDecide: boolean;
}

export interface SecurityEvent {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  subject_type: 'admin' | 'user' | 'ip' | 'api_key' | null;
  subject_id: string | null;
  ip: string | null;
  details: Record<string, unknown>;
  status: 'open' | 'acknowledged' | 'resolved';
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface LoginEvent {
  id: string;
  subject_type: 'admin' | 'user';
  subject_id: string | null;
  email: string | null;
  success: boolean;
  failure_reason: string | null;
  method: string;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  created_at: string;
}

export interface IpRule {
  id: string;
  cidr: string;
  action: 'block' | 'allow';
  scope: 'all' | 'admin' | 'api' | 'auth';
  reason: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface TeamSession extends AdminSessionRow {
  admin_id: string;
  admin_name: string;
  admin_email: string;
  mfa_verified: boolean;
  current: boolean;
}

export interface SecurityOverview {
  failedLogins24h: number;
  openEvents: Partial<Record<'info' | 'warning' | 'critical', number>>;
  /** Platform-wide figures: null for organization-scoped administrators. */
  blockedIps: number | null;
  lockedAdmins: number | null;
}

export interface AuditEntry {
  seq: number;
  id: string;
  actor_type: 'admin' | 'system' | 'api_key' | 'user' | 'plugin';
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  org_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}
