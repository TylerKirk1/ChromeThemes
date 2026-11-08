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

  const DEFAULTS = { enabled: true, theme: null, accentMode: "theme", disabledSites: [], siteThemes: {}, effects: { glass: "off", ombre: false } };

  function resolve(s) {
    const on = s.enabled && s.theme && !s.disabledSites.includes(host);
    return on ? { colors: s.siteThemes[host] ?? s.theme, accentMode: s.accentMode, effects: s.effects } : null;
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

  // ── Glass buttons (beta) ──────────────────────────────────────────────

  const GLASS_SEL = 'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], a[class*="btn" i], a[class*="button" i]';
  const SVG_ID = "chrome-themes-svg";
  const glassQueue = new Set();
  let glassTimer = 0;

  function queueGlass(root) {
    if (!engine.glassMode() || root.nodeType !== 1) return;
    if (root.matches(GLASS_SEL)) glassQueue.add(root);
    for (const el of root.querySelectorAll(GLASS_SEL)) glassQueue.add(el);
    if (glassQueue.size && !glassTimer) glassTimer = setTimeout(flushGlass, 120);
  }

  /** Picks the candidates that look like real, labelled buttons. Reads layout, so it runs batched. */
  function flushGlass() {
    glassTimer = 0;
    const candidates = [...glassQueue];
    glassQueue.clear();
    if (!active || !engine.glassMode()) return;
    for (const el of candidates) {
      if (!el.isConnected || el.hasAttribute("data-ct-glass") || el.parentElement?.closest("[data-ct-glass]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 32 || r.height < 20 || r.height > 72 || r.width > 420) continue; // icons, cards, full-width bars
      const label = el.tagName === "INPUT" ? el.value : el.textContent;
      if (!label?.trim()) continue; // icon-only buttons look worse as glass
      const cs = getComputedStyle(el);
      if (/url\(/.test(cs.backgroundImage)) continue;
      const fill = CTColor.parse(cs.backgroundColor);
      const border = parseFloat(cs.borderTopWidth) > 0 && (CTColor.parse(cs.borderTopColor)?.a ?? 0) > 0.1;
      if (!(fill && fill.a > 0.08) && !border) continue; // plain text links styled as buttons stay as they are
      el.setAttribute("data-ct-glass", "");
    }
  }

  function clearGlass() {
    for (const el of document.querySelectorAll("[data-ct-glass]")) {
      el.removeAttribute("data-ct-glass");
      el.style.removeProperty("--ct-gx");
      el.style.removeProperty("--ct-gy");
    }
  }

  /** A displacement map for a rounded lens: content behind is pulled inward near the edges. */
  function lensMap() {
    const n = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = ((x + 0.5) / n) * 2 - 1;
        const v = ((y + 0.5) / n) * 2 - 1;
        const edge = 1 - Math.max(Math.abs(u), Math.abs(v)); // 0 at the rim, 1 in the middle
        const s = Math.max(0, 1 - edge / 0.5) ** 2;
        const i = (y * n + x) * 4;
        img.data[i] = 128 - u * s * 127;
        img.data[i + 1] = 128 - v * s * 127;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }

  /** The SVG filter used by "Liquid" glass (Chrome supports SVG filters in backdrop-filter). */
  function ensureLiquidFilter(on) {
    const existing = document.getElementById(SVG_ID);
    if (!on) return existing?.remove();
    if (existing || !document.documentElement) return;
    const ns = "http://www.w3.org/2000/svg";
    const make = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const svg = make("svg", { id: SVG_ID, width: "0", height: "0", "aria-hidden": "true", style: "position:absolute;width:0;height:0;pointer-events:none" });
    const filter = make("filter", { id: "ct-liquid", x: "0", y: "0", width: "1", height: "1", primitiveUnits: "objectBoundingBox", "color-interpolation-filters": "sRGB" });
    filter.append(
      make("feImage", { href: lensMap(), x: "0", y: "0", width: "1", height: "1", preserveAspectRatio: "none", result: "lens" }),
      make("feDisplacementMap", { in: "SourceGraphic", in2: "lens", scale: "0.18", xChannelSelector: "R", yChannelSelector: "G" })
    );
    svg.append(filter);
    document.documentElement.insertBefore(svg, overrideEl.parentNode === document.documentElement ? overrideEl : null);
  }

  // The highlight follows the cursor across a glass button.
  let pointerFrame = 0;
  let lastPointer = null;
  function onPointerMove(e) {
    lastPointer = e;
    if (pointerFrame) return;
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      const button = lastPointer.target?.closest?.("[data-ct-glass]");
      if (!button) return;
      const r = button.getBoundingClientRect();
      button.style.setProperty("--ct-gx", `${(((lastPointer.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      button.style.setProperty("--ct-gy", `${(((lastPointer.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    });
  }

  function refreshGlass() {
    const mode = active ? engine.glassMode() : null;
    ensureLiquidFilter(mode === "liquid");
    if (!mode) {
      clearGlass();
      document.removeEventListener("pointermove", onPointerMove, true);
      return;
    }
    document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    queueGlass(document.documentElement);
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
        else {
          themeElementsIn(node);
          queueGlass(node);
        }
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
    refreshGlass();
  }

  function start(config) {
    engine.setTheme(config.colors, { accentMode: config.accentMode, effects: config.effects });
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
    refreshGlass();
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
