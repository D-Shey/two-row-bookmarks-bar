// Shared settings contract. Imported by the service worker, the popup and the
// options page; the content script receives a resolved copy over messaging.

export const DEFAULTS = Object.freeze({
  enabled: true,
  rows: 2,                 // 1..4 — two is the whole point of this extension
  layout: 'push',          // 'push' | 'overlay'
  autoHide: false,         // reveal only when the pointer touches the top edge
  theme: 'auto',           // 'auto' | 'light' | 'dark'
  fontSize: 12,            // px, matches Chrome's own bar
  rowHeight: 28,           // px per row, matches Chrome's own bar
  maxItemWidth: 180,       // px, same cap Chrome puts on a bookmark button
  labels: 'always',        // 'always' | 'folders' | 'never'
  showOther: true,         // the right-aligned "Other bookmarks" button
  hideOnFullscreen: true,
  newTabDark: true,        // new tab page stays dark whatever the theme says
  wheelScroll: true,       // wheel over the bar scrolls hidden rows into view
  blocklist: []            // hostnames the bar never shows on
});

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  // storage.sync returns defaults for missing keys, but guard against a stale
  // schema left over from an older version.
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}

export async function resetSettings() {
  await chrome.storage.sync.clear();
  return { ...DEFAULTS };
}
