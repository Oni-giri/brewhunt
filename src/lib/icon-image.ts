// The <img> AppIcon.astro renders, for scripts that draw icons (install sheet, search results).

/** An icon image that hands back to the tile under it if it fails to load. */
export function iconImage(src: string, size: number): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.width = img.height = size;
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.parentElement?.classList.remove('has-icon');
    img.remove();
  });
  return img;
}
