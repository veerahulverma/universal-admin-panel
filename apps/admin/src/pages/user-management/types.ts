// Shapes returned by the customers and security modules for user management screens.

export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export interface ImportMapping {
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  locale?: string;
  timezone?: string;
  country?: string;
  tags?: string;
  externalId?: string;
  marketingConsent?: string;
  customFields: Record<string, string>;
}

export interface UserImport {
  id: string;
  filename: string;
  status: 'uploaded' | 'validated' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  delimiter: string;
  headers: string[];
  rowCount: number;
  mapping: ImportMapping | null;
  summary: ImportSummary | null;
  errors: { row: number; email: string | null; message: string }[];
  progress: ImportSummary & { processed: number };
  error: string | null;
  createdByLabel: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface UploadedImport extends UserImport {
  sample: string[][];
  suggestedMapping: Partial<ImportMapping>;
  customFields: { key: string; label: string; type: string; required: boolean }[];
}

export interface MergeEntry {
  table: string;
  column: string;
  module: string | null;
  rows: number;
  conflicts: number;
  resolution: 'move' | 'combine' | 'keep_target' | 'custom' | 'keep_source';
}

export interface MergePreview {
  target: { id: string; email: string; name: string | null; createdAt: string };
  source: { id: string; email: string; name: string | null; createdAt: string };
  entries: MergeEntry[];
  filled: string[];
  excluded: { table: string; reason: string }[];
}

export interface AgreementVersion {
  agreementId: string;
  key: string;
  versionId: string;
  version: number;
  title: string;
  summary: string | null;
  effectiveAt: string;
  body?: string;
}

export interface Agreement {
  id: string;
  key: string;
  title: string;
  description: string;
  required: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  current: AgreementVersion | null;
  upcoming: AgreementVersion | null;
  versions: number;
  acceptances: number;
}

export interface AgreementDetail extends Agreement {
  versionList: (AgreementVersion & { acceptances: number; createdAt: string; body: string })[];
}

export interface Acceptance {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  version_id: string;
  version: number;
  accepted_at: string;
  ip: string | null;
  user_agent: string | null;
  source: 'signup' | 'client' | 'api';
}

export interface UserAgreements {
  accepted: { id: string; agreementId: string; key: string; agreementTitle: string; versionId: string; version: number; title: string; acceptedAt: string; ip: string | null; userAgent: string | null; source: string; current: boolean }[];
  pending: AgreementVersion[];
}

export interface FormField {
  type: 'profile' | 'custom';
  key: string;
  required: boolean;
  label?: string;
  helpText?: string;
}

export interface SignupForm {
  id: string;
  key: string;
  name: string;
  description: string;
  active: boolean;
  fields: FormField[];
  agreementId: string | null;
  planIds: string[];
  redirectUrl: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  signups?: number;
  agreementTitle?: string | null;
}

export interface SignupFormOptions {
  profileFields: { key: string; label: string; input: string }[];
  customFields: { key: string; label: string; type: string; required: boolean }[];
  agreements: { id: string; key: string; title: string; required: boolean }[];
  plans: { id: string; key: string; name: string; status: string; public: boolean }[];
}

export interface SharingAddress {
  ip: string;
  network: string;
  firstSeenAt: string;
  lastSeenAt: string;
  hits: number;
  sources: string[];
}

export interface SharingFlag {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  status: 'open' | 'cleared';
  distinctCount: number;
  maxAllowed: number;
  windowHours: number;
  countBy: 'address' | 'network';
  addresses: SharingAddress[];
  action: 'alert' | 'revoke_sessions' | 'block_logins';
  blockedUntil: string | null;
  securityEventId: string | null;
  clearedBy: string | null;
  clearedAt: string | null;
  clearNote: string | null;
  createdAt: string;
}

export interface SharingPolicy {
  enabled: boolean;
  maxAddresses: number;
  windowHours: number;
  countBy: 'address' | 'network';
  action: 'alert' | 'revoke_sessions' | 'block_logins';
  cooldownMinutes: number;
  trustedNetworks: string[];
}

export interface UserIpAddresses {
  addresses: (SharingAddress & { lastSource: string; userAgent: string | null; country: string | null; trusted: boolean })[];
  window: { hours: number; distinct: number; limit: number; countBy: 'address' | 'network'; enabled: boolean };
  flags: SharingFlag[];
  blockedUntil: string | null;
  caveat: string;
}

export const SOURCE_LABELS: Record<string, string> = {
  identity_login: 'Sign-in',
  identity_register: 'Registration',
  session_verify: 'Session check',
  social_login: 'Social sign-in',
  app_login: 'Sign-in (your app)',
  client_api: 'Client API',
  signup: 'Signup',
  client: 'Customer app',
  api: 'Your backend',
};

export const SHARING_ACTIONS: Record<SharingFlag['action'], string> = {
  alert: 'Alert only',
  revoke_sessions: 'Signed out',
  block_logins: 'Signed out, sign-ins paused',
};

/** "user_sessions" -> "User sessions". */
export function humanizeTable(table: string): string {
  const s = table.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
