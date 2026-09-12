// The content script has no access to chrome.bookmarks, chrome.tabs or
// chrome.windows, so everything it needs is proxied through here.

import { DEFAULTS, getSettings, setSettings, resetSettings } from './settings.js';

/* ------------------------------------------------------------------ *
 * Bookmarks API proxy
 * ------------------------------------------------------------------ */

// Only these are reachable from a page; nothing else in chrome.bookmarks is
// exposed to whatever happens to be running in the tab.
const BOOKMARK_METHODS = new Set([
  'get', 'getChildren', 'getSubTree', 'getTree', 'search',
  'create', 'update', 'move', 'remove', 'removeTree'
]);

async function bookmarksCall(method, args) {
  if (!BOOKMARK_METHODS.has(method)) throw new Error(`blocked method: ${method}`);
  return chrome.bookmarks[method](...args);
}

/* ------------------------------------------------------------------ *
 * Opening bookmarks
 * ------------------------------------------------------------------ */

// Chrome refuses to navigate to these from an extension; the real bar is
// equally unable to, so failing quietly matches the built-in behaviour.
function isOpenable(url) {
  if (!url) return false;
  return !/^(javascript|data):/i.test(url);
}

async function openUrl(url, where, senderTab) {
  if (!isOpenable(url)) return { ok: false, reason: 'unsupported-scheme' };
  const windowId = senderTab?.windowId;

  switch (where) {
    case 'current':
      if (senderTab) await chrome.tabs.update(senderTab.id, { url });
      else await chrome.tabs.create({ url });
      return { ok: true };

    case 'newTab':
      await chrome.tabs.create({
        url, windowId, active: true,
        index: senderTab ? senderTab.index + 1 : undefined
      });
      return { ok: true };

    case 'newTabBackground':
      await chrome.tabs.create({
        url, windowId, active: false,
        index: senderTab ? senderTab.index + 1 : undefined
      });
      return { ok: true };

    case 'newWindow':
      await chrome.windows.create({ url });
      return { ok: true };

    case 'incognito':
      try {
        await chrome.windows.create({ url, incognito: true });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'incognito-not-allowed' };
      }

    default:
      return { ok: false, reason: 'unknown-disposition' };
  }
}

async function openAll(urls, where, senderTab) {
  const list = urls.filter(isOpenable);
  if (!list.length) return { ok: true };

  if (where === 'newWindow' || where === 'incognito') {
    try {
      const win = await chrome.windows.create({
        url: list[0],
        incognito: where === 'incognito'
      });
      for (const url of list.slice(1)) {
        await chrome.tabs.create({ url, windowId: win.id, active: false });
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: 'incognito-not-allowed' };
    }
  }

  let index = senderTab ? senderTab.index + 1 : undefined;
  for (const url of list) {
    await chrome.tabs.create({
      url, windowId: senderTab?.windowId, active: false,
      index: index === undefined ? undefined : index++
    });
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Bookmark clipboard (cut / copy / paste) and undo
 * ------------------------------------------------------------------ */

// The real bar keeps a bookmark clipboard that survives across windows, so
// this lives in storage.local rather than a service-worker variable.
const CLIP_KEY = '__dbb_clipboard';

async function clipSet(mode, id) {
  const [node] = await chrome.bookmarks.getSubTree(id);
  await chrome.storage.local.set({ [CLIP_KEY]: { mode, node } });
  return { ok: true };
}

async function clipGet() {
  const data = await chrome.storage.local.get(CLIP_KEY);
  const clip = data[CLIP_KEY];
  return clip ? { mode: clip.mode, title: clip.node.title, isFolder: !clip.node.url } : null;
}

// Recreate a (possibly nested) node under parentId.
async function cloneInto(node, parentId, index) {
  const created = await chrome.bookmarks.create({
    parentId,
    index,
    title: node.title || '',
    url: node.url || undefined
  });
  for (const child of node.children || []) {
    await cloneInto(child, created.id, undefined);
  }
  return created;
}

async function clipPaste(parentId, index) {
  const data = await chrome.storage.local.get(CLIP_KEY);
  const clip = data[CLIP_KEY];
  if (!clip) return { ok: false, reason: 'empty' };

  if (clip.mode === 'cut') {
    // The node may be gone by now; fall back to recreating it.
    try {
      await chrome.bookmarks.get(clip.node.id);
      await chrome.bookmarks.move(clip.node.id, index === undefined ? { parentId } : { parentId, index });
      await chrome.storage.local.remove(CLIP_KEY);
      return { ok: true };
    } catch {
      // fall through to a copy
    }
  }

  await cloneInto(clip.node, parentId, index);
  if (clip.mode === 'cut') await chrome.storage.local.remove(CLIP_KEY);
  return { ok: true };
}

async function restoreNode(node, parentId, index) {
  await cloneInto(node, parentId, index);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Broadcasting bookmark changes to every open bar
 * ------------------------------------------------------------------ */

let broadcastTimer = null;

function scheduleBroadcast() {
  // Chrome fires a burst of events for a single drag; collapse them.
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'bookmarksChanged' }).catch(() => {
        // No content script in that tab (chrome://, Web Store, …) — expected.
      });
    }
    // tabs.sendMessage only reaches content scripts, so the bar on our own new
    // tab page (and the popup, if open) is notified over the runtime channel.
    chrome.runtime.sendMessage({ type: 'bookmarksChanged' }).catch(() => {});
  }, 40);
}

for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[event]?.addListener(scheduleBroadcast);
}

async function broadcastSettings(settings) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'settingsChanged', settings }).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: 'settingsChanged', settings }).catch(() => {});
}

chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== 'sync') return;
  broadcastSettings(await getSettings());
});

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

const HANDLERS = {
  async bookmarks({ method, args = [] }) {
    return bookmarksCall(method, args);
  },

  async open({ url, where }, sender) {
    return openUrl(url, where, sender.tab);
  },

  async openAll({ urls, where }, sender) {
    return openAll(urls, where, sender.tab);
  },

  async clipSet({ mode, id }) {
    return clipSet(mode, id);
  },

  async clipGet() {
    return clipGet();
  },

  async clipPaste({ parentId, index }) {
    return clipPaste(parentId, index);
  },

  async restore({ node, parentId, index }) {
    return restoreNode(node, parentId, index);
  },

  async openManager({ id }) {
    const url = id ? `chrome://bookmarks/?id=${encodeURIComponent(id)}` : 'chrome://bookmarks/';
    await chrome.tabs.create({ url });
    return { ok: true };
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },

  async getSettings() {
    return getSettings();
  },

  async setSettings({ patch }) {
    return setSettings(patch);
  },

  async resetSettings() {
    const settings = await resetSettings();
    broadcastSettings(settings);
    return settings;
  },

  // Used by the popup, which has no tab of its own to read.
  async activeTabInfo() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? { url: tab.url, title: tab.title } : null;
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;

  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: String(error?.message || error) })
  );
  return true; // keep the channel open for the async reply
});

/* ------------------------------------------------------------------ *
 * Keyboard shortcut + first run
 * ------------------------------------------------------------------ */

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-bar') return;
  const { enabled } = await getSettings();
  await setSettings({ enabled: !enabled });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  await chrome.storage.sync.set(DEFAULTS);
});
