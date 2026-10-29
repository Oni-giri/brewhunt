// Every kind of page, at desktop, phone and small-phone widths: it loads, renders its heading,
// doesn't scroll sideways and logs no errors.

import { expect, overflow, PAGES, test } from './fixtures.ts';

for (const width of [1280, 390, 320]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const path of PAGES) {
      test(path, async ({ page }) => {
        const response = await page.goto(path, { waitUntil: 'networkidle' });
        expect(response?.ok()).toBe(true);
        await expect(page.locator('h1').first()).toBeVisible();
        expect(await overflow(page), 'px past the right edge').toBe(0);
      });
    }
  });
}
