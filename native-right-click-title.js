(() => {
  "use strict";

  // Prevent double-init if injected twice
  const KEY = "__jf_patch_native_right_click_title";
  if (window[KEY]) return;
  window[KEY] = true;

  const TITLE_LINK =
    ".cardText a.itemAction.textActionButton[data-action='link'][href^='#/details']";

  function getTitleLink(target) {
    return target && target.closest ? target.closest(TITLE_LINK) : null;
  }

  function detailsUrlFromLink(linkEl) {
    const href = linkEl.getAttribute("href") || "";
    if (!href.startsWith("#/details")) return null;
    return `${location.origin}/web/${href}`;
  }

  // Kill Jellyfin's long-press / selection logic on title links.
  // Some browsers fire pointer events, some rely on mouse events for right-click.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!getTitleLink(e.target)) return;
      e.stopImmediatePropagation();
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (e) => {
      const link = getTitleLink(e.target);
      if (!link) return;

      // Only block handlers for right/middle mouse down.
      // Left-click should remain normal Jellyfin navigation unless Cmd-click handler below catches it.
      if (e.button === 2 || e.button === 1) {
        e.stopImmediatePropagation();
        // NOTE: no preventDefault -> keep native context menu / browser behavior
      }
    },
    true
  );

  // Restore native browser context menu on title links.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!getTitleLink(e.target)) return;
      e.stopImmediatePropagation(); // allow native menu
    },
    true
  );

  // Middle-click opens in new tab.
  document.addEventListener(
    "auxclick",
    (e) => {
      if (e.button !== 1) return;
      const link = getTitleLink(e.target);
      if (!link) return;

      const url = detailsUrlFromLink(link);
      if (!url) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      GM_openInTab(url, { active: false, insert: true });
    },
    true
  );

  // Cmd-click opens in new tab.
  document.addEventListener(
    "click",
    (e) => {
      if (!e.metaKey) return;
      const link = getTitleLink(e.target);
      if (!link) return;

      const url = detailsUrlFromLink(link);
      if (!url) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      GM_openInTab(url, { active: false, insert: true });
    },
    true
  );
})();