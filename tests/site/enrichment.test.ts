import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextEnrichment, type Enrichment, type Item } from '../../scripts/crawl/enrichment.ts';
import { readTakedowns } from '../../scripts/crawl/takedown.ts';
import { allowedImageOrigins, enrichedPackages, readEnrichment } from '../../src/lib/enrichment.ts';

const h = (c: string) => c.repeat(64);
const cask = () => 'cask' as const;
const BASE = 'https://assets.example.com';

const item = (sourceUrl = 'https://github.com/x/y/raw/demo.png'): Item => ({
  sources: [
    { id: 'readme', kind: 'readme', url: 'https://github.com/x/y', revision: 'abc', hash: h('a') },
    { id: 'home', kind: 'homepage', url: 'javascript:alert(1)', revision: 'now', hash: h('b') },
  ],
  summary: [
    { text: 'Downloads files.', citations: [{ source: 'readme', quote: 'Downloads files' }] },
  ],
  bullets: [],
  tags: ['download'],
  category: null,
  icon: null,
  screenshots: [
    {
      key: `screenshots/v1/${h('2')}.webp`,
      kind: 'screenshot',
      package: 'wget',
      sourceUrl,
      sourceRevision: 'abc',
      sourceHash: h('2'),
      outputHash: h('3'),
      width: 1200,
      height: 800,
      animated: false,
      flags: [],
      licence: 'MIT',
      credit: 'Screenshot from the project’s README',
      basis: 'rules',
    },
  ],
});

function published(assetBase: string | null = BASE): Enrichment {
  const run = { id: '1', date: '2026-11-10' };
  const ctx = {
    run,
    assetBase,
    approvals: [],
    takedowns: readTakedowns([]),
    isOfficial: () => true,
  };
  const first = nextEnrichment(null, { wget: item() }, ctx).enrichment;
  const draft = first.packages.wget.pending!.hash;
  return nextEnrichment(
    first,
    {},
    {
      ...ctx,
      approvals: [{ id: 'wget', draft, verdict: 'approve', date: '2026-11-11' }],
    },
  ).enrichment;
}

function site(enrichment: Enrichment | null, csp: string): string {
  const root = mkdtempSync(join(tmpdir(), 'brewhunt-enrichment-'));
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public', '_headers'), `/*\n  Content-Security-Policy: ${csp}\n`);
  if (enrichment) {
    mkdirSync(join(root, 'enrichment'));
    writeFileSync(join(root, 'enrichment', 'enrichment.json'), JSON.stringify(enrichment));
  }
  return root;
}

describe('allowedImageOrigins', () => {
  it('reads img-src from the headers file', () => {
    expect(
      allowedImageOrigins(
        "/*\n  Content-Security-Policy: default-src 'none'; img-src 'self' https://cdn.jsdelivr.net; font-src 'self'\n",
      ),
    ).toEqual(["'self'", 'https://cdn.jsdelivr.net']);
    expect(allowedImageOrigins('')).toEqual([]);
  });
});

describe('readEnrichment', () => {
  it('is null without the folder: the site builds as before', () => {
    expect(readEnrichment(site(null, "img-src 'self'"))).toBeNull();
  });

  it('stops the build when the CSP would block the images', () => {
    expect(() => readEnrichment(site(published(), "img-src 'self'"))).toThrow(
      /https:\/\/assets\.example\.com.*img-src/,
    );
    expect(readEnrichment(site(published(), `img-src 'self' ${BASE}`))?.packages.wget).toBeTruthy();
  });

  it('refuses a file that doesn’t match the schema', () => {
    const broken = { ...published(), packages: { wget: { published: { summary: 'x' } } } };
    expect(() => readEnrichment(site(broken as unknown as Enrichment, "img-src 'self'"))).toThrow(
      /isn't valid/,
    );
  });
});

describe('enrichedPackages', () => {
  it('turns keys into URLs and drops links that aren’t web links', () => {
    const shown = enrichedPackages(published(), { approvals: [], takedown: [] }, cask).get('wget')!;
    expect(shown.summary).toEqual(['Downloads files.']);
    expect(shown.sources).toEqual([{ kind: 'readme', url: 'https://github.com/x/y' }]);
    expect(shown.screenshots[0].url).toBe(`${BASE}/screenshots/v1/${h('2')}.webp`);
  });

  it('shows screenshots on Mac apps only', () => {
    const formula = enrichedPackages(published(), { approvals: [], takedown: [] }, () => 'formula');
    expect(formula.get('wget')?.screenshots).toEqual([]);
    expect(formula.get('wget')?.summary).toEqual(['Downloads files.']);
    // Not in the catalog: no screenshots either.
    expect(
      enrichedPackages(published(), { approvals: [], takedown: [] }, () => undefined).get('wget')
        ?.screenshots,
    ).toEqual([]);
  });

  it('shows nothing for a package taken down or still waiting for review', () => {
    const takedown = [{ id: 'wget', hashes: [], date: '2026-11-12', reason: 'Asked.' }];
    expect(enrichedPackages(published(), { approvals: [], takedown }, cask).size).toBe(0);
    const waiting = nextEnrichment(
      null,
      { wget: item() },
      {
        run: { id: '1', date: '2026-11-10' },
        assetBase: BASE,
        approvals: [],
        takedowns: readTakedowns([]),
        isOfficial: () => true,
      },
    ).enrichment;
    expect(enrichedPackages(waiting, { approvals: [], takedown: [] }, cask).size).toBe(0);
  });
});
