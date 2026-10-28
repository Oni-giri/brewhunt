# Roadmap

## M0 · Foundations
- [x] Scaffold Astro (static output) + TypeScript, lint/format, CI that builds the site.
- [x] Design tokens as CSS variables (`docs/DESIGN-SYSTEM.md`), self-hosted Geist, base layout, header pill + footer + mobile menu.
- [ ] Deploy the empty shell to Cloudflare Pages so every later change ships for real. (Workflow ready; waiting on the Cloudflare project and secrets.)
- [x] Brand assets and `<head>` tags (`design/README.md`).

## M1 · Data pipeline
- [x] Fetch scripts for metadata + analytics; typed parsers; daily snapshot storage.
- [x] `first_seen` tracking for "new", trend computation, dependency/library filtering.
- [x] Community-tap enrichment for the top N taps.
- [x] `content/` curation file (categories, picks, collections) with a schema.
- [x] Scheduled GitHub Action that refreshes data and triggers a rebuild.

## M2 · Core pages
- [ ] App page `/app/[token]`, statically generated for every package, with SEO metadata + structured data.
- [ ] Install sheet (Get) component with copy-to-clipboard.
- [ ] Discover home `/discover`.
- [ ] Search `/search` with Pagefind (filters for type, source, category), sort, mobile filter toggle.

## M3 · Lists
- [ ] Top charts `/charts`.
- [ ] New this week `/new` (+ RSS feed).
- [ ] Category pages `/category/[slug]`.
- [ ] Tap pages `/tap/[owner]/[repo]`.

## M4 · Landing + launch
- [ ] Landing page `/` (sky hero, app wall marquee, sections).
- [ ] Sitemap, robots, OG images, analytics (privacy-friendly), 404.
- [ ] Accessibility pass (keyboard, focus, contrast, 390px layouts), performance pass.
- [ ] Deploy to the production domain.

## Beyond v1: the long-term roadmap

### v1.x · Richer discovery
- Move the daily snapshots from the `data` git branch to Cloudflare R2 once the branch gets heavy (about 55MB a year of history).
- Weekly "New this week" newsletter and RSS feeds per category.
- More editorial: collections ("Set up a new Mac", "Menu bar essentials"), staff picks with short write-ups.
- "Alternatives to …" pages (an SEO goldmine: "rectangle alternatives mac").
- Compare two apps side by side.
- Real app icons pulled from cask metadata or app bundles where licensing allows.

### v2 · Brewfile builder
- Pick apps while browsing, then export a ready-to-run `Brewfile` (or a one-line `brew install` for all of them).
- Shareable setups: "My Mac setup" pages people can publish and share ("dotfiles for apps").
- Import an existing Brewfile to see your setup and get suggestions.

### v3 · For developers
- Claim a listing (verify via GitHub repo ownership), add icon, screenshots, description, links.
- Verified badge and a developer dashboard with install trends.
- Help get a tap or cask into Homebrew; launch announcements in "New this week".
- Promoted placements, clearly labelled. This is the business model.

### v4 · Ecosystem
- Accounts with favourites, follows, and notifications when an app updates.
- Public API and embeddable install badges ("Install with Brewhunt") for READMEs.
- Raycast extension / CLI companion to search Brewhunt from the terminal.
- Beyond macOS: Linuxbrew-friendly listings.
