// Search over the prebuilt index (/search-index.json, built by src/lib/search-index.ts; see
// docs/DECISIONS.md for why it isn't Pagefind). Pure functions shared by the search page's script
// and the tests: no DOM, no Node APIs. The page talks to it through `search()`.

// --- The index file ---

/** Bits of `SearchIndex.flags`. */
export const FLAG = {
  cask: 1,
  community: 2,
  library: 4,
  deprecated: 8,
  versioned: 16,
  linuxOnly: 32,
  /** In discovery, charts and New (Entry.listed). */
  listed: 64,
  /** A cask that installs only command-line programs (catalog.ts isCliCask). */
  cliCask: 128,
} as const;

/**
 * The file as built: one array per field, where row `i` of every array is package `i`, and a few
 * sparse fields keyed by row. Text is stored as written; the browser lowercases and splits it.
 */
export interface SearchIndex {
  version: 1;
  /** Date of the data (YYYY-MM-DD). */
  generatedOn: string;
  /** `generatedOn` as a day number (days since 1970-01-01), what "past month" counts back from. */
  today: number;
  /** Below this many 30-day installs a trend is a handful of people (catalog.ts). */
  trendingMin: number;
  /** In display order. `members` are row numbers, in the editors' order. */
  categories: { slug: string; name: string; members: number[] }[];
  collections: { slug: string; title: string; members: number[] }[];
  /** Package id: `wget`, `rectangle`, `hashicorp/tap/terraform`. Its last part is the token. */
  id: string[];
  /** Display name, or "" when it's the same as the token. */
  name: string[];
  /** One line for lists (tagline or Homebrew's description, at most 100 characters), or "". */
  line: string[];
  /** Other names: aliases, old names, cask alt names and editorial keywords, joined with "|". */
  alt: string[];
  /** FLAG bits. */
  flags: number[];
  /** Installs in the last 30 days (installs on request for formulae). */
  pop: number[];
  /** Day number the current version landed, or null when unknown. */
  updated: (number | null)[];
  /** Sparse: day number the package was added to its tap, when known. */
  added: Record<string, number>;
  /** Sparse: change in share of installs (0.42 = up 42%), when known. */
  trend: Record<string, number>;
  /** Sparse: the install command, only where it isn't `brew install [--cask] <id>`. */
  command: Record<string, string>;
}

export const DAY_MS = 86_400_000;
/** "2026-10-28" → days since 1970-01-01. */
export const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

// --- Text ---

/** Anything but printable ASCII (space to ~). */
const NON_ASCII = /[^ -~]/;

/** Lowercase, without accents, words separated by single spaces: "Visual-Studio Code" → "visual studio code". */
export function normalize(text: string): string {
  const s = text.toLowerCase();
  // Most of the catalog is plain ASCII, where a simple pattern does and decomposing is wasted.
  if (!NON_ASCII.test(s)) return s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `list` plus each of `more` that isn't empty or already in it. */
function addUnique(list: string[], ...more: string[]): string[] {
  for (const value of more) if (value && !list.includes(value)) list.push(value);
  return list;
}

/** " word word " for finding word starts (`' ' + w`) and whole words (`' ' + w + ' '`). */
const spaced = (...texts: string[]) => {
  const joined = texts.filter(Boolean).join(' ');
  return joined ? ` ${joined} ` : '';
};

// --- Prepared items ---

export interface Item {
  row: number;
  id: string;
  token: string;
  name: string;
  line: string;
  kind: 'formula' | 'cask';
  source: 'official' | 'community';
  library: boolean;
  deprecated: boolean;
  versioned: boolean;
  linuxOnly: boolean;
  listed: boolean;
  /** Installs only command-line programs: labelled and filtered with the tools. */
  cliCask: boolean;
  installs30: number;
  trend: number | null;
  added: number | null;
  updated: number | null;
  installCommand: string;
  /** Indexes into SearchData.categories, primary first. */
  categories: number[];
  // Matching, all normalized:
  /** Whole names that count as an exact match: id, token, name and every alt. */
  keys: string[];
  /** What 1–2 character queries match the start of: id, token and alts. */
  shortKeys: string[];
  /** Name and token, for "starts with". */
  heads: string[];
  /** " word word " strings, to find a word start with `includes(' ' + token)`. */
  nameWords: string;
  altWords: string;
  lineWords: string;
  /** Names of the categories the editors filed it in. */
  categoryWords: string;
}

export interface SearchData {
  index: SearchIndex;
  items: Item[];
  categories: SearchIndex['categories'];
  collections: SearchIndex['collections'];
  /** Position of each row in each collection, by collection slug. */
  collectionOrder: Map<string, Map<number, number>>;
}

/** Turns the file into items ready to match (lowercasing and splitting happen here, once). */
export function prepare(index: SearchIndex): SearchData {
  const categoryNames = index.categories.map((c) => normalize(c.name));
  const categoriesOf = new Map<number, number[]>();
  index.categories.forEach((category, c) => {
    for (const row of category.members) {
      if (!categoriesOf.has(row)) categoriesOf.set(row, []);
      categoriesOf.get(row)!.push(c);
    }
  });

  const items = index.id.map((id, row): Item => {
    const flags = index.flags[row];
    const token = id.slice(id.lastIndexOf('/') + 1);
    const name = index.name[row] || token;
    const alts = index.alt[row] ? index.alt[row].split('|') : [];
    const kind = flags & FLAG.cask ? 'cask' : 'formula';
    const normToken = normalize(token);
    const normId = id === token ? normToken : normalize(id);
    const normName = name === token ? normToken : normalize(name);
    const normAlts = alts.map(normalize);
    const categories = categoriesOf.get(row) ?? [];
    return {
      row,
      id,
      token,
      name,
      line: index.line[row],
      kind,
      source: flags & FLAG.community ? 'community' : 'official',
      library: !!(flags & FLAG.library),
      deprecated: !!(flags & FLAG.deprecated),
      versioned: !!(flags & FLAG.versioned),
      linuxOnly: !!(flags & FLAG.linuxOnly),
      listed: !!(flags & FLAG.listed),
      cliCask: !!(flags & FLAG.cliCask),
      installs30: index.pop[row],
      trend: index.trend[row] ?? null,
      added: index.added[row] ?? null,
      updated: index.updated[row],
      installCommand: index.command[row] ?? `brew install ${kind === 'cask' ? '--cask ' : ''}${id}`,
      categories,
      keys: addUnique([normToken], normId, normName, ...normAlts),
      shortKeys: addUnique([normToken], normId, ...normAlts),
      heads: normName === normToken ? [normName] : [normName, normToken],
      nameWords: spaced(normName, normName === normToken ? '' : normToken),
      altWords: normAlts.length ? spaced(...normAlts) : '',
      lineWords: spaced(normalize(index.line[row])),
      categoryWords: categories.length ? spaced(...categories.map((c) => categoryNames[c])) : '',
    };
  });

  const collectionOrder = new Map(
    index.collections.map((c) => [c.slug, new Map(c.members.map((row, i) => [row, i]))]),
  );
  return {
    index,
    items,
    categories: index.categories,
    collections: index.collections,
    collectionOrder,
  };
}

/** "Command-line tool", "Mac app" or "Linux app", as catalog.ts's kindLabel. */
export const kindLabel = (item: Item) =>
  item.kind === 'formula' || item.cliCask
    ? 'Command-line tool'
    : item.linuxOnly
      ? 'Linux app'
      : 'Mac app';

// --- Scoring ---

export interface Query {
  /** Normalized: "window manager". */
  text: string;
  tokens: string[];
  /** 1–2 characters: only ids, aliases and keywords that start with it match. */
  short: boolean;
  /** Has "@" or a digit: someone after a specific version, so don't rank versioned ones lower. */
  wantsVersion: boolean;
}

export function parseQuery(raw: string): Query {
  const text = normalize(raw);
  return {
    text,
    tokens: text ? text.split(' ') : [],
    short: text.length > 0 && text.length <= 2,
    wantsVersion: /[@\d]/.test(raw),
  };
}

/** Points for one query word, best match only. */
export const TIER = {
  /** Equals the id, token, name, an alias, an old name or a keyword. */
  exact: 1000,
  /** The name or token starts with it, or it's a whole word of the name ("chrome" in Google Chrome). */
  namePrefix: 600,
  /**
   * A word in the name of a category the editors filed it in starts with it: "window" finds
   * Rectangle and AltTab (Windows & desktop) as surely as apps with "window" in their name.
   */
  category: 600,
  /** A word in the name or token starts with it. */
  nameWord: 400,
  /** A word in an alias, alt name or keyword starts with it. */
  altWord: 300,
  /** A word in the description starts with it. */
  lineWord: 100,
} as const;

export function tokenScore(item: Item, token: string): number {
  if (item.keys.includes(token)) return TIER.exact;
  if (item.heads.some((h) => h.startsWith(token)) || item.nameWords.includes(` ${token} `))
    return TIER.namePrefix;
  if (item.categoryWords.includes(` ${token}`)) return TIER.category;
  if (item.nameWords.includes(` ${token}`)) return TIER.nameWord;
  if (item.altWords.includes(` ${token}`)) return TIER.altWord;
  if (item.lineWords.includes(` ${token}`)) return TIER.lineWord;
  return 0;
}

/** Popular packages first among similar matches: 10 installs ≈ 40 points, 100k ≈ 200. */
export const popularityBoost = (installs30: number) => Math.log10(installs30 + 1) * 40;

/**
 * Searchable, but below the packages most people are looking for. Typing a library's or a
 * versioned formula's exact name or alias (`openssl`, `python`, `postgres`) asks for that one:
 * Homebrew points those aliases at the current version, so they keep their rank.
 */
export function penalty(item: Item, query: Query, exact: boolean): number {
  let factor = 1;
  if (item.deprecated) factor *= 0.5;
  if (item.linuxOnly) factor *= 0.7;
  if (item.library && !exact) factor *= 0.7;
  if (item.versioned && !exact && !query.wantsVersion) factor *= 0.8;
  return factor;
}

/**
 * How well `item` matches: 0 when it doesn't. `every` requires each word to match (the normal
 * case); without it, any word will do (the fallback when that finds almost nothing).
 */
export function score(item: Item, query: Query, every = true): number {
  let base = 0;
  const exact = (query.short ? item.shortKeys : item.keys).includes(query.text);
  if (query.short) {
    if (exact) base = TIER.exact;
    else if (item.shortKeys.some((k) => k.startsWith(query.text))) base = TIER.namePrefix;
  } else if (exact && query.tokens.length > 1) {
    // The whole query is one of its names: "visual studio code", "postgresql 17".
    base = TIER.exact * query.tokens.length;
  } else {
    for (const token of query.tokens) {
      const points = tokenScore(item, token);
      if (points === 0 && every) return 0;
      // A stray 1–2 letter word would match half the catalog when any word will do.
      if (!every && token.length < 3 && points < TIER.exact) continue;
      base += points;
    }
  }
  if (base === 0) return 0;
  return (base + popularityBoost(item.installs30)) * penalty(item, query, exact);
}

// --- Filters, sorts, state ---

export const TYPES = ['all', 'mac', 'cli'] as const;
export const SOURCES = ['all', 'official', 'community'] as const;
export const UPDATED = ['any', 'month', 'year'] as const;
export const SORTS = ['relevance', 'installs', 'trending', 'newest', 'updated'] as const;
export type TypeFilter = (typeof TYPES)[number];
export type SourceFilter = (typeof SOURCES)[number];
export type UpdatedFilter = (typeof UPDATED)[number];
export type Sort = (typeof SORTS)[number];

export interface Filters {
  type: TypeFilter;
  source: SourceFilter;
  updated: UpdatedFilter;
  /** Category slugs; a package in any of them matches. */
  categories: string[];
  /** Collection slug. */
  collection: string | null;
}

export interface SearchState extends Filters {
  q: string;
  sort: Sort;
}

export const DEFAULT_STATE: SearchState = {
  q: '',
  type: 'all',
  source: 'all',
  updated: 'any',
  categories: [],
  collection: null,
  sort: 'relevance',
};

/** Days back for each "Updated" choice. */
const UPDATED_DAYS: Record<UpdatedFilter, number> = { any: Infinity, month: 30, year: 365 };

/** Results per "Show more". */
export const PAGE_SIZE = 20;

/** Fewer hits than this with every word required: fall back to any word. */
export const FALLBACK_BELOW = 3;

export interface Results {
  items: Item[];
  /** Per category (same order as SearchData.categories): matches if it were ticked. */
  categoryCounts: number[];
  /** `browse`: empty query. `every`: each word matched. `any`: the fallback. */
  mode: 'browse' | 'every' | 'any';
}

const byInstalls = (a: Item, b: Item) =>
  b.installs30 - a.installs30 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Known values first, newest or biggest first; unknowns after, most installed first. */
const byKnown =
  (value: (item: Item) => number | null, include: (item: Item) => boolean = () => true) =>
  (a: Item, b: Item) => {
    const va = include(a) ? value(a) : null;
    const vb = include(b) ? value(b) : null;
    if (va !== null && vb !== null) return vb - va || byInstalls(a, b);
    if (va !== null) return -1;
    if (vb !== null) return 1;
    return byInstalls(a, b);
  };

export function search(data: SearchData, rawQuery: string, filters: Filters, sort: Sort): Results {
  const query = parseQuery(rawQuery);
  const { index } = data;
  const cats = new Set(
    filters.categories.map((slug) => data.categories.findIndex((c) => c.slug === slug)),
  );
  cats.delete(-1);
  const collection = filters.collection ? data.collectionOrder.get(filters.collection) : undefined;
  const oldest = index.today - UPDATED_DAYS[filters.updated];

  // Everything but the category filter, which the counts need to ignore.
  const passes = (item: Item) =>
    (filters.type === 'all' ||
      (filters.type === 'mac'
        ? item.kind === 'cask' && !item.cliCask && !item.linuxOnly
        : item.kind === 'formula' || item.cliCask)) &&
    (filters.source === 'all' || item.source === filters.source) &&
    (filters.updated === 'any' || (item.updated !== null && item.updated >= oldest)) &&
    (!filters.collection || !!collection?.has(item.row));

  let mode: Results['mode'] = 'browse';
  const scores = new Map<Item, number>();
  let candidates: Item[];
  if (query.tokens.length === 0) {
    candidates = data.items;
  } else {
    const match = (every: boolean) => {
      scores.clear();
      for (const item of data.items) {
        const s = score(item, query, every);
        if (s > 0) scores.set(item, s);
      }
    };
    mode = 'every';
    match(true);
    if (scores.size < FALLBACK_BELOW && query.tokens.length > 1) {
      mode = 'any';
      match(false);
    }
    candidates = [...scores.keys()];
  }

  const categoryCounts = data.categories.map(() => 0);
  const items: Item[] = [];
  for (const item of candidates) {
    if (!passes(item)) continue;
    for (const c of item.categories) categoryCounts[c]++;
    const inCategory = cats.size === 0 || item.categories.some((c) => cats.has(c));
    if (!inCategory) continue;
    // Browsing shows what the store lists, plus whatever the editors put in the chosen
    // collection or categories. A query reaches everything.
    if (mode === 'browse' && !item.listed && !collection?.has(item.row) && cats.size === 0)
      continue;
    items.push(item);
  }

  items.sort(comparator(sort, mode, scores, collection, index.trendingMin));
  return { items, categoryCounts, mode };
}

function comparator(
  sort: Sort,
  mode: Results['mode'],
  scores: Map<Item, number>,
  collection: Map<number, number> | undefined,
  trendingMin: number,
): (a: Item, b: Item) => number {
  switch (sort) {
    case 'installs':
      return byInstalls;
    case 'trending':
      // Same rule as the charts: a trend only counts with real volume behind it.
      return byKnown(
        (i) => i.trend,
        (i) => i.installs30 >= trendingMin,
      );
    case 'newest':
      return byKnown((i) => i.added);
    case 'updated':
      return byKnown((i) => i.updated);
    case 'relevance':
      if (mode !== 'browse') return (a, b) => scores.get(b)! - scores.get(a)! || byInstalls(a, b);
      // An empty query in a collection keeps the editors' order.
      if (collection) return (a, b) => collection.get(a.row)! - collection.get(b.row)!;
      return byInstalls;
  }
}

// --- URL ---

const oneOf = <T extends string>(values: readonly T[], value: string | null, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

/** Reads ?q, type, source, updated, cat (repeatable or comma-separated), collection and sort. */
export function readState(params: URLSearchParams): SearchState {
  const categories = params
    .getAll('cat')
    .flatMap((value) => value.split(','))
    .map((slug) => slug.trim())
    .filter(Boolean);
  return {
    q: (params.get('q') ?? '').trim(),
    type: oneOf(TYPES, params.get('type'), 'all'),
    source: oneOf(SOURCES, params.get('source'), 'all'),
    updated: oneOf(UPDATED, params.get('updated'), 'any'),
    categories: [...new Set(categories)],
    collection: params.get('collection')?.trim() || null,
    sort: oneOf(SORTS, params.get('sort'), 'relevance'),
  };
}

/** The query string for a state, leaving out defaults so shared links stay short. */
export function writeState(state: SearchState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.type !== 'all') params.set('type', state.type);
  if (state.source !== 'all') params.set('source', state.source);
  if (state.updated !== 'any') params.set('updated', state.updated);
  for (const slug of state.categories) params.append('cat', slug);
  if (state.collection) params.set('collection', state.collection);
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  return params;
}
