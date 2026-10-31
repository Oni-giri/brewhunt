// /developers: reached from the header and footer, quotes Homebrew's rules with a link to them,
// and says what it takes to be among the listed taps.

import { expect, test } from './fixtures.ts';

test('the header and footer lead to /developers', async ({ page }) => {
  await page.goto('/discover');
  const nav = page.locator('.nav-links a', { hasText: 'For developers' });
  await expect(nav).toHaveAttribute('href', '/developers');
  await expect(page.locator('footer a', { hasText: 'Sponsor Brewhunt' })).toHaveAttribute(
    'href',
    '/developers#sponsor',
  );
  await nav.click();
  await page.waitForURL(/\/developers$/);
  await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText('For developers');
});

test("quotes Homebrew's notability rule and links to it", async ({ page }) => {
  await page.goto('/developers');
  const quote = page.locator('blockquote');
  await expect(quote).toContainText('at least 30 forks, 30 watchers or 75 stars');
  await expect(quote).toHaveAttribute(
    'cite',
    'https://docs.brew.sh/Package-Acceptance-Policy#notability',
  );
  await expect(
    page.locator('a[href="https://docs.brew.sh/Package-Acceptance-Policy#notability"]'),
  ).toBeVisible();
});

test('says how many installs the 100th tap has, and has the tap command', async ({ page }) => {
  await page.goto('/developers');
  await expect(page.locator('#tap-title').locator('..')).toContainText(/the 100th has [\d,]+\./);
  await expect(page.locator('[data-copy="brew tap-new you/homebrew-tap"]')).toBeVisible();
});

test('jump links reach each section', async ({ page }) => {
  await page.goto('/developers');
  for (const id of ['homebrew', 'claim', 'sponsor']) {
    await expect(page.locator(`.jump a[href="#${id}"]`)).toBeVisible();
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
});
