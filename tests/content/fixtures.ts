// Small inline content and package lists for the content tests.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import type { ContentFile } from '../../scripts/content/schema.ts';
import type { PackageInfo } from '../../scripts/content/validate.ts';

/** Content as parsed YAML, which tests bend into invalid shapes: hence `any`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawFixture = Record<ContentFile, any>;

/** Valid content: two categories, one collection, one pick, one tagline. */
export function rawContent(): RawFixture {
  return {
    'categories.yaml': [
      {
        slug: 'windows-desktop',
        name: 'Windows & desktop',
        description: 'Snap, tile and switch windows.',
        tile: 'blue',
        subcategories: [
          { slug: 'snapping', name: 'Snapping' },
          { slug: 'tiling', name: 'Tiling' },
        ],
        packages: [
          { id: 'rectangle', sub: 'snapping' },
          { id: 'nikitabobko/tap/aerospace', sub: 'tiling' },
        ],
      },
      {
        slug: 'terminal-tools',
        name: 'Terminal tools',
        description: 'Command-line tools for the shell.',
        tile: 'terminal',
        packages: [{ id: 'ripgrep' }, { id: 'fzf' }],
      },
    ],
    'collections.yaml': [
      {
        slug: 'command-line-essentials',
        title: 'Command-line essentials',
        subtitle: 'What power users install first',
        tile: 'terminal',
        packages: ['fzf', 'ripgrep'],
      },
    ],
    'picks.yaml': [
      {
        id: 'rectangle',
        date: '2026-10-28',
        category: 'windows-desktop',
        blurb: 'Snaps windows to halves, thirds and corners.',
      },
    ],
    'packages.yaml': { rectangle: { tagline: 'Snap windows with keyboard shortcuts' } },
    'overrides.yaml': { library: { show: [], hide: [] }, hidden: [] },
  };
}

function pkg(id: string, extra: Partial<PackageInfo> = {}): PackageInfo {
  const token = id.split('/').pop() ?? id;
  return { id, token, name: token, kind: 'formula', deprecated: false, disabled: false, ...extra };
}

/** The fixture's packages plus a few with flags. */
export function packageList(): PackageInfo[] {
  return [
    pkg('rectangle', { kind: 'cask', name: 'Rectangle' }),
    pkg('nikitabobko/tap/aerospace', { kind: 'cask', name: 'AeroSpace' }),
    pkg('ripgrep'),
    pkg('fzf'),
    pkg('jordanbaird-ice', { kind: 'cask', name: 'Ice' }),
    pkg('flameshot', { kind: 'cask', name: 'Flameshot', disabled: true }),
    pkg('arc', { kind: 'cask', name: 'Arc', deprecated: true }),
    pkg('openssl@3', { library: true }),
    pkg('deno', { library: true }),
  ];
}

/** Writes content files (YAML text, or data to stringify) to a new temporary directory. */
export function writeContentDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'brewhunt-content-'));
  const contentDir = path.join(dir, 'content');
  mkdirSync(contentDir);
  for (const [file, data] of Object.entries(files)) {
    writeFileSync(path.join(contentDir, file), typeof data === 'string' ? data : stringify(data));
  }
  return contentDir;
}
