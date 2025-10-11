// --- BEGIN ultra-safe live tail for Jellyfin logs (single-file) ---
(function () {
  // prevent double install if injected twice
  if (window.__JFIN_LOG_VIEWER__) return;
  window.__JFIN_LOG_VIEWER__ = true;

  // ----- Config -----
  const BTN_ID   = 'injected-log-button';
  const PANEL_ID = 'injected-log-panel';

  // polling + tail sizing (adjust if needed)
  let refreshInterval = 3000;       // ms
  let tailLines       = 200;        // show last N lines
  let tailBytes       = 96 * 1024;  // fetch last N bytes (suffix Range)

  // ----- State -----
  let active = false;          // panel open?
  let timer = null;            // refresh timer
  let currentLogUrl = null;    // current log URL
  let abortCtrl = null;        // abort fetches

  // ----- Utilities -----
  const $ = (id) => document.getElementById(id);
  function onLogsPage() {
    const h = (location.hash || '').toLowerCase();
    return h === '#/dashboard/logs' || (h.includes('/dashboard') && h.includes('log'));
  }
  function getCurrentLogUrl() {
    const a = document.querySelector('a[href*="/System/Logs/Log?name="]');
    if (!a) return null;
    return new URL(a.getAttribute('href') || a.href, location.origin).toString();
  }
  function setFileName(name) {
    const el = $(`${PANEL_ID}-file`);
    if (el) el.textContent = name ? ` — ${name}` : '';
  }
  function lastLines(txt, n) {
    if (!txt) return '';
    const arr = txt.split(/\r?\n/);
    return arr.slice(-n).join('\n');
  }

  // ----- Tail fetching (suffix Range) -----
  async function fetchTail(url) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    // Prefer suffix range; fallback to full text if server ignores Range
    const req = fetch(url, {
      credentials: 'same-origin',
      headers: { 'Range': `bytes=-${tailBytes}` },
      signal
    });

    // Hard timeout to avoid hangs
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000));

    const r = await Promise.race([req, timeout]);
    if (r.status === 206 || r.status === 200) return r.text();
    throw new Error(`HTTP ${r.status}`);
  }

  // ----- UI: Panel -----
  function makePanel() {
    let panel = $(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position:'fixed', right:'12px', bottom:'52px',
      width:'540px', maxHeight:'60vh', zIndex:2147483647,
      background:'rgba(20,20,20,0.92)', color:'#eee',
      border:'1px solid rgba(255,255,255,0.06)', borderRadius:'8px',
      display:'flex', flexDirection:'column', fontFamily:'monospace',
      fontSize:'12px', boxShadow:'0 6px 20px rgba(0,0,0,0.6)', overflow:'hidden'
    });
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);">
        <strong>Live Log</strong>
        <span id="${PANEL_ID}-file" style="opacity:.85"></span>
        <div style="flex:1"></div>
        <button id="${PANEL_ID}-refresh" title="Refresh now" style="background:transparent;border:0;color:#fff;cursor:pointer">⟳</button>
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="${PANEL_ID}-autoscroll" type="checkbox" checked> auto
        </label>
        <button id="${PANEL_ID}-close" title="Close" style="background:transparent;border:0;color:#fff;cursor:pointer">✕</button>
      </div>
      <div id="${PANEL_ID}-body" style="padding:8px;overflow:auto;white-space:pre-wrap;"></div>
      <div style="display:flex;gap:8px;align-items:center;padding:6px 8px;border-top:1px solid rgba(255,255,255,0.03);">
        <label>Interval</label><input id="${PANEL_ID}-interval" type="number" min="500" step="500" value="${refreshInterval}" style="width:80px">
        <label>Lines</label><input id="${PANEL_ID}-tail" type="number" min="10" step="10" value="${tailLines}" style="width:80px">
        <label>Bytes</label><input id="${PANEL_ID}-bytes" type="number" min="4096" step="4096" value="${tailBytes}" style="width:90px">
      </div>
    `;
    document.body.appendChild(panel);

    $(`${PANEL_ID}-close`).onclick    = () => { stop(); panel.remove(); active = false; };
    $(`${PANEL_ID}-refresh`).onclick  = () => { fetchAndShow(); };
    $(`${PANEL_ID}-interval`).onchange= (e) => { refreshInterval = Math.max(500, +e.target.value||3000); if (active) restart(); };
    $(`${PANEL_ID}-tail`).onchange    = (e) => { tailLines       = Math.max(10,  +e.target.value||200);  if (active) fetchAndShow(); };
    $(`${PANEL_ID}-bytes`).onchange   = (e) => { tailBytes       = Math.max(4096,+e.target.value||98304);if (active) fetchAndShow(); };

    return panel;
  }

  async function fetchAndShow() {
    if (!active || !currentLogUrl) return;
    const body = $(`${PANEL_ID}-body`);
    if (!body) return;

    body.style.opacity = '0.6';
    try {
      const txt  = await fetchTail(currentLogUrl);
      body.textContent = lastLines(txt, tailLines) || '(empty)';
    } catch (e) {
      body.textContent = `--- fetch failed: ${e.message} ---`;
    } finally {
      body.style.opacity = '';
      if ($(`${PANEL_ID}-autoscroll`)?.checked) body.scrollTop = body.scrollHeight;
    }
  }

  function start() {
    stop();
    timer = setInterval(fetchAndShow, refreshInterval);
  }
  function stop() {
    if (timer) clearInterval(timer), timer = null;
    if (abortCtrl) abortCtrl.abort();
  }
  function restart() { if (active) { start(); fetchAndShow(); } }

  function openPanel() {
    if (!onLogsPage()) return;
    const url = getCurrentLogUrl();
    if (!url) { alert('No log link found on this page.'); return; }

    currentLogUrl = url;
    try {
      const u = new URL(url);
      setFileName(u.searchParams.get('name') || '');
    } catch { setFileName(''); }

    makePanel();
    active = true;
    fetchAndShow();
  }

  // ----- UI: Floating Button -----
  function ensureButton() {
    let btn = $(BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      Object.assign(btn.style, {
        position:'fixed', right:'12px', bottom:'12px',
        zIndex:2147483647,
        background:'rgba(22, 98, 173, 0.95)', color:'#fff',
        border:'none', borderRadius:'16px',
        padding:'8px 10px', font:'600 12px/1 sans-serif',
        cursor:'pointer', boxShadow:'0 6px 18px rgba(0,0,0,.35)'
      });
      btn.textContent = 'Live Tail';
      btn.title = 'Show live tail of the latest log';
      btn.addEventListener('click', () => { openPanel(); start(); });
      if (document.body) document.body.appendChild(btn);
      else requestAnimationFrame(() => document.body && document.body.appendChild(btn));
    }
    btn.style.display = onLogsPage() ? 'inline-flex' : 'none';
  }

  // When user clicks a different log link on the page, update the tail target
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href*="/System/Logs/Log?name="]');
    if (!a) return;
    setTimeout(() => {
      if (!active) return;
      const url = getCurrentLogUrl();
      if (url && url !== currentLogUrl) {
        currentLogUrl = url;
        try {
          const u = new URL(url);
          setFileName(u.searchParams.get('name') || '');
        } catch { setFileName(''); }
        fetchAndShow();
      }
    }, 150);
  }, true);

  // react only to hash navigation; no heavy observers
  window.addEventListener('hashchange', ensureButton);

  // lightweight heartbeat to keep button visibility correct
  setInterval(ensureButton, 1000);

  // initial
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureButton);
  } else {
    ensureButton();
  }
})();
// --- END ultra-safe live tail for Jellyfin logs ---