// Jellyfin injected playback navigation enhancement:
// capture the ordered visible video cards when a direct play action starts, then
// expose previous/next controls in the player while preserving native queues.
(() => {
  "use strict";

  const INIT_KEY = "__tm_jellyfin_player_navigation_v1";
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  const CONTEXT_KEY = "tm_jellyfin_playback_context_v1";
  const CONTEXT_MAX_AGE = 30 * 60 * 1000;

  let scheduledPlayerRefresh = false;
  let webpackRequire = null;
  let playbackApi = null;
  let boundVideo = null;
  let boundVideoReset = null;
  let playRequestInFlight = false;
  let lastEndedKey = null;
  const heldShortcutKeys = new Set();

  function addStyles() {
    const style = document.createElement("style");
    style.id = "tm-jellyfin-player-navigation-style";
    style.textContent = `
      .tm-video-nav .material-icons { font-size: 24px; }
      .tm-video-nav[disabled] { opacity: .38; cursor: default; }
    `;
    document.head.appendChild(style);
  }

  function getApiClient() {
    try {
      if (window.ApiClient) return window.ApiClient;
      if (typeof ApiClient !== "undefined") return ApiClient;
    } catch {}
    return null;
  }

  function getServerId(item) {
    if (item?.serverId || item?.ServerId) return item.serverId || item.ServerId;
    try {
      return getApiClient()?.serverInfo?.()?.Id || null;
    } catch {
      return null;
    }
  }

  function getWebpackRequire() {
    if (webpackRequire) return webpackRequire;
    const chunks = window.webpackChunk;
    if (!Array.isArray(chunks)) return null;
    try {
      chunks.push([[`tm-player-navigation-${Date.now()}`], {}, require => { webpackRequire = require; }]);
    } catch (error) {
      console.warn("[InjectedPlayerNavigation] webpack runtime unavailable", error);
    }
    return webpackRequire;
  }

  function currentPlayerItem() {
    const roots = [...document.querySelectorAll('.videoOsdBottom-maincontrols')];
    const active = roots.find(root => !root.classList.contains("hide") && root.querySelector('.btnUserRating[data-id]')) || roots.find(root => root.querySelector('.btnUserRating[data-id]'));
    const button = active?.querySelector('.btnUserRating[data-id]');
    if (button?.dataset?.id) return { id: button.dataset.id, serverId: button.dataset.serverid || getServerId() };
    const poster = document.querySelector("video.htmlvideoplayer")?.getAttribute("poster") || "";
    const match = poster.match(/\/Items\/([^/]+)/i);
    return match ? { id: match[1], serverId: getServerId() } : null;
  }

  function getVideoCards() {
    return [...document.querySelectorAll('.card[data-type="Video"], .card[data-mediatype="Video"]')]
      .filter(card => {
        if (!card.dataset.id || card.classList.contains("tm-orientation-hidden") || card.classList.contains("hide")) return false;
        let current = card;
        while (current && current !== document.body) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden") return false;
          current = current.parentElement;
        }
        return true;
      });
  }

  function loadContext() {
    try {
      const context = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) || "null");
      if (!context || !Array.isArray(context.ids) || !context.ids.length || Date.now() - context.createdAt > CONTEXT_MAX_AGE) return null;
      return context;
    } catch {
      return null;
    }
  }

  function saveContext(context) {
    context.createdAt = context.createdAt || Date.now();
    window.__tmPlaybackContext = context;
    try { sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(context)); } catch {}
  }

  function clearContext() {
    window.__tmPlaybackContext = null;
    try { sessionStorage.removeItem(CONTEXT_KEY); } catch {}
  }

  function captureListingContext(selectedCard) {
    const cards = getVideoCards();
    const ids = cards.map(card => card.dataset.id);
    const selectedId = selectedCard?.dataset?.id;
    if (!ids.length || !selectedId || !ids.includes(selectedId)) return;
    saveContext({ ids, serverId: selectedCard.dataset.serverid || getServerId(), index: ids.indexOf(selectedId), source: location.hash, createdAt: Date.now() });
  }

  function findPlaybackApi() {
    if (playbackApi) return playbackApi;
    const require = getWebpackRequire();
    if (!require?.m) return null;
    for (const [id, moduleFactory] of Object.entries(require.m)) {
      const source = String(moduleFactory);
      if (!source.includes("previousTrack=function") || !source.includes("nextTrack=function")) continue;
      try {
        const exported = require(id);
        const candidates = [exported, exported?.default, ...(exported && typeof exported === "object" ? Object.values(exported) : [])];
        const found = candidates.find(value => value && typeof value.play === "function" && typeof value.getPlaylist === "function" && typeof value.nextTrack === "function" && typeof value.previousTrack === "function");
        if (found) {
          playbackApi = found;
          return playbackApi;
        }
      } catch (error) {
        console.warn("[InjectedPlayerNavigation] playback module lookup failed", error);
      }
    }
    // Do not cache failure: Jellyfin can register the playback chunk later.
    return null;
  }

  function nativeQueueIsActive(api = findPlaybackApi()) {
    const roots = [...document.querySelectorAll('.videoOsdBottom-maincontrols')];
    if (roots.some(root => !root.classList.contains("hide") && root.querySelector('.btnNextTrack:not(.hide), .btnPreviousTrack:not(.hide)'))) return true;
    try {
      const manager = api?._playQueueManager;
      const playlist = manager?.getPlaylist?.();
      if (Array.isArray(playlist) && playlist.length > 1) return true;
      if (Array.isArray(manager?._playlist) && manager._playlist.length > 1) return true;
    } catch {}
    try {
      const playlist = api?.getPlaylist?.();
      return Array.isArray(playlist) && playlist.length > 1;
    } catch {
      return false;
    }
  }

  function showToast(text) {
    const toast = document.createElement("div");
    toast.textContent = text;
    toast.style.cssText = "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:2147483647;padding:10px 14px;border-radius:3px;background:#292929;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.5);font:inherit";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  function isRepeatOneActive(api = findPlaybackApi()) {
    try {
      if (api?.getPlayerState?.()?.PlayState?.RepeatMode === "RepeatOne") return true;
    } catch {}
    try {
      return api?._playQueueManager?.getRepeatMode?.() === "RepeatOne";
    } catch {
      return false;
    }
  }

  async function playContextItem(context, index) {
    const api = findPlaybackApi();
    if (nativeQueueIsActive(api) || playRequestInFlight) return false;
    const id = context.ids[index];
    if (!id || !api?.play) {
      showToast("Next/previous playback is unavailable for this item.");
      return false;
    }
    context.index = index;
    saveContext(context);
    playRequestInFlight = true;
    try {
      await api.play({ serverId: context.serverId, ids: [id], fullscreen: true, startPositionTicks: 0 });
      return true;
    } catch (error) {
      console.error("[InjectedPlayerNavigation] failed to play adjacent item", error);
      showToast("The next/previous video could not be started.");
      return false;
    } finally {
      playRequestInFlight = false;
    }
  }

  function endedKey(video, item) {
    return `${item?.id || ""}|${video.currentSrc || video.src || ""}`;
  }

  async function handleVideoEnded(event) {
    const video = event.currentTarget;
    if (video !== boundVideo || !video.ended || video.error || playRequestInFlight) return;
    if (!video.currentSrc && !video.src) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const api = findPlaybackApi();
    if (isRepeatOneActive(api) || nativeQueueIsActive(api)) return;
    if (!api?.play) return;
    const context = loadContext();
    const item = currentPlayerItem();
    if (!context || !item) return;
    const key = endedKey(video, item);
    if (lastEndedKey === key) return;
    const index = context.ids.indexOf(item.id);
    const target = index + 1;
    if (index < 0 || target >= context.ids.length) return;
    // Jellyfin's regular ended handler can tear down this video before a
    // bubble listener gets to inspect it.  For a custom-context transition,
    // capture the event first and let playContextItem replace the player.
    event.stopImmediatePropagation();
    lastEndedKey = key;
    await playContextItem(context, target);
  }

  function syncVideoEndedListener() {
    const video = document.querySelector("video.htmlvideoplayer");
    if (video === boundVideo) return;
    if (boundVideo) {
      boundVideo.removeEventListener("ended", handleVideoEnded, true);
      if (boundVideoReset) {
        boundVideo.removeEventListener("loadedmetadata", boundVideoReset);
        boundVideo.removeEventListener("play", boundVideoReset);
      }
    }
    boundVideo = video || null;
    boundVideoReset = null;
    lastEndedKey = null;
    if (!boundVideo) return;
    boundVideoReset = () => { lastEndedKey = null; };
    boundVideo.addEventListener("ended", handleVideoEnded, true);
    boundVideo.addEventListener("loadedmetadata", boundVideoReset);
    boundVideo.addEventListener("play", boundVideoReset);
  }

  function setHidden(element, hidden) {
    if (!element || element.classList.contains("hide") === hidden) return;
    element.classList.toggle("hide", hidden);
  }

  function makeVideoNav(direction, reference, root) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tm-video-nav tm-video-${direction} autoSize paper-icon-button-light hide`;
    button.setAttribute("aria-label", direction === "previous" ? "Previous video" : "Next video");
    const icon = document.createElement("span");
    icon.className = `xlargePaperIconButton material-icons ${direction === "previous" ? "skip_previous" : "skip_next"}`;
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
    if (reference) reference.insertAdjacentElement(direction === "previous" ? "beforebegin" : "afterend", button);
    else root.querySelector(".osdControls")?.appendChild(button);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const context = loadContext();
      const item = currentPlayerItem();
      const api = findPlaybackApi();
      if (!context || !item || !api?.play || nativeQueueIsActive(api)) return;
      const index = context.ids.indexOf(item.id);
      const target = direction === "previous" ? index - 1 : index + 1;
      if (target >= 0 && target < context.ids.length) playContextItem(context, target);
    });
    return button;
  }

  function patchPlayerRoot(root) {
    const favorite = root.querySelector('.btnUserRating');
    if (!favorite) return;
    const context = loadContext();
    const item = currentPlayerItem();
    const api = findPlaybackApi();
    const usable = !!context && !!item && context.ids.includes(item.id) && !!api?.play && !nativeQueueIsActive(api);
    let previous = root.querySelector(".tm-video-nav.tm-video-previous");
    let next = root.querySelector(".tm-video-nav.tm-video-next");
    if (!previous) previous = makeVideoNav("previous", root.querySelector(".btnRewind"), root);
    if (!next) next = makeVideoNav("next", root.querySelector(".btnFastForward"), root);
    setHidden(previous, !usable);
    setHidden(next, !usable);
    if (!usable) return;
    const currentIndex = context.ids.indexOf(item.id);
    context.index = currentIndex;
    saveContext(context);
    const previousDisabled = currentIndex <= 0;
    const nextDisabled = currentIndex < 0 || currentIndex >= context.ids.length - 1;
    if (previous.disabled !== previousDisabled) previous.disabled = previousDisabled;
    if (next.disabled !== nextDisabled) next.disabled = nextDisabled;
    const previousTitle = previousDisabled ? "No previous video" : "Previous video";
    const nextTitle = nextDisabled ? "No next video" : "Next video";
    if (previous.title !== previousTitle) previous.title = previousTitle;
    if (next.title !== nextTitle) next.title = nextTitle;
  }

  function refreshPlayer() {
    scheduledPlayerRefresh = false;
    syncVideoEndedListener();
    for (const root of document.querySelectorAll('.videoOsdBottom-maincontrols')) patchPlayerRoot(root);
  }

  function schedulePlayerRefresh() {
    if (scheduledPlayerRefresh) return;
    scheduledPlayerRefresh = true;
    requestAnimationFrame(refreshPlayer);
  }

  function isVisible(element) {
    if (!element || element.hidden || element.classList.contains("hide")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function isEditableTarget(target) {
    let element = target;
    while (element) {
      if (element.matches?.("input, textarea, select")) return true;
      const contenteditable = element.getAttribute?.("contenteditable");
      if (element.isContentEditable || contenteditable === "true" || contenteditable === "") return true;
      if (element === document.body) break;
      element = element.parentElement;
    }
    return false;
  }

  function activePlayerRoot() {
    const video = document.querySelector("video.htmlvideoplayer");
    if (!isVisible(video)) return null;
    return [...document.querySelectorAll(".videoOsdBottom-maincontrols")]
      .find(root => !root.classList.contains("hide") && root.querySelector(".btnUserRating[data-id]")) || null;
  }

  function shortcutButton(direction) {
    const root = activePlayerRoot();
    if (!root) return null;

    const button = root.querySelector(`.tm-video-nav.tm-video-${direction}`);
    if (!button || button.disabled || !isVisible(button) || playRequestInFlight) return null;

    const context = loadContext();
    const item = currentPlayerItem();
    const api = findPlaybackApi();
    if (!context || !item || !context.ids.includes(item.id) || !api?.play || nativeQueueIsActive(api)) return null;

    const currentIndex = context.ids.indexOf(item.id);
    const target = direction === "previous" ? currentIndex - 1 : currentIndex + 1;
    if (target < 0 || target >= context.ids.length) return null;
    return button;
  }

  function shortcutKey(event) {
    const key = String(event.key || "").toLowerCase();
    return key === "p" || key === "n" ? key : null;
  }

  function handleShortcutKeydown(event) {
    const key = shortcutKey(event);
    if (!key || heldShortcutKeys.has(key) || event.repeat) return;
    heldShortcutKeys.add(key);

    if (event.defaultPrevented || event.isComposing || isModified(event) || isEditableTarget(event.target)) return;

    const button = shortcutButton(key === "p" ? "previous" : "next");
    if (!button) return;

    const requestWasInFlight = playRequestInFlight;
    try {
      // Use the same custom control as a pointer click so context, queue, and
      // boundary handling stay in one place.
      button.click();
    } catch (error) {
      console.warn("[InjectedPlayerNavigation] keyboard navigation failed", error);
      return;
    }
    if (!requestWasInFlight && playRequestInFlight) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function handleShortcutKeyup(event) {
    const key = shortcutKey(event);
    if (key) heldShortcutKeys.delete(key);
  }

  function itemFromCard(card) {
    if (!card?.dataset?.id) return null;
    return { id: card.dataset.id, serverId: card.dataset.serverid || getServerId() };
  }

  document.addEventListener("click", event => {
    const target = event.target?.closest?.("button, a, [data-action]");
    if (!target) return;
    const card = target.closest?.('.card[data-id]');
    if (card && target.closest('[data-action="resume"], [data-action="play"], [data-action="playallfromhere"], .btnPlay')) {
      captureListingContext(card);
    }
    if (card && target.closest('.cardText a, a[href*="/details"]')) captureListingContext(card);
    if (target.closest('.btnPlayAll, .btnShuffle, [data-id="playallfromhere"]')) clearContext();
  }, true);
  document.addEventListener("keydown", handleShortcutKeydown, true);
  document.addEventListener("keyup", handleShortcutKeyup, true);
  window.addEventListener("blur", () => heldShortcutKeys.clear());

  const observer = new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.type === "childList" || mutation.attributeName === "class" || mutation.attributeName === "data-id")) schedulePlayerRefresh();
  });

  addStyles();
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-id", "data-serverid"] });
  schedulePlayerRefresh();
})();
