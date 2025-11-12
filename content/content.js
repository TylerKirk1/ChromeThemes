(() => {
  const STYLE_ID = "__monkey_universal_theme__";
  const DEFAULT_THEME_ID = "serika-dark";
  const DEFAULT_BLEND = 0.9;
  let catalogPromise;
  let lastApplied = { themeId: null, blend: null };
  let applyTimeout;

  const normalizeHost = (host) => (host || "").toLowerCase().replace(/^www\./, "");

  async function loadCatalog() {
    if (!catalogPromise) {
      catalogPromise = fetch(chrome.runtime.getURL("themes/catalog.json"))
        .then((res) => res.json())
        .then((items) => {
          const map = new Map();
          items.forEach((item) => map.set(item.id, item));
          return { list: items, map };
        })
        .catch((error) => {
          console.error("Monkeytype theme catalog failed to load", error);
          return { list: [], map: new Map() };
        });
    }
    return catalogPromise;
  }

  async function getTheme(themeId) {
    const catalog = await loadCatalog();
    if (catalog.map.size === 0) {
      return null;
    }
    if (themeId && catalog.map.has(themeId)) {
      return catalog.map.get(themeId);
    }
    return catalog.list[0];
  }

  async function getSettings() {
    const stored = await chrome.storage.sync.get({
      selectedThemeId: DEFAULT_THEME_ID,
      blend: DEFAULT_BLEND,
      applyScope: "global",
      perHostThemes: {},
    });
    return stored;
  }

  async function resolveThemeFromSettings() {
    const settings = await getSettings();
    const normalizedHost = normalizeHost(window.location.hostname);
    let themeId = settings.selectedThemeId || DEFAULT_THEME_ID;
    let blendValue = typeof settings.blend === "number" ? settings.blend : DEFAULT_BLEND;

    if (settings.applyScope === "site" && normalizedHost) {
      const siteRecord = settings.perHostThemes?.[normalizedHost];
      if (siteRecord) {
        themeId = siteRecord.themeId || themeId;
        if (typeof siteRecord.blend === "number") {
          blendValue = siteRecord.blend;
        }
      }
    }

    return { themeId, blend: blendValue };
  }

  function clampBlend(value) {
    if (Number.isFinite(value)) {
      return Math.min(1, Math.max(0.15, value));
    }
    return DEFAULT_BLEND;
  }

  function buildCss(theme, blendValue) {
    const blend = clampBlend(blendValue);
    const tone = theme.tone === "light" ? "light" : "dark";
    const overlay = `${Math.round(blend * 100)}%`;
    const surfaceOverlay = `${Math.min(100, Math.round((blend + 0.12) * 100))}%`;
    const cardOverlay = `${Math.min(100, Math.round((blend + 0.24) * 100))}%`;
    const shadowStrength = tone === "dark" ? 0.35 : 0.18;
    const overlayMode = tone === "light" ? "screen" : "multiply";
    const overlayAlpha =
      tone === "light"
        ? Math.min(0.45, blend + 0.1)
        : Math.max(0.35, Math.min(0.85, blend + 0.05));
    const accentVeil = tone === "light" ? 0.08 : 0.16;

    return `:root {
  --mut-bg: ${theme.colors.background};
  --mut-surface: ${theme.colors.surface};
  --mut-surface-alt: ${theme.colors.surfaceAlt};
  --mut-border: ${theme.colors.border};
  --mut-text: ${theme.colors.textPrimary};
  --mut-text-muted: ${theme.colors.textMuted};
  --mut-accent: ${theme.colors.accent};
  --mut-accent-soft: ${theme.colors.accentSoft};
  --mut-overlay: ${overlay};
  --mut-surface-overlay: ${surfaceOverlay};
  --mut-card-overlay: ${cardOverlay};
  --mut-shadow-strength: ${shadowStrength};
  --mut-overlay-mode: ${overlayMode};
  --mut-overlay-alpha: ${overlayAlpha};
  --mut-accent-veil: ${accentVeil};
  color-scheme: ${tone};
}

html {
  background-color: var(--mut-bg);
}

body {
  background-color: color-mix(in srgb, var(--mut-bg) var(--mut-overlay), transparent) !important;
  color: var(--mut-text) !important;
  position: relative;
  isolation: isolate;
}

body::before,
body::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147482000;
}

body::before {
  background: var(--mut-bg);
  mix-blend-mode: var(--mut-overlay-mode);
  opacity: var(--mut-overlay-alpha);
}

body::after {
  background: radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--mut-accent-soft) 70%, transparent) 0%, transparent 55%);
  mix-blend-mode: soft-light;
  opacity: var(--mut-accent-veil);
}

main,
section,
article,
nav,
aside,
header,
footer,
:where([role="main"], [role="article"], [role="region"], [role="dialog"], [role="complementary"]) {
  background-color: color-mix(in srgb, var(--mut-surface) var(--mut-surface-overlay), transparent) !important;
  color: var(--mut-text) !important;
  border-color: color-mix(in srgb, var(--mut-border) 80%, transparent) !important;
  border-radius: 0.8rem;
}

#rcnt,
#search,
:where(div[class*="card"], section[class*="card"], article[class*="card"], div[class*="Card"], section[class*="Card"], article[class*="Card"], div[class*="panel"], section[class*="panel"], article[class*="panel"], div[class*="Panel"], section[class*="Panel"], article[class*="Panel"], div[class*="module"], section[class*="module"], article[class*="module"], div[class*="Module"], section[class*="Module"], article[class*="Module"], div[class*="surface"], section[class*="surface"], article[class*="surface"], div[class*="Surface"], section[class*="Surface"], article[class*="Surface"]) {
  background-color: color-mix(in srgb, var(--mut-surface-alt) var(--mut-card-overlay), transparent) !important;
  color: var(--mut-text) !important;
  border-color: color-mix(in srgb, var(--mut-border) 75%, transparent) !important;
  box-shadow: 0 10px 24px rgba(0, 0, 0, var(--mut-shadow-strength));
  border-radius: 0.8rem;
}

#search :where(.g, .MjjYud, .kvH3mc, .tF2Cxc, .ZINbbc, .hlcw0c, .xpd, .X7NTVe, .Ww4FFb) {
  background-color: color-mix(in srgb, var(--mut-surface-alt) var(--mut-card-overlay), transparent) !important;
  border-radius: 0.9rem;
  border: 1px solid color-mix(in srgb, var(--mut-border) 70%, transparent) !important;
  padding: 0.65rem !important;
}

#search :where(.g, .MjjYud, .kvH3mc, .tF2Cxc, .ZINbbc, .hlcw0c, .xpd, .X7NTVe, .Ww4FFb) a {
  background-color: transparent !important;
}

.RNNXgb,
.emcav {
  background: color-mix(in srgb, var(--mut-surface) 70%, transparent) !important;
  border: 1px solid color-mix(in srgb, var(--mut-border) 60%, transparent) !important;
  box-shadow: none !important;
}

.RNNXgb input,
.gLFyf {
  background: transparent !important;
  box-shadow: none !important;
}

p,
span,
li,
label,
summary,
strong,
em,
small {
  color: var(--mut-text) !important;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  color: var(--mut-text) !important;
}

a,
a * {
  color: var(--mut-accent) !important;
}

a:hover,
a:focus {
  color: var(--mut-accent-soft) !important;
}

button,
input,
select,
textarea {
  background-color: color-mix(in srgb, var(--mut-surface) var(--mut-surface-overlay), transparent) !important;
  color: var(--mut-text) !important;
  border: 1px solid color-mix(in srgb, var(--mut-border) 70%, transparent) !important;
  border-radius: 6px !important;
  box-shadow: 0 1px 2px rgba(0, 0, 0, var(--mut-shadow-strength));
}

button:hover,
input:hover,
select:hover,
textarea:hover {
  border-color: var(--mut-accent) !important;
}

::selection {
  background: var(--mut-accent);
  color: var(--mut-bg);
}

::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: color-mix(in srgb, var(--mut-surface) 60%, transparent);
}

::-webkit-scrollbar-thumb {
  background: var(--mut-accent-soft);
  border-radius: 999px;
}

img,
video,
canvas,
iframe {
  filter: none !important;
}
`;
  }

  function injectStyles(cssText) {
    let styleTag = document.getElementById(STYLE_ID);
    if (!styleTag) {
      styleTag = document.createElement("style");
      styleTag.id = STYLE_ID;
      document.documentElement.appendChild(styleTag);
    }
    styleTag.textContent = cssText;
  }

  async function applyTheme(themeId, blendValue, force = false) {
    const theme = await getTheme(themeId || DEFAULT_THEME_ID);
    if (!theme) return;
    const blend = clampBlend(blendValue);

    if (!force && lastApplied.themeId === theme.id && Math.abs((lastApplied.blend || 0) - blend) < 0.01) {
      return;
    }

    injectStyles(buildCss(theme, blend));
    document.documentElement.dataset.monkeyTheme = theme.id;
    lastApplied = { themeId: theme.id, blend };
  }

  async function applyFromSettings(force = false) {
    const resolved = await resolveThemeFromSettings();
    await applyTheme(resolved.themeId, resolved.blend, force);
  }

  function scheduleApply(force = false) {
    clearTimeout(applyTimeout);
    applyTimeout = setTimeout(() => {
      void applyFromSettings(force);
    }, 50);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "MONKEY_APPLY_THEME") {
      scheduleApply(true);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (
      changes.selectedThemeId ||
      changes.perHostThemes ||
      changes.applyScope ||
      changes.blend
    ) {
      scheduleApply();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleApply();
    }
  });

  scheduleApply(true);
})();
