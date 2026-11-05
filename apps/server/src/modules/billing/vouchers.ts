import { z } from 'zod';
import type { Router, RouteContext } from '../../core/http.js';
import type { Actor, App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { DAY } from '../../core/clock.js';
import { writeAudit } from '../../core/audit.js';
import { toCsv } from '../../core/csv.js';
import { currencyCode, likePattern, pageQuery, paginate } from '../../core/validation.js';
import { subjectFor, type Subject } from '../catalog/entitlements.js';
import { insertGeneratedCodes, randomCode } from '../catalog/coupons.js';
import { accessStartsAt, adjustBalance, assertSubjectMatchesProduct, scopeOfSubject } from './engine.js';
import { billingScopeSql } from './routes-admin.js';

/*
 * Gift vouchers: codes an administrator issues, one at a time or in batches, that a customer
 * redeems once for a product (for good or for a number of days) or for account credit, which pays
 * future invoices. Vouchers belong to no customer until redeemed, so only administrators without
 * an organization scope issue and manage them.
 */

/** Uppercase letters and digits only: codes match however they are typed ("gift-7kq2 m9xa" works). */
export function voucherKey(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "GIFT-7KQ2-M9XA-P3RT": an optional prefix and three groups of four unambiguous characters. */
function generateCode(prefix: string): string {
  const body = randomCode(12).match(/.{4}/g)!.join('-');
  return prefix ? `${prefix.toUpperCase()}-${body}` : body;
}

const invalid = (message: string) => new AppError(422, 'voucher_invalid', message);

export interface Redemption {
  voucher: { id: string; name: string; kind: 'product' | 'credit'; productId: string | null; productName: string | null; quantity: number; accessDays: number | null; creditAmount: number | null; currency: string | null };
  grant: { id: string; startsAt: Date; endsAt: Date | null } | null;
  /** Account credit after redeeming a credit voucher. */
  balance: number | null;
}

/** Redeem a voucher for a customer, exactly once. */
export async function redeemVoucher(db: Db, app: App, input: { code: string; subject: Subject; userId: string | null; orgId: string | null; actor: Actor }): Promise<Redemption> {
  const key = voucherKey(input.code);
  const v = key ? await db.maybe<any>(sql`SELECT * FROM vouchers WHERE code_key = ${key} FOR UPDATE`) : null;
  const now = app.clock.now();
  if (!v || v.status === 'disabled') throw invalid('This voucher code is not valid');
  if (v.status === 'redeemed') throw conflict('This voucher has already been redeemed', 'voucher_redeemed');
  if (v.expires_at && v.expires_at <= now) throw invalid('This voucher has expired');
  const scope = scopeOfSubject(input.subject);

  let grant: Redemption['grant'] = null;
  let balance: number | null = null;
  let productName: string | null = null;
  if (v.kind === 'product') {
    const product = await db.one<any>(sql`SELECT * FROM products WHERE id = ${v.product_id}`);
    if (product.status === 'archived') throw invalid('This voucher is no longer valid');
    assertSubjectMatchesProduct(product, input.subject);
    productName = product.name;
    const startsAt = v.access_days ? await accessStartsAt(db, app, input.subject, product.id) : now;
    grant = { id: newId('grt'), startsAt, endsAt: v.access_days ? new Date(startsAt.getTime() + v.access_days * DAY) : null };
    await db.exec(sql.insert('entitlement_grants', {
      id: grant.id,
      subject_type: input.subject.type,
      subject_id: input.subject.id,
      product_id: product.id,
      quantity: v.quantity,
      source: 'promotion',
      source_ref: v.id,
      reason: `Gift voucher ${v.code}`,
      starts_at: grant.startsAt,
      ends_at: grant.endsAt,
      created_at: now,
    }, ''));
    await app.events.emit(db, 'entitlements.updated', { subjectType: input.subject.type, subjectId: input.subject.id, reason: 'voucher' }, scope);
  } else {
    balance = await adjustBalance(db, app, input.subject, v.currency, v.credit_amount, `Gift voucher ${v.code}`);
  }

  await db.exec(sql`
    UPDATE vouchers SET status = 'redeemed', redeemed_at = ${now}, subject_type = ${input.subject.type}, subject_id = ${input.subject.id},
      user_id = ${input.userId}, org_id = ${input.orgId}, grant_id = ${grant?.id ?? null}, updated_at = ${now}
    WHERE id = ${v.id}
  `);
  await writeAudit(db, app, {
    actor: input.actor,
    action: 'voucher.redeem',
    targetType: 'voucher',
    targetId: v.id,
    orgId: input.orgId,
    metadata: { subject: `${input.subject.type}:${input.subject.id}`, kind: v.kind, productId: v.product_id, grantId: grant?.id ?? null, creditAmount: v.credit_amount, currency: v.currency },
  });
  await app.events.emit(db, 'voucher.redeemed', {
    voucherId: v.id,
    kind: v.kind,
    productId: v.product_id,
    grantId: grant?.id ?? null,
    accessDays: v.access_days,
    endsAt: grant?.endsAt ?? null,
    creditAmount: v.credit_amount,
    currency: v.currency,
  }, scope);
  return {
    voucher: { id: v.id, name: v.name, kind: v.kind, productId: v.product_id, productName, quantity: v.quantity, accessDays: v.access_days, creditAmount: v.credit_amount, currency: v.currency },
    grant,
    balance,
  };
}

const voucherBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['product', 'credit']),
    productId: z.string().optional(),
    quantity: z.number().int().min(1).max(1000).default(1),
    accessDays: z.number().int().min(1).max(36_500).optional(),
    creditAmount: z.number().int().min(1).optional(),
    currency: currencyCode.optional(),
    expiresAt: z.coerce.date().optional(),
    /** 1 issues a single voucher; more create a batch of generated codes. */
    count: z.number().int().min(1).max(5000).default(1),
    prefix: z.string().trim().max(12).regex(/^[A-Za-z0-9]*$/, 'Letters and numbers only').default(''),
    /** A chosen code for a single voucher. */
    code: z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes').optional(),
  })
  .superRefine((b, ctx) => {
    if (b.kind === 'product' && !b.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Choose the product this voucher grants' });
    if (b.kind === 'credit' && (!b.creditAmount || !b.currency)) ctx.addIssue({ code: 'custom', path: ['creditAmount'], message: 'Enter the credit amount and currency' });
    if (b.kind === 'credit' && b.accessDays) ctx.addIssue({ code: 'custom', path: ['accessDays'], message: 'Credit vouchers have no access period' });
    if (b.code && b.count > 1) ctx.addIssue({ code: 'custom', path: ['code'], message: 'Batches get generated codes; choose a code only for a single voucher' });
  });

const voucherSelect = sql`
  v.*, p.name AS product_name, b.name AS batch_name, coalesce(u.email, o.name) AS redeemed_by
`;
const voucherFrom = sql`
  vouchers v LEFT JOIN products p ON p.id = v.product_id LEFT JOIN voucher_batches b ON b.id = v.batch_id
  LEFT JOIN users u ON v.subject_type = 'user' AND u.id = v.subject_id
  LEFT JOIN organizations o ON v.subject_type = 'organization' AND o.id = v.subject_id
`;

/** Codes are worth money: administrators who cannot manage vouchers see only their last characters. */
function presentVoucher(v: any, reveal: boolean) {
  const { code_key: _key, ...rest } = v;
  return reveal ? rest : { ...rest, code: `••••${String(v.code).slice(-4)}` };
}

/** Vouchers are global until redeemed: only administrators without an organization scope issue or change them. */
function assertUnscoped(c: RouteContext): void {
  if (c.orgScope()) throw forbidden('Vouchers can be redeemed by any customer, so administrators limited to some organizations cannot issue or change them');
}

export function registerVoucherRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/vouchers',
    auth: 'admin',
    permission: 'billing.vouchers.view',
    summary: 'Gift vouchers',
    tags: ['Vouchers'],
    query: z.object({ ...pageQuery, status: z.enum(['active', 'redeemed', 'disabled', 'expired']).optional(), kind: z.enum(['product', 'credit']).optional(), batchId: z.string().optional(), q: z.string().max(100).optional() }),
    handler: async (c) => {
      const now = app.clock.now();
      const scope = c.orgScope();
      const reveal = c.can('billing.vouchers.manage');
      const key = c.query.q ? voucherKey(c.query.q) : '';
      // Only those who may see codes search inside them; everyone else can look up a whole code.
      const codeMatch = !key ? null : reveal ? sql`v.code_key LIKE ${likePattern(key)}` : sql`v.code_key = ${key}`;
      const page = await paginate<any>(app.db, {
        select: voucherSelect,
        from: voucherFrom,
        where: sql.where([
          c.query.status === 'expired' ? sql`v.status = 'active' AND v.expires_at <= ${now}` : c.query.status && sql`v.status = ${c.query.status}`,
          c.query.status === 'active' && sql`(v.expires_at IS NULL OR v.expires_at > ${now})`,
          c.query.kind && sql`v.kind = ${c.query.kind}`,
          c.query.batchId && sql`v.batch_id = ${c.query.batchId}`,
          c.query.q && sql.or([codeMatch, sql`v.name ILIKE ${likePattern(c.query.q)}`, sql`u.email ILIKE ${likePattern(c.query.q)}`]),
          // Administrators limited to some organizations see the vouchers redeemed there.
          scope && sql`v.status = 'redeemed'`,
          billingScopeSql(scope, 'v'),
        ]),
        orderBy: sql`ORDER BY v.created_at DESC, v.id DESC`,
        page: c.query.page,
        pageSize: c.query.pageSize,
      });
      return { ...page, data: page.data.map((v) => presentVoucher(v, reveal)) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/vouchers',
    auth: 'admin',
    permission: 'billing.vouchers.manage',
    summary: 'Issue a gift voucher, or a batch of vouchers with generated codes',
    description: 'A product voucher grants the product (for good, or for `accessDays`); a credit voucher adds account credit that pays future invoices.',
    tags: ['Vouchers'],
    body: voucherBody,
    handler: (c) =>
      app.db.tx(async (tx) => {
        assertUnscoped(c);
        const b = c.body;
        const now = app.clock.now();
        if (b.kind === 'product') {
          const product = await tx.maybe<{ kind: string; status: string }>(sql`SELECT kind, status FROM products WHERE id = ${b.productId}`);
          if (!product || product.status === 'archived') throw validationError([{ path: ['productId'], message: 'Choose an active product' }]);
          if (product.kind === 'credit_pack') throw validationError([{ path: ['productId'], message: 'Credit packs cannot be granted; issue a credit voucher instead' }]);
        }
        if (b.expiresAt && b.expiresAt <= now) throw validationError([{ path: ['expiresAt'], message: 'Choose a date in the future' }]);
        const batch = b.count > 1
          ? await tx.one<any>(sql.insert('voucher_batches', { id: newId('vbt'), name: b.name, prefix: b.prefix.toUpperCase(), count: b.count, created_by: c.admin().adminId, created_at: now }))
          : null;
        const terms = {
          batch_id: batch?.id ?? null,
          name: b.name,
          kind: b.kind,
          product_id: b.kind === 'product' ? b.productId : null,
          quantity: b.kind === 'product' ? b.quantity : 1,
          access_days: b.kind === 'product' ? b.accessDays ?? null : null,
          credit_amount: b.kind === 'credit' ? b.creditAmount : null,
          currency: b.kind === 'credit' ? b.currency : null,
          expires_at: b.expiresAt ?? null,
          status: 'active',
          created_by: c.admin().adminId,
          created_at: now,
          updated_at: now,
        };
        let created: { id: string; code: string }[];
        if (b.code) {
          const key = voucherKey(b.code);
          if (await tx.maybe(sql`SELECT 1 FROM vouchers WHERE code_key = ${key}`)) throw conflict('This code is already in use', 'code_taken');
          created = [await tx.one<{ id: string; code: string }>(sql.insert('vouchers', { id: newId('vch'), code: b.code.toUpperCase(), code_key: key, ...terms }, 'id, code'))];
        } else {
          created = await insertGeneratedCodes(tx, 'vouchers', b.count, () => generateCode(b.prefix), (code) => ({ id: newId('vch'), code, code_key: voucherKey(code), ...terms }));
        }
        await c.audit(tx, batch ? 'voucher_batch.create' : 'voucher.create', { type: batch ? 'voucher_batch' : 'voucher', id: batch?.id ?? created[0].id }, {
          kind: b.kind,
          count: b.count,
          productId: terms.product_id,
          accessDays: terms.access_days,
          creditAmount: terms.credit_amount,
          currency: terms.currency,
          expiresAt: terms.expires_at,
        });
        const sample = await tx.many(sql`SELECT ${voucherSelect} FROM ${voucherFrom} WHERE v.id IN ${sql.in(created.slice(0, 20).map((v) => v.id))} ORDER BY v.code`);
        return { batch, count: created.length, vouchers: sample.map((v) => presentVoucher(v, true)) };
      }),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/vouchers/:id',
    auth: 'admin',
    permission: 'billing.vouchers.manage',
    summary: 'Rename, disable, re-enable or change the expiry of an unredeemed voucher',
    tags: ['Vouchers'],
    params: z.object({ id: z.string() }),
    body: z.object({ name: z.string().trim().min(1).max(120).optional(), status: z.enum(['active', 'disabled']).optional(), expiresAt: z.coerce.date().nullable().optional() }),
    handler: (c) =>
      app.db.tx(async (tx) => {
        assertUnscoped(c);
        const v = await tx.maybe<{ status: string }>(sql`SELECT status FROM vouchers WHERE id = ${c.params.id} FOR UPDATE`);
        if (!v) throw notFound('Voucher');
        if (v.status === 'redeemed') throw conflict('A redeemed voucher cannot be changed', 'voucher_redeemed');
        if (Object.keys(c.body).length) {
          await tx.exec(sql`UPDATE vouchers SET ${sql.set({ name: c.body.name, status: c.body.status, expires_at: c.body.expiresAt, updated_at: app.clock.now() })} WHERE id = ${c.params.id}`);
        }
        await c.audit(tx, 'voucher.update', { type: 'voucher', id: c.params.id }, c.body);
        return presentVoucher(await tx.one(sql`SELECT ${voucherSelect} FROM ${voucherFrom} WHERE v.id = ${c.params.id}`), true);
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/voucher-batches',
    auth: 'admin',
    permission: 'billing.vouchers.view',
    summary: 'Voucher batches with how many codes were redeemed',
    tags: ['Vouchers'],
    handler: async (c) => {
      // Batches are not tied to any organization.
      if (c.orgScope()) return { data: [] };
      return {
        data: await app.db.many(sql`
          SELECT b.*, s.codes, s.redeemed, s.disabled, t.kind, t.product_id, t.product_name, t.access_days, t.credit_amount, t.currency, t.expires_at
          FROM voucher_batches b
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS codes, count(*) FILTER (WHERE status = 'redeemed')::int AS redeemed, count(*) FILTER (WHERE status = 'disabled')::int AS disabled
            FROM vouchers WHERE batch_id = b.id
          ) s ON TRUE
          LEFT JOIN LATERAL (
            SELECT v.kind, v.product_id, p.name AS product_name, v.access_days, v.credit_amount, v.currency, v.expires_at
            FROM vouchers v LEFT JOIN products p ON p.id = v.product_id WHERE v.batch_id = b.id LIMIT 1
          ) t ON TRUE
          ORDER BY b.created_at DESC LIMIT 200
        `),
      };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/voucher-batches/:id/codes.csv',
    auth: 'admin',
    permission: 'billing.vouchers.manage',
    summary: 'Export the codes of a voucher batch as CSV',
    tags: ['Vouchers'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      assertUnscoped(c);
      const batch = await app.db.maybe<{ id: string; name: string }>(sql`SELECT id, name FROM voucher_batches WHERE id = ${c.params.id}`);
      if (!batch) throw notFound('Voucher batch');
      const rows = await app.db.many<any>(sql`SELECT ${voucherSelect} FROM ${voucherFrom} WHERE v.batch_id = ${batch.id} ORDER BY v.code`);
      await c.audit(app.db, 'voucher_batch.export', { type: 'voucher_batch', id: batch.id }, { count: rows.length });
      const csv = toCsv(rows, [
        { header: 'code', value: (v) => v.code },
        { header: 'status', value: (v) => v.status },
        { header: 'kind', value: (v) => v.kind },
        { header: 'product', value: (v) => v.product_name },
        { header: 'access_days', value: (v) => v.access_days },
        { header: 'credit_minor', value: (v) => v.credit_amount },
        { header: 'currency', value: (v) => v.currency },
        { header: 'expires_at', value: (v) => v.expires_at },
        { header: 'redeemed_at', value: (v) => v.redeemed_at },
      ]);
      const filename = `vouchers-${batch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || batch.id}.csv`;
      return c.reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`).send(csv);
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/voucher-batches/:id/disable',
    auth: 'admin',
    permission: 'billing.vouchers.manage',
    summary: 'Disable every unredeemed voucher of a batch (for example after a leak)',
    tags: ['Vouchers'],
    params: z.object({ id: z.string() }),
    handler: (c) =>
      app.db.tx(async (tx) => {
        assertUnscoped(c);
        if (!(await tx.maybe(sql`SELECT 1 FROM voucher_batches WHERE id = ${c.params.id}`))) throw notFound('Voucher batch');
        const disabled = await tx.exec(sql`UPDATE vouchers SET status = 'disabled', updated_at = ${app.clock.now()} WHERE batch_id = ${c.params.id} AND status = 'active'`);
        await c.audit(tx, 'voucher_batch.disable', { type: 'voucher_batch', id: c.params.id }, { disabled });
        return { disabled };
      }),
  });

  // ---- Redemption ----------------------------------------------------------------------
  const redeemBody = z.object({ code: z.string().trim().min(1).max(60) });

  r.route({
    method: 'POST',
    url: '/api/v1/vouchers/redeem',
    auth: 'api',
    scope: 'checkout:write',
    summary: 'Redeem a gift voucher for a user or organization',
    description: 'Grants the voucher product or adds its account credit. Each voucher can be redeemed once.',
    tags: ['Vouchers'],
    rateLimit: { max: 120, windowSec: 60, by: 'principal', key: 'vouchers.redeem' },
    body: redeemBody.extend({ userId: z.string().optional(), orgId: z.string().optional() }).refine((b) => b.userId || b.orgId, 'userId or orgId is required'),
    handler: (c) =>
      app.db.tx(async (tx) => {
        const subject = await subjectFor(tx, { userId: c.body.userId, orgId: c.body.orgId }, c.orgScope());
        return redeemVoucher(tx, app, { code: c.body.code, subject, userId: c.body.userId ?? null, orgId: c.body.orgId ?? null, actor: c.actor });
      }),
  });

  r.route({
    method: 'POST',
    url: '/api/client/vouchers/redeem',
    auth: 'client',
    summary: 'Redeem a gift voucher',
    tags: ['Client'],
    // Codes are secrets: slow down guessing.
    rateLimit: { max: 10, windowSec: 60, by: 'principal', key: 'client.vouchers.redeem' },
    body: redeemBody,
    handler: (c) => {
      const p = c.customer();
      const subject: Subject = p.orgId ? { type: 'organization', id: p.orgId } : { type: 'user', id: p.userId };
      return app.db.tx((tx) => redeemVoucher(tx, app, { code: c.body.code, subject, userId: p.userId, orgId: p.orgId, actor: c.actor }));
    },
  });
}
