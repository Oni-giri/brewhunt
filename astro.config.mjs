// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://brewhunt.app',
  output: 'static',
  // Emit discover.html rather than discover/index.html so URLs have no trailing slash; Cloudflare
  // Pages, Netlify and GitHub Pages all serve /discover from discover.html.
  // Stylesheets as files, never inlined: the Content-Security-Policy (public/_headers) allows no
  // inline styles or scripts.
  build: { format: 'file', inlineStylesheets: 'never' },
  trailingSlash: 'never',
  // Scripts as files too, and no assets as data: URLs.
  vite: { build: { assetsInlineLimit: 0 } },
});
