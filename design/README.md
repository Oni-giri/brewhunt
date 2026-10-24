# Design handoff

Everything here was exported from the Brewhunt design canvas.

```
design/
  screens/        static HTML of each page (open directly in a browser)
  screenshots/    the same pages at 1280px (desktop) and 390px (mobile)
  source/         original interactive prototypes (.dc.html), for behaviour
  assets/         logo and brand files
```

## Pages

| Route (proposed) | Static HTML | Prototype source |
|---|---|---|
| `/` landing | `screens/landing.html` | `source/LandingStore.dc.html` |
| `/discover` store home | `screens/home.html` | `source/StoreHome.dc.html` |
| `/search?q=` | `screens/search.html` | `source/StoreBrowse.dc.html` |
| `/app/[token]` | `screens/app.html` | `source/StorePackage.dc.html` |
| `/new` | `screens/new.html` | `source/StoreNew.dc.html` |
| `/charts` | `screens/charts.html` | `source/StoreCharts.dc.html` |
| `/category/[slug]` | `screens/category.html` | `source/StoreCategory.dc.html` |
| `/tap/[owner]/[repo]` | `screens/tap.html` | `source/StoreTap.dc.html` |

The static HTML is each prototype rendered with its sample data. Interactive states (open menus, the install sheet, filters applied) aren't in the static files; read the prototype's `<script>` (`renderVals()`) to see how each one behaves.

The prototypes need the design canvas's runtime (`support.js`, not included) to run. Use them as reference only.

## Brand assets

| File | Use |
|---|---|
| `brewhunt-flask-{64,128,512,1024}.png` | Logo mark (transparent). Header and footer use 128 shown at 46px next to the "Brewhunt" wordmark. |
| `favicon.svg`, `favicon.ico`, `favicon-16.png`, `favicon-32.png` | Browser tab icons (simplified redraw for small sizes) |
| `apple-touch-icon.png` | iPhone "Add to Home Screen" (180px) |
| `avatar-400.png` | Social profile picture (X, GitHub, Product Hunt) |
| `og-image.png` | Link preview, 1200×630 |
| `brewhunt-appicon-1024.png`, `brewhunt-appicon-source.png` | App-icon (white tile) version and its original source image |

Wordmark: "Brewhunt", Geist 600, 20px in the nav, letter-spacing −0.035em, aligned to the flask's body (the flask image sits 46px with margins `-8px -2px -6px -6px`, text nudged down 3px).

`<head>` snippet:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:image" content="https://brewhunt.app/og-image.png">
<meta name="twitter:card" content="summary_large_image">
```

(Swap the domain if it ends up different from brewhunt.app.)
