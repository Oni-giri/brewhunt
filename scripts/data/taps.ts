// Community taps: pick the most-installed ones from the analytics, clone them, and read
// their package files as text (see ruby.ts; nothing is executed).

import { join } from 'node:path';
import { cloneRepo, readHistory, type RepoHistory } from './git.ts';
import type { AnalyticsFile } from './homebrew.ts';
import { parseCask, parseFormula, type RubyPackage } from './ruby.ts';
import { listTapFiles, readTapFile, type TapFile } from './tap-files.ts';

export interface TapRef {
  /** Short name as Homebrew writes it: `hashicorp/tap`. */
  id: string;
  owner: string;
  /** GitHub repository: `homebrew-tap`. */
  repo: string;
  installs30d: number;
}

/** Splits `owner/tap/name` analytics entries; null for core and official cask names. */
export function splitTapName(name: string): { tap: string; token: string } | null {
  const parts = name.split('/');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  const tap = `${parts[0]}/${parts[1]}`.toLowerCase();
  if (tap.startsWith('homebrew/')) return null;
  return { tap, token: parts[2] };
}

/** Community taps ranked by 30-day installs of all their formulae and casks. */
export function rankTaps(feeds: AnalyticsFile[]): TapRef[] {
  const totals = new Map<string, number>();
  for (const feed of feeds) {
    for (const [name, count] of feed.counts) {
      const split = splitTapName(name);
      if (split) totals.set(split.tap, (totals.get(split.tap) ?? 0) + count);
    }
  }
  return [...totals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, installs30d]) => {
      const [owner, tap] = id.split('/');
      return { id, owner, repo: `homebrew-${tap}`, installs30d };
    });
}

// Limits for one tap, so a huge or hostile repository can't stall the daily run. The
// largest real taps have under 1,000 package files.
const MAX_TAP_FILES = 5000;
const TAP_PARSE_BUDGET_MS = 90_000;

export interface GithubRepo {
  description: string | null;
  stars: number;
  pushedAt: string | null;
  archived: boolean;
}

export interface TapScan {
  ref: TapRef;
  /** False when the clone failed: the tap's packages are known from analytics only. */
  ok: boolean;
  error?: string;
  packages: { file: TapFile; parsed: RubyPackage }[];
  history: RepoHistory | null;
  github: GithubRepo | null;
}

/** GitHub repository details. Works without a token, but the anonymous limit is 60 an hour. */
export async function fetchGithubRepo(owner: string, repo: string, token?: string): Promise<GithubRepo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'brewhunt-data',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      description?: unknown;
      stargazers_count?: unknown;
      pushed_at?: unknown;
      archived?: unknown;
    };
    return {
      description: typeof json.description === 'string' && json.description.trim() ? json.description.trim().slice(0, 300) : null,
      stars: typeof json.stargazers_count === 'number' ? json.stargazers_count : 0,
      pushedAt: typeof json.pushed_at === 'string' ? json.pushed_at : null,
      archived: json.archived === true,
    };
  } catch {
    return null;
  }
}

export async function scanTap(
  ref: TapRef,
  { workDir, since, githubToken }: { workDir: string; since: string; githubToken?: string },
): Promise<TapScan> {
  const dir = join(workDir, `${ref.owner}__${ref.repo}`);
  const github = await fetchGithubRepo(ref.owner, ref.repo, githubToken);
  try {
    await cloneRepo({
      url: `https://github.com/${ref.owner}/${ref.repo}`,
      dir,
      since,
      checkout: ['/*.rb', '/Formula/', '/HomebrewFormula/', '/Casks/'],
      timeoutMs: 180_000,
    });
    const files = await listTapFiles(dir);
    if (files.length > MAX_TAP_FILES) throw new Error(`${files.length} package files, over ${MAX_TAP_FILES}`);
    const deadline = Date.now() + TAP_PARSE_BUDGET_MS;
    const packages: TapScan['packages'] = [];
    for (const file of files) {
      if (Date.now() > deadline) throw new Error(`reading took over ${TAP_PARSE_BUDGET_MS / 1000}s`);
      const source = await readTapFile(dir, file);
      if (source === null) continue;
      const parsed = file.kind === 'cask' ? parseCask(source, file.token) : parseFormula(source, file.token);
      packages.push({ file, parsed });
    }
    return { ref, ok: true, packages, history: await readHistory(dir), github };
  } catch (error) {
    return { ref, ok: false, error: String(error).slice(0, 300), packages: [], history: null, github };
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
