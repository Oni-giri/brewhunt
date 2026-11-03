// The crawler's output as the pages use it: enrichment/enrichment.json, checked out from the
// `enrichment` branch next to data/ (scripts/crawl/enrichment.ts says what it holds). Optional:
// without the folder, the site builds as it did before the crawler.
//
// What a page shows is the approved draft or the published item (shownItem), with takedowns
// applied. Crawled URLs go through externalUrl like every other link. Images are served from the
// crawl's asset domain, which public/_headers must allow: the build stops if it doesn't, rather
// than ship pages whose images the browser would refuse.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '../../scripts/content/schema.ts';
import {
  enrichmentSchema,
  shownItem,
  type Enrichment,
  type Item,
} from '../../scripts/crawl/enrichment.ts';
import { readTakedowns } from '../../scripts/crawl/takedown.ts';
import { externalUrl } from './urls.ts';

export interface Screenshot {
  url: string;
  width: number;
  height: number;
  animated: boolean;
  /** "Screenshot from the project's README". */
  credit: string | null;
  licence: string | null;
  /** Where it was taken from, when that's a web link. */
  sourceUrl: string | null;
}

/** A package's crawled content, as shown. */
export interface Enriched {
  /** Summary sentences, Brewhunt-written from the sources. */
  summary: string[];
  bullets: string[];
  tags: string[];
  /** The icon's URL, for packages without CaskFlow's. */
  icon: string | null;
  screenshots: Screenshot[];
  /** What the summary was written from. */
  sources: { kind: 'homepage' | 'readme'; url: string }[];
}

/** The image origins public/_headers' Content-Security-Policy allows. */
export function allowedImageOrigins(headers: string): string[] {
  const csp = headers.match(/^\s+Content-Security-Policy: (.+)$/m)?.[1] ?? '';
  const imgSrc = csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([name]) => name === 'img-src');
  return imgSrc?.slice(1) ?? [];
}

export function readEnrichment(root = process.cwd()): Enrichment | null {
  const file = join(root, 'enrichment', 'enrichment.json');
  if (!existsSync(file)) return null;
  const parsed = enrichmentSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success)
    throw new Error(`enrichment/enrichment.json isn't valid: ${parsed.error.message}`);
  const enrichment = parsed.data;
  if (enrichment.assetBase) {
    const origin = new URL(enrichment.assetBase).origin;
    const allowed = allowedImageOrigins(readFileSync(join(root, 'public', '_headers'), 'utf8'));
    if (!allowed.includes(origin))
      throw new Error(
        `The crawl's images are served from ${origin}, which public/_headers' img-src doesn't allow. Add it there.`,
      );
  }
  return enrichment;
}

function toEnriched(item: Item, assetBase: string | null): Enriched | null {
  const assetUrl = (key: string) => (assetBase ? `${assetBase.replace(/\/$/, '')}/${key}` : null);
  const enriched: Enriched = {
    summary: item.summary.map((s) => s.text),
    bullets: item.bullets.map((s) => s.text),
    tags: item.tags,
    icon: item.icon ? assetUrl(item.icon.key) : null,
    screenshots: item.screenshots.flatMap((s) => {
      const url = assetUrl(s.key);
      return url
        ? [
            {
              url,
              width: s.width,
              height: s.height,
              animated: s.animated,
              credit: s.credit,
              licence: s.licence,
              sourceUrl: externalUrl(s.sourceUrl),
            },
          ]
        : [];
    }),
    sources: item.sources.flatMap((s) => {
      const url = externalUrl(s.url);
      return url ? [{ kind: s.kind, url }] : [];
    }),
  };
  const empty =
    !enriched.summary.length &&
    !enriched.bullets.length &&
    !enriched.tags.length &&
    !enriched.icon &&
    !enriched.screenshots.length;
  return empty ? null : enriched;
}

/** Each package's shown content, by id: only packages with something to show. */
export function enrichedPackages(
  enrichment: Enrichment | null,
  content: Pick<Content, 'approvals' | 'takedown'>,
): Map<string, Enriched> {
  const out = new Map<string, Enriched>();
  if (!enrichment) return out;
  const takedowns = readTakedowns(content.takedown);
  for (const [id, p] of Object.entries(enrichment.packages)) {
    const item = shownItem(id, p, content.approvals, takedowns);
    const enriched = item && toEnriched(item, enrichment.assetBase);
    if (enriched) out.set(id, enriched);
  }
  return out;
}
