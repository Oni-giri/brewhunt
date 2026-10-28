// RSS feed of packages added to Homebrew (and the top community taps) in the last two weeks.
import type { APIContext } from 'astro';
import { getCatalog, kindLabel, recentlyAdded } from '../../lib/catalog';

const escape = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

export function GET({ site }: APIContext) {
  const { meta } = getCatalog();
  const entries = recentlyAdded(() => true, 14);
  const url = (path: string) => new URL(path, site).href;
  const items = entries.map((e) => {
    const source =
      e.source === 'official' ? "Homebrew's official catalog" : `the ${e.tap} community tap`;
    const description = `${e.desc ? `${e.desc}. ` : ''}${kindLabel(e)} from ${source}. Install with: ${e.installCommand}`;
    return `    <item>
      <title>${escape(e.name)}</title>
      <link>${url(e.url)}</link>
      <guid isPermaLink="true">${url(e.url)}</guid>
      <pubDate>${new Date(`${e.firstSeen}T12:00:00Z`).toUTCString()}</pubDate>
      <description>${escape(description)}</description>
    </item>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>New on Homebrew · Brewhunt</title>
    <link>${url('/new')}</link>
    <atom:link href="${url('/new/rss.xml')}" rel="self" type="application/rss+xml"/>
    <description>Apps and command-line tools added to Homebrew in the last two weeks.</description>
    <language>en</language>
    <lastBuildDate>${new Date(`${meta.generatedOn}T12:00:00Z`).toUTCString()}</lastBuildDate>
${items.join('\n')}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
}
