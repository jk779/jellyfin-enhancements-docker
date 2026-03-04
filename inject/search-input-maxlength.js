(() => {
  "use strict";

  // Prevent double-init if injected twice
  const KEY = "__jf_patch_searchmaxlength";
  if (window[KEY]) return;
  window[KEY] = true;

  const TARGET_ID = "searchTextInput";
  const MAXLEN = 1000; // set to null to remove attribute instead

  function patchOnce() {
    const el = document.getElementById(TARGET_ID);
    if (!el) return;

    if (!(el instanceof HTMLInputElement)) return;
    if (el.type && el.type !== "text" && el.type !== "search") return;

    if (MAXLEN === null) {
      el.removeAttribute("maxlength");
    } else {
      el.maxLength = MAXLEN;
      el.setAttribute("maxlength", String(MAXLEN));
    }
  }

  // Patch immediately
  patchOnce();

  // Reapply when Jellyfin rerenders DOM
  const mo = new MutationObserver(() => patchOnce());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Also when router changes
  window.addEventListener("hashchange", () => setTimeout(patchOnce, 50));
})();