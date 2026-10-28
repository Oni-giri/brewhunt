// Placeholder app icons: a gradient tile with initials, as in the designs. Mac apps get one of
// eight gradients picked from their id (stable across builds); command-line tools get the dark
// terminal tile with two monospace letters.

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

export function tileFor(p: {
  id: string;
  kind: 'formula' | 'cask';
  name: string;
  token: string;
}): TileLook {
  if (p.kind === 'formula') {
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
