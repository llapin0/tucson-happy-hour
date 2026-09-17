# Data sources

Primary listings are **hand-curated** in `data/curated-bars.json` — not raw OpenStreetMap dumps.

## Sources used (2026-09)

- [Tucson Foodie — Wine Enthusiast best bars](https://tucsonfoodie.com/guides/best-bars-wine-enthusiast) (Mar 2025 / updated 2026)
- [Tucson Foodie — Craft Beer Crawl 2025](https://tucsonfoodie.com/guides/tucson-craft-beer-crawl-map-2025)
- [Tucson Foodie editor picks](https://tucsonfoodie.com/guides/what-i-order-and-eat-in-tucson-as-editor)
- [Tucson Weekly happy hour roundup](https://www.tucsonweekly.com/chow-2/20-cant-miss-happy-hours-around-tucson-34241352/)
- Venue websites (Batch, Sky Bar, Gentle Ben’s, HighWire, NEX, Sidecar, REVEL, Bar Crisol, etc.)
- Public Yelp search pages (Downtown top bars, hours/ratings as published)
- Downtown Tucson Partnership venue pages
- OpenStreetMap Nominatim for geocoding addresses only
- Legacy OSM Overpass pull kept in `data/raw-osm.json` as a coord fallback when names match

## Not used

- Google Places API / Yelp Fusion API (need paid keys)
- Scraping Google Maps or Yelp HTML

## Rebuild

```bash
npm run build-bars
```
