import { describe, expect, it } from 'vitest';
import { bytes, decimals, fromMinor, initials, interval, money, pct, titleCase, toMinor } from './format';
import { safeNext } from './page';

describe('money', () => {
  it('knows zero- and three-decimal currencies', () => {
    expect(decimals('USD')).toBe(2);
    expect(decimals('jpy')).toBe(0);
    expect(decimals('KWD')).toBe(3);
  });

  it('formats minor units with the currency precision', () => {
    expect(money(1999, 'EUR')).toMatch(/19[.,]99/);
    expect(money(1500, 'JPY')).toMatch(/1[,.  ]?500/);
    expect(money(1500, 'JPY')).not.toMatch(/[.,]00/);
    expect(money(null)).toBe('—');
  });

  it('drops minor units for headline numbers and compacts large axis values', () => {
    const whole = money(123456, 'USD', { whole: true });
    expect(whole).toMatch(/1[,.  ]?235/);
    expect(whole).not.toMatch(/\.56/);
    expect(money(5_000_000, 'USD', { compact: true })).toMatch(/50\s?K/i);
  });

  it('converts between decimal input and minor units', () => {
    expect(toMinor('19.99', 'USD')).toBe(1999);
    expect(toMinor('$1,250.5', 'USD')).toBe(125050);
    expect(toMinor('1500', 'JPY')).toBe(1500);
    expect(toMinor('abc', 'USD')).toBeNull();
    expect(toMinor('', 'USD')).toBeNull();
    expect(fromMinor(1999, 'USD')).toBe('19.99');
    expect(fromMinor(1234, 'KWD')).toBe('1.234');
  });
});

describe('text helpers', () => {
  it('formats percentages, sizes, names and intervals', () => {
    expect(pct(0.256)).toBe('25.6%');
    expect(pct(null)).toBe('—');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials(null, 'grace.hopper@example.com')).toBe('GH');
    expect(titleCase('past_due')).toBe('Past Due');
    expect(interval('month')).toBe('/month');
    expect(interval('month', 3)).toBe(' every 3 months');
    expect(interval(null)).toBe('one-time');
  });
});

describe('safeNext', () => {
  it('only allows same-origin paths after sign-in', () => {
    expect(safeNext('/customers/users?status=active')).toBe('/customers/users?status=active');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example/path')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext(null, '/account')).toBe('/account');
  });
});
