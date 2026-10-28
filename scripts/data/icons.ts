// Mac app icons from CaskFlow (github.com/alielsokary/CaskFlow, MIT), which extracts each
// homebrew/cask app's icon from its bundle and publishes 256px PNGs named by token on an `icons`
// branch. We don't copy the images: we record which tokens have one and the commit they're at,
// and the site loads them from jsDelivr pinned to that commit (immutable, cached for a year).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJson } from './state.ts';

export const ICON_REPO = 'alielsokary/CaskFlow';
const ICON_BRANCH = 'icons';
/** Below this share of yesterday's icons, the manifest is probably broken: keep yesterday's. */
const MIN_KEPT = 0.5;

const SHA = /^[0-9a-f]{40}$/;
/** Homebrew cask tokens; anything else (paths, URLs) is dropped. */
const TOKEN = /^[a-z0-9][a-z0-9@+._-]*$/;

/** site/icons.json */
export interface IconSet {
  /** CaskFlow commit the icons are read at. */
  commit: string;
  /** Cask tokens with an icon, sorted. */
  tokens: string[];
}

const manifestSchema = z.object({ hashes: z.record(z.string(), z.unknown()) });

/** The tokens in CaskFlow's icons.json, keeping only ones that look like cask tokens. */
export function parseIconManifest(json: unknown): string[] {
  const { hashes } = manifestSchema.parse(json);
  return Object.keys(hashes)
    .filter((token) => TOKEN.test(token) && !token.includes('..'))
    .sort();
}

/** Today's set, or null to keep yesterday's (a shrunken manifest is more likely a bug than a purge). */
export function acceptIcons(next: IconSet, previous: IconSet | null): IconSet | null {
  if (!SHA.test(next.commit) || next.tokens.length === 0) return null;
  if (previous && next.tokens.length < previous.tokens.length * MIN_KEPT) return null;
  return next;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'user-agent': 'brewhunt-data (+https://github.com/Oni-giri/brewhunt)', ...headers },
  });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchIcons(githubToken?: string): Promise<IconSet> {
  const branch = (await getJson(`https://api.github.com/repos/${ICON_REPO}/branches/${ICON_BRANCH}`, {
    accept: 'application/vnd.github+json',
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
  })) as { commit?: { sha?: unknown } };
  const commit = branch.commit?.sha;
  if (typeof commit !== 'string' || !SHA.test(commit)) throw new Error('no commit for the icons branch');
  const manifest = await getJson(`https://raw.githubusercontent.com/${ICON_REPO}/${commit}/icons.json`);
  return { commit, tokens: parseIconManifest(manifest) };
}

export async function readIcons(dataDir: string): Promise<IconSet | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'site', 'icons.json'), 'utf8')) as IconSet;
  } catch {
    return null;
  }
}

/**
 * Refreshes site/icons.json. Icons are a nice-to-have: any failure keeps yesterday's file and
 * returns a warning instead of stopping the run.
 */
export async function updateIcons(
  dataDir: string,
  fetchSet: () => Promise<IconSet>,
): Promise<{ icons: IconSet | null; warning: string | null }> {
  const previous = await readIcons(dataDir);
  let next: IconSet;
  try {
    next = await fetchSet();
  } catch (error) {
    return { icons: previous, warning: `Couldn't fetch app icons, keeping the previous set: ${String(error)}` };
  }
  const accepted = acceptIcons(next, previous);
  if (!accepted) {
    return {
      icons: previous,
      warning: `CaskFlow lists ${next.tokens.length} icons (previously ${previous?.tokens.length ?? 0}); keeping the previous set`,
    };
  }
  await writeJson(join(dataDir, 'site', 'icons.json'), accepted);
  return { icons: accepted, warning: null };
}
