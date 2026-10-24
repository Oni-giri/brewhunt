# Product spec (v1)

## What it is

A store front for the Homebrew catalogue: Mac apps (casks), command-line tools (formulae) and packages from public community taps. Visitors browse and search like an app store, see install popularity and what's new, and copy the `brew install` command.

**In scope for v1:** landing, discover home, search, app page, new this week, top charts, category pages, tap pages, logo/meta/SEO basics.
**Later:** developer accounts ("Claim this app"), uploaded screenshots/icons, promotion, newsletter backend, RSS (designed, low priority), user accounts.

## Routes

| Route | Page | Design |
|---|---|---|
| `/` | Landing (store-first marketing page) | `design/screens/landing.html` |
| `/discover` | Store home | `home.html` |
| `/search?q=` | Search + filters | `search.html` |
| `/app/[token]` | App page (cask or formula; tap packages use `owner/tap/name`) | `app.html` |
| `/new` | New this week | `new.html` |
| `/charts` | Top charts | `charts.html` |
| `/category/[slug]` | Category | `category.html` |
| `/tap/[owner]/[repo]` | Community tap | `tap.html` |

SEO matters: the main traffic will come from app pages ranking for "‹app› homebrew", "brew install ‹app›" and "‹app› alternative mac". App pages must be static, fast, with good titles, descriptions, canonical URLs and structured data (`SoftwareApplication`).

## Pages

### Landing `/`
Sky-gradient hero with the frosted header, headline "Discover great Mac apps. Thousands [3 icon tiles] of them.", search pill, popular chips, a tilted "app wall" marquee (pause/play button, pauses on hover, respects reduced motion). Then: Top charts, New this week, Editor's picks, categories, a command-line tools section, the setup section (real Homebrew install command), a developers section, footer with newsletter.

### Discover `/discover`
Title + search, category chips, Editor's pick hero card + two collection cards, "Trending this week" (Mac apps / Command-line tools lists), "New this week" carousel, "Popular from independent developers" (community taps with 30-day installs), "Browse by what you need" category rows.

### Search `/search?q=`
Title "Results for ‘q’", count, search pill. Filters: Type (everything / Mac apps / CLI), Source (all / official / community), Updated (any / month / year), Category checkboxes. Active filter chips, sort (relevance, most installed, trending, newest, recently updated), results grid of app rows, empty state with "Clear filters", "Show more".

### App `/app/[token]`
Breadcrumb, big icon, name, tagline, badges (Official/Community, Mac app/CLI, licence, "Updated n days ago"), install card (command + Copy + "New to Homebrew?"). Stat cards (installs 30/90/365 days, trend), screenshots carousel (placeholders until claimed), About, installs-over-time chart, "Manage it" (upgrade/uninstall commands), Information list (developer, category, licence, version, updated, source), links (website, source, report an issue), "From Homebrew's official catalog" trust note or community warning, "Is this your app?" claim CTA, Similar apps.

### New `/new`
Title, RSS button, tabs (Everything / Mac apps / CLI / Community), toggle "Only ones people are already installing", grouped by day (Today / Yesterday / Earlier this week), "Show last week".

### Charts `/charts`
Period switch (30 days / 90 days / 1 year), tabs (Mac apps / CLI / Community taps), ranked list with category, installs and trend, "Show top 100". Side panel: "Climbing fast" movers and "How rankings work".

### Category `/category/[slug]`
Breadcrumb, icon stack, title, description, sub-filter chips (e.g. Snapping / Tiling / Switching / Displays), sort, editor's pick card, app list, other categories.

### Tap `/tap/[owner]/[repo]`
Avatar initials, tap name, description, badges (Community tap, repo link, updated), "Add this tap" card (`brew tap …` + copy), safety notice, stats, package list, "Maintain this tap? Claim it" CTA.

## Editorial

Editor's picks, collections, category assignment and sub-categories are curated, not in Homebrew's data. Start with a small YAML/JSON file in the repo (`content/`) the owner edits by hand.
