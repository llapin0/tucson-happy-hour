# Tucson Happy Hour

A Tucson happy-hour finder inspired by [5pm.nyc](https://5pm.nyc/) — map + list of bars with deals, hours, and filters.

## Stack

Static site: vanilla HTML/JS, `bars.json`, Leaflet. No build step for the frontend.

## Data pipeline

```bash
npm run fetch-osm    # Pull bars from OpenStreetMap → data/raw-osm.json
npm run build-bars   # Merge OSM + manual curation → bars.json
npm run build-data   # Both
```

## Local preview

```bash
npm run serve
```

Open http://localhost:3000

## Deploy (Cloudflare)

**Deploy command** (Workers / CI):

```bash
node scripts/prepare-public.mjs && npx wrangler deploy
```

Or locally after `npx wrangler login`:

```bash
npm run deploy
```

`public/` is generated (not committed). The prepare step copies `index.html`, `app.js`, `styles.css`, and `bars.json` into it before Wrangler uploads.

## MVP features

- List / Map toggle
- Neighborhood search + near-me geolocation
- HH Now / Open Now / HH Time filters
- Vibe + price filters
- Bar cards with deals, hours, verified badge, Maps + website links
