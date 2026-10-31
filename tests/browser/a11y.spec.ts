// axe's WCAG 2.x A and AA rules on every kind of page, at desktop and phone widths.

import AxeBuilder from '@axe-core/playwright';
import { expect, PAGES, searchReady, test } from './fixtures.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const path of PAGES) {
      test(path, async ({ page }) => {
        await page.goto(path, { waitUntil: 'networkidle' });
        if (path.startsWith('/search')) await searchReady(page);
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const found = violations.map((v) => ({
          rule: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
        }));
        expect(found).toEqual([]);
      });
    }
  });
}

// The sweep above sees the header's suggestions hidden; check them open, with one highlighted.
for (const width of [1280, 390]) {
  test(`header suggestions open at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/discover');
    await page.locator('[data-search-toggle]').click();
    await page.keyboard.type('aerospace');
    await expect(page.locator('#header-suggest [role="option"]').nth(1)).toBeAttached();
    await page.keyboard.press('ArrowDown');
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
  });
}
