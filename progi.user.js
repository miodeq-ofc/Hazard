// ==UserScript==
// @name         Progi zwalniające – warstwa WME
// @namespace    https://github.com/miodeq-ofc/Hazard
// @version      2.1.0
// @description  Kropki progów zwalniających z OSM na mapie WME + wspólna baza JSON na GitHubie, zsynchronizowana ze stroną (index.html). Alt+klik = „dodane”, Alt+Shift+klik = „błędne”.
// @author       miodeq
// @match        *://*.waze.com/*editor*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/miodeq-ofc/Hazard/main/progi.user.js
// @downloadURL  https://raw.githubusercontent.com/miodeq-ofc/Hazard/main/progi.user.js
// @supportURL   https://github.com/miodeq-ofc/Hazard
// ==/UserScript==

/*  Progi zwalniające – warstwa WME (2.1.0)

    CO ROBI:
    - rysuje na mapie WME kropki progów zwalniających (traffic_calming) z bazy data/progi.json
    - kolory: pomarańczowy = do dodania, niebieski = nowe, zielony = dodane,
      fioletowy = błędne (nie ma w OSM, a w terenie jest), czerwony = zniknęły z OSM
    - Alt + klik na kropce      = przełącz „dodane”
    - Alt + Shift + klik        = przełącz „błędne”
    - każda zmiana od razu leci do GitHuba (token w ustawieniach panelu)
    - co 20 s pobiera bazę z GitHuba, więc zmiany ze strony index.html widać bez odświeżania

    AKTUALIZACJE:
    - Tampermonkey sam sprawdza @updateURL / @downloadURL (raw.githubusercontent.com).
    - Żeby wymusić: ikona Tampermonkey → „Sprawdź aktualizacje skryptów”.
    - Po każdej zmianie w tym pliku trzeba podbić @version powyżej.

    SYNCHRONIZACJA ZE STRONĄ:
    - odczyt działa bez tokenu (repo publiczne → raw.githubusercontent.com)
    - zapis wymaga tokenu GitHub (fine-grained, uprawnienie „Contents: read and write”)
    - strona index.html ma własny token w swoich ustawieniach; to ten sam plik w repo
*/

(function () {
  'use strict';

  const VERSION = '2.1.0';
  const DEFAULTS = {
    owner: 'miodeq-ofc',
    repo: 'Hazard',
    branch: 'main',
    path: 'data/progi.json',
    token: '',
    dash: '',            // domyślnie https://<owner>.github.io/<repo>/
    interval: 20,        // sekundy
    visible: true,
    collapsed: false
  };

  const LAYER = 'Progi zwalniające';
  const COLORS = { todo: '#f59e0b', new: '#2563eb', done: '#16a34a', bad: '#7c3aed', gone: '#dc2626' };
  const NAMES = { todo: 'do dodania', new: 'nowe', done: 'dodane', bad: 'błędne', gone: 'zniknęły z OSM' };
  const KINDS = ['todo', 'new', 'done', 'bad', 'gone'];
  const TYPES = { bump: 'bump (próg)', hump: 'hump (garb)', table: 'table (płaski)', cushion: 'cushion (poduszka)' };
  const MAX = 4000;        // maks. kropek przy dużym zbliżeniu
  const MAX_FAR = 1200;    // maks. kropek przy oddaleniu
  const HIT_M = 60;        // promień trafienia Alt+klik (metry)

  let cfg = { ...DEFAULTS };
  const items = new Map();
  const filters = { todo: true, new: true, done: true, bad: true, gone: false };
  let sdk = null, ready = false, pushing = false, pushTimer = null, pulling = false, dashWin = null, rafPending = false;

  /* ---------- magazyn ustawień (GM albo localStorage) ---------- */
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
    const bin = atob(String(b64 || '').replace(/\s/g, ''));
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

  /* ---------- GitHub ---------- */
  const apiUrl = () => `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`;
  async function ghRead() {
    if (!cfg.owner || !cfg.repo || !cfg.path) throw new Error('brak konfiguracji repo');
    if (cfg.token) {
      const r = await fetch(`${apiUrl()}?ref=${encodeURIComponent(cfg.branch || 'main')}`, {
        cache: 'no-store',
        headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json' }
      });
      if (r.status === 404) return { sha: null, doc: docFromItems() };
      if (!r.ok) throw new Error('GitHub odczyt: HTTP ' + r.status + (r.status === 401 ? ' (zły token)' : r.status === 403 ? ' (brak uprawnień / limit)' : ''));
      const j = await r.json();
      return { sha: j.sha, doc: JSON.parse(b64d(j.content)) };
    }
    const url = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${encodeURIComponent(cfg.branch || 'main')}/${cfg.path}?t=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 404) return { sha: null, doc: docFromItems() };
    if (!r.ok) throw new Error('GitHub odczyt (raw): HTTP ' + r.status);
    return { sha: null, doc: await r.json() };
  }
  async function ghWrite(doc, msg) {
    if (!cfg.token) throw new Error('zapis wymaga tokenu GitHub (ustawienia w panelu)');
    let work = doc;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await ghRead();
      const merged = mergeDocs(cur.doc, work);
      const body = { message: msg || 'Aktualizacja bazy progów (WME)', branch: cfg.branch || 'main', content: b64e(JSON.stringify(merged)) };
      if (cur.sha) body.sha = cur.sha;
      const r = await fetch(apiUrl(), {
        method: 'PUT', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.status === 409 || r.status === 412 || r.status === 422) { await wait(500 + attempt * 900); work = merged; continue; }
      if (!r.ok) throw new Error('GitHub zapis: HTTP ' + r.status);
      return merged;
    }
    throw new Error('konflikt zapisu – spróbuj ponownie');
  }

  /* ---------- ikony kropek (base64, jak w dokumentacji SDK) ---------- */
  const iconCache = {};
  function icon(color) {
    if (!iconCache[color]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="7" fill="${color}" stroke="#ffffff" stroke-width="2.5"/></svg>`;
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
    // addLayer rzuca InvalidStateError, gdy warstwa istnieje → usuwamy i tworzymy od nowa,
    // dzięki temu po aktualizacji skryptu nowe kolory zawsze się aplikują
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
  function zoom() {
    try { const z = sdk.Map.getZoomLevel(); return typeof z === 'number' ? z : 0; } catch (e) { return 0; }
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  function render() {
    if (!sdk || !ready) return;
    const list = [];
    for (const it of items.values()) if (filters[kindOf(it)]) list.push(it);

    const c = mapCenter();
    const cap = zoom() >= 14 ? MAX : MAX_FAR;
    let shown = list;
    if (list.length > cap) {
      shown = c ? list.slice().sort((a, b) => dist(c[0], c[1], a.lat, a.lon) - dist(c[0], c[1], b.lat, b.lon)).slice(0, cap) : list.slice(0, cap);
    }

    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER }); } catch (e) { /* warstwy jeszcze nie ma */ }

    const features = shown.map(it => ({
      id: String(it.id),
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
      properties: { k: kindOf(it) }
    }));

    // dodajemy partiami – 4000 punktów w jednym wywołaniu potrafi zamulić edytor
    for (let i = 0; i < features.length; i += 1500) {
      try { sdk.Map.addFeaturesToLayer({ layerName: LAYER, features: features.slice(i, i + 1500) }); }
      catch (e) {
        console.warn('[Progi] addFeaturesToLayer:', e);
        setStatus('błąd rysowania: ' + (e && e.message ? e.message : e));
        break;
      }
    }

    updatePanel();
    setStatus(`na mapie: ${features.length} z ${items.size}` + (list.length > shown.length ? ' (najbliższe środkowi mapy)' : ''));
  }

  /* ---------- Alt + klik ---------- */
  function nearest(lat, lon, maxM) {
    let best = null, bd = maxM;
    for (const it of items.values()) {
      if (!filters[kindOf(it)]) continue;
      const d = dist(lat, lon, it.lat, it.lon);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }
  function attachMapClick() {
    if (!sdk || !ready) return;
    let el = null;
    try { el = sdk.Map.getMapViewportElement(); } catch (e) { return; }
    if (!el || el.__pzClick) return;
    el.__pzClick = true;
    el.addEventListener('click', ev => {
      if (!ev.altKey) return;
      let ll = null;
      try { ll = sdk.Map.getLonLatFromPixel({ x: ev.clientX, y: ev.clientY }); } catch (e) { /* ignore */ }
      if (!ll || typeof ll.lat !== 'number' || typeof ll.lon !== 'number') return;
      const hit = nearest(ll.lat, ll.lon, HIT_M);
      if (!hit) { toast('Brak progu w promieniu ' + HIT_M + ' m'); return; }
      ev.preventDefault(); ev.stopPropagation();
      if (ev.shiftKey) toggleBad(hit.id); else toggleDone(hit.id);
    }, true);
  }

  /* ---------- akcje ---------- */
  function broadcast(arr) {
    const msg = { kind: 'progi:items', items: (arr || []).map(stripItem) };
    if (dashWin) { try { dashWin.postMessage(msg, '*'); } catch (e) { /* ignore */ } }
  }
  function setItem(id, patch, label) {
    const it = items.get(id);
    if (!it) return;
    Object.assign(it, patch, { ts: Date.now() });
    updatePanel();
    scheduleRender();
    broadcast([it]);
    if (label) toast(label);
    schedulePush();
  }
  function toggleDone(id) {
    const it = items.get(id);
    if (!it) return;
    const on = !it.done;
    setItem(id, { done: on ? 1 : 0, bad: 0, da: on ? today() : '' },
      `${TYPES[it.type] || it.type} · ${on ? 'dodane' : 'do dodania'}`);
  }
  function toggleBad(id) {
    const it = items.get(id);
    if (!it) return;
    const on = !it.bad;
    setItem(id, { bad: on ? 1 : 0, done: 0, da: '' },
      `${TYPES[it.type] || it.type} · ${on ? 'błędne (nie ma w OSM)' : 'z powrotem do dodania'}`);
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
      setStatus('zapisano · ' + new Date().toLocaleTimeString('pl-PL'));
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
      setStatus(`baza: ${items.size} progów` + (changed.length ? ` · nowe z GitHuba: ${changed.length}` : ''));
    } catch (e) {
      setStatus('błąd odczytu: ' + e.message);
    } finally { pulling = false; }
  }

  function dashUrl() {
    if (cfg.dash) return cfg.dash;
    const repo = cfg.repo || '';
    if (repo.toLowerCase() === `${(cfg.owner || '').toLowerCase()}.github.io`) return `https://${repo}/`;
    return `https://${cfg.owner}.github.io/${repo}/`;
  }

  /* ---------- panel ---------- */
  let panel, statusEl, countsEl;
  function buildPanel() {
    const box = document.createElement('div');
    box.id = 'pz-panel';
    box.innerHTML = `
      <style>
        #pz-panel{position:fixed;top:70px;right:16px;z-index:100000;width:300px;font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif;
          background:#1b2029;color:#e6e9ef;border:1px solid #2d3442;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
        #pz-panel .pz-h{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#222836;border-radius:10px 10px 0 0}
        #pz-panel .pz-h b{flex:1;font-size:13px}
        #pz-panel .pz-h span{font-size:11px;color:#7d8798}
        #pz-panel .pz-h button{background:#2d3442;color:#e6e9ef;border:1px solid #3b4353;border-radius:6px;padding:1px 7px;cursor:pointer}
        #pz-panel .pz-b{padding:10px 11px;display:${cfg.collapsed ? 'none' : 'block'}}
        #pz-panel .pz-counts{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:#98a2b3}
        #pz-panel .pz-counts b{display:block;font-size:14px;color:#e6e9ef}
        #pz-panel .pz-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:7px}
        #pz-panel label{display:inline-flex;gap:4px;align-items:center;cursor:pointer;font-size:12px}
        #pz-panel .pz-dot{width:10px;height:10px;border-radius:50%;display:inline-block}
        #pz-panel button.pz-act{background:#2563eb;border:1px solid #2563eb;color:#fff;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
        #pz-panel button.pz-sec{background:#2d3442;border:1px solid #3b4353;color:#e6e9ef;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
        #pz-panel input[type=text],#pz-panel input[type=password]{background:#12151c;border:1px solid #2d3442;color:#e6e9ef;border-radius:6px;padding:3px 6px;width:100%;font:inherit}
        #pz-panel details{margin-top:8px;border-top:1px solid #2d3442;padding-top:8px}
        #pz-panel summary{cursor:pointer;color:#98a2b3;font-size:12px}
        #pz-panel .pz-st{font-size:11px;color:#98a2b3;margin-top:6px;min-height:15px}
        #pz-panel .pz-tiny{font-size:11px;color:#7d8798;margin:2px 0 6px}
        #pz-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:100001;background:#111827;color:#fff;
          border:1px solid #374151;border-radius:8px;padding:7px 13px;font:13px system-ui,sans-serif;opacity:0;transition:opacity .25s;pointer-events:none}
        #pz-toast.on{opacity:1}
      </style>
      <div class="pz-h"><b>Progi zwalniające</b><span>v${VERSION}</span><button data-min>–</button></div>
      <div class="pz-b">
        <div class="pz-counts" id="pz-counts"></div>
        <div class="pz-row">
          ${KINDS.map(k => `<label><span class="pz-dot" style="background:${COLORS[k]}"></span><input type="checkbox" data-f="${k}" ${filters[k] ? 'checked' : ''}> ${NAMES[k]}</label>`).join('')}
        </div>
        <div class="pz-row">
          <button class="pz-act" data-refresh>Odśwież</button>
          <button class="pz-sec" data-dash>Otwórz stronę</button>
          <button class="pz-sec" data-push>Wyślij</button>
          <label><input type="checkbox" data-vis ${cfg.visible === false ? '' : 'checked'}> warstwa</label>
        </div>
        <div class="pz-tiny">Alt + klik = „dodane” · Alt + Shift + klik = „błędne”</div>
        <div class="pz-st" id="pz-status">—</div>
        <details>
          <summary>Ustawienia bazy</summary>
          <div class="pz-row" style="margin-top:6px"><input type="text" data-cfg="repo" value="${esc(cfg.owner + '/' + cfg.repo)}" placeholder="użytkownik/repo"></div>
          <div class="pz-row"><input type="text" data-cfg="branch" value="${esc(cfg.branch)}" placeholder="gałąź"></div>
          <div class="pz-row"><input type="text" data-cfg="path" value="${esc(cfg.path)}" placeholder="data/progi.json"></div>
          <div class="pz-row"><input type="password" data-cfg="token" value="${esc(cfg.token)}" placeholder="token GitHub (zapis)"></div>
          <div class="pz-row"><input type="text" data-cfg="dash" value="${esc(cfg.dash)}" placeholder="adres strony (opcjonalnie)"></div>
          <div class="pz-row"><button class="pz-sec" data-save>Zapisz i połącz</button></div>
        </details>
      </div>`;
    document.body.appendChild(box);
    const toastEl = document.createElement('div');
    toastEl.id = 'pz-toast';
    document.body.appendChild(toastEl);

    panel = box;
    statusEl = box.querySelector('#pz-status');
    countsEl = box.querySelector('#pz-counts');

    box.querySelector('[data-min]').onclick = () => {
      const body = box.querySelector('.pz-b');
      cfg.collapsed = body.style.display !== 'none';
      body.style.display = cfg.collapsed ? 'none' : 'block';
      setCfg();
    };
    box.querySelectorAll('[data-f]').forEach(cb => {
      cb.onchange = () => { filters[cb.dataset.f] = cb.checked; scheduleRender(); };
    });
    box.querySelector('[data-refresh]').onclick = () => pull(true);
    box.querySelector('[data-dash]').onclick = () => {
      const url = dashUrl();
      try { dashWin = window.open(url, 'progi-wme-panel'); }
      catch (e) { toast('Nie udało się otworzyć: ' + url); }
    };
    box.querySelector('[data-push]').onclick = () => pushNow('Ręczna aktualizacja bazy progów (WME)').catch(e => toast(e.message));
    box.querySelector('[data-vis]').onchange = e => { cfg.visible = e.target.checked; setCfg(); setVisibility(cfg.visible); };
    box.querySelector('[data-save]').onclick = async () => {
      const repo = box.querySelector('[data-cfg="repo"]').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Podaj repo jako użytkownik/repo'); return; }
      if (repo) { cfg.owner = repo.split('/')[0]; cfg.repo = repo.split('/')[1]; }
      cfg.branch = box.querySelector('[data-cfg="branch"]').value.trim() || 'main';
      cfg.path = box.querySelector('[data-cfg="path"]').value.trim() || 'data/progi.json';
      cfg.token = box.querySelector('[data-cfg="token"]').value.trim();
      cfg.dash = box.querySelector('[data-cfg="dash"]').value.trim();
      setCfg();
      toast('Zapisano ustawienia');
      await pull(true);
    };
    updatePanel();
  }
  function toast(t) {
    const el = document.getElementById('pz-toast');
    if (!el) return;
    el.textContent = t;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('on'), 2400);
  }
  function updatePanel() {
    if (!countsEl) return;
    const n = { todo: 0, new: 0, done: 0, bad: 0, gone: 0 };
    for (const it of items.values()) n[kindOf(it)]++;
    countsEl.innerHTML = ['todo', 'done', 'bad', 'new', 'gone']
      .map(k => `<span><b>${n[k]}</b>${NAMES[k]}</span>`).join('');
  }
  function setStatus(s) { if (statusEl) statusEl.textContent = s; }

  /* ---------- start ---------- */
  async function boot() {
    const saved = getCfg();
    if (saved) cfg = { ...DEFAULTS, ...saved };
    buildPanel();
    setStatus('czekam na WME SDK…');
    for (let i = 0; i < 90 && !ready; i++) {
      if (await initSdk()) { ready = true; break; }
      await wait(1000);
    }
    if (!ready) { setStatus('brak WME SDK – odśwież edytor (F5)'); return; }
    createLayer();
    attachMapClick();
    setInterval(() => { try { attachMapClick(); } catch (e) { /* ignore */ } }, 10000);
    await pull(true);
    setInterval(() => {
      if (document.visibilityState === 'visible' && !pushing) pull(false);
    }, Math.max(10, cfg.interval || 20) * 1000);
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Progi: odśwież bazę', () => pull(true));
    GM_registerMenuCommand('Progi: wyślij zmiany', () => pushNow('Ręczna aktualizacja bazy progów (WME)').catch(e => toast(e.message)));
    GM_registerMenuCommand('Progi: pokaż/ukryj panel', () => {
      if (!panel) return;
      const body = panel.querySelector('.pz-b');
      const hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : 'block';
      cfg.collapsed = hide;
      setCfg();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
