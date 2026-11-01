// Deterministic extraction (M5 C5): what a package's homepage and README say about it, read
// without any AI. Pure functions over text the fetcher brought back; the I/O is in dry-run.ts.
//
// - The homepage gives its title, description, visible text (for the summary step), icon links,
//   its web manifest, and links to GitHub repositories.
// - A GitHub repository linked from the homepage counts as the package's own only when the
//   repository's homepage points back at the package's homepage domain.
// - Icon candidates come in a fixed order of trust: the homepage's own icons, then devicon and
//   dashboard-icons by exact name, the GitHub organisation's avatar when the organisation is the
//   project, and Simple Icons' glyph last.
// - README images are screenshot candidates once badges, SVGs and the like are dropped.

import { ELEMENT_NODE, TEXT_NODE, parse, walkSync, type ElementNode } from 'ultrahtml';
import { repoKey } from '../data/repos.ts';

/** Most text kept per source, in bytes (the plan's cache limit). */
export const TEXT_MAX_BYTES = 20_000;
/** Icons smaller than this are refused outright; homepage icons need ICON_MIN_SIZE. */
export const ICON_REJECT_BELOW = 64;
export const ICON_MIN_SIZE = 128;
/** Screenshots narrower than this are refused. */
export const SCREENSHOT_MIN_WIDTH = 400;
export const MAX_SCREENSHOTS = 6;
/**
 * Download cap for a README image. Larger than the fetcher's 2 MB: animated terminal demos often
 * are, and every screenshot is re-encoded to a WebP of 1600px at most before it's stored.
 */
export const SCREENSHOT_MAX_BYTES = 8_000_000;
/** Repositories linked from a homepage that are worth asking GitHub about. */
export const MAX_PAGE_REPOS = 5;

// --- HTML ---

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML character references in an attribute or text node. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

export interface IconLink {
  url: string;
  rel: 'apple-touch-icon' | 'icon';
  /** Largest size the page declares (`sizes="180x180"`); Infinity for `any`, null if unsaid. */
  size: number | null;
  /** The declared type, or `image/svg+xml` guessed from a .svg URL. */
  type: string | null;
}

export interface PageFacts {
  /** The page's address (after redirects). */
  url: string;
  title: string | null;
  description: string | null;
  icons: IconLink[];
  manifest: string | null;
  /** Where `<meta http-equiv="refresh">` sends the reader at once (5 s or less), if anywhere. */
  refresh: string | null;
  /** GitHub repositories the page links to, in page order (lowercase `owner/name`). */
  repoKeys: string[];
  /** Visible text, whitespace collapsed, at most TEXT_MAX_BYTES. */
  text: string;
}

/**
 * Elements whose text isn't the page's content. Not `head`: with `<HEAD>` in capitals (nmap.org)
 * the parser nests the whole body inside it.
 */
const SKIP_TEXT = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'footer',
  'title',
  'iframe',
]);

const absolute = (href: string | undefined, base: string): string | null => {
  if (!href) return null;
  try {
    const url = new URL(decodeEntities(href.trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

/** `180x180 32x32` → 180; `any` → Infinity. */
export function largestSize(sizes: string | undefined): number | null {
  if (!sizes) return null;
  if (/\bany\b/i.test(sizes)) return Infinity;
  const found = [...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map((m) =>
    Math.min(Number(m[1]), Number(m[2])),
  );
  return found.length ? Math.max(...found) : null;
}

/** Cut text to at most `max` UTF-8 bytes, on a word boundary when there's one nearby. */
export function capBytes(text: string, max = TEXT_MAX_BYTES): string {
  if (Buffer.byteLength(text) <= max) return text;
  let cut = Buffer.from(text).subarray(0, max).toString('utf8').replace(/�$/, '');
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.9) cut = cut.slice(0, space);
  return cut;
}

export function readPage(html: string, pageUrl: string): PageFacts {
  const doc = parse(html);
  let base = pageUrl;
  let title: string | null = null;
  let description: string | null = null;
  let manifest: string | null = null;
  let refresh: string | null = null;
  const icons: IconLink[] = [];
  const repoKeys: string[] = [];
  const text: string[] = [];

  const inside = (node: { parent?: unknown }, names: Set<string>): boolean => {
    for (
      let p = node.parent as ElementNode | undefined;
      p;
      p = p.parent as ElementNode | undefined
    ) {
      if (p.type === ELEMENT_NODE && names.has(p.name.toLowerCase())) return true;
    }
    return false;
  };

  walkSync(doc, (node) => {
    if (node.type === TEXT_NODE) {
      if (!inside(node, SKIP_TEXT)) text.push(decodeEntities(node.value));
      return;
    }
    if (node.type !== ELEMENT_NODE) return;
    const name = node.name.toLowerCase();
    const attrs = node.attributes ?? {};
    if (name === 'base' && attrs.href && base === pageUrl) {
      base = absolute(attrs.href, pageUrl) ?? pageUrl;
    } else if (name === 'title' && title === null) {
      const value = node.children
        .filter((c) => c.type === TEXT_NODE)
        .map((c) => (c as { value: string }).value)
        .join('');
      title = decodeEntities(value).replace(/\s+/g, ' ').trim() || null;
    } else if (name === 'meta') {
      if ((attrs['http-equiv'] ?? '').toLowerCase() === 'refresh' && refresh === null) {
        const m = /^\s*(\d+)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)/i.exec(
          decodeEntities(attrs.content ?? ''),
        );
        if (m && Number(m[1]) <= 5) refresh = absolute(m[2], base);
      }
      const key = (attrs.name ?? attrs.property ?? '').toLowerCase();
      if (
        (key === 'description' || key === 'og:description') &&
        attrs.content &&
        description === null
      ) {
        description = decodeEntities(attrs.content).replace(/\s+/g, ' ').trim() || null;
      }
    } else if (name === 'link') {
      const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/);
      const url = absolute(attrs.href, base);
      if (!url) return;
      if (rels.includes('manifest')) manifest ??= url;
      const rel = rels.some((r) => r.startsWith('apple-touch-icon'))
        ? 'apple-touch-icon'
        : rels.includes('icon')
          ? 'icon'
          : null;
      if (rel) {
        const type =
          attrs.type?.toLowerCase() ?? (/\.svg(?:$|[?#])/i.test(url) ? 'image/svg+xml' : null);
        icons.push({ url, rel, size: largestSize(attrs.sizes), type });
      }
    } else if (name === 'a') {
      const key = repoKey(absolute(attrs.href, base));
      if (key && !repoKeys.includes(key)) repoKeys.push(key);
    }
  });

  return {
    url: pageUrl,
    title,
    description,
    icons,
    manifest,
    refresh,
    repoKeys,
    text: capBytes(text.join(' ').replace(/\s+/g, ' ').trim()),
  };
}

// --- Web manifest ---

export interface ManifestIcon {
  url: string;
  size: number | null;
  type: string | null;
}

/** Icons a web manifest lists for ordinary use (not monochrome or maskable only). */
export function manifestIcons(json: unknown, manifestUrl: string): ManifestIcon[] {
  if (typeof json !== 'object' || json === null) return [];
  const icons = (json as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) return [];
  const out: ManifestIcon[] = [];
  for (const icon of icons.slice(0, 50)) {
    if (typeof icon !== 'object' || icon === null) continue;
    const { src, sizes, type, purpose } = icon as Record<string, unknown>;
    if (typeof src !== 'string') continue;
    const purposes = typeof purpose === 'string' ? purpose.toLowerCase().split(/\s+/) : ['any'];
    if (!purposes.includes('any')) continue;
    const url = absolute(src, manifestUrl);
    if (!url) continue;
    out.push({
      url,
      size: largestSize(typeof sizes === 'string' ? sizes : undefined),
      type: typeof type === 'string' ? type.toLowerCase() : null,
    });
  }
  return out;
}

// --- Repositories ---

export const hostOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Homepages that belong to a code or package host, not to the project: their icon is the host's. */
const SHARED_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'sourceforge.net',
  'sr.ht',
  'git.sr.ht',
  'gnu.org',
  'savannah.gnu.org',
  'savannah.nongnu.org',
  'launchpad.net',
  'pypi.org',
  'npmjs.com',
  'crates.io',
  'rubygems.org',
  'metacpan.org',
  'hackage.haskell.org',
  'pkg.go.dev',
  'formulae.brew.sh',
  'apps.apple.com',
]);

export const isSharedHost = (host: string | null): boolean =>
  host !== null &&
  (SHARED_HOSTS.has(host) || host.endsWith('.sourceforge.net') || host.endsWith('.sourceforge.io'));

/**
 * Whether a repository's homepage points back at the package's homepage: the same host, or one
 * inside the other (`docs.example.com` and `example.com`). Code and package hosts never count.
 */
export function pointsBack(repoHomepage: string | null, packageHomepage: string | null): boolean {
  const theirs = hostOf(repoHomepage);
  const ours = hostOf(packageHomepage);
  if (!theirs || !ours || isSharedHost(ours) || isSharedHost(theirs)) return false;
  return theirs === ours || theirs.endsWith(`.${ours}`) || ours.endsWith(`.${theirs}`);
}

export interface LinkedRepo {
  nameWithOwner: string;
  isFork: boolean;
  homepageUrl: string | null;
}

/** The first repository the homepage links to whose own homepage points back, if any. */
export function repoFromHomepage(
  homepage: string | null,
  keys: readonly string[],
  lookup: ReadonlyMap<string, LinkedRepo | null>,
): string | null {
  for (const key of keys.slice(0, MAX_PAGE_REPOS)) {
    const info = lookup.get(key);
    if (info && !info.isFork && pointsBack(info.homepageUrl, homepage)) return info.nameWithOwner;
  }
  return null;
}

// --- Icon candidates ---

export type IconSource =
  | 'apple-touch-icon'
  | 'manifest'
  | 'svg-icon'
  | 'page-icon'
  | 'touch-icon-default'
  | 'devicon'
  | 'dashboard-icons'
  | 'github-avatar'
  | 'simple-icons'
  // find-logos.ts, for the packages whose icon none of the above has:
  | 'page-logo'
  | 'page-svg'
  | 'readme-logo'
  | 'org-avatar'
  | 'maker-site'
  // and images a search agent found on the web (find-logos.ts --suggested):
  | 'web-search';

export interface IconCandidate {
  source: IconSource;
  url: string;
  /** Size the source declares, when it does. */
  declared: number | null;
}

/** Names a package goes by, squashed for exact matching (`Visual Studio Code` → visualstudiocode). */
export function nameKeys(token: string, name: string): string[] {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = token.replace(/@.*$/, '');
  return [
    ...new Set(
      [base, base.replace(/-(app|desktop|cli)$/, ''), name].map(squash).filter((k) => k.length > 1),
    ),
  ];
}

/** The homepage's own icons, best first. Code-host homepages have none of their own. */
export function homepageIcons(
  homepage: string | null,
  page: PageFacts | null,
  manifest: ManifestIcon[],
): IconCandidate[] {
  if (!homepage || isSharedHost(hostOf(homepage)) || !page) return [];
  const big = (size: number | null) => size === null || size >= ICON_MIN_SIZE;
  const bySize = <T extends { size: number | null }>(a: T, b: T) => (b.size ?? 0) - (a.size ?? 0);
  const out: IconCandidate[] = [];
  const touch = page.icons.filter((i) => i.rel === 'apple-touch-icon').sort(bySize);
  for (const icon of touch)
    out.push({ source: 'apple-touch-icon', url: icon.url, declared: icon.size });
  for (const icon of manifest.filter((i) => big(i.size) && i.size !== null).sort(bySize)) {
    out.push({
      source: 'manifest',
      url: icon.url,
      declared: icon.size === Infinity ? null : icon.size,
    });
  }
  for (const icon of page.icons.filter((i) => i.rel === 'icon')) {
    if (icon.type === 'image/svg+xml')
      out.push({ source: 'svg-icon', url: icon.url, declared: null });
    else if (icon.size !== null && icon.size >= ICON_MIN_SIZE) {
      out.push({ source: 'page-icon', url: icon.url, declared: icon.size });
    }
  }
  // Many sites serve one without declaring it.
  if (touch.length === 0) {
    out.push({
      source: 'touch-icon-default',
      url: `${new URL(page.url).origin}/apple-touch-icon.png`,
      declared: null,
    });
  }
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.url) && seen.add(c.url));
}

/** Icon libraries, by the squashed names they file icons under. */
export interface IconLibraries {
  /** devicon name → its colour SVG URL. */
  devicon: Map<string, string>;
  /** dashboard-icons name → URL. */
  dashboard: Map<string, string>;
  /** Simple Icons slug or title → URL. */
  simple: Map<string, string>;
}

const DEVICON = 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.18.0';
const DASHBOARD =
  'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@83f32e08257b66fbd971ac8d7645f5b38d52e85d';
const SIMPLE = 'https://cdn.jsdelivr.net/npm/simple-icons@16.36.0';
export const LIBRARY_LISTS = {
  devicon: `${DEVICON}/devicon.json`,
  dashboard: `${DASHBOARD}/tree.json`,
  simple: `${SIMPLE}/data/simple-icons.json`,
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function readLibraries(lists: {
  devicon: unknown;
  dashboard: unknown;
  simple: unknown;
}): IconLibraries {
  const devicon = new Map<string, string>();
  for (const item of Array.isArray(lists.devicon) ? lists.devicon : []) {
    const { name, altnames, versions } = item as {
      name?: unknown;
      altnames?: unknown;
      versions?: { svg?: unknown };
    };
    if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) continue;
    const svg = Array.isArray(versions?.svg) ? (versions.svg as string[]) : [];
    const variant = ['original', 'plain'].find((v) => svg.includes(v));
    if (!variant) continue;
    const url = `${DEVICON}/icons/${name}/${name}-${variant}.svg`;
    for (const key of [name, ...(Array.isArray(altnames) ? altnames : [])]) {
      if (typeof key === 'string' && !devicon.has(squash(key))) devicon.set(squash(key), url);
    }
  }
  const dashboard = new Map<string, string>();
  const tree = (lists.dashboard ?? {}) as { svg?: unknown; png?: unknown };
  for (const [folder, files] of [
    ['svg', tree.svg],
    ['png', tree.png],
  ] as const) {
    for (const file of Array.isArray(files) ? files : []) {
      const match = typeof file === 'string' ? /^([a-z0-9-]+)\.(svg|png)$/.exec(file) : null;
      // Light and dark variants are left for the base name.
      if (!match || /-(light|dark)$/.test(match[1])) continue;
      if (!dashboard.has(squash(match[1])))
        dashboard.set(squash(match[1]), `${DASHBOARD}/${folder}/${file}`);
    }
  }
  const simple = new Map<string, string>();
  for (const item of Array.isArray(lists.simple) ? lists.simple : []) {
    const { title, slug } = item as { title?: unknown; slug?: unknown };
    if (typeof title !== 'string') continue;
    const name = typeof slug === 'string' ? slug : squash(title);
    if (!/^[a-z0-9_]+$/.test(name)) continue;
    const url = `${SIMPLE}/icons/${name}.svg`;
    for (const key of [name, title]) if (!simple.has(squash(key))) simple.set(squash(key), url);
  }
  return { devicon, dashboard, simple };
}

export interface RepoOwner {
  login: string;
  isOrganization: boolean;
  avatarUrl: string | null;
}

/** Library icons by exact name, and the GitHub organisation's avatar when it's named after the project. */
export function libraryIcons(
  keys: readonly string[],
  libraries: IconLibraries,
  owner: RepoOwner | null,
): IconCandidate[] {
  const out: IconCandidate[] = [];
  const first = (map: Map<string, string>) =>
    keys.map((k) => map.get(k)).find((u) => u !== undefined);
  const devicon = first(libraries.devicon);
  if (devicon) out.push({ source: 'devicon', url: devicon, declared: null });
  const dashboard = first(libraries.dashboard);
  if (dashboard) out.push({ source: 'dashboard-icons', url: dashboard, declared: null });
  if (owner?.isOrganization && owner.avatarUrl && keys.includes(squash(owner.login))) {
    out.push({ source: 'github-avatar', url: owner.avatarUrl, declared: null });
  }
  const simple = first(libraries.simple);
  if (simple) out.push({ source: 'simple-icons', url: simple, declared: null });
  return out;
}

// --- README images ---

/** Image hosts and paths that serve badges, charts or buttons, never a screenshot. */
const BADGE_HOSTS = new Set([
  'img.shields.io',
  'shields.io',
  'badgen.net',
  'badge.fury.io',
  'travis-ci.org',
  'travis-ci.com',
  'circleci.com',
  'codecov.io',
  'coveralls.io',
  'app.codacy.com',
  'api.codacy.com',
  'ci.appveyor.com',
  'snyk.io',
  'sonarcloud.io',
  'deepscan.io',
  'gitter.im',
  'discordapp.com',
  'discord.com',
  'opencollective.com',
  'img.buymeacoffee.com',
  'cdn.buymeacoffee.com',
  'ko-fi.com',
  'storage.ko-fi.com',
  'www.paypalobjects.com',
  'api.star-history.com',
  'star-history.com',
  'contrib.rocks',
  'repobeats.axiom.co',
  'readme-typing-svg.demolab.com',
  'github-readme-stats.vercel.app',
  'liberapay.com',
  'api.netlify.com',
  'app.fossa.com',
  'bestpractices.coreinfrastructure.org',
  'www.bestpractices.dev',
  'goreportcard.com',
  'pkg.go.dev',
  'godoc.org',
  'repology.org',
  'snapcraft.io',
  'flathub.org',
  'deps.rs',
  'docs.rs',
  'hits.seeyoufarm.com',
  'visitor-badge.laobi.icu',
  'trendshift.io',
  'api.producthunt.com',
]);

export interface ReadmeImage {
  url: string;
  alt: string;
  /** Width from an `<img width>` attribute, when given. */
  width: number | null;
}

/** github.com blob links to raw files; relative paths against the repository's default branch. */
function readmeUrl(src: string, repo: string): string | null {
  const raw = `https://raw.githubusercontent.com/${repo}/HEAD/`;
  const url = absolute(src, raw);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.hostname === 'github.com') {
    const blob = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(parsed.pathname);
    if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  }
  return parsed.href;
}

/**
 * Not a screenshot by its address or its alt text: badges, avatars, sponsors' and projects' logos.
 * What's left still goes to the screenshot classifier (lazygit's sponsors are named only by brand).
 */
export function isBadge(url: string, alt: string): boolean {
  return (
    isBadgeOrAvatar(url) ||
    new URL(url).pathname.toLowerCase().endsWith('.svg') ||
    /\b(badge|avatar|sponsor(ed)?|logo)\b/i.test(alt)
  );
}

/** A badge, chart or button by its host or path, or a GitHub user's avatar. */
export function isBadgeOrAvatar(url: string): boolean {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();
  return (
    BADGE_HOSTS.has(parsed.hostname) ||
    /\/(actions\/)?workflows\/[^/]+\/badge/.test(path) ||
    /badge/.test(path) ||
    /^avatars\d*\.githubusercontent\.com$/.test(parsed.hostname)
  );
}

/** Every image in a README (Markdown with inline HTML), in document order, each address once. */
export function readmeRefs(markdown: string, repo: string): ReadmeImage[] {
  const found: ReadmeImage[] = [];
  const references = new Map<string, string>();
  for (const m of markdown.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm)) {
    references.set(m[1].toLowerCase(), m[2]);
  }
  const add = (src: string | undefined, alt: string, width: number | null) => {
    if (!src) return;
    const url = readmeUrl(src, repo);
    if (url && !found.some((f) => f.url === url)) found.push({ url, alt, width });
  };
  // Inline images and reference images, and HTML <img> tags, in document order.
  const pattern =
    /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)|!\[([^\]]*)\]\[([^\]]*)\]|<img\b([^>]*)>/gi;
  for (const m of markdown.matchAll(pattern)) {
    if (m[2] !== undefined) add(m[2], m[1], null);
    else if (m[4] !== undefined) add(references.get((m[4] || m[3]).toLowerCase()), m[3], null);
    else {
      const attrs = m[5];
      const attr = (name: string) =>
        new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
          .exec(attrs)
          ?.slice(1)
          .find((v) => v !== undefined);
      const width = Number(attr('width'));
      add(
        attr('src') && decodeEntities(attr('src')!),
        decodeEntities(attr('alt') ?? ''),
        Number.isFinite(width) && width > 0 ? width : null,
      );
    }
  }
  return found;
}

/** Screenshot candidates from a README, badges dropped, in order. */
export function readmeImages(markdown: string, repo: string): ReadmeImage[] {
  // An image the README itself shows small is a logo or an icon.
  return readmeRefs(markdown, repo).filter(
    (f) => !isBadge(f.url, f.alt) && (f.width === null || f.width >= SCREENSHOT_MIN_WIDTH),
  );
}

// --- Image hashes ---

/** Bits that differ between two 64-bit hex hashes. */
export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (x) {
    bits += Number(x & 1n);
    x >>= 1n;
  }
  return bits;
}

/**
 * Packages whose candidate looks like another package's (difference hash within `distance` bits):
 * a host's or vendor's default, not the app's own icon. Packages of one project (the same
 * `project` key: repository or homepage host) may share theirs. Returns the ids sharing each
 * candidate, keyed `${packageId} ${url}`.
 */
export function sharedImages(
  images: readonly { packageId: string; project: string | null; url: string; hash: string }[],
  distance = 4,
): Map<string, string[]> {
  const shared = new Map<string, string[]>();
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const a = images[i];
      const b = images[j];
      if (a.packageId === b.packageId || (a.project !== null && a.project === b.project)) continue;
      if (hamming(a.hash, b.hash) > distance) continue;
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const key = `${x.packageId} ${x.url}`;
        const others = shared.get(key) ?? [];
        if (!others.includes(y.packageId)) others.push(y.packageId);
        shared.set(key, others);
      }
    }
  }
  return shared;
}
