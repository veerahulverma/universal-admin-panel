import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { DAY } from '../../core/clock.js';
import { resolveEntitlements, type ResetPeriod, type ResolvedFeature, type Subject, type CatalogSettings } from '../catalog/entitlements.js';

const EPOCH = new Date(0);

export function periodBounds(reset: ResetPeriod, now: Date, anchor?: { start: Date | null; end: Date | null }): { start: Date; end: Date | null } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (reset) {
    case 'none':
    case 'rolling':
      return { start: EPOCH, end: null };
    case 'day':
      return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
    case 'week': {
      const offset = (now.getUTCDay() + 6) % 7; // ISO weeks start on Monday
      return { start: new Date(Date.UTC(y, m, d - offset)), end: new Date(Date.UTC(y, m, d - offset + 7)) };
    }
    case 'year':
      return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
    case 'billing_period':
      if (anchor?.start && anchor.end && anchor.start <= now && now < anchor.end) return { start: anchor.start, end: anchor.end };
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
    case 'month':
    default:
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  }
}

interface MeterRow {
  id: string;
  key: string;
  name: string;
  unit: string;
  kind: 'counter' | 'gauge';
  weights: Record<string, Record<string, number>>;
  credit_type: string | null;
  credits_per_unit: number | null;
  archived: boolean;
}

interface CounterRow {
  id: string;
  used: number;
  reserved: number;
  overage: number;
  period_start: Date;
  period_end: Date | null;
  warned_at: Date | null;
  limit_reached_at: Date | null;
}

/** Apply per-dimension multipliers (e.g. a large model costs 10x). Always rounds up so usage is never under-counted. */
export function weighQuantity(meter: Pick<MeterRow, 'weights'>, quantity: number, dimensions: Record<string, string> = {}): number {
  let factor = 1;
  for (const [dim, table] of Object.entries(meter.weights ?? {})) {
    const value = dimensions[dim];
    if (value !== undefined && table[value] !== undefined) factor *= table[value];
  }
  const weighted = quantity * factor;
  return weighted >= 0 ? Math.ceil(weighted - 1e-9) : Math.floor(weighted + 1e-9);
}

export interface UsageInput {
  subject: Subject;
  userId: string | null;
  orgId: string | null;
  meterKey: string;
  quantity: number;
  dimensions?: Record<string, string>;
  idempotencyKey?: string | null;
  /** enforce = check and record atomically; record = usage already happened, always record. */
  mode: 'enforce' | 'record';
  source: 'api' | 'admin' | 'system' | 'reservation';
  actorId?: string | null;
  reason?: string | null;
}

export interface UsageResult {
  allowed: boolean;
  duplicate?: boolean;
  reason?: 'limit_exceeded' | 'insufficient_credits' | 'not_in_plan' | 'unmetered';
  meter: string;
  quantity: number;
  used: number;
  limit: number | null;
  remaining: number | null;
  overage: number;
  enforcement: string | null;
  resetsAt: Date | null;
  eventId?: string;
  reservationId?: string;
  expiresAt?: Date;
  credits?: { type: string; charged: number; balance: number };
  warning?: 'approaching_limit' | 'limit_reached' | 'over_limit';
}

interface Plan {
  meter: MeterRow;
  feature: ResolvedFeature | null;
  limit: number | null;
  enforcement: 'hard' | 'soft' | 'overage';
  period: { start: Date; end: Date | null };
}

async function planFor(db: Db, app: App, input: Pick<UsageInput, 'subject' | 'meterKey'>): Promise<Plan & { notInPlan: boolean; unmeteredDenied: boolean }> {
  const meter = await db.maybe<MeterRow>(sql`SELECT * FROM meters WHERE key = ${input.meterKey}`);
  if (!meter || meter.archived) throw new AppError(404, 'unknown_meter', `Unknown meter "${input.meterKey}"`);
  const ent = await resolveEntitlements(db, app, input.subject);
  const feature = Object.values(ent.features).find((f) => f.type === 'quota' && f.meterKey === meter.key) ?? null;
  const now = app.clock.now();
  if (!feature) {
    const deny = app.settings.get<CatalogSettings>('catalog').unknownMeterPolicy === 'deny';
    return { meter, feature: null, limit: null, enforcement: 'hard', period: periodBounds(meter.kind === 'gauge' ? 'none' : 'month', now), notInPlan: false, unmeteredDenied: deny };
  }
  const reset = meter.kind === 'gauge' ? 'none' : feature.resetPeriod;
  return {
    meter,
    feature,
    limit: feature.enabled ? feature.limit : 0,
    enforcement: feature.enforcement,
    period: periodBounds(reset, now, { start: feature.periodStart, end: feature.periodEnd }),
    notInPlan: !feature.enabled,
    unmeteredDenied: false,
  };
}

/** Lock (creating if needed) the counter row for subject + meter + period. All enforcement serializes on this lock. */
async function lockCounter(db: Db, app: App, subject: Subject, meterKey: string, period: { start: Date; end: Date | null }): Promise<CounterRow> {
  await db.exec(sql`
    INSERT INTO usage_counters (id, subject_type, subject_id, meter_key, period_start, period_end, used, reserved, overage, updated_at)
    VALUES (${newId('ctr')}, ${subject.type}, ${subject.id}, ${meterKey}, ${period.start}, ${period.end}, 0, 0, 0, ${app.clock.now()})
    ON CONFLICT (subject_type, subject_id, meter_key, period_start) DO NOTHING
  `);
  return db.one<CounterRow>(sql`
    SELECT id, used, reserved, overage, period_start, period_end, warned_at, limit_reached_at FROM usage_counters
    WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND meter_key = ${meterKey} AND period_start = ${period.start}
    FOR UPDATE
  `);
}

async function windowUsed(db: Db, app: App, subject: Subject, meterKey: string, windowSeconds: number): Promise<number> {
  const since = new Date(app.clock.now().getTime() - windowSeconds * 1000);
  const row = await db.one<{ total: number }>(sql`
    SELECT coalesce(sum(quantity), 0) AS total FROM usage_events
    WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND meter_key = ${meterKey} AND created_at > ${since}
  `);
  return row.total;
}

async function currentUsed(db: Db, app: App, plan: Plan, subject: Subject, counter: CounterRow): Promise<number> {
  if (plan.feature?.resetPeriod === 'rolling' && plan.meter.kind !== 'gauge') {
    return windowUsed(db, app, subject, plan.meter.key, plan.feature.rollingWindowSeconds ?? DAY / 1000);
  }
  return counter.used;
}

function remainingOf(limit: number | null, used: number, reserved: number): number | null {
  return limit === null ? null : Math.max(0, limit - used - reserved);
}

// ---- Credits -----------------------------------------------------------------------

export async function creditBalance(db: Db, subject: Subject, creditType: string): Promise<number> {
  const row = await db.maybe<{ balance: number }>(sql`
    SELECT balance FROM credit_balances WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND credit_type = ${creditType}
  `);
  return row?.balance ?? 0;
}

export async function grantCredits(
  db: Db,
  app: App,
  input: { subject: Subject; creditType: string; amount: number; source: string; reason?: string | null; expiresAt?: Date | null; idempotencyKey?: string | null; actorId?: string | null; sourceRef?: string | null },
): Promise<{ balance: number; ledgerId: string; duplicate?: boolean }> {
  if (input.amount <= 0) throw validationError([{ path: ['amount'], message: 'Amount must be positive' }]);
  if (input.idempotencyKey) {
    const existing = await db.maybe<{ id: string; balance_after: number }>(sql`SELECT id, balance_after FROM credit_ledger WHERE credit_type = ${input.creditType} AND idempotency_key = ${input.idempotencyKey}`);
    if (existing) return { balance: await creditBalance(db, input.subject, input.creditType), ledgerId: existing.id, duplicate: true };
  }
  const now = app.clock.now();
  const row = await db.one<{ balance: number }>(sql`
    INSERT INTO credit_balances (subject_type, subject_id, credit_type, balance, updated_at)
    VALUES (${input.subject.type}, ${input.subject.id}, ${input.creditType}, ${input.amount}, ${now})
    ON CONFLICT (subject_type, subject_id, credit_type) DO UPDATE SET balance = credit_balances.balance + EXCLUDED.balance, updated_at = EXCLUDED.updated_at
    RETURNING balance
  `);
  const ledgerId = newId('cdt');
  await db.exec(sql.insert('credit_ledger', {
    id: ledgerId,
    subject_type: input.subject.type,
    subject_id: input.subject.id,
    credit_type: input.creditType,
    amount: input.amount,
    balance_after: row.balance,
    remaining: input.amount,
    reason: input.reason ?? null,
    source: input.source,
    source_ref: input.sourceRef ?? null,
    expires_at: input.expiresAt ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    actor_id: input.actorId ?? null,
    created_at: now,
  }, ''));
  await app.events.emit(db, 'credits.granted', { subjectType: input.subject.type, subjectId: input.subject.id, creditType: input.creditType, amount: input.amount, balance: row.balance, source: input.source }, subjectEventScope(input.subject));
  return { balance: row.balance, ledgerId };
}

/**
 * Debit credits atomically (conditional UPDATE, so concurrent debits can never
 * overdraw). Consumption is allocated to grants soonest-expiring first, so
 * expiring credits are used before permanent ones.
 */
export async function debitCredits(
  db: Db,
  app: App,
  input: { subject: Subject; creditType: string; amount: number; source: string; reason?: string | null; idempotencyKey?: string | null; actorId?: string | null; allowPartial?: boolean; sourceRef?: string | null },
): Promise<{ ok: boolean; charged: number; balance: number; duplicate?: boolean }> {
  if (input.amount <= 0) return { ok: true, charged: 0, balance: await creditBalance(db, input.subject, input.creditType) };
  if (input.idempotencyKey) {
    const existing = await db.maybe<{ amount: number }>(sql`SELECT amount FROM credit_ledger WHERE credit_type = ${input.creditType} AND idempotency_key = ${input.idempotencyKey}`);
    if (existing) return { ok: true, charged: -existing.amount, balance: await creditBalance(db, input.subject, input.creditType), duplicate: true };
  }
  const now = app.clock.now();
  await db.exec(sql`
    INSERT INTO credit_balances (subject_type, subject_id, credit_type, balance, updated_at) VALUES (${input.subject.type}, ${input.subject.id}, ${input.creditType}, 0, ${now})
    ON CONFLICT DO NOTHING
  `);
  // The row lock serializes concurrent debits of the same balance.
  const current = await db.one<{ balance: number }>(sql`
    SELECT balance FROM credit_balances
    WHERE subject_type = ${input.subject.type} AND subject_id = ${input.subject.id} AND credit_type = ${input.creditType} FOR UPDATE
  `);
  if (!input.allowPartial && current.balance < input.amount) return { ok: false, charged: 0, balance: current.balance };
  const charged = Math.min(current.balance, input.amount);
  const updated = await db.one<{ balance: number }>(sql`
    UPDATE credit_balances SET balance = balance - ${charged}, updated_at = ${now}
    WHERE subject_type = ${input.subject.type} AND subject_id = ${input.subject.id} AND credit_type = ${input.creditType}
    RETURNING balance
  `);
  let toAllocate = charged;
  const grants = await db.many<{ id: string; remaining: number }>(sql`
    SELECT id, remaining FROM credit_ledger
    WHERE subject_type = ${input.subject.type} AND subject_id = ${input.subject.id} AND credit_type = ${input.creditType} AND amount > 0 AND remaining > 0
    ORDER BY expires_at ASC NULLS LAST, created_at ASC FOR UPDATE
  `);
  for (const g of grants) {
    if (toAllocate <= 0) break;
    const take = Math.min(g.remaining, toAllocate);
    await db.exec(sql`UPDATE credit_ledger SET remaining = remaining - ${take} WHERE id = ${g.id}`);
    toAllocate -= take;
  }
  if (charged > 0) {
    await db.exec(sql.insert('credit_ledger', {
      id: newId('cdt'),
      subject_type: input.subject.type,
      subject_id: input.subject.id,
      credit_type: input.creditType,
      amount: -charged,
      balance_after: updated.balance,
      reason: input.reason ?? null,
      source: input.source,
      source_ref: input.sourceRef ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      actor_id: input.actorId ?? null,
      created_at: now,
    }, ''));
  }
  return { ok: charged === input.amount || Boolean(input.allowPartial), charged, balance: updated.balance };
}

export function subjectEventScope(subject: Subject): { userId?: string; orgId?: string } {
  return subject.type === 'user' ? { userId: subject.id } : { orgId: subject.id };
}

// ---- Consumption ------------------------------------------------------------------------

async function emitThresholds(db: Db, app: App, subject: Subject, plan: Plan, counter: CounterRow, newUsed: number): Promise<UsageResult['warning']> {
  if (plan.limit === null || plan.limit <= 0 || !plan.feature) return undefined;
  const now = app.clock.now();
  const pct = (newUsed / plan.limit) * 100;
  let warning: UsageResult['warning'];
  if (pct >= plan.feature.warnAtPercent) warning = 'approaching_limit';
  if (newUsed >= plan.limit) warning = newUsed > plan.limit ? 'over_limit' : 'limit_reached';
  const payload = { subjectType: subject.type, subjectId: subject.id, meter: plan.meter.key, feature: plan.feature.key, used: newUsed, limit: plan.limit, periodEnd: counter.period_end };
  if (pct >= plan.feature.warnAtPercent && !counter.warned_at) {
    await db.exec(sql`UPDATE usage_counters SET warned_at = ${now} WHERE id = ${counter.id}`);
    await app.events.emit(db, 'usage.limit_warning', { ...payload, percent: Math.floor(pct) }, subjectEventScope(subject));
  }
  if (newUsed >= plan.limit && !counter.limit_reached_at) {
    await db.exec(sql`UPDATE usage_counters SET limit_reached_at = ${now} WHERE id = ${counter.id}`);
    await app.events.emit(db, 'usage.limit_reached', payload, subjectEventScope(subject));
  }
  return warning;
}

function creditCost(meter: MeterRow, quantity: number): number {
  return meter.credit_type && meter.credits_per_unit ? Math.ceil(quantity * Number(meter.credits_per_unit) - 1e-9) : 0;
}

/**
 * Record usage. In `enforce` mode the limit check and the increment happen
 * atomically under the counter lock, so concurrent requests can never overshoot
 * a hard limit, and a repeated idempotency key is never charged twice.
 */
export async function recordUsage(db: Db, app: App, input: UsageInput): Promise<UsageResult> {
  if (!Number.isFinite(input.quantity) || input.quantity === 0) throw validationError([{ path: ['quantity'], message: 'Quantity must be a non-zero number' }]);
  return db.tx(async (tx) => {
    const plan = await planFor(tx, app, input);
    if (input.quantity < 0 && plan.meter.kind !== 'gauge' && input.source !== 'admin') {
      throw validationError([{ path: ['quantity'], message: 'Negative usage is only allowed for gauge meters and admin corrections' }]);
    }
    const counter = await lockCounter(tx, app, input.subject, plan.meter.key, plan.period);

    if (input.idempotencyKey) {
      const dup = await tx.maybe<{ id: string; quantity: number }>(sql`SELECT id, quantity FROM usage_events WHERE meter_key = ${plan.meter.key} AND idempotency_key = ${input.idempotencyKey}`);
      if (dup) {
        const used = await currentUsed(tx, app, plan, input.subject, counter);
        return { allowed: true, duplicate: true, meter: plan.meter.key, quantity: dup.quantity, used, limit: plan.limit, remaining: remainingOf(plan.limit, used, counter.reserved), overage: counter.overage, enforcement: plan.feature ? plan.enforcement : null, resetsAt: plan.period.end, eventId: dup.id };
      }
    }

    let weighted = weighQuantity(plan.meter, input.quantity, input.dimensions);
    const used = await currentUsed(tx, app, plan, input.subject, counter);
    if (used + weighted < 0) weighted = -used; // gauges and corrections never go below zero
    const base = { meter: plan.meter.key, quantity: weighted, limit: plan.limit, enforcement: plan.feature ? plan.enforcement : null, resetsAt: plan.period.end };
    const deny = (reason: UsageResult['reason']): UsageResult => ({ ...base, allowed: false, reason, used, remaining: remainingOf(plan.limit, used, counter.reserved), overage: counter.overage });

    if (input.mode === 'enforce' && weighted > 0) {
      if (plan.unmeteredDenied) return deny('unmetered');
      if (plan.notInPlan) return deny('not_in_plan');
      const grace = plan.feature?.graceUnits ?? 0;
      if (plan.limit !== null && plan.enforcement === 'hard' && used + counter.reserved + weighted > plan.limit + grace) return deny('limit_exceeded');
    }

    let credits: UsageResult['credits'];
    const cost = weighted > 0 ? creditCost(plan.meter, weighted) : 0;
    if (cost > 0) {
      const debit = await debitCredits(tx, app, {
        subject: input.subject,
        creditType: plan.meter.credit_type!,
        amount: cost,
        source: 'usage',
        reason: `${plan.meter.key} x${weighted}`,
        allowPartial: input.mode === 'record',
      });
      if (!debit.ok) return deny('insufficient_credits');
      credits = { type: plan.meter.credit_type!, charged: debit.charged, balance: debit.balance };
    }

    const newUsed = used + weighted;
    const overageDelta = plan.limit === null ? 0 : Math.max(0, newUsed - plan.limit) - Math.max(0, used - plan.limit);
    await tx.exec(sql`
      UPDATE usage_counters SET used = used + ${weighted}, overage = GREATEST(0, overage + ${overageDelta}), updated_at = ${app.clock.now()} WHERE id = ${counter.id}
    `);
    const eventId = newId('use');
    await tx.exec(sql.insert('usage_events', {
      id: eventId,
      subject_type: input.subject.type,
      subject_id: input.subject.id,
      user_id: input.userId,
      org_id: input.orgId,
      meter_key: plan.meter.key,
      quantity: weighted,
      raw_quantity: input.quantity,
      dimensions: input.dimensions ?? {},
      idempotency_key: input.idempotencyKey ?? null,
      source: input.source,
      actor_id: input.actorId ?? null,
      reason: input.reason ?? null,
      counter_id: counter.id,
      created_at: app.clock.now(),
    }, ''));
    if (input.userId) {
      await tx.exec(sql`UPDATE users SET last_active_at = ${app.clock.now()} WHERE id = ${input.userId} AND (last_active_at IS NULL OR last_active_at < ${new Date(app.clock.now().getTime() - 300_000)})`);
    }
    const warning = await emitThresholds(tx, app, input.subject, plan, counter, newUsed);
    return {
      ...base,
      allowed: true,
      used: newUsed,
      remaining: remainingOf(plan.limit, newUsed, counter.reserved),
      overage: Math.max(0, counter.overage + overageDelta),
      eventId,
      credits,
      warning,
    };
  });
}

/** Set a gauge meter to an absolute level (seats in use, projects, storage bytes). */
export async function setGauge(db: Db, app: App, input: Omit<UsageInput, 'quantity' | 'mode'> & { value: number }): Promise<UsageResult> {
  if (input.value < 0) throw validationError([{ path: ['value'], message: 'Value cannot be negative' }]);
  return db.tx(async (tx) => {
    const plan = await planFor(tx, app, input);
    if (plan.meter.kind !== 'gauge') throw validationError([{ path: ['meter'], message: 'Only gauge meters can be set to a value' }]);
    const counter = await lockCounter(tx, app, input.subject, plan.meter.key, plan.period);
    const delta = input.value - counter.used;
    if (delta === 0) {
      return { allowed: true, meter: plan.meter.key, quantity: 0, used: counter.used, limit: plan.limit, remaining: remainingOf(plan.limit, counter.used, 0), overage: counter.overage, enforcement: plan.feature ? plan.enforcement : null, resetsAt: null };
    }
    return recordUsage(tx, app, { ...input, quantity: delta, mode: 'enforce' });
  });
}

// ---- Reservations -------------------------------------------------------------------------

export async function reserveUsage(db: Db, app: App, input: UsageInput & { ttlSeconds: number }): Promise<UsageResult> {
  if (input.quantity <= 0) throw validationError([{ path: ['quantity'], message: 'Reservations need a positive quantity' }]);
  return db.tx(async (tx) => {
    const plan = await planFor(tx, app, input);
    const counter = await lockCounter(tx, app, input.subject, plan.meter.key, plan.period);
    if (input.idempotencyKey) {
      const existing = await tx.maybe<any>(sql`SELECT * FROM usage_reservations WHERE meter_key = ${plan.meter.key} AND idempotency_key = ${input.idempotencyKey}`);
      if (existing) {
        return { allowed: true, duplicate: true, meter: plan.meter.key, quantity: existing.quantity, used: counter.used, limit: plan.limit, remaining: remainingOf(plan.limit, counter.used, counter.reserved), overage: counter.overage, enforcement: plan.feature ? plan.enforcement : null, resetsAt: plan.period.end, reservationId: existing.id, expiresAt: existing.expires_at };
      }
    }
    const weighted = weighQuantity(plan.meter, input.quantity, input.dimensions);
    const used = await currentUsed(tx, app, plan, input.subject, counter);
    const base = { meter: plan.meter.key, quantity: weighted, limit: plan.limit, enforcement: plan.feature ? plan.enforcement : null, resetsAt: plan.period.end, overage: counter.overage, used };
    if (plan.unmeteredDenied) return { ...base, allowed: false, reason: 'unmetered', remaining: null };
    if (plan.notInPlan) return { ...base, allowed: false, reason: 'not_in_plan', remaining: 0 };
    if (plan.limit !== null && plan.enforcement === 'hard' && used + counter.reserved + weighted > plan.limit + (plan.feature?.graceUnits ?? 0)) {
      return { ...base, allowed: false, reason: 'limit_exceeded', remaining: remainingOf(plan.limit, used, counter.reserved) };
    }
    let credits: UsageResult['credits'];
    const cost = creditCost(plan.meter, weighted);
    const id = newId('rsv');
    if (cost > 0) {
      const debit = await debitCredits(tx, app, { subject: input.subject, creditType: plan.meter.credit_type!, amount: cost, source: 'usage', reason: `hold for reservation ${id}`, sourceRef: id });
      if (!debit.ok) return { ...base, allowed: false, reason: 'insufficient_credits', remaining: remainingOf(plan.limit, used, counter.reserved) };
      credits = { type: plan.meter.credit_type!, charged: debit.charged, balance: debit.balance };
    }
    const expiresAt = new Date(app.clock.now().getTime() + input.ttlSeconds * 1000);
    await tx.exec(sql`UPDATE usage_counters SET reserved = reserved + ${weighted}, updated_at = ${app.clock.now()} WHERE id = ${counter.id}`);
    await tx.exec(sql.insert('usage_reservations', {
      id,
      counter_id: counter.id,
      subject_type: input.subject.type,
      subject_id: input.subject.id,
      user_id: input.userId,
      org_id: input.orgId,
      meter_key: plan.meter.key,
      quantity: weighted,
      dimensions: input.dimensions ?? {},
      credit_hold: cost,
      status: 'held',
      idempotency_key: input.idempotencyKey ?? null,
      expires_at: expiresAt,
      created_at: app.clock.now(),
    }, ''));
    return { ...base, allowed: true, reservationId: id, expiresAt, remaining: remainingOf(plan.limit, used, counter.reserved + weighted), credits };
  });
}

interface ReservationRow {
  id: string;
  counter_id: string;
  subject_type: 'user' | 'organization';
  subject_id: string;
  user_id: string | null;
  org_id: string | null;
  meter_key: string;
  quantity: number;
  dimensions: Record<string, string>;
  credit_hold: number;
  status: 'held' | 'committed' | 'released' | 'expired';
  committed_quantity: number | null;
}

async function lockReservation(db: Db, id: string, scope: string[] | null): Promise<ReservationRow> {
  const r = await db.maybe<ReservationRow>(sql`
    SELECT * FROM usage_reservations WHERE id = ${id}
    ${scope ? sql`AND (org_id IN ${sql.in(scope)} OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = usage_reservations.user_id AND m.org_id IN ${sql.in(scope)}))` : sql.empty}
    FOR UPDATE
  `);
  if (!r) throw notFound('Reservation');
  return r;
}

/** Convert a hold into real usage. `quantity` (raw, re-weighted) defaults to the reserved amount; extra is recorded as overage. */
export async function commitReservation(db: Db, app: App, id: string, quantity: number | undefined, scope: string[] | null): Promise<UsageResult> {
  return db.tx(async (tx) => {
    const r = await lockReservation(tx, id, scope);
    const counter = await tx.one<CounterRow & { meter_key: string }>(sql`SELECT * FROM usage_counters WHERE id = ${r.counter_id} FOR UPDATE`);
    if (r.status === 'committed') {
      return { allowed: true, duplicate: true, meter: r.meter_key, quantity: r.committed_quantity ?? r.quantity, used: counter.used, limit: null, remaining: null, overage: counter.overage, enforcement: null, resetsAt: counter.period_end, reservationId: r.id };
    }
    if (r.status !== 'held') throw conflict(`Reservation is ${r.status}`, 'reservation_closed');
    const meter = await tx.one<MeterRow>(sql`SELECT * FROM meters WHERE key = ${r.meter_key}`);
    const actual = quantity === undefined ? r.quantity : weighQuantity(meter, quantity, r.dimensions);
    if (actual < 0) throw validationError([{ path: ['quantity'], message: 'Quantity cannot be negative' }]);
    const subject: Subject = { type: r.subject_type, id: r.subject_id };
    const ent = await resolveEntitlements(tx, app, subject);
    const feature = Object.values(ent.features).find((f) => f.meterKey === r.meter_key) ?? null;
    const limit = feature ? (feature.enabled ? feature.limit : 0) : null;

    // Settle credits: refund an unused hold or charge the extra.
    let credits: UsageResult['credits'];
    if (meter.credit_type) {
      const finalCost = creditCost(meter, actual);
      const diff = finalCost - r.credit_hold;
      if (diff < 0) {
        const g = await grantCredits(tx, app, { subject, creditType: meter.credit_type, amount: -diff, source: 'refund', reason: `unused hold for ${r.id}`, sourceRef: r.id });
        credits = { type: meter.credit_type, charged: finalCost, balance: g.balance };
      } else if (diff > 0) {
        const d = await debitCredits(tx, app, { subject, creditType: meter.credit_type, amount: diff, source: 'usage', reason: `overrun of ${r.id}`, allowPartial: true, sourceRef: r.id });
        credits = { type: meter.credit_type, charged: r.credit_hold + d.charged, balance: d.balance };
      } else {
        credits = { type: meter.credit_type, charged: finalCost, balance: await creditBalance(tx, subject, meter.credit_type) };
      }
    }

    const newUsed = counter.used + actual;
    const overageDelta = limit === null ? 0 : Math.max(0, newUsed - limit) - Math.max(0, counter.used - limit);
    await tx.exec(sql`
      UPDATE usage_counters SET reserved = GREATEST(0, reserved - ${r.quantity}), used = used + ${actual},
        overage = GREATEST(0, overage + ${overageDelta}), updated_at = ${app.clock.now()} WHERE id = ${counter.id}
    `);
    const eventId = newId('use');
    await tx.exec(sql.insert('usage_events', {
      id: eventId,
      subject_type: r.subject_type,
      subject_id: r.subject_id,
      user_id: r.user_id,
      org_id: r.org_id,
      meter_key: r.meter_key,
      quantity: actual,
      raw_quantity: quantity ?? r.quantity,
      dimensions: r.dimensions,
      source: 'reservation',
      reservation_id: r.id,
      counter_id: counter.id,
      created_at: app.clock.now(),
    }, ''));
    await tx.exec(sql`UPDATE usage_reservations SET status = 'committed', committed_quantity = ${actual}, finalized_at = ${app.clock.now()} WHERE id = ${r.id}`);
    const plan: Plan = { meter, feature, limit, enforcement: feature?.enforcement ?? 'hard', period: { start: counter.period_start, end: counter.period_end } };
    const warning = await emitThresholds(tx, app, subject, plan, counter, newUsed);
    return {
      allowed: true,
      meter: r.meter_key,
      quantity: actual,
      used: newUsed,
      limit,
      remaining: remainingOf(limit, newUsed, Math.max(0, counter.reserved - r.quantity)),
      overage: Math.max(0, counter.overage + overageDelta),
      enforcement: feature?.enforcement ?? null,
      resetsAt: counter.period_end,
      eventId,
      reservationId: r.id,
      credits,
      warning,
    };
  });
}

export async function releaseReservation(db: Db, app: App, id: string, scope: string[] | null, status: 'released' | 'expired' = 'released'): Promise<{ released: boolean }> {
  return db.tx(async (tx) => {
    const r = await lockReservation(tx, id, scope);
    if (r.status !== 'held') return { released: false };
    await tx.exec(sql`UPDATE usage_counters SET reserved = GREATEST(0, reserved - ${r.quantity}), updated_at = ${app.clock.now()} WHERE id = ${r.counter_id}`);
    await tx.exec(sql`UPDATE usage_reservations SET status = ${status}, finalized_at = ${app.clock.now()} WHERE id = ${r.id}`);
    if (r.credit_hold > 0) {
      const meter = await tx.one<{ credit_type: string }>(sql`SELECT credit_type FROM meters WHERE key = ${r.meter_key}`);
      await grantCredits(tx, app, { subject: { type: r.subject_type, id: r.subject_id }, creditType: meter.credit_type, amount: r.credit_hold, source: 'refund', reason: `${status} reservation ${r.id}`, sourceRef: r.id });
    }
    return { released: true };
  });
}

// ---- Reads -----------------------------------------------------------------------------------

export interface MeterUsage {
  meter: string;
  name: string;
  unit: string;
  kind: string;
  feature: string | null;
  used: number;
  reserved: number;
  limit: number | null;
  unlimited: boolean;
  remaining: number | null;
  overage: number;
  enforcement: string | null;
  resetPeriod: string | null;
  periodStart: Date;
  periodEnd: Date | null;
  forecast: { projected: number; limitReachedAt: Date | null } | null;
}

/** Usage for every meter visible to a subject in its current period, with linear forecasts. */
export async function usageSummary(db: Db, app: App, subject: Subject): Promise<MeterUsage[]> {
  const ent = await resolveEntitlements(db, app, subject);
  const meters = await db.many<MeterRow>(sql`SELECT * FROM meters WHERE NOT archived ORDER BY name`);
  const now = app.clock.now();
  const out: MeterUsage[] = [];
  for (const meter of meters) {
    const feature = Object.values(ent.features).find((f) => f.type === 'quota' && f.meterKey === meter.key) ?? null;
    const reset = meter.kind === 'gauge' ? 'none' : feature?.resetPeriod ?? 'month';
    const period = periodBounds(reset, now, { start: feature?.periodStart ?? null, end: feature?.periodEnd ?? null });
    const counter = await db.maybe<{ used: number; reserved: number; overage: number }>(sql`
      SELECT used, reserved, overage FROM usage_counters WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND meter_key = ${meter.key} AND period_start = ${period.start}
    `);
    const used = feature?.resetPeriod === 'rolling' && meter.kind !== 'gauge' ? await windowUsed(db, app, subject, meter.key, feature.rollingWindowSeconds ?? 86400) : counter?.used ?? 0;
    const limit = feature ? (feature.enabled ? feature.limit : 0) : null;
    let forecast: MeterUsage['forecast'] = null;
    if (period.end && meter.kind === 'counter' && reset !== 'rolling') {
      const elapsed = Math.max(1, now.getTime() - period.start.getTime());
      const total = period.end.getTime() - period.start.getTime();
      const rate = used / elapsed;
      const projected = Math.round(rate * total);
      const limitReachedAt = limit !== null && rate > 0 && used < limit ? new Date(now.getTime() + (limit - used) / rate) : null;
      forecast = { projected, limitReachedAt: limitReachedAt && limitReachedAt < period.end ? limitReachedAt : null };
    }
    out.push({
      meter: meter.key,
      name: meter.name,
      unit: meter.unit,
      kind: meter.kind,
      feature: feature?.key ?? null,
      used,
      reserved: counter?.reserved ?? 0,
      limit,
      unlimited: feature ? feature.unlimited : true,
      remaining: remainingOf(limit, used, counter?.reserved ?? 0),
      overage: counter?.overage ?? 0,
      enforcement: feature?.enforcement ?? null,
      resetPeriod: feature ? reset : null,
      periodStart: period.start,
      periodEnd: period.end,
      forecast,
    });
  }
  return out;
}

export async function currentUsageFor(db: Db, app: App, subject: Subject, feature: ResolvedFeature): Promise<{ used: number; reserved: number; periodStart: Date; periodEnd: Date | null }> {
  const meter = await db.maybe<MeterRow>(sql`SELECT * FROM meters WHERE key = ${feature.meterKey}`);
  const reset = meter?.kind === 'gauge' ? 'none' : feature.resetPeriod;
  const period = periodBounds(reset, app.clock.now(), { start: feature.periodStart, end: feature.periodEnd });
  const counter = await db.maybe<{ used: number; reserved: number }>(sql`
    SELECT used, reserved FROM usage_counters WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND meter_key = ${feature.meterKey} AND period_start = ${period.start}
  `);
  const used = reset === 'rolling' ? await windowUsed(db, app, subject, feature.meterKey!, feature.rollingWindowSeconds ?? 86400) : counter?.used ?? 0;
  return { used, reserved: counter?.reserved ?? 0, periodStart: period.start, periodEnd: period.end };
}

/** Expire credit grants: whatever remains of an expired grant leaves the balance. */
export async function expireCredits(app: App): Promise<number> {
  const due = await app.db.many<{ id: string; subject_type: 'user' | 'organization'; subject_id: string; credit_type: string; remaining: number }>(sql`
    SELECT id, subject_type, subject_id, credit_type, remaining FROM credit_ledger WHERE amount > 0 AND remaining > 0 AND expires_at <= ${app.clock.now()}
  `);
  for (const g of due) {
    await app.db.tx(async (tx) => {
      const locked = await tx.maybe<{ remaining: number }>(sql`SELECT remaining FROM credit_ledger WHERE id = ${g.id} AND remaining > 0 FOR UPDATE`);
      if (!locked) return;
      await tx.exec(sql`UPDATE credit_ledger SET remaining = 0 WHERE id = ${g.id}`);
      const subject: Subject = { type: g.subject_type, id: g.subject_id };
      const row = await tx.one<{ balance: number }>(sql`
        UPDATE credit_balances SET balance = GREATEST(0, balance - ${locked.remaining}), updated_at = ${app.clock.now()}
        WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND credit_type = ${g.credit_type} RETURNING balance
      `);
      await tx.exec(sql.insert('credit_ledger', {
        id: newId('cdt'),
        subject_type: subject.type,
        subject_id: subject.id,
        credit_type: g.credit_type,
        amount: -locked.remaining,
        balance_after: row.balance,
        reason: `expired grant ${g.id}`,
        source: 'expiry',
        source_ref: g.id,
        created_at: app.clock.now(),
      }, ''));
    });
  }
  return due.length;
}
