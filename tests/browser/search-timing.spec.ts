// Search must feel instant on a slow machine: with the CPU slowed 4× and a cold cache, the first
// results for a query appear within 1s of the first keystroke (median of 5 runs). The time to
// download and prepare the index is reported alongside, without a budget.

import { expect, searchReady, test } from './fixtures.ts';

const RUNS = 5;
const BUDGET_MS = 1000;
const QUERY = 'video player';

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test('first results within 1s of the first keystroke (4× CPU throttle)', async ({ browser }) => {
  test.slow();
  const typing: number[] = [];
  const loading: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    // A fresh context each run: nothing cached.
    const context = await browser.newContext();
    await context.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.goto('/search');
    await searchReady(page);
    loading.push(await page.evaluate(() => performance.now()));

    // Timed in the page: first keydown → the results heading shows the query with rows under it.
    await page.evaluate((query) => {
      const input = document.querySelector<HTMLInputElement>('#search-q')!;
      const w = window as unknown as { t0?: number; t1?: number };
      input.addEventListener('keydown', () => (w.t0 ??= performance.now()), { once: true });
      new MutationObserver((_, observer) => {
        const title = document.querySelector('h1')?.textContent ?? '';
        if (title.includes(query) && document.querySelector('[data-list] > li.card')) {
          w.t1 = performance.now();
          observer.disconnect();
        }
      }).observe(document.querySelector('[data-search-page]')!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }, QUERY);
    await page.locator('#search-q').pressSequentially(QUERY);
    const elapsed = await page
      .waitForFunction(() => {
        const w = window as unknown as { t0?: number; t1?: number };
        return w.t1 !== undefined && w.t0 !== undefined && w.t1 - w.t0;
      })
      .then((handle) => handle.jsonValue() as Promise<number>);
    typing.push(elapsed);
    await context.close();
  }
  const report = `keystroke → results: ${typing.map(Math.round).join(', ')} ms (median ${Math.round(median(typing))}); page load → index ready: ${loading.map(Math.round).join(', ')} ms`;
  test.info().annotations.push({ type: 'timing', description: report });
  console.log(report);
  expect(median(typing), report).toBeLessThanOrEqual(BUDGET_MS);
});
