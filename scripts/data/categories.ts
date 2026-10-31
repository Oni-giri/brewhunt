// Categories for homebrew/cask apps from CaskFlow (github.com/alielsokary/CaskFlow, MIT), which
// files each cask under one primary category and publishes the result as `categories.json` with
// each release. We keep only the primary category per token; content/categories.yaml maps
// CaskFlow's ids onto ours (src/lib/catalog.ts). Secondary categories aren't used.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ICON_REPO } from './icons.ts';
import { writeJson } from './state.ts';

/** Below this share of yesterday's tokens, the file is probably broken: keep yesterday's. */
const MIN_KEPT = 0.5;
/** Homebrew cask tokens; anything else is dropped. */
const TOKEN = /^[a-z0-9][a-z0-9@+._-]*$/;
/** CaskFlow's category ids: `developerTools`, `ai`. */
const CATEGORY_ID = /^[a-zA-Z]{1,40}$/;

/** site/caskflow-categories.json */
export interface CaskCategories {
  /** CaskFlow's release tag, `caskflow-v2026.10.31`. */
  release: string;
  /** CaskFlow's id → its display name, for the mapping in content/categories.yaml. */
  names: Record<string, string>;
  /** Cask token → CaskFlow's primary category id. */
  primary: Record<string, string>;
}

const fileSchema = z.object({
  categories: z.record(z.string(), z.object({ displayName: z.string() })),
  tokenToCategory: z.record(z.string(), z.object({ primary: z.string() })),
});

/** The release's categories.json, cut down to primary categories of tokens that look like casks. */
export function parseCaskCategories(release: string, json: unknown): CaskCategories {
  const file = fileSchema.parse(json);
  const names: Record<string, string> = {};
  for (const [id, { displayName }] of Object.entries(file.categories)) {
    if (CATEGORY_ID.test(id)) names[id] = displayName;
  }
  const primary: Record<string, string> = {};
  for (const token of Object.keys(file.tokenToCategory).sort()) {
    const id = file.tokenToCategory[token].primary;
    if (TOKEN.test(token) && !token.includes('..') && id in names) primary[token] = id;
  }
  return { release, names, primary };
}

/** Today's file, or null to keep yesterday's (a shrunken list is more likely a bug than a purge). */
export function acceptCaskCategories(
  next: CaskCategories,
  previous: CaskCategories | null,
): CaskCategories | null {
  const count = Object.keys(next.primary).length;
  if (count === 0) return null;
  if (previous && count < Object.keys(previous.primary).length * MIN_KEPT) return null;
  return next;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'user-agent': 'brewhunt-data (+https://github.com/Oni-giri/brewhunt)', ...headers },
  });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res;
}

export async function fetchCaskCategories(githubToken?: string): Promise<CaskCategories> {
  const latest = (await (
    await get(`https://api.github.com/repos/${ICON_REPO}/releases/latest`, {
      accept: 'application/vnd.github+json',
      ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
    })
  ).json()) as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] };
  const asset = latest.assets?.find((a) => a.name === 'categories.json');
  if (typeof latest.tag_name !== 'string' || typeof asset?.browser_download_url !== 'string') {
    throw new Error('no categories.json in the latest CaskFlow release');
  }
  // Release assets redirect to a signed download; fetch follows it.
  const json = await (await get(asset.browser_download_url)).json();
  return parseCaskCategories(latest.tag_name, json);
}

export async function readCaskCategories(dataDir: string): Promise<CaskCategories | null> {
  try {
    return JSON.parse(
      await readFile(join(dataDir, 'site', 'caskflow-categories.json'), 'utf8'),
    ) as CaskCategories;
  } catch {
    return null;
  }
}

/**
 * Refreshes site/caskflow-categories.json. Like icons, a nice-to-have: any failure keeps
 * yesterday's file and returns a warning instead of stopping the run.
 */
export async function updateCaskCategories(
  dataDir: string,
  fetchFile: () => Promise<CaskCategories>,
): Promise<{ categories: CaskCategories | null; warning: string | null }> {
  const previous = await readCaskCategories(dataDir);
  let next: CaskCategories;
  try {
    next = await fetchFile();
  } catch (error) {
    return {
      categories: previous,
      warning: `Couldn't fetch CaskFlow's categories, keeping the previous file: ${String(error)}`,
    };
  }
  const accepted = acceptCaskCategories(next, previous);
  if (!accepted) {
    const count = (c: CaskCategories | null) => Object.keys(c?.primary ?? {}).length;
    return {
      categories: previous,
      warning: `CaskFlow categorises ${count(next)} casks (previously ${count(previous)}); keeping the previous file`,
    };
  }
  await writeJson(join(dataDir, 'site', 'caskflow-categories.json'), accepted);
  return { categories: accepted, warning: null };
}
