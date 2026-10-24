# Roadmap

## M0 · Foundations
- [ ] Scaffold Next.js + TypeScript, lint/format, CI.
- [ ] Design tokens as CSS variables (`docs/DESIGN-SYSTEM.md`), Geist font, base layout, header pill + footer + mobile menu.
- [ ] Brand assets and `<head>` tags (`design/README.md`).

## M1 · Data pipeline
- [ ] Fetch scripts for metadata + analytics; typed parsers; daily snapshot storage.
- [ ] `first_seen` tracking for "new", trend computation, dependency/library filtering.
- [ ] Community-tap enrichment for the top N taps.
- [ ] `content/` curation file (categories, picks, collections) with a schema.
- [ ] Scheduled GitHub Action that refreshes data and triggers a rebuild.

## M2 · Core pages
- [ ] App page `/app/[token]`, statically generated for every package, with SEO metadata + structured data.
- [ ] Install sheet (Get) component with copy-to-clipboard.
- [ ] Discover home `/discover`.
- [ ] Search `/search` with client-side index, filters, sort, mobile filter toggle.

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

## Later
- Developer claim flow, uploaded icons/screenshots, promotion, newsletter backend, user accounts.
