import { sql } from './sql.js';
import type { Db } from './db.js';
import type { App } from './types.js';
import { newId } from './ids.js';
import { permissionMatches } from './permissions.js';

export interface DomainEvent<T = Record<string, any>> {
  id: string;
  type: string;
  data: T;
  userId: string | null;
  orgId: string | null;
  createdAt: Date;
}

export type EventHandler = (event: DomainEvent, app: App) => Promise<void>;

interface Subscription {
  id: string;
  pattern: string;
  module: string | null;
  fn: EventHandler;
}

export interface EventTypeDef {
  type: string;
  description: string;
  module: string;
}

/**
 * Transactional outbox. `emit` writes the event in the caller's transaction, so
 * an event exists if and only if the change that caused it committed. The
 * worker fans each event out to one job per subscribed handler, so handlers
 * retry independently and a failing subscriber (e.g. a plugin) cannot block
 * the others.
 */
export class EventBus {
  private readonly subs = new Map<string, Subscription>();
  private readonly types = new Map<string, EventTypeDef>();

  constructor(private readonly app: App) {}

  defineTypes(module: string, defs: readonly { type: string; description: string }[]): void {
    for (const d of defs) this.types.set(d.type, { ...d, module });
  }

  catalog(): EventTypeDef[] {
    return [...this.types.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  /** Pattern uses dot segments: `subscription.*`, `*`, or an exact type. */
  subscribe(id: string, pattern: string, fn: EventHandler, opts: { module?: string } = {}): void {
    this.subs.set(id, { id, pattern, fn, module: opts.module ?? null });
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  unsubscribeWhere(predicate: (id: string) => boolean): void {
    for (const id of [...this.subs.keys()]) if (predicate(id)) this.subs.delete(id);
  }

  async emit<T extends Record<string, any>>(
    db: Db,
    type: string,
    data: T,
    opts: { userId?: string | null; orgId?: string | null } = {},
  ): Promise<DomainEvent<T>> {
    const event: DomainEvent<T> = {
      id: newId('evt'),
      type,
      data,
      userId: opts.userId ?? null,
      orgId: opts.orgId ?? null,
      createdAt: this.app.clock.now(),
    };
    await db.exec(sql.insert('events', {
      id: event.id,
      type,
      data,
      user_id: event.userId,
      org_id: event.orgId,
      created_at: event.createdAt,
    }, ''));
    db.onCommit(() => this.app.worker.nudge());
    return event;
  }

  private matches(sub: Subscription, type: string): boolean {
    if (sub.module && !this.app.modules.isEnabled(sub.module)) return false;
    return sub.pattern === '*' || permissionMatches(sub.pattern, type);
  }

  /** Fan out undispatched events into handler jobs. Returns the number of events processed. */
  async dispatchPending(limit = 100): Promise<number> {
    return this.app.db.tx(async (tx) => {
      const rows = await tx.many<{ id: string; type: string }>(sql`
        SELECT id, type FROM events WHERE dispatched_at IS NULL
        ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      `);
      if (!rows.length) return 0;
      for (const row of rows) {
        for (const sub of this.subs.values()) {
          if (!this.matches(sub, row.type)) continue;
          await this.app.jobs.enqueue(tx, 'events.handle', { eventId: row.id, handlerId: sub.id }, {
            idempotencyKey: `evt:${row.id}:${sub.id}`,
            maxAttempts: 8,
          });
        }
      }
      await tx.exec(sql`UPDATE events SET dispatched_at = ${this.app.clock.now()} WHERE id IN ${sql.in(rows.map((r) => r.id))}`);
      return rows.length;
    });
  }

  async runHandler(eventId: string, handlerId: string): Promise<void> {
    const sub = this.subs.get(handlerId);
    if (!sub) return; // handler removed (plugin deactivated); nothing to do
    if (sub.module && !this.app.modules.isEnabled(sub.module)) return;
    const row = await this.app.db.maybe<any>(sql`SELECT * FROM events WHERE id = ${eventId}`);
    if (!row) return;
    await sub.fn(
      { id: row.id, type: row.type, data: row.data, userId: row.user_id, orgId: row.org_id, createdAt: row.created_at },
      this.app,
    );
  }
}
