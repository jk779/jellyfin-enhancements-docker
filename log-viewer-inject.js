// --- BEGIN dashboard-pinned live tail (5k lines, block zebra, no controls) ---
(function () {
  if (window.__JFIN_LOG_VIEWER_PINNED__) return;
  window.__JFIN_LOG_VIEWER_PINNED__ = true;

  const BTN_ID   = 'jfin-live-tail-header-btn';
  const PANEL_ID = 'jfin-live-tail-overlay';

  // Fixed config
  const refreshInterval = 3000;     // ms (fixed; no UI control)
  let   tailLines       = 5000;     // last N lines (fixed)
  const MIN_BYTES = 128 * 1024;
  const MAX_BYTES = 6   * 1024 * 1024;

  // State
  let active = false;
  let timer = null;
  let currentLogUrl = null;
  let abortCtrl = null;
  let lastHash = '';
  let userScrollLocked = false;

  // Utils
  const $ = (id) => document.getElementById(id);
  const onDashboard = () => (location.hash || '').toLowerCase().includes('/dashboard');
  const pad = (n) => (n < 10 ? '0'+n : ''+n);
  const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  function lastLines(txt, n) { if (!txt) return ''; const a=txt.split(/\r?\n/); return a.slice(-n).join('\n'); }
  function hash(s){ let h=0,i=0,l=s.length|0; while(i<l) h=(h*31 + s.charCodeAt(i++)|0); return h.toString(16); }
  function esc(s){ return s.replace(/[&<>"']/g, c => c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;'); }

  // ========= Global (early) CSS for header button =========
  function ensureHeaderButtonStyles() {
    if (document.getElementById('jfin-live-tail-header-css')) return;
    const style = document.createElement('style');
    style.id = 'jfin-live-tail-header-css';
    style.textContent = `
      /* Header button should look like MUI IconButton */
      #${BTN_ID} {
        display:inline-flex; align-items:center; justify-content:center;
        width:40px; height:40px; border-radius:50%;
        background:transparent; color:inherit; border:0;
        cursor:pointer; transition:background .15s ease;
      }
      #${BTN_ID}:hover { background:rgba(255,255,255,0.08); }
      #${BTN_ID} svg { width:24px; height:24px; fill:currentColor; }
    `;
    document.head.appendChild(style);
  }
  ensureHeaderButtonStyles();

  // ========= Block grouping + classification =========
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
    const head = (block.header || '').toUpperCase();
    if (head.includes('[ERR') || head.includes(' ERROR')) return 'lvl-error';
    if (head.includes('[WRN') || head.includes(' WARN'))  return 'lvl-warn';
    if (head.includes('[DBG') || head.includes(' DEBUG') || head.includes(' TRACE')) return 'lvl-debug';
    return 'lvl-info';
  }

  // ========= API token helpers =========
  function getApiKey(){
    try {
      if (window.ApiClient?._serverInfo?.AccessToken) return ApiClient._serverInfo.AccessToken;
      if (typeof ApiClient?.accessToken==='function') return ApiClient.accessToken();
    } catch {}
    return null;
  }
  function withApiKey(url){
    try {
      const u=new URL(url, location.origin);
      const key=getApiKey();
      if (key && !u.searchParams.get('api_key')) u.searchParams.set('api_key', key);
      return u.toString();
    } catch { return url; }
  }

  // ========= Tail window estimation =========
  function estimateTailBytes(){
    const approx = tailLines * 300; // ~1.5MB for 5k lines (heuristic)
    return Math.max(MIN_BYTES, Math.min(MAX_BYTES, approx));
  }

  // ========= Resolve latest log =========
  async function resolveLatestLogUrl(){
    for (let i=0;i<4;i++){
      const d=new Date(); d.setDate(d.getDate()-i);
      const url = withApiKey(`/System/Logs/Log?name=${encodeURIComponent('log_'+ymd(d)+'.log')}`);
      try { const r=await fetch(url,{method:'HEAD',credentials:'same-origin'}); if (r.ok) return url; } catch {}
    }
    const d=new Date();
    return withApiKey(`/System/Logs/Log?name=${encodeURIComponent('log_'+ymd(d)+'.log')}`);
  }

  // ========= Fetch tail (Range; retry with X-Emby-Authorization on 401) =========
  async function fetchTail(url){
    let target=withApiKey(url);
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    const rangeBytes = estimateTailBytes();

    async function doFetch(u, headers={}){
      const req = fetch(u,{credentials:'same-origin', headers:{'Range':`bytes=-${rangeBytes}`, ...headers}, signal});
      const timeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5000));
      return Promise.race([req, timeout]);
    }

    let r = await doFetch(target);
    if (r.status===401){
      const key=getApiKey();
      if (!key) throw new Error('401 (no token)');
      const auth=`MediaBrowser Client="InjectedTail", Device="Browser", DeviceId="injected-${navigator.userAgent}", Version="1.0", Token="${key}"`;
      r = await doFetch(target, {'X-Emby-Authorization':auth});
    }
    if (r.status===206 || r.status===200) return r.text();
    throw new Error(`HTTP ${r.status}`);
  }

  // ========= Panel UI (lazy CSS for panel only) =========
  function makePanel(){
    let panel = $(PANEL_ID);
    if (panel) return panel;

    if (!$('#jfin-live-tail-css')){
      const style=document.createElement('style');
      style.id='jfin-live-tail-css';
      style.textContent = `
        #${PANEL_ID}{
          position:fixed; right:12px; bottom:56px;
          width:540px; height:320px;
          min-width:300px; min-height:150px; max-width:95vw; max-height:95vh;
          z-index:2147483647; background:rgba(20,20,20,0.92); color:#eee;
          border:1px solid rgba(255,255,255,0.06); border-radius:8px;
          display:flex; flex-direction:column; font-family:monospace; font-size:12px;
          box-shadow:0 6px 20px rgba(0,0,0,0.6);
          resize:both; overflow:auto;
        }
        #${PANEL_ID}::after{ content:"⇲"; position:absolute; right:6px; bottom:2px; opacity:.3; font-size:14px; pointer-events:none; }
        #${PANEL_ID}:hover::after{ opacity:.6; }

        #${PANEL_ID} .jfin-resize-handle{ position:absolute; z-index:1; pointer-events:auto; }
        #${PANEL_ID} .jfin-resize-left{ left:0; top:0; bottom:0; width:8px; cursor:ew-resize; }
        #${PANEL_ID} .jfin-resize-top { left:0; right:0; top:0; height:8px; cursor:ns-resize; }
        #${PANEL_ID} .jfin-resize-tl  { left:0; top:0; width:12px; height:12px; cursor:nwse-resize; }

        #${PANEL_ID}-head{
          display:flex; align-items:center; gap:8px;
          padding:8px; border-bottom:1px solid rgba(255,255,255,0.04);
          flex:0 0 auto; cursor:grab; user-select:none;
        }
        #${PANEL_ID}-head.dragging{ cursor:grabbing; }

        #${PANEL_ID}-body{ padding:8px; overflow:auto; flex:1 1 auto; }

        /* Block zebra + level color + subtle separation */
        #${PANEL_ID}-body .logblock { padding: 2px 0 3px 0; margin-bottom: 2px; }
        #${PANEL_ID}-body .logblock:nth-child(even){ background:rgba(255,255,255,0.04); }
        #${PANEL_ID}-body .logblock.lvl-debug{ opacity:.95; }
        #${PANEL_ID}-body .logblock.lvl-warn { color:#f5d742; }
        #${PANEL_ID}-body .logblock.lvl-error{ color:#ff6b6b; }
        #${PANEL_ID}-body .logblock .line{ white-space:pre-wrap; padding:0 4px; }

        .jfin-icon-btn{ background:transparent; border:0; color:#fff; cursor:pointer; }
      `;
      document.head.appendChild(style);
    }

    const panelEl=document.createElement('div');
    panelEl.id=PANEL_ID;
    panelEl.innerHTML = `
      <div id="${PANEL_ID}-head">
        <strong>Live Log</strong>
        <span id="${PANEL_ID}-file" style="opacity:.85"></span>
        <div style="flex:1"></div>
        <button id="${PANEL_ID}-refresh" class="jfin-icon-btn" title="Refresh now">⟳</button>
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="${PANEL_ID}-autoscroll" type="checkbox" checked> auto
        </label>
        <button id="${PANEL_ID}-close" class="jfin-icon-btn" title="Close">✕</button>
      </div>
      <div id="${PANEL_ID}-body">(inactive)</div>
      <div class="jfin-resize-handle jfin-resize-left"></div>
      <div class="jfin-resize-handle jfin-resize-top"></div>
      <div class="jfin-resize-handle jfin-resize-tl"></div>
    `;
    document.body.appendChild(panelEl);

    $(`${PANEL_ID}-close`).onclick   = () => { deactivate(); panelEl.remove(); };
    $(`${PANEL_ID}-refresh`).onclick = () => { fetchAndShow(true); };

    // Pause autoscroll while user is reading up
    const bodyEl = $(`${PANEL_ID}-body`);
    bodyEl.addEventListener('scroll', () => {
      const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 20;
      userScrollLocked = !nearBottom;
    });

    attachEdgeResizing(panelEl);
    attachDragging(panelEl);

    return panelEl;
  }

  // ========= Edge-resize (left/top/top-left) =========
  function attachEdgeResizing(panel){
    const MIN_W=300, MIN_H=150,
          MAX_W=Math.round(window.innerWidth*0.95),
          MAX_H=Math.round(window.innerHeight*0.95);

    let dragging=null, startX=0, startY=0, startW=0, startH=0, startLeft=0, startTop=0;
    const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

    function ensureLeftTopAnchoring(){
      const cs=getComputedStyle(panel);
      if (cs.right!=='auto' || cs.bottom!=='auto'){
        const r=panel.getBoundingClientRect();
        panel.style.left=`${Math.round(r.left)}px`;
        panel.style.top =`${Math.round(r.top)}px`;
        panel.style.right='auto'; panel.style.bottom='auto';
      }
    }
    function onDown(kind,ev){
      ev.preventDefault();
      ensureLeftTopAnchoring();
      dragging=kind; startX=ev.clientX; startY=ev.clientY;
      const cs=getComputedStyle(panel), r=panel.getBoundingClientRect();
      startW=parseFloat(cs.width); startH=parseFloat(cs.height);
      startLeft=r.left; startTop=r.top;
      document.documentElement.style.userSelect='none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, {once:true});
    }
    function onMove(ev){
      if (!dragging) return;
      const dx=ev.clientX-startX, dy=ev.clientY-startY;
      let newLeft=startLeft, newTop=startTop, newW=startW, newH=startH;

      if (dragging==='left'||dragging==='tl'){
        newLeft=startLeft+dx; newW=startW-dx;
        newW=clamp(newW,MIN_W,MAX_W);
        const maxLeft=window.innerWidth-newW;
        newLeft=clamp(newLeft,0,maxLeft);
      }
      if (dragging==='top'||dragging==='tl'){
        newTop=startTop+dy; newH=startH-dy;
        newH=clamp(newH,MIN_H,MAX_H);
        const maxTop=window.innerHeight-newH;
        newTop=clamp(newTop,0,maxTop);
      }

      panel.style.left =`${Math.round(newLeft)}px`;
      panel.style.top  =`${Math.round(newTop)}px`;
      panel.style.width =`${Math.round(newW)}px`;
      panel.style.height=`${Math.round(newH)}px`;
    }
    function onUp(){
      dragging=null; document.documentElement.style.userSelect='';
      window.removeEventListener('mousemove', onMove);
    }

    panel.querySelector('.jfin-resize-left')?.addEventListener('mousedown', e=>onDown('left',e));
    panel.querySelector('.jfin-resize-top') ?.addEventListener('mousedown', e=>onDown('top', e));
    panel.querySelector('.jfin-resize-tl')  ?.addEventListener('mousedown', e=>onDown('tl',  e));
  }

  // ========= Drag via header; clamp; ESC/dblclick to snap back =========
  function attachDragging(panel){
    const head = document.getElementById(`${PANEL_ID}-head`);
    if (!head) return;
    let dragging=false, startX=0, startY=0, startLeft=0, startTop=0;

    function ensureLeftTopAnchoring(){
      const cs=getComputedStyle(panel);
      if (cs.right!=='auto' || cs.bottom!=='auto'){
        const r=panel.getBoundingClientRect();
        panel.style.left=`${Math.round(r.left)}px`;
        panel.style.top =`${Math.round(r.top)}px`;
        panel.style.right='auto'; panel.style.bottom='auto';
      }
    }
    function onMouseDown(e){
      const t=e.target.tagName;
      if (t==='BUTTON'||t==='INPUT'||t==='SELECT'||t==='LABEL') return;
      e.preventDefault(); ensureLeftTopAnchoring();
      const r=panel.getBoundingClientRect();
      startX=e.clientX; startY=e.clientY; startLeft=r.left; startTop=r.top; dragging=true;
      head.classList.add('dragging'); document.documentElement.style.userSelect='none';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp, {once:true});
    }
    function onMouseMove(e){
      if (!dragging) return;
      const dx=e.clientX-startX, dy=e.clientY-startY;
      const cs=getComputedStyle(panel);
      const w=parseFloat(cs.width), h=parseFloat(cs.height);
      const maxLeft=window.innerWidth-w, maxTop=window.innerHeight-h;
      const nextLeft=Math.max(0, Math.min(maxLeft, startLeft+dx));
      const nextTop =Math.max(0, Math.min(maxTop,  startTop +dy));
      panel.style.left=`${Math.round(nextLeft)}px`;
      panel.style.top =`${Math.round(nextTop)}px`;
    }
    function onMouseUp(){
      dragging=false; head.classList.remove('dragging');
      document.documentElement.style.userSelect=''; window.removeEventListener('mousemove', onMouseMove);
    }
    function snapBack(){ panel.style.left='auto'; panel.style.top='auto'; panel.style.right='12px'; panel.style.bottom='56px'; }

    head.addEventListener('mousedown', onMouseDown);
    head.addEventListener('dblclick',  snapBack);
    window.addEventListener('keydown', e=>{ if (e.key==='Escape' && document.getElementById(PANEL_ID)) snapBack(); });

    window.addEventListener('resize', ()=>{
      const cs=getComputedStyle(panel);
      if (cs.left==='auto'||cs.top==='auto') return;
      const r=panel.getBoundingClientRect();
      const w=parseFloat(cs.width), h=parseFloat(cs.height);
      const maxLeft=window.innerWidth-w, maxTop=window.innerHeight-h;
      panel.style.left=`${Math.max(0, Math.min(r.left, maxLeft))}px`;
      panel.style.top =`${Math.max(0, Math.min(r.top,  maxTop ))}px`;
    });
  }

  function setFileName(name){ const el=$(`${PANEL_ID}-file`); if (el) el.textContent = name ? ` — ${name}` : ''; }

  // ========= Render (blocks) + smart diff + autoscroll pause =========
  async function fetchAndShow(force=false){
    if (!active || !currentLogUrl) return;
    const body=$(`${PANEL_ID}-body`); if (!body) return;
    try {
      const txt = await fetchTail(currentLogUrl);
      const chunk = lastLines(txt, tailLines);
      const newHash = hash(chunk);
      if (!force && newHash===lastHash) return;
      lastHash = newHash;

      const blocks = splitIntoBlocks(chunk);
      const html = blocks.map(b => {
        const lvl = classifyBlock(b);
        const linesHtml = b.lines.map(l => `<div class="line">${esc(l)}</div>`).join('');
        return `<div class="logblock ${lvl}">${linesHtml}</div>`;
      }).join('');
      body.innerHTML = html || '<div class="logblock"><div class="line">(empty)</div></div>';

      const auto = $(`${PANEL_ID}-autoscroll`);
      if (auto?.checked && !userScrollLocked) body.scrollTop = body.scrollHeight;
    } catch(e){
      body.innerHTML = `<div class="logblock lvl-error"><div class="line">--- fetch failed: ${esc(e.message)} ---</div></div>`;
    }
  }

  function start(){ stop(); timer=setInterval(fetchAndShow, refreshInterval); }
  function stop(){ if (timer) clearInterval(timer), timer=null; if (abortCtrl) abortCtrl.abort(); }

  async function openPanel(){
    makePanel();
    const url = await resolveLatestLogUrl();
    currentLogUrl = url;
    try { const u=new URL(url); setFileName(u.searchParams.get('name') || ''); } catch { setFileName(''); }
    active = true; lastHash = '';
    fetchAndShow(true);
    start();
  }

  function deactivate(){
    active=false; stop(); if (abortCtrl) abortCtrl.abort();
    const body=$(`${PANEL_ID}-body`); if (body) body.textContent='(inactive)';
  }

  // ========= Header button =========
  function findHeaderRightBox(){
    const userBtn=document.querySelector('button[aria-label="User Menu"]');
    return userBtn ? userBtn.parentElement : null;
  }
  function ensureHeaderButton(){
    if (!onDashboard()){ const b=$(BTN_ID); if (b) b.remove(); return; }
    ensureHeaderButtonStyles(); // make sure styles exist BEFORE button appears

    let btn=$(BTN_ID); const host=findHeaderRightBox(); if (!host) return;
    if(!btn){
      btn=document.createElement('button');
      btn.id=BTN_ID; btn.type='button'; btn.title='Live Tail of latest log';
      // Material-ish document icon
      btn.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5z"/></svg>';
      btn.addEventListener('click', ()=>{ openPanel(); });
      host.parentElement.insertBefore(btn, host);
    } else if (!btn.isConnected){
      const h=findHeaderRightBox(); if (h) h.parentElement.insertBefore(btn, h);
    }
  }

  // ========= Events =========
  document.addEventListener('click', (ev)=>{
    const a = ev.target.closest && ev.target.closest('a[href*="/System/Logs/Log?name="]');
    if (!a) return;
    setTimeout(()=>{
      if (!active) return;
      const url = withApiKey(a.getAttribute('href') || a.href);
      if (url !== currentLogUrl){
        currentLogUrl = url;
        try { const u=new URL(url); setFileName(u.searchParams.get('name') || ''); } catch { setFileName(''); }
        lastHash=''; fetchAndShow(true);
      }
    }, 100);
  }, true);

  window.addEventListener('hashchange', ensureHeaderButton);
  setInterval(ensureHeaderButton, 1000);
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', ensureHeaderButton);
  else ensureHeaderButton();
})();
// --- END dashboard-pinned live tail (5k lines, block zebra, no controls) ---