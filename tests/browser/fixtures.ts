// Shared setup for the browser checks. Icons come from jsDelivr; by default it's blocked so the
// tests don't depend on a third-party CDN (every icon falls back to its letter tile). Tests that
// need the real icons opt in with `test.use({ cdn: true })`. Every page fails its test on a
// JavaScript error or a console error, except failed loads from URLs in `ignoreErrorsFrom`.

import { readdirSync } from 'node:fs';
import { test as base, expect, type Page } from '@playwright/test';

export { expect };

const CDN = 'cdn.jsdelivr.net';

export const test = base.extend<{ cdn: boolean; ignoreErrorsFrom: string[]; errors: string[] }>({
  cdn: [false, { option: true }],
  ignoreErrorsFrom: [[], { option: true }],
  context: async ({ context, cdn }, use) => {
    if (!cdn) await context.route(`**/${CDN}/**`, (route) => route.abort());
    await use(context);
  },
  errors: [
    async ({ page, ignoreErrorsFrom }, use) => {
      const errors: string[] = [];
      // The blocked CDN logs a failed load for each icon: expected.
      const ignored = [CDN, ...ignoreErrorsFrom];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        const url = message.location().url;
        if (message.type() === 'error' && !ignored.some((part) => url.includes(part)))
          errors.push(message.text());
      });
      await use(errors);
      expect(errors, 'console and page errors').toEqual([]);
    },
    { auto: true },
  ],
});

/** The largest overflow past the viewport's right edge, in px (0 = no sideways scroll). */
export const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Waits for /search to finish loading its index. */
export const searchReady = (page: Page) =>
  expect(page.locator('[data-results]')).not.toHaveAttribute('aria-busy', { timeout: 30_000 });

/** A community tap page from the build (the listed taps change with installs). */
function aTap() {
  const owners = readdirSync('dist/tap').sort();
  const owner = owners.includes('nikitabobko') ? 'nikitabobko' : owners[0];
  const repo = readdirSync(`dist/tap/${owner}`)
    .sort()[0]
    .replace(/\.html$/, '');
  return `/tap/${owner}/${repo}`;
}

/** One page of each kind. */
export const PAGES = [
  '/',
  '/discover',
  '/search?q=browser',
  '/charts',
  '/charts/1-year',
  '/new',
  '/category/windows-desktop',
  aTap(),
  '/app/firefox',
  '/app/wget',
  '/app/nikitabobko/tap/aerospace',
  '/404',
];
