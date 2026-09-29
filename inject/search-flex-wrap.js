(() => {
  "use strict";

  // Prevent double-init if injected twice
  const KEY = "__jf_patch_search_wrap";
  if (window[KEY]) return;
  window[KEY] = true;

  function addStyle(cssText) {
    const style = document.createElement("style");
    style.type = "text/css";
    style.appendChild(document.createTextNode(cssText));
    (document.head || document.documentElement).appendChild(style);
  }

  addStyle(`
    #searchPage .emby-scroller > div {
      flex-flow: wrap !important;
    }

    #searchPage .emby-scroller {
      padding: 0 max(2.5%, env(safe-area-inset-right)) 0 max(2.5%, env(safe-area-inset-left)) !important;
    }
  `);
})();
