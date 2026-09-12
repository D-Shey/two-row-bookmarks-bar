# Chrome Web Store listing — copy for the dashboard

Everything below is ready to paste. English is the listing language; the
extension's own name and short description are also served from `_locales`, so a
Russian-language user sees Russian ones automatically.

---

## Name

```
Double Bookmarks Bar
```

## Short description (97 / 132)

```
A pixel-faithful replica of Chrome's bookmarks bar rendered in two rows, with the same behaviour.
```

## Category

Productivity → Tools

## Detailed description

```
If you keep more bookmarks than fit across one row, half of them end up hidden behind the » button. This extension shows your bookmarks bar in two rows — or three, or four, whichever you prefer.

It is built to be indistinguishable from the bar Chrome already gives you. Colours, row height, font size, icon size and corner radius were matched against the real bar by measuring pixels, in both the light and the dark theme.

WHAT YOU GET

• Two to four rows, with anything that still does not fit collected under the » button
• Scroll the bar with the mouse wheel — point at it and the hidden rows come into view, one row per notch
• Folders with drop-down menus and nested submenus
• Real site icons, taken from the browser's own cache — nothing is fetched from the network
• The full context menu: open in a new tab, new window or Incognito, edit, rename, cut, copy, paste, delete, add page, add folder, bookmark manager
• Drag and drop, both along the bar and inside the menus, including dropping a bookmark into a folder
• Undo after a delete — a whole folder comes back with everything inside it
• An "All bookmarks" button on the right, matching current Chrome
• Bookmarks with no title show as a single icon, exactly as the built-in bar does
• Light and dark themes; row height, font size, titles and maximum width are adjustable
• A list of sites where the bar never appears
• English and Russian interface, following your browser's language

THE NEW TAB PAGE

Extensions are not allowed to run on chrome://newtab, so the only way to show the bar there is to replace that page. This extension does, with a deliberately empty page: a dark backdrop and the bookmarks bar, nothing else. No search box, no sponsored tiles, and your default search engine is never touched. If you would rather keep Chrome's own new tab, the page can be left dark or theme-following in the settings — and disabling the extension restores it entirely.

BEFORE YOU START

Hide Chrome's built-in bookmarks bar with Ctrl+Shift+B, otherwise you will have two bars at once.

HONEST LIMITATIONS

• The bar cannot appear on Chrome's own pages — settings, history, the Web Store, other extensions' pages. Extensions are not permitted to run there.
• Bookmarklets (javascript: bookmarks) do not work. Manifest V3 forbids extensions from executing arbitrary code on a page.
• In "push page content down" mode, a site with its own sticky header pinned to the top of the window will draw it underneath the bar. Switch that site to "float above the page", or add it to the exception list.

PRIVACY

The extension collects nothing, stores nothing remotely and makes no network requests at all. It reads and changes your bookmarks only when you ask it to, through Chrome's own bookmarks API. Settings live in Chrome's sync storage, which means your own Google account and nowhere else. There is no analytics, no advertising and no third-party code.
```

---

## Privacy tab

### Single purpose

```
Show the browser's bookmarks bar in more than one row, keeping the look and behaviour of the built-in bar.
```

### Permission justifications

**bookmarks**

```
The extension is a bookmarks bar and nothing else. It reads the bookmark tree in order to draw the bar, and changes it when the user renames, edits, deletes, adds or drags a bookmark using the bar's own menus.
```

**storage**

```
Stores the user's settings for the bar — number of rows, theme, row height, font size, list of excluded sites — and the clipboard used by the bar's own cut/copy/paste commands for bookmarks.
```

**favicon**

```
Draws each bookmark's site icon next to it, the way the built-in bookmarks bar does. Icons come from the browser's local favicon cache; no network request is made.
```

**host permission (`<all_urls>`)**

```
The bookmarks bar has to be visible on every page the user opens, exactly like the built-in one. The extension does not read or modify page content: it appends one element of its own inside a closed shadow root and offsets the page by the height of the bar. No page data is collected, stored or transmitted.
```

**chrome_url_overrides / new tab page**

```
Extensions cannot run on chrome://newtab, so replacing that page is the only way to show the bookmarks bar there. The replacement page is intentionally empty — a backdrop and the bookmarks bar. It contains no search box, no advertising, and does not alter the user's default search engine.
```

### Data usage

Declare **no** data collection in every category, then tick all three certifications:

- the extension does not sell or transfer user data to third parties beyond approved use cases
- the extension does not use or transfer user data for purposes unrelated to its single purpose
- the extension does not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

Published from `PRIVACY.md` as a public gist — paste this:

```
https://gist.github.com/D-Shey/9c24bb190ccb2e293346d56b75acba29
```

---

## Assets in this folder

| File | Size | Use |
|---|---|---|
| `screenshot-1-bar.png` | 1280×800 | the bar on an ordinary page |
| `screenshot-2-menus.png` | 1280×800 | folder menu with a nested submenu |
| `screenshot-3-context-menu.png` | 1280×800 | the full context menu |
| `screenshot-4-settings.png` | 1280×800 | the settings page |
| `screenshot-5-new-tab.png` | 1280×800 | the new tab page |
| `promo-tile-440x280.png` | 440×280 | small promo tile |

All of them were taken on a synthetic demo bookmark set, not on anyone's real
bookmarks.
