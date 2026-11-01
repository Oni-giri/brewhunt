import { describe, expect, it } from 'vitest';
import { Robots } from '../../scripts/crawl/robots.ts';

const AGENT = 'brewhunt-crawler';

describe('Robots', () => {
  it('uses the * group when no group names us', () => {
    const robots = Robots.parse(
      'User-agent: *\nDisallow: /private\n\nUser-agent: Googlebot\nDisallow: /',
      AGENT,
    );
    expect(robots.allows('/')).toBe(true);
    expect(robots.allows('/private/x')).toBe(false);
  });

  it('uses only our own groups when one names us', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: brewhunt-crawler\nDisallow: /admin\n';
    const robots = Robots.parse(text, AGENT);
    expect(robots.allows('/')).toBe(true);
    expect(robots.allows('/admin')).toBe(false);
  });

  it('shares rules among consecutive user-agent lines', () => {
    const robots = Robots.parse(
      'User-agent: other\nUser-agent: *\nDisallow: /x\nUser-agent: third\nDisallow: /',
      AGENT,
    );
    expect(robots.allows('/x')).toBe(false);
    expect(robots.allows('/y')).toBe(true);
  });

  it('lets the longest rule win, and Allow win a tie', () => {
    const robots = Robots.parse(
      'User-agent: *\nDisallow: /docs\nAllow: /docs/public\nDisallow: /a\nAllow: /a',
      AGENT,
    );
    expect(robots.allows('/docs/secret')).toBe(false);
    expect(robots.allows('/docs/public/page')).toBe(true);
    expect(robots.allows('/a')).toBe(true);
  });

  it('handles * and $', () => {
    const robots = Robots.parse('User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?session=', AGENT);
    expect(robots.allows('/files/a.pdf')).toBe(false);
    expect(robots.allows('/files/a.pdf.html')).toBe(true);
    expect(robots.allows('/page?session=1')).toBe(false);
  });

  it('treats an empty Disallow as no rule, and ignores comments and other lines', () => {
    const robots = Robots.parse(
      '# hi\nUser-agent: * # everyone\nDisallow:\nCrawl-delay: 10\nSitemap: /s.xml',
      AGENT,
    );
    expect(robots.allows('/anything')).toBe(true);
  });

  it('always allows /robots.txt, and nothing when blocked', () => {
    expect(Robots.parse('User-agent: *\nDisallow: /', AGENT).allows('/robots.txt')).toBe(true);
    expect(Robots.disallowAll().allows('/')).toBe(false);
    expect(Robots.allowAll().allows('/')).toBe(true);
  });
});
