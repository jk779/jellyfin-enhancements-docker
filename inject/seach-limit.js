(() => {
  "use strict";

  const KEY = "__jf_patch_search_limit";
  if (window[KEY]) return;
  window[KEY] = true;

  const SEARCH_LIMIT = 1000;

  const originalOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function (
    method,
    url,
    async,
    user,
    password
  ) {
    if (
      typeof url === "string" &&
      url.includes("/Items?") &&
      url.includes("searchTerm=")
    ) {
      const parsed = new URL(url, window.location.origin);

      if (parsed.searchParams.get("limit") === "100") {
        parsed.searchParams.set("limit", String(SEARCH_LIMIT));
        url = parsed.toString();
      }
    }

    return originalOpen.call(this, method, url, async, user, password);
  };
})();