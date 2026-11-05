import { describe, expect, it } from 'vitest';
import { humanize, resolve } from './SchemaForm';
import { compact, niceTicks } from './ui/charts';

describe('SchemaForm labels', () => {
  it('turns schema keys into readable labels', () => {
    expect(humanize('requireMixedCase')).toBe('Require mixed case');
    expect(humanize('webhook_max_attempts')).toBe('Webhook max attempts');
    expect(humanize('defaultCurrency')).toBe('Default currency');
  });
});

describe('SchemaForm field types', () => {
  it('renders "URL or empty" unions as one text field', () => {
    const r = resolve({ anyOf: [{ type: 'string', format: 'uri' }, { type: 'string', const: '' }], title: 'Logo URL' });
    expect(r.schema).toMatchObject({ type: 'string', format: 'uri', title: 'Logo URL' });
    expect(r.nullable).toBe(false);
  });

  it('unwraps nullable fields and keeps other unions as they are', () => {
    expect(resolve({ anyOf: [{ type: 'integer' }, { type: 'null' }] })).toMatchObject({ schema: { type: 'integer' }, nullable: true });
    const mixed = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(resolve(mixed).schema).toBe(mixed);
  });
});

describe('chart scales', () => {
  it('produces round ticks that cover the maximum', () => {
    expect(niceTicks(600)).toEqual([0, 200, 400, 600]);
    expect(niceTicks(0)).toEqual([0, 1]);
    const ticks = niceTicks(1234);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(1234);
    expect(ticks.length).toBeLessThanOrEqual(6);
  });

  it('abbreviates large numbers', () => {
    expect(compact(950)).toBe('950');
    expect(compact(12_500)).toBe('12.5K');
    expect(compact(3_000_000)).toBe('3M');
  });
});
