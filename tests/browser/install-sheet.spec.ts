// The install sheet (Get buttons) and the copy buttons.

import { expect, test } from './fixtures.ts';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('app page: install card copies the command', async ({ page }) => {
  await page.goto('/app/rectangle');
  const copy = page.locator('.copy-primary');
  await copy.click();
  await expect(copy).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'brew install --cask rectangle',
  );
  await expect(page.locator('#copy-status')).toContainText('copied');
});

test('sheet: opens from Get, copies, closes on Escape and returns focus', async ({ page }) => {
  await page.goto('/app/rectangle');
  const get = page.locator('.similar a[data-get]').first();
  const name = await get.getAttribute('data-name');
  const command = await get.getAttribute('data-command');
  const sheet = page.locator('#install-sheet');

  await get.focus();
  await page.keyboard.press('Enter');
  await expect(sheet).toBeVisible();
  await expect(page.locator('[data-sheet-name]')).toHaveText(name!);
  await expect(page.locator('[data-sheet-command]')).toHaveText(command!);
  expect(await page.evaluate(() => !!document.activeElement?.closest('#install-sheet'))).toBe(true);

  const copy = page.locator('[data-sheet-copy]');
  await copy.click();
  await expect(copy).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(get).toBeFocused();

  // Reopening resets the copy label; a click on the backdrop closes it.
  await get.click();
  await expect(copy).toHaveText('Copy command');
  await page.mouse.click(20, 20);
  await expect(sheet).toBeHidden();
});

test('sheet: a modifier click opens the app page instead', async ({ page, context }) => {
  await page.goto('/app/rectangle');
  const get = page.locator('.similar a[data-get]').first();
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    get.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(page.locator('#install-sheet')).toBeHidden();
  // The new tab starts at about:blank before it navigates.
  await popup.waitForURL(/#install$/);
});

test('sheet: community packages say they are not reviewed by Homebrew', async ({ page }) => {
  await page.goto('/charts');
  await page.locator('#tab-community').click();
  const get = page.locator('#panel-community a[data-get]').first();
  await get.click();
  await expect(page.locator('[data-sheet-command]')).toHaveText(
    (await get.getAttribute('data-command'))!,
  );
  await expect(page.locator('[data-sheet-community]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#tab-mac-apps').click();
  await page.locator('#panel-mac-apps a[data-get]').first().click();
  await expect(page.locator('[data-sheet-community]')).toBeHidden();
});

test.describe('at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('sheet fits the screen', async ({ page }) => {
    await page.goto('/app/nikitabobko/tap/aerospace');
    await page.locator('.similar a[data-get]').first().click();
    const sheet = page.locator('#install-sheet');
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('Get goes to the install card on the app page', async ({ page }) => {
    await page.goto('/app/rectangle');
    await page.locator('.similar a[data-get]').first().click();
    await page.waitForURL(/#install$/);
  });
});
