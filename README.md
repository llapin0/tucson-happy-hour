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

## Live preview

Temporary Cloudflare deploy: https://tucson-happy-hour.discreet-rise.workers.dev

Claim the preview account (within ~60 minutes of deploy) via the claim URL printed by `npm run deploy`, or run `npx wrangler login` for a permanent project.

## Local preview

```bash
npm run serve
```

Open http://localhost:3000

## Deploy

```bash
npm run deploy   # Cloudflare Workers temporary preview
```

## MVP features

- List / Map toggle
- Neighborhood search + near-me geolocation
- HH Now / Open Now / HH Time filters
- Vibe + price filters
- Bar cards with deals, hours, verified badge, Maps + website links
