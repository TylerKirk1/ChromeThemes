// Runs in the page's own JavaScript world. CSS-in-JS libraries add rules with
// insertRule()/replaceSync(), which don't change the DOM, so a MutationObserver
// can't see them. Wrap those methods and tell the content script.
(() => {
  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      document.dispatchEvent(new CustomEvent("chrome-themes:sheets"));
    });
  };
  const wrap = (proto, name) => {
    const original = proto[name];
    if (typeof original !== "function") return;
    proto[name] = function (...args) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
  };
  for (const name of ["insertRule", "deleteRule", "replace", "replaceSync"]) wrap(CSSStyleSheet.prototype, name);

  const adopted = Object.getOwnPropertyDescriptor(Document.prototype, "adoptedStyleSheets");
  if (adopted?.set) {
    Object.defineProperty(Document.prototype, "adoptedStyleSheets", {
      ...adopted,
      set(value) {
        adopted.set.call(this, value);
        notify();
      }
    });
  }
})();
