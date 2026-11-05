import type { App } from './types.js';

export type FilterFn<T = any, C = any> = (value: T, ctx: C) => Promise<T> | T;

interface FilterEntry {
  owner: string;
  priority: number;
  fn: FilterFn;
}

export interface HookFailure {
  owner: string;
  hook: string;
  error: Error;
}

/**
 * Extension points (filters). Modules and plugins register functions that can
 * transform a value: entitlements, checkout line items, dashboard widgets, etc.
 * Each filter runs isolated: a failure or timeout is reported and skipped, so
 * one broken plugin cannot take down the core flow it hooks into.
 */
export class HookRegistry {
  private readonly filters = new Map<string, FilterEntry[]>();
  private failureListener?: (f: HookFailure) => void;

  constructor(
    private readonly app: App,
    private readonly timeoutMs = 2000,
  ) {}

  onFailure(listener: (f: HookFailure) => void): void {
    this.failureListener = listener;
  }

  addFilter<T, C>(hook: string, owner: string, fn: FilterFn<T, C>, priority = 10): void {
    const list = this.filters.get(hook) ?? [];
    list.push({ owner, priority, fn: fn as FilterFn });
    list.sort((a, b) => a.priority - b.priority);
    this.filters.set(hook, list);
  }

  removeOwner(owner: string): void {
    for (const [hook, list] of this.filters) {
      this.filters.set(hook, list.filter((f) => f.owner !== owner));
    }
  }

  registered(): { hook: string; owners: string[] }[] {
    return [...this.filters].map(([hook, list]) => ({ hook, owners: list.map((f) => f.owner) }));
  }

  async apply<T, C = unknown>(hook: string, value: T, ctx: C): Promise<T> {
    const list = this.filters.get(hook);
    if (!list?.length) return value;
    let current = value;
    for (const entry of list) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const next = await Promise.race([
          Promise.resolve(entry.fn(current, ctx)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Hook "${hook}" timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
          }),
        ]);
        if (next !== undefined) current = next as T;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.app.log.warn({ hook, owner: entry.owner, err: error.message }, 'hook failed; skipping');
        this.failureListener?.({ owner: entry.owner, hook, error });
      } finally {
        clearTimeout(timer);
      }
    }
    return current;
  }
}
