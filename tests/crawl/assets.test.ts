import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ANIMATION,
  AssetError,
  assetRecord,
  ICON_LICENCE,
  processAsset,
  README_CREDIT,
  svgExternalReference,
  type AssetRecord,
} from '../../scripts/crawl/assets.ts';
import { applyTakedowns, readTakedowns } from '../../scripts/crawl/takedown.ts';

const png = (width: number, height: number, background = '#3366ff') =>
  sharp({ create: { width, height, channels: 4, background } })
    .png()
    .toBuffer();

/** A square with a dot, so it isn't one colour. */
const icon = (size: number) =>
  sharp({ create: { width: size, height: size, channels: 4, background: '#3366ff' } })
    .composite([{ input: Buffer.from(dotSvg(size)), top: 0, left: 0 }])
    .png();

const dotSvg = (size: number, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${extra}<circle cx="${size / 2}" cy="${size / 2}" r="${size / 4}" fill="#ff0000"/></svg>`;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof AssetError ? error.reason : String(error)),
  );

/** Frames of `size`, alternating colours, as an animated GIF. */
async function gif(frames: number, size = 400): Promise<Buffer> {
  const colours = ['#ff0000', '#00ff00'];
  const pages = await Promise.all(
    Array.from({ length: frames }, (_, i) => png(size, size, colours[i % 2])),
  );
  return sharp(pages, { join: { animated: true } })
    .gif()
    .toBuffer();
}

describe('processAsset', () => {
  it('makes a 128px WebP icon without the source’s metadata, keyed by the source’s hash', async () => {
    const source = await icon(512)
      .withExif({ IFD0: { Copyright: 'someone', Artist: 'someone' } })
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const asset = await processAsset('icon', source, 'png');
    const meta = await sharp(asset.body).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 128, height: 128 });
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(asset.key).toBe(`icons/v1/${asset.sourceHash}.webp`);
    expect(asset.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(asset.outputHash).not.toBe(asset.sourceHash);
  });

  it('pads a wide icon to a square on transparency', async () => {
    const source = await sharp(await icon(100).toBuffer())
      .resize(400, 100, { fit: 'fill' })
      .png()
      .toBuffer();
    const asset = await processAsset('icon', source, 'png');
    const { data } = await sharp(asset.body).raw().toBuffer({ resolveWithObject: true });
    expect([asset.width, asset.height]).toEqual([128, 128]);
    // The top-left corner is padding.
    expect(data[3]).toBe(0);
  });

  it('renders an SVG icon at full size, and refuses one that refers to other files', async () => {
    const asset = await processAsset('icon', Buffer.from(dotSvg(24)), 'svg');
    const { data } = await sharp(asset.body).raw().toBuffer({ resolveWithObject: true });
    // Rendered at 128px, not a 24px image scaled up: few soft edge pixels.
    let soft = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) soft++;
    expect(soft).toBeLessThan(400);
    expect(
      await failure(
        processAsset(
          'icon',
          Buffer.from(dotSvg(24, '<image href="file:///etc/passwd" width="1" height="1"/>')),
          'svg',
        ),
      ),
    ).toBe('external');
  });

  it('refuses ICO files, SVG screenshots, blank images and broken files', async () => {
    expect(await failure(processAsset('icon', Buffer.from([0, 0, 1, 0]), 'ico'))).toBe('format');
    expect(await failure(processAsset('screenshot', Buffer.from(dotSvg(500)), 'svg'))).toBe(
      'format',
    );
    expect(await failure(processAsset('icon', await png(64, 64, '#00000000'), 'png'))).toBe(
      'blank',
    );
    expect(await failure(processAsset('icon', await png(64, 64, '#ffffff'), 'png'))).toBe('blank');
    expect(await failure(processAsset('icon', Buffer.from('not a png'), 'png'))).toBe('decode');
  });

  it('fits screenshots in 1600px wide without enlarging small ones', async () => {
    const big = await processAsset(
      'screenshot',
      await sharp(await icon(1000).toBuffer())
        .resize(3200, 1000, { fit: 'fill' })
        .png()
        .toBuffer(),
      'png',
    );
    expect([big.width, big.height]).toEqual([1600, 500]);
    expect(big.key).toMatch(/^screenshots\/v1\//);
    const small = await processAsset('screenshot', await icon(600).toBuffer(), 'png');
    expect([small.width, small.height]).toEqual([600, 600]);
  });

  it('keeps a short animation animated, and shows a long one as a still', async () => {
    const short = await processAsset('screenshot', await gif(3), 'gif');
    expect(short).toMatchObject({ animated: true, poster: false, width: 400, height: 400 });
    expect((await sharp(short.body).metadata()).pages).toBe(3);

    const long = await processAsset('screenshot', await gif(ANIMATION.maxFrames + 1, 16), 'gif');
    expect(long).toMatchObject({ animated: false, poster: true });
    expect((await sharp(long.body).metadata()).pages ?? 1).toBe(1);
  });
});

describe('iconFlags', () => {
  const svg = (body: string, width = 100, height = 100) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`,
    );
  it('points out faint, light and wordmark icons, and not a plain one', async () => {
    const flags = async (source: Buffer) => (await processAsset('icon', source, 'svg')).flags;
    expect(await flags(svg('<rect width="100" height="100" rx="20" fill="#3366ff"/>'))).toEqual([]);
    // Text coloured by the page's CSS: only the green mark is drawn.
    expect(await flags(svg('<circle cx="50" cy="50" r="10" fill="#33aa33"/>'))).toEqual(['faint']);
    expect(await flags(svg('<circle cx="50" cy="50" r="30" fill="#ffffff"/>'))).toEqual(['light']);
    expect(await flags(svg('<rect width="400" height="40" fill="#222"/>', 400, 40))).toEqual([
      'wordmark',
    ]);
  });
});

describe('svgExternalReference', () => {
  it('allows fragments and data URLs, and nothing else', () => {
    expect(
      svgExternalReference(
        '<svg><linearGradient id="g"/><rect fill="url(#g)"/><use href="#a"/><image href="data:image/png;base64,AA"/></svg>',
      ),
    ).toBeNull();
    expect(svgExternalReference('<svg><use xlink:href="other.svg#a"/></svg>')).toBe('other.svg#a');
    expect(svgExternalReference('<svg><rect style="fill: url(https://x.test/p)"/></svg>')).toBe(
      'https://x.test/p',
    );
    expect(svgExternalReference('<svg><style>@import "x.css";</style></svg>')).toBe('@import');
  });
});

describe('assetRecord', () => {
  it('records an icon as a logo and a README screenshot under the repository’s licence', async () => {
    const origin = {
      package: 'tool',
      sourceUrl: 'https://tool.test/logo.png',
      sourceRevision: '2026-11-03T00:00:00.000Z',
      basis: 'judge' as const,
    };
    const iconAsset = await processAsset('icon', await icon(256).toBuffer(), 'png');
    expect(assetRecord(iconAsset, origin)).toMatchObject({
      kind: 'icon',
      licence: ICON_LICENCE,
      credit: null,
      basis: 'judge',
    });
    const shot = await processAsset('screenshot', await icon(800).toBuffer(), 'png');
    expect(
      assetRecord(shot, { ...origin, sourceRevision: 'abc123', repoLicence: 'MIT' }),
    ).toMatchObject({ kind: 'screenshot', licence: 'MIT', credit: README_CREDIT });
  });
});

describe('applyTakedowns', () => {
  const record = (pkg: string, n: number): AssetRecord => ({
    key: `icons/v1/${String(n).repeat(64)}.webp`,
    kind: 'icon',
    package: pkg,
    sourceUrl: 'https://x.test',
    sourceRevision: 'r',
    sourceHash: String(n).repeat(64),
    outputHash: String(n + 1).repeat(64),
    width: 128,
    height: 128,
    animated: false,
    flags: [],
    licence: ICON_LICENCE,
    credit: null,
    basis: 'rules',
  });

  it('removes a whole package, or images by hash wherever they’re shown', () => {
    const takedowns = readTakedowns([
      { id: 'gone', hashes: [], date: '2026-11-03', reason: 'Asked by the developer.' },
      { id: 'bun', hashes: ['3'.repeat(64)], date: '2026-11-03', reason: 'Asked.' },
    ]);
    const assets = [
      record('gone', 1),
      record('bun', 2),
      record('oven-sh/bun/bun', 2),
      record('x', 4),
    ];
    // Matched by output hash: 2 + 1.
    const { kept, removed, deleteKeys } = applyTakedowns(assets, takedowns, [record('old', 6)]);
    expect(kept.map((a) => a.package)).toEqual(['x']);
    expect(removed.map((a) => a.package)).toEqual(['gone', 'bun', 'oven-sh/bun/bun']);
    expect(deleteKeys).toEqual([record('gone', 1).key, record('bun', 2).key]);
  });

  it('deletes a stored key taken down since the last run, but not one still shown', () => {
    const takedowns = readTakedowns([
      { id: 'a', hashes: [], date: '2026-11-03', reason: 'Asked.' },
    ]);
    const shared = record('b', 5);
    const { deleteKeys } = applyTakedowns([shared], takedowns, [
      { ...shared, package: 'a' },
      record('a', 7),
    ]);
    expect(deleteKeys).toEqual([record('a', 7).key]);
  });
});
