import { randomBytes } from 'node:crypto';

// Crockford base32, lowercase. ULIDs are time-sortable, which keeps btree inserts local.
const ENCODING = '0123456789abcdefghjkmnpqrstvwxyz';

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * Monotonic ULID: within one process, ids generated in the same millisecond
 * (or while the clock steps backwards) increment the previous random part, so
 * ids always sort in creation order, which list ordering relies on.
 */
export function ulid(time = Date.now()): string {
  let digits: number[] | null = null;
  if (time <= lastTime) {
    digits = [...lastRandom];
    let i = digits.length - 1;
    while (i >= 0 && digits[i] === 31) digits[i--] = 0;
    if (i >= 0) {
      digits[i]++;
      time = lastTime;
    } else {
      digits = null; // the random part overflowed: move to the next millisecond
      time = lastTime + 1;
    }
  }
  if (!digits) digits = Array.from(randomBytes(16), (b) => b % 32);
  lastTime = time;
  lastRandom = digits;

  let ts = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    ts = ENCODING[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  return ts + digits.map((d) => ENCODING[d]).join('');
}

/** Stripe-style prefixed identifiers, e.g. `usr_01jc3zk8q7...`. */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniform random base62 string (rejection sampling, no modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const b of bytes) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}
