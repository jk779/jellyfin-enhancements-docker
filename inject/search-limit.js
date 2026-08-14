(() => {
  "use strict";

  const KEY = "__jf_patch_search_limit";
  if (window[KEY]) return;
  window[KEY] = true;

  const SEARCH_LIMIT = 1000;

  function patchUrl(url) {
    try {
      const parsed = new URL(url, location.origin);

      if (!parsed.pathname.includes("/Items")) {
        return url;
      }

      if (!parsed.searchParams.has("searchTerm")) {
        return url;
      }

      // Only change Jellyfin's normal 100-item search request.
      if (parsed.searchParams.get("limit") !== "100") {
        return url;
      }

      parsed.searchParams.set(
        "limit",
        String(SEARCH_LIMIT)
      );

      return parsed.toString();
    } catch {
      return url;
    }
  }

  // fetch
  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    if (typeof input === "string") {
      input = patchUrl(input);
    } else if (input instanceof Request) {
      const patchedUrl = patchUrl(input.url);

      if (patchedUrl !== input.url) {
        input = new Request(patchedUrl, input);
      }
    }

    return originalFetch.call(this, input, init);
  };

  // XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function (
    method,
    url,
    ...rest
  ) {
    if (typeof url === "string") {
      url = patchUrl(url);
    }

    return originalOpen.call(
      this,
      method,
      url,
      ...rest
    );
  };
})();