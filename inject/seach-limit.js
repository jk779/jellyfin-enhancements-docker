(() => {
  "use strict";

  const KEY = "__jf_patch_search_limit";

  if (window[KEY]) return;
  window[KEY] = true;

  const SEARCH_LIMIT = 1000;

  function patchUrl(url) {
    if (!url) return null;

    try {
      const parsed = new URL(
        String(url),
        window.location.origin
      );

      // Only Jellyfin /Items searches.
      if (!parsed.pathname.endsWith("/Items")) {
        return null;
      }

      if (!parsed.searchParams.has("searchTerm")) {
        return null;
      }

      const currentLimit =
        Number(parsed.searchParams.get("limit"));

      // Only enlarge Jellyfin's normal 100-result search request.
      if (currentLimit !== 100) {
        return null;
      }

      parsed.searchParams.set(
        "limit",
        String(SEARCH_LIMIT)
      );

      return parsed.toString();
    } catch {
      return null;
    }
  }

  // ====== fetch ======

  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    const originalUrl =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url;

    const patchedUrl = patchUrl(originalUrl);

    if (!patchedUrl) {
      return originalFetch.call(
        this,
        input,
        init
      );
    }

    const patchedInput =
      typeof input === "string" || input instanceof URL
        ? patchedUrl
        : new Request(
            patchedUrl,
            input
          );

    return originalFetch.call(
      this,
      patchedInput,
      init
    );
  };

  // ====== XMLHttpRequest ======

  const originalOpen =
    XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function (
    method,
    url,
    async,
    user,
    password
  ) {
    const patchedUrl = patchUrl(url);

    return originalOpen.call(
      this,
      method,
      patchedUrl || url,
      async,
      user,
      password
    );
  };
})();