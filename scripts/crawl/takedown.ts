// content/takedown.yaml applied to the crawler's results (M5 C9). It wins over everything: a
// package listed without hashes loses all its crawled text and images; listed hashes remove
// those images wherever they're shown, since one image can serve two packages (bun and
// oven-sh/bun/bun). Removed images are deleted from the store on the next run.

import type { Takedown } from '../content/schema.ts';
import type { AssetRecord } from './assets.ts';

export interface Takedowns {
  /** Packages that keep no crawled content at all. */
  packages: Set<string>;
  /** Source or output hashes of images that can't be shown. */
  hashes: Set<string>;
}

export function readTakedowns(list: readonly Takedown[]): Takedowns {
  const packages = new Set<string>();
  const hashes = new Set<string>();
  for (const t of list) {
    if (t.hashes.length === 0) packages.add(t.id);
    for (const hash of t.hashes) hashes.add(hash);
  }
  return { packages, hashes };
}

export const isTakenDown = (asset: AssetRecord, takedowns: Takedowns): boolean =>
  takedowns.packages.has(asset.package) ||
  takedowns.hashes.has(asset.sourceHash) ||
  takedowns.hashes.has(asset.outputHash);

/**
 * Splits this run's assets into those that may be shown and those taken down, and lists the
 * stored keys to delete: a key goes only when no asset still shown uses it.
 */
export function applyTakedowns(
  assets: readonly AssetRecord[],
  takedowns: Takedowns,
  /** Assets already in the store, from the previous run's manifest. */
  stored: readonly AssetRecord[] = [],
): { kept: AssetRecord[]; removed: AssetRecord[]; deleteKeys: string[] } {
  const kept: AssetRecord[] = [];
  const removed: AssetRecord[] = [];
  for (const asset of assets) (isTakenDown(asset, takedowns) ? removed : kept).push(asset);
  const keptKeys = new Set(kept.map((a) => a.key));
  const deleteKeys = [
    ...new Set(
      [...stored, ...removed]
        .filter((a) => isTakenDown(a, takedowns) && !keptKeys.has(a.key))
        .map((a) => a.key),
    ),
  ];
  return { kept, removed, deleteKeys };
}
