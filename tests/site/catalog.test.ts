import { describe, expect, it } from 'vitest';
import {
  forgeOwner,
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
