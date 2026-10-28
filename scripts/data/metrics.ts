// Derived numbers: trends from the rolling analytics windows, and the "library" flag that
// keeps dependencies like openssl out of charts and discovery.

import type { Trend } from './types.ts';

/** Below these 30-day counts a percentage change is noise, so there's no trend. */
export const TREND_MIN_RECENT = 100;
export const TREND_MIN_BASELINE = 50;

/** 30-day and 90-day counts, plus the 30-day count from the snapshot 30 days earlier. */
export interface TrendCounts {
  d30: number;
  d90: number;
  previous30: number | null;
}

/**
 * Trend of the last 30 days, as the change in the package's share of all installs in its feed
 * (installs on request for formulae, cask installs for casks). Using the share cancels shifts
 * that hit every package at once: in October 2026 all of Homebrew logged 52% more installs than
 * in the two months before, which would otherwise make nearly everything look like it's climbing.
 *
 * With snapshots from 30 days earlier, the baseline is those 30 days. Without, it's the average
 * 30 days of the 60 before, from the 90-day window: (d90 − d30) / 2. A package added inside the
 * baseline period has no full baseline, so it gets no trend.
 */
export function computeTrend(
  pkg: TrendCounts,
  all: TrendCounts,
  addedWithinBaseline: boolean,
): Trend | null {
  if (addedWithinBaseline || pkg.d30 < TREND_MIN_RECENT) return null;
  const fromSnapshot = pkg.previous30 !== null && all.previous30 !== null;
  const baseline = fromSnapshot ? pkg.previous30! : (pkg.d90 - pkg.d30) / 2;
  const allBaseline = fromSnapshot ? all.previous30! : (all.d90 - all.d30) / 2;
  if (baseline < TREND_MIN_BASELINE || allBaseline <= 0 || all.d30 <= 0) return null;
  const change = pkg.d30 / all.d30 / (baseline / allBaseline) - 1;
  return {
    change: Math.round(change * 1000) / 1000,
    basis: fromSnapshot ? 'previous-30-days' : 'previous-60-days-average',
  };
}

/** Below this many yearly installs the on-request ratio is too noisy to judge by. */
export const LIBRARY_MIN_INSTALLS = 100;

/**
 * A formula is a library when people rarely ask for it by name: under 30% of its installs
 * are on request (under 50% for `lib*` names). openssl@3 and libpng sit far below; git, jq
 * and ffmpeg far above; curl and cmake are borderline and stay visible. content/overrides.yaml
 * corrects individual cases.
 */
export function isLibrary(name: string, installs365: number, onRequest365: number): boolean {
  const libName = name.startsWith('lib');
  if (installs365 < LIBRARY_MIN_INSTALLS) return libName;
  const ratio = onRequest365 / installs365;
  return ratio < 0.3 || (libName && ratio < 0.5);
}

/** Days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
