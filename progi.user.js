// ==UserScript==
// @name         Progi zwalniające – warstwa WME
// @namespace    https://github.com/miodeq-ofc/Hazard
// @version      2.3.0
// @description  Kropki progów zwalniających z OSM na mapie WME + wspólna baza JSON na GitHubie, zsynchronizowana ze stroną (index.html). Alt+klik = „dodane”, Alt+Shift+klik = „błędne”. Menu w Layers.
// @author       miodeq
// @match        *://*.waze.com/*editor*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      api.openstreetmap.org
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/miodeq-ofc/Hazard/main/progi.user.js
// @downloadURL  https://raw.githubusercontent.com/miodeq-ofc/Hazard/main/progi.user.js
// @supportURL   https://github.com/miodeq-ofc/Hazard
// ==/UserScript==

/*  Progi zwalniające – warstwa WME (2.3.0)

    JAK RYSUJE:
    - kropki to NAKŁADKA DOM (div z kropkami) przyklejona do viewportu mapy,
      a nie warstwa wektorowa SDK — dlatego są NAD segmentami, ikonami ostrzeżeń
      i wszystkim innym, co rysuje WME
    - rozmiar 34 px, biała obwódka + ciemna aureola, więc widać je na każdym tle
    - klik w kropkę łapie kropka (element DOM), więc segment pod spodem się nie zaznacza
    - najechanie = pasek u góry z typem, stanem i datą dodania z OSM
      (daty nie ma w bazie, więc dociągam ją z api.openstreetmap.org wersja 1 i zapamiętuję)

    STEROWANIE:
    - Alt + klik = „dodane”, Alt + Shift + klik = „błędne”, sam klik = przypnij info
    - każda zmiana zapisuje się SAMA do GitHuba (0,3 s po kliknięciu);
      jeśli sieć zawiedzie, skrypt ponawia co 15 s
    - menu jest w Layers („Progi by Miodeq”): filtry, licznik, Ustawienia bazy

    AKTUALIZACJE: Tampermonkey sam sprawdza @updateURL; po zmianie pliku podbij @version.
*/

(function () {
  'use strict';

  const VERSION = '2.3.0';
  const DEFAULTS = {
    owner: 'miodeq-ofc',
    repo: 'Hazard',
    branch: 'main',
    path: 'data/progi.json',
    token: '',
    dash: '',
    interval: 20,
    visible: true,
    collapsed: false
  };

  const GROUP_ID = 'pz-group';
  const COLORS = { todo: '#f59e0b', new: '#2563eb', done: '#16a34a', bad: '#7c3aed', gone: '#dc2626' };
  const NAMES = { todo: 'do dodania', new: 'nowe', done: 'dodane', bad: 'błędne', gone: 'zniknęły z OSM' };
  const KINDS = ['todo', 'new', 'done', 'bad', 'gone'];
  const TYPES = { bump: 'bump (próg)', hump: 'hump (garb)', table: 'table (płaski)', cushion: 'cushion (poduszka)' };

  const DOT_PX = 34;        // średnica kropki (px)
  const MAX_DOTS = 900;     // ile kropek maksymalnie w jednym widoku
  const OSM_API = 'https://api.openstreetmap.org/api/0.6/';
  const Z_OVERLAY = 9000;   // ponad pane'ami mapy WME

  let cfg = { ...DEFAULTS };
  const items = new Map();
  const filters = { todo: true, new: true, done: true, bad: true, gone: false };
  let sdk = null, ready = false, pushing = false, pushTimer = null, pulling = false;
  let lastStatus = '—', dirtySince = 0;
  let overlay = null, dotEls = new Map(), visibleIds = [], lastKey = '';
  let hoverId = null, hoverPin = null, hoverSeq = 0;

  const osmCache = {};
  let osmSaveTimer = null;

  /* ---------- ustawienia ---------- */
  function getCfg() {
    try {
      const v = typeof GM_getValue === 'function' ? GM_getValue('progi.cfg', null) : localStorage.getItem('progi.cfg');
      if (v) return typeof v === 'string' ? JSON.parse(v) : v;
    } catch (e) { /* ignore */ }
    return null;
  }
  function setCfg() {
    try {
      const s = JSON.stringify(cfg);
      if (typeof GM_setValue === 'function') GM_setValue('progi.cfg', s);
      else localStorage.setItem('progi.cfg', s);
    } catch (e) { /* ignore */ }
  }
  function loadOsmCache() {
    try {
      const v = typeof GM_getValue === 'function' ? GM_getValue('progi.osm', null) : localStorage.getItem('progi.osm');
      if (v) Object.assign(osmCache, typeof v === 'string' ? JSON.parse(v) : v);
    } catch (e) { /* ignore */ }
  }
  function saveOsmCache() {
    if (osmSaveTimer) return;
    osmSaveTimer = setTimeout(() => {
      osmSaveTimer = null;
      try {
        const s = JSON.stringify(osmCache);
        if (typeof GM_setValue === 'function') GM_setValue('progi.osm', s);
        else localStorage.setItem('progi.osm', s);
      } catch (e) { /* ignore */ }
    }, 4000);
  }

  /* ---------- narzędzia ---------- */
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const today = () => new Date().toLocaleDateString('sv-SE');

  function datePL(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pl-PL');
  }
  function dist(a, b, c, d) {
    const R = 6371000, r = Math.PI / 180, dl = (c - a) * r, dn = (d - b) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function b64e(str) {
    const bytes = new TextEncoder().encode(str);
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  function b64d(b64) {
    const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
    const bin = atob(clean);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u);
  }
  function mergeDocs(a, b) {
    const out = { version: 2, updated: new Date().toISOString(), synced: {}, items: {} };
    for (const src of [a, b]) {
      if (!src) continue;
      for (const k of Object.keys(src.synced || {})) out.synced[k] = Math.max(out.synced[k] || 0, src.synced[k] || 0);
      for (const id of Object.keys(src.items || {})) {
        const it = src.items[id], cur = out.items[id];
        if (!cur || (it.ts || 0) >= (cur.ts || 0)) out.items[id] = it;
      }
    }
    return out;
  }
  const stripItem = it => { const { _d, ...rest } = it; return rest; };
  const docFromItems = () => ({ version: 2, updated: new Date().toISOString(), synced: {}, items: Object.fromEntries([...items].map(([k, v]) => [k, stripItem(v)])) });
  const kindOf = it => it.gone ? 'gone' : it.done ? 'done' : it.bad ? 'bad' : (it.fs !== 'baseline' ? 'new' : 'todo');

  function applyDoc(doc) {
    const changed = [];
    if (!doc) return changed;
    for (const id of Object.keys(doc.items || {})) {
      const it = doc.items[id];
      if (!it || !it.id) continue;
      const cur = items.get(id);
      if (!cur || (it.ts || 0) > (cur.ts || 0)) { items.set(id, it); changed.push(it); }
    }
    return changed;
  }

  /* ---------- GitHub przez GM_xmlhttpRequest (omija CSP Waze) ---------- */
  function gmRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data: body, timeout: 25000,
        onload: r => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('nie udało się połączyć (sieć / firewall / VPN)')),
        ontimeout: () => reject(new Error('przekroczony czas połączenia'))
      });
    });
  }
  async function httpJson(method, url, headers, body) {
    if (typeof GM_xmlhttpRequest === 'function') {
      const r = await gmRequest(method, url, headers, body);
      return { status: r.status, json: () => { try { return JSON.parse(r.text); } catch (e) { throw new Error('odpowiedź to nie JSON'); } } };
    }
    const r = await fetch(url, { method, headers, body, cache: 'no-store' });
    return { status: r.status, json: () => r.json() };
  }
  const apiUrl = () => 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + cfg.path;

  async function ghRead() {
    if (!cfg.owner || !cfg.repo || !cfg.path) throw new Error('brak konfiguracji repo');
    if (cfg.token) {
      const r = await httpJson('GET', apiUrl() + '?ref=' + encodeURIComponent(cfg.branch || 'main'), {
        Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json'
      });
      if (r.status === 404) return { sha: null, doc: docFromItems() };
      if (r.status < 200 || r.status >= 300) throw new Error('GitHub odczyt: HTTP ' + r.status + (r.status === 401 ? ' (zły token)' : r.status === 403 ? ' (brak uprawnień / limit)' : ''));
      const j = await r.json();
      return { sha: j.sha, doc: JSON.parse(b64d(j.content)) };
    }
    const url = 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' + encodeURIComponent(cfg.branch || 'main') + '/' + cfg.path + '?t=' + Date.now();
    const r = await httpJson('GET', url, { Accept: 'application/json' });
    if (r.status === 404) return { sha: null, doc: docFromItems() };
    if (r.status < 200 || r.status >= 300) throw new Error('GitHub odczyt (raw): HTTP ' + r.status);
    return { sha: null, doc: await r.json() };
  }

  async function ghWrite(doc, msg) {
    if (!cfg.token) throw new Error('zapis wymaga tokenu GitHub (Ustawienia bazy w menu Layers)');
    let work = doc;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await ghRead();
      const merged = mergeDocs(cur.doc, work);
      const body = { message: msg || 'Aktualizacja bazy progów (WME)', branch: cfg.branch || 'main', content: b64e(JSON.stringify(merged)) };
      if (cur.sha) body.sha = cur.sha;
      const r = await httpJson('PUT', apiUrl(), {
        Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json'
      }, JSON.stringify(body));
      if (r.status === 409 || r.status === 412 || r.status === 422) { await wait(500 + attempt * 900); work = merged; continue; }
      if (r.status < 200 || r.status >= 300) throw new Error('GitHub zapis: HTTP ' + r.status);
      return merged;
    }
    throw new Error('konflikt zapisu – spróbuj ponownie');
  }

  /* ---------- data dodania z OSM (leniwie, z cache) ---------- */
  function osmType(id) {
    const c = String(id).charAt(0);
    return c === 'w' ? 'way' : c === 'r' ? 'relation' : 'node';
  }
  function osmNum(id) {
    return String(id).replace(/[^0-9]/g, '');
  }
  async function osmDate(it) {
    if (it.ot) return { t: it.ot, v: it.ov || 0 };
    const cached = osmCache[it.id];
    if (cached) return cached.miss ? null : cached;
    const num = osmNum(it.id);
    if (!num) return null;
    try {
      const r = await httpJson('GET', OSM_API + osmType(it.id) + '/' + num + '/1.json', { Accept: 'application/json' });
      if (r.status >= 200 && r.status < 300) {
        const j = await r.json();
        const el = (j.elements || [])[0];
        if (el && el.timestamp) {
          osmCache[it.id] = { t: el.timestamp, v: el.version || 1 };
          saveOsmCache();
          return osmCache[it.id];
        }
      }
      osmCache[it.id] = { miss: true };
      saveOsmCache();
      return null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- WME SDK ---------- */
  async function initSdk() {
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const get = W.getWmeSdk || window.getWmeSdk;
    if (typeof get !== 'function') return false;
    try {
      sdk = await get({ scriptId: 'progi-wme-dots', scriptName: 'Progi zwalniające' });
      return !!(sdk && sdk.Map);
    } catch (e) {
      console.warn('[Progi] SDK:', e);
      return false;
    }
  }
  function mapCenter() {
    try {
      const c = sdk.Map.getMapCenter();
      if (c && typeof c.lat === 'number' && typeof c.lon === 'number') return [c.lat, c.lon];
    } catch (e) { /* ignore */ }
    return null;
  }
  function zoomLevel() {
    try { const z = sdk.Map.getZoomLevel(); return typeof z === 'number' ? z : 0; } catch (e) { return 0; }
  }
  function mapExtent() {
    try {
      const b = sdk.Map.getMapExtent();
      if (Array.isArray(b) && b.length === 4) return b; // [left, bottom, right, top]
    } catch (e) { /* ignore */ }
    return null;
  }
  function mapPixel(it) {
    try {
      const p = sdk.Map.getMapPixelFromLonLat({ lonLat: { lat: it.lat, lon: it.lon } });
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch (e) { /* ignore */ }
    try {
      const p = sdk.Map.getPixelFromLonLat({ lonLat: { lat: it.lat, lon: it.lon } });
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---------- nakładka DOM ---------- */
  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    let vp = null;
    try { vp = sdk.Map.getMapViewportElement(); } catch (e) { return null; }
    if (!vp) return null;
    try {
      const pos = window.getComputedStyle(vp).position;
      if (pos === 'static' || !pos) vp.style.position = 'relative';
    } catch (e) { /* ignore */ }
    overlay = document.createElement('div');
    overlay.id = 'pz-overlay';
    overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:' + Z_OVERLAY;
    vp.appendChild(overlay);
    dotEls = new Map();
    return overlay;
  }

  function dotStyle() {
    return 'position:absolute;width:' + DOT_PX + 'px;height:' + DOT_PX + 'px;border-radius:50%;box-sizing:border-box;'
      + 'transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;'
      + 'border:4px solid #ffffff;box-shadow:0 0 0 2px rgba(0,0,0,.65), 0 3px 8px rgba(0,0,0,.45)';
  }

  function makeDot(id) {
    const el = document.createElement('div');
    el.className = 'pz-dot';
    el.dataset.id = id;
    el.style.cssText = dotStyle();

    el.addEventListener('mousedown', ev => { ev.stopPropagation(); }, true);

    el.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const it = items.get(id);
      if (!it) return;
      if (ev.altKey && ev.shiftKey) { toggleBad(id); return; }
      if (ev.altKey) { toggleDone(id); return; }
      showHover(it, 6000);
    }, true);

    el.addEventListener('mouseenter', () => {
      const it = items.get(id);
      if (it) showHover(it, 0);
    });
    el.addEventListener('mouseleave', () => {
      if (!hoverPin) hideHover();
    });

    return el;
  }

  function rebuildVisible() {
    if (!sdk || !ready) return;
    const ov = ensureOverlay();
    if (!ov) return;
    if (cfg.visible === false) { ov.style.display = 'none'; visibleIds = []; return; }
    ov.style.display = 'block';

    const bbox = mapExtent();
    const c = mapCenter();
    let list = [];
    for (const it of items.values()) {
      if (!filters[kindOf(it)]) continue;
      if (bbox && (it.lon < bbox[0] || it.lon > bbox[2] || it.lat < bbox[1] || it.lat > bbox[3])) continue;
      list.push(it);
    }
    if (list.length > MAX_DOTS && c) {
      list.sort((a, b) => dist(c[0], c[1], a.lat, a.lon) - dist(c[0], c[1], b.lat, b.lon));
      list = list.slice(0, MAX_DOTS);
    }

    const keep = new Set();
    for (const it of list) {
      keep.add(it.id);
      let el = dotEls.get(it.id);
      if (!el) {
        el = makeDot(it.id);
        ov.appendChild(el);
        dotEls.set(it.id, el);
      }
      el.style.background = COLORS[kindOf(it)];
    }
    for (const [id, el] of dotEls) {
      if (!keep.has(id)) { el.remove(); dotEls.delete(id); }
    }

    visibleIds = list.map(it => it.id);
    document.querySelectorAll('[data-pz-counts]').forEach(el => {
      const n = { todo: 0, new: 0, done: 0, bad: 0, gone: 0 };
      for (const it of items.values()) n[kindOf(it)]++;
      el.textContent = n.todo + ' do dodania · ' + n.done + ' dodane · ' + n.bad + ' błędne · ' + n.new + ' nowe · ' + items.size + ' razem';
    });
    if (!pushing) setStatus('na mapie: ' + list.length + ' z ' + items.size);
  }

  function positionDots() {
    if (!overlay || !overlay.isConnected) return;
    for (const [id, el] of dotEls) {
      const it = items.get(id);
      if (!it) continue;
      const p = mapPixel(it);
      if (!p) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
    }
  }

  function viewKey() {
    const c = mapCenter();
    const b = mapExtent();
    const size = (overlay && overlay.parentElement) ? (overlay.parentElement.clientWidth + 'x' + overlay.parentElement.clientHeight) : '';
    return [zoomLevel(), c ? c[0].toFixed(5) : '', c ? c[1].toFixed(5) : '', b ? b.map(v => Number(v).toFixed(4)).join(',') : '', size].join('|');
  }

  /* ---------- pasek info ---------- */
  function hoverEl() {
    let el = document.getElementById('pz-hover');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pz-hover';
      document.body.appendChild(el);
    }
    return el;
  }

  function hoverHtml(it, osm) {
    const k = kindOf(it);
    const parts = [];
    if (osm && osm.t) parts.push('w OSM od ' + datePL(osm.t) + (osm.v > 1 ? ' (v' + osm.v + ')' : ''));
    else if (it.ot) parts.push('w OSM od ' + datePL(it.ot));
    else if (it.id) parts.push('sprawdzam datę w OSM…');
    if (it.da) parts.push('dodane w Waze: ' + it.da);
    if (it.note) parts.push('„' + it.note + '”');
    return '<i style="background:' + COLORS[k] + '"></i>'
      + '<b>' + esc(TYPES[it.type] || it.type) + '</b>'
      + '<span>' + esc(NAMES[k]) + '</span>'
      + (parts.length ? '<em>' + esc(parts.join(' · ')) + '</em>' : '')
      + '<u>' + it.lat.toFixed(5) + ', ' + it.lon.toFixed(5) + '</u>';
  }

  function paintHover(it, osm) {
    const el = hoverEl();
    el.innerHTML = hoverHtml(it, osm);
    el.style.display = 'flex';
  }

  function showHover(it, holdMs) {
    if (!it) { hideHover(); return; }
    hoverId = it.id;
    hoverPin = holdMs > 0 ? it.id : null;
    clearTimeout(hoverPin);
    const seq = ++hoverSeq;
    paintHover(it, null);
    if (!it.ot && !osmCache[it.id]) {
      osmDate(it).then(d => {
        if (seq !== hoverSeq || hoverId !== it.id) return;
        const cur = items.get(it.id) || it;
        paintHover(cur, d);
      });
    }
    if (holdMs > 0) {
      hoverPin = setTimeout(() => { hoverPin = null; hideHover(); }, holdMs);
    }
  }

  function hideHover() {
    const el = document.getElementById('pz-hover');
    if (el) el.style.display = 'none';
    hoverId = null;
  }

  /* ---------- akcje ---------- */
  function setItem(id, patch, label) {
    const it = items.get(id);
    if (!it) return;
    Object.assign(it, patch, { ts: Date.now() });
    dirtySince = Date.now();
    const el = dotEls.get(id);
    if (el) el.style.background = COLORS[kindOf(it)];
    rebuildVisible();
    if (hoverId === id) showHover(it, 0);
    if (label) toast(label);
    schedulePush();
  }
  function toggleDone(id) {
    const it = items.get(id);
    if (!it) return;
    const on = !it.done;
    setItem(id, { done: on ? 1 : 0, bad: 0, da: on ? today() : '' },
      (TYPES[it.type] || it.type) + ' · ' + (on ? 'dodane' : 'do dodania'));
  }
  function toggleBad(id) {
    const it = items.get(id);
    if (!it) return;
    const on = !it.bad;
    setItem(id, { bad: on ? 1 : 0, done: 0, da: '' },
      (TYPES[it.type] || it.type) + ' · ' + (on ? 'błędne (nie ma w OSM)' : 'z powrotem do dodania'));
  }

  function schedulePush() {
    if (!cfg.token) { setStatus('auto-zapis wstrzymany – wpisz token w Ustawieniach bazy'); return; }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushNow('Aktualizacja bazy progów (WME)').catch(() => {}); }, 300);
  }
  async function pushNow(msg) {
    if (!cfg.token) throw new Error('brak tokenu');
    if (pushing) return null;
    pushing = true;
    setStatus('auto-zapis: wysyłam…');
    try {
      const merged = await ghWrite(docFromItems(), msg);
      applyDoc(merged);
      dirtySince = 0;
      const when = new Date().toLocaleTimeString('pl-PL');
      rebuildVisible();
      setTimeout(() => setStatus('auto-zapis ✓ ' + when), 60);
      return merged;
    } catch (e) {
      setStatus('auto-zapis: błąd (' + e.message + ') – ponawiam co 15 s');
      throw e;
    } finally { pushing = false; }
  }
  async function pull(loud) {
    if (pulling) return;
    pulling = true;
    try {
      const { doc } = await ghRead();
      const changed = applyDoc(doc);
      if (changed.length || loud) rebuildVisible();
      if (!pushing) setStatus('baza: ' + items.size + ' progów' + (changed.length ? ' · nowe z GitHuba: ' + changed.length : ''));
    } catch (e) {
      const hint = cfg.token ? ' – sprawdź token (Contents: read/write) i połączenie' : ' – sprawdź internet; bez tokenu czytamy raw.githubusercontent.com';
      setStatus('błąd odczytu: ' + e.message + hint);
    } finally { pulling = false; }
  }

  function dashUrl() {
    if (cfg.dash) return cfg.dash;
    const repo = cfg.repo || '';
    if (repo.toLowerCase() === String(cfg.owner || '').toLowerCase() + '.github.io') return 'https://' + repo + '/';
    return 'https://' + cfg.owner + '.github.io/' + repo + '/';
  }

  /* ---------- wygląd ---------- */
  function buildStyles() {
    if (document.getElementById('pz-style')) return;
    const st = document.createElement('style');
    st.id = 'pz-style';
    st.textContent = [
      '#pz-group,#pz-fallback{font:12px/1.45 system-ui,Segoe UI,Roboto,sans-serif}',
      '#pz-group .pz-h,#pz-fallback .pz-h{display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;font-weight:600}',
      '#pz-group .pz-h span,#pz-fallback .pz-h span{font-weight:400;opacity:.6;font-size:10px}',
      '#pz-group .pz-h button,#pz-fallback .pz-h button{background:none;border:0;color:inherit;cursor:pointer;font-size:12px;padding:0 2px}',
      '#pz-group .pz-body,#pz-fallback .pz-body{padding:2px 6px 8px}',
      '#pz-group .pz-counts,#pz-fallback .pz-counts{opacity:.75;font-size:11px;margin-bottom:4px}',
      '#pz-group label.pz-f,#pz-fallback label.pz-f{display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;font-size:12px}',
      '#pz-group label.pz-f i,#pz-fallback label.pz-f i{width:11px;height:11px;border-radius:50%;display:inline-block;flex:0 0 auto}',
      '#pz-group .pz-row,#pz-fallback .pz-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}',
      '#pz-group button.pz-b,#pz-fallback button.pz-b{background:rgba(127,127,127,.18);border:1px solid rgba(127,127,127,.45);color:inherit;border-radius:5px;padding:2px 8px;cursor:pointer;font:inherit}',
      '#pz-group details.pz-set,#pz-fallback details.pz-set{margin-top:6px;border-top:1px solid rgba(127,127,127,.3);padding-top:5px}',
      '#pz-group details.pz-set summary,#pz-fallback details.pz-set summary{cursor:pointer;opacity:.8;font-size:11px}',
      '#pz-group input[type=text],#pz-group input[type=password],#pz-fallback input[type=text],#pz-fallback input[type=password]{width:100%;box-sizing:border-box;margin-top:4px;background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.45);border-radius:4px;color:inherit;padding:2px 5px;font:inherit}',
      '#pz-group .pz-st,#pz-fallback .pz-st{font-size:10px;opacity:.7;margin-top:5px;min-height:13px}',
      '#pz-fallback{position:fixed;right:14px;bottom:14px;z-index:100000;width:255px;padding:2px;border-radius:8px;background:#1b2029;color:#e6e9ef;border:1px solid #2d3442;box-shadow:0 8px 24px rgba(0,0,0,.4)}',
      '#pz-hover{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:100002;display:none;align-items:center;gap:8px;',
      'background:rgba(17,24,39,.95);color:#fff;border:1px solid #374151;border-radius:9px;padding:7px 13px;font:13px system-ui,sans-serif;',
      'box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;max-width:92vw;white-space:nowrap;overflow:hidden}',
      '#pz-hover i{width:12px;height:12px;border-radius:50%;display:inline-block;flex:0 0 auto}',
      '#pz-hover em{font-style:normal;opacity:.85}',
      '#pz-hover u{text-decoration:none;opacity:.55;font-size:11px}',
      '#pz-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:100003;background:#111827;color:#fff;',
      'border:1px solid #374151;border-radius:8px;padding:7px 13px;font:13px system-ui,sans-serif;opacity:0;transition:opacity .25s;pointer-events:none}',
      '#pz-toast.on{opacity:1}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------- menu w Layers ---------- */
  function menuHtml() {
    return ''
      + '<div class="pz-h" data-pz-min><button type="button">' + (cfg.collapsed ? '▸' : '▾') + '</button>'
      +   '<b>Progi by Miodeq</b><span>v' + VERSION + '</span></div>'
      + '<div class="pz-body"' + (cfg.collapsed ? ' style="display:none"' : '') + '>'
      +   '<div class="pz-counts" data-pz-counts></div>'
      +   KINDS.map(k => '<label class="pz-f"><input type="checkbox" data-f="' + k + '"' + (filters[k] ? ' checked' : '') + '>'
      +     '<i style="background:' + COLORS[k] + '"></i>' + NAMES[k] + '</label>').join('')
      +   '<div class="pz-row">'
      +     '<label class="pz-f"><input type="checkbox" data-vis' + (cfg.visible === false ? '' : ' checked') + '><i style="background:#9ca3af"></i>kropki</label>'
      +     '<button class="pz-b" data-refresh type="button">Odśwież</button>'
      +     '<button class="pz-b" data-push type="button">Wyślij</button>'
      +     '<button class="pz-b" data-dash type="button">Strona</button>'
      +   '</div>'
      +   '<details class="pz-set"><summary>Ustawienia bazy</summary>'
      +     '<input type="text" data-cfg="repo" value="' + esc(cfg.owner + '/' + cfg.repo) + '" placeholder="użytkownik/repo">'
      +     '<input type="text" data-cfg="branch" value="' + esc(cfg.branch) + '" placeholder="gałąź">'
      +     '<input type="text" data-cfg="path" value="' + esc(cfg.path) + '" placeholder="data/progi.json">'
      +     '<input type="password" data-cfg="token" value="' + esc(cfg.token) + '" placeholder="token GitHub (zapis)">'
      +     '<input type="text" data-cfg="dash" value="' + esc(cfg.dash) + '" placeholder="adres strony (opcjonalnie)">'
      +     '<div class="pz-row"><button class="pz-b" data-save type="button">Zapisz i połącz</button></div>'
      +   '</details>'
      +   '<div class="pz-st" data-pz-status></div>'
      + '</div>';
  }

  function wireUi(root) {
    const min = root.querySelector('[data-pz-min]');
    if (min) min.onclick = () => {
      const body = root.querySelector('.pz-body');
      const hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : 'block';
      const btn = min.querySelector('button');
      if (btn) btn.textContent = hide ? '▸' : '▾';
      cfg.collapsed = hide;
      setCfg();
    };

    root.querySelectorAll('[data-f]').forEach(cb => {
      cb.onchange = () => { filters[cb.dataset.f] = cb.checked; rebuildVisible(); positionDots(); };
    });

    const vis = root.querySelector('[data-vis]');
    if (vis) vis.onchange = e => { cfg.visible = e.target.checked; setCfg(); rebuildVisible(); positionDots(); };

    const ref = root.querySelector('[data-refresh]');
    if (ref) ref.onclick = () => pull(true);

    const push = root.querySelector('[data-push]');
    if (push) push.onclick = () => pushNow('Ręczna aktualizacja bazy progów (WME)').catch(e => toast(e.message));

    const dash = root.querySelector('[data-dash]');
    if (dash) dash.onclick = () => { try { window.open(dashUrl(), 'progi-wme'); } catch (e) { toast('Nie udało się otworzyć strony'); } };

    const save = root.querySelector('[data-save]');
    if (save) save.onclick = async () => {
      const val = n => (root.querySelector('[data-cfg="' + n + '"]').value || '').trim();
      let repo = val('repo');
      repo = repo.split('github.com/').pop().split('?')[0];
      if (repo.endsWith('.git')) repo = repo.slice(0, -4);
      if (repo && repo.indexOf('/') > 0) {
        const parts = repo.split('/');
        cfg.owner = parts[0];
        cfg.repo = parts[1];
      } else if (repo) {
        toast('Podaj repo jako użytkownik/repo');
        return;
      }
      cfg.branch = val('branch') || 'main';
      cfg.path = val('path') || 'data/progi.json';
      cfg.token = val('token');
      cfg.dash = val('dash');
      setCfg();
      toast('Zapisano ustawienia');
      await pull(true);
    };

    setStatus(lastStatus);
    updateCounts();
  }
  function updateCounts() {
    const n = { todo: 0, new: 0, done: 0, bad: 0, gone: 0 };
    for (const it of items.values()) n[kindOf(it)]++;
    const txt = n.todo + ' do dodania · ' + n.done + ' dodane · ' + n.bad + ' błędne · ' + n.new + ' nowe · ' + items.size + ' razem';
    document.querySelectorAll('[data-pz-counts]').forEach(el => { el.textContent = txt; });
  }

  function switcherList() {
    return document.querySelector('#layer-switcher-region [class*="scrollable"] > ul')
      || document.querySelector('#layer-switcher-region ul.togglers--RNmLJ')
      || document.querySelector('#layer-switcher-region .scrollable ul')
      || document.querySelector('#layer-switcher-region ul')
      || document.querySelector('.layer-switcher .menu .scrollable ul');
  }
  function injectIntoLayerSwitcher() {
    if (document.getElementById(GROUP_ID)) return true;
    const list = switcherList();
    if (!list) return false;
    const li = document.createElement('li');
    li.id = GROUP_ID;
    li.className = 'group--Ba0d7';
    li.style.listStyle = 'none';
    li.innerHTML = menuHtml();
    list.appendChild(li);
    wireUi(li);
    const fb = document.getElementById('pz-fallback');
    if (fb) fb.remove();
    return true;
  }
  function ensureFallback() {
    if (document.getElementById(GROUP_ID) || document.getElementById('pz-fallback')) return;
    const box = document.createElement('div');
    box.id = 'pz-fallback';
    box.innerHTML = menuHtml();
    document.body.appendChild(box);
    wireUi(box);
  }

  function setStatus(s) {
    lastStatus = s;
    document.querySelectorAll('[data-pz-status]').forEach(el => { el.textContent = s; });
  }
  function toast(t) {
    let el = document.getElementById('pz-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pz-toast';
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('on'), 2400);
  }

  /* ---------- pętla rysowania ---------- */
  function loop() {
    if (sdk && ready && cfg.visible !== false) {
      const key = viewKey();
      if (key !== lastKey) {
        lastKey = key;
        rebuildVisible();
      }
      positionDots();
    }
    requestAnimationFrame(loop);
  }

  async function boot() {
    const saved = getCfg();
    if (saved) cfg = { ...DEFAULTS, ...saved };
    loadOsmCache();
    buildStyles();

    let tries = 0;
    const menuTimer = setInterval(() => {
      tries++;
      if (injectIntoLayerSwitcher()) { clearInterval(menuTimer); return; }
      if (tries > 40) { clearInterval(menuTimer); ensureFallback(); }
    }, 1000);
    injectIntoLayerSwitcher();
    setInterval(() => {
      if (!document.getElementById(GROUP_ID)) injectIntoLayerSwitcher();
    }, 4000);

    setStatus('czekam na WME SDK…');
    for (let i = 0; i < 90 && !ready; i++) {
      if (await initSdk()) { ready = true; break; }
      await wait(1000);
    }
    if (!ready) { setStatus('brak WME SDK – odśwież edytor (F5)'); return; }

    ensureOverlay();
    lastKey = '';
    requestAnimationFrame(loop);

    await pull(true);

    setInterval(() => {
      if (document.visibilityState === 'visible' && !pushing) pull(false);
    }, Math.max(10, cfg.interval || 20) * 1000);

    // ponawianie nieudanego auto-zapisu
    setInterval(() => {
      if (dirtySince && !pushing && cfg.token) pushNow('Aktualizacja bazy progów (WME)').catch(() => {});
    }, 15000);
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Progi: odśwież bazę', () => pull(true));
    GM_registerMenuCommand('Progi: wyślij zmiany teraz', () => pushNow('Ręczna aktualizacja bazy progów (WME)').catch(e => toast(e.message)));
    GM_registerMenuCommand('Progi: pokaż/ukryj menu', () => {
      const root = document.getElementById(GROUP_ID) || document.getElementById('pz-fallback');
      if (!root) return;
      const body = root.querySelector('.pz-body');
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
