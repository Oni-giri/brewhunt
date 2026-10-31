// The app page header: the Official / Community badge's note, the facts strip, and badges centred
// on their letters.

import { expect, test } from './fixtures.ts';

const note = '#source-note';
const badge = '[data-explain] button';

test('the badge note opens on a tap, closes on a second tap, Escape or a tap elsewhere', async ({
  page,
}) => {
  await page.goto('/app/wget');
  await expect(page.locator(badge)).toHaveAttribute('aria-describedby', 'source-note');
  await expect(page.locator(note)).toBeHidden();
  await page.locator(badge).click();
  await expect(page.locator(note)).toContainText("Homebrew's official catalog");
  await page.locator(badge).click();
  await expect(page.locator(note)).toBeHidden();
  await page.locator(badge).click();
  await page.keyboard.press('Escape');
  await expect(page.locator(note)).toBeHidden();
  await page.locator(badge).click();
  await page.locator('h1').click();
  await expect(page.locator(note)).toBeHidden();
});

test('the badge note shows on hover and keyboard focus', async ({ page }) => {
  await page.goto('/app/wget');
  await page.locator(badge).hover();
  await expect(page.locator(note)).toBeVisible();
  // The pointer can move onto the note without it closing.
  await page.locator(note).hover();
  await expect(page.locator(note)).toBeVisible();
  await page.locator('h1').hover();
  await expect(page.locator(note)).toBeHidden();

  await page.locator('h1').click();
  await page.locator(badge).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator(note)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(note)).toBeHidden();
});

test('community packages say the tap is not reviewed', async ({ page }) => {
  await page.goto('/app/nikitabobko/tap/aerospace');
  await page.locator(badge).click();
  await expect(page.locator(note)).toContainText('Not reviewed by Homebrew');
});

test('the facts strip lists what the package has', async ({ page }) => {
  await page.goto('/app/wget');
  const labels = await page.locator('[data-facts] dt').allTextContents();
  expect(labels).toContain('Version');
  expect(labels.at(-1)).toBe('Installs');
  // The header keeps two badges (plus Deprecated when it is).
  expect(await page.locator('.badges .badge').count()).toBeLessThanOrEqual(3);
});

test('the facts strip fits at 1280 and scrolls, focusable, at 320', async ({ page }) => {
  await page.goto('/app/wget');
  const strip = page.locator('[data-facts]');
  await expect(strip).not.toHaveAttribute('data-overflow');
  await expect(strip).not.toHaveAttribute('tabindex');
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(strip).toHaveAttribute('data-overflow', 'end');
  await expect(strip).toHaveAttribute('tabindex', '0');
});

test('badge labels sit in the middle of the badge', async ({ page }) => {
  await page.goto('/app/wget');
  const offsets = await page.locator('.badge').evaluateAll((badges) =>
    badges.map((b) => {
      const box = b.getBoundingClientRect();
      const label = b.querySelector('.label')!.getBoundingClientRect();
      return Math.abs(label.top - box.top - (box.bottom - label.bottom));
    }),
  );
  for (const offset of offsets) expect(offset).toBeLessThan(0.75);
});
