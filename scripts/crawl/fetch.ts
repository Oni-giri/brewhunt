// The crawler's only way out to the web. Every URL it follows comes from package data (homepages,
// README images, icon links), so each one is treated as hostile: http(s) on ports 80/443 only, no
// credentials, and the host resolved first and refused if any of its addresses is private,
// loopback, link-local (169.254.169.254, the cloud metadata service), multicast or reserved. The
// connection is then pinned to the address that was checked, so a second DNS answer can't swap it
// (DNS rebinding). Redirects are followed by hand, at most 3, each checked like a new URL.
// Downloads stop at 2 MB (after decompression) and 15 s; robots.txt is obeyed, with at most one
// request a second per host.
//
// Fixed API endpoints (GitHub's GraphQL in scripts/data/repos.ts) don't come from package data and
// keep their own client.

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { Robots } from './robots.ts';

export const USER_AGENT = 'brewhunt-crawler (+https://github.com/Oni-giri/brewhunt)';
export const MAX_BYTES = 2_000_000;
export const TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;
/** Time for one address to take the connection before the next is tried. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** Addresses tried per request. */
const MAX_ADDRESSES = 3;
/** Least time between two requests to the same host. */
export const HOST_INTERVAL_MS = 1_000;
/** RFC 9309 asks crawlers to read at least 500 KiB of robots.txt. */
const ROBOTS_MAX_BYTES = 512_000;

/** What the caller wants back; anything else is refused. */
export type Kind = 'html' | 'image' | 'json' | 'text';

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'ico' | 'svg';

export interface Fetched {
  /** Where the body came from, after redirects. */
  url: string;
  /** The Content-Type header as sent, lowercased (with any charset). */
  contentType: string;
  body: Buffer;
  /** Images: the format from the file's own bytes, not its Content-Type. */
  format?: ImageFormat;
}

export type FetchFailure =
  | 'url' // not http(s), credentials, a port other than 80/443
  | 'address' // resolves to a private or reserved address
  | 'dns'
  | 'robots'
  | 'status'
  | 'redirects'
  | 'type'
  | 'size'
  | 'timeout'
  | 'network';

export class FetchError extends Error {
  readonly reason: FetchFailure;
  /** The HTTP status, for `status`. */
  readonly status?: number;
  constructor(reason: FetchFailure, message: string, status?: number) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

// --- Addresses ---

const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, and Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blockedV4.addSubnet(net, prefix, 'ipv4');
}

// IPv6: only global unicast (2000::/3), which leaves out loopback, unique-local (fc00::/7),
// link-local (fe80::/10), multicast (ff00::/8) and IPv4-mapped or translated addresses
// (::ffff:0:0/96, 64:ff9b::/96) whose IPv4 part could be private.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ['2001::', 23], // protocol assignments, Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, embeds an IPv4 address
  ['3fff::', 20], // documentation
] as const) {
  blockedV6.addSubnet(net, prefix, 'ipv6');
}

/** Whether an IP address is somewhere on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a host resolves to. */
export async function resolveHost(host: string): Promise<ResolvedAddress[]> {
  const found = await dnsLookup(host, { all: true, verbatim: true });
  return found.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

// --- Images ---

/** The image format from its first bytes, or null. SVG is text: an `<svg` root near the start. */
export function sniffImage(body: Buffer): ImageFormat | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => body[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpeg';
  if (body.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (
    body.subarray(0, 4).toString('latin1') === 'RIFF' &&
    body.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'ico';
  // Past an optional BOM, XML declaration, comments and doctype, the first element is <svg.
  const head = body
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  const rest = head.replace(/^(?:\s+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
  if (/^<svg[\s>]/i.test(rest)) return 'svg';
  return null;
}

// --- Fetching ---

const ACCEPT: Record<Kind, string> = {
  html: 'text/html,application/xhtml+xml;q=0.9',
  image: 'image/png,image/webp,image/jpeg,image/gif,image/svg+xml,image/x-icon;q=0.9',
  json: 'application/manifest+json,application/json;q=0.9,*/*;q=0.1',
  text: 'text/plain,*/*;q=0.1',
};
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface FetcherOptions {
  /** Defaults to the system resolver. Tests pass a fixed table. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** Defaults to `isPublicAddress`. Tests allow 127.0.0.1 to reach a local server. */
  allowAddress?: (address: string) => boolean;
  /** Defaults to 80 and 443. */
  allowPort?: (port: number) => boolean;
  /** Whether to read and obey robots.txt (default true). */
  robots?: boolean;
  hostIntervalMs?: number;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxBytes?: number;
}

const defaultPort = (url: URL) =>
  url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class SafeFetcher {
  readonly #resolve: (host: string) => Promise<ResolvedAddress[]>;
  readonly #allowAddress: (address: string) => boolean;
  readonly #allowPort: (port: number) => boolean;
  readonly #robots: boolean;
  readonly #interval: number;
  readonly #timeout: number;
  readonly #connectTimeout: number;
  readonly #maxBytes: number;
  /** Host → earliest time the next request may start. */
  readonly #nextSlot = new Map<string, number>();
  /** Origin → its rules, fetched once per run. */
  readonly #robotsCache = new Map<string, Promise<Robots>>();

  constructor(options: FetcherOptions = {}) {
    this.#resolve = options.resolve ?? resolveHost;
    this.#allowAddress = options.allowAddress ?? isPublicAddress;
    this.#allowPort = options.allowPort ?? ((port) => port === 80 || port === 443);
    this.#robots = options.robots ?? true;
    this.#interval = options.hostIntervalMs ?? HOST_INTERVAL_MS;
    this.#timeout = options.timeoutMs ?? TIMEOUT_MS;
    this.#connectTimeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
  }

  /** GET a URL as `kind`, or throw a FetchError saying why not. */
  async get(raw: string, kind: Kind, maxBytes = this.#maxBytes): Promise<Fetched> {
    let url = this.#checkUrl(raw);
    for (let hop = 0; ; hop++) {
      if (this.#robots && !(await this.#robotsFor(url)).allows(url.pathname + url.search)) {
        throw new FetchError('robots', `${url.origin} disallows ${url.pathname}`);
      }
      const res = await this.#request(url, kind, maxBytes);
      if (REDIRECTS.has(res.status)) {
        if (hop >= MAX_REDIRECTS)
          throw new FetchError('redirects', `more than ${MAX_REDIRECTS} redirects from ${raw}`);
        if (!res.location)
          throw new FetchError('status', `${res.status} without a Location`, res.status);
        url = this.#checkUrl(new URL(res.location, url).href);
        continue;
      }
      if (res.status < 200 || res.status > 299) {
        throw new FetchError('status', `${url.href}: HTTP ${res.status}`, res.status);
      }
      return checkType(url.href, kind, res.contentType, res.body);
    }
  }

  #checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new FetchError('url', `not a URL: ${raw.slice(0, 200)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new FetchError('url', `not http(s): ${url.protocol}`);
    if (url.username || url.password) throw new FetchError('url', 'credentials in the URL');
    if (!this.#allowPort(defaultPort(url))) throw new FetchError('url', `port ${defaultPort(url)}`);
    url.hash = '';
    return url;
  }

  /**
   * The addresses to try, IPv4 first (GitHub's runners have no IPv6 route); every address the
   * host has must be allowed, whichever ends up used.
   */
  async #addresses(url: URL): Promise<ResolvedAddress[]> {
    const host = bareHost(url);
    const literal = isIP(host);
    let addresses: ResolvedAddress[];
    if (literal) {
      addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
    } else {
      if (host === 'localhost' || host.endsWith('.localhost'))
        throw new FetchError('address', host);
      try {
        addresses = await this.#resolve(host);
      } catch (error) {
        throw new FetchError('dns', `${host}: ${(error as Error).message}`);
      }
    }
    if (addresses.length === 0) throw new FetchError('dns', `${host}: no address`);
    const refused = addresses.find((a) => !this.#allowAddress(a.address));
    if (refused) throw new FetchError('address', `${host} resolves to ${refused.address}`);
    return [
      ...addresses.filter((a) => a.family === 4),
      ...addresses.filter((a) => a.family === 6),
    ].slice(0, MAX_ADDRESSES);
  }

  async #slot(host: string): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#nextSlot.get(host) ?? 0);
    this.#nextSlot.set(host, at + this.#interval);
    if (at > now) await sleep(at - now);
  }

  #robotsFor(url: URL): Promise<Robots> {
    let rules = this.#robotsCache.get(url.origin);
    if (!rules) {
      rules = this.#loadRobots(url);
      this.#robotsCache.set(url.origin, rules);
    }
    return rules;
  }

  // RFC 9309: a 4xx means no rules; a 5xx or no answer means stay out for now.
  async #loadRobots(url: URL): Promise<Robots> {
    let target = new URL('/robots.txt', url.origin);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res: RawResponse;
      try {
        res = await this.#request(target, 'text', ROBOTS_MAX_BYTES);
      } catch {
        return Robots.disallowAll();
      }
      if (REDIRECTS.has(res.status) && res.location) {
        try {
          target = this.#checkUrl(new URL(res.location, target).href);
        } catch {
          // Redirected somewhere we won't go: as if there were no file.
          return Robots.allowAll();
        }
        continue;
      }
      if (res.status >= 200 && res.status <= 299)
        return Robots.parse(res.body.toString('utf8'), 'brewhunt-crawler');
      if (res.status >= 400 && res.status <= 499) return Robots.allowAll();
      return Robots.disallowAll();
    }
    return Robots.allowAll();
  }

  async #request(url: URL, kind: Kind, maxBytes: number): Promise<RawResponse> {
    const addresses = await this.#addresses(url);
    await this.#slot(bareHost(url));
    const signal = AbortSignal.timeout(this.#timeout);
    // A host can be reachable on one of its addresses only: try the next when one doesn't connect.
    for (const [i, address] of addresses.entries()) {
      try {
        return await this.#attempt(url, address, kind, maxBytes, signal);
      } catch (error) {
        if (!(error instanceof NoConnection)) throw error;
        if (i === addresses.length - 1 || signal.aborted) {
          throw new FetchError(
            signal.aborted ? 'timeout' : 'network',
            `${url.href}: ${error.message}`,
          );
        }
      }
    }
    throw new FetchError('network', `${url.href}: no address`);
  }

  #attempt(
    url: URL,
    pinned: ResolvedAddress,
    kind: Kind,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<RawResponse> {
    const host = bareHost(url);
    return new Promise<RawResponse>((resolve, reject) => {
      let connected = false;
      const fail = (error: unknown) => {
        if (error instanceof FetchError || error instanceof NoConnection) return reject(error);
        if (!connected && !signal.aborted) {
          return reject(new NoConnection(`${pinned.address}: ${(error as Error).message}`));
        }
        if (signal.aborted)
          return reject(new FetchError('timeout', `${url.href}: no answer in ${this.#timeout} ms`));
        reject(new FetchError('network', `${url.href}: ${(error as Error).message}`));
      };
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        url,
        {
          method: 'GET',
          agent: false,
          signal,
          // Connect to the checked address, whatever DNS says now.
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
          ...(isIP(host) ? {} : { servername: host }),
          headers: {
            'user-agent': USER_AGENT,
            accept: ACCEPT[kind],
            'accept-encoding': 'gzip, deflate, br',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === 'string' ? res.headers.location : null;
          const contentType = (res.headers['content-type'] ?? '').toLowerCase();
          if (status < 200 || status > 299) {
            res.resume();
            return resolve({ status, location, contentType, body: Buffer.alloc(0) });
          }
          if (
            Number(res.headers['content-length']) > maxBytes &&
            !res.headers['content-encoding']
          ) {
            res.destroy();
            return reject(new FetchError('size', `${url.href}: over ${maxBytes} bytes`));
          }
          readBody(res, res.headers['content-encoding'], maxBytes, url.href).then(
            (body) => resolve({ status, location, contentType, body }),
            fail,
          );
        },
      );
      req.on('socket', (socket) => {
        const timer = setTimeout(
          () =>
            req.destroy(
              new NoConnection(`${pinned.address}: no connection in ${this.#connectTimeout} ms`),
            ),
          this.#connectTimeout,
        );
        socket.once('connect', () => {
          connected = true;
          clearTimeout(timer);
        });
        socket.once('close', () => clearTimeout(timer));
      });
      req.on('error', fail);
      req.end();
    });
  }
}

/** One address didn't take the connection; the next may. */
class NoConnection extends Error {}

interface RawResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
}

/** The decoded body, stopping as soon as it passes `max` bytes either way. */
async function readBody(
  res: Readable,
  encoding: string | undefined,
  max: number,
  url: string,
): Promise<Buffer> {
  const coding = (encoding ?? 'identity').trim().toLowerCase();
  const decoders: Record<string, () => zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress> = {
    gzip: () => zlib.createGunzip(),
    'x-gzip': () => zlib.createGunzip(),
    deflate: () => zlib.createInflate(),
    br: () => zlib.createBrotliDecompress(),
  };
  if (coding !== 'identity' && !decoders[coding]) {
    res.destroy();
    throw new FetchError('type', `${url}: content-encoding ${coding}`);
  }
  let stream: Readable = res;
  if (coding !== 'identity') {
    // The compressed bytes count too, and a broken download fails the decoder.
    let raw = 0;
    res.on('data', (chunk: Buffer) => {
      raw += chunk.length;
      if (raw > max) res.destroy(new FetchError('size', `${url}: over ${max} bytes`));
    });
    stream = res.pipe(decoders[coding]());
    res.on('error', (error) => stream.destroy(error));
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Leaving the loop destroys the stream.
    if (size > max) {
      res.destroy();
      throw new FetchError('size', `${url}: over ${max} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function checkType(url: string, kind: Kind, contentType: string, body: Buffer): Fetched {
  const mime = contentType.split(';')[0].trim();
  if (kind === 'html') {
    if (!HTML_TYPES.has(mime))
      throw new FetchError('type', `${url}: ${mime || 'no type'}, not HTML`);
    return { url, contentType, body };
  }
  if (kind === 'image') {
    const format = sniffImage(body);
    if (!format) throw new FetchError('type', `${url}: not an image (${mime || 'no type'})`);
    return { url, contentType, body, format };
  }
  // JSON and text: anything that isn't a binary format.
  if (/^(image|audio|video|font)\//.test(mime) || mime === 'application/octet-stream') {
    throw new FetchError('type', `${url}: ${mime}, not text`);
  }
  return { url, contentType, body };
}

/** A body as text, in the charset its Content-Type names (UTF-8 otherwise). */
export function decodeText(fetched: Fetched): string {
  const charset = /charset=["']?([\w-]+)/i.exec(fetched.contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(fetched.body);
  } catch {
    return new TextDecoder('utf-8').decode(fetched.body);
  }
}
