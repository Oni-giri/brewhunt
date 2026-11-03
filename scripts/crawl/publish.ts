// The crawl's publish step (M5 C, crawl.yml): this run's drafts merged into the `enrichment`
// branch's file (enrichment.ts), with the owner's verdicts and takedowns applied. Writes, in
// --out:
//   enrichment.json  the branch's next file
//   upload/          the assets the file now refers to and the store doesn't have, at their keys
//   remove.txt       keys to delete from the store, once the site that stopped showing them is
//                    deployed (crawl.yml's last job)
// Nothing is uploaded or deleted here: the workflow does that with the R2 keys, which this step
// never sees.
//
//   node scripts/crawl/publish.ts --previous enrichment --out <dir> --run-id <id>
//     [--drafts <drafts.json>] [--assets <dir>] [--asset-base https://…] [--date 2026-11-10]

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContent } from '../content/schema.ts';
import type { Package } from '../data/types.ts';
import { draftsSchema, enrichmentSchema, nextEnrichment, type Enrichment } from './enrichment.ts';
import { readTakedowns } from './takedown.ts';
import { allowedImageOrigins } from '../../src/lib/enrichment.ts';

const { values } = parseArgs({
  options: {
    previous: { type: 'string' },
    drafts: { type: 'string' },
    assets: { type: 'string' },
    'asset-base': { type: 'string' },
    'run-id': { type: 'string' },
    date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    content: { type: 'string', default: 'content' },
    packages: { type: 'string', default: 'data/site/packages.json' },
    out: { type: 'string' },
  },
});
if (!values.previous || !values.out || !values['run-id']) {
  console.error(
    'Usage: node scripts/crawl/publish.ts --previous <dir> --out <dir> --run-id <id> [--drafts <file>] [--assets <dir>] [--asset-base <url>]',
  );
  process.exit(2);
}

const previousFile = join(values.previous, 'enrichment.json');
const previous: Enrichment | null = existsSync(previousFile)
  ? enrichmentSchema.parse(JSON.parse(readFileSync(previousFile, 'utf8')))
  : null;
const drafts = values.drafts
  ? draftsSchema.parse(JSON.parse(readFileSync(values.drafts, 'utf8'))).packages
  : {};
const content = loadContent(values.content);
const packages = JSON.parse(readFileSync(values.packages, 'utf8')) as Package[];
const official = new Set(packages.filter((p) => p.source === 'official').map((p) => p.id));

const next = nextEnrichment(previous, drafts, {
  run: { id: values['run-id'], date: values.date },
  assetBase: values['asset-base'] || null,
  approvals: content.approvals,
  takedowns: readTakedowns(content.takedown),
  isOfficial: (id) => official.has(id),
});

if (next.upload.length && !next.enrichment.assetBase) {
  console.error(`${next.upload.length} assets to upload, but no --asset-base to serve them from.`);
  process.exit(1);
}
// The site's build refuses a file whose images its CSP would block: refuse it here, before the
// branch has it.
const base = next.enrichment.assetBase;
if (
  base &&
  !allowedImageOrigins(readFileSync('public/_headers', 'utf8')).includes(new URL(base).origin)
) {
  console.error(
    `public/_headers' img-src doesn't allow ${new URL(base).origin}. Add it there first.`,
  );
  process.exit(1);
}
const missing = next.upload.filter(
  (key) => !values.assets || !existsSync(join(values.assets, key)),
);
if (missing.length) {
  console.error(`${missing.length} assets aren't in --assets, starting with ${missing[0]}.`);
  process.exit(1);
}

mkdirSync(values.out, { recursive: true });
for (const key of next.upload) {
  const to = join(values.out, 'upload', key);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(values.assets!, key), to);
}
writeFileSync(join(values.out, 'enrichment.json'), `${JSON.stringify(next.enrichment, null, 2)}\n`);
writeFileSync(join(values.out, 'remove.txt'), next.remove.map((k) => `${k}\n`).join(''));

const counts = Object.entries(Object.groupBy(Object.values(next.outcomes), (o) => o))
  .map(([outcome, list]) => `${outcome} ${list!.length}`)
  .join(', ');
const waiting = Object.values(next.enrichment.packages).filter((p) => p.pending).length;
console.log(
  `Drafts: ${counts || 'none'}. ${waiting} packages wait for review. ${next.upload.length} assets to upload, ${next.remove.length} to delete.`,
);
