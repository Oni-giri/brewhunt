// Tabs, filters, "show more" and sorting on /charts, /new and /category, with and without JS.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

const visibleRows = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).length);

test('charts: tabs follow the arrow keys, show more moves focus', async ({ page }) => {
  await page.goto('/charts');
  expect(await visibleRows(page, '#panel-mac-apps ol > li')).toBe(25);
  await expect(page.locator('#panel-command-line')).toBeHidden();
  await page.locator('#tab-mac-apps').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#panel-command-line')).toBeVisible();
  await expect(page.locator('#tab-command-line')).toBeFocused();
  await expect(page.locator('#tab-command-line')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.locator('#panel-community')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.locator('#panel-mac-apps')).toBeVisible();
  await page.keyboard.press('End');
  await page.locator('#panel-community [data-more]').click();
  expect(await visibleRows(page, '#panel-community ol > li')).toBeGreaterThan(25);
  expect(
    await page.evaluate(() => document.activeElement?.closest('li')?.matches(':nth-child(26)')),
  ).toBe(true);
});

test('charts: each period page marks its period', async ({ page }) => {
  await page.goto('/charts/1-year');
  await expect(page.locator('.periods [aria-current=page]')).toHaveText('1 year');
  await page.goto('/charts/90-days');
  await expect(page.locator('.periods [aria-current=page]')).toHaveText('90 days');
});

test('new: type tabs and the installing toggle filter the list', async ({ page }) => {
  await page.goto('/new');
  const total = await visibleRows(page, '#new-list .row');
  const withInstalls = await visibleRows(page, '#new-list .row[data-installing]');
  await page.getByRole('tab', { name: 'Mac apps' }).click();
  const mac = await visibleRows(page, '#new-list .row');
  expect(mac).toBeGreaterThan(0);
  expect(mac).toBeLessThan(total);
  await page.getByRole('tab', { name: 'Community' }).click();
  const sources = await page
    .locator('#new-list .row:visible')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.source));
  expect(sources.length).toBeGreaterThan(0);
  expect(new Set(sources)).toEqual(new Set(['community']));
  await page.getByRole('tab', { name: 'Everything' }).click();
  await page.getByLabel('Only ones people are already installing').check();
  expect(withInstalls).toBeGreaterThan(0);
  expect(await visibleRows(page, '#new-list .row')).toBe(withInstalls);
  expect(await visibleRows(page, '#new-list .row[data-installing]')).toBe(withInstalls);
  await page.getByLabel('Only ones people are already installing').uncheck();
  expect(await visibleRows(page, '#new-list .row')).toBe(total);
  const lastWeek = page.locator('[data-last-week]');
  if (await lastWeek.count()) {
    await lastWeek.click();
    await expect(page.locator('[data-week=last]')).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H2');
  }
});

test('new: tabs follow the arrow keys, Home and End', async ({ page }) => {
  await page.goto('/new');
  const total = await visibleRows(page, '#new-list .row');
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  const expectSelected = async (name: string) => {
    await expect(tab(name)).toBeFocused();
    await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
    await expect(tab(name)).toHaveAttribute('tabindex', '0');
  };
  const sources = () =>
    page
      .locator('#new-list .row:visible')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.source))
      .then((list) => new Set(list));

  await tab('Everything').focus();
  await page.keyboard.press('ArrowRight');
  await expectSelected('Mac apps');
  const mac = await visibleRows(page, '#new-list .row');
  expect(mac).toBeGreaterThan(0);
  expect(mac).toBeLessThan(total);
  await page.keyboard.press('End');
  await expectSelected('Community');
  expect(await sources()).toEqual(new Set(['community']));
  await page.keyboard.press('ArrowRight');
  await expectSelected('Everything');
  expect(await visibleRows(page, '#new-list .row')).toBe(total);
  await page.keyboard.press('ArrowLeft');
  await expectSelected('Community');
  await page.keyboard.press('Home');
  await expectSelected('Everything');
  expect(await visibleRows(page, '#new-list .row')).toBe(total);
});

test('category: subcategory filter, count and sort', async ({ page }) => {
  await page.goto('/category/windows-desktop');
  const all = await visibleRows(page, '[data-list] > li');
  const tiling = page.getByRole('button', { name: 'Tiling' });
  await tiling.click();
  await expect(tiling).toHaveAttribute('aria-pressed', 'true');
  const shown = await visibleRows(page, '[data-list] > li');
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(all);
  await expect(page.locator('[data-list-count]')).toHaveText(new RegExp(`^${shown}\\b`));
  await page.getByRole('button', { name: 'All' }).click();
  await page.locator('[data-sort]').selectOption('name');
  await expect(page.locator('[data-list-title]')).toHaveText('By name');
  const names = await page.locator('[data-list] > li .name').allTextContents();
  const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  expect(names).toEqual(sorted);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('charts show every list in full', async ({ page }) => {
    await page.goto('/charts');
    await expect(page.locator('#panel-command-line')).toBeVisible();
    expect(await visibleRows(page, '#panel-command-line ol > li')).toBeGreaterThan(25);
  });

  test('category hides the controls and lists everything', async ({ page }) => {
    await page.goto('/category/windows-desktop');
    await expect(page.locator('[data-controls]')).toBeHidden();
    expect(await visibleRows(page, '[data-list] > li')).toBeGreaterThan(0);
  });
});

test('app page: installs chart has range tabs, hover and keyboard readout', async ({ page }) => {
  await page.goto('/app/wget');
  const chart = page.locator('[data-chart]');
  // App pages show the chart once the data has 7 days of history, and a range tab for each
  // range the history covers.
  const days = Number(await page.locator('[data-history-days]').getAttribute('data-history-days'));
  test.skip(days < 7, `${days} days of install history`);
  await expect(chart).toBeVisible();
  const tabs = chart.getByRole('tab');
  const selected = chart.locator('[role=tab][aria-selected=true]');
  const panel = async () => page.locator(`#${await selected.getAttribute('aria-controls')}`);
  if ((await tabs.count()) > 1) {
    const before = await selected.textContent();
    const hidden = await panel();
    await selected.focus();
    await page.keyboard.press(
      (await tabs.last().getAttribute('aria-selected')) === 'true' ? 'Home' : 'ArrowRight',
    );
    await expect(selected).not.toHaveText(before!);
    await expect(selected).toBeFocused();
    await expect(hidden).toBeHidden();
  }
  const plot = chart.locator('[data-plot]:visible');
  await expect(plot).toHaveCount(1);
  const readout = plot.locator('.readout');
  await plot.scrollIntoViewIfNeeded();
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(readout).toBeVisible();
  await page.mouse.move(0, 0);
  await plot.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(readout).toBeVisible();
  await expect(readout).not.toBeEmpty();
});
