# Decisions to review

Calls made while the owner was away, where the docs said one thing and the constraints said another. Each one is reversible; the alternative is noted.

## Search: a prebuilt JSON index instead of Pagefind (28 Oct 2026)

**Docs said:** Pagefind (CLAUDE.md, Stack).

**Problem:** Cloudflare Pages' free plan allows 20,000 files per deployment (paid plans: 100,000 with `PAGES_WRANGLER_MAJOR_VERSION=4`). Brewhunt has about 15,000 package pages, and Pagefind writes one fragment file per indexed page plus index chunks: about 30,000 files. Pagefind also ranks by text relevance with no popularity signal, and its sort replaces relevance rather than blending with it, so typing "fire" wouldn't reliably put Firefox first.

**Decision:** search runs on a compact JSON index generated at build time (one file, loaded only by `/search`; the header's suggestions load a 3,000-package cut of it, about 80KB gzipped, on first focus), with matching, scoring, filters and sorts in a small script. It needs no server, so the "plain files anywhere" rule still holds. The search page talks to it through one function (`search(query, filters, sort)`), so Pagefind can come back without touching the UI.

**To reverse:** upgrade Cloudflare to a paid plan (or host elsewhere), swap the search module for Pagefind.

## Which packages get a page (28 Oct 2026)

Same file limit. Every page is a file, and the catalogue grows by roughly 1,000 packages a year.

- **Page:** every installable official formula and cask (libraries, versioned, deprecated and Linux-only ones too: "brew install openssl" is a real query), and community packages from the top 100 taps with at least 10 installs in the last year or added in the last 30 days.
- **No page for now:** disabled packages (can't be installed), font casks (about 2,600 with no description; a single fonts list can come later), and the community long tail (they're on their tap's page).
- **Listed but kept out of discovery, charts and New:** libraries, versioned formulae, Linux-only casks, deprecated packages.

CI fails the build if `dist/` goes over 19,000 files. If it gets close, prune in this order: fonts (already out), community tail, low-install libraries.

## Source badges in list rows (28 Oct 2026)

**Docs said:** "Official vs Community is always visible: a solid Official badge … a dashed Community badge" (CLAUDE.md).

**Design shows:** list rows (search results, category lists, charts, similar apps) carry only the Community badge; Official rows have none. Cards (New this week) and page headers show both.

**Decision:** followed the design: rows mark community packages, and an unmarked row is official. Every app page states the source in full, and the install sheet warns for community packages.

**To reverse:** render `SourceBadge` unconditionally in `AppCard.astro` and `RankedRow.astro` (and the search row template).

## Cask type: Mac app or command-line tool (28 Oct 2026)

A cask that installs only command-line programs (`binary`, no app, pkg or plugin) counts as a command-line tool: codex, claude-code, gcloud-cli. A `.pkg` installer can hold either, so pkg casks count as apps unless `content/packages.yaml` says `type: cli` (set for the .NET SDK, the AWS session plugin and the ARM toolchains).

## Real app icons from CaskFlow (28 Oct 2026)

**Docs said:** no real app icons until a developer claims a listing; the designs only show gradient tiles.

**Owner's call:** use real icons, as Applite does. Showing an app's icon next to its name to identify it is treated as fair use.

**Decision:** official casks use [CaskFlow](https://github.com/alielsokary/CaskFlow)'s icons (MIT licensed project; the icons themselves belong to each app's developer). CaskFlow extracts them from the app bundles and publishes 256px PNGs by token; it covers about 89% of official casks. The data job records which tokens have one and the commit (`data/site/icons.json`); pages load them from jsDelivr pinned to that commit, lazily, with the gradient tile underneath that comes back if an image fails. Formulae, command-line casks CaskFlow lacks, and community taps keep the tiles. The footer credits CaskFlow.

**Costs:** visitors' browsers contact jsDelivr (worth a line in the privacy page), and a list of 100 apps can load a few MB of PNGs. Self-hosting downscaled icons on R2 is on the roadmap. A developer who wants their icon removed: add the token to a skip list (not built yet).

**To reverse:** make `iconFor` in `src/lib/catalog.ts` return null, and every icon goes back to its tile.

## Categories from CaskFlow (31 Oct 2026)

**Plan (M5 B2):** one taxonomy: our 14 categories plus Games, Finance & crypto, Science & education, Cloud & storage and Office, filled with the Mac apps CaskFlow classifies.

**Decision:** the data job keeps each official cask's primary category from CaskFlow's latest release (`data/site/caskflow-categories.json`; CaskFlow is MIT licensed, and the classification is a list of tokens and ids, credited in the footer). Each of our categories names the CaskFlow categories that fill it (`caskflow:` in `content/categories.yaml`): Audio & Music and Video & Media go to Video & audio; Other and Screensaver & Wallpaper to Utilities; AI & LLMs to AI tools (CaskFlow only uses it as a secondary category, so it adds nothing today). Secondary categories aren't used, and formulae keep their editorial categories until the crawler (phase C).

- **The editors win.** A package listed anywhere in `categories.yaml` keeps only the categories it's listed in; CaskFlow's opinion is ignored for it. Otherwise curated placements get diluted (Ice would also land in Utilities). Every other official cask CaskFlow classifies has exactly one category, its primary.
- **Fill order:** the editors' list first, in their order (it leads the icon stacks), then CaskFlow's listed apps, most installed first.
- **Big pages:** Utilities holds about 960 apps and Developer tools about 780, so a category page lists its 100 most installed (about 160KB of HTML) and links to `/search?cat=<slug>`, whose filter covers them all. Its sort and sub-category chips work on those 100.
- **Office:** LibreOffice, ONLYOFFICE and Word moved from Writing & notes to the new Office category (with Excel and PowerPoint), and Writing & notes no longer says "office suites". Owner can move them back.
- A category with nothing in it (before the first data run with CaskFlow's file) stays off the site.

**To reverse:** remove the `caskflow:` lists, and categories go back to the editors' lists.

## Editor's picks without the screenshot area (31 Oct 2026)

**Design:** pick cards (landing, Discover, category pages) open with a large area for a screenshot.

**Decision (owner, 31 Oct 2026):** there are no screenshots yet, and a bigger copy of the icon in that space only repeated the row below it, so the cards start with the icon, name and Get, and the editors' blurb carries them. On Discover the pick takes half the row next to the collections instead of two thirds.

**To reverse:** when phase C/D brings real screenshots, a pick that has one shows it in that space; a pick without one keeps the compact card.

## Content-Security-Policy (3 Nov 2026)

**In `public/_headers`**, not Astro's `security.csp`: Astro's puts per-page hashes in a `<meta>` tag, which can't set `frame-ancestors`, and still wouldn't allow the icons' inline `onerror` handlers. So nothing is inline: Astro emits every script and stylesheet as a file (`vite.build.assetsInlineLimit: 0`, `build.inlineStylesheets: 'never'`; a page loads up to eight small stylesheets, cached), the no-JavaScript rules are files in `public/` loaded from `<noscript>`, and a failed icon falls back to its tile through one listener (`watchIconFailures`). JSON-LD is a data block, which the policy doesn't touch.

**Style attributes stay allowed** (`style-src-attr 'unsafe-inline'`): tiles get their size and colour as CSS variables at build time, never from crawled text. Safari before 15.4 ignores `style-src-attr` and would drop them.

**External links** go through `externalUrl` (`src/lib/urls.ts`): an absolute `http:` or `https:` URL without credentials, as given, or no link. The plan said `https:` only; 177 of Homebrew's 18,065 homepages are `http:`, and the danger is `javascript:` or `data:`, not the scheme, so they stay. To go https-only, change one line.

**Not covered:** `astro preview` (and the tailnet preview) doesn't read `_headers`, so only the deployed site and the browser tests run under the policy. The crawler's asset domain joins `img-src` once it exists.

## Crawled images: keys, rights and takedowns (3 Nov 2026)

**Keys** are `icons/v1/<hash>.webp` and `screenshots/v1/<hash>.webp`, where the hash is the source file's sha256, not the WebP's. A takedown by hash keeps matching after the encoder changes, and changing how images are encoded bumps `v1` instead of changing what a live URL serves. The record keeps both hashes, and a takedown matches either.

**Rights basis per source:** an icon is the project's logo, shown to identify it ("trademark: identification use"), wherever it was found (homepage, README, icon library, the organisation's avatar). A README screenshot is recorded with the repository's licence and credited "Screenshot from the project's README"; one whose repository has no licence GitHub recognises is recorded with none (whether to show those is the owner's call before phase D).

**Animated demos (my default, owner to confirm):** kept animated only within 300 frames, about 50 million pixels across all frames and 4 MB as WebP; otherwise shown as a still, the busiest of four frames. In a 30-package dry run all three animated READMEs were past the limit.

**Takedowns** (`content/takedown.yaml`, how to ask: `/developers#remove`): an entry without hashes removes everything crawled for the package and its CaskFlow icon; hashes remove just those images, for every package showing them. An entry stays when the package leaves Homebrew.

## The AI step: Claude Haiku through the API (6 Nov 2026)

**The plan said** Claude Haiku 5.5 on the Message Batches API, with the icon judge and the summary writer left open (GLM through Inco had been measured as the judge).

**Owner's call:** Haiku for the whole batch (summary, labels, icon judge, screenshot classifier), paid with an Anthropic API key, not run through Claude Code on the owner's plan, which would share the owner's own usage limits. `scripts/crawl/enrich.ts`. On the 30-package test run it cost $0.03 (about $1 per 1,000 packages), against a $10 cap per run.

**Also (my calls, the owner can change them):** a summary sentence in the first person ("we", "our") is dropped, since Brewhunt writes the summary and "Our software is tested daily" would read as Brewhunt's claim; second person ("lets you switch versions") stays. Haiku as the icon judge, on the owner's answer key: 2 wrong of 296, as GLM, but 43 missed against GLM's 17, mostly organisation avatars the owner accepted as the tool's logo, and 31 picks the owner hasn't seen. The first run's review catches a wrong icon; a missed one is a letter tile.

**To reverse:** `enrich.ts` takes its requests from `ai.ts`. The icon judge has since moved to GLM (next entry).

## The icon judge: GLM through Inco, not Haiku (7 Nov 2026)

**Owner's call**, after the first real drafts: Haiku's icons were wrong for node (a menu icon: it described the green hexagon but answered the hamburger's number) and uv (Astral's own logo, which it called uv's), where GLM 5.3 Flash picked right on the same candidates. On those 30 packages GLM had no wrong logo and Haiku 2, and Haiku left 1 icon the owner chose as a letter tile; Haiku's picks also changed with the candidates' order between two crawls. Haiku still writes the summary and labels and sorts the screenshots.

**Where:** `judge.ts` (`askJudge`, `readJudge`), called by `enrich.ts` while the Haiku batch runs, under the same cost guard (GLM: $0.15/$0.50 per million tokens, no batches); `INCO_AI_API_KEY` is the third secret `crawl.yml` waits for.

**Also (my call):** each candidate image now carries its number in a band above it, drawn as seven-segment digits (no font needed), so a model can't pair a label with the wrong image. On the answer key it made no difference to GLM that a run can show (2 wrong and 20 missed with numbers, 1 and 21 without, two fresh runs; the 17 missed measured before were on the picks the owner had approved wholesale), so it stays as a guard. The judge runs at Inco's `max` effort, set explicitly, and an empty answer is asked once more: at `high` it thought a sixth as long but chose about three times as many wrong images (a menu chevron, an arrow, a README screenshot), and at `max` it sometimes thinks through all 4,000 tokens without answering. Its picks still vary from run to run (uv over six tries at lower effort: the pink u three times, Astral's logo twice), which the owner's review of the first run is there to catch. On the key: $0.24 for 300 packages, about $0.80 per 1,000.

**To reverse:** `enrich.ts`'s `judgeAll` calls `askJudge`; another model on an OpenAI-style endpoint is a different `model`, and Haiku would mean an icon request back in `ai.ts`.

## README screenshots for Mac apps only (4 Nov 2026)

**The plan said** README images become screenshots for every package (step 9), while CLAUDE.md still said no real screenshots until a developer claims a listing.

**Owner's call:** Mac apps (casks) get README screenshots; command-line tools get none until a developer claims the listing. In the 30-package test run, 4 of 23 formulae had README images kept, and half were not screenshots: mole's two mascot drawings, a photo of fzf mugs and a colour banner, next to gh's, mise's and fzf's useful terminal captures. A CLI's page leads with its summary and install command, and the crawl can't tell a terminal capture from a mascot without the classifier.

**Where:** `showsScreenshots` in `scripts/crawl/enrichment.ts`. The dry run doesn't fetch a formula's README images, `assets-run.ts` skips them in older runs, and the site and the review page leave them out whatever the branch holds.

**To reverse:** let `showsScreenshots` take formulae too, perhaps only those a classifier calls terminal captures.

## The crawl's review: verdicts on `main`, drafts on the branch (3 Nov 2026)

**The plan said** the first run, community packages and changed sources go to a review page before publishing, without saying where the verdicts live.

**Decision:** the `enrichment` branch holds both what's published and the draft waiting (`pending`, with its hash); the owner's verdicts go in `content/approvals.yaml` on `main`, by draft hash. The site applies them at build time, as it applies takedowns, so approving is one commit and shows on the next deploy without a crawl; the next crawl folds approved drafts into `published`. A verdict names one exact draft: a later, different draft waits again, and the approved one stays shown meanwhile. Rejected drafts aren't asked about again. "Sources changed" is any change to a source text's hash, stricter than the plan's "README rewritten", until the first runs show how often that triggers.

**Also:** images are uploaded before the file that refers to them is committed, and deleted only after the site that stopped showing them is deployed. The jobs holding the R2 keys and the write token run no npm code (the AWS CLI on the runner does the upload), as in the data workflow.

**To reverse:** keep verdicts on the branch instead (a review page writing to it through a workflow dispatch), at the cost of a crawl run per approval.

## GitHub repositories from download URLs (30 Oct 2026)

Homebrew gives a homepage, which is rarely the repository (gh's is cli.github.com). The data job also reads the formula `urls.stable`/`urls.head`, the cask `url` and community taps' `url`/`head` stanzas, keeps the `github.com/owner/repo` candidates and looks them up with GitHub GraphQL (`scripts/data/repos.ts`, about 8,100 repositories in about 165 queries of 50, one point each, one at a time: about 8 minutes).

**Accepted when** the repository isn't a fork and: the homepage is the repository (the author's own word); or its name, owner, owner and name together, or a whole word of its name is the package's token (without `@version`) or display name (docker/compose for docker-compose, obsidianmd/obsidian-releases for obsidian); or its own homepage is on the same host as the package's (cli/cli is cli.github.com; the full hostname, never just the domain). Parts of words never match ("go" isn't in "mongo").

**Kind:** a repository with no code GitHub recognises and at least one release is `releases` ("Downloads on GitHub", no "Report an issue"); everything else is `source`. Archived repositories keep the link but lose "Report an issue".

**Checked on 30 Oct 2026:** 49 of the 60 most installed formulae and 20 of the 60 most installed casks get a repository (plan: 45 and 15). The 531 accepted only on owner or hostname were reviewed by hand from the most installed down; the questionable-looking ones were right (docker → docker/cli, telnet → apple-oss-distributions/remote_cmds).

**Failure:** a batch that fails (HTTP error, or a GraphQL error about the whole query) is split in half and retried; the lookup stops before the hourly budget runs out. When GitHub says to slow down (403 or 429 with budget left: its secondary limits, which the Actions token hit after about 40 quick queries), it waits as told (`retry-after`, else a minute), up to 10 minutes in all. A package whose candidates GitHub didn't all answer keeps yesterday's repository, unless GitHub said that one is gone or no longer qualifies. The run never fails over it: meta.json gets a warning with the count and the last error.

**Two repositories:** when the homepage is a repository (GitLab, Codeberg) and the GitHub one found is different (a mirror), the app page links both, and "Report an issue" goes to the homepage's.

