// Joins Homebrew's metadata, the analytics, git dates and community taps into the files
// the site reads. Pure: all I/O happens in run.ts, so this is what the tests exercise.

import { addedDate, lastTouched, versionDate, type RepoHistory } from './git.ts';
import type { AnalyticsFeed, AnalyticsFile, AnalyticsPeriod, Cask, Formula, HomebrewData } from './homebrew.ts';
import { addDays, computeTrend, isLibrary } from './metrics.ts';
import { splitTapName, type TapRef, type TapScan } from './taps.ts';
import type {
  Deprecation,
  History,
  Meta,
  Package,
  PackageDates,
  PipelineState,
  Snapshot,
  Tap,
  WindowCounts,
} from './types.ts';

export const CORE_TAP = 'homebrew/core';
/** Community packages need this many installs in a year (or a recent addition) to be listed. */
export const COMMUNITY_MIN_INSTALLS = 10;
export const CASK_TAP = 'homebrew/cask';

export interface BuildInput {
  /** Date of this run (YYYY-MM-DD, UTC). */
  today: string;
  homebrew: HomebrewData;
  /** Git history of homebrew-core and homebrew-cask; null if the clone failed. */
  coreHistory: RepoHistory | null;
  caskHistory: RepoHistory | null;
  /** The community taps that were cloned and read, most installed first. */
  taps: TapScan[];
  /** Every community tap with installs, for tap totals. */
  tapRanking: TapRef[];
  previous: PipelineState;
  /** Yesterday's packages.json, to carry over taps that can't be read today. */
  previousPackages: Package[];
  /** Earlier snapshots by analytics end date. */
  snapshots: Map<string, Snapshot>;
  /** Per repository (`homebrew/core`, `owner/tap`): start of its tracking window. */
  trackedSince: Record<string, string>;
  /** Repositories read for the first time today: no previous state to carry over. */
  bootstrapped: Set<string>;
}

export interface BuildOutput {
  packages: Package[];
  taps: Tap[];
  meta: Meta;
  history: History;
  state: PipelineState;
  snapshotDate: string;
  snapshot: Snapshot;
}

const PERIODS: Record<AnalyticsPeriod, keyof WindowCounts> = { '30d': 'd30', '90d': 'd90', '365d': 'd365' };
const zeroCounts = (): WindowCounts => ({ d30: 0, d90: 0, d365: 0 });

/** Sums a feed's counts per package id; names nobody claims are reported back. */
function countByPackage(
  feed: Record<AnalyticsPeriod, AnalyticsFile>,
  resolve: (name: string) => string | undefined,
  unresolved: Map<string, number>,
): Map<string, WindowCounts> {
  const counts = new Map<string, WindowCounts>();
  for (const [period, key] of Object.entries(PERIODS) as [AnalyticsPeriod, keyof WindowCounts][]) {
    for (const [name, count] of feed[period].counts) {
      const id = resolve(name);
      if (!id) {
        if (period === '30d') unresolved.set(name, count);
        continue;
      }
      if (!counts.has(id)) counts.set(id, zeroCounts());
      counts.get(id)![key] += count;
    }
  }
  return counts;
}

/** Name lookup that prefers current names over old names and aliases. */
function nameIndex(entries: { id: string; names: string[]; others: string[] }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const { id, names } of entries) for (const n of names) index.set(n, id);
  for (const { id, others } of entries) for (const n of others) if (!index.has(n)) index.set(n, id);
  return index;
}

const formulaVersion = (f: Formula) =>
  f.versions.stable === null ? null : f.revision > 0 ? `${f.versions.stable}_${f.revision}` : f.versions.stable;

function caskPlatforms(platforms: string[] | null): Package['platforms'] {
  if (!platforms?.length) return null;
  const result: ('macos' | 'linux')[] = [];
  if (platforms.some((p) => !p.endsWith('_linux'))) result.push('macos');
  if (platforms.some((p) => p.endsWith('_linux'))) result.push('linux');
  return result;
}

const ARTIFACT_NOISE = new Set(['uninstall', 'zap', 'preflight', 'postflight', 'uninstall_preflight', 'uninstall_postflight']);
function caskArtifacts(cask: Cask): string[] {
  const kinds = new Set<string>();
  for (const artifact of cask.artifacts) {
    for (const key of Object.keys(artifact)) {
      if (!ARTIFACT_NOISE.has(key) && key !== 'target' && !key.endsWith('_steps')) kinds.add(key);
    }
  }
  return [...kinds].sort();
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Trimmed text without control characters, capped at `max`; null if empty. */
const cleanText = (text: string | null | undefined, max: number) => {
  const cleaned = text?.replace(CONTROL_CHARS, '').trim();
  return cleaned ? cleaned.slice(0, max) : null;
};

function deprecationOf(p: Formula | Cask): Deprecation | null {
  if (!p.deprecated && !p.disabled) return null;
  return {
    reason: (p.disabled ? (p.disable_reason ?? p.deprecation_reason) : p.deprecation_reason) ?? null,
    date: p.deprecation_date,
    disableDate: p.disable_date,
    replacement:
      p.deprecation_replacement_formula ??
      p.deprecation_replacement_cask ??
      p.disable_replacement_formula ??
      p.disable_replacement_cask,
  };
}

/** `depends_on macos: ">= :sonoma"` arrives as `{ ">=": ["14"] }`. */
function minMacos(cask: Cask): string | null {
  const atLeast = cask.depends_on?.macos?.['>='];
  const version = Array.isArray(atLeast) ? atLeast[0] : atLeast;
  return typeof version === 'string' ? version : null;
}

const isHttpUrl = (url: string | null | undefined): url is string => !!url && /^https?:\/\/[^\s]+$/i.test(url);

interface Draft {
  pkg: Omit<Package, 'trend' | 'firstSeen' | 'updatedAt' | 'updatedKind' | 'library'>;
  /** Version string that identifies a release (formulae include the revision). */
  datingVersion: string | null;
  /** Repository-relative path of the definition, for git dates. */
  path: string | null;
  repo: string;
  history: RepoHistory | null;
}

/**
 * Carries dates over from the previous run and fills in what git shows. See types.ts for
 * what `firstSeen` and `updatedAt` mean.
 */
export function resolveDates(
  draft: Pick<Draft, 'datingVersion' | 'path' | 'history'> & { oldNames: string[] },
  previous: PackageDates | undefined,
  previousUnderOldName: PackageDates | undefined,
  bootstrapped: boolean,
  today: string,
): PackageDates {
  const { datingVersion: version, path, history, oldNames } = draft;
  const added = history && path ? addedDate(history, path, oldNames) : null;

  let firstSeen: string | null;
  if (previous) firstSeen = previous.firstSeen ?? added;
  else if (previousUnderOldName) firstSeen = previousUnderOldName.firstSeen;
  else firstSeen = added;

  const carried = previous ?? previousUnderOldName;
  let updatedAt: string | null = null;
  let updatedKind: PackageDates['updatedKind'] = null;
  if (carried && carried.version === version) {
    ({ updatedAt, updatedKind } = carried);
  } else if (version && version !== 'latest' && history && path) {
    const date = versionDate(history, path, version);
    if (date) {
      [updatedAt, updatedKind] = [date, 'version'];
    } else if (carried || !bootstrapped) {
      // The version changed since the last run but no commit names it: use the file's last change.
      const touched = lastTouched(history, path) ?? added;
      if (touched) [updatedAt, updatedKind] = [touched, 'file'];
    }
  } else if (carried && version && !history) {
    // No history today (clone failed) but the version moved since the last run.
    [updatedAt, updatedKind] = [today, 'version'];
  }
  return { firstSeen, updatedAt, updatedKind, version };
}

export function buildCatalog(input: BuildInput): BuildOutput {
  const { homebrew, today, previous } = input;
  const warnings: string[] = [];
  const drafts: Draft[] = [];

  // --- Official formulae and casks ---
  for (const f of homebrew.formulae) {
    drafts.push({
      pkg: {
        id: f.name,
        kind: 'formula',
        source: 'official',
        tap: CORE_TAP,
        token: f.name,
        name: f.name,
        desc: cleanText(f.desc, 300),
        homepage: isHttpUrl(f.homepage) ? f.homepage : null,
        version: f.versions.stable,
        license: f.license,
        installCommand: `brew install ${f.name}`,
        sourceUrl: f.ruby_source_path ? `https://github.com/Homebrew/homebrew-core/blob/HEAD/${f.ruby_source_path}` : null,
        oldNames: f.oldnames,
        aliases: f.aliases,
        altNames: [],
        installs: zeroCounts(),
        installsOnRequest: zeroCounts(),
        deprecated: f.deprecated,
        disabled: f.disabled,
        deprecation: deprecationOf(f),
        caveats: cleanText(f.caveats, 1500),
        kegOnly: f.keg_only,
        minMacos: null,
        font: false,
        versioned: f.name.includes('@'),
        autoUpdates: false,
        artifacts: [],
        platforms: f.requirements.some((r) => r.name === 'linux')
          ? ['linux']
          : f.requirements.some((r) => r.name === 'macos')
            ? ['macos']
            : ['macos', 'linux'],
        dependencies: f.dependencies,
      },
      datingVersion: formulaVersion(f),
      path: f.ruby_source_path,
      repo: CORE_TAP,
      history: input.coreHistory,
    });
  }
  for (const c of homebrew.casks) {
    const artifacts = caskArtifacts(c);
    drafts.push({
      pkg: {
        id: c.token,
        kind: 'cask',
        source: 'official',
        tap: CASK_TAP,
        token: c.token,
        name: cleanText(c.name[0], 120) ?? c.token,
        desc: cleanText(c.desc, 300),
        homepage: isHttpUrl(c.homepage) ? c.homepage : null,
        version: c.version,
        license: null,
        installCommand: `brew install --cask ${c.token}`,
        sourceUrl: c.ruby_source_path ? `https://github.com/Homebrew/homebrew-cask/blob/HEAD/${c.ruby_source_path}` : null,
        oldNames: c.old_tokens,
        aliases: [],
        altNames: c.name.slice(1).map((n) => n.trim()).filter(Boolean),
        installs: zeroCounts(),
        installsOnRequest: null,
        deprecated: c.deprecated,
        disabled: c.disabled,
        deprecation: deprecationOf(c),
        caveats: cleanText(c.caveats, 1500),
        kegOnly: false,
        minMacos: minMacos(c),
        font: c.token.startsWith('font-') || artifacts.includes('font'),
        versioned: c.token.includes('@'),
        autoUpdates: c.auto_updates === true,
        artifacts,
        platforms: caskPlatforms(c.supported_platforms),
        dependencies: [],
      },
      datingVersion: c.version,
      path: c.ruby_source_path,
      repo: CASK_TAP,
      history: input.caskHistory,
    });
  }

  const officialIds = new Map<string, Draft>();
  for (const d of drafts) {
    const clash = officialIds.get(d.pkg.id);
    if (clash) {
      // Formula and cask share one URL space (/app/<id>); Homebrew keeps them distinct today.
      throw new Error(`Package id collision: ${d.pkg.kind} and ${clash.pkg.kind} are both "${d.pkg.id}"`);
    }
    officialIds.set(d.pkg.id, d);
  }

  // --- Analytics ---
  const unresolved = new Map<string, number>();
  const formulaIndex = nameIndex(
    homebrew.formulae.map((f) => ({ id: f.name, names: [f.name], others: [...f.oldnames, ...f.aliases] })),
  );
  const caskIndex = nameIndex(homebrew.casks.map((c) => ({ id: c.token, names: [c.token], others: c.old_tokens })));
  // Community entries resolve to `owner/tap/name` with the tap part lowercased.
  const communityId = (name: string) => {
    const split = splitTapName(name);
    return split ? `${split.tap}/${split.token}` : undefined;
  };
  const counts: Record<AnalyticsFeed, Map<string, WindowCounts>> = {
    install: countByPackage(homebrew.analytics.install, (n) => formulaIndex.get(n) ?? communityId(n), unresolved),
    installOnRequest: countByPackage(
      homebrew.analytics.installOnRequest,
      (n) => formulaIndex.get(n) ?? communityId(n),
      new Map(),
    ),
    caskInstall: countByPackage(homebrew.analytics.caskInstall, (n) => caskIndex.get(n) ?? communityId(n), unresolved),
  };
  const unresolvedOfficial = [...unresolved].filter(([n]) => !n.includes('/'));
  if (unresolvedOfficial.length) {
    const top = unresolvedOfficial.sort((a, b) => b[1] - a[1]).slice(0, 5);
    warnings.push(
      `${unresolvedOfficial.length} analytics names match no current package (removed or renamed away), e.g. ${top.map(([n, c]) => `${n} (${c})`).join(', ')}`,
    );
  }

  // --- Community taps ---
  const tapPackages = new Map<string, string[]>();
  for (const scan of input.taps) {
    const { ref } = scan;
    const ids = new Map<string, Draft>();
    if (!scan.ok) warnings.push(`Couldn't read tap ${ref.id}: ${scan.error ?? 'unknown error'}`);
    if (!scan.ok) {
      // Keep yesterday's listing for a tap we couldn't read today, so a GitHub hiccup doesn't
      // drop its packages. A tap never read successfully lists nothing: analytics alone
      // can't tell a real package from a mirror or a private repository.
      for (const prev of input.previousPackages.filter((p) => p.tap === ref.id)) {
        drafts.push({
          pkg: { ...prev, installs: zeroCounts(), installsOnRequest: prev.kind === 'formula' ? zeroCounts() : null },
          datingVersion: prev.version,
          path: null,
          repo: ref.id,
          history: null,
        });
      }
      continue;
    }
    const files = scan.packages.map(({ file, parsed }) => ({
      kind: file.kind,
      token: file.token,
      path: file.path,
      parsed,
    }));
    for (const { kind, token, path, parsed } of files) {
      const id = `${ref.id}/${token}`;
      const fullName = `${ref.id}/${token}`;
      const draft: Draft = {
        pkg: {
          id,
          kind,
          source: 'community',
          tap: ref.id,
          token,
          name: (kind === 'cask' ? parsed.name : null) ?? token,
          desc: parsed.desc,
          homepage: isHttpUrl(parsed.homepage) ? parsed.homepage : null,
          version: parsed.version,
          license: parsed.license,
          installCommand: kind === 'cask' ? `brew install --cask ${fullName}` : `brew install ${fullName}`,
          sourceUrl: path ? `https://github.com/${ref.owner}/${ref.repo}/blob/HEAD/${path}` : null,
          oldNames: [],
          aliases: [],
          altNames: [],
          installs: zeroCounts(),
          installsOnRequest: kind === 'formula' ? zeroCounts() : null,
          deprecated: parsed.deprecated,
          disabled: parsed.disabled,
          deprecation:
            parsed.deprecated || parsed.disabled
              ? { reason: null, date: null, disableDate: null, replacement: null }
              : null,
          caveats: null,
          kegOnly: false,
          minMacos: null,
          font: kind === 'cask' && token.startsWith('font-'),
          versioned: token.includes('@'),
          autoUpdates: parsed.autoUpdates,
          artifacts: [],
          platforms: null,
          dependencies: parsed.dependencies,
        },
        datingVersion: parsed.version,
        path,
        repo: ref.id,
        history: scan.history,
      };
      const clash = ids.get(id);
      if (clash) {
        // `brew install owner/tap/x` is ambiguous between a formula and a cask; keep the busier one.
        const installs = (d: Draft) =>
          (d.pkg.kind === 'cask' ? counts.caskInstall : counts.install).get(d.pkg.id)?.d30 ?? 0;
        warnings.push(`${id} is both a formula and a cask; listing the ${installs(draft) > installs(clash) ? kind : clash.pkg.kind}`);
        if (installs(draft) <= installs(clash)) continue;
      }
      ids.set(id, draft);
    }
    drafts.push(...ids.values());
  }

  // --- Join counts, dates and derived fields ---
  const nextState: PipelineState = { schemaVersion: 1, repos: {}, packages: {} };
  const d30 = homebrew.analytics.install['30d'];
  const d90 = homebrew.analytics.install['90d'];
  const snapshotDate = d30.end;
  const baselineSnapshot = input.snapshots.get(addDays(snapshotDate, -30));
  const sameEnd = Object.values(homebrew.analytics).every((feed) =>
    Object.values(feed).every((file) => file.end === snapshotDate),
  );
  if (!sameEnd) warnings.push('Analytics windows end on different dates; trends are skipped.');

  const packages: Package[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const { pkg } = draft;
    if (seen.has(pkg.id)) continue;
    seen.add(pkg.id);
    const isCask = pkg.kind === 'cask';
    const installs = (isCask ? counts.caskInstall : counts.install).get(pkg.id) ?? zeroCounts();
    const onRequest = isCask ? null : (counts.installOnRequest.get(pkg.id) ?? zeroCounts());

    const previousUnderOldName = pkg.oldNames.map((n) => previous.packages[n]).find(Boolean);
    const dates = resolveDates(
      { datingVersion: draft.datingVersion, path: draft.path, history: draft.history, oldNames: pkg.oldNames },
      previous.packages[pkg.id],
      previousUnderOldName,
      input.bootstrapped.has(draft.repo),
      today,
    );

    // Community packages hardly anyone installed in a year are mostly old versions and stubs.
    const recentlyAdded = !!dates.firstSeen && dates.firstSeen >= addDays(today, -30);
    if (pkg.source === 'community' && installs.d365 < COMMUNITY_MIN_INSTALLS && !recentlyAdded) {
      continue;
    }
    nextState.packages[pkg.id] = dates;

    // Popularity: installs on request for formulae (not pulled in as a dependency), installs for casks.
    const popularity = onRequest ?? installs;
    const feed = isCask ? 'caskInstall' : 'installOnRequest';
    const previous30 = baselineSnapshot
      ? ((isCask ? baselineSnapshot.installs : baselineSnapshot.installsOnRequest)[pkg.id] ?? 0)
      : null;
    const baselineStart = baselineSnapshot ? addDays(snapshotDate, -60) : d90.start;
    const trend = sameEnd
      ? computeTrend(
          { d30: popularity.d30, d90: popularity.d90, previous30 },
          {
            d30: homebrew.analytics[feed]['30d'].total,
            d90: homebrew.analytics[feed]['90d'].total,
            previous30: baselineSnapshot?.totals?.[feed] ?? null,
          },
          !!dates.firstSeen && dates.firstSeen > baselineStart,
        )
      : null;

    packages.push({
      ...pkg,
      installs,
      installsOnRequest: onRequest,
      trend,
      firstSeen: dates.firstSeen,
      updatedAt: dates.updatedAt,
      updatedKind: dates.updatedKind,
      library: !isCask && isLibrary(pkg.token, installs.d365, onRequest?.d365 ?? 0),
    });
    if (pkg.source === 'community') {
      if (!tapPackages.has(pkg.tap)) tapPackages.set(pkg.tap, []);
      tapPackages.get(pkg.tap)!.push(pkg.id);
    }
  }
  packages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // --- Taps ---
  const taps: Tap[] = input.taps.map(({ ref, ok, github }) => ({
    id: ref.id,
    owner: ref.owner,
    repo: ref.repo,
    url: `https://github.com/${ref.owner}/${ref.repo}`,
    description: github?.description ?? null,
    stars: github?.stars ?? null,
    pushedAt: github?.pushedAt ?? null,
    archived: github?.archived ?? false,
    installs30d: ref.installs30d,
    packageIds: (tapPackages.get(ref.id) ?? []).sort(),
    enriched: ok,
  }));

  // --- Snapshot and history ---
  const snapshot: Snapshot = {
    installs: {},
    installsOnRequest: {},
    totals: {
      install: homebrew.analytics.install['30d'].total,
      installOnRequest: homebrew.analytics.installOnRequest['30d'].total,
      caskInstall: homebrew.analytics.caskInstall['30d'].total,
    },
  };
  for (const p of packages) {
    if (p.installs.d30 > 0) snapshot.installs[p.id] = p.installs.d30;
    if (p.installsOnRequest && p.installsOnRequest.d30 > 0) snapshot.installsOnRequest[p.id] = p.installsOnRequest.d30;
  }
  const allSnapshots = new Map(input.snapshots);
  allSnapshots.set(snapshotDate, snapshot);
  const dates = [...allSnapshots.keys()].sort();
  const history: History = { dates, installs: {}, installsOnRequest: {} };
  for (const p of packages) {
    const series = (field: 'installs' | 'installsOnRequest') => dates.map((d) => allSnapshots.get(d)![field][p.id] ?? null);
    const installSeries = series('installs');
    if (installSeries.some((n) => n !== null)) history.installs[p.id] = installSeries;
    if (p.installsOnRequest) {
      const requestSeries = series('installsOnRequest');
      if (requestSeries.some((n) => n !== null)) history.installsOnRequest[p.id] = requestSeries;
    }
  }

  for (const [repo, since] of Object.entries(input.trackedSince)) {
    nextState.repos[repo] = { trackedSince: since, lastRun: today };
  }

  const analyticsWindow = (period: AnalyticsPeriod) => ({
    start: homebrew.analytics.install[period].start,
    end: homebrew.analytics.install[period].end,
  });
  const meta: Meta = {
    schemaVersion: 1,
    generatedOn: today,
    analytics: { d30: analyticsWindow('30d'), d90: analyticsWindow('90d'), d365: analyticsWindow('365d') },
    trackedSince: input.trackedSince,
    history: { days: dates.length, first: dates[0] ?? null, last: dates.at(-1) ?? null },
    counts: {
      formulae: packages.filter((p) => p.source === 'official' && p.kind === 'formula').length,
      casks: packages.filter((p) => p.source === 'official' && p.kind === 'cask').length,
      community: packages.filter((p) => p.source === 'community').length,
      taps: taps.length,
    },
    warnings,
  };

  return { packages, taps, meta, history, state: nextState, snapshotDate, snapshot };
}
