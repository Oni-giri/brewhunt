import { describe, expect, it } from 'vitest';
import {
  batchQuery,
  candidates,
  fetchRepos,
  isOwnRepo,
  pickRepo,
  readBatch,
  repoKey,
  type RepoInfo,
  type RepoLookup,
} from '../../scripts/data/repos.ts';

const info = (nameWithOwner: string, more: Partial<RepoInfo> = {}): RepoInfo => ({
  nameWithOwner,
  url: `https://github.com/${nameWithOwner}`,
  isFork: false,
  isArchived: false,
  stars: 10,
  pushedAt: null,
  homepageUrl: null,
  hasCode: true,
  hasReleases: false,
  ...more,
});
const pkg = (token: string, name = token, homepage: string | null = null) => ({ token, name, homepage });

describe('repoKey', () => {
  it('reads owner/name from GitHub URLs', () => {
    expect(repoKey('https://github.com/cli/cli/archive/refs/tags/v2.tar.gz')).toBe('cli/cli');
    expect(repoKey('https://github.com/BurntSushi/ripgrep.git')).toBe('burntsushi/ripgrep');
    expect(repoKey('https://www.github.com/rxhanson/Rectangle/releases/download/v')).toBe(
      'rxhanson/rectangle',
    );
    expect(repoKey('http://github.com/a/b')).toBe('a/b');
  });

  it('refuses anything that isn’t a repository URL on github.com', () => {
    for (const url of [
      null,
      'not a url',
      'https://gitlab.com/a/b',
      'https://cli.github.com/',
      'https://github.com/cli',
      'https://github.com/orgs/cli/people',
      'https://github.com/sponsors/someone/x',
      'https://github.com/-bad/name',
      'https://github.com/owner/..',
      'https://github.com/owner/na%20me',
      'ftp://github.com/a/b',
      'https://github.com.evil.example/a/b',
    ])
      expect(repoKey(url), String(url)).toBeNull();
  });

  it('lists distinct candidates, the homepage first', () => {
    expect(
      candidates('https://github.com/BurntSushi/ripgrep', [
        'https://github.com/BurntSushi/ripgrep/archive/15.tar.gz',
        'https://example.com/x.tar.gz',
        null,
      ]),
    ).toEqual(['burntsushi/ripgrep']);
    expect(
      candidates('https://cli.github.com/', ['https://github.com/cli/cli/archive/v2.tar.gz']),
    ).toEqual(['cli/cli']);
  });
});

describe('isOwnRepo', () => {
  it('trusts the homepage, but never a fork', () => {
    expect(isOwnRepo(pkg('tool'), info('someone/other-name'), true)).toBe(true);
    expect(isOwnRepo(pkg('tool'), info('someone/tool', { isFork: true }), true)).toBe(false);
  });

  it('matches the name, owner, owner and name, or a whole word of the name', () => {
    expect(isOwnRepo(pkg('ripgrep'), info('BurntSushi/ripgrep'), false)).toBe(true);
    expect(isOwnRepo(pkg('rectangle', 'Rectangle'), info('rxhanson/Rectangle'), false)).toBe(true);
    expect(isOwnRepo(pkg('neovim'), info('neovim/neovim-releases'), false)).toBe(true);
    expect(isOwnRepo(pkg('docker-compose'), info('docker/compose'), false)).toBe(true);
    expect(isOwnRepo(pkg('obsidian', 'Obsidian'), info('obsidianmd/obsidian-releases'), false)).toBe(true);
    expect(isOwnRepo(pkg('python@3.14'), info('python/cpython'), false)).toBe(true);
    expect(isOwnRepo(pkg('google-chrome', 'Google Chrome'), info('google/chrome'), false)).toBe(true);
  });

  it('doesn’t match on part of a word', () => {
    // "go" is in "mongo", "fd" in "fdupes": candidates from a package's own URLs still need to agree.
    expect(isOwnRepo(pkg('go'), info('mongodb/mongo-tools'), false)).toBe(false);
    expect(isOwnRepo(pkg('fd'), info('adrianlopezroche/fdupes'), false)).toBe(false);
    expect(isOwnRepo(pkg('wget'), info('someone/curl'), false)).toBe(false);
  });

  it('matches a repository whose homepage is on the package’s homepage host', () => {
    const gh = pkg('gh', 'gh', 'https://cli.github.com/');
    expect(isOwnRepo(gh, info('cli/cli', { homepageUrl: 'https://cli.github.com' }), false)).toBe(true);
    expect(isOwnRepo(gh, info('cli/cli', { homepageUrl: 'cli.github.com/manual' }), false)).toBe(true);
    // Same registrable domain isn't enough.
    expect(isOwnRepo(gh, info('github/docs', { homepageUrl: 'https://docs.github.com' }), false)).toBe(
      false,
    );
    // github.com itself says nothing.
    const onGithub = pkg('tool', 'tool', 'https://github.com/a/tool-site');
    expect(isOwnRepo(onGithub, info('b/other', { homepageUrl: 'https://github.com/b' }), false)).toBe(
      false,
    );
  });
});

describe('pickRepo', () => {
  const lookup: RepoLookup = new Map([
    ['someone/mirror', info('someone/mirror')],
    ['obsidianmd/obsidian-releases', info('obsidianmd/obsidian-releases', { hasCode: false, hasReleases: true })],
  ]);

  it('takes the first candidate that qualifies and classifies it', () => {
    expect(
      pickRepo(pkg('obsidian', 'Obsidian'), ['someone/mirror', 'obsidianmd/obsidian-releases'], lookup),
    ).toEqual({
      url: 'https://github.com/obsidianmd/obsidian-releases',
      name: 'obsidianmd/obsidian-releases',
      kind: 'releases',
      stars: 10,
      pushedAt: null,
      archived: false,
    });
  });

  it('gives null when none qualifies and undefined when one wasn’t looked up', () => {
    expect(pickRepo(pkg('obsidian'), ['someone/mirror'], lookup)).toBeNull();
    expect(pickRepo(pkg('obsidian'), [], lookup)).toBeNull();
    expect(pickRepo(pkg('obsidian'), ['someone/mirror', 'not/asked'], lookup)).toBeUndefined();
    expect(pickRepo(pkg('x'), ['gone/x'], new Map([['gone/x', null]]))).toBeNull();
  });
});

describe('GitHub GraphQL', () => {
  it('passes every name as a variable', () => {
    const { query, variables } = batchQuery(['cli/cli', 'a/b']);
    expect(variables).toEqual({ o0: 'cli', n0: 'cli', o1: 'a', n1: 'b' });
    expect(query).toContain('r1: repository(owner: $o1, name: $n1)');
    expect(query).not.toContain('"cli"');
  });

  const node = (nameWithOwner: string) => ({
    nameWithOwner,
    url: `https://github.com/${nameWithOwner}`,
    isFork: false,
    isArchived: true,
    stargazerCount: 5,
    pushedAt: '2026-01-01T00:00:00Z',
    homepageUrl: '',
    languages: { totalCount: 0 },
    latestRelease: { createdAt: '2026-01-01T00:00:00Z' },
  });

  it('reads a partial response: found, not found, and failed', () => {
    const lookup: RepoLookup = new Map();
    readBatch(
      ['a/one', 'b/gone', 'c/err'],
      {
        data: { r0: node('A/One'), r1: null, r2: null },
        errors: [
          { type: 'NOT_FOUND', path: ['r1'], message: 'Could not resolve' },
          { type: 'SERVICE_UNAVAILABLE', path: ['r2'], message: 'Timeout' },
        ],
      },
      lookup,
    );
    expect(lookup.get('a/one')).toMatchObject({
      nameWithOwner: 'A/One',
      isArchived: true,
      homepageUrl: null,
      hasCode: false,
      hasReleases: true,
    });
    expect(lookup.has('b/gone') && lookup.get('b/gone')).toBeNull();
    expect(lookup.has('c/err')).toBe(false);
  });

  it('trusts nothing in a response with a query-wide error', () => {
    const lookup: RepoLookup = new Map();
    readBatch(['a/one'], { data: { r0: null }, errors: [{ message: 'Something went wrong' }] }, lookup);
    expect(lookup.size).toBe(0);
  });

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('batches 100 per query and adds up the cost', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `o/r${i}`);
    const bodies: { variables: Record<string, string> }[] = [];
    const result = await fetchRepos(keys, 'token', async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      const count = Object.keys(body.variables).length / 2;
      const data: Record<string, unknown> = { rateLimit: { cost: 2, remaining: 900, resetAt: '' } };
      for (let i = 0; i < count; i++) data[`r${i}`] = node(`o/${body.variables[`n${i}`]}`);
      return respond({ data });
    });
    expect(bodies.map((b) => Object.keys(b.variables).length / 2)).toEqual([100, 100, 50]);
    expect(result).toMatchObject({ cost: 6, queries: 3, warning: null });
    expect(result.lookup.size).toBe(250);
  });

  it('stops before the budget runs out, keeping what it has', async () => {
    const keys = Array.from({ length: 600 }, (_, i) => `o/r${i}`);
    let calls = 0;
    const result = await fetchRepos(keys, 'token', async () => {
      calls++;
      return respond({ data: { rateLimit: { cost: 3, remaining: 10, resetAt: '' } } });
    });
    expect(calls).toBe(2);
    expect(result.warning).toMatch(/budget ran low/);
  });

  it('gives up after repeated failures, with a warning', async () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `o/r${i}`);
    let calls = 0;
    const result = await fetchRepos(keys, 'token', async () => {
      calls++;
      return respond({ message: 'Bad gateway' }, 502);
    });
    expect(result.lookup.size).toBe(0);
    expect(calls).toBeLessThan(12);
    expect(result.warning).toMatch(/kept failing/);
  });
});
