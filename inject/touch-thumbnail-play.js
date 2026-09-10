// Jellyfin injected touch playback enhancement:
// play a video card from a normal touch tap on its thumbnail while keeping
// the thumbnail's details link available for mouse and keyboard interaction.
(() => {
  "use strict";

  const INIT_KEY = "__tm_jellyfin_touch_thumbnail_play_v1";
  const CARD_SELECTOR = '.card[data-type="Video"], .card[data-mediatype="Video"]';
  const THUMBNAIL_SELECTOR = 'a.cardImageContainer[data-action="link"]';
  const PLAY_SELECTOR = [
    'button[data-action="resume"]',
    'button[data-action="play"]',
    'button.btnPlay',
  ].join(",");
  const TAP_MOVE_TOLERANCE = 12;
  const LONG_PRESS_LIMIT = 700;
  const CLICK_SUPPRESSION_WINDOW = 500;
  const NESTED_INTERACTIVE_SELECTOR = "button, a, input, select, textarea, [data-action], [role='button'], [contenteditable='true']";

  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  let pendingTouch = null;
  let fallbackTouch = null;
  let suppressClick = null;
  let lastNonTouchInputAt = 0;

  function isTouchPointer(event) {
    if (event.pointerType) return event.pointerType === "touch";
    return false;
  }

  function isModified(event) {
    return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  }

  function getVideoCard(target) {
    const card = target?.closest?.(CARD_SELECTOR);
    if (!card || card.dataset.isfolder === "true") return null;

    const type = String(card.dataset.type || card.dataset.mediatype || "").toLowerCase();
    return type === "video" ? card : null;
  }

  function getThumbnail(target) {
    const thumbnail = target?.closest?.(THUMBNAIL_SELECTOR);
    if (!thumbnail || !getVideoCard(thumbnail)) return null;

    // Some Jellyfin themes place action elements inside the image link. A
    // tap on one of those controls must keep its own native action.
    let node = target;
    while (node && node !== thumbnail) {
      if (node.matches?.(NESTED_INTERACTIVE_SELECTOR)) return null;
      node = node.parentElement;
    }
    return thumbnail;
  }

  function getPlayButton(card) {
    return card?.querySelector?.(PLAY_SELECTOR) || null;
  }

  function clearPendingTouch() {
    pendingTouch = null;
  }

  function rememberClickToSuppress(thumbnail, card) {
    suppressClick = {
      thumbnail,
      card,
      createdAt: Date.now(),
      expiresAt: Date.now() + CLICK_SUPPRESSION_WINDOW,
    };
  }

  function isTouchGeneratedClick(event, remembered) {
    if (isModified(event) || event.detail === 0) return false;
    if (event.pointerType) return event.pointerType === "touch";
    if (event.sourceCapabilities) return event.sourceCapabilities.firesTouchEvents === true;
    if (lastNonTouchInputAt >= remembered.createdAt) return false;
    // Older WebViews may omit sourceCapabilities. The short expiry keeps this
    // fallback limited to the click synthesized immediately after touchend.
    return Date.now() - remembered.createdAt <= 250;
  }

  function consumeSyntheticThumbnailClick(event) {
    const remembered = suppressClick;
    if (!remembered) return false;
    if (Date.now() > remembered.expiresAt) {
      suppressClick = null;
      return false;
    }
    if (!isTouchGeneratedClick(event, remembered)) return false;

    const thumbnail = getThumbnail(event.target);
    if (thumbnail !== remembered.thumbnail || getVideoCard(thumbnail) !== remembered.card) return false;

    suppressClick = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  function beginTouch(event) {
    if (!isTouchPointer(event)) return;
    if (event.isPrimary === false) {
      clearPendingTouch();
      return;
    }
    if (event.button !== 0 || isModified(event)) return;

    const thumbnail = getThumbnail(event.target);
    const card = getVideoCard(thumbnail);
    if (!thumbnail || !card || !getPlayButton(card)) return;

    pendingTouch = {
      pointerId: event.pointerId,
      thumbnail,
      card,
      x: event.clientX,
      y: event.clientY,
      startedAt: event.timeStamp || performance.now(),
      moved: false,
    };
  }

  function updateTouch(event) {
    const touch = pendingTouch;
    if (event.pointerType === "touch" && event.isPrimary === false) {
      clearPendingTouch();
      return;
    }
    if (!touch || event.pointerId !== touch.pointerId) return;

    const x = Number.isFinite(event.clientX) ? event.clientX : touch.x;
    const y = Number.isFinite(event.clientY) ? event.clientY : touch.y;
    if (Math.hypot(x - touch.x, y - touch.y) > TAP_MOVE_TOLERANCE) touch.moved = true;
  }

  function finishTouch(event) {
    const touch = pendingTouch;
    if (!touch || event.pointerId !== touch.pointerId) return;
    clearPendingTouch();

    const duration = (event.timeStamp || performance.now()) - touch.startedAt;
    if (touch.moved || duration > LONG_PRESS_LIMIT || isModified(event)) return;
    if (getThumbnail(event.target) !== touch.thumbnail || getVideoCard(touch.thumbnail) !== touch.card) return;

    const playButton = getPlayButton(touch.card);
    if (!playButton || playButton.disabled) return;

    // Keep the call synchronous with the trusted touch gesture. Jellyfin's
    // native button handler then preserves its normal resume/play semantics.
    event.preventDefault();
    event.stopImmediatePropagation();
    rememberClickToSuppress(touch.thumbnail, touch.card);
    playButton.click();
  }

  function cancelTouch(event) {
    if (!pendingTouch || event.pointerId === pendingTouch.pointerId) clearPendingTouch();
  }

  document.addEventListener("pointerdown", beginTouch, true);
  document.addEventListener("pointerdown", event => {
    if (event.pointerType && event.pointerType !== "touch") lastNonTouchInputAt = Date.now();
  }, true);
  document.addEventListener("mousedown", () => {
    lastNonTouchInputAt = Date.now();
  }, true);
  document.addEventListener("pointermove", updateTouch, true);
  document.addEventListener("pointerup", finishTouch, true);
  document.addEventListener("pointercancel", cancelTouch, true);
  document.addEventListener("lostpointercapture", cancelTouch, true);
  document.addEventListener("click", consumeSyntheticThumbnailClick, true);
  document.addEventListener("contextmenu", () => {
    clearPendingTouch();
    fallbackTouch = null;
  }, true);

  // Older iPad WebViews without PointerEvent support still expose touch
  // events. Enable the same conservative gesture path only in that case, so
  // touchscreen-capable desktop browsers keep their normal mouse behavior.
  if (!window.PointerEvent) {
    document.addEventListener("touchstart", event => {
      if (event.touches.length !== 1 || isModified(event)) {
        fallbackTouch = null;
        return;
      }
      const touch = event.touches[0];
      const thumbnail = getThumbnail(touch.target);
      const card = getVideoCard(thumbnail);
      if (!thumbnail || !card || !getPlayButton(card)) return;
      fallbackTouch = {
        thumbnail,
        card,
        identifier: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        startedAt: event.timeStamp || performance.now(),
        moved: false,
      };
    }, true);

    document.addEventListener("touchmove", event => {
      const touch = fallbackTouch && [...event.touches].find(item => item.identifier === fallbackTouch.identifier);
      if (!touch) return;
      if (Math.hypot(touch.clientX - fallbackTouch.x, touch.clientY - fallbackTouch.y) > TAP_MOVE_TOLERANCE) fallbackTouch.moved = true;
    }, true);

    document.addEventListener("touchend", event => {
      const state = fallbackTouch;
      if (!state) return;
      const touch = [...event.changedTouches].find(item => item.identifier === state.identifier);
      fallbackTouch = null;
      if (!touch || state.moved || (event.timeStamp || performance.now()) - state.startedAt > LONG_PRESS_LIMIT) return;
      if (getThumbnail(touch.target) !== state.thumbnail || getVideoCard(state.thumbnail) !== state.card) return;

      const playButton = getPlayButton(state.card);
      if (!playButton || playButton.disabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      rememberClickToSuppress(state.thumbnail, state.card);
      playButton.click();
    }, { capture: true, passive: false });

    document.addEventListener("touchcancel", () => {
      fallbackTouch = null;
    }, true);
  }
})();
