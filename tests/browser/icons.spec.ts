// App icons load from jsDelivr, and every icon falls back to its letter tile when they can't.

import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.ts';

test.describe('with jsDelivr blocked', () => {
  test('every icon on /charts falls back to its tile', async ({ page }) => {
    await page.goto('/charts');
    // Icons below the fold load lazily: scroll so each one tries.
    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < height; y += 600) await page.mouse.wheel(0, 600);
    await expect
      .poll(() =>
        page
          .locator('.app-icon.has-icon')
          .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).length),
      )
      .toBe(0);
  });

  test('the app page header falls back', async ({ page }) => {
    await page.goto('/app/firefox');
    await expect(page.locator('.app-icon.raised')).toBeVisible();
    await expect(page.locator('.app-icon.raised.has-icon')).toHaveCount(0);
  });

  test('search rows fall back', async ({ page }) => {
    await page.goto('/search?q=browser');
    await expect(page.locator('[data-list] li').first()).toBeVisible();
    await expect(page.locator('[data-list] .app-icon.has-icon')).toHaveCount(0);
  });
});

test.describe('with icons available', () => {
  // jsDelivr itself isn't under test: every icon request gets the same local PNG, so the job
  // doesn't fail (and block the deploy) when the CDN has a bad day.
  test.use({ cdn: true });
  test.beforeEach(async ({ context }) => {
    const png = readFileSync('public/brewhunt-flask-128.png');
    await context.route('**/cdn.jsdelivr.net/**', (route) =>
      route.fulfill({ contentType: 'image/png', body: png }),
    );
  });

  test('icons load on an app page and in the install sheet', async ({ page }) => {
    await page.goto('/app/firefox');
    const img = page.locator('.app-icon.raised.has-icon img');
    await expect(img).toHaveCount(1);
    await expect
      .poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth))
      .toBeGreaterThan(0);

    await page.goto('/charts');
    await page.locator('#panel-mac-apps a[data-get]').first().click();
    await expect(page.locator('[data-sheet-icon].has-icon img')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.locator('#panel-mac-apps a[data-get]').first().click();
    await expect(page.locator('[data-sheet-icon] img')).toHaveCount(1);
    await page.keyboard.press('Escape');
    // A formula has no icon: the sheet goes back to the tile.
    await page.locator('#tab-command-line').click();
    await page.locator('#panel-command-line a[data-get]').first().click();
    await expect(page.locator('[data-sheet-icon] img')).toHaveCount(0);
    await expect(page.locator('[data-sheet-icon]')).not.toHaveClass(/has-icon/);
  });
});
