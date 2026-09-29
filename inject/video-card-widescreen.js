(() => {
  "use strict";

  const INIT_KEY = "__tm_video_card_widescreen_v1";
  const CARD_SELECTOR = ".card[data-type], .card[data-mediatype]";
  const SQUARE_CARD_CLASS = "squareCard";
  const BACKDROP_CARD_CLASS = "backdropCard";
  const SQUARE_PADDER_CLASS = "cardPadder-square";
  const BACKDROP_PADDER_CLASS = "cardPadder-backdrop";

  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  function isEligibleVideoCard(card) {
    if (!card?.matches?.(".card")) return false;

    const types = [card.dataset.type, card.dataset.mediatype];
    const isVideo = types.some(type => String(type || "").toLowerCase() === "video");
    const isFolder = String(card.dataset.isfolder || "").toLowerCase() === "true";

    return isVideo && !isFolder;
  }

  function updateCard(card) {
    if (!isEligibleVideoCard(card)) return;

    if (card.classList.contains(SQUARE_CARD_CLASS)) {
      card.classList.replace(SQUARE_CARD_CLASS, BACKDROP_CARD_CLASS);
    }

    card.querySelectorAll(`.${SQUARE_PADDER_CLASS}`).forEach(padder => {
      padder.classList.replace(SQUARE_PADDER_CLASS, BACKDROP_PADDER_CLASS);
    });
  }

  function refresh(root = document) {
    if (root.matches?.(".card")) updateCard(root);
    root.querySelectorAll?.(CARD_SELECTOR).forEach(updateCard);
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

  refresh();

  if (window.MutationObserver && document.body) {
    new MutationObserver(scheduleRefresh).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
})();
