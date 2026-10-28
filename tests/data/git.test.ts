import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addedDate,
  landingDates,
  lastTouched,
  readHistory,
  versionDate,
  versionPattern,
  versionSpellings,
  type Commit,
} from '../../scripts/data/git.ts';

describe('versionPattern', () => {
  const matches = (version: string, subject: string) => versionPattern(version).test(subject);

  it('matches the version as a whole token', () => {
    expect(matches('1.25.0', 'wget 1.25.0')).toBe(true);
    expect(matches('1.25.0', 'Merge pull request #1 from Homebrew/bump-wget-1.25.0')).toBe(true);
    expect(matches('1.25.0_2', 'wget: update 1.25.0_2 bottle.')).toBe(true);
    expect(matches('1.2.3', 'Brew formula update for foo version v1.2.3')).toBe(true);
    expect(matches('2.0', 'foo 2.0 (new formula)')).toBe(true);
  });

  it("doesn't match a longer version or a revision", () => {
    expect(matches('1.2', 'foo 1.2.3')).toBe(false);
    expect(matches('1.25.0', 'wget: update 1.25.0_1 bottle.')).toBe(false);
    expect(matches('1.0', 'foo 11.0')).toBe(false);
    expect(matches('3.6', 'Merge pull request #1 from Homebrew/openssl@3.6.5')).toBe(false);
  });

  it('escapes regex characters in versions', () => {
    expect(matches('1.0+build', 'foo 1.0+build')).toBe(true);
    expect(matches('1.0+build', 'foo 1.00build')).toBe(false);
  });

  it('offers the part before the comma for cask build suffixes', () => {
    expect(versionSpellings('0.5.16,261015abc')).toEqual(['0.5.16,261015abc', '0.5.16']);
    expect(versionSpellings('2.0.4')).toEqual(['2.0.4']);
  });
});

describe('landingDates', () => {
  it('dates merged branch commits with their merge', () => {
    // m1 ← m2 (merge of b1 ← b2) ← m3
    const commits = new Map<string, Commit>([
      ['m1', { parents: [], date: '2026-01-01' }],
      ['b1', { parents: ['m1'], date: '2025-12-20' }],
      ['b2', { parents: ['b1'], date: '2025-12-21' }],
      ['m2', { parents: ['m1', 'b2'], date: '2026-01-10' }],
      ['m3', { parents: ['m2'], date: '2026-01-11' }],
    ]);
    const landed = landingDates(commits, 'm3');
    expect(Object.fromEntries(landed)).toEqual({
      m1: '2026-01-01',
      b1: '2026-01-10',
      b2: '2026-01-10',
      m2: '2026-01-10',
      m3: '2026-01-11',
    });
  });

  it('gives a commit merged twice its first landing', () => {
    const commits = new Map<string, Commit>([
      ['m1', { parents: [], date: '2026-01-01' }],
      ['b1', { parents: ['m1'], date: '2026-01-02' }],
      ['m2', { parents: ['m1', 'b1'], date: '2026-01-03' }],
      ['b2', { parents: ['b1'], date: '2026-01-04' }],
      ['m3', { parents: ['m2', 'b2'], date: '2026-01-05' }],
    ]);
    const landed = landingDates(commits, 'm3');
    expect(landed.get('b1')).toBe('2026-01-03');
    expect(landed.get('b2')).toBe('2026-01-05');
  });
});

describe('readHistory on a real repository', () => {
  let dir: string;
  const run = (args: string[], date?: string) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...(date ? { GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` } : {}),
      },
      encoding: 'utf8',
    });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message: string, date: string) => {
    run(['add', '-A']);
    run(['commit', '-q', '-m', message], date);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'brewhunt-git-'));
    run(['init', '-q', '-b', 'main']);
    write('Formula/a/alpha.rb', 'class Alpha; end # 1.0\n');
    write('Formula/b/beta.rb', 'class Beta; end\n');
    write('Formula/delta.rb', 'class Delta; end\n');
    write('README.md', 'tap\n');
    commit('alpha 1.0 (new formula)', '2026-01-01');

    // A pull request written on the 5th, merged on the 10th.
    run(['checkout', '-q', '-b', 'bump-alpha']);
    write('Formula/a/alpha.rb', 'class Alpha; end # 1.1\n');
    commit('alpha 1.1', '2026-01-05');
    run(['checkout', '-q', 'main']);
    write('README.md', 'tap!\n');
    commit('docs', '2026-01-06');
    run(['merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from someone/bump-alpha', 'bump-alpha'], '2026-01-10');

    // beta renamed to gamma, delta moved into a shard directory.
    unlinkSync(join(dir, 'Formula/b/beta.rb'));
    write('Formula/g/gamma.rb', 'class Gamma; end\n');
    commit('gamma: rename from beta', '2026-01-12');
    unlinkSync(join(dir, 'Formula/delta.rb'));
    write('Formula/d/delta.rb', 'class Delta; end\n');
    commit('delta: move to shard', '2026-01-15');

    write('Formula/e/epsilon.rb', 'class Epsilon; end\n');
    commit('epsilon 0.1 (new formula)', '2026-01-20');
    write('Formula/a/alpha.rb', 'class Alpha; end # 1.1 style\n');
    commit('alpha: style', '2026-01-21');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('dates additions, ignoring renames and moves', async () => {
    const history = await readHistory(dir, ['Formula']);
    expect(addedDate(history, 'Formula/a/alpha.rb')).toBe('2026-01-01');
    expect(addedDate(history, 'Formula/e/epsilon.rb')).toBe('2026-01-20');
    expect(addedDate(history, 'Formula/g/gamma.rb', ['beta'])).toBeNull();
    expect(addedDate(history, 'Formula/d/delta.rb')).toBeNull();
  });

  it('dates a version by when its commit landed on main', async () => {
    const history = await readHistory(dir, ['Formula']);
    expect(versionDate(history, 'Formula/a/alpha.rb', '1.1')).toBe('2026-01-10');
    expect(versionDate(history, 'Formula/a/alpha.rb', '1.0')).toBe('2026-01-01');
    expect(versionDate(history, 'Formula/a/alpha.rb', '2.0')).toBeNull();
    expect(lastTouched(history, 'Formula/a/alpha.rb')).toBe('2026-01-21');
  });

  it('ignores the boundary of a shallow clone', async () => {
    const shallow = mkdtempSync(join(tmpdir(), 'brewhunt-shallow-'));
    try {
      execFileSync('git', [
        '-c',
        'protocol.file.allow=always',
        'clone',
        '-q',
        '--shallow-since=2026-01-11',
        `file://${dir}`,
        shallow,
      ]);
      const history = await readHistory(shallow, ['Formula']);
      // Everything at the boundary looks added in a shallow clone; none of it should count.
      expect(addedDate(history, 'Formula/a/alpha.rb')).toBeNull();
      expect(addedDate(history, 'Formula/e/epsilon.rb')).toBe('2026-01-20');
      expect(lastTouched(history, 'Formula/a/alpha.rb')).toBe('2026-01-21');
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});
