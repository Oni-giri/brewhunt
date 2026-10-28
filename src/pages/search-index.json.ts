// The search index, one JSON file built with the site and fetched only by /search. The page asks
// for it with ?v=<data date> so browsers pick up each day's rebuild. See src/lib/search-index.ts.
import { getCatalog, TRENDING_MIN_INSTALLS } from '../lib/catalog';
import { buildSearchIndex } from '../lib/search-index';

export function GET() {
  const { entries, categories, collections, meta } = getCatalog();
  const index = buildSearchIndex({
    entries,
    categories,
    collections,
    generatedOn: meta.generatedOn,
    trendingMin: TRENDING_MIN_INSTALLS,
  });
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
