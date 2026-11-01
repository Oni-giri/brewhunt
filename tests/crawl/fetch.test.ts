import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FetchError,
  SafeFetcher,
  isPublicAddress,
  sniffImage,
  type FetcherOptions,
} from '../../scripts/crawl/fetch.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('isPublicAddress', () => {
  it.each([
    ['93.184.215.14', true],
    ['140.82.112.3', true],
    ['2606:4700::6810:84e5', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.72.225.32', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['198.18.0.1', false],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['ff02::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:93.184.215.14', false],
    ['64:ff9b::a00:1', false],
    ['2002:a00:1::', false],
    ['2001:db8::1', false],
    ['not an address', false],
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe('sniffImage', () => {
  it('reads formats from bytes', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('ico');
    expect(
      sniffImage(
        Buffer.from(
          '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
      ),
    ).toBe('svg');
    expect(sniffImage(Buffer.from('<html><svg/></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('hello'))).toBeNull();
  });
});

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchError) return error.reason;
    throw error;
  }
  return 'ok';
};

describe('URLs and addresses the default policy refuses', () => {
  const fetcher = new SafeFetcher({ robots: false, hostIntervalMs: 0 });
  // No request is made for any of these: the check comes first.
  it.each([
    ['ftp://example.com/', 'url'],
    ['file:///etc/passwd', 'url'],
    ['https://user:pw@example.com/', 'url'],
    ['https://example.com:8080/', 'url'],
    ['http://localhost/', 'address'],
    ['http://app.localhost/', 'address'],
    ['http://127.0.0.1/', 'address'],
    ['http://0x7f.1/', 'address'],
    ['http://[::1]/', 'address'],
    ['http://[::ffff:7f00:1]/', 'address'],
    ['http://169.254.169.254/latest/meta-data/', 'address'],
    ['http://100.100.100.100/', 'address'],
    ['not a url', 'url'],
  ])('%s → %s', async (url, expected) => {
    expect(await reason(fetcher.get(url, 'html'))).toBe(expected);
  });

  it('refuses a host if any of its addresses is private', async () => {
    const mixed = new SafeFetcher({
      robots: false,
      resolve: async () => [
        { address: '93.184.215.14', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    });
    expect(await reason(mixed.get('https://rebind.test/', 'html'))).toBe('address');
  });
});

describe('against a local server', () => {
  let server: Server;
  let port: number;
  let robotsTxt: { status: number; body: string } = { status: 404, body: '' };
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      hits.push(path);
      const html = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (path === '/robots.txt') {
        res.writeHead(robotsTxt.status, { 'content-type': 'text/plain' });
        return res.end(robotsTxt.body);
      }
      if (path === '/page') return html('<title>Hi</title>');
      if (path.startsWith('/hop/')) {
        const left = Number(path.slice(5));
        res.writeHead(302, { location: left > 0 ? `/hop/${left - 1}` : '/page' });
        return res.end();
      }
      if (path === '/to-private') {
        res.writeHead(301, { location: `http://private.test:${port}/page` });
        return res.end();
      }
      if (path === '/png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      if (path === '/fake-png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end('<html>not an image</html>');
      }
      if (path === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(Buffer.alloc(3_000_000, 'a'));
      }
      if (path === '/big-unannounced') {
        res.writeHead(200, { 'content-type': 'text/html', 'transfer-encoding': 'chunked' });
        for (let i = 0; i < 30; i++) res.write(Buffer.alloc(100_000, 'a'));
        return res.end();
      }
      if (path === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        return res.end(gzipSync('<p>compressed</p>'));
      }
      if (path === '/bomb') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        return res.end(gzipSync(Buffer.alloc(20_000_000)));
      }
      if (path === '/missing') {
        res.writeHead(404);
        return res.end();
      }
      if (path === '/slow') return; // never answers
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  // site.test only exists in this table, so reaching it at all shows the connection goes to the
  // checked address, not to a fresh DNS answer.
  const make = (options: FetcherOptions = {}) =>
    new SafeFetcher({
      resolve: async (host) => [
        { address: host === 'site.test' ? '127.0.0.1' : '10.0.0.9', family: 4 },
      ],
      allowAddress: (address) => address === '127.0.0.1',
      allowPort: (p) => p === port,
      hostIntervalMs: 0,
      robots: false,
      ...options,
    });
  const url = (path: string) => `http://site.test:${port}${path}`;

  it('fetches a page from the pinned address', async () => {
    const page = await make().get(url('/page'), 'html');
    expect(page.body.toString()).toBe('<title>Hi</title>');
    expect(page.contentType).toBe('text/html; charset=utf-8');
  });

  it('follows up to 3 redirects and reports where it landed', async () => {
    const page = await make().get(url('/hop/2'), 'html');
    expect(page.url).toBe(url('/page'));
    expect(await reason(make().get(url('/hop/3'), 'html'))).toBe('redirects');
  });

  it('checks every redirect target', async () => {
    expect(await reason(make().get(url('/to-private'), 'html'))).toBe('address');
  });

  it('checks types: HTML for pages, image bytes for images', async () => {
    expect(await reason(make().get(url('/png'), 'html'))).toBe('type');
    expect((await make().get(url('/png'), 'image')).format).toBe('png');
    expect(await reason(make().get(url('/fake-png'), 'image'))).toBe('type');
  });

  it('stops at the size cap, announced or not, compressed or not', async () => {
    expect(await reason(make().get(url('/big'), 'html'))).toBe('size');
    expect(await reason(make().get(url('/big-unannounced'), 'html'))).toBe('size');
    expect(await reason(make().get(url('/bomb'), 'html'))).toBe('size');
    expect((await make().get(url('/gzip'), 'html')).body.toString()).toBe('<p>compressed</p>');
  });

  it('reports HTTP errors and timeouts', async () => {
    const error = await make()
      .get(url('/missing'), 'html')
      .catch((e: FetchError) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).status).toBe(404);
    expect(await reason(make({ timeoutMs: 200 }).get(url('/slow'), 'html'))).toBe('timeout');
  });

  it('obeys robots.txt, and stays out when robots.txt fails', async () => {
    robotsTxt = { status: 200, body: 'User-agent: *\nDisallow: /page\n' };
    expect(await reason(make({ robots: true }).get(url('/page'), 'html'))).toBe('robots');
    expect(await reason(make({ robots: true }).get(url('/png'), 'image'))).toBe('ok');
    robotsTxt = { status: 503, body: '' };
    expect(await reason(make({ robots: true }).get(url('/png'), 'image'))).toBe('robots');
    robotsTxt = { status: 404, body: '' };
    expect(await reason(make({ robots: true }).get(url('/page'), 'html'))).toBe('ok');
  });

  it('reads robots.txt once per origin', async () => {
    robotsTxt = { status: 200, body: 'User-agent: *\nAllow: /\n' };
    const fetcher = make({ robots: true });
    hits.length = 0;
    await fetcher.get(url('/page'), 'html');
    await fetcher.get(url('/png'), 'image');
    expect(hits).toEqual(['/robots.txt', '/page', '/png']);
  });

  it('waits between requests to the same host', async () => {
    const fetcher = make({ hostIntervalMs: 150 });
    const start = Date.now();
    await Promise.all([fetcher.get(url('/page'), 'html'), fetcher.get(url('/page'), 'html')]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  });
});
