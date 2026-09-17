/**
 * Fetch Tucson bars/pubs/breweries from OpenStreetMap via Overpass API.
 * Writes data/raw-osm.json
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'data', 'raw-osm.json');

// Tucson metro bbox: south, west, north, east
const BBOX = '32.05,-111.10,32.36,-110.72';

const QUERY = `
[out:json][timeout:90];
(
  node["amenity"~"^(bar|pub|biergarten|nightclub)$"](${BBOX});
  way["amenity"~"^(bar|pub|biergarten|nightclub)$"](${BBOX});
  node["microbrewery"="yes"](${BBOX});
  way["microbrewery"="yes"](${BBOX});
  node["craft"="brewery"](${BBOX});
  way["craft"="brewery"](${BBOX});
);
out center tags;
`.trim();

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

function amenityToVibe(tags) {
  if (tags.microbrewery === 'yes' || tags.craft === 'brewery' || tags.amenity === 'biergarten') {
    return 'Brewery';
  }
  const a = tags.amenity || '';
  if (a === 'nightclub') return 'Nightclub';
  if (a === 'pub') return 'Pub';
  if (a === 'bar') {
    if (/wine/i.test(tags.name || '') || tags.drink === 'wine') return 'Wine Bar';
    if (/cocktail|speakeasy/i.test(tags.name || '') || tags.drink === 'cocktail') return 'Cocktail Bar';
    return 'Bar';
  }
  if (a === 'restaurant') return 'Bar & Restaurant';
  return 'Bar';
}

function buildAddress(tags) {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'] || 'Tucson',
    tags['addr:state'] || 'AZ',
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.join(', ') || '';
}

function slugify(name, neighborhood = '') {
  const base = `${name} ${neighborhood}`
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'venue';
}

function normalizeElement(el) {
  const tags = el.tags || {};
  const name = (tags.name || '').trim();
  if (!name) return null;

  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;

  return {
    osm_id: `${el.type}/${el.id}`,
    name,
    vibe: amenityToVibe(tags),
    outdoor: tags.outdoor_seating === 'yes' || tags.garden === 'yes',
    address: buildAddress(tags),
    website: tags.website || tags['contact:website'] || tags['contact:facebook'] || '',
    phone: tags.phone || tags['contact:phone'] || '',
    bar_hours: tags.opening_hours || '',
    lat,
    lng,
    zip: tags['addr:postcode'] || '',
    cuisine: tags.cuisine || '',
    raw_amenity: tags.amenity || '',
  };
}

function dedupe(bars) {
  const byKey = new Map();
  for (const b of bars) {
    const key = b.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, b);
      continue;
    }
    // Prefer richer address / website
    const score = (x) => (x.address ? 2 : 0) + (x.website ? 2 : 0) + (x.bar_hours ? 1 : 0);
    if (score(b) > score(existing)) byKey.set(key, b);
  }
  return [...byKey.values()];
}

async function fetchOverpass() {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      console.log(`Querying ${url}…`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'TucsonHappyHour/0.1 (local data pipeline)',
        },
        body: `data=${encodeURIComponent(QUERY)}`,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json();
      if (!json.elements) throw new Error('No elements in response');
      return json;
    } catch (err) {
      lastErr = err;
      console.warn(`Failed: ${err.message}`);
    }
  }
  throw lastErr;
}

async function main() {
  const data = await fetchOverpass();
  const bars = dedupe(
    data.elements.map(normalizeElement).filter(Boolean)
  ).sort((a, b) => a.name.localeCompare(b.name));

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify(
      {
        fetched_at: new Date().toISOString(),
        bbox: BBOX,
        count: bars.length,
        bars,
      },
      null,
      2
    )
  );

  console.log(`Wrote ${bars.length} venues → data/raw-osm.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
