// ==UserScript==
// @name         Progi zwalniające – warstwa WME
// @namespace    https://github.com/miodeq-ofc/Hazard
// @version      2.0.0
// @description  Kropki progów zwalniających z OSM na mapie WME + wspólna baza JSON na GitHubie, zsynchronizowana ze stroną (index.html).
// @author       miodeq
// @match        https://www.waze.com/editor*
// @match        https://beta.waze.com/editor*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

/* Baza: plik JSON w repozytorium GitHub (domyślnie miodeq-ofc/Hazard, data/progi.json).
   Strona index.html czyta i zapisuje dokładnie ten sam plik.
   - odczyt: GitHub Contents API (z tokenem) albo raw.githubusercontent (bez tokenu, repo publiczne)
   - zapis: Contents API + token (fine-grained, uprawnienie "Contents: read and write")
   - natychmiastowa synchronizacja ze stroną: window.postMessage, gdy panel otwarty przyciskiem poniżej
   - bez otwartego panelu: odświeżanie z GitHuba co 20 s                                          */

(function () {
  'use strict';

  const DEFAULTS = {
    owner: 'miodeq-ofc',
    repo: 'Hazard',
    branch: 'main',
    path: 'data/progi.json',
    token: '',
    dash: '',            // domyślnie https://<owner>.github.io/<repo>/
    interval: 20,        // sekundy
    visible: true
  };
  const LAYER = 'Progi zwalniające';
  const COLORS = { todo: '#f59e0b', new: '#2563eb', done: '#16a34a', gone: '#dc2626' };
  const NAMES = { todo: 'do dodania', new: 'nowe', done: 'dodane', gone: 'zniknęły z OSM' };
  const MAX_FEATURES = 4000;
  const TYPES = { bump: 'bump (próg)', hump: 'hump (garb)', table: 'table (płaski)', cushion: 'cushion (poduszka)' };

  let cfg = { ...DEFAULTS };
  const items = new Map();
  let sdk = null, ready = false, pushing = false, pushTimer = null, pulling = false, dashWin = null;
  const filters = { todo: true, new: true, done: true, gone: false };

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
  const kindOf = it => it.gone ? 'gone' : it.done ? 'done' : (it.fs !== 'baseline' ? 'new' : 'todo');

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
        cache: 'no-store', headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json' }
      });
      if (r.status === 404) return { sha: null, doc: docFromItems() };
      if (!r.ok) throw new Error('GitHub odczyt: HTTP ' + r.status + (r.status === 401 ? ' (zły token)' : r.status === 403 ? ' (brak uprawnień / limit)' : ''));
      const j = await r.json();
      return { sha: j.sha, doc: JSON.parse(b64d(j.content)) };
    }
    const url = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${encodeURIComponent(cfg.branch || 'main')}/${cfg.path}?t=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 404) return { sha: null, doc: docFromItems() };
    if (!r.ok) throw new Error('GitHub odczyt (raw): HTTP ' + r.status + ' – repo musi być publiczne, żeby czytać bez tokenu');
    return { sha: null, doc: await r.json() };
  }
  async function ghWrite(doc, msg) {
    if (!cfg.token) throw new Error('zapis wymaga tokenu GitHub');
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

  /* ---------- panel ---------- */
  let panel, statusEl, countsEl;
  function buildPanel() {
    const box = document.createElement('div');
    box.id = 'progi-wme-panel';
    box.innerHTML = `
      <style>
        #progi-wme-panel{position:fixed;top:70px;right:16px;z-index:100000;width:290px;font:13px/1.4 system-ui,Segoe UI,Roboto,sans-serif;
          background:#1b2029;color:#e6e9ef;border:1px solid #2d3442;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden}
        #progi-wme-panel .h{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#222836;cursor:default}
        #progi-wme-panel .h b{font-size:13px;flex:1}
        #progi-wme-panel .h button{background:#2d3442;color:#e6e9ef;border:1px solid #3b4353;border-radius:6px;padding:1px 7px;cursor:pointer}
        #progi-wme-panel .b{padding:10px 11px;display:${cfg.collapsed ? 'none' : 'block'}}
        #progi-wme-panel .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:7px}
        #progi-wme-panel label{display:inline-flex;gap:4px;align-items:center;cursor:pointer}
        #progi-wme-panel .c{display:flex;gap:12px;flex-wrap:wrap;margin:4px 0 8px;font-size:12px;color:#98a2b3}
        #progi-wme-panel .c b{color:#e6e9ef;font-size:14px;display:block}
        #progi-wme-panel button.act{background:#2563eb;border:1px solid #2563eb;color:#fff;border-radius:6px;padding:4px 9px;cursor:pointer}
        #progi-wme-panel button.sec{background:#2d3442;border:1px solid #3b4353;color:#e6e9ef;border-radius:6px;padding:4px 9px;cursor:pointer}
        #progi-wme-panel input[type=text],#progi-wme-panel input[type=password]{background:#12151c;border:1px solid #2d3442;color:#e6e9ef;border-radius:6px;padding:3px 6px;width:100%}
        #progi-wme-panel details{margin-top:8px;border-top:1px solid #2d3442;padding-top:8px}
        #progi-wme-panel summary{cursor:pointer;color:#98a2b3}
        #progi-wme-panel .st{font-size:11px;color:#98a2b3;margin-top:6px;min-height:15px}
        #progi-wme-panel .tiny{font-size:11px;color:#98a2b3;margin-top:4px}
        #progi-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:100001;background:#111827;color:#fff;
          border:1px solid #374151;border-radius:8px;padding:7px 13px;font:13px system-ui,sans-serif;opacity:0;transition:opacity .25s;pointer-events:none}
        #progi-toast.on{opacity:1}
      </style>
      <div class="h"><b>Progi zwalniające</b><button data-min>–</button></div>
      <div class="b">
        <div class="c" id="progi-counts"></div>
        <div class="row">
          ${Object.keys(filters).map(k => `<label><input type="checkbox" data-f="${k}" ${filters[k] ? 'checked' : ''}> ${NAMES[k]}</label>`).join('')}
        </div>
        <div class="row">
          <button class="act" data-refresh>Odśwież</button>
          <button class="sec" data-dash>Otwórz panel</button>
          <label><input type="checkbox" data-vis ${cfg.visible === false ? '' : 'checked'}> warstwa</label>
        </div>
        <div class="tiny">Alt + klik na mapie = przełącz „dodane” dla najbliższego progu.</div>
        <div class="st" id="progi-status">—</div>
        <details>
          <summary>Ustawienia bazy</summary>
          <div class="row" style="margin-top:6px"><input type="text" data-cfg="repo" value="${esc(cfg.owner + '/' + cfg.repo)}" placeholder="użytkownik/repo"></div>
          <div class="row"><input type="text" data-cfg="branch" value="${esc(cfg.branch)}" placeholder="gałąź"></div>
          <div class="row"><input type="text" data-cfg="path" value="${esc(cfg.path)}" placeholder="data/progi.json"></div>
          <div class="row"><input type="password" data-cfg="token" value="${esc(cfg.token)}" placeholder="token GitHub (zapis)"></div>
          <div class="row"><input type="text" data-cfg="dash" value="${esc(cfg.dash)}" placeholder="adres strony (opcjonalnie)"></div>
          <div class="row"><button class="sec" data-save>Zapisz i połącz</button></div>
        </details>
      </div>`;
    document.body.appendChild(box);
    const toast = document.createElement('div');
    toast.id = 'progi-toast';
    document.body.appendChild(toast);
    panel = box;
    statusEl = box.querySelector('#progi-status');
    countsEl = box.querySelector('#progi-counts');

    box.querySelector('[data-min]').onclick = () => {
      const body = box.querySelector('.b');
      cfg.collapsed = body.style.display !== 'none';
      body.style.display = cfg.collapsed ? 'none' : 'block';
      setCfg();
    };
    box.querySelectorAll('[data-f]').forEach(cb => {
      cb.onchange = () => { filters[cb.dataset.f] = cb.checked; renderLayer(); };
    });
    box.querySelector('[data-refresh]').onclick = () => pull(true);
    box.querySelector('[data-dash]').onclick = () => openDash();
    box.querySelector('[data-vis]').onchange = e => { cfg.visible = e.target.checked; setCfg(); setVisibility(cfg.visible); };
    box.querySelector('[data-save]').onclick = async () => {
      const repo = box.querySelector('[data-cfg="repo"]').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { toastMsg('Podaj repo jako użytkownik/repo'); return; }
      if (repo) { cfg.owner = repo.split('/')[0]; cfg.repo = repo.split('/')[1]; }
      cfg.branch = box.querySelector('[data-cfg="branch"]').value.trim() || 'main';
      cfg.path = box.querySelector('[data-cfg="path"]').value.trim() || 'data/progi.json';
      cfg.token = box.querySelector('[data-cfg="token"]').value.trim();
      cfg.dash = box.querySelector('[data-cfg="dash"]').value.trim();
      setCfg();
      toastMsg('Zapisano ustawienia');
      await pull(true);
    };
    updatePanel();
  }
  function toastMsg(t) {
    const el = document.getElementById('progi-toast');
    if (!el) return;
    el.textContent = t;
    el.classList.add('on');
    clearTimeout(toastMsg._t);
    toastMsg._t = setTimeout(() => el.classList.remove('on'), 2200);
  }
  function updatePanel() {
    if (!countsEl) return;
    let todo = 0, done = 0, nw = 0;
    for (const it of items.values()) {
      if (it.gone) continue;
      if (it.done) done++;
      else if (it.fs !== 'baseline') nw++;
      else todo++;
    }
    countsEl.innerHTML = `<span><b>${todo}</b>do dodania</span><span><b>${done}</b>dodane</span><span><b>${nw}</b>nowe</span><span><b>${items.size}</b>razem</span>`;
  }
  function setStatus(s) { if (statusEl) statusEl.textContent = s; }

  /* ---------- WME SDK ---------- */
  async function initSdk() {
    const get = window.getWmeSdk || (window.unsafeWindow && window.unsafeWindow.getWmeSdk);
    if (typeof get !== 'function') return false;
    try {
      sdk = await get({ scriptId: 'progi-wme-layer', scriptName: 'Progi zwalniające' });
      return !!sdk && !!sdk.Map;
    } catch (e) {
      console.warn('[Progi] SDK:', e);
      return false;
    }
  }
  function dot(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="${color}" stroke="#ffffff" stroke-width="2"/></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function ensureLayer() {
    if (!sdk) return;
    try {
      sdk.Map.addLayer({
        layerName: LAYER,
        styleRules: Object.keys(COLORS).map(k => ({
          predicate: props => props && props.k === k,
          style: { externalGraphic: dot(COLORS[k]), fillOpacity: 1 }
        }))
      });
    } catch (e) { /* warstwa już istnieje */ }
    setVisibility(cfg.visible !== false);
  }
  function setVisibility(v) {
    if (!sdk) return;
    try { sdk.Map.setLayerVisibility({ layerName: LAYER, visible: v }); } catch (e) {
      try { sdk.Map.setLayerVisibility({ layerName: LAYER, isVisible: v }); } catch (_) { /* ignore */ }
    }
  }
  function mapCenter() {
    try {
      const c = sdk.Map.getMapCenter();
      const lat = c.lat, lon = c.lon ?? c.lng ?? c.longitude;
      if (typeof lat === 'number' && typeof lon === 'number') return [lat, lon];
    } catch (e) { /* ignore */ }
    return null;
  }
  function renderLayer() {
    if (!sdk || !ready) return;
    ensureLayer();
    let list = [];
    for (const it of items.values()) if (filters[kindOf(it)]) list.push(it);
    const c = mapCenter();
    if (c && list.length > MAX_FEATURES) {
      list.sort((a, b) => dist(c[0], c[1], a.lat, a.lon) - dist(c[0], c[1], b.lat, b.lon));
      list = list.slice(0, MAX_FEATURES);
    }
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER }); } catch (e) { /* ignore */ }
    const features = list.map(it => ({
      id: it.id,
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
      properties: { k: kindOf(it), id: it.id }
    }));
    try {
      sdk.Map.addFeaturesToLayer({ layerName: LAYER, features });
    } catch (e) {
      console.warn('[Progi] addFeaturesToLayer:', e);
      setStatus('Nie udało się dodać kropek: ' + (e && e.message ? e.message : e));
    }
    updatePanel();
    setStatus(`warstwa: ${features.length} kropek` + (c && features.length === MAX_FEATURES ? ' (najbliższe środkowi mapy)' : ''));
  }

  /* Alt + klik = przełącz „dodane” dla najbliższego progu (do 60 m) */
  function attachMapClick() {
    let el = null;
    try { el = sdk.Map.getMapViewportElement(); } catch (e) { /* ignore */ }
    if (!el || el.__progiClick) return;
    el.__progiClick = true;
    el.addEventListener('click', ev => {
      if (!ev.altKey) return;
      let ll = null;
      try { ll = sdk.Map.getLonLatFromPixel({ x: ev.clientX, y: ev.clientY }); } catch (e) { /* ignore */ }
      if (!ll) return;
      const lat = ll.lat, lon = ll.lon ?? ll.lng ?? ll.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') return;
      let best = null, bd = 1e9;
      for (const it of items.values()) {
        const d = dist(lat, lon, it.lat, it.lon);
        if (d < bd) { bd = d; best = it; }
      }
      if (!best || bd > 60) { toastMsg('Brak progu w promieniu 60 m'); return; }
      ev.preventDefault(); ev.stopPropagation();
      toggle(best.id);
    }, true);
  }

  /* ---------- akcje ---------- */
  function broadcast(arr) {
    const msg = { kind: 'progi:items', items: (arr || []).map(stripItem) };
    if (dashWin) { try { dashWin.postMessage(msg, '*'); } catch (e) { /* ignore */ } }
  }
  async function toggle(id) {
    const it = items.get(id);
    if (!it) return;
    it.done = it.done ? 0 : 1;
    it.da = it.done ? new Date().toLocaleDateString('sv-SE') : '';
    it.ts = Date.now();
    renderLayer();
    broadcast([it]);
    toastMsg(`${TYPES[it.type] || it.type} · ${it.done ? 'dodane' : 'do dodania'}`);
    schedulePush();
  }
  function schedulePush() {
    if (!cfg.token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      if (pushing) return;
      pushing = true;
      setStatus('zapisuję w GitHubie…');
      try {
        const merged = await ghWrite(docFromItems(), 'Aktualizacja bazy progów (WME)');
        applyDoc(merged);
        renderLayer();
        setStatus('zapisano · ' + new Date().toLocaleTimeString('pl-PL'));
      } catch (e) {
        setStatus('błąd zapisu: ' + e.message);
      } finally { pushing = false; }
    }, 1500);
  }
  async function pull(loud) {
    if (pulling) return;
    pulling = true;
    try {
      const { doc } = await ghRead();
      const changed = applyDoc(doc);
      if (changed.length || loud) renderLayer();
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
  function openDash() {
    const url = dashUrl();
    try {
      dashWin = window.open(url, 'progi-wme-panel');
      setTimeout(() => { try { dashWin && dashWin.postMessage({ kind: 'progi:hello' }, '*'); } catch (e) { /* ignore */ } }, 1500);
    } catch (e) { toastMsg('Nie udało się otworzyć: ' + url); }
  }

  /* ---------- komunikacja ze stroną ---------- */
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    const host = (() => { try { return new URL(dashUrl()).host; } catch (x) { return ''; } })();
    if (host && e.origin && new URL(e.origin).host !== host) return;
    if (d.kind === 'progi:items') {
      const changed = applyDoc({ items: Object.fromEntries((d.items || []).map(i => [i.id, i])) });
      if (changed.length) renderLayer();
      updatePanel();
    } else if (d.kind === 'progi:hello') {
      const all = [...items.values()].map(stripItem);
      try { e.source && e.source.postMessage({ kind: 'progi:items', items: all }, '*'); } catch (x) { /* ignore */ }
    }
  });

  /* ---------- start ---------- */
  async function boot() {
    const saved = getCfg();
    if (saved) cfg = { ...DEFAULTS, ...saved };
    buildPanel();
    setStatus('czekam na WME SDK…');
    for (let i = 0; i < 60 && !ready; i++) {
      if (await initSdk()) { ready = true; break; }
      await wait(1000);
    }
    if (!ready) { setStatus('brak WME SDK – odśwież edytor'); return; }
    ensureLayer();
    attachMapClick();
    setInterval(attachMapClick, 15000);
    await pull(true);
    setInterval(() => { if (document.visibilityState === 'visible' && !pushing) pull(false); }, (cfg.interval || 20) * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
