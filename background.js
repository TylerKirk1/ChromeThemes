const DEFAULT_SETTINGS = {
  selectedThemeId: 'serika-dark',
  blend: 0.9,
  applyScope: 'global',
  favorites: ['serika-dark', 'nord', 'dracula'],
  perHostThemes: {},
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const next = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) {
      next[key] = value;
    }
  }

  if (Object.keys(next).length > 0) {
    await chrome.storage.sync.set(next);
  }
});
