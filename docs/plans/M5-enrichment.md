# M5 plan: better search, richer pages, enrichment crawler

Agreed with the owner on 29 Oct 2026, revised after a Codex review of the plan (17 findings, all taken). Phases run in order; each ends with a Codex review (deep profile) and the browser checks below before it ships. CLAUDE.md rules still apply: honest data, Official vs Community always visible, a static site that works as plain files (the one Pages Function in phase E degrades to keyword search without it).

## Owner tasks

Needed before phase C (crawler) and E (semantic search); A and B don't wait on them.

1. Cloudflare Pages project `brewhunt` (Workers & Pages → Create → Pages → Direct Upload). API token (custom) with **Account · Cloudflare Pages · Edit**, **Account · Workers AI · Read**, **Account · Workers R2 Storage · Edit**.
2. An R2 bucket `brewhunt-assets` for icons, screenshots and the crawl cache, served on a subdomain of the site's domain (R2 custom domain; `r2.dev` URLs are rate-limited and not for production). Which domain will the site use?
3. GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY` (with a monthly spend limit in the Anthropic console; budget $80), and R2 S3 credentials `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. A Tally form for sponsorship enquiries; send me its link.
5. Review time: about an hour for the first crawl's answer key and sample pages (C6).

## Phase 0 · Browser tests in CI

The UI checks so far ran from scripts outside the repo. Before changing UI again, move them in:
- `@playwright/test` pinned, Chromium only, run against `astro preview` of the CI build in a separate CI job.
- Suites: overflow at 1280/390/320, console errors, tab and dialog keyboard behaviour (charts, new, category, install sheet), search interactions, icon fallback with the CDN blocked, axe (WCAG A/AA).
- Search timing: CDP 4× CPU throttle, cold cache, time from the first keystroke to the first rendered result, median of 5 runs, budget 1s.
- ~~Reduced-motion screenshots at 1280/390/320 committed as baselines for A3.~~ Changed when building it: full-page screenshots would change every day with the data, and the body font (system stack) renders differently on this server and on GitHub's machines, so baselines would fail CI every morning. Reduced motion is checked through computed styles instead (no animation, no transform, pause button hidden); A3 extends those checks to its transitions.
- Done 29 Oct 2026: `tests/browser/`, `npm run test:browser`, CI job `browser` (deploy waits for it). The daily data run only runs layout, a11y and search timing (owner's call, 30 Oct: the other suites test code, which only changes on push). jsDelivr is blocked by default so the suite doesn't depend on it; one test lets it through. The installs-chart test skips until the data has 7 days of history.

## Phase A · Quick fixes (no new data sources)

**A1 Search relevance.** Today the match tier decides almost everything (name 600, description 100) and popularity adds at most ~200 (`src/lib/search.ts` › `score`), so "books" ranks Frappe Books (18 installs, book-keeping) above calibre (3,640).
- Golden query set `tests/site/search-golden.test.ts` against the real catalog (CI has `data/`; skipped locally without it), landed together with the scoring change so CI never sees it failing. Cases: books/ebook → calibre; notes → obsidian, notion; password → 1password, bitwarden; browser → chrome, firefox, arc; video player → vlc, iina; terminal → ghostty, iterm2, warp; window manager → rectangle; clipboard → maccy; exact names first (wget, node, gh, firefox, rectangle, "visual studio code"); `python` → whichever formula owns the `python` alias, derived from the catalog. Top-N thresholds in the file.
- Scoring (tried in a lab copy, see the commit): partial prefixes ("obsi") stay strong; whole-word name matches, category, keyword and description matches count in proportion to how established the package is (0.25 at a handful of installs, 1 at 10k/month); exact matches too, with a floor; popularity weight 40 → 60 per decade. Editorial keywords for the cases words can't reach (calibre: ebook, epub, kindle; rectangle: window manager).
- Acceptance: golden set and all unit tests pass; Phase 0 search suite and timing budget pass.
- Done 29 Oct 2026. After the Codex review, a query equal to a package's token or id (`iperf`, `duck`) gets the full exact score again, however few installs; a one-word display name or keyword keeps the weighting ("Notes" for an 8-install app doesn't beat Obsidian). Golden set changes: `python` expects whichever formula owns the alias; `browser` expects Brave, not Arc (deprecated, discontinued); `pdf` dropped (PDF Expert has 288 installs a month, below pdfcraft and pdfcpu).

**A2 GitHub links.** Today only `homepage` is read (4/60 top casks, 11/60 top formulae have a repo; `gh` has none).
- Pipeline: also read formula `urls.stable.url`, `urls.head.url` and cask `url`; extract `github.com/<owner>/<repo>` candidates.
- Verify daily with GitHub GraphQL, 100 repos per query (~40 queries, ~40 points of the 1,000/hour `GITHUB_TOKEN` budget; rate-limit headers checked, unverified candidates keep yesterday's result). Accept when not a fork and the repo's name, owner or `homepageUrl` domain matches the package (token, name, homepage domain). Classify `source` vs `releases` (no code, only release assets, e.g. `obsidian-releases`). Store `repo: { url, kind, stars, pushedAt } | null` on `Package`.
- App page: repo link with ★ stars in the facts strip (A4); "Downloads on GitHub" for release-only repos; "Report an issue" only for source repos.
- Acceptance: ≥45/60 top formulae and ≥15/60 top casks get a verified repo (research measured 50 and 18); a hand-checked list of 30 has no wrong repo; `gh` → cli/cli.
- Done 30 Oct 2026: 49/60 and 20/60 on the cached API data, `gh` → cli/cli; the owner/hostname-only matches reviewed (see `docs/DECISIONS.md`). Counting releases timed out GraphQL at 100 repositories per query, so `releases` means "no code and a latest release". In Actions even 100 without it timed out: batches are 50, split in half on failure. The repo link and stars sit in the Information links until A4's facts strip.

**A3 Transitions.**
- Segmented controls and tabs: one sliding thumb moved with `transform` (200ms ease-out); panels crossfade (opacity 150ms). Keyboard and ARIA behaviour unchanged.
- Same-site navigations (chart periods and the rest): CSS cross-document view transitions (`@view-transition { navigation: auto; }`), short fade, header and footer named so they stay put. No JS; browsers without support just navigate.
- All of it off under `prefers-reduced-motion` (Phase 0 baselines unchanged).
- Done 30 Oct 2026. One tab script for the charts, /new and the installs chart (`src/lib/tabs.ts`). The thumb slides with `transform` and also animates its `width` (tabs differ in width; `scaleX` would squash the pill's rounded ends). The period links on /charts are pages, so they get the page fade, not a sliding pill: a named pill would carry the old label across. Header and footer are named; every part of the page change takes 150ms. After the owner looked at it: each tab reserves its bold width so the tabs don't shift, the label's colour and weight change with the thumb's 200ms, and a tab bar wider than the screen fades the side scrolled out of sight (and scrolls the selected tab into view). Headless Chromium skips cross-document transitions at random, so the browser tests check the opt-in rule and the names rather than watching a transition; when Chromium skips one, it reports an unhandled "Transition was skipped/aborted" rejection (engine behaviour, no site script involved), which the test fixture ignores.

**A4 Badges and facts strip.**
- App headers keep two badges: source and type. The source badge stays "Official" (solid) / "Community" (dashed) and gains an explainer (button with `aria-describedby`, works on tap), scoped to what Homebrew actually reviews: "The install definition is in Homebrew's official catalog; changes to it are reviewed by Homebrew's maintainers." / "From an independent developer's tap: not reviewed by Homebrew." The trust card on app pages gets the same scoping (today it says every change to the listing is reviewed).
- Facts strip under the header, App Store style: ★ stars (A2), licence, version, updated, installs 30 days. Small icons, design tokens only.
- Mock up at 1280 and 390 first and show the owner before building.
- Done 31 Oct 2026. Owner's calls on the mock-ups: the Official badge is amber with a beer stein (Phosphor, MIT; not Homebrew's mug logo) everywhere it appears, and the note opens from an ⓘ icon; badge labels are centred on their letters (`text-box: trim-both cap alphabetic`; Firefox keeps the old position). Strip contents (my recommendation, kept): GitHub stars (the repository is linked from Information, next to the website: owner's call, a name or an icon in the strip overflowed or looked odd), chart position, version with "Updated …", licence, "Requires macOS n+", installs in 30 days; each only when the package has it. On phones it sits between the name and the install card and scrolls sideways (fade, focusable when it scrolls). The note's text: official = changes to the install definition are reviewed by Homebrew's maintainers, the software comes from its developer; community = not reviewed by Homebrew. The trust card says the same.

Codex review after A1–A2 and after A3–A4.

## Phase B · New pages

**B1 Header search suggestions.** Combobox in the header search: after 2 characters, up to 6 results with icon, name and line; arrows move, Enter opens the app, last option "See all results for …". Small suggest file (top ~3,000 listed packages: id, name, line, icon flag, popularity; ~80KB gzip) built next to the search index, loaded on first focus, same scoring code as `/search`. WAI-ARIA combobox, Escape closes, works at 390, in the Phase 0 suites.
- Done 31 Oct 2026: `src/pages/search-suggest.json.ts` builds the full index's format for the 3,000 most installed listed packages, without dates and trends (80KB gzipped), so the header runs `prepare()` and `search()` from `src/lib/search.ts` unchanged; the file and the search code load on first focus. Rows show the Community badge (Official vs Community always visible). Nothing is highlighted until an arrow key, so typing and Enter still goes to `/search`. Escape closes the list first, then the search. Tests in `tests/browser/header.spec.ts`, plus axe with the list open in `a11y.spec.ts`.

**B2 Categories.**
- The data job downloads CaskFlow's `categories.json` (latest release; keep-yesterday rules as for icons) to `data/site/caskflow-categories.json`.
- One taxonomy in `content/categories.yaml`: our 14 + Games, Finance & Crypto, Science & Education, Cloud & Storage, Office (CaskFlow's "Other" and "Screensaver & Wallpaper" fold into Utilities), with a mapping table from CaskFlow ids. Editorial members lead each category in their order; CaskFlow fills the rest by popularity. Formulae keep editorial categories until the crawler (C) classifies them.
- `/categories`: every category with its icon stack, count and its 10 most installed apps, linking to `/category/<slug>`. Header "Categories" points here.
- Acceptance: under the 19,000-file guard; every official cask CaskFlow classifies appears in exactly one primary category. (Better "Similar apps" is a phase D goal: it needs tags.)
- Done 31 Oct 2026: `scripts/data/categories.ts` (stores release, names and primary per token), `caskflow:` lists in `content/categories.yaml`, `fillCategories` in `src/lib/catalog.ts`, `/categories`, header and footer links. Calls made (in `docs/DECISIONS.md`, owner can change them): editorial placement wins over CaskFlow's; category pages list their 100 most installed and link to search for the rest; LibreOffice, ONLYOFFICE and Word moved to Office; AI & LLMs maps to AI tools (secondary-only today). 14,578 files. Categories fill in on the site after the first data run with this code.

**B3 `/developers`.** Replaces the landing `#developers` anchor (footer links updated).
- Get your app into Homebrew: your own tap vs homebrew-cask/core, with Homebrew's notability rules quoted from their docs and linked. Brewhunt lists the top 100 taps; how to ask to be added.
- Claim your listing: "coming soon" (v2, with GitHub sign-in).
- Sponsor Brewhunt: one labelled "Sponsored" slot on Discover, a category or search; never in charts, install numbers or rankings; founding-sponsor offer; Tally form.
- Done 31 Oct 2026: `src/pages/developers.astro`, linked from the header, the footer's Developers column and the landing page's developers panel. Homebrew's notability thresholds are quoted from the Package Acceptance Policy (reviewed 18 Jul 2026). Waiting on the owner: the Tally link (`SPONSOR_FORM`; until then "The enquiry form opens soon") and what the founding-sponsor offer is (the page only says "We're starting with a few founding sponsors"). Asking to be added below the top 100 goes through a GitHub issue; there's no allow-list in the data job yet.

Codex review after B.

## Phase C · Enrichment crawler

**Pipeline shape.** Workflow `crawl.yml` (weekly + manual, `concurrency: crawl`), three jobs with the same separation the data job uses:
1. `fetch`: no secrets, read-only token. Fetches sources, extracts text and candidates, uploads a bounded artifact.
2. `enrich`: has `ANTHROPIC_API_KEY`, no write access, no network beyond the Anthropic API. Runs the AI step and checks on the artifact.
3. `publish`: write access, no AI key. Uploads assets to R2 and commits the enrichment output.

**Handoff to the site.** Output lives on its own branch `enrichment` (never touched by the daily data job, which deletes `site/` before publishing). It holds `enrichment.json` and a manifest with the run id, source hashes and the asset keys in R2. CI checks out `enrichment` next to `data` (missing branch = no enrichment, the site builds as today). A failed or rejected run leaves the previous version in place.

**Scope.** First run: the top 1,000 listed packages by popularity. Community packages only from taps with ≥1,000 installs in 30 days, and only after the owner approves them (step 6).

1. **Answer key.** The ~300 most installed packages without a CaskFlow icon, with the correct icon or "none", hand-picked and confirmed by the owner on a contact-sheet page; 50 hand-checked repos; stored in `tests/fixtures/answer-key/`.
2. **Fetch (SSRF-safe).** One fetcher for every outbound request: HTTP(S) only on ports 80/443, no credentials in URLs; DNS resolved first and loopback, private, link-local (incl. 169.254.169.254), multicast, reserved and IPv6-local addresses refused; the connection pinned to the checked address; at most 3 redirects, each re-checked; 15s timeout; 2MB download cap; HTML only for pages, decoded raster types for images. robots.txt respected, `brewhunt-crawler (+repo URL)` user agent, ≤1 request/s per host. Wikipedia only via Wikidata's official-website match.
3. **GitHub budget.** Repo metadata and README text through GraphQL in batches (README as the `HEAD:README.md` blob), rate-limit headers read after each batch, a resumable cursor, and the run stops before the hourly budget runs out (the bootstrap can take several hours).
4. **Cache.** Extracted text only (≤20KB per source, normalized, gzipped) in R2 keyed by content hash; Git holds only the package → hash manifest. Unchanged hashes skip the AI step.
5. **Deterministic extraction.**
   - GitHub repo from homepage links, accepted only when the repo's `homepageUrl` points back to the package's homepage domain.
   - Icon candidates in order: alias table (`content/icon-aliases.yaml`, e.g. `gh → github`), homepage apple-touch/manifest/SVG ≥128px, devicon (MIT) / dashboard-icons (Apache-2.0) exact name, GitHub org avatar when the org matches the project, Simple Icons (CC0) glyph, vendor logo. Rejected before any AI: images shared by several packages (perceptual hash), identicons, < 64px, wrong magic bytes, repo-host and GNU defaults.
   - README images: drop badges, shields, SVGs and anything < 400px wide; at most 6 candidates.
6. **AI step.** Message Batches API (50% off), Claude Haiku 5.5, no tools. Citations and structured outputs can't be combined in one request, so:
   - Summary call: sources passed as documents with citations on; plain-text summary (~100 words) and up to 5 bullets. Every sentence must carry a citation to a source span; uncited sentences are dropped.
   - Labels call (structured JSON output): 10–15 tags/synonyms and a category from the fixed list, from the same sources.
   - Icon judge: name, homepage, description and the surviving candidates → one or none.
   - Screenshot classifier: screenshot / terminal demo / logo / banner / ad / other.
7. **Checks.** Model output is untrusted draft data; nothing is published on model confidence alone.
   - Deterministic: each sentence's citation must point to an exact span in the stored source text; every number must appear in its cited span; no URLs, HTML or markdown in text; length limits; no claims about other products.
   - A second model (Claude Sonnet 5.5) checks each summary sentence against its cited span (supported / not). It can only drop content, never approve it.
   - Human approval: the whole first run, every community package, and any package whose sources changed materially (README rewritten) go to a review page before publishing. Later runs publish unchanged-source items automatically.
8. **Quality gate** (blocking; a failed gate keeps the previous enrichment). On a fixed random sample (seed in the run manifest) of 100 summaries and 100 screenshot picks, plus the icon answer key:
   - Wrong icons < 2% on the answer key.
   - Unsupported sentences < 1% of sentences; misattributed or materially wrong summaries < 2% of summaries; unsafe content 0.
   - Screenshot picks that aren't screenshots or demos < 5%.
9. **Assets, rights and takedown.** Icons and screenshots are fetched through the safe fetcher, decoded, checked for type and size, stripped of metadata, re-encoded (icons 128px WebP, screenshots ≤1600px WebP), hashed and stored in R2 (immutable keys), served from Brewhunt's asset domain. Per asset: source URL, source revision, licence (or "trademark: identification use"), credit and review basis. `content/takedown.yaml` (package ids and asset hashes) wins over every crawler result and deletes the R2 objects on the next run; the developers page says how to ask. Screenshots credited under the carousel ("Screenshot from the project's README").
10. **Cost guard.** Before each batch: worst-case cost from input tokens, images, `max_tokens` and both models. Work goes in small batches that each fit the remaining budget (cap per run, default $10); the next batch is submitted only after the previous one's real usage is reconciled. If the cap can't cover a batch, the run stops before submitting it.

Tags also feed search (scored like keywords) and "Similar apps".

Codex review after C (security focus: fetcher, prompt injection, untrusted text and URLs).

## Phase D · App page

**D1 Redesign** around the new data, mocked up first and in the design's style: header with source/type badges and facts strip; About (labelled "Summary written by Brewhunt from the README and website", with source links, with the developer's own text in v2); screenshots carousel (keyboard and swipe, lazy, credited); GitHub card (stars, last commit, licence, issues); installs chart (needs 7 days of history); Manage it; Information; Similar apps from shared tags and categories (acceptance: calibre's similar apps are e-book or reading apps); "Is this your app?" → `/developers#claim`. Fill the empty column under "Manage it". Every enrichment block says where it came from.

**D2 Content-Security-Policy.** A CSP in `public/_headers` (no inline-script exceptions beyond what Astro needs; `img-src` limited to the site, the asset domain and jsDelivr) as a second line of defence for crawled text and URLs. Every external URL rendered on a page (homepages, repos, screenshot sources) must be an absolute `https:` URL without credentials.

Developer verification is not in M5: owner's call (29 Oct 2026) to build it in v2 with GitHub sign-in, the developer UI and payments, with the same URL and content rules.

Codex review after D.

## Phase E · Semantic search (after the Cloudflare deploy works)

- **Deploy shape first.** `wrangler pages deploy dist` uploads only static files today. Phase E builds the function into the artifact (Pages "advanced mode" `_worker.js` in `dist/`, with the Workers AI binding in `wrangler.toml`), and a post-deploy check asserts `/api/search?q=test` answers from the function, not the 404 page.
- **Feasibility gate.** Workers Free allows 10ms CPU per request and 100,000 requests a day. Benchmark in a preview deploy: int8 vectors (5,000 × 384 ≈ 1.9MB) bundled with the worker, brute-force cosine, p95 CPU cold and warm. If it doesn't fit 10ms reliably: Vectorize (free at this size) or the $5 Workers Paid plan.
- The crawler computes one embedding per package with the same model the function uses (`@cf/baai/bge-small-en-v1.5`, from name + summary + tags).
- `/api/search`: query trimmed to 100 characters and normalized, cached per query (Cache API), rate-limited per client, returns the top ids and scores. `/search` and suggestions blend keyword and semantic results (reciprocal rank fusion, then the popularity weighting); any error, timeout or 429 falls back to keyword search.
- Golden queries extended with intent queries ("read epub", "record my screen", "tile windows").

Codex review after E.

## Docs to update as phases land

CLAUDE.md (README screenshots allowed with credit; Brewhunt-written summaries labelled; the Pages Function exception), `docs/DECISIONS.md` (each call above, including the rights basis per asset source), `docs/DATA.md` (new sources, the `enrichment` branch), `docs/ROADMAP.md` (tick items; v2: GitHub sign-in, payments, self-serve sponsorship).
