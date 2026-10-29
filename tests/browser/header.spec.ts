// The header (mobile menu, search) and the landing page: hero search, the app wall's pause
// button and its reduced-motion version.

import { expect, test } from './fixtures.ts';

test.describe('at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('menu opens with focus inside and closes on Escape', async ({ page }) => {
    await page.goto('/discover');
    const toggle = page.locator('[data-menu-toggle]');
    await toggle.click();
    await expect(page.locator('[data-menu]')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-menu]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-menu]')).toBeHidden();
    await expect(toggle).toBeFocused();
  });
});

for (const width of [1280, 390]) {
  test(`header search goes to /search at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/discover');
    await page.locator('[data-search-toggle]').click();
    await page.keyboard.type('rectangle');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/search\?q=rectangle$/);
    await expect(page.locator('#search-q')).toHaveValue('rectangle');
  });
}

test('landing: hero search goes to /search', async ({ page }) => {
  await page.goto('/');
  await page.fill('#landing-q', 'firefox');
  await page.press('#landing-q', 'Enter');
  await page.waitForURL(/\/search\?q=firefox$/);
});

test('landing: the app wall moves, pauses on the button and on hover', async ({ page }) => {
  await page.goto('/');
  await page.mouse.move(5, 5);
  const button = page.locator('[data-wall-pause]');
  const states = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.track')].map((t) => getComputedStyle(t).animationPlayState),
    );
  const position = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('.track')!).transform);

  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(new Set(await states())).toEqual(new Set(['running']));
  const start = await position();
  await expect.poll(position).not.toBe(start);

  await button.click();
  await page.mouse.move(5, 5);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(new Set(await states())).toEqual(new Set(['paused']));

  await button.click();
  await page.mouse.move(5, 5);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.wall .chip').nth(1).hover({ force: true });
  expect(new Set(await states())).toEqual(new Set(['paused']));
});

test('landing: hidden copies on the app wall are skipped by Tab', async ({ page }) => {
  await page.goto('/');
  const copies = await page.evaluate(() => {
    const hidden = [...document.querySelectorAll('.wall li[aria-hidden="true"]')];
    return {
      hidden: hidden.length,
      total: document.querySelectorAll('.wall li').length,
      unfocusable: hidden.every((li) => li.querySelector('a')!.tabIndex === -1),
    };
  });
  expect(copies.hidden * 2).toBe(copies.total);
  expect(copies.unfocusable).toBe(true);
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('landing: the app wall stands still and has no pause button', async ({ page }) => {
    await page.goto('/');
    const wall = await page.evaluate(() => ({
      animations: [...document.querySelectorAll('.track')].map(
        (t) => getComputedStyle(t).animationName,
      ),
      transforms: [...document.querySelectorAll('.track')].map(
        (t) => getComputedStyle(t).transform,
      ),
      button: getComputedStyle(document.querySelector('.controls')!).display,
    }));
    expect(new Set(wall.animations)).toEqual(new Set(['none']));
    expect(new Set(wall.transforms)).toEqual(new Set(['none']));
    expect(wall.button).toBe('none');
  });
});
