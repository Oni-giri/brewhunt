// Downloads and validates Homebrew's public JSON API: formula/cask metadata and the
// install analytics. Only the fields Brewhunt uses are validated; the rest pass through.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const API = 'https://formulae.brew.sh/api';

export const WINDOWS = ['30d', '90d', '365d'] as const;
export type AnalyticsPeriod = (typeof WINDOWS)[number];

// `cask-install/{period}.json` covers every tap. The documented
// `cask-install/homebrew-cask/{period}.json` only covers the official cask tap.
export const ANALYTICS_FEEDS = {
  install: 'install',
  installOnRequest: 'install-on-request',
  caskInstall: 'cask-install',
} as const;
export type AnalyticsFeed = keyof typeof ANALYTICS_FEEDS;

export const formulaSchema = z.object({
  name: z.string().min(1),
  tap: z.string(),
  oldnames: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  desc: z.string().nullable(),
  license: z.string().nullable(),
  homepage: z.string().nullable(),
  versions: z.object({ stable: z.string().nullable() }),
  revision: z.number().int().default(0),
  dependencies: z.array(z.string()).default([]),
  requirements: z.array(z.object({ name: z.string() })).default([]),
  keg_only: z.boolean().default(false),
  deprecated: z.boolean(),
  disabled: z.boolean(),
  deprecation_date: z.string().nullable().default(null),
  deprecation_reason: z.string().nullable().default(null),
  deprecation_replacement_formula: z.string().nullable().default(null),
  deprecation_replacement_cask: z.string().nullable().default(null),
  disable_date: z.string().nullable().default(null),
  disable_reason: z.string().nullable().default(null),
  disable_replacement_formula: z.string().nullable().default(null),
  disable_replacement_cask: z.string().nullable().default(null),
  caveats: z.string().nullable().default(null),
  ruby_source_path: z.string().nullable(),
});
export type Formula = z.infer<typeof formulaSchema>;

export const caskSchema = z.object({
  token: z.string().min(1),
  tap: z.string(),
  old_tokens: z.array(z.string()).default([]),
  name: z.array(z.string()).default([]),
  desc: z.string().nullable(),
  homepage: z.string().nullable(),
  version: z.string().nullable(),
  auto_updates: z.boolean().nullable().default(false),
  depends_on: z
    .object({ macos: z.record(z.string(), z.unknown()).optional() })
    .nullable()
    .default(null),
  deprecated: z.boolean(),
  disabled: z.boolean(),
  deprecation_date: z.string().nullable().default(null),
  deprecation_reason: z.string().nullable().default(null),
  deprecation_replacement_formula: z.string().nullable().default(null),
  deprecation_replacement_cask: z.string().nullable().default(null),
  disable_date: z.string().nullable().default(null),
  disable_reason: z.string().nullable().default(null),
  disable_replacement_formula: z.string().nullable().default(null),
  disable_replacement_cask: z.string().nullable().default(null),
  caveats: z.string().nullable().default(null),
  artifacts: z.array(z.record(z.string(), z.unknown())).default([]),
  supported_platforms: z.array(z.string()).nullable().default(null),
  ruby_source_path: z.string().nullable(),
});
export type Cask = z.infer<typeof caskSchema>;

// Counts arrive as strings with thousands separators ("509,747").
const countSchema = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^\d{1,3}(,\d{3})*$|^\d+$/)
    .transform((s) => Number(s.replaceAll(',', ''))),
]);

const dateSchema = z.iso.date();

export const analyticsSchema = z.object({
  category: z.string(),
  start_date: dateSchema,
  end_date: dateSchema,
  total_count: countSchema,
  items: z.array(
    z
      .object({
        formula: z.string().min(1).optional(),
        cask: z.string().min(1).optional(),
        count: countSchema,
      })
      .refine((item) => (item.formula ?? item.cask) !== undefined, 'item has no name'),
  ),
});

export interface AnalyticsFile {
  start: string;
  end: string;
  /** Package name as Homebrew reports it (`wget`, `owner/tap/name`) → install count. */
  counts: Map<string, number>;
  /** Every install in the window, listed packages or not. */
  total: number;
}

export interface HomebrewData {
  formulae: Formula[];
  casks: Cask[];
  analytics: Record<AnalyticsFeed, Record<AnalyticsPeriod, AnalyticsFile>>;
}

export function parseAnalytics(json: unknown): AnalyticsFile {
  const file = analyticsSchema.parse(json);
  const counts = new Map<string, number>();
  for (const item of file.items) {
    const name = (item.formula ?? item.cask) as string;
    // A name can't legitimately appear twice; if it ever does, add rather than overwrite.
    counts.set(name, (counts.get(name) ?? 0) + item.count);
  }
  return { start: file.start_date, end: file.end_date, counts, total: file.total_count };
}

export function parseList<T>(schema: z.ZodType<T>, json: unknown, what: string): T[] {
  if (!Array.isArray(json)) throw new Error(`${what}: expected an array`);
  return json.map((entry, i) => {
    const result = schema.safeParse(entry);
    if (!result.success) {
      const name = (entry as { name?: string; token?: string })?.name ?? i;
      throw new Error(`${what}[${String(name)}]: ${z.prettifyError(result.error)}`);
    }
    return result.data;
  });
}

interface FetchOptions {
  /** Directory to cache raw responses in, for repeated local runs. */
  cacheDir?: string;
  retries?: number;
}

async function fetchJson(url: string, { cacheDir, retries = 3 }: FetchOptions): Promise<unknown> {
  const cacheFile = cacheDir ? join(cacheDir, url.replace(`${API}/`, '').replaceAll('/', '_')) : null;
  if (cacheFile) {
    try {
      return JSON.parse(await readFile(cacheFile, 'utf8'));
    } catch {
      // Not cached yet.
    }
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
        headers: { 'user-agent': 'brewhunt-data (+https://github.com/Oni-giri/brewhunt)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json: unknown = JSON.parse(text);
      if (cacheFile && cacheDir) {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, text);
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  throw new Error(`GET ${url} failed: ${String(lastError)}`);
}

export async function fetchHomebrew(options: FetchOptions = {}): Promise<HomebrewData> {
  const analyticsJobs = Object.entries(ANALYTICS_FEEDS).flatMap(([feed, path]) =>
    WINDOWS.map(async (period) => ({
      feed: feed as AnalyticsFeed,
      period,
      file: parseAnalytics(await fetchJson(`${API}/analytics/${path}/${period}.json`, options)),
    })),
  );
  const [formulaJson, caskJson, ...analyticsFiles] = await Promise.all([
    fetchJson(`${API}/formula.json`, options),
    fetchJson(`${API}/cask.json`, options),
    ...analyticsJobs,
  ]);

  const analytics = {} as HomebrewData['analytics'];
  for (const { feed, period, file } of analyticsFiles as Awaited<(typeof analyticsJobs)[number]>[]) {
    analytics[feed] ??= {} as Record<AnalyticsPeriod, AnalyticsFile>;
    analytics[feed][period] = file;
  }

  return {
    formulae: parseList(formulaSchema, formulaJson, 'formula.json'),
    casks: parseList(caskSchema, caskJson, 'cask.json'),
    analytics,
  };
}

const PERIOD_DAYS: Record<AnalyticsPeriod, number> = { '30d': 30, '90d': 90, '365d': 365 };
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Reasons not to publish this data, or an empty list. Catches what a valid but broken response
 * would look like: too few packages, an empty or stale window, windows ending on different
 * days (the endpoints updating one at a time), or a longer window with fewer installs.
 */
export function checkHomebrew(data: HomebrewData, today: string): string[] {
  const problems: string[] = [];
  if (data.formulae.length < 5000) problems.push(`only ${data.formulae.length} formulae`);
  if (data.casks.length < 5000) problems.push(`only ${data.casks.length} casks`);
  const end = data.analytics.install['30d'].end;
  const age = daysBetween(end, today);
  if (age > 7 || age < -1) problems.push(`analytics end ${end}, ${age} days from today`);
  for (const [feed, periods] of Object.entries(data.analytics)) {
    let previous: AnalyticsFile | null = null;
    for (const period of WINDOWS) {
      const file = periods[period];
      const name = `${feed} ${period}`;
      if (file.counts.size < 1000) problems.push(`${name} has ${file.counts.size} entries`);
      if (file.end !== end) problems.push(`${name} ends ${file.end}, not ${end}`);
      const span = daysBetween(file.start, file.end);
      if (Math.abs(span - PERIOD_DAYS[period]) > 2) problems.push(`${name} spans ${span} days`);
      if (previous && (file.total < previous.total || file.counts.size < previous.counts.size)) {
        problems.push(`${name} has fewer installs or entries than the shorter window`);
      }
      previous = file;
    }
  }
  return problems;
}
