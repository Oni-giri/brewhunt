import { describe, expect, it } from 'vitest';
import { buildCatalog, resolveDates, type BuildInput } from '../../scripts/data/build.ts';
import type { RepoHistory } from '../../scripts/data/git.ts';
import {
  caskSchema,
  formulaSchema,
  parseAnalytics,
  type AnalyticsFile,
  type HomebrewData,
} from '../../scripts/data/homebrew.ts';
import type { TapScan } from '../../scripts/data/taps.ts';
import type { PackageDates } from '../../scripts/data/types.ts';

const END = '2026-10-27';
const window = (days: number) => ({
  start: new Date(Date.parse(`${END}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10),
  end: END,
});

const formula = (name: string, extra: Record<string, unknown> = {}) =>
  formulaSchema.parse({
    name,
    tap: 'homebrew/core',
    desc: `${name} desc`,
    license: 'MIT',
    homepage: `https://example.com/${name}`,
    versions: { stable: '1.0' },
    deprecated: false,
    disabled: false,
    ruby_source_path: `Formula/${name[0]}/${name}.rb`,
    ...extra,
  });

const cask = (token: string, extra: Record<string, unknown> = {}) =>
  caskSchema.parse({
    token,
    tap: 'homebrew/cask',
    name: [token[0].toUpperCase() + token.slice(1)],
    desc: `${token} desc`,
    homepage: `https://example.com/${token}`,
    version: '2.0',
    deprecated: false,
    disabled: false,
    artifacts: [{ app: [`${token}.app`] }, { zap: [] }],
    supported_platforms: ['tahoe', 'arm64_tahoe'],
    ruby_source_path: `Casks/${token[0]}/${token}.rb`,
    ...extra,
  });

/** Analytics feed from `{ name: [d30, d90, d365] }`. */
function feed(entries: Record<string, [number, number, number]>) {
  const file = (i: number, days: number): AnalyticsFile =>
    parseAnalytics({
      category: 'install',
      ...Object.fromEntries(Object.entries(window(days)).map(([k, v]) => [`${k}_date`, v])),
      total_count: Object.values(entries).reduce((sum, counts) => sum + counts[i], 0),
      items: Object.entries(entries).map(([name, counts]) => ({
        formula: name,
        count: counts[i].toLocaleString('en-US'),
      })),
    });
  return { '30d': file(0, 30), '90d': file(1, 90), '365d': file(2, 365) };
}

function input(overrides: Partial<BuildInput> = {}, homebrew: Partial<HomebrewData> = {}): BuildInput {
  return {
    today: '2026-10-28',
    homebrew: {
      formulae: [
        formula('wget', { versions: { stable: '1.25.0' }, revision: 2 }),
        formula('openssl@3'),
        formula('newtool', { oldnames: ['oldtool'] }),
        formula('gone', { disabled: true }),
      ],
      casks: [cask('rectangle'), cask('font-foo', { artifacts: [{ font: ['Foo.ttf'] }] })],
      analytics: {
        install: feed({
          wget: [1000, 2600, 9000],
          'openssl@3': [50_000, 150_000, 600_000],
          oldtool: [10, 30, 90],
          newtool: [200, 300, 400],
          removed: [5, 5, 5],
          'acme/tools/widget': [300, 800, 2000],
        }),
        installOnRequest: feed({
          wget: [950, 2500, 8800],
          'openssl@3': [5000, 15_000, 60_000],
          newtool: [190, 280, 380],
          'acme/tools/widget': [290, 790, 1950],
        }),
        caskInstall: feed({ rectangle: [4000, 9000, 30_000], 'font-foo': [3, 9, 30] }),
      },
      ...homebrew,
    },
    coreHistory: null,
    caskHistory: null,
    taps: [],
    tapRanking: [],
    previous: { schemaVersion: 1, repos: {}, packages: {} },
    previousPackages: [],
    snapshots: new Map(),
    trackedSince: { 'homebrew/core': '2025-09-23', 'homebrew/cask': '2025-09-23' },
    bootstrapped: new Set(['homebrew/core', 'homebrew/cask']),
    ...overrides,
  };
}

const byId = (out: ReturnType<typeof buildCatalog>) => new Map(out.packages.map((p) => [p.id, p]));

describe('buildCatalog', () => {
  it('lists official formulae and casks with their install counts', () => {
    const out = buildCatalog(input());
    const pkgs = byId(out);
    expect([...pkgs.keys()]).toEqual(['font-foo', 'gone', 'newtool', 'openssl@3', 'rectangle', 'wget']);
    expect(pkgs.get('wget')).toMatchObject({
      kind: 'formula',
      source: 'official',
      installCommand: 'brew install wget',
      installs: { d30: 1000, d90: 2600, d365: 9000 },
      installsOnRequest: { d30: 950, d90: 2500, d365: 8800 },
      sourceUrl: 'https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/w/wget.rb',
      library: false,
    });
    expect(pkgs.get('rectangle')).toMatchObject({
      kind: 'cask',
      name: 'Rectangle',
      installCommand: 'brew install --cask rectangle',
      installsOnRequest: null,
      artifacts: ['app'],
      platforms: ['macos'],
    });
    expect(pkgs.get('font-foo')!.font).toBe(true);
    expect(pkgs.get('gone')!.disabled).toBe(true);
  });

  it('adds counts recorded under an old name and reports unknown names', () => {
    const out = buildCatalog(input());
    expect(byId(out).get('newtool')!.installs.d30).toBe(210);
    expect(out.meta.warnings.join('\n')).toContain('removed (5)');
  });

  it('flags libraries and computes trends from the 90-day window', () => {
    const pkgs = byId(buildCatalog(input()));
    expect(pkgs.get('openssl@3')!.library).toBe(true);
    // wget on request: 950 of 6,430 against 775 of 6,070 (the average 30 days of the 60 before).
    expect(pkgs.get('wget')!.trend).toEqual({ change: 0.157, basis: 'previous-60-days-average' });
    expect(pkgs.get('newtool')!.trend).toBeNull(); // baseline under 50
  });

  it('uses the snapshot from 30 days earlier once there is one', () => {
    const snapshots = new Map([
      [
        '2026-09-27',
        {
          installs: { rectangle: 5000 },
          installsOnRequest: { wget: 500 },
          totals: { install: 9000, installOnRequest: 6430, caskInstall: 4003 },
        },
      ],
    ]);
    const pkgs = byId(buildCatalog(input({ snapshots })));
    expect(pkgs.get('wget')!.trend).toEqual({ change: 0.9, basis: 'previous-30-days' });
    expect(pkgs.get('rectangle')!.trend).toEqual({ change: -0.2, basis: 'previous-30-days' });
  });

  it('writes a snapshot keyed by the analytics end date and an aligned history', () => {
    const snapshots = new Map([['2026-10-26', { installs: { wget: 990 }, installsOnRequest: {} }]]);
    const out = buildCatalog(input({ snapshots }));
    expect(out.snapshotDate).toBe(END);
    expect(out.snapshot.installs.wget).toBe(1000);
    expect(out.snapshot.installsOnRequest.wget).toBe(950);
    expect(out.history.dates).toEqual(['2026-10-26', END]);
    expect(out.history.installs.wget).toEqual([990, 1000]);
    expect(out.history.installs.rectangle).toEqual([null, 4000]);
    expect(out.meta.history).toEqual({ days: 2, first: '2026-10-26', last: END });
  });

  it('refuses a formula and a cask with the same id', () => {
    expect(() => buildCatalog(input({}, { casks: [cask('wget')] }))).toThrow(/collision/);
  });

  it('lists community packages from a read tap, with installs, and skips unused ones', () => {
    const scan: TapScan = {
      ref: { id: 'acme/tools', owner: 'acme', repo: 'homebrew-tools', installs30d: 300 },
      ok: true,
      packages: [
        {
          file: { kind: 'formula', token: 'widget', path: 'Formula/widget.rb' },
          parsed: {
            kind: 'formula',
            token: 'widget',
            desc: 'Makes widgets',
            homepage: 'https://acme.dev',
            version: '3.1',
            license: 'Apache-2.0',
            name: null,
            deprecated: false,
            disabled: false,
            dependencies: [],
            autoUpdates: false,
          },
        },
        {
          file: { kind: 'formula', token: 'widget@1', path: 'Formula/widget@1.rb' },
          parsed: {
            kind: 'formula',
            token: 'widget@1',
            desc: null,
            homepage: null,
            version: '1.0',
            license: null,
            name: null,
            deprecated: false,
            disabled: false,
            dependencies: [],
            autoUpdates: false,
          },
        },
      ],
      history: null,
      github: { description: 'Acme tools', stars: 12, pushedAt: '2026-10-01T00:00:00Z', archived: false },
    };
    const out = buildCatalog(input({ taps: [scan], tapRanking: [scan.ref] }));
    const widget = byId(out).get('acme/tools/widget')!;
    expect(widget).toMatchObject({
      source: 'community',
      tap: 'acme/tools',
      desc: 'Makes widgets',
      installCommand: 'brew install acme/tools/widget',
      installs: { d30: 300, d90: 800, d365: 2000 },
      sourceUrl: 'https://github.com/acme/homebrew-tools/blob/HEAD/Formula/widget.rb',
    });
    expect(byId(out).has('acme/tools/widget@1')).toBe(false);
    expect(out.taps).toEqual([
      {
        id: 'acme/tools',
        owner: 'acme',
        repo: 'homebrew-tools',
        url: 'https://github.com/acme/homebrew-tools',
        description: 'Acme tools',
        stars: 12,
        pushedAt: '2026-10-01T00:00:00Z',
        archived: false,
        installs30d: 300,
        packageIds: ['acme/tools/widget'],
        enriched: true,
      },
    ]);
  });

  it("keeps yesterday's packages for a tap it can't read today, and nothing else", () => {
    const scan: TapScan = {
      ref: { id: 'acme/tools', owner: 'acme', repo: 'homebrew-tools', installs30d: 300 },
      ok: false,
      error: 'clone failed',
      packages: [],
      history: null,
      github: null,
    };
    // Never read before: analytics alone don't make a listing.
    const first = buildCatalog(input({ taps: [scan] }));
    expect(byId(first).has('acme/tools/widget')).toBe(false);
    expect(first.taps[0]).toMatchObject({ enriched: false, packageIds: [] });
    expect(first.meta.warnings.join('\n')).toContain("Couldn't read tap acme/tools");

    const yesterday = { ...byId(buildCatalog(input())).get('wget')! };
    Object.assign(yesterday, {
      id: 'acme/tools/widget',
      tap: 'acme/tools',
      token: 'widget',
      source: 'community',
      desc: 'Makes widgets',
    });
    const second = buildCatalog(input({ taps: [scan], previousPackages: [yesterday] }));
    expect(byId(second).get('acme/tools/widget')).toMatchObject({
      desc: 'Makes widgets',
      installs: { d30: 300, d90: 800, d365: 2000 },
    });
  });

  it('is deterministic for the same input', () => {
    expect(JSON.stringify(buildCatalog(input()))).toBe(JSON.stringify(buildCatalog(input())));
  });
});

describe('resolveDates', () => {
  const history = (subjects: Record<string, string>, added: string | null): RepoHistory => ({
    commits: new Map(),
    landed: new Map(Object.keys(subjects).map((h) => [h, subjects[h].slice(0, 10)])),
    mainline: new Map([
      [
        'Formula/f/foo.rb',
        [
          { hash: 'last', date: '2026-10-20', status: 'M' as const },
          ...(added ? [{ hash: 'add', date: added, status: 'A' as const }] : []),
        ],
      ],
    ]),
    deletedBy: new Map(),
    subjects: new Map([
      ['Formula/f/foo.rb', Object.entries(subjects).map(([hash, s]) => ({ hash, subject: s.slice(11) }))],
    ]),
  });
  const draft = (h: RepoHistory | null, version = '2.0') => ({
    datingVersion: version,
    path: 'Formula/f/foo.rb',
    history: h,
    oldNames: ['oldfoo'],
  });

  it('dates a new package and its version from git on the first run', () => {
    const h = history({ a: '2026-10-01 foo 1.0 (new formula)', b: '2026-10-15 foo 2.0' }, '2026-10-01');
    expect(resolveDates(draft(h), undefined, undefined, true, '2026-10-28')).toEqual({
      firstSeen: '2026-10-01',
      updatedAt: '2026-10-15',
      updatedKind: 'version',
      version: '2.0',
    });
  });

  it("leaves dates unknown on the first run when they're older than the window", () => {
    const h = history({ a: '2026-10-20 foo: style' }, null);
    expect(resolveDates(draft(h), undefined, undefined, true, '2026-10-28')).toEqual({
      firstSeen: null,
      updatedAt: null,
      updatedKind: null,
      version: '2.0',
    });
  });

  it('keeps the previous dates while the version is unchanged', () => {
    const previous: PackageDates = { firstSeen: null, updatedAt: '2026-03-01', updatedKind: 'version', version: '2.0' };
    // A rebuild commit mentions 2.0 inside today's window; the version date must not move.
    const h = history({ a: '2026-10-20 foo: update 2.0 bottle.' }, null);
    expect(resolveDates(draft(h), previous, undefined, false, '2026-10-28')).toEqual(previous);
  });

  it('falls back to the last file change when a new version has no named commit', () => {
    const previous: PackageDates = { firstSeen: null, updatedAt: '2026-03-01', updatedKind: 'version', version: '1.0' };
    const h = history({ a: '2026-10-20 foo: various fixes' }, null);
    expect(resolveDates(draft(h), previous, undefined, false, '2026-10-28')).toMatchObject({
      updatedAt: '2026-10-20',
      updatedKind: 'file',
    });
  });

  it('inherits dates through a rename', () => {
    const old: PackageDates = { firstSeen: '2025-01-01', updatedAt: '2026-03-01', updatedKind: 'version', version: '2.0' };
    const h = history({ a: '2026-10-25 foo: rename from oldfoo' }, '2026-10-25');
    expect(resolveDates(draft(h), undefined, old, false, '2026-10-28')).toMatchObject({
      firstSeen: '2025-01-01',
      updatedAt: '2026-03-01',
    });
  });

  it('marks a version change seen without git history as today', () => {
    const previous: PackageDates = { firstSeen: null, updatedAt: null, updatedKind: null, version: '1.0' };
    expect(resolveDates(draft(null), previous, undefined, false, '2026-10-28')).toMatchObject({
      updatedAt: '2026-10-28',
      updatedKind: 'version',
    });
  });
});
