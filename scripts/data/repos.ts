// Finds each package's GitHub repository. Homebrew only gives a homepage, which is rarely the
// repository (gh's is cli.github.com), but the download URLs often point at it: formula
// sources (`github.com/cli/cli/archive/…`) and cask release assets
// (`github.com/rxhanson/Rectangle/releases/download/…`). Candidates from those URLs are looked
// up with GitHub's GraphQL API and kept only when the repository is plausibly the package's own.
// Matching and classification are pure (build.ts); `fetchRepos` is the I/O, called from run.ts.

import type { Repo } from './types.ts';

/** What GitHub says about a candidate. */
export interface RepoInfo {
  /** As GitHub has it now (renamed repositories redirect): `cli/cli`. */
  nameWithOwner: string;
  url: string;
  isFork: boolean;
  isArchived: boolean;
  stars: number;
  pushedAt: string | null;
  homepageUrl: string | null;
  /** Any code GitHub recognises a language in. */
  hasCode: boolean;
  hasReleases: boolean;
}

/**
 * Candidate key (lowercase `owner/name`) → what GitHub said: the repository, or null when it
 * doesn't exist (or isn't public). A key that's missing wasn't looked up today.
 */
export type RepoLookup = Map<string, RepoInfo | null>;

// GitHub's rules for owner and repository names. Anything else (a `#{…}` fragment from a tap
// file, a path like /orgs/…) never reaches a query.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
/** github.com paths that aren't repositories. */
const NOT_OWNERS = new Set(['orgs', 'sponsors', 'features', 'topics', 'apps', 'marketplace', 'settings', 'login', 'about']);

/** `https://github.com/cli/cli/archive/v2.tar.gz` → `cli/cli`; null for anything else. */
export function repoKey(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const [owner, rawName] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !rawName) return null;
  const name = rawName.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null;
  if (NOT_OWNERS.has(owner.toLowerCase())) return null;
  return `${owner}/${name}`.toLowerCase();
}

/** Distinct candidates, in order: the homepage first, then the download URLs. */
export function candidates(homepage: string | null, urls: readonly (string | null | undefined)[]): string[] {
  const keys = [homepage, ...urls].map(repoKey).filter((k): k is string => k !== null);
  return [...new Set(keys)];
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const segments = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const host = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

export interface RepoOwnerOf {
  token: string;
  name: string;
  homepage: string | null;
}

/**
 * Whether `info` is the package's own repository. The homepage pointing at it is the author's
 * own word. A download URL is only a hint: it has to agree with the package's name (the
 * repository's name, owner, or owner and name together: docker/compose for docker-compose,
 * obsidianmd/obsidian-releases for obsidian) or with its homepage (the repository's homepage on
 * the same host: cli/cli is cli.github.com). Forks never count.
 */
export function isOwnRepo(pkg: RepoOwnerOf, info: RepoInfo, fromHomepage: boolean): boolean {
  if (info.isFork) return false;
  if (fromHomepage) return true;
  const [owner, name] = info.nameWithOwner.split('/');
  // `python@3.14` is python's; `font-` casks are named after the font.
  const wanted = new Set(
    [pkg.token.replace(/@.*$/, ''), pkg.name].map(squash).filter((w) => w.length > 0),
  );
  if (wanted.has(squash(name)) || wanted.has(squash(owner)) || wanted.has(squash(owner + name))) return true;
  if (segments(name).some((s) => wanted.has(s))) return true;
  const ours = host(pkg.homepage);
  return ours !== null && ours !== 'github.com' && ours === host(info.homepageUrl);
}

/** Source code, or a repository that only publishes downloads (obsidianmd/obsidian-releases). */
export const repoKind = (info: RepoInfo): Repo['kind'] =>
  !info.hasCode && info.hasReleases ? 'releases' : 'source';

/**
 * The package's repository from today's lookup: a Repo, null when no candidate qualifies, or
 * undefined when that depends on a candidate GitHub didn't answer today (the caller keeps
 * yesterday's `previous`). Yesterday's repository is dropped once GitHub says it's gone or no
 * longer qualifies, whatever else went unanswered.
 */
export function pickRepo(
  pkg: RepoOwnerOf,
  keys: readonly string[],
  lookup: RepoLookup,
  previous: Repo | null = null,
): Repo | null | undefined {
  const homepageKey = repoKey(pkg.homepage);
  let unanswered = false;
  for (const key of keys) {
    if (!lookup.has(key)) {
      unanswered = true;
      continue;
    }
    const info = lookup.get(key);
    if (info && isOwnRepo(pkg, info, key === homepageKey)) {
      return {
        url: info.url,
        name: info.nameWithOwner,
        kind: repoKind(info),
        stars: info.stars,
        pushedAt: info.pushedAt,
        archived: info.isArchived,
      };
    }
  }
  if (!unanswered) return null;
  if (previous) {
    const key = previous.name.toLowerCase();
    const info = lookup.get(key);
    if (lookup.has(key) && !(info && isOwnRepo(pkg, info, key === homepageKey))) return null;
  }
  return undefined;
}

// --- GitHub ---

const ENDPOINT = 'https://api.github.com/graphql';
/**
 * Repositories per query. 100 is GraphQL's limit, but GitHub times out (502/504) on some batches
 * that size; a batch that fails is split in half and tried again.
 */
export const BATCH = 50;
const MIN_BATCH = 10;
/** Batches of MIN_BATCH or fewer that failed twice before the lookup gives up. */
const MAX_FAILURES = 3;
/**
 * Total time to spend waiting when GitHub says to slow down (403/429 with the hourly budget
 * left: its secondary limits, which Actions' token hits after a few dozen quick queries).
 */
const MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_WAIT_MS = 60_000;

// Counting releases (`releases { totalCount }`) times out; the latest one is cheap.
const FIELDS = `nameWithOwner url isFork isArchived stargazerCount pushedAt homepageUrl
  languages(first: 1) { totalCount } latestRelease { createdAt }`;

interface RepoNode {
  nameWithOwner: string;
  url: string;
  isFork: boolean;
  isArchived: boolean;
  stargazerCount: number;
  pushedAt: string | null;
  homepageUrl: string | null;
  languages: { totalCount: number };
  latestRelease: { createdAt: string } | null;
}

interface Response {
  data?: ({ rateLimit?: { cost: number; remaining: number; resetAt: string } } & Record<string, unknown>) | null;
  errors?: { type?: string; path?: (string | number)[]; message: string }[];
}

/** The query for one batch, with every name passed as a variable. */
export function batchQuery(keys: readonly string[]): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = {};
  const declarations: string[] = [];
  const fields: string[] = [];
  keys.forEach((key, i) => {
    const [owner, name] = key.split('/');
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    declarations.push(`$o${i}: String!, $n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...F }`);
  });
  const query = `query(${declarations.join(', ')}) {
  rateLimit { cost remaining resetAt }
  ${fields.join('\n  ')}
}
fragment F on Repository { ${FIELDS} }`;
  return { query, variables };
}

/**
 * Reads one batch's response into `lookup`. A repository that doesn't exist comes back as null
 * with a NOT_FOUND error beside the others. Any other error on one repository leaves its key out
 * (not known today); an error about the whole query (rate limit, timeout) changes nothing and is
 * returned, for the caller to retry.
 */
export function readBatch(
  keys: readonly string[],
  response: Response,
  lookup: RepoLookup,
): { queryError: string | null; failed: number } {
  const failed = new Set<number>();
  for (const error of response.errors ?? []) {
    const alias = error.path?.[0];
    const i = typeof alias === 'string' && /^r\d+$/.test(alias) ? Number(alias.slice(1)) : -1;
    if (i < 0 || i >= keys.length) return { queryError: `${error.type ?? 'error'}: ${error.message}`, failed: 0 };
    if (error.type !== 'NOT_FOUND') failed.add(i);
  }
  if (!response.data) return { queryError: 'no data in the response', failed: 0 };
  keys.forEach((key, i) => {
    const node = response.data?.[`r${i}`] as RepoNode | null | undefined;
    if (failed.has(i) || node === undefined) {
      failed.add(i);
      return;
    }
    lookup.set(
      key,
      node === null
        ? null
        : {
            nameWithOwner: node.nameWithOwner,
            url: node.url,
            isFork: node.isFork,
            isArchived: node.isArchived,
            stars: node.stargazerCount,
            pushedAt: node.pushedAt,
            homepageUrl: node.homepageUrl || null,
            hasCode: node.languages.totalCount > 0,
            hasReleases: node.latestRelease !== null,
          },
    );
  });
  return { queryError: null, failed: failed.size };
}

export interface FetchReposResult {
  lookup: RepoLookup;
  /** Points spent and queries made. */
  cost: number;
  queries: number;
  /** Why some candidates weren't looked up, if any. */
  warning: string | null;
}

/** GitHub asked us to wait before the next query. */
class SlowDown extends Error {
  readonly waitMs: number;
  constructor(message: string, waitMs: number) {
    super(message);
    this.waitMs = waitMs;
  }
}

export interface FetchReposOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Looks up every candidate, BATCH per query, one query at a time. A batch that fails is split in
 * half (or, at MIN_BATCH, retried once); when GitHub says to slow down, it waits as told. Stops,
 * keeping what it has, when the hourly budget couldn't cover the next query, GitHub keeps
 * failing, or the waiting adds up to MAX_WAIT_MS.
 */
export async function fetchRepos(
  keys: readonly string[],
  token: string,
  options: FetchReposOptions = {},
): Promise<FetchReposResult> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lookup: RepoLookup = new Map();
  const queue: { keys: string[]; tries: number }[] = [];
  for (let i = 0; i < keys.length; i += BATCH) queue.push({ keys: keys.slice(i, i + BATCH), tries: 0 });
  let cost = 0;
  let queries = 0;
  let lastCost = 1;
  let remaining = Infinity;
  let failures = 0;
  let waited = 0;
  let unanswered = 0;
  let lastError: string | null = null;
  let stopped: string | null = null;

  const query = async (batch: string[]) => {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'brewhunt' },
      body: JSON.stringify(batchQuery(batch)),
      signal: AbortSignal.timeout(30_000),
    });
    queries++;
    const header = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (Number.isFinite(header)) remaining = Math.min(remaining, header);
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      const message = `HTTP ${res.status}${text ? `: ${text}` : ''}`;
      if ((res.status === 403 || res.status === 429) && remaining > 0) {
        const after = Number(res.headers.get('retry-after') ?? NaN);
        throw new SlowDown(message, Number.isFinite(after) ? after * 1000 : DEFAULT_WAIT_MS);
      }
      throw new Error(message);
    }
    const response = (await res.json()) as Response;
    const rate = response.data?.rateLimit;
    if (rate) {
      cost += rate.cost;
      lastCost = Math.max(1, rate.cost);
      remaining = Math.min(remaining, rate.remaining);
    }
    const { queryError, failed } = readBatch(batch, response, lookup);
    if (queryError) throw new Error(queryError);
    if (failed) {
      unanswered += failed;
      lastError = `${failed} repositories failed in a batch`;
    }
  };

  while (queue.length > 0) {
    if (remaining < lastCost * 2) {
      stopped = `GitHub's GraphQL budget ran low (${remaining} points left)`;
      break;
    }
    if (failures >= MAX_FAILURES) {
      stopped = 'GitHub repository lookup kept failing';
      break;
    }
    const item = queue.shift()!;
    try {
      await query(item.keys);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof SlowDown) {
        queue.unshift(item);
        if (waited + error.waitMs > MAX_WAIT_MS) {
          stopped = 'GitHub kept asking to slow down';
          break;
        }
        waited += error.waitMs;
        await sleep(error.waitMs);
      } else if (item.keys.length > MIN_BATCH) {
        const half = Math.ceil(item.keys.length / 2);
        queue.unshift({ keys: item.keys.slice(0, half), tries: 0 }, { keys: item.keys.slice(half), tries: 0 });
      } else if (item.tries === 0) {
        // Straight away, so an outage reaches MAX_FAILURES before every batch has been split.
        queue.unshift({ keys: item.keys, tries: 1 });
      } else {
        failures++;
        unanswered += item.keys.length;
      }
    }
  }
  for (const item of queue) unanswered += item.keys.length;
  const warning =
    unanswered === 0
      ? null
      : `${stopped ?? 'GitHub repository lookup incomplete'}: ${unanswered} of ${keys.length} repositories not looked up (last error: ${lastError}); their packages keep yesterday's repository`;
  if (waited > 0) console.warn(`GitHub asked to slow down: waited ${Math.round(waited / 1000)}s in all`);
  return { lookup, cost, queries, warning };
}
