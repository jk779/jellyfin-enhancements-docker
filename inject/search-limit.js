(() => {
  "use strict";

  // Prevent double-init if injected twice
  const KEY = "__jf_patch_search_limit";
  if (window[KEY]) return;
  window[KEY] = true;

  const FORCED_LIMIT = 1000;
  const DEBUG = true;

  const log = (...args) => {
    if (DEBUG) {
      console.log("[jf-search-limit]", ...args);
    }
  };

  function shouldPatch(urlObj) {
    const path = urlObj.pathname || "";

    if (!path.includes("/Items")) {
      return false;
    }

    return urlObj.searchParams.has("searchTerm");
  }

  function patchItemsSearchUrl(inputUrl) {
    let urlObj;

    try {
      urlObj = new URL(inputUrl, location.origin);
    } catch {
      return {
        patched: false,
        url: inputUrl
      };
    }

    if (!shouldPatch(urlObj)) {
      return {
        patched: false,
        url: inputUrl
      };
    }

    const searchTerm =
      urlObj.searchParams.get("searchTerm") ?? "";

    if (!searchTerm) {
      return {
        patched: false,
        url: inputUrl
      };
    }

    const oldLimit =
      urlObj.searchParams.get("limit");

    urlObj.searchParams.set(
      "limit",
      String(FORCED_LIMIT)
    );

    const out = urlObj.toString();

    log(
      `patched search "${searchTerm}":`,
      oldLimit,
      "=>",
      FORCED_LIMIT
    );

    return {
      patched: true,
      url: out
    };
  }

  // ====== fetch ======

  const _fetch = window.fetch;

  window.fetch = function (input, init) {
    try {
      if (typeof input === "string") {
        const patched =
          patchItemsSearchUrl(input);

        if (patched.patched) {
          input = patched.url;
        }
      } else if (input instanceof Request) {
        const patched =
          patchItemsSearchUrl(input.url);

        if (patched.patched) {
          input = new Request(
            patched.url,
            input
          );
        }
      }
    } catch (e) {
      log("fetch patch error", e);
    }

    return _fetch.call(
      this,
      input,
      init
    );
  };

  // ====== XMLHttpRequest ======

  const _open =
    XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open =
    function (method, url, ...rest) {
      try {
        if (typeof url === "string") {
          const patched =
            patchItemsSearchUrl(url);

          if (patched.patched) {
            url = patched.url;
          }
        }
      } catch (e) {
        log("xhr patch error", e);
      }

      return _open.call(
        this,
        method,
        url,
        ...rest
      );
    };

  log(
    "installed, forced limit =",
    FORCED_LIMIT
  );
})();