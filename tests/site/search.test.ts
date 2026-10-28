import { describe, expect, it } from 'vitest';
import { buildSearchIndex, clip, type IndexEntry } from '../../src/lib/search-index.ts';
import {
  DEFAULT_STATE,
  FLAG,
  normalize,
  prepare,
  readState,
  search,
  writeState,
  type Filters,
  type Sort,
} from '../../src/lib/search.ts';

const ICON_BASE =
  'https://cdn.jsdelivr.net/gh/alielsokary/CaskFlow@0123456789abcdef0123456789abcdef01234567/';

// A small catalog with the shapes that matter: install counts are rounded from real data.
function entry(id: string, fields: Partial<IndexEntry> = {}): IndexEntry {
  const token = id.slice(id.lastIndexOf('/') + 1);
  const kind = fields.kind ?? 'formula';
  const versioned = fields.versioned ?? false;
  const isLibrary = fields.isLibrary ?? false;
  const deprecated = fields.deprecated ?? false;
  return {
    id,
    kind,
    source: id.includes('/') ? 'community' : 'official',
    token,
    name: token,
    line: null,
    aliases: [],
    oldNames: [],
    altNames: [],
    keywords: [],
    isLibrary,
    deprecated,
    versioned,
    platforms: null,
    commandLine: kind === 'formula',
    listed: !versioned && !isLibrary && !deprecated,
    hasPage: true,
    popularity: { d30: 0, d90: 0, d365: 0 },
    trend: null,
    firstSeen: null,
    updatedAt: null,
    updatedKind: null,
    installCommand: `brew install ${kind === 'cask' ? '--cask ' : ''}${id}`,
    icon: null,
    ...fields,
  };
}
const installs = (d30: number) => ({ popularity: { d30, d90: d30 * 3, d365: d30 * 12 } });
const cask = (
  id: string,
  name: string,
  line: string,
  d30: number,
  more: Partial<IndexEntry> = {},
) => entry(id, { kind: 'cask', name, line, ...installs(d30), ...more });
const formula = (id: string, line: string, d30: number, more: Partial<IndexEntry> = {}) =>
  entry(id, { line, ...installs(d30), ...more });

const entries: IndexEntry[] = [
  cask('firefox', 'Mozilla Firefox', 'Web browser', 13_945, {
    updatedAt: '2026-10-27',
    updatedKind: 'version',
  }),
  cask('firefox@nightly', 'Mozilla Firefox Nightly', 'Web browser', 223, { versioned: true }),
  formula('firebase-cli', 'Firebase command-line tools', 4_731),
  formula('firefoxpwa', 'Tool to install, manage and use Progressive Web Apps', 461),
  cask('google-chrome', 'Google Chrome', 'Web browser', 25_221),
  cask('chrome-remote-desktop-host', 'Chrome Remote Desktop', 'Remote access', 287),
  cask('rectangle', 'Rectangle', 'Move and resize windows using keyboard shortcuts', 9_782, {
    updatedAt: '2026-10-20',
    updatedKind: 'version',
    icon: `${ICON_BASE}rectangle.png`,
  }),
  cask('nikitabobko/tap/aerospace', 'AeroSpace', 'i3-like tiling window manager', 5_161, {
    trend: { change: 0.42, basis: 'previous-60-days-average' },
  }),
  cask('omniwm', 'OmniWM', 'Tiling window manager', 1_412, {
    firstSeen: '2026-10-01',
    trend: { change: 1.5, basis: 'previous-60-days-average' },
    updatedAt: '2026-08-01',
    updatedKind: 'version',
  }),
  cask('amethyst', 'Amethyst', 'Automatic tiling window manager', 678, {
    updatedAt: '2025-06-01',
    updatedKind: 'version',
  }),
  cask('hazeover', 'HazeOver', 'Windows manager and desktop organiser', 78, {
    firstSeen: '2026-10-20',
    trend: { change: 3, basis: 'previous-60-days-average' },
  }),
  formula('ripgrep', 'Search file contents recursively', 38_075, {
    aliases: ['rg'],
    updatedAt: '2026-10-25',
    updatedKind: 'file',
  }),
  formula('ripgrep-all', 'Wrapper around ripgrep for PDFs and archives', 490),
  formula('rgbds', 'Rednex GameBoy Development System', 152),
  formula('grep', 'GNU grep, egrep and fgrep', 9_000),
  formula('hashicorp/tap/terraform', 'Terraform', 23_070, { keywords: ['tf'] }),
  formula('terraform-docs', 'Generate documentation from Terraform modules', 4_402),
  formula('opentofu', 'Drop-in replacement for Terraform', 3_000),
  formula('postgresql@18', 'Object-relational database system', 15_973, {
    aliases: ['postgres', 'postgresql'],
    versioned: true,
  }),
  formula('postgresql@17', 'Object-relational database system', 16_545, { versioned: true }),
  cask('postgres-app', 'Postgres', 'App wrapper for Postgres', 829, {
    oldNames: ['postgres-unofficial'],
  }),
  formula('postgrest', 'Serves a RESTful API from any Postgres database', 600),
  formula('libpng', 'Library for manipulating PNG images', 2_000, { isLibrary: true }),
  formula('pngquant', 'PNG image optimizer', 300),
  formula('youtube-dl', 'Download videos from YouTube', 5_000, { deprecated: true }),
  formula('yt-dlp', 'Feature-rich command-line audio/video downloader', 40_000, {
    keywords: ['youtube-dl'],
  }),
  cask('linux-only-app', 'Penguin Viewer', 'Image viewer', 50_000, {
    platforms: ['linux'],
    listed: false,
  }),
  cask('dtctl', 'dtctl', 'Dynatrace from your terminal', 100, { commandLine: true }),
  cask('café', 'Café Ünïcode', 'Accented name', 10),
  cask('fontless', 'Disabled thing', 'No page', 99_999, { hasPage: false }),
];

const categories = [
  {
    slug: 'windows-desktop',
    name: 'Windows & desktop',
    packages: [
      { id: 'rectangle' },
      { id: 'nikitabobko/tap/aerospace' },
      { id: 'amethyst' },
      { id: 'omniwm' },
    ],
  },
  { slug: 'browsers', name: 'Browsers', packages: [{ id: 'firefox' }, { id: 'google-chrome' }] },
  {
    slug: 'terminal-tools',
    name: 'Terminal tools',
    packages: [{ id: 'ripgrep' }, { id: 'postgresql@18' }, { id: 'missing-package' }],
  },
];
const collections = [
  {
    slug: 'set-up-a-new-mac',
    title: 'Set up a new Mac',
    packages: ['amethyst', 'rectangle', 'firefox', 'ripgrep'],
  },
];

const index = buildSearchIndex({
  entries,
  categories,
  collections,
  generatedOn: '2026-10-28',
  trendingMin: 500,
  iconBase: ICON_BASE,
});
const data = prepare(JSON.parse(JSON.stringify(index)));

const noFilters: Filters = { ...DEFAULT_STATE };
const ids = (q: string, filters: Partial<Filters> = {}, sort: Sort = 'relevance') =>
  search(data, q, { ...noFilters, ...filters }, sort).items.map((i) => i.id);

describe('normalize', () => {
  it('lowercases, strips accents and splits on separators', () => {
    expect(normalize('Visual-Studio Code')).toBe('visual studio code');
    expect(normalize('postgresql@17')).toBe('postgresql 17');
    expect(normalize('hashicorp/tap/terraform')).toBe('hashicorp tap terraform');
    expect(normalize('  Café_Ünïcode.app ')).toBe('cafe unicode app');
  });
});

describe('buildSearchIndex', () => {
  it('has one row per package with a page', () => {
    expect(index.id).toHaveLength(entries.length - 1);
    expect(index.id).not.toContain('fontless');
  });

  it('stores names only when they differ from the token, and keeps lines short', () => {
    const row = (id: string) => index.id.indexOf(id);
    expect(index.name[row('ripgrep')]).toBe('');
    expect(index.name[row('firefox')]).toBe('Mozilla Firefox');
    expect(clip('word '.repeat(40).trim())).toHaveLength(95);
    expect(clip('word '.repeat(40).trim()).endsWith('word…')).toBe(true);
    expect(clip('short')).toBe('short');
  });

  it('packs alternative names, flags and dates', () => {
    const row = (id: string) => index.id.indexOf(id);
    expect(index.alt[row('postgres-app')]).toBe('postgres-unofficial');
    expect(index.alt[row('yt-dlp')]).toBe('youtube-dl');
    expect(index.flags[row('nikitabobko/tap/aerospace')]).toBe(
      FLAG.cask | FLAG.community | FLAG.listed,
    );
    expect(index.flags[row('libpng')]).toBe(FLAG.library);
    expect(index.flags[row('rectangle')]).toBe(FLAG.cask | FLAG.listed | FLAG.icon);
    expect(index.flags[row('linux-only-app')]).toBe(FLAG.cask | FLAG.linuxOnly);
    // Only a version date counts as an update.
    expect(index.updated[row('firefox')]).toBe(index.today - 1);
    expect(index.updated[row('ripgrep')]).toBeNull();
    expect(index.added).toEqual({
      [row('omniwm')]: index.today - 27,
      [row('hazeover')]: index.today - 8,
    });
    expect(index.trend[row('omniwm')]).toBe(1.5);
  });

  it('maps categories and collections to rows in the editors’ order', () => {
    const rows = (members: number[]) => members.map((m) => index.id[m]);
    expect(rows(index.categories[0].members)).toEqual([
      'rectangle',
      'nikitabobko/tap/aerospace',
      'amethyst',
      'omniwm',
    ]);
    expect(rows(index.categories[2].members)).toEqual(['ripgrep', 'postgresql@18']);
    expect(rows(index.collections[0].members)).toEqual([
      'amethyst',
      'rectangle',
      'firefox',
      'ripgrep',
    ]);
  });

  it('round-trips install commands', () => {
    for (const item of data.items) {
      expect(item.installCommand).toBe(entries.find((e) => e.id === item.id)!.installCommand);
    }
  });

  it('round-trips icons, from the flag and one shared base', () => {
    for (const item of data.items) {
      expect(item.icon).toBe(entries.find((e) => e.id === item.id)!.icon);
    }
    expect(JSON.stringify(index)).not.toContain('rectangle.png');
  });
});

describe('search ranking', () => {
  it('puts Firefox first for “fire”', () => {
    expect(ids('fire')[0]).toBe('firefox');
    expect(ids('fire')).toContain('firebase-cli');
  });

  it('ranks window managers by popularity, and only those', () => {
    expect(ids('window manager')).toEqual([
      'nikitabobko/tap/aerospace',
      'omniwm',
      'amethyst',
      'hazeover',
    ]);
  });

  it('finds ripgrep by its Homebrew alias “rg”', () => {
    const results = ids('rg');
    expect(results[0]).toBe('ripgrep');
    // Short queries match the start of ids and aliases, not descriptions.
    expect(results).toContain('rgbds');
    expect(results).not.toContain('ripgrep-all');
    expect(results).not.toContain('grep');
  });

  it('finds the community terraform now that core terraform is gone', () => {
    expect(ids('terraform')[0]).toBe('hashicorp/tap/terraform');
    expect(ids('tf')[0]).toBe('hashicorp/tap/terraform');
  });

  it('puts a postgresql formula first for “postgres”', () => {
    expect(ids('postgres')[0]).toBe('postgresql@18');
    expect(ids('postgres')).toContain('postgres-app');
  });

  it('counts a whole word of the name like a prefix', () => {
    expect(ids('chrome')[0]).toBe('google-chrome');
  });

  it('counts the editors’ categories like a name', () => {
    // Rectangle only says "windows" in its description, but it's filed in Windows & desktop.
    expect(ids('window').slice(0, 4)).toEqual([
      'rectangle',
      'nikitabobko/tap/aerospace',
      'omniwm',
      'amethyst',
    ]);
    expect(ids('browser')).toEqual(['google-chrome', 'firefox', 'firefox@nightly']);
  });

  it('ranks versioned, deprecated, library and Linux-only packages lower', () => {
    expect(ids('firefox')).toEqual(['firefox', 'firefoxpwa', 'firefox@nightly']);
    expect(ids('youtube')[0]).toBe('yt-dlp');
    expect(ids('png')).toEqual(['pngquant', 'libpng']);
    expect(ids('viewer')).toEqual(['linux-only-app']);
  });

  it('keeps versioned formulae when the query names a version', () => {
    expect(ids('postgresql@17')[0]).toBe('postgresql@17');
    expect(ids('firefox nightly')[0]).toBe('firefox@nightly');
  });

  it('matches accented names without accents', () => {
    expect(ids('cafe unicode')).toEqual(['café']);
  });

  it('falls back to any word when every word finds too little', () => {
    const every = search(data, 'tiling window', noFilters, 'relevance');
    expect(every.mode).toBe('every');
    const any = search(data, 'tiling zzzz', noFilters, 'relevance');
    expect(any.mode).toBe('any');
    expect(any.items.map((i) => i.id)).toEqual(['nikitabobko/tap/aerospace', 'omniwm', 'amethyst']);
    expect(ids('zzzzqqq')).toEqual([]);
  });
});

describe('filters and sorts', () => {
  it('browses listed packages by popularity when the query is empty', () => {
    const results = ids('');
    expect(results.slice(0, 3)).toEqual(['yt-dlp', 'ripgrep', 'google-chrome']);
    for (const hidden of ['firefox@nightly', 'libpng', 'youtube-dl', 'linux-only-app'])
      expect(results).not.toContain(hidden);
  });

  it('filters by type and source', () => {
    expect(ids('', { type: 'mac', source: 'community' })).toEqual(['nikitabobko/tap/aerospace']);
    expect(ids('viewer', { type: 'mac' })).toEqual([]);
    // A cask that only installs command-line programs counts as a command-line tool.
    expect(ids('dynatrace', { type: 'cli' })).toEqual(['dtctl']);
    expect(ids('dynatrace', { type: 'mac' })).toEqual([]);
    expect(ids('terraform', { type: 'cli', source: 'official' })).toEqual([
      'terraform-docs',
      'opentofu',
    ]);
  });

  it('filters by update date, leaving out packages without a known version date', () => {
    expect(ids('', { updated: 'month' })).toEqual(['firefox', 'rectangle']);
    expect(ids('', { updated: 'year' })).toEqual(['firefox', 'rectangle', 'omniwm']);
    expect(ids('ripgrep', { updated: 'year' })).toEqual([]);
  });

  it('filters by categories (any of them) and counts each category', () => {
    const results = search(data, '', { ...noFilters, categories: ['browsers'] }, 'installs');
    expect(results.items.map((i) => i.id)).toEqual(['google-chrome', 'firefox']);
    expect(results.categoryCounts).toEqual([4, 2, 2]);
    expect(
      ids('', { categories: ['browsers', 'windows-desktop'] }, 'installs').slice(0, 3),
    ).toEqual(['google-chrome', 'firefox', 'rectangle']);
    // A ticked category shows everything the editors put in it, listed or not.
    expect(ids('', { categories: ['terminal-tools'] })).toEqual(['ripgrep', 'postgresql@18']);
  });

  it('keeps a collection in the editors’ order', () => {
    expect(ids('', { collection: 'set-up-a-new-mac' })).toEqual([
      'amethyst',
      'rectangle',
      'firefox',
      'ripgrep',
    ]);
    expect(ids('', { collection: 'set-up-a-new-mac' }, 'installs')[0]).toBe('ripgrep');
    expect(ids('', { collection: 'no-such-collection' })).toEqual([]);
  });

  it('sorts by trend only with enough installs behind it, unknowns last', () => {
    const results = ids('window', {}, 'trending');
    expect(results.slice(0, 2)).toEqual(['omniwm', 'nikitabobko/tap/aerospace']);
    // HazeOver's +300% is 78 installs: it goes with the unknowns, by popularity.
    expect(results.at(-1)).toBe('hazeover');
  });

  it('sorts by newest and recently updated with unknown dates last', () => {
    expect(ids('window', {}, 'newest').slice(0, 2)).toEqual(['hazeover', 'omniwm']);
    expect(ids('', {}, 'updated').slice(0, 4)).toEqual([
      'firefox',
      'rectangle',
      'omniwm',
      'amethyst',
    ]);
  });
});

describe('URL state', () => {
  it('reads every parameter and ignores unknown values', () => {
    const state = readState(
      new URLSearchParams(
        'q=+window+&type=mac&source=nope&updated=year&cat=browsers,windows-desktop&cat=browsers&collection=set-up-a-new-mac&sort=trending',
      ),
    );
    expect(state).toEqual({
      q: 'window',
      type: 'mac',
      source: 'all',
      updated: 'year',
      categories: ['browsers', 'windows-desktop'],
      collection: 'set-up-a-new-mac',
      sort: 'trending',
    });
  });

  it('writes only what differs from the defaults, and round-trips', () => {
    expect(writeState(DEFAULT_STATE).toString()).toBe('');
    const state = {
      ...DEFAULT_STATE,
      q: 'window manager',
      source: 'community' as const,
      categories: ['browsers', 'windows-desktop'],
      sort: 'installs' as const,
    };
    const params = writeState(state);
    expect(params.toString()).toBe(
      'q=window+manager&source=community&cat=browsers&cat=windows-desktop&sort=installs',
    );
    expect(readState(params)).toEqual(state);
  });
});
