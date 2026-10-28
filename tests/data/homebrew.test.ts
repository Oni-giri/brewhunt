import { describe, expect, it } from 'vitest';
import {
  checkHomebrew,
  parseAnalytics,
  type AnalyticsFile,
  type HomebrewData,
} from '../../scripts/data/homebrew.ts';

const END = '2026-10-28';
const startFor = (days: number) =>
  new Date(Date.parse(`${END}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** A window with `entries` packages of `each` installs. */
const file = (days: number, entries: number, each: number, end = END): AnalyticsFile => ({
  start: startFor(days),
  end,
  counts: new Map(Array.from({ length: entries }, (_, i) => [`pkg${i}`, each])),
  total: entries * each,
});

const feed = () => ({ '30d': file(30, 2000, 10), '90d': file(90, 3000, 20), '365d': file(365, 5000, 50) });

function data(overrides: Partial<HomebrewData['analytics']> = {}): HomebrewData {
  return {
    formulae: Array.from({ length: 6000 }) as HomebrewData['formulae'],
    casks: Array.from({ length: 6000 }) as HomebrewData['casks'],
    analytics: { install: feed(), installOnRequest: feed(), caskInstall: feed(), ...overrides },
  };
}

describe('parseAnalytics', () => {
  it('reads comma-separated counts and the window', () => {
    const parsed = parseAnalytics({
      category: 'install',
      start_date: '2026-09-28',
      end_date: END,
      total_count: '1,509,747',
      items: [
        { number: 1, formula: 'wget', count: '1,509,700', percent: '99' },
        { number: 2, formula: 'acme/tools/widget', count: '47', percent: '1' },
      ],
    });
    expect(parsed.start).toBe('2026-09-28');
    expect(parsed.total).toBe(1_509_747);
    expect(Object.fromEntries(parsed.counts)).toEqual({ wget: 1_509_700, 'acme/tools/widget': 47 });
  });

  it('rejects malformed counts', () => {
    expect(() =>
      parseAnalytics({
        category: 'install',
        start_date: '2026-09-28',
        end_date: END,
        total_count: 1,
        items: [{ formula: 'wget', count: 'lots' }],
      }),
    ).toThrow();
  });
});

describe('checkHomebrew', () => {
  it('accepts plausible data', () => {
    expect(checkHomebrew(data(), END)).toEqual([]);
  });

  it('rejects stale analytics', () => {
    expect(checkHomebrew(data(), '2026-11-10').join()).toMatch(/13 days from today/);
  });

  it('rejects an empty long window', () => {
    const install = { ...feed(), '365d': file(365, 0, 0) };
    expect(checkHomebrew(data({ install }), END).join()).toMatch(/install 365d has 0 entries/);
  });

  it('rejects windows that end on different days', () => {
    const caskInstall = { ...feed(), '30d': file(30, 2000, 10, '2026-10-27') };
    expect(checkHomebrew(data({ caskInstall }), END).join()).toMatch(/caskInstall 30d ends 2026-10-27/);
  });

  it('rejects a longer window with fewer installs', () => {
    const installOnRequest = { ...feed(), '90d': file(90, 3000, 1) };
    expect(checkHomebrew(data({ installOnRequest }), END).join()).toMatch(
      /installOnRequest 90d has fewer installs/,
    );
  });

  it('rejects a catalogue that shrank', () => {
    expect(checkHomebrew({ ...data(), casks: [] }, END)).toContain('only 0 casks');
  });
});
