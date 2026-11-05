import { sql } from './sql.js';
import type { Db } from './db.js';
import type { App } from './types.js';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters stored in Postgres so limits hold across every app
 * instance. The interface is small on purpose: a Redis implementation can
 * replace it without touching callers.
 */
export class RateLimiter {
  constructor(private readonly app: App) {}

  private window(windowSec: number): { start: Date; reset: Date } {
    const now = this.app.clock.now().getTime();
    const size = windowSec * 1000;
    const start = Math.floor(now / size) * size;
    return { start: new Date(start), reset: new Date(start + size) };
  }

  async hit(key: string, limit: number, windowSec: number, db: Db = this.app.db, cost = 1): Promise<RateLimitResult> {
    const { start, reset } = this.window(windowSec);
    const row = await db.one<{ count: number }>(sql`
      INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES (${key}, ${start}, ${cost}, ${reset})
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + ${cost}
      RETURNING count
    `);
    const retryAfterSeconds = Math.max(1, Math.ceil((reset.getTime() - this.app.clock.now().getTime()) / 1000));
    return {
      allowed: row.count <= limit,
      limit,
      remaining: Math.max(0, limit - row.count),
      resetAt: reset,
      retryAfterSeconds,
    };
  }

  async peek(key: string, windowSec: number, db: Db = this.app.db): Promise<number> {
    const { start } = this.window(windowSec);
    const row = await db.maybe<{ count: number }>(sql`SELECT count FROM rate_limits WHERE key = ${key} AND window_start = ${start}`);
    return row?.count ?? 0;
  }

  async reset(key: string, db: Db = this.app.db): Promise<void> {
    await db.exec(sql`DELETE FROM rate_limits WHERE key = ${key}`);
  }

  async purgeExpired(): Promise<number> {
    return this.app.db.exec(sql`DELETE FROM rate_limits WHERE expires_at < ${this.app.clock.now()}`);
  }
}
