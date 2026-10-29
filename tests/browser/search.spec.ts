// /search mechanics: typing, filters and chips in the URL, reload, show more, the install sheet,
// collections. Which packages rank where belongs to tests/site/search-golden.test.ts, not here.

import type { Page } from '@playwright/test';
import { expect, searchReady, test } from './fixtures.ts';

const rows = (page: Page) =>
  page.locator('[data-list] > li.card').evaluateAll((lis) =>
    lis.map((li) => ({
      name: li.querySelector('.name')!.textContent,
      meta: li.querySelector('.meta')!.textContent!,
      command: (li.querySelector('a[data-get]') as HTMLElement).dataset.command,
    })),
  );
const param = (page: Page, name: string) => new URL(page.url()).searchParams.getAll(name).join();

test('typing searches and fills the URL and title', async ({ page }) => {
  await page.goto('/search');
  await searchReady(page);
  await expect(page.locator('h1')).toHaveText('Search');
  await expect(page.locator('[data-summary]')).toContainText('sorted by most installed');
  await page.locator('#search-q').pressSequentially('window manager');
  await expect(page.locator('h1')).toContainText('window manager');
  expect(param(page, 'q')).toBe('window manager');
  await expect(page).toHaveTitle('Results for “window manager” · Brewhunt');
  expect((await rows(page)).length).toBeGreaterThan(0);
});

test('filters, sort and chips live in the URL and survive a reload', async ({ page }) => {
  await page.goto('/search?q=window+manager');
  await searchReady(page);
  await page.click('label.option:has-text("Mac apps")');
  await expect.poll(() => param(page, 'type')).toBe('mac');
  await expect(page.locator('[data-filters-label]')).toHaveText('Filters (1)');
  await expect(page.getByRole('button', { name: 'Remove filter: Mac apps' })).toBeVisible();
  const metas = (await rows(page)).map((r) => r.meta);
  expect(metas.length).toBeGreaterThan(0);
  expect(metas.every((m) => m.startsWith('Mac app'))).toBe(true);

  await page.selectOption('[data-sort]', 'installs');
  await expect.poll(() => param(page, 'sort')).toBe('installs');
  await expect(page.locator('[data-summary]')).toContainText('sorted by most installed');

  await page.click('label.option:has-text("Windows & desktop")');
  await expect.poll(() => param(page, 'cat')).toBe('windows-desktop');

  await page.reload();
  await searchReady(page);
  await expect(page.locator('#search-q')).toHaveValue('window manager');
  await expect(page.locator('input[name="type"][value="mac"]')).toBeChecked();
  await expect(page.locator('input[name="cat"][value="windows-desktop"]')).toBeChecked();
  await expect(page.locator('[data-sort]')).toHaveValue('installs');
  await expect(page.locator('[data-chips] .chip')).toHaveCount(2);

  await page.getByRole('button', { name: 'Remove filter: Mac apps' }).click();
  await expect.poll(() => param(page, 'type')).toBe('');
  await expect(
    page.getByRole('button', { name: 'Remove filter: Windows & desktop' }),
  ).toBeFocused();
  await page.click('[data-chips] .text-btn');
  await expect.poll(() => new URL(page.url()).search).toBe('?q=window+manager&sort=installs');
});

test('sorting by installs lists the most installed first', async ({ page }) => {
  await page.goto('/search?q=git&sort=installs');
  await searchReady(page);
  const installs = (await rows(page)).map((r) => {
    const m = r.meta.match(/([\d.]+)(k|M)? installs/);
    return m ? Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'M' ? 1e6 : 1) : 0;
  });
  expect(installs).toEqual([...installs].sort((a, b) => b - a));
});

test('show more adds a page and moves focus to it', async ({ page }) => {
  await page.goto('/search?q=git');
  await searchReady(page);
  expect((await rows(page)).length).toBe(20);
  const before = await page.locator('[data-showing]').textContent();
  await page.click('[data-more]');
  expect((await rows(page)).length).toBe(40);
  expect(
    await page.evaluate(
      () =>
        document.activeElement ===
        document.querySelectorAll('[data-list] > li')[20].querySelector('a'),
    ),
  ).toBe(true);
  await expect(page.locator('[data-showing]')).not.toHaveText(before!);
});

test('Get opens the install sheet with the row’s command', async ({ page }) => {
  await page.goto('/search?q=aerospace');
  await searchReady(page);
  const [first] = await rows(page);
  const get = page.locator('[data-list] > li:first-child a[data-get]');
  await get.click();
  await expect(page.locator('#install-sheet')).toBeVisible();
  await expect(page.locator('[data-sheet-command]')).toHaveText(first.command!);
  await page.keyboard.press('Escape');
  await expect(page.locator('#install-sheet')).toBeHidden();
  await expect(get).toBeFocused();
});

test('a collection link lists the collection with a chip', async ({ page }) => {
  await page.goto('/search?collection=set-up-a-new-mac');
  await searchReady(page);
  await expect(page.locator('h1')).toHaveText('Set up a new Mac');
  await expect(
    page.getByRole('button', { name: 'Remove filter: Collection: Set up a new Mac' }),
  ).toBeVisible();
  expect((await rows(page)).length).toBeGreaterThan(0);
});

test.describe('when the index fails to download', () => {
  test.use({ ignoreErrorsFrom: ['search-index.json'] });

  test('shows the error and retries', async ({ page }) => {
    let fail = true;
    await page.route('**/search-index.json?*', (route) =>
      fail ? route.abort() : route.continue(),
    );
    await page.goto('/search?q=git');
    await expect(page.locator('[data-error]')).toBeVisible();
    fail = false;
    await page.click('[data-retry]');
    await searchReady(page);
    await expect(page.locator('[data-error]')).toBeHidden();
    expect((await rows(page)).length).toBeGreaterThan(0);
  });
});

test.describe('at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('filters open in a panel and close on Escape', async ({ page }) => {
    await page.goto('/search?q=git');
    await searchReady(page);
    const toggle = page.locator('[data-filters-toggle]');
    await toggle.click();
    await expect(page.locator('[data-filters]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-filters]')).toBeHidden();
    await expect(toggle).toBeFocused();
  });
});
