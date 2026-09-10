(() => {
  "use strict";

  const INIT_KEY = "__tm_video_card_titles_v1";
  const CARD_CLASS = "tm-video-card-title";
  const SECONDARY_CLASS = "tm-video-card-secondary";
  const TITLE_SELECTOR = ".cardText-first";

  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  function addStyles() {
    const style = document.createElement("style");

    style.textContent = `
      /* Keep video-card titles readable without changing Jellyfin metadata. */
      .${CARD_CLASS} .cardText-first {
        display: -webkit-box !important;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden !important;
        max-height: 2.8em;
        line-height: 1.4em;
        white-space: normal !important;
        text-overflow: clip !important;
      }

      .${CARD_CLASS} .${SECONDARY_CLASS},
      .${CARD_CLASS} .cardText-secondary {
        display: none !important;
      }

      /* Reserve the same two title lines on every video card in a grid. */
      .${CARD_CLASS} .cardText-first {
        min-height: 2.8em;
      }
    `;

    document.head.appendChild(style);
  }

  function isVideoCard(card) {
    if (!card || !card.matches(".card")) return false;

    const type = String(
      card.dataset.type || card.dataset.mediatype || ""
    ).toLowerCase();

    // Jellyfin's library and folder grids use either of these attributes.
    if (type === "video") return true;

    return false;
  }

  function applyToCard(card) {
    if (!isVideoCard(card)) return;
    const title = card.querySelector(TITLE_SELECTOR);
    if (!title) return;

    card.classList.add(CARD_CLASS);

    // Jellyfin 12 renders the year as a sibling .cardText block rather than
    // consistently using .cardText-secondary. Keep the title block visible,
    // and mark the other text blocks for the scoped CSS rule above.
    const titleBlock = title.closest(".cardText");
    card.querySelectorAll(".cardText").forEach(block => {
      const isTitleBlock = block === titleBlock || block.contains(title);
      block.classList.toggle(SECONDARY_CLASS, !isTitleBlock);
    });
  }

  function refresh(root = document) {
    if (root.matches?.(".card")) applyToCard(root);

    root.querySelectorAll?.(".card[data-type], .card[data-mediatype]")
      .forEach(applyToCard);
  }

  let refreshScheduled = false;

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;

    requestAnimationFrame(() => {
      refreshScheduled = false;
      refresh();
    });
  }

  addStyles();

  new MutationObserver(scheduleRefresh).observe(document.body, {
    childList: true,
    subtree: true,
  });

  refresh();
})();
