(function () {
  // ====== Config ======
  const overlayClass = 'quality-overlay-label';
  const orientationMode = 'both'; // 'both' | 'horizontal-only' | 'vertical-only' | 'none'

  // Centralized label definitions (change only here)
  const HORZ_LABEL   = 'H→';  // e.g. '↔️' or '📺'
  const VERT_LABEL   = 'V↓';  // e.g. '↕️' or '📱'
  const SQUARE_LABEL = 'Square';

  // ====== Internals ======
  const requestQueue = [];
  const qualityOverlayCache = {};
  const observedElements = new WeakSet();
  const seenItems = new Set();
  let activeRequests = 0;
  const maxRequestsPerSecond = 15;
  const maxQueueSize = 1000;

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
    // Returns HORZ_LABEL | VERT_LABEL | SQUARE_LABEL | null
    if (!mediaStream) return null;

    const w = Number(mediaStream.Width) || 0;
    const h = Number(mediaStream.Height) || 0;
    if (!w || !h) return null;

    const ratio = w / h; // Tolerance to avoid classifying almost-square videos incorrectly
    if (ratio >= 1.1) return HORZ_LABEL;
    if (ratio <= 0.9) return VERT_LABEL;
    return SQUARE_LABEL;
  }

  function getQuality(mediaStream) {
    if (!mediaStream) return 'SD';
    const h = Number(mediaStream.Height) || (mediaStream.Width ? Math.round(mediaStream.Width / 16 * 9) : 0);

    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    if (h >= 1080) return '1080p';
    if (h >= 720)  return '720p';
    if (h >= 480)  return '480p';
    if (h >= 360)  return '360p';
    return 'SD';
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
        right: 6px;  /* move badges to top-right corner */
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 0; /* badges touch each other */
        overflow: hidden;
        border-radius: 4px;
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
      /* Blue for resolution */
      .quality-badge { background: rgba(22, 98, 173, 0.85); }

      /* Orientation: green / red / gray */
      .orientation-badge.horz   { background: rgba(14,152,106,0.95); }  /* green */
      .orientation-badge.vert   { background: rgba(201,25,25,0.95); }   /* red */
      .orientation-badge.square { background: rgba(107,114,128,0.95); } /* gray */

      /* Rounded "pill" ends */
      .quality-badge:first-child       { border-radius: 4px 0 0 4px; }
      .orientation-badge:last-child    { border-radius: 0 4px 4px 0; }
    `;
    document.head.appendChild(style);
  }

  async function fetchFirstEpisode(userId, seriesId) {
    try {
      const episodeResponse = await ApiClient.ajax({
        type: "GET",
        url: ApiClient.getUrl("/Items", {
          ParentId: seriesId,
          IncludeItemTypes: "Episode",
          Recursive: true,
          SortBy: "PremiereDate",
          SortOrder: "Ascending",
          Limit: 1,
          userId: userId
        }),
        dataType: "json"
      });
      const episode = episodeResponse.Items?.[0];
      if (!episode?.Id) {
        console.warn("No episode found for series", seriesId);
        return null;
      }
      return episode;
    } catch (err) {
      console.error('Failed to fetch first episode for series', seriesId, err);
      return null;
    }
  }

  async function fetchAndInject(itemId, container) {
    // Cache hit → render immediately, no API call
    if (qualityOverlayCache[itemId]) {
      const { quality, orientation } = qualityOverlayCache[itemId];
      insertOverlay(container, quality, orientation);
      return;
    }

    const userId = getUserId();
    if (!userId) return;

    try {
      const item = await ApiClient.getItem(userId, itemId);
      let videoStream = null;

      if (item.Type === "Series") {
        const ep = await fetchFirstEpisode(userId, itemId);
        if (ep?.Id) {
          const fullEp = await ApiClient.getItem(userId, ep.Id);
          videoStream = fullEp?.MediaSources?.[0]?.MediaStreams?.find(s => s.Type === "Video");
        }
      } else {
        videoStream = item?.MediaSources?.[0]?.MediaStreams?.find(s => s.Type === "Video");
      }

      if (videoStream?.Height || videoStream?.Width) {
        const quality = getQuality(videoStream);
        const orientation = getOrientationLabel(videoStream);

        qualityOverlayCache[itemId] = { quality, orientation };
        insertOverlay(container, quality, orientation);
      }
    } catch (err) {
      console.error("Failed to fetch or inject overlay for", itemId, err);
    }
  }

  function insertOverlay(container, quality, orientation) {
    if (!container || container.querySelector(`.${overlayClass}`)) return;

    const overlay = document.createElement('div');
    overlay.className = overlayClass;

    const stack = document.createElement('div');
    stack.className = 'quality-badges';

    // Quality badge
    const q = createLabel(quality, 'quality-badge');
    stack.appendChild(q);

    // Orientation badge (filtered by orientationMode)
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
        const o = createLabel(orientation, cls);
        stack.appendChild(o);
      }
    }

    overlay.appendChild(stack);

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(overlay);
  }

  function enqueueRequest(itemId, container) {
    if (requestQueue.length >= maxQueueSize) return;
    requestQueue.push({ itemId, container });
  }

  function processQueue() {
    if (activeRequests >= maxRequestsPerSecond || requestQueue.length === 0) return;
    const { itemId, container } = requestQueue.shift();
    activeRequests++;
    fetchAndInject(itemId, container).finally(() => {
      activeRequests--;
    });
  }
  setInterval(processQueue, 1000 / maxRequestsPerSecond);

  let intersectionObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const el = entry.target;
      if (!entry.isIntersecting || !el.href) continue;
      if (observedElements.has(el)) continue;

      const match = el.href.match(/id=([a-f0-9]{32})/i);
      if (!match) continue;

      const itemId = match[1];
      if (seenItems.has(itemId)) continue;

      seenItems.add(itemId);
      observedElements.add(el);
      intersectionObserver.unobserve(el);

      // Always enqueue; fetchAndInject() will short-circuit on cache
      enqueueRequest(itemId, el);
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