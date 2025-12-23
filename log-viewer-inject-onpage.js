// --- BEGIN inline live tail for Jellyfin logs (button after Save, inline panel) ---
(function () {
  if (window.__JFIN_LOG_VIEWER_INLINE__) return;
  window.__JFIN_LOG_VIEWER_INLINE__ = true;

  // ---- IDs & defaults ----
  const BTN_ID   = 'jfin-live-tail-btn';
  const WRAP_ID  = 'jfin-live-tail-wrap';
  const PANEL_ID = 'jfin-live-tail-panel';

  let refreshInterval = 3000;       // ms
  let tailLines       = 200;        // last N lines
  let tailBytes       = 96 * 1024;  // bytes to fetch from end

  let active = false;
  let timer = null;
  let currentLogUrl = null;
  let abortCtrl = null;

  // ---- small utils ----
  const $ = (id) => document.getElementById(id);
  const onLogsPage = () => ((location.hash || '').toLowerCase() === '#/dashboard/logs');

  function lastLines(txt, n) {
    if (!txt) return '';
    const arr = txt.split(/\r?\n/);
    return arr.slice(-n).join('\n');
  }

  function getCurrentLogUrl() {
    const a = document.querySelector('a[href*="/System/Logs/Log?name="]');
    if (!a) return null;
    return new URL(a.getAttribute('href') || a.href, location.origin).toString();
  }

  // ---- fetching (suffix range) ----
  async function fetchTail(url) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    const req = fetch(url, {
      credentials: 'same-origin',
      headers: { 'Range': `bytes=-${tailBytes}` },
      signal
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000));
    const r = await Promise.race([req, timeout]);

    if (r.status === 206 || r.status === 200) return r.text();
    throw new Error(`HTTP ${r.status}`);
  }

  // ---- DOM builders (inline) ----
  function ensureStylesOnce() {
    if (document.getElementById('jfin-live-tail-css')) return;
    const style = document.createElement('style');
    style.id = 'jfin-live-tail-css';
    style.textContent = `
      /* Inline panel adopts page flow */
      #${WRAP_ID} {
        margin-top: 12px;
      }
      #${PANEL_ID} {
        background: rgba(20,20,20,0.92);
        color: #eee;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        padding: 8px;
        font: 12px/1.4 monospace;
      }
      #${PANEL_ID}-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      #${PANEL_ID}-body {
        white-space: pre-wrap;
        overflow: auto;
        max-height: 50vh;
        padding: 6px;
        background: rgba(0,0,0,0.25);
        border-radius: 4px;
      }
    `;
    document.head.appendChild(style);
  }

  function findSaveButton() {
    // Ziel: <button is="emby-button" class="raised button-submit block emby-button"><span>Save</span></button>
    // Je nach Theme/Locale kann der Text variieren; wir matchen bevorzugt Rolle/Klassen.
    const candidates = Array.from(document.querySelectorAll('button.emby-button.button-submit'));
    if (!candidates.length) return null;
    // Falls mehrere, nimm den ersten sichtbaren
    return candidates.find(b => b.offsetParent !== null) || candidates[0];
  }

  function ensureInlineButton() {
    if (!onLogsPage()) { removeInline(); return; }
    ensureStylesOnce();

    let btn = $(BTN_ID);
    const saveBtn = findSaveButton();
    if (!saveBtn) return;

    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      // gleiche Klassen wie Save:
      btn.setAttribute('is', 'emby-button');
      btn.className = 'raised button-submit block emby-button';
      btn.innerHTML = '<span>Live Tail</span>';
      btn.addEventListener('click', () => {
        togglePanel();
      });

      // hinter dem Save-Button einfügen
      if (saveBtn.parentElement) {
        saveBtn.parentElement.insertBefore(btn, saveBtn.nextSibling);
      } else {
        saveBtn.insertAdjacentElement('afterend', btn);
      }
    } else {
      // sicherstellen, dass er nach Save sitzt (Renderwechsel)
      if (btn.previousElementSibling !== saveBtn) {
        saveBtn.parentElement?.insertBefore(btn, saveBtn.nextSibling);
      }
    }
  }

  function ensureWrapAndPanel() {
    let wrap = $(WRAP_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = WRAP_ID;
      // unterhalb des Button-Containers einhängen:
      const saveBtn = findSaveButton();
      if (saveBtn) {
        // gehe zum Container (oft der Form/Toolbar-Container)
        const container = saveBtn.parentElement || saveBtn.closest('div') || document.body;
        container.insertAdjacentElement('afterend', wrap);
      } else {
        document.body.appendChild(wrap);
      }
    }
    let panel = $(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.innerHTML = `
        <div id="${PANEL_ID}-head">
          <strong>Live Log</strong>
          <span id="${PANEL_ID}-file" style="opacity:.85"></span>
          <div style="flex:1"></div>
          <button id="${PANEL_ID}-refresh" class="emby-button raised mini" type="button"><span>Refresh</span></button>
          <label style="display:flex;align-items:center;gap:6px;">
            <input id="${PANEL_ID}-autoscroll" type="checkbox" checked> <span>Auto</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;">
            <span>Interval</span><input id="${PANEL_ID}-interval" type="number" min="500" step="500" value="${refreshInterval}" style="width:80px">
          </label>
          <label style="display:flex;align-items:center;gap:4px;">
            <span>Lines</span><input id="${PANEL_ID}-tail" type="number" min="10" step="10" value="${tailLines}" style="width:80px">
          </label>
          <label style="display:flex;align-items:center;gap:4px;">
            <span>Bytes</span><input id="${PANEL_ID}-bytes" type="number" min="4096" step="4096" value="${tailBytes}" style="width:90px">
          </label>
          <button id="${PANEL_ID}-close" class="emby-button mini" type="button"><span>Close</span></button>
        </div>
        <div id="${PANEL_ID}-body">(inactive)</div>
      `;
      wrap.appendChild(panel);

      // wire controls
      $(`${PANEL_ID}-close`).onclick     = () => { deactivate(); };
      $(`${PANEL_ID}-refresh`).onclick   = () => { fetchAndShow(); };
      $(`${PANEL_ID}-interval`).onchange = (e) => { refreshInterval = Math.max(500, +e.target.value||3000); if (active) restart(); };
      $(`${PANEL_ID}-tail`).onchange     = (e) => { tailLines       = Math.max(10,  +e.target.value||200);  if (active) fetchAndShow(); };
      $(`${PANEL_ID}-bytes`).onchange    = (e) => { tailBytes       = Math.max(4096,+e.target.value||98304);if (active) fetchAndShow(); };
    }
    return panel;
  }

  function removeInline() {
    deactivate();
    const btn = $(BTN_ID);
    if (btn) btn.remove();
    const wrap = $(WRAP_ID);
    if (wrap) wrap.remove();
  }

  // ---- activity control ----
  function activate() {
    if (active) return;
    const url = getCurrentLogUrl();
    if (!url) {
      // ggf. ist die Liste noch nicht gerendert; nicht aggressiv pollen
      const body = $(`${PANEL_ID}-body`);
      if (body) body.textContent = '(no log link found yet)';
      return;
    }
    currentLogUrl = url;
    try {
      const u = new URL(url);
      const name = u.searchParams.get('name') || '';
      const fn = $(`${PANEL_ID}-file`);
      if (fn) fn.textContent = name ? ` — ${name}` : '';
    } catch {}
    active = true;
    fetchAndShow();
    start();
  }

  function deactivate() {
    active = false;
    stop();
    if (abortCtrl) abortCtrl.abort();
    const body = $(`${PANEL_ID}-body`);
    if (body) body.textContent = '(inactive)';
  }

  function togglePanel() {
    ensureWrapAndPanel();
    if (active) deactivate(); else activate();
  }

  function start() {
    stop();
    timer = setInterval(fetchAndShow, refreshInterval);
  }
  function stop() {
    if (timer) clearInterval(timer), timer = null;
  }

  async function fetchAndShow() {
    if (!active || !currentLogUrl) return;
    const body = $(`${PANEL_ID}-body`);
    if (!body) return;
    body.style.opacity = '0.6';
    try {
      const txt  = await fetchTail(currentLogUrl);
      body.textContent = lastLines(txt, tailLines) || '(empty)';
      // autoscroll
      const auto = $(`${PANEL_ID}-autoscroll`);
      if (auto && auto.checked) body.scrollTop = body.scrollHeight;
    } catch (e) {
      body.textContent = `--- fetch failed: ${e.message} ---`;
    } finally {
      body.style.opacity = '';
    }
  }

  // Wenn der User auf einen anderen Log-Link klickt, Ziel aktualisieren
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
          const fn = $(`${PANEL_ID}-file`);
          if (fn) fn.textContent = (u.searchParams.get('name') || '');
        } catch {}
        fetchAndShow();
      }
    }, 150);
  }, true);

  // Sichtbarkeit/Einbettung steuern
  function tick() {
    if (!onLogsPage()) {
      removeInline();
      return;
    }
    ensureInlineButton();
    // panel im Flow halten, falls DOM neu gerendert wurde
    if ($(PANEL_ID) && !$(WRAP_ID)) {
      // wurde weggeräumt – neu anlegen
      ensureWrapAndPanel();
    }
  }

  window.addEventListener('hashchange', tick);
  setInterval(tick, 1000); // leichter heartbeat, keine schweren Observer

  // init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
})();
// --- END inline live tail for Jellyfin logs ---