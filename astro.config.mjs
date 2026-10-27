// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://brewhunt.app',
  output: 'static',
  // Emit discover.html rather than discover/index.html so URLs have no trailing slash; Cloudflare
  // Pages, Netlify and GitHub Pages all serve /discover from discover.html.
  build: { format: 'file' },
  trailingSlash: 'never',
  // Until the landing page ships (M4). Astro emits a meta-refresh page so this works on any
  // static host; public/_redirects turns it into a real 302 on Cloudflare Pages.
  redirects: { '/': '/discover' },
});
