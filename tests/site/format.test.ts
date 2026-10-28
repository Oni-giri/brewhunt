import { describe, expect, it } from 'vitest';
import {
  agoLabel,
  compactNumber,
  relativeDay,
  shortDate,
  trendLabel,
} from '../../src/lib/format.ts';

describe('compactNumber', () => {
  it('abbreviates like the designs', () => {
    expect(compactNumber(842)).toBe('842');
    expect(compactNumber(1234)).toBe('1.2k');
    expect(compactNumber(36_812)).toBe('36.8k');
    expect(compactNumber(99_960)).toBe('100k');
    expect(compactNumber(509_747)).toBe('510k');
    expect(compactNumber(999_499)).toBe('999k');
    expect(compactNumber(999_500)).toBe('1M');
    expect(compactNumber(1_234_567)).toBe('1.2M');
  });
});

describe('trendLabel', () => {
  it('shows direction and whole percentages', () => {
    expect(trendLabel(0.426)).toBe('↑ 43%');
    expect(trendLabel(-0.12)).toBe('↓ 12%');
    expect(trendLabel(0.004)).toBe('0%');
    expect(trendLabel(12.5)).toBe('↑ 1,250%');
  });
});

describe('dates', () => {
  const today = '2026-10-28'; // a Wednesday
  it('labels recent days the way the New page does', () => {
    expect(relativeDay('2026-10-28', today)).toBe('today');
    expect(relativeDay('2026-10-27', today)).toBe('yesterday');
    expect(relativeDay('2026-10-26', today)).toBe('Monday');
    expect(relativeDay('2026-10-21', today)).toBe('21 Oct');
    expect(relativeDay('2025-12-30', today)).toBe('30 Dec 2025');
  });

  it('says how long ago', () => {
    expect(agoLabel('2026-10-23', today)).toBe('5 days ago');
    expect(agoLabel('2026-10-07', today)).toBe('3 weeks ago');
    expect(agoLabel('2026-06-01', today)).toBe('4 months ago');
    expect(agoLabel('2025-06-01', today)).toBe('over a year ago');
  });

  it('formats short dates', () => {
    expect(shortDate('2026-10-08')).toBe('8 Oct 2026');
    expect(shortDate('2026-10-08', false)).toBe('8 Oct');
  });
});
