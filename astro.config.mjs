// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://brewhunt.app',
  output: 'static',
  // Emit discover.html rather than discover/index.html so URLs have no trailing slash; Cloudflare
  // Pages, Netlify and GitHub Pages all serve /discover from discover.html.
  build: { format: 'file' },
  trailingSlash: 'never',
});
