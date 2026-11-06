// The crawl's AI step (M5 C6–7, crawl.yml's `enrich` job): a crawl's sources and image candidates
// (dry-run.ts) → checked drafts for publish.ts. Claude Haiku 5.5 through the Message Batches API
// (owner's call, 6 Nov 2026), with TypeSafe's Jev checking the summary (jev-check.ts). Writes, in
// --out:
//   drafts.json  what publish.ts merges (enrichment.ts draftsSchema): only packages with something
//   assets/      the drafts' re-encoded images, at their keys
//   report.json  per package: what each request returned, what the checks dropped and why, and
//                the run's cost, for the quality gate (C8) and the owner
//
//   ANTHROPIC_API_KEY=… JEV_API_KEY=… node scripts/crawl/enrich.ts --from <crawl> --out <dir>
//     [--cap 10] [--ids a,b | --limit N] [--batch 100] [--deadline 200] [--run-id 42]
//   ANTHROPIC_API_KEY=… node scripts/crawl/enrich.ts --from <dry run> --out <dir> --icons-only
//
// --icons-only runs only the icon judge and writes picks.json in icon-check.ts's shape, for
// score.ts --picks against the answer key.
//
// Work goes in batches of --batch packages, one at a time under the cost guard (cost.ts): each
// batch's worst case is reserved before it's submitted and reconciled from its real usage, Jev's
// included, before the next. --deadline (minutes, under the job's timeout) cancels a batch still
// running and keeps what it finished; no batch starts after it.
//
// Packages with a CaskFlow icon get no judge: the site shows CaskFlow's. Screenshots are for Mac
// apps only (enrichment.ts showsScreenshots).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { getCatalog } from '../../src/lib/catalog.ts';
import { loadContent } from '../content/schema.ts';
import {
  MODEL,
  ReplyError,
  SHOWN_KINDS,
  iconRequest,
  labelsRequest,
  readIcon,
  readLabels,
  readScreenshots,
  readSummary,
  screenshotsRequest,
  summaryRequest,
  type CategoryChoice,
  type IconChoice,
  type ShotKind,
} from './ai.ts';
import { AssetError, LocalStore, assetRecord, processAsset, type AssetRecord } from './assets.ts';
import {
  checkDraft,
  type CheckContext,
  type Draft,
  type Dropped,
  type Sentence,
  type Source,
} from './checks.ts';
import {
  CostGuard,
  DEFAULT_CAP,
  MAX_TOKENS,
  OVERHEAD_TOKENS,
  estimateTokens,
  worstCase,
  type RequestCost,
  type Usage,
} from './cost.ts';
import type { IconResult, PackageResult, ShotResult } from './dry-run.ts';
import { draftsSchema, itemSchema, showsScreenshots, sourceRef, type Item } from './enrichment.ts';
import { sniffImage } from './fetch.ts';
import type { ModelPick, ModelPicks } from './icon-check.ts';
import { checkSentences, type Checked } from './jev-check.ts';
import { candidateLabel, judgeCandidates, packageDetails, showable } from './judge.ts';
import { safeName } from './util.ts';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    out: { type: 'string' },
    cap: { type: 'string', default: String(DEFAULT_CAP) },
    ids: { type: 'string' },
    limit: { type: 'string' },
    batch: { type: 'string', default: '100' },
    deadline: { type: 'string', default: '200' },
    poll: { type: 'string', default: '30' },
    'run-id': { type: 'string', default: process.env.GITHUB_RUN_ID ?? 'local' },
    date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    content: { type: 'string', default: 'content' },
    'icons-only': { type: 'boolean', default: false },
  },
});
const iconsOnly = args['icons-only'];
const jevKey = process.env.JEV_API_KEY;
if (!args.from || !args.out || !process.env.ANTHROPIC_API_KEY || (!iconsOnly && !jevKey)) {
  console.error(
    'Usage: ANTHROPIC_API_KEY=… JEV_API_KEY=… node scripts/crawl/enrich.ts --from <crawl> --out <dir> [--icons-only]',
  );
  process.exit(2);
}
const FROM = args.from;
const OUT = args.out;
const deadline = Date.now() + Number(args.deadline) * 60_000;
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

/** Images in one batch's requests, base64, at most: the API takes 256 MB a batch. */
const MAX_BATCH_BYTES = 150_000_000;
/** README images are shown to the classifier at most this size, as JPEG. */
const SHOT_PREVIEW = 1024;

const client = new Anthropic({ maxRetries: 4 });
const guard = new CostGuard(Number(args.cap));
const store = new LocalStore(join(OUT, 'assets'));

const run = JSON.parse(readFileSync(join(FROM, 'results.json'), 'utf8')) as {
  generatedAt: string;
  packages: PackageResult[];
};
const wanted = args.ids ? new Set(args.ids.split(',')) : null;
const queue = run.packages
  .filter((p) => !wanted || wanted.has(p.id))
  .slice(0, args.limit ? Number(args.limit) : undefined);

// --- What the checks need ---

const catalog = iconsOnly ? null : getCatalog();
const categories: CategoryChoice[] = iconsOnly
  ? []
  : loadContent(args.content).categories.map((c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
    }));

function checkContext(p: PackageResult): CheckContext {
  const entry = catalog!.byId.get(p.id);
  const own = [p.name, p.id, ...(entry ? [entry.token, ...entry.aliases, ...entry.oldNames] : [])];
  if (entry) own.push(...entry.altNames);
  return {
    ownNames: own,
    otherNames: catalog!.entries.filter((e) => e.id !== p.id).map((e) => e.name),
    categories: categories.map((c) => c.slug),
  };
}

// --- One package's work ---

type Part = 'summary' | 'labels' | 'icon' | 'screenshots';

interface Work {
  p: PackageResult;
  sources: Source[];
  details: string;
  requests: { part: Part; params: Anthropic.Messages.MessageCreateParamsNonStreaming }[];
  /** The judge's candidates, in the order the request numbers them. */
  icons: IconResult[];
  shots: ShotResult[];
  costs: RequestCost[];
  bytes: number;
}

function readSources(p: PackageResult): Source[] {
  try {
    return JSON.parse(
      readFileSync(join(FROM, 'files', safeName(p.id), 'sources.json'), 'utf8'),
    ) as Source[];
  } catch {
    return [];
  }
}

async function shotPreview(file: string): Promise<Buffer | null> {
  try {
    return await sharp(readFileSync(join(FROM, file)), {
      limitInputPixels: 50_000_000,
      failOn: 'error',
    })
      .resize(SHOT_PREVIEW, SHOT_PREVIEW, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** A request's worst case: its text by bytes (cost.ts), every image at its largest. */
function requestCost(params: Anthropic.Messages.MessageCreateParamsNonStreaming): RequestCost {
  let images = 0;
  const text = JSON.stringify(params, (key, value: unknown) => {
    if (key === 'source' && (value as { type?: string })?.type === 'base64') {
      images++;
      return null;
    }
    return value;
  });
  return { model: MODEL, inputTokens: estimateTokens(text), images, maxTokens: params.max_tokens };
}

/**
 * Jev's request for a package, reserved before the summary exists. Not a strict bound: the
 * quotes are source spans, not the summary's output, and can be longer. A Jev request past it
 * shows in `reconcile` (overReserved), which stops the run; at Jev's price that's cents.
 */
const JEV_RESERVED: RequestCost = {
  model: 'jev-latest',
  inputTokens: OVERHEAD_TOKENS + 2 * MAX_TOKENS.summary,
  images: 0,
  maxTokens: 0,
};

async function prepare(p: PackageResult): Promise<Work> {
  const sources = iconsOnly ? [] : readSources(p);
  const details = packageDetails(p);
  const work: Work = {
    p,
    sources,
    details,
    requests: [],
    icons: [],
    shots: [],
    costs: [],
    bytes: 0,
  };
  if (sources.length) {
    work.requests.push({ part: 'summary', params: summaryRequest(details, sources) });
    work.requests.push({ part: 'labels', params: labelsRequest(details, sources, categories) });
  }
  if (!p.caskflowIcon) {
    const shown: { label: string; image: Buffer }[] = [];
    for (const icon of judgeCandidates(p)) {
      const image = await showable(FROM, icon);
      if (!image) continue;
      work.icons.push(icon);
      shown.push({ label: candidateLabel(icon, shown.length + 1), image });
    }
    if (shown.length) work.requests.push({ part: 'icon', params: iconRequest(details, shown) });
  }
  if (!iconsOnly && showsScreenshots(p.kind)) {
    const previews: Buffer[] = [];
    for (const shot of p.screenshots.filter((s) => s.status === 'ok' && s.file)) {
      const preview = await shotPreview(shot.file!);
      if (!preview) continue;
      work.shots.push(shot);
      previews.push(preview);
    }
    if (previews.length)
      work.requests.push({ part: 'screenshots', params: screenshotsRequest(details, previews) });
  }
  work.costs = work.requests.map((r) => requestCost(r.params));
  if (sources.length) work.costs.push(JEV_RESERVED);
  work.bytes = work.requests.reduce((n, r) => n + JSON.stringify(r.params).length, 0);
  return work;
}

// --- Results ---

interface PackageReport {
  id: string;
  /** Requests that failed or whose reply didn't parse, and why. */
  failures: string[];
  dropped: Dropped[];
  problems: string[];
  jev: Checked[];
  icon: (IconChoice & { url: string | null }) | null;
  screenshots: { url: string; kind: ShotKind }[];
  assetFailures: string[];
  drafted: boolean;
}

const drafts: Record<string, Item> = {};
const reports: PackageReport[] = [];
const picks: Record<string, ModelPick> = {};
const totals = { batches: 0, cost: 0, jevInputTokens: 0, stopped: null as string | null };

/** A quote or citation list the enrichment file can't hold: dropped like a failed check. */
const tooBig = (s: Sentence) =>
  s.citations.length > 10 || s.citations.some((c) => c.quote.length > 2000);

async function asset(
  report: PackageReport,
  p: PackageResult,
  kind: 'icon' | 'screenshot',
  file: { url: string; file?: string },
  origin: { sourceRevision: string; basis: 'judge' | 'classifier'; repoLicence?: string | null },
): Promise<AssetRecord | null> {
  try {
    if (!file.file) throw new AssetError('format', 'no file kept');
    const body = readFileSync(join(FROM, file.file));
    const format = sniffImage(body);
    if (!format) throw new AssetError('format', 'not an image');
    const processed = await processAsset(kind, body, format);
    if (!(await store.has(processed.key))) await store.put(processed.key, processed.body);
    return assetRecord(processed, { package: p.id, sourceUrl: file.url, ...origin });
  } catch (error) {
    report.assetFailures.push(`${kind} ${file.url}: ${(error as Error).message}`);
    return null;
  }
}

/** One package's replies → its checked draft. Returns Jev's usage. */
async function finish(
  work: Work,
  replies: Map<Part, Anthropic.Messages.Message | string>,
): Promise<number> {
  const { p, sources } = work;
  const report: PackageReport = {
    id: p.id,
    failures: [],
    dropped: [],
    problems: [],
    jev: [],
    icon: null,
    screenshots: [],
    assetFailures: [],
    drafted: false,
  };
  reports.push(report);
  const read = <T>(part: Part, f: (m: Anthropic.Messages.Message) => T): T | null => {
    const reply = replies.get(part);
    if (reply === undefined) return null;
    if (typeof reply === 'string') {
      report.failures.push(`${part}: ${reply}`);
      return null;
    }
    try {
      return f(reply);
    } catch (error) {
      if (!(error instanceof ReplyError)) throw error;
      report.failures.push(`${part}: ${error.message}`);
      return null;
    }
  };

  // Icon.
  let icon: AssetRecord | null = null;
  const choice = read('icon', (m) => readIcon(m, work.icons.length));
  if (choice) {
    const picked = choice.index === null ? null : work.icons[choice.index];
    report.icon = { ...choice, url: picked?.url ?? null };
    picks[p.id] = {
      icon: picked?.url ?? null,
      source: picked?.source ?? 'none',
      confidence: choice.confidence,
      reason: choice.reason,
      ...(choice.kind && { kind: choice.kind }),
    };
    if (picked && !iconsOnly)
      icon = await asset(report, p, 'icon', picked, {
        sourceRevision: run.generatedAt,
        basis: 'judge',
      });
  } else if (!replies.has('icon') && !p.caskflowIcon) {
    picks[p.id] = { icon: null, source: 'none', confidence: 'high', reason: 'No candidates.' };
  }
  if (iconsOnly) return 0;

  // Screenshots.
  const screenshots: AssetRecord[] = [];
  const kinds = read('screenshots', (m) => readScreenshots(m, work.shots.length));
  for (const [i, kind] of (kinds ?? []).entries()) {
    const shot = work.shots[i];
    report.screenshots.push({ url: shot.url, kind });
    if (!SHOWN_KINDS.has(kind)) continue;
    const record = await asset(report, p, 'screenshot', shot, {
      sourceRevision: p.repo?.readmeRevision ?? run.generatedAt,
      basis: 'classifier',
      repoLicence: p.repo?.licence ?? null,
    });
    if (record) screenshots.push(record);
  }

  // Summary and labels, through the checks.
  const written = read('summary', (m) => readSummary(m, sources)) ?? { summary: [], bullets: [] };
  const labels = read('labels', readLabels) ?? { tags: [], category: null };
  const fits = (part: 'summary' | 'bullets') =>
    written[part].filter((s) => {
      if (!tooBig(s)) return true;
      report.dropped.push({ part, text: s.text, reason: 'quote too long for the file' });
      return false;
    });
  const draft: Draft = { summary: fits('summary'), bullets: fits('bullets'), ...labels };
  const checked = checkDraft(draft, sources, checkContext(p));
  report.dropped.push(...checked.dropped);
  report.problems.push(...checked.problems);

  let { summary, bullets } = checked.kept;
  let jevTokens = 0;
  const sentences = [...summary, ...bullets];
  if (sentences.length) {
    try {
      const body = await checkSentences(jevKey!, p.name, sentences);
      jevTokens = body.inputTokens;
      report.jev = body.checked;
      const keep = body.checked.map((c) => c.keep);
      const n = summary.length;
      for (const [i, c] of body.checked.entries())
        if (!c.keep)
          report.dropped.push({
            part: i < n ? 'summary' : 'bullets',
            text: c.text,
            reason: `Jev: ${c.support.toFixed(2)}`,
          });
      summary = summary.filter((_, i) => keep[i]);
      bullets = bullets.filter((_, i) => keep[n + i]);
    } catch (error) {
      // Unchecked sentences can't be kept.
      report.failures.push(`jev: ${(error as Error).message}`);
      summary = [];
      bullets = [];
    }
  }

  const strip = (list: Sentence[]) =>
    list.map((s) => ({
      text: s.text,
      citations: s.citations.map((c) => ({ source: c.source, quote: c.quote })),
    }));
  const revision = (s: Source) =>
    s.kind === 'readme' ? (p.repo?.readmeRevision ?? run.generatedAt) : run.generatedAt;
  const item: Item = {
    sources: sources.map((s) => sourceRef(s, revision(s))),
    summary: strip(summary),
    bullets: strip(bullets),
    tags: checked.kept.tags,
    category: checked.kept.category,
    icon,
    screenshots,
  };
  if (
    item.summary.length ||
    item.bullets.length ||
    item.tags.length ||
    icon ||
    screenshots.length
  ) {
    // One draft the file can't hold (limits the checks don't apply) mustn't lose the batch.
    const valid = itemSchema.safeParse(item);
    if (valid.success) {
      drafts[p.id] = item;
      report.drafted = true;
    } else report.failures.push(`draft: ${valid.error.issues[0]?.message ?? 'invalid'}`);
  }
  return jevTokens;
}

// --- Batches ---

async function runBatch(works: Work[]) {
  const name = `batch-${++totals.batches}`;
  const reserved = guard.reserve(
    name,
    works.flatMap((w) => w.costs),
  );
  const requests = works.flatMap((w, i) =>
    w.requests.map((r) => ({ custom_id: `p${i}-${r.part}`, params: r.params })),
  );
  let batch = await client.messages.batches.create({ requests });
  log(
    `${name}: ${works.length} packages, ${requests.length} requests, $${reserved.toFixed(4)} reserved (${batch.id})`,
  );
  let cancelled = false;
  while (batch.processing_status !== 'ended') {
    await new Promise((done) => setTimeout(done, Number(args.poll) * 1000));
    if (!cancelled && Date.now() > deadline) {
      log(`${name}: past the deadline, cancelling; what it finished is kept`);
      await client.messages.batches.cancel(batch.id);
      cancelled = true;
    }
    batch = await client.messages.batches.retrieve(batch.id);
  }
  const replies = works.map(() => new Map<Part, Anthropic.Messages.Message | string>());
  const usage: { model: 'claude-haiku-5-5' | 'jev-latest'; usage: Usage }[] = [];
  for await (const result of await client.messages.batches.results(batch.id)) {
    const [, index, part] = result.custom_id.match(/^p(\d+)-(\w+)$/) ?? [];
    const target = replies[Number(index)];
    if (!target) continue;
    if (result.result.type === 'succeeded') {
      target.set(part as Part, result.result.message);
      usage.push({ model: MODEL, usage: result.result.message.usage });
    } else {
      const why =
        result.result.type === 'errored'
          ? `errored: ${result.result.error.error?.type ?? 'unknown'}`
          : result.result.type;
      target.set(part as Part, why);
    }
  }
  for (const [i, work] of works.entries()) {
    const jevTokens = await finish(work, replies[i]);
    totals.jevInputTokens += jevTokens;
    if (jevTokens)
      usage.push({ model: 'jev-latest', usage: { input_tokens: jevTokens, output_tokens: 0 } });
  }
  const { cost, overReserved } = guard.reconcile(name, usage);
  totals.cost += cost;
  log(
    `${name}: $${cost.toFixed(4)} (of $${reserved.toFixed(4)} reserved); $${guard.remaining.toFixed(2)} left`,
  );
  if (overReserved) totals.stopped = `${name} cost more than its worst case`;
  if (cancelled) totals.stopped = 'deadline';
}

function save() {
  mkdirSync(OUT, { recursive: true });
  if (iconsOnly) {
    const out: ModelPicks = { model: MODEL, at: new Date().toISOString(), picks };
    writeFileSync(join(OUT, 'picks.json'), `${JSON.stringify(out, null, 1)}\n`);
  } else {
    const file = draftsSchema.parse({
      run: { id: args['run-id'], date: args.date },
      packages: drafts,
    });
    writeFileSync(join(OUT, 'drafts.json'), `${JSON.stringify(file, null, 1)}\n`);
  }
  writeFileSync(
    join(OUT, 'report.json'),
    `${JSON.stringify({ from: run.generatedAt, at: new Date().toISOString(), totals, packages: reports }, null, 1)}\n`,
  );
}

const batchSize = Number(args.batch);
let next = 0;
while (next < queue.length && !totals.stopped) {
  if (Date.now() > deadline) {
    totals.stopped = 'deadline';
    break;
  }
  const works: Work[] = [];
  let worst = 0;
  let bytes = 0;
  while (next < queue.length && works.length < batchSize) {
    const work = await prepare(queue[next]);
    const cost = work.costs.reduce((sum, c) => sum + worstCase(c), 0);
    if (worst + cost > guard.remaining || (works.length && bytes + work.bytes > MAX_BATCH_BYTES))
      break;
    next++;
    worst += cost;
    bytes += work.bytes;
    // Nothing to ask: no sources and no candidates.
    if (work.requests.length) works.push(work);
    else await finish(work, new Map());
  }
  if (!works.length) {
    if (next < queue.length)
      totals.stopped = `the cap ($${guard.cap}) can't cover ${queue[next].id}`;
    break;
  }
  await runBatch(works);
  save();
}
save();

const drafted = reports.filter((r) => r.drafted).length;
const dropped = reports.flatMap((r) => r.dropped);
const by = <T>(list: T[], f: (x: T) => string) =>
  Object.entries(Object.groupBy(list, f))
    .map(([k, v]) => `${k} ${v!.length}`)
    .join(', ');
log(
  `Done: ${reports.length}/${queue.length} packages, ${iconsOnly ? `${Object.keys(picks).length} picks` : `${drafted} drafts`}, $${totals.cost.toFixed(4)}${totals.stopped ? `; stopped: ${totals.stopped}` : ''}`,
);
if (!iconsOnly) {
  log(`Dropped: ${by(dropped, (d) => `${d.part} ${d.reason.replace(/[\d.]+$/, 'n')}`) || 'none'}`);
  const failures = reports.flatMap((r) => r.failures);
  if (failures.length) log(`Failures: ${failures.join('; ')}`);
}
