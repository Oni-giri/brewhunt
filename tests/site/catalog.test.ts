import { describe, expect, it } from 'vitest';
import {
  caskflowCategory,
  fillCategories,
  forgeOwner,
  iconFor,
  isCommandLine,
  isMacApp,
  kindLabel,
  sourceRepo,
} from '../../src/lib/catalog.ts';

describe('sourceRepo', () => {
  it('keeps owner/repo on GitHub and Codeberg', () => {
    expect(sourceRepo('https://github.com/rxhanson/Rectangle')).toBe(
      'https://github.com/rxhanson/Rectangle',
    );
    expect(sourceRepo('https://github.com/BurntSushi/ripgrep/releases')).toBe(
      'https://github.com/BurntSushi/ripgrep',
    );
    expect(sourceRepo('https://www.github.com/a/b.git')).toBe('https://github.com/a/b');
    expect(sourceRepo('https://codeberg.org/dnkl/foot')).toBe('https://codeberg.org/dnkl/foot');
  });

  it('keeps nested GitLab groups and drops page paths', () => {
    expect(sourceRepo('https://gitlab.com/sane-project/frontend/xsane')).toBe(
      'https://gitlab.com/sane-project/frontend/xsane',
    );
    expect(sourceRepo('https://gitlab.com/group/project/-/releases')).toBe(
      'https://gitlab.com/group/project',
    );
  });

  it('returns null for other sites and bare owners', () => {
    expect(sourceRepo('https://rectangleapp.com/')).toBeNull();
    expect(sourceRepo('https://github.com/rxhanson')).toBeNull();
    expect(sourceRepo('not a url')).toBeNull();
    expect(sourceRepo(null)).toBeNull();
  });

  it('finds the owner for the Developer row', () => {
    expect(forgeOwner('https://github.com/rxhanson/Rectangle')).toBe('rxhanson');
    expect(forgeOwner('https://rectangleapp.com/')).toBeNull();
  });
});

describe('package type', () => {
  const app = { kind: 'cask' as const, commandLine: false, platforms: ['macos' as const] };
  const cliCask = { kind: 'cask' as const, commandLine: true, platforms: null };
  const formula = { kind: 'formula' as const, commandLine: true, platforms: null };
  const linux = { kind: 'cask' as const, commandLine: false, platforms: ['linux' as const] };

  it('labels and groups by the resolved type', () => {
    expect([app, cliCask, formula, linux].map(kindLabel)).toEqual([
      'Mac app',
      'Command-line tool',
      'Command-line tool',
      'Linux app',
    ]);
    expect([app, cliCask, formula].map(isMacApp)).toEqual([true, false, false]);
    expect([app, cliCask, formula].map(isCommandLine)).toEqual([false, true, true]);
  });
});

describe('iconFor', () => {
  const base = 'https://cdn.jsdelivr.net/gh/alielsokary/CaskFlow@abc/';
  const tokens = new Set(['firefox', 'wget']);
  it('gives official casks with an icon their URL, and everything else a tile', () => {
    expect(iconFor(base, tokens, { kind: 'cask', source: 'official', token: 'firefox' })).toBe(
      `${base}firefox.png`,
    );
    expect(
      iconFor(base, tokens, { kind: 'cask', source: 'community', token: 'firefox' }),
    ).toBeNull();
    expect(
      iconFor(base, tokens, { kind: 'formula', source: 'official', token: 'wget' }),
    ).toBeNull();
    expect(iconFor(base, tokens, { kind: 'cask', source: 'official', token: 'zed' })).toBeNull();
    expect(
      iconFor(null, tokens, { kind: 'cask', source: 'official', token: 'firefox' }),
    ).toBeNull();
  });
});

describe('categories filled from CaskFlow', () => {
  const caskflow = {
    release: 'caskflow-v1',
    names: { games: 'Games', other: 'Other' },
    primary: { steam: 'games', moonlight: 'games', tool: 'other' },
  };
  const slugFor = new Map([['games', 'games']]);
  const cask = (token: string, source: 'official' | 'community' = 'official') =>
    ({ kind: 'cask', source, token }) as const;

  it("map an official cask's primary category to ours", () => {
    expect(caskflowCategory(cask('steam'), caskflow, slugFor)).toEqual(['games']);
    // Someone else's app with the same name, an unmapped CaskFlow id, a formula, no file.
    expect(caskflowCategory(cask('steam', 'community'), caskflow, slugFor)).toEqual([]);
    expect(caskflowCategory(cask('tool'), caskflow, slugFor)).toEqual([]);
    expect(
      caskflowCategory({ kind: 'formula', source: 'official', token: 'steam' }, caskflow, slugFor),
    ).toEqual([]);
    expect(caskflowCategory(cask('steam'), null, slugFor)).toEqual([]);
  });

  it('follow the editors’ list, most installed first, listed packages only', () => {
    const category = (slug: string, ids: string[]) => ({
      slug,
      name: slug,
      description: `${slug}.`,
      tile: 'blue' as const,
      subcategories: [],
      caskflow: [],
      packages: ids.map((id) => ({ id })),
    });
    const entry = (id: string, d30: number, categories: string[], listed = true) => ({
      id,
      listed,
      categories,
      popularity: { d30, d90: 0, d365: 0 },
    });
    const filled = fillCategories(
      [category('games', ['dolphin']), category('utilities', [])],
      [
        entry('dolphin', 10, ['games']),
        entry('moonlight', 50, ['games']),
        entry('steam', 900, ['games']),
        entry('steam@beta', 5000, ['games'], false),
        entry('keka', 70, ['utilities']),
        entry('wget', 99999, []),
      ],
    );
    expect(filled.map((c) => c.packages.map((p) => p.id))).toEqual([
      ['dolphin', 'steam', 'moonlight'],
      ['keka'],
    ]);
  });
});
