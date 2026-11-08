// ==UserScript==
// @name         GeoFS Living World Addon
// @namespace    https://github.com/MVX-star/GeoFS-Living-World-Addon
// @author       SkyTeamDelta
// @license      MIT
// @homepageURL  https://github.com/MVX-star/GeoFS-Living-World-Addon
// @supportURL   https://github.com/MVX-star/GeoFS-Living-World-Addon/issues
// @updateURL    https://raw.githubusercontent.com/MVX-star/GeoFS-Living-World-Addon/main/GeoFS-Living-World-Addon.user.js
// @downloadURL  https://raw.githubusercontent.com/MVX-star/GeoFS-Living-World-Addon/main/GeoFS-Living-World-Addon.user.js
// @version      0.23.0
// @description  GeoFS Living World: AI traffic on real OpenStreetMap roads with night lighting, in a native GeoFS menu
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      tiles.openfreemap.org
// @connect      overpass-api.de
// @connect      overpass.kumi.systems
// @connect      overpass.private.coffee
// @connect      maps.mail.ru
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  SETTINGS
   * ------------------------------------------------------------------ */
  const DEFAULTS = {
    enabled: true,
    radiusUnl: false,   // unlimited car radius (really UNL_KM)
    radiusKm: 5,        // cars only exist inside this radius around you; everything outside is removed
    maxCars: 3000,      // cars simulated (all inside the car radius, so a small radius = a dense, lively area)
    detail: 'regular',   // model detail: low / regular / high
    mode: 'manual',      // 'manual' = you set the sliders, 'auto' = Auto-Configure picks them for where you are
    source: 'auto',     // where roads and rails come from: 'auto' = fast map tiles with Overpass as backup, 'overpass' = Overpass only
    rare: true,          // rare vehicles: supercars, cruise ships and famous trains
    rareCars: true, rareTrains: true, rareShips: true,
    rareHl: false,        // yellow ring (and an arrow at the screen edge) on every rare vehicle, however far away
    rareFreq: 1,         // 1 = normal rarity, 0 = none, 20 = a lot of them (handy for finding them)
    rareTier: { uncommon: 3, rare: 3, veryrare: 0.8, legendary: 0.3 },   // % of the trains / ships that are rare, per tier (cars get a much smaller share)
    maxDrawn: 500,      // cars actually drawn (nearest first); lower this if it lags
    heightOffset: 0,    // metres added to terrain height (calibrate if cars float or sink)
    localRoads: true,   // include residential/unclassified roads (lots more places for cars to be)
    localRadiusKm: 5,   // local streets only load this close to you
    lights: 'auto',     // 'auto' | 'on' | 'off'
    farDots: true,      // cars that are inside the radius but too many to draw as models show as small coloured dots
    maxDots: 4000,
    trains: true,       // trains on real railways
    maxTrains: 25,      // trains running at once (each is several cars long)
    boats: true,        // boats and ships on ferry routes, shipping lanes and big rivers
    maxBoats: 40,
    waterOffset: 0,     // metres added to boat height (boats float or sink? change it)
    followTraffic: true, // cars keep a gap to the car ahead, so slowdowns ripple back as traffic waves
    nightDark: 85,      // how dark vehicles get at night, in % (GeoFS darkens everything else at night too)
    lightFx: true,      // glowing 3D headlight / taillight beams at night
    bloom: false,       // experimental screen glow (affects the whole view)
    v: 9                // settings version (bumped when defaults change)
  };
  function loadCfg() {
    try {
      const saved = JSON.parse(localStorage.getItem('gftraffic') || '{}');
      if (saved.v !== 9) { if (!(saved.v >= 4)) delete saved.maxCars; delete saved.groundMode; delete saved.nearModelM; if (!(saved.v >= 6)) delete saved.radiusKm; if (!(saved.v >= 7)) { delete saved.localRoads; delete saved.localRadiusKm; if (saved.maxCars < 3000) delete saved.maxCars; } if (!(saved.v >= 8)) delete saved.nightDark; if (!(saved.v >= 9)) delete saved.rareHl; saved.v = 9; }   // adopt new defaults
      return saved;
    } catch (e) { return {}; }
  }
  const cfg = Object.assign({}, DEFAULTS, loadCfg());
  cfg.rareTier = Object.assign({}, DEFAULTS.rareTier, cfg.rareTier || {});
  cfg.nightDark = 85; cfg.lightFx = true; cfg.bloom = false;     // no longer in the menu: fixed values
  if (cfg.maxCars > 10000) cfg.maxCars = 10000;   // slider stops at 10,000 again
  // trains and boats are always part of the addon; the Max sliders set how many (0 = none)
  function syncKinds() { cfg.trains = cfg.maxTrains > 0; cfg.boats = cfg.maxBoats > 0; }
  syncKinds();
  // Auto-Configure takes over these settings; your own values are kept aside and come back when you switch to Manual
  const UNL_KM = 30;
  const MANAGED = ['radiusKm', 'maxCars', 'maxTrains', 'maxBoats', 'maxDrawn'];
  function pickManual() { const o = {}; MANAGED.forEach(function (k) { o[k] = cfg[k]; }); return o; }
  if (cfg.mode !== 'auto') cfg.mode = 'manual'; else cfg.manualSaved = pickManual();
  function saveCfg() {
    try {
      const o = Object.assign({}, cfg);
      if (cfg.mode === 'auto' && cfg.manualSaved) Object.assign(o, cfg.manualSaved);
      delete o.manualSaved;
      localStorage.setItem('gftraffic', JSON.stringify(o));
    } catch (e) { /* ignore */ }
  }

  // Public Overpass servers (tried in rotation). The last two are listed on the OSM wiki but I could not
  // test them from my side; if one is dead the script just moves on to the next.
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  // (sizes of the 3D model pools are set with the vehicle models below)
  const D2R = Math.PI / 180;

  const ROAD_SPEED = { motorway: 29, trunk: 25, primary: 20, secondary: 16, tertiary: 13, unclassified: 11, residential: 9, living_street: 5 };
  const ROAD_WEIGHT = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1, living_street: 1 };
  // railways (kind 'rail') and water routes (kind 'boat'): speed in m/s, and how much traffic each class gets
  const RAIL_SPEED = { rail: 30, light_rail: 20, subway: 17, tram: 10, narrow_gauge: 14 };
  const WATER_SPEED = { ferry: 8, fairway: 7, river: 5 };
  const KIND_WEIGHT = { rail: 4, light_rail: 2, subway: 2, tram: 1.5, narrow_gauge: 1, ferry: 3, fairway: 4, river: 1 };
  const PAINT = ['#f2f2f2', '#1b1b1b', '#9aa0a6', '#b3202a', '#1f4e9c', '#2e6b3a', '#d9b43c'];

  /* ------------------------------------------------------------------ *
   *  SMALL MATH HELPERS
   * ------------------------------------------------------------------ */
  function distM(lat1, lon1, lat2, lon2) {
    const x = (lon2 - lon1) * Math.cos((lat1 + lat2) * 0.5 * D2R);
    const y = lat2 - lat1;
    return Math.sqrt(x * x + y * y) * 111320;
  }
  function bearing(lat1, lon1, lat2, lon2) {
    return Math.atan2((lon2 - lon1) * Math.cos(lat1 * D2R), lat2 - lat1); // radians, 0 = north
  }
  function sunElevation(date, lat, lon) {
    const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const g = (357.529 + 0.98560028 * d) * D2R;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const e = (23.439 - 0.00000036 * d) * D2R;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ha = (gmst * 15 + lon) * D2R - ra;
    return Math.asin(Math.sin(lat * D2R) * Math.sin(dec) + Math.cos(lat * D2R) * Math.cos(dec) * Math.cos(ha));
  }

  /* ------------------------------------------------------------------ *
   *  WAIT FOR GEOFS
   * ------------------------------------------------------------------ */
  // Tampermonkey can run scripts in a sandbox; unsafeWindow is the real page, where GeoFS lives.
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // Small badge so you can see the script is running while it waits for GeoFS to finish loading.
  let badge = null;
  try {
    badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;padding:6px 10px;border-radius:14px;' +
      'background:rgba(20,26,36,.9);color:#e8ecf2;font:12px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.5);';
    badge.textContent = '\uD83C\uDF0D GeoFS Living World: starting...';
    document.body.appendChild(badge);
  } catch (e) { badge = null; }

  function waitForGeoFS(cb) {
    let tries = 0;
    const t = setInterval(function () {
      tries++;
      const g = W.geofs;
      let missing = '';
      if (!g) missing = 'geofs';
      else if (!g.api || !g.api.viewer) missing = 'geofs.api.viewer';
      else if (!W.Cesium) missing = 'Cesium';
      else if (!g.aircraft || !g.aircraft.instance || !g.aircraft.instance.llaLocation) missing = 'aircraft (spawn into a flight first)';
      if (!missing) {
        clearInterval(t);
        if (badge) { badge.remove(); badge = null; }
        cb();
        return;
      }
      if (badge) badge.textContent = '\uD83C\uDF0D GeoFS Living World: waiting for ' + missing + ' (' + tries + 's)';
    }, 1000);
  }

  waitForGeoFS(function () {
    const geofs = W.geofs, Cesium = W.Cesium;   // always the page's own objects
    const viewer = geofs.api.viewer;

    function playerPos() {
      const p = geofs.aircraft.instance.llaLocation;
      return { lat: p[0], lon: p[1] };
    }

    /* ---------------------------------------------------------------- *
     *  ROAD DATA (Overpass tiles)
     * ---------------------------------------------------------------- */
    // how long things took since you last jumped somewhere new (shown in Advanced, helps find what is slow)
    const JUMP = { pos: null, t0: Date.now(), tile: null, car: null, all: null, ground: null };
    const tiles = new Map();      // key -> {key, layer, size, ix, iy, state, ways, retries, ...}
    const wayOwner = new Map();   // way id -> tile key
    const nodeIndex = new Map();  // node id -> [{way, i}]
    // Two layers: big tiles for main roads (few requests), small tiles for local streets (the data
    // per tile is huge, so one big tile used to time out and local roads never appeared).
    const LAYERS = {
      near:  { size: 0.03, cls: 'motorway|trunk|primary|secondary|tertiary', timeout: 30 },   // quick start: cars within seconds
      main:  { size: 0.10, cls: 'motorway|trunk|primary|secondary|tertiary', timeout: 50 },   // big tiles = few requests
      local: { size: 0.025, cls: 'unclassified|residential|living_street',   timeout: 60 },
      rail:  { size: 0.10,  kind: 'rail',  timeout: 50 },    // railways (no tunnels, yards or sidings)
      water: { size: 0.15,  kind: 'boat',  timeout: 60 },    // ferry routes, shipping lanes, big rivers and canals
      // the same roads and rails as ready-made map tiles (these replace near / main / local / rail while the fast tiles work)
      vmain: { vec: true }, vlocal: { vec: true }, vrail: { vec: true }
    };
    const RAIL_QUERY = 'way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"]["tunnel"!="yes"]["service"!~"^(yard|siding|spur|crossover)$"]';
    const WATER_QUERY = '(way["route"="ferry"]BBOX;way["waterway"="fairway"]BBOX;' +
      'way["seamark:type"~"^(fairway|recommended_track|separation_lane)$"]BBOX;' +
      'way["waterway"~"^(river|canal)$"]["width"~"^([3-9][0-9]|[0-9]{3,})"]BBOX;' +
      'way["waterway"~"^(river|canal)$"]["boat"~"^(yes|permissive)$"]BBOX;' +
      'way["waterway"~"^(river|canal)$"]["ship"="yes"]BBOX;)';
    let maxInflight = 4;          // parallel requests; backs off if a server complains
    const NET_GAP_MS = 300;       // minimum gap between starting two network requests
    const CACHE_TTL = 14 * 86400000;
    let inflight = 0;
    let busy = false;             // true while any network request is running
    let lastMsg = 'no result yet';  // outcome of the most recent request (stays on screen)
    let reqHost = '';               // server of the latest request
    let nextFetchAt = 0;
    // rotates through server x method (POST, then GET) until one works; the working one is remembered
    let combo = 0;
    try { combo = parseInt(localStorage.getItem('gftraffic_combo'), 10) || 0; } catch (e) { combo = 0; }
    let poolDirty = true;
    let cacheHits = 0;
    let okCount = 0;
    const comboBad = {};          // server/method combos to skip until this time
    const comboOk = {};           // combos that have worked this session

    function tileKey(layer, ix, iy) { return layer + ':' + ix + ',' + iy; }
    function tileCenter(t) { return t.c || { lat: (t.iy + 0.5) * t.size, lon: (t.ix + 0.5) * t.size }; }
    function layerRadiusM(layer) {
      if (layer === 'water') return (cfg.boats || cfg.mode === 'auto') ? cfg.radiusKm * 1000 : -1;
      const vec = layer.charAt(0) === 'v';
      if (vec !== useVec()) return -1;                       // only one source feeds roads and rails at a time
      const base = vec ? layer.slice(1) : layer;
      if (base === 'main') return cfg.radiusKm * 1000;
      if (base === 'near') return Math.min(3500, cfg.radiusKm * 1000);
      if (base === 'rail') return (cfg.trains || cfg.mode === 'auto') ? cfg.radiusKm * 1000 : -1;
      return cfg.localRoads ? Math.min(cfg.localRadiusKm, cfg.radiusKm) * 1000 : -1;
    }

    // ---- persistent tile cache (IndexedDB): revisiting an area loads instantly ----
    let idb = null, idbReady = false;
    try {
      const rq = indexedDB.open('gftraffic2', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('tiles'); };
      rq.onsuccess = function () { idb = rq.result; idbReady = true; };
      rq.onerror = function () { idbReady = true; };
      rq.onblocked = function () { idbReady = true; };
      setTimeout(function () { idbReady = true; }, 3000);
    } catch (e) { idbReady = true; }
    function cacheGet(key, cb) {
      if (!idb) return cb(null);
      try {
        const rq = idb.transaction('tiles').objectStore('tiles').get(key);
        rq.onsuccess = function () { const v = rq.result; cb(v && Date.now() - v.t < CACHE_TTL ? v.ways : null); };
        rq.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    }
    function cachePut(key, specs) {
      if (!idb) return;
      try { idb.transaction('tiles', 'readwrite').objectStore('tiles').put({ t: Date.now(), ways: specs }, key); } catch (e) { /* ignore */ }
    }

    function updateTiles() {
      const p = playerPos();
      Object.keys(LAYERS).forEach(function (layer) {
        const r = layerRadiusM(layer);
        if (r < 0) return;
        if (LAYERS[layer].vec) { if (VEC.tpl) vecEnumerate(layer, r, p); return; }
        const size = LAYERS[layer].size;
        const dLat = r / 111320;
        const dLon = r / (111320 * Math.cos(p.lat * D2R));
        const ix0 = Math.floor((p.lon - dLon) / size), ix1 = Math.floor((p.lon + dLon) / size);
        const iy0 = Math.floor((p.lat - dLat) / size), iy1 = Math.floor((p.lat + dLat) / size);
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const key = tileKey(layer, ix, iy);
            if (tiles.has(key)) continue;
            const t = { key: key, layer: layer, size: size, ix: ix, iy: iy, state: 'queued', ways: [], retries: 0, net: false, combo: 0 };
            const c = tileCenter(t);
            if (distM(p.lat, p.lon, c.lat, c.lon) > r + size * 111320 * 0.7) continue;
            tiles.set(key, t);
          }
        }
      });
    }

    function pump() {
      if (!idbReady) return;
      const now = Date.now();
      // watchdog: a request that never answered
      tiles.forEach(function (t) {
        if (t.vec) { if (t.state === 'loading' && now - t.startedAt > 90000) t.state = 'queued'; }
        else if (t.state === 'loading' && now - t.startedAt > 70000) { lastMsg = 'request hung 70s'; fail(t); }
        if (t.state === 'failed' && now - t.failedAt > 60000) { t.state = 'queued'; t.retries = 0; }  // try again later
      });
      const p = playerPos();
      let started = 0;
      while (started < 6 && inflight < maxInflight && Date.now() >= nextFetchAt) {
        let best = null, bestD = Infinity;
        tiles.forEach(function (t, key) {
          if (t.state !== 'queued' || t.vec) return;
          const c = tileCenter(t);
          const d = distM(p.lat, p.lon, c.lat, c.lon);
          if (d > layerRadiusM(t.layer) + t.size * 111320 * 1.5) { tiles.delete(key); return; }
          const rank = d - (t.layer === 'near' ? 1e6 : 0);   // the quick-start tiles always go first
          if (rank < bestD) { bestD = rank; best = t; }
        });
        if (!best) break;
        startTile(best);
        started++;
      }
    }

    function startTile(t) {
      t.state = 'loading';
      t.startedAt = Date.now();
      cacheGet(t.key, function (specs) {
        if (tiles.get(t.key) !== t || t.state !== 'loading') return;
        if (specs) { addWays(t, specs); t.state = 'done'; cacheHits++; poolDirty = true; return; }
        if (inflight >= maxInflight || Date.now() < nextFetchAt) { t.state = 'queued'; return; }  // wait for a free slot
        netFetch(t);
      });
    }

    // Uses Tampermonkey's cross-origin request when granted; otherwise falls back to plain fetch
    // (works with servers that send CORS headers, even if the @grant block was not applied).
    let transport = '?';
    function httpPost(o) {
      if (typeof GM_xmlhttpRequest === 'function') { transport = 'GM_xmlhttpRequest'; return GM_xmlhttpRequest(o); }
      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') { transport = 'GM.xmlHttpRequest'; return GM.xmlHttpRequest(o); }
      transport = 'plain fetch (no GM grant)';
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      const to = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); o.ontimeout(); }, o.timeout || 30000);
      fetch(o.url, { method: o.method, headers: o.headers, body: o.data, signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          return r.text().then(function (text) {
            clearTimeout(to);
            if (!timedOut) o.onload({ status: r.status, responseText: text });
          });
        })
        .catch(function (err) {
          clearTimeout(to);
          if (!timedOut) o.onerror(err);
        });
    }

    function netFetch(t) {
      const L = LAYERS[t.layer];
      const s = t.iy * t.size, w = t.ix * t.size, n = s + t.size, e = w + t.size;
      const bbox = [s, w, n, e].map(function (v) { return v.toFixed(5); }).join(',');
      let q;
      if (L.kind === 'rail') q = '[out:json][timeout:' + L.timeout + '];' + RAIL_QUERY + '(' + bbox + ');out geom qt;';
      else if (L.kind === 'boat') q = '[out:json][timeout:' + L.timeout + '];' + WATER_QUERY.replace(/BBOX/g, '(' + bbox + ')') + ';out geom qt;';
      else q = '[out:json][timeout:' + L.timeout + '];way["highway"~"^(' + L.cls + ')$"](' + bbox + ');out geom qt;';
      // skip server/method combinations that recently failed (a dead server must not hold up a slot)
      const NC = ENDPOINTS.length * 2;
      for (let g = 0; g < NC && comboBad[combo % NC] > Date.now(); g++) combo++;
      t.net = true;
      t.combo = combo;
      t.startedAt = Date.now();
      inflight++; busy = true;
      nextFetchAt = Date.now() + NET_GAP_MS;
      const useGet = Math.floor(combo / ENDPOINTS.length) % 2 === 1;
      const base = ENDPOINTS[combo % ENDPOINTS.length];
      const host = base.split('/')[2] + (useGet ? ' GET' : ' POST');
      const body = 'data=' + encodeURIComponent(q);
      reqHost = host;
      function finish() { if (t.net) { t.net = false; inflight = Math.max(0, inflight - 1); busy = inflight > 0; } }
      try {
        httpPost({
          method: useGet ? 'GET' : 'POST',
          url: useGet ? base + '?' + body : base,
          data: useGet ? undefined : body,
          headers: useGet ? undefined : { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: (comboOk[combo % (ENDPOINTS.length * 2)] ? L.timeout + 15 : 20) * 1000,   // unproven servers get 20 s
          onload: function (res) {
            if (!t.net) return;                       // watchdog already gave up on this one
            finish();
            if (tiles.get(t.key) !== t) return;       // world was reset while this was in flight
            if (res.status === 200) {
              try {
                const json = JSON.parse(res.responseText);
                const specs = parseSpecs(json, L.kind || 'road');
                addWays(t, specs);
                t.state = 'done';
                cachePut(t.key, specs);
                poolDirty = true;
                comboOk[t.combo % (ENDPOINTS.length * 2)] = true; delete comboBad[t.combo % (ENDPOINTS.length * 2)];
                okCount++; if (okCount % 8 === 0 && maxInflight < 4) maxInflight++;
                if (t.combo === combo) { try { localStorage.setItem('gftraffic_combo', String(combo)); } catch (e2) { /* ignore */ } }
                lastMsg = host + ' OK via ' + transport + ' (' + specs.length + ' roads in a ' + t.layer + ' tile)';
              } catch (err) { lastMsg = 'parse error: ' + err.message; fail(t); }
            } else {
              lastMsg = host + ' HTTP ' + res.status;
              if (res.status === 429 || res.status === 503 || res.status === 504) maxInflight = Math.max(1, maxInflight - 1);
              fail(t);
            }
          },
          onerror: function (err) {
            if (!t.net) return;
            lastMsg = host + ' network error via ' + transport + ' (blocked?)';
            console.warn('[GeoFS Living World] request failed via ' + transport, err);
            fail(t);
          },
          ontimeout: function () { if (t.net) { lastMsg = host + ' timed out'; fail(t); } }
        });
      } catch (err) {
        lastMsg = 'request threw: ' + err.message;
        fail(t);
      }
    }

    function fail(t) {
      if (t.net) { t.net = false; inflight = Math.max(0, inflight - 1); busy = inflight > 0; }
      t.retries++;
      const NC = ENDPOINTS.length * 2;
      comboBad[t.combo % NC] = Date.now() + (comboOk[t.combo % NC] ? 20000 : 300000);   // proven servers get a short timeout
      if (t.combo === combo) combo++;   // rotate server/method (only once if several requests failed together)
      t.state = t.retries > 5 ? 'failed' : 'queued';
      t.failedAt = Date.now();
      nextFetchAt = Date.now() + 1500;
    }

    // Turns an Overpass response into compact road records (these are also what the cache stores).
    const DEFAULT_LANES = { motorway: 2, trunk: 2, primary: 2, secondary: 2, tertiary: 2 };
    function parseSpecs(data, kind) {
      const out = [];
      const els = data.elements || [];
      for (let k = 0; k < els.length; k++) {
        const el = els[k];
        if (el.type !== 'way' || !el.geometry || !el.nodes) continue;
        const tags = el.tags || {};
        if (kind === 'rail' || kind === 'boat') {
          let c2;
          if (kind === 'rail') c2 = RAIL_SPEED[tags.railway] ? tags.railway : null;
          else c2 = tags.route === 'ferry' ? 'ferry' : (tags.waterway === 'river' || tags.waterway === 'canal') ? 'river' : 'fairway';
          if (!c2) continue;
          const pts2 = [], nodes2 = [];
          for (let i = 0; i < el.geometry.length; i++) {
            const g = el.geometry[i];
            if (!g) continue;
            pts2.push([g.lat, g.lon]);
            nodes2.push(el.nodes[i]);
          }
          if (pts2.length < 2) continue;
          let ms = 0, hs = false;
          if (kind === 'rail' && tags.maxspeed) { const v = parseFloat(tags.maxspeed); if (v > 0) { const kmh = v * (/mph/.test(tags.maxspeed) ? 1.609 : 1); ms = Math.min(50, kmh / 3.6); hs = kmh >= 200; } }
          if (kind === 'rail' && tags.highspeed === 'yes') hs = true;
          out.push({ id: el.id, kind: kind, cls: c2, pts: pts2, nodes: nodes2, oneway: false, lanes: 1, bridge: !!tags.bridge && tags.bridge !== 'no', tunnel: false, ms: ms, hs: hs });
          continue;
        }
        const cls = tags.highway;
        if (!ROAD_SPEED[cls]) continue;
        // keep pts and nodes aligned; geometry can contain nulls outside the bbox
        const pts = [], nodes = [];
        for (let i = 0; i < el.geometry.length; i++) {
          const g = el.geometry[i];
          if (!g) continue;
          pts.push([g.lat, g.lon]);
          nodes.push(el.nodes[i]);
        }
        if (pts.length < 2) continue;
        let oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout' ||
                     (cls === 'motorway' && tags.oneway !== 'no');
        if (tags.oneway === '-1') { pts.reverse(); nodes.reverse(); oneway = true; }
        let lanes = parseInt(tags.lanes, 10);
        if (!(lanes > 0)) lanes = DEFAULT_LANES[cls] || 2;
        const perDir = Math.max(1, Math.min(5, oneway ? lanes : Math.floor(lanes / 2)));
        const bridge = !!tags.bridge && tags.bridge !== 'no';
        const tunnel = (!!tags.tunnel && tags.tunnel !== 'no') || tags.covered === 'yes';
        out.push({ id: el.id, cls: cls, pts: pts, nodes: nodes, oneway: oneway, lanes: perDir, bridge: bridge, tunnel: tunnel });
      }
      return out;
    }

    /* ---------------------------------------------------------------- *
     *  FAST MAP TILES (OpenFreeMap vector tiles: OpenStreetMap data cut into ready-made tiles)
     *  A tile is a small file on a CDN, so it loads in a fraction of a second. Overpass (which has to
     *  search the whole OpenStreetMap database for every request) stays as the backup.
     * ---------------------------------------------------------------- */
    // MVT-BEGIN
    // --- a small reader for Mapbox Vector Tiles (protobuf): only what road / rail data needs ---
    function mvtVarint(buf, st) {
      let r = 0, m = 1, b;
      do { b = buf[st.p++]; r += (b & 127) * m; m *= 128; } while ((b & 128) && st.p < buf.length);
      return r;
    }
    function mvtSkip(buf, st, wire) {
      if (wire === 0) mvtVarint(buf, st);
      else if (wire === 1) st.p += 8;
      else if (wire === 5) st.p += 4;
      else if (wire === 2) { const n = mvtVarint(buf, st); st.p += n; }
      else throw new Error('bad protobuf wire type ' + wire);
    }
    function mvtStr(buf, a, b) {
      let s = '';
      for (let i = a; i < b; i++) s += String.fromCharCode(buf[i]);
      return s;
    }
    function mvtValue(buf, a, b) {
      const st = { p: a };
      let v = null;
      while (st.p < b) {
        const tag = mvtVarint(buf, st), f = Math.floor(tag / 8), w = tag % 8;
        if (w === 2) { const n = mvtVarint(buf, st); if (f === 1) v = mvtStr(buf, st.p, st.p + n); st.p += n; }
        else if (w === 0) {
          const x = mvtVarint(buf, st);
          if (f === 4 || f === 5) v = x;
          else if (f === 6) v = (x % 2) ? -(x + 1) / 2 : x / 2;
          else if (f === 7) v = !!x;
        } else if (w === 1) {
          if (f === 3) v = new DataView(buf.buffer, buf.byteOffset + st.p, 8).getFloat64(0, true);
          st.p += 8;
        } else if (w === 5) {
          if (f === 2) v = new DataView(buf.buffer, buf.byteOffset + st.p, 4).getFloat32(0, true);
          st.p += 4;
        } else mvtSkip(buf, st, w);
      }
      return v;
    }
    // reads one layer; returns null unless its name is in `want`. Lines only (that is all roads and rails are).
    function mvtLayer(buf, a, end, want) {
      let st = { p: a }, name = null;
      while (st.p < end && name === null) {          // pass 1: just the name, so big unwanted layers cost nothing
        const tag = mvtVarint(buf, st), f = Math.floor(tag / 8), w = tag % 8;
        if (w === 2) { const n = mvtVarint(buf, st); if (f === 1) name = mvtStr(buf, st.p, st.p + n); st.p += n; }
        else mvtSkip(buf, st, w);
      }
      if (name === null || want.indexOf(name) < 0) return null;
      st = { p: a };
      let extent = 4096;
      const keys = [], vals = [], spans = [];
      while (st.p < end) {
        const tag = mvtVarint(buf, st), f = Math.floor(tag / 8), w = tag % 8;
        if (w === 2) {
          const n = mvtVarint(buf, st), s0 = st.p;
          if (f === 2) spans.push(s0, s0 + n);
          else if (f === 3) keys.push(mvtStr(buf, s0, s0 + n));
          else if (f === 4) vals.push(mvtValue(buf, s0, s0 + n));
          st.p = s0 + n;
        } else if (w === 0) { const x = mvtVarint(buf, st); if (f === 5) extent = x; }
        else mvtSkip(buf, st, w);
      }
      const feats = [];
      for (let s = 0; s < spans.length; s += 2) {
        const fs = { p: spans[s] }, fe = spans[s + 1];
        let type = 0, tagsAt = null, geomAt = null;
        while (fs.p < fe) {
          const tag = mvtVarint(buf, fs), f = Math.floor(tag / 8), w = tag % 8;
          if (w === 2) { const n = mvtVarint(buf, fs); if (f === 2) tagsAt = [fs.p, fs.p + n]; else if (f === 4) geomAt = [fs.p, fs.p + n]; fs.p += n; }
          else if (w === 0) { const x = mvtVarint(buf, fs); if (f === 3) type = x; }
          else mvtSkip(buf, fs, w);
        }
        if (type !== 2 || !geomAt || !tagsAt) continue;        // 2 = LineString
        const props = {};
        const ts = { p: tagsAt[0] };
        while (ts.p < tagsAt[1]) { const k = mvtVarint(buf, ts), v = mvtVarint(buf, ts); props[keys[k]] = vals[v]; }
        const gs = { p: geomAt[0] };
        const lines = [];
        let cur = null, x = 0, y = 0;
        while (gs.p < geomAt[1]) {
          const cmd = mvtVarint(buf, gs), id = cmd % 8, count = Math.floor(cmd / 8);
          if (id === 1 || id === 2) {
            for (let c = 0; c < count; c++) {
              const zx = mvtVarint(buf, gs), zy = mvtVarint(buf, gs);
              x += (zx % 2) ? -(zx + 1) / 2 : zx / 2; y += (zy % 2) ? -(zy + 1) / 2 : zy / 2;
              if (id === 1) { cur = [[x, y]]; lines.push(cur); } else if (cur) cur.push([x, y]);
            }
          }
        }
        feats.push({ props: props, lines: lines });
      }
      return { name: name, extent: extent, feats: feats };
    }
    function decodeMVT(buf, want) {
      const out = {}, st = { p: 0 };
      while (st.p < buf.length) {
        const tag = mvtVarint(buf, st), f = Math.floor(tag / 8), w = tag % 8;
        if (f === 3 && w === 2) {
          const n = mvtVarint(buf, st), end = st.p + n;
          const L = mvtLayer(buf, st.p, end, want);
          if (L) out[L.name] = L;
          st.p = end;
        } else mvtSkip(buf, st, w);
      }
      return out;
    }

    // --- tile -> roads and rails ---
    const VEC_MAIN = { motorway: 1, trunk: 1, primary: 1, secondary: 1, tertiary: 1 };
    // node ids have to match where roads meet, and the tiles carry none: use the (rounded) position instead
    function vecNodeId(lat, lon) { return 1e15 + Math.round((lat + 90) * 1e5) * 4e7 + Math.round((lon + 180) * 1e5); }
    // keeps the parts of a line that lie inside the tile square (the tile files also carry a margin of the
    // neighbouring tiles, and that would put two cars on every road near a tile border)
    function clipLine(line, E) {
      const runs = [];
      let cur = null;
      for (let i = 1; i < line.length; i++) {
        const x0 = line[i - 1][0], y0 = line[i - 1][1], dx = line[i][0] - x0, dy = line[i][1] - y0;
        const p = [-dx, dx, -dy, dy], q = [x0, E - x0, y0, E - y0];
        let t0 = 0, t1 = 1, ok = true;
        for (let k = 0; k < 4 && ok; k++) {
          if (p[k] === 0) { if (q[k] < 0) ok = false; }
          else {
            const r = q[k] / p[k];
            if (p[k] < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; }
            else { if (r < t0) ok = false; else if (r < t1) t1 = r; }
          }
        }
        if (!ok || t0 > t1) { cur = null; continue; }
        if (!cur || t0 > 0) { cur = [[x0 + t0 * dx, y0 + t0 * dy]]; runs.push(cur); }
        cur.push([x0 + t1 * dx, y0 + t1 * dy]);
        if (t1 < 1) cur = null;
      }
      return runs;
    }
    // Tiles simplify straight stretches, which can remove the point where a side road joins. Put that point
    // back into the road it touches, so side roads still connect (cars can turn onto the through road).
    function snapJunctions(specs) {
      if (specs.length < 2) return;
      const lat0 = specs[0].pts[0][0], lon0 = specs[0].pts[0][1];
      const kx = 111320 * Math.cos(lat0 * D2R), ky = 110540, CELL = 40;
      const xs = [], ys = [];                       // local metres per point, computed once
      for (let wi = 0; wi < specs.length; wi++) {
        const pts = specs[wi].pts, ax = new Float64Array(pts.length), ay = new Float64Array(pts.length);
        for (let i = 0; i < pts.length; i++) { ax[i] = (pts[i][1] - lon0) * kx; ay[i] = (pts[i][0] - lat0) * ky; }
        xs.push(ax); ys.push(ay);
      }
      const grid = new Map();
      for (let wi = 0; wi < specs.length; wi++) {
        const ax = xs[wi], ay = ys[wi];
        for (let j = 0; j + 1 < ax.length; j++) {
          const c0 = Math.floor(Math.min(ax[j], ax[j + 1]) / CELL), c1 = Math.floor(Math.max(ax[j], ax[j + 1]) / CELL);
          const r0 = Math.floor(Math.min(ay[j], ay[j + 1]) / CELL), r1 = Math.floor(Math.max(ay[j], ay[j + 1]) / CELL);
          for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
            const k = cx * 200003 + cy; let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(wi, j);
          }
        }
      }
      const ins = new Map();
      for (let wi = 0; wi < specs.length; wi++) {
        const sp = specs[wi], last = sp.pts.length - 1;
        for (let ei = 0; ei < 2; ei++) {
          const e = ei ? last : 0, id = sp.nodes[e], px = xs[wi][e], py = ys[wi][e];
          const cx0 = Math.floor((px - 1.6) / CELL), cx1 = Math.floor((px + 1.6) / CELL);
          const cy0 = Math.floor((py - 1.6) / CELL), cy1 = Math.floor((py + 1.6) / CELL);
          for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
            const cell = grid.get(cx * 200003 + cy);
            if (!cell) continue;
            for (let c = 0; c < cell.length; c += 2) {
              const wj = cell[c], j = cell[c + 1];
              if (wj === wi) continue;
              const o = specs[wj];
              if (o.nodes[j] === id || o.nodes[j + 1] === id) continue;
              const sx = xs[wj][j], sy = ys[wj][j], ex = xs[wj][j + 1] - sx, ey = ys[wj][j + 1] - sy;
              const l2 = ex * ex + ey * ey;
              if (l2 < 0.01) continue;
              const t = ((px - sx) * ex + (py - sy) * ey) / l2;
              if (t <= 0.001 || t >= 0.999) continue;
              const dx = sx + t * ex - px, dy = sy + t * ey - py;
              if (dx * dx + dy * dy > 2.25) continue;           // within 1.5 m of the road
              let list = ins.get(wj); if (!list) { list = []; ins.set(wj, list); }
              let dup = false;
              for (let q = 0; q < list.length; q++) if (list[q].id === id) { dup = true; break; }
              if (!dup && o.nodes.indexOf(id) < 0) list.push({ j: j, t: t, pt: sp.pts[e], id: id });
            }
          }
        }
      }
      ins.forEach(function (list, wj) {
        list.sort(function (a, b) { return b.j - a.j || b.t - a.t; });
        const o = specs[wj];
        list.forEach(function (q) { o.pts.splice(q.j + 1, 0, q.pt); o.nodes.splice(q.j + 1, 0, q.id); });
      });
    }
    // decoded transportation layer -> { main: [...], local: [...], rail: [...] } road records (same shape the Overpass path makes)
    function vecToSpecs(layers, z, tx, ty) {
      const out = { main: [], local: [], rail: [] };
      const L = layers.transportation;
      if (!L) return out;
      const E = L.extent || 4096, n = Math.pow(2, z);
      const rnd = function (v) { return Math.round(v * 1e6) / 1e6; };
      for (let f = 0; f < L.feats.length; f++) {
        const pr = L.feats[f].props, c = pr.class, sub = pr.subclass, br = pr.brunnel;
        let grp = null, cls = null;
        if (VEC_MAIN[c]) { grp = 'main'; cls = c; }
        else if (c === 'minor') { grp = 'local'; cls = 'residential'; }
        else if (c === 'rail' || c === 'transit') {
          if (br === 'tunnel' || sub === 'funicular' || sub === 'monorail' || sub === 'magnetic_levitation') continue;
          if (pr.service && /^(yard|siding|spur|crossover)$/.test(pr.service)) continue;
          grp = 'rail'; cls = RAIL_SPEED[sub] ? sub : 'rail';
        } else continue;
        for (let li = 0; li < L.feats[f].lines.length; li++) {
          const runs = clipLine(L.feats[f].lines[li], E);
          for (let ri = 0; ri < runs.length; ri++) {
            const pts = [], nodes = [];
            for (let i = 0; i < runs[ri].length; i++) {
              const px = runs[ri][i][0], py = runs[ri][i][1];
              const lon = rnd((tx + px / E) / n * 360 - 180);
              const lat = rnd(Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + py / E) / n))) / D2R);
              const id = vecNodeId(lat, lon);
              if (nodes.length && nodes[nodes.length - 1] === id) continue;
              pts.push([lat, lon]); nodes.push(id);
            }
            if (pts.length < 2) continue;
            if (grp === 'rail') { out.rail.push({ kind: 'rail', cls: cls, pts: pts, nodes: nodes, oneway: false, lanes: 1, bridge: br === 'bridge', tunnel: false, ms: 0 }); continue; }
            let oneway = pr.oneway === 1 || pr.oneway === -1 || pr.ramp === 1 || cls === 'motorway';
            if (pr.oneway === -1) { pts.reverse(); nodes.reverse(); }
            const lanes = DEFAULT_LANES[cls] || 2;
            out[grp].push({ cls: cls, pts: pts, nodes: nodes, oneway: oneway, lanes: Math.max(1, Math.min(5, oneway ? lanes : Math.floor(lanes / 2))), bridge: br === 'bridge', tunnel: br === 'tunnel' });
          }
        }
      }
      snapJunctions(out.main.concat(out.local));
      return out;
    }
    // MVT-END

    // ---- fast tile loading and the fallback to Overpass ----
    const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
    const VEC = { state: 'init', tpl: null, z: 14, fails: 0, ok: 0, empty: 0, downUntil: 0, probing: false, note: '' };
    // state: init = looking up the tile address, ok = working, down = not working (Overpass is used instead)
    const vecData = new Map();      // 'z/x/y' -> { st: 'loading'|'done', rec, waiters, t }: one download feeds the main, local and rail tiles
    let vecWayId = 0;
    function useVec() { return cfg.source !== 'overpass' && VEC.state !== 'down'; }

    function httpGet(url, binary, timeout, ok, err) {
      const o = { method: 'GET', url: url, timeout: timeout, responseType: binary ? 'arraybuffer' : 'text',
        onload: function (res) { ok(res); }, onerror: function (e) { err(e); }, ontimeout: function () { err(new Error('timed out')); } };
      if (typeof GM_xmlhttpRequest === 'function') { transport = 'GM_xmlhttpRequest'; return GM_xmlhttpRequest(o); }
      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') { transport = 'GM.xmlHttpRequest'; return GM.xmlHttpRequest(o); }
      transport = 'plain fetch (no GM grant)';
      let done = false;
      const to = setTimeout(function () { if (!done) { done = true; err(new Error('timed out')); } }, timeout);
      fetch(url).then(function (r) {
        return (binary ? r.arrayBuffer() : r.text()).then(function (b) {
          if (done) return; done = true; clearTimeout(to);
          ok({ status: r.status, response: binary ? b : null, responseText: binary ? '' : b });
        });
      }).catch(function (e) { if (!done) { done = true; clearTimeout(to); err(e); } });
    }
    function vecDown(msg) {
      VEC.state = 'down'; VEC.note = msg; VEC.probing = false;
      VEC.downUntil = Date.now() + 10 * 60000;
      lastMsg = 'fast map tiles not available (' + msg + ') - using Overpass instead';
      console.warn('[GeoFS Living World] ' + lastMsg);
    }
    // finds the current tile address; probe = a quiet re-check while Overpass is in use
    function vecDiscover(probe) {
      if (VEC.probing) return;
      VEC.probing = true;
      httpGet(TILEJSON_URL, false, 8000, function (res) {
        try {
          if (res.status !== 200) throw new Error('HTTP ' + res.status);
          const tj = JSON.parse(res.responseText);
          const tpl = tj.tiles && tj.tiles[0];
          if (typeof tpl !== 'string' || tpl.indexOf('{z}') < 0 || tpl.indexOf('{x}') < 0 || tpl.indexOf('{y}') < 0) throw new Error('no tile address');
          VEC.tpl = tpl; VEC.z = Math.max(10, Math.min(14, +tj.maxzoom || 14));
          VEC.state = 'ok'; VEC.fails = 0; VEC.empty = 0; VEC.ok = 0; VEC.probing = false; VEC.note = '';
          lastMsg = 'fast map tiles ready';
        } catch (e) { if (probe) { VEC.probing = false; VEC.downUntil = Date.now() + 10 * 60000; } else vecDown('tile index: ' + e.message); }
      }, function (e) {
        if (probe) { VEC.probing = false; VEC.downUntil = Date.now() + 10 * 60000; } else vecDown('service not reachable');
      });
    }
    function vecTileUrl(z, x, y) { return VEC.tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y); }
    // tile square -> latitude / longitude of a point inside it (fx, fy = 0..1)
    function vecLL(z, x, y, fx, fy) {
      const n = Math.pow(2, z);
      return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + fy) / n))) / D2R, lon: (x + fx) / n * 360 - 180 };
    }
    function vecEnumerate(layer, r, p) {
      const z = VEC.z, n = Math.pow(2, z);
      const lat = Math.max(-84, Math.min(84, p.lat));
      const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * D2R));
      const xOf = function (lon) { return Math.floor((lon + 180) / 360 * n); };
      const yOf = function (la) { la = Math.max(-84, Math.min(84, la)); return Math.floor((1 - Math.log(Math.tan(la * D2R) + 1 / Math.cos(la * D2R)) / Math.PI) / 2 * n); };
      const x0 = xOf(p.lon - dLon), x1 = xOf(p.lon + dLon), y0 = yOf(lat + dLat), y1 = yOf(lat - dLat);
      const grp = layer.slice(1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const key = layer + ':' + z + '/' + x + ',' + y;
          if (tiles.has(key)) continue;
          const c = vecLL(z, x, y, 0.5, 0.5), top = vecLL(z, x, y, 0.5, 0), bot = vecLL(z, x, y, 0.5, 1);
          const size = Math.abs(top.lat - bot.lat);
          if (distM(p.lat, p.lon, c.lat, c.lon) > r + size * 111320 * 0.8) continue;
          tiles.set(key, { key: key, layer: layer, vec: true, grp: grp, z: z, vx: x, vy: y, size: size, c: c, state: 'queued', ways: [], retries: 0, net: false, combo: 0 });
        }
      }
    }
    function vecApply(t, rec) {
      if (tiles.get(t.key) !== t) return;
      addWays(t, rec[t.grp] || []);
      t.state = 'done';
      poolDirty = true;
    }
    function vecFlush(e) {
      const w = e.waiters; e.waiters = [];
      w.forEach(function (t) { if (tiles.get(t.key) === t && t.state === 'loading') vecApply(t, e.rec); });
    }
    function vecFailEntry(k, e, msg) {
      vecData.delete(k);
      VEC.fails++;
      lastMsg = 'fast tiles: ' + msg;
      e.waiters.forEach(function (t) {
        if (tiles.get(t.key) !== t) return;
        t.retries++; t.state = t.retries > 3 ? 'failed' : 'queued'; t.failedAt = Date.now();
      });
      e.waiters = [];
      if (VEC.fails >= 6) vecDown(msg);
    }
    function vecGunzip(u8) {
      return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    function vecFetch(k, e, t) {
      const url = vecTileUrl(t.z, t.vx, t.vy);
      reqHost = 'tiles.openfreemap.org';
      httpGet(url, true, 15000, function (res) {
        if (vecData.get(k) !== e) return;
        const status = res.status;
        if (status === 204 || status === 404) {                         // no data in this tile
          VEC.empty++;
          if (VEC.empty >= 6 && VEC.ok === 0) { vecData.delete(k); e.waiters = []; vecDown('the tile server returned no data'); return; }
          e.st = 'done'; e.rec = { main: [], local: [], rail: [] }; vecFlush(e); return;
        }
        if (status !== 200 || !res.response) { vecFailEntry(k, e, 'HTTP ' + status); return; }
        const finish = function (u8) {
          try {
            const rec = vecToSpecs(decodeMVT(u8, ['transportation']), t.z, t.vx, t.vy);
            VEC.ok++; VEC.fails = 0;
            cachePut('v' + k, rec);
            e.st = 'done'; e.rec = rec; e.t = Date.now();
            lastMsg = 'fast tiles OK (' + (rec.main.length + rec.local.length) + ' roads, ' + rec.rail.length + ' rails in a tile)';
            vecFlush(e);
          } catch (err) { vecFailEntry(k, e, 'could not read a tile: ' + err.message); }
        };
        try {
          let u8 = new Uint8Array(res.response);
          if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) {         // still gzip-compressed
            if (typeof DecompressionStream !== 'function') { vecFailEntry(k, e, 'browser cannot unzip tiles'); return; }
            vecGunzip(u8).then(finish, function (err) { vecFailEntry(k, e, 'unzip failed'); });
          } else if (u8.length === 0) { VEC.empty++; e.st = 'done'; e.rec = { main: [], local: [], rail: [] }; vecFlush(e); }
          else finish(u8);
        } catch (err) { vecFailEntry(k, e, 'bad tile data'); }
      }, function (err) { if (vecData.get(k) === e) vecFailEntry(k, e, 'network error'); });
    }
    function vecStart(t) {
      const k = t.z + '/' + t.vx + '/' + t.vy;
      t.state = 'loading'; t.startedAt = Date.now();
      const e0 = vecData.get(k);
      if (e0) { if (e0.st === 'loading') e0.waiters.push(t); else vecApply(t, e0.rec); return; }
      const e = { st: 'loading', rec: null, waiters: [t], t: Date.now() };
      vecData.set(k, e);
      cacheGet('v' + k, function (rec) {
        if (vecData.get(k) !== e) return;
        if (rec) { cacheHits++; e.st = 'done'; e.rec = rec; e.t = Date.now(); vecFlush(e); return; }
        vecFetch(k, e, t);
      });
    }
    function vecPump() {
      if (!idbReady || !useVec() || !VEC.tpl) return;
      const now = Date.now();
      let active = 0;
      vecData.forEach(function (e, k) {
        if (e.st !== 'loading') { if (now - e.t > 180000) vecData.delete(k); return; }
        if (now - e.t > 40000) { vecFailEntry(k, e, 'tile request hung'); return; }
        active++;
      });
      const p = playerPos();
      for (let guard = 0; guard < 12 && active < 4; guard++) {
        let best = null, bestD = Infinity;
        tiles.forEach(function (t, key) {
          if (!t.vec || t.state !== 'queued') return;
          const d = distM(p.lat, p.lon, t.c.lat, t.c.lon);
          if (d > layerRadiusM(t.layer) + t.size * 111320 * 1.5) { tiles.delete(key); return; }
          if (d < bestD) { bestD = d; best = t; }
        });
        if (!best) break;
        const before = vecData.size;
        vecStart(best);
        if (vecData.size > before) active++;
      }
    }
    // switching between fast tiles and Overpass: remove what the other source loaded so nothing is doubled
    let lastVecActive = null;
    function applySource() {
      const v = useVec();
      if (lastVecActive === null) { lastVecActive = v; }
      else if (v !== lastVecActive) {
        lastVecActive = v;
        const dead = new Set();
        tiles.forEach(function (t, key) { if (t.layer !== 'water' && (!!t.vec) !== v) dead.add(key); });
        removeTiles(dead);
      }
      if (cfg.source !== 'overpass') {
        if (VEC.state === 'init' && !VEC.tpl) vecDiscover(false);
        else if (VEC.state === 'down' && Date.now() > VEC.downUntil) vecDiscover(true);
      }
    }

    function addWays(t, specs) {
      for (let k = 0; k < specs.length; k++) {
        const sp = specs[k];
        if (JUMP.tile === null) JUMP.tile = Date.now() - JUMP.t0;
        const wid = sp.id != null ? sp.id : -(++vecWayId);      // tile roads have no OpenStreetMap id: number them
        if (wayOwner.has(wid)) continue;
        const cum = [0];
        let len = 0;
        for (let i = 1; i < sp.pts.length; i++) { len += distM(sp.pts[i - 1][0], sp.pts[i - 1][1], sp.pts[i][0], sp.pts[i][1]); cum.push(len); }
        if (len < 15) continue;
        const way = { id: wid, kind: sp.kind || 'road', ms: sp.ms || 0, cls: sp.cls, pts: sp.pts, nodes: sp.nodes, len: len, oneway: sp.oneway, lanes: sp.lanes, cum: cum, bridge: !!sp.bridge, tunnel: !!sp.tunnel, hs: !!sp.hs, tile: t.key };
        wayOwner.set(wid, t.key);
        t.ways.push(way);
        if (terrainOK) { if (!t.dq) t.dq = []; t.dq.push(way); }      // ground height gets measured nearest tile first
        for (let i = 0; i < sp.nodes.length; i++) {
          let a = nodeIndex.get(sp.nodes[i]);
          if (!a) { a = []; nodeIndex.set(sp.nodes[i], a); }
          a.push({ way: way, i: i });
        }
      }
    }

    function evictTiles() {
      const p = playerPos();
      const limit = cfg.radiusKm * 1000 * 2.2 + 5000;
      const dead = [];
      tiles.forEach(function (t, key) {
        const c = tileCenter(t);
        if (t.state !== 'loading' && distM(p.lat, p.lon, c.lat, c.lon) > limit) dead.push(key);
      });
      if (dead.length) removeTiles(new Set(dead));
    }
    function removeTiles(deadSet) {
      if (!deadSet.size) return;
      deadSet.forEach(function (key) {
        const t = tiles.get(key);
        if (!t) return;
        t.ways.forEach(function (w) { wayOwner.delete(w.id); });
        tiles.delete(key);
      });
      nodeIndex.forEach(function (arr, id) {
        const f = arr.filter(function (e) { return !deadSet.has(e.way.tile); });
        if (f.length) nodeIndex.set(id, f); else nodeIndex.delete(id);
      });
      for (let k = cars.length - 1; k >= 0; k--) if (deadSet.has(cars[k].way.tile)) removeCar(k);
      poolDirty = true;
    }

    // spawn pools per kind: PK.road / PK.rail / PK.boat = { pool: [{way, cum}], total, tw: tile key -> weight }
    const PK = { road: { pool: [], total: 0, tw: {} }, rail: { pool: [], total: 0, tw: {} }, boat: { pool: [], total: 0, tw: {} } };
    const kindCount = { road: 0, rail: 0, boat: 0 };   // live heads of each kind (a train counts once, not per car)
    // When the car cap is reached, early tiles hold every car and late tiles get none. This removes
    // cars from tiles that hold more than their fair share so the spawner refills the others.
    function rebalance() {
      const P = PK.road;
      if (!P.total || kindCount.road < cfg.maxCars * 0.95) return;
      const count = {};
      for (let k = 0; k < cars.length; k++) { if (cars[k].kind !== 'road') continue; const key = cars[k].way.tile; count[key] = (count[key] || 0) + 1; }
      const excess = {};
      Object.keys(count).forEach(function (key) {
        const fair = cfg.maxCars * (P.tw[key] || 0) / P.total;
        const over = Math.floor(count[key] - (fair * 1.25 + 3));
        if (over > 0) excess[key] = over;
      });
      let budget = 60;
      for (let k = cars.length - 1; k >= 0 && budget > 0; k--) {
        if (cars[k].kind !== 'road') continue;
        const key = cars[k].way.tile;
        if (excess[key] > 0) { excess[key]--; removeCar(k); budget--; }
      }
    }

    let lastPoolBuild = 0;
    function rebuildPool() {
      const p = playerPos();
      const r = cfg.radiusKm * 1000 * 0.95;
      Object.keys(PK).forEach(function (k) { PK[k] = { pool: [], total: 0, tw: {} }; });
      lastPoolBuild = Date.now();
      tiles.forEach(function (t) {
        for (let k = 0; k < t.ways.length; k++) {
          const w = t.ways[k];
          const m = w.pts[w.pts.length >> 1];
          const dm = distM(p.lat, p.lon, m[0], m[1]);
          if (dm > r) continue;
          if (terrainOK && !w.th && !w.tunnel && dm > 3000) continue;   // far away and not measured yet: it would stay invisible
          const P = PK[w.kind];
          // ways near you get more traffic (about 3x at your feet, fading with distance)
          const wt = (ROAD_WEIGHT[w.cls] || KIND_WEIGHT[w.cls] || 1) * Math.min(w.len, 2000) * (1 + 2 / (1 + dm / 3000)) * (w.tunnel ? 0.2 : 1);   // tunnels hide their cars
          P.total += wt;
          P.pool.push({ way: w, cum: P.total });
          P.tw[w.tile] = (P.tw[w.tile] || 0) + wt;
        }
      });
      poolDirty = false;
    }

    function pickWay(kind) {
      const P = PK[kind || 'road'];
      if (!P.pool.length) return null;
      const x = Math.random() * P.total;
      let lo = 0, hi = P.pool.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (P.pool[mid].cum < x) lo = mid + 1; else hi = mid; }
      return P.pool[lo].way;
    }

    /* ---------------------------------------------------------------- *
     *  CARS
     * ---------------------------------------------------------------- */
    const cars = [];
    let carId = 0;
    const lightPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    const COL_HEAD = Cesium.Color.fromCssColorString('#fff3c4');
    const COL_TAIL = Cesium.Color.fromCssColorString('#ff2a2a');
    const SCALE_LIGHT = new Cesium.NearFarScalar(150, 2.2, 25000, 0.8);
    const SCALE_BODY = new Cesium.NearFarScalar(300, 2.0, 9000, 0.9);
    const scratchA = new Cesium.Cartesian3();
    const scratchB = new Cesium.Cartesian3();
    const scratchC = new Cesium.Cartesian3();
    // ---- Vehicle types: each is built from simple boxes (no interiors, no logos) ----
    // Axes: +x = forward, y = left, z = up, origin on the ground at the vehicle's middle.
    // Colour kinds: p paint, g glass, t tyre, l light grey (cargo), d dark grey, h headlight, r taillight, s hubcap
    // lod: 'f' = only in the full-detail model, 'm' = only in the simplified model (about the look you
    // see from 30,000 ft), undefined = in both. pitch = tilt in radians (for sloped windscreens).
    const KIND_COLOR = {};
    const KIND_CSS = { g: '#1c2430', t: '#101010', l: '#d9dce1', d: '#3a3f46', h: '#fff6d0', r: '#b01616', s: '#aeb4bc', k: '#eef6fb', m: '#b9bec6', o: '#e8731a',
      x1: '#a3262a', x2: '#2a5aa0', x3: '#d8a21c', x4: '#2f7d4f', x5: '#c9ccd1', x6: '#c96a1b', x7: '#0b2a5b' };
    Object.keys(KIND_CSS).forEach(function (k) { KIND_COLOR[k] = Cesium.Color.fromCssColorString(KIND_CSS[k]); });
    function part(id, l, w, h, x, y, z, k, lod, pitch) {
      return { id: id, d: [l, w, h], at: [x, y, z], k: k, lod: lod, pitch: pitch || 0 };
    }
    // tyres on both sides of every axle, plus hubcaps in the full model
    function wheelSet(size, wt, xs, W) {
      const out = [];
      xs.forEach(function (x, i) {
        [1, -1].forEach(function (s) {
          const y = s * (W / 2 - wt / 2 + 0.03), n = 'w' + i + (s > 0 ? 'a' : 'b');
          out.push(part(n, size, wt, size, x, y, size / 2, 't'));
          out.push(part(n + 'h', size * 0.55, wt + 0.05, size * 0.55, x, y, size / 2, 's', 'f'));
        });
      });
      return out;
    }
    function lamps(xf, xr, W, z, zr) {
      const out = [];
      [1, -1].forEach(function (s) {
        out.push(part('hl' + s, 0.1, 0.4, 0.14, xf + 0.01, s * (W / 2 - 0.35), z, 'h', 'f'));
        out.push(part('tl' + s, 0.1, 0.4, 0.14, xr - 0.01, s * (W / 2 - 0.35), zr === undefined ? z : zr, 'r', 'f'));
      });
      return out;
    }

    // Passenger vehicles come from one generator. cl/ch/cx = cabin length/height/centre,
    // rake/tail = how far the windscreen / rear glass lean (degrees), bz/bh = body bottom/height.
    function makeCar(p) {
      const z0 = p.bz + p.bh;
      const xf = p.cx + p.cl / 2, xr = p.cx - p.cl / 2;
      const tr = Math.tan(p.rake * D2R), tt = Math.tan(p.tail * D2R);
      const rf = xf - p.ch * tr, rr = xr + p.ch * tt;
      const gw = p.W - 0.3;
      let out = [
        part('body', p.L, p.W, p.bh, 0, 0, p.bz + p.bh / 2, 'p'),
        part('bf', 0.22, p.W - 0.1, 0.32, p.L / 2 - 0.08, 0, p.bz + 0.2, 'd', 'f'),
        part('br', 0.22, p.W - 0.1, 0.32, -p.L / 2 + 0.08, 0, p.bz + 0.2, 'd', 'f')
      ];
      out = out.concat(lamps(p.L / 2, -p.L / 2, p.W, z0 - 0.22));
      [1, -1].forEach(function (s) { out.push(part('mir' + s, 0.12, 0.2, 0.1, xf - 0.1, s * (p.W / 2 + 0.08), z0 + 0.12, 'p', 'f')); });
      // finest detail (High setting only): number plates, grille, door handles, exhaust
      out.push(part('plF', 0.04, 0.5, 0.12, p.L / 2 + 0.01, 0, p.bz + 0.22, 'l', 'e'));
      out.push(part('plR', 0.04, 0.5, 0.12, -p.L / 2 - 0.01, 0, p.bz + 0.22, 'l', 'e'));
      out.push(part('grl', 0.05, p.W * 0.5, 0.14, p.L / 2 + 0.01, 0, p.bz + 0.4, 'd', 'e'));
      [1, -1].forEach(function (s) { out.push(part('dh' + s, 0.22, 0.03, 0.04, p.cx, s * (p.W / 2 + 0.01), p.bz + p.bh * 0.85, 'd', 'e')); });
      out.push(part('exh', 0.12, 0.1, 0.1, -p.L / 2 - 0.04, p.W * 0.3, p.bz + 0.1, 'd', 'e'));
      if (p.open) {
        out.push(part('cockpit', p.cl, p.W - 0.4, 0.05, p.cx, 0, z0 + 0.01, 'd'));
        out.push(part('ws', 0.06, gw, p.ch / Math.cos(p.rake * D2R), xf - p.ch * tr / 2, 0, z0 + p.ch / 2, 'g', undefined, -p.rake * D2R));
      } else {
        // full model: sloped windscreen and rear glass, side windows, roof
        out.push(part('ws', 0.06, gw, p.ch / Math.cos(p.rake * D2R), xf - p.ch * tr / 2, 0, z0 + p.ch / 2, 'g', 'f', -p.rake * D2R));
        out.push(part('rw', 0.06, gw, p.ch / Math.cos(p.tail * D2R), xr + p.ch * tt / 2, 0, z0 + p.ch / 2, 'g', 'f', p.tail * D2R));
        out.push(part('roof', rf - rr, gw, 0.07, (rf + rr) / 2, 0, z0 + p.ch - 0.035, 'p', 'f'));
        const sl = (xf - xr) - p.ch * (tr + tt) / 2, sx = (xf + xr) / 2 - p.ch * (tr - tt) / 4;
        [1, -1].forEach(function (s) { out.push(part('sg' + s, sl, 0.05, p.ch - 0.1, sx, s * (gw / 2 + 0.02), z0 + p.ch / 2, 'g', 'f')); });
        // simplified model: one dark cabin block with a roof
        out.push(part('cab', p.cl, gw + 0.04, p.ch, p.cx, 0, z0 + p.ch / 2, 'g', 'm'));
        out.push(part('cabroof', p.cl - 0.2, gw, 0.07, p.cx, 0, z0 + p.ch - 0.035, 'p', 'm'));
      }
      if (p.bed) {
        const b = p.bed;
        out.push(part('bedfloor', b.len, p.W - 0.3, 0.06, b.x, 0, z0 + 0.03, 'd'));
        [1, -1].forEach(function (s) { out.push(part('bw' + s, b.len, 0.08, 0.38, b.x, s * (p.W / 2 - 0.06), z0 + 0.19, 'p')); });
        out.push(part('gate', 0.08, p.W - 0.1, 0.38, b.x - b.len / 2 + 0.04, 0, z0 + 0.19, 'p'));
        out.push(part('headboard', 0.08, p.W - 0.2, 0.45, b.x + b.len / 2 - 0.04, 0, z0 + 0.22, 'p'));
      }
      if (p.wing) {      // rear wing on two struts (supercars)
        out.push(part('wing', p.wing.l, p.W - 0.1, 0.05, xr + 0.05, 0, z0 + p.wing.h, 'p'));
        [1, -1].forEach(function (s) { out.push(part('wst' + s, 0.08, 0.06, p.wing.h, xr + 0.1, s * 0.5, z0 + p.wing.h / 2, 'd', 'f')); });
      }
      if (p.split) out.push(part('split', 0.45, p.W - 0.05, 0.05, p.L / 2 + 0.08, 0, p.bz + 0.04, 'd'));
      if (p.stripe) { out.push(part('rs1', p.L * 0.28, 0.3, 0.025, p.L * 0.26, 0, z0 + 0.012, 'a')); out.push(part('rs2', p.L * 0.2, 0.3, 0.025, -p.L * 0.34, 0, z0 + 0.012, 'a')); }
      if (p.cline) [1, -1].forEach(function (s) { out.push(part('cl' + s, p.L * 0.2, 0.04, 0.22, p.cx - 0.1, s * (p.W / 2 + 0.01), p.bz + 0.38, 'a')); });
      if (p.quad) out.push(part('qex', 0.1, 0.5, 0.18, -p.L / 2 - 0.03, 0, p.bz + 0.2, 'd', 'e'));
      if (p.intake) [1, -1].forEach(function (s) { out.push(part('int' + s, p.L * 0.18, 0.05, 0.28, p.cx - p.L * 0.12, s * (p.W / 2 + 0.01), p.bz + 0.4, 'd')); });
      return out.concat(wheelSet(p.wr, p.wt, p.wx, p.W));
    }

    // most real cars are white, black, grey / silver, red or blue; the odd colour is mixed in
    const PAL_CAR = ['#f2f2f2', '#f2f2f2', '#f2f2f2', '#f2f2f2', '#f2f2f2', '#1b1b1b', '#1b1b1b', '#1b1b1b', '#1b1b1b', '#1b1b1b',
      '#9aa0a6', '#9aa0a6', '#9aa0a6', '#c8ccd2', '#c8ccd2', '#b3202a', '#b3202a', '#1f4e9c', '#1f4e9c',
      '#2e6b3a', '#d9b43c', '#6b4b2a', '#7a1f5c'];
    const PAL_SPORT = ['#d62828', '#f77f00', '#fcbf49', '#1f4e9c', '#f2f2f2', '#2a9d8f'];
    const PAL_WORK = ['#f2f2f2', '#f2f2f2', '#f2f2f2', '#f2f2f2', '#e0e3e8', '#e0e3e8', '#9aa0a6', '#9aa0a6', '#1b1b1b', '#1f4e9c', '#b3202a', '#2e6b3a'];
    const PAL_BUS = ['#f2c200', '#e8e8e8', '#2b5aa8', '#c8c8c8'];

    // L/W/H = overall size in metres (used for the far-away rectangle), cx = middle offset,
    // w = how common, heavy = mostly on big roads, spd = speed factor
    const TYPES = [
      { name: 'sedan', L: 4.6, W: 1.85, H: 1.52, cx: 0, w: 30, heavy: false, spd: 1.0, pal: PAL_CAR,
        parts: makeCar({ L: 4.6, W: 1.85, bz: 0.2, bh: 0.7, cl: 2.6, ch: 0.62, cx: -0.25, rake: 40, tail: 45, wr: 0.7, wt: 0.28, wx: [1.4, -1.4] }) },
      { name: 'hatch', L: 3.6, W: 1.7, H: 1.54, cx: 0, w: 14, heavy: false, spd: 0.95, pal: PAL_CAR,
        parts: makeCar({ L: 3.6, W: 1.7, bz: 0.2, bh: 0.68, cl: 2.3, ch: 0.66, cx: -0.15, rake: 40, tail: 25, wr: 0.6, wt: 0.26, wx: [1.1, -1.1] }) },
      { name: 'suv', L: 4.8, W: 1.95, H: 1.88, cx: 0, w: 24, heavy: false, spd: 1.0, pal: PAL_CAR,
        parts: makeCar({ L: 4.8, W: 1.95, bz: 0.3, bh: 0.9, cl: 3.2, ch: 0.68, cx: -0.3, rake: 38, tail: 8, wr: 0.85, wt: 0.3, wx: [1.5, -1.5] }) },
      { name: 'pickup', L: 5.4, W: 2.0, H: 1.8, cx: 0, w: 10, heavy: false, spd: 1.0, pal: PAL_WORK,
        parts: makeCar({ L: 5.4, W: 2.0, bz: 0.32, bh: 0.8, cl: 1.9, ch: 0.68, cx: 0.75, rake: 35, tail: 5, wr: 0.9, wt: 0.32, wx: [1.8, -1.8],
                         bed: { len: 2.5, x: -1.5 } }) },
      { name: 'convertible', L: 4.3, W: 1.8, H: 1.22, cx: 0, w: 3, heavy: false, spd: 1.05, pal: PAL_SPORT,
        parts: makeCar({ L: 4.3, W: 1.8, bz: 0.2, bh: 0.62, cl: 1.9, ch: 0.4, cx: 0.1, rake: 50, tail: 0, open: true, wr: 0.66, wt: 0.27, wx: [1.35, -1.35] }) },
      { name: 'van', L: 5.0, W: 1.95, H: 1.85, cx: 0, w: 6, heavy: false, spd: 0.95, pal: PAL_WORK,
        parts: makeCar({ L: 5.0, W: 1.95, bz: 0.3, bh: 1.0, cl: 4.4, ch: 0.55, cx: -0.1, rake: 20, tail: 0, wr: 0.8, wt: 0.3, wx: [1.6, -1.6] }) },
      { name: 'boxtruck', L: 8.2, W: 2.4, H: 2.85, cx: 0.4, w: 4, heavy: true, spd: 0.9, pal: PAL_WORK,
        parts: [].concat([
          part('chassis', 8.2, 1.8, 0.3, 0.4, 0, 0.5, 'd', 'f'),
          part('cab', 2.0, 2.3, 2.1, 3.3, 0, 1.3, 'p'),
          part('ws', 0.1, 2.0, 0.9, 4.3, 0, 1.85, 'g'),
          part('sw', 1.0, 2.34, 0.7, 3.2, 0, 1.9, 'g'),
          part('cargo', 5.8, 2.4, 2.6, -0.4, 0, 1.55, 'l'),
          part('bumper', 0.25, 2.3, 0.35, 4.4, 0, 0.5, 'd', 'f'),
          part('mir1', 0.15, 0.25, 0.4, 4.2, 1.3, 2.0, 'd', 'f'), part('mir2', 0.15, 0.25, 0.4, 4.2, -1.3, 2.0, 'd', 'f')
        ], lamps(4.3, -3.3, 2.4, 0.9, 0.75), wheelSet(1.0, 0.4, [3.3, -1.8, -3.0], 2.4)) },
      { name: 'bus', L: 11.1, W: 2.55, H: 2.95, cx: 0, w: 2, heavy: true, spd: 0.85, pal: PAL_BUS,
        parts: [].concat([
          part('body', 11.0, 2.5, 2.6, 0, 0, 1.6, 'p'),
          part('win', 9.6, 2.54, 0.8, -0.2, 0, 2.2, 'g'),
          part('ws', 0.1, 2.2, 1.0, 5.52, 0, 2.2, 'g', 'f'),
          part('rwin', 0.1, 2.2, 0.8, -5.52, 0, 2.2, 'g', 'f'),
          part('ac', 2.5, 1.6, 0.25, -1, 0, 3.02, 'l', 'f'),
          part('bf', 0.2, 2.4, 0.4, 5.55, 0, 0.5, 'd', 'f'), part('br', 0.2, 2.4, 0.4, -5.55, 0, 0.5, 'd', 'f')
        ], lamps(5.5, -5.5, 2.5, 0.9), wheelSet(1.0, 0.35, [3.6, -3.4], 2.5)) },
      { name: 'semi', L: 15.3, W: 2.6, H: 4.0, cx: -0.3, w: 5, heavy: true, spd: 0.9, pal: PAL_WORK,
        parts: [].concat([
          part('chassis', 15, 1.8, 0.3, -0.6, 0, 0.7, 'd', 'f'),
          part('cab', 2.2, 2.5, 3.0, 6.0, 0, 2.0, 'p'),
          part('ws', 0.1, 2.2, 1.0, 7.12, 0, 2.9, 'g'),
          part('sw', 1.0, 2.54, 0.9, 6.0, 0, 2.9, 'g'),
          part('tr', 12.5, 2.5, 3.2, -1.5, 0, 2.4, 'l'),
          part('bumper', 0.25, 2.4, 0.4, 7.2, 0, 0.6, 'd', 'f'),
          part('stack1', 0.12, 0.12, 1.3, 4.9, 1.0, 3.9, 'd', 'f'), part('stack2', 0.12, 0.12, 1.3, 4.9, -1.0, 3.9, 'd', 'f')
        ], lamps(7.1, -7.75, 2.5, 1.0, 1.1), wheelSet(1.0, 0.4, [6.0, 3.4, 2.2, -5.8, -7.0], 2.5)) }
    ];
    // big vehicles mostly stick to big roads
    const HEAVY_MULT = { motorway: 1, trunk: 1, primary: 0.7, secondary: 0.4, tertiary: 0.2, unclassified: 0.05, residential: 0.03 };
    function pickType(cls) {
      const hm = HEAVY_MULT[cls] === undefined ? 0.1 : HEAVY_MULT[cls];
      let total = 0;
      for (let i = 0; i < TYPES.length; i++) total += TYPES[i].w * (TYPES[i].heavy ? hm : 1);
      let x = Math.random() * total;
      for (let i = 0; i < TYPES.length; i++) {
        x -= TYPES[i].w * (TYPES[i].heavy ? hm : 1);
        if (x <= 0) return TYPES[i];
      }
      return TYPES[0];
    }

    // ---- Trains and boats: simple boxes, but with real detail (windows, bogies, stripes, containers, funnels...) ----
    // Extra colour kinds: a = this vehicle's accent colour (stripes), m = light metal, o = orange, x1..x6 = container colours
    const UNIT = {};      // rail unit types by name (locomotives, coaches, wagons, trams)
    const SHIP = {};      // boat types by name
    const bogie = function (id, x, W) {
      const out = [part(id + 'f', 3.0, W - 1.0, 0.45, x, 0, 0.62, 'd', 'f')];
      [-1, 1].forEach(function (sx) { [1, -1].forEach(function (sy) { out.push(part(id + 'w' + sx + sy, 0.95, 0.22, 0.95, x + sx * 1.0, sy * 0.72, 0.48, 't', 'f')); }); });
      return out;
    };
    const pantograph = function (x, z) {
      return [part('pgb', 1.8, 1.1, 0.22, x, 0, z + 0.11, 'd', 'f'),
        part('pga', 2.0, 0.08, 0.08, x - 0.2, 0, z + 0.7, 'm', 'f', 0.6),
        part('pgt', 1.5, 1.4, 0.06, x + 0.5, 0, z + 1.2, 'm', 'f')];
    };
    // passenger car: individual windows between pillars, doors, side stripe, roof units, bogies
    function railcar(p) {
      const L = p.L, W = p.W, bh = p.H - 1.45, z0 = 0.95;
      const out = [
        part('body', L, W, bh, 0, 0, z0 + bh / 2, 'p'),
        part('stripe', L + 0.04, W + 0.05, 0.42, 0, 0, z0 + 0.55, 'a'),
        part('under', L - 3, W - 0.8, 0.7, 0, 0, 0.62, 'd'),
        part('roof', L - 0.5, W - 0.55, 0.32, 0, 0, z0 + bh + 0.16, 'm'),
        part('win', L - 2.6, W + 0.04, 0.95, 0, 0, z0 + 1.75, 'g', 'm')          // one strip for the simplified model
      ];
      const nw = Math.max(3, Math.floor((L - 4.6) / 2.45));
      for (let i = 0; i < nw; i++) out.push(part('w' + i, 1.55, W + 0.04, 0.95, -((nw - 1) * 2.45) / 2 + i * 2.45, 0, z0 + 1.75, 'g', 'f'));
      [1, -1].forEach(function (s) {
        out.push(part('door' + s, 1.2, W + 0.05, 2.05, s * (L / 2 - 2.0), 0, z0 + 1.1, 'd', 'f'));
        out.push(part('gw' + s, 0.25, W - 0.5, bh - 0.4, s * (L / 2 + 0.1), 0, z0 + bh / 2, 'd', 'f'));
      });
      if (!p.noac) { out.push(part('ac1', 3.0, 1.5, 0.38, -L * 0.25, 0, z0 + bh + 0.5, 'l', 'f')); out.push(part('ac2', 3.0, 1.5, 0.38, L * 0.25, 0, z0 + bh + 0.5, 'l', 'f')); }
      if (p.pan) pantograph(0, z0 + bh + 0.32).forEach(function (q) { out.push(q); });
      out.push.apply(out, bogie('b1', L * 0.34, W)); out.push.apply(out, bogie('b2', -L * 0.34, W));
      if (p.front) {      // sloped cab windscreen, nose, headlamps
        out.push(part('nose', 1.6, W - 0.5, bh * 0.75, L / 2 - 0.5, 0, z0 + bh * 0.38, 'p', 'f'));
        out.push(part('ws', 1.4, W - 0.9, bh * 0.45, L / 2 - 0.2, 0, z0 + bh * 0.66, 'g', null, 0.45));
        [1, -1].forEach(function (s) { out.push(part('hl' + s, 0.14, 0.45, 0.28, L / 2 + 0.1, s * (W / 2 - 0.75), z0 + 0.5, 'h', 'f')); });
        out.push(part('hlt', 0.14, 0.5, 0.3, L / 2 + 0.1, 0, z0 + bh - 0.3, 'h', 'f'));
      }
      if (p.rear) [1, -1].forEach(function (s) { out.push(part('tl' + s, 0.14, 0.45, 0.28, -L / 2 - 0.1, s * (W / 2 - 0.75), z0 + 0.5, 'r', 'f')); });
      return out;
    }
    // 'e' parts only show on the High detail setting: the tiny stuff (wheels, ladders, rails, vents, pantographs, ...)
    function tierFine(parts) {
      const fine = /^(ac|vent|pg|ld|rail|step|gw|stack|tank|dome|walk|cap|band|rib|drail|dl|hlt|funt|radar|mast)/;
      parts.forEach(function (q) {
        if (q.lod !== 'f' || q.k === 'h' || q.k === 'r') return;
        if (q.d[0] * q.d[1] * q.d[2] < 1.2 || fine.test(q.id) || /^b\dw/.test(q.id)) q.lod = 'e';
      });
      return parts;
    }
    function unit(name, L, W, H, lit, parts) {
      tierFine(parts);
      UNIT[name] = { name: name, L: L, W: W, H: H, cx: 0, w: 0, heavy: false, spd: 1, pal: ['#e8e8ea'], lit: lit, acc: 0.7, dec: 3, parts: parts };
    }
    // diesel locomotive: long hood, raised cab, stripe, roof vents, steps, ditch lights
    (function () {
      const o = [
        part('frame', 20, 2.9, 0.85, 0, 0, 1.25, 'd'),
        part('hood', 13.2, 2.9, 2.3, 3.4, 0, 1.65 + 1.15, 'p'),
        part('hstripe', 13.3, 2.96, 0.45, 3.4, 0, 2.05, 'a'),
        part('cab', 6.2, 3.0, 3.0, -6.9, 0, 1.65 + 1.5, 'p'),
        part('cabroof', 6.4, 2.8, 0.25, -6.9, 0, 4.78, 'm'),
        part('cabwin', 6.25, 3.04, 0.85, -6.9, 0, 3.75, 'g', 'm'),
        part('cabws', 0.12, 2.5, 0.95, -3.76, 0, 3.75, 'g'),
        part('cabstripe', 6.25, 3.06, 0.4, -6.9, 0, 2.2, 'a'),
        part('nose', 1.4, 2.9, 1.6, 10.3, 0, 2.2, 'p', null, 0.0),
        part('vent1', 2.2, 1.7, 0.55, 0.0, 0, 4.1, 'm', 'f'), part('vent2', 2.2, 1.7, 0.55, 3.6, 0, 4.1, 'm', 'f'), part('vent3', 2.2, 1.7, 0.55, 7.2, 0, 4.1, 'm', 'f'),
        part('stack', 0.55, 0.55, 0.7, -2.4, 0, 4.2, 'd', 'f'),
        part('tank', 6.5, 2.6, 0.9, 0, 0, 0.6, 'd', 'f'),
        part('hl1', 0.14, 0.45, 0.3, 11.05, 0.8, 2.75, 'h', 'f'), part('hl2', 0.14, 0.45, 0.3, 11.05, -0.8, 2.75, 'h', 'f'),
        part('dl1', 0.14, 0.3, 0.25, 11.05, 1.25, 1.35, 'h', 'f'), part('dl2', 0.14, 0.3, 0.25, 11.05, -1.25, 1.35, 'h', 'f'),
        part('step1', 0.6, 0.5, 0.9, 9.8, 1.55, 0.95, 'd', 'f'), part('step2', 0.6, 0.5, 0.9, 9.8, -1.55, 0.95, 'd', 'f'),
        part('rail1', 12, 0.07, 0.07, 4, 1.52, 2.0, 'm', 'f'), part('rail2', 12, 0.07, 0.07, 4, -1.52, 2.0, 'm', 'f')
      ];
      o.push.apply(o, bogie('b1', 6.4, 3.0)); o.push.apply(o, bogie('b2', -6.4, 3.0));
      unit('loco', 20.6, 3.0, 4.9, 'front', o);
    })();
    unit('coach', 24, 3.0, 4.1, 'none', railcar({ L: 24, W: 3.0, H: 4.1 }));
    unit('coachEnd', 24, 3.0, 4.1, 'rear', railcar({ L: 24, W: 3.0, H: 4.1, rear: true }));
    unit('emuHead', 24, 3.0, 4.1, 'front', railcar({ L: 24, W: 3.0, H: 4.1, front: true, pan: true, noac: true }));
    unit('emuTail', 24, 3.0, 4.1, 'rear', railcar({ L: 24, W: 3.0, H: 4.1, rear: true, pan: true, noac: true }));
    unit('emu', 24, 3.0, 4.1, 'none', railcar({ L: 24, W: 3.0, H: 4.1 }));
    unit('metroHead', 18, 2.9, 3.7, 'front', railcar({ L: 18, W: 2.9, H: 3.7, front: true, noac: true }));
    unit('metroTail', 18, 2.9, 3.7, 'rear', railcar({ L: 18, W: 2.9, H: 3.7, rear: true, noac: true }));
    unit('metro', 18, 2.9, 3.7, 'none', railcar({ L: 18, W: 2.9, H: 3.7, noac: true }));
    (function () {      // tram: low floor, big windows, articulation, headlamps both ends
      const L = 28, W = 2.45, o = [
        part('body', L, W, 2.35, 0, 0, 0.55 + 1.18, 'p'),
        part('skirt', L + 0.04, W + 0.05, 0.5, 0, 0, 0.82, 'a'),
        part('win', L - 1.6, W + 0.04, 1.05, 0, 0, 2.05, 'g'),
        part('roof', L - 0.6, W - 0.5, 0.3, 0, 0, 3.05, 'm'),
        part('joint', 1.8, W - 0.2, 2.3, 0, 0, 1.7, 'd', 'f'),
        part('ac', 6, 1.5, 0.35, 5, 0, 3.35, 'l', 'f'), part('ac2', 6, 1.5, 0.35, -5, 0, 3.35, 'l', 'f'),
        part('bg1', 3.0, W - 0.7, 0.7, 9, 0, 0.4, 'd', 'f'), part('bg2', 3.0, W - 0.7, 0.7, -9, 0, 0.4, 'd', 'f'),
        part('hl1', 0.12, 0.4, 0.26, L / 2 + 0.05, 0.7, 0.9, 'h', 'f'), part('hl2', 0.12, 0.4, 0.26, L / 2 + 0.05, -0.7, 0.9, 'h', 'f'),
        part('tl1', 0.12, 0.4, 0.26, -L / 2 - 0.05, 0.7, 0.9, 'r', 'f'), part('tl2', 0.12, 0.4, 0.26, -L / 2 - 0.05, -0.7, 0.9, 'r', 'f')
      ].concat(pantograph(-8, 3.2));
      unit('tram', L, W, 3.4, 'both', o);
    })();
    const wagonBase = function (L, W) {
      return [part('under', L - 1, W - 0.6, 0.5, 0, 0, 0.72, 'd'), part('sill', L, W - 0.3, 0.2, 0, 0, 0.98, 'd', 'f')]
        .concat(bogie('b1', L * 0.33, W), bogie('b2', -L * 0.33, W));
    };
    const rearLamps = function (L, z) { return [part('tl1', 0.12, 0.45, 0.28, -L / 2 - 0.05, 0.9, z, 'r', 'f'), part('tl2', 0.12, 0.45, 0.28, -L / 2 - 0.05, -0.9, z, 'r', 'f')]; };
    const ladders = function (L, h) { const o = []; [1, -1].forEach(function (sx) { [1, -1].forEach(function (sy) { o.push(part('ld' + sx + sy, 0.08, 0.5, h, sx * (L / 2 - 0.4), sy * 1.52, 1.0 + h / 2, 'm', 'f')); }); }); return o; };
    const boxcar = function (end) {
      const o = wagonBase(15, 3.0).concat([part('body', 15, 3.0, 3.0, 0, 0, 1.08 + 1.5, 'p'), part('door1', 3.6, 3.06, 2.55, 0.8, 0, 2.5, 'd', 'f'), part('door2', 3.6, 3.06, 2.55, -4.2, 0, 2.5, 'd', 'f'),
        part('drail', 11.5, 3.08, 0.12, -1.2, 0, 3.95, 'm', 'f'), part('roof', 15.1, 2.6, 0.22, 0, 0, 4.18, 'm'), part('mark', 5.5, 3.08, 0.7, 4.6, 0, 3.4, 'a', 'f')], ladders(15, 2.8));
      if (end) o.push.apply(o, rearLamps(15, 1.7));
      return o;
    };
    unit('boxcar', 15, 3.0, 4.3, 'none', boxcar(false));
    unit('boxcarEnd', 15, 3.0, 4.3, 'rear', boxcar(true));
    unit('tank', 14, 2.9, 4.0, 'none', wagonBase(14, 2.9).concat([
      part('t0', 12.6, 2.75, 1.8, 0, 0, 2.45, 'p'), part('t1', 12.6, 2.0, 0.55, 0, 0, 3.6, 'p'), part('t2', 12.6, 2.0, 0.55, 0, 0, 1.3, 'p', 'f'),
      part('cap1', 0.5, 2.2, 2.2, 6.5, 0, 2.45, 'p', 'f'), part('cap2', 0.5, 2.2, 2.2, -6.5, 0, 2.45, 'p', 'f'),
      part('walk', 11, 0.7, 0.08, 0, 0, 3.95, 'd', 'f'), part('dome', 1.1, 1.1, 0.45, 1.5, 0, 4.15, 'm', 'f'), part('band', 0.4, 2.8, 1.85, 3.0, 0, 2.45, 'a', 'f'), part('band2', 0.4, 2.8, 1.85, -3.0, 0, 2.45, 'a', 'f')], ladders(14, 2.2)));
    unit('hopper', 13, 3.0, 4.0, 'none', wagonBase(13, 3.0).concat([
      part('hop', 12.6, 3.0, 2.0, 0, 0, 2.95, 'p'), part('top', 11.8, 2.5, 0.06, 0, 0, 3.97, 'd', 'f'),
      part('h1', 2.6, 2.2, 1.2, 4.2, 0, 1.55, 'd'), part('h2', 2.6, 2.2, 1.2, 0, 0, 1.55, 'd'), part('h3', 2.6, 2.2, 1.2, -4.2, 0, 1.55, 'd'),
      part('rib1', 0.18, 3.06, 2.0, 3.2, 0, 2.95, 'm', 'f'), part('rib2', 0.18, 3.06, 2.0, 0, 0, 2.95, 'm', 'f'), part('rib3', 0.18, 3.06, 2.0, -3.2, 0, 2.95, 'm', 'f')], ladders(13, 2.6)));
    const flat = function (name, c1, c2, double) {
      const o = wagonBase(18, 2.9).concat([part('deck', 18, 2.9, 0.3, 0, 0, 1.15, 'd'),
        part('c1', 8.7, 2.45, 2.6, 4.5, 0, 2.6, c1), part('c2', 8.7, 2.45, 2.6, -4.5, 0, 2.6, c2),
        part('c1d', 0.12, 2.0, 2.2, 8.9, 0, 2.6, 'm', 'f'), part('c2d', 0.12, 2.0, 2.2, -8.9, 0, 2.6, 'm', 'f'),
        part('c1r', 8.72, 2.5, 0.25, 4.5, 0, 3.8, 'm', 'f'), part('c2r', 8.72, 2.5, 0.25, -4.5, 0, 3.8, 'm', 'f')]);
      if (double) o.push(part('c3', 8.7, 2.45, 2.6, 4.5, 0, 5.2, 'x6'), part('c4', 8.7, 2.45, 2.6, -4.5, 0, 5.2, 'x5'));
      unit(name, 18, 2.9, double ? 6.6 : 4.1, 'none', o);
    };
    flat('containerA', 'x1', 'x2', false); flat('containerB', 'x3', 'x5', false); flat('containerC', 'x4', 'x6', false); flat('doubleA', 'x2', 'x3', true);
    const PAL_PAX = ['#e8e8ea', '#c8102e', '#1f4e9c', '#2e6b3a', '#f2c200', '#9aa0a6'];
    const ACCENTS = ['#f2f2f2', '#1b1b1b', '#f2c200', '#c8102e', '#1f4e9c', '#d9d9d9'];
    const PAL_LOCO = ['#1f4e9c', '#f28c00', '#b3202a', '#2b2b2b', '#2e6b3a'];
    const PAL_WAGON = ['#7a4b2a', '#8a8f98', '#2b2b2b', '#b3202a', '#3b5b3b', '#1f4e9c', '#c9a227'];
    // a train = head + middle units + tail (names refer to UNIT); mix = every wagon gets its own colour
    const CONSISTS = [
      { name: 'freight', cls: ['rail', 'narrow_gauge'], w: 35, spd: 0.7, head: 'loco', mid: ['boxcar', 'tank', 'hopper', 'containerA', 'containerB', 'containerC', 'doubleA'], tail: 'boxcarEnd', n: [8, 18], pal: PAL_LOCO, mix: true },
      { name: 'intercity', cls: ['rail'], w: 25, spd: 1.2, head: 'loco', mid: ['coach'], tail: 'coachEnd', n: [4, 9], pal: PAL_PAX },
      { name: 'commuter', cls: ['rail', 'light_rail'], w: 35, spd: 1.0, head: 'emuHead', mid: ['emu'], tail: 'emuTail', n: [2, 6], pal: PAL_PAX },
      { name: 'metro', cls: ['light_rail', 'subway'], w: 60, spd: 0.9, head: 'metroHead', mid: ['metro'], tail: 'metroTail', n: [2, 4], pal: PAL_PAX },
      { name: 'tram', cls: ['tram'], w: 100, spd: 1, head: 'tram', mid: ['tram'], tail: null, n: [0, 1], pal: ['#c8102e', '#f2c200', '#1f4e9c', '#e8e8ea'] }
    ];
    function pickConsist(cls) {
      let total = 0;
      CONSISTS.forEach(function (c) { if (c.cls.indexOf(cls) >= 0) total += c.w; });
      let x = Math.random() * total;
      for (let i = 0; i < CONSISTS.length; i++) {
        const c = CONSISTS[i];
        if (c.cls.indexOf(cls) < 0) continue;
        x -= c.w;
        if (x <= 0) return c;
      }
      return CONSISTS[2];
    }

    // ---- ships. z = 0 is the waterline: hull below (red antifouling), boot stripe, hull above, then the superstructure ----
    // p.house = [{l, w, h, x}...] stacked tiers; p.stacks = container stacks (full model only)
    function ship(name, p) {
      const L = p.L, W = p.W, fb = p.fb, dr = p.dr;
      const out = [
        part('hullLow', L * 0.8, W - 0.2, dr, -L * 0.1, 0, -dr / 2 + 0.2, 'x1'),
        part('hull', L * 0.8, W, fb - 0.4, -L * 0.1, 0, 0.4 + (fb - 0.4) / 2, 'p'),
        part('stripe', L * 0.8 + 0.1, W + 0.12, 0.9, -L * 0.1, 0, 0.85, 'a'),
        part('bowA', L * 0.12, W * 0.8, fb + dr * 0.8, L * 0.36, 0, (fb - dr * 0.8) / 2, 'p'),
        part('bowB', L * 0.07, W * 0.5, fb + dr * 0.5, L * 0.455, 0, (fb - dr * 0.5) / 2, 'p'),
        part('bowC', L * 0.035, W * 0.22, fb + dr * 0.3, L * 0.51, 0, (fb - dr * 0.3) / 2, 'p'),
        part('sternB', L * 0.06, W * 0.8, fb + dr * 0.6, -L * 0.52, 0, (fb - dr * 0.6) / 2, 'p')
      ];
      if (p.deck) out.push(part('deck', L * 0.74, W * 0.94, 0.4, -L * 0.1, 0, fb + 0.2, p.deck));
      (p.stacks || []).forEach(function (c, i) { out.push(part('st' + i, c.l, c.w, c.h, c.x, c.y || 0, fb + 0.4 + c.h / 2, c.k, 'f')); });
      (p.blocks || []).forEach(function (c, i) { out.push(part('bk' + i, c.l, c.w, c.h, c.x, 0, fb + 0.4 + c.h / 2, c.k, 'm')); });
      (p.extra || []).forEach(function (c, i) { out.push(part('ex' + i, c.l, c.w, c.h, c.x, c.y || 0, c.z, c.k, c.lod, c.pitch)); });
      let z = fb;
      (p.house || []).forEach(function (h, i) {
        out.push(part('hs' + i, h.l, h.w, h.h, h.x, 0, z + h.h / 2, 'l'));
        out.push(part('hw' + i, h.l + 0.1, h.w + 0.1, Math.min(1.4, h.h * 0.4), h.x, 0, z + h.h * 0.62, 'g'));
        out.push(part('hf' + i, 0.12, h.w * 0.9, Math.min(1.4, h.h * 0.4), h.x + h.l / 2 + 0.03, 0, z + h.h * 0.62, 'g'));
        z += h.h;
      });
      if (p.funnel) {
        const f = p.funnel;
        out.push(part('fun', f.l, f.w, f.h, f.x, 0, z - (f.drop || 0) + f.h / 2, 'p'));
        out.push(part('funb', f.l + 0.05, f.w + 0.05, f.h * 0.22, f.x, 0, z - (f.drop || 0) + f.h * 0.72, 'a'));
        out.push(part('funt', f.l * 0.9, f.w * 0.9, 0.2, f.x, 0, z - (f.drop || 0) + f.h + 0.1, 'd', 'f'));
      }
      if (p.mast) out.push(part('mast', 0.5, 0.5, p.mast.h, p.mast.x, 0, z + p.mast.h / 2, 'm', 'f'), part('radar', 0.3, p.mast.r || 3.2, 0.3, p.mast.x, 0, z + p.mast.h + 0.2, 'd', 'f'));
      out.push(part('wake', L * 0.9, W * 0.55, 0.05, -L * 0.98, 0, 0.06, 'k', 'f'));
      tierFine(out);
      SHIP[name] = { name: name, L: L, W: W, H: z + (p.funnel ? p.funnel.h * 0.3 : 0) + (p.mast ? p.mast.h : 0), cx: 0, w: 0, heavy: false, spd: p.spd, pal: p.pal, lit: 'boat', acc: 0.3, dec: 1.0, parts: out };
    }
    const PAL_HULL = ['#1b2a4a', '#7a1f1f', '#2a2a2a', '#1f5a3a', '#4a4f57'];
    const stackGrid = function (x0, bays, bayL, cols, colW, tiers, W) {      // container stacks in rows across the deck
      const o = [], ks = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
      for (let b = 0; b < bays; b++) for (let c = 0; c < cols; c++) {
        const t = tiers - ((b + c) % 2);
        o.push({ l: bayL - 0.4, w: colW - 0.3, h: t * 2.6, x: x0 + b * bayL, y: (c - (cols - 1) / 2) * colW, k: ks[(b * 3 + c * 5 + ((b * c) % 3)) % ks.length] });
      }
      return o;
    };
    ship('cargo', { L: 190, W: 28, fb: 9, dr: 6, spd: 0.9, pal: PAL_HULL, deck: 'd',
      stacks: stackGrid(-45, 6, 20, 3, 7.4, 3), blocks: [{ l: 118, w: 22.2, h: 6.5, x: -9, k: 'l' }],
      extra: [{ l: 16, w: 24, h: 3.2, x: 74, z: 9 + 1.6, k: 'p', lod: 'f' }, { l: 0.5, w: 0.5, h: 9, x: 78, z: 9 + 4.5, k: 'm', lod: 'f' }],
      house: [{ l: 14, w: 24, h: 9, x: -75 }, { l: 12, w: 22, h: 6, x: -75.5 }, { l: 10, w: 21, h: 4.5, x: -76 }, { l: 6, w: 27, h: 3, x: -73.5 }],
      funnel: { l: 7, w: 6, h: 8, x: -82, drop: 14 }, mast: { h: 9, x: -76 } });
    ship('bulker', { L: 185, W: 30, fb: 9, dr: 9, spd: 0.85, pal: PAL_HULL, deck: 'x1',
      extra: [0, 1, 2, 3, 4].map(function (i) { return { l: 15, w: 19, h: 1.4, x: -45 + i * 22, z: 9 + 1.1, k: 'd' }; })
        .concat([0, 1, 2, 3].map(function (i) { return { l: 0.7, w: 0.7, h: 11, x: -34 + i * 22, y: 0, z: 9 + 5.5, k: 'm', lod: 'f' }; }))
        .concat([0, 1, 2, 3].map(function (i) { return { l: 15, w: 0.6, h: 0.6, x: -28 + i * 22, y: 0, z: 9 + 11.2, k: 'm', lod: 'f' }; })),
      house: [{ l: 14, w: 25, h: 9, x: -72 }, { l: 12, w: 22, h: 6, x: -72.5 }, { l: 10, w: 20, h: 4.5, x: -73 }],
      funnel: { l: 6, w: 6, h: 7, x: -79, drop: 12 }, mast: { h: 8, x: -73 } });
    ship('tanker', { L: 220, W: 38, fb: 8, dr: 13, spd: 0.8, pal: PAL_HULL, deck: 'x1',
      extra: [{ l: 140, w: 0.5, h: 0.5, x: 4, y: 3, z: 8 + 1.2, k: 'm', lod: 'f' }, { l: 140, w: 0.5, h: 0.5, x: 4, y: -3, z: 8 + 1.2, k: 'm', lod: 'f' },
        { l: 140, w: 1.4, h: 0.15, x: 4, y: 0, z: 8 + 1.7, k: 'd', lod: 'f' }, { l: 2.5, w: 5, h: 1.6, x: 62, z: 8 + 1.2, k: 'm', lod: 'f' }, { l: 15, w: 30, h: 2.2, x: 80, z: 8 + 1.1, k: 'p', lod: 'f' }]
        .concat([0, 1, 2, 3, 4, 5].map(function (i) { return { l: 0.8, w: 7, h: 0.9, x: -50 + i * 20, y: 0, z: 8 + 0.9, k: 'm', lod: 'f' }; })),
      house: [{ l: 16, w: 30, h: 9, x: -92 }, { l: 13, w: 26, h: 6, x: -92.5 }, { l: 10, w: 23, h: 4.5, x: -93 }],
      funnel: { l: 7, w: 6, h: 7, x: -100, drop: 12 }, mast: { h: 8, x: -93 } });
    ship('ferry', { L: 62, W: 15, fb: 5, dr: 2.2, spd: 1.15, pal: ['#f2f2f2', '#1f4e9c', '#c8102e', '#2e6b3a'],
      extra: [{ l: 6, w: 12, h: 2.4, x: 27, z: 5 + 1.2, k: 'd', lod: 'f' }, { l: 7, w: 2, h: 2.2, x: -3, y: 6.9, z: 5 + 3.2, k: 'o', lod: 'f' }, { l: 7, w: 2, h: 2.2, x: -3, y: -6.9, z: 5 + 3.2, k: 'o', lod: 'f' },
        { l: 7, w: 2, h: 2.2, x: -14, y: 6.9, z: 5 + 3.2, k: 'o', lod: 'f' }, { l: 7, w: 2, h: 2.2, x: -14, y: -6.9, z: 5 + 3.2, k: 'o', lod: 'f' }],
      house: [{ l: 46, w: 13.6, h: 3.2, x: -2 }, { l: 38, w: 12.4, h: 3.2, x: -4 }, { l: 13, w: 12.8, h: 2.8, x: 6 }],
      funnel: { l: 5.5, w: 4.5, h: 4, x: -14, drop: 2.8 }, mast: { h: 5, x: 6 } });
    ship('tug', { L: 28, W: 9.4, fb: 2.6, dr: 2.2, spd: 0.7, pal: ['#b3202a', '#1f4e9c', '#2b2b2b', '#2e6b3a'],
      extra: [{ l: 1.1, w: 6.2, h: 1.3, x: 14.1, z: 1.3, k: 'd' }].concat([0, 1, 2, 3, 4].map(function (i) { return { l: 1.3, w: 0.5, h: 1.0, x: -9 + i * 4.8, y: 4.7, z: 1.5, k: 't', lod: 'f' }; }))
        .concat([0, 1, 2, 3, 4].map(function (i) { return { l: 1.3, w: 0.5, h: 1.0, x: -9 + i * 4.8, y: -4.7, z: 1.5, k: 't', lod: 'f' }; })),
      house: [{ l: 9, w: 6.6, h: 3.4, x: 3 }, { l: 5, w: 5, h: 2.6, x: 3.5 }],
      funnel: { l: 2.4, w: 2.4, h: 3.6, x: -4, drop: 4 }, mast: { h: 3.5, x: 3.5, r: 2 } });
    ship('pushboat', { L: 32, W: 11, fb: 2.4, dr: 1.8, spd: 0.7, pal: ['#b3202a', '#1f4e9c', '#f2f2f2', '#2e6b3a'],
      extra: [{ l: 1.0, w: 8, h: 4.5, x: 15.6, z: 4.5, k: 'd' }],
      house: [{ l: 14, w: 9.4, h: 3.2, x: -3 }, { l: 11, w: 8.4, h: 3.0, x: -3 }, { l: 6, w: 6.5, h: 2.8, x: -1 }, { l: 3.5, w: 5, h: 2.5, x: 0 }],
      funnel: { l: 1.8, w: 1.8, h: 3.4, x: -9, drop: 5 }, mast: { h: 4, x: 0, r: 2 } });
    ship('barge', { L: 80, W: 11, fb: 2.2, dr: 1.8, spd: 0.6, pal: ['#2b2b2b', '#7a1f1f', '#4a4f57'], deck: 'd',
      extra: [{ l: 30, w: 9.6, h: 3.4, x: 16, z: 2.2 + 2.1, k: 'd' }, { l: 30, w: 9.6, h: 3.0, x: -18, z: 2.2 + 1.9, k: 'x5' }, { l: 8, w: 0.6, h: 0.6, x: 38, z: 3.2, k: 'm', lod: 'f' }]
        .concat([0, 1, 2, 3, 4, 5].map(function (i) { return { l: 0.5, w: 0.5, h: 1.0, x: -34 + i * 14, y: 5.3, z: 3.3, k: 'm', lod: 'f' }; })) });
    ship('motorboat', { L: 9, W: 3, fb: 1.1, dr: 0.5, spd: 1.8, pal: ['#f2f2f2', '#1f4e9c', '#b3202a', '#d9b43c'],
      extra: [{ l: 3.2, w: 2.2, h: 1.0, x: -0.8, z: 1.1 + 0.5, k: 'l' }, { l: 0.12, w: 2.0, h: 0.8, x: 0.9, z: 1.1 + 1.3, k: 'g', pitch: -0.5 }, { l: 1.4, w: 1.8, h: 0.4, x: -3, z: 1.1 + 0.2, k: 'd', lod: 'f' },
        { l: 0.6, w: 0.5, h: 0.9, x: -4.7, z: 1.1 + 0.2, k: 'd', lod: 'f' }, { l: 2.5, w: 0.05, h: 0.5, x: 2.6, y: 0.0, z: 1.1 + 0.35, k: 'm', lod: 'f' }] });
    ship('sailboat', { L: 11, W: 3.4, fb: 1.0, dr: 1.4, spd: 1.4, pal: ['#f2f2f2', '#1f4e9c', '#2b2b2b', '#b3202a'],
      extra: [{ l: 3.2, w: 2.2, h: 0.7, x: 0, z: 1.0 + 0.35, k: 'l' }, { l: 0.2, w: 0.2, h: 13, x: 0.8, z: 1.0 + 6.5, k: 'm' },
        { l: 4.2, w: 0.06, h: 9.5, x: -1.4, z: 1.0 + 5.2, k: 'k' }, { l: 3.0, w: 0.06, h: 7.2, x: 3.2, z: 1.0 + 4.0, k: 'k' }, { l: 3.0, w: 0.2, h: 0.2, x: -1.0, z: 1.0 + 1.1, k: 'm', lod: 'f' }] });
    const BOAT_MIX = {
      ferry:   { ferry: 55, tug: 10, motorboat: 25, sailboat: 10 },
      fairway: { cargo: 35, tanker: 25, bulker: 15, tug: 8, ferry: 7, motorboat: 5, sailboat: 5 },
      river:   { barge: 28, pushboat: 18, motorboat: 24, sailboat: 10, tug: 12, ferry: 8 }
    };
    function pickBoatType(cls) {
      const mix = BOAT_MIX[cls] || BOAT_MIX.fairway;
      let total = 0;
      Object.keys(mix).forEach(function (k) { total += mix[k]; });
      let x = Math.random() * total, pick = 'motorboat';
      Object.keys(mix).some(function (k) { x -= mix[k]; if (x <= 0) { pick = k; return true; } return false; });
      return SHIP[pick];
    }

    /* ================================================================ *
     *  RARE VEHICLES (RARE-BEGIN)
     *  Exotic supercars, cruise ships and famous trains. They use the normal spawners: a spawn
     *  occasionally rolls "rare" first. Where (region / port / route) is checked before anything is
     *  built, every model is only created the first time it is picked, and rare ones stay rare.
     * ================================================================ */
    function lazyDef(obj, names, build) {     // the models of a vehicle are built the first time one of its names is read
      names.forEach(function (n) {
        Object.defineProperty(obj, n, { configurable: true, enumerable: true, get: function () {
          names.forEach(function (m) { delete obj[m]; });
          build();
          return obj[n];
        } });
      });
    }

    // ---- places: rough outlines, only used to decide where a rare vehicle is allowed ----
    const USA48 = [[48.4, -124.8], [49.0, -123.3], [49.0, -95.1], [48.1, -89.5], [46.5, -84.3], [45.9, -83.5], [43.6, -82.5], [42.9, -82.4], [42.0, -83.1], [41.7, -83.4],
      [42.9, -78.9], [43.25, -79.07], [43.45, -76.5], [44.1, -76.3], [45.0, -74.7], [45.0, -71.5], [45.3, -70.8], [47.4, -69.2], [47.3, -68.3], [45.9, -67.8], [44.8, -66.95],
      [43.5, -70.0], [41.5, -69.9], [41.0, -71.8], [40.6, -74.0], [39.0, -74.8], [37.0, -75.9], [35.2, -75.5], [33.8, -77.9], [32.0, -80.8], [30.7, -81.4], [27.0, -80.0],
      [25.1, -80.4], [25.2, -81.2], [26.5, -82.1], [28.0, -82.8], [29.9, -84.0], [30.1, -85.5], [30.3, -87.5], [30.2, -89.6], [29.1, -90.3], [29.3, -94.8], [25.9, -97.4],
      [26.4, -99.1], [27.5, -99.5], [29.0, -100.9], [29.8, -102.3], [29.0, -103.1], [30.0, -104.8], [31.8, -106.5], [31.8, -108.2], [31.3, -108.2], [31.33, -111.07],
      [32.5, -114.8], [32.5, -117.1], [33.7, -118.4], [34.5, -120.5], [36.6, -121.9], [38.0, -123.0], [40.4, -124.4], [42.0, -124.5], [46.2, -124.0]];
    // a region is boxes [lat0, lat1, lon0, lon1] (minus the `not` boxes), a polygon, a line corridor, or several regions that must all hold
    const REGION = {
      japan: { boxes: [[30.9, 41.6, 129.7, 142.3], [41.3, 45.6, 139.3, 145.9]] },
      china: { boxes: [[22.3, 42.5, 98.0, 122.8], [43.0, 48.5, 121.0, 131.0], [18.0, 22.3, 108.5, 117.5]], not: [[21.8, 25.4, 119.9, 122.5]] },
      shanghai_maglev: { boxes: [[31.13, 31.24, 121.54, 121.83]] },
      france: { boxes: [[41.3, 51.2, -5.2, 10.0]] },                       // France and the connected routes (Belgium, Switzerland, Luxembourg)
      germany: { boxes: [[46.4, 55.6, 4.2, 17.2]] },                       // Germany and the neighbouring routes (Netherlands, Austria, Switzerland, Denmark)
      italy: { boxes: [[36.6, 47.2, 6.6, 18.6]] },
      spain: { boxes: [[36.0, 43.9, -9.4, 3.4]], not: [[36.9, 42.2, -9.6, -6.2]] },
      korea: { boxes: [[33.9, 37.9, 126.1, 129.5]] },
      uk: { boxes: [[49.9, 58.8, -5.8, 1.8]] },
      usa: { poly: USA48 },
      uwest: { boxes: [[24, 50, -125, -85]] },
      us_west: { and: ['usa', 'uwest'] },
      bigboy: { and: ['usa', { boxes: [[30, 46, -125, -88]] }] },           // the Union Pacific heartland
      nec: { line: { r: 1500, pts: [[38.897, -77.006], [39.308, -76.615], [39.737, -75.551], [39.956, -75.182], [40.218, -74.77], [40.734, -74.164], [40.75, -73.994],
        [41.047, -73.542], [41.298, -72.926], [41.354, -72.094], [41.829, -71.413], [42.21, -71.147], [42.352, -71.055]] } },
      alps: { boxes: [[42.0, 52.0, -2.0, 16.0]] },
      swiss: { boxes: [[46.0, 47.3, 7.0, 10.3]] }
    };
    function segDistM(lat, lon, a, b) {
      const kx = Math.cos(lat * D2R), ax = (a[1] - lon) * kx, ay = a[0] - lat, bx = (b[1] - lon) * kx, by = b[0] - lat;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const px = ax + dx * t, py = ay + dy * t;
      return Math.sqrt(px * px + py * py) * 111320;
    }
    function inRegion(r, lat, lon) {
      if (typeof r === 'string') r = REGION[r];
      if (r.and) return r.and.every(function (n) { return inRegion(n, lat, lon); });
      const inBox = function (b) { return lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]; };
      if (r.boxes) return r.boxes.some(inBox) && !(r.not && r.not.some(inBox));
      if (r.poly) {
        let inside = false;
        for (let i = 0, j = r.poly.length - 1; i < r.poly.length; j = i++) {
          const a = r.poly[i], b = r.poly[j];
          if ((a[0] > lat) !== (b[0] > lat) && lon < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0]) + a[1]) inside = !inside;
        }
        return inside;
      }
      if (r.line) { for (let i = 1; i < r.line.pts.length; i++) if (segDistM(lat, lon, r.line.pts[i - 1], r.line.pts[i]) <= r.line.r) return true; return false; }
      return false;
    }
    // high-speed lines are long and nearly straight: tracks with tight bends are not used for them (cached per way)
    function gentle(w) {
      if (w.gent !== undefined) return w.gent;
      let ok = w.len >= 300;
      if (ok) {
        const an = [w.pts[0]];
        for (let i = 1; i < w.pts.length; i++) if (distM(an[an.length - 1][0], an[an.length - 1][1], w.pts[i][0], w.pts[i][1]) >= 80) an.push(w.pts[i]);
        if (an.length < 4) ok = false;
        for (let i = 1; ok && i < an.length - 1; i++) {
          const d = bearing(an[i][0], an[i][1], an[i + 1][0], an[i + 1][1]) - bearing(an[i - 1][0], an[i - 1][1], an[i][0], an[i][1]);
          if (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > 0.075) ok = false;     // about 4 degrees per 80 m = a 1 km radius
        }
      }
      return (w.gent = ok);
    }

    // ---- rarity: chance (in % of the spawns of that kind) of a rare vehicle of this tier. The sliders in Advanced change cfg.rareTier. ----
    const TIER_LABEL = { uncommon: 'Uncommon', rare: 'Rare', veryrare: 'Very rare', legendary: 'Legendary' };
    const KIND_SCALE = { road: 0.003, rail: 1, boat: 0.15 };   // cars spawn by the thousand (and there are 18 models), so they get a far smaller share
    // never more than this many alive at once, per kind and tier (so common rare ones can't use up all the room for the rarer ones)
    const RARE_MAX = { road: { veryrare: 4 }, rail: { uncommon: 2, rare: 2, veryrare: 1, legendary: 1 }, boat: { uncommon: 2, rare: 2, veryrare: 1 } };
    const RARE_SEP = { road: 2500, rail: 15000, boat: 20000 }; // the same model is never spawned closer than this (metres)
    function rareP(kind, d) { return Math.min(0.5, Math.max(0, (+cfg.rareTier[d.tier] || 0) / 100) * Math.max(0, cfg.rareFreq) * KIND_SCALE[kind] * (d.rw || 1)); }
    function rareCount(kind, tier) { let n = 0; for (let k = 0; k < cars.length; k++) if (cars[k].kind === kind && cars[k].rare && cars[k].rare.tier === tier) n++; return n; }
    function roomFor(kind, tier) { return rareCount(kind, tier) < (RARE_MAX[kind][tier] || 0); }
    function rareNear(id, lat, lon, r) {
      for (let k = 0; k < cars.length; k++) { const c = cars[k]; if (c.rare && c.rare.id === id && distM(lat, lon, c.lat, c.lon) < r) return true; }
      return false;
    }
    function rollPick(defs, ps) {      // one roll over all candidates; returns one or null
      let tot = 0; ps.forEach(function (p) { tot += p; });
      if (tot <= 0 || Math.random() > tot) return null;
      let x = Math.random() * tot;
      for (let i = 0; i < defs.length; i++) { x -= ps[i]; if (x <= 0) return defs[i]; }
      return defs[defs.length - 1];
    }

    /* ---- supercars ---- */
    // wealth: global baseline, much higher in rich districts and next to each maker's home town
    const WEALTH = [[43.74, 7.42, 10, 12], [25.2, 55.27, 7, 30], [24.47, 54.37, 5, 25], [25.29, 51.53, 5, 20], [34.08, -118.4, 6, 25], [25.8, -80.13, 5, 20], [26.7, -80.04, 4, 15],
      [40.76, -73.97, 4, 15], [51.5, -0.16, 5, 12], [48.87, 2.3, 4, 12], [47.37, 8.54, 4, 12], [46.2, 6.15, 4, 10], [35.66, 139.74, 3, 15], [1.3, 103.85, 4, 20], [22.28, 114.17, 4, 15],
      [45.47, 9.19, 3, 12], [43.6, 7.1, 3, 25], [24.7, 46.7, 3, 25], [-33.87, 151.25, 2, 15], [37.4, -122.1, 3, 30], [49.27, -123.12, 2, 15], [48.14, 11.58, 3, 15], [55.75, 37.6, 2, 25],
      [31.23, 121.47, 2, 25], [52.37, 4.9, 2, 12], [41.39, 2.17, 2, 15], [19.43, -99.13, 2, 20]];
    const MAKER_HOME = { lamborghini: [44.65, 11.12], bugatti: [48.54, 7.49], koenigsegg: [56.25, 12.86], ferrari: [44.53, 10.86], mclaren: [51.34, -0.56], pagani: [44.68, 10.96], porsche: [48.83, 9.15] };
    function wealth(lat, lon) {
      let w = 0.4;
      for (let i = 0; i < WEALTH.length; i++) { const z = WEALTH[i], d = distM(lat, lon, z[0], z[1]) / (z[3] * 1000); if (d < 3) w += z[2] * Math.exp(-d * d); }
      return Math.min(w, 12);
    }
    const SUPER_PAL = {
      lamborghini: ['#f2c200', '#f2c200', '#6bd400', '#ff6a00', '#1b1b1b', '#f2f2f2', '#4b1f8c', '#c8102e'],
      ferrari: ['#d40000', '#d40000', '#d40000', '#f2c200', '#1b1b1b', '#f2f2f2', '#1f4e9c'],
      mclaren: ['#ff7f00', '#ff7f00', '#1b1b1b', '#c8ccd2', '#1f4e9c', '#f2f2f2'],
      bugatti: ['#1f3d8f', '#1b1b1b', '#1f3d8f', '#c8ccd2'],
      koenigsegg: ['#f2f2f2', '#c8ccd2', '#1b1b1b', '#ff6a00', '#1a8a4a'],
      pagani: ['#c8ccd2', '#1b1b1b', '#d8a21c', '#f2f2f2'],
      porsche: ['#c8ccd2', '#c8ccd2', '#1b1b1b', '#c8102e', '#f2f2f2']
    };
    // id, maker, name, length, width, height, weight in the tier, features (wing: 1 small / 2 big, split, stripe, cline, quad, intake, cab = cabin length share)
    const SUPER = [
      ['aventador', 'lamborghini', 'Lamborghini Aventador', 4.84, 2.03, 1.14, 1.0, { wing: 1, split: 1, intake: 1 }],
      ['revuelto', 'lamborghini', 'Lamborghini Revuelto', 4.95, 2.03, 1.16, 1.0, { wing: 1, split: 1, intake: 1 }],
      ['huracan', 'lamborghini', 'Lamborghini Huracán', 4.52, 1.93, 1.17, 1.5, { wing: 1, split: 1, intake: 1 }],
      ['chiron', 'bugatti', 'Bugatti Chiron', 4.54, 2.04, 1.21, 0.5, { wing: 1, cline: 1, cab: 0.46 }],
      ['tourbillon', 'bugatti', 'Bugatti Tourbillon', 4.55, 2.0, 1.2, 0.5, { wing: 1, cline: 1, cab: 0.46 }],
      ['jesko', 'koenigsegg', 'Koenigsegg Jesko', 4.61, 2.03, 1.2, 0.4, { wing: 2, split: 1, stripe: 1 }],
      ['regera', 'koenigsegg', 'Koenigsegg Regera', 4.56, 2.05, 1.11, 0.4, { wing: 1, split: 1 }],
      ['gemera', 'koenigsegg', 'Koenigsegg Gemera', 4.97, 2.03, 1.2, 0.4, { wing: 1, split: 1, cab: 0.55 }],
      ['sf90', 'ferrari', 'Ferrari SF90', 4.71, 1.97, 1.19, 1.2, { wing: 1, split: 1, intake: 1 }],
      ['f80', 'ferrari', 'Ferrari F80', 4.8, 2.0, 1.12, 0.4, { wing: 2, split: 1, intake: 1 }],
      ['laferrari', 'ferrari', 'Ferrari LaFerrari', 4.7, 1.99, 1.12, 0.4, { wing: 1, split: 1, intake: 1 }],
      ['p1', 'mclaren', 'McLaren P1', 4.59, 1.95, 1.17, 0.4, { wing: 2, split: 1 }],
      ['senna', 'mclaren', 'McLaren Senna', 4.74, 1.97, 1.22, 0.5, { wing: 2, split: 1, intake: 1 }],
      ['w1', 'mclaren', 'McLaren W1', 4.64, 2.0, 1.18, 0.4, { wing: 2, split: 1 }],
      ['huayra', 'pagani', 'Pagani Huayra', 4.68, 2.03, 1.17, 0.4, { wing: 1, quad: 1, intake: 1 }],
      ['utopia', 'pagani', 'Pagani Utopia', 4.77, 2.0, 1.14, 0.4, { wing: 1, quad: 1, intake: 1 }],
      ['p918', 'porsche', 'Porsche 918 Spyder', 4.64, 1.94, 1.17, 0.4, { wing: 1, split: 1, stripe: 1 }],
      ['cgt', 'porsche', 'Porsche Carrera GT', 4.61, 1.92, 1.17, 0.6, { wing: 1, split: 1 }]
    ].map(function (r) {
      return { id: r[0], maker: r[1], name: r[2], L: r[3], W: r[4], H: r[5], rw: r[6], f: r[7], tier: 'veryrare', cat: 'road', type: null };
    });
    function superType(d) {
      if (d.type) return d.type;
      const f = d.f, bz = 0.12, bh = d.H * 0.46, ch = Math.max(0.3, d.H - bz - bh);
      const p = { L: d.L, W: d.W, bz: bz, bh: bh, cl: d.L * (f.cab || 0.42), ch: ch, cx: d.L * 0.04, rake: 58, tail: 36, wr: 0.7, wt: d.W * 0.16, wx: [d.L * 0.3, -d.L * 0.3],
        wing: f.wing ? { h: f.wing === 2 ? 0.55 : 0.32, l: f.wing === 2 ? 0.7 : 0.45 } : null, split: f.split, stripe: f.stripe, cline: f.cline, quad: f.quad, intake: f.intake };
      d.type = { name: 'sc_' + d.id, L: d.L, W: d.W, H: d.H, cx: 0, w: 0, heavy: false, spd: 1.15, pal: SUPER_PAL[d.maker], parts: makeCar(p) };
      return d.type;
    }
    const SUPER_CLS = { motorway: 1, trunk: 1, primary: 1, secondary: 1, tertiary: 1, unclassified: 1, residential: 1 };

    /* ---- trains ---- */
    function flipX(parts) { parts.forEach(function (q) { q.at[0] = -q.at[0]; q.pitch = -q.pitch; if (q.k === 'h') q.k = 'r'; }); return parts; }
    // one car of a high-speed train: `nose` = length of the streamlined end (0 = a plain middle car)
    function hsCar(o, L, nose, pan) {
      const W = o.W, H = o.H, z0 = 0.85, bh = H - z0 - 0.38;
      const bl = nose ? L - nose : L, bx = nose ? -nose / 2 : 0;
      const out = [
        part('body', bl, W, bh, bx, 0, z0 + bh / 2, 'p'),
        part('roof1', bl, W - 0.45, 0.22, bx, 0, z0 + bh + 0.11, 'p'),
        part('roof2', bl, W - 1.3, 0.16, bx, 0, z0 + bh + 0.3, 'm'),
        part('stripe', bl + 0.02, W + 0.05, 0.3, bx, 0, z0 + 0.42, 'a'),
        part('skirt', bl - 1.2, W - 0.25, 0.62, bx, 0, 0.55, 'd')
      ];
      if (o.power && nose) out.push(part('louv', bl - 3, W + 0.04, 0.6, bx - 1, 0, z0 + 1.2, 'd'));
      else {
        out.push(part('win', bl - 2.4, W + 0.04, 0.78, bx, 0, z0 + 1.45, 'g', 'm'));
        const nw = Math.max(3, Math.floor((bl - 3.4) / 1.8));
        for (let i = 0; i < nw; i++) out.push(part('w' + i, 1.2, W + 0.04, 0.78, bx - ((nw - 1) * 1.8) / 2 + i * 1.8, 0, z0 + 1.45, 'g', 'f'));
      }
      out.push(part('dr1', 1.1, W + 0.05, 2.0, bx + bl / 2 - 1.8, 0, z0 + 1.0, 'd', 'f'), part('dr2', 1.1, W + 0.05, 2.0, bx - bl / 2 + 1.8, 0, z0 + 1.0, 'd', 'f'));
      if (o.nobogie) out.push(part('mskirt', bl, W + 0.3, 0.9, bx, 0, 0.5, 'd'));
      else { out.push.apply(out, bogie('b1', bx + bl * 0.3, W)); out.push.apply(out, bogie('b2', bx - bl * 0.3, W)); }
      if (pan) pantograph(bx, H - 0.2).forEach(function (q) { out.push(q); });
      if (nose) {
        const n = o.steps || 5, sl = nose / n;
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n, w = W * (1 - o.nw * Math.pow(t, 1.6)), h = bh * (1 - o.nh * Math.pow(t, 1.3));
          out.push(part('n' + i, sl + 0.02, w, h, L / 2 - nose + (i + 0.5) * sl, 0, z0 + h / 2, 'p'));
        }
        const tw = 0.3, hw = bh * (1 - o.nh * Math.pow(tw, 1.3));      // windscreen sits on the sloping top of the nose
        out.push(part('ws', nose * 0.3, W * 0.6, 0.5, L / 2 - nose + nose * tw, 0, z0 + hw - 0.1, 'g', undefined, 0.16));
        [1, -1].forEach(function (s) { out.push(part('hl' + s, 0.14, 0.4, 0.2, L / 2 + 0.04, s * 0.35, z0 + 0.5, 'h', 'f')); });
      }
      return out;
    }
    // defines key+'H' (head), key+'M' (middle), key+'P' (middle with pantograph), key+'T' (tail)
    function hsSet(key, o) {
      const Lh = o.Lh || o.L;
      unit(key + 'H', Lh, o.W, o.H, 'front', hsCar(o, Lh, o.nose, o.panH));
      unit(key + 'T', Lh, o.W, o.H, 'rear', flipX(hsCar(o, Lh, o.nose, false)));
      unit(key + 'M', o.L, o.W, o.H, 'none', hsCar(o, o.L, 0, false));
      unit(key + 'P', o.L, o.W, o.H, 'none', hsCar(o, o.L, 0, true));
    }
    function hsLazy(key, o) { lazyDef(UNIT, [key + 'H', key + 'M', key + 'P', key + 'T'], function () { hsSet(key, o); }); }
    hsLazy('n700', { L: 25, Lh: 27.35, W: 3.36, H: 3.65, nose: 10.7, steps: 6, nw: 0.72, nh: 0.5, panH: false });
    hsLazy('e7', { L: 25, Lh: 27.35, W: 3.38, H: 3.65, nose: 9.1, steps: 6, nw: 0.7, nh: 0.5 });
    hsLazy('cr400', { L: 25, Lh: 26.5, W: 3.36, H: 4.0, nose: 9.0, steps: 6, nw: 0.65, nh: 0.45 });
    hsLazy('tgv', { L: 18.7, Lh: 22.15, W: 2.9, H: 4.1, nose: 6.0, steps: 5, nw: 0.55, nh: 0.3, power: true, panH: true });
    hsLazy('ice3', { L: 25.8, Lh: 25.8, W: 2.95, H: 3.89, nose: 7.0, steps: 5, nw: 0.6, nh: 0.45, panH: true });
    hsLazy('frecce', { L: 26.1, Lh: 26.1, W: 2.83, H: 3.9, nose: 8.2, steps: 6, nw: 0.75, nh: 0.5 });
    hsLazy('ave', { L: 24, Lh: 25, W: 2.95, H: 3.9, nose: 7.5, steps: 5, nw: 0.7, nh: 0.55 });
    hsLazy('ktx', { L: 22, Lh: 22, W: 2.95, H: 3.95, nose: 7.0, steps: 5, nw: 0.65, nh: 0.45 });
    hsLazy('c395', { L: 20, Lh: 20.8, W: 2.78, H: 3.78, nose: 3.2, steps: 3, nw: 0.45, nh: 0.4 });
    hsLazy('acela', { L: 20.5, Lh: 20.7, W: 3.05, H: 3.9, nose: 6.5, steps: 5, nw: 0.5, nh: 0.35, power: true });
    hsLazy('maglev', { L: 24.3, Lh: 26.5, W: 3.7, H: 4.0, nose: 5.0, steps: 4, nw: 0.6, nh: 0.4, nobogie: true });
    // diesel-electric passenger locomotive (Siemens Charger): raked cab, sloped nose
    lazyDef(UNIT, ['charger'], function () {
      const o = [
        part('frame', 22, 2.9, 0.9, 0, 0, 1.3, 'd'),
        part('body', 18, 3.05, 2.5, -2, 0, 3.0, 'p'),
        part('stripe', 20, 3.1, 0.5, -1, 0, 2.2, 'a'),
        part('roof', 17.5, 2.6, 0.3, -2.2, 0, 4.4, 'm'),
        part('vent', 4.5, 2.2, 0.35, -7, 0, 4.65, 'd'),
        part('nose1', 2.0, 3.0, 2.3, 8.0, 0, 2.9, 'p'),
        part('nose2', 2.0, 2.9, 1.7, 10.0, 0, 2.6, 'p'),
        part('ws', 1.6, 2.4, 0.5, 7.4, 0, 3.9, 'g', undefined, 0.3),
        part('cabwin', 3.0, 3.08, 0.8, 5.2, 0, 3.7, 'g'),
        part('hl1', 0.14, 0.45, 0.3, 11.05, 0.8, 2.75, 'h', 'f'), part('hl2', 0.14, 0.45, 0.3, 11.05, -0.8, 2.75, 'h', 'f'),
        part('dl1', 0.14, 0.3, 0.25, 11.05, 1.2, 1.5, 'h', 'f'), part('dl2', 0.14, 0.3, 0.25, 11.05, -1.2, 1.5, 'h', 'f')
      ];
      o.push.apply(o, bogie('b1', 6.4, 3.0)); o.push.apply(o, bogie('b2', -6.4, 3.0));
      unit('charger', 22, 3.05, 4.7, 'front', o);
    });
    // steam locomotives (engine + tender): key+'E' engine, key+'T' tender
    function steamSet(key, o) {
      const L = o.EL, W = o.W, D = o.D, z = 1.5 + D / 2, bl = L - o.cabL - 1.3, bx = -L / 2 + o.cabL + bl / 2;
      const e = [
        part('frame', L, W - 0.5, 0.5, 0, 0, 1.15, 'd'),
        part('boiler', bl, D, D, bx, 0, z, 'p'),
        part('smoke', 1.8, D + 0.1, D + 0.1, L / 2 - 1.1, 0, z, 'd'),
        part('rboard', bl + 2, W, 0.14, bx - 1, 0, 1.55 + D * 0.55, 'a'),
        part('beam', 0.3, W, 0.5, L / 2 + 0.1, 0, 1.0, 'a'),
        part('cab', o.cabL, W, o.cabH, -L / 2 + o.cabL / 2 + 0.1, 0, 1.4 + o.cabH / 2, 'p'),
        part('cabroof', o.cabL + 0.5, W + 0.2, 0.15, -L / 2 + o.cabL / 2, 0, 1.4 + o.cabH + 0.08, 'd'),
        part('cabwin', o.cabL * 0.55, W + 0.04, 0.8, -L / 2 + o.cabL / 2 + 0.2, 0, 1.4 + o.cabH * 0.62, 'g'),
        part('hl', 0.3, 0.5, 0.45, L / 2 - 0.2, 0, z + D * 0.45, 'h', 'f')
      ];
      if (o.shroud) {       // streamlined casing (A4): wedge nose, valances over the wheels, tiny chimney
        const n = 4, sl = 3.2 / n;
        for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; e.push(part('sn' + i, sl + 0.02, (D + 0.3) * (1 - 0.5 * t * t), D * (1 - 0.35 * t), L / 2 + 0.6 - 3.2 + (i + 0.5) * sl, 0, 1.5 + D * (1 - 0.35 * t) / 2 + 0.05, 'p')); }
        e.push(part('val', L * 0.62, W + 0.04, 0.9, 0.5, 0, 1.4, 'p'));
        e.push(part('stack', 0.5, 0.5, 0.35, L / 2 - 2.6, 0, 1.5 + D + 0.1, 'd'));
      } else {
        e.push(part('stack', 0.7, 0.7, o.stackH, L / 2 - 1.1, 0, 1.5 + D + o.stackH / 2 - 0.2, 'd'));
        e.push(part('dome', 1.0, 1.0, 0.7, bx + 1, 0, 1.5 + D + 0.2, 'm', 'f'));
        e.push(part('dome2', 0.8, 0.8, 0.5, bx - 2, 0, 1.5 + D + 0.1, 'm', 'f'));
      }
      const dw = o.dw;
      o.drivers.forEach(function (x, i) {
        [1, -1].forEach(function (s) { e.push(part('dw' + i + (s > 0 ? 'a' : 'b'), dw, 0.2, dw, x, s * (W / 2 - 0.1), dw / 2, 'd')); });
      });
      const dx = o.drivers.reduce(function (a, b) { return a + b; }, 0) / o.drivers.length;
      [1, -1].forEach(function (s) {
        e.push(part('rod' + s, Math.abs(o.drivers[o.drivers.length - 1] - o.drivers[0]) + 0.6, 0.06, 0.12, dx, s * (W / 2 + 0.05), dw * 0.5, 'm', 'f'));
        e.push(part('cyl' + s, 2.4, 0.6, 0.6, L / 2 - 3.6, s * (W / 2 - 0.2), 1.1, 'd', 'f'));
      });
      (o.pilot || []).forEach(function (x, i) { [1, -1].forEach(function (s) { e.push(part('pw' + i + (s > 0 ? 'a' : 'b'), 0.9, 0.16, 0.9, x, s * (W / 2 - 0.3), 0.45, 'd')); }); });
      unit(key + 'E', L, W, 1.5 + D + 1.1, 'front', e);
      const TL = o.TL, t = [
        part('frame', TL, W - 0.5, 0.5, 0, 0, 1.0, 'd'),
        part('tank', TL - 0.4, W - 0.1, 1.7, 0, 0, 2.0, 'p'),
        part('coal', TL * 0.7, W - 0.9, 0.7, 0.8, 0, 3.1, 'd'),
        part('band', TL - 0.4, W, 0.2, 0, 0, 2.7, 'a'),
        part('tl1', 0.12, 0.4, 0.26, -TL / 2 - 0.05, 0.9, 1.5, 'r', 'f'), part('tl2', 0.12, 0.4, 0.26, -TL / 2 - 0.05, -0.9, 1.5, 'r', 'f')
      ];
      t.push.apply(t, bogie('b1', TL * 0.28, W)); t.push.apply(t, bogie('b2', -TL * 0.28, W));
      unit(key + 'T', TL, W, 3.5, 'rear', t);
    }
    function steamLazy(key, o) { lazyDef(UNIT, [key + 'E', key + 'T'], function () { steamSet(key, o); }); }
    steamLazy('bigboy', { EL: 24, TL: 16.4, W: 3.3, D: 3.1, cabL: 4.0, cabH: 3.4, stackH: 1.3, dw: 1.7, drivers: [-9, -7.3, -5.6, -3.9, 0.2, 1.9, 3.6, 5.3], pilot: [9.2, 10.6, -11] });
    steamLazy('mallard', { EL: 12.5, TL: 8.8, W: 2.85, D: 2.0, cabL: 2.6, cabH: 3.0, stackH: 0.6, dw: 2.0, drivers: [-1.7, 0.4, 2.5], pilot: [4.7], shroud: true });
    steamLazy('scots', { EL: 12.2, TL: 9.2, W: 2.85, D: 2.0, cabL: 2.6, cabH: 3.0, stackH: 0.9, dw: 2.0, drivers: [-1.7, 0.4, 2.5], pilot: [4.5] });
    // luxury / scenic train cars
    lazyDef(UNIT, ['glacH', 'glacM', 'glacT'], function () {
      unit('glacH', 18, 2.7, 3.5, 'front', railcar({ L: 18, W: 2.7, H: 3.5, front: true, noac: true }));
      unit('glacM', 18, 2.7, 3.5, 'none', railcar({ L: 18, W: 2.7, H: 3.5, noac: true }));
      unit('glacT', 18, 2.7, 3.5, 'rear', railcar({ L: 18, W: 2.7, H: 3.5, rear: true, noac: true }));
    });
    lazyDef(UNIT, ['pullman', 'pullmanEnd'], function () {
      unit('pullman', 22, 2.9, 3.9, 'none', railcar({ L: 22, W: 2.9, H: 3.9, noac: true }));
      unit('pullmanEnd', 22, 2.9, 3.9, 'rear', railcar({ L: 22, W: 2.9, H: 3.9, rear: true, noac: true }));
    });

    // pal = colours of the whole train, acc = stripe colour, v = cruising speed m/s, n = middle units, lead = extra units right behind the head
    const RARE_TRAINS = [
      { id: 'n700s', name: 'Shinkansen N700S', tier: 'rare', region: ['japan'], hs: 1, head: 'n700H', mid: ['n700M', 'n700M', 'n700P'], tail: 'n700T', n: [12, 14], pal: ['#f2f4f8'], acc: ['#1f4aa8'], v: 75 },
      { id: 'e7', name: 'Shinkansen E7', tier: 'rare', region: ['japan'], hs: 1, head: 'e7H', mid: ['e7M', 'e7M', 'e7P'], tail: 'e7T', n: [10, 12], pal: ['#eef0f2'], acc: ['#b8863a'], v: 72 },
      { id: 'maglev', name: 'Shanghai Maglev', tier: 'rare', region: ['shanghai_maglev'], hs: 1, minLen: 250, head: 'maglevH', mid: ['maglevM'], tail: 'maglevT', n: [4, 5], pal: ['#e8f0f6'], acc: ['#27a9e1'], v: 85 },
      { id: 'cr400', name: 'CR400 Fuxing', tier: 'rare', region: ['china'], hs: 1, head: 'cr400H', mid: ['cr400M', 'cr400M', 'cr400P'], tail: 'cr400T', n: [6, 14], pal: ['#eef0f2'], acc: ['#c9a227'], v: 78 },
      { id: 'tgv', name: 'TGV', tier: 'rare', region: ['france'], hs: 1, head: 'tgvH', mid: ['tgvM'], tail: 'tgvT', n: [8, 10], pal: ['#c9ced6'], acc: ['#23408f'], v: 78 },
      { id: 'ice3', name: 'ICE 3', tier: 'rare', region: ['germany'], hs: 1, head: 'ice3H', mid: ['ice3M', 'ice3M', 'ice3P'], tail: 'ice3T', n: [6, 6], pal: ['#f4f4f4'], acc: ['#d4001a'], v: 68 },
      { id: 'frecce', name: 'Frecciarossa 1000', tier: 'rare', region: ['italy'], hs: 1, head: 'frecceH', mid: ['frecceM'], tail: 'frecceT', n: [6, 6], pal: ['#d0d3d8'], acc: ['#c8102e'], v: 75 },
      { id: 'ave', name: 'AVE', tier: 'rare', region: ['spain'], hs: 1, head: 'aveH', mid: ['aveM'], tail: 'aveT', n: [6, 8], pal: ['#f2f2f4'], acc: ['#1b2a5b'], v: 72 },
      { id: 'ktx', name: 'KTX', tier: 'rare', region: ['korea'], hs: 1, head: 'ktxH', mid: ['ktxM'], tail: 'ktxT', n: [8, 8], pal: ['#f0f2f5'], acc: ['#1f4e9c'], v: 72 },
      { id: 'c395', name: 'Class 395 Javelin', tier: 'rare', region: ['uk'], hs: 1, minLen: 200, head: 'c395H', mid: ['c395M'], tail: 'c395T', n: [4, 4], pal: ['#e8eaee'], acc: ['#1f3d8f'], v: 52 },
      { id: 'acela', name: 'Amtrak Acela', tier: 'rare', region: ['nec'], head: 'acelaH', mid: ['acelaM'], tail: 'acelaT', n: [5, 6], pal: ['#d4d8de'], acc: ['#1f4e9c'], v: 55 },
      { id: 'charger', name: 'Amtrak ALC-42 Charger', tier: 'uncommon', region: ['usa'], head: 'charger', mid: ['coach'], tail: 'coachEnd', n: [3, 6], pal: ['#c8ccd2'], acc: ['#1f4e9c'], v: 30 },
      { id: 'bnsf', name: 'BNSF ES44AC', tier: 'uncommon', region: ['us_west'], head: 'loco', lead: ['loco', 'loco'], mid: ['boxcar', 'tank', 'hopper', 'containerA', 'containerB', 'containerC', 'doubleA'], tail: 'boxcarEnd', n: [10, 20], pal: ['#e8650a'], acc: ['#1b1b1b'], mix: true, v: 21 },
      { id: 'up', name: 'Union Pacific SD70ACe', tier: 'uncommon', region: ['us_west'], head: 'loco', lead: ['loco'], mid: ['boxcar', 'tank', 'hopper', 'containerA', 'containerB', 'containerC', 'doubleA'], tail: 'boxcarEnd', n: [10, 20], pal: ['#f2c200'], acc: ['#7a7f87'], mix: true, v: 21 },
      { id: 'vsoe', name: 'Venice Simplon-Orient-Express', tier: 'veryrare', region: ['alps'], head: 'loco', mid: ['pullman'], tail: 'pullmanEnd', n: [8, 11], pal: ['#12295c'], acc: ['#c9a227'], v: 32 },
      { id: 'glacier', name: 'Glacier Express', tier: 'veryrare', region: ['swiss'], cls: ['narrow_gauge'], minLen: 150, head: 'glacH', mid: ['glacM'], tail: 'glacT', n: [5, 7], pal: ['#c8102e'], acc: ['#f2f2f2'], v: 13 },
      { id: 'bigboy', name: 'Union Pacific Big Boy', tier: 'legendary', region: ['bigboy'], minLen: 300, head: 'bigboyE', lead: ['bigboyT'], mid: ['coach'], tail: 'coachEnd', n: [8, 12], pal: ['#1b1b1b'], acc: ['#d4a017'], hex: { coach: '#d8b43a', coachEnd: '#d8b43a' }, v: 22 },
      { id: 'mallard', name: 'LNER Mallard', tier: 'legendary', region: ['uk'], minLen: 250, head: 'mallardE', lead: ['mallardT'], mid: ['coach'], tail: 'coachEnd', n: [5, 8], pal: ['#1d5ea8'], acc: ['#e8dcb8'], hex: { coach: '#6b3f1e', coachEnd: '#6b3f1e' }, v: 28 },
      { id: 'scotsman', name: 'Flying Scotsman', tier: 'legendary', region: ['uk'], minLen: 250, head: 'scotsE', lead: ['scotsT'], mid: ['coach'], tail: 'coachEnd', n: [5, 8], pal: ['#2a6b3a'], acc: ['#e8dcb8'], hex: { coach: '#6b3f1e', coachEnd: '#6b3f1e' }, v: 24 }
    ].map(function (d) { d.cat = 'rail'; d.cls = d.cls || ['rail']; d.spd = 1; return d; });

    /* ---- cruise ships ---- */
    // name, lat, lon, area (a ship only sails where its line goes)
    const PORTS = [['Miami', 25.774, -80.17, 'carib'], ['Port Everglades', 26.089, -80.113, 'carib'], ['Port Canaveral', 28.41, -80.62, 'carib'], ['Tampa', 27.945, -82.45, 'carib'],
      ['Galveston', 29.31, -94.79, 'carib'], ['New Orleans', 29.935, -90.065, 'carib'], ['Nassau', 25.078, -77.352, 'carib'], ['Cozumel', 20.509, -86.953, 'carib'],
      ['Grand Cayman', 19.296, -81.383, 'carib'], ['St Thomas', 18.336, -64.931, 'carib'], ['San Juan', 18.466, -66.106, 'carib'], ['Cartagena', 10.42, -75.55, 'carib'],
      ['Jacksonville', 30.39, -81.43, 'us_east'], ['Charleston', 32.78, -79.92, 'us_east'], ['Baltimore', 39.268, -76.583, 'us_east'], ['New York', 40.7665, -74.0017, 'us_east'],
      ['Cape Liberty', 40.6435, -74.0555, 'us_east'], ['Boston', 42.3465, -71.031, 'us_east'],
      ['Barcelona', 41.3515, 2.1805, 'med'], ['Civitavecchia', 42.0915, 11.7885, 'med'], ['Naples', 40.842, 14.261, 'med'], ['Genoa', 44.409, 8.925, 'med'], ['Venice', 45.435, 12.315, 'med'],
      ['Marseille', 43.32, 5.35, 'med'], ['Palma', 39.56, 2.63, 'med'], ['Valencia', 39.45, -0.32, 'med'], ['Piraeus', 37.94, 23.635, 'med'], ['Dubrovnik', 42.66, 18.09, 'med'],
      ['Southampton', 50.896, -1.417, 'nweur'], ['Hamburg', 53.54, 9.97, 'nweur'], ['Copenhagen', 55.69, 12.6, 'nweur'], ['Stockholm', 59.32, 18.1, 'nweur'], ['Tallinn', 59.444, 24.762, 'nweur'],
      ['Kiel', 54.33, 10.15, 'nweur'], ['Rotterdam', 51.906, 4.48, 'nweur'], ['Amsterdam', 52.383, 4.9, 'nweur'], ['Bergen', 60.397, 5.32, 'nweur'], ['Lisbon', 38.705, -9.165, 'nweur'], ['Reykjavik', 64.155, -21.94, 'nweur'],
      ['Seattle', 47.61, -122.355, 'alaska'], ['Vancouver', 49.29, -123.11, 'alaska'], ['Juneau', 58.297, -134.41, 'alaska'], ['Ketchikan', 55.34, -131.64, 'alaska'], ['Skagway', 59.45, -135.32, 'alaska'],
      ['Los Angeles', 33.735, -118.28, 'us_west'], ['San Diego', 32.715, -117.175, 'us_west'], ['San Francisco', 37.81, -122.41, 'us_west'], ['Honolulu', 21.31, -157.87, 'hawaii'],
      ['Sydney', -33.857, 151.213, 'aus'], ['Brisbane', -27.4, 153.1, 'aus'], ['Auckland', -36.84, 174.77, 'aus'],
      ['Singapore', 1.264, 103.82, 'asia'], ['Hong Kong', 22.3, 114.17, 'asia'], ['Shanghai', 31.392, 121.5, 'asia'], ['Yokohama', 35.45, 139.65, 'asia'], ['Kobe', 34.65, 135.2, 'asia'], ['Busan', 35.1, 129.04, 'asia'],
      ['Dubai', 25.27, 55.28, 'me'], ['Abu Dhabi', 24.53, 54.38, 'me'], ['Cape Town', -33.91, 18.43, 'safrica'], ['Rio de Janeiro', -22.89, -43.18, 'samer'], ['Buenos Aires', -34.58, -58.37, 'samer']
    ].map(function (r) { return { n: r[0], lat: r[1], lon: r[2], g: r[3] }; });
    const PORT_R = 20000;      // ships only appear within this distance of a cruise port
    // ---- cruise ships ----
    // A shaped hull (pointed bow in plan view, sheer, tapered stern), a stack of deck slices whose dark balcony bands run along both sides,
    // decks that step back at the bow (raked front) and the stern (terraces), orange lifeboats, funnels, bridge wings and class-specific
    // extras. Window glow strips for the night are saved on the model and drawn with the lights.
    // o: L W fb dr (hull) | aft fore (x of the lowest deck's ends) n (decks) hd (deck height) | rake rakeFrom (front steps back per deck) |
    // aftStep aftFrom (stern steps forward per deck) | narrow [fromDeck, perDeck] | notch {x0,x1,from,wing} (split aft block, Oasis) |
    // bridge (deck index of the bridge wings) | lb [x0, x1, colour] | funnels [{x,y,l,w,h,k,band,cap}] | extras [l,w,h,x,y,colour,lod,lift]
    function cruise(name, o) {
      const L = o.L, W = o.W, fb = o.fb, dr = o.dr, hd = o.hd || 3.1, n = o.n;
      const out = [], glow = [];
      const bowX = L * 0.28, sternX = -L * 0.40, sh = o.sheer || 3.4;
      const sheer = function (x) { return sh * Math.pow(Math.max(0, (x + L / 2) / L), 3.5); };
      const wf = function (x) {       // beam as a fraction of W at this x: full in the middle, pointed bow, narrower transom
        if (x > bowX) { const t = Math.min(1, (x - bowX) / (L / 2 - bowX)); return Math.max(0.04, Math.pow(1 - Math.pow(t, 1.9), 0.75)); }
        if (x < sternX) { const t = (sternX - x) / (L / 2 + sternX); return 1 - 0.26 * Math.pow(t, 1.4); }
        return 1;
      };
      // ---- hull slices
      const xb = [];
      for (let i = 0; i <= 3; i++) xb.push(-L / 2 + (sternX + L / 2) * i / 3);
      for (let i = 1; i <= 5; i++) xb.push(sternX + (bowX - sternX) * i / 5);
      for (let i = 1; i <= 10; i++) xb.push(bowX + (L / 2 - bowX) * (1 - Math.pow(1 - i / 10, 1.5)));
      out.push(part('hullLow', L * 0.78, W - 0.4, dr, -L * 0.07, 0, -dr / 2 + 0.2, 'x1'));
      for (let i = 0; i < xb.length - 1; i++) {
        const x0 = xb[i], x1 = xb[i + 1], xc = (x0 + x1) / 2, l = x1 - x0 + 0.15;
        const w = W * wf(x0 >= bowX ? x0 + (x1 - x0) * 0.35 : xc);
        const top = fb + sheer(xc), hh = top - 0.4;
        out.push(part('hu' + i, l, w, hh, xc, 0, 0.4 + hh / 2, 'p'));
        out.push(part('hs' + i, l + 0.05, w + 0.12, 0.55, xc, 0, 0.9, 'a'));
        if (x0 > o.fore - 2) out.push(part('fk' + i, l, w * 0.86, 0.3, xc, 0, top + 0.15, 'm'));        // forecastle deck
      }
      out.push(part('sk', o.aft + L / 2, W * 0.84, 0.3, (o.aft - L / 2) / 2, 0, fb + 0.15, 'm'));        // open stern deck
      out.push(part('port', L * 0.58, W + 0.14, 0.5, -L * 0.02, 0, fb * 0.55 + 0.4, 'd', 'f'));        // row of portholes
      for (let x = -L * 0.3; x < L * 0.27; x += 18) [1, -1].forEach(function (s) { glow.push({ l: 1.3, w: 0.3, h: 0.9, x: x, y: s * (W / 2 + 0.2), z: fb * 0.55 + 0.4, c: '#ffe0a0' }); });
      if (o.art) {                                                      // painted hull (Breakaway)
        const ks = ['x1', 'x3', 'x2', 'x4', 'x1', 'x3', 'x2'];
        for (let i = 0; i < 7; i++) [1, -1].forEach(function (s) { out.push(part('art' + i + (s > 0 ? 'a' : 'b'), 9, 0.3, 4.2 - (i % 3), L * 0.05 + i * 10.5, s * (W / 2 + 0.05), 4.2 + (i % 3) * 0.6, ks[i], 'f')); });
      }
      // ---- decks
      const decks = [];
      for (let i = 0; i < n; i++) {
        const xa = o.aft + Math.max(0, i - (o.aftFrom === undefined ? 99 : o.aftFrom) + 1) * (o.aftStep || 0);
        const xf = o.fore - Math.max(0, i - (o.rakeFrom === undefined ? 99 : o.rakeFrom) + 1) * (o.rake || 0);
        const w = (i === 0 ? W - 5.4 : W - 0.9) - (o.narrow ? Math.max(0, i - o.narrow[0] + 1) * o.narrow[1] : 0);
        decks.push({ xa: xa, xf: Math.max(xf, xa + 20), w: Math.max(w, 10), z0: fb + i * hd });
      }
      const levelAt = function (x) {
        let lvl = fb;
        for (let i = 0; i < n; i++) if (x >= decks[i].xa && x <= decks[i].xf) lvl = decks[i].z0 + hd;
        return lvl;
      };
      decks.forEach(function (d, i) {
        const l = d.xf - d.xa, xc = (d.xa + d.xf) / 2, z0 = d.z0;
        const nt = (o.notch && i >= o.notch.from) ? o.notch : null;
        const box = function (tag, xa, xb2, y, w) { if (xb2 - xa > 2) out.push(part('d' + i + tag, xb2 - xa, w, hd, (xa + xb2) / 2, y, z0 + hd / 2, 'k')); };
        if (!nt) box('a', d.xa, d.xf, 0, d.w);
        else {
          const ww = nt.wing, wy = d.w / 2 - ww / 2;
          box('a', d.xa, Math.min(d.xf, nt.x0), 0, d.w);
          box('b', Math.max(d.xa, nt.x0), Math.min(d.xf, nt.x1), wy, ww); box('c', Math.max(d.xa, nt.x0), Math.min(d.xf, nt.x1), -wy, ww);
          box('d', Math.max(d.xa, nt.x1), d.xf, 0, d.w);
        }
        if (i >= (o.balc === undefined ? 1 : o.balc)) {
          const bh = hd * 0.58, zb = z0 + hd * 0.5, gk = o.glass || 'g';
          [1, -1].forEach(function (s) { out.push(part('bs' + i + (s > 0 ? 'a' : 'b'), l - 1, 0.5, bh, xc, s * (d.w / 2 - 0.1), zb, gk)); });
          out.push(part('bf' + i, 0.5, d.w - 4, bh, d.xf - 0.1, 0, zb, gk));
          let k = 0;
          for (let x = d.xa + 3; x < d.xf - 8; x += 36, k++) {                    // lit cabins at night, a few dark ones
            if ((i * 7 + k * 3) % 11 === 0) continue;
            const ln = Math.min(32, d.xf - 3 - x);
            [1, -1].forEach(function (s) { glow.push({ l: ln, w: 0.3, h: bh * 0.72, x: x + ln / 2, y: s * (d.w / 2 + 0.2), z: zb, c: (k + i) % 3 ? '#ffd27a' : '#ffe6b0' }); });
          }
          glow.push({ l: 0.3, w: d.w - 6, h: bh * 0.72, x: d.xf + 0.3, y: 0, z: zb, c: '#ffdc90' });
        }
      });
      const topZ = fb + n * hd;
      // ---- lifeboats
      if (o.lb) for (let x = o.lb[0], k = 0; x <= o.lb[1]; x += 11.5, k++) [1, -1].forEach(function (s) {
        out.push(part('lb' + k + (s > 0 ? 'a' : 'b'), 8.8, 2.5, 2.4, x, s * (W / 2 - 1.5), fb + 1.3, o.lb[2] || 'x6', 'f'));
        glow.push({ l: 8.8, w: 0.3, h: 0.5, x: x, y: s * (W / 2 - 0.1), z: fb + 2.1, c: '#ffd27a' });
      });
      // ---- bridge wings
      const bd = decks[Math.min(n - 1, o.bridge === undefined ? n - 3 : o.bridge)];
      out.push(part('wing', 7, W + 3.2, 2.4, bd.xf - 4.5, 0, bd.z0 + hd * 0.55, 'k'));
      out.push(part('wingg', 0.4, W + 1, 1.1, bd.xf - 0.8, 0, bd.z0 + hd * 0.75, 'g'));
      // ---- funnels
      (o.funnels || []).forEach(function (f, j) {
        const z = levelAt(f.x), y = f.y || 0;
        out.push(part('fn' + j, f.l, f.w, f.h, f.x, y, z + f.h / 2, f.k || 'k'));
        if (f.band) out.push(part('fnb' + j, f.l + 0.1, f.w + 0.1, f.h * 0.2, f.x, y, z + f.h * 0.66, f.band));
        out.push(part('fnc' + j, f.l * 0.96, f.w * 0.96, f.h * 0.13, f.x, y, z + f.h * 0.94, f.cap || 'd'));
      });
      // ---- extras (placed on the highest deck under them)
      (o.extras || []).forEach(function (e, i) { out.push(part('ex' + i, e[0], e[1], e[2], e[3], e[4], levelAt(e[3]) + e[2] / 2 + (e[7] || 0), e[5], e[6])); });
      const mx = decks[n - 1].xf - 4;
      out.push(part('mast', 0.8, 0.8, 10, mx, 0, topZ + 5, 'm', 'f'), part('radar', 0.4, 4, 0.4, mx, 0, topZ + 10.2, 'd', 'f'));
      // ---- wake and bow wave (shorter than before, widening astern)
      out.push(part('wk0', L * 0.18, W * 0.85, 0.05, -L * 0.59, 0, 0.06, 'k', 'f'), part('wk1', L * 0.2, W * 0.55, 0.05, -L * 0.78, 0, 0.06, 'k', 'f'), part('wk2', L * 0.22, W * 0.3, 0.05, -L * 0.99, 0, 0.06, 'k', 'f'));
      [1, -1].forEach(function (s) { const bx = bowX + (L / 2 - bowX) * 0.55; out.push(part('bw' + (s > 0 ? 'a' : 'b'), L * 0.1, 1.5, 0.7, bx, s * (W * wf(bx) / 2 + 0.6), 0.45, 'k', 'f')); });
      tierFine(out);
      let H = 0;
      out.forEach(function (q) { H = Math.max(H, q.at[2] + q.d[2] / 2); });
      SHIP[name] = { name: name, L: L, W: W, H: H, cx: 0, w: 0, heavy: false, spd: o.spd || 2.0, pal: o.pal, lit: 'boat', acc: 0.3, dec: 1.0, parts: out, glow: glow,
        nav: { x: bd.xf - 3, y: W / 2 + 1.6, z: bd.z0 + hd * 0.9, mx: mx, mz: topZ + 10.8, sz: fb + 5 } };
      SHIP[name].accHex = o.acc;       // (not .acc: that is the ship's acceleration)
    }
    const WHITE = ['#f4f6f8'];
    const CRUISE = [
      { id: 'oasis', name: 'Royal Caribbean Oasis class', tier: 'rare', groups: ['carib', 'med', 'nweur', 'us_east'], o: { L: 362, W: 47, fb: 13, dr: 9.3, hd: 3.2, pal: WHITE, acc: '#1f3d8f',
        aft: -146, fore: 98, n: 12, rake: 2.4, rakeFrom: 6, aftStep: 9, aftFrom: 4, narrow: [10, 6], bridge: 8, lb: [-110, 70, 'x6'],
        notch: { x0: -146, x1: -40, from: 4, wing: 15 },
        funnels: [{ x: -48, y: 8, l: 13, w: 8, h: 12, band: 'x2' }, { x: -48, y: -8, l: 13, w: 8, h: 12, band: 'x2' }],
        extras: [[7, 7, 14, -125, 17, 'x1'], [7, 7, 11, -125, -17, 'x3'], [4.6, 4.6, 4.6, 20, 8, 'k', 'f'], [4.6, 4.6, 4.6, 20, -8, 'k', 'f'], [30, 16, 3, 30, 0, 'k'], [26, 14, 1, 30, 0, 'g', null, 3]] } },
      { id: 'icon', name: 'Royal Caribbean Icon class', tier: 'veryrare', groups: ['carib'], o: { L: 365, W: 48, fb: 13, dr: 9.3, hd: 3.2, pal: WHITE, acc: '#1f3d8f',
        aft: -150, fore: 100, n: 12, rake: 2.8, rakeFrom: 5, aftStep: 8, aftFrom: 4, narrow: [10, 6], bridge: 8, lb: [-110, 70, 'x6'],
        funnels: [{ x: -20, l: 10, w: 7, h: 6 }],
        extras: [[34, 30, 3, 56, 0, 'k'], [28, 24, 9, 56, 0, 'g', null, 3], [8, 8, 20, -100, 12, 'x1'], [8, 8, 16, -100, -12, 'x3'], [8, 8, 24, -82, 0, 'x2'], [4.6, 4.6, 4.6, 10, 10, 'k', 'f']] } },
      { id: 'quantum', name: 'Royal Caribbean Quantum class', tier: 'uncommon', groups: ['asia', 'aus', 'us_east', 'carib', 'alaska'], o: { L: 348, W: 41.4, fb: 12, dr: 8.8, pal: WHITE, acc: '#1f3d8f',
        aft: -140, fore: 94, n: 11, rake: 3.6, rakeFrom: 2, aftStep: 7.5, aftFrom: 6, narrow: [8, 6.5], bridge: 7, lb: [-95, 60, 'x6'],
        funnels: [{ x: -62, l: 14, w: 9, h: 9, band: 'a' }],
        extras: [[2.6, 2.6, 34, -26, 0, 'm'], [4, 4, 1.5, -26, 0, 'k', 'f', 0.5], [8.5, 8.5, 5, -26, 0, 'g', null, 34], [4.6, 4.6, 4.6, 30, 6, 'k', 'f'], [4.6, 4.6, 4.6, 30, -6, 'k', 'f'], [20, 12, 0.4, -75, 0, 'x2', 'f']] } },
      { id: 'prima', name: 'Norwegian Prima class', tier: 'rare', groups: ['carib', 'alaska', 'nweur', 'us_east'], o: { L: 294, W: 41.8, fb: 11, dr: 8.2, pal: WHITE, acc: '#1d4f9a',
        aft: -118, fore: 80, n: 11, rake: 3, rakeFrom: 3, aftStep: 6, aftFrom: 6, narrow: [9, 6], bridge: 7, lb: [-75, 50, 'x1'],
        funnels: [{ x: -72, l: 12, w: 8, h: 10, k: 'x7', band: 'k' }],
        extras: [[10, 8, 5, -40, 0, 'x2', 'f'], [4.6, 4.6, 4.6, 20, 7, 'k', 'f'], [4.6, 4.6, 4.6, 20, -7, 'k', 'f']] } },
      { id: 'breakaway', name: 'Norwegian Breakaway class', tier: 'uncommon', groups: ['carib', 'us_east', 'nweur', 'alaska'], o: { L: 324, W: 39.7, fb: 11, dr: 8.3, pal: WHITE, acc: '#2a5aa0', art: true,
        aft: -130, fore: 88, n: 12, rake: 3.2, rakeFrom: 5, aftStep: 6, aftFrom: 7, narrow: [10, 5], bridge: 8, lb: [-100, 55, 'x1'], glass: 'g',
        funnels: [{ x: -88, l: 14, w: 10, h: 9, k: 'x7', cap: 'd', band: 'x2' }],
        extras: [[6, 6, 12, -100, 6, 'x3', 'f'], [8, 3, 6, -106, -6, 'x1', 'f'], [6, 6, 10, -112, -2, 'x2', 'f'], [14, 10, 5, -96, 0, 'x1', 'f'], [4.6, 4.6, 4.6, 30, 6, 'k', 'f']] } },
      { id: 'mscworld', name: 'MSC World class', tier: 'rare', groups: ['carib', 'med', 'me'], o: { L: 333, W: 47, fb: 12, dr: 9, pal: WHITE, acc: '#0b2a5b',
        aft: -122, fore: 92, n: 12, rake: 2.2, rakeFrom: 7, aftStep: 8, aftFrom: 3, narrow: [10, 6], bridge: 8, lb: [-60, 70, 'x6'],
        funnels: [{ x: -34, l: 18, w: 10, h: 8, band: 'x7' }],
        extras: [[38, 24, 4, 40, 0, 'k'], [36, 22, 4, 40, 0, 'g', null, 4], [4.6, 4.6, 4.6, 10, 10, 'k', 'f'], [4.6, 4.6, 4.6, 10, -10, 'k', 'f']] } },
      { id: 'meraviglia', name: 'MSC Meraviglia class', tier: 'rare', groups: ['med', 'carib', 'nweur', 'safrica', 'samer', 'me'], o: { L: 316, W: 43, fb: 12, dr: 8.6, pal: ['#14306e'], acc: '#f2f2f2',
        aft: -125, fore: 86, n: 11, rake: 3.4, rakeFrom: 3, aftStep: 6.5, aftFrom: 6, narrow: [9, 6], bridge: 7, lb: [-80, 50, 'x6'],
        funnels: [{ x: -70, l: 16, w: 10, h: 10, band: 'x7' }],
        extras: [[4.6, 4.6, 4.6, 20, 8, 'k', 'f'], [4.6, 4.6, 4.6, 20, -8, 'k', 'f'], [14, 10, 3, -30, 0, 'x2', 'f']] } },
      { id: 'excel', name: 'Carnival Excel class', tier: 'uncommon', groups: ['carib', 'us_west', 'us_east', 'aus'], o: { L: 344, W: 42, fb: 12, dr: 8.7, pal: WHITE, acc: '#1f4e9c',
        aft: -138, fore: 94, n: 12, rake: 3, rakeFrom: 4, aftStep: 6, aftFrom: 7, narrow: [10, 5], bridge: 8, lb: [-100, 60, 'x6'],
        funnels: [{ x: -70, l: 14, w: 12, h: 10, k: 'x1', band: 'x2' }],
        extras: [[130, 3, 1.2, -5, 0, 'x1', 'f', 10], [2, 2, 10, -60, 0, 'x5', 'f'], [2, 2, 10, -10, 0, 'x5', 'f'], [2, 2, 10, 40, 0, 'x5', 'f'], [4, 2.5, 1.5, -20, 0, 'x3', 'f', 11.5], [4.6, 4.6, 4.6, 40, 8, 'k', 'f']] } },
      { id: 'celebrity', name: 'Celebrity Edge class', tier: 'uncommon', groups: ['carib', 'med', 'alaska', 'aus'], o: { L: 306, W: 39, fb: 11, dr: 8.1, pal: WHITE, acc: '#0b2a5b',
        aft: -122, fore: 84, n: 11, rake: 3, rakeFrom: 4, aftStep: 6, aftFrom: 6, narrow: [9, 6], bridge: 7, lb: [-80, 50, 'x6'], glass: 'g',
        funnels: [{ x: -62, l: 12, w: 8, h: 9, k: 'x7', band: 'k' }],
        extras: [[10, 6, 1.2, 0, 21, 'x7', null, -14], [4.6, 4.6, 4.6, 20, 7, 'k', 'f'], [4.6, 4.6, 4.6, 20, -7, 'k', 'f']] } },
      { id: 'disney', name: 'Disney Wish class', tier: 'veryrare', groups: ['carib', 'med', 'nweur'], o: { L: 341, W: 38, fb: 12, dr: 8.4, pal: ['#12295c'], acc: '#f2c200',
        aft: -132, fore: 92, n: 11, rake: 3.4, rakeFrom: 4, aftStep: 6, aftFrom: 6, narrow: [9, 6], bridge: 7, lb: [-95, 55, 'x6'],
        funnels: [{ x: -44, l: 12, w: 9, h: 11, k: 'x1', band: 'a', cap: 'd' }, { x: -76, l: 12, w: 9, h: 11, k: 'x1', band: 'a', cap: 'd' }],
        extras: [[36, 2, 2, -60, 0, 'x1', 'f', 14], [4.6, 4.6, 4.6, 20, 6, 'k', 'f'], [14, 12, 3, 60, 0, 'x1', 'f']] } },
      { id: 'virgin', name: 'Virgin Voyages Lady ship', tier: 'rare', groups: ['carib', 'med', 'aus', 'nweur'], o: { L: 278, W: 38, fb: 10, dr: 7.5, pal: ['#cfd3d8'], acc: '#c8102e',
        aft: -105, fore: 76, n: 12, rake: 2.6, rakeFrom: 6, aftStep: 5, aftFrom: 8, narrow: [10, 5], bridge: 8, lb: [-65, 45, 'x1'],
        extras: [[24, 20, 6, -60, 0, 'x1'], [14, 12, 3, -60, 0, 'd', null, 6], [18, 30, 3.5, 45, 0, 'x1'], [4.6, 4.6, 4.6, -20, 8, 'k', 'f']] } },
      { id: 'qm2', name: 'Queen Mary 2', tier: 'veryrare', groups: ['us_east', 'nweur', 'med'], o: { L: 345, W: 41, fb: 15, dr: 10, hd: 3.2, sheer: 5.5, spd: 2.2, pal: ['#16181c'], acc: '#c8102e',
        aft: -150, fore: 62, n: 9, rake: 3.5, rakeFrom: 4, aftStep: 9, aftFrom: 5, narrow: [7, 6], bridge: 5, lb: [-110, 40, 'x6'],
        funnels: [{ x: -30, l: 24, w: 13, h: 20, k: 'x1', band: 'k', cap: 'd' }],
        extras: [[4.6, 4.6, 4.6, 20, 8, 'k', 'f'], [30, 2.4, 1.2, -90, 0, 'x2', 'f']] } }
    ].map(function (d) {
      d.cat = 'boat'; d.rw = d.rw || 1; d.sname = 'cr_' + d.id;
      lazyDef(SHIP, [d.sname], function () { cruise(d.sname, d.o); });
      return d;
    });
    let portCache = { t: 0, list: [] };
    function portsNear() {          // ports within reach of the player (re-checked every few seconds)
      if (Date.now() - portCache.t < 4000) return portCache.list;
      const p = playerPos(), reach = cfg.radiusKm * 1000 + PORT_R;
      portCache = { t: Date.now(), list: PORTS.filter(function (q) { return distM(p.lat, p.lon, q.lat, q.lon) < reach; }) };
      return portCache.list;
    }

    /* ---- the roll: called by the normal spawners; null = spawn something ordinary ---- */
    function rollRare(kind, way) {
      if (!cfg.rare || cfg.rareFreq <= 0) return null;
      const m = way.pts[way.pts.length >> 1];
      if (kind === 'road') {
        if (!cfg.rareCars || !SUPER_CLS[way.cls] || !roomFor('road', 'veryrare')) return null;
        const w = wealth(m[0], m[1]);
        const boost = {};
        Object.keys(MAKER_HOME).forEach(function (k) { const h = MAKER_HOME[k], d = distM(m[0], m[1], h[0], h[1]) / 50000; boost[k] = d < 3 ? 1 + 6 * Math.exp(-d * d) : 1; });
        const d = rollPick(SUPER, SUPER.map(function (s) { return rareP('road', s) * w * boost[s.maker]; }));
        if (!d || rareNear(d.id, m[0], m[1], RARE_SEP.road)) return null;
        return { type: superType(d), info: { id: d.id, name: d.name, tier: d.tier, cat: 'road', acc: null } };
      }
      if (kind === 'rail') {
        if (!cfg.rareTrains) return null;
        const defs = RARE_TRAINS.filter(function (d) {
          return roomFor('rail', d.tier) && d.cls.indexOf(way.cls) >= 0 && way.len >= (d.minLen || 150) && d.region.some(function (r) { return inRegion(r, m[0], m[1]); }) && (!d.hs || way.hs || gentle(way));
        });
        if (!defs.length) return null;
        const d = rollPick(defs, defs.map(function (s) { return rareP('rail', s); }));
        if (!d || rareNear(d.id, m[0], m[1], RARE_SEP.rail)) return null;
        return { spec: d, info: { id: d.id, name: d.name, tier: d.tier, cat: 'rail' } };
      }
      if (kind === 'boat') {
        if (!cfg.rareShips) return null;
        const ports = portsNear();
        if (!ports.length) return null;                       // not near any cruise port: nothing to decide
        const groups = {}; ports.forEach(function (q) { groups[q.g] = 1; });
        const defs = CRUISE.filter(function (d) { return roomFor('boat', d.tier) && d.groups.some(function (g) { return groups[g]; }); });
        const d = rollPick(defs, defs.map(function (s) { return rareP('boat', s); }));
        if (!d) return null;
        for (let t = 0; t < 40; t++) {       // a fairway or ferry route close to a port the ship sails from
          const w = pickWay('boat');
          if (!w || (w.cls !== 'fairway' && w.cls !== 'ferry')) continue;
          const mm = w.pts[w.pts.length >> 1];
          if (!ports.some(function (q) { return d.groups.indexOf(q.g) >= 0 && distM(mm[0], mm[1], q.lat, q.lon) < PORT_R; })) continue;
          if (rareNear(d.id, mm[0], mm[1], RARE_SEP.boat)) return null;
          return { way: w, type: SHIP[d.sname], info: { id: d.id, name: d.name, tier: d.tier, cat: 'boat' } };
        }
      }
      return null;
    }
    function rareList() {       // "name x2, name" of the rare vehicles alive right now
      const n = {};
      cars.forEach(function (c) { if (c.rare) n[c.rare.name] = (n[c.rare.name] || 0) + 1; });
      return Object.keys(n).map(function (k) { return k + (n[k] > 1 ? ' x' + n[k] : ''); }).join(', ');
    }
    /* (RARE-END) */

    // ---- Pools of 3D models, created on demand and reused for whichever cars are nearest ----
    // Level 0 = full model (per type), level 1 = no small details (per type),
    // level 2 = one coloured rectangle scaled to the vehicle's size (shared by all types).
    const POOL_DETAIL = 25, POOL_MEDIUM = 80, POOL_RECT = 2000;
    const carAppearance = new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true });
    const pools = {};
    const allPrims = [];
    const cand = [];                // cars close enough for a 3D model this frame
    const scratchT = new Cesium.Cartesian3();
    const scratchS = new Cesium.Cartesian3();

    function poolFor(type, lod) {
      const key = lod === 2 ? 'rect' : type.name + lod;      // (pools are flushed when the detail level changes)
      let pool = pools[key];
      if (!pool) {
        pool = pools[key] = { key: key, lod: lod, type: type, all: [], free: [],
          max: lod === 0 ? POOL_DETAIL : lod === 1 ? POOL_MEDIUM : POOL_RECT };
      }
      return pool;
    }

    // Detail levels: Low = simple models everywhere, Regular = full models without the tiniest details of trains and boats
    // (cars unchanged), High = everything. The simplified model (distance level 1) is the same on all three.
    function partsFor(type, lod) {
      const L = cfg.detail;
      return type.parts.filter(function (q) {
        if (lod === 0 && L !== 'low') return q.lod !== 'm' && (q.lod !== 'e' || L === 'high');
        return q.lod !== 'f' && q.lod !== 'e';
      });
    }
    // switching the detail level: throw away every built model so they are rebuilt with the new parts
    function flushPools() {
      cars.forEach(function (c) { releasePrim(c); if (c.units) c.units.forEach(releasePrim); });
      Object.keys(pools).forEach(function (k) {
        pools[k].all.forEach(function (p) { try { viewer.scene.primitives.remove(p); } catch (e) { /* already gone */ } });
        delete pools[k];
      });
      allPrims.length = 0;
    }
    function buildPrim(pool) {
      let parts;
      if (pool.lod === 2) parts = [{ id: 'body', d: [1, 1, 1], at: [0, 0, 0.5], k: 'p', pitch: 0 }];
      else parts = partsFor(pool.type, pool.lod);
      const instances = parts.map(function (q) {
        return new Cesium.GeometryInstance({
          id: q.id,
          geometry: Cesium.BoxGeometry.fromDimensions({
            dimensions: new Cesium.Cartesian3(q.d[0], q.d[1], q.d[2]),
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
          }),
          modelMatrix: q.pitch
            ? Cesium.Matrix4.fromTranslationQuaternionRotationScale(new Cesium.Cartesian3(q.at[0], q.at[1], q.at[2]),
                Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Y, q.pitch), new Cesium.Cartesian3(1, 1, 1))
            : Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(q.at[0], q.at[1], q.at[2])),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor((q.k === 'p' || q.k === 'a') ? Cesium.Color.LIGHTGRAY : KIND_COLOR[q.k]) }
        });
      });
      const prim = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: carAppearance,
        asynchronous: true,
        releaseGeometryInstances: false,   // keep them so each car can be repainted
        allowPicking: false,
        show: false,
        modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)
      });
      prim.paintIds = parts.filter(function (q) { return q.k === 'p' || q.k === 'a'; }).map(function (q) { return q.id; });
      prim.pool = pool;
      prim.car = null;
      prim.paintFor = -1;
      prim.parts = parts;
      prim.shadeFor = 1;      // built with daylight colours
      return prim;
    }

    // Colours follow the time of day: every part is darkened by shadeQ (lamps stay bright), like GeoFS's own night.
    const scratchCol = new Cesium.Color(), scratchU8 = new Uint8Array(4);
    function paintPart(p, q, car, k) {
      const base = q.k === 'p' ? car.color : q.k === 'a' ? car.accent : KIND_COLOR[q.k];
      const f = (q.k === 'h' || q.k === 'r') ? 1 : k;
      scratchCol.red = base.red * f; scratchCol.green = base.green * f; scratchCol.blue = base.blue * f; scratchCol.alpha = 1;
      p.getGeometryInstanceAttributes(q.id).color = Cesium.ColorGeometryInstanceAttribute.toValue(scratchCol, scratchU8);
    }
    function paintAll(p, car) {
      for (let j = 0; j < p.parts.length; j++) paintPart(p, p.parts[j], car, shadeQ);
      p.paintFor = car.id; p.shadeFor = shadeQ;
    }
    let repaintBudget = 0;

    function acquire(pool) {
      let p = pool.free.pop();
      if (p) return p;
      if (pool.all.length >= (pool.lod === 2 ? cfg.maxDrawn : pool.max)) return null;
      p = buildPrim(pool);
      viewer.scene.primitives.add(p);
      pool.all.push(p);
      allPrims.push(p);
      return p;
    }

    function releasePrim(car) {
      const p = car.prim;
      if (!p) return;
      p.show = false;
      p.car = null;
      car.prim = null;
      p.pool.free.push(p);
    }

    // ---- Night light beams: bright translucent 3D streaks, one small primitive per nearby car ----
    // Headlights throw a long white streak plus a faint pool on the road; taillights leave a short red one.
    // Seen from altitude they are stretched with distance so they still read as light trails.
    const beamAppearance = new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false });
    const beamPools = {};
    const allBeams = [];
    function beamParts(t) {
      const fx = t.L / 2 + t.cx, rx = -t.L / 2 + t.cx;          // front and rear ends of the vehicle
      const y = t.W / 2 - 0.35;
      const col = function (hex, a) { const c = Cesium.Color.fromCssColorString(hex); c.alpha = a; return c; };
      const defs = [];
      if (t.lit === 'boat') {       // navigation lights: red port, green starboard, white mast and stern (+ lit windows on cruise ships)
        const nv = t.nav, s = nv ? Math.min(1.8, Math.max(0.8, t.L / 150)) : Math.max(0.6, t.L / 50);
        const bx = nv ? nv.x : fx - t.L * 0.12, ny = nv ? nv.y : t.W * 0.4, nz = nv ? nv.z : t.H * 0.45;
        defs.push({ l: s, w: s, h: s, x: bx, y: ny, z: nz, col: col('#ff2020', 1) });
        defs.push({ l: s, w: s, h: s, x: bx, y: -ny, z: nz, col: col('#20ff50', 1) });
        defs.push({ l: s, w: s, h: s, x: nv ? nv.mx : fx - t.L * 0.3, y: 0, z: nv ? nv.mz : t.H + s, col: col('#ffffff', 1) });
        defs.push({ l: s, w: s, h: s, x: rx + (nv ? 3 : t.L * 0.04), y: 0, z: nv ? nv.sz : t.H * 0.7, col: col('#ffffff', 1) });
        if (t.glow) t.glow.forEach(function (g) { defs.push({ l: g.l, w: g.w, h: g.h, x: g.x, y: g.y, z: g.z, col: col(g.c, 1) }); });
        return defs;
      }
      const front = t.lit !== 'rear', rear = t.lit !== 'front';
      const lampZ = (t.lit === 'both' || !t.lit) ? 0.65 : 1.6;
      [1, -1].forEach(function (sd) {
        if (front) {
          defs.push({ l: 0.25, w: 0.5, h: 0.28, x: fx, y: sd * y, z: lampZ, col: col('#fffbe8', 1) });        // headlamp glow
          defs.push({ l: 14, w: 0.4, h: 0.16, x: fx + 7, y: sd * y, z: lampZ - 0.05, col: col('#fff6d8', 0.6) });     // long white streak
        }
        if (rear) {
          defs.push({ l: 0.25, w: 0.5, h: 0.28, x: rx, y: sd * y, z: lampZ + 0.05, col: col('#ff2020', 1) });         // tail lamp glow
          defs.push({ l: 3, w: 0.4, h: 0.16, x: rx - 1.5, y: sd * y, z: lampZ + 0.05, col: col('#ff2a2a', 0.65) });     // short red streak
        }
      });
      if (front) defs.push({ l: 10, w: 2.4, h: 0.04, x: fx + 5, y: 0, z: 0.12, col: col('#ffe9a6', 0.16) });        // headlight pool on the ground
      if (rear) defs.push({ l: 4, w: 2.0, h: 0.04, x: rx - 2, y: 0, z: 0.12, col: col('#ff3030', 0.14) });        // red glow on the ground
      return defs;
    }
    function buildBeamPrim(pool) {
      const instances = beamParts(pool.type).map(function (q, i) {
        return new Cesium.GeometryInstance({
          id: 'b' + i,
          geometry: Cesium.BoxGeometry.fromDimensions({
            dimensions: new Cesium.Cartesian3(q.l, q.w, q.h),
            vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT
          }),
          modelMatrix: Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(q.x, q.y, q.z)),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(q.col) }
        });
      });
      const prim = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: beamAppearance,
        asynchronous: true,
        releaseGeometryInstances: true,
        allowPicking: false,
        show: false,
        modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)
      });
      prim.pool = pool;
      prim.car = null;
      return prim;
    }
    function acquireBeam(type) {
      let pool = beamPools[type.name];
      if (!pool) pool = beamPools[type.name] = { all: [], free: [], type: type, max: 400 };
      let p = pool.free.pop();
      if (p) return p;
      if (pool.all.length >= pool.max) return null;
      p = buildBeamPrim(pool);
      viewer.scene.primitives.add(p);
      pool.all.push(p);
      allBeams.push(p);
      return p;
    }
    function releaseBeam(car) {
      const b = car.beam;
      if (!b) return;
      b.show = false;
      b.car = null;
      car.beam = null;
      b.pool.free.push(b);
    }
    function applyBloom() {
      try {
        const b = viewer.scene.postProcessStages.bloom;
        if (cfg.bloom) {
          b.uniforms.glowOnly = false; b.uniforms.contrast = 128; b.uniforms.brightness = -0.3;
          b.uniforms.delta = 1; b.uniforms.sigma = 2; b.uniforms.stepSize = 1;
          b.enabled = true;
        } else if (bloomOn) { b.enabled = false; }
        bloomOn = !!cfg.bloom;
      } catch (e) { /* bloom not available in this build */ }
    }
    let bloomOn = false;

    function validDirs(way, i) {
      const out = [];
      if (i < way.pts.length - 1) out.push(1);
      if (!way.oneway && i > 0) out.push(-1);
      return out;
    }

    // Each car picks its own lane: right-hand traffic, offset from the road's centreline.
    function assignLane(car) {
      const w = car.way, n = w.lanes || 1, k = (Math.random() * n) | 0;
      car.laneOff = w.oneway ? (k - (n - 1) / 2) * 3.4 : 1.7 + k * 3.4;   // metres to the right of travel
    }

    function setSeg(car) {
      const w = car.way;
      const a = w.pts[car.i], b = w.pts[car.i + car.dir];
      car.a = a; car.b = b;
      car.segLen = Math.max(distM(a[0], a[1], b[0], b[1]), 0.5);
      car.hdg = bearing(a[0], a[1], b[0], b[1]);
      car.s = 0;
    }

    function speedFor(way, car) {
      const j = 0.8 + Math.random() * 0.4;
      if (way.kind === 'rail') return (way.ms ? way.ms * 0.9 : RAIL_SPEED[way.cls] || 20) * (car.cspd || 1) * j;
      if (way.kind === 'boat') return (WATER_SPEED[way.cls] || 6) * car.type.spd * j;
      return ROAD_SPEED[way.cls] * car.type.spd * j;
    }
    // Trains and boats cannot turn sharply: they only continue onto a connected track / route that leaves
    // within about 57 degrees, and are removed at a dead end (a new one appears somewhere else).
    function arriveGuided(car, w, atEnd, entries) {
      const cands = [];
      for (let k = 0; k < entries.length; k++) {
        const e = entries[k];
        if (e.way === w || e.way.kind !== w.kind) continue;
        const dirs = validDirs(e.way, e.i);
        for (let m = 0; m < dirs.length; m++) {
          const a = e.way.pts[e.i], b = e.way.pts[e.i + dirs[m]];
          const df = bearing(a[0], a[1], b[0], b[1]) - car.hdg;
          if (Math.abs(Math.atan2(Math.sin(df), Math.cos(df))) < 1.0) cands.push({ e: e, d: dirs[m] });
        }
      }
      if (cands.length && (atEnd || Math.random() < 0.5)) {
        const c = cands[(Math.random() * cands.length) | 0];
        car.way = c.e.way; car.i = c.e.i; car.dir = c.d;
        car.speed = speedFor(c.e.way, car);
        setSeg(car);
        return true;
      }
      if (atEnd) return false;
      setSeg(car);
      return true;
    }

    // Called when a car reaches the end of a segment. Snap-turns onto a connected road at junctions.
    function arrive(car) {
      const w = car.way;
      const vi = car.i + car.dir;
      car.i = vi;
      const atEnd = vi === 0 || vi === w.pts.length - 1;
      const entries = nodeIndex.get(w.nodes[vi]) || [];
      if (car.kind !== 'road') return arriveGuided(car, w, atEnd, entries);
      const cands = entries.filter(function (e) { return e.way !== w && e.way.kind === 'road' && validDirs(e.way, e.i).length; });
      if (cands.length && (atEnd || Math.random() < 0.35)) {
        const e = cands[(Math.random() * cands.length) | 0];
        const dirs = validDirs(e.way, e.i);
        car.way = e.way;
        car.i = e.i;
        car.dir = dirs[(Math.random() * dirs.length) | 0];
        car.speed = speedFor(e.way, car);
        assignLane(car);
        car.v = Math.min(car.v, 6);   // slow down for the turn
        setSeg(car);
        return true;
      }
      if (atEnd) {
        if (w.oneway) return false;      // dead end on a one-way: remove car
        car.dir = -car.dir;
        car.v = Math.min(car.v, 3);
      }
      setSeg(car);
      return true;
    }

    // Light points are pooled and only given to cars that are actually drawn (night), so a huge car count
    // does not mean tens of thousands of point primitives.
    const freeHead = [], freeTail = [], pointCars = new Set();
    function takePoints(car) {
      if (car.ptHead) return;
      car.ptHead = freeHead.pop() || lightPoints.add({ position: Cesium.Cartesian3.ZERO, pixelSize: 3.6, color: COL_HEAD, scaleByDistance: SCALE_LIGHT, show: false });
      car.ptTail = freeTail.pop() || lightPoints.add({ position: Cesium.Cartesian3.ZERO, pixelSize: 3.0, color: COL_TAIL, scaleByDistance: SCALE_LIGHT, show: false });
      pointCars.add(car);
    }
    function freePoints(car) {
      if (!car.ptHead) return;
      car.ptHead.show = false; car.ptTail.show = false;
      freeHead.push(car.ptHead); freeTail.push(car.ptTail);
      car.ptHead = car.ptTail = null;
      pointCars.delete(car);
    }
    function placePoints(car, ho) {
      const off = car.type.L * 0.5;
      const lz = 0.5 + car.type.H * 0.2;
      const dLat = off * Math.cos(car.hdg) / 111320;
      const dLon = off * Math.sin(car.hdg) / (111320 * Math.cos(car.lat * D2R));
      Cesium.Cartesian3.fromDegrees(car.lon + dLon, car.lat + dLat, car.h + ho + lz, undefined, scratchB);
      Cesium.Cartesian3.fromDegrees(car.lon - dLon, car.lat - dLat, car.h + ho + lz, undefined, scratchC);
      const lit = car.type.lit || 'both';
      car.ptHead.position = scratchB; car.ptHead.show = lit !== 'rear';
      car.ptTail.position = scratchC; car.ptTail.show = lit !== 'front';
    }

    // Cars inside the radius that are beyond the drawn limit appear as tiny coloured dots (one cheap pooled point each),
    // so the whole area looks alive and not just a bubble around you.
    const dotColl = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    const freeDots = [], dotCars = new Set();
    function takeDot(car) {
      if (car.dot) return;
      car.dot = freeDots.pop() || dotColl.add({ position: Cesium.Cartesian3.ZERO, pixelSize: 3, color: car.color, scaleByDistance: SCALE_BODY, show: false });
      dotCars.add(car);
    }
    function freeDot(car) {
      if (!car.dot) return;
      car.dot.show = false;
      freeDots.push(car.dot);
      car.dot = null;
      dotCars.delete(car);
    }
    function placeDot(car, ho) {
      Cesium.Cartesian3.fromDegrees(car.lon, car.lat, car.h + ho + 0.8, undefined, scratchB);
      car.dot.position = scratchB; car.dot.show = true;
    }

    function spawnCar() {
      const way = pickWay();
      if (!way) return false;
      const rr = rollRare('road', way);
      const type = rr ? rr.type : pickType(way.cls);
      const car = {
        id: carId++, kind: 'road', way: way, i: 0, dir: 1, s: 0, segLen: 1, hdg: 0, a: null, b: null,
        type: type, v: 0, tv: 0, brakeUntil: 0, prog: 0, front: type.L / 2, back: type.L / 2, acc: 2, dec: 7, laneOff: 0,
        speed: ROAD_SPEED[way.cls] * type.spd * (0.8 + Math.random() * 0.4),
        lat: 0, lon: 0, h: null,
        color: Cesium.Color.fromCssColorString(type.pal[(Math.random() * type.pal.length) | 0]),
        accent: Cesium.Color.fromCssColorString(ACCENTS[(Math.random() * ACCENTS.length) | 0]),
        ht: null, hOK: 0, gt: 0, dtAcc: 0, vis: false, bw: false, prim: null, beam: null, primLod: -1, wl: 2, d: 0, want: -1, rare: null
      };
      if (rr) { car.rare = rr.info; if (type.accHex) car.accent = Cesium.Color.fromCssColorString(type.accHex); }
      car.i = (Math.random() * (way.pts.length - 1)) | 0;
      car.dir = way.oneway ? 1 : (Math.random() < 0.5 ? 1 : -1);
      if (car.dir === -1 && car.i === 0) car.dir = 1;
      setSeg(car);
      car.s = Math.random() * car.segLen;
      assignLane(car);
      car.v = car.tv = car.speed;
      poseCar(car);
      car.ptHead = car.ptTail = null;     // light points are handed out only to cars that are drawn at night
      sampleGround(car);
      cars.push(car);
      kindCount.road++;
      return true;
    }

    // ---- shared helpers for trains and boats ----
    function newVehicle(way, type, kind, hex) {
      return {
        id: carId++, kind: kind, way: way, i: 0, dir: 1, s: 0, segLen: 1, hdg: 0, a: null, b: null,
        type: type, v: 0, tv: 0, brakeUntil: 0, prog: 0, front: type.L / 2, back: type.L / 2, acc: type.acc || 2, dec: type.dec || 7, laneOff: 0,
        speed: 0, cspd: 1, lat: 0, lon: 0, h: null, color: Cesium.Color.fromCssColorString(hex),
        accent: Cesium.Color.fromCssColorString(ACCENTS[(Math.random() * ACCENTS.length) | 0]),
        ht: null, hOK: 0, gt: 0, dtAcc: 0, vis: false, bw: false, prim: null, beam: null, primLod: -1, wl: 2, d: 0, want: -1,
        ptHead: null, ptTail: null, dot: null, units: null, trail: null, trav: 0, lastPush: 0, off: 0, rare: null
      };
    }
    function disposeVehicle(car) {
      freePoints(car);
      freeDot(car);
      releasePrim(car);
      releaseBeam(car);
    }
    // the way's segment that contains distance a along it
    function segAt(way, a) {
      const c = way.cum;
      let lo = 0, hi = c.length - 2;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m] <= a) lo = m; else hi = m - 1; }
      return lo;
    }
    function pointAlong(way, a, out) {
      const j = segAt(way, a), c = way.cum, sl = c[j + 1] - c[j];
      const f = sl > 0 ? Math.max(0, Math.min(1, (a - c[j]) / sl)) : 0;
      out.lat = way.pts[j][0] + (way.pts[j + 1][0] - way.pts[j][0]) * f;
      out.lon = way.pts[j][1] + (way.pts[j + 1][1] - way.pts[j][1]) * f;
      return out;
    }
    function heightAlong(way, a) {
      const th = way.th;
      if (!th) return undefined;
      const j = segAt(way, a), c = way.cum, sl = c[j + 1] - c[j];
      const f = sl > 0 ? Math.max(0, Math.min(1, (a - c[j]) / sl)) : 0;
      if (th[j] === undefined || th[j + 1] === undefined) return undefined;
      return th[j] + (th[j + 1] - th[j]) * f;
    }
    // puts a vehicle at distance `along` the way, heading in direction dir
    function placeOnWay(car, along) {
      const w = car.way, j = segAt(w, along);
      if (car.dir === 1) { car.i = j; setSeg(car); car.s = along - w.cum[j]; }
      else { car.i = j + 1; setSeg(car); car.s = w.cum[j + 1] - along; }
      car.s = Math.max(0, Math.min(car.segLen, car.s));
    }

    // ---- trains: one simulated head plus trailing units that follow the head's exact path ----
    // true when another train / boat of the same kind is already within `r` metres of (lat, lon): do not spawn on top of it
    function crowded(kind, lat, lon, r) {
      const kx = 111320 * Math.cos(lat * D2R);
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        if (c.kind !== kind) continue;
        const dx = (c.lon - lon) * kx, dy = (c.lat - lat) * 110540;
        if (dx * dx + dy * dy < r * r) return true;
        if (c.units && c.back > r) {      // a long train: also check along its length
          const tr = c.trail;
          for (let t = tr.length - 1; t >= 0; t -= 6) {
            const ex = (tr[t].lon - lon) * kx, ey = (tr[t].lat - lat) * 110540;
            if (ex * ex + ey * ey < r * r) return true;
          }
        }
      }
      return false;
    }
    function spawnTrain() {
      const way = pickWay('rail');
      if (!way) return false;
      const rr = rollRare('rail', way);
      const spec = rr ? rr.spec : pickConsist(way.cls);
      const n = spec.n[0] + ((Math.random() * (spec.n[1] - spec.n[0] + 1)) | 0);
      const names = [spec.head].concat(spec.lead || []);
      const keep = names.length;
      for (let k = 0; k < n; k++) names.push(spec.mid[(Math.random() * spec.mid.length) | 0]);
      if (spec.tail && n > 0) names.push(spec.tail);
      const GAP = 0.8;
      const lengthOf = function () { let t = 0; names.forEach(function (nm) { t += UNIT[nm].L + GAP; }); return t; };
      while (names.length > 1 && lengthOf() > way.len - 6) names.splice(names.length > keep + 1 ? keep : names.length - 1, 1);
      const base = spec.pal[(Math.random() * spec.pal.length) | 0];
      const head = newVehicle(way, UNIT[names[0]], 'rail', base);
      head.cspd = spec.spd;
      head.speed = speedFor(way, head);
      if (rr) { head.rare = rr.info; head.speed = spec.v * (0.9 + Math.random() * 0.2); head.accent = Cesium.Color.fromCssColorString(spec.acc[(Math.random() * spec.acc.length) | 0]); }
      head.dir = Math.random() < 0.5 ? 1 : -1;
      head.units = []; head.trail = [];
      let pos = head.type.L / 2;
      for (let k = 1; k < names.length; k++) {
        const ut = UNIT[names[k]];
        const u = newVehicle(way, ut, 'rail', k < keep ? base : (spec.hex && spec.hex[names[k]]) || (spec.mix ? PAL_WAGON[(Math.random() * PAL_WAGON.length) | 0] : base));
        pos += GAP + ut.L / 2;
        u.off = pos;
        u.accent = head.accent;
        pos += ut.L / 2;
        head.units.push(u);
      }
      head.back = pos;
      const lo = head.dir === 1 ? Math.min(pos, way.len - 0.5) : 0.5;
      const hi = head.dir === 1 ? way.len - 0.5 : Math.max(0.5, way.len - pos);
      const along = lo + Math.random() * Math.max(0, hi - lo);
      placeOnWay(head, along);
      head.v = head.tv = head.speed;
      poseCar(head);
      // history behind the head, so the units start on the track and not in a heap
      head.trav = 0;
      const pa = { lat: 0, lon: 0 };
      for (let k = Math.ceil((pos + 8) / 2); k >= 1; k--) {
        const a = along - head.dir * k * 2;
        if (a < 0 || a > way.len) continue;
        pointAlong(way, a, pa);
        head.trail.push({ w: way, a: a, lat: pa.lat, lon: pa.lon, t: -k * 2 });
      }
      head.trail.push({ w: way, a: along, lat: head.lat, lon: head.lon, t: 0 });
      head.lastPush = 0;
      if (crowded('rail', head.lat, head.lon, head.back + 40)) { disposeVehicle(head); head.units.forEach(disposeVehicle); return false; }
      sampleGround(head);
      cars.push(head);
      kindCount.rail++;
      return true;
    }

    // ---- boats ----
    function spawnBoat() {
      let way = pickWay('boat');
      if (!way) return false;
      const rr = rollRare('boat', way);
      if (rr) way = rr.way;
      const type = rr ? rr.type : pickBoatType(way.cls);
      const car = newVehicle(way, type, 'boat', type.pal[(Math.random() * type.pal.length) | 0]);
      if (rr) { car.rare = rr.info; if (type.accHex) car.accent = Cesium.Color.fromCssColorString(type.accHex); }
      car.speed = speedFor(way, car);
      car.i = (Math.random() * (way.pts.length - 1)) | 0;
      car.dir = Math.random() < 0.5 ? 1 : -1;
      if (car.dir === -1 && car.i === 0) car.dir = 1;
      setSeg(car);
      car.s = Math.random() * car.segLen;
      car.laneOff = type.W * 0.5 + 3;      // keep right, so boats going the other way pass beside each other
      car.v = car.tv = car.speed;
      poseCar(car);
      if (crowded('boat', car.lat, car.lon, car.type.L + 60)) { disposeVehicle(car); return false; }
      sampleGround(car);
      cars.push(car);
      kindCount.boat++;
      return true;
    }

    function removeCar(index) {
      const car = cars[index];
      kindCount[car.kind]--;
      disposeVehicle(car);
      if (car.units) car.units.forEach(disposeVehicle);
      car.gone = true;
      cars[index] = cars[cars.length - 1];
      cars.pop();
    }

    function removeAllCars() { for (let k = cars.length - 1; k >= 0; k--) removeCar(k); }

    function poseCar(car) {
      const f = car.s / car.segLen;
      car.lat = car.a[0] + (car.b[0] - car.a[0]) * f;
      car.lon = car.a[1] + (car.b[1] - car.a[1]) * f;
      const o = car.laneOff || 0;
      if (o) {   // shift sideways, to the right of the direction of travel
        car.lat += (-o * Math.sin(car.hdg)) / 111320;
        car.lon += (o * Math.cos(car.hdg)) / (111320 * Math.cos(car.lat * D2R));
      }
    }

    function advance(car, dt) {
      let move = car.v * dt;
      while (move > 0) {
        const rem = car.segLen - car.s;
        if (move < rem) { car.s += move; break; }
        move -= rem;
        if (!arrive(car)) return false;
      }
      poseCar(car);
      return true;
    }

    const carto = new Cesium.Cartographic();
    let terrBudget = 0;
    function sampleGround(car) {
      carto.longitude = car.lon * D2R;
      carto.latitude = car.lat * D2R;
      carto.height = 0;
      let h;
      try { h = viewer.scene.globe.getHeight(carto); } catch (e) { h = undefined; }
      if (h !== undefined && h !== null && isFinite(h)) {
        // Terrain far from the camera is low-detail and its height can be way off until it sharpens.
        // A car only counts as "grounded" once two samples in a row agree; until then it stays hidden.
        if (car.ht === null) { car.ht = h; car.h = h; car.hOK = 0; }
        else {
          if (Math.abs(h - car.ht) < 3) { if (car.hOK < 3) car.hOK++; } else car.hOK = 0;
          car.ht = h;
        }
      }
    }

    // ---- Detailed terrain: asks the terrain provider for its most detailed heights (not the blurry far-away
    // mesh that is currently drawn). Measured once per road vertex in batches, no scene access at all. ----
    let terrainOK = false, detailBusy = 0, detailDone = 0, detailFails = 0;
    try { terrainOK = typeof Cesium.sampleTerrainMostDetailed === 'function' && !!viewer.terrainProvider; } catch (e) { terrainOK = false; }
    function runDetail() {
      if (!terrainOK || detailBusy >= 2) return;
      const p = playerPos();
      const batch = [], pos = [];
      const cap = detailDone < 3000 ? 1200 : 5000;      // first batches are small so the roads around you are measured quickly
      // measure the ground under the roads nearest to you first (main roads before side streets)
      while (pos.length < cap) {
        let best = null, bd = Infinity;
        tiles.forEach(function (t) {
          if (!t.dq || !t.dq.length) return;
          const c = tileCenter(t);
          const d = distM(p.lat, p.lon, c.lat, c.lon) - (t.layer === 'main' || t.layer === 'near' || t.layer === 'vmain' ? 4000 : 0);
          if (d < bd) { bd = d; best = t; }
        });
        if (!best) break;
        const q = best.dq;
        while (q.length && pos.length < cap) {
          const w = q.pop();
          if (w.th) continue;
          batch.push(w);
          for (let i = 0; i < w.pts.length; i++) pos.push(Cesium.Cartographic.fromDegrees(w.pts[i][1], w.pts[i][0]));
        }
      }
      if (!batch.length) { if (!detailBusy && JUMP.ground === null && JUMP.tile !== null) JUMP.ground = Date.now() - JUMP.t0; return; }
      detailBusy++;
      function failed() { detailBusy = Math.max(0, detailBusy - 1); batch.forEach(function (w) { const t = tiles.get(w.tile); if (t && t.dq) t.dq.push(w); }); if (++detailFails >= 3) terrainOK = false; }   // give up: fall back to plain terrain
      let pr;
      try { pr = Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, pos); } catch (e) { pr = null; }
      if (!pr || typeof pr.then !== 'function') { failed(); return; }
      pr.then(function (res) {
        let k = 0;
        batch.forEach(function (w) {
          const th = new Array(w.pts.length);
          for (let i = 0; i < th.length; i++) { const c = res[k++]; th[i] = (c && c.height !== undefined && isFinite(c.height)) ? c.height : undefined; }
          w.th = th;
        });
        detailDone += batch.length; detailFails = 0; detailBusy = Math.max(0, detailBusy - 1);
        if (Date.now() - lastPoolBuild > 1500) poolDirty = true;      // newly measured roads can now get cars
      }).catch(failed);
    }
    function groundFromDetail(car) {
      const w = car.way;
      if (w.tunnel) return;
      const th = w.th;
      if (!th) { car.hOK = 0; return; }            // not measured yet: stay hidden
      const ha = th[car.i], hb = th[car.i + car.dir];
      if (ha === undefined || hb === undefined) { car.hOK = 0; return; }
      car.h = car.ht = ha + (hb - ha) * (car.segLen > 0 ? car.s / car.segLen : 0) + (car.kind === 'boat' ? cfg.waterOffset : 0);
      car.hOK = 1;
    }

    /* ---------------------------------------------------------------- *
     *  NIGHT
     * ---------------------------------------------------------------- */
    let night = false;
    let shadeQ = 1;                  // 1 = full daylight colour; lower = darker (follows the sun, like GeoFS's own night)
    function computeShade() {
      let date;
      try { date = Cesium.JulianDate.toDate(viewer.clock.currentTime); } catch (e) { date = new Date(); }
      const p = playerPos();
      const deg = sunElevation(date, p.lat, p.lon) / D2R;
      const t = Math.max(0, Math.min(1, (deg + 10) / 16));          // fully dark below -10 deg, fully bright above +6 deg
      const k = 1 - (cfg.nightDark / 100) * (1 - t * t * (3 - 2 * t));
      return Math.round(k * 25) / 25;                                 // steps, so a sunset repaints ~20 times, not constantly
    }
    function computeNight() {
      if (cfg.lights === 'on') return true;
      if (cfg.lights === 'off') return false;
      let date;
      try { date = Cesium.JulianDate.toDate(viewer.clock.currentTime); } catch (e) { date = new Date(); }
      const p = playerPos();
      return sunElevation(date, p.lat, p.lon) < -3 * D2R;
    }

    /* ---------------------------------------------------------------- *
     *  PER-FRAME UPDATE (movement + LOD)
     * ---------------------------------------------------------------- */
    let lastT = performance.now();
    let frameNo = 0;
    const hpr = new Cesium.HeadingPitchRoll();

    // ---- Traffic: each car keeps a safe gap to the car ahead in its lane, so one braking car
    // makes everyone behind it slow down, and the jam ripples backwards. Runs 10 times a second. ----
    let followAcc = 0;
    function updateFollowing() {
      const now = performance.now();
      const buckets = new Map();
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        c.tv = c.speed;
        if (c.kind === 'boat' && c.rare) continue;        // cruise ships never wait for little boats (they would sit still forever)
        if (!cfg.followTraffic || !c.way.cum || c.d > (c.kind === 'road' ? 3000 : 25000)) continue;   // jams only matter where you can see them
        const key = c.way.id * 4096 + (c.dir > 0 ? 2048 : 0) + Math.round(c.laneOff * 10) + 700;
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        c.prog = (c.way.cum[c.i] + c.dir * c.s) * c.dir;     // distance travelled in its direction of travel
        b.push(c);
        // now and then a driver brakes for no reason: that is what starts the traffic waves
        if (c.kind === 'road' && now > c.brakeUntil && Math.random() < 0.0003) c.brakeUntil = now + 2500;
        if (now < c.brakeUntil) c.tv = c.speed * 0.35;
      }
      buckets.forEach(function (b) {
        if (b.length < 2) return;
        b.sort(function (x, y) { return x.prog - y.prog; });
        for (let i = 0; i < b.length - 1; i++) {
          const me = b[i], ld = b[i + 1];
          const gap = (ld.prog - ld.back) - (me.prog + me.front);          // bumper to bumper (a train counts as its whole length)
          const safe = me.kind !== 'road' ? brakeSpeed(me, gap, me.kind === 'rail' ? 8 : 16)   // heavy: needs real braking distance
            : (gap <= 3 ? 0 : (gap - 3) / 1.3);                    // cars keep about a 1.3 s gap
          if (safe < me.tv) me.tv = safe;
        }
      });
      if (cfg.followTraffic) spatialFollowing();
    }

    // Trains and boats also watch whatever is physically in front of them, even on another way or on the other side of a
    // junction: a train waits for the one ahead, a ship slows for a boat in its path. Two vehicles meeting head-on cannot
    // pass each other (single track), so the lower one is removed and respawns somewhere else. Cars are not affected.
    // fastest speed from which `me` can still stop within the free gap (trains and ships brake slowly)
    function brakeSpeed(me, gap, margin) {
      const room = gap - margin;
      return room <= 0 ? 0 : Math.sqrt(2 * Math.max(0.3, me.dec * 0.7) * room);
    }
    const SP_CELL = 250;
    function spatialFollowing() {
      const grid = new Map(), list = [];
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        if (c.kind === 'road' || c.d > 25000) continue;
        const kx = 111320 * Math.cos(c.lat * D2R);
        c.sx = c.lon * kx; c.sy = c.lat * 110540;
        const key = (Math.floor(c.sx / SP_CELL) * 100003) + Math.floor(c.sy / SP_CELL);
        let b = grid.get(key); if (!b) { b = []; grid.set(key, b); }
        b.push(c); list.push(c);
      }
      const doomed = [];
      for (let m = 0; m < list.length; m++) {
        const me = list[m];
        const sn = Math.sin(me.hdg), cs = Math.cos(me.hdg);
        const gx = Math.floor(me.sx / SP_CELL), gy = Math.floor(me.sy / SP_CELL);
        const rail = me.kind === 'rail';
        const reach = rail ? 600 : 300, margin = rail ? 8 : 16, side = rail ? 0.7 : 3.5;
        let limit = Infinity, crash = false;
        for (let ax = -2; ax <= 2; ax++) for (let ay = -2; ay <= 2; ay++) {
          const cell = grid.get((gx + ax) * 100003 + gy + ay);
          if (!cell) continue;
          for (let q = 0; q < cell.length; q++) {
            const o = cell[q];
            if (o === me || o.kind !== me.kind) continue;
            const dot = Math.sin(o.hdg) * sn + Math.cos(o.hdg) * cs;
            const wid = (me.type.W + o.type.W) / 2 + side;
            // points along the other vehicle: its centre and tip, and a train's whole length (trail every ~25 m)
            const pts = [[o.sx, o.sy], [o.sx + Math.sin(o.hdg) * o.front, o.sy + Math.cos(o.hdg) * o.front]];
            if (o.trail && o.trail.length) {
              let lastT = Infinity;
              for (let t = o.trail.length - 1; t >= 0; t--) {
                const tp = o.trail[t];
                if (o.trav - tp.t > o.back) break;
                if (lastT - tp.t >= 25 || lastT === Infinity) {
                  const kx2 = 111320 * Math.cos(tp.lat * D2R);
                  pts.push([tp.lon * kx2, tp.lat * 110540]); lastT = tp.t;
                }
              }
            } else if (o.back > o.front) {
              pts.push([o.sx - Math.sin(o.hdg) * o.back * 0.9, o.sy - Math.cos(o.hdg) * o.back * 0.9]);
            }
            for (let i = 0; i < pts.length; i++) {
              const dx = pts[i][0] - me.sx, dy = pts[i][1] - me.sy;
              const along = dx * sn + dy * cs, lat = dx * cs - dy * sn;
              if (along < 0 || along > reach + me.front || Math.abs(lat) > wid) continue;
              const gap = along - me.front;
              if (dot < -0.3) { if (gap < 30) crash = true; continue; }      // coming the other way: handled below
              const safe = brakeSpeed(me, gap, margin);
              if (safe < limit) limit = safe;
            }
          }
        }
        if (crash) { if (!me.crashIn) me.crashIn = 0; me.crashIn++; if (me.crashIn > 8) doomed.push(me); } else me.crashIn = 0;
        if (limit < me.tv && !(me.kind === 'boat' && me.rare)) me.tv = limit;
        // blocked for a very long time (a jam that never clears): take it off the map
        if (limit === 0 && me.v < 0.2) { me.stuck = (me.stuck || 0) + 0.1; if (me.stuck > 40) doomed.push(me); } else me.stuck = 0;
      }
      if (doomed.length) {
        const kill = new Set(doomed);
        for (let k = cars.length - 1; k >= 0; k--) if (kill.has(cars[k])) removeCar(k);
      }
    }

    // Places a car's model / beam primitive. Called when the car moved, or just got a primitive.
    function writeModel(car, p) {
      Cesium.Cartesian3.fromDegrees(car.lon, car.lat, car.h + cfg.heightOffset, undefined, scratchA);
      hpr.heading = car.hdg - Math.PI / 2;     // models face +X (east) at heading 0
      Cesium.Transforms.headingPitchRollToFixedFrame(scratchA, hpr, Cesium.Ellipsoid.WGS84,
        Cesium.Transforms.eastNorthUpToFixedFrame, p.modelMatrix);
      if (p.pool.lod === 2) {
        // the shared unit box is stretched to this vehicle's overall size
        Cesium.Cartesian3.fromElements(car.type.cx, 0, 0, scratchT);
        Cesium.Cartesian3.fromElements(car.type.L, car.type.W, car.type.H, scratchS);
        Cesium.Matrix4.multiplyByTranslation(p.modelMatrix, scratchT, p.modelMatrix);
        Cesium.Matrix4.multiplyByScale(p.modelMatrix, scratchS, p.modelMatrix);
      }
    }
    function writeBeam(car, b) {
      Cesium.Cartesian3.fromDegrees(car.lon, car.lat, car.h + cfg.heightOffset, undefined, scratchA);
      hpr.heading = car.hdg - Math.PI / 2;
      Cesium.Transforms.headingPitchRollToFixedFrame(scratchA, hpr, Cesium.Ellipsoid.WGS84,
        Cesium.Transforms.eastNorthUpToFixedFrame, b.modelMatrix);
      // stretch with distance so they stay visible (about 1.5 px wide) from altitude
      let sw = Math.min(40, Math.max(1, car.d * 0.004));
      let sl = Math.min(4, Math.max(1, car.d * 0.0004));
      if (car.type.lit === 'boat') { sw = sl = car.type.L > 150 ? 1 : Math.min(6, Math.max(1, car.d * 0.001)); }   // big ships keep their real size: scaling would push the lights off the hull   // ships are big: lights grow evenly, not sideways
      Cesium.Cartesian3.fromElements(sl, sw, Math.min(3, sw), scratchS);
      Cesium.Matrix4.multiplyByScale(b.modelMatrix, scratchS, b.modelMatrix);
    }

    // Performance: far cars are updated less often (their motion is under a pixel), only the nearest
    // `maxDrawn` cars get a drawn model, and models are re-assigned every 3rd frame, not every frame.
    const BIN = 250, NBINS = 100;
    const bins = new Int32Array(NBINS + 1);
    const MAX_BEAMS = 300;

    function hideVehicle(u) {
      u.vis = false; u.d = 20000;
      freePoints(u); releasePrim(u); releaseBeam(u);
    }
    function hideUnits(head) { if (head.units) for (let i = 0; i < head.units.length; i++) hideVehicle(head.units[i]); }
    function countUnits(head) { if (head.units) for (let i = 0; i < head.units.length; i++) { const u = head.units[i]; if (u.vis) bins[Math.min(NBINS, (u.d / BIN) | 0)]++; } }

    // Places the trailing units of a train on the path its head has driven.
    function updateTrain(head, ho, camLat, camLon, kx, camH, modelRange) {
      const tr = head.trail, units = head.units;
      if (head.trav - head.lastPush >= 2) {       // remember the head's path every ~2 m
        const a = head.way.cum[head.i] + head.dir * head.s;
        tr.push({ w: head.way, a: a, lat: head.lat, lon: head.lon, t: head.trav });
        head.lastPush = head.trav;
        const keep = head.trav - head.back - 12;
        let cut = 0;
        while (cut < tr.length - 2 && tr[cut + 1].t < keep) cut++;
        if (cut > 0) tr.splice(0, cut);
      }
      const n = tr.length;
      for (let m = 0; m < units.length; m++) {
        const u = units[m];
        const T = head.trav - u.off;
        let j = n - 2;
        while (j > 0 && tr[j].t > T) j--;
        const i0 = Math.max(0, j);
        const p0 = tr[i0], p1 = tr[Math.min(n - 1, i0 + 1)];
        const dt = p1.t - p0.t;
        const f = dt > 1e-6 ? Math.max(0, Math.min(1, (T - p0.t) / dt)) : 0;
        u.lat = p0.lat + (p1.lat - p0.lat) * f;
        u.lon = p0.lon + (p1.lon - p0.lon) * f;
        if (dt > 1e-6 && (p1.lat !== p0.lat || p1.lon !== p0.lon)) u.hdg = bearing(p0.lat, p0.lon, p1.lat, p1.lon);
        let h = heightAlong(p1.w, p1.a);
        if (h === undefined && !terrainOK) h = head.h;     // plain-terrain fallback: follow the head's height
        if (h === undefined) { hideVehicle(u); continue; }   // detailed heights not measured yet
        u.h = h;
        const ddx = (u.lon - camLon) * kx, ddy = (u.lat - camLat) * 111320, ddz = u.h + ho + 0.8 - camH;
        u.d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        u.vis = u.d < modelRange;
        if (u.vis) bins[Math.min(NBINS, (u.d / BIN) | 0)]++;
        if (u.ptHead) placePoints(u, ho);
        if (u.prim) writeModel(u, u.prim);
        if (u.beam) writeBeam(u, u.beam);
      }
    }

    /* ---- rare vehicle highlighter (HL-BEGIN) ----
     * A yellow ring on every rare vehicle that exists (it follows it, however far away it is), with its name and
     * distance. When it is off screen, a yellow arrow at the edge of the screen points the way. Plain page
     * elements over the game view, so distance and terrain in between do not matter. */
    let hlRoot = null, hlRect = '', hlList = [];
    const hlMap = new Map();
    function hlHide() { if (hlRoot && hlRoot.style.display !== 'none') hlRoot.style.display = 'none'; }
    function hlGet(c) {
      let g = hlMap.get(c);
      if (g) return g;
      const mkd = function (css) { const e = document.createElement('div'); e.style.cssText = 'position:absolute;left:0;top:0;display:none;' + css; hlRoot.appendChild(e); return e; };
      g = {
        ring: mkd('border:3px solid #ffd400;border-radius:50%;box-sizing:border-box;box-shadow:0 0 0 1px #000,0 0 10px 2px rgba(255,212,0,.85);'),
        arrow: mkd('width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-bottom:22px solid #ffd400;filter:drop-shadow(0 0 2px #000);'),
        lab: mkd('font:bold 12px/1.2 sans-serif;color:#ffd400;text-shadow:0 0 3px #000,0 0 3px #000,0 0 3px #000;white-space:nowrap;'),
        txt: '', seen: 0
      };
      hlMap.set(c, g);
      return g;
    }
    function updateHighlight(ho) {
      if (!cfg.rareHl || !hlList.length) { hlHide(); return; }
      if (!hlRoot) {
        hlRoot = document.createElement('div');
        document.body.appendChild(hlRoot);
      }
      const cv = viewer.canvas;
      if (!cv || !cv.getBoundingClientRect) { hlHide(); return; }
      const r = cv.getBoundingClientRect();
      const W = r.width, H = r.height;
      if (!(W > 0 && H > 0)) { hlHide(); return; }
      const key = r.left + ',' + r.top + ',' + W + ',' + H;
      if (key !== hlRect || hlRoot.style.display === 'none') {
        hlRect = key;
        hlRoot.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:5;left:' + r.left + 'px;top:' + r.top + 'px;width:' + W + 'px;height:' + H + 'px;';
      }
      const cam = viewer.camera, P = cam.positionWC, D = cam.directionWC, U = cam.upWC, R = cam.rightWC;
      const tanY = Math.tan((cam.frustum && cam.frustum.fovy || 1) / 2), tanX = tanY * (W / H);
      const pxPerM = (H / 2) / tanY;          // pixels per metre at one metre distance
      for (let i = 0; i < hlList.length; i++) {
        const c = hlList[i];
        if (c.gone) continue;
        const g = hlGet(c);
        g.seen = frameNo;
        const pos = Cesium.Cartesian3.fromDegrees(c.lon, c.lat, (c.h || 0) + ho + 1.5);
        const vx = pos.x - P.x, vy = pos.y - P.y, vz = pos.z - P.z;
        const dx = vx * R.x + vy * R.y + vz * R.z, dy = vx * U.x + vy * U.y + vz * U.z, dz = vx * D.x + vy * D.y + vz * D.z;
        const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const txt = c.rare.name + '  ' + (dist < 1000 ? Math.round(dist / 10) * 10 + ' m' : (dist / 1000).toFixed(1) + ' km');
        if (txt !== g.txt) { g.txt = txt; g.lab.textContent = txt; }
        const sx = dz > 1 ? W / 2 + (dx / (dz * tanX)) * (W / 2) : -1, sy = dz > 1 ? H / 2 - (dy / (dz * tanY)) * (H / 2) : -1;
        if (dz > 1 && sx >= 0 && sx <= W && sy >= 0 && sy <= H) {       // on screen: a ring that grows with the vehicle
          const ext = c.units ? c.units.length * c.type.L : c.type.L;
          const sz = Math.max(28, Math.min(320, (ext * pxPerM / dz) * 1.15));
          g.ring.style.width = g.ring.style.height = sz + 'px';
          g.ring.style.transform = 'translate(' + (sx - sz / 2) + 'px,' + (sy - sz / 2) + 'px)';
          g.ring.style.display = 'block'; g.arrow.style.display = 'none';
          g.lab.style.transform = 'translate(' + (sx + sz / 2 + 6) + 'px,' + (sy - 8) + 'px)';
          g.lab.style.display = 'block';
        } else {                                                          // off screen: an arrow on the screen edge, pointing the way
          let ax = dx, ay = -dy;
          const m = Math.sqrt(ax * ax + ay * ay);
          if (m < 1e-6) { ax = 0; ay = 1; } else { ax /= m; ay /= m; }
          const edge = 44, t = Math.min(ax ? (W / 2 - edge) / Math.abs(ax) : 1e9, ay ? (H / 2 - edge) / Math.abs(ay) : 1e9);
          const px = W / 2 + ax * t, py = H / 2 + ay * t;
          g.arrow.style.transform = 'translate(' + (px - 11) + 'px,' + (py - 11) + 'px) rotate(' + (Math.atan2(ay, ax) * 180 / Math.PI + 90) + 'deg)';
          g.arrow.style.display = 'block'; g.ring.style.display = 'none';
          g.lab.style.transform = 'translate(' + (px - ax * 34 - 60) + 'px,' + (py - ay * 34 - 8) + 'px)';
          g.lab.style.display = 'block';
        }
      }
      hlMap.forEach(function (g, c) {      // vehicles that are gone
        if (g.seen !== frameNo) { g.ring.remove(); g.arrow.remove(); g.lab.remove(); hlMap.delete(c); }
      });
    }
    /* (HL-END) */

    const AGL_HIDE_M = 4572, AGL_SHOW_M = 4300;   // 15,000 ft above the terrain; a little lower to come back so it never flickers
    let tooHigh = false, hiddenHigh = false, aglT = 0, camGround = 0;
    function groundUnder(cc) {      // terrain height under the camera (keeps the last good value while terrain there is still loading)
      carto.longitude = cc.longitude; carto.latitude = cc.latitude; carto.height = 0;
      let h; try { h = viewer.scene.globe.getHeight(carto); } catch (e) { h = undefined; }
      if (h !== undefined && h !== null && isFinite(h)) camGround = h;
      return camGround;
    }
    function hideEverything() {
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        c.vis = false; c.d = 20000;
        freePoints(c); freeDot(c); releasePrim(c); releaseBeam(c);
        hideUnits(c);
      }
    }
    function frame() {
      const now = performance.now();
      let dt = (now - lastT) / 1000;
      lastT = now;
      if (dt < 0.5) AUTO.ema += (dt * 1000 - AUTO.ema) * 0.05;     // smoothed frame time, used by Auto-Configure's frame-rate guard
      if (dt > 0.1) dt = 0.1;
      if (!cfg.enabled || !cars.length) { hlHide(); return; }
      frameNo++;

      const camPos = viewer.camera.positionWC;
      const camH = viewer.camera.positionCartographic.height;
      const thin = camH > 25000 ? 4 : camH > 12000 ? 3 : camH > 5000 ? 2 : 1;
      const ho = cfg.heightOffset;
      const cc = viewer.camera.positionCartographic;
      const camLat = cc.latitude / D2R, camLon = cc.longitude / D2R, kx = 111320 * Math.cos(cc.latitude);
      // Nothing is drawn (models, dots, night lights) while the camera is more than 15,000 ft above the terrain under it
      if (--aglT <= 0) { aglT = 6; const agl = camH - groundUnder(cc); tooHigh = tooHigh ? agl > AGL_SHOW_M : agl > AGL_HIDE_M; }
      if (tooHigh) { if (!hiddenHigh) { hideEverything(); hiddenHigh = true; } hlHide(); return; }
      hiddenHigh = false;
      try { updateHighlight(ho); } catch (e) { hlHide(); }     // the highlighter must never be able to stop the traffic
      const modelRange = cfg.radiusKm * 1200 + camH;     // cars only exist inside the radius; this just covers the camera being above you
      terrBudget = 80;    // terrain lookups allowed this frame
      const useDetail = terrainOK;   // detailed terrain heights (falls back to plain terrain if unavailable)

      followAcc += dt;
      if (followAcc >= 0.1) { followAcc = 0; updateFollowing(); }

      bins.fill(0);
      for (let k = cars.length - 1; k >= 0; k--) {
        const car = cars[k];
        const dg = car.d > 0 ? car.d : 20000;
        const skip = dg < 2500 ? 1 : dg < 6000 ? 2 : dg < 12000 ? 4 : 8;
        if (skip > 1 && (frameNo + car.id) % skip !== 0) {     // not this car's turn: remember the time it missed
          car.dtAcc += dt;
          if (car.vis) bins[Math.min(NBINS, (car.d / BIN) | 0)]++;
          countUnits(car);
          continue;
        }
        const step = dt + car.dtAcc;
        car.dtAcc = 0;
        car.v += Math.max(-car.dec * step, Math.min(car.acc * step, car.tv - car.v));   // cars brake hard, accelerate gently
        if (car.v < 0) car.v = 0;
        const moved0 = car.v * step;
        if (!advance(car, step)) { removeCar(k); continue; }
        car.trav += moved0;
        const dNow = Math.sqrt(((car.lon - camLon) * kx) * ((car.lon - camLon) * kx) + ((car.lat - camLat) * 111320) * ((car.lat - camLat) * 111320));   // distance on the ground (car.d is only kept for drawn cars)
        if (useDetail && (car.way.th || dNow > 3500)) {
          groundFromDetail(car);           // measured: exact. Not measured yet and close to you: the terrain you can see (below), so cars appear at once
        } else {
          // terrain only: re-check often for cars near you (terrain sharpens as you approach), rarely for far ones
          if (car.h === null || ((car.gt -= step) <= 0 && terrBudget > 0)) {
            terrBudget--;
            sampleGround(car);
            car.gt = dg < 1500 ? 0.07 : dg < 5000 ? 0.25 : 1.0;
          }
          if (car.h !== null && car.ht !== car.h) {   // small changes are smoothed, big ones snap at once
            const dh = car.ht - car.h;
            car.h = (dh > 2 || dh < -2) ? car.ht : car.h + dh * Math.min(1, 8 * step);
          }
        }
        if (car.h === null || car.hOK < 1 || car.id % thin !== 0 || car.way.tunnel) {   // hidden: no ground yet, high-altitude thinning, tunnels
          car.vis = false; car.d = 20000;
          freePoints(car);
          freeDot(car);
          releasePrim(car); releaseBeam(car);
          hideUnits(car);
          continue;
        }

        const ddx = (car.lon - camLon) * kx, ddy = (car.lat - camLat) * 111320, ddz = car.h + ho + 0.8 - camH;
        car.d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);     // plain maths: much cheaper than building a Cesium position per car
        car.vis = car.d < modelRange;
        if (car.vis) bins[Math.min(NBINS, (car.d / BIN) | 0)]++;

        if (car.dot) placeDot(car, ho);
        if (car.ptHead) placePoints(car, ho);     // light points exist only for drawn cars (handed out below)
        // keep an assigned model / beam in step with the car
        if (car.prim) writeModel(car, car.prim);
        if (car.beam) writeBeam(car, car.beam);
        if (car.units) updateTrain(car, ho, camLat, camLon, kx, camH, modelRange);
      }

      if (frameNo % 3 !== 0) return;

      // ---- every 3rd frame: decide which cars get drawn, and how detailed ----
      // the distance cut-off that keeps at most maxDrawn cars comes from a histogram (no full sort)
      let acc = 0, cut = NBINS;
      for (let b = 0; b <= NBINS; b++) { acc += bins[b]; if (acc > cfg.maxDrawn) { cut = b; break; } }
      const cutD = Math.max(cut, 1) * BIN;
      cand.length = 0;
      let dots = 0;
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        if (c.vis && c.d < cutD) cand.push(c);
        if (c.units) for (let m = 0; m < c.units.length; m++) { const u = c.units[m]; if (u.vis && u.d < cutD) cand.push(u); }
        if (c.vis && c.d >= cutD && cfg.farDots && dots < cfg.maxDots) {
          dots++;
          takeDot(c);
          if (night) c.dot.color = COL_HEAD;      // at night they read as lit cars
          else if (shadeQ === 1) c.dot.color = c.color;
          else { scratchCol.red = c.color.red * shadeQ; scratchCol.green = c.color.green * shadeQ; scratchCol.blue = c.color.blue * shadeQ; scratchCol.alpha = 1; c.dot.color = scratchCol; }
          placeDot(c, ho);
        } else if (c.dot) freeDot(c);
      }
      cand.sort(function (a, b) { return a.d - b.d; });

      const lodNear = cfg.detail === 'low' ? 500 : cfg.detail === 'high' ? 1600 : 1200, lodMid = 9000;   // metres: full model / simplified model (~30,000 ft) / rectangle
      const wantBeams = night && cfg.lightFx;
      for (let i = 0; i < cand.length; i++) {
        const c = cand[i];
        c.want = frameNo;
        c.wl = c.d < lodNear ? 0 : c.d < lodMid ? 1 : 2;
        c.bw = wantBeams && i < MAX_BEAMS && c.d < 9000 && c.type.lit !== 'none';
      }
      if (pointCars.size) pointCars.forEach(function (c) { if (c.want !== frameNo || !night) freePoints(c); });
      // free models / beams whose car left the list or needs a different level of detail
      for (let i = 0; i < allPrims.length; i++) {
        const c = allPrims[i].car;
        if (c && (c.want !== frameNo || c.primLod !== c.wl)) releasePrim(c);
      }
      for (let i = 0; i < allBeams.length; i++) {
        const c = allBeams[i].car;
        if (c && (c.want !== frameNo || !c.bw)) releaseBeam(c);
      }
      repaintBudget = 40;
      // hand models out nearest-first; if a pool is full, fall back to a simpler level
      for (let i = 0; i < cand.length; i++) {
        const car = cand[i];
        let p = car.prim;
        if (!p) {
          for (let l = car.wl; l <= 2 && !p; l++) {
            p = acquire(poolFor(car.type, l));
            if (p) { car.prim = p; p.car = car; car.primLod = l; writeModel(car, p); }
          }
        }
        if (p) {
          p.show = true;
          if (p.ready) {
            if (p.shadeFor !== shadeQ) { if (repaintBudget > 0) { repaintBudget--; paintAll(p, car); } }   // time of day changed: darken / brighten (a few dozen models per pass)
            else if (p.paintFor !== car.id) {
              for (let j = 0; j < p.paintIds.length; j++) paintPart(p, p.parts.find(function (q) { return q.id === p.paintIds[j]; }), car, shadeQ);
              p.paintFor = car.id;
            }
          }
        }
        if (car.bw) {
          if (!car.beam) {
            const nb = acquireBeam(car.type);
            if (nb) { car.beam = nb; nb.car = car; writeBeam(car, nb); }
          }
          if (car.beam) car.beam.show = true;
        }
        if (night && !car.beam && car.type.lit !== 'none') { takePoints(car); placePoints(car, ho); } else freePoints(car);
      }
    }
    viewer.scene.preRender.addEventListener(frame);

    /* ---------------------------------------------------------------- *
     *  SLOW TICK (tiles, spawning, despawning)
     * ---------------------------------------------------------------- */
    /* ---------------------------------------------------------------- *
     *  AUTO-CONFIGURE (AUTO-BEGIN)
     *  Looks at the map data around you and picks radius, cars, trains and boats.
     *  Dense city = smaller radius and lots of cars; countryside = bigger radius, fewer cars;
     *  busy harbours = more boats. Time of day (local solar time) thins traffic at night.
     *  A frame-rate guard backs off when the game gets slow. Your Manual values are kept.
     * ---------------------------------------------------------------- */
    // how many cars each kind of road holds per km, how many trains per km of track, boats per km of water route
    const CAR_PER_KM = { motorway: 20, trunk: 16, primary: 15, secondary: 11, tertiary: 8, unclassified: 5, residential: 4.5, living_street: 1.5 };
    const TRAIN_PER_KM = { rail: 0.07, light_rail: 0.15, subway: 0.2, tram: 0.25, narrow_gauge: 0.06 };
    const BOAT_PER_KM = { ferry: 0.22, fairway: 0.35, river: 0.12 };
    const AUTO_CAPS = { low: { cars: 4500, trains: 100, boats: 150, drawn: 800 }, regular: { cars: 3000, trains: 60, boats: 120, drawn: 500 }, high: { cars: 2000, trains: 35, boats: 80, drawn: 350 } };
    // traffic through the day (local solar hour -> share of the daytime amount)
    const DAY_CURVE = [[0, 0.35], [4, 0.3], [6, 0.7], [8, 1.1], [10, 0.95], [13, 1.0], [16, 1.0], [18, 1.15], [20, 0.8], [22, 0.55], [24, 0.35]];
    const AUTO = { t: 0, scanT: 0, place: null, fresh: true, guard: 1, slow: 0, fast: 0, ema: 16, since: 0, info: null, note: 'Starting...' };
    function autoReset() { AUTO.place = null; AUTO.fresh = true; AUTO.guard = 1; AUTO.slow = AUTO.fast = 0; AUTO.since = Date.now(); AUTO.info = null; AUTO.t = AUTO.scanT = 0; AUTO.note = 'Reading the map around you...'; }
    function layerKindOf(layer) { const base = LAYERS[layer] && LAYERS[layer].vec ? layer.slice(1) : layer; return base === 'water' ? 'boat' : base === 'rail' ? 'rail' : 'road'; }
    // true when every map tile near you (for this kind) has finished, successfully or not
    function tilesReady(p, rM, kind) {
      let any = false, ok = true;
      tiles.forEach(function (t) {
        if (layerKindOf(t.layer) !== kind) return;
        const c = tileCenter(t);
        if (distM(p.lat, p.lon, c.lat, c.lon) > rM + t.size * 111320 * 0.7) return;
        any = true;
        if (t.state !== 'done' && t.state !== 'failed') ok = false;
      });
      return any && ok;
    }
    function localHour() {
      let d; try { d = Cesium.JulianDate.toDate(viewer.clock.currentTime); } catch (e) { d = new Date(); }
      const p = playerPos();
      return ((d.getUTCHours() + d.getUTCMinutes() / 60 + p.lon / 15) % 24 + 24) % 24;
    }
    function dayFactor(h) {
      for (let i = 1; i < DAY_CURVE.length; i++) if (h <= DAY_CURVE[i][0]) { const a = DAY_CURVE[i - 1], b = DAY_CURVE[i]; return a[1] + (b[1] - a[1]) * (h - a[0]) / (b[0] - a[0]); }
      return 1;
    }
    function autoScan(p, rM) {
      const S = { d3: 0, dR: 0, train: 0, boat: 0 };
      tiles.forEach(function (t) {
        if (t.state !== 'done') return;
        for (let k = 0; k < t.ways.length; k++) {
          const w = t.ways[k];
          const m = w.pts[w.pts.length >> 1];
          const dm = distM(p.lat, p.lon, m[0], m[1]);
          if (dm > rM) continue;
          const km = w.len / 1000;
          if (w.kind === 'road') { const d = (CAR_PER_KM[w.cls] || 4) * km * (w.tunnel ? 0.2 : 1); S.dR += d; if (dm <= 3000) S.d3 += d; }
          else if (w.kind === 'rail') S.train += (TRAIN_PER_KM[w.cls] || 0.07) * km * (w.tunnel ? 0.3 : 1);
          else S.boat += (BOAT_PER_KM[w.cls] || 0.2) * km;
        }
      });
      return S;
    }
    function placeName(D) { return D >= 80 ? 'dense city' : D >= 35 ? 'city or large town' : D >= 14 ? 'town or suburbs' : D >= 5 ? 'countryside with villages' : 'very quiet area'; }
    function autoStep() {
      if (cfg.mode !== 'auto') return;
      const now = Date.now();
      if (now - AUTO.t < 1500) return;
      AUTO.t = now;
      const p = playerPos();
      const caps = AUTO_CAPS[cfg.detail] || AUTO_CAPS.regular;

      // frame-rate guard: slow game -> fewer cars and fewer drawn; fast for a long time -> creep back up
      if (now - AUTO.since > 25000) {
        if (AUTO.ema > 45) { AUTO.slow++; AUTO.fast = 0; } else if (AUTO.ema < 24) { AUTO.fast++; AUTO.slow = 0; } else { AUTO.slow = AUTO.fast = 0; }
        if (AUTO.slow >= 4) { AUTO.guard = Math.max(0.35, AUTO.guard * 0.8); AUTO.slow = 0; }
        if (AUTO.fast >= 20) { AUTO.guard = Math.min(1, AUTO.guard * 1.15); AUTO.fast = 0; }
      }
      // new place (you flew or teleported far): decide everything again
      if (!AUTO.place || distM(p.lat, p.lon, AUTO.place.lat, AUTO.place.lon) > 6000) { AUTO.place = { lat: p.lat, lon: p.lon }; AUTO.fresh = true; AUTO.since = now; }
      if (!tilesReady(p, 3000, 'road')) { if (!AUTO.info) AUTO.note = 'Reading the map around you...'; return; }
      if (now - AUTO.scanT < 5000 && !AUTO.fresh) { applyGuard(); return; }
      AUTO.scanT = now;

      const S3 = autoScan(p, 3000);
      const D = Math.max(0.5, S3.d3 / (Math.PI * 9));           // cars per km2 the roads here can hold
      let r = Math.round(Math.sqrt(caps.cars * 0.8 / (Math.PI * D)));
      r = Math.max(4, Math.min(8, r));
      if (AUTO.fresh || Math.abs(r - cfg.radiusKm) >= 2) { if (r !== cfg.radiusKm) { cfg.radiusKm = r; poolDirty = true; } }
      AUTO.fresh = false;

      const rM = cfg.radiusKm * 1000 * 0.95;
      const loaded = tilesReady(p, rM, 'road');
      const S = autoScan(p, rM);
      const h = localHour(), f = dayFactor(h);
      const fTrain = 0.45 + 0.55 * Math.min(1, f), fBoat = 0.7 + 0.3 * Math.min(1, f);
      // until the whole radius has loaded, estimate from the 3 km around you (cautiously)
      const cars = loaded ? S.dR * f : D * Math.PI * cfg.radiusKm * cfg.radiusKm * 0.5 * f;
      const railReady = tilesReady(p, rM, 'rail'), waterReady = tilesReady(p, rM, 'boat');
      let trains = railReady ? Math.round(S.train * fTrain) : cfg.maxTrains;
      if (railReady && S.train > 0.15 && trains < 1) trains = 1;
      let boats = waterReady ? Math.round(S.boat * fBoat) : cfg.maxBoats;
      const set = function (key, v, big) {
        v = Math.round(v);
        const cur = cfg[key];
        if (cur === v) return;
        if (big && cur > 0 && Math.abs(v - cur) / cur < 0.1) return;   // ignore tiny changes
        cfg[key] = v;
      };
      set('maxCars', Math.max(50, Math.min(caps.cars, cars)) * AUTO.guard, true);
      set('maxTrains', Math.min(caps.trains, trains), false);
      set('maxBoats', Math.min(caps.boats, boats), false);
      applyGuard();
      syncKinds();
      const tod = h < 5.5 || h >= 22 ? 'night' : h < 10 ? 'morning rush' : h < 16 ? 'daytime' : h < 19.5 ? 'evening rush' : 'evening';
      AUTO.info = { place: placeName(D), tod: tod, loaded: loaded };
      AUTO.note = '';
    }
    function applyGuard() {
      const caps = AUTO_CAPS[cfg.detail] || AUTO_CAPS.regular;
      cfg.maxDrawn = Math.max(100, Math.round(caps.drawn * AUTO.guard / 50) * 50);
    }
    function autoText() {
      if (cfg.mode !== 'auto') return '';
      if (!AUTO.info) return AUTO.note || 'Reading the map around you...';
      const I = AUTO.info;
      return 'Here: ' + I.place + ', ' + I.tod + '. Using a ' + cfg.radiusKm + ' km radius, up to ' + cfg.maxCars + ' cars, ' +
        cfg.maxTrains + ' trains and ' + cfg.maxBoats + ' boats.' + (AUTO.guard < 0.95 ? ' Slowing down a little to keep the game smooth.' : '') + (I.loaded ? '' : ' (still loading the map, numbers will settle)');
    }
    function setMode(m) {
      if (cfg.mode === m) return;
      if (m === 'auto') { cfg.manualSaved = pickManual(); cfg.mode = 'auto'; autoReset(); }
      else { Object.assign(cfg, cfg.manualSaved || {}); delete cfg.manualSaved; cfg.mode = 'manual'; syncKinds(); poolDirty = true; }
      saveCfg();
    }
    if (cfg.mode === 'auto') autoReset();
    /* (AUTO-END) */

    let tick = 0;
    let lastNightCheck = 0;
    function slowTick() {
      tick++;
      if (!cfg.enabled) { if (cars.length) removeAllCars(); updateStatus(); return; }
      const p = playerPos();
      const r = cfg.radiusKm * 1000;

      if (!JUMP.pos || distM(p.lat, p.lon, JUMP.pos.lat, JUMP.pos.lon) > 15000) { JUMP.pos = { lat: p.lat, lon: p.lon }; JUMP.t0 = Date.now(); JUMP.tile = JUMP.car = JUMP.all = JUMP.ground = null; }
      applySource();
      updateTiles();
      pump();
      vecPump();
      runDetail();
      if (tick % 40 === 0) evictTiles();

      if (Date.now() - lastNightCheck > 2000) { night = computeNight(); shadeQ = computeShade(); lastNightCheck = Date.now(); }
      if (poolDirty || tick % 12 === 0) rebuildPool();
      if (tick % 3 === 0) rebalance();
      autoStep();

      for (let k = cars.length - 1; k >= 0; k--) {
        const c = cars[k];
        if (distM(p.lat, p.lon, c.lat, c.lon) > r * 1.05 ||
            (c.kind === 'rail' && (!cfg.trains || kindCount.rail > cfg.maxTrains)) ||
            (c.kind === 'boat' && (!cfg.boats || kindCount.boat > cfg.maxBoats))) removeCar(k);
      }
      // above the cap (slider lowered): farthest cars leave in quick batches, not all in one frame
      const over = kindCount.road - cfg.maxCars;
      if (over > 0) {
        cars.map(function (c, idx) { return { idx: idx, d: c.kind === 'road' ? distM(p.lat, p.lon, c.lat, c.lon) : -1 }; })
          .filter(function (o) { return o.d >= 0; })
          .sort(function (a, b) { return b.d - a.d; }).slice(0, Math.min(over, 40))
          .map(function (o) { return o.idx; }).sort(function (a, b) { return b - a; })
          .forEach(function (idx) { removeCar(idx); });
      }
      // below the cap: fill quickly when the area is empty, gently when nearly full
      let n = 0;
      const burst = kindCount.road < cfg.maxCars * 0.5 ? 150 : 25;
      while (kindCount.road < cfg.maxCars && n < burst && PK.road.pool.length) { if (!spawnCar()) break; n++; }
      n = 0;
      while (cfg.trains && kindCount.rail < cfg.maxTrains && n < 3 && PK.rail.pool.length) { if (!spawnTrain()) break; n++; }
      n = 0;
      while (cfg.boats && kindCount.boat < cfg.maxBoats && n < 6 && PK.boat.pool.length) { if (!spawnBoat()) break; n++; }
      if (JUMP.car === null && kindCount.road > 0) JUMP.car = Date.now() - JUMP.t0;
      updateStatus();
    }
    setInterval(slowTick, 250);

    function resetWorld() {
      removeAllCars();
      tiles.clear(); wayOwner.clear(); nodeIndex.clear(); vecData.clear();
      Object.keys(PK).forEach(function (k) { PK[k] = { pool: [], total: 0, tw: {} }; });
      poolDirty = true;
    }

    /* ---------------------------------------------------------------- *
     *  SETTINGS PANEL
     * ---------------------------------------------------------------- */
    let statusEl = null, statusSum = null, autoTextEl = null, rareEl = null;   // short line (tiles) and the full advanced text
    function updateStatus() {
      if (!statusEl || !statusSum) return;
      let done = 0, queued = 0, loading = 0, failed = 0;
      tiles.forEach(function (t) {
        if (t.layer === 'vlocal' || t.layer === 'vrail') return;     // the same download as the main tile: count it once
        if (t.state === 'done') done++;
        else if (t.state === 'failed') failed++;
        else if (t.state === 'loading') loading++;
        else queued++;
      });
      if (JUMP.all === null && JUMP.tile !== null && done > 0 && loading + queued === 0) JUMP.all = Date.now() - JUMP.t0;
      const sec = function (v) { return v === null ? 'waiting' : (v / 1000).toFixed(1) + 's'; };
      const jumpTxt = ' | since your last jump: first roads ' + sec(JUMP.tile) + ', first cars ' + sec(JUMP.car) + ', all map tiles ' + sec(JUMP.all) + ', ground measured ' + sec(JUMP.ground);
      if (autoTextEl && cfg.mode === 'auto') autoTextEl.textContent = autoText();
      hlList = cars.filter(function (c) { return c.rare; });
      if (rareEl && tick % 8 === 0) rareEl.textContent = 'Rare vehicles near you right now: ' + (rareList() || 'none');
      statusSum.textContent = 'Tiles: ' + loading + ' loading / ' + done + ' loaded';
      const srcTxt = cfg.source === 'overpass' ? 'Overpass only (your choice)' : VEC.state === 'ok' ? 'fast map tiles' : VEC.state === 'down' ? 'Overpass (fast tiles unavailable: ' + VEC.note + ')' : 'fast map tiles (starting)';
      statusEl.textContent = 'roads from: ' + srcTxt + ' | ' + kindCount.road + ' cars, ' + kindCount.rail + ' trains, ' + kindCount.boat + ' boats (' + PK.road.pool.length + ' roads, ' +
        PK.rail.pool.length + ' tracks, ' + PK.boat.pool.length + ' water routes) | tiles: ' + done + ' loaded, ' +
        loading + ' loading, ' + queued + ' queued, ' + failed + ' failed | ' + (night ? 'night' : 'day') +
        ' | ground: ' + (terrainOK ? 'detailed terrain (' + detailDone + ' ways measured)' : 'plain terrain (detailed data unavailable)') +
        jumpTxt + ' | cache hits: ' + cacheHits + ' | LAST RESULT: ' + lastMsg + (busy ? ' | in flight: ' + inflight + ' (latest ' + reqHost + ' via ' + transport + ')' : '');
    }

    function buildPanel() {
      const VERSION = '0.23.0';
      const LOGO = 'data:image/png;base64,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';
      // ---- look: native GeoFS classes for the panel and buttons, a little extra CSS for the sections ----
      const css = document.createElement('style');
      css.textContent =
        '.living-world-panel{min-width:280px;max-width:320px;padding:12px 14px;box-sizing:border-box}' +
        '.living-world-panel summary{text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 0 3px #000}' +
        '.living-world-panel .lw-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px}' +
        '.living-world-panel .lw-title{font-size:15px;line-height:1.15;font-weight:bold;letter-spacing:.3px}' +
        '.living-world-panel .lw-ver{font-size:10px;opacity:.6}' +
        '.living-world-panel details{border-top:1px solid rgba(255,255,255,.14);padding:6px 0}' +
        '.living-world-panel summary{cursor:pointer;font-weight:bold;font-size:13px;padding:3px 0;outline:none;list-style:none}' +
        '.living-world-panel summary::-webkit-details-marker{display:none}' +
        '.living-world-panel summary:before{content:"\\25B8";display:inline-block;width:14px;opacity:.7}' +
        '.living-world-panel details[open]>summary:before{content:"\\25BE"}' +
        '.living-world-panel .lw-soon{opacity:.45;cursor:default}' +
        '.living-world-panel .lw-soon span{font-weight:normal;font-size:10px;margin-left:6px;padding:1px 6px;border:1px solid rgba(255,255,255,.35);border-radius:8px}' +
        '.living-world-panel .lw-row{margin:6px 0 2px 0;font-size:12px;line-height:1.35}' +
        '.living-world-panel .lw-row b{font-weight:600}' +
        '.living-world-panel .lw-hint{opacity:.6;font-size:11px}' +
        '.living-world-panel input[type=range]{width:100%;margin:2px 0 4px 0;accent-color:#4cc38a}' +
        '.living-world-panel input[type=checkbox]{accent-color:#4cc38a}' +
        '.living-world-panel .mdl-button--colored,.living-world-panel .mdl-button--raised.mdl-button--colored{background:#4cc38a !important;color:#00241a !important;font-weight:bold}' +
        '.living-world-panel .mdl-button--colored:hover{background:#6fd9a5 !important}' +
        '.living-world-panel .lw-off{background:#3a4654 !important;color:#cfd8e2 !important}' +
        '.living-world-panel .lw-logo{display:flex;align-items:center;gap:10px}' +
        '.living-world-panel .lw-logo img{width:72px;height:auto}' +
        '.living-world-panel .lw-tabs{display:flex;gap:6px;margin:10px 0 4px 0}' +
        '.living-world-panel .lw-tab{flex:1;text-align:center;padding:5px 0;border-radius:6px;font-size:12px;font-weight:bold;cursor:pointer;background:rgba(255,255,255,.08);color:#00241a;user-select:none}' +
        '.living-world-panel .lw-tab.on{background:#4cc38a;color:#00241a}' +
        '.living-world-panel summary{color:#a8d8f0}' +
        '.living-world-panel .lw-credit{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.14);font-size:9.5px;line-height:1.35;opacity:.75}' +
        '.living-world-panel .lw-credit a{color:#a8d8f0;text-decoration:underline}' +
        '.living-world-panel select{background:#1d2430;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:2px 4px}' +
        '.living-world-panel .lw-strow{display:flex;align-items:center;justify-content:space-between}' +
        '.living-world-panel .lw-autoon{font-size:15px;font-weight:bold;color:#4cc38a;margin:14px 0 6px 0}' +
        '.living-world-panel .lw-status{margin-top:8px;font-size:10.5px;opacity:.7;word-break:break-word}';
      document.head.appendChild(css);

      const panel = document.createElement('div');
      panel.id = 'livingWorldPanel';
      panel.className = 'geofs-list geofs-toggle-panel living-world-panel';
      panel.setAttribute('data-noblur', 'true');
      panel.style.maxHeight = '90vh';
      panel.style.overflowY = 'auto';
      // typing / dragging inside the menu must never fly the plane
      ['keydown', 'keyup', 'keypress'].forEach(function (n) { panel.addEventListener(n, function (e) { e.stopPropagation(); }, true); });

      const mk = function (tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

      // ---- header + master switch ----
      const head = mk('div', 'lw-head');
      const brand = mk('div', 'lw-logo');
      const logoImg = document.createElement('img'); logoImg.src = LOGO; logoImg.alt = '';
      brand.appendChild(logoImg);
      brand.appendChild(mk('div', 'lw-title', 'GeoFS Living World Addon'));
      head.appendChild(brand);
      head.appendChild(mk('div', 'lw-ver', 'v' + VERSION));
      panel.appendChild(head);
      const master = mk('button', 'mdl-button mdl-js-button mdl-button--raised mdl-button--colored');
      master.style.width = '100%';
      const refreshMaster = function () { master.textContent = cfg.enabled ? 'WORLD ON' : 'WORLD OFF'; master.classList.toggle('lw-off', !cfg.enabled); };
      master.onclick = function () { cfg.enabled = !cfg.enabled; saveCfg(); refreshMaster(); };
      refreshMaster();
      panel.appendChild(master);

      // ---- little control builders ----
      function soon(title) {
        const d = mk('details', 'lw-soon');
        const s = mk('summary', '', title); s.appendChild(mk('span', '', 'coming soon'));
        s.addEventListener('click', function (e) { e.preventDefault(); });
        d.appendChild(s); panel.appendChild(d);
      }
      const sliderSync = [];
      function slider(parent, label, key, min, max, step, unit, after) {
        const row = mk('div', 'lw-row');
        const val = mk('b', '', String(cfg[key]));
        row.appendChild(document.createTextNode(label + ': ')); row.appendChild(val);
        if (unit) row.appendChild(document.createTextNode(' ' + unit));
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = cfg[key];
        inp.addEventListener('input', function () { cfg[key] = +inp.value; val.textContent = String(cfg[key]); saveCfg(); if (after) after(); });
        parent.appendChild(row); parent.appendChild(inp);
        sliderSync.push(function () { inp.value = cfg[key]; val.textContent = String(cfg[key]); });
        return inp;
      }
      function check(parent, label, key, after) {
        const row = mk('div', 'lw-row');
        const l = document.createElement('label');
        const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!cfg[key];
        c.addEventListener('change', function () { cfg[key] = c.checked; saveCfg(); if (after) after(); });
        l.appendChild(c); l.appendChild(document.createTextNode(' ' + label));
        row.appendChild(l); parent.appendChild(row);
      }
      function hint(parent, text) { parent.appendChild(mk('div', 'lw-row lw-hint', text)); }

      // ---- two pages: Main (the few things most people need) and Advanced (everything else) ----
      const tabs = mk('div', 'lw-tabs');
      const tMain = mk('div', 'lw-tab on', 'Main'), tAdv = mk('div', 'lw-tab', 'Advanced');
      tabs.appendChild(tMain); tabs.appendChild(tAdv);
      panel.appendChild(tabs);
      const pgMain = mk('div', 'lw-page'), pgAdv = mk('div', 'lw-page');
      pgAdv.style.display = 'none';
      panel.appendChild(pgMain); panel.appendChild(pgAdv);
      const showPage = function (adv) {
        pgMain.style.display = adv ? 'none' : ''; pgAdv.style.display = adv ? '' : 'none';
        tMain.classList.toggle('on', !adv); tAdv.classList.toggle('on', adv);
      };
      tMain.onclick = function () { showPage(false); };
      tAdv.onclick = function () { showPage(true); };
      function section(title, open) {
        const d = mk('details'); if (open) d.open = true;
        d.appendChild(mk('summary', '', title));
        pgAdv.appendChild(d);
        return d;
      }

      // Main page: Manual / Auto-Configure switch, then either the sliders or the Auto-Configure message
      const mSeg = mk('div', 'lw-tabs');
      const mBtn = { manual: mk('div', 'lw-tab', 'Manual'), auto: mk('div', 'lw-tab', 'Auto-Configure') };
      mSeg.appendChild(mBtn.manual); mSeg.appendChild(mBtn.auto);
      pgMain.appendChild(mSeg);
      const manBox = mk('div', 'lw-box'), autoBox = mk('div', 'lw-box');
      pgMain.appendChild(manBox); pgMain.appendChild(autoBox);
      let unlChk = null;
      slider(manBox, 'Car radius', 'radiusKm', 1, 10, 1, 'km', function () { cfg.radiusUnl = false; if (unlChk) unlChk.checked = false; poolDirty = true; });
      (function () {
        const row = mk('div', 'lw-row'), l = document.createElement('label');
        unlChk = document.createElement('input'); unlChk.type = 'checkbox'; unlChk.checked = !!cfg.radiusUnl;
        unlChk.addEventListener('change', function () {
          cfg.radiusUnl = unlChk.checked;
          if (cfg.radiusUnl) { cfg.radiusPrev = cfg.radiusKm <= 10 ? cfg.radiusKm : 5; cfg.radiusKm = UNL_KM; }
          else cfg.radiusKm = cfg.radiusPrev || 5;
          saveCfg(); poolDirty = true; sliderSync.forEach(function (f) { f(); });
        });
        l.appendChild(unlChk); l.appendChild(document.createTextNode(' Unlimited radius (' + UNL_KM + ' km, as far as you can see)'));
        row.appendChild(l); manBox.appendChild(row);
      })();
      hint(manBox, 'Traffic only exists this close to you. Smaller = faster.');
      slider(manBox, 'Max cars', 'maxCars', 50, 10000, 50, '');
      slider(manBox, 'Trains', 'maxTrains', 0, 100, 1, '', syncKinds);
      slider(manBox, 'Boats', 'maxBoats', 0, 200, 5, '', syncKinds);
      hint(manBox, 'How many trains and boats at most. 0 turns them off.');
      autoBox.appendChild(mk('div', 'lw-autoon', 'Auto-Configure on'));
      const dRow = mk('div', 'lw-row');
      dRow.appendChild(document.createTextNode('Model detail'));
      const dSeg = mk('div', 'lw-tabs');
      const dBtn = {};
      [['low', 'Low'], ['regular', 'Regular'], ['high', 'High']].forEach(function (o) {
        const b = mk('div', 'lw-tab', o[1]);
        b.onclick = function () {
          if (cfg.detail === o[0]) return;
          cfg.detail = o[0]; saveCfg(); flushPools(); markDetail();
          if (cfg.mode === 'auto') { AUTO.fresh = true; AUTO.scanT = 0; }
        };
        dBtn[o[0]] = b; dSeg.appendChild(b);
      });
      const markDetail = function () { Object.keys(dBtn).forEach(function (k) { dBtn[k].classList.toggle('on', cfg.detail === k); }); };
      markDetail();
      dRow.appendChild(dSeg);
      pgMain.appendChild(dRow);
      hint(pgMain, 'Low: simpler cars, trains and boats (fastest). Regular: detailed, without the tiniest parts of trains and boats. High: everything. Lower it if the game lags.');
      statusSum = mk('div', 'lw-status', 'Tiles: 0 loading / 0 loaded');
      pgMain.appendChild(statusSum);

      // Advanced page
      const sTraffic = section('Traffic', false);
      check(sTraffic, 'Traffic jams (cars keep a gap)', 'followTraffic');
      check(sTraffic, 'Include local streets', 'localRoads');
      slider(sTraffic, 'Local street radius', 'localRadiusKm', 1, 8, 1, 'km');

      const sMap = section('Map data', false);
      const mr = mk('div', 'lw-row');
      mr.appendChild(document.createTextNode('Roads and railways from: '));
      const msel = document.createElement('select');
      [['auto', 'Fast map tiles (Overpass as backup)'], ['overpass', 'Overpass only']].forEach(function (o) {
        const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; msel.appendChild(op);
      });
      msel.value = cfg.source === 'overpass' ? 'overpass' : 'auto';
      msel.addEventListener('change', function () { cfg.source = msel.value; saveCfg(); });
      mr.appendChild(msel); sMap.appendChild(mr);
      hint(sMap, 'Fast map tiles load in a second or two. If they ever fail, the addon switches to Overpass by itself. Boats always use Overpass.');

      const sPerf = section('Performance', false);
      const drawnInp = slider(sPerf, 'Max drawn cars', 'maxDrawn', 100, 3000, 100, '');
      const drawnHint = mk('div', 'lw-row lw-hint', 'Lower this first if the game lags. (Auto-Configure sets this by itself while it is on.)');
      sPerf.appendChild(drawnHint);
      check(sPerf, 'Show the rest of the cars as small dots', 'farDots');

      const sLight = section('Night lighting', false);
      const lr = mk('div', 'lw-row');
      lr.appendChild(document.createTextNode('Lights: '));
      const sel = document.createElement('select');
      [['auto', 'Auto'], ['on', 'Always on'], ['off', 'Off']].forEach(function (o) {
        const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op);
      });
      sel.value = cfg.lights;
      sel.addEventListener('change', function () { cfg.lights = sel.value; saveCfg(); lastNightCheck = 0; });
      lr.appendChild(sel); sLight.appendChild(lr);

      const sRare = section('Rare vehicles', false);
      check(sRare, 'Rare vehicles on', 'rare');
      check(sRare, 'Highlight rare vehicles (yellow ring, arrow at the screen edge)', 'rareHl');
      check(sRare, 'Supercars (more often in rich areas)', 'rareCars');
      check(sRare, 'Cruise ships (only near cruise ports)', 'rareShips');
      check(sRare, 'Famous trains (only in their own country or line)', 'rareTrains');
      slider(sRare, 'How often (1 = normal, 0 = never)', 'rareFreq', 0, 20, 0.25, 'x');
      hint(sRare, 'Turn this up to go looking for them. They stay rare at 1.');
      [['uncommon', 'Uncommon', 20, 0.5], ['rare', 'Rare', 20, 0.5], ['veryrare', 'Very rare', 5, 0.1], ['legendary', 'Legendary', 2, 0.05]].forEach(function (t) {
        const row = mk('div', 'lw-row'), val = mk('b', '', String(cfg.rareTier[t[0]]));
        row.appendChild(document.createTextNode(t[1] + ': ')); row.appendChild(val); row.appendChild(document.createTextNode(' % of trains and ships'));
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = 0; inp.max = t[2]; inp.step = t[3]; inp.value = cfg.rareTier[t[0]];
        inp.addEventListener('input', function () { cfg.rareTier[t[0]] = +inp.value; val.textContent = String(cfg.rareTier[t[0]]); saveCfg(); });
        sRare.appendChild(row); sRare.appendChild(inp);
      });
      hint(sRare, 'Uncommon: modern American locomotives. Rare: bullet trains, TGV, ICE, cruise ships. Very rare: luxury trains, the biggest ships, supercars. Legendary: Big Boy, Mallard, Flying Scotsman. Cars get a far smaller share. Only a few of each tier exist at once.');
      rareEl = mk('div', 'lw-row lw-hint', 'Rare vehicles near you right now: none');
      sRare.appendChild(rareEl);

      const sCal = section('Calibration', false);
      slider(sCal, 'Height offset', 'heightOffset', -150, 150, 1, 'm');
      hint(sCal, 'Cars float or sink? Nudge this.');

      const sBoat = section('Boats', false);
      slider(sBoat, 'Boat height offset', 'waterOffset', -60, 60, 1, 'm');
      hint(sBoat, 'Boats float above or sink into the water? Nudge the offset.');

      statusEl = mk('div', 'lw-status', '');
      pgAdv.appendChild(statusEl);

      const refreshMode = function () {
        const a = cfg.mode === 'auto';
        mBtn.manual.classList.toggle('on', !a); mBtn.auto.classList.toggle('on', a);
        manBox.style.display = a ? 'none' : ''; autoBox.style.display = a ? '' : 'none';
        drawnInp.disabled = a; drawnInp.style.opacity = a ? '0.4' : '';
        sliderSync.forEach(function (f) { f(); });
      };
      mBtn.manual.onclick = function () { setMode('manual'); refreshMode(); };
      mBtn.auto.onclick = function () { setMode('auto'); refreshMode(); };
      refreshMode();

      // ---- credits (required by the OpenStreetMap licence: shown on both pages) ----
      const credit = mk('div', 'lw-credit');
      const link = function (text, href) {
        const a = document.createElement('a'); a.textContent = text; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        return a;
      };
      credit.appendChild(document.createTextNode('Map data \u00A9 '));
      credit.appendChild(link('OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'));
      credit.appendChild(document.createTextNode(' (ODbL). Road and rail tiles: '));
      credit.appendChild(link('OpenFreeMap', 'https://openfreemap.org'));
      credit.appendChild(document.createTextNode(' \u00A9 '));
      credit.appendChild(link('OpenMapTiles', 'https://openmaptiles.org'));
      credit.appendChild(document.createTextNode(', data from OpenStreetMap. Backup and water data: '));
      credit.appendChild(link('Overpass API', 'https://overpass-api.de'));
      credit.appendChild(document.createTextNode('. Menu style based on GeoFS After Dark by SkyTeamDelta.'));
      panel.appendChild(credit);

      try { if (W.componentHandler && W.componentHandler.upgradeElements) W.componentHandler.upgradeElements(panel); } catch (e) { /* styling only */ }

      // ---- placement: GeoFS's own left panel area + a button in the bottom bar (same as built-in menus) ----
      const left = document.querySelector('.geofs-ui-left');
      const bottom = document.querySelector('.geofs-ui-bottom');
      const iconHtml = '<span style="display:inline-block;width:32px;height:32px;vertical-align:middle;background:url(' + LOGO + ') center/92% no-repeat"></span>';
      let btn = null, native = false;
      if (left && bottom && !document.getElementById('livingWorldButton')) {
        left.appendChild(panel);
        btn = document.createElement('button');
        btn.id = 'livingWorldButton';
        btn.title = 'GeoFS Living World';
        btn.className = 'mdl-button mdl-js-button geofs-f-standard-ui geofs-mediumScreenOnly';
        btn.setAttribute('data-toggle-panel', '.living-world-panel');
        btn.setAttribute('data-tooltip-classname', 'mdl-tooltip--top');
        btn.innerHTML = iconHtml;
        let pos = 3;
        try { pos = (W.geofs.version >= 3.6) ? 4 : 3; } catch (e) { pos = 3; }
        if (bottom.children.length > pos) bottom.insertBefore(btn, bottom.children[pos]); else bottom.appendChild(btn);
        native = true;
        // GeoFS opens and closes the panel itself through data-toggle-panel (same as its own menus); nothing else touches its visibility.
      } else if (!document.getElementById('livingWorldButton')) {
        // fallback: floating button (GeoFS bar not found)
        btn = document.createElement('div');
        btn.id = 'livingWorldButton';
        btn.title = 'GeoFS Living World';
        btn.innerHTML = iconHtml;
        btn.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;width:38px;height:38px;border-radius:50%;' +
          'background:#1d2430;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.5);user-select:none;';
        panel.style.cssText += ';position:fixed;bottom:58px;left:12px;z-index:99999;display:none;background:rgba(20,26,36,.94);color:#e8ecf2;font:12px/1.4 sans-serif;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.6);';
        document.body.appendChild(btn); document.body.appendChild(panel);
        btn.addEventListener('click', function () { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; });
      }
      return native ? 'GeoFS bottom bar' : 'floating button';
    }
    const panelMode = buildPanel();
    applyBloom();
    console.log('[GeoFS Living World] ready (menu: ' + panelMode + ')');
  });
})();
