import { describe, expect, it } from 'vitest';
import { makerSite, pageLogos, rawGitHub, readmeLogos } from '../../scripts/crawl/logos.ts';

describe('pageLogos', () => {
  const page = 'https://tool.test/docs/';

  it('finds images marked as the logo, then images in the header', () => {
    const html = `<html><body>
      <header><a href="/"><img src="/img/mark.png"></a></header>
      <main><img src="/shot.png"><img class="site-logo" src="logo-full.svg" alt="Tool"></main>
    </body></html>`;
    expect(pageLogos(html, page)).toEqual([
      { url: 'https://tool.test/docs/logo-full.svg', marked: true },
      { url: 'https://tool.test/img/mark.png', marked: false },
    ]);
  });

  it("skips other people's logos", () => {
    const html = `<section class="customers"><img src="/acme-logo.png"></section>
      <div class="sponsor-logos"><img src="/s.png" class="logo"></div>`;
    expect(pageLogos(html, page)).toEqual([]);
  });

  it('keeps an inline SVG logo, adding the namespace it needs as a file', () => {
    const html = `<nav><a href="https://tool.test/" aria-label="Tool home"><svg viewBox="0 0 8 8"><path d="M0 0h8v8z"/><svg><rect/></svg></svg></a></nav>`;
    const [logo, ...rest] = pageLogos(html, page);
    expect(rest).toEqual([]);
    expect(logo.url).toBe('https://tool.test/docs/#svg-1');
    expect(logo.marked).toBe(false);
    expect(logo.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 8 8">/);
  });

  it('ignores SVGs that are neither marked nor in the header, and data URIs', () => {
    const html = `<main><svg class="icon-arrow"><path/></svg><img class="logo" src="data:image/png;base64,AA"></main>`;
    expect(pageLogos(html, page)).toEqual([]);
  });

  it('reads data-src and srcset when src is missing', () => {
    const html = `<img class="logo" data-src="/a.png"><img alt="Tool logo" srcset="/b.png 1x, /b@2x.png 2x">`;
    expect(pageLogos(html, page).map((l) => l.url)).toEqual([
      'https://tool.test/a.png',
      'https://tool.test/b.png',
    ]);
  });
});

describe('readmeLogos', () => {
  it('takes images named as logos, then the first image, never badges or avatars', () => {
    const md = `<p align="center"><img src="docs/banner.png"></p>
[![CI](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](x)
![](https://avatars.githubusercontent.com/u/1)
![Tool](assets/tool-logo.svg)
![sponsor logo](https://sponsor.test/logo.png)
![screenshot](docs/shot.png)`;
    expect(readmeLogos(md, 'o/r')).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/assets/tool-logo.svg',
      'https://raw.githubusercontent.com/o/r/HEAD/docs/banner.png',
    ]);
  });
});

describe('makerSite', () => {
  it.each([
    ['https://cli.github.com/', 'https://github.com/'],
    ['https://docs.ansible.com/projects/lint/', 'https://ansible.com/'],
    ['https://www.tool.co.uk/x', null],
    ['https://docs.tool.co.uk/x', 'https://tool.co.uk/'],
    ['https://tool.test/', null],
    ['https://www.tool.test/', null],
    ['https://facebook.github.io/watchman/', null],
    ['https://tool.readthedocs.io/', null],
    ['https://github.com/microsoft/git', null],
    ['https://www.gnu.org/software/sed/', null],
    [null, null],
  ])('%s → %s', (homepage, expected) => {
    expect(makerSite(homepage)).toBe(expected);
  });
});

describe('rawGitHub', () => {
  it.each([
    [
      'https://github.com/shirok/Gauche/raw/refs/heads/master/icons/gauche_logo.svg',
      'https://raw.githubusercontent.com/shirok/Gauche/master/icons/gauche_logo.svg',
    ],
    [
      'https://github.com/a/b/blob/main/logo.png?raw=true',
      'https://raw.githubusercontent.com/a/b/main/logo.png',
    ],
    ['https://github.com/a/b', 'https://github.com/a/b'],
    ['https://example.com/a/b/raw/main/x.png', 'https://example.com/a/b/raw/main/x.png'],
  ])('%s → %s', (url, expected) => {
    expect(rawGitHub(url)).toBe(expected);
  });
});
