// Lists and labels for the Discover page (src/pages/discover.astro), on top of catalog.ts.

import type { Category } from '../../scripts/content/schema.ts';
import type { Trend } from '../../scripts/data/types.ts';
import {
  categoryEntries,
  getCatalog,
  kindLabel,
  licenseLabel,
  recentlyAdded,
  top,
  TRENDING_MIN_INSTALLS,
  type Entry,
} from './catalog';
import { fullNumber } from './format';

/** "New this week" falls back to two weeks when the last seven days are this thin. */
const NEW_MIN = 4;
const NEW_LIMIT = 12;

/** Newest listed packages: the last 7 days, or the last 14 if that gives fewer than 4. */
export function newOnDiscover(): { entries: Entry[]; days: 7 | 14 } {
  const week = recentlyAdded(() => true, 7, NEW_LIMIT);
  if (week.length >= NEW_MIN) return { entries: week, days: 7 };
  return { entries: recentlyAdded(() => true, 14, NEW_LIMIT), days: 14 };
}

/** Most installed community-tap packages in the last 30 days, one per tap for variety. */
export function popularCommunity(limit = 4): Entry[] {
  const taps = new Set<string>();
  return top((e) => e.source === 'community', Infinity)
    .filter((e) => !taps.has(e.tap) && taps.add(e.tap))
    .slice(0, limit);
}

/** Card colours for the featured collections, in order (home.html: blue, then navy). */
export const COLLECTION_BACKGROUNDS = ['#1A3FBF', 'var(--navy)'] as const;

/** "Menu bar · Mac app", plus the licence when Homebrew has one ("… · MIT"). */
export function pickMeta(entry: Entry): string {
  const slug = entry.categories[0];
  const category = slug ? getCatalog().categoryBySlug.get(slug) : undefined;
  return [category?.name, kindLabel(entry), licenseLabel(entry)].filter(Boolean).join(' · ');
}

/** The first `limit` packages of a category: its icon stack and "Rectangle, AltTab, …". */
export const categoryLead = (category: Category, limit = 3) =>
  categoryEntries(category).slice(0, limit);

/** What a trend compares the last 30 days with, as a phrase: "the 60 days before". */
export function trendBasisPhrase(basis: Trend['basis']): string {
  return basis === 'previous-30-days' ? 'the 30 days before' : 'the 60 days before';
}

/**
 * One line saying what the trending lists measure. Every package in a build shares one basis
 * (it changes once 30 days of snapshots exist), so the first trend speaks for the list.
 */
export function trendingCaption(entries: Entry[]): string {
  const basis = entries.find((e) => e.trend)?.trend?.basis ?? 'previous-60-days-average';
  return `Biggest rise in share of Homebrew installs over the last 30 days, against ${trendBasisPhrase(basis)}, among packages with ${fullNumber(TRENDING_MIN_INSTALLS)}+ installs.`;
}
