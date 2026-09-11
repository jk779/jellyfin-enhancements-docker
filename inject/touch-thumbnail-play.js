// Jellyfin injected thumbnail playback enhancement:
// route video thumbnail clicks through Jellyfin's native resume/play action.
(() => {
  "use strict";

  const INIT_KEY = "__tm_jellyfin_touch_thumbnail_play_v2";
  const CARD_SELECTOR = '.card[data-type="Video"], .card[data-mediatype="Video"]';
  const THUMBNAIL_SELECTOR = "a.cardImageContainer";
  const LINK_ACTION = "link";
  const PLAY_ACTION = "resume";

  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  function isVideoCard(card) {
    if (!card?.matches?.(CARD_SELECTOR)) return false;
    return String(card.dataset.isfolder || "").toLowerCase() !== "true";
  }

  function updateThumbnail(card) {
    if (!isVideoCard(card)) return;

    const thumbnail = card.querySelector(THUMBNAIL_SELECTOR);
    if (!thumbnail || thumbnail.dataset.action !== LINK_ACTION) return;

    // Jellyfin's native shortcuts handler resolves the card from this
    // itemAction, reads data-positionticks, and delegates to playbackManager.
    // Keep the existing href as a fallback for clients without that handler.
    thumbnail.dataset.action = PLAY_ACTION;
  }

  function updateCards(root) {
    if (!(root instanceof Element)) return;

    const ownCard = root.matches(CARD_SELECTOR) ? root : root.closest(CARD_SELECTOR);
    if (ownCard) updateThumbnail(ownCard);

    root.querySelectorAll(CARD_SELECTOR).forEach(updateThumbnail);
  }

  document.querySelectorAll(CARD_SELECTOR).forEach(updateThumbnail);

  if (window.MutationObserver && document.documentElement) {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(updateCards);
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();
