// Builds the search index (src/lib/search.ts › SearchIndex) from the catalog. Runs at build time
// only, through src/pages/search-index.json.ts. Every package with a page is in it, listed or not:
// "brew install openssl" is a real query, and the scoring ranks such packages lower.

import { isCliCask, type Entry } from './catalog.ts';
import { dayNumber, FLAG, type SearchIndex } from './search.ts';

export type IndexEntry = Pick<
  Entry,
  | 'id'
  | 'kind'
  | 'source'
  | 'token'
  | 'name'
  | 'line'
  | 'aliases'
  | 'oldNames'
  | 'altNames'
  | 'keywords'
  | 'isLibrary'
  | 'deprecated'
  | 'versioned'
  | 'platforms'
  | 'artifacts'
  | 'listed'
  | 'hasPage'
  | 'popularity'
  | 'trend'
  | 'firstSeen'
  | 'updatedAt'
  | 'updatedKind'
  | 'installCommand'
>;

export interface IndexInput {
  entries: IndexEntry[];
  categories: { slug: string; name: string; packages: { id: string }[] }[];
  collections: { slug: string; title: string; packages: string[] }[];
  generatedOn: string;
  trendingMin: number;
}

export const LINE_MAX = 100;

/** Cuts at a word boundary and adds "…" when the line is over `max` characters. */
export function clip(text: string, max = LINE_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

const linuxOnly = (e: IndexEntry) => e.platforms?.length === 1 && e.platforms[0] === 'linux';

export function buildSearchIndex(input: IndexInput): SearchIndex {
  const entries = input.entries.filter((e) => e.hasPage);
  const rowOf = new Map(entries.map((e, row) => [e.id, row]));
  const rowsFor = (ids: string[]) =>
    ids.map((id) => rowOf.get(id)).filter((row): row is number => row !== undefined);

  const index: SearchIndex = {
    version: 1,
    generatedOn: input.generatedOn,
    today: dayNumber(input.generatedOn),
    trendingMin: input.trendingMin,
    categories: input.categories.map((c) => ({
      slug: c.slug,
      name: c.name,
      members: rowsFor(c.packages.map((p) => p.id)),
    })),
    collections: input.collections.map((c) => ({
      slug: c.slug,
      title: c.title,
      members: rowsFor(c.packages),
    })),
    id: [],
    name: [],
    line: [],
    alt: [],
    flags: [],
    pop: [],
    updated: [],
    added: {},
    trend: {},
    command: {},
  };

  entries.forEach((e, row) => {
    index.id.push(e.id);
    index.name.push(e.name === e.token ? '' : e.name);
    index.line.push(e.line ? clip(e.line) : '');
    // Names people might type that aren't already the name or token, once each.
    const seen = new Set([e.name.toLowerCase(), e.token.toLowerCase()]);
    const alts = [...e.aliases, ...e.oldNames, ...e.altNames, ...e.keywords].filter((alt) => {
      const key = alt.toLowerCase();
      if (!alt.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    index.alt.push(alts.map((alt) => alt.replaceAll('|', ' ')).join('|'));
    index.flags.push(
      (e.kind === 'cask' ? FLAG.cask : 0) |
        (e.source === 'community' ? FLAG.community : 0) |
        (e.isLibrary ? FLAG.library : 0) |
        (e.deprecated ? FLAG.deprecated : 0) |
        (e.versioned ? FLAG.versioned : 0) |
        (linuxOnly(e) ? FLAG.linuxOnly : 0) |
        (e.listed ? FLAG.listed : 0) |
        (isCliCask(e) ? FLAG.cliCask : 0),
    );
    index.pop.push(e.popularity.d30);
    // A "file" date is the last edit to the definition, not a release: don't call it an update.
    index.updated.push(e.updatedKind === 'version' && e.updatedAt ? dayNumber(e.updatedAt) : null);
    if (e.firstSeen) index.added[row] = dayNumber(e.firstSeen);
    if (e.trend) index.trend[row] = Math.round(e.trend.change * 1000) / 1000;
    const derived = `brew install ${e.kind === 'cask' ? '--cask ' : ''}${e.id}`;
    if (e.installCommand !== derived) index.command[row] = e.installCommand;
  });

  return index;
}
