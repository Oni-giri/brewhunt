// The owner's review of crawler drafts (M5 C, plan step 7): which drafts wait, and how a verdict
// is written to content/approvals.yaml. review-drafts.ts serves the page.
//
// A verdict names the draft's hash, so it can't approve a later draft by accident. Verdicts are
// never pruned here: a rejected hash is how the next crawl knows not to ask again
// (enrichment.ts), and an approval that the crawl has since published is harmless.

import { isMap, isSeq, parseDocument, type Document } from 'yaml';
import { approvalsSchema, type Approval } from '../content/schema.ts';
import type { Package } from '../data/types.ts';
import {
  showsScreenshots,
  withoutTakenDown,
  type Enrichment,
  type Item,
  type Pending,
} from './enrichment.ts';
import type { Takedowns } from './takedown.ts';

const REASONS: readonly Pending['reason'][] = ['first-run', 'sources-changed', 'community'];

export interface WaitingDraft {
  id: string;
  /** From today's catalog; null when the package has left it. */
  pkg: Package | null;
  pending: Pending;
  /**
   * The draft as it would be shown: images taken down since the run are left out, and screenshots
   * unless it's a Mac app.
   */
  item: Item;
  /** How many of the draft's images were taken down since the run. */
  takenDown: number;
  /** What the site shows now, when anything, the same way. */
  published: Item | null;
  verdict: Approval['verdict'] | null;
}

const imageCount = (item: Item) => (item.icon ? 1 : 0) + item.screenshots.length;

/**
 * Every draft waiting for a verdict, by reason (first run, then changed sources, then community
 * packages), most installed first. Taken-down packages aren't listed: they show nothing anyway.
 */
export function waitingDrafts(
  enrichment: Enrichment,
  approvals: readonly Approval[],
  takedowns: Takedowns,
  packages: readonly Package[],
): WaitingDraft[] {
  const byId = new Map(packages.map((p) => [p.id, p]));
  const verdicts = new Map(approvals.map((a) => [`${a.id} ${a.draft}`, a.verdict] as const));
  const out: WaitingDraft[] = [];
  for (const [id, p] of Object.entries(enrichment.packages)) {
    if (!p.pending || takedowns.packages.has(id)) continue;
    const pkg = byId.get(id) ?? null;
    const shown = (it: Item): Item => {
      const item = withoutTakenDown(it, takedowns);
      return pkg && showsScreenshots(pkg.kind) ? item : { ...item, screenshots: [] };
    };
    const item = shown(p.pending.item);
    out.push({
      id,
      pkg,
      pending: p.pending,
      item,
      takenDown:
        imageCount(p.pending.item) - imageCount(withoutTakenDown(p.pending.item, takedowns)),
      published: p.published && shown(p.published),
      verdict: verdicts.get(`${id} ${p.pending.hash}`) ?? null,
    });
  }
  const installs = (d: WaitingDraft) => d.pkg?.installs.d30 ?? 0;
  return out.sort(
    (a, b) =>
      REASONS.indexOf(a.pending.reason) - REASONS.indexOf(b.pending.reason) ||
      installs(b) - installs(a) ||
      a.id.localeCompare(b.id),
  );
}

export interface VerdictChange {
  id: string;
  draft: string;
  /** Null clears the verdict. */
  verdict: Approval['verdict'] | null;
  date: string;
}

/**
 * approvals.yaml's text with one draft's verdict set, replaced or cleared, keeping the file's
 * comments. Throws when the result wouldn't pass validate:content.
 */
export function setVerdict(text: string, change: VerdictChange): string {
  // Widened from the parsed type, so new nodes can go in.
  const doc: Document = parseDocument(text);
  if (doc.errors.length) throw new Error(`approvals.yaml doesn't parse: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode([]);
  const seq = doc.contents;
  if (!isSeq(seq)) throw new Error('approvals.yaml should be a list.');
  const at = seq.items.findIndex(
    (n) => isMap(n) && n.get('id') === change.id && n.get('draft') === change.draft,
  );
  if (change.verdict) {
    const node = doc.createNode({
      id: change.id,
      draft: change.draft,
      verdict: change.verdict,
      date: change.date,
    });
    if (at >= 0) seq.items[at] = node;
    else seq.items.push(node);
  } else if (at >= 0) seq.items.splice(at, 1);
  // `[]` while empty, a block list once it has entries.
  seq.flow = seq.items.length === 0;
  const parsed = approvalsSchema.safeParse(doc.toJS());
  if (!parsed.success) throw new Error(`approvals.yaml wouldn't be valid: ${parsed.error.message}`);
  return doc.toString({ lineWidth: 0 });
}

/** approvals.yaml's entries, checked. */
export function readApprovals(text: string): Approval[] {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`approvals.yaml doesn't parse: ${doc.errors[0].message}`);
  return approvalsSchema.parse(doc.toJS() ?? []);
}
