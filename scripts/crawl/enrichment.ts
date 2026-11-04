// The crawler's hand-off to the site (M5 C): what the `enrichment` branch holds, and how a run's
// drafts become what the site shows.
//
// enrichment.json keeps, per package, what's published and what waits for the owner's review
// (`pending`). The site shows the published item, or the pending one once content/approvals.yaml
// approves that exact draft by its hash; content/takedown.yaml wins over both. The next run
// promotes approved drafts and drops rejected ones, so a verdict takes effect at the next build
// and the branch catches up at the next crawl.
//
// Who reviews (plan step 7): the whole first run (until anything is published, counting the
// approvals this run applies), every community package, and any package whose sources changed
// since what's published. After the first run, a new official package, or a new draft from
// unchanged sources, publishes directly. "Changed" is
// any source text's hash: stricter than the plan's "README rewritten" until it's measured.
//
// Asset keys are immutable (assets.ts), so the store should hold exactly the keys the file
// refers to: a run uploads the keys it adds and deletes the ones it drops (rejected, replaced or
// taken down) after the site that stopped showing them is deployed. The dropped keys stay listed
// in `removed` for one more run, so a delete that failed is tried again.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Approval } from '../content/schema.ts';
import type { AssetRecord } from './assets.ts';
import type { Sentence, Source } from './checks.ts';
import { isTakenDown, type Takedowns } from './takedown.ts';

export const ENRICHMENT_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const ASSET_KEY = /^(?:icons|screenshots)\/v\d+\/[0-9a-f]{64}\.webp$/;
const PACKAGE_ID = /^(?:[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9@+._-]*$/;

const hash = z.string().regex(SHA256);
const text = (max: number) => z.string().min(1).max(max);

const assetSchema = z.strictObject({
  key: z.string().regex(ASSET_KEY),
  kind: z.enum(['icon', 'screenshot']),
  package: z.string().regex(PACKAGE_ID),
  sourceUrl: text(2000),
  sourceRevision: text(100),
  sourceHash: hash,
  outputHash: hash,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  animated: z.boolean(),
  flags: z.array(z.enum(['faint', 'light', 'wordmark'])),
  licence: text(100).nullable(),
  credit: text(200).nullable(),
  basis: z.enum(['owner', 'judge', 'rules', 'classifier']),
}) satisfies z.ZodType<AssetRecord>;

const sentenceSchema = z.strictObject({
  text: text(500),
  citations: z
    .array(z.strictObject({ source: text(100), quote: text(2000) }))
    .min(1)
    .max(10),
});

const sourceSchema = z.strictObject({
  id: text(100),
  kind: z.enum(['homepage', 'readme']),
  url: text(2000),
  /** A README's blob id, or the time a homepage was fetched. */
  revision: text(100),
  /** sha256 of the text the model read. */
  hash,
});

const itemSchema = z.strictObject({
  sources: z.array(sourceSchema).max(10),
  summary: z.array(sentenceSchema).max(20),
  bullets: z.array(sentenceSchema).max(20),
  tags: z.array(text(40)).max(30),
  category: text(60).nullable(),
  icon: assetSchema.nullable(),
  screenshots: z.array(assetSchema).max(10),
});

const pendingSchema = z.strictObject({
  item: itemSchema,
  /** itemHash(item): what an approval names. */
  hash,
  reason: z.enum(['first-run', 'community', 'sources-changed']),
  /** The run date this draft was first written. */
  since: z.iso.date(),
});

const packageSchema = z.strictObject({
  published: itemSchema.nullable(),
  pending: pendingSchema.nullable(),
});

const runSchema = z.strictObject({ id: text(100), date: z.iso.date() });

export const enrichmentSchema = z.strictObject({
  version: z.literal(ENRICHMENT_VERSION),
  run: runSchema,
  /** Where asset keys are served: `${assetBase}/${key}`. Null until a run has assets. */
  assetBase: z.url({ protocol: /^https$/ }).nullable(),
  packages: z.record(z.string().regex(PACKAGE_ID), packageSchema),
  /** Keys this run dropped, deleted again by the next one in case a delete failed. */
  removed: z.array(z.string().regex(ASSET_KEY)),
});

/**
 * What the AI step writes (scripts/crawl/enrich.ts, to come) as drafts.json: this run's checked
 * drafts, only for the packages it enriched, with their re-encoded images under assets/<key>.
 */
export const draftsSchema = z.strictObject({
  run: runSchema,
  packages: z.record(z.string().regex(PACKAGE_ID), itemSchema),
});

export type Item = z.infer<typeof itemSchema>;
export type ItemSentence = z.infer<typeof sentenceSchema>;
export type ItemSource = z.infer<typeof sourceSchema>;
export type Pending = z.infer<typeof pendingSchema>;
export type PackageEnrichment = z.infer<typeof packageSchema>;
export type Enrichment = z.infer<typeof enrichmentSchema>;
export type Drafts = z.infer<typeof draftsSchema>;
export type Run = z.infer<typeof runSchema>;

/** A source as the item records it: the text itself stays in the crawl's cache. */
export const sourceRef = (source: Source, revision: string): ItemSource => ({
  id: source.id,
  kind: source.kind,
  url: source.url,
  revision,
  hash: createHash('sha256').update(source.text).digest('hex'),
});

/** A checked sentence as the item records it (offsets dropped: they're the model's). */
export const itemSentence = (s: Sentence): ItemSentence => ({
  text: s.text,
  citations: s.citations.map((c) => ({ source: c.source, quote: c.quote })),
});

/** JSON with object keys sorted, so equal items hash equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const itemHash = (item: Item): string =>
  createHash('sha256').update(stableJson(item)).digest('hex');

const assetsOf = (item: Item | null | undefined): AssetRecord[] =>
  item ? [...(item.icon ? [item.icon] : []), ...item.screenshots] : [];

/** Every asset key the file refers to, published or pending. */
export function referencedKeys(enrichment: Enrichment | null): Set<string> {
  const keys = new Set<string>();
  for (const p of Object.values(enrichment?.packages ?? {}))
    for (const a of [...assetsOf(p.published), ...assetsOf(p.pending?.item)]) keys.add(a.key);
  return keys;
}

/** The item without images taken down by hash. */
export function withoutTakenDown(item: Item, takedowns: Takedowns): Item {
  const keep = (a: AssetRecord) => !isTakenDown(a, takedowns);
  return {
    ...item,
    icon: item.icon && keep(item.icon) ? item.icon : null,
    screenshots: item.screenshots.filter(keep),
  };
}

function sourcesChanged(before: Item, after: Item): boolean {
  const hashes = (item: Item) =>
    item.sources
      .map((s) => `${s.kind} ${s.hash}`)
      .sort()
      .join('\n');
  return hashes(before) !== hashes(after);
}

const verdicts = (approvals: readonly Approval[]) =>
  new Map(approvals.map((a) => [`${a.id} ${a.draft}`, a.verdict] as const));

/**
 * What the site shows for a package: the approved pending draft, else the published item, with
 * takedowns applied. Null when there's nothing, or the package is taken down.
 */
export function shownItem(
  id: string,
  enrichment: PackageEnrichment | undefined,
  approvals: readonly Approval[],
  takedowns: Takedowns,
): Item | null {
  if (!enrichment || takedowns.packages.has(id)) return null;
  const { published, pending } = enrichment;
  const approved = pending && verdicts(approvals).get(`${id} ${pending.hash}`) === 'approve';
  const item = approved ? pending.item : published;
  return item && withoutTakenDown(item, takedowns);
}

export interface RunContext {
  run: Run;
  /** Where this run's assets are served, when it has any. */
  assetBase: string | null;
  approvals: readonly Approval[];
  takedowns: Takedowns;
  /** Official packages skip review after the first run. Unknown ids count as community. */
  isOfficial: (id: string) => boolean;
}

export interface NextEnrichment {
  enrichment: Enrichment;
  /** Keys to upload: referred to now and not before. */
  upload: string[];
  /** Keys to delete once the site no longer shows them. */
  remove: string[];
  /** Per package, what happened, for the run's log. */
  outcomes: Record<string, 'published' | 'pending' | 'unchanged' | 'rejected' | 'taken-down'>;
}

/**
 * The next enrichment.json: the previous one with the owner's verdicts applied, this run's
 * drafts merged in and takedowns applied, plus the keys to upload and delete.
 */
export function nextEnrichment(
  previous: Enrichment | null,
  drafts: Readonly<Record<string, Item>>,
  ctx: RunContext,
): NextEnrichment {
  const verdict = verdicts(ctx.approvals);
  const packages: Record<string, PackageEnrichment> = {};
  const outcomes: NextEnrichment['outcomes'] = {};

  // The owner's verdicts on what was waiting.
  for (const [id, p] of Object.entries(previous?.packages ?? {})) {
    if (ctx.takedowns.packages.has(id)) continue;
    const v = p.pending && verdict.get(`${id} ${p.pending.hash}`);
    if (v === 'approve') packages[id] = { published: p.pending!.item, pending: null };
    else if (v === 'reject') packages[id] = { published: p.published, pending: null };
    else packages[id] = p;
  }
  // Until the owner has approved something, every draft waits.
  const firstRun = !Object.values(packages).some((p) => p.published);

  for (const [id, draft] of Object.entries(drafts)) {
    if (ctx.takedowns.packages.has(id)) {
      outcomes[id] = 'taken-down';
      continue;
    }
    const item = withoutTakenDown(draft, ctx.takedowns);
    const h = itemHash(item);
    const current = packages[id] ?? { published: null, pending: null };
    const v = verdict.get(`${id} ${h}`);
    if (current.published && itemHash(current.published) === h) {
      packages[id] = { published: current.published, pending: null };
      outcomes[id] = 'unchanged';
    } else if (v === 'reject') {
      // Asked about before: keep what's shown, don't ask again.
      packages[id] = { published: current.published, pending: null };
      outcomes[id] = 'rejected';
    } else {
      const reason =
        v === 'approve'
          ? null
          : firstRun
            ? 'first-run'
            : // A first-run draft nobody answered keeps waiting when it's rewritten.
              !current.published && current.pending
              ? current.pending.reason
              : !ctx.isOfficial(id)
                ? 'community'
                : current.published && sourcesChanged(current.published, item)
                  ? 'sources-changed'
                  : null;
      packages[id] = reason
        ? {
            published: current.published,
            pending: {
              item,
              hash: h,
              reason,
              since: current.pending?.hash === h ? current.pending.since : ctx.run.date,
            },
          }
        : { published: item, pending: null };
      outcomes[id] = reason ? 'pending' : 'published';
    }
  }

  // Images taken down by hash since they were published or drafted.
  for (const [id, p] of Object.entries(packages)) {
    const published = p.published && withoutTakenDown(p.published, ctx.takedowns);
    let pending = p.pending;
    if (pending) {
      const item = withoutTakenDown(pending.item, ctx.takedowns);
      const h = itemHash(item);
      if (h !== pending.hash) pending = { ...pending, item, hash: h };
    }
    packages[id] = { published, pending };
    if (!published && !pending) delete packages[id];
  }

  const enrichment: Enrichment = {
    version: ENRICHMENT_VERSION,
    run: ctx.run,
    assetBase: ctx.assetBase ?? previous?.assetBase ?? null,
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
    removed: [],
  };
  const before = referencedKeys(previous);
  const after = referencedKeys(enrichment);
  const remove = [
    ...new Set([...before, ...(previous?.removed ?? [])].filter((k) => !after.has(k))),
  ].sort();
  enrichment.removed = remove;
  return {
    enrichment,
    upload: [...after].filter((k) => !before.has(k)).sort(),
    remove,
    outcomes,
  };
}
