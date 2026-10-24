# Design system

Extracted from the screens in `design/`. The static HTML is the source of truth; this file names the values so they can become tokens.

## Colour

| Token | Value | Use |
|---|---|---|
| `--bg` | `#F4F7FB` | Page background (store pages) |
| `--surface` | `#FFFFFF` | Cards, panels, header pill, search pill |
| `--border` | `#E6E8EE` | 1px edge on every white surface (cards would vanish on `--bg` otherwise) |
| `--divider` | `#F0F0F3` | Row separators inside cards |
| `--ink` | `#1D1D1F` | Primary text, primary buttons, "Official" badge |
| `--text-body` | `#3A3A3C` | Long-form body copy |
| `--text-secondary` | `#5E6068` | Subtitles, descriptions |
| `--text-meta` | `#6E6E73` | Meta lines, ranks, captions |
| `--link` / `--link-hover` | `#1F5FD6` / `#16449B` | Links, "Get" button label |
| `--accent` | `#2F6BFF` | Checkboxes/radios, chart line, focus |
| `--chip` | `#EDEEF2` | Secondary buttons ("Get", "Read more"), segmented track on cards |
| `--track` | `#E8E8ED` | Tab / segmented-control track on the page background |
| `--navy` | `#10132A` | Footer, code blocks, dark sections |
| `--navy-text` | `#C3C7D6` | Footer links (hover → white) |
| `--filter-chip-bg` / `--filter-chip-text` | `#E8F0FF` / `#16449B` | Active filter chips on search |
| `--trend-up` | `#1E7A46` | "↑ n%" movers |
| Sky gradient (landing hero) | `linear-gradient(180deg, #1A3FBF 0%, #2459D8 30%, #2F6BE0 62%, #7DB4F2 78%, #CFE5FA 92%, #F4F7FB 100%)` | Landing page only. Inner pages have a plain light header. |

App-icon placeholder tiles use 160° two-stop gradients per category (blue `#5AA9FF→#1F5FD6`, orange `#FFB347→#F26B1D`, green `#7BE495→#1E9E5A`, purple `#C3A6FF→#6B3FD6`, pink `#FF8FB1→#E0336E`, yellow `#FFE88A→#F2B705` with dark text `#3A2A00`, teal `#7FE3E0→#159C9A`, slate `#B8C2D3→#5B6577`, terminal `#3A3A40→#0E0E10` with monospace initials).

## Typography

- **Headings and wordmark:** Geist (400/500/600). **Body:** system stack `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif`. **Code:** `ui-monospace, 'SF Mono', Menlo, monospace`.
- No serif fonts anywhere (explicit product decision).

| Role | Spec |
|---|---|
| Landing hero h1 | Geist 500, `clamp(44px, 6.2vw, 80px)`, line-height 1.06, tracking −0.035em, `text-wrap: balance`, white on sky |
| Page title (store h1) | Geist 600, 36px, line-height 1.1, tracking −0.025em (app page title is larger, see `screens/app.html`) |
| Section h2 | Geist 600, 32px, line-height 1.05, tracking −0.03em, with a 14px/600 grey eyebrow above |
| Card h2 / panel title | Geist 600, 20–28px, tracking −0.02em |
| Lead / subtitle | 17px, `--text-secondary` |
| Body | 16px / 1.5 |
| Nav links | 15px |
| Meta / captions | 13–14px, `--text-meta` |
| Badges | 12px (list) or 13px (page header), weight 600 |
| Wordmark | Geist 600, 20px, tracking −0.035em |

## Spacing, layout, radius, shadow

- Content max-width **1160px** with **24px** side gutters (header pill max 1112px, landing header 1080px).
- Section rhythm: 40–64px between sections; 16–20px between cards; card padding 16–28px.
- Breakpoints: **760px** (nav links collapse into the menu button, filters fold into a "Filters" button) and **480px** (secondary columns hide).
- Radius: pills **999px**; big panels **28px**; cards and list rows **20px**; inner stages **14–16px**; code blocks **12px**; icon tiles ≈ **22–23%** of their size (48→11, 56→13, 112→25).
- Shadows: header `0 1px 0 rgba(0,0,0,.04), 0 10px 30px -18px rgba(8,25,80,.35)`; floating/install card `0 24px 50px -28px rgba(8,25,80,.6)`; hover lift `translateY(-3/-4px)` + `0 24px 40px -24px rgba(8,25,80,.4)` (disabled under `prefers-reduced-motion`).
- Minimum touch target **44px** (buttons, chips, tabs, filter rows, breadcrumb links).

## Components

| Component | Notes | Seen in |
|---|---|---|
| Header pill | Floating rounded bar: logo + wordmark, nav links (current page bold + `aria-current`), search button that opens an inline search field, menu button under 760px with a dropdown (focus moves in, Escape closes). On the landing page it's frosted (`rgba(255,255,255,.78)` + blur) over the sky. | all |
| Footer | Navy, brand blurb, 4 link columns (Discover, Categories, Developers, Help), disclaimer row. Landing adds a newsletter field. | all |
| Search pill | White pill, magnifier, input, black "Search" submit. | home, search, landing |
| App row | Icon tile, name (+ badge), one-line description (clamped to 2 lines), meta line, "Get" button. | search, new, category, charts, similar apps |
| Ranked row | Rank number, icon, name/description, category (hidden <760), installs + trend (hidden <480), Get. | charts, home |
| Get / install sheet | Modal dialog: icon, name, the `brew install …` command in a navy code block, Copy button (shows "Copied ✓"), "View app page"; community packages add "not reviewed by Homebrew". Closes on Escape and backdrop click. | everywhere there's a Get |
| Badges | "Official" solid ink pill; "Community" dashed outline; neutral info pills (white + border). Two sizes: 20px (lists) and 24px (page headers). | all |
| Collection card | Coloured card with a stack of overlapping icon tiles, eyebrow, title, subtitle. | home |
| Category row | Overlapping icon stack + title + example app names + chevron. | home, landing |
| Stat card | Label, big Geist number, note. | app, tap |
| Installs chart | Line chart with y-axis values, start/mid/end dates, hover readout (vertical rule + dot + tooltip), 30/90/365-day segmented control (arrow keys). | app |
| Segmented control / tabs | Track `--track`, selected = white pill with small shadow; `role=tablist`, roving tabindex, arrow/Home/End keys. | new, charts, app |
| Filters | Radio groups + category checkboxes; active filters shown as removable chips with "Clear all"; folds into a "Filters (n)" toggle under 760px. Sort select. | search |
| Safety notice | Bordered card with shield icon for community taps, "View source" button. | tap |
| Claim CTA | Light sky gradient card, "Is this your app? / Claim this app". | app, tap |

## Logo

See `design/README.md` → Brand assets.
