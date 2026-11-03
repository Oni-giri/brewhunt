// The AI step's worst-case cost for a dry run's packages (cost.ts), before there's a key: what a
// run's cap covers, and the most a run of N packages could cost. Sonnet's check is bounded here
// by the summary's max_tokens; in a run its batch is planned once the summaries are back, from
// their real length.
//
//   node scripts/crawl/cost-estimate.ts --from <dir> [--cap 10]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Source } from './checks.ts';
import { DEFAULT_CAP, packageRequests, worstCase } from './cost.ts';
import type { PackageResult } from './dry-run.ts';
import { safeName } from './util.ts';

const { values } = parseArgs({
  options: { from: { type: 'string' }, cap: { type: 'string', default: String(DEFAULT_CAP) } },
});
if (!values.from) {
  console.error('Usage: node scripts/crawl/cost-estimate.ts --from <dir> [--cap 10]');
  process.exit(1);
}
const FROM = values.from;
const cap = Number(values.cap);
const { packages, iconsOnly } = JSON.parse(readFileSync(join(FROM, 'results.json'), 'utf8')) as {
  packages: PackageResult[];
  iconsOnly: boolean;
};
if (iconsOnly) console.warn('An icons-only run: no sources, so no summary, labels or check.');

const byModel = new Map<string, number>();
const costs = packages.map((p) => {
  const file = join(FROM, 'files', safeName(p.id), 'sources.json');
  const sources: Source[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const requests = packageRequests({
    sourceText: sources.map((s) => s.text).join('\n'),
    iconCandidates: p.icons.filter((i) => i.status === 'ok' && i.format !== 'ico').length,
    screenshots: p.screenshots.filter((s) => s.status === 'ok').length,
  });
  for (const r of requests) byModel.set(r.model, (byModel.get(r.model) ?? 0) + worstCase(r));
  return {
    id: p.id,
    cost: requests.reduce((sum, r) => sum + worstCase(r), 0),
    requests: requests.length,
  };
});
costs.sort((a, b) => b.cost - a.cost);
const total = costs.reduce((sum, c) => sum + c.cost, 0);
const mean = total / costs.length;
const $ = (n: number) => `$${n.toFixed(4)}`;
console.log(
  `${costs.length} packages, ${costs.reduce((n, c) => n + c.requests, 0)} requests, worst case ${$(total)} (batch prices)`,
);
console.log(
  `By model: ${[...byModel].map(([m, c]) => `${m} ${$(c)} (${Math.round((100 * c) / total)}%)`).join(', ')}`,
);
console.log(`Per package: mean ${$(mean)}, most ${$(costs[0].cost)} (${costs[0].id})`);
for (const n of [1000, 15000])
  console.log(`${n.toLocaleString('en')} packages like these: at most ${$(mean * n)}`);
console.log(
  `A $${cap} cap covers about ${Math.floor(cap / mean).toLocaleString('en')} packages at worst`,
);
