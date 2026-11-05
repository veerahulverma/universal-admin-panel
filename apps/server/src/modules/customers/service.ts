import { z } from 'zod';
import type { App, Actor } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql, type Sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { diff } from '../../core/json.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import { MINUTE } from '../../core/clock.js';

export interface UserRow {
  id: string;
  external_id: string | null;
  email: string;
  email_verified_at: Date | null;
  name: string | null;
  phone: string | null;
  avatar_url: string | null;
  status: 'active' | 'suspended' | 'banned' | 'pending';
  status_reason: string | null;
  suspended_until: Date | null;
  locale: string | null;
  timezone: string | null;
  country: string | null;
  registration_source: string | null;
  utm: Record<string, string>;
  referral_code: string | null;
  custom_fields: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  marketing_consent: boolean;
  lifetime_revenue: number;
  last_active_at: Date | null;
  last_login_at: Date | null;
  last_login_ip: string | null;
  deleted_at: Date | null;
  anonymized_at: Date | null;
  archived_at: Date | null;
  archived_reason: string | null;
  merged_into_id: string | null;
  merged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Columns safe to return from APIs (never password hashes or lockout internals). */
export const USER_COLUMNS = sql`${sql.raw(
  [
    'id', 'external_id', 'email', 'email_verified_at', 'name', 'phone', 'avatar_url', 'status', 'status_reason', 'suspended_until',
    'locale', 'timezone', 'country', 'registration_source', 'utm', 'referral_code', 'custom_fields', 'tags', 'metadata',
    'marketing_consent', 'lifetime_revenue', 'last_active_at', 'last_login_at', 'last_login_ip', 'deleted_at', 'anonymized_at',
    'archived_at', 'archived_reason', 'merged_into_id', 'merged_at', 'created_at', 'updated_at',
  ].map((c) => `u.${c}`).join(', '),
)}`;

/**
 * Tenant isolation: when the caller is limited to some organizations (an
 * org-scoped admin or API key), a user is visible only through a membership in
 * one of those organizations.
 */
export function userScopeSql(scope: string[] | null, alias = 'u'): Sql | null {
  if (!scope) return null;
  return sql`EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${sql.raw(alias)}.id AND m.org_id IN ${sql.in(scope)})`;
}

export function orgScopeSql(scope: string[] | null, alias = 'o'): Sql | null {
  if (!scope) return null;
  return sql`${sql.raw(alias)}.id IN ${sql.in(scope)}`;
}

export async function getUser(db: Db, id: string, scope: string[] | null, opts: { includeDeleted?: boolean; lock?: boolean } = {}): Promise<UserRow> {
  const row = await db.maybe<UserRow>(sql`
    SELECT ${USER_COLUMNS} FROM users u
    ${sql.where([sql`u.id = ${id}`, !opts.includeDeleted && sql`u.deleted_at IS NULL`, userScopeSql(scope)])}
    ${opts.lock ? sql`FOR UPDATE` : sql.empty}
  `);
  if (!row) throw notFound('User');
  return row;
}

export async function findUserByExternalId(db: Db, externalId: string, scope: string[] | null): Promise<UserRow | null> {
  return db.maybe<UserRow>(sql`
    SELECT ${USER_COLUMNS} FROM users u
    ${sql.where([sql`u.external_id = ${externalId}`, sql`u.deleted_at IS NULL`, userScopeSql(scope)])}
  `);
}

// ---- Custom fields ----------------------------------------------------------

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'date' | 'url';
  options: string[];
  required: boolean;
}

export interface FieldIssue {
  path: string[];
  message: string;
}

export function loadFieldDefs(db: Db, entity: 'user' | 'organization'): Promise<FieldDef[]> {
  return db.many<FieldDef>(sql`SELECT key, label, type, options, required FROM custom_field_defs WHERE entity = ${entity} ORDER BY position, label`);
}

/** Validate values against already-loaded definitions (bulk callers such as imports load them once). */
export function checkCustomFields(
  defs: readonly FieldDef[],
  values: Record<string, unknown>,
  opts: { partial: boolean; path?: string[] },
): { values: Record<string, unknown>; issues: FieldIssue[] } {
  const base = opts.path ?? ['customFields'];
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const issues: FieldIssue[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def) {
      issues.push({ path: [...base, key], message: 'Unknown custom field' });
      continue;
    }
    if (value === null || value === '') {
      out[key] = null;
      continue;
    }
    const validators: Record<FieldDef['type'], z.ZodType> = {
      text: z.string().max(2000),
      number: z.number(),
      boolean: z.boolean(),
      select: z.enum(def.options.length ? (def.options as [string, ...string[]]) : ['']),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      url: z.string().url(),
    };
    const parsed = validators[def.type].safeParse(value);
    if (!parsed.success) issues.push({ path: [...base, key], message: `${def.label}: ${parsed.error.issues[0]?.message}` });
    else out[key] = parsed.data;
  }
  if (!opts.partial) {
    for (const d of defs) if (d.required && (values[d.key] === undefined || values[d.key] === null || values[d.key] === '')) {
      issues.push({ path: [...base, d.key], message: `${d.label} is required` });
    }
  }
  return { values: out, issues };
}

export async function validateCustomFields(
  db: Db,
  entity: 'user' | 'organization',
  values: Record<string, unknown>,
  opts: { partial: boolean },
): Promise<Record<string, unknown>> {
  const checked = checkCustomFields(await loadFieldDefs(db, entity), values, opts);
  if (checked.issues.length) throw validationError(checked.issues);
  return checked.values;
}

// ---- Users ----------------------------------------------------------------

export const userInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  externalId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  avatarUrl: z.string().url().max(1000).optional(),
  locale: z.string().max(10).optional(),
  timezone: z.string().max(64).optional(),
  country: z.string().length(2).transform((s) => s.toUpperCase()).optional(),
  registrationSource: z.string().max(100).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  referralCode: z.string().max(100).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  marketingConsent: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
  status: z.enum(['active', 'pending']).optional(),
});
export type UserInput = z.infer<typeof userInputSchema>;

async function assertEmailFree(db: Db, email: string, exceptId?: string): Promise<void> {
  const clash = await db.maybe(sql`SELECT 1 FROM users WHERE lower(email) = ${email.toLowerCase()} AND deleted_at IS NULL ${exceptId ? sql`AND id <> ${exceptId}` : sql.empty}`);
  if (clash) throw conflict('A user with this email already exists', 'email_taken');
}

export async function createUser(db: Db, app: App, input: UserInput, actor: Actor, opts: { orgId?: string | null; passwordHash?: string } = {}): Promise<UserRow> {
  await assertEmailFree(db, input.email);
  if (input.externalId && (await db.maybe(sql`SELECT 1 FROM users WHERE external_id = ${input.externalId} AND deleted_at IS NULL`))) {
    throw conflict('A user with this external ID already exists', 'external_id_taken');
  }
  const customFields = input.customFields ? await validateCustomFields(db, 'user', input.customFields, { partial: false }) : {};
  const now = app.clock.now();
  const id = newId('usr');
  await db.exec(sql.insert('users', {
    id,
    external_id: input.externalId ?? null,
    email: input.email,
    email_verified_at: input.emailVerified ? now : null,
    name: input.name ?? null,
    phone: input.phone ?? null,
    avatar_url: input.avatarUrl ?? null,
    status: input.status ?? 'active',
    password_hash: opts.passwordHash ?? null,
    locale: input.locale ?? null,
    timezone: input.timezone ?? null,
    country: input.country ?? null,
    registration_source: input.registrationSource ?? null,
    utm: input.utm ?? {},
    referral_code: input.referralCode ?? null,
    custom_fields: customFields,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
    marketing_consent: input.marketingConsent ?? false,
    consent_updated_at: input.marketingConsent !== undefined ? now : null,
    created_at: now,
    updated_at: now,
  }, ''));
  if (opts.orgId) await addMember(db, app, opts.orgId, id, 'member', actor);
  await writeAudit(db, app, { actor, action: 'user.create', targetType: 'user', targetId: id, orgId: opts.orgId ?? null, metadata: { email: input.email } });
  await app.events.emit(db, 'user.created', { userId: id, email: input.email, externalId: input.externalId ?? null, referralCode: input.referralCode ?? null, source: input.registrationSource ?? null }, { userId: id, orgId: opts.orgId ?? null });
  return getUser(db, id, null);
}

export async function updateUser(db: Db, app: App, id: string, input: Partial<UserInput>, actor: Actor, scope: string[] | null): Promise<UserRow> {
  const before = await getUser(db, id, scope, { lock: true });
  if (input.email && input.email !== before.email) await assertEmailFree(db, input.email, id);
  if (input.externalId && input.externalId !== before.external_id) {
    const clash = await db.maybe(sql`SELECT 1 FROM users WHERE external_id = ${input.externalId} AND deleted_at IS NULL AND id <> ${id}`);
    if (clash) throw conflict('A user with this external ID already exists', 'external_id_taken');
  }
  const customFields = input.customFields
    ? { ...before.custom_fields, ...(await validateCustomFields(db, 'user', input.customFields, { partial: true })) }
    : undefined;
  const now = app.clock.now();
  const patch: Record<string, unknown> = {
    email: input.email,
    external_id: input.externalId,
    name: input.name,
    phone: input.phone,
    avatar_url: input.avatarUrl,
    locale: input.locale,
    timezone: input.timezone,
    country: input.country,
    custom_fields: customFields,
    tags: input.tags,
    metadata: input.metadata ? { ...before.metadata, ...input.metadata } : undefined,
    marketing_consent: input.marketingConsent,
    consent_updated_at: input.marketingConsent !== undefined && input.marketingConsent !== before.marketing_consent ? now : undefined,
    email_verified_at: input.email && input.email !== before.email ? null : undefined,
  };
  const changes = diff(before as unknown as Record<string, unknown>, patch);
  if (!Object.keys(changes).length) return before;
  await db.exec(sql`UPDATE users SET ${sql.set({ ...patch, updated_at: now })} WHERE id = ${id}`);
  await writeAudit(db, app, { actor, action: 'user.update', targetType: 'user', targetId: id, metadata: { changes } });
  await app.events.emit(db, 'user.updated', { userId: id, changes: Object.keys(changes) }, { userId: id });
  return getUser(db, id, null);
}

/** Insert or update a user keyed by externalId (preferred) or email. Used by the integration API and SDK sync. */
export async function upsertUser(db: Db, app: App, input: UserInput, actor: Actor, scope: string[] | null): Promise<{ user: UserRow; created: boolean }> {
  const existing = input.externalId
    ? await db.maybe<{ id: string }>(sql`SELECT id FROM users WHERE external_id = ${input.externalId} AND deleted_at IS NULL FOR UPDATE`)
    : await db.maybe<{ id: string }>(sql`SELECT id FROM users WHERE lower(email) = ${input.email} AND deleted_at IS NULL FOR UPDATE`);
  if (existing) {
    // Org-scoped callers may only update users inside their organization.
    await getUser(db, existing.id, scope);
    const { status: _ignored, ...rest } = input;
    return { user: await updateUser(db, app, existing.id, rest, actor, scope), created: false };
  }
  return { user: await createUser(db, app, input, actor, { orgId: scope?.[0] ?? null }), created: true };
}

export type StatusAction = 'suspend' | 'ban' | 'reactivate';

export async function setUserStatus(
  db: Db,
  app: App,
  id: string,
  action: StatusAction,
  input: { reason?: string | null; until?: Date | null },
  actor: Actor,
  scope: string[] | null,
): Promise<UserRow> {
  const user = await getUser(db, id, scope, { lock: true });
  const now = app.clock.now();
  const status = action === 'suspend' ? 'suspended' : action === 'ban' ? 'banned' : 'active';
  if (user.status === status && action !== 'suspend') return user;
  await db.exec(sql`
    UPDATE users SET status = ${status}, status_reason = ${action === 'reactivate' ? null : input.reason ?? null},
      suspended_until = ${action === 'suspend' ? input.until ?? null : null}, updated_at = ${now}
    WHERE id = ${id}
  `);
  if (action !== 'reactivate') await revokeUserSessions(db, app, id, action === 'ban' ? 'banned' : 'suspended', actor, { audit: false });
  await writeAudit(db, app, { actor, action: `user.${action}`, targetType: 'user', targetId: id, metadata: { reason: input.reason ?? null, until: input.until ?? null, previous: user.status } });
  const eventType = action === 'suspend' ? 'user.suspended' : action === 'ban' ? 'user.banned' : 'user.reactivated';
  await app.events.emit(db, eventType, { userId: id, reason: input.reason ?? null, until: input.until ?? null }, { userId: id });
  return getUser(db, id, null);
}

export async function revokeUserSessions(db: Db, app: App, userId: string, reason: string, actor: Actor, opts: { audit?: boolean } = {}): Promise<number> {
  const n = await db.exec(sql`
    UPDATE user_sessions SET revoked_at = ${app.clock.now()}, revoked_reason = ${reason} WHERE user_id = ${userId} AND revoked_at IS NULL
  `);
  if (opts.audit !== false) await writeAudit(db, app, { actor, action: 'user.sessions_revoke', targetType: 'user', targetId: userId, metadata: { reason, count: n } });
  // External-auth apps must drop their own sessions too; the webhook/SDK tells them to.
  await app.events.emit(db, 'user.sessions_revoked', { userId, reason }, { userId });
  return n;
}

export async function softDeleteUser(db: Db, app: App, id: string, actor: Actor, scope: string[] | null): Promise<void> {
  await getUser(db, id, scope, { lock: true });
  await db.exec(sql`UPDATE users SET deleted_at = ${app.clock.now()}, updated_at = ${app.clock.now()} WHERE id = ${id}`);
  await revokeUserSessions(db, app, id, 'deleted', actor, { audit: false });
  await writeAudit(db, app, { actor, action: 'user.delete', targetType: 'user', targetId: id });
  await app.events.emit(db, 'user.deleted', { userId: id }, { userId: id });
}

export async function restoreUser(db: Db, app: App, id: string, actor: Actor, scope: string[] | null): Promise<UserRow> {
  const user = await getUser(db, id, scope, { includeDeleted: true, lock: true });
  if (!user.deleted_at) return user;
  if (user.anonymized_at) throw conflict('Anonymized users cannot be restored', 'user_anonymized');
  if (user.merged_into_id) throw conflict('This account was merged into another account; its records now belong to that account', 'user_merged', { mergedInto: user.merged_into_id });
  await assertEmailFree(db, user.email, id);
  await db.exec(sql`UPDATE users SET deleted_at = NULL, updated_at = ${app.clock.now()} WHERE id = ${id}`);
  await writeAudit(db, app, { actor, action: 'user.restore', targetType: 'user', targetId: id });
  await app.events.emit(db, 'user.restored', { userId: id }, { userId: id });
  return getUser(db, id, null);
}

/**
 * Right to erasure. Personal data is removed from the user record and from every
 * module (through the `privacy.anonymize` hook). Financial records such as
 * invoices are retained where law requires, but detached from personal fields.
 */
export async function anonymizeUser(db: Db, app: App, id: string, actor: Actor, scope: string[] | null): Promise<void> {
  const user = await getUser(db, id, scope, { includeDeleted: true, lock: true });
  if (user.anonymized_at) return;
  const now = app.clock.now();
  await db.exec(sql`
    UPDATE users SET email = ${`deleted+${id}@anonymized.invalid`}, name = NULL, phone = NULL, avatar_url = NULL, external_id = NULL,
      password_hash = NULL, custom_fields = '{}', metadata = '{}', utm = '{}', tags = '[]', last_login_ip = NULL,
      marketing_consent = FALSE, status = 'banned', status_reason = 'anonymized', deleted_at = coalesce(deleted_at, ${now}),
      anonymized_at = ${now}, updated_at = ${now}
    WHERE id = ${id}
  `);
  await db.exec(sql`DELETE FROM user_notes WHERE user_id = ${id}`);
  await db.exec(sql`UPDATE user_sessions SET ip = NULL, user_agent = NULL, revoked_at = coalesce(revoked_at, ${now}) WHERE user_id = ${id}`);
  await db.exec(sql`UPDATE login_events SET email = NULL, ip = NULL, user_agent = NULL WHERE subject_type = 'user' AND subject_id = ${id}`);
  // Acceptance records stay as evidence of what was agreed, without the network details.
  await db.exec(sql`UPDATE agreement_acceptances SET ip = NULL, user_agent = NULL WHERE user_id = ${id}`);
  await db.exec(sql`DELETE FROM memberships WHERE user_id = ${id}`);
  await app.hooks.apply('privacy.anonymize', null, { db, userId: id, app });
  await writeAudit(db, app, { actor, action: 'user.anonymize', targetType: 'user', targetId: id });
  await app.events.emit(db, 'user.anonymized', { userId: id }, { userId: id });
}

/** Everything the platform knows about a user, for data-portability requests. */
export async function exportUserData(db: Db, app: App, id: string, scope: string[] | null): Promise<Record<string, unknown>> {
  const user = await getUser(db, id, scope, { includeDeleted: true });
  const [memberships, notes, sessions, logins, agreements] = await Promise.all([
    db.many(sql`SELECT m.org_id, o.name AS org_name, m.role, m.status, m.created_at FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ${id}`),
    db.many(sql`SELECT body, created_at FROM user_notes WHERE user_id = ${id}`),
    db.many(sql`SELECT ip, user_agent, created_at, last_seen_at, revoked_at FROM user_sessions WHERE user_id = ${id}`),
    db.many(sql`SELECT success, ip, user_agent, country, created_at FROM login_events WHERE subject_type = 'user' AND subject_id = ${id}`),
    db.many(sql`
      SELECT a.key AS agreement, v.version, v.title, aa.accepted_at, aa.ip, aa.source
      FROM agreement_acceptances aa JOIN agreements a ON a.id = aa.agreement_id JOIN agreement_versions v ON v.id = aa.version_id
      WHERE aa.user_id = ${id} ORDER BY aa.accepted_at
    `),
  ]);
  const base: Record<string, unknown> = {
    exportedAt: app.clock.now(),
    profile: user,
    organizations: memberships,
    notes,
    sessions,
    loginHistory: logins,
    agreements,
  };
  return app.hooks.apply('privacy.export', base, { db, userId: id, app });
}

// ---- Organizations -----------------------------------------------------------

export async function getOrganization(db: Db, id: string, scope: string[] | null, opts: { lock?: boolean } = {}): Promise<any> {
  const row = await db.maybe(sql`
    SELECT o.* FROM organizations o ${sql.where([sql`o.id = ${id}`, sql`o.deleted_at IS NULL`, orgScopeSql(scope)])}
    ${opts.lock ? sql`FOR UPDATE` : sql.empty}
  `);
  if (!row) throw notFound('Organization');
  return row;
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'org';
}

export async function uniqueSlug(db: Db, base: string): Promise<string> {
  let slug = base;
  for (let i = 2; await db.maybe(sql`SELECT 1 FROM organizations WHERE slug = ${slug} AND deleted_at IS NULL`); i++) slug = `${base}-${i}`;
  return slug;
}

export async function addMember(db: Db, app: App, orgId: string, userId: string, role: string, actor: Actor, status: 'active' | 'invited' | 'pending_approval' = 'active'): Promise<void> {
  const org = await db.one<{ seat_limit: number | null }>(sql`SELECT seat_limit FROM organizations WHERE id = ${orgId} FOR UPDATE`);
  if (org.seat_limit !== null) {
    const used = await db.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM memberships WHERE org_id = ${orgId} AND status = 'active' AND user_id <> ${userId}`);
    if (status === 'active' && used.count >= org.seat_limit) throw conflict(`This organization has used all ${org.seat_limit} seats`, 'seat_limit_reached');
  }
  const now = app.clock.now();
  await db.exec(sql`
    INSERT INTO memberships (id, org_id, user_id, role, status, invited_by, created_at, updated_at)
    VALUES (${newId('mem')}, ${orgId}, ${userId}, ${role}, ${status}, ${actor.id}, ${now}, ${now})
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
  `);
  await writeAudit(db, app, { actor, action: 'organization.member_add', targetType: 'organization', targetId: orgId, orgId, metadata: { userId, role, status } });
  await app.events.emit(db, 'organization.member_added', { orgId, userId, role, status }, { userId, orgId });
}

export async function removeMember(db: Db, app: App, orgId: string, userId: string, actor: Actor): Promise<void> {
  const org = await db.one<{ owner_user_id: string | null }>(sql`SELECT owner_user_id FROM organizations WHERE id = ${orgId}`);
  if (org.owner_user_id === userId) throw conflict('Transfer ownership before removing the owner', 'owner_cannot_leave');
  const n = await db.exec(sql`DELETE FROM memberships WHERE org_id = ${orgId} AND user_id = ${userId}`);
  if (!n) throw notFound('Membership');
  await writeAudit(db, app, { actor, action: 'organization.member_remove', targetType: 'organization', targetId: orgId, orgId, metadata: { userId } });
  await app.events.emit(db, 'organization.member_removed', { orgId, userId }, { userId, orgId });
}

// ---- Impersonation ---------------------------------------------------------------

export interface ImpersonationSettings {
  impersonationUrl: string;
  impersonationMinutes: number;
  allowWriteImpersonation: boolean;
}

/**
 * Start an audited, time-limited impersonation. The SaaS app receives a one-time
 * token (via the configured URL), verifies it through the API, and must show a
 * visible "impersonating" banner; `readOnly` asks the app to block writes.
 */
export async function startImpersonation(
  db: Db,
  app: App,
  input: { adminId: string; userId: string; reason: string; readOnly: boolean; ip: string },
  actor: Actor,
  scope: string[] | null,
): Promise<{ id: string; token: string; url: string | null; expiresAt: Date }> {
  const settings = app.settings.get<ImpersonationSettings>('customers');
  if (!input.readOnly && !settings.allowWriteImpersonation) throw forbidden('Write-mode impersonation is disabled in settings', 'impersonation_write_disabled');
  const user = await getUser(db, input.userId, scope);
  if (user.status === 'banned') throw conflict('Banned users cannot be impersonated', 'user_banned');
  const token = `imp_${randomToken(32)}`;
  const now = app.clock.now();
  const expiresAt = new Date(now.getTime() + settings.impersonationMinutes * MINUTE);
  const id = newId('imp');
  await db.exec(sql.insert('impersonations', {
    id,
    admin_id: input.adminId,
    user_id: input.userId,
    reason: input.reason,
    token_hash: sha256(token),
    read_only: input.readOnly,
    ip: input.ip,
    started_at: now,
    expires_at: expiresAt,
  }, ''));
  await writeAudit(db, app, { actor, action: 'user.impersonate_start', targetType: 'user', targetId: input.userId, metadata: { impersonationId: id, reason: input.reason, readOnly: input.readOnly } });
  await app.events.emit(db, 'user.impersonation_started', { userId: input.userId, adminId: input.adminId, impersonationId: id, readOnly: input.readOnly, expiresAt }, { userId: input.userId });
  const url = settings.impersonationUrl ? settings.impersonationUrl.replace('{token}', encodeURIComponent(token)) : null;
  return { id, token, url, expiresAt };
}

export async function verifyImpersonationToken(db: Db, app: App, token: string, actor: Actor): Promise<Record<string, unknown>> {
  const now = app.clock.now();
  const row = await db.maybe<any>(sql`
    UPDATE impersonations SET consumed_at = coalesce(consumed_at, ${now})
    WHERE token_hash = ${sha256(token)} AND ended_at IS NULL AND expires_at > ${now} AND consumed_at IS NULL
    RETURNING id, admin_id, user_id, read_only, expires_at, reason
  `);
  if (!row) throw notFound('Impersonation session');
  const admin = await db.maybe<{ name: string; email: string }>(sql`SELECT name, email FROM admins WHERE id = ${row.admin_id}`);
  await writeAudit(db, app, { actor, action: 'user.impersonate_verify', targetType: 'user', targetId: row.user_id, metadata: { impersonationId: row.id } });
  return {
    impersonationId: row.id,
    userId: row.user_id,
    readOnly: row.read_only,
    expiresAt: row.expires_at,
    admin: { id: row.admin_id, name: admin?.name ?? null, email: admin?.email ?? null },
    reason: row.reason,
  };
}
