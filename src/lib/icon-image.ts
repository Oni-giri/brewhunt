// The <img> AppIcon.astro renders, for scripts that draw icons (install sheet, search results),
// and the fallback to the tile when an icon fails to load.

/** Drops a failed icon so the tile under it shows. */
function fallBack(img: HTMLImageElement): void {
  img.parentElement?.classList.remove('has-icon');
  img.remove();
}

/**
 * Hands every AppIcon whose image fails back to its tile: those that fail from now on (error
 * events don't bubble, so this listens while they go down), and those that failed before this
 * module ran (a broken image is `complete` with no size; one still loading isn't complete).
 */
export function watchIconFailures(): void {
  document.addEventListener(
    'error',
    (event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement && img.parentElement?.classList.contains('app-icon'))
        fallBack(img);
    },
    true,
  );
  for (const img of document.querySelectorAll<HTMLImageElement>('.app-icon > img'))
    if (img.complete && img.naturalWidth === 0) fallBack(img);
}

/** An icon image that hands back to the tile under it if it fails to load. */
export function iconImage(src: string, size: number): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.width = img.height = size;
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => fallBack(img));
  return img;
}
