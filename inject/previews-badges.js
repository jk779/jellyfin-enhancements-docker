(function () {
  // ====== Config ======
  const overlayClass = 'quality-overlay-label';
  const orientationMode = 'both'; // 'both' | 'horizontal-only' | 'vertical-only' | 'none'

  const HORZ_LABEL   = 'H→';
  const VERT_LABEL   = 'V↓';
  const SQUARE_LABEL = 'Square';

  // ====== Cache ======
  const qualityOverlayCache = {};
  const observedElements = new WeakSet();
  const seenItems = new Set();

  function getUserId() {
    return (window.ApiClient && ApiClient._serverInfo && ApiClient._serverInfo.UserId) || null;
  }

  function createLabel(text, className) {
    const badge = document.createElement('div');
    badge.textContent = text;
    badge.className = className;
    return badge;
  }

  function getOrientationLabel(mediaStream) {
    if (!mediaStream) return null;
    const w = Number(mediaStream.Width) || 0;
    const h = Number(mediaStream.Height) || 0;
    if (!w || !h) return null;
    const ratio = w / h;
    if (ratio >= 1.1) return HORZ_LABEL;
    if (ratio <= 0.9) return VERT_LABEL;
    return SQUARE_LABEL;
  }

  function getQuality(mediaStream) {
    if (!mediaStream) return null;
    const h = Number(mediaStream.Height) || (mediaStream.Width ? Math.round(mediaStream.Width / 16 * 9) : 0);
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    if (h >= 1080) return '1080p';
    if (h >= 720)  return '720p';
    if (h >= 480)  return '480p';
    if (h >= 360)  return '360p';
    return 'SD';
  }

  function formatRuntime(ticks) {
    if (!ticks) return null;
    const totalSeconds = Math.floor(ticks / 10_000_000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .${overlayClass} {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 99;
      }
      .quality-badges {
        position: absolute;
        top: 6px;
        right: 6px;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 0;
        overflow: hidden;
        border-radius: 4px;
      }
      .runtime-badge {
        position: absolute;
        bottom: 4px;
        right: 4px;
        background: rgba(0, 0, 0, 0.75);
        color: #fff;
        padding: 1px 5px;
        font-size: 12px;
        font-weight: bold;
        line-height: 1.4;
        border-radius: 3px;
        user-select: none;
      }
      .quality-badge,
      .orientation-badge {
        color: #fff;
        padding: 2px 6px;
        font-size: 12px;
        font-weight: bold;
        line-height: 1.2;
        user-select: none;
        display: inline-flex;
        align-items: center;
      }
      .quality-badge { background: rgba(22, 98, 173, 0.85); }
      .orientation-badge.horz   { background: rgba(14,152,106,0.95); }
      .orientation-badge.vert   { background: rgba(201,25,25,0.95); }
      .orientation-badge.square { background: rgba(107,114,128,0.95); }
      .quality-badge:first-child    { border-radius: 4px 0 0 4px; }
      .orientation-badge:last-child { border-radius: 0 4px 4px 0; }
      .quality-badges:has(.quality-badge:only-child) .quality-badge {
        border-radius: 4px;
      }
    `;
    document.head.appendChild(style);
  }

  // ====== Fetch patch ======
  // Intercepts Jellyfin's own /Items calls, appends MediaStreams + RunTimeTicks
  // to the Fields parameter, and pre-populates the cache from the response —
  // so the IntersectionObserver needs zero extra API calls.
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url;

    const isItemsCall = url && url.includes('/Items') && url.includes('Fields=');
    if (!isItemsCall) return origFetch.call(this, input, init);

    // Inject extra fields into the URL
    const patchedUrl = url.replace('Fields=', 'Fields=MediaStreams,RunTimeTicks,');
    const patchedInput = typeof input === 'string' ? patchedUrl : new Request(patchedUrl, input);

    return origFetch.call(this, patchedInput, init).then(response => {
      const clone = response.clone();
      clone.json().then(data => {
        for (const item of data.Items ?? []) {
          if (qualityOverlayCache[item.Id]) continue;

          const videoStream = item.MediaStreams?.find(s => s.Type === "Video");
          const quality = getQuality(videoStream);
          const orientation = getOrientationLabel(videoStream);
          const runtime = formatRuntime(item.RunTimeTicks);

          if (quality) {
            qualityOverlayCache[item.Id] = { quality, orientation, runtime };
          }
        }
      }).catch(() => {});

      return response;
    });
  };

  // ====== Overlay rendering ======
  function insertOverlay(container, quality, orientation, runtime) {
    if (!container || container.querySelector(`.${overlayClass}`)) return;

    const overlay = document.createElement('div');
    overlay.className = overlayClass;

    const stack = document.createElement('div');
    stack.className = 'quality-badges';

    stack.appendChild(createLabel(quality, 'quality-badge'));

    if (orientation && orientationMode !== 'none') {
      const show =
        (orientationMode === 'both') ||
        (orientationMode === 'horizontal-only' && orientation === HORZ_LABEL) ||
        (orientationMode === 'vertical-only'   && orientation === VERT_LABEL);

      if (show) {
        const cls =
          (orientation === HORZ_LABEL) ? 'orientation-badge horz' :
          (orientation === VERT_LABEL) ? 'orientation-badge vert' :
                                         'orientation-badge square';
        stack.appendChild(createLabel(orientation, cls));
      }
    }

    overlay.appendChild(stack);

    if (runtime) {
      overlay.appendChild(createLabel(runtime, 'runtime-badge'));
    }

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(overlay);
  }

  // ====== IntersectionObserver ======
  // Watches cards as they enter the viewport and renders badges from cache.
  // If a card's item ID is not in cache yet (e.g. different endpoint),
  // it is tracked in seenItems for potential later use — no fallback call is made.
  const intersectionObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const el = entry.target;
      if (!entry.isIntersecting || !el.href) continue;
      if (observedElements.has(el)) continue;

      const match = el.href.match(/id=([a-f0-9]{32})/i);
      if (!match) continue;

      const itemId = match[1];
      observedElements.add(el);
      intersectionObserver.unobserve(el);

      const cached = qualityOverlayCache[itemId];
      if (cached) {
        insertOverlay(el, cached.quality, cached.orientation, cached.runtime);
      } else {
        // Cache miss: item was not part of the intercepted batch (different endpoint).
        // Tracked here for potential future use; no extra API call is made.
        seenItems.add(itemId);
      }
    }
  }, { rootMargin: '200px' });

  function scanCards() {
    document.querySelectorAll('a.cardImageContainer').forEach(el => {
      if (!observedElements.has(el)) {
        intersectionObserver.observe(el);
      }
    });
  }

  let mutationTimeout;
  const mutationObserver = new MutationObserver(() => {
    clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(scanCards, 300);
  });

  addStyles();
  mutationObserver.observe(document.body, { childList: true, subtree: true });
  scanCards();
})();