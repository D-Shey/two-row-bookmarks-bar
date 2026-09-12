import { DEFAULTS, getSettings, setSettings } from '../background/settings.js';

const $ = (sel) => document.querySelector(sel);

const CHECKBOXES = ['enabled', 'autoHide', 'hideOnFullscreen', 'showOther', 'newTabDark', 'wheelScroll'];
const SELECTS = ['layout', 'theme', 'labels'];
const RANGES = {
  rows: '',
  rowHeight: ' px',
  fontSize: ' px',
  maxItemWidth: ' px'
};

function localize() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const msg = chrome.i18n.getMessage(node.dataset.i18n);
    if (msg) node.textContent = msg;
  }
}

let savedTimer = null;
function flashSaved() {
  const el = $('#saved');
  el.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.hidden = true; }, 1200);
}

function paint(settings) {
  for (const id of CHECKBOXES) $('#' + id).checked = !!settings[id];
  for (const id of SELECTS) $('#' + id).value = settings[id];
  for (const [id, unit] of Object.entries(RANGES)) {
    $('#' + id).value = settings[id];
    $('#' + id + 'Out').textContent = settings[id] + unit;
  }
  $('#blocklist').value = (settings.blocklist || []).join('\n');
}

async function save(patch) {
  await setSettings(patch);
  flashSaved();
}

async function main() {
  localize();
  paint(await getSettings());

  for (const id of CHECKBOXES) {
    $('#' + id).addEventListener('change', (ev) => save({ [id]: ev.target.checked }));
  }

  for (const id of SELECTS) {
    $('#' + id).addEventListener('change', (ev) => save({ [id]: ev.target.value }));
  }

  for (const [id, unit] of Object.entries(RANGES)) {
    const input = $('#' + id);
    input.addEventListener('input', () => { $('#' + id + 'Out').textContent = input.value + unit; });
    input.addEventListener('change', () => save({ [id]: Number(input.value) }));
  }

  let blocklistTimer = null;
  $('#blocklist').addEventListener('input', (ev) => {
    clearTimeout(blocklistTimer);
    blocklistTimer = setTimeout(() => {
      const list = ev.target.value
        .split('\n')
        .map((line) => line.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(Boolean);
      save({ blocklist: [...new Set(list)] });
    }, 500);
  });

  $('#reset').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'resetSettings' });
    paint({ ...DEFAULTS });
    flashSaved();
  });

  // Keep the page in step with changes made from the popup or the bar itself.
  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area === 'sync') paint(await getSettings());
  });
}

main();
