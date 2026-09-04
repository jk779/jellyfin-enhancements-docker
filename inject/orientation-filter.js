(() => {
  "use strict";

  const INIT_KEY = "__jf_orientation_filter_v1";
  const STORAGE_KEY = "tm_jf_orientation_filter_v1";
  const CONTROL_CLASS = "tm-orientation-filter";
  const HIDDEN_CLASS = "tm-orientation-hidden";

  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  let activeFilter = loadFilter();
  let refreshScheduled = false;

  function loadFilter() {
    try {
      const value = sessionStorage.getItem(STORAGE_KEY);
      return ["all", "horizontal", "vertical"].includes(value)
        ? value
        : "all";
    } catch {
      return "all";
    }
  }

  function saveFilter() {
    try {
      sessionStorage.setItem(STORAGE_KEY, activeFilter);
    } catch {}
  }

  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .${CONTROL_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: .45em;
        margin-left: .35em;
        margin-right: .35em;
        white-space: nowrap;
      }

      .${CONTROL_CLASS} select {
        min-height: 2.2em;
        max-width: 12em;
        padding: .25em .65em;
        border: 2px solid rgb(41, 41, 41);
        border-radius: 3px;
        background: rgb(41, 41, 41);
        color: rgba(255, 255, 255, .8);
        font: inherit;
        cursor: pointer;
      }

      .${CONTROL_CLASS} select:focus-visible {
        outline: 2px solid currentColor;
        outline-offset: 2px;
      }

      .${CONTROL_CLASS} option {
        color: #111;
        background: #fff;
      }

      #searchPage .${CONTROL_CLASS} {
        display: flex;
        margin: .35em 0 .7em;
        padding: 0 3.1%;
      }

      .${HIDDEN_CLASS} {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function createControl() {
    const wrapper = document.createElement("label");
    wrapper.className = CONTROL_CLASS;
    wrapper.setAttribute("data-tm-orientation-filter", "true");

    const select = document.createElement("select");
    select.className = "tm-orientation-select";
    select.setAttribute("aria-label", "Filter videos: horizontal and vertical");

    for (const [value, text] of [
      ["all", "Horz + Vert"],
      ["horizontal", "Horizontal"],
      ["vertical", "Vertical"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }

    select.value = activeFilter;
    select.addEventListener("change", () => {
      activeFilter = select.value;
      saveFilter();
      applyFilter();
      syncControls();
    });

    wrapper.append(select);
    return wrapper;
  }

  function syncControls() {
    document.querySelectorAll(`.${CONTROL_CLASS} select`).forEach(select => {
      if (select.value !== activeFilter) select.value = activeFilter;
    });
  }

  function isVisible(element) {
    return !!element && (
      element.offsetWidth > 0 ||
      element.offsetHeight > 0 ||
      element.getClientRects().length > 0
    );
  }

  function getLibraryMount() {
    const page = document.querySelector(".libraryPage:not(.hide)");
    if (!page) return null;

    const toolbar = [...page.querySelectorAll("button.btnFilter")]
      .find(isVisible)
      ?.closest(".itemsViewSettingsContainer");

    return toolbar || null;
  }

  function getSearchVideoSection() {
    return [...document.querySelectorAll("#searchPage .verticalSection")]
      .find(section => section.querySelector('.card[data-type="Video"], .card[data-mediatype="Video"]')) || null;
  }

  function mountControls() {
    const libraryMount = getLibraryMount();
    if (libraryMount && !libraryMount.querySelector(`.${CONTROL_CLASS}`)) {
      libraryMount.appendChild(createControl());
    }

    const searchSection = getSearchVideoSection();
    if (searchSection && !searchSection.querySelector(`.${CONTROL_CLASS}`)) {
      const title = searchSection.querySelector(".sectionTitle");
      const control = createControl();

      if (title) title.insertAdjacentElement("afterend", control);
      else searchSection.insertBefore(control, searchSection.firstChild);
    }
  }

  function getVideoCards() {
    const cards = [];

    const libraryPage = document.querySelector(".libraryPage:not(.hide)");
    if (libraryPage) {
      cards.push(...libraryPage.querySelectorAll('.card[data-type="Video"], .card[data-mediatype="Video"]'));
    }

    const searchSection = getSearchVideoSection();
    if (searchSection) {
      cards.push(...searchSection.querySelectorAll('.card[data-type="Video"], .card[data-mediatype="Video"]'));
    }

    return [...new Set(cards)];
  }

  function cardOrientation(card) {
    const badge = card.querySelector(".orientation-badge");
    if (!badge) return null;
    if (badge.classList.contains("horz")) return "horizontal";
    if (badge.classList.contains("vert")) return "vertical";
    if (badge.classList.contains("square")) return "square";
    return null;
  }

  function applyFilter() {
    const cards = getVideoCards();

    for (const card of cards) {
      const orientation = cardOrientation(card);
      const hide = activeFilter !== "all" && orientation && orientation !== activeFilter;
      card.classList.toggle(HIDDEN_CLASS, !!hide);
    }
  }

  function refresh() {
    refreshScheduled = false;
    mountControls();
    syncControls();
    applyFilter();
  }

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(refresh);
  }

  addStyles();

  new MutationObserver(scheduleRefresh).observe(document.body, {
    childList: true,
    subtree: true
  });

  scheduleRefresh();
})();
