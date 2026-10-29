// The data contract between the daily pipeline (scripts/data) and the Astro build.
// The pipeline writes these shapes to data/site/*.json and data/state/*.json on the
// `data` branch; the site only ever reads data/site.

export type PackageKind = 'formula' | 'cask';
export type PackageSource = 'official' | 'community';

/** Install counts for Homebrew's three rolling analytics windows. */
export interface WindowCounts {
  d30: number;
  d90: number;
  d365: number;
}

export interface Trend {
  /**
   * Change in the package's share of all installs, last 30 days against the basis: 0.42 means
   * its share grew 42%. A share, not a raw count, so Homebrew-wide swings in analytics volume
   * don't make everything look like it's climbing.
   */
  change: number;
  /**
   * What the last 30 days are compared with. Until 30 days of daily snapshots exist,
   * the only honest comparison is the average 30 days of the 60 before (from the 90-day window).
   */
  basis: 'previous-30-days' | 'previous-60-days-average';
}

/**
 * How `updatedAt` was found. `version`: the commit that introduced the current version.
 * `file`: the version changed but no commit names it, so this is the last change to the file.
 */
export type UpdatedKind = 'version' | 'file';

export interface Package {
  /** Core formula name or cask token (`wget`, `rectangle`), or `owner/tap/name` for community taps. */
  id: string;
  kind: PackageKind;
  source: PackageSource;
  /** `homebrew/core`, `homebrew/cask`, or a community tap's short name (`hashicorp/tap`). */
  tap: string;
  /** The package's own name without the tap (`terraform`). */
  token: string;
  /** Display name: the cask's app name, or the formula name. */
  name: string;
  desc: string | null;
  homepage: string | null;
  /** The package's own GitHub repository, when one is found (scripts/data/repos.ts). */
  repo: Repo | null;
  version: string | null;
  /** SPDX expression. Formulae only: casks don't declare a licence. */
  license: string | null;
  installCommand: string;
  /** The package definition on GitHub. */
  sourceUrl: string | null;
  /** Previous names and cask tokens, for redirects and search. */
  oldNames: string[];
  /** Formula aliases (`python` for `python@3.14`). */
  aliases: string[];
  /** Other display names of a cask ("VS Code" for Microsoft Visual Studio Code). */
  altNames: string[];
  /** Formulae: every install, including as a dependency. Casks: installs. */
  installs: WindowCounts;
  /** Formulae only: installs people asked for, not pulled in as a dependency. */
  installsOnRequest: WindowCounts | null;
  trend: Trend | null;
  /** Date (YYYY-MM-DD) the package was added to its tap; null if before the tap's tracking window. */
  firstSeen: string | null;
  /** Date the current version landed; null if before the tap's tracking window. */
  updatedAt: string | null;
  updatedKind: UpdatedKind | null;
  deprecated: boolean;
  /** Can no longer be installed. */
  disabled: boolean;
  /** Why it's deprecated or disabled; null when it's neither. */
  deprecation: Deprecation | null;
  /** Notes Homebrew prints after installing (plain text). */
  caveats: string | null;
  /** Formula installed but not linked into the prefix (usually because macOS ships a version). */
  kegOnly: boolean;
  /** Oldest macOS version a cask supports ("14"), when it says. */
  minMacos: string | null;
  /** Formula that is mostly installed as a dependency (openssl, libpng). Overridable in content/. */
  library: boolean;
  font: boolean;
  /** Versioned name like `postgresql@17` or `firefox@nightly`. */
  versioned: boolean;
  /** Cask that updates itself, so `brew upgrade` skips it by default. */
  autoUpdates: boolean;
  /** Cask artifact types (`app`, `binary`, `pkg`, `font`…). Empty for formulae. */
  artifacts: string[];
  /** Operating systems the package declares support for; null when unknown. */
  platforms: ('macos' | 'linux')[] | null;
  /** Runtime dependencies (formula names). */
  dependencies: string[];
}

export interface Repo {
  /** `https://github.com/cli/cli`, as GitHub gives it (after any rename). */
  url: string;
  /** `cli/cli`. */
  name: string;
  /** `releases`: no code, only downloads (obsidianmd/obsidian-releases). */
  kind: 'source' | 'releases';
  stars: number;
  /** Last push (ISO timestamp). */
  pushedAt: string | null;
  archived: boolean;
}

export interface Deprecation {
  /** Homebrew's reason code (`unmaintained`, `repo_archived`…) or a short sentence. */
  reason: string | null;
  /** When it was (or will be) deprecated. */
  date: string | null;
  /** When it was (or is scheduled to be) disabled. */
  disableDate: string | null;
  /** Package Homebrew suggests instead. */
  replacement: string | null;
}

export interface Tap {
  /** Short name, `hashicorp/tap`. */
  id: string;
  owner: string;
  /** GitHub repository name, `homebrew-tap`. */
  repo: string;
  url: string;
  description: string | null;
  stars: number | null;
  /** Last push to the repository (ISO timestamp). */
  pushedAt: string | null;
  archived: boolean;
  /** 30-day installs of all the tap's packages, listed on Brewhunt or not. */
  installs30d: number;
  /** Packages from this tap in packages.json. */
  packageIds: string[];
  /** False when the tap couldn't be read: its packages are listed from analytics alone. */
  enriched: boolean;
}

export interface AnalyticsWindow {
  start: string;
  end: string;
}

export interface Meta {
  schemaVersion: 1;
  /** Date of the pipeline run (YYYY-MM-DD, UTC). */
  generatedOn: string;
  /** Exact date ranges of Homebrew's analytics files, to label every number. */
  analytics: { d30: AnalyticsWindow; d90: AnalyticsWindow; d365: AnalyticsWindow };
  /** Per tap: firstSeen/updatedAt are unknown (null) for anything older than this date. */
  trackedSince: Record<string, string>;
  history: { days: number; first: string | null; last: string | null };
  counts: { formulae: number; casks: number; community: number; taps: number };
  warnings: string[];
}

/** Daily 30-day counts, aligned with `dates`, for the installs-over-time chart. */
export interface History {
  dates: string[];
  installs: Record<string, (number | null)[]>;
  installsOnRequest: Record<string, (number | null)[]>;
}

// --- Pipeline state, persisted on the data branch (not read by the site) ---

export interface PackageDates {
  firstSeen: string | null;
  updatedAt: string | null;
  updatedKind: UpdatedKind | null;
  /** Version when last seen, to notice changes between runs. */
  version: string | null;
}

export interface RepoState {
  /** Start of the first history window cloned for this repository. */
  trackedSince: string;
  /** Date of the last successful run that read this repository's history. */
  lastRun: string;
}

export interface PipelineState {
  schemaVersion: 1;
  repos: Record<string, RepoState>;
  packages: Record<string, PackageDates>;
}

/** One day of 30-day counts, keyed by the analytics end date. Stored by month. */
export interface Snapshot {
  installs: Record<string, number>;
  installsOnRequest: Record<string, number>;
  /** Every install in each feed that day, to turn counts into shares of the total. */
  totals?: { install: number; installOnRequest: number; caskInstall: number };
}

export type HistoryShard = Record<string, Snapshot>;
