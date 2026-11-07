// Fetches cross-origin stylesheets for the content script. Pages can't read
// CSS rules from other origins, but the extension can fetch the file itself.
const cache = new Map();
const MAX_BYTES = 4_000_000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fetch-css" || !/^https?:/.test(message.url)) return;
  let pending = cache.get(message.url);
  if (!pending) {
    pending = fetch(message.url, { credentials: "omit" })
      .then((res) => (res.ok ? res.text() : ""))
      .then((text) => (text.length > MAX_BYTES ? "" : text))
      .catch(() => "");
    cache.set(message.url, pending);
  }
  pending.then((text) => sendResponse({ text }));
  return true; // respond asynchronously
});
