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
import type { IconSet } from '../../scripts/data/icons.ts';
import type { History, Meta, Package, Tap, WindowCounts } from '../../scripts/data/types.ts';
import { iconBase, iconUrl } from './tiles.ts';

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
  /**
   * A command-line tool rather than an app: every formula, and casks that install only
   * command-line programs or that content/packages.yaml says are `type: cli`.
   */
  commandLine: boolean;
  /** Has its own page at /app/<id>. */
  hasPage: boolean;
  /** Appears in discovery, charts and New (see docs/DECISIONS.md). */
  listed: boolean;
  /** Installs on request for formulae, installs for casks: what rankings use. */
  popularity: WindowCounts;
  url: string;
  /** The app's real icon (official casks CaskFlow has one for), else null for a tile. */
  icon: string | null;
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
  /** Where the real icons are (tiles.ts iconBase), or null without icon data. */
  iconBase: string | null;
}

const DATA_DIR = join(process.cwd(), 'data', 'site');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as T;
}

/** Packages that get a page: installable and not a font (see docs/DECISIONS.md). */
export const hasPage = (p: Package) => !p.disabled && !p.font;

const linuxOnly = (p: Pick<Package, 'platforms'>) =>
  p.platforms?.length === 1 && p.platforms[0] === 'linux';

export const appUrl = (id: string) => `/app/${id}`;

/** The tap's page, if it has one (the pipeline read it and it lists packages with pages). */
export function tapUrl(tapId: string): string | null {
  const tap = getCatalog().tapById.get(tapId);
  if (!tap?.enriched) return null;
  return tap.packageIds.some((id) => getCatalog().byId.get(id)?.hasPage) ? `/tap/${tap.id}` : null;
}

/**
 * Versioned casks often share their app's name (every `aerospace@0.x` cask is "AeroSpace"),
 * so add the version when the name doesn't already say it.
 */
function displayName(p: Package): string {
  const at = p.token.indexOf('@');
  if (p.kind !== 'cask' || at < 0) return p.name;
  const suffix = p.token.slice(at + 1);
  return p.name.toLowerCase().includes(suffix.toLowerCase()) ? p.name : `${p.name} (${suffix})`;
}

/**
 * The real icon's URL, for official casks CaskFlow has one for (it covers homebrew/cask only: a
 * community tap's `firefox` is someone else's app).
 */
export function iconFor(
  base: string | null,
  tokens: ReadonlySet<string>,
  p: Pick<Package, 'kind' | 'source' | 'token'>,
): string | null {
  return base && p.kind === 'cask' && p.source === 'official' && tokens.has(p.token)
    ? iconUrl(base, p.token)
    : null;
}

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
  // Optional: data from before icons existed builds with tiles only.
  const icons = existsSync(join(DATA_DIR, 'icons.json')) ? readJson<IconSet>('icons.json') : null;
  const iconTokens = new Set(icons?.tokens);
  const iconsAt = icons ? iconBase(icons.commit) : null;

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
      // Data from before repositories were looked up has no field.
      repo: p.repo ?? null,
      commandLine:
        p.kind === 'formula' ||
        (editorial.type ? editorial.type === 'cli' : installsOnlyPrograms(p)),
      name: editorial.name ?? displayName(p),
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
      icon: iconFor(iconsAt, iconTokens, p),
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
    iconBase: iconsAt,
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

// Cask artifacts that put something app-like on the Mac (as opposed to `binary`, man pages,
// shell completions or an install script). A .pkg installer can hold either an app or tools,
// so it counts as an app unless content/packages.yaml says `type: cli`.
const APP_ARTIFACTS = new Set([
  'app',
  'pkg',
  'suite',
  'prefpane',
  'qlplugin',
  'mdimporter',
  'screen_saver',
  'service',
  'colorpicker',
  'dictionary',
  'input_method',
  'internet_plugin',
  'keyboard_layout',
  'audio_unit_plugin',
  'vst_plugin',
  'vst3_plugin',
  'font',
]);

/** A cask that installs command-line programs and nothing app-like (`dtctl`, `gcloud-cli`). */
const installsOnlyPrograms = (p: Package) =>
  p.kind === 'cask' &&
  p.artifacts.includes('binary') &&
  !p.artifacts.some((a) => APP_ARTIFACTS.has(a));

type Typed = Pick<Entry, 'kind' | 'commandLine' | 'platforms'>;

/** "Mac app", "Command-line tool", "Linux app". */
export function kindLabel(p: Typed): string {
  if (p.commandLine) return 'Command-line tool';
  return linuxOnly(p) ? 'Linux app' : 'Mac app';
}

/** Mac apps for lists: casks that install an app (or don't say), not command-line casks. */
export const isMacApp = (p: Typed) => p.kind === 'cask' && !p.commandLine;
/** Command-line tools for lists: formulae and command-line casks. */
export const isCommandLine = (p: Typed) => p.commandLine;

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

/**
 * Issues page of a homepage repository (sourceRepo): GitLab's under `/-/issues`, Codeberg's under
 * `/issues`. GitHub's comes from the data job's repository check instead, so null here.
 */
export function forgeIssues(repo: string): string | null {
  const host = new URL(repo).hostname;
  if (host === 'gitlab.com') return `${repo}/-/issues`;
  if (host === 'codeberg.org') return `${repo}/issues`;
  return null;
}

/** The source repository when the homepage is one. */
export function sourceRepo(url: string | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);
  let path: string[];
  if (host === 'github.com' || host === 'codeberg.org') {
    path = parts.slice(0, 2);
  } else if (host === 'gitlab.com') {
    // GitLab nests groups (gitlab.com/sane-project/frontend/xsane); `/-/` starts the page part.
    const end = parts.indexOf('-');
    path = end === -1 ? parts : parts.slice(0, end);
  } else {
    return null;
  }
  if (path.length < 2) return null;
  return `https://${host}/${path.join('/')}`.replace(/\.git$/, '');
}

const kindRanks = new Map<string, number>();
/**
 * Position by 30-day popularity among listed packages of the same type (1-based), and that
 * group's name: "Mac apps" or "command-line tools".
 */
export function kindRank(entry: Entry): { rank: number; group: string } | null {
  if (!entry.listed) return null;
  if (kindRanks.size === 0) {
    for (const filter of [isMacApp, isCommandLine]) {
      top(filter, Infinity).forEach((e, i) => kindRanks.set(e.id, i + 1));
    }
  }
  const rank = kindRanks.get(entry.id);
  if (!rank) return null;
  return { rank, group: entry.commandLine ? 'command-line tools' : 'Mac apps' };
}

/** Cask versions carry build numbers after a comma ("0.5.16,261015"); show the release part. */
export function displayVersion(p: Package): string | null {
  if (!p.version) return null;
  if (p.version === 'latest') return 'Latest (updates itself)';
  return p.version.split(',')[0];
}
