/**
 * Injectable clock. All time-dependent business logic (billing periods, usage
 * windows, job scheduling, session expiry) reads time from here so tests can
 * travel through time deterministically.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Real time plus a movable offset: time keeps flowing, and tests can jump ahead. */
export class OffsetClock implements Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  set(date: Date | string): void {
    this.offsetMs = new Date(date).getTime() - Date.now();
  }

  reset(): void {
    this.offsetMs = 0;
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
