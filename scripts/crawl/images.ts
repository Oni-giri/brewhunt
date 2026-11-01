// Sizes and look-alike hashes for fetched images. Decoding untrusted files goes through sharp
// (libvips) with a pixel limit, so a small file can't expand into gigabytes. ICO files aren't
// decoded: their directory says how big they are, and nothing downstream can re-encode them.

import sharp, { type Sharp } from 'sharp';
import type { ImageFormat } from './fetch.ts';

/** About 7,000 × 7,000: far past any icon or screenshot. */
const MAX_PIXELS = 50_000_000;

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
  const meta = await sharp(body, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  return {
    width: meta.width ?? null,
    height: meta.height ?? null,
    // The first frame of an animation.
    hash: await dHash(sharp(body, { limitInputPixels: MAX_PIXELS, failOn: 'error' })),
    animated: (meta.pages ?? 1) > 1,
  };
}
