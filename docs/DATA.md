# Data plan

All data is public. Docs: https://formulae.brew.sh/docs/api/ and https://docs.brew.sh/Analytics. The pipeline lives in `scripts/data/`; its output contract is `scripts/data/types.ts`.

## Sources

| Need | Endpoint |
|---|---|
| All core formulae (metadata) | `https://formulae.brew.sh/api/formula.json` |
| All official casks (metadata) | `https://formulae.brew.sh/api/cask.json` |
| Formula installs, ranked (all taps) | `https://formulae.brew.sh/api/analytics/install/{30d,90d,365d}.json` |
| Installs on request (not as a dependency) | `https://formulae.brew.sh/api/analytics/install-on-request/{30d,90d,365d}.json` |
| Cask installs (all taps) | `https://formulae.brew.sh/api/analytics/cask-install/{30d,90d,365d}.json` |
| Dates (added, updated) | git history of `Homebrew/homebrew-core`, `Homebrew/homebrew-cask` and each community tap |
| Community package metadata | the tap's GitHub repo (`owner/homebrew-tap`), read as text |
| Tap description, stars | GitHub REST API `repos/{owner}/{repo}` |
| Mac app icons | [CaskFlow](https://github.com/alielsokary/CaskFlow)'s `icons` branch: `icons.json` lists the cask tokens with a 256px PNG |

Notes:
- Analytics count **install events** from users who haven't opted out, on macOS and Linux. Show them as relative popularity, always labelled with the period ("Installs · 30 days"), and never as "Mac installs". `meta.json` has each window's exact dates.
- Counts arrive as strings with thousands separators (`"509,747"`).
- Public GitHub **taps are included** in the analytics as `owner/tap/name`. The cask feed that covers them is the undocumented `cask-install/{period}.json`; the documented `cask-install/homebrew-cask/{period}.json` only covers the official tap and has a different shape.
- Around 13,000 community taps show up; about 100 have more than 1,000 installs in 30 days. Brewhunt lists packages from the top 100 taps by installs.
- About 120 analytics names match no current formula: removed packages, plus a few renames, which `oldnames`/`old_tokens` resolve. The rest are dropped (the run logs the biggest).
- Prefer **install-on-request** for the popularity of formulae (avoids libraries pulled in as dependencies). Casks are always installed on request.
- Metadata for community packages is **not** in `formula.json`/`cask.json`. We don't run `brew info` on taps: that would execute third-party Ruby in CI. The pipeline clones each tap and reads `desc`, `homepage`, `version`, `license`, `name` from the `.rb` files as text (`scripts/data/ruby.ts`). Nothing from a tap is executed, symlinks are ignored, and the output is treated as untrusted text.

## Pipeline

`.github/workflows/data.yml` runs daily at 06:17 UTC (and on demand):

1. **refresh** (read-only token, no secrets): `node scripts/data/run.ts` downloads the API files, clones homebrew-core, homebrew-cask and the top 100 taps, and writes `data/`. It refuses to publish if Homebrew returns something implausible (too few packages, stale analytics).
2. **publish** (can push, runs no pipeline code): commits `data/` to the `data` branch if anything changed.
3. **site**: runs `ci.yml` (lint, tests, `validate:content`, build, deploy) against that data commit.

Every other build (pushes, PRs) checks out the latest `data` branch into `data/`. Locally: `npm run data:pull` (fetch it) or `npm run data` (run the pipeline; add `-- --cache-api` to reuse downloads, set `GITHUB_TOKEN` for tap descriptions).

### Dates
- **Added (`firstSeen`)**: the date the package's file was added on the tap's default branch (merge date, not when the PR was opened). Renames (`oldnames`/`old_tokens`) and file moves don't count as new.
- **Updated (`updatedAt`)**: when the current version landed: the earliest commit whose subject names the version (`wget 1.25.0`, `bump-wget-1.25.0`, `wget: update 1.25.0_2 bottle.`), dated by when it reached the default branch. `updatedKind: 'file'` means the version changed but no commit names it, so it's the file's last change; only show "Updated n days ago" for `'version'`.
- The first run reads 400 days of history (about 45s and 330MB for core and cask); later runs read the week before the last run and carry everything else over in `state/packages.json`. Anything older than the tracking window is `null`: added or updated "over a year ago".

### Trends
Change of the last 30 days against a baseline, on install-on-request for formulae and installs for casks:
- With a snapshot from exactly 30 days earlier: against those 30 days (`basis: previous-30-days`, label "vs. previous 30 days").
- Until then: against the average 30 days of the previous 60, which the 90-day window gives as `(d90 − d30) / 2` (`basis: previous-60-days-average`, label it that way).
- No trend below 100 installs in 30 days or a baseline under 50, or for packages added inside the baseline period.

### Libraries
A formula is flagged `library` when under 30% of its yearly installs are on request (under 50% for `lib*` names), which hides openssl@3, libpng, pcre2 and sqlite but keeps git, jq, ffmpeg, node, curl (38%) and cmake (48%). Under 100 yearly installs, only the `lib*` name counts. `content/overrides.yaml` corrects individual cases.

### History
Homebrew only publishes rolling windows, so the installs-over-time chart comes from our own daily snapshots of the 30-day counts, stored by month in `state/history/YYYY-MM.json` and keyed by the analytics end date (re-running a day replaces it). There's no public archive to backfill from: history starts on 28 Oct 2026. Until there's history, show only the stat cards. The chart plots the rolling 30-day count; label it that way.

## Output (`data/site/`)

| File | Contents |
|---|---|
| `packages.json` | Every official formula and cask (including disabled ones, flagged), plus community packages from the top taps with an install in the last year or added in the last 30 days. See `Package` in `scripts/data/types.ts`. |
| `taps.json` | The top community taps: GitHub details, 30-day installs, listed packages. |
| `history.json` | Snapshot dates and, per package, the 30-day counts on each date. |
| `meta.json` | Analytics windows, tracking windows, counts, warnings from the run. |
| `icons.json` | The CaskFlow commit and the cask tokens it has an icon for (`scripts/data/icons.ts`). Pages load the images from jsDelivr pinned to that commit; only official casks use them. If CaskFlow can't be reached or its list shrinks by half, the run keeps yesterday's file. |

Curation (`content/`: categories, picks, collections, overrides) is joined at build time, so editing it only needs a push.

Snapshots live on the `data` branch for now (about 150KB a day). Moving them to Cloudflare R2 is on the roadmap.

## Not available from Homebrew

App icons, screenshots and rich descriptions. Official Mac apps get icons from CaskFlow (above); formulae, community packages and the casks CaskFlow lacks use the generated initial-letter tiles from the design. Later: developer-claimed listings can upload these.
