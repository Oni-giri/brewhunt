import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ContentError,
  formatIssue,
  inspectContent,
  loadContent,
  parseContent,
} from '../../scripts/content/schema.ts';
import { rawContent, writeContentDir } from './fixtures.ts';
import type { RawFixture } from './fixtures.ts';

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

/** The fixture after `change`, parsed: its issues as `file path: message`. */
function issues(change: (raw: RawFixture) => void): string[] {
  const raw = rawContent();
  change(raw);
  return parseContent(raw).issues.map((i) => formatIssue(i, '').replace(/^\//, ''));
}

describe('the real content files', () => {
  it('load and validate', () => {
    const content = loadContent(contentDir);
    const slugs = content.categories.map((c) => c.slug);
    // The footer links to these.
    expect(slugs.slice(0, 2)).toEqual(['windows-desktop', 'menu-bar']);
    expect(slugs).toContain('terminal-tools');
    // The design: Ice is the Discover pick, Rectangle the Windows & desktop pick.
    expect(content.picks[0]).toMatchObject({ id: 'jordanbaird-ice', category: 'menu-bar' });
    expect(content.picks.find((p) => p.category === 'windows-desktop')?.id).toBe('rectangle');
    expect(content.collections.map((c) => c.slug)).toEqual(
      expect.arrayContaining(['set-up-a-new-mac', 'command-line-essentials']),
    );
  });
});

describe('parseContent', () => {
  it('accepts valid content and fills in empty lists', () => {
    const { content, issues: found } = parseContent(rawContent());
    expect(found).toEqual([]);
    expect(content?.categories[1].subcategories).toEqual([]);
    expect(content?.packages.rectangle.tagline).toBe('Snap windows with keyboard shortcuts');
  });

  it('treats missing and empty optional files as empty', () => {
    const { content, issues: found } = parseContent({
      'categories.yaml': rawContent()['categories.yaml'],
      'overrides.yaml': { library: null, hidden: null },
    });
    expect(found).toEqual([]);
    expect(content).toMatchObject({
      collections: [],
      picks: [],
      packages: {},
      overrides: { library: { show: [], hide: [] }, hidden: [] },
    });
  });

  it('rejects a sub-category the category does not have', () => {
    expect(
      issues((raw) => {
        raw['categories.yaml'][0].packages[0].sub = 'snap';
        raw['categories.yaml'][1].packages[0].sub = 'files';
      }),
    ).toEqual([
      'categories.yaml [0].packages[0].sub: Unknown sub-category "snap": "windows-desktop" has snapping, tiling.',
      'categories.yaml [1].packages[0].sub: Unknown sub-category "files": "terminal-tools" has no sub-categories.',
    ]);
  });

  it('rejects duplicate slugs and ids within a list', () => {
    expect(
      issues((raw) => {
        raw['categories.yaml'][1].slug = 'windows-desktop';
        raw['categories.yaml'][1].packages.push({ id: 'fzf' });
        raw['categories.yaml'][0].subcategories.push({ slug: 'tiling', name: 'Tiles' });
        raw['collections.yaml'][0].packages.push('fzf');
        raw['overrides.yaml'].hidden = ['fzf', 'fzf'];
      }),
    ).toEqual([
      'categories.yaml [0].subcategories[2].slug: Duplicate sub-category "tiling".',
      'categories.yaml [1].packages[2].id: Duplicate package "fzf".',
      'categories.yaml [1].slug: Duplicate category "windows-desktop".',
      'collections.yaml [0].packages[2]: Duplicate package "fzf".',
      'overrides.yaml hidden[1]: Duplicate package "fzf".',
    ]);
  });

  it('fills a category from CaskFlow ids, each mapped once', () => {
    expect(
      issues((raw) => {
        raw['categories.yaml'][0].caskflow = ['utilities', 'other'];
        raw['categories.yaml'][1].caskflow = ['other', 'not an id'];
        raw['categories.yaml'][1].packages = [];
      }),
    ).toEqual([
      'categories.yaml [1].caskflow[1]: Use a CaskFlow category id, like "developerTools".',
      'categories.yaml [1].caskflow[0]: CaskFlow\'s "other" already fills "windows-desktop".',
    ]);
    // Without packages, it needs CaskFlow ids to fill it from.
    expect(
      issues((raw) => {
        raw['categories.yaml'][1].packages = [];
      }),
    ).toEqual([
      'categories.yaml [1].packages: List at least one package, or CaskFlow categories to fill it from.',
    ]);
  });

  it('wants one-sentence descriptions, short taglines and lowercase keywords', () => {
    expect(
      issues((raw) => {
        raw['categories.yaml'][0].description = 'Snap, tile and switch windows';
        raw['categories.yaml'][1].description = 'Tools for the shell. Fast ones.';
        raw['packages.yaml'].rectangle.tagline = 'x'.repeat(61);
        raw['packages.yaml'].fzf = { tagline: 'Fuzzy finder.' };
        raw['packages.yaml'].ripgrep = {};
        raw['packages.yaml']['visual-studio-code'] = { keywords: ['vscode', 'VSCode', 'vscode'] };
      }),
    ).toEqual([
      'categories.yaml [0].description: End it with a full stop.',
      'categories.yaml [1].description: Keep it to one sentence.',
      'packages.yaml rectangle.tagline: Keep it under 61 characters.',
      'packages.yaml fzf.tagline: No full stop at the end, like Homebrew descriptions.',
      'packages.yaml ripgrep: Add a name, a type, a tagline, a developer or keywords, or remove this entry.',
      'packages.yaml visual-studio-code.keywords[1]: Use lowercase.',
      'packages.yaml visual-studio-code.keywords[2]: Duplicate keyword "vscode".',
    ]);
  });

  it('rejects unknown keys, bad ids and bad tiles', () => {
    const found = issues((raw) => {
      raw['categories.yaml'][0].subcategory = [];
      raw['categories.yaml'][0].tile = 'red';
      raw['collections.yaml'][0].packages.push('Rectangle', 'owner/name');
    });
    expect(found).toHaveLength(4);
    expect(found[0]).toMatch(/^categories\.yaml \[0\]\.tile: Use one of: blue, orange/);
    expect(found[1]).toMatch(/^categories\.yaml \[0\]: Unrecognized key: "subcategory"/);
    expect(found[2]).toMatch(/^collections\.yaml \[0\]\.packages\[2\]: Not a package id/);
    expect(found[3]).toMatch(/^collections\.yaml \[0\]\.packages\[3\]: Not a package id/);
  });

  it('wants picks newest first, with a real date', () => {
    expect(
      issues((raw) => {
        raw['picks.yaml'].push({ id: 'fzf', date: '2026-11-02', blurb: 'Finds things.' });
      }),
    ).toEqual([
      'picks.yaml [1].date: List picks newest first: 2026-11-02 is after the pick above it (2026-10-28).',
    ]);
    expect(
      issues((raw) => {
        raw['picks.yaml'][0].date = '28/10/2026';
      }),
    ).toEqual(['picks.yaml [0].date: Use a date like 2026-10-28.']);
  });

  it("checks a pick's category exists and lists the package", () => {
    expect(
      issues((raw) => {
        raw['picks.yaml'].push(
          { id: 'fzf', date: '2026-10-01', category: 'windows-desktop', blurb: 'Finds things.' },
          { id: 'ripgrep', date: '2026-09-01', category: 'cli', blurb: 'Searches files.' },
        );
      }),
    ).toEqual([
      'picks.yaml [1].id: "fzf" isn\'t listed in the "windows-desktop" category.',
      'picks.yaml [2].category: Unknown category "cli".',
    ]);
  });

  it('rejects a package in both library.show and library.hide', () => {
    expect(
      issues((raw) => {
        raw['overrides.yaml'].library = { show: ['deno'], hide: ['deno'] };
      }),
    ).toEqual(['overrides.yaml library.hide[0]: "deno" is in both library.show and library.hide.']);
  });
});

describe('inspectContent and loadContent', () => {
  it('point schema issues at their line', () => {
    const dir = writeContentDir({
      'categories.yaml': [
        '- slug: windows-desktop',
        '  name: Windows & desktop',
        '  description: Snap windows.',
        '  tile: blue',
        '  packages:',
        '    - { id: rectangle }',
        '    - { id: rectangle }',
        '',
      ].join('\n'),
    });
    const { content, issues: found } = inspectContent(dir);
    expect(content).toBeNull();
    expect(found).toEqual([
      {
        file: 'categories.yaml',
        path: [0, 'packages', 1, 'id'],
        line: 7,
        message: 'Duplicate package "rectangle".',
      },
    ]);
    expect(() => loadContent(dir)).toThrow(ContentError);
    expect(() => loadContent(dir)).toThrow(
      `${dir}/categories.yaml:7 [0].packages[1].id: Duplicate package "rectangle".`,
    );
  });

  it('report YAML syntax errors and duplicate keys with their line', () => {
    const raw = rawContent();
    const dir = writeContentDir({
      ...raw,
      'collections.yaml': '- slug: [unclosed\n',
      'packages.yaml': 'fzf:\n  developer: Junegunn Choi\nfzf:\n  developer: Someone\n',
    });
    const { content, issues: found } = inspectContent(dir);
    expect(content).toBeNull();
    expect(found.map((i) => [i.file, i.line])).toEqual([
      ['collections.yaml', 2],
      ['packages.yaml', 3],
    ]);
    expect(found[1].message).toBe('Invalid YAML: Map keys must be unique');
  });

  it('need categories.yaml but not the other files', () => {
    expect(inspectContent(writeContentDir({})).issues).toMatchObject([
      { file: 'categories.yaml', message: 'File not found.' },
    ]);
    const dir = writeContentDir({
      'categories.yaml': rawContent()['categories.yaml'],
      'overrides.yaml': '# Nothing yet.\n',
    });
    expect(loadContent(dir).overrides).toEqual({ library: { show: [], hide: [] }, hidden: [] });
  });
});
