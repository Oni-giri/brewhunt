// Icons and screenshots as Brewhunt serves them (M5 C9). A fetched image is untrusted: it's
// decoded with a pixel limit, re-encoded to WebP (which drops its metadata, EXIF and location
// included, and any script an SVG carried), checked for a blank result and stored under a key
// made from the source file's hash, so a key never changes what it points to. Each asset carries
// a record of where it came from and on what basis Brewhunt shows it. content/takedown.yaml
// (takedown.ts) wins over all of this.
//
// Keys: `<kind>s/v1/<sha256 of the source bytes>.webp`. Hashing the source, not the output,
// means a takedown by hash still matches after the encoder changes, and changing how images are
// encoded bumps `v1` rather than changing the bytes behind a live URL.

import { createHash } from 'node:crypto';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import type { ImageFormat } from './fetch.ts';

export const ASSET_VERSION = 'v1';
/** Icons are square, on a transparent background. */
export const ICON_SIZE = 128;
/** Screenshots fit in this box, and are never enlarged. */
export const SHOT_MAX = { width: 1600, height: 2400 };
/**
 * An animated screenshot (a terminal demo) stays animated within these limits and the pixel
 * limit across all its frames; past them, it's shown as a still (`poster`).
 */
export const ANIMATION = { maxFrames: 300, maxBytes: 4_000_000 };
/** About 7,000 × 7,000 (images.ts): for an animation, all its frames together. */
const MAX_PIXELS = 50_000_000;

export type AssetKind = 'icon' | 'screenshot';

export type AssetFailure =
  | 'format' // ICO for anything, SVG for a screenshot
  | 'external' // an SVG that refers to other files or sites
  | 'decode'
  | 'blank'; // one colour, or fully transparent, once encoded

export class AssetError extends Error {
  readonly reason: AssetFailure;
  constructor(reason: AssetFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface Processed {
  kind: AssetKind;
  key: string;
  body: Buffer;
  width: number;
  height: number;
  /** An animated WebP. */
  animated: boolean;
  /** An animation shown as a still, for being too long or too large. */
  poster: boolean;
  /** sha256 of the fetched file, hex. */
  sourceHash: string;
  /** sha256 of the WebP. */
  outputHash: string;
  /** Icons: what the review page should point out (iconFlags). */
  flags: IconFlag[];
}

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');

export const assetKey = (kind: AssetKind, sourceHash: string) =>
  `${kind}s/${ASSET_VERSION}/${sourceHash}.webp`;

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

const open = (body: Buffer, frame: number | 'all' = 0) =>
  sharp(body, {
    limitInputPixels: MAX_PIXELS,
    failOn: 'error',
    ...(frame === 'all' ? { animated: true } : { page: frame }),
  });

async function encode(image: Sharp, kind: AssetKind): Promise<{ data: Buffer; info: OutputInfo }> {
  return image
    .toColourspace('srgb')
    .webp(kind === 'icon' ? { quality: 90, alphaQuality: 100 } : { quality: 82 })
    .toBuffer({ resolveWithObject: true });
}

/**
 * One colour across the whole image, every frame of an animation and transparency included: a
 * failed render or a spacer.
 */
async function blank(body: Buffer, animated: boolean): Promise<boolean> {
  const { channels } = await sharp(body, { animated }).stats();
  return channels.every((c) => c.min === c.max);
}

/**
 * Icons that come out poorly, for the owner's review, not dropped (measured on the answer key's
 * 235 icons): `faint`, under 8% of the square drawn (a logo coloured by its page's CSS, a thin
 * wordmark); `light`, a pale logo on transparency, lost on a light tile; `wordmark`, drawn less
 * than a quarter as tall as the square and over three times as wide as tall.
 */
export type IconFlag = 'faint' | 'light' | 'wordmark';

export async function iconFlags(webp: Buffer): Promise<IconFlag[]> {
  const { data, info } = await sharp(webp)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let drawn = 0;
  let light = 0;
  const rows = new Set<number>();
  const columns = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    drawn++;
    light += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    rows.add(Math.floor(i / 4 / info.width));
    columns.add((i / 4) % info.width);
  }
  const cover = drawn / (info.width * info.height);
  const flags: IconFlag[] = [];
  if (cover < 0.08) flags.push('faint');
  if (cover < 0.5 && drawn > 0 && light / drawn > 0.9) flags.push('light');
  if (rows.size / info.height < 0.25 && columns.size > 3 * rows.size) flags.push('wordmark');
  return flags;
}

function resize(image: Sharp, kind: AssetKind): Sharp {
  return kind === 'icon'
    ? image.resize(ICON_SIZE, ICON_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
    : image.resize(SHOT_MAX.width, SHOT_MAX.height, { fit: 'inside', withoutEnlargement: true });
}

/** Decodes, checks and re-encodes a fetched image. Throws an AssetError when it can't be used. */
export async function processAsset(
  kind: AssetKind,
  body: Buffer,
  format: ImageFormat,
): Promise<Processed> {
  if (format === 'ico') throw new AssetError('format', 'ICO files aren’t re-encoded');
  if (format === 'svg') {
    if (kind === 'screenshot') throw new AssetError('format', 'an SVG isn’t a screenshot');
    const reference = svgExternalReference(body.toString('utf8'));
    if (reference) throw new AssetError('external', `the SVG refers to ${reference.slice(0, 80)}`);
  }

  let out: { data: Buffer; info: OutputInfo } | null = null;
  let animated = false;
  let poster = false;
  try {
    if (kind === 'screenshot' && (format === 'gif' || format === 'webp')) {
      const pages = (await open(body).metadata()).pages ?? 1;
      if (pages > 1) {
        if (pages <= ANIMATION.maxFrames) {
          // Past the pixel limit across all frames, decoding throws.
          const encoded = await encode(resize(open(body, 'all'), kind), kind).catch(() => null);
          if (encoded && encoded.data.length <= ANIMATION.maxBytes) {
            out = encoded;
            animated = true;
          }
        }
        if (!out) {
          // A demo often starts on an empty terminal: the busiest of a few frames, by how
          // much it takes to encode.
          poster = true;
          const frames = [...new Set([0.25, 0.5, 0.75, 1].map((f) => Math.ceil(f * pages) - 1))];
          for (const frame of frames) {
            const encoded = await encode(resize(open(body, frame), kind), kind);
            if (!out || encoded.data.length > out.data.length) out = encoded;
          }
        }
      }
    }
    // An icon from an animation is its first frame.
    out ??= await encode(resize(open(body), kind), kind);
  } catch (error) {
    throw new AssetError('decode', (error as Error).message);
  }

  if (await blank(out.data, animated))
    throw new AssetError('blank', 'the image is a single colour');
  const sourceHash = sha256(body);
  return {
    kind,
    key: assetKey(kind, sourceHash),
    body: out.data,
    width: out.info.width,
    // An animation's height is its frame's.
    height: out.info.pageHeight ?? out.info.height,
    animated,
    poster,
    sourceHash,
    outputHash: sha256(out.data),
    flags: kind === 'icon' ? await iconFlags(out.data) : [],
  };
}

// --- Records ---

/** Why Brewhunt shows the asset: the owner picked it, or the judge or the rules did. */
export type AssetBasis = 'owner' | 'judge' | 'rules' | 'classifier';

export interface AssetRecord {
  key: string;
  kind: AssetKind;
  /** The package it's shown for. */
  package: string;
  sourceUrl: string;
  /**
   * The version of the source it was taken from: a README's blob id for README images, else
   * the time it was fetched.
   */
  sourceRevision: string;
  sourceHash: string;
  outputHash: string;
  width: number;
  height: number;
  animated: boolean;
  /** Icons: what the review page should point out. */
  flags: IconFlag[];
  /**
   * An icon is a logo, shown to identify the project: "trademark: identification use". A README
   * screenshot is under the repository's licence (SPDX id), or null when GitHub names none.
   */
  licence: string | null;
  /** Shown with the asset: screenshots only. */
  credit: string | null;
  basis: AssetBasis;
}

export const ICON_LICENCE = 'trademark: identification use';
export const README_CREDIT = 'Screenshot from the project’s README';

export interface Origin {
  package: string;
  sourceUrl: string;
  sourceRevision: string;
  basis: AssetBasis;
  /** For a README screenshot: the repository's licence. */
  repoLicence?: string | null;
}

export function assetRecord(asset: Processed, origin: Origin): AssetRecord {
  return {
    key: asset.key,
    kind: asset.kind,
    package: origin.package,
    sourceUrl: origin.sourceUrl,
    sourceRevision: origin.sourceRevision,
    sourceHash: asset.sourceHash,
    outputHash: asset.outputHash,
    width: asset.width,
    height: asset.height,
    animated: asset.animated,
    flags: asset.flags,
    licence: asset.kind === 'icon' ? ICON_LICENCE : (origin.repoLicence ?? null),
    credit: asset.kind === 'icon' ? null : README_CREDIT,
    basis: origin.basis,
  };
}

// --- Storage ---

/** Where assets go: R2 in the crawl, a folder for a local run. Keys are immutable. */
export interface AssetStore {
  has(key: string): Promise<boolean>;
  put(key: string, body: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
}
