# Editorial content

Brewhunt's curated layer: categories, collections, editor's picks and a few overrides. Homebrew's data doesn't have any of this, so it lives here as YAML you edit by hand. The site and the data pipeline read these files at build time.

| File | What it holds |
|---|---|
| `categories.yaml` | Categories in display order, their sub-categories and packages |
| `collections.yaml` | Hand-picked sets shown as cards on Discover ("Set up a new Mac") |
| `picks.yaml` | Editor's picks, newest first |
| `packages.yaml` | Optional display name, type, tagline, developer and search keywords per package |
| `overrides.yaml` | Corrections to the pipeline's "library" flag, and packages to hide |

## Package ids

Every package is referenced by its Homebrew id:

- a core formula name: `ripgrep`, `llama.cpp`
- a cask token: `rectangle`. Tokens are often not the app's name: Ice is `jordanbaird-ice`, HandBrake is `handbrake-app`, and `ice` is an unrelated formula. Check on [formulae.brew.sh](https://formulae.brew.sh) or with `brew info --cask <token>`.
- `owner/tap/name` for a community tap: `nikitabobko/tap/aerospace`. Only list community packages people actually install.

When a package is both in Homebrew's catalog and in its developer's tap (`bun` and `oven-sh/bun/bun`), use the official one. Don't list packages Homebrew has disabled; avoid deprecated ones.

## Fields

**categories.yaml**: a list; file order is display order.

- `slug`: the URL, `/category/<slug>`. Lowercase words joined by hyphens. Changing it breaks links.
- `name`: as shown, "Windows & desktop".
- `description`: one sentence ending with a full stop.
- `tile`: icon colour, one of `blue`, `orange`, `green`, `purple`, `pink`, `yellow`, `teal`, `slate`, `terminal`.
- `subcategories` (optional): the filter chips, `{ slug, name }`.
- `packages`: `{ id, sub }`, where `sub` is one of the category's sub-category slugs. Put the best-known first: the first few stand for the category in icon stacks and example lists.
- `caskflow` (optional): ids of [CaskFlow](https://github.com/alielsokary/CaskFlow)'s categories (`developerTools`, `games`; the names are in `data/site/caskflow-categories.json`) whose Mac apps fill the category after `packages`, most installed first. Each CaskFlow id goes in one category. A package listed in any category's `packages` keeps only those categories. A category with `caskflow` may leave `packages` empty.

A package can be in several categories. Its first category in file order is its primary one: it's used for breadcrumbs and "Rank #n in …". Apps that only CaskFlow files have one category.

**collections.yaml**: `slug`, `title`, `subtitle` (a short phrase, no full stop), `tile`, and `packages`, a list of ids. The first four make the card's icon stack.

**picks.yaml**: newest first. `id`, `date` (`2026-10-28`), `category` (optional slug) and `blurb` (a sentence or two). Discover's hero shows the first pick; a category page shows the newest pick for that category, and the package must be listed in it. Say what the app does, plainly: no "best", rankings, prices or claims we can't back up.

**packages.yaml**: keyed by id, each with any of `name`, `type`, `tagline`, `developer` and `keywords`.

- `name`: a shorter display name than Homebrew's ("VLC" for "VLC media player"), used everywhere. 40 characters at most.
- `type`: casks only, `app` or `cli`, when the cask doesn't make it clear whether it's a Mac app or a command-line tool (a `.pkg` installer can hold either). Without it, a cask that installs only command-line programs (`binary`) is a command-line tool and anything else is a Mac app.
- `tagline`: replaces Homebrew's description in lists. 60 characters at most, no full stop. Only add one where Homebrew's description is unclear or clumsy.
- `developer`: shown in the app page's Information list.
- `keywords`: lowercase search terms Homebrew's data doesn't link to the package, such as command names, former names, common abbreviations and what people call that kind of app when the package never says it (`ebook` for calibre): `visual-studio-code: { keywords: [vscode] }`. Up to 10, each 30 characters at most. Homebrew's data already links formula aliases (`rg` for ripgrep, `nvim` for neovim) and old cask tokens, so don't repeat them.

**overrides.yaml**:

- `library.show`: formulae the pipeline flags as libraries (mostly installed as a dependency, like `openssl`) that should still appear in charts and discovery. Say why in a comment.
- `library.hide`: formulae to treat as libraries even though the pipeline doesn't flag them.
- `hidden`: packages removed from every list. Their app pages stay.

## Checking your changes

With Node 24, from the repository root:

```sh
npm run validate:content
# or: node scripts/content/validate.ts [--packages data/site/packages.json]
```

It checks every file's shape (unknown keys, missing full stops, duplicate slugs or ids, sub-categories that don't exist, picks out of date order, a pick whose package isn't in its category), then checks every id against the package list at `data/site/packages.json`: unknown ids and disabled packages are errors, deprecated ones are warnings. Without that file (before `npm run data:pull`) it says so and checks the content files only. Use `--packages <file>` to point at another list.

Errors exit with status 1 and name the file, line and field. Warnings (a category with fewer than 6 packages, a sub-category nobody uses, a package without a sub-category in a category that has them, a hidden package listed somewhere, a library left out of `library.show`, a keyword Homebrew already links) don't fail the check.

Then format: `npx prettier --write content`.
