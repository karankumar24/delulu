import { describe, it, expect } from 'vitest';
import { clockNow, fullDay, handoffLabel, stampWhen } from './dates';

const NOW = new Date(2026, 7, 26, 12, 0, 0); // Aug 26 2026, local

describe('stampWhen', () => {
  it('reads a stamp as a local day and time', () => {
    expect(stampWhen('2026-08-20T03-48-19', NOW)).toEqual({ day: 'Aug 20', age: '6 days ago', time: '3:48 AM' });
  });

  it('keeps a late-evening save on its own day', () => {
    expect(stampWhen('2026-08-17T23-30-00', NOW)?.day).toBe('Aug 17');
  });

  it('refuses an impossible date instead of rolling it over', () => {
    expect(stampWhen('2026-13-45T00-00-00', NOW)).toBeNull();
  });

  it('accepts the suffix added when two saves share a second', () => {
    expect(stampWhen('2026-08-20T03-48-19-2', NOW)?.day).toBe('Aug 20');
  });

  it('returns null for anything that is not a stamp', () => {
    for (const bad of ['', 'latest', '2026-08-20', '2026-08-20T03-48']) expect(stampWhen(bad, NOW)).toBeNull();
  });

  it('says today and yesterday by calendar day', () => {
    expect(stampWhen('2026-08-26T01-00-00', NOW)?.age).toBe('today');
    expect(stampWhen('2026-08-25T23-00-00', NOW)?.age).toBe('yesterday');
  });

  it('shows the year only when it is not the current one', () => {
    expect(stampWhen('2026-06-18T19-53-37', NOW)?.day).toBe('Jun 18');
    expect(stampWhen('2025-06-18T19-53-37', NOW)?.day).toBe('Jun 18 2025');
  });
});

describe('handoffLabel', () => {
  it('names a handoff by its date, and falls back to the stamp only when it is not a date', () => {
    expect(handoffLabel('2026-08-17T20-01-36', NOW)).toBe('Aug 17 handoff');
    expect(handoffLabel('not-a-stamp', NOW)).toBe('not-a-stamp');
  });
});

describe('clock strings', () => {
  it('writes midnight and noon the way a clock does', () => {
    expect(clockNow(new Date(2026, 8, 15, 0, 5))).toBe('Tue Sep 15 at 12:05 AM');
    expect(fullDay(new Date(2026, 8, 15, 12, 30))).toBe('Tue Sep 15, 2026');
  });
});
