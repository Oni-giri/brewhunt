// Everything the pages know about packages: the pipeline's data (data/site, from the `data`
// branch) joined with the editorial content (content/). Loaded once per build.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadContent,
  type Category,
  type Collection,
  type Content,
  type EditorsPick,
} from '../../scripts/content/schema.ts';
import type { History, Meta, Package, Tap, WindowCounts } from '../../scripts/data/types.ts';

export interface Entry extends Package {
  /** One line for lists: the editorial tagline, else Homebrew's description. */
  line: string | null;
  developer: string | null;
  keywords: string[];
  /** Category slugs, primary first. */
  categories: string[];
  /** Sub-category slug within the primary category. */
  subcategory: string | null;
  /** The library flag after content/overrides.yaml. */
  isLibrary: boolean;
  /** Has its own page at /app/<id>. */
  hasPage: boolean;
  /** Appears in discovery, charts and New (see docs/DECISIONS.md). */
  listed: boolean;
  /** Installs on request for formulae, installs for casks: what rankings use. */
  popularity: WindowCounts;
  url: string;
}

export interface Catalog {
  meta: Meta;
  entries: Entry[];
  byId: Map<string, Entry>;
  taps: Tap[];
  tapById: Map<string, Tap>;
  categories: Category[];
  categoryBySlug: Map<string, Category>;
  collections: Collection[];
  picks: EditorsPick[];
  history: History;
}

const DATA_DIR = join(process.cwd(), 'data', 'site');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as T;
}

/** Packages that get a page: installable and not a font (see docs/DECISIONS.md). */
export const hasPage = (p: Package) => !p.disabled && !p.font;

const linuxOnly = (p: Package) => p.platforms?.length === 1 && p.platforms[0] === 'linux';

export const appUrl = (id: string) => `/app/${id}`;

function build(): Catalog {
  if (!existsSync(join(DATA_DIR, 'packages.json'))) {
    throw new Error(
      'No data in data/site. Run `npm run data:pull` to fetch it from the data branch, or `npm run data` to build it.',
    );
  }
  const packages = readJson<Package[]>('packages.json');
  const content: Content = loadContent(join(process.cwd(), 'content'));
  const { overrides } = content;
  const libraryShow = new Set(overrides.library.show);
  const libraryHide = new Set(overrides.library.hide);
  const hidden = new Set(overrides.hidden);

  const categoriesOf = new Map<string, string[]>();
  const subOf = new Map<string, string>();
  for (const category of content.categories) {
    for (const { id, sub } of category.packages) {
      if (!categoriesOf.has(id)) {
        categoriesOf.set(id, []);
        if (sub) subOf.set(id, sub);
      }
      categoriesOf.get(id)!.push(category.slug);
    }
  }

  const entries = packages.map((p): Entry => {
    const editorial = content.packages[p.id] ?? {};
    const isLibrary =
      p.kind === 'formula' && !libraryShow.has(p.id) && (p.library || libraryHide.has(p.id));
    const page = hasPage(p);
    return {
      ...p,
      line: editorial.tagline ?? p.desc,
      developer: editorial.developer ?? null,
      keywords: editorial.keywords ?? [],
      categories: categoriesOf.get(p.id) ?? [],
      subcategory: subOf.get(p.id) ?? null,
      isLibrary,
      hasPage: page,
      listed:
        page && !p.deprecated && !p.versioned && !isLibrary && !hidden.has(p.id) && !linuxOnly(p),
      popularity: p.installsOnRequest ?? p.installs,
      url: appUrl(p.id),
    };
  });

  const taps = readJson<Tap[]>('taps.json');
  return {
    meta: readJson<Meta>('meta.json'),
    entries,
    byId: new Map(entries.map((e) => [e.id, e])),
    taps,
    tapById: new Map(taps.map((t) => [t.id, t])),
    categories: content.categories,
    categoryBySlug: new Map(content.categories.map((c) => [c.slug, c])),
    collections: content.collections,
    picks: content.picks,
    history: readJson<History>('history.json'),
  };
}

let catalog: Catalog | undefined;
export function getCatalog(): Catalog {
  catalog ??= build();
  return catalog;
}

// --- Lists ---

const byPopularity = (a: Entry, b: Entry) =>
  b.popularity.d30 - a.popularity.d30 || a.id.localeCompare(b.id);

/** Most installed in the last 30 days among listed packages matching `filter`. */
export function top(filter: (e: Entry) => boolean, limit: number): Entry[] {
  return getCatalog()
    .entries.filter((e) => e.listed && filter(e))
    .sort(byPopularity)
    .slice(0, limit);
}

/** Below this many 30-day installs a big percentage is a handful of people. */
export const TRENDING_MIN_INSTALLS = 500;

/** Biggest gains in share of installs, among packages with real volume. */
export function trending(filter: (e: Entry) => boolean, limit: number): Entry[] {
  return getCatalog()
    .entries.filter(
      (e) =>
        e.listed &&
        e.trend !== null &&
        e.trend.change > 0 &&
        e.popularity.d30 >= TRENDING_MIN_INSTALLS &&
        filter(e),
    )
    .sort((a, b) => b.trend!.change - a.trend!.change || byPopularity(a, b))
    .slice(0, limit);
}

/** Added in the `days` before the data's date, newest first. */
export function recentlyAdded(
  filter: (e: Entry) => boolean,
  days: number,
  limit = Infinity,
): Entry[] {
  const { meta } = getCatalog();
  const since = new Date(Date.parse(`${meta.generatedOn}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return getCatalog()
    .entries.filter((e) => e.listed && e.firstSeen !== null && e.firstSeen > since && filter(e))
    .sort((a, b) => b.firstSeen!.localeCompare(a.firstSeen!) || byPopularity(a, b))
    .slice(0, limit);
}

/** A category's packages in file order (the editors' order), resolved and with pages. */
export function categoryEntries(category: Category): Entry[] {
  const { byId } = getCatalog();
  return category.packages.map((p) => byId.get(p.id)).filter((e): e is Entry => !!e && e.hasPage);
}

export function collectionEntries(collection: Collection): Entry[] {
  const { byId } = getCatalog();
  return collection.packages.map((id) => byId.get(id)).filter((e): e is Entry => !!e && e.hasPage);
}

/** Position by 30-day popularity within the package's primary category (1-based). */
export function categoryRank(entry: Entry): { rank: number; category: Category } | null {
  const slug = entry.categories[0];
  const category = slug ? getCatalog().categoryBySlug.get(slug) : undefined;
  if (!category) return null;
  const ranked = categoryEntries(category).sort(byPopularity);
  const rank = ranked.findIndex((e) => e.id === entry.id) + 1;
  return rank > 0 ? { rank, category } : null;
}

/** Other packages from the same primary category, same sub-category first. */
export function similar(entry: Entry, limit = 4): Entry[] {
  const slug = entry.categories[0];
  const category = slug ? getCatalog().categoryBySlug.get(slug) : undefined;
  if (!category) return [];
  return categoryEntries(category)
    .filter((e) => e.id !== entry.id)
    .sort(
      (a, b) =>
        Number(b.subcategory === entry.subcategory) - Number(a.subcategory === entry.subcategory) ||
        byPopularity(a, b),
    )
    .slice(0, limit);
}

/** The newest editor's pick, optionally for one category. */
export function latestPick(categorySlug?: string): { pick: EditorsPick; entry: Entry } | null {
  const { picks, byId } = getCatalog();
  for (const pick of picks) {
    if (categorySlug && pick.category !== categorySlug) continue;
    const entry = byId.get(pick.id);
    if (entry?.hasPage) return { pick, entry };
  }
  return null;
}

export function pickFor(id: string): EditorsPick | null {
  return getCatalog().picks.find((p) => p.id === id) ?? null;
}

// --- Labels ---

/** "Mac app", "Command-line tool", "Linux app". */
export function kindLabel(p: Package): string {
  if (p.kind === 'formula') return 'Command-line tool';
  return linuxOnly(p) ? 'Linux app' : 'Mac app';
}

/** Readable licence: "MIT", "Public domain", or null when there's none or it's unwieldy. */
export function licenseLabel(p: Package): string | null {
  if (!p.license) return null;
  const label = p.license.replaceAll('LicenseRef-Homebrew-public-domain', 'Public domain');
  return label.length <= 40 ? label : null;
}

/** `brew upgrade` / `brew uninstall` for the package, matching its install command. */
export function brewCommand(p: Package, verb: 'install' | 'upgrade' | 'uninstall'): string {
  return p.installCommand.replace(/^brew install/, `brew ${verb}`);
}

/** Owner of a GitHub/GitLab/Codeberg homepage, used when nobody has named the developer. */
export function forgeOwner(url: string | null): string | null {
  const m = url?.match(
    /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)\/([^/?#]+)/i,
  );
  return m ? m[1] : null;
}

/** The source repository when the homepage is one. */
export function sourceRepo(url: string | null): string | null {
  const m = url?.match(
    /^(https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)\/[^/?#]+\/[^/?#]+)/i,
  );
  return m ? m[1].replace(/\.git$/, '') : null;
}

const kindRanks = new Map<string, number>();
/** Position by 30-day popularity among listed packages of the same kind (1-based). */
export function kindRank(entry: Entry): number | null {
  if (!entry.listed) return null;
  if (kindRanks.size === 0) {
    for (const kind of ['formula', 'cask'] as const) {
      top((e) => e.kind === kind, Infinity).forEach((e, i) => kindRanks.set(e.id, i + 1));
    }
  }
  return kindRanks.get(entry.id) ?? null;
}

/** Cask versions carry build numbers after a comma ("0.5.16,261015"); show the release part. */
export function displayVersion(p: Package): string | null {
  if (!p.version) return null;
  if (p.version === 'latest') return 'Latest (updates itself)';
  return p.version.split(',')[0];
}
