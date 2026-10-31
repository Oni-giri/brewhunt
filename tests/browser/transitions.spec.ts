// Motion: the sliding tab thumb, panels fading in, and the fade between pages. All of it stands
// still under reduced motion.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

/** Where the thumb is, against the selected tab, in px. */
const thumbOffset = (page: Page, list: string) =>
  page.evaluate((list) => {
    const root = document.querySelector(list)!;
    const thumb = root.querySelector('.tab-thumb')!.getBoundingClientRect();
    const tab = root.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
    return Math.abs(thumb.left - tab.left) + Math.abs(thumb.width - tab.width);
  }, list);

/** Selects the second tab, then reads the panel's animations and the thumb's transition at once
 * (the fade is over in 150ms). Waits two frames first: the thumb starts sliding after one. */
const motion = (page: Page, list: string, panel: string) =>
  page.evaluate(
    async ([list, panel]) => {
      const frame = () => new Promise(requestAnimationFrame);
      await frame();
      await frame();
      const tab = document.querySelectorAll<HTMLElement>(`${list} [role="tab"]`)[1];
      tab.focus();
      tab.click();
      return {
        fades: document.querySelector(panel)!.getAnimations().length,
        thumb: getComputedStyle(document.querySelector(`${list} .tab-thumb`)!).transitionDuration,
      };
    },
    [list, panel],
  );

/** Whether the page opts in to cross-document view transitions, and its named parts. Headless
 * Chromium skips some of these transitions at random, so the opt-in is checked rather than a
 * transition watched. */
const pageFade = (page: Page) =>
  page.evaluate(() => {
    const rules = (list: CSSRuleList): CSSRule[] =>
      [...list].flatMap((r) => (r instanceof CSSGroupingRule ? [r, ...rules(r.cssRules)] : [r]));
    const optIn = [...document.styleSheets]
      .flatMap((sheet) => rules(sheet.cssRules))
      .find((r) => r instanceof CSSViewTransitionRule);
    const media = optIn?.parentRule instanceof CSSMediaRule ? optIn.parentRule.media.mediaText : '';
    const name = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!).viewTransitionName;
    return {
      on:
        !!optIn &&
        (optIn as CSSViewTransitionRule).navigation === 'auto' &&
        (!media || matchMedia(media).matches),
      header: name('[data-header]'),
      footer: name('footer'),
    };
  });

// Each page's tablist and the panel its second tab shows.
const TABLISTS = [
  { path: '/charts', list: '[data-tabs]', panel: '#panel-command-line' },
  { path: '/new', list: '[data-controls] [role="tablist"]', panel: '#new-list' },
];

for (const { path, list, panel } of TABLISTS) {
  test(`${path}: the thumb follows the selected tab and the panel fades in`, async ({ page }) => {
    await page.goto(path);
    expect(await thumbOffset(page, list)).toBeLessThan(1);
    expect(await motion(page, list, panel)).toEqual({ fades: 1, thumb: '0.2s, 0.2s' });
    await expect.poll(() => thumbOffset(page, list)).toBeLessThan(1);
    await page.keyboard.press('End');
    await expect.poll(() => thumbOffset(page, list)).toBeLessThan(1);
  });
}

test('the thumb keeps up with a narrower window', async ({ page }) => {
  await page.goto('/charts');
  await page.locator('[data-tabs] [role="tab"]').last().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => thumbOffset(page, '[data-tabs]')).toBeLessThan(1);
});

test('a tab bar wider than the screen fades the side that is scrolled away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new');
  const list = page.locator('[data-controls] [role="tablist"]');
  await expect(list).toHaveAttribute('data-overflow', 'end');
  await list.locator('[role="tab"]').first().focus();
  await page.keyboard.press('End');
  await expect(list).toHaveAttribute('data-overflow', 'start');
});

test('turning bold does not move the tabs', async ({ page }) => {
  await page.goto('/new');
  const lefts = () =>
    page
      .locator('[data-controls] [role="tab"]')
      .evaluateAll((tabs) => tabs.map((t) => t.getBoundingClientRect().left));
  const before = await lefts();
  await page.locator('[data-controls] [role="tab"]').nth(1).click();
  expect(await lefts()).toEqual(before);
});

test('same-site navigation fades between pages; header and footer move on their own', async ({
  page,
}) => {
  await page.goto('/charts');
  expect(await pageFade(page)).toEqual({ on: true, header: 'site-header', footer: 'site-footer' });
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  for (const { path, list, panel } of TABLISTS) {
    test(`${path}: the thumb jumps and the panel doesn't fade`, async ({ page }) => {
      await page.goto(path);
      expect(await motion(page, list, panel)).toEqual({ fades: 0, thumb: '0s' });
      expect(await thumbOffset(page, list)).toBeLessThan(1);
    });
  }

  test('pages change without a fade', async ({ page }) => {
    await page.goto('/charts');
    expect((await pageFade(page)).on).toBe(false);
  });
});
