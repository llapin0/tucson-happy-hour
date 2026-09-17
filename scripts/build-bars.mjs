/**
 * Build bars.json from curated research (primary) + OSM coords (fallback only).
 * Curated sources: Tucson Foodie, Wine Enthusiast 2025, venue websites, public Yelp listings.
 * Does NOT scrape Google/Yelp APIs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function slugify(name, neighborhood = '') {
  return `${name} ${neighborhood}`
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[''`]s\b/g, 's')
    .replace(/\b(bar|co|company|brewing|brewery|cafe|café|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function nearestNeighborhood(lat, lng, neighborhoods) {
  let best = neighborhoods[0];
  let bestDist = Infinity;
  for (const n of neighborhoods) {
    const d = haversineMiles(lat, lng, n.lat, n.lng);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return { neighborhood: best.name, area: best.area };
}

function nearestSunlink(lat, lng, stops, maxMiles) {
  let best = null;
  let bestDist = Infinity;
  for (const s of stops) {
    const d = haversineMiles(lat, lng, s.lat, s.lng);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (best && bestDist <= maxMiles) {
    return { stop: best.name, miles: Math.round(bestDist * 100) / 100 };
  }
  return null;
}

async function geocodeAddress(address) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' +
    encodeURIComponent(address);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TucsonHappyHour/0.2 (curation; local research pipeline)' },
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json?.length) return null;
  return { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const curated = JSON.parse(await readFile(join(ROOT, 'data', 'curated-bars.json'), 'utf8'));
  const geo = JSON.parse(await readFile(join(ROOT, 'data', 'neighborhoods.json'), 'utf8'));

  let osmByName = new Map();
  try {
    const raw = JSON.parse(await readFile(join(ROOT, 'data', 'raw-osm.json'), 'utf8'));
    for (const b of raw.bars || []) {
      osmByName.set(normalizeName(b.name), b);
    }
  } catch {
    console.warn('No OSM raw file — using curated coords only');
  }

  const results = [];
  for (const m of curated) {
    if (m.closed) continue;

    let lat = m.lat;
    let lng = m.lng;
    const osm = osmByName.get(normalizeName(m.name));

    if ((lat == null || lng == null) && osm) {
      lat = osm.lat;
      lng = osm.lng;
    }

    if ((lat == null || lng == null) && m.address) {
      console.log(`Geocoding ${m.name}…`);
      await sleep(1100);
      const g = await geocodeAddress(m.address.includes('Tucson') ? m.address : `${m.address}, Tucson, AZ`);
      if (g) {
        lat = g.lat;
        lng = g.lng;
      }
    }

    if (lat == null || lng == null) {
      console.warn(`Skipping ${m.name} — no coordinates`);
      continue;
    }

    const hood =
      m.neighborhood && m.area
        ? { neighborhood: m.neighborhood, area: m.area }
        : nearestNeighborhood(lat, lng, geo.neighborhoods);

    const sl = nearestSunlink(lat, lng, geo.sunlink_stops, geo.sunlink_walk_miles);

    results.push({
      name: m.name,
      neighborhood: hood.neighborhood,
      area: hood.area,
      price: m.price ?? 2,
      happy_hour_days: m.happy_hour_days || '',
      happy_hour_times: m.happy_hour_times || '',
      bar_hours: m.bar_hours || osm?.bar_hours || '',
      food: m.food || '',
      vibe: m.vibe || osm?.vibe || 'Bar',
      outdoor: m.outdoor ?? osm?.outdoor ?? false,
      deal: m.deal || '',
      address: m.address || osm?.address || '',
      website: m.website || osm?.website || '',
      lat,
      lng,
      rating: m.rating ?? null,
      rating_count: m.rating_count ?? null,
      seating: m.seating || '',
      source: m.source || 'estimated',
      zip: m.zip || '',
      slug: slugify(m.name, hood.neighborhood),
      date_checked: m.date_checked || new Date().toISOString().slice(0, 10),
      sunlink: sl ? [sl.stop] : [],
      featured: m.featured === true,
      research_notes: m.research_notes || '',
      phone: m.phone || osm?.phone || '',
    });
  }

  // Dedupe
  const deduped = new Map();
  for (const b of results) {
    const key = normalizeName(b.name);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, b);
      continue;
    }
    const score = (x) =>
      (x.deal ? 4 : 0) +
      (x.source === 'verified' ? 3 : x.source === 'estimated' ? 1 : 0) +
      (x.address ? 1 : 0) +
      (x.website ? 1 : 0) +
      (x.featured ? 2 : 0);
    if (score(b) >= score(existing)) deduped.set(key, b);
  }

  const bars = [...deduped.values()].sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
    return a.name.localeCompare(b.name);
  });

  // Strip internal notes from public JSON
  const publicBars = bars.map(({ research_notes, ...rest }) => rest);

  await writeFile(join(ROOT, 'bars.json'), JSON.stringify(publicBars, null, 2));
  console.log(`Wrote ${publicBars.length} curated bars → bars.json`);
  console.log(
    `  deals: ${publicBars.filter((b) => b.deal).length}, verified: ${publicBars.filter((b) => b.source === 'verified').length}, sunlink: ${publicBars.filter((b) => b.sunlink.length).length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
