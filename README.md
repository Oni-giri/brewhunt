<p align="center"><img src="design/assets/brewhunt-flask-128.png" width="96" alt=""></p>

# Brewhunt

The app store for everything you can install with Homebrew: discover Mac apps and command-line tools, see what's new and trending, and grab the one-line install command.

**Status:** M0 to M3 are done (shell, data pipeline, app pages, Discover, search, charts, new, categories, taps) and the M4 landing page is built. Left before launch: Cloudflare deploy secrets, analytics, a manual accessibility pass. See the roadmap.

- Product spec: [`docs/PRODUCT.md`](docs/PRODUCT.md)
- Design system: [`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md)
- Data plan: [`docs/DATA.md`](docs/DATA.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Designs: [`design/`](design/README.md) (static HTML, screenshots, prototypes, brand assets)
- Editorial content: [`content/`](content/README.md) (categories, picks, collections)
- Calls to review: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Develop

Needs Node 24 (`.nvmrc`).

```sh
npm install
npm run data:pull   # latest data from the `data` branch into data/ (or `npm run data` to build it yourself)
npm run dev         # http://localhost:4321
npm test            # unit tests (Vitest)
npm run build && npm run test:browser   # browser tests (Playwright) on the build; first `npx playwright install --only-shell chromium`
npm run check       # types; `npm run lint`, `npm run format:check`, `npm run validate:content` too
```

Not affiliated with the Homebrew project or Apple.
