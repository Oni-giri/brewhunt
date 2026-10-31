// Tabs (WAI-ARIA tablist) for the charts, /new and the installs chart: click or arrow keys, Home
// and End select a tab. A thumb slides under the selected tab, its label turns bold as the thumb
// arrives, and the panel it shows fades in; nothing moves under reduced motion. A list too wide
// for the screen scrolls, with its hidden end faded. The styles are in global.css.

import { fadeEdges } from './edges';

const FADE_MS = 150;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const panelOf = (tab: HTMLElement) =>
  document.getElementById(tab.getAttribute('aria-controls') ?? '');

/**
 * Wires up the tabs in `list`. Each tab shows the panel its aria-controls names (several tabs may
 * share one panel, as on /new); `onSelect` runs after the selection changes.
 */
export function tabs(list: HTMLElement, onSelect?: (tab: HTMLButtonElement) => void) {
  const all = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  if (all.length === 0) return;
  let current = all.find((t) => t.getAttribute('aria-selected') === 'true') ?? all[0];

  const thumb = document.createElement('span');
  thumb.className = 'tab-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  list.prepend(thumb);
  list.classList.add('has-thumb');
  // Each tab reserves its bold width, so turning bold doesn't move the tabs (global.css).
  for (const tab of all) tab.dataset.label = tab.textContent?.trim() ?? '';

  const place = () => {
    thumb.style.width = `${current.offsetWidth}px`;
    thumb.style.transform = `translateX(${current.offsetLeft}px)`;
  };
  place();
  // Slides from then on, not into its first place.
  requestAnimationFrame(() => thumb.classList.add('ready'));
  // Widths change when the font loads, the page resizes or a hidden list appears.
  const edges = fadeEdges(list);
  const observer = new ResizeObserver(() => {
    place();
    edges();
  });
  observer.observe(list);
  for (const tab of all) observer.observe(tab);

  const select = (tab: HTMLButtonElement) => {
    if (tab === current) return;
    current = tab;
    const shown = panelOf(tab);
    for (const t of all) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = panelOf(t);
      if (panel && panel !== shown) panel.hidden = true;
    }
    if (shown) shown.hidden = false;
    onSelect?.(tab);
    place();
    tab.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: still() ? 'auto' : 'smooth',
    });
    if (shown && !still()) {
      shown.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
    }
  };

  all.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = all[(next + all.length) % all.length];
      select(target);
      target.focus();
    });
  });
}
