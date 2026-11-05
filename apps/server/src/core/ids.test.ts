import { describe, expect, it } from 'vitest';
import { newId, randomBase62, ulid } from './ids.js';

describe('ids', () => {
  it('generates unique ids that sort in creation order, even within one millisecond', () => {
    const ids = Array.from({ length: 2000 }, () => newId('evt'));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^evt_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it('stays increasing when the clock steps backwards', () => {
    const later = ulid(Date.now() + 60_000);
    const earlier = ulid(Date.now());
    expect(earlier > later).toBe(true);
  });

  it('produces uniform base62 secrets of the requested length', () => {
    const s = randomBase62(40);
    expect(s).toMatch(/^[0-9A-Za-z]{40}$/);
    expect(randomBase62(40)).not.toBe(s);
  });
});
