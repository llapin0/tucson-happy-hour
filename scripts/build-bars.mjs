/**
 * Merge OSM raw data + manual curation, assign neighborhoods & Sun Link,
 * emit bars.json for the frontend.
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
  return { neighborhood: best.name, area: best.area, dist: bestDist };
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

function mergeBar(osm, manual) {
  const m = manual || {};
  const lat = m.lat ?? osm?.lat;
  const lng = m.lng ?? osm?.lng;
  if (lat == null || lng == null) return null;

  const name = m.name || osm?.name;
  if (!name) return null;

  return {
    name,
    neighborhood: m.neighborhood || '',
    area: m.area || '',
    price: m.price ?? 2,
    happy_hour_days: m.happy_hour_days ?? '',
    happy_hour_times: m.happy_hour_times ?? '',
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
    source: m.source || (m.deal ? 'estimated' : 'unverified'),
    zip: m.zip || osm?.zip || '',
    slug: '',
    date_checked: m.date_checked || new Date().toISOString().slice(0, 10),
    sunlink: [],
    featured: m.featured === true,
    osm_id: osm?.osm_id || m.osm_id || '',
    phone: m.phone || osm?.phone || '',
  };
}

async function main() {
  const raw = JSON.parse(await readFile(join(ROOT, 'data', 'raw-osm.json'), 'utf8'));
  const manualList = JSON.parse(await readFile(join(ROOT, 'data', 'manual-bars.json'), 'utf8'));
  const geo = JSON.parse(await readFile(join(ROOT, 'data', 'neighborhoods.json'), 'utf8'));

  const osmByName = new Map();
  for (const b of raw.bars) {
    osmByName.set(normalizeName(b.name), b);
  }

  const manualByName = new Map();
  for (const b of manualList) {
    manualByName.set(normalizeName(b.name), b);
  }

  const usedOsm = new Set();
  const results = [];

  // Manual entries first (overrides / additions)
  for (const m of manualList) {
    const key = normalizeName(m.name);
    const osm = osmByName.get(key) || null;
    if (osm) usedOsm.add(key);
    // Also try fuzzy match against osm names containing key
    if (!osm) {
      for (const [k, v] of osmByName) {
        if (k.includes(key) || key.includes(k)) {
          usedOsm.add(k);
          const merged = mergeBar(v, m);
          if (merged) results.push(merged);
          break;
        }
      }
      if (!results.find((r) => normalizeName(r.name) === key)) {
        const merged = mergeBar(null, m);
        if (merged) results.push(merged);
      }
    } else {
      const merged = mergeBar(osm, m);
      if (merged) results.push(merged);
    }
  }

  // Remaining OSM venues
  for (const [key, osm] of osmByName) {
    if (usedOsm.has(key)) continue;
    if (manualByName.has(key)) continue;
    const merged = mergeBar(osm, null);
    if (merged) results.push(merged);
  }

  // Assign neighborhood / area / sunlink / slug
  for (const b of results) {
    if (!b.neighborhood || !b.area) {
      const n = nearestNeighborhood(b.lat, b.lng, geo.neighborhoods);
      if (!b.neighborhood) b.neighborhood = n.neighborhood;
      if (!b.area) b.area = n.area;
    }
    const sl = nearestSunlink(b.lat, b.lng, geo.sunlink_stops, geo.sunlink_walk_miles);
    b.sunlink = sl ? [sl.stop] : [];
    b.slug = slugify(b.name, b.neighborhood);
  }

  // Dedupe by normalized name (prefer manual/richer)
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
      (x.source === 'verified' ? 3 : 0) +
      (x.address ? 1 : 0) +
      (x.website ? 1 : 0) +
      (x.rating ? 1 : 0);
    if (score(b) >= score(existing)) deduped.set(key, b);
  }

  const bars = [...deduped.values()].sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
    return a.name.localeCompare(b.name);
  });

  await writeFile(join(ROOT, 'bars.json'), JSON.stringify(bars, null, 2));
  console.log(`Wrote ${bars.length} bars → bars.json`);
  console.log(
    `  with HH deals: ${bars.filter((b) => b.deal).length}, verified: ${bars.filter((b) => b.source === 'verified').length}, sunlink: ${bars.filter((b) => b.sunlink.length).length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
