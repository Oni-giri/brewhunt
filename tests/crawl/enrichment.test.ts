import { describe, expect, it } from 'vitest';
import type { Approval } from '../../scripts/content/schema.ts';
import type { AssetRecord } from '../../scripts/crawl/assets.ts';
import {
  enrichmentSchema,
  itemHash,
  nextEnrichment,
  shownItem,
  type Enrichment,
  type Item,
  type RunContext,
} from '../../scripts/crawl/enrichment.ts';
import { readTakedowns } from '../../scripts/crawl/takedown.ts';

const h = (c: string) => c.repeat(64);

const asset = (pkg: string, c: string, kind: 'icon' | 'screenshot' = 'icon'): AssetRecord => ({
  key: `${kind}s/v1/${h(c)}.webp`,
  kind,
  package: pkg,
  sourceUrl: `https://example.com/${c}.png`,
  sourceRevision: '2026-11-03T00:00:00Z',
  sourceHash: h(c),
  outputHash: h(c === 'f' ? 'e' : 'f'),
  width: 128,
  height: 128,
  animated: false,
  flags: [],
  licence: kind === 'icon' ? 'trademark: identification use' : 'MIT',
  credit: kind === 'icon' ? null : 'Screenshot from the project’s README',
  basis: 'judge',
});

const item = (pkg: string, text = 'Downloads files.', readme = 'a', icon = '1'): Item => ({
  sources: [
    {
      id: 'readme',
      kind: 'readme',
      url: 'https://github.com/x/y',
      revision: 'abc',
      hash: h(readme),
    },
  ],
  summary: [{ text, citations: [{ source: 'readme', quote: text }] }],
  bullets: [],
  tags: ['download'],
  category: null,
  icon: asset(pkg, icon),
  screenshots: [asset(pkg, '2', 'screenshot')],
});

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  run: { id: '42', date: '2026-11-10' },
  assetBase: 'https://assets.example.com',
  approvals: [],
  takedowns: readTakedowns([]),
  isOfficial: (id) => !id.includes('/'),
  ...extra,
});

const approve = (
  id: string,
  draft: string,
  verdict: Approval['verdict'] = 'approve',
): Approval => ({
  id,
  draft,
  verdict,
  date: '2026-11-11',
});

/** A first run, approved for wget: wget is published, curl waits. */
function afterFirstReview(): Enrichment {
  const first = nextEnrichment(null, { wget: item('wget'), curl: item('curl') }, ctx());
  const hash = first.enrichment.packages.wget.pending!.hash;
  return nextEnrichment(first.enrichment, {}, ctx({ approvals: [approve('wget', hash)] }))
    .enrichment;
}

describe('nextEnrichment', () => {
  it('sends the whole first run to review, and its assets to upload', () => {
    const { enrichment, upload, remove, outcomes } = nextEnrichment(
      null,
      { wget: item('wget') },
      ctx(),
    );
    expect(enrichmentSchema.parse(enrichment)).toEqual(enrichment);
    expect(enrichment.packages.wget).toEqual({
      published: null,
      pending: {
        item: item('wget'),
        hash: itemHash(item('wget')),
        reason: 'first-run',
        since: '2026-11-10',
      },
    });
    expect(outcomes).toEqual({ wget: 'pending' });
    expect(upload).toEqual([`icons/v1/${h('1')}.webp`, `screenshots/v1/${h('2')}.webp`]);
    expect(remove).toEqual([]);
  });

  it('stays a first run until something is published', () => {
    const first = nextEnrichment(null, { wget: item('wget') }, ctx()).enrichment;
    const second = nextEnrichment(
      first,
      { curl: item('curl') },
      ctx({ run: { id: '43', date: '2026-11-17' } }),
    );
    expect(second.enrichment.packages.curl.pending?.reason).toBe('first-run');
    // The same draft again keeps its first date.
    const again = nextEnrichment(
      first,
      { wget: item('wget') },
      ctx({ run: { id: '43', date: '2026-11-17' } }),
    );
    expect(again.enrichment.packages.wget.pending?.since).toBe('2026-11-10');
  });

  it('ends the first run with the owner’s first approval, in the run that applies it', () => {
    const first = nextEnrichment(null, { wget: item('wget') }, ctx()).enrichment;
    const draft = first.packages.wget.pending!.hash;
    const second = nextEnrichment(
      first,
      { curl: item('curl') },
      ctx({
        run: { id: '43', date: '2026-11-17' },
        approvals: [{ id: 'wget', draft, verdict: 'approve', date: '2026-11-12' }],
      }),
    );
    expect(second.outcomes.curl).toBe('published');
  });

  it('keeps an unanswered first-run draft waiting when it’s rewritten', () => {
    const first = nextEnrichment(
      null,
      { wget: item('wget'), curl: item('curl') },
      ctx(),
    ).enrichment;
    const draft = first.packages.wget.pending!.hash;
    const second = nextEnrichment(
      first,
      { curl: item('curl', 'rewritten') },
      ctx({
        run: { id: '43', date: '2026-11-17' },
        approvals: [{ id: 'wget', draft, verdict: 'approve', date: '2026-11-12' }],
      }),
    );
    expect(second.outcomes.curl).toBe('pending');
    expect(second.enrichment.packages.curl.pending?.reason).toBe('first-run');
  });

  it('promotes an approved draft and drops a rejected one, deleting its images', () => {
    const first = nextEnrichment(
      null,
      { wget: item('wget'), curl: item('curl', 'x', 'a', '3') },
      ctx(),
    );
    const { wget, curl } = first.enrichment.packages;
    const next = nextEnrichment(
      first.enrichment,
      {},
      ctx({
        approvals: [
          approve('wget', wget.pending!.hash),
          approve('curl', curl.pending!.hash, 'reject'),
        ],
      }),
    );
    expect(next.enrichment.packages.wget).toEqual({ published: item('wget'), pending: null });
    expect(next.enrichment.packages.curl).toBeUndefined();
    expect(next.remove).toEqual([`icons/v1/${h('3')}.webp`]);
    expect(next.enrichment.removed).toEqual(next.remove);
  });

  it('publishes new official packages and unchanged sources after the first run', () => {
    const before = afterFirstReview();
    const next = nextEnrichment(
      before,
      {
        jq: item('jq'),
        wget: item('wget', 'Downloads files over HTTP.'),
        'owner/tap/tool': item('owner/tap/tool'),
      },
      ctx(),
    );
    expect(next.outcomes).toEqual({
      jq: 'published',
      wget: 'published',
      'owner/tap/tool': 'pending',
    });
    expect(next.enrichment.packages['owner/tap/tool'].pending?.reason).toBe('community');
    expect(next.enrichment.packages.wget.published?.summary[0].text).toBe(
      'Downloads files over HTTP.',
    );
  });

  it('holds a draft from changed sources for review, keeping what’s published', () => {
    const before = afterFirstReview();
    const changed = item('wget', 'Mirrors websites.', 'b');
    const next = nextEnrichment(before, { wget: changed }, ctx());
    expect(next.enrichment.packages.wget.published).toEqual(item('wget'));
    expect(next.enrichment.packages.wget.pending?.reason).toBe('sources-changed');
    // A draft equal to what's published clears it.
    const back = nextEnrichment(next.enrichment, { wget: item('wget') }, ctx());
    expect(back.enrichment.packages.wget).toEqual({ published: item('wget'), pending: null });
    expect(back.outcomes.wget).toBe('unchanged');
  });

  it('doesn’t ask again about a draft the owner rejected', () => {
    const before = afterFirstReview();
    const changed = item('wget', 'Mirrors websites.', 'b');
    const next = nextEnrichment(
      before,
      { wget: changed },
      ctx({ approvals: [approve('wget', itemHash(changed), 'reject')] }),
    );
    expect(next.outcomes.wget).toBe('rejected');
    expect(next.enrichment.packages.wget).toEqual({ published: item('wget'), pending: null });
  });

  it('applies takedowns to everything, published, pending and new', () => {
    const before = afterFirstReview();
    const takedowns = readTakedowns([
      { id: 'curl', hashes: [], date: '2026-11-12', reason: 'Asked by the developer.' },
      { id: 'wget', hashes: [h('2')], date: '2026-11-12', reason: 'Asked by the developer.' },
    ]);
    const next = nextEnrichment(before, { curl: item('curl') }, ctx({ takedowns }));
    expect(next.outcomes.curl).toBe('taken-down');
    expect(next.enrichment.packages.curl).toBeUndefined();
    expect(next.enrichment.packages.wget.published?.screenshots).toEqual([]);
    // wget's and curl's screenshot share a key; curl's icon is curl's own.
    expect(next.remove).toEqual([`screenshots/v1/${h('2')}.webp`]);
    expect(nextEnrichment(next.enrichment, {}, ctx({ takedowns })).remove).toEqual(next.remove);
  });

  it('keeps an image another package still shows', () => {
    const before = afterFirstReview();
    const takedowns = readTakedowns([
      { id: 'curl', hashes: [], date: '2026-11-12', reason: 'Asked by the developer.' },
    ]);
    // curl's pending draft shares wget's screenshot and icon key ('1').
    expect(nextEnrichment(before, {}, ctx({ takedowns })).remove).toEqual([]);
  });
});

describe('shownItem', () => {
  const takedowns = readTakedowns([]);
  it('shows the approved pending draft, else what’s published', () => {
    const before = afterFirstReview();
    const changed = item('wget', 'Mirrors websites.', 'b');
    const p = nextEnrichment(before, { wget: changed }, ctx()).enrichment.packages.wget;
    expect(shownItem('wget', p, [], takedowns)).toEqual(item('wget'));
    expect(shownItem('wget', p, [approve('wget', p.pending!.hash)], takedowns)).toEqual(changed);
    expect(shownItem('wget', p, [approve('wget', h('9'))], takedowns)).toEqual(item('wget'));
    expect(shownItem('wget', undefined, [], takedowns)).toBeNull();
  });

  it('shows nothing for a package taken down, and no image taken down', () => {
    const p = { published: item('wget'), pending: null };
    const whole = readTakedowns([{ id: 'wget', hashes: [], date: '2026-11-12', reason: 'Asked.' }]);
    expect(shownItem('wget', p, [], whole)).toBeNull();
    const icon = readTakedowns([
      { id: 'wget', hashes: [h('1')], date: '2026-11-12', reason: 'Asked.' },
    ]);
    expect(shownItem('wget', p, [], icon)?.icon).toBeNull();
  });
});
