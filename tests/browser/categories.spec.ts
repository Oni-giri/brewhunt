// /categories and the categories CaskFlow fills: every category with its most installed, the
// cap on big category pages and its link to search. The data may not have CaskFlow's file yet
// (the first data run after this code lands adds it), so counts are only checked when it does.

import { expect, test } from './fixtures.ts';

test('/categories lists every category with up to 10 of its apps', async ({ page }) => {
  await page.goto('/categories');
  const cards = page.locator('.grid > li');
  const count = await cards.count();
  expect(count).toBeGreaterThanOrEqual(14);
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    await expect(card.locator('.head')).toHaveAttribute('href', /^\/category\/[a-z0-9-]+$/);
    const apps = await card.locator('.top a').count();
    expect(apps).toBeLessThanOrEqual(10);
    if (apps > 0) await expect(card.locator('.top a').first()).toHaveAttribute('href', /^\/app\//);
  }
  await expect(page.getByRole('link', { name: 'Windows & desktop' }).first()).toBeVisible();
});

test('the header and footer point at /categories, marked current there', async ({ page }) => {
  await page.goto('/discover');
  const nav = page.locator('.nav-links a', { hasText: 'Categories' });
  await expect(nav).toHaveAttribute('href', '/categories');
  await expect(page.locator('footer a', { hasText: 'All categories' })).toHaveAttribute(
    'href',
    '/categories',
  );
  await nav.click();
  await page.waitForURL(/\/categories$/);
  await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText('Categories');
});

test('a big category lists its 100 most installed and links to the rest in search', async ({
  page,
}) => {
  await page.goto('/category/utilities');
  const rows = await page.locator('[data-list] > li').count();
  const seeAll = page.locator('.see-all');
  test.skip(rows < 100, "The data doesn't have CaskFlow's categories yet.");
  expect(rows).toBe(100);
  await expect(page.locator('[data-list-count]')).toHaveText(
    /^The 100 most installed of [\d,]+ apps and tools$/,
  );
  await expect(seeAll).toHaveAttribute('href', '/search?cat=utilities');
  await seeAll.click();
  await page.waitForURL(/\/search\?cat=utilities$/);
  await expect(page.locator('input[name="cat"][value="utilities"]')).toBeChecked();
});

test('a small category has no cap and no link to search', async ({ page }) => {
  await page.goto('/category/windows-desktop');
  await expect(page.locator('.see-all')).toHaveCount(0);
  await expect(page.locator('[data-list-count]')).toHaveText(/^\d+ apps and tools$/);
});
