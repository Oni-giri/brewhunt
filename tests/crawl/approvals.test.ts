import { describe, expect, it } from 'vitest';
import { readApprovals, setVerdict, waitingDrafts } from '../../scripts/crawl/approvals.ts';
import { nextEnrichment, type Item } from '../../scripts/crawl/enrichment.ts';
import { readTakedowns } from '../../scripts/crawl/takedown.ts';
import type { Package } from '../../scripts/data/types.ts';

const h = (c: string) => c.repeat(64);
const HEADER = '# Approvals: the owner’s verdicts.\n#\n# - id: wget\n#   verdict: approve\n\n[]\n';

const item = (text: string, source = 'a', icon = false): Item => ({
  sources: [
    {
      id: 'readme',
      kind: 'readme',
      url: 'https://github.com/x/y',
      revision: 'abc',
      hash: h(source),
    },
  ],
  summary: [{ text, citations: [{ source: 'readme', quote: text }] }],
  bullets: [],
  tags: [],
  category: null,
  icon: icon
    ? {
        key: `icons/v1/${h('1')}.webp`,
        kind: 'icon',
        package: 'wget',
        sourceUrl: 'https://example.com/logo.svg',
        sourceRevision: 'now',
        sourceHash: h('1'),
        outputHash: h('2'),
        width: 128,
        height: 128,
        animated: false,
        flags: [],
        licence: null,
        credit: null,
        basis: 'rules',
      }
    : null,
  screenshots: [],
});

const pkg = (id: string, d30: number, source: 'official' | 'community' = 'official') =>
  ({ id, name: id, source, installs: { d30, d90: 0, d365: 0 } }) as unknown as Package;

const ctx = (date: string, approvals: Parameters<typeof nextEnrichment>[2]['approvals'] = []) => ({
  run: { id: date, date },
  assetBase: 'https://assets.example.com',
  approvals,
  takedowns: readTakedowns([]),
  isOfficial: (id: string) => !id.includes('/'),
});

describe('setVerdict', () => {
  const change = { id: 'wget', draft: h('a'), verdict: 'approve' as const, date: '2026-11-04' };

  it('adds, replaces and clears a verdict, keeping the comments', () => {
    const added = setVerdict(HEADER, change);
    expect(added.startsWith('# Approvals: the owner’s verdicts.\n#\n# - id: wget')).toBe(true);
    expect(readApprovals(added)).toEqual([change]);

    const replaced = setVerdict(added, { ...change, verdict: 'reject', date: '2026-11-05' });
    expect(readApprovals(replaced)).toEqual([{ ...change, verdict: 'reject', date: '2026-11-05' }]);

    const two = setVerdict(replaced, { ...change, id: 'curl' });
    expect(readApprovals(two).map((a) => a.id)).toEqual(['wget', 'curl']);

    const cleared = setVerdict(setVerdict(two, { ...change, verdict: null }), {
      ...change,
      id: 'curl',
      verdict: null,
    });
    expect(cleared).toBe(HEADER);
  });

  it('keeps verdicts on other drafts of the same package', () => {
    const both = setVerdict(setVerdict(HEADER, change), { ...change, draft: h('b') });
    expect(readApprovals(both)).toHaveLength(2);
  });

  it('refuses what validate:content would', () => {
    expect(() => setVerdict(HEADER, { ...change, draft: 'abc' })).toThrow(/wouldn't be valid/);
    expect(() => setVerdict(HEADER, { ...change, date: 'today' })).toThrow(/wouldn't be valid/);
    expect(() => setVerdict('a: 1\n', change)).toThrow(/should be a list/);
  });

  it('starts an empty file', () => {
    expect(readApprovals(setVerdict('', change))).toEqual([change]);
  });
});

describe('waitingDrafts', () => {
  // Run 1: two first-run drafts. wget is approved, and run 2 brings new sources for it, a
  // community package, and a new official one that publishes directly.
  const first = nextEnrichment(
    null,
    { wget: item('Downloads files.', 'a', true), jq: item('Filters JSON.') },
    ctx('2026-11-03'),
  ).enrichment;
  const approve = [
    {
      id: 'wget',
      draft: first.packages.wget.pending!.hash,
      verdict: 'approve' as const,
      date: '2026-11-03',
    },
  ];
  const second = nextEnrichment(
    first,
    {
      wget: item('Fetches files.', 'b', true),
      'a/b/tool': item('A community tool.'),
      curl: item('Transfers data.'),
    },
    ctx('2026-11-04', approve),
  ).enrichment;
  const packages = [pkg('wget', 10), pkg('jq', 50), pkg('curl', 99)];

  it('lists first-run, changed-source and community drafts, in that order', () => {
    const list = waitingDrafts(second, [], readTakedowns([]), packages);
    expect(list.map((d) => [d.id, d.pending.reason])).toEqual([
      ['jq', 'first-run'],
      ['wget', 'sources-changed'],
      ['a/b/tool', 'community'],
    ]);
    expect(list[1].published?.summary[0].text).toBe('Downloads files.');
    expect(list[2].pkg).toBeNull();
    expect(list.every((d) => d.verdict === null)).toBe(true);
  });

  it('sorts by installs within a reason', () => {
    const run = nextEnrichment(
      null,
      { wget: item('Downloads files.'), jq: item('Filters JSON.'), curl: item('Transfers data.') },
      ctx('2026-11-03'),
    ).enrichment;
    expect(waitingDrafts(run, [], readTakedowns([]), packages).map((d) => d.id)).toEqual([
      'curl',
      'jq',
      'wget',
    ]);
  });

  it('shows the verdict on this draft only', () => {
    const jq = second.packages.jq.pending!.hash;
    const approvals = [
      { id: 'jq', draft: jq, verdict: 'reject' as const, date: '2026-11-04' },
      { id: 'wget', draft: h('f'), verdict: 'approve' as const, date: '2026-11-04' },
    ];
    const list = waitingDrafts(second, approvals, readTakedowns([]), packages);
    expect(list.find((d) => d.id === 'jq')?.verdict).toBe('reject');
    expect(list.find((d) => d.id === 'wget')?.verdict).toBeNull();
  });

  it('leaves out taken-down packages and images', () => {
    const takedowns = readTakedowns([
      { id: 'jq', hashes: [], date: '2026-11-04', reason: 'Asked.' },
      { id: 'wget', hashes: [h('1')], date: '2026-11-04', reason: 'Asked.' },
    ]);
    const list = waitingDrafts(second, [], takedowns, packages);
    expect(list.map((d) => d.id)).toEqual(['wget', 'a/b/tool']);
    expect(list[0].item.icon).toBeNull();
    expect(list[0].takenDown).toBe(1);
    expect(list[0].published?.icon).toBeNull();
  });
});
