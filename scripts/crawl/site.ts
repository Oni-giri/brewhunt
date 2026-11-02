// Reading sites for icons, shared by dry-run.ts and find-logos.ts. Every request goes through the
// SafeFetcher.

import {
  hostOf,
  manifestIcons,
  readPage,
  siteIcons,
  type IconCandidate,
  type ManifestIcon,
  type PageFacts,
} from './extract.ts';
import { decodeText, type SafeFetcher } from './fetch.ts';
import { makerSite } from './logos.ts';

/** Icons kept from each maker site: its best few are enough. */
export const MAKER_ICONS = 3;

export interface Site {
  /** Where the page ended up, after redirects and one meta refresh. */
  url: string;
  html: string;
  facts: PageFacts;
  manifest: ManifestIcon[];
}

/** A page (following one meta refresh: tmux.github.io → its GitHub wiki) and its manifest's icons. */
export async function readSite(fetcher: SafeFetcher, url: string): Promise<Site> {
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
  return { url: page.url, html, facts, manifest };
}

/**
 * The maker's logo, for when the tool has none of its own (owner's rule, 1 Nov 2026): the GitHub
 * organisation's avatar, and the icons of the maker's site (the homepage's parent domain,
 * cli.github.com → github.com, or the organisation's website).
 */
export async function makerCandidates(
  fetcher: SafeFetcher,
  homepage: string | null,
  owner: { isOrganization: boolean; avatarUrl: string | null; websiteUrl?: string | null } | null,
): Promise<IconCandidate[]> {
  const out: IconCandidate[] = [];
  if (owner?.isOrganization && owner.avatarUrl)
    out.push({ source: 'org-avatar', url: owner.avatarUrl, declared: null });
  const sites = [makerSite(homepage), owner?.websiteUrl ?? null].filter(
    (url): url is string => url !== null && hostOf(url) !== hostOf(homepage),
  );
  for (const url of new Map(sites.map((u) => [hostOf(u), u])).values()) {
    try {
      const site = await readSite(fetcher, url);
      for (const icon of siteIcons(site.facts, site.manifest).slice(0, MAKER_ICONS))
        out.push({ ...icon, source: 'maker-site' });
    } catch {
      // A maker site that can't be read only loses its icons.
    }
  }
  return out;
}
