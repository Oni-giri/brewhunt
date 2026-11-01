// Where to look for a logo when none of the icon candidates (extract.ts) is right, but the owner
// says one exists (the answer key's "findable" packages, owner's rules of 1 Nov 2026):
//
// - The tool's own logo first: an image or inline SVG its homepage marks as the logo, or the
//   logo at the top of its README.
// - When the tool has none of its own, its maker's: the GitHub organisation's avatar, and the
//   icons of the maker's site (the homepage's parent domain, cli.github.com → github.com, or the
//   organisation's website).
//
// Pure functions over fetched text; the I/O is in find-logos.ts.

import { ELEMENT_NODE, parse, renderSync, walkSync, type ElementNode } from 'ultrahtml';
import { decodeEntities, hostOf, isBadgeOrAvatar, isSharedHost, readmeRefs } from './extract.ts';

/** Logos kept per page, and per README. */
export const MAX_PAGE_LOGOS = 6;
export const MAX_README_LOGOS = 3;
/** Inline SVGs bigger than this are illustrations, not logos. */
export const MAX_INLINE_SVG_BYTES = 100_000;

const LOGO = /logo|brand|wordmark|site-?mark/i;
/** Sections of other people's logos: customers, sponsors, integrations. */
const OTHERS = /partner|customer|client|sponsor|trusted|integration|companies|backer|used-?by/i;

export interface PageLogo {
  /** The image's address; for an inline SVG, the page's address with `#svg-n`. */
  url: string;
  /** An inline SVG's markup. */
  svg?: string;
  /** Marked as a logo (by its address, alt text, class or id), not only placed in the header. */
  marked: boolean;
}

const absolute = (href: string | undefined, base: string): string | null => {
  if (!href) return null;
  try {
    const url = new URL(decodeEntities(href.trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

/** What an element and its nearest ancestors say about it: class, id, labels. */
function hints(node: ElementNode, depth = 3): string {
  const out: string[] = [];
  let at: ElementNode | undefined = node;
  for (let i = 0; at && i <= depth; i++, at = at.parent as ElementNode | undefined) {
    if (at.type !== ELEMENT_NODE) break;
    const a = at.attributes ?? {};
    out.push(a.class ?? '', a.id ?? '', a['aria-label'] ?? '', a.title ?? '');
  }
  return out.join(' ');
}

/** Inside the page's header or navigation, or a link to the home page. */
function inHeader(node: ElementNode, pageUrl: string): boolean {
  const home = new URL('/', pageUrl).href;
  for (let at = node.parent as ElementNode | undefined; at; at = at.parent as ElementNode) {
    if (at.type !== ELEMENT_NODE) return false;
    if (at.name === 'header' || at.name === 'nav') return true;
    if (at.name === 'a' && at.attributes?.href !== undefined) {
      const href = absolute(at.attributes.href || '/', pageUrl);
      if (href === home) return true;
    }
  }
  return false;
}

/** Images and inline SVGs a homepage shows as its logo, marked ones first, in page order. */
export function pageLogos(html: string, pageUrl: string): PageLogo[] {
  const marked: PageLogo[] = [];
  const placed: PageLogo[] = [];
  let svgs = 0;
  walkSync(parse(html), (node) => {
    if (node.type !== ELEMENT_NODE) return;
    const el = node as ElementNode;
    if (el.name !== 'img' && el.name !== 'svg') return;
    const around = hints(el);
    if (OTHERS.test(around)) return;
    if (el.name === 'img') {
      const a = el.attributes ?? {};
      const src = absolute(a.src || a['data-src'] || a.srcset?.split(/\s+/)[0], pageUrl);
      if (!src || src.startsWith('data:')) return;
      const isMarked = LOGO.test(`${new URL(src).pathname} ${a.alt ?? ''} ${around}`);
      if (isMarked) marked.push({ url: src, marked: true });
      else if (inHeader(el, pageUrl)) placed.push({ url: src, marked: false });
      return;
    }
    // An SVG inside another one is part of it.
    for (let at = el.parent as ElementNode | undefined; at; at = at.parent as ElementNode) {
      if (at.type === ELEMENT_NODE && at.name === 'svg') return;
    }
    const isMarked = LOGO.test(around);
    if (!isMarked && !inHeader(el, pageUrl)) return;
    let svg = renderSync(el);
    if (Buffer.byteLength(svg) > MAX_INLINE_SVG_BYTES) return;
    if (!/\sxmlns=/.test(svg.slice(0, svg.indexOf('>'))))
      svg = svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const logo = { url: `${pageUrl.replace(/#.*$/, '')}#svg-${++svgs}`, svg, marked: isMarked };
    (isMarked ? marked : placed).push(logo);
  });
  const seen = new Set<string>();
  return [...marked, ...placed]
    .filter((l) => !seen.has(l.url) && seen.add(l.url))
    .slice(0, MAX_PAGE_LOGOS);
}

/**
 * The logo at the top of a README: images whose address or alt text says logo or icon, and the
 * first image when it isn't a badge (projects often open with their logo).
 */
export function readmeLogos(markdown: string, repo: string): string[] {
  const images = readmeRefs(markdown, repo).filter(
    (i) => !isBadgeOrAvatar(i.url) && !OTHERS.test(i.alt) && !OTHERS.test(i.url),
  );
  const out = images.filter((i) => /logo|icon|brand/i.test(`${new URL(i.url).pathname} ${i.alt}`));
  if (images[0] && !out.includes(images[0])) out.push(images[0]);
  return out.slice(0, MAX_README_LOGOS).map((i) => i.url);
}

/** Hosting platforms: a subdomain of one belongs to its user, not to the platform. */
const PLATFORMS = new Set([
  'github.io',
  'gitlab.io',
  'readthedocs.io',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'fly.dev',
  'surge.sh',
]);

/** Second-level labels under which a domain takes three labels (example.co.uk). */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

/**
 * The maker's site for a homepage on a subdomain (cli.github.com → https://github.com/), or null
 * when the homepage already is one, or it's on a code or package host.
 */
export function makerSite(homepage: string | null): string | null {
  const host = hostOf(homepage);
  if (!host || isSharedHost(host) || /^[\d.]+$/.test(host) || host.includes(':')) return null;
  const labels = host.split('.');
  const take =
    labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  const root = labels.slice(-take).join('.');
  // A code host's own subdomains are its own (cli.github.com); its users' pages are on PLATFORMS.
  if (root === host || PLATFORMS.has(root)) return null;
  return `https://${root}/`;
}

/** github.com's /raw/ and /blob/ links, which its robots.txt disallows, as raw.githubusercontent.com's. */
export function rawGitHub(url: string): string {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(?:refs\/heads\/)?([^?#]+?)(?:\?raw=true)?$/,
  );
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}
