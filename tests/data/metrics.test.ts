import { describe, expect, it } from 'vitest';
import { addDays, computeTrend, daysBetween, isLibrary } from '../../scripts/data/metrics.ts';

describe('computeTrend', () => {
  // All of Homebrew: 9,000 over 90 days, 4,000 in the last 30 (the 60 before averaged 2,500).
  const all = { d30: 4000, d90: 9000, previous30: null };

  it("compares the package's share with the average 30 days of the previous 60", () => {
    // Package: 400 of 900. Its count grew 60%, but everything grew 60%: no change in share.
    expect(computeTrend({ d30: 400, d90: 900, previous30: null }, all, false)).toEqual({
      change: 0,
      basis: 'previous-60-days-average',
    });
    // 500 of 1,000: share went from 250/2,500 to 500/4,000, up 25%.
    expect(computeTrend({ d30: 500, d90: 1000, previous30: null }, all, false)).toEqual({
      change: 0.25,
      basis: 'previous-60-days-average',
    });
  });

  it('compares with the snapshot from 30 days earlier when there is one', () => {
    const withSnapshot = { ...all, previous30: 2000 };
    // Share went from 400/2,000 to 300/4,000.
    expect(computeTrend({ d30: 300, d90: 900, previous30: 400 }, withSnapshot, false)).toEqual({
      change: -0.625,
      basis: 'previous-30-days',
    });
    // No total for that day: fall back to the 90-day window.
    expect(computeTrend({ d30: 400, d90: 900, previous30: 400 }, all, false)?.basis).toBe(
      'previous-60-days-average',
    );
  });

  it('skips low volumes and packages added inside the baseline', () => {
    expect(computeTrend({ d30: 99, d90: 120, previous30: null }, all, false)).toBeNull();
    expect(computeTrend({ d30: 500, d90: 560, previous30: null }, all, false)).toBeNull(); // baseline 30
    expect(computeTrend({ d30: 5000, d90: 9000, previous30: null }, all, true)).toBeNull();
    expect(computeTrend({ d30: 500, d90: 1500, previous30: 0 }, { ...all, previous30: 2000 }, false)).toBeNull();
  });
});

describe('isLibrary', () => {
  it('flags formulae people rarely install by name', () => {
    expect(isLibrary('openssl@3', 1_000_000, 180_000)).toBe(true); // 0.18
    expect(isLibrary('libpng', 500_000, 25_000)).toBe(true);
    expect(isLibrary('libvips', 10_000, 4_500)).toBe(true); // lib* below 0.5
  });

  it('keeps tools, including borderline ones', () => {
    expect(isLibrary('git', 500_000, 490_000)).toBe(false);
    expect(isLibrary('curl', 300_000, 114_000)).toBe(false); // 0.38
    expect(isLibrary('cmake', 300_000, 144_000)).toBe(false); // 0.48
    expect(isLibrary('libvips-tools', 10_000, 6_000)).toBe(false); // lib* but 0.6
  });

  it('judges low-volume formulae by name only', () => {
    expect(isLibrary('libfoo', 20, 0)).toBe(true);
    expect(isLibrary('foo', 20, 0)).toBe(false);
  });
});

describe('dates', () => {
  it('adds days and measures gaps in UTC', () => {
    expect(addDays('2026-10-27', -30)).toBe('2026-09-27');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-09-27', '2026-10-27')).toBe(30);
  });
});
