# Data plan

All data is public. Docs: https://formulae.brew.sh/docs/api/ and https://docs.brew.sh/Analytics. Verify the endpoints and response shapes before building on them; none of this has been prototyped yet.

## Sources

| Need | Endpoint |
|---|---|
| All core formulae (metadata) | `https://formulae.brew.sh/api/formula.json` |
| All casks (metadata) | `https://formulae.brew.sh/api/cask.json` |
| One formula / cask (+ its analytics) | `https://formulae.brew.sh/api/formula/{name}.json`, `…/api/cask/{token}.json` |
| Formula installs, ranked (all taps) | `https://formulae.brew.sh/api/analytics/install/{30d,90d,365d}.json` |
| Installs on request (not as a dependency) | `https://formulae.brew.sh/api/analytics/install-on-request/{30d,90d,365d}.json` |
| Cask installs | `https://formulae.brew.sh/api/analytics/cask-install/homebrew-cask/{30d,90d,365d}.json` |

Notes:
- Analytics count **install events** from users who haven't opted out. Show them as relative popularity, always labelled with the period.
- Public, non-private **GitHub taps are included** in the analytics: entries appear with tap-qualified names like `owner/tap/name`. In design research, the top community entries over 30 days (to 8 Oct 2026) were `anomalyco/tap/opencode` ~36.8k, `wix/brew/applesimutils` ~19.2k, `facebook/fb/idb-companion` ~17.8k, `hashicorp/tap/terraform` ~12.5k. Check whether community **casks** appear in a cask analytics feed; the documented cask endpoint is homebrew-cask only.
- Prefer **install-on-request** for "popularity" of CLI tools (avoids libraries pulled in as dependencies). Libraries and dependencies (openssl, libpng…) should be hidden from charts and discovery by default.
- Metadata for community-tap packages is **not** in `formula.json`/`cask.json`. Get it from the tap's GitHub repo, or by running `brew info --json=v2` in CI for the top N taps by installs.

## Pipeline

A scheduled job (GitHub Actions, daily):

1. Download formula/cask metadata and the analytics files (30/90/365 days, install + install-on-request + cask-install).
2. Store a dated snapshot (JSON in object storage or a small DB; SQLite/D1/Postgres are all fine).
3. **New this week:** diff today's package list against previous snapshots and record a `first_seen` date per package. Optionally cross-check with "new formula/cask" commits in homebrew-core/homebrew-cask.
4. **Trends:** compare the 30-day count with the previous snapshot's 30-day window → "↑ n%", "Climbing fast".
5. **Installs over time chart:** comes from your own accumulated daily snapshots (Homebrew only publishes rolling windows). Start collecting from day one; until there's history, show only the stat cards.
6. Enrich community packages for the top N taps (metadata, descriptions, homepage).
7. Join with the curated `content/` file (categories, picks, collections).
8. Rebuild the static site (or revalidate the affected pages).

## Data model (sketch)

```
Package   id (token or owner/tap/name), kind (cask|formula), source (official|community),
          tap, name, desc, homepage, version, license, updated_at, first_seen,
          install_command, category, subcategory
Analytics package_id, period (30d|90d|365d), kind (install|on_request), count, rank, date
Tap       owner, repo, url, description, packages[], installs_30d
Curated   picks[], collections[], categories{slug → packages[], subcats}
```

## Not available from Homebrew

App icons, screenshots and rich descriptions. v1 uses the generated initial-letter tiles from the design. Later: developer-claimed listings can upload these.
