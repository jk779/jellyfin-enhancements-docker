// This is a blantant hack to add some basic search filters to the Jellyfin frontend without backend modifications.
//
// Use only if you're OK with potentially much worse server and client performance, incomplete filtering results due to
// API limits, breakage of future Jellyfin versions, race conditions on API requests, and other fun side effects.
//
// Usage: `TERM +REQUIRE -EXCLUDE` where
//   TERM is the backend search term,
//   REQUIRE removes results not matching the keyword and
//   EXCLUDE removes results that match the keyword.
// Modifiers can be used together and multiple times. Quoted terms are supported,
// Example: `star -wars -borg +end`
//

(() => {
  "use strict";

  // Prevent double-init if injected twice
  const KEY = "__jf_patch_frontend_search_filters";
  if (window[KEY]) return;
  window[KEY] = true;

  const STORE_KEY = "tm_jf_search_ops_v1";
  const SENTINEL = "__tm_no_positive__"; // avoids "empty search returns everything" behavior
  const DEBUG = false;

  // Set every (patched) search /Items request to this limit
  // This has the potential to cause performance issues, or is too low for some use cases. Adjust as needed.
  const FORCED_LIMIT = 1000;

  // This is not yet robust enough to not have logs ;)
  const log = (...args) => {
    if (DEBUG) console.log("[tm-jf-opssearch]", ...args);
  };

  const normalize = (s) =>
    (s ?? "")
      .toString()
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .trim();

  function tokenize(input) {
    const s = (input ?? "").trim();
    if (!s) return [];

    const tokens = [];
    let cur = "";
    let inQuote = false;
    let quoteChar = null;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (!inQuote && (ch === `"` || ch === `'`)) {
        inQuote = true;
        quoteChar = ch;
        continue;
      }
      if (inQuote && ch === quoteChar) {
        inQuote = false;
        quoteChar = null;
        continue;
      }

      if (!inQuote && /\s/.test(ch)) {
        if (cur) tokens.push(cur);
        cur = "";
        continue;
      }

      cur += ch;
    }

    if (cur) tokens.push(cur);
    return tokens;
  }

  function parseQuery(raw) {
    const tokens = tokenize(raw);

    const positives = [];
    const excludes = [];
    const requires = [];

    for (const t of tokens) {
      if (t.startsWith("-") && t.length > 1) excludes.push(t.slice(1));
      else if (t.startsWith("+") && t.length > 1) requires.push(t.slice(1));
      else positives.push(t);
    }

    return {
      positive: positives.join(" ").trim(),
      excludes: excludes.map(normalize).filter(Boolean),
      requires: requires.map(normalize).filter(Boolean),
      hasOps: excludes.length > 0 || requires.length > 0,
    };
  }

  function storeOps(excludes, requires) {
    try {
      sessionStorage.setItem(
        STORE_KEY,
        JSON.stringify({ excludes: excludes ?? [], requires: requires ?? [] })
      );
    } catch {}
  }

  function loadOps() {
    try {
      const v = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}");
      return {
        excludes: Array.isArray(v.excludes) ? v.excludes : [],
        requires: Array.isArray(v.requires) ? v.requires : [],
      };
    } catch {
      return { excludes: [], requires: [] };
    }
  }

  // Decide whether a URL is a Jellyfin items request we want to patch
  // Ignore other API requests like /Artists for now.
  function shouldPatch(urlObj) {
    const p = urlObj.pathname || "";
    if (!p.includes("/Items")) return false;
    return urlObj.searchParams.has("searchTerm");
  }

  function patchItemsSearchUrl(inputUrl) {
    let urlObj;
    try {
      urlObj = new URL(inputUrl, location.origin);
    } catch {
      return { patched: false, url: inputUrl };
    }

    if (!shouldPatch(urlObj)) return { patched: false, url: inputUrl };

    const rawTerm = urlObj.searchParams.get("searchTerm") ?? "";
    if (!rawTerm) return { patched: false, url: inputUrl };

    const parsed = parseQuery(rawTerm);
    if (!parsed.hasOps) return { patched: false, url: inputUrl };

    storeOps(parsed.excludes, parsed.requires);

    // Force a larger result set to have more items for client-side filtering.
    urlObj.searchParams.set("limit", String(FORCED_LIMIT));

    const backendTerm = parsed.positive || SENTINEL;
    urlObj.searchParams.set("searchTerm", backendTerm);

    const out = urlObj.toString();
    log("patched searchTerm:", rawTerm, "=>", backendTerm, {
      excludes: parsed.excludes,
      requires: parsed.requires,
      forcedLimit: FORCED_LIMIT,
    });
    return { patched: true, url: out };
  }

  // UI filtering (after results render) - ugh!
  function findResultsRoot() {
    return (
      document.querySelector(".searchResults") ||
      document.querySelector(".searchResultsContainer") ||
      document.querySelector(".page") ||
      document.body
    );
  }

  function extractResultText(node) {
    const titleEl =
      node.querySelector(".cardText") ||
      node.querySelector(".cardText-first") ||
      node.querySelector(".secondaryText") ||
      node.querySelector("[data-title]");

    const title =
      titleEl?.getAttribute?.("data-title") ||
      titleEl?.textContent ||
      node.textContent;

    return normalize(title);
  }

  function applyOpsFilter() {
    const { excludes, requires } = loadOps();
    if (!excludes.length && !requires.length) return;

    const root = findResultsRoot();
    const items = root.querySelectorAll(".card, a.card, .listItem, .searchResult, .cardBox");

    for (const el of items) {
      const text = extractResultText(el);
      if (!text) continue;

      const failsRequires = requires.some((r) => !text.includes(r));
      const hitsExclude = excludes.some((e) => text.includes(e));
      const hide = failsRequires || hitsExclude;

      if (hide) {
        el.style.display = "none";
        el.dataset.tmOpsHidden = "1";
      } else if (el.dataset.tmOpsHidden === "1") {
        el.style.display = "";
        delete el.dataset.tmOpsHidden;
      }
    }
  }

  const mo = new MutationObserver(() => applyOpsFilter());
  mo.observe(findResultsRoot(), { childList: true, subtree: true });

  // Intercept API fetch
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string") {
        const patched = patchItemsSearchUrl(input);
        if (patched.patched) input = patched.url;
      } else if (input instanceof Request) {
        const patched = patchItemsSearchUrl(input.url);
        if (patched.patched) input = new Request(patched.url, input);
      }
    } catch (e) {
      log("fetch patch error", e);
    }

    return _fetch.call(this, input, init).finally(() => {
      requestAnimationFrame(applyOpsFilter);
    });
  };

  // Intercept XHR as well just to be safe.
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === "string") {
        const patched = patchItemsSearchUrl(url);
        if (patched.patched) url = patched.url;
      }
    } catch (e) {
      log("xhr patch error", e);
    }
    return _open.call(this, method, url, ...rest);
  };

  // Initial pass in case results already exist
  applyOpsFilter();
})();