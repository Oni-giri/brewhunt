// Scores an icon run against the owner's answer key (M5 C8: wrong icons < 2%). A run is a dry
// run's folder (its results.json says what each candidate was) and the picks to score, in
// icon-check.ts's shape: the rules' (rank.ts, --rules) or a model's (model-picks.json).
//
//   node scripts/crawl/score.ts --from <dir> --rules
//   node scripts/crawl/score.ts --from <dir> --picks <dir>/model-picks.json [--list]
//
// Each answered package lands in one bucket:
// - exact: the owner's file; same file: a perceptual hash within SAME_FILE bits of it.
// - other file: an icon, but another file. It may be the same logo drawn again (hashes can't tell:
//   such files differ by up to 44 of 64 bits) or a wrong one; --list shows them to look at.
// - icon for tile: an icon where the owner wants the letter tile. Wrong.
// - missed: the tile where the owner has an icon. Not wrong, but no icon.
// - tile: the tile, as the owner wants.
// Packages the owner left "findable" aren't scored.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { PackageResult } from './dry-run.ts';
import { hamming } from './extract.ts';
import type { ModelPick, ModelPicks } from './icon-check.ts';
import { chooseIcon } from './rank.ts';

/** Hashes this close are the same file, re-encoded or resized (calibrated on the answer key). */
export const SAME_FILE = 4;

export interface KeyEntry {
  id: string;
  icon: string | null;
  source: string;
  hash?: string;
}

export type Bucket = 'exact' | 'same file' | 'other file' | 'icon for tile' | 'missed' | 'tile';

/** Where one pick lands against the owner's answer; null when the owner left it findable. */
export function bucket(
  answer: KeyEntry,
  pick: { icon: string | null; hash?: string | null },
): Bucket | null {
  if (answer.source === 'findable') return null;
  if (answer.icon === null) return pick.icon === null ? 'tile' : 'icon for tile';
  if (pick.icon === null) return 'missed';
  if (pick.icon === answer.icon) return 'exact';
  if (answer.hash && pick.hash && hamming(answer.hash, pick.hash) <= SAME_FILE) return 'same file';
  return 'other file';
}

if (import.meta.main) {
  const { values: args } = parseArgs({
    options: {
      from: { type: 'string' },
      picks: { type: 'string' },
      rules: { type: 'boolean', default: false },
      key: { type: 'string', default: 'tests/fixtures/answer-key/icons.json' },
      list: { type: 'boolean', default: false },
    },
  });
  if (!args.from || (!args.picks && !args.rules)) {
    console.error('Usage: node scripts/crawl/score.ts --from <dir> (--rules | --picks <file>)');
    process.exit(2);
  }
  const { packages } = JSON.parse(readFileSync(join(args.from, 'results.json'), 'utf8')) as {
    packages: PackageResult[];
  };
  const byId = new Map(packages.map((p) => [p.id, p]));
  const picks: Record<string, Pick<ModelPick, 'icon' | 'source'>> = args.picks
    ? (JSON.parse(readFileSync(args.picks, 'utf8')) as ModelPicks).picks
    : Object.fromEntries(packages.map((p) => [p.id, chooseIcon(p.icons)]));
  const key = JSON.parse(readFileSync(args.key, 'utf8')) as KeyEntry[];

  const counts = new Map<Bucket | 'not in run', number>();
  const listed: string[] = [];
  for (const answer of key) {
    const p = byId.get(answer.id);
    const pick = picks[answer.id];
    if (!p || !pick) {
      if (answer.source !== 'findable')
        counts.set('not in run', (counts.get('not in run') ?? 0) + 1);
      continue;
    }
    const hash = p.icons.find((i) => i.url === pick.icon)?.hash;
    const b = bucket(answer, { icon: pick.icon, hash });
    if (!b) continue;
    counts.set(b, (counts.get(b) ?? 0) + 1);
    if (b === 'other file' || b === 'icon for tile' || (args.list && b === 'missed'))
      listed.push(
        `${b.padEnd(13)} ${answer.id}: ${pick.source} ${pick.icon} (owner: ${answer.source} ${answer.icon ?? ''})`,
      );
  }
  const scored = [...counts].filter(([b]) => b !== 'not in run').reduce((n, [, c]) => n + c, 0);
  const n = (b: Bucket) => counts.get(b) ?? 0;
  const pct = (x: number) => `${((100 * x) / scored).toFixed(1)}%`;
  console.log(
    `${scored} packages scored${counts.get('not in run') ? `, ${counts.get('not in run')} not in this run` : ''}`,
  );
  for (const b of ['exact', 'same file', 'other file', 'icon for tile', 'missed', 'tile'] as const)
    console.log(`  ${b.padEnd(13)} ${String(n(b)).padStart(4)}  ${pct(n(b))}`);
  console.log(
    `Wrong for sure (icon for tile): ${pct(n('icon for tile'))}; at most, counting every other file as wrong: ${pct(n('icon for tile') + n('other file'))}`,
  );
  if (args.list || listed.length <= 40) for (const line of listed) console.log(line);
}
