(function () {
  "use strict";

  // ====== Config ======
  const overlayClass = "quality-overlay-label";
  const orientationMode = "both"; // 'both' | 'horizontal-only' | 'vertical-only' | 'none'

  const HORZ_LABEL = "H→";
  const VERT_LABEL = "V↓";
  const SQUARE_LABEL = "Square";

  // ====== State ======
  //
  // This is intentionally NOT a persistent cache.
  //
  // Data from /Items responses is kept only until the corresponding
  // card appears in the DOM. Once the badge has been rendered,
  // the entry is deleted.
  const pendingItemData = new Map();

  // Cards for which the overlay has already been rendered.
  const renderedElements = new WeakSet();

  function createLabel(text, className) {
    const badge = document.createElement("div");
    badge.textContent = text;
    badge.className = className;
    return badge;
  }

  // Parses Jellyfin AspectRatio values such as:
  // "16:9", "9:16", "135:239", "1.7778", etc.
  function parseAspectRatio(value) {
    if (value == null) return null;

    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0
        ? value
        : null;
    }

    const str = String(value).trim();

    if (!str) return null;

    // Ratio notation: 16:9 or 16/9
    const match = str.match(
      /^([0-9]+(?:\.[0-9]+)?)\s*[:/]\s*([0-9]+(?:\.[0-9]+)?)$/
    );

    if (match) {
      const a = Number(match[1]);
      const b = Number(match[2]);

      if (a > 0 && b > 0) {
        return a / b;
      }

      return null;
    }

    // Decimal notation: 1.7778
    const numeric = Number(str);

    return Number.isFinite(numeric) && numeric > 0
      ? numeric
      : null;
  }

  function getDisplayAspectRatio(mediaStream) {
    if (!mediaStream) return null;

    // Prefer Jellyfin's display aspect ratio.
    // This correctly handles anamorphic/non-square-pixel video.
    let ratio = parseAspectRatio(mediaStream.AspectRatio);

    // Fallback for files where Jellyfin doesn't provide AspectRatio.
    if (!ratio) {
      const w = Number(mediaStream.Width) || 0;
      const h = Number(mediaStream.Height) || 0;

      if (!w || !h) return null;

      ratio = w / h;
    }

    // Rotation metadata is independent of the encoded width/height and DAR.
    // For 90° / 270° rotation, displayed width and height are swapped.
    const rotation = Number(mediaStream.Rotation);

    if (Number.isFinite(rotation)) {
      const normalizedRotation = ((rotation % 360) + 360) % 360;

      if (
        Math.abs(normalizedRotation - 90) < 1 ||
        Math.abs(normalizedRotation - 270) < 1
      ) {
        ratio = 1 / ratio;
      }
    }

    return ratio;
  }

  function getOrientationLabel(mediaStream) {
    const ratio = getDisplayAspectRatio(mediaStream);

    if (!ratio) return null;

    if (ratio >= 1.1) return HORZ_LABEL;
    if (ratio <= 0.9) return VERT_LABEL;

    return SQUARE_LABEL;
  }

  function getQuality(mediaStream) {
    if (!mediaStream) return null;

    const h =
      Number(mediaStream.Height) ||
      (
        mediaStream.Width
          ? Math.round(mediaStream.Width / 16 * 9)
          : 0
      );

    if (h >= 2160) return "4K";
    if (h >= 1440) return "2K";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";

    return "SD";
  }

  function formatRuntime(ticks) {
    if (!ticks) return null;

    const totalSeconds = Math.floor(ticks / 10_000_000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");

    return h > 0
      ? `${h}:${mm}:${ss}`
      : `${mm}:${ss}`;
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

      .quality-badge {
        background: rgba(22, 98, 173, 0.85);
      }

      .orientation-badge.horz {
        background: rgba(14, 152, 106, 0.95);
      }

      .orientation-badge.vert {
        background: rgba(201, 25, 25, 0.95);
      }

      .orientation-badge.square {
        background: rgba(107, 114, 128, 0.95);
      }

      .quality-badge:first-child {
        border-radius: 4px 0 0 4px;
      }

      .orientation-badge:last-child {
        border-radius: 0 4px 4px 0;
      }

      .quality-badges:has(.quality-badge:only-child) .quality-badge {
        border-radius: 4px;
      }
    `;

    document.head.appendChild(style);
  }

  // ====== URL patching ======

  function patchItemsUrl(url) {
    if (!url) return null;

    try {
      const parsed = new URL(
        String(url),
        window.location.origin
      );

      if (!parsed.pathname.endsWith("/Items")) {
        return null;
      }

      // Jellyfin uses both "Fields" and "fields" depending on code path.
      const fieldEntries = [
        ...parsed.searchParams.entries()
      ].filter(([key]) => key.toLowerCase() === "fields");

      // Preserve previous behavior: only modify /Items requests
      // which already explicitly request additional fields.
      if (!fieldEntries.length) {
        return null;
      }

      const existingFields = new Set(
        fieldEntries
          .flatMap(([, value]) => value.split(","))
          .map(value => value.trim().toLowerCase())
          .filter(Boolean)
      );

      // Preserve the spelling Jellyfin itself used.
      const fieldKey = fieldEntries[0][0];

      if (!existingFields.has("mediastreams")) {
        parsed.searchParams.append(
          fieldKey,
          "MediaStreams"
        );
      }

      if (!existingFields.has("runtimeticks")) {
        parsed.searchParams.append(
          fieldKey,
          "RunTimeTicks"
        );
      }

      return parsed.toString();
    } catch {
      return null;
    }
  }

  // ====== Response processing ======

  function processItemsResponse(data) {
    for (const item of data?.Items ?? []) {
      const videoStream = item.MediaStreams?.find(
        stream => stream.Type === "Video"
      );

      const quality = getQuality(videoStream);

      // Ignore non-video items / responses without MediaStreams.
      if (!quality) continue;

      pendingItemData.set(item.Id, {
        quality,
        orientation: getOrientationLabel(videoStream),
        runtime: formatRuntime(item.RunTimeTicks)
      });
    }

    // The cards may already be in the DOM.
    scanCards();
  }

  // ====== fetch patch ======

  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    const originalUrl =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url;

    const patchedUrl = patchItemsUrl(originalUrl);

    if (!patchedUrl) {
      return originalFetch.call(this, input, init);
    }

    const patchedInput =
      typeof input === "string" || input instanceof URL
        ? patchedUrl
        : new Request(patchedUrl, input);

    return originalFetch
      .call(this, patchedInput, init)
      .then(response => {
        const clone = response.clone();

        clone
          .json()
          .then(processItemsResponse)
          .catch(() => {});

        return response;
      });
  };

  // ====== XMLHttpRequest patch ======

  const originalXhrOpen =
    XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function (
    method,
    url,
    async,
    user,
    password
  ) {
    const patchedUrl = patchItemsUrl(url);

    if (patchedUrl) {
      url = patchedUrl;

      this.addEventListener("load", () => {
        try {
          let data;

          if (this.responseType === "json") {
            data = this.response;
          } else if (
            this.responseType === "" ||
            this.responseType === "text"
          ) {
            data = JSON.parse(this.responseText);
          } else {
            return;
          }

          processItemsResponse(data);
        } catch {
          // Ignore non-JSON/invalid responses.
        }
      });
    }

    return originalXhrOpen.call(
      this,
      method,
      url,
      async,
      user,
      password
    );
  };

  // ====== Overlay rendering ======

  function insertOverlay(
    container,
    quality,
    orientation,
    runtime
  ) {
    if (
      !container ||
      container.querySelector(`.${overlayClass}`)
    ) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = overlayClass;

    const stack = document.createElement("div");
    stack.className = "quality-badges";

    stack.appendChild(
      createLabel(
        quality,
        "quality-badge"
      )
    );

    if (
      orientation &&
      orientationMode !== "none"
    ) {
      const show =
        orientationMode === "both" ||
        (
          orientationMode === "horizontal-only" &&
          orientation === HORZ_LABEL
        ) ||
        (
          orientationMode === "vertical-only" &&
          orientation === VERT_LABEL
        );

      if (show) {
        const cls =
          orientation === HORZ_LABEL
            ? "orientation-badge horz"
            : orientation === VERT_LABEL
              ? "orientation-badge vert"
              : "orientation-badge square";

        stack.appendChild(
          createLabel(
            orientation,
            cls
          )
        );
      }
    }

    overlay.appendChild(stack);

    if (runtime) {
      overlay.appendChild(
        createLabel(
          runtime,
          "runtime-badge"
        )
      );
    }

    if (
      getComputedStyle(container).position === "static"
    ) {
      container.style.position = "relative";
    }

    container.appendChild(overlay);
  }

  // ====== Card processing ======

  function getItemIdFromCard(el) {
    if (!el?.href) return null;

    const match = el.href.match(
      /id=([a-f0-9]{32})/i
    );

    return match
      ? match[1]
      : null;
  }

  function renderCard(el) {
    if (!el || renderedElements.has(el)) {
      return false;
    }

    const itemId = getItemIdFromCard(el);

    if (!itemId) {
      return false;
    }

    const data = pendingItemData.get(itemId);

    if (!data) {
      return false;
    }

    insertOverlay(
      el,
      data.quality,
      data.orientation,
      data.runtime
    );

    renderedElements.add(el);

    // No persistent cache:
    // the information has fulfilled its purpose.
    pendingItemData.delete(itemId);

    return true;
  }

  // ====== IntersectionObserver ======

  const intersectionObserver =
    new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          const el = entry.target;

          if (renderCard(el)) {
            intersectionObserver.unobserve(el);
          }
        }
      },
      {
        rootMargin: "200px"
      }
    );

  function scanCards() {
    document
      .querySelectorAll("a.cardImageContainer")
      .forEach(el => {
        // If we already have the data, render immediately.
        if (renderCard(el)) {
          intersectionObserver.unobserve(el);
          return;
        }

        // Otherwise keep it observed until the corresponding
        // /Items response arrives.
        if (!renderedElements.has(el)) {
          intersectionObserver.observe(el);
        }
      });
  }

  // ====== DOM observer ======

  let mutationTimeout;

  const mutationObserver =
    new MutationObserver(() => {
      clearTimeout(mutationTimeout);

      mutationTimeout = setTimeout(
        scanCards,
        300
      );
    });

  // ====== Init ======

  addStyles();

  mutationObserver.observe(
    document.body,
    {
      childList: true,
      subtree: true
    }
  );

  scanCards();
})();