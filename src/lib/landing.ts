// Lists for the landing page (src/pages/index.astro), on top of catalog.ts.

import { getCatalog, isCommandLine, isMacApp, top, type Entry } from './catalog';
import { tileFor } from './tiles';

/** The most installed Mac apps, skipping any whose tile colour is already taken (the hero). */
export function colourfulTop(count: number): Entry[] {
  const seen = new Set<string>();
  return top(isMacApp, 50)
    .filter((e) => {
      const { tile } = tileFor(e);
      return !seen.has(tile) && seen.add(tile);
    })
    .slice(0, count);
}

/**
 * Chips for the app wall: the most installed packages the editors have filed in a category
 * (which leaves out SDKs, plugins and drivers), with a line to show under the name.
 */
export function wallEntries(filter: (e: Entry) => boolean, limit: number): Entry[] {
  return top((e) => filter(e) && e.categories.length > 0 && !!e.line, limit);
}

export const wallApps = (limit: number) => wallEntries(isMacApp, limit);
export const wallTools = (limit: number) => wallEntries(isCommandLine, limit);

/** The command-line section: the most installed command-line tools in one category. */
export function topToolsIn(categorySlug: string, limit: number): Entry[] {
  if (!getCatalog().categoryBySlug.has(categorySlug)) return [];
  return top((e) => isCommandLine(e) && e.categories.includes(categorySlug), limit);
}
