// The icon answer key's third round (M5 C8): the images the pipeline picks (rank.ts's rules and the
// judge, icon-check.ts --judge) that the key can't score yet, for the owner to rule on.
//
// 1. Never shown: images the owner didn't see in rounds 1 and 2 (new sources), including icons for
//    packages where the owner chose the letter tile without seeing them.
// 2. Passed over: images the owner saw and didn't choose. The same logo from a worse source, or a
//    wrong one; only the owner can say which.
//
// For each image: wrong, also fine, or better (use it instead). Verdicts save to review.json in the
// dry run's folder; --update records them in the key as `rejected` and `accepted` hashes, and a
// "better" image becomes the answer (the old one stays accepted).
//
//   node scripts/crawl/review-sheet.ts --from <dry-run dir> --host 100.72.225.32 --port 4327
//   node scripts/crawl/review-sheet.ts --from <dry-run dir> --update tests/fixtures/answer-key/icons.json
//
// Served like the contact sheet: only files the dry run fetched, text escaped, images under a CSP
// that runs nothing.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { IconResult, PackageResult } from './dry-run.ts';
import { hamming } from './extract.ts';
import type { ModelPick, ModelPicks } from './icon-check.ts';
import { chooseIcon } from './rank.ts';
import { SAME_FILE, bucket, type KeyEntry } from './score.ts';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    key: { type: 'string', default: 'tests/fixtures/answer-key/icons.json' },
    judge: { type: 'string', default: 'judge-picks.json' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4327' },
    update: { type: 'string' },
  },
});
if (!args.from) {
  console.error(
    'Usage: node scripts/crawl/review-sheet.ts --from <dir> [--host H --port P | --update <file>]',
  );
  process.exit(2);
}
const DIR = args.from;
const REVIEW = join(DIR, 'review.json');

type Verdict = 'wrong' | 'fine' | 'better';
const VERDICTS: readonly Verdict[] = ['wrong', 'fine', 'better'];

const { packages } = JSON.parse(readFileSync(join(DIR, 'results.json'), 'utf8')) as {
  packages: PackageResult[];
};
const byId = new Map(packages.map((p) => [p.id, p]));
const key = JSON.parse(readFileSync(args.update ?? args.key, 'utf8')) as (KeyEntry &
  Record<string, unknown>)[];
const judge: Record<string, ModelPick> = existsSync(join(DIR, args.judge))
  ? (JSON.parse(readFileSync(join(DIR, args.judge), 'utf8')) as ModelPicks).picks
  : {};
const readReview = (): Record<string, Record<string, Verdict>> =>
  existsSync(REVIEW) ? JSON.parse(readFileSync(REVIEW, 'utf8')) : {};

interface Item {
  answer: KeyEntry;
  p: PackageResult;
  section: 1 | 2;
  /** The images to rule on, with who picked each. */
  images: { icon: IconResult; by: string[]; reason?: string }[];
}

const near = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && hamming(a, b) <= SAME_FILE;

const items: Item[] = [];
for (const answer of key) {
  const p = byId.get(answer.id);
  if (!p) continue;
  const images: Item['images'] = [];
  let section: 1 | 2 = 2;
  const judged = judge[answer.id];
  for (const [by, pick] of [
    ['rules', chooseIcon(p.icons)],
    ['judge', judged],
  ] as const) {
    if (!pick?.icon) continue;
    const icon = p.icons.find((i) => i.url === pick.icon);
    if (!icon) continue;
    const b = bucket(answer, { icon: icon.url, hash: icon.hash });
    if (b !== 'never shown' && b !== 'unreviewed icon' && b !== 'passed over') continue;
    if (b !== 'passed over') section = 1;
    const same = images.find((i) => i.icon.url === icon.url || near(i.icon.hash, icon.hash));
    const reason = by === 'judge' ? judged?.reason : undefined;
    if (same) {
      same.by.push(by);
      same.reason ??= reason;
    } else images.push({ icon, by: [by], reason });
  }
  if (images.length) items.push({ answer, p, section, images });
}
items.sort((a, b) => a.section - b.section);

if (args.update) {
  const review = readReview();
  let changed = 0;
  const next = key.map((entry) => {
    const verdicts = review[entry.id];
    const p = byId.get(entry.id);
    if (!verdicts || !p) return entry;
    const hashOf = (url: string) => p.icons.find((i) => i.url === url)?.hash ?? undefined;
    const add = (list: unknown, hash: string | undefined) => [
      ...new Set([...((list as string[] | undefined) ?? []), ...(hash ? [hash] : [])]),
    ];
    let out: typeof entry = { ...entry };
    for (const [url, verdict] of Object.entries(verdicts)) {
      const hash = hashOf(url);
      out.seen = add(out.seen, hash);
      if (verdict === 'wrong') out.rejected = add(out.rejected, hash);
      if (verdict === 'fine') out.accepted = add(out.accepted, hash);
      if (verdict === 'better') {
        const icon = p.icons.find((i) => i.url === url)!;
        out = {
          ...out,
          icon: url,
          source: icon.source,
          hash,
          // The old answer stays right.
          accepted: add(out.accepted, out.hash),
        };
      }
    }
    changed++;
    return out;
  });
  writeFileSync(args.update, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${changed} entries updated in ${args.update} from ${REVIEW}`);
  process.exit(0);
}

const escape = (s: string | null | undefined) =>
  (s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? escape(url) : '');

const art = (icon: IconResult) =>
  `<span class="art"><img src="/${escape(icon.file!)}" alt="" width="96" height="96" loading="lazy"><img class="small" src="/${escape(icon.file!)}" alt="" width="32" height="32" loading="lazy"></span>`;

function row(item: Item, verdicts: Record<string, Verdict>, index: number): string {
  const { answer, p } = item;
  // The owner's current answer, from this run's files when it has the same image.
  const current = answer.icon
    ? p.icons.find((i) => i.file && (i.url === answer.icon || near(i.hash, answer.hash)))
    : undefined;
  const yours = answer.icon
    ? current
      ? `${art(current)}<span class="meta"><b>Your pick</b><br>${escape(answer.source)}</span>`
      : `<span class="art missing">not in this run</span><span class="meta"><b>Your pick</b><br>${escape(answer.source)}</span>`
    : `<span class="art tile">${escape(p.name.slice(0, 1).toUpperCase())}</span><span class="meta"><b>Your pick</b><br>letter tile</span>`;
  const images = item.images
    .map(({ icon, by, reason }, n) => {
      const name = `v-${index}-${n}`;
      const dims = icon.format === 'svg' ? 'SVG' : `${icon.width}×${icon.height}`;
      const choices: [Verdict, string][] = answer.icon
        ? [
            ['wrong', 'Wrong'],
            ['fine', 'Also fine'],
            ['better', 'Better, use it'],
          ]
        : [
            ['wrong', 'Wrong'],
            ['better', 'Right, show it'],
          ];
      return `<fieldset class="image" data-url="${escape(icon.url)}"><legend class="visually-hidden">${escape(p.name)}: ${escape(icon.source)} image</legend>
${art(icon)}<span class="meta"><b>${escape(icon.source)}</b>${icon.marked ? ' (marked)' : ''} · ${dims}<br><em>${by.map((b) => (b === 'rules' ? 'rules’ pick' : 'judge’s pick')).join(', ')}</em>${reason ? `<br><span class="reason">${escape(reason)}</span>` : ''}</span>
<span class="verdicts">${choices
        .map(
          ([value, label]) =>
            `<label><input type="radio" name="${name}" value="${value}"${verdicts[icon.url] === value ? ' checked' : ''}> ${label}</label>`,
        )
        .join('')}</span></fieldset>`;
    })
    .join('\n');
  const done = item.images.every(({ icon }) => verdicts[icon.url]);
  return `<li class="pkg${done ? ' answered' : ''}" data-id="${escape(p.id)}">
<div class="head">
  <h2>${index + 1}. ${escape(p.name)} <code>${escape(p.id)}</code></h2>
  <p>${escape(p.kind)} · ${escape(p.source)}${p.homepage ? ` · <a href="${safeUrl(p.homepage)}" target="_blank" rel="noopener noreferrer">${escape(p.homepage)}</a>` : ''}${p.repo ? ` · repo ${escape(p.repo.name)}` : ''}</p>
  ${p.desc ? `<p class="desc">${escape(p.desc)}</p>` : ''}
</div>
<div class="row"><div class="yours">${yours}</div>${images}</div>
<p class="saved" aria-live="polite"></p>
</li>`;
}

function page(): string {
  const review = readReview();
  const total = items.reduce((n, i) => n + i.images.length, 0);
  const ruled = items.reduce(
    (n, i) => n + i.images.filter(({ icon }) => review[i.p.id]?.[icon.url]).length,
    0,
  );
  const section = (s: 1 | 2) =>
    items
      .map((item, i) => (item.section === s ? row(item, review[item.p.id] ?? {}, i) : ''))
      .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Icon review</title>
<style>
:root { --ink: #0b1430; --muted: #5b6478; --line: #dfe3ec; --bg: #f6f7fb; --card: #fff; --accent: #2f5bff; color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: var(--ink); background: var(--bg); }
header { position: sticky; top: 0; z-index: 2; background: var(--card); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
header h1 { font-size: 18px; margin: 0; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
main > h2 { font-size: 17px; margin: 24px 0 4px; }
ol { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 12px; }
.pkg { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.pkg.answered { border-color: #9fb4ff; }
body.hide-answered .pkg.answered { display: none; }
.pkg h2 { font-size: 16px; margin: 0; } .pkg h2 code { font-size: 13px; color: var(--muted); font-weight: 400; }
.head p { margin: 2px 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.head .desc { color: var(--ink); }
.row { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; align-items: stretch; }
.yours, .image { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 190px; padding: 10px; border: 2px solid var(--line); border-radius: 12px; margin: 0; font-size: 12px; text-align: center; }
.yours { background: #f2f4f8; }
.image:has(input[value=wrong]:checked) { border-color: #d92d20; background: #fff4f2; }
.image:has(input[value=fine]:checked) { border-color: #1f9d55; background: #f0fbf4; }
.image:has(input[value=better]:checked) { border-color: var(--accent); background: #eef2ff; }
.art { display: flex; align-items: end; gap: 6px; padding: 6px; border-radius: 10px; background: repeating-conic-gradient(#eceef3 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
.art img { display: block; object-fit: contain; }
.art.missing { width: 108px; height: 108px; align-items: center; justify-content: center; color: var(--muted); }
.tile { width: 108px; height: 108px; justify-content: center; align-items: center; font: 700 44px system-ui; color: #fff; background: linear-gradient(160deg, #6b7cff, #3046d8); }
.meta em { color: #8a6d00; font-style: normal; font-weight: 600; }
.reason { color: var(--muted); }
.verdicts { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.verdicts label { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; font-size: 14px; background: var(--card); }
.verdicts input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.verdicts label:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 2px; }
.saved { margin: 6px 0 0; font-size: 12px; color: var(--accent); min-height: 1em; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.button { font: inherit; padding: 8px 14px; min-height: 44px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
</style></head><body>
<header><h1>Icon review</h1><span><b id="count">${ruled}</b> of ${total} images ruled on</span>
<label class="button"><input type="checkbox" id="hide"> Hide done</label>
<a class="button" href="/review.json" download>Download verdicts</a></header>
<main>
<p>The icon pipeline’s picks that the answer key can’t score yet. Your current answer is on the left; for each image the rules or the judge picked, say whether it’s wrong, also fine (the right logo, a file you’d accept), or better than yours. On a package where you chose the letter tile, “Right, show it” means the tool does have this logo. Verdicts save as you click.</p>
<h2>1. Images you haven’t seen</h2>
<p>From the new sources (homepage and README logos, the maker’s logo).</p>
<ol>${section(1)}</ol>
<h2>2. Images you passed over</h2>
<p>You saw these and chose another. Optional: it tells a worse file of the right logo from a wrong logo.</p>
<ol>${section(2)}</ol>
</main>
<script>
const count = document.getElementById('count');
document.getElementById('hide').addEventListener('change', (e) => document.body.classList.toggle('hide-answered', e.target.checked));
document.addEventListener('change', async (e) => {
  const input = e.target;
  if (input.type !== 'radio') return;
  const li = input.closest('.pkg');
  const image = input.closest('.image');
  const status = li.querySelector('.saved');
  try {
    const res = await fetch('/verdict', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: li.dataset.id, url: image.dataset.url, verdict: input.value }) });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    count.textContent = body.ruled;
    // Only one image can replace the answer.
    if (input.value === 'better') for (const other of li.querySelectorAll('input[value=better]:checked')) if (other !== input) other.closest('.image').querySelector('input[value=fine]').checked = true;
    if ([...li.querySelectorAll('.image')].every((f) => f.querySelector('input:checked'))) li.classList.add('answered');
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = 'Not saved: ' + error.message;
  }
});
</script></body></html>`;
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const itemById = new Map(items.map((i) => [i.p.id, i]));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://sheet');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page());
  }
  if (req.method === 'GET' && url.pathname === '/review.json') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="review.json"',
    });
    return res.end(JSON.stringify(readReview(), null, 2));
  }
  if (req.method === 'POST' && url.pathname === '/verdict') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const { id, url: image, verdict } = JSON.parse(body) as Record<string, unknown>;
        const item = typeof id === 'string' ? itemById.get(id) : undefined;
        if (!item) throw new Error('unknown package');
        if (!item.images.some((i) => i.icon.url === image)) throw new Error('not an image here');
        if (!VERDICTS.includes(verdict as Verdict)) throw new Error('bad verdict');
        if (verdict === 'fine' && item.answer.icon === null) throw new Error('bad verdict');
        const review = readReview();
        const verdicts = (review[item.p.id] ??= {});
        if (verdict === 'better')
          for (const [other, v] of Object.entries(verdicts))
            if (v === 'better') verdicts[other] = 'fine';
        verdicts[image as string] = verdict as Verdict;
        writeFileSync(`${REVIEW}.tmp`, JSON.stringify(review, null, 1));
        renameSync(`${REVIEW}.tmp`, REVIEW);
        const ruled = items.reduce(
          (n, i) => n + i.images.filter(({ icon }) => review[i.p.id]?.[icon.url]).length,
          0,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ruled }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end((error as Error).message);
      }
    });
    return;
  }
  // Fetched images, from the dry run's files/ folder only.
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  const type = TYPES[extname(path).toLowerCase()];
  if (req.method === 'GET' && type && path.startsWith(`files${sep}`) && !path.includes('..')) {
    try {
      const file = readFileSync(join(DIR, path));
      res.writeHead(200, {
        'content-type': type,
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
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
  const count = (s: number) => items.filter((i) => i.section === s).length;
  console.log(
    `Icon review: ${count(1)} packages with images not seen, ${count(2)} with images passed over, on http://${args.host}:${args.port}/`,
  );
});
