// Placeholder app icons: a gradient tile with initials, as in the designs. Mac apps get one of
// eight gradients picked from their id (stable across builds); command-line tools (formulae and
// command-line casks) get the dark terminal tile with two monospace letters. Official Mac apps
// with a CaskFlow icon (scripts/data/icons.ts) show it instead, over the tile as a fallback.

export const APP_TILES = [
  'blue',
  'orange',
  'green',
  'purple',
  'pink',
  'yellow',
  'teal',
  'slate',
] as const;
export type TileName = (typeof APP_TILES)[number] | 'terminal';

export interface TileLook {
  tile: TileName;
  initials: string;
  mono: boolean;
}

/** FNV-1a: a small, stable string hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Tileable {
  id: string;
  kind: 'formula' | 'cask';
  name: string;
  token: string;
  /** Command-line casks get the terminal tile too. */
  commandLine?: boolean;
  /** The real icon's URL, when there is one (iconUrl). */
  icon?: string | null;
}

/** Where CaskFlow's icons are served, pinned to a commit so the files never change under a URL. */
export const iconBase = (commit: string) =>
  `https://cdn.jsdelivr.net/gh/alielsokary/CaskFlow@${commit}/`;

/**
 * `onerror` for an icon image: drop it and show the tile. An attribute rather than a listener,
 * so it also catches images that fail before any script has run.
 */
export const ICON_FALLBACK = "this.parentNode.classList.remove('has-icon');this.remove()";

export const iconUrl = (base: string, token: string) => `${base}${encodeURIComponent(token)}.png`;

export function tileFor(p: Tileable): TileLook {
  if (p.kind === 'formula' || p.commandLine) {
    const letters = p.token.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return { tile: 'terminal', initials: letters.slice(0, 2) || '?', mono: true };
  }
  const first = p.name.match(/[\p{L}\p{N}]/u)?.[0] ?? p.token[0] ?? '?';
  return {
    tile: APP_TILES[hash(p.id) % APP_TILES.length],
    initials: first.toUpperCase(),
    mono: false,
  };
}
