import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readSnapshots,
  readState,
  stableJson,
  writeSnapshot,
  writeState,
} from '../../scripts/data/state.ts';

describe('stableJson', () => {
  it('sorts keys and puts one top-level entry per line', () => {
    expect(stableJson({ b: { y: 1, x: 2 }, a: [3] })).toBe('{\n"a":[3],\n"b":{"x":2,"y":1}\n}\n');
    expect(stableJson([{ b: 1, a: 2 }, 3])).toBe('[\n{"a":2,"b":1},\n3\n]\n');
  });
});

describe('state files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'brewhunt-state-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts empty and round-trips', async () => {
    expect(await readState(dir)).toEqual({ schemaVersion: 1, repos: {}, packages: {} });
    const state = {
      schemaVersion: 1 as const,
      repos: { 'homebrew/core': { trackedSince: '2025-09-23', lastRun: '2026-10-28' } },
      packages: { wget: { firstSeen: null, updatedAt: '2026-09-22', updatedKind: 'version' as const, version: '1.25.0_2' } },
    };
    await writeState(dir, state);
    expect(await readState(dir)).toEqual(state);
  });

  it('stores snapshots by month and replaces a day instead of duplicating it', async () => {
    await writeSnapshot(dir, '2026-10-27', { installs: { wget: 10 }, installsOnRequest: {} });
    await writeSnapshot(dir, '2026-10-27', { installs: { wget: 11 }, installsOnRequest: {} });
    await writeSnapshot(dir, '2026-11-01', { installs: { wget: 12 }, installsOnRequest: {} });
    expect(readdirSync(join(dir, 'state', 'history')).sort()).toEqual(['2026-10.json', '2026-11.json']);
    const snapshots = await readSnapshots(dir);
    expect([...snapshots.keys()]).toEqual(['2026-10-27', '2026-11-01']);
    expect(snapshots.get('2026-10-27')!.installs.wget).toBe(11);
    expect(readFileSync(join(dir, 'state', 'history', '2026-10.json'), 'utf8')).not.toContain('.tmp');
  });
});
