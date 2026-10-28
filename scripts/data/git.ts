// Reads a tap's git history to date its packages: when each one was added and when its
// current version landed. Clones are partial (no file contents) and shallow (only the
// tracking window), and nothing from the repository is ever executed.

import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Paths that can hold packages in any tap (see tap-files.ts for the exact layout rules).
export const PACKAGE_PATHSPECS = ['Formula', 'HomebrewFormula', 'Casks', ':(glob)*.rb'];

const GIT_ENV = {
  ...process.env,
  // Fail instead of prompting for credentials when a repository is missing or private.
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  // Dates in UTC whatever the runner's timezone.
  TZ: 'UTC',
};

// Hardening for untrusted repositories: symlinks become plain files, no local file
// transport, no credential helpers, no hooks from the user's config.
const GIT_SAFE = [
  '-c',
  'core.symlinks=false',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'credential.helper=',
  '-c',
  'core.hooksPath=/dev/null',
];

export async function git(args: string[], cwd?: string, timeoutMs = 600_000): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_SAFE, ...args], {
    cwd,
    env: GIT_ENV,
    maxBuffer: 1024 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout;
}

export interface CloneOptions {
  url: string;
  dir: string;
  /** Fetch history since this date (YYYY-MM-DD); null for the latest commit only. */
  since: string | null;
  /** Check out only these paths (git sparse-checkout patterns); omit to skip checkout. */
  checkout?: string[];
  timeoutMs?: number;
}

/** Clones without file contents (fetched lazily for checkout). Replaces `dir` if it exists. */
export async function cloneRepo({ url, dir, since, checkout, timeoutMs }: CloneOptions) {
  const base = ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--single-branch'];
  await rm(dir, { recursive: true, force: true });
  try {
    await git([...base, ...(since ? [`--shallow-since=${since}`] : ['--depth=1']), url, dir], undefined, timeoutMs);
  } catch (error) {
    // A repository with no commits in the window can't be cloned with --shallow-since.
    if (!since) throw error;
    await rm(dir, { recursive: true, force: true });
    await git([...base, '--depth=1', url, dir], undefined, timeoutMs);
  }
  if (checkout) {
    await git(['sparse-checkout', 'set', '--no-cone', ...checkout], dir);
    await git(['checkout', '--quiet'], dir, timeoutMs);
  }
}

/** Commits at the edge of a shallow clone. Their diffs show every file as added, so skip them. */
export async function shallowBoundary(dir: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, '.git', 'shallow'), 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export interface Commit {
  parents: string[];
  date: string;
}

export interface FileChange {
  hash: string;
  date: string;
  status: 'A' | 'M' | 'D';
}

export interface RepoHistory {
  /** Every commit in the window, by hash. */
  commits: Map<string, Commit>;
  /** For each commit, the date it reached the default branch (merge date for PR commits). */
  landed: Map<string, string>;
  /** Changes on the default branch (first-parent), newest first, per path. */
  mainline: Map<string, FileChange[]>;
  /** Paths deleted by each mainline commit, to recognise moves and renames. */
  deletedBy: Map<string, string[]>;
  /** Subjects of every commit (merged branches included) that touched each path, newest first. */
  subjects: Map<string, { hash: string; subject: string }[]>;
}

const DATE_FORMAT = '--date=format-local:%Y-%m-%d';

/** Parses `git log --format=@<fields…>` output followed by file lines. */
function* logEntries(out: string): Generator<{ header: string[]; files: string[] }> {
  let header: string[] | null = null;
  let files: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('@')) {
      if (header) yield { header, files };
      header = line.slice(1).split('\t');
      files = [];
    } else if (line && header) {
      files.push(line);
    }
  }
  if (header) yield { header, files };
}

export function parseGraph(out: string): Map<string, Commit> {
  const commits = new Map<string, Commit>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [hash, parents, date] = line.split('\t');
    commits.set(hash, { parents: parents ? parents.split(' ') : [], date });
  }
  return commits;
}

/**
 * Walks the first-parent chain from `head`, oldest first, and gives every commit the date
 * of the first mainline commit that contains it. A PR's commits land with its merge.
 */
export function landingDates(commits: Map<string, Commit>, head: string): Map<string, string> {
  const mainline: string[] = [];
  for (let hash: string | undefined = head; hash && commits.has(hash); ) {
    mainline.push(hash);
    hash = commits.get(hash)!.parents[0];
  }
  const landed = new Map<string, string>();
  for (const hash of mainline.reverse()) {
    const { date, parents } = commits.get(hash)!;
    landed.set(hash, date);
    const stack = parents.slice(1);
    while (stack.length) {
      const next = stack.pop()!;
      const commit = commits.get(next);
      if (!commit || landed.has(next)) continue;
      landed.set(next, date);
      stack.push(...commit.parents);
    }
  }
  return landed;
}

export function parseMainline(out: string) {
  const mainline = new Map<string, FileChange[]>();
  const deletedBy = new Map<string, string[]>();
  for (const { header, files } of logEntries(out)) {
    const [hash, date] = header;
    for (const line of files) {
      const [status, path] = line.split('\t');
      if (status !== 'A' && status !== 'M' && status !== 'D') continue;
      if (!mainline.has(path)) mainline.set(path, []);
      mainline.get(path)!.push({ hash, date, status });
      if (status === 'D') {
        if (!deletedBy.has(hash)) deletedBy.set(hash, []);
        deletedBy.get(hash)!.push(path);
      }
    }
  }
  return { mainline, deletedBy };
}

export function parseSubjects(out: string) {
  const subjects = new Map<string, { hash: string; subject: string }[]>();
  for (const { header, files } of logEntries(out)) {
    const [hash, ...rest] = header;
    const subject = rest.join('\t');
    for (const path of files) {
      if (!subjects.has(path)) subjects.set(path, []);
      subjects.get(path)!.push({ hash, subject });
    }
  }
  return subjects;
}

export async function readHistory(dir: string, pathspecs = PACKAGE_PATHSPECS): Promise<RepoHistory> {
  const boundary = await shallowBoundary(dir);
  const range = ['HEAD', ...(boundary.length ? ['--not', ...boundary] : [])];
  const head = (await git(['rev-parse', 'HEAD'], dir)).trim();

  const [graphOut, mainlineOut, subjectsOut] = await Promise.all([
    git(['log', '--format=%H%x09%P%x09%cd', DATE_FORMAT, ...range], dir),
    git(
      ['log', '--first-parent', '--diff-merges=first-parent', '--format=@%H%x09%cd', DATE_FORMAT, '--name-status', '--no-renames', ...range, '--', ...pathspecs],
      dir,
    ),
    git(
      ['log', '--format=@%H%x09%s', '--name-only', '--no-renames', '--diff-merges=off', ...range, '--', ...pathspecs],
      dir,
    ),
  ]);

  const commits = parseGraph(graphOut);
  // The boundary commits themselves are in the clone but their parents aren't; keep them
  // out so their "everything added" diffs never count.
  for (const hash of boundary) commits.delete(hash);
  const { mainline, deletedBy } = parseMainline(mainlineOut);
  return {
    commits,
    landed: landingDates(commits, head),
    mainline,
    deletedBy,
    subjects: parseSubjects(subjectsOut),
  };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches a version as a whole token in a commit subject: "wget 1.25.0", "bump-wget-1.25.0",
 * "wget: update 1.25.0_2 bottle.", "update foo to v1.2.3". "1.2" doesn't match "1.2.3" or "1.2_1".
 */
export function versionPattern(version: string): RegExp {
  return new RegExp(`(?:^|[\\s/(\\-@])v?${escapeRegExp(version)}(?=$|[\\s),:;]|\\.(?:\\s|$))`);
}

const tokenOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.rb$/, '');

/**
 * The date a package was added on the default branch, or null if it was added before the
 * window. A move (same name, new path) or a rename (an old name deleted in the same commit)
 * isn't an addition.
 */
export function addedDate(history: RepoHistory, path: string, oldNames: string[] = []): string | null {
  const changes = history.mainline.get(path) ?? [];
  // Newest first: the latest addition counts if the file was ever deleted and re-added.
  const added = changes.find((c) => c.status === 'A');
  if (!added) return null;
  const sameNames = new Set([tokenOf(path), ...oldNames]);
  const deleted = history.deletedBy.get(added.hash) ?? [];
  if (deleted.some((p) => sameNames.has(tokenOf(p)))) return null;
  return added.date;
}

/**
 * Spellings of a version that commit subjects use. Cask versions like "0.5.16,261015" carry a
 * build suffix after the comma that bump commits usually leave out ("paper-design 0.5.16").
 */
export function versionSpellings(version: string): string[] {
  const comma = version.indexOf(',');
  return comma > 0 ? [version, version.slice(0, comma)] : [version];
}

/** Date the given version first landed, from commit subjects that name it. */
export function versionDate(history: RepoHistory, path: string, version: string): string | null {
  const commits = history.subjects.get(path) ?? [];
  for (const spelling of versionSpellings(version)) {
    const pattern = versionPattern(spelling);
    let earliest: string | null = null;
    for (const { hash, subject } of commits) {
      if (!pattern.test(subject)) continue;
      // Squash merges and direct pushes are mainline commits: they land on their own date.
      const landed = history.landed.get(hash);
      if (landed && (!earliest || landed < earliest)) earliest = landed;
    }
    if (earliest) return earliest;
  }
  return null;
}

/** Last change to the file on the default branch within the window. */
export function lastTouched(history: RepoHistory, path: string): string | null {
  return history.mainline.get(path)?.[0]?.date ?? null;
}
