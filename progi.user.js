// ==UserScript==
// @name         Progi zwalniające – warstwa WME
// @namespace    https://github.com/miodeq-ofc/Hazard
// @version      2.2.0
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
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/miodeq-ofc/Hazard/main/progi.user.js
// @downloadURL  https://raw.githubusercontent.com/miodeq-ofc/Hazard/main/progi.user.js
// @supportURL   https://github.com/miodeq-ofc/Hazard
// ==/UserScript==

/*  Progi zwalniające – warstwa WME (2.2.0)

    CO ROBI:
    - rysuje kropki progów zwalniających (traffic_calming) z bazy data/progi.json
    - kropki są duże (26 px) i leżą NAD segmentami; klik w kropkę nie zaznacza segmentu pod nią
    - kolory: pomarańczowy = do dodania, niebieski = nowe, zielony = dodane,
      fioletowy = błędne (nie ma w OSM, a w terenie jest), czerwony = zniknęły z OSM
    - najechanie na kropkę = pasek u góry z typem, stanem i datą z OSM
    - Alt + klik  = przełącz „dodane”
    - Alt + Shift + klik = przełącz „błędne”
    - każda zmiana od razu leci do GitHuba (token w ustawieniach w menu warstw)
    - co 20 s pobiera bazę z GitHuba, więc zmiany ze strony index.html widać bez odświeżania

    MENU:
    - nie ma osobnego okienka: wszystko jest w menu Layers (grupa „Progi by Miodeq”),
      tak jak w skrypcie WME Geoportal
    - ustawienia bazy (repo, gałąź, token) schowane w rozwijanym „Ustawienia bazy”
    - gdyby WME nie miało jeszcze menu warstw, po chwili pojawi się awaryjne okienko

    AKTUALIZACJE:
    - Tampermonkey sam sprawdza @updateURL / @downloadURL (raw.githubusercontent.com).
    - Żeby wymusić: ikona Tampermonkey → „Sprawdź aktualizacje skryptów”.
    - Po każdej zmianie w tym pliku trzeba podbić @version powyżej.

    SYNCHRONIZACJA ZE STRONĄ:
    - odczyt działa bez tokenu (repo publiczne → raw.githubusercontent.com)
    - połączenia idą przez GM_xmlhttpRequest, więc CSP Waze (connect-src) ich nie blokuje
    - zapis wymaga tokenu GitHub (fine-grained, uprawnienie „Contents: read and write”)
*/

(function () {
  'use strict';

  const VERSION = '2.2.0';
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

  const LAYER = 'Progi zwalniające';
  const GROUP_ID = 'pz-group';
  const COLORS = { todo: '#f59e0b', new: '#2563eb', done: '#16a34a', bad: '#7c3aed', gone: '#dc2626' };
  const NAMES = { todo: 'do dodania', new: 'nowe', done: 'dodane', bad: 'błędne', gone: 'zniknęły z OSM' };
  const KINDS = ['todo', 'new', 'done', 'bad', 'gone'];
  const TYPES = { bump: 'bump (próg)', hump: 'hump (garb)', table: 'table (płaski)', cushion: 'cushion (poduszka)' };

  const DOT_PX = 26;        // średnica kropki na mapie
  const HIT_PX = 16;        // promień trafienia kursorem (piksele)
  const MAX = 4000;         // maks. kropek przy dużym zbliżeniu
  const MAX_FAR = 1200;     // maks. kropek przy oddaleniu
  const Z_INDEX = 4000;     // ponad segmentami i warstwami Geoportalu (te mają 3000)

  let cfg = { ...DEFAULTS };
  const items = new Map();
  const filters = { todo: true, new: true, done: true, bad: true, gone: false };
  let sdk = null, ready = false, pushing = false, pushTimer = null, pulling = false, rafPending = false;
  let lastStatus = '—', hoverTimer = 0, hoverId = null, hoverHide = null;

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

  function osmLine(it) {
    const parts = [];
    if (it.ot) parts.push('w OSM: ' + datePL(it.ot) + (it.ov ? ' (v' + it.ov + ')' : ''));
    if (it.da) parts.push('dodane w Waze: ' + it.da);
    if (it.note) parts.push('„' + it.note + '”');
    return parts.join(' · ');
  }

  /* ---------- GitHub (GM_xmlhttpRequest omija CSP i CORS) ---------- */
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
    if (!cfg.token) throw new Error('zapis wymaga tokenu GitHub (Ustawienia bazy w menu warstw)');
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

  /* ---------- ikony ---------- */
  const iconCache = {};
  function icon(color) {
    if (!iconCache[color]) {
      const r = DOT_PX / 2 - 2;
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + DOT_PX + '" height="' + DOT_PX + '"><circle cx="' + (DOT_PX / 2) + '" cy="' + (DOT_PX / 2) + '" r="' + r + '" fill="' + color + '" stroke="#ffffff" stroke-width="3"/></svg>';
      iconCache[color] = 'data:image/svg+xml;base64,' + btoa(svg);
    }
    return iconCache[color];
  }
  const styleOf = k => ({ externalGraphic: icon(COLORS[k]), fillOpacity: 1, strokeOpacity: 1 });

  /* ---------- WME SDK ---------- */
  async function initSdk() {
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const get = W.getWmeSdk || window.getWmeSdk;
    if (typeof get !== 'function') return false;
    try {
      sdk = await get({ scriptId: 'progi-wme-layer', scriptName: 'Progi zwalniające' });
      return !!(sdk && sdk.Map);
    } catch (e) {
      console.warn('[Progi] SDK:', e);
      return false;
    }
  }

  function createLayer() {
    if (!sdk) return;
    try { sdk.Map.removeLayer({ layerName: LAYER }); } catch (e) { /* nie było */ }
    const rules = [{ style: { externalGraphic: icon('#9ca3af'), fillOpacity: 1 } }];
    for (const k of KINDS) rules.push({ predicate: p => p && p.k === k, style: styleOf(k) });
    try {
      sdk.Map.addLayer({ layerName: LAYER, zIndexing: true, styleRules: rules });
    } catch (e) {
      console.warn('[Progi] addLayer:', e);
      setStatus('nie udało się utworzyć warstwy: ' + (e && e.message ? e.message : e));
      return;
    }
    // nad segmentami i nad warstwami geoportalu (3000)
    try { sdk.Map.setLayerZIndex({ layerName: LAYER, zIndex: Z_INDEX }); } catch (e) { /* starsze SDK */ }
    setVisibility(cfg.visible !== false);
  }

  function setVisibility(v) {
    if (!sdk) return;
    try { sdk.Map.setLayerVisibility({ layerName: LAYER, visibility: !!v }); }
    catch (e) { try { sdk.Map.setLayerVisibility({ layerName: LAYER, visible: !!v }); } catch (_) { /* ignore */ } }
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
  function pixelOf(it) {
    try {
      const p = sdk.Map.getPixelFromLonLat({ lonLat: { lat: it.lat, lon: it.lon } });
      return (p && typeof p.x === 'number' && typeof p.y === 'number') ? p : null;
    } catch (e) { return null; }
  }

  /* ---------- rysowanie ---------- */
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  function visibleList() {
    const out = [];
    for (const it of items.values()) if (filters[kindOf(it)]) out.push(it);
    return out;
  }

  function render() {
    if (!sdk || !ready) return;
    const list = visibleList();
    const c = mapCenter();
    const cap = zoomLevel() >= 14 ? MAX : MAX_FAR;
    let shown = list;
    if (list.length > cap) {
      shown = c ? list.slice().sort((a, b) => dist(c[0], c[1], a.lat, a.lon) - dist(c[0], c[1], b.lat, b.lon)).slice(0, cap) : list.slice(0, cap);
    }

    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER }); } catch (e) { /* brak warstwy */ }

    const features = shown.map(it => ({
      id: String(it.id),
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
      properties: { k: kindOf(it) }
    }));

    for (let i = 0; i < features.length; i += 1500) {
      try { sdk.Map.addFeaturesToLayer({ layerName: LAYER, features: features.slice(i, i + 1500) }); }
      catch (e) {
        console.warn('[Progi] addFeaturesToLayer:', e);
        setStatus('błąd rysowania: ' + (e && e.message ? e.message : e));
        break;
      }
    }

    updatePanel();
    if (!pushing) setStatus('na mapie: ' + features.length + ' z ' + items.size + (list.length > shown.length ? ' (najbliższe środkowi mapy)' : ''));
  }

  /* ---------- trafianie w kropkę ---------- */
  function hitTest(clientX, clientY) {
    if (!sdk || !ready || cfg.visible === false) return null;
    let ll = null;
    try { ll = sdk.Map.getLonLatFromPixel({ x: clientX, y: clientY }); } catch (e) { return null; }
    if (!ll || typeof ll.lat !== 'number' || typeof ll.lon !== 'number') return null;

    const cands = [];
    for (const it of items.values()) {
      if (!filters[kindOf(it)]) continue;
      const d = dist(ll.lat, ll.lon, it.lat, it.lon);
      if (d <= 120) cands.push([d, it]);
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a[0] - b[0]);

    for (let i = 0; i < cands.length && i < 8; i++) {
      const it = cands[i][1];
      const p = pixelOf(it);
      if (p && Math.abs(p.x - clientX) <= HIT_PX && Math.abs(p.y - clientY) <= HIT_PX) return it;
    }
    return null;
  }

  /* ---------- pasek info u góry ---------- */
  function hoverEl() {
    let el = document.getElementById('pz-hover');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pz-hover';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  }
  function showHover(it, holdMs) {
    if (!it) { hideHover(); return; }
    const k = kindOf(it);
    const el = hoverEl();
    el.innerHTML = '<i style="background:' + COLORS[k] + '"></i>'
      + '<b>' + esc(TYPES[it.type] || it.type) + '</b>'
      + '<span>' + esc(NAMES[k]) + '</span>'
      + (osmLine(it) ? '<em>' + esc(osmLine(it)) + '</em>' : '')
      + '<u>' + (it.lat.toFixed(5) + ', ' + it.lon.toFixed(5)) + '</u>';
    el.style.display = 'flex';
    hoverId = it.id;
    clearTimeout(hoverHide);
    if (holdMs) hoverHide = setTimeout(() => hideHover(), holdMs);
  }
  function hideHover() {
    const el = document.getElementById('pz-hover');
    if (el) el.style.display = 'none';
    hoverId = null;
  }

  /* ---------- zdarzenia mapy ---------- */
  function attachMapHandlers() {
    if (!sdk || !ready) return;
    let el = null;
    try { el = sdk.Map.getMapViewportElement(); } catch (e) { return; }
    if (!el || el.__pzHandlers) return;
    el.__pzHandlers = true;

    el.addEventListener('mousedown', ev => {
      if (hitTest(ev.clientX, ev.clientY)) ev.stopPropagation();
    }, true);

    el.addEventListener('click', ev => {
      const hit = hitTest(ev.clientX, ev.clientY);
      if (!hit) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.altKey && ev.shiftKey) { toggleBad(hit.id); return; }
      if (ev.altKey) { toggleDone(hit.id); return; }
      showHover(hit, 6000);
    }, true);

    el.addEventListener('mousemove', ev => {
      const now = Date.now();
      if (now - hoverTimer < 60) return;
      hoverTimer = now;
      const hit = hitTest(ev.clientX, ev.clientY);
      if (!hit) { if (hoverId) hideHover(); return; }
      if (hit.id === hoverId) return;
      showHover(hit, 0);
    }, true);

    el.addEventListener('mouseleave', () => hideHover(), true);
  }

  /* ---------- akcje ---------- */
  function setItem(id, patch, label) {
    const it = items.get(id);
    if (!it) return;
    Object.assign(it, patch, { ts: Date.now() });
    updatePanel();
    scheduleRender();
    if (hoverId === id) showHover(it, 2500);
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
    if (!cfg.token) { setStatus('zmiana lokalna – brak tokenu, nie zapisano w GitHubie'); return; }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushNow('Aktualizacja bazy progów (WME)').catch(() => {}); }, 600);
  }
  async function pushNow(msg) {
    if (!cfg.token) throw new Error('brak tokenu');
    if (pushing) return null;
    pushing = true;
    setStatus('zapisuję w GitHubie…');
    try {
      const merged = await ghWrite(docFromItems(), msg);
      applyDoc(merged);
      updatePanel();
      scheduleRender();
      const when = new Date().toLocaleTimeString('pl-PL');
      // po rysowaniu, żeby „na mapie: …” nie nadpisało potwierdzenia zapisu
      setTimeout(() => setStatus('zapisano · ' + when), 60);
      return merged;
    } catch (e) {
      setStatus('błąd zapisu: ' + e.message);
      throw e;
    } finally { pushing = false; }
  }
  async function pull(loud) {
    if (pulling) return;
    pulling = true;
    try {
      const { doc } = await ghRead();
      const changed = applyDoc(doc);
      if (changed.length || loud) scheduleRender();
      updatePanel();
      setStatus('baza: ' + items.size + ' progów' + (changed.length ? ' · nowe z GitHuba: ' + changed.length : ''));
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
      'background:rgba(17,24,39,.94);color:#fff;border:1px solid #374151;border-radius:9px;padding:6px 12px;font:13px system-ui,sans-serif;',
      'box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;max-width:92vw;white-space:nowrap;overflow:hidden}',
      '#pz-hover i{width:12px;height:12px;border-radius:50%;display:inline-block;flex:0 0 auto}',
      '#pz-hover em{font-style:normal;opacity:.8}',
      '#pz-hover u{text-decoration:none;opacity:.55;font-size:11px}',
      '#pz-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:100003;background:#111827;color:#fff;',
      'border:1px solid #374151;border-radius:8px;padding:7px 13px;font:13px system-ui,sans-serif;opacity:0;transition:opacity .25s;pointer-events:none}',
      '#pz-toast.on{opacity:1}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------- markup menu ---------- */
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
      cb.onchange = () => { filters[cb.dataset.f] = cb.checked; scheduleRender(); };
    });

    const vis = root.querySelector('[data-vis]');
    if (vis) vis.onchange = e => { cfg.visible = e.target.checked; setCfg(); setVisibility(cfg.visible); };

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

    updatePanel();
    setStatus(lastStatus);
  }

  /* ---------- wstrzyknięcie do menu Layers ---------- */
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

  function updatePanel() {
    const n = { todo: 0, new: 0, done: 0, bad: 0, gone: 0 };
    for (const it of items.values()) n[kindOf(it)]++;
    const txt = n.todo + ' do dodania · ' + n.done + ' dodane · ' + n.bad + ' błędne · ' + n.new + ' nowe · ' + items.size + ' razem';
    document.querySelectorAll('[data-pz-counts]').forEach(el => { el.textContent = txt; });
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

  /* ---------- start ---------- */
  async function boot() {
    const saved = getCfg();
    if (saved) cfg = { ...DEFAULTS, ...saved };
    buildStyles();

    // menu warstw może pojawić się później niż skrypt
    let tries = 0;
    const menuTimer = setInterval(() => {
      tries++;
      if (injectIntoLayerSwitcher()) { clearInterval(menuTimer); return; }
      if (tries > 40) { clearInterval(menuTimer); ensureFallback(); }
    }, 1000);
    injectIntoLayerSwitcher();

    // WME potrafi przerysować menu – dokładamy grupę z powrotem
    setInterval(() => {
      if (!document.getElementById(GROUP_ID)) injectIntoLayerSwitcher();
    }, 4000);

    setStatus('czekam na WME SDK…');
    for (let i = 0; i < 90 && !ready; i++) {
      if (await initSdk()) { ready = true; break; }
      await wait(1000);
    }
    if (!ready) { setStatus('brak WME SDK – odśwież edytor (F5)'); return; }

    createLayer();
    attachMapHandlers();
    setInterval(() => { try { attachMapHandlers(); } catch (e) { /* ignore */ } }, 10000);

    await pull(true);
    setInterval(() => {
      if (document.visibilityState === 'visible' && !pushing) pull(false);
    }, Math.max(10, cfg.interval || 20) * 1000);
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Progi: odśwież bazę', () => pull(true));
    GM_registerMenuCommand('Progi: wyślij zmiany', () => pushNow('Ręczna aktualizacja bazy progów (WME)').catch(e => toast(e.message)));
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
