// Ranks a package's icon candidates and makes the rules' pick (M5 C5), before any model looks.
//
// The order of sources follows the owner's answer key (1 Nov 2026): which source the owner chose
// when several had a usable image. The web app manifest beat the touch icon 13 to 1 and the
// page's own large icon beat it 8 to 1 (the same logo, a bigger or cleaner file); the touch icon
// beat devicon 6 to 2, devicon beat dashboard-icons 10 to 4, and Simple Icons' one-colour glyphs
// lost to nearly everything. It's fitted on those 300 packages, so their score flatters it.
//
// The rules only pick what is plainly the tool's own: the maker's logo (organisation avatar, maker
// site) is right only when the tool has none of its own (owner's rule), and a logo the page or
// README doesn't mark as one may be a menu icon or a screenshot. Those wait for the judge.

import type { IconResult } from './dry-run.ts';
import type { IconSource } from './extract.ts';

export const RULE_ORDER: readonly IconSource[] = [
  'manifest',
  'page-icon',
  'apple-touch-icon',
  'devicon',
  'svg-icon',
  'touch-icon-default',
  'dashboard-icons',
  'github-avatar',
  'page-svg',
  'page-logo',
  'readme-logo',
  'simple-icons',
  'org-avatar',
  'maker-site',
  'web-search',
];

/** Sources whose image may be the maker's, not the tool's: only a judge picks them. */
const MAKER: ReadonlySet<IconSource> = new Set(['org-avatar', 'maker-site', 'web-search']);
/** Sources that need the page or README to call the image a logo before the rules pick it. */
const NEEDS_MARK: ReadonlySet<IconSource> = new Set(['page-svg', 'page-logo', 'readme-logo']);

const rank = (source: IconSource) => {
  const i = RULE_ORDER.indexOf(source);
  return i === -1 ? RULE_ORDER.length : i;
};
const pixels = (icon: IconResult) =>
  icon.format === 'svg' ? Infinity : Math.min(icon.width ?? 0, icon.height ?? 0);

/** The usable candidates, best first: by source, then SVG, then the larger file. */
export function rankIcons(icons: readonly IconResult[]): IconResult[] {
  return icons
    .filter((i) => i.status === 'ok')
    .sort((a, b) => rank(a.source) - rank(b.source) || pixels(b) - pixels(a));
}

/** Whether the rules may pick this candidate on their own. */
export const rulesMayPick = (icon: IconResult): boolean =>
  !MAKER.has(icon.source) && (!NEEDS_MARK.has(icon.source) || icon.marked === true);

/** The rules' pick, in icon-check.ts's shape: the best candidate they may pick, or the tile. */
export function chooseIcon(icons: readonly IconResult[]): { icon: string | null; source: string } {
  const best = rankIcons(icons).find(rulesMayPick);
  return best ? { icon: best.url, source: best.source } : { icon: null, source: 'none' };
}
