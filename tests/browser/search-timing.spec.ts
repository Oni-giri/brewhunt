// Search must feel instant on a slow machine: with the CPU slowed 4× and a cold cache, the first
// results for a query appear within 1s of the first keystroke (median of 5 runs). The index
// download is held until that keystroke, so the time includes downloading and preparing it, as
// for someone who starts typing as soon as the page appears. (The local server makes the download
// itself near-instant; the budget covers parsing, preparing, scoring and rendering.)

import { expect, test } from './fixtures.ts';

const RUNS = 5;
const BUDGET_MS = 1000;
const QUERY = 'video player';

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test('first results within 1s of the first keystroke (4× CPU throttle)', async ({ browser }) => {
  test.slow();
  const times: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    // A fresh context each run: nothing cached.
    const context = await browser.newContext();
    await context.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
    let release!: () => void;
    const keystroke = new Promise<void>((resolve) => (release = resolve));
    await context.route('**/search-index.json?*', async (route) => {
      await keystroke;
      await route.continue();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/search');

    // Timed in the page: first keydown → the index is in and the query's rows are on screen.
    await page.evaluate((query) => {
      const w = window as unknown as { t0?: number; t1?: number };
      const input = document.querySelector<HTMLInputElement>('#search-q')!;
      const results = document.querySelector('[data-results]')!;
      input.addEventListener('keydown', () => (w.t0 ??= performance.now()), { once: true });
      new MutationObserver((_, observer) => {
        const title = document.querySelector('h1')?.textContent ?? '';
        if (
          title.includes(query) &&
          !results.hasAttribute('aria-busy') &&
          document.querySelector('[data-list] > li.card')
        ) {
          w.t1 = performance.now();
          observer.disconnect();
        }
      }).observe(document.querySelector('[data-search-page]')!, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }, QUERY);
    const input = page.locator('#search-q');
    await input.press(QUERY[0]);
    release();
    await input.pressSequentially(QUERY.slice(1));
    const elapsed = await page
      .waitForFunction(() => {
        const w = window as unknown as { t0?: number; t1?: number };
        return w.t1 !== undefined && w.t0 !== undefined && w.t1 - w.t0;
      })
      .then((handle) => handle.jsonValue() as Promise<number>);
    times.push(elapsed);
    await context.close();
  }
  const report = `first keystroke → results, cold: ${times.map(Math.round).join(', ')} ms (median ${Math.round(median(times))})`;
  test.info().annotations.push({ type: 'timing', description: report });
  console.log(report);
  expect(median(times), report).toBeLessThanOrEqual(BUDGET_MS);
});
