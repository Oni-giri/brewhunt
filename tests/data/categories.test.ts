import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptCaskCategories,
  parseCaskCategories,
  readCapped,
  updateCaskCategories,
  type CaskCategories,
} from '../../scripts/data/categories.ts';
import { writeJson } from '../../scripts/data/state.ts';

const file = (count: number): CaskCategories => ({
  release: 'caskflow-v2026.10.31',
  names: { games: 'Games' },
  primary: Object.fromEntries(Array.from({ length: count }, (_, i) => [`app-${i}`, 'games'])),
});

const mapped = new Set(['games']);

describe('parseCaskCategories', () => {
  it('keeps primary categories of cask tokens, and drops paths and unknown ids', () => {
    const parsed = parseCaskCategories('caskflow-v1', {
      version: 2,
      categories: {
        games: { displayName: 'Games', icon: 'gamecontroller' },
        ai: { displayName: 'AI & LLMs' },
        'bad id': { displayName: 'Nope' },
      },
      tokenToCategory: {
        steam: { primary: 'games', secondary: ['ai'] },
        '1password@7': { primary: 'games', secondary: [] },
        '../../evil': { primary: 'games', secondary: [] },
        mystery: { primary: 'notACategory', secondary: [] },
      },
      appIdentities: {},
    });
    expect(parsed).toEqual({
      release: 'caskflow-v1',
      names: { games: 'Games', ai: 'AI & LLMs' },
      primary: { '1password@7': 'games', steam: 'games' },
    });
  });

  it('rejects a file of the wrong shape', () => {
    expect(() => parseCaskCategories('x', { categories: [] })).toThrow();
  });

  it('rejects runaway names', () => {
    const json = {
      categories: { games: { displayName: 'G'.repeat(500) } },
      tokenToCategory: { steam: { primary: 'games' } },
    };
    expect(() => parseCaskCategories('x', json)).toThrow();
  });
});

describe('acceptCaskCategories', () => {
  it('takes a sane file, and refuses an empty one or a sudden drop', () => {
    expect(acceptCaskCategories(file(100), file(120))).toEqual(file(100));
    expect(acceptCaskCategories(file(100), null)).toEqual(file(100));
    expect(acceptCaskCategories(file(0), null)).toBeNull();
    expect(acceptCaskCategories(file(40), file(100))).toBeNull();
  });
});

describe('updateCaskCategories', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'categories-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const onDisk = async () =>
    JSON.parse(
      await readFile(join(dir, 'site', 'caskflow-categories.json'), 'utf8'),
    ) as CaskCategories;

  it('writes the new file', async () => {
    const result = await updateCaskCategories(dir, async () => file(3), mapped);
    expect(result.warning).toBeNull();
    expect(await onDisk()).toEqual(file(3));
  });

  it("keeps yesterday's file when the fetch fails or the file shrinks", async () => {
    await writeJson(join(dir, 'site', 'caskflow-categories.json'), file(10));
    const failed = await updateCaskCategories(dir, () => Promise.reject(new Error('HTTP 503')), mapped);
    expect(failed.warning).toMatch(/HTTP 503/);
    expect(failed.categories).toEqual(file(10));
    const shrunk = await updateCaskCategories(dir, async () => file(2), mapped);
    expect(shrunk.warning).toMatch(/keeping the previous file/);
    expect(await onDisk()).toEqual(file(10));
  });

  it("keeps yesterday's file when today's isn't a categories file", async () => {
    await writeJson(join(dir, 'site', 'caskflow-categories.json'), file(10));
    const result = await updateCaskCategories(
      dir,
      async () => ({ release: 'x' }) as CaskCategories,
      mapped,
    );
    expect(result.warning).toMatch(/keeping the previous file/);
    expect(result.categories).toEqual(file(10));
    expect(await onDisk()).toEqual(file(10));
  });

  it("replaces yesterday's file when it's malformed", async () => {
    await mkdir(join(dir, 'site'), { recursive: true });
    await writeFile(join(dir, 'site', 'caskflow-categories.json'), '{"release":"x"}');
    const result = await updateCaskCategories(dir, async () => file(3), mapped);
    expect(result.warning).toBeNull();
    expect(await onDisk()).toEqual(file(3));
  });

  it("keeps yesterday's file when CaskFlow files casks under an id we don't map", async () => {
    await writeJson(join(dir, 'site', 'caskflow-categories.json'), file(10));
    const next = file(10);
    next.names.health = 'Health';
    next.primary['app-0'] = 'health';
    const result = await updateCaskCategories(dir, async () => next, mapped);
    expect(result.warning).toMatch(/"health" \(1 casks\).*keeping the previous file/);
    expect(await onDisk()).toEqual(file(10));
    // An id with no casks is fine.
    const empty = file(12);
    empty.names.health = 'Health';
    expect((await updateCaskCategories(dir, async () => empty, mapped)).warning).toBeNull();
  });
});

describe('readCapped', () => {
  it('reads a small body, and refuses a big one', async () => {
    expect(await readCapped(new Response('{"a":1}'), 100)).toBe('{"a":1}');
    await expect(readCapped(new Response('x'.repeat(200)), 100)).rejects.toThrow(/over 100 bytes/);
    // Without a declared length, it stops while streaming.
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(60)));
      },
    });
    await expect(readCapped(new Response(stream), 100)).rejects.toThrow(/over 100 bytes/);
  });
});
