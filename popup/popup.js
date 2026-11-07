import { THEMES } from "./themes.js";

const DEFAULTS = {
  enabled: true,
  theme: null,
  custom: { id: "custom", name: "Custom", bg: "#24262b", text: "#e3e1da", accent: "#f0a64a" },
  accentMode: "theme",
  disabledSites: [],
  siteThemes: {}
};

const $ = (id) => document.getElementById(id);
let settings;
let host = null;

async function activeHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url ?? "");
    if (!/^https?:$|^file:$/.test(url.protocol) || /^(chrome|chromewebstore)\.google\.com$/.test(url.hostname)) return null;
    return url.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const save = (patch) => {
  settings = { ...settings, ...patch };
  return chrome.storage.sync.set(patch);
};

const pick = ({ id, name, bg, text, accent }) => ({ id, name, bg, text, accent });

/** The theme shown as selected: this site's own one if it has one, else the global one. */
const currentTheme = () => (host && settings.siteThemes[host]) || settings.theme;

async function chooseTheme(theme) {
  const t = pick(theme);
  if ($("siteOnly").checked && host) await save({ siteThemes: { ...settings.siteThemes, [host]: t } });
  else await save({ theme: t, enabled: true });
  render();
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderGrid() {
  const grid = $("grid");
  grid.replaceChildren();
  const selected = currentTheme()?.id;
  for (const theme of [...THEMES, settings.custom]) {
    const node = $("card").content.firstElementChild.cloneNode(true);
    node.querySelector(".card__swatch").style.background = theme.bg;
    node.querySelector(".card__aa").style.color = theme.text;
    node.querySelector(".card__dot").style.background = theme.accent;
    node.querySelector(".card__name").textContent = theme.name;
    node.title = theme.name;
    node.setAttribute("aria-pressed", String(theme.id === selected));
    node.addEventListener("click", () => chooseTheme(theme));
    grid.append(node);
  }
}

function renderCustom() {
  const isCustom = currentTheme()?.id === "custom";
  $("custom").hidden = !isCustom;
  if (!isCustom) return;
  const { bg, text, accent } = settings.custom;
  $("cBg").value = bg;
  $("cText").value = text;
  $("cAccent").value = accent;
  const ratio = CTColor.contrast(CTColor.parse(bg), CTColor.parse(text));
  $("contrastNote").textContent =
    ratio < 4.5 ? `Text contrast is ${ratio.toFixed(1)}:1. Aim for at least 4.5:1 so pages stay readable.` : `Text contrast ${ratio.toFixed(1)}:1`;
  $("contrastNote").classList.toggle("warn", ratio < 4.5);
}

function render() {
  $("enabled").checked = settings.enabled;
  document.body.classList.toggle("off", !settings.enabled);

  $("siteRow").hidden = !host;
  $("restricted").hidden = !!host;
  $("siteOnlyRow").hidden = !host;
  if (host) {
    $("host").textContent = host;
    $("siteEnabled").checked = !settings.disabledSites.includes(host);
    $("siteOnly").checked = !!settings.siteThemes[host];
  }
  for (const b of document.querySelectorAll("[data-accent]")) b.setAttribute("aria-checked", String(b.dataset.accent === settings.accentMode));
  renderGrid();
  renderCustom();
}

// ── Events ───────────────────────────────────────────────────────────────

$("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }).then(render));

$("siteEnabled").addEventListener("change", (e) => {
  const others = settings.disabledSites.filter((h) => h !== host);
  save({ disabledSites: e.target.checked ? others : [...others, host] }).then(render);
});

$("siteOnly").addEventListener("change", (e) => {
  const siteThemes = { ...settings.siteThemes };
  if (e.target.checked) siteThemes[host] = currentTheme() ?? pick(THEMES[0]);
  else delete siteThemes[host];
  save({ siteThemes }).then(render);
});

for (const b of document.querySelectorAll("[data-accent]")) {
  b.addEventListener("click", () => save({ accentMode: b.dataset.accent }).then(render));
}

// Custom colors apply live while dragging, but storage writes are throttled
// (chrome.storage.sync allows only a couple of writes per second).
let pendingCustom = 0;
for (const [id, key] of [["cBg", "bg"], ["cText", "text"], ["cAccent", "accent"]]) {
  $(id).addEventListener("input", (e) => {
    settings.custom = { ...settings.custom, [key]: e.target.value };
    renderCustom();
    clearTimeout(pendingCustom);
    pendingCustom = setTimeout(() => {
      const custom = settings.custom;
      const patch = { custom };
      if (host && settings.siteThemes[host]?.id === "custom") patch.siteThemes = { ...settings.siteThemes, [host]: custom };
      else patch.theme = custom;
      save(patch).then(renderGrid);
    }, 250);
  });
}

// ── Start ────────────────────────────────────────────────────────────────

[settings, host] = await Promise.all([chrome.storage.sync.get(DEFAULTS), activeHost()]);
render();
