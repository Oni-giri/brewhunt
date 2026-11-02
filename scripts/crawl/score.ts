// Scores an icon run against the owner's answer key (M5 C8: wrong icons < 2%). A run is a dry
// run's folder (its results.json says what each candidate was) and the picks to score, in
// icon-check.ts's shape: the rules' (rank.ts, --rules) or a model's (model-picks.json).
//
//   node scripts/crawl/score.ts --from <dir> --rules
//   node scripts/crawl/score.ts --from <dir> --picks <dir>/model-picks.json [--list]
//
// Each answered package lands in one bucket:
// - exact: the owner's file; same file: a perceptual hash within SAME_FILE bits of it.
// - also fine: an image the owner accepted in a later review (`accepted` in the key).
// - wrong: an image the owner rejected in a review (`rejected`), or an icon where the owner chose
//   the letter tile after seeing that image.
// - passed over: another image the owner saw and didn't choose. The same logo from a worse source,
//   or a wrong one: hashes can't tell (one logo drawn again differs by up to 44 of 64 bits).
// - never shown: an image the owner never saw, where the owner has an icon; unreviewed icon: one
//   where the owner chose the tile without seeing it. Neither is scored until the owner looks.
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
  /** Hashes of every image the owner was shown for the package. */
  seen?: string[];
  /** Hashes of other images the owner accepted, or rejected, in a later review. */
  accepted?: string[];
  rejected?: string[];
}

export const BUCKETS = [
  'exact',
  'same file',
  'also fine',
  'passed over',
  'never shown',
  'unreviewed icon',
  'wrong',
  'missed',
  'tile',
] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Where one pick lands against the owner's answer; null when the owner left it findable. */
export function bucket(
  answer: KeyEntry,
  pick: { icon: string | null; hash?: string | null },
): Bucket | null {
  if (answer.source === 'findable') return null;
  if (pick.icon === null) return answer.icon === null ? 'tile' : 'missed';
  if (pick.icon === answer.icon) return 'exact';
  const near = (hashes: string[] | undefined) =>
    !!pick.hash && (hashes ?? []).some((h) => hamming(h, pick.hash!) <= SAME_FILE);
  if (answer.hash && near([answer.hash])) return 'same file';
  if (near(answer.rejected)) return 'wrong';
  if (near(answer.accepted)) return 'also fine';
  const seen = near(answer.seen);
  if (answer.icon === null) return seen ? 'wrong' : 'unreviewed icon';
  return seen ? 'passed over' : 'never shown';
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
    if (
      !['exact', 'same file', 'also fine', 'tile', 'missed'].includes(b) ||
      (args.list && b === 'missed')
    )
      listed.push(
        `${b.padEnd(15)} ${answer.id}: ${pick.source} ${pick.icon} (owner: ${answer.source} ${answer.icon ?? ''})`,
      );
  }
  const scored = [...counts].filter(([b]) => b !== 'not in run').reduce((n, [, c]) => n + c, 0);
  const n = (b: Bucket) => counts.get(b) ?? 0;
  const pct = (x: number) => `${((100 * x) / scored).toFixed(1)}%`;
  console.log(
    `${scored} packages scored${counts.get('not in run') ? `, ${counts.get('not in run')} not in this run` : ''}`,
  );
  for (const b of BUCKETS)
    console.log(`  ${b.padEnd(15)} ${String(n(b)).padStart(4)}  ${pct(n(b))}`);
  const unknown = n('never shown') + n('unreviewed icon');
  console.log(
    `Wrong: ${pct(n('wrong'))}; up to ${pct(n('wrong') + n('passed over'))} if every passed-over image is a wrong logo, not a worse file of the right one${unknown ? `; ${unknown} picks the owner hasn't seen` : ''}`,
  );
  if (args.list || listed.length <= 40) for (const line of listed) console.log(line);
}
