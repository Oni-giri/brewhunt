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
// Ceilings far above CaskFlow's release (0.9 MB, about 4,000 casks in 18 categories), so a
// runaway file fails the refresh instead of the run.
export const MAX_BYTES = 16_000_000;
const MAX_CATEGORIES = 100;
const MAX_TOKENS = 50_000;
const MAX_TEXT = 100;

/** site/caskflow-categories.json */
export interface CaskCategories {
  /** CaskFlow's release tag, `caskflow-v2026.10.31`. */
  release: string;
  /** CaskFlow's id → its display name, for the mapping in content/categories.yaml. */
  names: Record<string, string>;
  /** Cask token → CaskFlow's primary category id. */
  primary: Record<string, string>;
}

const text = z.string().min(1).max(MAX_TEXT);
const categoryId = z.string().regex(CATEGORY_ID);

/** What we store, checked again whenever it's read back. */
export const caskCategoriesSchema = z
  .strictObject({
    release: text,
    names: z.record(categoryId, text),
    primary: z.record(
      z
        .string()
        .regex(TOKEN)
        .refine((token) => !token.includes('..')),
      categoryId,
    ),
  })
  .refine((c) => Object.keys(c.names).length <= MAX_CATEGORIES, 'too many categories')
  .refine((c) => Object.keys(c.primary).length <= MAX_TOKENS, 'too many casks')
  .refine((c) => Object.values(c.primary).every((id) => id in c.names), 'unknown category id');

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
  return caskCategoriesSchema.parse({ release, names, primary });
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

/** CaskFlow ids that file at least one cask but that no category maps, with their cask counts. */
export function unmappedCategories(
  categories: CaskCategories,
  mapped: ReadonlySet<string>,
): Map<string, number> {
  const unmapped = new Map<string, number>();
  for (const id of Object.values(categories.primary)) {
    if (!mapped.has(id)) unmapped.set(id, (unmapped.get(id) ?? 0) + 1);
  }
  return unmapped;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'user-agent': 'brewhunt-data (+https://github.com/Oni-giri/brewhunt)', ...headers },
  });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res;
}

/** The response body as text, refusing one over `max` bytes before it's all in memory. */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length')) > max) throw new Error(`over ${max} bytes`);
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    // Leaving the loop cancels the download.
    if (size > max) throw new Error(`over ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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
  const body = await readCapped(await get(asset.browser_download_url), MAX_BYTES);
  return parseCaskCategories(latest.tag_name, JSON.parse(body));
}

/** Yesterday's file, or null if there's none or it isn't one we'd write. */
export async function readCaskCategories(dataDir: string): Promise<CaskCategories | null> {
  try {
    return caskCategoriesSchema.parse(
      JSON.parse(await readFile(join(dataDir, 'site', 'caskflow-categories.json'), 'utf8')),
    );
  } catch {
    return null;
  }
}

/**
 * Refreshes site/caskflow-categories.json. Like icons, a nice-to-have: any failure keeps
 * yesterday's file and returns a warning instead of stopping the run. So does a CaskFlow id that
 * files casks but isn't in any category's `caskflow` list (`mapped`): those apps would quietly
 * lose their category until content/categories.yaml maps it.
 */
export async function updateCaskCategories(
  dataDir: string,
  fetchFile: () => Promise<CaskCategories>,
  mapped: ReadonlySet<string>,
): Promise<{ categories: CaskCategories | null; warning: string | null }> {
  const previous = await readCaskCategories(dataDir);
  const keep = (reason: string) => ({
    categories: previous,
    warning: `${reason}; keeping the previous file`,
  });
  let next: CaskCategories;
  try {
    next = caskCategoriesSchema.parse(await fetchFile());
  } catch (error) {
    return keep(`Couldn't fetch CaskFlow's categories: ${String(error).slice(0, 300)}`);
  }
  const unmapped = unmappedCategories(next, mapped);
  if (unmapped.size > 0) {
    const list = [...unmapped].map(([id, n]) => `"${id}" (${n} casks)`).join(', ');
    return keep(
      `CaskFlow ${next.release} files casks under ${list}, which no category in content/categories.yaml maps`,
    );
  }
  if (!acceptCaskCategories(next, previous)) {
    const count = (c: CaskCategories | null) => Object.keys(c?.primary ?? {}).length;
    return keep(`CaskFlow categorises ${count(next)} casks (previously ${count(previous)})`);
  }
  await writeJson(join(dataDir, 'site', 'caskflow-categories.json'), next);
  return { categories: next, warning: null };
}
