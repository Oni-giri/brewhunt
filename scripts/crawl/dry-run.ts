// A local crawl that publishes nothing: fetches homepages, asks GitHub about repositories, and
// gathers icon and screenshot candidates into a folder, with every decision and the reason for
// each rejection, to look at (or to build the icon answer key from, contact-sheet.ts). No AI step:
// that needs the owner's Anthropic key.
//
//   node scripts/crawl/dry-run.ts --out <dir> [--top 50 | --answer-key 300 | --ids <icons.json>] [--icons-only]
//
// --top N:        the N most popular listed packages, everything extracted.
// --answer-key N: the N most popular listed packages without a CaskFlow icon (fonts aside), icons
//                 only: the packages the icon answer key covers (M5 C1).
// --ids <file>:   exactly the packages of an answer key (tests/fixtures/answer-key/icons.json),
//                 icons only, to score with score.ts: popularity moves, so --answer-key drifts.
//
// Icon candidates: the homepage's icons, icon libraries by name, the logos the homepage and README
// show (logos.ts), and the maker's (site.ts). rank.ts orders them.
// GitHub needs a token: GITHUB_TOKEN, or `gh auth token` when the GitHub CLI is signed in.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getCatalog, type Entry } from '../../src/lib/catalog.ts';
import { repoKey } from '../data/repos.ts';
import {
  LIBRARY_LISTS,
  MAX_PAGE_REPOS,
  MAX_SCREENSHOTS,
  ICON_MIN_SIZE,
  ICON_REJECT_BELOW,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MIN_WIDTH,
  homepageIcons,
  libraryIcons,
  nameKeys,
  readLibraries,
  readmeImages,
  repoFromHomepage,
  capBytes,
  hostOf,
  sharedImages,
  type IconCandidate,
  type IconLibraries,
  type ManifestIcon,
  type PageFacts,
} from './extract.ts';
import { SafeFetcher, decodeText, type ImageFormat } from './fetch.ts';
import { fetchDetails, type RepoDetails } from './github.ts';
import { measure } from './images.ts';
import { logoCandidates, type LogoCandidate } from './logos.ts';
import { makerCandidates, readSite } from './site.ts';
import { EXT, failure, pool, safeName } from './util.ts';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    top: { type: 'string' },
    'answer-key': { type: 'string' },
    ids: { type: 'string' },
    'icons-only': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '8' },
  },
});
if (!args.out) {
  console.error(
    'Usage: node scripts/crawl/dry-run.ts --out <dir> [--top N | --answer-key N] [--icons-only]',
  );
  process.exit(2);
}
const OUT = args.out;
const iconsOnly = args['icons-only'] || args['answer-key'] !== undefined || args.ids !== undefined;
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

export interface IconResult extends IconCandidate {
  status: 'ok' | 'rejected';
  reason?: string;
  finalUrl?: string;
  format?: ImageFormat;
  width?: number | null;
  height?: number | null;
  hash?: string | null;
  /** Path under the output folder. */
  file?: string;
}

export interface ShotResult {
  url: string;
  alt: string;
  status: 'ok' | 'rejected';
  reason?: string;
  width?: number | null;
  height?: number | null;
  animated?: boolean;
  file?: string;
}

export interface PackageResult {
  id: string;
  name: string;
  kind: Entry['kind'];
  source: Entry['source'];
  desc: string | null;
  homepage: string | null;
  installs30: number;
  /** The CaskFlow icon the site already shows, if any. */
  caskflowIcon: string | null;
  page: { url: string; title: string | null; description: string | null; textBytes: number } | null;
  pageError: string | null;
  repo: { name: string; via: 'data' | 'homepage' } | null;
  /** Repositories the homepage links to, as asked of GitHub. */
  pageRepos: string[];
  icons: IconResult[];
  screenshots: ShotResult[];
}

// --- Selection ---

const catalog = getCatalog();
const listed = catalog.entries
  .filter((e) => e.listed && !e.font)
  .sort((a, b) => b.popularity.d30 - a.popularity.d30 || a.id.localeCompare(b.id));
const keyIds = args.ids
  ? (JSON.parse(readFileSync(args.ids, 'utf8')) as { id: string }[]).map((k) => k.id)
  : null;
const byId = new Map(catalog.entries.map((e) => [e.id, e]));
const selected = keyIds
  ? keyIds.map((id) => byId.get(id)).filter((e): e is Entry => e !== undefined)
  : args['answer-key']
    ? listed.filter((e) => e.icon === null).slice(0, Number(args['answer-key']))
    : listed.slice(0, Number(args.top ?? 50));
if (keyIds && selected.length < keyIds.length)
  log(`${keyIds.length - selected.length} of the key's packages are no longer in the catalog`);
log(
  `${selected.length} packages, ${iconsOnly ? 'icons only' : 'icons, screenshots and text'} → ${OUT}`,
);

const filesDir = (id: string) => {
  const dir = join(OUT, 'files', safeName(id));
  mkdirSync(dir, { recursive: true });
  return dir;
};

// --- Run ---

const fetcher = new SafeFetcher();
const concurrency = Number(args.concurrency);

async function getJson(url: string): Promise<unknown> {
  const fetched = await fetcher.get(url, 'json', 8_000_000);
  return JSON.parse(decodeText(fetched));
}

log('Reading icon libraries…');
const libraries: IconLibraries = readLibraries({
  devicon: await getJson(LIBRARY_LISTS.devicon),
  dashboard: await getJson(LIBRARY_LISTS.dashboard),
  simple: await getJson(LIBRARY_LISTS.simple),
});
log(
  `devicon ${libraries.devicon.size}, dashboard-icons ${libraries.dashboard.size}, Simple Icons ${libraries.simple.size} names`,
);

// 1. Homepages.
const pages = new Map<string, { facts: PageFacts; url: string } | { error: string }>();
const manifests = new Map<string, ManifestIcon[]>();
/** The logos each homepage shows, read while its HTML is at hand. */
const pageLogos = new Map<string, LogoCandidate[]>();
let done = 0;
await pool(selected, concurrency, async (entry) => {
  if (entry.homepage) {
    try {
      const site = await readSite(fetcher, entry.homepage);
      pages.set(entry.id, { facts: site.facts, url: site.url });
      manifests.set(entry.id, site.manifest);
      pageLogos.set(entry.id, logoCandidates(site, null));
    } catch (error) {
      pages.set(entry.id, { error: failure(error) });
    }
  }
  if (++done % 25 === 0) log(`homepages ${done}/${selected.length}`);
});

// 2. GitHub: the repository the data already found, or candidates linked from the homepage.
let token = process.env.GITHUB_TOKEN;
if (!token) {
  try {
    token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    log('No GitHub token: no repositories, avatars or READMEs');
  }
}
const pageRepoKeys = (e: Entry) => {
  const page = pages.get(e.id);
  return page && 'facts' in page ? page.facts.repoKeys.slice(0, MAX_PAGE_REPOS) : [];
};
const keys = new Set<string>();
for (const e of selected) {
  const known = repoKey(e.repo?.url);
  if (known) keys.add(known);
  else for (const key of pageRepoKeys(e)) keys.add(key);
}
const details = token
  ? await fetchDetails([...keys], token, log)
  : new Map<string, RepoDetails | null>();
log(`GitHub: ${details.size} of ${keys.size} repositories answered`);

// 3. Candidates, fetched and measured.
const results: PackageResult[] = [];
done = 0;
await pool(selected, concurrency, async (entry) => {
  const page = pages.get(entry.id);
  const facts = page && 'facts' in page ? page.facts : null;
  const knownKey = repoKey(entry.repo?.url);
  let repo: PackageResult['repo'] = entry.repo ? { name: entry.repo.name, via: 'data' } : null;
  if (!repo) {
    const linked = repoFromHomepage(entry.homepage, pageRepoKeys(entry), details);
    if (linked) repo = { name: linked, via: 'homepage' };
  }
  const repoInfo =
    repo?.via === 'data'
      ? (details.get(knownKey ?? '') ?? null)
      : (pageRepoKeys(entry)
          .map((k) => details.get(k))
          .find((d) => d && d.nameWithOwner === repo?.name) ?? null);

  const candidates: LogoCandidate[] = [
    ...homepageIcons(entry.homepage, facts, manifests.get(entry.id) ?? []),
    ...libraryIcons(nameKeys(entry.token, entry.name), libraries, repoInfo?.owner ?? null),
    ...(pageLogos.get(entry.id) ?? []),
    ...logoCandidates(
      null,
      repo && repoInfo?.readme ? { markdown: repoInfo.readme, repo: repo.name } : null,
    ),
    ...(await makerCandidates(fetcher, entry.homepage, repoInfo?.owner ?? null)),
  ];
  const dir = filesDir(entry.id);
  const icons: IconResult[] = [];
  const seenHashes = new Set<string>();
  for (const [i, { svg, ...candidate }] of candidates.entries()) {
    if (icons.some((r) => r.url === candidate.url)) continue;
    const result: IconResult = { ...candidate, status: 'rejected' };
    icons.push(result);
    try {
      const image = svg
        ? { url: candidate.url, body: Buffer.from(svg), format: 'svg' as const }
        : await fetcher.get(candidate.url, 'image');
      const { width, height, hash } = await measure(image.body, image.format!);
      const size = { width, height, hash };
      Object.assign(result, { finalUrl: image.url, format: image.format, ...size });
      const smallest = Math.min(size.width ?? Infinity, size.height ?? Infinity);
      const homepageOwn = [
        'apple-touch-icon',
        'manifest',
        'page-icon',
        'touch-icon-default',
      ].includes(candidate.source);
      if (image.format === 'ico') result.reason = 'ICO (nothing can re-encode it)';
      else if (
        image.format !== 'svg' &&
        (smallest < ICON_REJECT_BELOW || (homepageOwn && smallest < ICON_MIN_SIZE))
      ) {
        result.reason = `too small (${size.width}×${size.height})`;
      } else if (size.hash && seenHashes.has(size.hash))
        result.reason = 'same image as an earlier candidate';
      else result.status = 'ok';
      if (size.hash) seenHashes.add(size.hash);
      const file = join(dir, `icon-${i}.${EXT[image.format!]}`);
      writeFileSync(file, image.body);
      result.file = file.slice(OUT.length + 1);
    } catch (error) {
      result.reason = failure(error);
    }
  }

  const screenshots: ShotResult[] = [];
  if (!iconsOnly && repo && repoInfo?.readme) {
    let kept = 0;
    for (const [i, image] of readmeImages(repoInfo.readme, repo.name).slice(0, 12).entries()) {
      if (kept >= MAX_SCREENSHOTS) break;
      const result: ShotResult = { url: image.url, alt: image.alt, status: 'rejected' };
      screenshots.push(result);
      try {
        const fetched = await fetcher.get(image.url, 'image', SCREENSHOT_MAX_BYTES);
        if (fetched.format === 'svg' || fetched.format === 'ico') {
          result.reason = `${fetched.format}, not a screenshot`;
          continue;
        }
        const size = await measure(fetched.body, fetched.format!);
        Object.assign(result, { width: size.width, height: size.height, animated: size.animated });
        if ((size.width ?? 0) < SCREENSHOT_MIN_WIDTH) {
          result.reason = `narrower than ${SCREENSHOT_MIN_WIDTH}px (${size.width})`;
          continue;
        }
        const file = join(dir, `shot-${i}.${EXT[fetched.format!]}`);
        writeFileSync(file, fetched.body);
        result.file = file.slice(OUT.length + 1);
        result.status = 'ok';
        kept++;
      } catch (error) {
        result.reason = failure(error);
      }
    }
  }
  if (!iconsOnly) {
    if (facts) writeFileSync(join(dir, 'homepage.txt'), facts.text);
    if (repoInfo?.readme) writeFileSync(join(dir, 'readme.md'), capBytes(repoInfo.readme));
  }

  results.push({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    source: entry.source,
    desc: entry.desc,
    homepage: entry.homepage,
    installs30: entry.popularity.d30,
    caskflowIcon: entry.icon,
    page:
      facts && page && 'url' in page
        ? {
            url: page.url,
            title: facts.title,
            description: facts.description,
            textBytes: Buffer.byteLength(facts.text),
          }
        : null,
    pageError: page && 'error' in page ? page.error : null,
    repo,
    pageRepos: knownKey ? [] : pageRepoKeys(entry),
    icons,
    screenshots,
  });
  if (++done % 25 === 0) log(`candidates ${done}/${selected.length}`);
});

// 4. Pictures several packages share are a host's or vendor's default, not the app's.
const hashed = results.flatMap((r) =>
  r.icons
    .filter((i) => i.status === 'ok' && i.hash)
    .map((i) => ({
      packageId: r.id,
      project: r.repo?.name.toLowerCase() ?? hostOf(r.homepage),
      url: i.url,
      hash: i.hash!,
    })),
);
const shared = sharedImages(hashed);
for (const r of results) {
  for (const icon of r.icons) {
    const others = shared.get(`${r.id} ${icon.url}`);
    // Library icons are picked by exact name, so two packages of one project may share them, and
    // a maker's logo is shared by its tools.
    if (
      others &&
      icon.status === 'ok' &&
      !['devicon', 'dashboard-icons', 'simple-icons', 'org-avatar', 'maker-site'].includes(
        icon.source,
      )
    ) {
      icon.status = 'rejected';
      icon.reason = `looks like ${others.slice(0, 3).join(', ')}'s${others.length > 3 ? ` (+${others.length - 3})` : ''}`;
    }
  }
}

const order = new Map(selected.map((e, i) => [e.id, i]));
results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
writeFileSync(
  join(OUT, 'results.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), iconsOnly, packages: results }, null, 1)}\n`,
);

const count = (f: (r: PackageResult) => boolean) => results.filter(f).length;
log(`Done. Homepages read: ${count((r) => r.page !== null)}/${results.length}`);
log(
  `Repositories: ${count((r) => r.repo?.via === 'data')} from the data, ${count((r) => r.repo?.via === 'homepage')} new from homepages`,
);
log(
  `At least one icon candidate: ${count((r) => r.icons.some((i) => i.status === 'ok'))}/${results.length}`,
);
if (!iconsOnly)
  log(
    `At least one screenshot: ${count((r) => r.screenshots.some((s) => s.status === 'ok'))}/${results.length}`,
  );
