// The header's search suggestions: the search index (src/lib/search-index.ts) cut down to the
// most installed listed packages, so the header's script can score them with the same code as
// /search. Fetched on first focus of the header search, with ?v=<data date> like the full index.
import { getCatalog, TRENDING_MIN_INSTALLS } from '../lib/catalog';
import { buildSearchIndex } from '../lib/search-index';

/** About 80KB gzipped. Anything past these is one Enter away, on /search. */
const SUGGEST_MAX = 3000;

export function GET() {
  const { entries, categories, meta, iconBase } = getCatalog();
  const top = entries
    .filter((e) => e.listed && e.hasPage)
    .sort((a, b) => b.popularity.d30 - a.popularity.d30 || (a.id < b.id ? -1 : 1))
    .slice(0, SUGGEST_MAX);
  const index = buildSearchIndex({
    entries: top,
    categories,
    collections: [],
    generatedOn: meta.generatedOn,
    trendingMin: TRENDING_MIN_INSTALLS,
    iconBase,
  });
  // Suggestions are ranked by relevance only: dates and trends would be a fifth of the file.
  const suggest = { ...index, updated: index.updated.map(() => null), added: {}, trend: {} };
  return new Response(JSON.stringify(suggest), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
