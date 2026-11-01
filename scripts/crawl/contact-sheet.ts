// The icon answer key's contact sheet (M5 C1): one row per package from a dry run
// (`dry-run.ts --answer-key 300`), its icon candidates side by side, and a choice the owner makes
// for each: one of the candidates, "none" (the letter tile is right), "findable" (none of these,
// but the right icon exists and a cheap model with search should find it), or another URL. Choices are
// saved to answers.json in the dry run's folder as they're made; --export turns them into
// tests/fixtures/answer-key/icons.json.
//
//   node scripts/crawl/contact-sheet.ts --from <dir> --host 100.72.225.32 --port 4325
//   node scripts/crawl/contact-sheet.ts --from <dir> --export tests/fixtures/answer-key/icons.json
//
// Everything shown was fetched by the dry run and is served from its folder, so the owner's
// browser never contacts the sites. Crawled files are untrusted: text is escaped, and images
// (SVGs included) are served with a CSP that runs nothing.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { PackageResult } from './dry-run.ts';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4325' },
    export: { type: 'string' },
  },
});
if (!args.from) {
  console.error(
    'Usage: node scripts/crawl/contact-sheet.ts --from <dir> [--host H --port P | --export <file>]',
  );
  process.exit(2);
}
const DIR = args.from;
const ANSWERS = join(DIR, 'answers.json');

/** A candidate's URL, another URL the owner typed, or null (`none` or `findable`). */
interface Answer {
  icon: string | null;
  /**
   * Which candidate source it was, `other` for a typed URL, `none` for the tile, `findable` when
   * the right icon isn't here but should be easy to find.
   */
  source: string;
  at: string;
}

const { packages } = JSON.parse(readFileSync(join(DIR, 'results.json'), 'utf8')) as {
  packages: PackageResult[];
};
const byId = new Map(packages.map((p) => [p.id, p]));
const readAnswers = (): Record<string, Answer> =>
  existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, 'utf8')) : {};

if (args.export) {
  const answers = readAnswers();
  const key = packages
    .filter((p) => answers[p.id])
    .map((p) => ({ id: p.id, icon: answers[p.id].icon, source: answers[p.id].source }));
  mkdirSync(dirname(args.export), { recursive: true });
  writeFileSync(args.export, `${JSON.stringify(key, null, 2)}\n`);
  console.log(`${key.length} of ${packages.length} packages answered → ${args.export}`);
  process.exit(0);
}

const escape = (s: string | null | undefined) =>
  (s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? escape(url) : '');

function row(p: PackageResult, answer: Answer | undefined, index: number): string {
  const name = `pick-${index}`;
  const suggested = p.icons.find((i) => i.status === 'ok');
  const options = p.icons
    .filter((i) => i.file)
    .map((icon, n) => {
      const id = `${name}-${n}`;
      const checked = answer?.icon === icon.url ? ' checked' : '';
      const dims = icon.format === 'svg' ? 'SVG' : `${icon.width}×${icon.height}`;
      return `<label class="option${icon.status === 'ok' ? '' : ' rejected'}" for="${id}">
  <input type="radio" id="${id}" name="${name}" value="${escape(icon.url)}" data-source="${escape(icon.source)}"${checked}>
  <span class="art"><img src="/${escape(icon.file!)}" alt="" width="96" height="96" loading="lazy"><img class="small" src="/${escape(icon.file!)}" alt="" width="32" height="32" loading="lazy"></span>
  <span class="meta"><b>${escape(icon.source)}</b>${icon === suggested ? ' <em>pipeline’s pick</em>' : ''}<br>${dims}${icon.reason ? `<br><span class="why">${escape(icon.reason)}</span>` : ''}</span>
</label>`;
    })
    .join('\n');
  const none = answer?.source === 'none' ? ' checked' : '';
  const findable = answer?.source === 'findable' ? ' checked' : '';
  const other = answer?.source === 'other';
  const failed = p.icons.filter((i) => !i.file).length;
  return `<li class="pkg${answer ? ' answered' : ''}" data-id="${escape(p.id)}">
<div class="head">
  <h2>${index + 1}. ${escape(p.name)} <code>${escape(p.id)}</code></h2>
  <p>${escape(p.kind)} · ${escape(p.source)} · ${p.installs30.toLocaleString('en')} installs/30d${p.homepage ? ` · <a href="${safeUrl(p.homepage)}" target="_blank" rel="noopener noreferrer">${escape(p.homepage)}</a>` : ''}${p.repo ? ` · repo ${escape(p.repo.name)} (${p.repo.via})` : ''}</p>
  ${p.desc ? `<p class="desc">${escape(p.desc)}</p>` : ''}
  ${p.pageError ? `<p class="why">Homepage: ${escape(p.pageError)}</p>` : ''}
</div>
<fieldset><legend class="visually-hidden">Icon for ${escape(p.name)}</legend>
<div class="options">
${options}
<label class="option none" for="${name}-none"><input type="radio" id="${name}-none" name="${name}" value="" data-source="none"${none}><span class="art tile">${escape(p.name.slice(0, 1).toUpperCase())}</span><span class="meta"><b>None of these</b><br>keep the letter tile</span></label>
<label class="option findable" for="${name}-findable"><input type="radio" id="${name}-findable" name="${name}" value="" data-source="findable"${findable}><span class="art tile find" aria-hidden="true">?</span><span class="meta"><b>Not here, but findable</b><br>a model should find the right one</span></label>
<label class="option other" for="${name}-other"><input type="radio" id="${name}-other" name="${name}" value="other" data-source="other"${other ? ' checked' : ''}><span class="meta"><b>Another URL</b><br><input type="url" class="other-url" aria-label="Icon URL for ${escape(p.name)}" placeholder="https://…" value="${other ? escape(answer?.icon) : ''}"></span></label>
</div></fieldset>
${
  failed
    ? `<details><summary>${failed} candidate${failed === 1 ? '' : 's'} not fetched</summary><ul>${p.icons
        .filter((i) => !i.file)
        .map((i) => `<li><b>${escape(i.source)}</b> ${escape(i.url)}: ${escape(i.reason)}</li>`)
        .join('')}</ul></details>`
    : ''
}
<p class="saved" aria-live="polite"></p>
</li>`;
}

function page(): string {
  const answers = readAnswers();
  const answered = packages.filter((p) => answers[p.id]).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Icon answer key</title>
<style>
:root { --ink: #0b1430; --muted: #5b6478; --line: #dfe3ec; --bg: #f6f7fb; --card: #fff; --accent: #2f5bff; --bad: #b42318; color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: var(--ink); background: var(--bg); }
header { position: sticky; top: 0; z-index: 2; background: var(--card); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
header h1 { font-size: 18px; margin: 0; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.pkg { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.pkg.answered { border-color: #9fb4ff; }
body.hide-answered .pkg.answered { display: none; }
h2 { font-size: 16px; margin: 0; } h2 code { font-size: 13px; color: var(--muted); font-weight: 400; }
.head p { margin: 2px 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.head .desc { color: var(--ink); }
fieldset { border: 0; margin: 10px 0 0; padding: 0; }
.options { display: flex; flex-wrap: wrap; gap: 10px; }
.option { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 150px; padding: 10px; border: 2px solid var(--line); border-radius: 12px; cursor: pointer; text-align: center; font-size: 12px; }
.option:has(input:checked) { border-color: var(--accent); background: #eef2ff; }
.option:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 2px; }
.option > input[type=radio] { margin: 0; width: 18px; height: 18px; accent-color: var(--accent); }
.option.rejected .art { opacity: 0.45; }
.art { display: flex; align-items: end; gap: 6px; padding: 6px; border-radius: 10px; background: repeating-conic-gradient(#eceef3 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
.art img { display: block; object-fit: contain; }
.tile { width: 108px; height: 108px; justify-content: center; align-items: center; font: 700 44px system-ui; color: #fff; background: linear-gradient(160deg, #6b7cff, #3046d8); }
.tile.find { background: repeating-conic-gradient(#eceef3 0 25%, #fff 0 50%) 0 0 / 16px 16px; color: var(--muted); border: 2px dashed var(--line); }
.meta em { color: var(--accent); font-style: normal; font-weight: 600; }
.why { color: var(--bad); }
.other-url { width: 128px; margin-top: 4px; font-size: 12px; }
details { margin-top: 8px; font-size: 12px; color: var(--muted); } details li { overflow-wrap: anywhere; }
.saved { margin: 6px 0 0; font-size: 12px; color: var(--accent); min-height: 1em; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
button, .button { font: inherit; padding: 8px 14px; min-height: 44px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
</style></head><body>
<header><h1>Icon answer key</h1><span><b id="count">${answered}</b> of ${packages.length} answered</span>
<label class="button"><input type="checkbox" id="hide"> Hide answered</label>
<a class="button" href="/answers.json" download>Download answers</a></header>
<main>
<p>For each package, pick the icon Brewhunt should show, “None of these” if the letter tile is right, or “Not here, but findable” if the app has a real icon that none of these is and a quick search should turn it up. Dimmed candidates were rejected by a rule (the reason is under them); pick one anyway if the rule is wrong. Choices save as you click.</p>
<ol>
${packages.map((p, i) => row(p, answers[p.id], i)).join('\n')}
</ol></main>
<script>
const count = document.getElementById('count');
document.getElementById('hide').addEventListener('change', (e) => document.body.classList.toggle('hide-answered', e.target.checked));
async function save(li, icon, source) {
  const status = li.querySelector('.saved');
  try {
    const res = await fetch('/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: li.dataset.id, icon, source }) });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    count.textContent = body.answered;
    li.classList.add('answered');
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = 'Not saved: ' + error.message;
  }
}
document.addEventListener('change', (e) => {
  const input = e.target;
  const li = input.closest('.pkg');
  if (!li) return;
  if (input.type === 'radio') {
    if (input.value === 'other') { li.querySelector('.other-url').focus(); return; }
    save(li, input.value || null, input.dataset.source);
  } else if (input.classList.contains('other-url') && input.value) {
    li.querySelector('input[value=other]').checked = true;
    save(li, input.value, 'other');
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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://sheet');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page());
  }
  if (req.method === 'GET' && url.pathname === '/answers.json') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="answers.json"',
    });
    return res.end(JSON.stringify(readAnswers(), null, 2));
  }
  if (req.method === 'POST' && url.pathname === '/answer') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const { id, icon, source } = JSON.parse(body) as {
          id: unknown;
          icon: unknown;
          source: unknown;
        };
        const pkg = typeof id === 'string' ? byId.get(id) : undefined;
        if (!pkg) throw new Error('unknown package');
        if (
          icon !== null &&
          (typeof icon !== 'string' || !/^https?:\/\/\S+$/.test(icon) || icon.length > 2000)
        )
          throw new Error('not a URL');
        if (typeof source !== 'string' || !/^[a-z-]{1,30}$/.test(source))
          throw new Error('bad source');
        if (source !== 'other' && icon !== null && !pkg.icons.some((i) => i.url === icon))
          throw new Error('not a candidate');
        const answers = readAnswers();
        answers[pkg.id] = {
          icon: (icon as string | null) ?? null,
          source: icon !== null ? source : source === 'findable' ? 'findable' : 'none',
          at: new Date().toISOString(),
        };
        writeFileSync(`${ANSWERS}.tmp`, JSON.stringify(answers, null, 1));
        renameSync(`${ANSWERS}.tmp`, ANSWERS);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ answered: Object.keys(answers).filter((k) => byId.has(k)).length }),
        );
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
  console.log(`Contact sheet for ${packages.length} packages on http://${args.host}:${args.port}/`);
});
