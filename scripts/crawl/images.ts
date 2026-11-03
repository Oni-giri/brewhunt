// Sizes and look-alike hashes for fetched images. Decoding untrusted files goes through sharp
// (libvips) with a pixel limit, so a small file can't expand into gigabytes. ICO files aren't
// decoded: their directory says how big they are, and nothing downstream can re-encode them.

import sharp, { type Sharp } from 'sharp';
import type { ImageFormat } from './fetch.ts';

/** About 7,000 × 7,000: far past any icon or screenshot. */
const MAX_PIXELS = 50_000_000;
/** The largest of 502 SVG icons in the answer key's run was 520 KB. */
export const MAX_SVG_BYTES = 1_000_000;

/**
 * A reference to anything outside the SVG: an href or src that isn't `#fragment` or `data:`, a
 * CSS `url()` that isn't, or an `@import`. librsvg loads none of these for an image given as
 * bytes, but an SVG logo has no need for them, so it's refused rather than trusted to that.
 */
export function svgExternalReference(svg: string): string | null {
  const attribute = /\b(?:xlink:)?(?:href|src)\s*=\s*(["'])\s*([^"']*)\1/gi;
  for (const [, , value] of svg.matchAll(attribute))
    if (!/^(?:#|data:)/i.test(value)) return value || '(empty)';
  for (const [, value] of svg.matchAll(/url\(\s*["']?([^"')]*)/gi))
    if (!/^(?:#|data:)/i.test(value.trim())) return value;
  if (/@import\b/i.test(svg)) return '@import';
  return null;
}

export interface Measured {
  width: number | null;
  height: number | null;
  /** 64-bit difference hash (hex), for spotting the same picture under different URLs. */
  hash: string | null;
  /** More than one frame (an animated GIF or WebP: a terminal demo, usually). */
  animated: boolean;
}

/** The largest image an ICO's directory lists. */
export function icoSize(body: Buffer): number | null {
  if (body.length < 6) return null;
  const count = body.readUInt16LE(4);
  let best = 0;
  for (let i = 0; i < count && 6 + i * 16 + 16 <= body.length; i++) {
    const width = body[6 + i * 16] || 256;
    best = Math.max(best, width);
  }
  return best || null;
}

/** Difference hash: is each pixel brighter than its right neighbour, on a 9 × 8 greyscale. */
async function dHash(image: Sharp): Promise<string> {
  const pixels = await image
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits = (bits << 1n) | (pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export async function measure(body: Buffer, format: ImageFormat): Promise<Measured> {
  if (format === 'ico') {
    const size = icoSize(body);
    return { width: size, height: size, hash: null, animated: false };
  }
  // An SVG is checked before it's ever decoded. Rendering one can't be stopped midway (sharp's
  // timeout doesn't reach into librsvg), but librsvg refuses past 500,000 referenced elements,
  // which bounds the worst at a few seconds, and it runs off the event loop.
  if (format === 'svg') {
    if (body.length > MAX_SVG_BYTES) throw new Error(`SVG over ${MAX_SVG_BYTES} bytes`);
    const reference = svgExternalReference(body.toString('utf8'));
    if (reference) throw new Error(`the SVG refers to ${reference.slice(0, 80)}`);
  }
  const meta = await sharp(body, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  return {
    width: meta.width ?? null,
    height: meta.height ?? null,
    // The first frame of an animation.
    hash: await dHash(sharp(body, { limitInputPixels: MAX_PIXELS, failOn: 'error' })),
    animated: (meta.pages ?? 1) > 1,
  };
}
