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

  it('looks past an unanswered candidate, and drops yesterday’s repository once it’s gone', () => {
    const repos: RepoLookup = new Map([
      ['a/obsidian', info('a/obsidian')],
      ['old/obsidian', null],
    ]);
    expect(pickRepo(pkg('obsidian'), ['not/asked', 'a/obsidian'], repos)?.name).toBe('a/obsidian');
    const yesterday = pickRepo(pkg('obsidian'), ['a/obsidian'], repos)!;
    const gone = { ...yesterday, name: 'Old/Obsidian', url: 'https://github.com/Old/Obsidian' };
    expect(pickRepo(pkg('obsidian'), ['old/obsidian', 'not/asked'], repos, gone)).toBeNull();
    // Yesterday's wasn't answered today either: keep it.
    expect(pickRepo(pkg('obsidian'), ['not/asked'], repos, yesterday)).toBeUndefined();
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
    const result = readBatch(
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
    expect(result).toEqual({ queryError: null, failed: 1 });
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

  it('trusts nothing in a response with a query-wide error, and says so', () => {
    const lookup: RepoLookup = new Map();
    expect(
      readBatch(['a/one'], { data: { r0: null }, errors: [{ type: 'RATE_LIMITED', message: 'Slow down' }] }, lookup),
    ).toEqual({ queryError: 'RATE_LIMITED: Slow down', failed: 0 });
    expect(readBatch(['a/one'], { data: null }, lookup).queryError).toBe('no data in the response');
    expect(lookup.size).toBe(0);
  });

  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  /** Answers every repository in the query; `rate` is what rateLimit reports. */
  const answer =
    (rate = { cost: 1, remaining: 900 }, fail?: (keys: string[]) => Response | null) =>
    async (_url: unknown, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init!.body)) as { variables: Record<string, string> };
      const keys = Object.keys(variables)
        .filter((k) => k.startsWith('n'))
        .map((k) => `${variables[`o${k.slice(1)}`]}/${variables[k]}`);
      const failed = fail?.(keys);
      if (failed) return failed;
      const data: Record<string, unknown> = { rateLimit: { ...rate, resetAt: '' } };
      keys.forEach((key, i) => (data[`r${i}`] = node(key)));
      return respond({ data });
    };
  const sizes = (calls: string[][]) => calls.map((c) => c.length);

  it('batches 50 per query and adds up the cost', async () => {
    const keys = Array.from({ length: 120 }, (_, i) => `o/r${i}`);
    const calls: string[][] = [];
    const reply = answer({ cost: 2, remaining: 900 });
    const result = await fetchRepos(keys, 'token', async (url, init) => {
      calls.push(Object.keys(JSON.parse(String(init!.body)).variables).filter((k) => k[0] === 'n'));
      return reply(url, init);
    });
    expect(sizes(calls)).toEqual([50, 50, 20]);
    expect(result).toMatchObject({ cost: 6, queries: 3, warning: null });
    expect(result.lookup.size).toBe(120);
  });

  it('sends one query first and stops when the budget is low, keeping what it has', async () => {
    const keys = Array.from({ length: 600 }, (_, i) => `o/r${i}`);
    let calls = 0;
    const reply = answer({ cost: 3, remaining: 10 });
    const result = await fetchRepos(keys, 'token', async (url, init) => {
      calls++;
      return reply(url, init);
    });
    expect(calls).toBe(1);
    expect(result.lookup.size).toBe(50);
    expect(result.warning).toMatch(/budget ran low \(10 points left\): 550 of 600/);
  });

  it('reads the budget from the rate-limit header too', async () => {
    const keys = Array.from({ length: 200 }, (_, i) => `o/r${i}`);
    let calls = 0;
    const result = await fetchRepos(keys, 'token', async () => {
      calls++;
      return respond({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
    });
    expect(calls).toBe(1);
    expect(result.warning).toMatch(/budget ran low \(0 points left\)/);
  });

  it('splits a batch that times out and retries the halves', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `o/r${i}`);
    const calls: number[] = [];
    const result = await fetchRepos(
      keys,
      'token',
      answer(undefined, (batch) => {
        calls.push(batch.length);
        return batch.length > 25 ? respond({ message: 'Gateway timeout' }, 504) : null;
      }),
    );
    expect(calls).toEqual([50, 25, 25]);
    expect(result.lookup.size).toBe(50);
    expect(result.warning).toBeNull();
  });

  it('treats a GraphQL error in a 200 response as a failure, not an answer', async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `o/r${i}`);
    let calls = 0;
    const result = await fetchRepos(keys, 'token', async () => {
      calls++;
      return respond({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'Slow down' }] });
    });
    // A small batch: tried twice.
    expect(calls).toBe(2);
    expect(result.lookup.size).toBe(0);
    expect(result.warning).toMatch(/8 of 8 repositories not looked up \(last error: Error: RATE_LIMITED: Slow down\)/);
  });

  it('warns about repositories that failed inside an answered batch', async () => {
    const result = await fetchRepos(['a/one', 'b/two'], 'token', async () =>
      respond({
        data: { rateLimit: { cost: 1, remaining: 900, resetAt: '' }, r0: node('a/one'), r1: null },
        errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['r1'], message: 'Timeout' }],
      }),
    );
    expect(result.lookup.size).toBe(1);
    expect(result.warning).toMatch(/1 of 2 repositories not looked up/);
  });

  it('gives up after repeated failures, with a warning', async () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `o/r${i}`);
    let calls = 0;
    const result = await fetchRepos(keys, 'token', async () => {
      calls++;
      return respond({ message: 'Bad gateway' }, 502);
    });
    expect(result.lookup.size).toBe(0);
    expect(calls).toBeLessThan(30);
    expect(result.warning).toMatch(/kept failing: 1000 of 1000 repositories not looked up \(last error: Error: HTTP 502\)/);
  });
});
