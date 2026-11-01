import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  capBytes,
  decodeEntities,
  hamming,
  homepageIcons,
  isBadge,
  largestSize,
  libraryIcons,
  manifestIcons,
  nameKeys,
  pointsBack,
  readLibraries,
  readPage,
  readmeImages,
  repoFromHomepage,
  sharedImages,
} from '../../scripts/crawl/extract.ts';
import { detailsQuery, readDetails } from '../../scripts/crawl/github.ts';
import { icoSize, measure } from '../../scripts/crawl/images.ts';

const PAGE = `<!doctype html><html><head>
<title> Rectangle &amp; friends </title>
<meta name="description" content="Move and resize windows">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" sizes="192x192" href="https://cdn.example.com/icon-192.png">
<link rel="icon" href="/logo.svg">
<link rel="manifest" href="/site.webmanifest">
<style>body { color: red }</style><script>var hidden = "no";</script>
</head><body>
<nav>Home Docs</nav>
<h1>Rectangle</h1><p>Window   management
 for macOS.</p>
<a href="https://github.com/rxhanson/Rectangle">Source</a>
<a href="https://github.com/rxhanson/Rectangle/releases">Releases</a>
<a href="https://github.com/sponsors/rxhanson">Sponsor</a>
<a href="https://github.com/other/thing">Other</a>
<footer>© 2026</footer>
</body></html>`;

describe('readPage', () => {
  const page = readPage(PAGE, 'https://rectangleapp.com/');

  it('reads the title, description and visible text', () => {
    expect(page.title).toBe('Rectangle & friends');
    expect(page.description).toBe('Move and resize windows');
    expect(page.text).toBe('Rectangle Window management for macOS. Source Releases Sponsor Other');
  });

  it('collects icons with their declared sizes, and the manifest', () => {
    expect(page.icons).toEqual([
      {
        url: 'https://rectangleapp.com/apple-touch-icon.png',
        rel: 'apple-touch-icon',
        size: 180,
        type: null,
      },
      { url: 'https://rectangleapp.com/favicon-32.png', rel: 'icon', size: 32, type: 'image/png' },
      { url: 'https://cdn.example.com/icon-192.png', rel: 'icon', size: 192, type: null },
      { url: 'https://rectangleapp.com/logo.svg', rel: 'icon', size: null, type: 'image/svg+xml' },
    ]);
    expect(page.manifest).toBe('https://rectangleapp.com/site.webmanifest');
  });

  it('lists linked GitHub repositories once, in order, and nothing that isn’t one', () => {
    expect(page.repoKeys).toEqual(['rxhanson/rectangle', 'other/thing']);
  });

  it('reads text when the head is in capitals, and an immediate meta refresh', () => {
    const shouting = readPage(
      '<HEAD><TITLE>Nmap</TITLE></HEAD><body><p>Port scanner</p></body>',
      'https://nmap.test/',
    );
    expect(shouting.title).toBe('Nmap');
    expect(shouting.text).toBe('Port scanner');
    const forward = readPage(
      '<meta http-equiv="refresh" content="0; url=https://github.com/tmux/tmux/wiki"/>',
      'https://tmux.test/',
    );
    expect(forward.refresh).toBe('https://github.com/tmux/tmux/wiki');
    expect(
      readPage('<meta http-equiv="refresh" content="300">', 'https://x.test/').refresh,
    ).toBeNull();
    expect(page.refresh).toBeNull();
  });

  it('ignores javascript: and data: links', () => {
    const odd = readPage(
      '<link rel="icon" href="javascript:alert(1)"><link rel="icon" href="data:image/png;base64,AA">',
      'https://x.test/',
    );
    expect(odd.icons).toEqual([]);
  });

  it('caps the text at 20 KB', () => {
    const long = readPage(`<p>${'word '.repeat(10_000)}</p>`, 'https://x.test/');
    expect(Buffer.byteLength(long.text)).toBeLessThanOrEqual(20_000);
    expect(long.text.endsWith('word')).toBe(true);
  });
});

describe('small helpers', () => {
  it('decodes entities', () => {
    expect(decodeEntities('a &amp; b &#39;c&#x27; &lt;d&gt; &bogus;')).toBe(
      "a & b 'c' <d> &bogus;",
    );
  });

  it('reads declared sizes', () => {
    expect(largestSize('16x16 180x180')).toBe(180);
    expect(largestSize('any')).toBe(Infinity);
    expect(largestSize(undefined)).toBeNull();
    expect(largestSize('big')).toBeNull();
  });

  it('cuts text on a character boundary', () => {
    expect(Buffer.byteLength(capBytes('é'.repeat(20), 9))).toBeLessThanOrEqual(9);
    expect(capBytes('short', 100)).toBe('short');
  });

  it('squashes a package’s names', () => {
    expect(nameKeys('visual-studio-code', 'Microsoft Visual Studio Code')).toEqual([
      'visualstudiocode',
      'microsoftvisualstudiocode',
    ]);
    expect(nameKeys('python@3.14', 'python@3.14')).toEqual(['python', 'python314']);
    expect(nameKeys('github-desktop', 'GitHub Desktop')).toEqual(['githubdesktop', 'github']);
  });
});

describe('manifestIcons', () => {
  it('keeps ordinary icons, resolved against the manifest', () => {
    const icons = manifestIcons(
      {
        icons: [
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'mask.png', sizes: '512x512', purpose: 'maskable' },
          { src: 'both.png', sizes: '192x192', purpose: 'any maskable' },
          { src: 42 },
        ],
      },
      'https://x.test/static/site.webmanifest',
    );
    expect(icons.map((i) => i.url)).toEqual([
      'https://x.test/static/icon-512.png',
      'https://x.test/static/both.png',
    ]);
  });

  it('survives anything that isn’t a manifest', () => {
    expect(manifestIcons(null, 'https://x.test/m')).toEqual([]);
    expect(manifestIcons({ icons: 'no' }, 'https://x.test/m')).toEqual([]);
  });
});

describe('repositories linked from a homepage', () => {
  it('accept the same host or one inside the other', () => {
    expect(pointsBack('https://rectangleapp.com', 'https://www.rectangleapp.com/')).toBe(true);
    expect(pointsBack('https://docs.example.com/x', 'https://example.com')).toBe(true);
    expect(pointsBack('https://other.com', 'https://example.com')).toBe(false);
    expect(pointsBack(null, 'https://example.com')).toBe(false);
  });

  it('never accept a code host as the shared domain', () => {
    expect(pointsBack('https://github.com/a/b', 'https://github.com/a/b')).toBe(false);
    expect(pointsBack('https://example.sourceforge.net', 'https://example.sourceforge.net')).toBe(
      false,
    );
  });

  it('take the first that points back and isn’t a fork', () => {
    const lookup = new Map([
      ['a/fork', { nameWithOwner: 'a/fork', isFork: true, homepageUrl: 'https://app.test' }],
      [
        'b/elsewhere',
        { nameWithOwner: 'b/elsewhere', isFork: false, homepageUrl: 'https://other.test' },
      ],
      ['c/app', { nameWithOwner: 'C/App', isFork: false, homepageUrl: 'https://app.test/' }],
    ]);
    expect(
      repoFromHomepage('https://app.test', ['a/fork', 'b/elsewhere', 'missing/x', 'c/app'], lookup),
    ).toBe('C/App');
    expect(repoFromHomepage('https://nope.test', ['c/app'], lookup)).toBeNull();
  });
});

describe('icon candidates', () => {
  const page = readPage(PAGE, 'https://rectangleapp.com/');

  it('rank the homepage’s own icons, big ones only', () => {
    const icons = homepageIcons('https://rectangleapp.com/', page, [
      { url: 'https://rectangleapp.com/512.png', size: 512, type: 'image/png' },
      { url: 'https://rectangleapp.com/64.png', size: 64, type: 'image/png' },
    ]);
    expect(icons.map((i) => `${i.source} ${i.url}`)).toEqual([
      'apple-touch-icon https://rectangleapp.com/apple-touch-icon.png',
      'manifest https://rectangleapp.com/512.png',
      'page-icon https://cdn.example.com/icon-192.png',
      'svg-icon https://rectangleapp.com/logo.svg',
    ]);
  });

  it('guess /apple-touch-icon.png on the page’s own origin when none is declared', () => {
    const bare = readPage(
      '<link rel="icon" href="https://cdn.test/f.ico">',
      'https://www.app.test/home',
    );
    expect(homepageIcons('https://app.test', bare, [])).toEqual([
      {
        source: 'touch-icon-default',
        url: 'https://www.app.test/apple-touch-icon.png',
        declared: null,
      },
    ]);
  });

  it('take nothing from code-host homepages', () => {
    const github = readPage(PAGE, 'https://github.com/rxhanson/Rectangle');
    expect(homepageIcons('https://github.com/rxhanson/Rectangle', github, [])).toEqual([]);
    expect(homepageIcons('https://www.gnu.org/software/wget/', github, [])).toEqual([]);
  });

  const libraries = readLibraries({
    devicon: [
      { name: 'docker', altnames: [], versions: { svg: ['original', 'plain'] } },
      { name: 'nodejs', altnames: ['node'], versions: { svg: ['plain'] } },
      { name: '../evil', versions: { svg: ['original'] } },
      { name: 'fontonly', versions: { svg: [] } },
    ],
    dashboard: { svg: ['docker.svg', 'docker-light.svg'], png: ['docker.png', 'gitea.png'] },
    simple: [
      { title: 'Docker', slug: 'docker' },
      { title: 'Visual Studio Code', slug: 'visualstudiocode' },
    ],
  });

  it('read library lists, refusing odd names', () => {
    expect([...libraries.devicon.keys()]).toEqual(['docker', 'nodejs', 'node']);
    expect(libraries.devicon.get('node')).toMatch(/icons\/nodejs\/nodejs-plain\.svg$/);
    expect(libraries.dashboard.get('docker')).toMatch(/\/svg\/docker\.svg$/);
    expect(libraries.dashboard.get('gitea')).toMatch(/\/png\/gitea\.png$/);
  });

  it('match libraries by exact name, with the organisation avatar before Simple Icons', () => {
    const icons = libraryIcons(nameKeys('docker', 'Docker'), libraries, {
      login: 'docker',
      isOrganization: true,
      avatarUrl: 'https://avatars.githubusercontent.com/u/5429470?s=256',
    });
    expect(icons.map((i) => i.source)).toEqual([
      'devicon',
      'dashboard-icons',
      'github-avatar',
      'simple-icons',
    ]);
  });

  it('skip a personal account’s or an unrelated organisation’s avatar', () => {
    const keys = nameKeys('rectangle', 'Rectangle');
    expect(
      libraryIcons(keys, libraries, {
        login: 'rectangle',
        isOrganization: false,
        avatarUrl: 'https://a.test/x',
      }),
    ).toEqual([]);
    expect(
      libraryIcons(keys, libraries, {
        login: 'rxhanson',
        isOrganization: true,
        avatarUrl: 'https://a.test/x',
      }),
    ).toEqual([]);
  });
});

describe('readmeImages', () => {
  const README = `# App
[![Build](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](x)
[![Downloads](https://img.shields.io/github/downloads/o/r/total)](x)
![Screenshot](docs/screen.png "Main window")
![Again](docs/screen.png)
![Blob](https://github.com/o/r/blob/main/img/blob.png?raw=true)
![Diagram](https://example.com/diagram.svg)
![Ref][shot]
<p align="center"><img src="https://user-images.githubusercontent.com/1/2.png" width="600" alt="Demo"></p>
<img src='logo.png' width=120>

[shot]: https://example.com/ref.png
`;

  it('finds screenshots in order, dropping badges, SVGs and images shown small', () => {
    expect(readmeImages(README, 'o/r').map((i) => i.url)).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/docs/screen.png',
      'https://raw.githubusercontent.com/o/r/main/img/blob.png',
      'https://example.com/ref.png',
      'https://user-images.githubusercontent.com/1/2.png',
    ]);
  });

  it('spots badges by host, path or alt text', () => {
    expect(isBadge('https://img.shields.io/x', '')).toBe(true);
    expect(isBadge('https://example.com/badges/ci.png', '')).toBe(true);
    expect(isBadge('https://example.com/a.png', 'Coverage badge')).toBe(true);
    expect(isBadge('https://example.com/a.png', 'User avatar: Dean')).toBe(true);
    expect(isBadge('https://example.com/a.png', 'Sponsored by Warp')).toBe(true);
    expect(isBadge('https://avatars.githubusercontent.com/u/1?v=4', '')).toBe(true);
    expect(isBadge('https://example.com/a.png', 'Screenshot')).toBe(false);
  });
});

describe('image hashes', () => {
  it('count differing bits', () => {
    expect(hamming('ffffffffffffffff', 'fffffffffffffffe')).toBe(1);
    expect(hamming('0000000000000000', '0000000000000000')).toBe(0);
  });

  it('flag pictures several packages share, not one package’s repeats', () => {
    const shared = sharedImages([
      { packageId: 'a', project: 'a.test', url: 'https://a.test/i.png', hash: 'ff00ff00ff00ff00' },
      { packageId: 'b', project: 'b.test', url: 'https://b.test/i.png', hash: 'ff00ff00ff00ff01' },
      { packageId: 'a', project: 'a.test', url: 'https://a.test/j.png', hash: 'ff00ff00ff00ff00' },
      { packageId: 'c', project: 'c.test', url: 'https://c.test/i.png', hash: '00ff00ff00ff00ff' },
      {
        packageId: 'c-tap',
        project: 'c.test',
        url: 'https://c.test/i.png',
        hash: '00ff00ff00ff00ff',
      },
    ]);
    expect(shared.get('a https://a.test/i.png')).toEqual(['b']);
    expect(shared.get('b https://b.test/i.png')).toEqual(['a']);
    // One project's packages (bun and oven-sh/bun/bun) may share an icon.
    expect(shared.has('c https://c.test/i.png')).toBe(false);
  });

  it('measure decoded images and read ICO directories', async () => {
    const png = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#3366ff' },
    })
      .png()
      .toBuffer();
    const measured = await measure(png, 'png');
    expect(measured).toMatchObject({ width: 200, height: 100, animated: false });
    expect(measured.hash).toMatch(/^[0-9a-f]{16}$/);
    // Two entries: 32px and 0 (= 256px).
    const ico = Buffer.alloc(6 + 32);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(2, 4);
    ico[6] = 32;
    ico[22] = 0;
    expect(icoSize(ico)).toBe(256);
  });

  it('refuse an image that would decode past the pixel limit', async () => {
    const huge = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect width="10" height="10"/></svg>`,
    );
    await expect(measure(huge, 'svg')).rejects.toThrow();
  });
});

describe('GitHub details', () => {
  it('build a query with every name as a variable, and refuse odd keys', () => {
    const { query, variables } = detailsQuery(['cli/cli', 'rxhanson/rectangle']);
    expect(variables).toEqual({ o0: 'cli', n0: 'cli', o1: 'rxhanson', n1: 'rectangle' });
    expect(query).toContain('HEAD:README.md');
    expect(() => detailsQuery(['a/b") { x }'])).toThrow();
  });

  it('read the first README found, and null for missing repositories', () => {
    const details = readDetails(['a/b', 'gone/x', 'unanswered/y'], {
      r0: {
        nameWithOwner: 'A/B',
        isFork: false,
        homepageUrl: '',
        owner: { __typename: 'Organization', login: 'A', avatarUrl: 'https://avatars.test/a' },
        m0: null,
        m1: { text: '# readme' },
        m2: { text: '# other' },
      },
      r1: null,
    });
    expect(details.get('a/b')).toEqual({
      nameWithOwner: 'A/B',
      isFork: false,
      homepageUrl: null,
      owner: { login: 'A', isOrganization: true, avatarUrl: 'https://avatars.test/a' },
      readme: '# readme',
    });
    expect(details.get('gone/x')).toBeNull();
    expect(details.has('unanswered/y')).toBe(false);
  });
});
