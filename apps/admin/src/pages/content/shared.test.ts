import { describe, expect, it } from 'vitest';
import { decisionDetail, fileSize, limitLabel, reasonLabel, releaseSummary, type Decision } from './shared';

const decision = (patch: Partial<Decision>): Decision => ({ allowed: false, state: 'locked', reason: 'no_access', availableAt: null, availableUntil: null, matchedBy: null, ...patch });

describe('content labels', () => {
  it('describes release schedules and access windows', () => {
    expect(releaseSummary({ mode: 'immediate', days: null, date: null }, null)).toBe('Immediately');
    expect(releaseSummary({ mode: 'days', days: 1, date: null }, null)).toBe('1 day after access starts');
    expect(releaseSummary({ mode: 'days', days: 7, date: null }, 30)).toBe('7 days after access starts, for 30 days');
    expect(releaseSummary({ mode: 'days', days: 0, date: null }, null)).toBe('When access starts');
    expect(releaseSummary({ mode: 'date', days: null, date: '2026-03-20T00:00:00Z' }, 1)).toMatch(/^From .+, for 1 day$/);
  });

  it('describes download limits and sizes', () => {
    expect(limitLabel(null, 'day')).toBe('Unlimited');
    expect(limitLabel(5, 'day')).toBe('5 per day');
    expect(limitLabel(3, 'lifetime')).toBe('3 in total');
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(1536)).toBe('1.5 KB');
    expect(fileSize(25 * 1024 * 1024)).toBe('25 MB');
  });

  it('explains decisions in one line', () => {
    expect(decisionDetail(decision({ allowed: true, state: 'available', reason: 'plan', matchedBy: { type: 'plan', id: 'prod_1', name: 'Pro' } }))).toBe('Via Pro');
    expect(decisionDetail(decision({ allowed: true, state: 'available', reason: 'any_customer', matchedBy: { type: 'any_customer', id: null, name: 'Any signed-in customer' } }))).toBe('Any signed-in customer');
    expect(decisionDetail(decision({ state: 'scheduled', reason: 'not_yet_available', availableAt: '2026-03-09T09:00:00Z', matchedBy: { type: 'group', id: 'ugrp_1', name: 'Cohort A' } }))).toMatch(/^Opens .+ \(via Cohort A\)$/);
    expect(decisionDetail(decision({ state: 'ended', reason: 'access_ended', availableUntil: '2026-03-05T09:00:00Z' }))).toMatch(/^Ended /);
    expect(decisionDetail(decision({}))).toBe('No matching plan, product or group');
    expect(reasonLabel('something_new')).toBe('something new');
  });
});
