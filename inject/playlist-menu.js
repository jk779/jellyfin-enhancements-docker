// Jellyfin injected playlist enhancement:
// - Replaces the item Add-to-playlist dialog with a checked, toggleable popover.
// - Adds the same playlist popover to the video player through a bookmark button.
// - Keeps the native playlist editor available as an exact English fallback row.
// Playlist mutations use Jellyfin's playlist-entry IDs for removals. Read-only or
// unavailable permissions stay disabled.
(() => {
  "use strict";

  const INIT_KEY = "__tm_jellyfin_playlist_menu_v1";
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  const PLAYLIST_MODULE_ID = 4330;
  const SDK_CHUNK_ID = 45642;
  const PLAYLIST_EDITOR_CHUNK_ID = 4330;
  const MAX_PAGE_SIZE = 200;

  let pendingMenuContext = null;
  let activeMenuContext = null;
  let popover = null;
  let popoverAnchor = null;
  let popoverItem = null;
  let popoverMode = null;
  let popoverVersion = 0;
  let scheduledPlayerRefresh = false;
  let webpackRequire = null;
  const busyPlaylists = new Set();

  function addStyles() {
    const style = document.createElement("style");
    style.id = "tm-jellyfin-playlist-menu-style";
    style.textContent = `
      .tm-playlist-popover {
        position: fixed;
        z-index: 2147483646;
        width: min(340px, calc(100vw - 16px));
        max-height: min(520px, calc(100vh - 16px));
        overflow: auto;
        padding: 4px 0;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 3px;
        background: rgb(39,39,39);
        color: #fff;
        box-shadow: 0 5px 18px rgba(0,0,0,.55);
        font: inherit;
      }
      .tm-playlist-row {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 40px;
        padding: 8px 12px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .tm-playlist-row:hover:not(:disabled),
      .tm-playlist-row:focus-visible { background: rgba(255,255,255,.1); }
      .tm-playlist-row:disabled { cursor: default; opacity: .52; }
      .tm-playlist-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-playlist-check { display: inline-flex; align-items: center; justify-content: center; width: 20px; min-width: 20px; height: 20px; }
      .tm-playlist-check .material-icons { font-size: 19px; }
      .tm-playlist-spinner {
        box-sizing: border-box;
        width: 16px; height: 16px;
        border: 2px solid rgba(255,255,255,.35);
        border-top-color: #fff;
        border-radius: 50%;
        animation: tm-playlist-spin .7s linear infinite;
      }
      .tm-playlist-divider { height: 1px; margin: 4px 0; background: rgba(255,255,255,.12); }
      .tm-playlist-status { padding: 10px 12px; color: rgba(255,255,255,.72); font-size: .92em; }
      .tm-playlist-error { color: #ff9b9b; white-space: normal; }
      .tm-playlist-legacy { color: rgba(255,255,255,.82); }
      .tm-playlist-bookmark .material-icons { font-size: 24px; }
      .tm-playlist-bookmark[disabled] { opacity: .38; cursor: default; }
      @keyframes tm-playlist-spin { to { transform: rotate(360deg); } }
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

  function getUserId() {
    const api = getApiClient();
    try {
      return api?.getCurrentUserId?.() || api?._currentUser?.Id || api?._serverInfo?.UserId || null;
    } catch {
      return null;
    }
  }

  function getAccessToken() {
    const api = getApiClient();
    try {
      return api?.accessToken?.() || api?._serverInfo?.AccessToken || null;
    } catch {
      return null;
    }
  }

  function makeApiUrl(path, params) {
    const api = getApiClient();
    const cleanPath = String(path).replace(/^\/+/, "");
    let url;
    try {
      url = api?.getUrl ? api.getUrl(cleanPath) : `${location.origin}/${cleanPath}`;
    } catch {
      url = `${location.origin}/${cleanPath}`;
    }
    const parsed = new URL(url, location.origin);
    for (const [key, value] of params || []) {
      if (value !== undefined && value !== null && value !== "") parsed.searchParams.append(key, String(value));
    }
    return parsed.toString();
  }

  async function apiRequest(path, { method = "GET", params = [], body } = {}) {
    const token = getAccessToken();
    const headers = {};
    const api = getApiClient();
    try {
      // Jellyfin 12 expects the same standard Authorization header used by its
      // web client.  Keeping this on ApiClient also preserves its current
      // client, device, and version identifiers across web-client upgrades.
      if (typeof api?.setRequestHeaders === "function") api.setRequestHeaders(headers);
    } catch {}
    if (token && !headers.Authorization) {
      headers.Authorization = `MediaBrowser Token="${token}"`;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(makeApiUrl(path, params), {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function fetchAllPages(path, params, readPage) {
    const out = [];
    let startIndex = 0;
    let total = Infinity;
    while (startIndex < total) {
      const page = await apiRequest(path, {
        params: [...params, ["StartIndex", startIndex], ["Limit", MAX_PAGE_SIZE]],
      });
      const values = readPage(page);
      out.push(...values);
      total = Number(page?.TotalRecordCount);
      if (!values.length || !Number.isFinite(total) || startIndex + values.length >= total) break;
      startIndex += values.length;
    }
    return out;
  }

  async function getPlaylists() {
    const userId = getUserId();
    if (!userId) throw new Error("Jellyfin user is unavailable");
    const items = await fetchAllPages(
      "Items",
      [["UserId", userId], ["IncludeItemTypes", "Playlist"], ["Recursive", true], ["SortBy", "SortName"], ["EnableUserData", false]],
      page => Array.isArray(page?.Items) ? page.Items : []
    );

    const permissions = await Promise.all(items.map(async item => {
      try {
        const result = await apiRequest(`Playlists/${encodeURIComponent(item.Id)}/Users/${encodeURIComponent(userId)}`);
        return { item, editable: result?.CanEdit === true, permissionKnown: true };
      } catch {
        return { item, editable: false, permissionKnown: false };
      }
    }));

    return Promise.all(permissions.map(async playlist => {
      try {
        const entries = await fetchAllPages(
          `Playlists/${encodeURIComponent(playlist.item.Id)}/Items`,
          [["UserId", userId]],
          page => Array.isArray(page?.Items) ? page.Items : []
        );
        return { ...playlist, entries, member: false };
      } catch {
        return { ...playlist, entries: [], entriesUnavailable: true, member: false };
      }
    }));
  }

  function itemIsInPlaylist(playlist, itemId) {
    return playlist.entries.some(entry => String(entry.Id) === String(itemId));
  }

  function findEntryIds(playlist, itemId) {
    return playlist.entries
      .filter(entry => String(entry.Id) === String(itemId))
      .map(entry => entry.PlaylistItemId)
      .filter(Boolean);
  }

  function appendLegacyRow(item) {
    if (!popover || popover.querySelector(".tm-playlist-legacy")) return;
    const divider = document.createElement("div");
    divider.className = "tm-playlist-divider";
    popover.appendChild(divider);
    const legacy = document.createElement("button");
    legacy.type = "button";
    legacy.className = "tm-playlist-row tm-playlist-legacy";
    legacy.textContent = "Legacy playlist overlay";
    legacy.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openLegacyPlaylistOverlay(item);
    });
    popover.appendChild(legacy);
  }

  function setPopoverStatus(text, error = false, includeLegacy = true) {
    if (!popover) return;
    const status = document.createElement("div");
    status.className = `tm-playlist-status${error ? " tm-playlist-error" : ""}`;
    status.setAttribute("role", error ? "alert" : "status");
    status.textContent = text;
    popover.replaceChildren(status);
    if (includeLegacy && popoverItem) appendLegacyRow(popoverItem);
    positionPopover();
  }

  function positionPopover() {
    if (!popover || !popoverAnchor?.isConnected) return;
    const anchorRect = popoverAnchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    let left = popoverMode === "context" ? anchorRect.right + 4 : anchorRect.left;
    let top = popoverMode === "context" ? anchorRect.top : anchorRect.top - height - 8;
    if (left + width > window.innerWidth - 8) left = anchorRect.left - width - 4;
    if (left < 8) left = 8;
    if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
    if (top < 8) top = 8;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function closePlaylistMenu() {
    popoverVersion++;
    popover?.remove();
    popover = null;
    popoverAnchor = null;
    popoverItem = null;
    popoverMode = null;
  }

  function renderPlaylistRows(playlists, item, version) {
    if (!popover || version !== popoverVersion) return;
    popover.replaceChildren();
    if (!playlists.length) {
      setPopoverStatus("No editable playlists found.");
      return;
    }

    for (const playlist of playlists) {
      playlist.member = itemIsInPlaylist(playlist, item.id);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tm-playlist-row";
      row.dataset.playlistId = playlist.item.Id;
      row.title = playlist.permissionKnown === false ? "Playlist permissions could not be read" : "";
      row.disabled = playlist.permissionKnown === false || playlist.editable !== true || playlist.entriesUnavailable === true || playlist.unknownMutation === true;

      const check = document.createElement("span");
      check.className = "tm-playlist-check";
      const icon = document.createElement("span");
      icon.className = "material-icons";
      icon.textContent = playlist.member ? "check" : "";
      check.appendChild(icon);
      const name = document.createElement("span");
      name.className = "tm-playlist-name";
      name.textContent = playlist.item.Name || "Unnamed playlist";
      row.append(check, name);
      row.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        togglePlaylist(playlist, item, row, check, icon);
      });
      popover.appendChild(row);
    }

    appendLegacyRow(item);
    positionPopover();
  }

  async function getPlaylistEntries(playlistId, userId) {
    if (!userId) throw new Error("Jellyfin user is unavailable");
    return fetchAllPages(
      `Playlists/${encodeURIComponent(playlistId)}/Items`,
      [["UserId", userId]],
      page => Array.isArray(page?.Items) ? page.Items : []
    );
  }

  async function togglePlaylist(playlist, item, row, check, icon) {
    const playlistId = String(playlist.item.Id);
    if (busyPlaylists.has(playlistId) || row.disabled) return;
    const menuAtStart = popover;
    const versionAtStart = popoverVersion;
    const desiredMember = !playlist.member;
    let mutationSent = false;
    busyPlaylists.add(playlistId);
    row.disabled = true;
    icon.textContent = "";
    const spinner = document.createElement("span");
    spinner.className = "tm-playlist-spinner";
    check.appendChild(spinner);
    try {
      const userId = getUserId();
      if (!userId) throw new Error("Jellyfin user is unavailable");
      if (playlist.member) {
        const entryIds = findEntryIds(playlist, item.id);
        if (!entryIds.length) throw new Error("Playlist entry ID is unavailable");
        for (const entryId of entryIds) {
          mutationSent = true;
          await apiRequest(`Playlists/${encodeURIComponent(playlistId)}/Items`, {
            method: "DELETE",
            params: [["EntryIds", entryId]],
          });
        }
      } else {
        mutationSent = true;
        await apiRequest(`Playlists/${encodeURIComponent(playlistId)}/Items`, {
          method: "POST",
          params: [["Ids", item.id], ["UserId", userId]],
        });
      }

      const entries = await getPlaylistEntries(playlistId, userId);
      const member = entries.some(entry => String(entry.Id) === String(item.id));
      if (!playlist.member && !member) throw new Error("Jellyfin did not confirm the playlist addition");
      if (playlist.member && member) throw new Error("Jellyfin did not remove every playlist entry");
      playlist.entries = entries;
      playlist.member = member;
      playlist.unknownMutation = false;
      if (popover === menuAtStart && popoverVersion === versionAtStart && row.isConnected) {
        row.disabled = false;
        icon.textContent = member ? "check" : "";
      }
    } catch (error) {
      console.error("[InjectedPlaylist] playlist mutation failed", error);
      let confirmedMember = null;
      try {
        const refreshedEntries = await getPlaylistEntries(playlistId, getUserId());
        confirmedMember = refreshedEntries.some(entry => String(entry.Id) === String(item.id));
        playlist.entries = refreshedEntries;
        playlist.member = confirmedMember;
      } catch {}

      if (confirmedMember === desiredMember) {
        playlist.unknownMutation = false;
        if (popover === menuAtStart && popoverVersion === versionAtStart && row.isConnected) {
          row.disabled = false;
          icon.textContent = confirmedMember ? "check" : "";
        }
      } else if (popover === menuAtStart && popoverVersion === versionAtStart && row.isConnected) {
        // Do not allow an ambiguous successful mutation to be retried in this menu.
        playlist.unknownMutation = mutationSent;
        row.disabled = true;
        icon.textContent = playlist.member ? "check" : "";
        const message = document.createElement("div");
        message.className = "tm-playlist-status tm-playlist-error";
        message.setAttribute("role", "alert");
        message.textContent = mutationSent
          ? "Playlist change could not be confirmed. Reopen the menu before retrying."
          : "Playlist change failed. Check your Jellyfin permissions and try again.";
        popover.insertBefore(message, popover.firstChild);
      }
    } finally {
      spinner.remove();
      busyPlaylists.delete(playlistId);
      positionPopover();
    }
  }

  async function openPlaylistMenu(item, anchor, mode) {
    closePlaylistMenu();
    popoverItem = item;
    popoverAnchor = anchor;
    popoverMode = mode;
    popover = document.createElement("div");
    popover.className = "tm-playlist-popover";
    popover.setAttribute("role", "menu");
    popover.setAttribute("aria-label", "Playlists");
    document.body.appendChild(popover);
    setPopoverStatus("Loading playlists…");
    positionPopover();
    const version = popoverVersion;
    try {
      const playlists = await getPlaylists();
      renderPlaylistRows(playlists, item, version);
    } catch (error) {
      console.error("[InjectedPlaylist] failed to load playlists", error);
      if (version === popoverVersion) setPopoverStatus("Could not load playlists. Check your Jellyfin permissions.", true);
    }
  }

  function showToast(text) {
    const toast = document.createElement("div");
    toast.textContent = text;
    toast.style.cssText = "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:2147483647;padding:10px 14px;border-radius:3px;background:#292929;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.5);font:inherit";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  function getWebpackRequire() {
    if (webpackRequire) return webpackRequire;
    const chunks = window.webpackChunk;
    if (!Array.isArray(chunks)) return null;
    try {
      chunks.push([[`tm-playlist-${Date.now()}`], {}, require => { webpackRequire = require; }]);
    } catch (error) {
      console.warn("[InjectedPlaylist] webpack runtime unavailable", error);
    }
    return webpackRequire;
  }

  function openLegacyPlaylistOverlay(item) {
    const actionButton = document.querySelector('.actionSheet.opened [data-id="addtoplaylist"]');
    closePlaylistMenu();
    if (actionButton) {
      window.__tmSkipPlaylistIntercept = true;
      actionButton.click();
      setTimeout(() => { window.__tmSkipPlaylistIntercept = false; }, 0);
      return;
    }

    const require = getWebpackRequire();
    if (!require?.e) {
      showToast("The legacy playlist overlay is unavailable in this Jellyfin build.");
      return;
    }
    Promise.all([require.e(SDK_CHUNK_ID), require.e(PLAYLIST_EDITOR_CHUNK_ID)])
      .then(() => {
        const module = require(PLAYLIST_MODULE_ID);
        const Editor = module?.default || module;
        if (typeof Editor !== "function") throw new Error("Playlist editor module unavailable");
        return new Editor().show({
          items: [item.id],
          serverId: getServerId(item),
          enableAddToPlayQueue: false,
          defaultValue: "new",
        });
      })
      .catch(error => {
        console.error("[InjectedPlaylist] failed to open legacy playlist overlay", error);
        showToast("The legacy playlist overlay could not be opened.");
      });
  }

  function itemFromCard(card) {
    if (!card?.dataset?.id) return null;
    return { id: card.dataset.id, serverId: card.dataset.serverid || getServerId(), title: card.textContent.trim().slice(0, 200) };
  }

  function visibleDetailItem() {
    const candidates = [...document.querySelectorAll('.detailPage [data-id][data-serverid], .detailRibbon [data-id][data-serverid], .btnPlay[data-id][data-serverid]')];
    const visible = candidates.find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.dataset.id;
    });
    if (visible) return { id: visible.dataset.id, serverId: visible.dataset.serverid || getServerId() };
    try {
      const query = new URLSearchParams((location.hash.split("?")[1] || "").split("#")[0]);
      const id = query.get("id");
      return id ? { id, serverId: query.get("serverId") || getServerId() } : null;
    } catch {
      return null;
    }
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

  function patchPlayerRoot(root) {
    const favorite = root.querySelector('.btnUserRating');
    if (!favorite) return;
    let bookmark = root.querySelector(".tm-playlist-bookmark");
    if (!bookmark) {
      bookmark = document.createElement("button");
      bookmark.type = "button";
      bookmark.className = "tm-playlist-bookmark autoSize paper-icon-button-light";
      bookmark.title = "Add to playlist";
      bookmark.setAttribute("aria-label", "Add to playlist");
      const icon = document.createElement("span");
      icon.className = "xlargePaperIconButton material-icons bookmark_border";
      icon.setAttribute("aria-hidden", "true");
      bookmark.appendChild(icon);
      favorite.insertAdjacentElement("afterend", bookmark);
      bookmark.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const item = currentPlayerItem();
        if (item) openPlaylistMenu(item, bookmark, "player");
      });
    }
    const item = currentPlayerItem();
    if (bookmark.disabled !== !item) bookmark.disabled = !item;
  }

  function refreshPlayer() {
    scheduledPlayerRefresh = false;
    for (const root of document.querySelectorAll('.videoOsdBottom-maincontrols')) patchPlayerRoot(root);
    if (popoverMode === "player") {
      const item = currentPlayerItem();
      if (!item || item.id !== popoverItem?.id) closePlaylistMenu();
    }
  }

  function schedulePlayerRefresh() {
    if (scheduledPlayerRefresh) return;
    scheduledPlayerRefresh = true;
    requestAnimationFrame(refreshPlayer);
  }

  function rememberMenuContext(item, trigger) {
    pendingMenuContext = item && trigger
      ? { item, trigger, token: Symbol("menu"), createdAt: performance.now() }
      : null;
    activeMenuContext = null;
  }

  function bindActionSheetContext() {
    const sheet = [...document.querySelectorAll(".actionSheet.opened")].at(-1);
    if (!sheet) {
      activeMenuContext = null;
      if (pendingMenuContext && performance.now() - pendingMenuContext.createdAt > 1000) pendingMenuContext = null;
      return;
    }
    if (activeMenuContext?.sheet === sheet) return;
    if (pendingMenuContext?.trigger?.isConnected && performance.now() - pendingMenuContext.createdAt <= 1000) {
      activeMenuContext = { ...pendingMenuContext, sheet };
      pendingMenuContext = null;
    } else {
      activeMenuContext = null;
    }
  }

  document.addEventListener("click", event => {
    const target = event.target?.closest?.("button, a, [data-action]");
    if (!target) return;
    const card = target.closest?.('.card[data-id]');
    if (card && target.closest('[data-action="menu"]')) {
      rememberMenuContext(itemFromCard(card), target.closest('[data-action="menu"]'));
    }
    if (target.closest('.btnMoreCommands')) {
      rememberMenuContext(visibleDetailItem(), target.closest('.btnMoreCommands'));
    }

    const addToPlaylist = target.closest('.actionSheet.opened [data-id="addtoplaylist"]');
    if (addToPlaylist) {
      if (window.__tmSkipPlaylistIntercept) {
        window.__tmSkipPlaylistIntercept = false;
        return;
      }
      const sheet = addToPlaylist.closest(".actionSheet");
      bindActionSheetContext();
      const item = activeMenuContext?.sheet === sheet ? activeMenuContext.item : null;
      if (!item) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openPlaylistMenu(item, addToPlaylist, "context");
    }
  }, true);

  document.addEventListener("pointerdown", event => {
    if (!popover) return;
    const target = event.target;
    if (popover.contains(target) || popoverAnchor?.contains(target)) return;
    closePlaylistMenu();
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && popover) {
      event.preventDefault();
      event.stopPropagation();
      closePlaylistMenu();
    }
  }, true);

  const observer = new MutationObserver(mutations => {
    bindActionSheetContext();
    if (popoverMode === "context" && popoverAnchor && !popoverAnchor.isConnected) closePlaylistMenu();
    if (mutations.some(mutation => mutation.type === "childList" || mutation.attributeName === "class" || mutation.attributeName === "data-id")) schedulePlayerRefresh();
  });

  addStyles();
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-id", "data-serverid"] });
  window.addEventListener("hashchange", () => {
    pendingMenuContext = null;
    activeMenuContext = null;
    closePlaylistMenu();
    schedulePlayerRefresh();
  });
  schedulePlayerRefresh();
})();
