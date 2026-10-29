// Daily data pipeline. Usage:
//   node scripts/data/run.ts [--data data] [--work .cache/pipeline] [--taps 100] [--cache-api]
// Reads the previous state from <data>/state, writes <data>/state and <data>/site.
// Set GITHUB_TOKEN for tap descriptions (the anonymous API limit is 60 requests an hour).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildCatalog } from './build.ts';
import { cloneRepo, readHistory, type RepoHistory } from './git.ts';
import { checkHomebrew, fetchHomebrew } from './homebrew.ts';
import { fetchIcons, updateIcons, type IconSet } from './icons.ts';
import { addDays } from './metrics.ts';
import {
  readPackages,
  readSnapshots,
  readState,
  writeJson,
  writeSnapshot,
  writeState,
} from './state.ts';
import { mapLimit, rankTaps, scanTap } from './taps.ts';

/** How far back the first run reads a repository's history: a year, plus margin. */
const BOOTSTRAP_DAYS = 400;
/** Later runs re-read a week before the last run, to cover late merges and missed days. */
const OVERLAP_DAYS = 7;
/** Share of the top taps that must be readable for the run to publish. */
const MIN_TAPS_READ = 0.8;

const { values: args } = parseArgs({
  options: {
    data: { type: 'string', default: 'data' },
    work: { type: 'string', default: '.cache/pipeline' },
    taps: { type: 'string', default: '100' },
    'cache-api': { type: 'boolean', default: false },
    today: { type: 'string' },
  },
});

const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function main() {
  const dataDir = resolve(args.data);
  const workDir = resolve(args.work);
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const tapLimit = Number(args.taps);

  const previous = await readState(dataDir);
  const snapshots = await readSnapshots(dataDir);
  const previousPackages = await readPackages(dataDir);
  log(`Previous state: ${Object.keys(previous.packages).length} packages, ${snapshots.size} days of history`);

  log('Fetching Homebrew API…');
  const homebrew = await fetchHomebrew({ cacheDir: args['cache-api'] ? join(workDir, 'api') : undefined });
  log(`${homebrew.formulae.length} formulae, ${homebrew.casks.length} casks`);
  // Refuse to publish if Homebrew's API returned something implausible.
  const problems = checkHomebrew(homebrew, today);
  if (problems.length) throw new Error(`Homebrew data failed sanity checks: ${problems.join('; ')}`);

  const trackedSince: Record<string, string> = {};
  const bootstrapped = new Set<string>();
  const windowFor = (repo: string) => {
    const state = previous.repos[repo];
    if (state) {
      trackedSince[repo] = state.trackedSince;
      return addDays(state.lastRun, -OVERLAP_DAYS);
    }
    const since = addDays(today, -BOOTSTRAP_DAYS);
    trackedSince[repo] = since;
    bootstrapped.add(repo);
    return since;
  };

  const officialHistory = async (repo: string, name: string, pathspec: string): Promise<RepoHistory | null> => {
    const dir = join(workDir, 'repos', name);
    try {
      await cloneRepo({ url: `https://github.com/Homebrew/${name}`, dir, since: windowFor(repo) });
      return await readHistory(dir, [pathspec]);
    } catch (error) {
      // Dates are carried over from the previous run; today's new packages wait for tomorrow.
      console.warn(`Couldn't read ${name} history: ${String(error)}`);
      delete trackedSince[repo];
      return null;
    }
  };

  const ranking = rankTaps([homebrew.analytics.install['30d'], homebrew.analytics.caskInstall['30d']]);
  const topTaps = ranking.slice(0, tapLimit);
  log(`Reading homebrew-core, homebrew-cask and ${topTaps.length} community taps…`);
  const [coreHistory, caskHistory, taps] = await Promise.all([
    officialHistory('homebrew/core', 'homebrew-core', 'Formula'),
    officialHistory('homebrew/cask', 'homebrew-cask', 'Casks'),
    mapLimit(topTaps, 8, (ref) =>
      scanTap(ref, { workDir: join(workDir, 'taps'), since: windowFor(ref.id), githubToken: process.env.GITHUB_TOKEN }),
    ),
  ]);
  for (const scan of taps) if (!scan.ok) delete trackedSince[scan.ref.id];
  const tapsRead = taps.filter((t) => t.ok).length;
  log(`Taps read: ${tapsRead}/${taps.length}`);
  // A few unreadable taps are normal (deleted, private); most of them failing means GitHub or
  // our cloning is broken, and publishing would drop new community packages.
  if (taps.length >= 10 && tapsRead < taps.length * MIN_TAPS_READ) {
    throw new Error(`Only ${tapsRead} of ${taps.length} taps could be read; not publishing.`);
  }

  const output = buildCatalog({
    today,
    homebrew,
    coreHistory,
    caskHistory,
    taps,
    tapRanking: ranking,
    previous,
    previousPackages,
    snapshots,
    trackedSince,
    bootstrapped,
  });
  // A repository that couldn't be read today keeps its previous tracking window.
  for (const [repo, state] of Object.entries(previous.repos)) output.state.repos[repo] ??= state;

  const icons = await updateIcons(dataDir, () => cachedIcons(join(workDir, 'api'), args['cache-api']));
  log(`App icons: ${icons.icons?.tokens.length ?? 0} at CaskFlow ${icons.icons?.commit.slice(0, 7) ?? '(none)'}`);
  if (icons.warning) output.meta.warnings.push(icons.warning);

  await writeSnapshot(dataDir, output.snapshotDate, output.snapshot);
  await writeState(dataDir, output.state);
  await writeJson(join(dataDir, 'site', 'packages.json'), output.packages);
  await writeJson(join(dataDir, 'site', 'taps.json'), output.taps);
  await writeJson(join(dataDir, 'site', 'meta.json'), output.meta);
  await writeJson(join(dataDir, 'site', 'history.json'), output.history);

  const { counts, warnings } = output.meta;
  log(
    `Wrote ${output.packages.length} packages (${counts.formulae} formulae, ${counts.casks} casks, ` +
      `${counts.community} community) and ${counts.taps} taps for analytics ending ${output.snapshotDate}`,
  );
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}

/** CaskFlow's icon list, cached with the API responses under --cache-api for repeatable runs. */
async function cachedIcons(cacheDir: string, cache: boolean): Promise<IconSet> {
  const file = join(cacheDir, 'caskflow-icons.json');
  if (cache) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as IconSet;
    } catch {
      // Not cached yet.
    }
  }
  const icons = await fetchIcons(process.env.GITHUB_TOKEN);
  if (cache) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(icons));
  }
  return icons;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
