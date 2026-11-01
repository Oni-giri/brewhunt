// Small pieces dry-run.ts and find-logos.ts share.

import { FetchError, type ImageFormat } from './fetch.ts';

/** A package id as a folder name (`oven-sh/bun/bun` → `oven-sh__bun__bun`). */
export const safeName = (id: string) => id.replace(/\//g, '__').replace(/[^a-z0-9@+._-]/gi, '_');

export const EXT: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  ico: 'ico',
  svg: 'svg',
};

/** Runs `work` over `items`, at most `size` at a time. */
export async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await work(items[i], i);
      }
    }),
  );
}

export const failure = (error: unknown) =>
  error instanceof FetchError
    ? `${error.reason}: ${error.message}`
    : `error: ${(error as Error).message}`;
