// --- Jellyfin Admin "Live Tail" (v1.0) ---
// - Pinned header button in admin dashboard
// - Groups multiline entries into blocks (zebra + WARN/ERR colors)
// - Autoscroll (pauses when user scrolls up)
// - Draggable header, edge resizing (left/top/top-left)
// - Token handling (api_key or X-Emby-Authorization)
// - Visibility-aware, error backoff, no overlapping timers
(function () {
  "use strict";
  if (window.__JFIN_LOG_VIEWER_PINNED__) return;
  window.__JFIN_LOG_VIEWER_PINNED__ = true;

  // ---------- Config (overridable via window.JFIN_LIVE_TAIL_CONFIG) ----------
  const CFG = Object.assign(
    {
      refreshMs: 3000,              // polling interval
      tailLines: 2000,              // lines to render (block-grouped)
      minBytes: 128 * 1024,         // lower bound for suffix range
      maxBytes: 6 * 1024 * 1024,    // upper bound for suffix range
      lookbackDays: 2,              // how many days back to probe via HEAD
      requestTimeoutMs: 5000,       // hard timeout for fetches
      scrollNearPx: 20,             // autoscroll threshold from bottom
      ids: {
        btn:   "jfin-live-tail-header-btn",
        panel: "jfin-live-tail-overlay",
        cssBtn: "jfin-live-tail-header-css",
        cssPanel: "jfin-live-tail-panel-css",
      },
      selectors: {
        userMenuBtn: 'button[aria-label="User Menu"]',
        logLink:     'a[href*="/System/Logs/Log?name="]',
      },
      backoff: {
        stepMs: 2000,               // increase per consecutive error
        maxMs: 30000,               // clamp
      }
    },
    (window.JFIN_LIVE_TAIL_CONFIG || {})
  );

  // ---------- State ----------
  let active = false;
  let timerHandle = null;
  let currentLogUrl = null;
  let abortCtrl = null;
  let lastHash = "";
  let userScrollLocked = false;
  let consecutiveErrors = 0; // for backoff
  let pausedByVisibility = false;

  // ---------- Utils ----------
  const $ = (id) => document.getElementById(id);
  const onDashboard = () => (location.hash || "").toLowerCase().includes("/dashboard");
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;

  function lastLines(txt, n) {
    if (!txt) return "";
    const a = txt.split(/\r?\n/);
    return a.slice(-n).join("\n");
  }
  function hash(s) {
    // tiny non-crypto hash for change detection
    let h = 0, i = 0;
    while (i < s.length) h = (h * 31 + s.charCodeAt(i++) | 0);
    return h.toString(16);
  }
  function esc(s) {
    return s.replace(/[&<>"']/g, c => c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;');
  }

  // ---------- Block grouping + classification ----------
  // [YYYY-MM-DD hh:mm:ss.mmm +/-TZ] [LVL] ...
  const ENTRY_START = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}\]\s+\[(\w+)\]\s+/;

  function splitIntoBlocks(text) {
    const lines = text ? text.split(/\r?\n/) : [];
    const blocks = [];
    let current = null;

    for (const line of lines) {
      if (ENTRY_START.test(line)) {
        if (current) blocks.push(current);
        current = { header: line, lines: [line] };
      } else {
        if (!current) current = { header: null, lines: [] }; // leading fragment
        current.lines.push(line);
      }
    }
    if (current) blocks.push(current);
    return blocks;
  }

  function classifyBlock(block) {
    const head = (block.header || "").toUpperCase();
    if (head.includes("[ERR") || head.includes(" ERROR")) return "lvl-error";
    if (head.includes("[WRN") || head.includes(" WARN"))  return "lvl-warn";
    if (head.includes("[DBG") || head.includes(" DEBUG") || head.includes(" TRACE")) return "lvl-debug";
    return "lvl-info";
  }

  // ---------- Token helpers ----------
  function getApiKey() {
    try {
      if (window.ApiClient?._serverInfo?.AccessToken) return ApiClient._serverInfo.AccessToken;
      if (typeof ApiClient?.accessToken === "function") return ApiClient.accessToken();
    } catch {}
    return null;
  }
  function withApiKey(url) {
    try {
      const u = new URL(url, location.origin);
      const key = getApiKey();
      if (key && !u.searchParams.get("api_key")) u.searchParams.set("api_key", key);
      return u.toString();
    } catch { return url; }
  }

  // ---------- Tail window estimation ----------
  function estimateTailBytes() {
    const approx = CFG.tailLines * 300; // heuristic ~ 300B/line
    return Math.max(CFG.minBytes, Math.min(CFG.maxBytes, approx));
  }

  // ---------- Resolve latest log (today → lookbackDays) ----------
  async function resolveLatestLogUrl() {
    for (let i = 0; i <= CFG.lookbackDays; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const url = withApiKey(`/System/Logs/Log?name=${encodeURIComponent("log_"+ymd(d)+".log")}`);
      try {
        const r = await fetch(url, { method: "HEAD", credentials: "same-origin" });
        if (r.ok) return url;
      } catch {}
    }
    const d = new Date();
    return withApiKey(`/System/Logs/Log?name=${encodeURIComponent("log_"+ymd(d)+".log")}`);
  }

  // ---------- Fetch tail (Range; retry with X-Emby-Authorization on 401) ----------
  async function fetchTail(url) {
    let target = withApiKey(url);
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    const rangeBytes = estimateTailBytes();

    async function doFetch(u, headers = {}) {
      const req = fetch(u, {
        credentials: "same-origin",
        headers: { "Range": `bytes=-${rangeBytes}`, ...headers },
        signal
      });
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), CFG.requestTimeoutMs)
      );
      return Promise.race([req, timeout]);
    }

    let r = await doFetch(target);
    if (r.status === 401) {
      const key = getApiKey();
      if (!key) throw new Error("401 (no token)");
      const auth = `MediaBrowser Client="InjectedTail", Device="Browser", DeviceId="injected-${navigator.userAgent}", Version="1.0", Token="${key}"`;
      r = await doFetch(target, { "X-Emby-Authorization": auth });
    }
    if (r.status === 206 || r.status === 200) return r.text();
    throw new Error(`HTTP ${r.status}`);
  }

  // ---------- Early CSS for header button (so it's styled before first click) ----------
  function ensureHeaderButtonStyles() {
    if ($(CFG.ids.cssBtn)) return;
    const style = document.createElement("style");
    style.id = CFG.ids.cssBtn;
    style.textContent = `
      #${CFG.ids.btn}{
        display:inline-flex; align-items:center; justify-content:center;
        width:40px; height:40px; border-radius:50%;
        background:transparent; color:inherit; border:0;
        cursor:pointer; transition:background .15s ease;
      }
      #${CFG.ids.btn}:hover{ background:rgba(255,255,255,0.08); }
      #${CFG.ids.btn} svg{ width:24px; height:24px; fill:currentColor; }
    `;
    document.head.appendChild(style);
  }
  ensureHeaderButtonStyles();

  // ---------- Lazy CSS for panel (injected when panel created) ----------
  function ensurePanelStyles() {
    if ($(CFG.ids.cssPanel)) return;
    const style = document.createElement("style");
    style.id = CFG.ids.cssPanel;
    style.textContent = `
      #${CFG.ids.panel}{
        position:fixed; right:12px; bottom:56px;
        width:540px; height:320px;
        min-width:300px; min-height:150px; max-width:95vw; max-height:95vh;
        z-index:2147483647; background:rgba(20,20,20,0.92); color:#eee;
        border:1px solid rgba(255,255,255,0.06); border-radius:8px;
        display:flex; flex-direction:column; font-family:monospace; font-size:12px;
        box-shadow:0 6px 20px rgba(0,0,0,0.6);
        resize:both; overflow:auto;
      }
      #${CFG.ids.panel}::after{
        content:"⇲"; position:absolute; right:6px; bottom:2px;
        opacity:.3; font-size:14px; pointer-events:none;
      }
      #${CFG.ids.panel}:hover::after{ opacity:.6; }

      #${CFG.ids.panel} .jfin-resize-handle{ position:absolute; z-index:1; pointer-events:auto; }
      #${CFG.ids.panel} .jfin-resize-left{ left:0; top:0; bottom:0; width:8px; cursor:ew-resize; }
      #${CFG.ids.panel} .jfin-resize-top { left:0; right:0; top:0; height:8px; cursor:ns-resize; }
      #${CFG.ids.panel} .jfin-resize-tl  { left:0; top:0; width:12px; height:12px; cursor:nwse-resize; }

      #${CFG.ids.panel}-head{
        display:flex; align-items:center; gap:8px;
        padding:8px; border-bottom:1px solid rgba(255,255,255,0.04);
        flex:0 0 auto; cursor:grab; user-select:none;
      }
      #${CFG.ids.panel}-head.dragging{ cursor:grabbing; }

      #${CFG.ids.panel}-body{ padding:8px; overflow:auto; flex:1 1 auto; }

      /* Block zebra + level colors + subtle gap */
      #${CFG.ids.panel}-body .logblock { padding: 2px 0 3px 0; margin-bottom: 2px; }
      #${CFG.ids.panel}-body .logblock:nth-child(even){ background:rgba(255,255,255,0.04); }
      #${CFG.ids.panel}-body .logblock.lvl-debug{ opacity:.95; }
      #${CFG.ids.panel}-body .logblock.lvl-warn { color:#f5d742; }
      #${CFG.ids.panel}-body .logblock.lvl-error{ color:#ff6b6b; }
      #${CFG.ids.panel}-body .logblock .line{ white-space:pre-wrap; padding:0 4px; }

      .jfin-icon-btn{ background:transparent; border:0; color:#fff; cursor:pointer; }
    `;
    document.head.appendChild(style);
  }

  // ---------- Panel creation ----------
  function makePanel() {
    let panel = $(CFG.ids.panel);
    if (panel) return panel;

    ensurePanelStyles();

    panel = document.createElement("div");
    panel.id = CFG.ids.panel;
    panel.innerHTML = `
      <div id="${CFG.ids.panel}-head">
        <strong>Live Log</strong>
        <span id="${CFG.ids.panel}-file" style="opacity:.85"></span>
        <div style="flex:1"></div>
        <button id="${CFG.ids.panel}-refresh" class="jfin-icon-btn" title="Refresh now">⟳</button>
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="${CFG.ids.panel}-autoscroll" type="checkbox" checked> auto
        </label>
        <button id="${CFG.ids.panel}-close" class="jfin-icon-btn" title="Close">✕</button>
      </div>
      <div id="${CFG.ids.panel}-body">(inactive)</div>
      <div class="jfin-resize-handle jfin-resize-left"></div>
      <div class="jfin-resize-handle jfin-resize-top"></div>
      <div class="jfin-resize-handle jfin-resize-tl"></div>
    `;
    document.body.appendChild(panel);

    // Wire controls
    $(`${CFG.ids.panel}-close`).onclick   = () => { deactivate(); panel.remove(); };
    $(`${CFG.ids.panel}-refresh`).onclick = () => { fetchAndShow(true); };

    // Pause autoscroll while user is reading up
    const bodyEl = $(`${CFG.ids.panel}-body`);
    bodyEl.addEventListener("scroll", () => {
      const nearBottom =
        bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < CFG.scrollNearPx;
      userScrollLocked = !nearBottom;
    });

    attachEdgeResizing(panel);
    attachDragging(panel);
    return panel;
  }

  // ---------- Edge-resize (left/top/top-left) ----------
  function attachEdgeResizing(panel) {
    const MIN_W = 300, MIN_H = 150,
          MAX_W = Math.round(window.innerWidth * 0.95),
          MAX_H = Math.round(window.innerHeight * 0.95);

    let dragging = null;
    let startX = 0, startY = 0, startW = 0, startH = 0, startLeft = 0, startTop = 0;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    function ensureLeftTopAnchoring() {
      const cs = getComputedStyle(panel);
      if (cs.right !== "auto" || cs.bottom !== "auto") {
        const r = panel.getBoundingClientRect();
        panel.style.left = `${Math.round(r.left)}px`;
        panel.style.top  = `${Math.round(r.top)}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }
    }

    function onDown(kind, ev) {
      ev.preventDefault();
      ensureLeftTopAnchoring();
      dragging = kind; startX = ev.clientX; startY = ev.clientY;
      const cs = getComputedStyle(panel), r = panel.getBoundingClientRect();
      startW = parseFloat(cs.width); startH = parseFloat(cs.height);
      startLeft = r.left; startTop = r.top;
      document.documentElement.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, { once: true });
    }

    function onMove(ev) {
      if (!dragging) return;
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let newLeft = startLeft, newTop = startTop, newW = startW, newH = startH;

      if (dragging === "left" || dragging === "tl") {
        newLeft = startLeft + dx; newW = startW - dx;
        newW = clamp(newW, MIN_W, MAX_W);
        const maxLeft = window.innerWidth - newW;
        newLeft = clamp(newLeft, 0, maxLeft);
      }
      if (dragging === "top" || dragging === "tl") {
        newTop = startTop + dy; newH = startH - dy;
        newH = clamp(newH, MIN_H, MAX_H);
        const maxTop = window.innerHeight - newH;
        newTop = clamp(newTop, 0, maxTop);
      }

      panel.style.left   = `${Math.round(newLeft)}px`;
      panel.style.top    = `${Math.round(newTop)}px`;
      panel.style.width  = `${Math.round(newW)}px`;
      panel.style.height = `${Math.round(newH)}px`;
    }

    function onUp() {
      dragging = null; document.documentElement.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
    }

    panel.querySelector(".jfin-resize-left")?.addEventListener("mousedown", e => onDown("left", e));
    panel.querySelector(".jfin-resize-top") ?.addEventListener("mousedown", e => onDown("top",  e));
    panel.querySelector(".jfin-resize-tl")  ?.addEventListener("mousedown", e => onDown("tl",   e));
  }

  // ---------- Drag via header; clamp; ESC/dblclick to snap back ----------
  function attachDragging(panel) {
    const head = document.getElementById(`${CFG.ids.panel}-head`);
    if (!head) return;
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function ensureLeftTopAnchoring() {
      const cs = getComputedStyle(panel);
      if (cs.right !== "auto" || cs.bottom !== "auto") {
        const r = panel.getBoundingClientRect();
        panel.style.left = `${Math.round(r.left)}px`;
        panel.style.top  = `${Math.round(r.top)}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }
    }
    function onMouseDown(e) {
      const t = e.target.tagName;
      if (t === "BUTTON" || t === "INPUT" || t === "SELECT" || t === "LABEL") return;
      e.preventDefault(); ensureLeftTopAnchoring();
      const r = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; startLeft = r.left; startTop = r.top; dragging = true;
      head.classList.add("dragging"); document.documentElement.style.userSelect = "none";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp, { once: true });
    }
    function onMouseMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const cs = getComputedStyle(panel);
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      const maxLeft = window.innerWidth - w, maxTop = window.innerHeight - h;
      const nextLeft = Math.max(0, Math.min(maxLeft, startLeft + dx));
      const nextTop  = Math.max(0, Math.min(maxTop,  startTop  + dy));
      panel.style.left = `${Math.round(nextLeft)}px`;
      panel.style.top  = `${Math.round(nextTop)}px`;
    }
    function onMouseUp() {
      dragging = false; head.classList.remove("dragging");
      document.documentElement.style.userSelect = ""; window.removeEventListener("mousemove", onMouseMove);
    }
    function snapBack() { panel.style.left = "auto"; panel.style.top = "auto"; panel.style.right = "12px"; panel.style.bottom = "56px"; }

    head.addEventListener("mousedown", onMouseDown);
    head.addEventListener("dblclick",  snapBack);
    window.addEventListener("keydown", e => { if (e.key === "Escape" && $(CFG.ids.panel)) snapBack(); });

    // Keep panel inside viewport on resize
    window.addEventListener("resize", () => {
      const cs = getComputedStyle(panel);
      if (cs.left === "auto" || cs.top === "auto") return; // anchored bottom-right
      const r = panel.getBoundingClientRect();
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      const maxLeft = window.innerWidth - w, maxTop = window.innerHeight - h;
      panel.style.left = `${Math.max(0, Math.min(r.left, maxLeft))}px`;
      panel.style.top  = `${Math.max(0, Math.min(r.top,  maxTop ))}px`;
    });
  }

  function setFileName(name) {
    const el = $(`${CFG.ids.panel}-file`);
    if (el) el.textContent = name ? ` — ${name}` : "";
  }

  // ---------- Render (blocks) + smart diff + autoscroll pause ----------
  async function fetchAndShow(force = false) {
    if (!active || !currentLogUrl) return;
    const body = $(`${CFG.ids.panel}-body`); if (!body) return;

    const txt = await fetchTail(currentLogUrl);
    const chunk = lastLines(txt, CFG.tailLines);
    const newHash = hash(chunk);
    if (!force && newHash === lastHash) return;
    lastHash = newHash;

    const blocks = splitIntoBlocks(chunk);
    const html = blocks.map(b => {
      const lvl = classifyBlock(b);
      const linesHtml = b.lines.map(l => `<div class="line">${esc(l)}</div>`).join("");
      return `<div class="logblock ${lvl}">${linesHtml}</div>`;
    }).join("");
    body.innerHTML = html || '<div class="logblock"><div class="line">(empty)</div></div>';

    const auto = $(`${CFG.ids.panel}-autoscroll`);
    if (auto?.checked && !userScrollLocked) body.scrollTop = body.scrollHeight;
  }

  // ---------- Loop (no overlap) + backoff ----------
  function scheduleNext(delayMs) {
    clearTimeout(timerHandle);
    timerHandle = setTimeout(loop, delayMs);
  }
  async function loop() {
    if (!active || pausedByVisibility) return;
    try {
      await fetchAndShow();
      consecutiveErrors = 0;
      scheduleNext(CFG.refreshMs);
    } catch {
      consecutiveErrors++;
      const backoff = Math.min(CFG.backoff.maxMs, CFG.refreshMs + consecutiveErrors * CFG.backoff.stepMs);
      // Show a minimal status to the user
      const body = $(`${CFG.ids.panel}-body`);
      if (body && body.innerHTML.includes("fetch failed") === false) {
        // don’t spam; only inject if body is not already an error
        body.innerHTML = `<div class="logblock lvl-warn"><div class="line">… reconnecting in ${Math.round(backoff/1000)}s …</div></div>` + body.innerHTML;
      }
      scheduleNext(backoff);
    }
  }
  function start() { stop(); scheduleNext(0); }
  function stop()  { clearTimeout(timerHandle); timerHandle = null; if (abortCtrl) abortCtrl.abort(); }

  async function openPanel() {
    makePanel();
    const url = await resolveLatestLogUrl();
    currentLogUrl = url;
    try { const u = new URL(url); setFileName(u.searchParams.get("name") || ""); } catch { setFileName(""); }
    active = true; lastHash = ""; consecutiveErrors = 0;
    scheduleNext(0);
  }

  function deactivate() {
    active = false; stop(); if (abortCtrl) abortCtrl.abort();
    const body = $(`${CFG.ids.panel}-body`); if (body) body.textContent = "(inactive)";
  }

  // ---------- Header button insertion via MutationObserver ----------
  function findHeaderRightBox() {
    const userBtn = document.querySelector(CFG.selectors.userMenuBtn);
    return userBtn ? userBtn.parentElement : null;
  }
  function ensureHeaderButton() {
    if (!onDashboard()) { const b = $(CFG.ids.btn); if (b) b.remove(); return; }
    ensureHeaderButtonStyles();

    let btn = $(CFG.ids.btn);
    const host = findHeaderRightBox(); if (!host) return;
    if (!btn) {
      btn = document.createElement("button");
      btn.id = CFG.ids.btn; btn.type = "button";
      btn.title = "Live Tail of latest log";
      // Material-ish document icon
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5z"/></svg>';
      btn.addEventListener("click", () => { openPanel(); });
      host.parentElement.insertBefore(btn, host);
    } else if (!btn.isConnected) {
      const h = findHeaderRightBox(); if (h) h.parentElement.insertBefore(btn, h);
    }
  }

  // Observe the top bar instead of polling each second
  const mo = new MutationObserver(() => { if (onDashboard()) ensureHeaderButton(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Fallback slow tick (in case MUI swaps nodes out in a way that misses the observer)
  setInterval(() => { if (onDashboard()) ensureHeaderButton(); }, 5000);

  // Update tail target when clicking another log link
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest(CFG.selectors.logLink);
    if (!a) return;
    setTimeout(() => {
      if (!active) return;
      const url = withApiKey(a.getAttribute("href") || a.href);
      if (url !== currentLogUrl) {
        currentLogUrl = url;
        try { const u = new URL(url); setFileName(u.searchParams.get("name") || ""); } catch { setFileName(""); }
        lastHash = ""; consecutiveErrors = 0; scheduleNext(0);
      }
    }, 100);
  }, true);

  // Pause/resume on tab visibility
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { pausedByVisibility = true; stop(); }
    else { pausedByVisibility = false; if (active) scheduleNext(0); }
  });

  // Initial kick
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureHeaderButton);
  } else {
    ensureHeaderButton();
  }

  // ---------- Optional tiny API for consumers ----------
  window.JFINLiveTail = {
    open: () => openPanel(),
    close: () => deactivate(),
    setConfig: (p) => Object.assign(CFG, p)
  };
})();