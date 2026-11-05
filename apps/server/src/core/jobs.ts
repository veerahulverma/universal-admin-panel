import { hostname } from 'node:os';
import { sql } from './sql.js';
import type { Db } from './db.js';
import type { App } from './types.js';
import { newId } from './ids.js';
import { MINUTE, SECOND } from './clock.js';

export interface JobRow {
  id: string;
  queue: string;
  type: string;
  payload: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
}

export interface JobContext {
  app: App;
  job: JobRow;
}

export type JobHandler = (payload: any, ctx: JobContext) => Promise<void>;

interface HandlerDef {
  fn: JobHandler;
  module: string | null;
  timeoutMs: number;
}

export interface ScheduledTaskDef {
  key: string;
  jobType: string;
  intervalSeconds: number;
  description: string;
  module?: string;
  payload?: Record<string, unknown>;
}

/** Exponential backoff with jitter, capped at 6 hours. */
export function backoffMs(attempt: number): number {
  const base = Math.min(6 * 60 * MINUTE, 30 * SECOND * 2 ** (attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Durable job queue on Postgres (FOR UPDATE SKIP LOCKED), so several worker
 * processes can share the queue without double-processing and no extra
 * infrastructure is required.
 */
export class JobQueue {
  private readonly handlers = new Map<string, HandlerDef>();
  private readonly scheduled = new Map<string, ScheduledTaskDef>();

  constructor(private readonly app: App) {}

  register(type: string, fn: JobHandler, opts: { module?: string; timeoutMs?: number } = {}): void {
    this.handlers.set(type, { fn, module: opts.module ?? null, timeoutMs: opts.timeoutMs ?? 5 * MINUTE });
  }

  handler(type: string): HandlerDef | undefined {
    return this.handlers.get(type);
  }

  schedule(def: ScheduledTaskDef): void {
    this.scheduled.set(def.key, def);
  }

  scheduledDefinitions(): ScheduledTaskDef[] {
    return [...this.scheduled.values()];
  }

  async enqueue(
    db: Db,
    type: string,
    payload: Record<string, unknown> = {},
    opts: { runAt?: Date; maxAttempts?: number; idempotencyKey?: string; queue?: string; priority?: number } = {},
  ): Promise<string | null> {
    const now = this.app.clock.now();
    const row = await db.maybe<{ id: string }>(sql`
      INSERT INTO jobs (id, queue, type, payload, status, attempts, max_attempts, priority, run_at, idempotency_key, created_at, updated_at)
      VALUES (${newId('job')}, ${opts.queue ?? 'default'}, ${type}, ${sql.json(payload)}, 'pending', 0, ${opts.maxAttempts ?? 5},
              ${opts.priority ?? 0}, ${opts.runAt ?? now}, ${opts.idempotencyKey ?? null}, ${now}, ${now})
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id
    `);
    if (!opts.runAt || opts.runAt <= now) db.onCommit(() => this.app.worker.nudge());
    return row?.id ?? null;
  }

  /** Create/refresh scheduled task rows from code definitions (keeps admin enable/disable choices). */
  async syncSchedules(db: Db): Promise<void> {
    const now = this.app.clock.now();
    for (const def of this.scheduled.values()) {
      await db.exec(sql`
        INSERT INTO scheduled_tasks (key, job_type, interval_seconds, description, module, payload, enabled, next_run_at, created_at)
        VALUES (${def.key}, ${def.jobType}, ${def.intervalSeconds}, ${def.description}, ${def.module ?? null},
                ${sql.json(def.payload ?? {})}, TRUE, ${new Date(now.getTime() + 5 * SECOND)}, ${now})
        ON CONFLICT (key) DO UPDATE SET job_type = EXCLUDED.job_type, interval_seconds = EXCLUDED.interval_seconds,
          description = EXCLUDED.description, module = EXCLUDED.module, payload = EXCLUDED.payload
      `);
    }
  }
}

/**
 * Polls for due work: dispatches outbox events, enqueues due scheduled tasks,
 * and runs jobs with bounded concurrency. `nudge()` wakes it immediately after a
 * commit so event handling is near-real-time without tight polling.
 */
export class Worker {
  readonly id = `${hostname()}:${process.pid}:${newId('wrk').slice(-6)}`;
  private running = false;
  private timer?: NodeJS.Timeout;
  private active = 0;
  private ticking = false;
  private nudged = false;

  constructor(
    private readonly app: App,
    private readonly concurrency = 5,
    private readonly pollMs = 1000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + 10_000;
    while (this.active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  nudge(): void {
    if (!this.running) return;
    if (this.ticking) {
      this.nudged = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    let didWork = false;
    try {
      didWork = await this.tick(false);
    } catch (err) {
      this.app.log.error({ err }, 'worker tick failed');
    } finally {
      this.ticking = false;
    }
    if (!this.running) return;
    const again = didWork || this.nudged;
    this.nudged = false;
    this.schedule(again ? 0 : this.pollMs);
  }

  /**
   * One unit of work. Returns true if anything was processed. The polling loop
   * does not wait for claimed jobs (finished jobs nudge the loop to refill
   * slots); tests and the CLI wait so they observe completed work.
   */
  async tick(waitForJobs = true): Promise<boolean> {
    const dispatched = await this.app.events.dispatchPending();
    const enqueued = await this.runScheduler();
    await this.recoverStuck();
    const slots = this.concurrency - this.active;
    if (slots <= 0) return dispatched > 0 || enqueued > 0;
    const jobs = await this.claim(slots);
    const run = Promise.all(jobs.map((j) => this.execute(j)));
    if (waitForJobs) await run;
    return dispatched > 0 || enqueued > 0 || jobs.length > 0;
  }

  /** Test/CLI helper: process everything that is currently due, then return. */
  async runUntilIdle(maxIterations = 100): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (!(await this.tick())) return;
    }
    throw new Error('Worker did not become idle (possible job loop)');
  }

  private async runScheduler(): Promise<number> {
    const now = this.app.clock.now();
    return this.app.db.tx(async (tx) => {
      const due = await tx.many<{ key: string; job_type: string; payload: Record<string, unknown>; module: string | null; next_run_at: Date }>(sql`
        UPDATE scheduled_tasks SET last_run_at = ${now},
          next_run_at = ${now}::timestamptz + make_interval(secs => interval_seconds)
        WHERE enabled AND next_run_at <= ${now}
        RETURNING key, job_type, payload, module, next_run_at
      `);
      let count = 0;
      for (const task of due) {
        if (task.module && !this.app.modules.isEnabled(task.module)) continue;
        await this.app.jobs.enqueue(tx, task.job_type, { ...task.payload, scheduledTask: task.key }, {
          idempotencyKey: `sched:${task.key}:${task.next_run_at.toISOString()}`,
          maxAttempts: 3,
        });
        count++;
      }
      return count;
    });
  }

  private async recoverStuck(): Promise<void> {
    const cutoff = new Date(this.app.clock.now().getTime() - 15 * MINUTE);
    await this.app.db.exec(sql`
      UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, last_error = 'Recovered after worker timeout'
      WHERE status = 'running' AND locked_at < ${cutoff}
    `);
  }

  private async claim(limit: number): Promise<JobRow[]> {
    const now = this.app.clock.now();
    return this.app.db.many<JobRow>(sql`
      UPDATE jobs SET status = 'running', locked_at = ${now}, locked_by = ${this.id}, attempts = attempts + 1, updated_at = ${now}
      WHERE id IN (
        SELECT id FROM jobs WHERE status = 'pending' AND run_at <= ${now}
        ORDER BY priority DESC, run_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING id, queue, type, payload, status, attempts, max_attempts, run_at, last_error
    `);
  }

  private async execute(job: JobRow): Promise<void> {
    this.active++;
    try {
      const def = this.app.jobs.handler(job.type);
      if (!def) throw new Error(`No handler registered for job type "${job.type}"`);
      if (def.module && !this.app.modules.isEnabled(def.module)) {
        await this.finish(job, 'completed', 'Skipped: module disabled');
        return;
      }
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        def.fn(job.payload, { app: this.app, job }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Job timed out after ${def.timeoutMs}ms`)), def.timeoutMs);
        }),
      ]).finally(() => clearTimeout(timeout));
      await this.finish(job, 'completed', null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = job.attempts >= job.max_attempts;
      this.app.log.warn({ jobId: job.id, type: job.type, attempt: job.attempts, err: message }, dead ? 'job dead' : 'job failed; will retry');
      await this.finish(job, dead ? 'dead' : 'pending', message, dead ? undefined : new Date(this.app.clock.now().getTime() + backoffMs(job.attempts)));
    } finally {
      this.active--;
      this.nudge();
    }
  }

  private async finish(job: JobRow, status: JobRow['status'], error: string | null, runAt?: Date): Promise<void> {
    const now = this.app.clock.now();
    await this.app.db.exec(sql`
      UPDATE jobs SET status = ${status}, last_error = ${error?.slice(0, 2000) ?? null}, locked_at = NULL, locked_by = NULL,
        updated_at = ${now}, completed_at = ${status === 'completed' ? now : null}
        ${runAt ? sql`, run_at = ${runAt}` : sql.empty}
      WHERE id = ${job.id}
    `);
  }
}
