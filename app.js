/* 5PM Tucson — client app */
(function () {
  'use strict';

  const TUCSON = { lat: 32.2226, lng: -110.9747 };
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_ALIASES = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  const state = {
    allBars: [],
    filtered: [],
    neighborhoods: [],
    view: 'list',
    timeMode: 'all', // all | open | hhnow | hhtime
    hhDay: new Date().getDay(),
    hhMinutes: 17 * 60,
    vibe: 'all',
    price: 'all',
    outdoorOnly: false,
    sunlinkOnly: false,
    verifiedOnly: false,
    area: 'all',
    query: '',
    userLat: null,
    userLng: null,
    map: null,
    cluster: null,
    markers: [],
  };

  const $ = (id) => document.getElementById(id);

  // ——— Time / HH parsing ———

  function parseClockToken(token) {
    const t = token.trim().toLowerCase().replace(/\s+/g, '');
    if (t === 'open' || t === 'open-') return null;
    if (t === 'close' || t === 'midnight') return 24 * 60;
    if (t === 'noon') return 12 * 60;

    let m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i);
    if (!m) m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
    if (!m) return null;

    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = (m[3] || '').replace(/\./g, '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    // Bare hour 1-7 often means PM for happy hour
    if (!ap && h >= 1 && h <= 7) h += 12;
    return h * 60 + min;
  }

  function expandDays(text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    if (/daily|every\s*day|all\s*day/.test(lower) && !/mon|tue|wed|thu|fri|sat|sun/.test(lower)) {
      return [0, 1, 2, 3, 4, 5, 6];
    }
    if (/all\s*day/.test(lower) && /mon|tue|wed|thu|fri|sat|sun/.test(lower) === false && /daily/.test(lower)) {
      return [0, 1, 2, 3, 4, 5, 6];
    }

    const days = new Set();
    // Ranges: Mon–Fri, Mon-Sat, Wed–Fri
    const rangeRe = /(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\s*[–\-—to]+\s*(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)/gi;
    let match;
    while ((match = rangeRe.exec(lower))) {
      const a = DAY_ALIASES[match[1]];
      const b = DAY_ALIASES[match[2]];
      if (a == null || b == null) continue;
      let i = a;
      for (;;) {
        days.add(i);
        if (i === b) break;
        i = (i + 1) % 7;
      }
    }

    // Individual days
    for (const [alias, d] of Object.entries(DAY_ALIASES)) {
      const re = new RegExp('\\b' + alias + '\\b', 'i');
      if (re.test(lower)) days.add(d);
    }

    if (days.size === 0 && /daily/i.test(text)) return [0, 1, 2, 3, 4, 5, 6];
    return [...days];
  }

  function parseTimeWindows(timesText) {
    if (!timesText || /^na$/i.test(timesText.trim())) return [];
    const lower = timesText.toLowerCase();
    if (/all\s*day/.test(lower)) return [{ start: 0, end: 24 * 60 }];

    const windows = [];
    // Split on | or & or "and" for multiple windows
    const parts = timesText.split(/\||(?:\band\b)/i);
    for (const part of parts) {
      const cleaned = part.replace(/\(.*?\)/g, '').trim();
      // open–8PM, 4–7PM, 2 pm to 5 pm, 4-8pm
      const range = cleaned.match(
        /(open|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*[–\-—to]+\s*(close|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i
      );
      if (range) {
        let start = parseClockToken(range[1]);
        let end = parseClockToken(range[2]);
        if (range[1].toLowerCase().includes('open')) start = 10 * 60; // assume opens ~10
        if (start == null || end == null) continue;
        if (end <= start) end += 24 * 60; // overnight
        windows.push({ start, end });
        continue;
      }
      // Single clock like "6PM & 11PM" happy minutes — treat as 30-min windows
      const single = cleaned.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
      if (single && /&|,/.test(timesText)) {
        const s = parseClockToken(single[1]);
        if (s != null) windows.push({ start: s, end: s + 30 });
      }
    }
    return windows;
  }

  function isHappyHourAt(bar, day, minutes) {
    const daysText = bar.happy_hour_days || '';
    const timesText = bar.happy_hour_times || '';
    if (!daysText && !timesText && !bar.deal) return false;
    if (!bar.deal && !timesText) return false;

    let days = expandDays(daysText);
    // If days empty but deal exists, assume daily when times present
    if (days.length === 0) {
      if (/daily|all day/i.test(timesText) || /daily/i.test(bar.deal || '')) {
        days = [0, 1, 2, 3, 4, 5, 6];
      } else if (timesText) {
        days = [1, 2, 3, 4, 5]; // default weekday
      } else {
        return false;
      }
    }

    // Combined "Wed–Fri Open–8PM" sometimes lives only in days field
    const windows = parseTimeWindows(timesText) || [];
    if (windows.length === 0 && /open|–|-|pm|am/i.test(daysText)) {
      windows.push(...parseTimeWindows(daysText));
    }
    if (windows.length === 0 && timesText) {
      // fallback common HH
      windows.push({ start: 15 * 60, end: 19 * 60 });
    }
    if (windows.length === 0) return days.includes(day);

    if (!days.includes(day)) {
      // check overnight window from previous day
      for (const w of windows) {
        if (w.end > 24 * 60 && days.includes((day + 6) % 7)) {
          const adj = minutes + 24 * 60;
          if (adj >= w.start && adj < w.end) return true;
        }
      }
      return false;
    }

    for (const w of windows) {
      const m = minutes;
      if (m >= w.start && m < Math.min(w.end, 24 * 60)) return true;
      if (w.end > 24 * 60 && m < w.end - 24 * 60) return true;
    }
    return false;
  }

  function isProbablyOpen(bar, day, minutes) {
    // Prefer bar_hours if present; else assume open evenings if has HH
    const hours = bar.bar_hours || '';
    if (!hours) {
      // Heuristic: bars typically 11–2am
      return minutes >= 11 * 60 || minutes < 2 * 60;
    }
    // Very light parse of opening_hours-like strings
    const windows = parseTimeWindows(hours.replace(/\|/g, ' | '));
    if (windows.length === 0) return true;
    for (const w of windows) {
      if (minutes >= w.start && minutes < w.end) return true;
    }
    return false;
  }

  function nowParts() {
    const d = new Date();
    return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
  }

  function formatPrice(n) {
    if (!n) return '';
    return '$'.repeat(Math.min(3, Math.max(1, n)));
  }

  function mapsUrl(bar) {
    const q = encodeURIComponent(bar.address || `${bar.name} Tucson AZ`);
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }

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

  // ——— Filtering ———

  function applyFilters() {
    const q = state.query.trim().toLowerCase();
    const { day, minutes } =
      state.timeMode === 'hhtime'
        ? { day: state.hhDay, minutes: state.hhMinutes }
        : nowParts();

    let list = state.allBars.slice();

    if (state.area !== 'all') {
      list = list.filter((b) => b.area === state.area);
    }
    if (state.vibe !== 'all') {
      list = list.filter((b) => b.vibe === state.vibe);
    }
    if (state.price !== 'all') {
      list = list.filter((b) => String(b.price) === state.price);
    }
    if (state.outdoorOnly) list = list.filter((b) => b.outdoor);
    if (state.sunlinkOnly) list = list.filter((b) => b.sunlink && b.sunlink.length);
    if (state.verifiedOnly) list = list.filter((b) => b.source === 'verified');

    if (state.timeMode === 'hhnow' || state.timeMode === 'hhtime') {
      list = list.filter((b) => isHappyHourAt(b, day, minutes));
    } else if (state.timeMode === 'open') {
      list = list.filter((b) => isProbablyOpen(b, day, minutes));
    }

    if (q) {
      list = list.filter((b) => {
        const hay = [b.name, b.neighborhood, b.area, b.vibe, b.deal, b.address, b.food]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }

    // Distance sort if near me
    if (state.userLat != null && state.userLng != null) {
      list.forEach((b) => {
        b._distance = haversineMiles(state.userLat, state.userLng, b.lat, b.lng);
      });
      list.sort((a, b) => (a._distance || 99) - (b._distance || 99));
    } else {
      list.sort((a, b) => {
        if (a.featured && !b.featured) return -1;
        if (!a.featured && b.featured) return 1;
        return (b.rating || 0) - (a.rating || 0);
      });
    }

    state.filtered = list;
    render();
  }

  // ——— Render ———

  function cardHtml(bar, index) {
    const now = nowParts();
    const hhActive = isHappyHourAt(bar, now.day, now.minutes);
    const price = formatPrice(bar.price);
    const verified = bar.source === 'verified';
    const dist =
      bar._distance != null ? ` · ${bar._distance < 10 ? bar._distance.toFixed(1) : Math.round(bar._distance)} mi` : '';

    return `
      <article class="bar-card ${bar.featured ? 'featured' : ''}" data-slug="${bar.slug}" data-idx="${index}">
        ${hhActive ? '<div class="hh-now-tag">HH Now</div>' : ''}
        <div class="card-top">
          <div>
            <h3 class="card-name">
              ${escapeHtml(bar.name)}
              ${bar.featured ? '<span class="badge top">Top Pick</span>' : ''}
              ${verified ? '<span class="badge verified">Verified HH</span>' : ''}
            </h3>
            <p class="card-meta">
              ${escapeHtml(bar.vibe || 'Bar')}
              ${bar.rating != null ? ` · ★ ${bar.rating}` : ''}
              ${bar.rating_count ? ` (${bar.rating_count})` : ''}
              · ${escapeHtml(bar.neighborhood || '')}
              ${bar.sunlink && bar.sunlink.length ? `<span class="sunlink-chip">Sun Link · ${escapeHtml(bar.sunlink[0])}</span>` : ''}
              ${dist}
            </p>
          </div>
        </div>
        ${
          bar.happy_hour_days || bar.happy_hour_times
            ? `<p class="hh-line ${hhActive ? '' : 'inactive'}">${escapeHtml(
                [bar.happy_hour_days, bar.happy_hour_times].filter(Boolean).join(' ')
              )}</p>`
            : ''
        }
        ${bar.deal ? `<p class="deal">${escapeHtml(bar.deal)}</p>` : ''}
        ${bar.food ? `<p class="food">${escapeHtml(bar.food)}</p>` : ''}
        ${
          price
            ? `<div class="price-row"><span class="price-tag">${price}</span><span class="price-dim">${'$$$'.slice(
                price.length
              )}</span></div>`
            : ''
        }
        <div class="card-links">
          ${bar.address ? `<span class="card-link" style="cursor:default">${escapeHtml(bar.address)}</span>` : ''}
          ${bar.website ? `<a class="card-link" href="${escapeAttr(bar.website)}" target="_blank" rel="noopener">Website →</a>` : ''}
          <a class="card-link" href="${mapsUrl(bar)}" target="_blank" rel="noopener">Maps ⌖</a>
          <button type="button" class="card-link" data-focus-map="${index}">Show on map</button>
        </div>
      </article>
    `;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function renderList() {
    const grid = $('cardsGrid');
    if (!state.filtered.length) {
      grid.innerHTML =
        '<div class="empty-state">No bars match these filters. Try clearing HH Now or searching a neighborhood.</div>';
      return;
    }
    grid.innerHTML = state.filtered.map((b, i) => cardHtml(b, i)).join('');
    grid.querySelectorAll('[data-focus-map]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-focus-map'), 10);
        switchView('map');
        focusBar(idx);
      });
    });
  }

  function renderMapSidebar() {
    const el = $('mapSidebarList');
    el.innerHTML = state.filtered
      .slice(0, 40)
      .map(
        (b, i) => `
      <div class="map-side-card" data-idx="${i}">
        <h4>${escapeHtml(b.name)}</h4>
        <p>${escapeHtml(b.neighborhood)} · ${escapeHtml(b.deal || b.vibe || '')}</p>
      </div>`
      )
      .join('');
    el.querySelectorAll('.map-side-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.getAttribute('data-idx'), 10);
        focusBar(idx);
        el.querySelectorAll('.map-side-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
      });
    });
  }

  function ensureMap() {
    if (state.map) {
      setTimeout(() => state.map.invalidateSize(), 100);
      return;
    }
    state.map = L.map('mapContainer', { zoomControl: true }).setView(
      [TUCSON.lat, TUCSON.lng],
      13
    );
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(state.map);
    state.cluster = L.markerClusterGroup({ maxClusterRadius: 48 });
    state.map.addLayer(state.cluster);
  }

  function updateMapMarkers() {
    ensureMap();
    state.cluster.clearLayers();
    state.markers = [];

    state.filtered.forEach((bar, i) => {
      const icon = L.divIcon({
        className: '',
        html: `<div class="pin-icon">${i + 1}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const marker = L.marker([bar.lat, bar.lng], { icon });
      marker.bindPopup(
        `<div class="popup-title">${escapeHtml(bar.name)}</div>
         <div>${escapeHtml(bar.neighborhood)} · ${escapeHtml(bar.vibe || '')}</div>
         ${bar.deal ? `<div class="popup-deal">${escapeHtml(bar.deal)}</div>` : ''}
         <div style="margin-top:6px"><a href="${mapsUrl(bar)}" target="_blank" rel="noopener">Maps</a></div>`
      );
      state.cluster.addLayer(marker);
      state.markers.push(marker);
    });

    if (state.filtered.length) {
      const bounds = L.latLngBounds(state.filtered.map((b) => [b.lat, b.lng]));
      state.map.fitBounds(bounds.pad(0.15));
    }
    renderMapSidebar();
    $('mapSidebar').classList.add('open');
  }

  function focusBar(idx) {
    const bar = state.filtered[idx];
    const marker = state.markers[idx];
    if (!bar || !marker) return;
    state.map.setView([bar.lat, bar.lng], 16, { animate: true });
    marker.openPopup();
  }

  function renderCount() {
    const n = state.filtered.length;
    const hh = state.filtered.filter((b) => {
      const now = nowParts();
      return isHappyHourAt(b, now.day, now.minutes);
    }).length;
    $('resultCount').textContent = `${n} bars · ${hh} HH now`;
  }

  function render() {
    renderCount();
    if (state.view === 'list') renderList();
    else updateMapMarkers();
  }

  function switchView(view) {
    state.view = view;
    $('tabList').classList.toggle('active', view === 'list');
    $('tabMap').classList.toggle('active', view === 'map');
    $('tabList').setAttribute('aria-selected', view === 'list');
    $('tabMap').setAttribute('aria-selected', view === 'map');
    $('listView').hidden = view !== 'list';
    $('mapView').hidden = view !== 'map';
    if (view === 'map') {
      ensureMap();
      updateMapMarkers();
      setTimeout(() => state.map.invalidateSize(), 150);
    } else {
      renderList();
    }
  }

  // ——— Autocomplete / search ———

  function buildNeighborhoodIndex() {
    const set = new Map();
    state.allBars.forEach((b) => {
      if (b.neighborhood) set.set(b.neighborhood, (set.get(b.neighborhood) || 0) + 1);
    });
    state.neighborhoods = [...set.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  function showAutocomplete(q) {
    const list = $('autocompleteList');
    if (!q || q.length < 1) {
      list.hidden = true;
      return;
    }
    const lq = q.toLowerCase();
    const hoods = state.neighborhoods
      .filter((n) => n.name.toLowerCase().includes(lq))
      .slice(0, 6)
      .map(
        (n) =>
          `<li data-q="${escapeAttr(n.name)}"><strong>${escapeHtml(n.name)}</strong><span class="ac-meta">Neighborhood · ${n.count} bars</span></li>`
      );
    const bars = state.allBars
      .filter((b) => b.name.toLowerCase().includes(lq))
      .slice(0, 6)
      .map(
        (b) =>
          `<li data-q="${escapeAttr(b.name)}"><strong>${escapeHtml(b.name)}</strong><span class="ac-meta">${escapeHtml(b.neighborhood)} · ${escapeHtml(b.vibe || '')}</span></li>`
      );
    const items = [...hoods, ...bars];
    if (!items.length) {
      list.hidden = true;
      return;
    }
    list.innerHTML = items.join('');
    list.hidden = false;
    list.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => {
        $('searchInput').value = li.getAttribute('data-q');
        list.hidden = true;
        runSearch();
      });
    });
  }

  function runSearch() {
    state.query = $('searchInput').value.trim();
    $('searchClear').hidden = !state.query;
    $('autocompleteList').hidden = true;
    applyFilters();
    if (state.view === 'list') {
      $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  async function nearMe() {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported in this browser.');
      return;
    }
    $('nearMeBtn').textContent = '…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.userLat = pos.coords.latitude;
        state.userLng = pos.coords.longitude;
        state.query = '';
        $('searchInput').value = '';
        $('searchClear').hidden = true;
        $('nearMeBtn').textContent = '⌖';
        applyFilters();
        switchView('map');
        state.map.setView([state.userLat, state.userLng], 14);
        L.circleMarker([state.userLat, state.userLng], {
          radius: 8,
          color: '#a3e635',
          fillColor: '#a3e635',
          fillOpacity: 0.8,
        })
          .addTo(state.map)
          .bindPopup('You are here')
          .openPopup();
      },
      () => {
        $('nearMeBtn').textContent = '⌖';
        alert('Could not get your location. Check permissions.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // ——— Clock ———

  function tickClock() {
    const d = new Date();
    const opts = {
      timeZone: 'America/Phoenix',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    };
    $('liveClock').textContent = d.toLocaleString('en-US', opts) + ' MST';
  }

  // ——— Filters UI ———

  function buildVibeFilters() {
    const vibes = [...new Set(state.allBars.map((b) => b.vibe).filter(Boolean))].sort();
    const row = $('vibeFilterRow');
    row.innerHTML =
      `<button type="button" class="filter-btn active" data-vibe="all">All vibes</button>` +
      vibes
        .map((v) => `<button type="button" class="filter-btn" data-vibe="${escapeAttr(v)}">${escapeHtml(v)}</button>`)
        .join('');
    row.querySelectorAll('[data-vibe]').forEach((btn) => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('[data-vibe]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.vibe = btn.getAttribute('data-vibe');
        applyFilters();
        updateFilterToggleState();
      });
    });
  }

  function buildAreaFilters() {
    const areas = [...new Set(state.allBars.map((b) => b.area).filter(Boolean))].sort();
    const row = $('areaRow');
    row.innerHTML =
      `<button type="button" class="filter-btn active" data-area="all">All areas</button>` +
      areas
        .map((a) => `<button type="button" class="filter-btn" data-area="${escapeAttr(a)}">${escapeHtml(a)}</button>`)
        .join('');
    row.querySelectorAll('[data-area]').forEach((btn) => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('[data-area]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.area = btn.getAttribute('data-area');
        applyFilters();
        updateFilterToggleState();
      });
    });
  }

  function updateFilterToggleState() {
    const active =
      state.timeMode !== 'all' ||
      state.vibe !== 'all' ||
      state.price !== 'all' ||
      state.outdoorOnly ||
      state.sunlinkOnly ||
      state.verifiedOnly ||
      state.area !== 'all';
    $('filterToggle').classList.toggle('has-active', active);
  }

  function wireFilters() {
    $('filterToggle').addEventListener('click', () => {
      const panel = $('filtersPanel');
      const open = panel.hidden;
      panel.hidden = !open;
      $('filterToggle').classList.toggle('open', open);
    });

    $('timeFilterRow').querySelectorAll('[data-time]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('timeFilterRow').querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.timeMode = btn.getAttribute('data-time');
        $('hhTimePanel').hidden = true;
        applyFilters();
        updateFilterToggleState();
      });
    });

    $('hhTimeBtn').addEventListener('click', () => {
      const panel = $('hhTimePanel');
      panel.hidden = !panel.hidden;
      $('timeFilterRow').querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      $('hhTimeBtn').classList.add('active');
      state.timeMode = 'hhtime';
      $('hhDay').value = String(state.hhDay);
    });

    $('hhTimeApply').addEventListener('click', () => {
      state.hhDay = parseInt($('hhDay').value, 10);
      const [h, m] = ($('hhTime').value || '17:00').split(':').map(Number);
      state.hhMinutes = h * 60 + m;
      state.timeMode = 'hhtime';
      applyFilters();
      updateFilterToggleState();
    });

    document.querySelectorAll('[data-price]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-price]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.price = btn.getAttribute('data-price');
        applyFilters();
        updateFilterToggleState();
      });
    });

    document.querySelector('[data-outdoor]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      state.outdoorOnly = !state.outdoorOnly;
      btn.classList.toggle('active', state.outdoorOnly);
      applyFilters();
      updateFilterToggleState();
    });

    document.querySelector('[data-sunlink]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      state.sunlinkOnly = !state.sunlinkOnly;
      btn.classList.toggle('active', state.sunlinkOnly);
      applyFilters();
      updateFilterToggleState();
    });

    document.querySelector('[data-verified]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      state.verifiedOnly = !state.verifiedOnly;
      btn.classList.toggle('active', state.verifiedOnly);
      applyFilters();
      updateFilterToggleState();
    });
  }

  function wireChrome() {
    $('tabList').addEventListener('click', () => switchView('list'));
    $('tabMap').addEventListener('click', () => switchView('map'));
    $('searchBtn').addEventListener('click', runSearch);
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch();
      }
    });
    $('searchInput').addEventListener('input', (e) => {
      $('searchClear').hidden = !e.target.value;
      showAutocomplete(e.target.value);
    });
    $('searchClear').addEventListener('click', () => {
      $('searchInput').value = '';
      state.query = '';
      $('searchClear').hidden = true;
      $('autocompleteList').hidden = true;
      applyFilters();
    });
    $('nearMeBtn').addEventListener('click', nearMe);
    $('sidebarClose').addEventListener('click', () => $('mapSidebar').classList.remove('open'));
    $('mapFsBtn').addEventListener('click', () => {
      $('mapView').classList.toggle('fullscreen');
      setTimeout(() => state.map && state.map.invalidateSize(), 200);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('mapView').classList.contains('fullscreen')) {
        $('mapView').classList.remove('fullscreen');
        setTimeout(() => state.map && state.map.invalidateSize(), 200);
      }
    });

    const top = $('backToTop');
    window.addEventListener('scroll', () => {
      top.hidden = window.scrollY < 400;
    });
    top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  // ——— Init ———

  async function init() {
    tickClock();
    setInterval(tickClock, 30000);
    wireChrome();
    wireFilters();

    try {
      const res = await fetch('bars.json');
      state.allBars = await res.json();
    } catch (err) {
      $('cardsGrid').innerHTML =
        '<div class="empty-state">Could not load bars.json. Serve this folder over HTTP.</div>';
      console.error(err);
      return;
    }

    buildNeighborhoodIndex();
    buildVibeFilters();
    buildAreaFilters();
    $('hhDay').value = String(new Date().getDay());
    applyFilters();

    // Open filters by default on first visit so MVP features are discoverable
    $('filtersPanel').hidden = false;
    $('filterToggle').classList.add('open');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
