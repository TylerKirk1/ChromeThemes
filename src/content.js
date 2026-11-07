// Content script: applies the engine to the page and keeps it in sync.

(() => {
  if (window.__chromeThemes) return;
  window.__chromeThemes = true;

  const engine = CTEngine.createEngine();
  const host = location.hostname.replace(/^www\./, "");

  const BASE_ID = "chrome-themes-base";
  const OVERRIDE_ID = "chrome-themes-overrides";
  let active = false;
  let baseEl, overrideEl;

  // Per-sheet cache: re-processing thousands of rules on every change is slow,
  // so reuse the previous result while a sheet's rule count is unchanged.
  let sheetCache = new WeakMap();
  const remoteSheets = new Map(); // href -> CSSStyleSheet built from fetched text (cross-origin)
  const pendingFetches = new Set();

  // ── Settings ──────────────────────────────────────────────────────────

  const DEFAULTS = { enabled: true, theme: null, accentMode: "theme", disabledSites: [], siteThemes: {} };

  function resolve(s) {
    const on = s.enabled && s.theme && !s.disabledSites.includes(host);
    return on ? { colors: s.siteThemes[host] ?? s.theme, accentMode: s.accentMode } : null;
  }

  // ── Injection ─────────────────────────────────────────────────────────

  function styleEl(id) {
    const el = document.createElement("style");
    el.id = id;
    return el;
  }

  /** Our overrides must come after every site stylesheet, so they live at the very end of <html>. */
  function keepLast() {
    const root = document.documentElement;
    if (!root) return;
    if (baseEl.parentNode !== root) root.prepend(baseEl);
    if (root.lastElementChild !== overrideEl) root.append(overrideEl);
  }

  // ── Stylesheets ───────────────────────────────────────────────────────

  function cssForSheet(sheet) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin stylesheet without CORS: fetch its text through the background worker.
      const href = sheet.href;
      if (!href) return "";
      const remote = remoteSheets.get(href);
      if (remote) return cachedCss(remote, remote.cssRules.length, sheet.media?.mediaText);
      if (!pendingFetches.has(href)) {
        pendingFetches.add(href);
        chrome.runtime
          .sendMessage({ type: "fetch-css", url: href })
          .then((res) => {
            if (!res?.text) return;
            const built = new CSSStyleSheet();
            built.replaceSync(res.text.replace(/@import[^;]+;/g, ""));
            remoteSheets.set(href, built);
            schedule();
          })
          .catch(() => {});
      }
      return "";
    }
    return cachedCss(sheet, rules.length);
  }

  /**
   * A sheet's output stays valid while its rule count is unchanged, unless it
   * defines variables and the set of used variables has grown since.
   */
  function cachedCss(sheet, count, media) {
    const version = engine.usageVersion();
    const cached = sheetCache.get(sheet);
    if (cached && cached.count === count && (!cached.hasVars || cached.version === version)) return cached.css;
    let { css, hasVars } = engine.sheetToCss(sheet);
    if (css && media && media !== "all") css = `@media ${media}{${css}}`;
    sheetCache.set(sheet, { count, css, hasVars, version: engine.usageVersion() });
    return css;
  }

  function collectSheets() {
    const sheets = [];
    for (const sheet of document.styleSheets) {
      const owner = sheet.ownerNode;
      if (owner === baseEl || owner === overrideEl || sheet.disabled) continue;
      sheets.push(sheet);
    }
    sheets.push(...(document.adoptedStyleSheets ?? []));
    return sheets;
  }

  let inlineVersion = -1;
  function rebuildOverrides() {
    // A sheet processed early may define variables that a later sheet turns
    // out to use, so repeat until no new variable uses appear.
    const t0 = performance.now();
    let css = "";
    for (let pass = 0; pass < 4; pass++) {
      const before = engine.usageVersion();
      css = collectSheets().map(cssForSheet).join("\n");
      if (engine.usageVersion() === before) break;
    }
    if (overrideEl.textContent !== css) overrideEl.textContent = css;
    keepLast();
    // Slowest rebuild so far, visible in DevTools.
    overrideEl.dataset.ms = String(Math.max(Number(overrideEl.dataset.ms ?? 0), Math.round(performance.now() - t0)));
    if (inlineVersion !== engine.usageVersion() && document.body) {
      inlineVersion = engine.usageVersion();
      themeElementsIn(document.documentElement); // inline variables may now need twins
    }
  }

  // ── Inline styles and legacy color attributes ────────────────────────

  const INLINE_PROPS = new Set(["color", "background-color", "background-image", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke"]);
  // element -> { prop: { orig, priority, seen, twins } }. `seen` is the value as
  // the browser serializes it after our write (e.g. "rgb(…)", not "#…"), so our
  // own writes are recognised and not themed a second time.
  const touched = new Map();

  function themeInline(el) {
    const style = el.style;
    if (!style || !style.length) return;
    const props = [];
    for (let i = 0; i < style.length; i++) {
      const p = style[i];
      if (INLINE_PROPS.has(p) || (p.startsWith("--") && !p.startsWith("--ct-"))) props.push(p);
    }
    if (!props.length) return;
    const record = touched.get(el) ?? {};
    for (const prop of props) {
      const value = style.getPropertyValue(prop);
      const prev = record[prop];
      if (prev?.seen === value && (!prev.twins || prev.version === engine.usageVersion())) continue;
      const decls = engine.mapDeclaration(prop, value);
      if (!decls) continue;
      const priority = style.getPropertyPriority(prop);
      if (prop.startsWith("--")) {
        // Variables keep their value; their remapped twins sit next to them.
        const twins = decls.map((d) => {
          const at = d.indexOf(":");
          style.setProperty(d.slice(0, at), d.slice(at + 1), priority);
          return d.slice(0, at);
        });
        record[prop] = { seen: value, twins, version: engine.usageVersion() };
      } else {
        const mapped = decls[0].slice(decls[0].indexOf(":") + 1);
        if (mapped === value) continue;
        style.setProperty(prop, mapped, priority);
        record[prop] = { orig: value, priority, seen: style.getPropertyValue(prop) };
      }
    }
    touched.set(el, record);
    if (touched.size > 3000) for (const e of touched.keys()) if (!e.isConnected) touched.delete(e);
  }

  function themeLegacyAttributes(el) {
    if (el.hasAttribute("bgcolor") && !el.style.backgroundColor) el.style.backgroundColor = el.getAttribute("bgcolor");
    if (el.tagName === "FONT" && el.hasAttribute("color") && !el.style.color) el.style.color = el.getAttribute("color");
    themeInline(el);
  }

  function themeElementsIn(root) {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute("style") || root.hasAttribute("bgcolor") || root.tagName === "FONT") themeLegacyAttributes(root);
    for (const el of root.querySelectorAll("[style], [bgcolor], font[color]")) themeLegacyAttributes(el);
  }

  function restoreInline() {
    for (const [el, record] of touched) {
      for (const [prop, r] of Object.entries(record)) {
        if (r.twins) r.twins.forEach((t) => el.style.removeProperty(t));
        else if (el.style.getPropertyValue(prop) === r.seen) el.style.setProperty(prop, r.orig, r.priority);
      }
    }
    touched.clear();
  }

  // ── Page polarity ─────────────────────────────────────────────────────

  /** The site's own page background, read with our styles switched off (null = browser default white). */
  function detectPagePaper() {
    if (!document.body) return null;
    const ours = [baseEl.sheet, overrideEl.sheet].filter(Boolean);
    ours.forEach((s) => (s.disabled = true));
    const pick = (el) => CTColor.parse(getComputedStyle(el).backgroundColor);
    let c = pick(document.body);
    if (!c || c.a < 0.5) c = pick(document.documentElement);
    ours.forEach((s) => (s.disabled = false));
    return c && c.a >= 0.5 ? c : null;
  }

  // ── Scheduling and observation ────────────────────────────────────────

  let timer = 0;
  function schedule(delay = 30) {
    if (!active || timer) return;
    timer = setTimeout(() => {
      timer = 0;
      if (active) rebuildOverrides();
    }, delay);
  }

  const observer = new MutationObserver((mutations) => {
    let sheetsChanged = false;
    for (const m of mutations) {
      if (m.type === "attributes") {
        themeLegacyAttributes(m.target);
        continue;
      }
      const target = m.target;
      if (target.nodeName === "STYLE" || target.nodeName === "LINK") sheetsChanged = true;
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.nodeName === "STYLE" || node.nodeName === "LINK") sheetsChanged = true;
        else themeElementsIn(node);
      }
      for (const node of m.removedNodes) if (node.nodeName === "STYLE" || node.nodeName === "LINK") sheetsChanged = true;
    }
    if (sheetsChanged) schedule();
    else if (document.documentElement.lastElementChild !== overrideEl) keepLast();
  });

  const onSheetEvent = () => schedule(60);
  const onLoad = (e) => {
    if (e.target?.nodeName === "LINK") schedule();
  };

  let polarityChecked = false;
  function onReady() {
    if (!active) return;
    if (!polarityChecked) {
      polarityChecked = true;
      engine.setPagePaper(detectPagePaper());
      sheetCache = new WeakMap();
    }
    rebuildOverrides();
    themeElementsIn(document.documentElement);
  }

  function start(config) {
    engine.setTheme(config.colors, { accentMode: config.accentMode });
    sheetCache = new WeakMap();
    if (!active) {
      active = true;
      baseEl ||= styleEl(BASE_ID);
      overrideEl ||= styleEl(OVERRIDE_ID);
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "bgcolor"] });
      document.addEventListener("chrome-themes:sheets", onSheetEvent);
      document.addEventListener("load", onLoad, true);
    }
    baseEl.textContent = engine.baseCss();
    if (document.documentElement) keepLast();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady, { once: true });
    else {
      restoreInline();
      onReady();
    }
  }

  function stop() {
    if (!active) return;
    active = false;
    observer.disconnect();
    document.removeEventListener("chrome-themes:sheets", onSheetEvent);
    document.removeEventListener("load", onLoad, true);
    clearTimeout(timer);
    timer = 0;
    baseEl?.remove();
    overrideEl?.remove();
    restoreInline();
  }

  function apply(settings) {
    const config = resolve({ ...DEFAULTS, ...settings });
    if (config) start(config);
    else stop();
  }

  chrome.storage.sync.get(DEFAULTS).then(apply);
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "sync") chrome.storage.sync.get(DEFAULTS).then(apply);
  });
})();
