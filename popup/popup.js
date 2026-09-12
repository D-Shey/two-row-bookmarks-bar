import { getSettings, setSettings } from '../background/settings.js';

const $ = (sel) => document.querySelector(sel);

function localize() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const msg = chrome.i18n.getMessage(node.dataset.i18n);
    if (msg) node.textContent = msg;
  }
  document.title = chrome.i18n.getMessage('extName') || document.title;
}

function hostnameOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function main() {
  localize();

  const settings = await getSettings();
  const tab = await activeTab();
  const host = tab ? hostnameOf(tab.url) : null;

  $('#enabled').checked = settings.enabled;
  $('#enabled').addEventListener('change', async (ev) => {
    await setSettings({ enabled: ev.target.checked });
  });

  const rowButtons = [...document.querySelectorAll('#rows button')];
  const paintRows = (value) => {
    for (const b of rowButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.value) === value));
  };
  paintRows(settings.rows);
  for (const b of rowButtons) {
    b.addEventListener('click', async () => {
      const rows = Number(b.dataset.value);
      paintRows(rows);
      await setSettings({ rows });
    });
  }

  // Without the "tabs" permission a page we hold no host permission for (a
  // chrome:// tab, say) reports no URL — there is nothing to bookmark then.
  const addBtn = $('#add');
  if (!tab?.url) {
    addBtn.disabled = true;
    addBtn.style.opacity = '0.45';
  } else {
    addBtn.addEventListener('click', async () => {
      await chrome.bookmarks.create({ parentId: '1', title: tab.title || tab.url, url: tab.url });
      window.close();
    });
  }

  const hideBtn = $('#hideHere');
  if (!host) {
    hideBtn.disabled = true;
    hideBtn.style.opacity = '0.45';
  } else {
    const blocked = settings.blocklist.includes(host);
    hideBtn.setAttribute('aria-pressed', String(blocked));
    hideBtn.addEventListener('click', async () => {
      const current = (await getSettings()).blocklist;
      const next = current.includes(host)
        ? current.filter((h) => h !== host)
        : [...current, host];
      await setSettings({ blocklist: next });
      hideBtn.setAttribute('aria-pressed', String(next.includes(host)));
    });
  }

  $('#manager').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://bookmarks/' });
    window.close();
  });

  $('#options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

main();
