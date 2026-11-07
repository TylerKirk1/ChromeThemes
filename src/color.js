// Color parsing and OKLab math. Shared by the content script and the popup.
// Colors are { r, g, b, a } with r/g/b in 0..1 (sRGB) and a in 0..1.

(() => {
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  // ── Parsing ─────────────────────────────────────────────────────────────

  const num = (s, scale = 1) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s));
  const alpha = (s) => (s === undefined ? 1 : clamp01(num(s, 1)));
  const hue = (s) => {
    if (s === "none") return 0;
    if (s.endsWith("turn")) return parseFloat(s) * 360;
    if (s.endsWith("rad")) return (parseFloat(s) * 180) / Math.PI;
    return parseFloat(s);
  };

  /** Splits "a b c / d" or "a, b, c, d" into [a, b, c, d?]. */
  function args(inner) {
    const [main, slashAlpha] = inner.split("/");
    const parts = main.trim().split(/[\s,]+/).filter(Boolean);
    if (slashAlpha !== undefined) parts[3] = slashAlpha.trim();
    return parts;
  }

  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }

  let probe;
  const probeCache = new Map();
  /** Named colors, system colors, lab(), color() etc.: let the browser normalize them. */
  function parseViaCanvas(str) {
    if (probeCache.has(str)) return probeCache.get(str);
    probe ||= document.createElement("canvas").getContext("2d");
    let out = null;
    if (probe) {
      probe.fillStyle = "#010203";
      probe.fillStyle = str;
      const v = probe.fillStyle;
      if (v !== "#010203" || str.toLowerCase() === "#010203") out = v.startsWith("#") || v.startsWith("rgb") ? parse(v, false) : null;
    }
    probeCache.set(str, out);
    return out;
  }

  /** Parses a CSS color; returns null for anything it can't read reliably. */
  function parse(input, allowProbe = true) {
    const c = parseRaw(input, allowProbe);
    return c && [c.r, c.g, c.b, c.a].every(Number.isFinite) ? c : null;
  }

  function parseRaw(input, allowProbe) {
    const str = input.trim().toLowerCase();
    if (str[0] === "#") {
      const h = str.slice(1);
      if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
      const full = h.length < 5 ? [...h].map((c) => c + c).join("") : h;
      const v = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
      return { r: v(0), g: v(2), b: v(4), a: full.length === 8 ? v(6) : 1 };
    }
    const m = /^([a-z]+)\((.*)\)$/.exec(str);
    if (m) {
      const [, fn, inner] = m;
      if (inner.includes("var(") || inner.includes("calc(") || inner.includes("from ")) return null;
      const p = args(inner);
      if (fn === "rgb" || fn === "rgba") {
        if (p.length < 3) return null;
        const c = (s) => clamp01(s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s) / 255);
        return { r: c(p[0]), g: c(p[1]), b: c(p[2]), a: alpha(p[3]) };
      }
      if (fn === "hsl" || fn === "hsla") {
        if (p.length < 3) return null;
        const [r, g, b] = hslToRgb(hue(p[0]), clamp01(parseFloat(p[1]) / 100), clamp01(parseFloat(p[2]) / 100));
        return { r, g, b, a: alpha(p[3]) };
      }
      if (fn === "oklch" || fn === "oklab") {
        if (p.length < 3) return null;
        const L = num(p[0], 1);
        let a, b;
        if (fn === "oklch") {
          const C = num(p[1], 0.4);
          const H = (hue(p[2]) * Math.PI) / 180;
          a = C * Math.cos(H);
          b = C * Math.sin(H);
        } else {
          a = num(p[1], 0.4);
          b = num(p[2], 0.4);
        }
        return { ...fromOklab({ L, a, b }), a: alpha(p[3]) };
      }
    }
    if (!allowProbe || !/^[a-z]+$|^(lab|lch|color|hwb)\(/.test(str)) return null;
    return parseViaCanvas(str);
  }

  // ── OKLab ───────────────────────────────────────────────────────────────

  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function toOklab({ r, g, b }) {
    const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return {
      L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    };
  }

  function fromOklab({ L, a, b }) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return {
      r: clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
      g: clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
      b: clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
    };
  }

  const toLch = (c) => {
    const { L, a, b } = toOklab(c);
    return { L, C: Math.hypot(a, b), H: Math.atan2(b, a) };
  };

  /** Builds an sRGB color from OKLCH, reducing chroma until it fits the gamut. */
  function fromLch(L, C, H, alphaValue = 1) {
    if (!Number.isFinite(L) || !Number.isFinite(C) || !Number.isFinite(H)) return { r: 0.5, g: 0.5, b: 0.5, a: alphaValue };
    L = clamp01(L);
    for (let c = Math.max(0, C), i = 0; i < 60; c *= 0.9, i++) {
      const lab = { L, a: c * Math.cos(H), b: c * Math.sin(H) };
      const l = (L + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
      const m = (L - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
      const s = (L - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
      const lin = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
      ];
      if (c < 0.001 || lin.every((v) => v >= -0.001 && v <= 1.001)) return { ...fromOklab(lab), a: alphaValue };
    }
    return { ...fromOklab({ L, a: 0, b: 0 }), a: alphaValue };
  }

  function mixLab(x, y, t, alphaValue = 1) {
    const p = toOklab(x), q = toOklab(y);
    return { ...fromOklab({ L: p.L + (q.L - p.L) * t, a: p.a + (q.a - p.a) * t, b: p.b + (q.b - p.b) * t }), a: alphaValue };
  }

  function format({ r, g, b, a }) {
    const to255 = (v) => Math.round(clamp01(v) * 255);
    if (a >= 0.999) return "#" + [r, g, b].map((v) => to255(v).toString(16).padStart(2, "0")).join("");
    return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${Math.round(a * 1000) / 1000})`;
  }

  /** WCAG relative luminance and contrast ratio, used by the popup's preview checks. */
  const luminance = ({ r, g, b }) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  const contrast = (x, y) => {
    const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
  };

  globalThis.CTColor = { parse, format, toLch, fromLch, mixLab, contrast, luminance };
})();
