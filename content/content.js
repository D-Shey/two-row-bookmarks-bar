/* Double Bookmarks Bar — the in-page replica of Chrome's bookmarks bar.
 *
 * Runs in the isolated world at document_start. Everything is rendered into a
 * closed shadow root so the page cannot see it, style it or script it.
 * chrome.bookmarks / tabs / windows are unreachable from here, so every such
 * call is proxied through the service worker.
 */

(() => {
  'use strict';

  if (window.__dbbInstalled) return;
  window.__dbbInstalled = true;

  /* ================================================================== *
   * Messaging
   * ================================================================== */

  async function send(msg) {
    let res;
    try {
      res = await chrome.runtime.sendMessage(msg);
    } catch (e) {
      throw new Error(`extension unavailable: ${e.message}`);
    }
    if (!res) throw new Error('no response from background');
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  // bm.getTree(), bm.move(id, dest), … → proxied chrome.bookmarks calls
  const bm = new Proxy({}, {
    get: (_t, method) => (...args) => send({ type: 'bookmarks', method, args })
  });

  const t = (key, fallback) => chrome.i18n.getMessage(key) || fallback || key;

  /* ================================================================== *
   * Icons (inline SVG so they follow currentColor)
   * ================================================================== */

  const SVGNS = 'http://www.w3.org/2000/svg';

  function svg(paths, { stroke = false, viewBox = '0 0 24 24', cls = 'icon' } = {}) {
    const el = document.createElementNS(SVGNS, 'svg');
    el.setAttribute('viewBox', viewBox);
    el.setAttribute('class', cls);
    el.setAttribute('aria-hidden', 'true');
    for (const d of [].concat(paths)) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      if (stroke) {
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', '2');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
      } else {
        p.setAttribute('fill', 'currentColor');
      }
      el.appendChild(p);
    }
    return el;
  }

  const ICON = {
    folder: () => svg('M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z'),
    chevrons: () => svg(['M4 6l5 6-5 6', 'M12 6l5 6-5 6'], { stroke: true }),
    arrow: (cls = 'arrow') => svg('M9 5l7 7-7 7', { stroke: true, cls }),
    check: (cls = 'icon') => svg('M5 13l4 4L19 7', { stroke: true, cls }),
    page: () => svg('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.2 0 2.6 2 3.1 5H8.9C9.4 6 10.8 4 12 4zM8.6 9h6.8a17 17 0 0 1 0 6H8.6a17 17 0 0 1 0-6zM6.6 9a19 19 0 0 0 0 6H4.3a8 8 0 0 1 0-6h2.3zm10.8 0h2.3a8 8 0 0 1 0 6h-2.3a19 19 0 0 0 0-6zM12 20c-1.2 0-2.6-2-3.1-5h6.2c-.5 3-1.9 5-3.1 5z')
  };

  function faviconURL(pageUrl, size = 32) {
    try {
      const u = new URL(chrome.runtime.getURL('/_favicon/'));
      u.searchParams.set('pageUrl', pageUrl);
      u.searchParams.set('size', String(size));
      return u.toString();
    } catch {
      return null;
    }
  }

  function faviconImg(url) {
    const img = document.createElement('img');
    img.className = 'icon';
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    const src = faviconURL(url);
    if (src) img.src = src;
    img.addEventListener('error', () => img.replaceWith(ICON.page()), { once: true });
    return img;
  }

  /* ================================================================== *
   * State
   * ================================================================== */

  let settings = null;
  let roots = { bar: null, other: null, mobile: null, managed: null };
  let host = null;
  let root = null;              // shadow root
  let barEl, rowsEl, chevronEl, rightEl, otherSep, otherEl, mobileEl, managedEl;
  let overlayEl, layerEl, scrimEl, toastEl, dropLine;

  let barItems = [];            // the .item elements currently inside #rows
  let overflowNodes = [];       // bookmark nodes pushed past the last row
  const menuStack = [];         // open dropdowns / context menus, outermost first
  let hoverTimer = null;
  let relayoutRaf = 0;

  /* ================================================================== *
   * Geometry helpers
   * ================================================================== */

  const barHeight = () => settings.rows * settings.rowHeight + 4 + 1; // padding + border

  function hostCss() {
    return [
      'all: initial',
      'display: block',
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 100%',
      'height: ' + barHeight() + 'px',
      'margin: 0',
      'padding: 0',
      'border: 0',
      'z-index: 2147483646',
      'pointer-events: auto',
      'color-scheme: light dark',
      '--dbb-row-h: ' + settings.rowHeight + 'px',
      '--dbb-font: ' + settings.fontSize + 'px',
      '--dbb-item-max: ' + settings.maxItemWidth + 'px'
    ].map((d) => d + ' !important').join(';') + ';';
  }

  function applyPageOffset() {
    const de = document.documentElement;
    if (!settings.enabled || settings.layout !== 'push' || settings.autoHide) {
      de.style.removeProperty('padding-top');
      return;
    }
    de.style.setProperty('padding-top', barHeight() + 'px', 'important');
  }

  /* ================================================================== *
   * Shadow root construction
   * ================================================================== */

  async function buildHost() {
    host = document.createElement('dbb-bookmarks-bar');
    host.style.cssText = hostCss();
    root = host.attachShadow({ mode: 'closed' });

    // Fetch the stylesheet up front so the bar never paints unstyled.
    try {
      const css = await fetch(chrome.runtime.getURL('content/bar.css')).then((r) => r.text());
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('content/bar.css');
      root.appendChild(link);
    }

    overlayEl = el('div', { id: 'overlay', hidden: true });
    barEl = el('div', { id: 'bar' });
    rowsEl = el('div', { id: 'rows' });
    chevronEl = el('button', { id: 'chevron', class: 'item', hidden: true, title: t('overflowTitle') });
    chevronEl.appendChild(ICON.chevrons());
    rightEl = el('div', { id: 'right' });
    otherSep = el('div', { class: 'sep', hidden: true });
    layerEl = el('div', { id: 'layer' });
    scrimEl = el('div', { id: 'scrim', hidden: true });
    scrimEl.addEventListener('mousedown', (ev) => {
      if (ev.target === scrimEl) closeDialog();
    });
    toastEl = el('div', { id: 'toast', hidden: true });
    dropLine = el('div', { id: 'drop-line', hidden: true });

    barEl.append(rowsEl, otherSep, rightEl, chevronEl);
    root.append(overlayEl, barEl, layerEl, scrimEl, toastEl, dropLine);

    document.documentElement.appendChild(host);

    wireBarEvents();
    applyTheme();
    window.__dbbRefreshTheme = () => { if (host) applyTheme(); };
  }

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'hidden') node.hidden = !!v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    if (text != null) node.textContent = text;
    return node;
  }

  // The new tab page pins the bar to a theme of its own; ordinary pages do not
  // set the override and the user's theme setting wins.
  function applyTheme() {
    const theme = window.__dbbThemeOverride || settings.theme;
    if (theme === 'auto') host.removeAttribute('data-theme');
    else host.setAttribute('data-theme', theme);
    host.classList.toggle('autohide', !!settings.autoHide);
  }

  /* ================================================================== *
   * Tree loading
   * ================================================================== */

  async function loadTree() {
    const [treeRoot] = await bm.getTree();
    const kids = treeRoot.children || [];
    const byId = (id) => kids.find((k) => k.id === id);
    roots.bar = byId('1') || kids[0] || null;
    roots.other = byId('2') || kids[1] || null;
    roots.mobile = byId('3') || kids[2] || null;
    roots.managed = kids.find((k) => k.id !== '1' && k.id !== '2' && k.id !== '3') || null;
  }

  const isFolder = (node) => !node.url;

  function collectUrls(node, out = []) {
    for (const child of node.children || []) {
      if (child.url) out.push(child.url);
      else collectUrls(child, out);
    }
    return out;
  }

  /* ================================================================== *
   * Rendering the bar
   * ================================================================== */

  function render() {
    rowsEl.textContent = '';
    rightEl.textContent = '';
    barItems = [];

    rowsEl.style.height = settings.rows * settings.rowHeight + 'px';

    const children = roots.bar?.children || [];
    if (!children.length) {
      rowsEl.appendChild(el('div', { class: 'item empty-hint', style: 'opacity:.55' },
        t('emptyBarHint', 'For quick access, place your bookmarks here on the bookmarks bar.')));
    }

    for (const node of children) {
      const item = createItem(node);
      rowsEl.appendChild(item);
      barItems.push(item);
    }

    // Chrome shows a single "All bookmarks" button here (plus a managed-bookmarks
    // button when policy supplies one); mobile bookmarks never appear on the bar.
    const extras = [];
    if (roots.managed?.children?.length) extras.push([roots.managed, t('managedBookmarks'), 'folder']);
    if (settings.showOther && roots.other) extras.push([roots.other, t('allBookmarks'), 'all']);

    for (const [node, label, role] of extras) {
      const item = createItem({ ...node, title: label }, { alwaysLabel: true });
      item.dataset.role = role;
      rightEl.appendChild(item);
    }
    otherSep.hidden = extras.length === 0;

    relayout();
  }

  function createItem(node, { alwaysLabel = false } = {}) {
    const item = el('button', { class: 'item', type: 'button' });
    item.dataset.id = node.id;
    item.dataset.kind = isFolder(node) ? 'folder' : 'bookmark';
    item.draggable = true;

    const title = (node.title || '').trim();
    const iconOnly = settings.labels === 'never' || !title ||
      (settings.labels === 'folders' && !isFolder(node) && !alwaysLabel);
    if (iconOnly) item.classList.add('icon-only');

    item.appendChild(isFolder(node) ? ICON.folder() : faviconImg(node.url));
    item.appendChild(el('span', { class: 'label' }, title));

    item.title = isFolder(node) ? title : [title, node.url].filter(Boolean).join('\n');

    return item;
  }

  /* ------------------------------------------------------------------ *
   * Two-row layout with overflow, mirroring how Chrome spills into "»"
   * ------------------------------------------------------------------ */

  function relayout() {
    if (!host || !rowsEl) return;
    const limit = settings.rows * settings.rowHeight;

    const firstOverflowing = () => {
      const top = rowsEl.getBoundingClientRect().top;
      for (let i = 0; i < barItems.length; i++) {
        if (barItems[i].getBoundingClientRect().top - top >= limit - 1) return i;
      }
      return -1;
    };

    for (const item of barItems) item.classList.remove('overflowed');
    chevronEl.hidden = true;
    rowsEl.classList.toggle('scrollable', !!settings.wheelScroll);

    if (settings.wheelScroll) {
      // Nothing is hidden; the rows box simply scrolls past the last visible row
      // and the chevron lists whatever is off screen right now.
      chevronEl.hidden = rowsEl.scrollHeight <= rowsEl.clientHeight + 1;
      if (chevronEl.hidden) rowsEl.scrollTop = 0;
      updateOffscreen();
      return;
    }

    // An overflow:hidden box keeps whatever scrollTop it was left with, which
    // would throw the row measurements off; wind it back before measuring.
    rowsEl.scrollTop = 0;

    let cut = firstOverflowing();
    if (cut >= 0) {
      chevronEl.hidden = false;
      cut = firstOverflowing();           // the chevron itself steals some width
    }

    overflowNodes = [];
    if (cut >= 0) {
      const children = roots.bar?.children || [];
      for (let i = cut; i < barItems.length; i++) {
        barItems[i].classList.add('overflowed');
        if (children[i]) overflowNodes.push(children[i]);
      }
    }
  }

  // Which bar entries are currently out of the visible band, above or below.
  function updateOffscreen() {
    const children = roots.bar?.children || [];
    const top = rowsEl.scrollTop;
    const bottom = top + rowsEl.clientHeight;
    overflowNodes = [];
    for (let i = 0; i < barItems.length; i++) {
      const el = barItems[i];
      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      if (elTop < top - 1 || elBottom > bottom + 1) {
        if (children[i]) overflowNodes.push(children[i]);
      }
    }
  }

  function scheduleRelayout() {
    if (relayoutRaf) return;
    relayoutRaf = requestAnimationFrame(() => {
      relayoutRaf = 0;
      relayout();
    });
  }

  /* ================================================================== *
   * Opening bookmarks
   * ================================================================== */

  function dispositionFor(ev) {
    if (ev.button === 1) return 'newTabBackground';
    if (ev.ctrlKey || ev.metaKey) return ev.shiftKey ? 'newTab' : 'newTabBackground';
    if (ev.shiftKey) return 'newWindow';
    return 'current';
  }

  async function openNode(node, where) {
    if (/^javascript:/i.test(node.url || '')) {
      toast(t('bookmarkletUnsupported', 'Chrome extensions are not allowed to run bookmarklets.'));
      return;
    }
    const res = await send({ type: 'open', url: node.url, where });
    if (res && res.ok === false && res.reason === 'incognito-not-allowed') {
      toast(t('incognitoBlocked'));
    }
  }

  async function openAllIn(node, where) {
    const urls = collectUrls(node);
    if (!urls.length) return;
    const res = await send({ type: 'openAll', urls, where });
    if (res && res.ok === false && res.reason === 'incognito-not-allowed') {
      toast(t('incognitoBlocked'));
    }
  }

  /* ================================================================== *
   * Bar event wiring
   * ================================================================== */

  function nodeById(id, start = null) {
    const stack = start ? [start] : [roots.bar, roots.other, roots.mobile, roots.managed].filter(Boolean);
    while (stack.length) {
      const n = stack.pop();
      if (n.id === id) return n;
      if (n.children) stack.push(...n.children);
    }
    return null;
  }

  function wireBarEvents() {
    // Middle-click must not start the page's autoscroll.
    barEl.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) ev.preventDefault();
    });

    barEl.addEventListener('click', (ev) => {
      const item = ev.target.closest?.('.item');

      // Empty space on the bar dismisses whatever is open, as in Chrome.
      if (!item) { closeAllMenus(); return; }

      ev.preventDefault();
      ev.stopPropagation();

      // Clicking the button that opened a dropdown closes it again.
      if (menuStack.length && menuStack[0].anchor === item) { closeAllMenus(); return; }

      if (item === chevronEl) return openOverflowMenu();

      const node = nodeById(item.dataset.id);
      if (!node) return;

      if (isFolder(node)) openMenuForItem(item);
      else { closeAllMenus(); openNode(node, dispositionFor(ev)); }
    });

    barEl.addEventListener('auxclick', (ev) => {
      if (ev.button !== 1) return;
      const item = ev.target.closest?.('.item');
      if (!item || item === chevronEl) return;
      ev.preventDefault();
      const node = nodeById(item.dataset.id);
      if (!node) return;
      if (isFolder(node)) openAllIn(node, 'newTabBackground');
      else openNode(node, 'newTabBackground');
    });

    barEl.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const item = ev.target.closest?.('.item');
      const node = item && item !== chevronEl ? nodeById(item.dataset.id) : null;
      openContextMenu(ev.clientX, ev.clientY, node, roots.bar);
    });

    // Hovering a sibling while a dropdown is open switches to it, as in Chrome.
    barEl.addEventListener('mouseover', (ev) => {
      if (!menuStack.length || menuStack[0].kind !== 'folder') return;
      const item = ev.target.closest?.('.item');
      if (!item || item === menuStack[0].anchor) return;
      if (item === chevronEl) { openOverflowMenu(); return; }
      const node = nodeById(item.dataset.id);
      if (node && isFolder(node)) openMenuForItem(item);
      else closeAllMenus();
    });

    // Wheel over the bar walks through the rows one at a time. The event is only
    // swallowed when the bar actually moves, so pages still scroll normally once
    // the bar is at either end — or when there is nothing hidden at all.
    barEl.addEventListener('wheel', (ev) => {
      if (!settings.wheelScroll) return;
      const max = rowsEl.scrollHeight - rowsEl.clientHeight;
      if (max <= 1) return;

      const delta = ev.deltaY || ev.deltaX;
      const direction = Math.sign(delta);
      if (!direction) return;

      const from = rowsEl.scrollTop;
      const to = Math.max(0, Math.min(max, from + direction * settings.rowHeight));
      if (to === from) return;

      ev.preventDefault();
      rowsEl.scrollTop = to;
    }, { passive: false });

    let scrollRaf = 0;
    rowsEl.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        updateOffscreen();
      });
    }, { passive: true });

    enableDnd(rowsEl, {
      orientation: 'horizontal',
      parentId: () => roots.bar?.id,
      indexOf: (item) => barItems.indexOf(item)
    });

    if (settings.autoHide) {
      host.addEventListener('mouseenter', () => host.classList.add('revealed'));
      host.addEventListener('mouseleave', () => {
        if (!menuStack.length) host.classList.remove('revealed');
      });
    }

    overlayEl.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeAllMenus();
    });
    overlayEl.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      closeAllMenus();
    });
  }

  /* ================================================================== *
   * Menus
   * ================================================================== */

  function closeMenusFrom(depth) {
    if (!host) { menuStack.length = 0; return; }
    while (menuStack.length > depth) {
      const entry = menuStack.pop();
      entry.el.remove();
      entry.anchor?.classList.remove('open');
    }
    if (!menuStack.length) {
      overlayEl.hidden = true;
      host.classList.remove('menu-open');
      if (settings.autoHide && !host.matches(':hover')) host.classList.remove('revealed');
    }
  }

  const closeAllMenus = () => closeMenusFrom(0);

  function pushMenu(entry) {
    menuStack.push(entry);
    overlayEl.hidden = false;
    host.classList.add('menu-open');
  }

  function makeMenu(cls = '') {
    const menu = el('div', { class: 'menu ' + cls, role: 'menu', tabindex: '-1' });
    menu.addEventListener('contextmenu', (ev) => ev.preventDefault());
    return menu;
  }

  function menuItem({ label, icon, arrow, disabled, checked, onClick }) {
    const mi = el('button', { class: 'mi', type: 'button', role: 'menuitem' });
    if (disabled) mi.setAttribute('disabled', '');
    if (icon) mi.appendChild(icon);
    else if (checked !== undefined) {
      mi.appendChild(checked ? ICON.check('tick') : el('span', { class: 'tick' }));
    }
    mi.appendChild(el('span', { class: 'label' }, label));
    if (arrow) mi.appendChild(ICON.arrow());
    if (onClick && !disabled) {
      mi.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick(ev);
      });
    }
    return mi;
  }

  const menuSep = () => el('div', { class: 'msep' });

  // A dropdown must never cover the button that opened it: it is capped to the
  // free space below the anchor and scrolls, instead of sliding up over the bar.
  function placeMenu(menu, { anchor, x, y, submenu = false }) {
    layerEl.appendChild(menu);
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.maxHeight = '';

    const gap = 4;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const measure = () => menu.getBoundingClientRect();

    let rect = measure();
    let left;
    let top;

    if (anchor && submenu) {
      const a = anchor.getBoundingClientRect();
      const fits = vh - 2 * gap;
      if (rect.height > fits) { menu.style.maxHeight = fits + 'px'; rect = measure(); }
      left = a.right - 4;
      if (left + rect.width > vw - gap) left = a.left - rect.width + 4;
      top = Math.min(Math.max(gap, a.top - 6), vh - rect.height - gap);
    } else if (anchor) {
      const a = anchor.getBoundingClientRect();
      const below = vh - a.bottom - 2 * gap;
      const above = a.top - 2 * gap;
      if (rect.height <= below || below >= above) {
        menu.style.maxHeight = Math.max(96, below) + 'px';
        top = a.bottom + 2;
      } else {
        menu.style.maxHeight = Math.max(96, above) + 'px';
        rect = measure();
        top = Math.max(gap, a.top - rect.height - 2);
      }
      rect = measure();
      left = a.left;
      if (left + rect.width > vw - gap) left = Math.max(gap, vw - rect.width - gap);
    } else {
      const fits = vh - 2 * gap;
      if (rect.height > fits) { menu.style.maxHeight = fits + 'px'; rect = measure(); }
      left = x + rect.width > vw - gap ? Math.max(gap, x - rect.width) : x;
      top = y + rect.height > vh - gap ? Math.max(gap, y - rect.height) : y;
    }

    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.focus({ preventScroll: true });
  }

  /* ---------- folder dropdowns --------------------------------------- */

  // Chrome shows the URL for an untitled bookmark inside menus, with the scheme
  // and any trailing slash trimmed off.
  function menuLabel(node) {
    const title = (node.title || '').trim();
    if (title) return title;
    return (node.url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
  }

  // The "All bookmarks" button leads with a manager entry, as Chrome's does.
  function openMenuForItem(item, depth = 0) {
    if (item === chevronEl) return openOverflowMenu();
    const node = nodeById(item.dataset.id);
    if (!node || !isFolder(node)) return null;

    if (item.dataset.role === 'all') {
      return openFolderMenu(item, node, depth, {
        lead: [menuItem({
          label: t('bookmarkManager'),
          onClick: () => { closeAllMenus(); send({ type: 'openManager' }); }
        })]
      });
    }
    return openFolderMenu(item, node, depth);
  }

  function openFolderMenu(anchor, node, depth = 0, opts = {}) {
    closeMenusFrom(depth);
    anchor.classList.add('open');

    const menu = makeMenu();
    const children = node.children || [];

    if (opts.lead?.length) {
      for (const lead of opts.lead) menu.appendChild(lead);
      menu.appendChild(menuSep());
    }

    if (!children.length) {
      const emptyRow = menuItem({ label: t('emptyFolder'), disabled: true });
      emptyRow.classList.add('empty');
      menu.appendChild(emptyRow);
    }

    for (const child of children) {
      const folder = isFolder(child);
      const mi = menuItem({
        label: menuLabel(child),
        icon: folder ? ICON.folder() : faviconImg(child.url),
        arrow: folder,
        onClick: folder ? null : (ev) => { closeAllMenus(); openNode(child, dispositionFor(ev)); }
      });
      mi.dataset.id = child.id;
      mi.draggable = true;
      if (!folder) mi.title = [child.title, child.url].filter(Boolean).join('\n');

      mi.addEventListener('mouseenter', () => {
        clearTimeout(hoverTimer);
        for (const sib of menu.querySelectorAll('.mi.active')) sib.classList.remove('active');
        mi.classList.add('active');
        hoverTimer = setTimeout(() => {
          if (folder) openFolderMenu(mi, child, depth + 1);
          else closeMenusFrom(depth + 1);
        }, folder ? 180 : 120);
      });
      mi.addEventListener('mouseleave', () => clearTimeout(hoverTimer));

      if (folder) {
        mi.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          clearTimeout(hoverTimer);
          openFolderMenu(mi, child, depth + 1);
        });
      }
      mi.addEventListener('auxclick', (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        closeAllMenus();
        if (folder) openAllIn(child, 'newTabBackground');
        else openNode(child, 'newTabBackground');
      });
      mi.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });
      mi.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openContextMenu(ev.clientX, ev.clientY, child, node, { keepMenus: depth + 1 });
      });

      menu.appendChild(mi);
    }

    menu.addEventListener('contextmenu', (ev) => {
      if (ev.target.closest('.mi')) return;
      ev.preventDefault();
      ev.stopPropagation();
      openContextMenu(ev.clientX, ev.clientY, null, node, { keepMenus: depth + 1 });
    });

    enableDnd(menu, {
      orientation: 'vertical',
      parentId: () => node.id,
      indexOf: (mi) => [...menu.querySelectorAll('.mi[data-id]')].indexOf(mi),
      itemSelector: '.mi[data-id]'
    });

    pushMenu({ el: menu, kind: 'folder', anchor, node, depth });
    placeMenu(menu, { anchor, submenu: depth > 0 });
    return menu;
  }

  function openOverflowMenu() {
    closeAllMenus();
    chevronEl.classList.add('open');
    const pseudo = { id: roots.bar.id, title: '', children: overflowNodes };
    const menu = openFolderMenu(chevronEl, pseudo, 0);
    menuStack[0].anchor = chevronEl;
    return menu;
  }

  /* ---------- context menu ------------------------------------------- */

  async function openContextMenu(x, y, node, parentFolder, { keepMenus = 0 } = {}) {
    closeMenusFrom(keepMenus);

    const menu = makeMenu('plain');
    const add = (item) => menu.appendChild(item);
    const run = (fn) => (ev) => { closeAllMenus(); fn(ev); };

    const clip = await send({ type: 'clipGet' }).catch(() => null);
    const targetParent = node && isFolder(node) ? node : (parentFolder || roots.bar);
    const targetIndex = node && parentFolder
      ? (parentFolder.children || []).findIndex((c) => c.id === node.id) + 1
      : undefined;

    if (node && !isFolder(node)) {
      add(menuItem({ label: t('openNewTab'), onClick: run(() => openNode(node, 'newTab')) }));
      add(menuItem({ label: t('openNewWindow'), onClick: run(() => openNode(node, 'newWindow')) }));
      add(menuItem({ label: t('openIncognito'), onClick: run(() => openNode(node, 'incognito')) }));
      add(menuSep());
      add(menuItem({ label: t('edit'), onClick: run(() => editBookmarkDialog(node)) }));
    } else if (node && isFolder(node)) {
      const count = collectUrls(node).length;
      add(menuItem({ label: t('openAll'), disabled: !count, onClick: run(() => openAllIn(node, 'newTabBackground')) }));
      add(menuItem({ label: t('openAllNewWindow'), disabled: !count, onClick: run(() => openAllIn(node, 'newWindow')) }));
      add(menuItem({ label: t('openAllIncognito'), disabled: !count, onClick: run(() => openAllIn(node, 'incognito')) }));
      add(menuSep());
      add(menuItem({ label: t('rename'), onClick: run(() => renameFolderDialog(node)) }));
    }

    if (node) {
      add(menuItem({ label: t('cut'), onClick: run(() => clipboardPut(node, 'cut')) }));
      add(menuItem({ label: t('copy'), onClick: run(() => clipboardPut(node, 'copy')) }));
    }
    add(menuItem({
      label: t('paste'),
      disabled: !clip,
      onClick: run(() => pasteInto(targetParent.id, targetIndex))
    }));

    if (node) {
      add(menuSep());
      add(menuItem({ label: t('delete'), onClick: run(() => deleteNode(node)) }));
    }

    add(menuSep());
    add(menuItem({ label: t('addPage'), onClick: run(() => addPageDialog(targetParent, targetIndex)) }));
    add(menuItem({ label: t('addFolder'), onClick: run(() => addFolderDialog(targetParent, targetIndex)) }));
    add(menuSep());
    add(menuItem({ label: t('bookmarkManager'), onClick: run(() => send({ type: 'openManager', id: targetParent.id })) }));
    add(menuItem({
      label: t('showBookmarksBar'),
      checked: settings.enabled,
      onClick: run(() => send({ type: 'setSettings', patch: { enabled: false } }))
    }));
    add(menuItem({ label: t('extensionOptions'), onClick: run(() => send({ type: 'openOptions' })) }));

    pushMenu({ el: menu, kind: 'context', depth: keepMenus });
    placeMenu(menu, { x, y });
    return menu;
  }

  /* ---------- keyboard ------------------------------------------------ */

  function menuKeydown(ev) {
    if (!menuStack.length) return;
    const top = menuStack[menuStack.length - 1];
    const items = [...top.el.querySelectorAll('.mi:not([disabled])')];
    const current = top.el.querySelector('.mi.active');
    const idx = items.indexOf(current);

    const focus = (i) => {
      items.forEach((m) => m.classList.remove('active'));
      const next = items[(i + items.length) % items.length];
      if (next) { next.classList.add('active'); next.scrollIntoView({ block: 'nearest' }); }
    };

    switch (ev.key) {
      case 'Escape':   ev.preventDefault(); closeMenusFrom(menuStack.length - 1); break;
      case 'ArrowDown':ev.preventDefault(); focus(idx + 1); break;
      case 'ArrowUp':  ev.preventDefault(); focus(idx - 1); break;
      case 'ArrowRight': {
        if (!current) return;
        const node = nodeById(current.dataset.id);
        if (node && isFolder(node)) { ev.preventDefault(); openFolderMenu(current, node, top.depth + 1); }
        break;
      }
      case 'ArrowLeft':
        if (menuStack.length > 1) { ev.preventDefault(); closeMenusFrom(menuStack.length - 1); }
        break;
      case 'Enter':
      case ' ':
        if (current) { ev.preventDefault(); current.click(); }
        break;
      default: break;
    }
  }

  /* ================================================================== *
   * Clipboard (bookmark cut / copy / paste)
   * ================================================================== */

  async function clipboardPut(node, mode) {
    await send({ type: 'clipSet', mode, id: node.id });
    if (node.url) navigator.clipboard?.writeText(node.url).catch(() => {});
  }

  async function pasteInto(parentId, index) {
    try {
      await send({ type: 'clipPaste', parentId, index });
    } catch (e) {
      toast(e.message);
    }
  }

  /* ================================================================== *
   * Mutations
   * ================================================================== */

  async function deleteNode(node) {
    const snapshot = isFolder(node) ? (await bm.getSubTree(node.id))[0] : node;
    const parentId = node.parentId;
    const index = node.index;

    if (isFolder(node)) await bm.removeTree(node.id);
    else await bm.remove(node.id);

    toast(t('deleted', 'Deleted'), t('undo', 'Undo'), async () => {
      await send({ type: 'restore', node: snapshot, parentId, index });
    });
  }

  async function moveNode(id, parentId, index) {
    try {
      await bm.move(id, index === undefined ? { parentId } : { parentId, index });
    } catch (e) {
      toast(e.message);
    }
  }

  /* ================================================================== *
   * Dialogs
   * ================================================================== */

  function closeDialog() {
    scrimEl.hidden = true;
    scrimEl.textContent = '';
  }

  function dialog({ title, fields = [], message, okLabel, onOk }) {
    closeAllMenus();
    scrimEl.textContent = '';
    scrimEl.hidden = false;

    const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
    box.appendChild(el('h2', {}, title));
    if (message) box.appendChild(el('div', { class: 'msg' }, message));

    const inputs = {};
    for (const f of fields) {
      const row = el('div', { class: 'row' });
      row.appendChild(el('label', { for: 'f_' + f.name }, f.label));
      const input = el('input', { type: 'text', id: 'f_' + f.name, spellcheck: 'false' });
      input.value = f.value || '';
      inputs[f.name] = input;
      row.appendChild(input);
      box.appendChild(row);
    }

    const buttons = el('div', { class: 'buttons' });
    const cancel = el('button', { type: 'button' }, t('btnCancel'));
    const ok = el('button', { type: 'button', class: 'primary' }, okLabel || t('btnSave'));
    buttons.append(cancel, ok);
    box.appendChild(buttons);

    const close = closeDialog;
    const submit = async () => {
      const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
      close();
      try { await onOk(values); } catch (e) { toast(e.message); }
    };

    cancel.addEventListener('click', close);
    ok.addEventListener('click', submit);
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      ev.stopPropagation();
    });
    scrimEl.appendChild(box);
    const first = fields.length ? inputs[fields[0].name] : ok;
    first.focus();
    if (first.select) first.select();
  }

  function editBookmarkDialog(node) {
    dialog({
      title: t('dlgEditBookmark'),
      fields: [
        { name: 'title', label: t('fieldName'), value: node.title || '' },
        { name: 'url', label: t('fieldUrl'), value: node.url || '' }
      ],
      onOk: ({ title, url }) => bm.update(node.id, { title, url: normalizeUrl(url) })
    });
  }

  function renameFolderDialog(node) {
    dialog({
      title: t('dlgEditFolder'),
      fields: [{ name: 'title', label: t('fieldName'), value: node.title || '' }],
      onOk: ({ title }) => bm.update(node.id, { title })
    });
  }

  function addPageDialog(parent, index) {
    dialog({
      title: t('dlgNewBookmark'),
      fields: [
        { name: 'title', label: t('fieldName'), value: document.title || '' },
        { name: 'url', label: t('fieldUrl'), value: location.href }
      ],
      onOk: ({ title, url }) => bm.create({ parentId: parent.id, index, title, url: normalizeUrl(url) })
    });
  }

  function addFolderDialog(parent, index) {
    dialog({
      title: t('dlgNewFolder'),
      fields: [{ name: 'title', label: t('fieldName'), value: t('newFolderName') }],
      onOk: ({ title }) => bm.create({ parentId: parent.id, index, title: title || t('newFolderName') })
    });
  }

  function normalizeUrl(url) {
    if (!url) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    return 'https://' + url;
  }

  /* ================================================================== *
   * Toast
   * ================================================================== */

  let toastTimer = null;

  function toast(message, actionLabel, onAction) {
    clearTimeout(toastTimer);
    toastEl.textContent = '';
    toastEl.appendChild(el('span', {}, message));
    if (actionLabel) {
      const btn = el('button', {
        type: 'button',
        style: 'margin-left:12px;background:none;border:0;color:#8ab4f8;font-size:12px;cursor:default;pointer-events:auto'
      }, actionLabel);
      btn.addEventListener('click', () => { toastEl.hidden = true; onAction(); });
      toastEl.appendChild(btn);
      toastEl.style.pointerEvents = 'auto';
    } else {
      toastEl.style.pointerEvents = 'none';
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, actionLabel ? 6000 : 3200);
  }

  /* ================================================================== *
   * Drag and drop
   * ================================================================== */

  let dragState = null;

  function enableDnd(container, { orientation, parentId, indexOf, itemSelector = '.item[data-id]' }) {
    const visibleItems = () => {
      const box = container.getBoundingClientRect();
      return [...container.querySelectorAll(itemSelector)].filter((n) => {
        if (n.classList.contains('overflowed')) return false;
        const r = n.getBoundingClientRect();
        return r.bottom > box.top + 1 && r.top < box.bottom - 1;
      });
    };

    container.addEventListener('dragstart', (ev) => {
      const item = ev.target.closest(itemSelector);
      if (!item) return;
      const node = nodeById(item.dataset.id);
      if (!node) return;
      dragState = { id: node.id, fromContainer: container };
      item.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.setData('text/plain', node.url || node.title || '');
      if (node.url) ev.dataTransfer.setData('text/uri-list', node.url);
      ev.dataTransfer.setData('application/x-dbb-id', node.id);
    });

    container.addEventListener('dragend', () => {
      for (const n of container.querySelectorAll('.dragging')) n.classList.remove('dragging');
      clearDropIndicators(container);
      dragState = null;
      dropLine.hidden = true;
    });

    container.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = dragState ? 'move' : 'copy';
      const target = resolveDropTarget(ev, container, orientation, visibleItems(), indexOf);
      paintDropTarget(container, target, orientation);
    });

    container.addEventListener('dragleave', (ev) => {
      if (container.contains(ev.relatedTarget)) return;
      clearDropIndicators(container);
    });

    container.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = resolveDropTarget(ev, container, orientation, visibleItems(), indexOf);
      clearDropIndicators(container);

      const internalId = dragState?.id || ev.dataTransfer.getData('application/x-dbb-id');
      const destParent = target.intoFolderId || parentId();
      if (!destParent) return;

      if (internalId) {
        if (internalId === target.intoFolderId) return;
        await moveNode(internalId, destParent, target.intoFolderId ? undefined : target.index);
        return;
      }

      // Something dragged in from the page or another window.
      const uri = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text/plain');
      if (!uri || !/^\s*[a-z][a-z0-9+.-]*:/i.test(uri)) return;
      const title = ev.dataTransfer.getData('text/x-moz-url-desc') || uri.trim();
      await bm.create({
        parentId: destParent,
        index: target.intoFolderId ? undefined : target.index,
        title,
        url: uri.trim()
      });
    });
  }

  function resolveDropTarget(ev, container, orientation, items, indexOf) {
    if (!items.length) return { index: 0 };

    for (const item of items) {
      const r = item.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right &&
                     ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) continue;

      const isFolderItem = item.dataset.kind === 'folder' ||
        nodeById(item.dataset.id)?.url === undefined;

      if (isFolderItem) {
        // Middle band of a folder means "drop inside", edges mean "reorder".
        const pos = orientation === 'horizontal'
          ? (ev.clientX - r.left) / r.width
          : (ev.clientY - r.top) / r.height;
        if (pos > 0.25 && pos < 0.75) return { intoFolderId: item.dataset.id, item };
      }

      const before = orientation === 'horizontal'
        ? ev.clientX < r.left + r.width / 2
        : ev.clientY < r.top + r.height / 2;
      const i = indexOf(item);
      return { index: before ? i : i + 1, item, before };
    }

    // Past the last item.
    const last = items[items.length - 1];
    return { index: indexOf(last) + 1, item: last, before: false };
  }

  function paintDropTarget(container, target, orientation) {
    clearDropIndicators(container);
    if (target.intoFolderId) {
      target.item?.classList.add('drop-into');
      dropLine.hidden = true;
      return;
    }
    if (!target.item) { dropLine.hidden = true; return; }

    const r = target.item.getBoundingClientRect();
    if (orientation === 'horizontal') {
      dropLine.style.left = (target.before ? r.left - 1 : r.right - 1) + 'px';
      dropLine.style.top = r.top + 'px';
      dropLine.style.width = '2px';
      dropLine.style.height = r.height + 'px';
    } else {
      dropLine.style.left = r.left + 'px';
      dropLine.style.top = (target.before ? r.top - 1 : r.bottom - 1) + 'px';
      dropLine.style.width = r.width + 'px';
      dropLine.style.height = '2px';
    }
    dropLine.hidden = false;
  }

  function clearDropIndicators(container) {
    for (const n of container.querySelectorAll('.drop-into')) n.classList.remove('drop-into');
    dropLine.hidden = true;
  }

  /* ================================================================== *
   * Host lifecycle
   * ================================================================== */

  function hostedOnBlockedSite() {
    const host_ = location.hostname;
    return (settings.blocklist || []).some((entry) => {
      const e = String(entry).trim().toLowerCase();
      if (!e) return false;
      return host_ === e || host_.endsWith('.' + e);
    });
  }

  function teardown() {
    closeAllMenus();
    host?.remove();
    host = null;
    document.documentElement.style.removeProperty('padding-top');
  }

  async function mount() {
    if (host) return;
    await buildHost();
    await loadTree();
    render();
    applyPageOffset();
  }

  // A bookmark change repaints the whole bar, which would yank an open dropdown
  // out from under the pointer — e.g. right after dragging an entry inside it.
  // So remember which chain of menus was open and put it back afterwards.
  function captureMenuState() {
    const first = menuStack[0];
    if (!first || first.kind !== 'folder') return null;
    return {
      overflow: first.anchor === chevronEl,
      anchorId: first.anchor?.dataset.id,
      path: menuStack.slice(1).map((e) => e.node?.id).filter(Boolean),
      scroll: menuStack.map((e) => e.el.scrollTop)
    };
  }

  function restoreMenuState(state) {
    if (!state) return;

    let menu;
    if (state.overflow) {
      if (chevronEl.hidden) return;
      menu = openOverflowMenu();
    } else {
      const anchor = [...barEl.querySelectorAll('.item[data-id]')]
        .find((i) => i.dataset.id === state.anchorId && !i.classList.contains('overflowed'));
      if (!anchor) return;
      menu = openMenuForItem(anchor);
    }
    if (!menu) return;

    const opened = [menu];
    let depth = 0;
    for (const id of state.path) {
      const mi = menu.querySelector(`.mi[data-id="${CSS.escape(id)}"]`);
      const node = nodeById(id);
      if (!mi || !node || !isFolder(node)) break;
      menu = openFolderMenu(mi, node, ++depth);
      opened.push(menu);
    }

    opened.forEach((m, i) => {
      if (state.scroll[i] != null) m.scrollTop = state.scroll[i];
    });
  }

  async function refresh() {
    if (!host) return;
    const state = captureMenuState();
    const scrollTop = rowsEl ? rowsEl.scrollTop : 0;
    closeAllMenus();
    await loadTree();
    render();
    if (scrollTop) {
      rowsEl.scrollTop = scrollTop;
      updateOffscreen();
    }
    restoreMenuState(state);
  }

  async function applySettings(next) {
    const previous = settings;
    settings = next;

    const shouldShow = settings.enabled && !hostedOnBlockedSite() &&
      !(settings.hideOnFullscreen && document.fullscreenElement);

    if (!shouldShow) { teardown(); return; }

    if (!host) { await mount(); return; }

    host.style.cssText = hostCss();
    applyTheme();
    applyPageOffset();
    if (previous && previous.autoHide !== settings.autoHide) {
      // The hover listeners differ between modes; rebuild from scratch.
      teardown();
      await mount();
      return;
    }
    render();
  }

  /* ================================================================== *
   * Boot
   * ================================================================== */

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'bookmarksChanged') refresh();
    else if (msg?.type === 'settingsChanged') applySettings(msg.settings);
  });

  window.addEventListener('resize', scheduleRelayout, { passive: true });
  document.addEventListener('fullscreenchange', () => settings && applySettings(settings));
  window.addEventListener('keydown', (ev) => {
    if (!menuStack.length) return;
    menuKeydown(ev);
  }, true);

  // Some pages rewrite documentElement's children wholesale; put the bar back.
  const guard = new MutationObserver(() => {
    if (host && !host.isConnected) document.documentElement.appendChild(host);
  });
  guard.observe(document.documentElement, { childList: true });

  (async () => {
    try {
      settings = await send({ type: 'getSettings' });
    } catch {
      return; // extension reloading or disabled
    }
    await applySettings(settings);
  })();
})();
