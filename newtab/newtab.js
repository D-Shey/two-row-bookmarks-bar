/* The page itself does almost nothing: content/content.js draws the bar exactly
   as it does inside a web page. All this has to do is name the tab and decide
   whether the page is pinned dark or follows the theme.
   It must run before content.js, which reads __dbbThemeOverride. */

document.title = chrome.i18n.getMessage('newTabTitle') || 'New Tab';

function apply({ theme, newTabDark }) {
  const root = document.documentElement;

  if (newTabDark) {
    // Dark backdrop and a dark bar, whatever the theme setting says.
    root.setAttribute('data-ntp-dark', '');
    window.__dbbThemeOverride = 'dark';
  } else {
    root.removeAttribute('data-ntp-dark');
    window.__dbbThemeOverride = null;
  }

  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  // The bar may already be on screen; make it pick the change up.
  window.__dbbRefreshTheme?.();
}

const DEFAULTS = { theme: 'auto', newTabDark: true };

chrome.storage.sync.get(DEFAULTS).then(apply);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!changes.theme && !changes.newTabDark) return;
  chrome.storage.sync.get(DEFAULTS).then(apply);
});

// Chrome puts the caret in the address bar when a new tab opens; never steal it.
window.addEventListener('load', () => {
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
});
