// One sitemap for every page (about 14k URLs; the limit per file is 50,000).
import type { APIContext } from 'astro';
import { getCatalog, tapUrl } from '../lib/catalog';

export function GET({ site }: APIContext) {
  const { entries, taps, categories, meta } = getCatalog();
  const lastmod = meta.generatedOn;
  const paths = [
    '/discover',
    '/charts',
    '/new',
    ...categories.map((c) => `/category/${c.slug}`),
    ...taps.map((t) => tapUrl(t.id)).filter((url): url is string => url !== null),
    ...entries.filter((e) => e.hasPage).map((e) => e.url),
  ];
  const urls = paths.map(
    (path) =>
      `<url><loc>${new URL(path, site).href.replaceAll('&', '&amp;')}</loc><lastmod>${lastmod}</lastmod></url>`,
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
