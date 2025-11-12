const DEFAULT_THEME_ID = "serika-dark";
const DEFAULT_BLEND = 0.9;

const state = {
  catalog: [],
  host: null,
  normalizedHost: null,
  scope: "global",
  settings: null,
  favoritesOnly: false,
  search: "",
  currentThemeId: DEFAULT_THEME_ID,
  currentBlend: DEFAULT_BLEND,
};

const dom = {
  sitePill: document.getElementById("sitePill"),
  scopeInputs: document.querySelectorAll('input[name="scope"]'),
  siteScopeOption: document.getElementById("siteScopeOption"),
  clearSiteBtn: document.getElementById("clearSiteTheme"),
  blendSlider: document.getElementById("blendSlider"),
  blendValue: document.getElementById("blendValue"),
  searchInput: document.getElementById("themeSearch"),
  favoritesOnly: document.getElementById("favoritesOnly"),
  themeGrid: document.getElementById("themeGrid"),
  emptyState: document.getElementById("emptyState"),
  template: document.getElementById("themeCardTemplate"),
};

const normalizeHost = (host) => (host || "").toLowerCase().replace(/^www\./, "");

async function loadCatalog() {
  const res = await fetch(chrome.runtime.getURL("themes/catalog.json"));
  return res.json();
}

async function getActiveTabHost() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  try {
    const url = new URL(tab?.url ?? "");
    if (url.protocol === "chrome:" || url.protocol === "edge:" || url.hostname === "chrome.google.com") {
      return null;
    }
    return url.hostname;
  } catch {
    return null;
  }
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({
    selectedThemeId: DEFAULT_THEME_ID,
    blend: DEFAULT_BLEND,
    applyScope: "global",
    perHostThemes: {},
    favorites: [],
  });
  return stored;
}

function getActiveThemeId() {
  if (state.scope === "site" && state.normalizedHost) {
    return state.settings.perHostThemes?.[state.normalizedHost]?.themeId ?? state.settings.selectedThemeId;
  }
  return state.settings.selectedThemeId;
}

function getActiveBlend() {
  if (state.scope === "site" && state.normalizedHost) {
    return state.settings.perHostThemes?.[state.normalizedHost]?.blend ?? state.settings.blend;
  }
  return state.settings.blend;
}

function updateSitePill() {
  if (!state.host) {
    dom.sitePill.textContent = "Unavailable";
    dom.siteScopeOption.classList.add("disabled");
    dom.siteScopeOption.querySelector("input").disabled = true;
    dom.clearSiteBtn.disabled = true;
    return;
  }
  dom.sitePill.textContent = state.host;
  dom.siteScopeOption.classList.remove("disabled");
  dom.siteScopeOption.querySelector("input").disabled = false;
  const hasOverride = Boolean(state.settings.perHostThemes?.[state.normalizedHost]);
  dom.clearSiteBtn.disabled = !hasOverride;
}

function updateBlendUI() {
  dom.blendSlider.value = state.currentBlend.toFixed(2);
  dom.blendValue.textContent = `${Math.round(state.currentBlend * 100)}%`;
}

function updateScopeUI() {
  dom.scopeInputs.forEach((input) => {
    input.checked = input.value === state.scope;
  });
}

function filterCatalog() {
  const query = state.search.trim().toLowerCase();
  const favorites = new Set(state.settings.favorites ?? []);
  return state.catalog
    .filter((theme) => {
      if (state.favoritesOnly && !favorites.has(theme.id)) {
        return false;
      }
      if (!query) return true;
      return (
        theme.name.toLowerCase().includes(query) ||
        theme.id.toLowerCase().includes(query) ||
        theme.description.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const aFav = favorites.has(a.id) ? 1 : 0;
      const bFav = favorites.has(b.id) ? 1 : 0;
      if (aFav !== bFav) {
        return bFav - aFav;
      }
      return a.name.localeCompare(b.name);
    });
}

function renderThemes() {
  const favorites = new Set(state.settings.favorites ?? []);
  const filtered = filterCatalog();
  dom.themeGrid.replaceChildren();

  filtered.forEach((theme) => {
    const node = dom.template.content.firstElementChild.cloneNode(true);
    node.dataset.themeId = theme.id;
    node.querySelector(".theme-name").textContent = theme.name;
    node.querySelector(".theme-desc").textContent = theme.description;
    node.querySelector(".swatch.bg").style.background = theme.colors.background;
    node.querySelector(".swatch.surface").style.background = theme.colors.surface;
    node.querySelector(".swatch.accent").style.background = theme.colors.accent;
    const favBtn = node.querySelector(".favorite");
    if (favorites.has(theme.id)) {
      favBtn.classList.add("active");
      favBtn.querySelector("span").textContent = "★";
    } else {
      favBtn.querySelector("span").textContent = "☆";
    }
    favBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void toggleFavorite(theme.id, favBtn);
    });

    node.addEventListener("click", () => {
      void handleThemeSelection(theme.id);
    });

    if (state.currentThemeId === theme.id) {
      node.classList.add("active");
    }

    dom.themeGrid.appendChild(node);
  });

  dom.emptyState.hidden = filtered.length > 0;
}

async function toggleFavorite(themeId, button) {
  const favorites = new Set(state.settings.favorites ?? []);
  if (favorites.has(themeId)) {
    favorites.delete(themeId);
  } else {
    favorites.add(themeId);
  }
  state.settings.favorites = Array.from(favorites);
  await chrome.storage.sync.set({ favorites: state.settings.favorites });
  button.classList.toggle("active", favorites.has(themeId));
  button.querySelector("span").textContent = favorites.has(themeId) ? "★" : "☆";
  renderThemes();
}

async function handleThemeSelection(themeId) {
  const updates = {};
  if (state.scope === "site" && state.normalizedHost) {
    const perHost = { ...(state.settings.perHostThemes ?? {}) };
    perHost[state.normalizedHost] = {
      themeId,
      blend: state.currentBlend,
    };
    updates.perHostThemes = perHost;
  } else {
    updates.selectedThemeId = themeId;
  }
  updates.applyScope = state.scope;
  await chrome.storage.sync.set(updates);
  state.settings = {
    ...state.settings,
    ...updates,
    perHostThemes: updates.perHostThemes ?? state.settings.perHostThemes,
  };
  state.currentThemeId = themeId;
  updateSitePill();
  renderThemes();
  await notifyActiveTab(themeId, state.currentBlend);
}

async function notifyActiveTab(themeId, blend) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "MONKEY_APPLY_THEME",
      themeId,
      blend,
    });
  } catch {
    // likely a restricted page, ignore
  }
}

async function updateBlend(value) {
  state.currentBlend = Number(value);
  updateBlendUI();
  if (state.scope === "site" && state.normalizedHost) {
    const perHost = { ...(state.settings.perHostThemes ?? {}) };
    const current = perHost[state.normalizedHost] ?? {
      themeId: state.currentThemeId,
    };
    perHost[state.normalizedHost] = {
      ...current,
      blend: state.currentBlend,
    };
    state.settings.perHostThemes = perHost;
    await chrome.storage.sync.set({ perHostThemes: perHost });
  } else {
    state.settings.blend = state.currentBlend;
    await chrome.storage.sync.set({ blend: state.currentBlend });
  }
  await notifyActiveTab(state.currentThemeId, state.currentBlend);
}

async function handleScopeChange(value) {
  if (value === "site" && !state.host) {
    updateScopeUI();
    return;
  }
  state.scope = value;
  state.settings.applyScope = value;
  await chrome.storage.sync.set({ applyScope: value });
  state.currentThemeId = getActiveThemeId();
  state.currentBlend = getActiveBlend();
  updateBlendUI();
  updateScopeUI();
  updateSitePill();
  renderThemes();
  await notifyActiveTab(state.currentThemeId, state.currentBlend);
}

async function clearSiteOverride() {
  if (!state.normalizedHost) return;
  const perHost = { ...(state.settings.perHostThemes ?? {}) };
  delete perHost[state.normalizedHost];
  state.settings.perHostThemes = perHost;
  await chrome.storage.sync.set({ perHostThemes: perHost });
  state.currentThemeId = getActiveThemeId();
  state.currentBlend = getActiveBlend();
  updateSitePill();
  updateBlendUI();
  renderThemes();
  await notifyActiveTab(state.currentThemeId, state.currentBlend);
}

function bindControls() {
  dom.scopeInputs.forEach((input) => {
    input.addEventListener("change", (event) => {
      void handleScopeChange(event.target.value);
    });
  });
  dom.clearSiteBtn.addEventListener("click", () => {
    void clearSiteOverride();
  });
  dom.blendSlider.addEventListener("input", (event) => {
    void updateBlend(event.target.value);
  });
  dom.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderThemes();
  });
  dom.favoritesOnly.addEventListener("change", (event) => {
    state.favoritesOnly = event.target.checked;
    renderThemes();
  });
}

async function init() {
  const [catalog, host, settings] = await Promise.all([
    loadCatalog(),
    getActiveTabHost(),
    loadSettings(),
  ]);
  state.catalog = catalog;
  state.host = host;
  state.normalizedHost = normalizeHost(host);
  state.settings = settings;
  const desiredScope = settings.applyScope === "site" && host ? "site" : "global";
  state.scope = desiredScope;
  state.currentThemeId = getActiveThemeId();
  state.currentBlend = getActiveBlend();
  state.search = "";
  state.favoritesOnly = false;

  bindControls();
  updateScopeUI();
  updateBlendUI();
  updateSitePill();
  renderThemes();
}

void init();
