// The crawl's review page (M5 C, plan step 7): the drafts waiting in the `enrichment` branch's
// file, for the owner to approve or reject. The whole first run waits, then every community
// package and any package whose sources changed (enrichment.ts).
//
// Each verdict is written to content/approvals.yaml as it's clicked (approvals.ts), by the draft's
// hash. Commit and push it: the site shows approved drafts from the next build, and the next crawl
// publishes them and drops the rejected ones.
//
//   npm run enrichment:pull
//   node scripts/crawl/review-drafts.ts --host 100.72.225.32 --port 4328
//     [--from enrichment] [--assets <dir>] [--approvals content/approvals.yaml]
//
// Images load from the file's asset base, or from --assets (the enrich job's assets/ or
// publish.ts's upload/ folder) for keys found there. Everything in a draft is crawled or
// model-written: text is escaped, links are checked, and the page runs under a CSP that allows
// only its own script and the asset origin's images.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContent } from '../content/schema.ts';
import type { Package } from '../data/types.ts';
import { externalUrl } from '../../src/lib/urls.ts';
import { readApprovals, setVerdict, waitingDrafts, type WaitingDraft } from './approvals.ts';
import type { AssetRecord } from './assets.ts';
import { enrichmentSchema, type Item, type ItemSentence } from './enrichment.ts';
import { readTakedowns } from './takedown.ts';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string', default: 'enrichment' },
    assets: { type: 'string' },
    approvals: { type: 'string', default: 'content/approvals.yaml' },
    content: { type: 'string', default: 'content' },
    packages: { type: 'string', default: 'data/site/packages.json' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4328' },
  },
});

const enrichmentFile = join(args.from, 'enrichment.json');
if (!existsSync(enrichmentFile)) {
  console.error(`No ${enrichmentFile}. Run npm run enrichment:pull, or pass --from <dir>.`);
  process.exit(2);
}
const enrichment = enrichmentSchema.parse(JSON.parse(readFileSync(enrichmentFile, 'utf8')));
const takedowns = readTakedowns(loadContent(args.content).takedown);
const packages = JSON.parse(readFileSync(args.packages, 'utf8')) as Package[];
const assetOrigin = enrichment.assetBase && new URL(enrichment.assetBase).origin;
const ASSET_KEY = /^(?:icons|screenshots)\/v\d+\/[0-9a-f]{64}\.webp$/;

const readFile = () => readFileSync(args.approvals, 'utf8');
const drafts = () => waitingDrafts(enrichment, readApprovals(readFile()), takedowns, packages);
// Fails now, not at the first click, when the approvals file is broken.
const total = drafts().length;

// The address the page was started on: a request for any other Host (a DNS rebinding page) is
// refused, and a verdict needs this launch's token, which only the served page has.
const HOST = `${args.host.includes(':') ? `[${args.host}]` : args.host}:${args.port}`;
const TOKEN = randomBytes(24).toString('base64url');

const today = () => new Date().toISOString().slice(0, 10);

const escape = (s: string | null | undefined) =>
  (s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const link = (url: string | null | undefined, text: string) => {
  const href = externalUrl(url);
  return href
    ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(text)}</a>`
    : escape(text);
};

function assetUrl(key: string): string | null {
  if (!ASSET_KEY.test(key)) return null;
  if (args.assets && existsSync(join(args.assets, key))) return `/assets/${key}`;
  return enrichment.assetBase ? `${enrichment.assetBase.replace(/\/$/, '')}/${key}` : null;
}

const REASON: Record<WaitingDraft['pending']['reason'], string> = {
  'first-run': 'First run',
  'sources-changed': 'Sources changed',
  community: 'Community package',
};

function sentences(title: string, list: ItemSentence[], item: Item): string {
  if (!list.length) return '';
  const source = new Map(item.sources.map((s) => [s.id, s]));
  return `<h4>${title}</h4><ol class="sentences">${list
    .map(
      (s) =>
        `<li><p>${escape(s.text)}</p>${s.citations
          .map((c) => {
            const from = source.get(c.source);
            const label = from ? (from.kind === 'readme' ? 'README' : 'Homepage') : c.source;
            return `<blockquote><span class="from">${link(from?.url, label)}</span> “${escape(c.quote)}”</blockquote>`;
          })
          .join('')}</li>`,
    )
    .join('')}</ol>`;
}

function image(a: AssetRecord): string {
  const url = assetUrl(a.key);
  const notes = [
    a.kind === 'screenshot' ? `${a.width}×${a.height}` : null,
    a.animated ? 'animated' : null,
    ...a.flags,
    a.licence ? `licence ${a.licence}` : 'no licence',
    `picked by ${a.basis}`,
  ].filter(Boolean);
  const art = url
    ? a.kind === 'icon'
      ? `<span class="art"><img src="${escape(url)}" alt="" width="96" height="96"><img src="${escape(url)}" alt="" width="32" height="32"></span>`
      : `<a class="shot" href="${escape(url)}" target="_blank" rel="noopener noreferrer"><img src="${escape(url)}" alt="Open the screenshot at full size" width="${a.width}" height="${a.height}" loading="lazy"></a>`
    : '<span class="art missing">No asset base</span>';
  return `<figure>${art}<figcaption>${a.credit ? `${escape(a.credit)} · ` : ''}${link(a.sourceUrl, 'source')}<br>${escape(notes.join(' · '))}</figcaption></figure>`;
}

function itemView(item: Item): string {
  const facts = [
    item.category ? `<p><b>Category</b> ${escape(item.category)}</p>` : '',
    item.tags.length
      ? `<p><b>Tags</b> ${item.tags.map((t) => `<span class="tag">${escape(t)}</span>`).join(' ')}</p>`
      : '',
  ].join('');
  const images = [
    item.icon ? `<h4>Icon</h4><div class="images">${image(item.icon)}</div>` : '',
    item.screenshots.length
      ? `<h4>Screenshots</h4><div class="images">${item.screenshots.map(image).join('')}</div>`
      : '',
  ].join('');
  const sources = item.sources.length
    ? `<h4>Sources</h4><ul class="sources">${item.sources
        .map(
          (s) =>
            `<li>${link(s.url, s.url)} <span class="muted">${s.kind === 'readme' ? 'README' : 'homepage'}, ${escape(s.revision)}</span></li>`,
        )
        .join('')}</ul>`
    : '';
  const body =
    sentences('Summary', item.summary, item) +
    sentences('Bullets', item.bullets, item) +
    facts +
    images +
    sources;
  return body || '<p class="muted">Nothing in this draft.</p>';
}

function card(d: WaitingDraft, index: number): string {
  const { pkg, pending } = d;
  const official = pkg?.source === 'official';
  const name = `v-${index}`;
  const choices: [string, string][] = [
    ['approve', 'Approve'],
    ['reject', 'Reject'],
    ['', 'Undecided'],
  ];
  const rejectMeans = d.published
    ? 'Reject keeps what the site shows now.'
    : 'Reject means the site shows nothing crawled for it.';
  const draft = itemView(d.item);
  return `<li class="pkg${d.verdict ? ' answered' : ''}" data-id="${escape(d.id)}" data-draft="${pending.hash}" data-reason="${pending.reason}">
<div class="head">
  <h2>${escape(pkg?.name ?? d.id)} <code>${escape(d.id)}</code></h2>
  <p class="badges"><span class="badge ${official ? 'official' : 'community'}">${official ? 'Official' : 'Community'}</span><span class="reason">${REASON[pending.reason]}</span><span class="muted">since ${escape(pending.since)}</span></p>
  ${pkg ? `<p class="muted">${escape(pkg.kind)} · ${pkg.homepage ? link(pkg.homepage, pkg.homepage) : 'no homepage'}</p>` : '<p class="muted">Not in today’s catalog.</p>'}
  ${pkg?.desc ? `<p>Homebrew’s description: ${escape(pkg.desc)}</p>` : ''}
  <p class="hash">Draft <code>${pending.hash}</code></p>
</div>
${
  d.published
    ? `<div class="compare"><section><h3>Shown now</h3>${itemView(d.published)}</section><section><h3>Draft</h3>${draft}</section></div>`
    : `<section><h3>Draft</h3>${draft}</section>`
}
${d.takenDown ? `<p class="muted">${d.takenDown} image${d.takenDown > 1 ? 's' : ''} taken down since the run, left out.</p>` : ''}
<fieldset class="verdicts"><legend>Verdict on ${escape(pkg?.name ?? d.id)}. ${rejectMeans}</legend>${choices
    .map(
      ([value, label]) =>
        `<label><input type="radio" name="${name}" value="${value}"${(d.verdict ?? '') === value ? ' checked' : ''}> ${label}</label>`,
    )
    .join('')}</fieldset>
<p class="saved" aria-live="polite"></p>
</li>`;
}

function page(nonce: string): string {
  const list = drafts();
  const decided = list.filter((d) => d.verdict).length;
  const counts = Object.entries(Object.groupBy(list, (d) => d.pending.reason))
    .map(([reason, l]) => `${REASON[reason as keyof typeof REASON].toLowerCase()} ${l!.length}`)
    .join(', ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft review</title>
<style nonce="${nonce}">
:root { --ink: #0b1430; --muted: #5b6478; --line: #dfe3ec; --bg: #f6f7fb; --card: #fff; --accent: #2f5bff; --amber: #f5a524; color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: var(--ink); background: var(--bg); }
header { position: sticky; top: 0; z-index: 2; background: var(--card); border-bottom: 1px solid var(--line); padding: 8px 16px; display: flex; gap: 8px 16px; align-items: center; flex-wrap: wrap; }
header h1 { font-size: 18px; margin: 0; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
a { color: var(--accent); overflow-wrap: anywhere; }
a:focus-visible, select:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
ol.list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 12px; }
.pkg { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; min-width: 0; }
.pkg.answered { border-color: #9fb4ff; }
body.hide-answered .pkg.answered, .pkg[hidden] { display: none; }
.pkg h2 { font-size: 17px; margin: 0; overflow-wrap: anywhere; } .pkg h2 code { font-size: 13px; color: var(--muted); font-weight: 400; }
.pkg h3 { font-size: 15px; margin: 14px 0 4px; } .pkg h4 { font-size: 13px; margin: 12px 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.head p { margin: 4px 0; overflow-wrap: anywhere; }
.muted { color: var(--muted); font-size: 13px; }
.badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.badge, .reason { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; }
.badge.official { background: var(--amber); color: #3b2500; }
.badge.community { border: 1px dashed var(--muted); color: var(--muted); }
.reason { background: #eef2ff; color: #2337a8; }
.hash code { font-size: 12px; overflow-wrap: anywhere; word-break: break-all; }
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.compare > section { min-width: 0; }
.compare > section:first-child { color: var(--muted); }
@media (max-width: 760px) { .compare { grid-template-columns: 1fr; } }
.sentences { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
.sentences p { margin: 0; }
blockquote { margin: 4px 0 0; padding: 4px 10px; border-left: 3px solid var(--line); color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.from { font-weight: 600; margin-right: 4px; }
.tag { display: inline-block; background: #f2f4f8; border-radius: 6px; padding: 0 6px; font-size: 13px; }
.images { display: flex; flex-wrap: wrap; gap: 12px; }
figure { margin: 0; max-width: 100%; font-size: 12px; color: var(--muted); }
figure:has(.shot) { width: 260px; }
.shot { display: block; } .shot img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
.shot:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
@media (max-width: 600px) { figure:has(.shot) { width: 100%; } }
figcaption { margin-top: 4px; overflow-wrap: anywhere; }
.art { display: flex; align-items: end; gap: 6px; padding: 6px; border-radius: 10px; background: repeating-conic-gradient(#eceef3 0 25%, #fff 0 50%) 0 0 / 16px 16px; width: max-content; }
.art img { display: block; object-fit: contain; }
.art.missing { width: 108px; height: 108px; align-items: center; justify-content: center; text-align: center; }
.sources { margin: 0; padding-left: 20px; font-size: 13px; }
.verdicts { border: 0; padding: 0; margin: 16px 0 0; display: flex; flex-wrap: wrap; gap: 8px; }
.verdicts legend { padding: 0; margin-bottom: 8px; font-size: 13px; color: var(--muted); }
.verdicts label { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; background: var(--card); }
.verdicts input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.verdicts label:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 2px; }
.verdicts label:has(input[value=approve]:checked) { border-color: #1f9d55; background: #f0fbf4; }
.verdicts label:has(input[value=reject]:checked) { border-color: #d92d20; background: #fff4f2; }
.saved { margin: 6px 0 0; font-size: 13px; color: var(--accent); min-height: 1em; }
.control { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); cursor: pointer; font-size: 14px; }
.control:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
select { font: inherit; min-height: 44px; border: 1px solid var(--line); border-radius: 999px; padding: 0 12px; background: var(--card); color: var(--ink); }
</style></head><body>
<header><h1>Draft review</h1><span><b id="count">${decided}</b> of ${list.length} decided</span>
<label class="control"><input type="checkbox" id="hide"> Hide decided</label>
<label class="visually-hidden" for="reason">Show</label><select id="reason"><option value="">All reasons</option>${Object.entries(
    REASON,
  )
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('')}</select></header>
<main>
<p>The crawl’s drafts waiting for you: ${escape(counts || 'none')}. Each sentence shows the quotes it was checked against. Approve shows that exact draft on the site; reject keeps what’s shown now (or nothing) and the crawl won’t ask about that draft again.</p>
<p class="muted">Verdicts are written to <code>${escape(args.approvals)}</code> as you click. Commit and push it: the site uses them from the next build, and the next crawl publishes the approved drafts.</p>
<ol class="list">${list.map(card).join('\n')}</ol>
</main>
<script nonce="${nonce}">
const count = document.getElementById('count');
document.getElementById('hide').addEventListener('change', (e) => document.body.classList.toggle('hide-answered', e.target.checked));
document.getElementById('reason').addEventListener('change', (e) => {
  for (const li of document.querySelectorAll('.pkg')) li.hidden = !!e.target.value && li.dataset.reason !== e.target.value;
});
document.addEventListener('change', async (e) => {
  const input = e.target;
  if (input.type !== 'radio') return;
  const li = input.closest('.pkg');
  const status = li.querySelector('.saved');
  status.textContent = 'Saving…';
  try {
    const res = await fetch('/verdict', { method: 'POST', headers: { 'content-type': 'application/json', 'x-review-token': '${TOKEN}' }, body: JSON.stringify({ id: li.dataset.id, draft: li.dataset.draft, verdict: input.value || null }) });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    count.textContent = body.decided;
    li.classList.toggle('answered', !!input.value);
    status.textContent = input.value ? 'Saved' : 'Cleared';
  } catch (error) {
    status.textContent = 'Not saved: ' + error.message;
  }
});
</script></body></html>`;
}

function saveVerdict(body: string): number {
  const { id, draft, verdict } = JSON.parse(body) as Record<string, unknown>;
  const d = drafts().find((x) => x.id === id && x.pending.hash === draft);
  if (!d) throw new Error('not a draft waiting for review');
  if (verdict !== null && verdict !== 'approve' && verdict !== 'reject')
    throw new Error('bad verdict');
  const next = setVerdict(readFile(), { id: d.id, draft: d.pending.hash, verdict, date: today() });
  writeFileSync(`${args.approvals}.tmp`, next);
  renameSync(`${args.approvals}.tmp`, args.approvals);
  return drafts().filter((x) => x.verdict).length;
}

const server = createServer((req, res) => {
  if (req.headers.host !== HOST) {
    res.writeHead(421, { 'content-type': 'text/plain' });
    return res.end(`Open http://${HOST}/`);
  }
  const url = new URL(req.url ?? '/', 'http://review');
  if (req.method === 'GET' && url.pathname === '/') {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'${assetOrigin ? ` ${assetOrigin}` : ''}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    return res.end(page(nonce));
  }
  if (req.method === 'POST' && url.pathname === '/verdict') {
    // Only this page writes verdicts: a page elsewhere can't post here from the owner's browser.
    // Origin, not Sec-Fetch-Site: browsers don't send the latter to a plain-HTTP tailnet address.
    if (
      req.headers.origin !== `http://${HOST}` ||
      req.headers['x-review-token'] !== TOKEN ||
      !req.headers['content-type']?.startsWith('application/json')
    ) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Only the review page can save verdicts.');
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const decided = saveVerdict(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decided }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end((error as Error).message);
      }
    });
    return;
  }
  // The run's re-encoded images, by key only.
  const key = url.pathname.replace(/^\/assets\//, '');
  if (
    req.method === 'GET' &&
    args.assets &&
    url.pathname.startsWith('/assets/') &&
    ASSET_KEY.test(key)
  ) {
    try {
      const file = readFileSync(join(args.assets, key));
      res.writeHead(200, {
        'content-type': 'image/webp',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'max-age=3600',
      });
      return res.end(file);
    } catch {
      // falls through to 404
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(Number(args.port), args.host, () => {
  console.log(
    `Draft review: ${total} drafts waiting, verdicts to ${args.approvals}, on http://${args.host}:${args.port}/`,
  );
});
