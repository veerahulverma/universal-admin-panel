import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import fs from 'node:fs';
import { compile, type Sql } from './sql.js';

export type Row = Record<string, any>;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

interface Executor {
  query(text: string, values: unknown[]): Promise<QueryResult<any>>;
  script(text: string): Promise<void>;
}

interface Driver extends Executor {
  readonly dialect: 'pg' | 'pglite';
  transaction<T>(fn: (ex: Executor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface TxState {
  active: boolean;
}

/**
 * Tracks the transaction an async call chain is running in. Using the root
 * handle inside a transaction is always a bug: with a connection pool it runs
 * outside the transaction, and with PGlite (single connection) it deadlocks.
 * We fail fast instead.
 */
const txContext = new AsyncLocalStorage<TxState>();

export class Db {
  private afterCommit: (() => void)[] = [];

  private constructor(
    private readonly driver: Driver,
    private readonly ex: Executor,
    private readonly depth: number,
    afterCommit?: (() => void)[],
  ) {
    if (afterCommit) this.afterCommit = afterCommit;
  }

  static async connect(url: string, opts: { poolMax?: number } = {}): Promise<Db> {
    const driver = url.startsWith('pglite:') ? await pgliteDriver(url) : await pgDriver(url, opts.poolMax ?? 10);
    return new Db(driver, driver, 0);
  }

  /** Wrap an existing PGlite instance (used by tests to clone a migrated template). */
  static async fromPglite(instance: import('@electric-sql/pglite').PGliteInterface): Promise<Db> {
    const driver = await wrapPglite(instance);
    return new Db(driver, driver, 0);
  }

  get dialect(): 'pg' | 'pglite' {
    return this.driver.dialect;
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  private guard(): void {
    if (this.depth === 0 && txContext.getStore()?.active) {
      throw new Error('Root database handle used inside a transaction; pass the transaction handle instead');
    }
  }

  async query<T = Row>(q: Sql): Promise<QueryResult<T>> {
    this.guard();
    const { text, values } = compile(q);
    return this.ex.query(text, values);
  }

  async many<T = Row>(q: Sql): Promise<T[]> {
    return (await this.query<T>(q)).rows;
  }

  async maybe<T = Row>(q: Sql): Promise<T | null> {
    return (await this.query<T>(q)).rows[0] ?? null;
  }

  async one<T = Row>(q: Sql): Promise<T> {
    const row = await this.maybe<T>(q);
    if (row === null) throw new Error('Expected a row but the query returned none');
    return row;
  }

  async exec(q: Sql): Promise<number> {
    return (await this.query(q)).rowCount;
  }

  /** Run a multi-statement script (migrations). */
  async script(text: string): Promise<void> {
    this.guard();
    await this.ex.script(text);
  }

  /** Run `fn` in a transaction. Nested calls use savepoints. */
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      const sp = `sp_${this.depth}`;
      await this.ex.query(`SAVEPOINT ${sp}`, []);
      try {
        const result = await fn(new Db(this.driver, this.ex, this.depth + 1, this.afterCommit));
        await this.ex.query(`RELEASE SAVEPOINT ${sp}`, []);
        return result;
      } catch (err) {
        await this.ex.query(`ROLLBACK TO SAVEPOINT ${sp}`, []);
        throw err;
      }
    }
    this.guard();
    const state: TxState = { active: true };
    const hooks: (() => void)[] = [];
    try {
      const result = await this.driver.transaction((ex) =>
        txContext.run(state, () => fn(new Db(this.driver, ex, 1, hooks))),
      );
      state.active = false;
      for (const hook of hooks) {
        try {
          hook();
        } catch {
          /* after-commit hooks are best effort */
        }
      }
      return result;
    } finally {
      state.active = false;
    }
  }

  /** Run `fn` after the surrounding transaction commits (immediately if not in one). */
  onCommit(fn: () => void): void {
    if (this.depth === 0) queueMicrotask(fn);
    else this.afterCommit.push(fn);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

async function pgDriver(url: string, poolMax: number): Promise<Driver> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v: string) => Number(v)); // int8
  pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  const wrap = (r: { rows: any[]; rowCount: number | null }) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 });
  return {
    dialect: 'pg',
    query: async (text, values) => wrap(await pool.query(text, values)),
    script: async (text) => {
      await pool.query(text);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (text, values) => wrap(await client.query(text, values)),
          script: async (text) => {
            await client.query(text);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(url: string): Promise<Driver> {
  const { PGlite } = await import('@electric-sql/pglite');
  const location = url.slice('pglite:'.length).replace(/^\/\//, '');
  let instance;
  if (!location || location === 'memory') {
    instance = new PGlite();
  } else {
    const dir = path.resolve(location);
    fs.mkdirSync(dir, { recursive: true });
    instance = new PGlite(dir);
  }
  return wrapPglite(instance);
}

async function wrapPglite(db: import('@electric-sql/pglite').PGliteInterface): Promise<Driver> {
  const { types } = await import('@electric-sql/pglite');
  await db.waitReady;
  // Parsers are passed per query so cloned instances behave identically.
  const options = {
    parsers: {
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
    },
  };
  const wrap = (r: { rows: any[]; affectedRows?: number }) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  return {
    dialect: 'pglite',
    query: async (text, values) => wrap(await db.query(text, values, options)),
    script: async (text) => {
      await db.exec(text);
    },
    transaction: (fn) =>
      db.transaction(async (tx) =>
        fn({
          query: async (text, values) => wrap(await tx.query(text, values, options)),
          script: async (text) => {
            await tx.exec(text);
          },
        }),
      ),
    close: () => db.close(),
  };
}
