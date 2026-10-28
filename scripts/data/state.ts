// Reads and writes the pipeline's files under data/: state/ (what the next run needs) and
// site/ (what the Astro build reads). JSON is written with sorted keys, one top-level
// entry per line, so daily commits to the data branch stay small and diffable.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HistoryShard, Package, PipelineState, Snapshot } from './types.ts';

export const emptyState = (): PipelineState => ({ schemaVersion: 1, repos: {}, packages: {} });

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${file}: ${String(error)}`, { cause: error });
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Objects with sorted keys; arrays and top-level objects get one entry per line. */
export function stableJson(value: unknown): string {
  const sorted = sortKeys(value);
  if (Array.isArray(sorted)) {
    return `[\n${sorted.map((v) => JSON.stringify(v)).join(',\n')}\n]\n`;
  }
  if (sorted && typeof sorted === 'object') {
    const lines = Object.entries(sorted).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
    return `{\n${lines.join(',\n')}\n}\n`;
  }
  return `${JSON.stringify(sorted)}\n`;
}

/** Writes atomically so an interrupted run never leaves half a file behind. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, stableJson(value));
  await rename(tmp, file);
}

export async function readState(dataDir: string): Promise<PipelineState> {
  const state = await readJson<PipelineState>(join(dataDir, 'state', 'packages.json'));
  if (!state) return emptyState();
  if (state.schemaVersion !== 1) throw new Error(`Unknown state schemaVersion ${state.schemaVersion}`);
  return state;
}

export const writeState = (dataDir: string, state: PipelineState) =>
  writeJson(join(dataDir, 'state', 'packages.json'), state);

/** The previous run's package list, or nothing on a first run. */
export async function readPackages(dataDir: string): Promise<Package[]> {
  return (await readJson<Package[]>(join(dataDir, 'site', 'packages.json'))) ?? [];
}

const historyDir = (dataDir: string) => join(dataDir, 'state', 'history');

/** Every stored snapshot, by analytics end date. */
export async function readSnapshots(dataDir: string): Promise<Map<string, Snapshot>> {
  const snapshots = new Map<string, Snapshot>();
  let files: string[];
  try {
    files = (await readdir(historyDir(dataDir))).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));
  } catch {
    return snapshots;
  }
  for (const file of files.sort()) {
    const shard = await readJson<HistoryShard>(join(historyDir(dataDir), file));
    for (const [date, snapshot] of Object.entries(shard ?? {})) snapshots.set(date, snapshot);
  }
  return snapshots;
}

/**
 * Stores one day's counts in its month's shard. Keyed by the analytics end date, so running
 * twice for the same data replaces the entry instead of adding a day.
 */
export async function writeSnapshot(dataDir: string, date: string, snapshot: Snapshot) {
  const file = join(historyDir(dataDir), `${date.slice(0, 7)}.json`);
  const shard = (await readJson<HistoryShard>(file)) ?? {};
  shard[date] = snapshot;
  await writeJson(file, shard);
}
