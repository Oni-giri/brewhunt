import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatIssue, loadContent, parseContent } from '../../scripts/content/schema.ts';
import type { Content, ContentIssue } from '../../scripts/content/schema.ts';
import { validateContent } from '../../scripts/content/validate.ts';
import type { PackageInfo } from '../../scripts/content/validate.ts';
import { packageList, rawContent, writeContentDir } from './fixtures.ts';
import type { RawFixture } from './fixtures.ts';

const script = fileURLToPath(new URL('../../scripts/content/validate.ts', import.meta.url));
const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

/** Six terminal tools, so the fixture's second category is big enough not to warn. */
const TERMINAL_TOOLS = ['ripgrep', 'fzf', 'bat', 'fd', 'jq', 'eza'];

function content(change: (raw: RawFixture) => void = () => {}): Content {
  const raw = rawContent();
  raw['categories.yaml'][1].packages = TERMINAL_TOOLS.map((id) => ({ id }));
  change(raw);
  const result = parseContent(raw);
  if (!result.content) throw new Error(JSON.stringify(result.issues));
  return result.content;
}

function packages(): PackageInfo[] {
  const list = packageList();
  for (const id of ['bat', 'fd', 'jq', 'eza']) {
    list.push({ id, token: id, name: id, kind: 'formula', deprecated: false, disabled: false });
  }
  return list;
}

const lines = (issues: ContentIssue[]) => issues.map((i) => formatIssue(i, '').replace(/^\//, ''));

describe('validateContent', () => {
  it('passes valid content, warning about a small category', () => {
    const { errors, warnings } = validateContent(content(), packages());
    expect(errors).toEqual([]);
    expect(lines(warnings)).toEqual([
      'categories.yaml [0].packages: "windows-desktop" lists 2 usable packages; aim for at least 6.',
    ]);
  });

  it('reports unknown ids, with suggestions', () => {
    const { errors } = validateContent(
      content((raw) => {
        raw['categories.yaml'][0].packages.push({ id: 'rectangel', sub: 'snapping' });
        raw['collections.yaml'][0].packages.push('ice');
        raw['picks.yaml'][0].id = 'rectangel';
        raw['packages.yaml'].wget = { developer: 'GNU' };
        raw['overrides.yaml'].hidden = ['aerospace'];
      }),
      packages(),
    );
    expect(lines(errors)).toEqual([
      'categories.yaml [0].packages[2].id: Unknown package "rectangel". Did you mean "rectangle"?',
      'collections.yaml [0].packages[2]: Unknown package "ice". Did you mean "jordanbaird-ice"?',
      'picks.yaml [0].id: Unknown package "rectangel". Did you mean "rectangle"?',
      'packages.yaml wget: Unknown package "wget".',
      'overrides.yaml hidden[0]: Unknown package "aerospace". Did you mean "nikitabobko/tap/aerospace"?',
    ]);
  });

  it('rejects disabled packages and warns about deprecated ones', () => {
    const { errors, warnings } = validateContent(
      content((raw) => {
        raw['collections.yaml'][0].packages.push('flameshot', 'arc');
      }),
      packages(),
    );
    expect(lines(errors)).toEqual([
      'collections.yaml [0].packages[2]: "flameshot" is disabled in Homebrew: remove it.',
    ]);
    expect(lines(warnings)).toContain(
      'collections.yaml [0].packages[3]: "arc" is deprecated in Homebrew.',
    );
  });

  it('warns about listed libraries unless library.show has them', () => {
    const { warnings } = validateContent(
      content((raw) => {
        raw['collections.yaml'][0].packages.push('openssl@3', 'deno');
        raw['overrides.yaml'].library = { show: ['deno'], hide: ['rectangle'] };
      }),
      packages(),
    );
    expect(lines(warnings).slice(0, -1)).toEqual([
      'collections.yaml [0].packages[2]: "openssl@3" is flagged as a library, so charts and discovery hide it. Add it to library.show in overrides.yaml to list it.',
      'overrides.yaml library.hide[0]: "rectangle" is a cask: only formulae are flagged as libraries, so this does nothing.',
    ]);
  });

  it('warns about hidden packages in lists, unused sub-categories and keywords Homebrew links', () => {
    const list = packages();
    list.find((p) => p.id === 'ripgrep')!.aliases = ['rg'];
    const { errors, warnings } = validateContent(
      content((raw) => {
        raw['categories.yaml'][0].subcategories.push({ slug: 'displays', name: 'Displays' });
        raw['categories.yaml'][0].packages.push({ id: 'jordanbaird-ice' });
        raw['overrides.yaml'].hidden = ['fzf'];
        raw['packages.yaml'].ripgrep = { keywords: ['rg', 'grep'] };
      }),
      list,
    );
    expect(errors).toEqual([]);
    expect(lines(warnings)).toEqual([
      'categories.yaml [1].packages[1].id: "fzf" is in overrides.yaml hidden, so it won\'t show.',
      'collections.yaml [0].packages[0]: "fzf" is in overrides.yaml hidden, so it won\'t show.',
      'packages.yaml ripgrep.keywords[0]: Homebrew already links "rg" to "ripgrep" (name, alias or old name).',
      'categories.yaml [0].packages: "windows-desktop" lists 3 usable packages; aim for at least 6.',
      'categories.yaml [0].subcategories[2]: No package in "windows-desktop" uses the sub-category "displays".',
      'categories.yaml [0].packages[2]: "jordanbaird-ice" has no sub-category, so it only shows under All.',
      'categories.yaml [1].packages: "terminal-tools" lists 5 usable packages; aim for at least 6.',
    ]);
  });

  it('checks only the content without a package list', () => {
    const { errors, warnings } = validateContent(
      content((raw) => {
        raw['collections.yaml'][0].packages.push('rectangel');
      }),
      null,
    );
    expect(errors).toEqual([]);
    expect(lines(warnings)).toEqual([
      'categories.yaml [0].packages: "windows-desktop" lists 2 usable packages; aim for at least 6.',
    ]);
  });

  it('finds nothing wrong with the real content', () => {
    expect(validateContent(loadContent(contentDir), null)).toEqual({ errors: [], warnings: [] });
  });
});

describe('the CLI', () => {
  function run(cwd: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  it('checks the content only, and passes, when there is no package list', () => {
    const dir = writeContentDir(rawContent());
    const { status, output } = run(path.dirname(dir));
    expect(status).toBe(0);
    expect(output).toContain("data/site/packages.json not found, so package ids weren't checked");
  });

  it('fails with the file and line of each error', () => {
    const raw = rawContent();
    raw['categories.yaml'][1].packages.push({ id: 'flameshot' });
    const dir = writeContentDir(raw);
    const list = path.join(path.dirname(dir), 'packages.json');
    writeFileSync(list, JSON.stringify(packageList()));
    const { status, output } = run(path.dirname(dir), '--packages', list);
    expect(status).toBe(1);
    expect(output).toMatch(
      /content\/categories\.yaml:\d+ \[1\]\.packages\[2\]\.id: "flameshot" is disabled/,
    );
    expect(output).toContain('Invalid: 1 error');
  });

  it('fails on schema errors', () => {
    const raw = rawContent();
    raw['categories.yaml'][0].tile = 'red';
    const { status, output } = run(path.dirname(writeContentDir(raw)));
    expect(status).toBe(1);
    expect(output).toMatch(/content\/categories\.yaml:\d+ \[0\]\.tile: Use one of: blue/);
  });

  it('passes with a notice when --packages names a file that does not exist yet', () => {
    const cwd = path.dirname(writeContentDir(rawContent()));
    expect(run(cwd, '--packages', 'nowhere.json')).toEqual({
      status: 0,
      output: expect.stringContaining("nowhere.json not found, so package ids weren't checked"),
    });
  });
});
