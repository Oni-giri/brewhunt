// Search quality on the real catalog: queries people type, and the packages they mean. Rankings
// move with each day's installs, so most cases ask for "in the top N", not an exact position.
// Skipped without data (run `npm run data:pull`); CI always has it.

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getCatalog, TRENDING_MIN_INSTALLS } from '../../src/lib/catalog.ts';
import { buildSearchIndex } from '../../src/lib/search-index.ts';
import { DEFAULT_STATE, prepare, search } from '../../src/lib/search.ts';

const hasData = existsSync('data/site/packages.json');

/** [query, ids that must all appear in the first `top` results] */
const CASES: [string, string[], number][] = [
  // Exact names and aliases: the package itself, first.
  ['wget', ['wget'], 1],
  ['node', ['node'], 1],
  ['gh', ['gh'], 1],
  ['firefox', ['firefox'], 1],
  ['visual studio code', ['visual-studio-code'], 1],
  ['docker', ['docker-desktop'], 3],
  ['rectangle', ['rectangle'], 1],
  // What people mean by a word.
  ['books', ['calibre'], 3],
  ['ebook', ['calibre'], 3],
  ['notes', ['obsidian', 'notion'], 5],
  ['password', ['1password', 'bitwarden'], 4],
  ['browser', ['google-chrome', 'firefox', 'brave-browser'], 5],
  ['video player', ['vlc', 'iina'], 4],
  ['terminal', ['ghostty', 'iterm2', 'warp'], 6],
  ['window manager', ['rectangle'], 5],
  ['clipboard', ['maccy'], 3],
  ['markdown editor', ['typora'], 5],
];

describe.skipIf(!hasData)('search on the real catalog', () => {
  const { entries, categories, collections, meta, iconBase } = hasData
    ? getCatalog()
    : ({} as ReturnType<typeof getCatalog>);
  const data = hasData
    ? prepare(
        buildSearchIndex({
          entries,
          categories,
          collections,
          generatedOn: meta.generatedOn,
          trendingMin: TRENDING_MIN_INSTALLS,
          iconBase,
        }),
      )
    : null;

  // Homebrew moves the `python` alias to each new version: whichever formula owns it comes first.
  it('python → the formula with the python alias, first', () => {
    const owner = entries.find((e) => e.kind === 'formula' && e.aliases.includes('python'));
    expect(owner).toBeDefined();
    const [first] = search(data!, 'python', { ...DEFAULT_STATE }, 'relevance').items;
    expect(first.id).toBe(owner!.id);
  });

  it.each(CASES)('%s → %j in the top %i', (query, ids, top) => {
    const found = search(data!, query, { ...DEFAULT_STATE }, 'relevance')
      .items.slice(0, top)
      .map((i) => i.id);
    for (const id of ids) expect(found, `${query}: ${found.join(', ')}`).toContain(id);
  });
});
