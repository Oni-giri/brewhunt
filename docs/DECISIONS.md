# Decisions to review

Calls made while the owner was away, where the docs said one thing and the constraints said another. Each one is reversible; the alternative is noted.

## Search: a prebuilt JSON index instead of Pagefind (28 Oct 2026)

**Docs said:** Pagefind (CLAUDE.md, Stack).

**Problem:** Cloudflare Pages' free plan allows 20,000 files per deployment (paid plans: 100,000 with `PAGES_WRANGLER_MAJOR_VERSION=4`). Brewhunt has about 15,000 package pages, and Pagefind writes one fragment file per indexed page plus index chunks: about 30,000 files. Pagefind also ranks by text relevance with no popularity signal, and its sort replaces relevance rather than blending with it, so typing "fire" wouldn't reliably put Firefox first.

**Decision:** search runs on a compact JSON index generated at build time (one hashed file, loaded only by `/search`), with matching, scoring, filters and sorts in a small script. It needs no server, so the "plain files anywhere" rule still holds. The search page talks to it through one function (`search(query, filters, sort)`), so Pagefind can come back without touching the UI.

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
