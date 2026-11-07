// The theming engine: maps a page's own colors onto a theme.
//
// Instead of painting over the page, it reads the site's stylesheets and emits
// a parallel stylesheet with the same selectors where every color is remapped:
// backgrounds land near the theme background, text near the theme text, and
// colorful elements keep their hue (or take the theme accent) at a readable
// lightness. Only colors change, so layout can never break.

(() => {
  const { parse, format, toLch, fromLch, mixLab, contrast } = globalThis.CTColor;

  const KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "currentcolor", "transparent", "none", "auto"]);
  const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]*\)|\b[a-z]+\b/gi;

  const ROLES = ["bg", "fg", "border"];

  /** Which mapping a property's colors get. Custom properties get all three (see below). */
  function roleOf(prop) {
    if (prop === "color" || prop === "caret-color" || prop === "fill" || prop === "stroke" || prop === "-webkit-text-fill-color") return "fg";
    if (prop === "background-color" || prop === "background-image") return "bg";
    if (prop.endsWith("-color") && /^(border|outline|column-rule|text-decoration|text-emphasis)/.test(prop)) return "border";
    if (prop.startsWith("--")) return "var";
    return null;
  }

  // CSS variables: a variable like --brand can be used as a background in one
  // place and as text in another, so its role can't be known where it's
  // defined. Instead each color variable gets three remapped twins
  // (--ct-bg--brand, --ct-fg--brand, --ct-border--brand), and every *use* is
  // rewritten by the property using it: background-color: var(--brand) becomes
  // var(--ct-bg--brand, var(--brand)). The fallback keeps non-color variables
  // (e.g. "255" channel values) working untouched.
  const twin = (role, name) => `--ct-${role}${name}`;

  function createEngine() {
    let theme = null; // prepared palette
    let pageIsDark = false;
    let paperL = 1; // OKLab lightness of the site's own page background
    const cache = new Map();

    // Which variables are used in which role. Twins are only emitted for those,
    // which keeps the output small on sites that ship CSS for many themes.
    const used = new Map();
    let usageVersion = 0;
    let sawVarDefs = false;
    function markUsed(name, role) {
      let roles = used.get(name);
      if (!roles) used.set(name, (roles = new Set()));
      if (!roles.has(role)) {
        roles.add(role);
        usageVersion++;
      }
    }

    function setTheme(colors, options = {}) {
      const bg = parse(colors.bg), text = parse(colors.text), accent = parse(colors.accent);
      const B = toLch(bg), T = toLch(text), A = toLch(accent);
      // Text must reach 4.5:1 against a slightly raised surface (cards, sidebars),
      // or as close as the theme's own text gets there.
      const surface = mixLab(bg, text, 0.1);
      const minContrast = Math.min(4.5, contrast(surface, text));
      theme = { bg, text, accent, B, T, A, dark: B.L < T.L, useAccent: options.accentMode !== "site", surface, minContrast };
      cache.clear();
    }

    /** Moves a text color toward the theme's text color until it is readable on theme surfaces. */
    function ensureReadable(c) {
      let out = c;
      for (let t = 0.15; contrast(out, theme.surface) < theme.minContrast - 0.01 && t <= 1.001; t += 0.15) {
        out = mixLab(c, theme.text, Math.min(1, t), c.a);
      }
      return out;
    }

    /** Tells the engine the site's own page background, so it maps exactly onto the theme background. */
    function setPagePaper(color) {
      const L = color ? toLch(color).L : 1;
      if (Math.abs(L - paperL) > 0.001) cache.clear();
      paperL = L;
      pageIsDark = L < 0.5;
    }

    const lerp = (a, b, t) => a + (b - a) * t;

    /** Hue/chroma for a colorful source color: its own, or the theme accent's. */
    function tint(c) {
      if (!theme.useAccent) return { C: c.C, H: c.H };
      return { C: Math.max(theme.A.C * Math.min(1, c.C / 0.12), 0.04), H: theme.A.H };
    }

    // `edge` is 0 for the site's own page color (and for pure black/white) and
    // grows toward 1 for colors far from it: how "raised" a surface is. Used to
    // keep the site's hierarchy of panels, cards and footers.
    const edgeOf = (L) => {
      const fromPaper = Math.abs(L - paperL) / 0.4;
      const fromExtreme = L > 0.6 ? (1 - L) / 0.4 : L / 0.6;
      return Math.min(fromPaper, fromExtreme);
    };

    function mapColor(c, role) {
      const lch = toLch(c);
      const chromatic = lch.C > 0.045 && lch.L > 0.08 && lch.L < 0.97;
      const { B, T } = theme;

      // Translucent overlays (hover tints, dividers) work relative to the page:
      // a black 8% overlay darkens a light page, so on a dark theme it should
      // lighten. Map by "ink-ness" against the page's own polarity.
      if (!chromatic && c.a < 0.6 && role !== "fg") {
        const ink = pageIsDark ? lch.L : 1 - lch.L;
        return mixLab(theme.bg, theme.text, ink, c.a);
      }

      if (role === "bg") {
        const edge = Math.min(1, edgeOf(lch.L));
        if (!chromatic) return mixLab(theme.bg, theme.text, edge * 0.3, c.a);
        const { C, H } = tint(lch);
        const L = lerp(B.L, T.L, 0.06 + 0.16 * Math.min(1, edge * 1.3));
        return fromLch(L, C * (0.55 + 0.45 * Math.min(1, edge * 1.5)), H, c.a);
      }

      if (role === "border") {
        const edge = Math.min(1, edgeOf(lch.L));
        if (!chromatic) return mixLab(theme.bg, theme.text, 0.16 + edge * 0.22, c.a);
        const { C, H } = tint(lch);
        return fromLch(lerp(B.L, T.L, 0.55), C, H, c.a);
      }

      // Foreground: strong text stays strong, grey text stays muted but legible.
      if (!chromatic) {
        const muted = lch.L > 0.5 ? 1 - lch.L : lch.L;
        return ensureReadable(mixLab(theme.text, theme.bg, Math.min(0.26, muted * 0.6), c.a));
      }
      const { C, H } = tint(lch);
      return ensureReadable(fromLch(lerp(T.L, B.L, 0.14), Math.min(C, 0.2), H, c.a));
    }

    function mapToken(token, role) {
      const key = role + token;
      let out = cache.get(key);
      if (out !== undefined) return out;
      const lower = token.toLowerCase();
      const c = KEYWORDS.has(lower) ? null : parse(token);
      out = !c || c.a === 0 ? token : format(mapColor(c, role));
      cache.set(key, out);
      return out;
    }

    const mapLiteral = (text, role) => text.replace(COLOR_TOKEN, (t) => mapToken(t, role));

    // Tailwind v3 and others write "rgb(255 255 255 / var(--tw-bg-opacity))":
    // a literal color whose alpha comes from a variable.
    const ALPHA_VAR = /\b(rgba?|hsla?)\(([^()]*?)[\s,/]+(var\([^()]*\))\s*\)/gi;

    /** Remaps colors in a value and points var() references at their twins for `role`. */
    function mapValue(value, role) {
      if (!value.includes("var(")) return mapLiteral(value, role);
      const kept = [];
      value = value.replace(ALPHA_VAR, (match, fn, channels, alphaVar) => {
        const c = channels.includes("var(") ? null : parse(`${fn.replace(/a$/i, "")}(${channels})`);
        if (!c) return match;
        const m = mapColor({ ...c, a: 1 }, role);
        kept.push(`rgb(${Math.round(m.r * 255)} ${Math.round(m.g * 255)} ${Math.round(m.b * 255)} / ${alphaVar})`);
        return `\u0001${kept.length - 1}\u0001`;
      });
      return mapVars(value, role).replace(/\u0001(\d+)\u0001/g, (_, i) => kept[i]);
    }

    function mapVars(value, role) {
      let out = "";
      let i = 0;
      for (;;) {
        const start = value.indexOf("var(", i);
        if (start < 0) return out + mapLiteral(value.slice(i), role);
        out += mapLiteral(value.slice(i, start), role);
        let depth = 0;
        let end = start + 3;
        for (; end < value.length; end++) {
          if (value[end] === "(") depth++;
          else if (value[end] === ")" && --depth === 0) break;
        }
        const inner = value.slice(start + 4, end);
        const comma = inner.indexOf(",");
        const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
        const fallback = comma < 0 ? "" : "," + mapVars(inner.slice(comma + 1), role);
        markUsed(name, role);
        out += `var(${twin(role, name)}, var(${name}${fallback}))`;
        i = end + 1;
      }
    }

    const hasColor = (value) => {
      COLOR_TOKEN.lastIndex = 0;
      for (const m of value.matchAll(COLOR_TOKEN)) if (mapToken(m[0], "fg") !== m[0]) return true;
      return false;
    };

    /**
     * Returns the remapped declarations for one property as "prop:value" strings,
     * or null when the property isn't color-related or nothing needs to change.
     */
    function mapDeclaration(prop, value) {
      const role = roleOf(prop);
      if (!role) return null;
      if (role !== "var") {
        if (role === "bg" && /url\(/i.test(value)) return null; // background images: leave alone
        return [`${prop}:${mapValue(value, role)}`];
      }
      sawVarDefs = true;
      const roles = used.get(prop);
      if (!roles || /shadow/i.test(prop) || (!value.includes("var(") && !hasColor(value))) return null;
      return ROLES.filter((r) => roles.has(r)).map((r) => `${twin(r, prop)}:${mapValue(value, r)}`);
    }

    // ── Stylesheets ───────────────────────────────────────────────────────

    /** Shorthands that can carry a longhand's color, most specific first. */
    function shorthandsFor(prop) {
      if (prop === "background-color") return ["background"];
      if (prop === "outline-color") return ["outline"];
      if (prop === "text-decoration-color") return ["text-decoration"];
      if (prop === "column-rule-color") return ["column-rule"];
      const side = /^border-(.+)-color$/.exec(prop)?.[1];
      return side ? [`border-${side}`, "border-color", "border"] : [];
    }

    /** Picks the color out of a shorthand like "1px solid var(--line)". */
    function colorPart(value) {
      const vars = [];
      for (let i = value.indexOf("var("); i >= 0; i = value.indexOf("var(", i + 1)) {
        let depth = 0, end = i + 3;
        for (; end < value.length; end++) {
          if (value[end] === "(") depth++;
          else if (value[end] === ")" && --depth === 0) break;
        }
        vars.push(value.slice(i, end + 1));
        i = end;
      }
      const literal = value.replace(/var\((?:[^()]|\([^()]*\))*\)/g, " ").match(COLOR_TOKEN)?.find((t) => parse(t));
      if (literal) return literal;
      if (vars.length <= 1) return vars[0] ?? null;
      return vars.find((v) => /color|bg|background|border|fg|text|line|fill|stroke|surface|canvas/i.test(v)) ?? vars[vars.length - 1];
    }

    function declarations(style) {
      let out = "";
      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        if (!roleOf(prop)) continue;
        let value = style.getPropertyValue(prop);
        if (!value) {
          // Longhands of a shorthand that uses var() read as empty until the
          // page is rendered; recover the color from the shorthand instead.
          for (const sh of shorthandsFor(prop)) {
            const v = style.getPropertyValue(sh);
            if (v) {
              value = colorPart(v);
              break;
            }
          }
        }
        if (!value) continue;
        const important = style.getPropertyPriority(prop) ? " !important" : "";
        // Keyword values (inherit, transparent…) come through unchanged; they're
        // still copied so the cascade between the site's own rules keeps its order.
        const mapped = mapDeclaration(prop, value);
        if (mapped) for (const decl of mapped) out += `${decl}${important};`;
      }
      return out;
    }

    /**
     * "@media …", "@supports …" etc. Built from the rule's fields: reading
     * rule.cssText would serialize every rule inside the block, which is very
     * slow on sites with large media blocks.
     */
    function groupHeader(rule) {
      if (rule instanceof CSSMediaRule) return `@media ${rule.media.mediaText}`;
      if (rule instanceof CSSSupportsRule) return `@supports ${rule.conditionText}`;
      if (typeof CSSLayerBlockRule !== "undefined" && rule instanceof CSSLayerBlockRule) return `@layer ${rule.name}`;
      if (typeof CSSContainerRule !== "undefined" && rule instanceof CSSContainerRule) return `@container ${rule.conditionText}`;
      const text = rule.cssText;
      return text.slice(0, text.indexOf("{"));
    }

    function rulesToCss(rules) {
      let out = "";
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          const body = declarations(rule.style);
          if (body) out += `${rule.selectorText}{${body}}`;
        } else if (rule instanceof CSSImportRule) {
          try {
            if (rule.styleSheet) out += wrapMedia(rulesToCss(rule.styleSheet.cssRules), rule.media?.mediaText);
          } catch {
            /* cross-origin import: skipped */
          }
        } else if (typeof CSSGroupingRule !== "undefined" && rule instanceof CSSGroupingRule) {
          const inner = rulesToCss(rule.cssRules);
          if (inner) out += `${groupHeader(rule)}{${inner}}`;
        }
      }
      return out;
    }

    const wrapMedia = (css, media) => (css && media && media !== "all" ? `@media ${media}{${css}}` : css);

    /** Returns the override CSS for a sheet, and whether it defines variables (whose output depends on usage). */
    function sheetToCss(sheet) {
      sawVarDefs = false;
      const css = wrapMedia(rulesToCss(sheet.cssRules), sheet.media?.mediaText);
      return { css, hasVars: sawVarDefs };
    }

    /** CSS that always applies: page canvas, default text, links, selection, controls. */
    function baseCss() {
      const { bg, text, accent } = theme;
      const link = mapColor({ ...accent, a: 1 }, "fg");
      const visited = mixLab(link, text, 0.35);
      const selection = mixLab(theme.bg, accent, 0.45);
      const thumb = mixLab(theme.bg, text, 0.28);
      return `
:root { color-scheme: ${theme.dark ? "dark" : "light"} !important; }
html { background-color: ${format(bg)} !important; color: ${format(text)}; scrollbar-color: ${format(thumb)} ${format(bg)}; }
:where(a:link) { color: ${format(link)}; }
:where(a:visited) { color: ${format(visited)}; }
::selection { background-color: ${format(selection)} !important; color: ${format(text)} !important; }
`;
    }

    return { setTheme, setPagePaper, mapDeclaration, sheetToCss, baseCss, usageVersion: () => usageVersion };
  }

  globalThis.CTEngine = { createEngine, roleOf };
})();
