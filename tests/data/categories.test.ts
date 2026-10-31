import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptCaskCategories,
  parseCaskCategories,
  updateCaskCategories,
  type CaskCategories,
} from '../../scripts/data/categories.ts';
import { writeJson } from '../../scripts/data/state.ts';

const file = (count: number): CaskCategories => ({
  release: 'caskflow-v2026.10.31',
  names: { games: 'Games' },
  primary: Object.fromEntries(Array.from({ length: count }, (_, i) => [`app-${i}`, 'games'])),
});

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
    const result = await updateCaskCategories(dir, async () => file(3));
    expect(result.warning).toBeNull();
    expect(await onDisk()).toEqual(file(3));
  });

  it("keeps yesterday's file when the fetch fails or the file shrinks", async () => {
    await writeJson(join(dir, 'site', 'caskflow-categories.json'), file(10));
    const failed = await updateCaskCategories(dir, () => Promise.reject(new Error('HTTP 503')));
    expect(failed.warning).toMatch(/HTTP 503/);
    expect(failed.categories).toEqual(file(10));
    const shrunk = await updateCaskCategories(dir, async () => file(2));
    expect(shrunk.warning).toMatch(/keeping the previous file/);
    expect(await onDisk()).toEqual(file(10));
  });
});
