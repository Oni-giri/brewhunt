// Turns a dry run's chosen icons and screenshots into the assets Brewhunt would serve (M5 C9),
// in a local folder standing in for R2: each one re-encoded (assets.ts), recorded with its source
// and rights, and content/takedown.yaml applied. Writes <dir>/assets/<key>, manifest.json and
// index.html (a page of the results, to look at). Nothing is uploaded.
//
//   node scripts/crawl/assets-run.ts --from <dir> (--key <icons.json> | --picks <picks.json>)
//
// --key:   the owner's answer key: icons the owner chose (basis "owner").
// --picks: a judge's picks in icon-check.ts's shape (basis "judge").
// Screenshots: every README image the dry run kept (basis "rules", until the classifier runs).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContent } from '../content/schema.ts';
import {
  AssetError,
  assetRecord,
  processAsset,
  type AssetBasis,
  type AssetKind,
  type AssetRecord,
  type AssetStore,
} from './assets.ts';
import { sniffImage } from './fetch.ts';
import type { PackageResult } from './dry-run.ts';
import type { ModelPicks } from './icon-check.ts';
import type { KeyEntry } from './score.ts';
import { applyTakedowns, isTakenDown, readTakedowns } from './takedown.ts';

/** A folder standing in for the R2 bucket. */
export class LocalStore implements AssetStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private path(key: string): string {
    if (!/^[a-z]+\/v\d+\/[0-9a-f]{64}\.webp$/.test(key))
      throw new Error(`not an asset key: ${key}`);
    return join(this.dir, key);
  }
  async has(key: string) {
    return existsSync(this.path(key));
  }
  async put(key: string, body: Buffer) {
    mkdirSync(dirname(this.path(key)), { recursive: true });
    writeFileSync(this.path(key), body);
  }
  async delete(key: string) {
    rmSync(this.path(key), { force: true });
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Failure {
  package: string;
  kind: AssetKind;
  url: string;
  reason: string;
  message: string;
}

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    key: { type: 'string' },
    picks: { type: 'string' },
    content: { type: 'string', default: 'content' },
  },
});
if (!values.from || !values.key === !values.picks) {
  console.error(
    'Usage: node scripts/crawl/assets-run.ts --from <dir> (--key <icons.json> | --picks <picks.json>)',
  );
  process.exit(1);
}
const FROM = values.from;
const OUT = join(FROM, 'assets');
const run = JSON.parse(readFileSync(join(FROM, 'results.json'), 'utf8')) as {
  generatedAt: string;
  packages: PackageResult[];
};

const chosen = new Map<string, string>();
let basis: AssetBasis;
if (values.key) {
  basis = 'owner';
  for (const e of JSON.parse(readFileSync(values.key, 'utf8')) as KeyEntry[])
    if (e.icon) chosen.set(e.id, e.icon);
} else {
  basis = 'judge';
  const { picks } = JSON.parse(readFileSync(values.picks!, 'utf8')) as ModelPicks;
  for (const [id, p] of Object.entries(picks)) if (p.icon) chosen.set(id, p.icon);
}

const store = new LocalStore(OUT);
const takedowns = readTakedowns(loadContent(values.content).takedown);
// The previous run's assets, so one taken down since is deleted too.
const manifestFile = join(OUT, 'manifest.json');
const stored: AssetRecord[] = existsSync(manifestFile)
  ? (JSON.parse(readFileSync(manifestFile, 'utf8')) as { assets: AssetRecord[] }).assets
  : [];
const records: AssetRecord[] = [];
const failures: Failure[] = [];
let notInRun = 0;

async function take(
  p: PackageResult,
  kind: AssetKind,
  file: { url: string; file?: string },
  origin: { sourceRevision: string; basis: AssetBasis; repoLicence?: string | null },
) {
  try {
    if (!file.file) throw new AssetError('format', 'no file kept');
    const body = readFileSync(join(FROM, file.file));
    // The format from the bytes, as the fetcher read it.
    const format = sniffImage(body);
    if (!format) throw new AssetError('format', 'not an image');
    const asset = await processAsset(kind, body, format);
    const record = assetRecord(asset, { package: p.id, sourceUrl: file.url, ...origin });
    // A taken-down image is never written.
    if (!isTakenDown(record, takedowns) && !(await store.has(asset.key)))
      await store.put(asset.key, asset.body);
    records.push(record);
  } catch (error) {
    failures.push({
      package: p.id,
      kind,
      url: file.url,
      reason: error instanceof AssetError ? error.reason : 'error',
      message: (error as Error).message,
    });
  }
}

for (const p of run.packages) {
  const url = chosen.get(p.id);
  if (url) {
    const icon = p.icons.find((i) => i.status === 'ok' && (i.url === url || i.finalUrl === url));
    if (icon) await take(p, 'icon', icon, { sourceRevision: run.generatedAt, basis });
    else notInRun++;
  }
  for (const shot of p.screenshots.filter((s) => s.status === 'ok'))
    await take(p, 'screenshot', shot, {
      sourceRevision: p.repo?.readmeRevision ?? run.generatedAt,
      basis: 'rules',
      repoLicence: p.repo?.licence ?? null,
    });
}

const { kept, removed, deleteKeys } = applyTakedowns(records, takedowns, stored);
for (const key of deleteKeys) await store.delete(key);
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, 'manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), from: run.generatedAt, assets: kept, removed, failures }, null, 2)}\n`,
);

const tiles = kept
  .map(
    (a) =>
      `<figure class="${a.kind}"><img src="${escapeHtml(a.key)}" alt="" width="${a.kind === 'icon' ? 64 : 240}"><figcaption>${escapeHtml(a.package)}${a.flags.length ? `<br><b>${a.flags.join(', ')}</b>` : ''}</figcaption></figure>`,
  )
  .join('\n');
writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><title>Assets</title>
<style>body{font:13px system-ui;margin:16px;background:#f4f4f5}main{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:88px;text-align:center}figure.screenshot{width:240px}img{display:block;margin:auto;background:#fff;border-radius:14px;box-shadow:0 0 0 1px #0001}figure.screenshot img{border-radius:4px;height:auto}figcaption{overflow-wrap:anywhere;margin-top:4px}</style>
<p>${kept.length} assets, ${failures.length} failures</p><main>${tiles}</main>`,
);

const by = <T>(list: T[], f: (x: T) => string) =>
  Object.entries(Object.groupBy(list, f))
    .map(([k, v]) => `${k} ${v!.length}`)
    .join(', ');
const bytes = (kind: AssetKind) =>
  kept
    .filter((a) => a.kind === kind)
    .reduce((n, a) => n + readFileSync(join(OUT, a.key)).length, 0);
console.log(`Assets: ${by(kept, (a) => a.kind) || 'none'} → ${OUT}`);
if (deleteKeys.length) console.log(`Deleted ${deleteKeys.length} taken down`);
console.log(
  `Icons ${(bytes('icon') / 1024).toFixed(0)} KB, screenshots ${(bytes('screenshot') / 1024).toFixed(0)} KB`,
);
console.log(`Animated ${kept.filter((a) => a.animated).length}`);
const flagged = kept.filter((a) => a.flags.length);
console.log(
  `Flagged for review: ${flagged.map((a) => `${a.package} (${a.flags.join(', ')})`).join(', ') || 'none'}`,
);
console.log(`Failures: ${by(failures, (f) => `${f.kind} ${f.reason}`) || 'none'}`);
for (const f of failures) console.log(`  ${f.package} ${f.kind}: ${f.reason}: ${f.message}`);
console.log(`Taken down: ${removed.length}. Chosen icons not in this run: ${notInRun}`);
