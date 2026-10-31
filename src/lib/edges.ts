// Rows that scroll sideways on narrow screens (tab bars, the app page's facts strip): the side
// scrolled out of sight fades (global.css, [data-overflow]), and a row that scrolls can take
// keyboard focus so it can be scrolled without a mouse.

/** Keeps `row`'s fades in step with its scroll position and size. */
export function fadeEdges(row: HTMLElement, focusable = false) {
  const update = () => {
    const start = row.scrollLeft > 1;
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    if (start || end) row.dataset.overflow = start && end ? 'both' : start ? 'start' : 'end';
    else delete row.dataset.overflow;
    if (focusable) {
      if (start || end) row.tabIndex = 0;
      else row.removeAttribute('tabindex');
    }
  };
  row.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(row);
  update();
  return update;
}
