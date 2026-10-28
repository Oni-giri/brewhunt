import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptIcons, parseIconManifest, updateIcons, type IconSet } from '../../scripts/data/icons.ts';
import { writeJson } from '../../scripts/data/state.ts';
import { iconBase, iconUrl } from '../../src/lib/tiles.ts';

const COMMIT = '229a55f43a9aacf64488c39393c9f1a21423e382';
const set = (count: number, commit = COMMIT): IconSet => ({
  commit,
  tokens: Array.from({ length: count }, (_, i) => `app-${i}`),
});

describe('parseIconManifest', () => {
  it('keeps cask tokens and drops anything that could be a path or URL', () => {
    const tokens = parseIconManifest({
      version: 1,
      hashes: {
        firefox: 'a',
        '1password@7': 'b',
        '4k-video-downloader+': 'c',
        '../../evil': 'd',
        'a/b': 'e',
        'https://x': 'f',
        Upper: 'g',
        '.hidden': 'h',
        'a..b': 'i',
      },
    });
    expect(tokens).toEqual(['1password@7', '4k-video-downloader+', 'firefox']);
  });

  it('rejects a manifest of the wrong shape', () => {
    expect(() => parseIconManifest({ icons: [] })).toThrow();
  });
});

describe('acceptIcons', () => {
  it('takes a sane set, and refuses a bad commit, an empty set or a sudden drop', () => {
    expect(acceptIcons(set(100), set(120))).toEqual(set(100));
    expect(acceptIcons(set(100), null)).toEqual(set(100));
    expect(acceptIcons(set(100, 'main'), null)).toBeNull();
    expect(acceptIcons(set(0), null)).toBeNull();
    expect(acceptIcons(set(40), set(100))).toBeNull();
  });
});

describe('updateIcons', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'icons-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const onDisk = async () => JSON.parse(await readFile(join(dir, 'site', 'icons.json'), 'utf8')) as IconSet;

  it('writes the new set', async () => {
    const result = await updateIcons(dir, async () => set(3));
    expect(result.warning).toBeNull();
    expect(await onDisk()).toEqual(set(3));
  });

  it("keeps yesterday's file when the fetch fails or the set shrinks", async () => {
    await writeJson(join(dir, 'site', 'icons.json'), set(10));
    const failed = await updateIcons(dir, () => Promise.reject(new Error('HTTP 503')));
    expect(failed.warning).toMatch(/HTTP 503/);
    expect(failed.icons).toEqual(set(10));
    const shrunk = await updateIcons(dir, async () => set(2));
    expect(shrunk.warning).toMatch(/keeping the previous set/);
    expect(await onDisk()).toEqual(set(10));
  });
});

describe('icon URLs', () => {
  it('pin the commit and encode the token', () => {
    const base = iconBase(COMMIT);
    expect(iconUrl(base, 'firefox')).toBe(`https://cdn.jsdelivr.net/gh/alielsokary/CaskFlow@${COMMIT}/firefox.png`);
    expect(iconUrl(base, '1password@7')).toBe(`${base}1password%407.png`);
    expect(iconUrl(base, '4k-video-downloader+')).toBe(`${base}4k-video-downloader%2B.png`);
  });
});
