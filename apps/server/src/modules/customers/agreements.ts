import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { keySlug, pageQuery, paginate } from '../../core/validation.js';
import { diff } from '../../core/json.js';
import { MINUTE } from '../../core/clock.js';
import { getUser, userScopeSql } from './service.js';

/**
 * Terms of service, privacy policies and similar documents. An agreement has
 * numbered versions with an effective date; the current version is the latest
 * one in effect. Acceptance records keep who accepted which version, when,
 * from which address and through which channel.
 */

export interface AgreementVersionRow {
  id: string;
  agreement_id: string;
  version: number;
  title: string;
  body: string;
  summary: string | null;
  effective_at: Date;
  created_at: Date;
}

interface AgreementRow {
  id: string;
  key: string;
  title: string;
  description: string;
  required: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type AcceptanceSource = 'signup' | 'client' | 'api';

export function presentVersion(a: { id: string; key: string }, v: AgreementVersionRow, opts: { body?: boolean } = {}) {
  return {
    agreementId: a.id,
    key: a.key,
    versionId: v.id,
    version: v.version,
    title: v.title,
    summary: v.summary,
    effectiveAt: v.effective_at,
    ...(opts.body === false ? {} : { body: v.body }),
  };
}

/** The version in effect now: the highest version whose effective date has passed. */
export async function currentVersion(db: Db, app: App, agreementId: string): Promise<AgreementVersionRow | null> {
  return db.maybe<AgreementVersionRow>(sql`
    SELECT * FROM agreement_versions WHERE agreement_id = ${agreementId} AND effective_at <= ${app.clock.now()} ORDER BY version DESC LIMIT 1
  `);
}

/** Required agreements whose current version the customer has not accepted. */
export async function pendingAgreements(db: Db, app: App, userId: string) {
  const rows = await db.many<AgreementVersionRow & { key: string; agreement_title: string }>(sql`
    SELECT v.*, a.key, a.title AS agreement_title FROM agreements a
    JOIN LATERAL (
      SELECT * FROM agreement_versions v WHERE v.agreement_id = a.id AND v.effective_at <= ${app.clock.now()} ORDER BY v.version DESC LIMIT 1
    ) v ON TRUE
    WHERE a.required AND a.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM agreement_acceptances aa WHERE aa.user_id = ${userId} AND aa.version_id = v.id)
    ORDER BY a.title
  `);
  return rows.map((r) => presentVersion({ id: r.agreement_id, key: r.key }, r));
}

export async function acceptedAgreements(db: Db, app: App, userId: string) {
  return db.many(sql`
    SELECT aa.id, a.id AS "agreementId", a.key, a.title AS "agreementTitle", v.id AS "versionId", v.version, v.title,
      aa.accepted_at AS "acceptedAt", aa.ip, aa.user_agent AS "userAgent", aa.source,
      (v.id = (SELECT c.id FROM agreement_versions c WHERE c.agreement_id = a.id AND c.effective_at <= ${app.clock.now()} ORDER BY c.version DESC LIMIT 1)) AS current
    FROM agreement_acceptances aa JOIN agreements a ON a.id = aa.agreement_id JOIN agreement_versions v ON v.id = aa.version_id
    WHERE aa.user_id = ${userId} ORDER BY aa.accepted_at DESC
  `);
}

/**
 * Record that a customer accepted a version. Only the version in effect can be
 * accepted, so nobody agrees to superseded or not-yet-published terms; accepting
 * the same version twice returns the first record.
 */
export async function recordAcceptance(
  db: Db,
  app: App,
  input: { userId: string; versionId: string; ip: string | null; userAgent: string | null; source: AcceptanceSource },
) {
  const version = await db.maybe<AgreementVersionRow & { key: string; archived_at: Date | null }>(sql`
    SELECT v.*, a.key, a.archived_at FROM agreement_versions v JOIN agreements a ON a.id = v.agreement_id WHERE v.id = ${input.versionId}
  `);
  if (!version || version.archived_at) throw notFound('Agreement version');
  const current = await currentVersion(db, app, version.agreement_id);
  if (!current) throw conflict('This agreement has no version in effect yet', 'agreement_not_effective');
  if (current.id !== version.id) {
    throw conflict('A newer version of this agreement is in effect; show it to the customer and accept that one', 'agreement_version_outdated', { currentVersionId: current.id, currentVersion: current.version });
  }
  const existing = await db.maybe<{ id: string; accepted_at: Date }>(sql`
    SELECT id, accepted_at FROM agreement_acceptances WHERE user_id = ${input.userId} AND version_id = ${version.id} ORDER BY accepted_at LIMIT 1
  `);
  if (existing) return { id: existing.id, acceptedAt: existing.accepted_at, ...presentVersion({ id: version.agreement_id, key: version.key }, version, { body: false }), created: false };
  const id = newId('agac');
  const now = app.clock.now();
  await db.exec(sql.insert('agreement_acceptances', {
    id,
    user_id: input.userId,
    agreement_id: version.agreement_id,
    version_id: version.id,
    ip: input.ip,
    user_agent: input.userAgent?.slice(0, 500) ?? null,
    source: input.source,
    accepted_at: now,
  }, ''));
  await app.events.emit(db, 'agreement.accepted', { userId: input.userId, agreementId: version.agreement_id, agreementKey: version.key, versionId: version.id, version: version.version, source: input.source }, { userId: input.userId });
  return { id, acceptedAt: now, ...presentVersion({ id: version.agreement_id, key: version.key }, version, { body: false }), created: true };
}

const versionBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(200_000),
  summary: z.string().trim().max(2000).optional(),
  /** Defaults to now. Future dates schedule the version; past dates are refused (nobody can accept retroactively). */
  effectiveAt: z.coerce.date().optional(),
});

async function loadAgreement(db: Db, id: string, opts: { lock?: boolean } = {}): Promise<AgreementRow> {
  const row = await db.maybe<AgreementRow>(sql`SELECT * FROM agreements WHERE id = ${id} ${opts.lock ? sql`FOR UPDATE` : sql.empty}`);
  if (!row) throw notFound('Agreement');
  return row;
}

function effectiveDate(app: App, value: Date | undefined): Date {
  const now = app.clock.now();
  if (!value) return now;
  if (value.getTime() < now.getTime() - 5 * MINUTE) throw validationError([{ path: ['effectiveAt'], message: 'The effective date cannot be in the past' }]);
  return value.getTime() < now.getTime() ? now : value;
}

/** A version can still be edited while nobody can have seen it as binding: not in effect and never accepted. */
async function editableVersion(db: Db, app: App, versionId: string): Promise<AgreementVersionRow> {
  const v = await db.maybe<AgreementVersionRow>(sql`SELECT * FROM agreement_versions WHERE id = ${versionId} FOR UPDATE`);
  if (!v) throw notFound('Agreement version');
  const accepted = await db.maybe(sql`SELECT 1 FROM agreement_acceptances WHERE version_id = ${v.id} LIMIT 1`);
  if (accepted || v.effective_at <= app.clock.now()) throw conflict('This version is in effect or has been accepted; publish a new version instead', 'agreement_version_locked');
  return v;
}

async function presentAgreement(db: Db, app: App, a: AgreementRow) {
  const [current, upcoming, counts] = await Promise.all([
    currentVersion(db, app, a.id),
    db.maybe<AgreementVersionRow>(sql`SELECT * FROM agreement_versions WHERE agreement_id = ${a.id} AND effective_at > ${app.clock.now()} ORDER BY version LIMIT 1`),
    db.one<{ versions: number; acceptances: number }>(sql`
      SELECT (SELECT count(*)::int FROM agreement_versions WHERE agreement_id = ${a.id}) AS versions,
        (SELECT count(*)::int FROM agreement_acceptances WHERE agreement_id = ${a.id}) AS acceptances
    `),
  ]);
  return {
    id: a.id,
    key: a.key,
    title: a.title,
    description: a.description,
    required: a.required,
    archivedAt: a.archived_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    current: current ? presentVersion(a, current, { body: false }) : null,
    upcoming: upcoming ? presentVersion(a, upcoming, { body: false }) : null,
    versions: counts.versions,
    acceptances: counts.acceptances,
  };
}

export function registerAgreementRoutes(r: Router, app: App): void {
  // ---- Admin -------------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/admin/agreements',
    auth: 'admin',
    permission: 'customers.agreements.view',
    summary: 'Agreements (terms, policies) with their current version',
    tags: ['Agreements'],
    query: z.object({ archived: z.enum(['true', 'false']).optional() }),
    handler: async (c) => {
      const rows = await app.db.many<AgreementRow>(sql`
        SELECT * FROM agreements ${c.query.archived === 'true' ? sql.empty : sql`WHERE archived_at IS NULL`} ORDER BY title
      `);
      return { data: await Promise.all(rows.map((a) => presentAgreement(app.db, app, a))) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/agreements',
    auth: 'admin',
    permission: 'customers.agreements.manage',
    summary: 'Create an agreement with its first version',
    tags: ['Agreements'],
    body: versionBody.extend({
      key: keySlug,
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(1000).default(''),
      /** Every customer must accept the current version (the client API lists it until they do). */
      required: z.boolean().default(false),
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        if (await tx.maybe(sql`SELECT 1 FROM agreements WHERE key = ${c.body.key}`)) throw conflict('An agreement with this key already exists', 'agreement_key_taken');
        const now = app.clock.now();
        const id = newId('agr');
        const admin = c.admin().adminId;
        const agreement = await tx.one<AgreementRow>(sql.insert('agreements', {
          id,
          key: c.body.key,
          title: c.body.title,
          description: c.body.description,
          required: c.body.required,
          created_by: admin,
          created_at: now,
          updated_at: now,
        }));
        const version = await tx.one<AgreementVersionRow>(sql.insert('agreement_versions', {
          id: newId('agv'),
          agreement_id: id,
          version: 1,
          title: c.body.title,
          body: c.body.body,
          summary: c.body.summary ?? null,
          effective_at: effectiveDate(app, c.body.effectiveAt),
          created_by: admin,
          created_at: now,
        }));
        await c.audit(tx, 'agreement.create', { type: 'agreement', id }, { key: c.body.key, required: c.body.required, versionId: version.id });
        await app.events.emit(tx, 'agreement.version_published', { agreementId: id, agreementKey: agreement.key, versionId: version.id, version: 1, effectiveAt: version.effective_at, required: agreement.required });
        return presentAgreement(tx, app, agreement);
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/agreements/:id',
    auth: 'admin',
    permission: 'customers.agreements.view',
    summary: 'An agreement with every version and its acceptance count',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const a = await loadAgreement(app.db, c.params.id);
      const versions = await app.db.many<AgreementVersionRow & { acceptances: number }>(sql`
        SELECT v.*, (SELECT count(*)::int FROM agreement_acceptances aa WHERE aa.version_id = v.id) AS acceptances
        FROM agreement_versions v WHERE v.agreement_id = ${a.id} ORDER BY v.version DESC
      `);
      return { ...(await presentAgreement(app.db, app, a)), versionList: versions.map((v) => ({ ...presentVersion(a, v), acceptances: v.acceptances, createdAt: v.created_at })) };
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/agreements/:id',
    auth: 'admin',
    permission: 'customers.agreements.manage',
    summary: 'Rename, require or archive an agreement (the text changes through new versions)',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    body: z.object({
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(1000).optional(),
      required: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await loadAgreement(tx, c.params.id, { lock: true });
        const now = app.clock.now();
        const patch = {
          title: c.body.title,
          description: c.body.description,
          required: c.body.required,
          archived_at: c.body.archived === undefined ? undefined : c.body.archived ? before.archived_at ?? now : null,
        };
        const changes = diff(before as unknown as Record<string, unknown>, patch);
        if (!Object.keys(changes).length) return presentAgreement(tx, app, before);
        if (c.body.archived) {
          const forms = await tx.many<{ name: string }>(sql`SELECT name FROM signup_forms WHERE agreement_id = ${before.id} AND active`);
          if (forms.length) throw conflict(`Remove this agreement from these signup forms first: ${forms.map((f) => f.name).join(', ')}`, 'agreement_in_use');
        }
        const row = await tx.one<AgreementRow>(sql`UPDATE agreements SET ${sql.set({ ...patch, updated_at: now })} WHERE id = ${before.id} RETURNING *`);
        await c.audit(tx, 'agreement.update', { type: 'agreement', id: before.id }, { changes });
        return presentAgreement(tx, app, row);
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/admin/agreements/:id/versions',
    auth: 'admin',
    permission: 'customers.agreements.manage',
    summary: 'Publish a new version (now or on a future date); customers must accept it again if the agreement is required',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    body: versionBody,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const a = await loadAgreement(tx, c.params.id, { lock: true });
        if (a.archived_at) throw conflict('Restore the agreement before publishing a new version', 'agreement_archived');
        const latest = await tx.one<{ version: number; effective_at: Date }>(sql`SELECT version, effective_at FROM agreement_versions WHERE agreement_id = ${a.id} ORDER BY version DESC LIMIT 1`);
        const effectiveAt = effectiveDate(app, c.body.effectiveAt);
        if (effectiveAt < latest.effective_at) throw validationError([{ path: ['effectiveAt'], message: `Version ${latest.version} takes effect later; schedule this one after it` }]);
        const version = await tx.one<AgreementVersionRow>(sql.insert('agreement_versions', {
          id: newId('agv'),
          agreement_id: a.id,
          version: latest.version + 1,
          title: c.body.title ?? a.title,
          body: c.body.body,
          summary: c.body.summary ?? null,
          effective_at: effectiveAt,
          created_by: c.admin().adminId,
          created_at: app.clock.now(),
        }));
        await tx.exec(sql`UPDATE agreements SET updated_at = ${app.clock.now()} WHERE id = ${a.id}`);
        await c.audit(tx, 'agreement.version_create', { type: 'agreement', id: a.id }, { versionId: version.id, version: version.version, effectiveAt });
        await app.events.emit(tx, 'agreement.version_published', { agreementId: a.id, agreementKey: a.key, versionId: version.id, version: version.version, effectiveAt, required: a.required });
        return presentVersion(a, version);
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/agreement-versions/:id',
    auth: 'admin',
    permission: 'customers.agreements.manage',
    summary: 'Correct a scheduled version before it takes effect',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    body: versionBody.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const v = await editableVersion(tx, app, c.params.id);
        const a = await loadAgreement(tx, v.agreement_id);
        const patch = {
          title: c.body.title,
          body: c.body.body,
          summary: c.body.summary,
          effective_at: c.body.effectiveAt ? effectiveDate(app, c.body.effectiveAt) : undefined,
        };
        const changes = diff(v as unknown as Record<string, unknown>, patch);
        if (!Object.keys(changes).length) return presentVersion(a, v);
        const row = await tx.one<AgreementVersionRow>(sql`UPDATE agreement_versions SET ${sql.set(patch)} WHERE id = ${v.id} RETURNING *`);
        await c.audit(tx, 'agreement.version_update', { type: 'agreement', id: a.id }, { versionId: v.id, fields: Object.keys(changes) });
        return presentVersion(a, row);
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/agreement-versions/:id',
    auth: 'admin',
    permission: 'customers.agreements.manage',
    summary: 'Withdraw a scheduled version before it takes effect',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const v = await editableVersion(tx, app, c.params.id);
        const later = await tx.maybe(sql`SELECT 1 FROM agreement_versions WHERE agreement_id = ${v.agreement_id} AND version > ${v.version}`);
        if (later) throw conflict('Withdraw the later scheduled versions first', 'agreement_version_not_latest');
        const others = await tx.one<{ count: number }>(sql`SELECT count(*)::int AS count FROM agreement_versions WHERE agreement_id = ${v.agreement_id}`);
        if (others.count <= 1) throw conflict('An agreement needs at least one version; archive the agreement instead', 'agreement_last_version');
        await tx.exec(sql`DELETE FROM agreement_versions WHERE id = ${v.id}`);
        await c.audit(tx, 'agreement.version_delete', { type: 'agreement', id: v.agreement_id }, { versionId: v.id, version: v.version });
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/agreements/:id/acceptances',
    auth: 'admin',
    permission: 'customers.agreements.view',
    summary: 'Who accepted an agreement, which version, when and from where',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    query: z.object({ ...pageQuery, versionId: z.string().optional() }),
    handler: async (c) => {
      await loadAgreement(app.db, c.params.id);
      return paginate(app.db, {
        select: sql`aa.id, aa.user_id, u.email, u.name, aa.version_id, v.version, aa.accepted_at, aa.ip, aa.user_agent, aa.source`,
        from: sql`agreement_acceptances aa JOIN users u ON u.id = aa.user_id JOIN agreement_versions v ON v.id = aa.version_id`,
        where: sql.where([sql`aa.agreement_id = ${c.params.id}`, c.query.versionId && sql`aa.version_id = ${c.query.versionId}`, userScopeSql(c.orgScope())]),
        orderBy: sql`ORDER BY aa.accepted_at DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/agreements',
    auth: 'admin',
    permission: 'customers.agreements.view',
    summary: 'Agreements this customer accepted, and required ones still pending',
    tags: ['Agreements', 'Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, c.orgScope(), { includeDeleted: true });
      const [accepted, pending] = await Promise.all([acceptedAgreements(app.db, app, user.id), pendingAgreements(app.db, app, user.id)]);
      return { accepted, pending: pending.map(({ body: _body, ...rest }) => rest) };
    },
  });

  // ---- Public, client and integration API ----------------------------------------------
  r.route({
    method: 'GET',
    url: '/api/public/agreements/:key',
    auth: 'public',
    summary: 'The version of an agreement in effect, for your terms or privacy page',
    tags: ['Agreements'],
    rateLimit: { max: 120, windowSec: 60 },
    params: z.object({ key: z.string().max(64) }),
    handler: async (c) => {
      const a = await app.db.maybe<AgreementRow>(sql`SELECT * FROM agreements WHERE key = ${c.params.key} AND archived_at IS NULL`);
      const v = a ? await currentVersion(app.db, app, a.id) : null;
      if (!a || !v) throw notFound('Agreement');
      return presentVersion(a, v);
    },
  });

  r.route({
    method: 'GET',
    url: '/api/client/agreements',
    auth: 'client',
    summary: 'Agreements the signed-in customer still has to accept, and those already accepted',
    tags: ['Client'],
    handler: async (c) => {
      const userId = c.customer().userId;
      const [pending, accepted] = await Promise.all([pendingAgreements(app.db, app, userId), acceptedAgreements(app.db, app, userId)]);
      return { pending, accepted: accepted.map(({ ip: _ip, userAgent: _ua, ...rest }) => rest) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/client/agreements/:versionId/accept',
    auth: 'client',
    summary: 'Record that the signed-in customer accepts this version (their IP address and browser are stored with it)',
    tags: ['Client'],
    rateLimit: { max: 30, windowSec: 60, by: 'principal', key: 'client-agreement-accept' },
    params: z.object({ versionId: z.string() }),
    handler: async (c) =>
      app.db.tx((tx) => recordAcceptance(tx, app, { userId: c.customer().userId, versionId: c.params.versionId, ip: c.ip, userAgent: c.userAgent, source: 'client' })),
  });

  r.route({
    method: 'GET',
    url: '/api/v1/users/:id/agreements',
    auth: 'api',
    scope: 'users:read',
    summary: 'Agreements a user still has to accept, and those already accepted',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, c.orgScope());
      const [pending, accepted] = await Promise.all([pendingAgreements(app.db, app, user.id), acceptedAgreements(app.db, app, user.id)]);
      return { pending, accepted };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/v1/users/:id/agreements/accept',
    auth: 'api',
    scope: 'users:write',
    summary: 'Record that a user accepted the version in effect (pass their IP address and user agent)',
    tags: ['Agreements'],
    params: z.object({ id: z.string() }),
    body: z.object({ versionId: z.string(), ip: z.string().max(64).optional(), userAgent: z.string().max(500).optional() }),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const user = await getUser(tx, c.params.id, c.orgScope());
        return recordAcceptance(tx, app, { userId: user.id, versionId: c.body.versionId, ip: c.body.ip ?? null, userAgent: c.body.userAgent ?? null, source: 'api' });
      }),
  });
}
