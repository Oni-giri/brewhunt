# Brewhunt

Brewhunt is a web app store for everything you can install with Homebrew: Mac apps (casks), command-line tools (formulae), and packages from community taps. People come to **discover** apps, see **what's new and trending**, and get the **one-line install command**. Later, developers will be able to claim listings and promote them. That's out of scope for v1.

The design phase is done. This repo starts from a design handoff; your job is to build the site.

## Read these first

| File | What it is |
|---|---|
| `docs/PRODUCT.md` | Scope, routes, and a spec for every page |
| `docs/DESIGN-SYSTEM.md` | Tokens (colour, type, spacing, radius, shadow) and the component inventory |
| `docs/DATA.md` | Where the data comes from (Homebrew JSON API + analytics) and the refresh pipeline |
| `docs/ROADMAP.md` | Milestones and the first tasks, in order |
| `design/README.md` | How to use the design files |

## Design is the source of truth

- `design/screens/*.html`: static HTML of every page, open in a browser. Match these closely: spacing, type, colour, radii, states.
- `design/screenshots/*-desktop.png` / `*-mobile.png`: the same pages at 1280px and 390px.
- `design/source/*.dc.html`: the original interactive prototypes. Their `<script>` holds the interaction logic (filters, tabs, install sheet, chart hover). Read them for behaviour; don't ship them.
- `design/assets/`: logo, favicon set, social avatar, link-preview image, home-screen icon.

When the design and these docs disagree, ask. Placeholder values in the designs look like `[n]`, `[n]k`, `[date]`, `[x.y.z]`, `[Screenshot …]`. They must come from real data, never be shipped as text.

## Product rules

- **Store-first, not installer-first.** Lead with discovery; the install command is the action, not the pitch.
- **Honest data.** Install numbers come from Homebrew's public, opt-out analytics. Label periods ("Installs · 30 days") and say it's relative popularity. Never invent numbers.
- **Official vs Community** is always visible: a solid "Official" badge for homebrew-core/cask, a dashed "Community" badge for third-party taps, plus a "not reviewed by Homebrew" note in the install sheet for community packages.
- **Not affiliated** with Homebrew or Apple. Keep the footer disclaimer. Don't use Homebrew's logo.
- No real app icons or screenshots until a developer claims a listing. Use the initial-letter gradient tiles from the designs.

## Stack

The site is static: about 15k app pages plus lists, rebuilt once a day from Homebrew's data. Keep it that way. It must be hostable as plain files anywhere (Cloudflare Pages, Netlify, GitHub Pages, or nginx on a VPS), with no Node server in production.

- **Astro + TypeScript**, `output: 'static'`. One page per package via `getStaticPaths()` from the data pipeline's output.
- **Interactivity as small islands or plain scripts**, only where the design needs it: install sheet, mobile menu and header search, search filters and sort, tabs and segmented controls, chart hover, marquee pause. Prefer vanilla TS or tiny components (Preact/Svelte islands are fine). No client JS on pages that don't need it.
- **Styling:** CSS variables for the tokens in `docs/DESIGN-SYSTEM.md`, scoped Astro component styles. Tailwind is fine if mapped to the same tokens.
- **Fonts:** Geist self-hosted (e.g. `@fontsource/geist`) for headings and the wordmark; system font stack for body.
- **Search:** Pagefind, which indexes the built HTML at build time, so search needs no server. Filters map to Pagefind filters (type, source, category).
- **Hosting:** Cloudflare Pages by default (free, static, fast). A daily GitHub Actions job fetches data, builds and deploys.
- **Later** (developer claims, accounts): add a small separate API or Astro server endpoints only then. Don't add a server for v1.

## Working conventions

- Accessibility is a requirement: touch targets ≥ 44px, visible focus, labelled controls, tabs with arrow keys, dialogs closing on Escape, mobile nav focus handling. The prototypes already do this; keep it.
- Everything must work at 390px wide without horizontal scroll (only explicit carousels scroll sideways).
- Keep pages fast: static where possible, images lazy, no client JS where HTML will do.
