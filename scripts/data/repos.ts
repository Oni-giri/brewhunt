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
 * undefined when a candidate wasn't looked up today (the caller keeps yesterday's answer).
 */
export function pickRepo(pkg: RepoOwnerOf, keys: readonly string[], lookup: RepoLookup): Repo | null | undefined {
  const homepageKey = repoKey(pkg.homepage);
  for (const key of keys) {
    if (!lookup.has(key)) return undefined;
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
  return null;
}

// --- GitHub ---

const ENDPOINT = 'https://api.github.com/graphql';
/** Repositories per query: GraphQL's node limit makes 100 the practical maximum. */
export const BATCH = 100;

// Counting releases (`releases { totalCount }`) times out at this size; the latest one is cheap.
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
  data?: { rateLimit?: { cost: number; remaining: number; resetAt: string } } & Record<string, unknown>;
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
 * with a NOT_FOUND error beside the others; any other error leaves that key out (not known today).
 */
export function readBatch(keys: readonly string[], response: Response, lookup: RepoLookup): void {
  const failed = new Set<number>();
  for (const error of response.errors ?? []) {
    const alias = error.path?.[0];
    const i = typeof alias === 'string' && /^r\d+$/.test(alias) ? Number(alias.slice(1)) : -1;
    if (i < 0) {
      // An error about the whole query: nothing in it can be trusted as "not found".
      for (let j = 0; j < keys.length; j++) failed.add(j);
    } else if (error.type !== 'NOT_FOUND') failed.add(i);
  }
  keys.forEach((key, i) => {
    if (failed.has(i)) return;
    const node = response.data?.[`r${i}`] as RepoNode | null | undefined;
    if (node === undefined) return;
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
}

export interface FetchReposResult {
  lookup: RepoLookup;
  /** Points spent and queries made. */
  cost: number;
  queries: number;
  /** Why some candidates weren't looked up, if any. */
  warning: string | null;
}

/**
 * Looks up every candidate, 100 per query, two queries at a time. Stops (keeping what it has)
 * when the hourly budget couldn't cover the next queries or GitHub keeps failing.
 */
export async function fetchRepos(
  keys: readonly string[],
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchReposResult> {
  const lookup: RepoLookup = new Map();
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));
  let cost = 0;
  let queries = 0;
  let lastCost = 1;
  let remaining = Infinity;
  let failures = 0;
  let warning: string | null = null;

  const run = async (batch: string[]) => {
    const body = JSON.stringify(batchQuery(batch));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'brewhunt' },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const response = (await res.json()) as Response;
        queries++;
        const rate = response.data?.rateLimit;
        if (rate) {
          cost += rate.cost;
          lastCost = rate.cost;
          remaining = Math.min(remaining, rate.remaining);
        }
        readBatch(batch, response, lookup);
        return;
      } catch (error) {
        if (attempt === 1) {
          failures++;
          warning = `GitHub repository lookup failed for some packages: ${String(error)}`;
        }
      }
    }
  };

  for (let i = 0; i < batches.length; i += 2) {
    if (remaining < lastCost * 4) {
      warning = `GitHub's GraphQL budget ran low (${remaining} points left): ${batches.length - i} of ${batches.length} repository batches skipped`;
      break;
    }
    if (failures >= 3) {
      warning = `GitHub repository lookup kept failing: ${batches.length - i} of ${batches.length} batches skipped`;
      break;
    }
    await Promise.all(batches.slice(i, i + 2).map(run));
  }
  return { lookup, cost, queries, warning };
}
