// Logo candidates for the answer key's "findable" packages (owner's call, 1 Nov 2026): the owner
// said the right icon exists but none of the first candidates was it. This looks where
// logos.ts says, fetches everything through the SafeFetcher, and writes a folder in the dry run's
// shape, so icon-check.ts (--findable) can preset a pick and contact-sheet.ts can show it.
//
//   node scripts/crawl/find-logos.ts --from <answer-key dir> --key tests/fixtures/answer-key/icons.json --out <dir>
//
// Candidates that look like one the owner already turned down are kept, dimmed, with that reason.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { repoKey } from '../data/repos.ts';
import type { IconResult, PackageResult } from './dry-run.ts';
import {
  ICON_REJECT_BELOW,
  hamming,
  homepageIcons,
  hostOf,
  isSharedHost,
  manifestIcons,
  readPage,
  type IconCandidate,
  type ManifestIcon,
  type PageFacts,
} from './extract.ts';
import { SafeFetcher, decodeText } from './fetch.ts';
import { fetchDetails } from './github.ts';
import { measure } from './images.ts';
import { makerSite, pageLogos, readmeLogos } from './logos.ts';
import { EXT, failure, pool, safeName } from './util.ts';

/** Icons kept from each maker site: its best few are enough. */
const MAKER_ICONS = 3;

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    key: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string', default: '6' },
  },
});
if (!args.from || !args.key || !args.out) {
  console.error(
    'Usage: node scripts/crawl/find-logos.ts --from <dir> --key <icons.json> --out <dir>',
  );
  process.exit(2);
}
const OUT = args.out;
mkdirSync(OUT, { recursive: true });
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const key = JSON.parse(readFileSync(args.key, 'utf8')) as { id: string; source: string }[];
const findable = new Set(key.filter((k) => k.source === 'findable').map((k) => k.id));
const { packages: all } = JSON.parse(readFileSync(join(args.from, 'results.json'), 'utf8')) as {
  packages: PackageResult[];
};
const packages = all.filter((p) => findable.has(p.id));
log(`${packages.length} findable packages → ${OUT}`);

const fetcher = new SafeFetcher();

/** A page and its manifest's icons; null when it can't be read. */
async function readSite(
  url: string,
): Promise<{ facts: PageFacts; manifest: ManifestIcon[]; html: string } | null> {
  try {
    let page = await fetcher.get(url, 'html');
    let html = decodeText(page);
    let facts = readPage(html, page.url);
    if (facts.refresh) {
      page = await fetcher.get(facts.refresh, 'html');
      html = decodeText(page);
      facts = readPage(html, page.url);
    }
    let manifest: ManifestIcon[] = [];
    if (facts.manifest) {
      try {
        const fetched = await fetcher.get(facts.manifest, 'json', 200_000);
        manifest = manifestIcons(JSON.parse(decodeText(fetched)), fetched.url);
      } catch {
        // A broken manifest only loses its icons.
      }
    }
    return { facts, manifest, html };
  } catch {
    return null;
  }
}

// GitHub: the repository the data knows, or the one a github.com homepage names.
const repoOf = (p: PackageResult) => p.repo?.name.toLowerCase() ?? repoKey(p.homepage);
let token = process.env.GITHUB_TOKEN;
if (!token) token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const repoKeys = [...new Set(packages.map(repoOf).filter((k): k is string => k !== null))];
const details = await fetchDetails(repoKeys, token, log);
log(`GitHub: ${details.size} of ${repoKeys.length} repositories answered`);

const results: PackageResult[] = [];
let done = 0;
await pool(packages, Number(args.concurrency), async (p) => {
  const repoKeyOf = repoOf(p);
  const repo = repoKeyOf ? (details.get(repoKeyOf) ?? null) : null;
  const candidates: (IconCandidate & { svg?: string })[] = [];

  // The tool's own: its homepage's logo, then its README's.
  let pageError: string | null = null;
  if (p.homepage && !isSharedHost(hostOf(p.homepage))) {
    const site = await readSite(p.homepage);
    if (site) {
      for (const logo of pageLogos(site.html, site.facts.url)) {
        candidates.push({
          source: logo.svg ? 'page-svg' : 'page-logo',
          url: logo.url,
          declared: null,
          ...(logo.svg && { svg: logo.svg }),
        });
      }
    } else pageError = 'homepage not read';
  }
  if (repo?.readme) {
    for (const url of readmeLogos(repo.readme, repo.nameWithOwner))
      candidates.push({ source: 'readme-logo', url, declared: null });
  }

  // The maker's: the GitHub organisation's avatar, and its site's icons.
  if (repo?.owner.isOrganization && repo.owner.avatarUrl)
    candidates.push({ source: 'org-avatar', url: repo.owner.avatarUrl, declared: null });
  const makers = [makerSite(p.homepage), repo?.owner.websiteUrl ?? null].filter(
    (url): url is string => url !== null && hostOf(url) !== hostOf(p.homepage),
  );
  for (const url of [...new Map(makers.map((u) => [hostOf(u), u])).values()]) {
    const site = await readSite(url);
    if (!site) continue;
    for (const icon of homepageIcons(url, site.facts, site.manifest).slice(0, MAKER_ICONS))
      candidates.push({ ...icon, source: 'maker-site' });
  }

  // Fetched, measured and saved, like the dry run's.
  const dir = join(OUT, 'files', safeName(p.id));
  mkdirSync(dir, { recursive: true });
  const turnedDown = p.icons.map((i) => i.hash).filter((h): h is string => !!h);
  const seen = new Set<string>();
  const icons: IconResult[] = [];
  for (const [i, { svg, ...candidate }] of candidates.entries()) {
    if (icons.some((r) => r.url === candidate.url)) continue;
    const result: IconResult = { ...candidate, status: 'rejected' };
    icons.push(result);
    try {
      const image = svg
        ? { url: candidate.url, body: Buffer.from(svg), format: 'svg' as const }
        : await fetcher.get(candidate.url, 'image');
      const size = await measure(image.body, image.format!);
      Object.assign(result, {
        finalUrl: image.url,
        format: image.format,
        width: size.width,
        height: size.height,
        hash: size.hash,
      });
      const smallest = Math.min(size.width ?? Infinity, size.height ?? Infinity);
      if (image.format === 'ico') result.reason = 'ICO (nothing can re-encode it)';
      else if (image.format !== 'svg' && smallest < ICON_REJECT_BELOW)
        result.reason = `too small (${size.width}×${size.height})`;
      else if (size.hash && seen.has(size.hash))
        result.reason = 'same image as an earlier candidate';
      else if (size.hash && turnedDown.some((h) => hamming(h, size.hash!) <= 4))
        result.reason = 'looks like a candidate the owner turned down';
      else result.status = 'ok';
      if (size.hash) seen.add(size.hash);
      const file = join(dir, `logo-${i}.${EXT[image.format!]}`);
      writeFileSync(file, image.body);
      result.file = file.slice(OUT.length + 1);
    } catch (error) {
      result.reason = failure(error);
    }
  }
  results.push({ ...p, pageError: p.pageError ?? pageError, icons, screenshots: [] });
  if (++done % 10 === 0) log(`${done}/${packages.length}`);
});

const order = new Map(packages.map((p, i) => [p.id, i]));
results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
writeFileSync(
  join(OUT, 'results.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), iconsOnly: true, packages: results }, null, 1)}\n`,
);
const count = (f: (r: PackageResult) => boolean) => results.filter(f).length;
const by = (source: string) =>
  count((r) => r.icons.some((i) => i.status === 'ok' && i.source === source));
log(
  `Done. At least one new candidate: ${count((r) => r.icons.some((i) => i.status === 'ok'))}/${results.length}; page logo ${by('page-logo') + by('page-svg')}, README ${by('readme-logo')}, organisation avatar ${by('org-avatar')}, maker site ${by('maker-site')}`,
);
