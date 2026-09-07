(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const devtoolsFrame = document.getElementById('devtools-frame');
  const dockSplitter = document.getElementById('dock-splitter');
  const stage = document.getElementById('stage');
  const overlay = document.getElementById('overlay');
  const address = document.getElementById('address');
  const empty = document.getElementById('empty');
  const draftBox = document.getElementById('draft');
  const elementLabel = document.getElementById('element-label');
  let hoverElement = null;
  const annotation = document.getElementById('annotation');
  const codexActions = document.getElementById('codex-actions');
  const addContext = document.getElementById('add-context');
  const contextMenu = document.getElementById('context-menu');
  const contextMenuToggle = document.getElementById('context-menu-toggle');
  const toast = document.getElementById('toast');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const devtoolsToggle = document.getElementById('devtools-toggle');
  const areaCapture = document.getElementById('area-capture');
  const screenshotMenu = document.getElementById('screenshot-menu');
  const screenshotMenuToggle = document.getElementById('screenshot-menu-toggle');
  const shareButton = document.getElementById('share-browser');
  const shareConfirmation = document.getElementById('share-confirmation');
  const shareDontAsk = document.getElementById('share-dont-ask');

  const previous = vscode.getState() || {};
  let mode = previous.mode || 'browse';
  let commentMode = previous.commentMode !== false;
  let captures = Array.isArray(previous.captures) ? previous.captures : [];
  let draft = null;
  let frameMeta = { width: 1280, height: 760, url: '', title: '' };
  let drawing = null;
  let hoverRect = null;
  let inspectTimer = null;
  let resizeTimer = null;
  let toastTimer = null;
  let loading = false;
  let requestSequence = 0;
  let hoverRequest = null;
  let selectionRequest = null;
  let gesture = null;
  let pendingCapture = null;
  let devtoolsActive = false;
  let areaAfterDevtools = false;
  let splitRatio = Math.max(.3, Math.min(.75, Number(previous.splitRatio) || .54));
  let focusedSurface = 'page';
  let resizingDock = false;
  let browserSharing = false;
  let shareConsentGranted = document.body.dataset.shareConsent === 'true';
  const reload = document.getElementById("reload");
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  document.getElementById("select-shortcut").textContent = isMac ? "⌥⌘C" : "Ctrl+Alt+C";
  document.getElementById('element-shortcut').textContent = isMac ? '⇧⌘C' : 'Ctrl+Shift+C';
  document.getElementById('screenshot-shortcut').textContent = isMac ? '⌥⌘S' : 'Ctrl+Alt+S';
  document.getElementById('area-shortcut').textContent = isMac ? '⌥⌘A' : 'Ctrl+Alt+A';
  const standardShortcuts = {
    'new-tab-shortcut': ['Ctrl+T', '⌘T'],
    'zoom-in-shortcut': ['Ctrl++', '⌘+'],
    'zoom-out-shortcut': ['Ctrl+-', '⌘−'],
    'zoom-reset-shortcut': ['Ctrl+0', '⌘0'],
    'find-shortcut': ['Ctrl+F', '⌘F'],
    'history-shortcut': ['Ctrl+Y', '⌘Y'],
    'favorite-shortcut': ['Ctrl+D', '⌘D']
  };
  for (const [id, labels] of Object.entries(standardShortcuts)) document.getElementById(id).textContent = labels[isMac ? 1 : 0];
  address.addEventListener("focus", () => address.select());
  document.getElementById("external").addEventListener("click", () => post("external"));
  document.getElementById("settings").addEventListener("click", () => post("settings"));
  document.getElementById('copy-url').addEventListener('click', () => post('copyUrl'));
  function closeShareConfirmation() {
    shareConfirmation.classList.add('hidden');
    shareButton.setAttribute('aria-expanded', 'false');
  }

  function requestBrowserShare() {
    if (browserSharing || shareConsentGranted) {
      post('shareBrowser');
      return;
    }
    toggleContextMenu(false);
    closeScreenshotMenu();
    closeMore();
    shareDontAsk.checked = false;
    shareConfirmation.classList.remove('hidden');
    shareButton.setAttribute('aria-expanded', 'true');
    document.getElementById('share-allow').focus();
  }

  shareButton.addEventListener('click', requestBrowserShare);
  document.getElementById('share-deny').addEventListener('click', () => {
    closeShareConfirmation();
    shareButton.focus();
  });
  document.getElementById('share-allow').addEventListener('click', () => {
    const remember = shareDontAsk.checked;
    if (remember) shareConsentGranted = true;
    closeShareConfirmation();
    post('shareBrowser', { remember });
  });
  shareConfirmation.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeShareConfirmation();
      shareButton.focus();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...shareConfirmation.querySelectorAll('input, button')];
    const index = items.indexOf(document.activeElement);
    if ((!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0)) {
      event.preventDefault();
      items[event.shiftKey ? items.length - 1 : 0].focus();
    }
  });
  const moreMenu = document.getElementById('more-menu');
  const moreToggle = document.getElementById('more-toggle');
  function closeMore() { moreMenu.classList.add('hidden'); moreToggle.setAttribute('aria-expanded', 'false'); }
  moreToggle.addEventListener('click', () => {
    const open = moreMenu.classList.contains('hidden');
    toggleContextMenu(false); closeScreenshotMenu(); moreMenu.classList.toggle('hidden', !open); moreToggle.setAttribute('aria-expanded', String(open));
    if (open) moreMenu.querySelector('button').focus();
  });
  document.addEventListener('click', event => { if (!event.target.closest('.browser-more') || event.target.closest('[role=menuitem]')) closeMore(); });
  moreMenu.addEventListener('keydown', event => {
    if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...moreMenu.querySelectorAll('button:not(:disabled)')]; items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  });

  const modeButtons = {
    element: document.getElementById('element-mode'),
    select: document.getElementById('select-mode')
  };

  function post(type, rest) {
    vscode.postMessage(Object.assign({ type }, rest || {}));
  }

  function saveState() {
    vscode.setState({ mode, captures, commentMode, splitRatio });
  }

  function setMode(next) {
    clearTimeout(inspectTimer);
    hoverRequest = null;
    selectionRequest = null;
    gesture = null;
    mode = next;
    for (const [name, button] of Object.entries(modeButtons)) button.classList.toggle('active', name === mode);
    codexActions.classList.toggle('selection-active', mode !== 'browse' || !!draft);
    addContext.setAttribute('aria-pressed', String(mode !== 'browse' || !!draft));
    areaCapture.setAttribute('aria-checked', String(mode === 'region' || draft?.kind === 'region'));
    modeButtons.select.setAttribute('aria-checked', String(mode === 'select'));
    stage.dataset.mode = mode;
    hoverRect = null;
    hoverElement = null;
    drawing = null;
    renderOverlay();
    saveState();
    stage.focus();
  }

  function viewportPoint(event) {
    const rect = frame.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(frameMeta.width, (event.clientX - rect.left) * frameMeta.width / rect.width)),
      y: Math.max(0, Math.min(frameMeta.height, (event.clientY - rect.top) * frameMeta.height / rect.height))
    };
  }

  function inputPoint(event) {
    const useDevtools = devtoolsActive && event.clientX >= devtoolsFrame.getBoundingClientRect().left;
    const surface = useDevtools ? devtoolsFrame : frame;
    const meta = useDevtools ? { width: Number(devtoolsFrame.dataset.width), height: Number(devtoolsFrame.dataset.height) } : frameMeta;
    const rect = surface.getBoundingClientRect();
    return {
      surface: useDevtools ? 'devtools' : 'page',
      x: Math.max(0, Math.min(meta.width, (event.clientX - rect.left) * meta.width / rect.width)),
      y: Math.max(0, Math.min(meta.height, (event.clientY - rect.top) * meta.height / rect.height))
    };
  }

  function svgRect(rect, className, label) {
    if (!rect) return '';
    const title = label ? `<text x="${rect.x + 6}" y="${Math.max(14, rect.y - 5)}" class="marker-label">${escapeHtml(label)}</text>` : '';
    return `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="0" class="${className}"/>${title}`;
  }

  function renderOverlay() {
    overlay.setAttribute('viewBox', `0 0 ${frameMeta.width} ${frameMeta.height}`);
    const items = [];
    if (['select', 'element'].includes(mode) && hoverRect && !draft) items.push(svgRect(hoverRect, 'hover-marker'));
    if (draft) items.push(svgRect(draft.kind === 'element' ? draft.element.rect : draft.region, 'hover-marker'));
    if (drawing) {
      const r = normalizeRegion(drawing.start, drawing.end);
      items.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" class="draft-region"/>`);
    }
    overlay.innerHTML = items.join('');
    positionSelection();
  }

  function positionSelection() {
    const element = draft?.kind === 'element' ? draft.element : ['select', 'element'].includes(mode) ? hoverElement : null;
    const rect = draft ? (draft.kind === 'element' ? draft.element.rect : draft.region) : ['select', 'element'].includes(mode) ? hoverRect : null;
    areaCapture.setAttribute('aria-checked', String(mode === 'region' || draft?.kind === 'region'));
    stage.classList.toggle('inspecting', !!draft);
    codexActions.classList.toggle('selection-active', mode !== 'browse' || !!draft);
    addContext.setAttribute('aria-pressed', String(mode !== 'browse' || !!draft));
    elementLabel.classList.toggle('hidden', !rect);
    if (!rect) return;
    const pageBounds = frame.getBoundingClientRect();
    const sx = pageBounds.width / frameMeta.width;
    const sy = pageBounds.height / frameMeta.height;
    const x = rect.x * sx, y = rect.y * sy, bottom = (rect.y + rect.height) * sy;
    const name = element ? element.displaySelector || element.tag.toLowerCase() : 'Area';
    elementLabel.textContent = `${name}  ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    elementLabel.style.left = `${Math.max(4, Math.min(x, pageBounds.width - elementLabel.offsetWidth - 4))}px`;
    elementLabel.style.top = `${Math.max(0, y - 22)}px`;
    if (draft) {
      draftBox.style.left = `${Math.max(4, Math.min(x, pageBounds.width - draftBox.offsetWidth - 4))}px`;
      const below = bottom + 2;
      const above = y - draftBox.offsetHeight - 24;
      draftBox.style.top = `${Math.max(0, Math.min(below + draftBox.offsetHeight <= pageBounds.height ? below : above, pageBounds.height - draftBox.offsetHeight))}px`;
    }
  }

  annotation.addEventListener('input', () => {
    annotation.style.height = '28px';
    annotation.style.height = `${Math.min(100, Math.max(28, annotation.scrollHeight + 2))}px`;
    positionSelection();
  });

  function normalizeRegion(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }

  function openDraft(capture) {
    draft = Object.assign({ id: cryptoId(), annotation: '', url: frameMeta.url, title: frameMeta.title }, capture);
    annotation.value = draft.annotation || '';
    draftBox.classList.remove('hidden');
    annotation.style.height = '28px';
    renderOverlay();
    annotation.focus();
  }

  function closeDraft() {
    draft = null;
    draftBox.classList.add('hidden');
    annotation.value = '';
    drawing = null;
    renderOverlay();
  }

  function commitDraft() {
    if (!draft || pendingCapture) return;
    draft.annotation = annotation.value.trim();
    if (!draft.annotation) { annotation.focus(); return; }
    pendingCapture = draft;
    post('sendCapture', { capture: draft });
    showToast('Adding request to the Codex composer…');
    closeDraft();
    stage.focus();
  }

  function renderCaptures() {
    document.getElementById('capture-count').textContent = String(captures.length);
  }

  function toggleDevtools(open) {
    const shouldOpen = typeof open === 'boolean' ? open : !devtoolsActive;
    devtoolsActive = shouldOpen;
    applyDockLayout();
    devtoolsToggle.setAttribute('aria-pressed', String(shouldOpen));
    if (shouldOpen) { closeDraft(); setMode('browse'); }
    post('devtools', { open: shouldOpen });
  }

  function applyDockLayout() {
    stage.style.setProperty('--page-ratio', `${splitRatio * 100}%`);
    stage.classList.toggle('devtools-split', devtoolsActive);
    dockSplitter.classList.toggle('hidden', !devtoolsActive);
    devtoolsFrame.classList.toggle('hidden', !devtoolsActive);
    positionSelection();
  }

  dockSplitter.addEventListener('pointerdown', event => {
    event.preventDefault(); event.stopPropagation(); resizingDock = true;
    dockSplitter.setPointerCapture(event.pointerId);
  });
  dockSplitter.addEventListener('pointermove', event => {
    if (!resizingDock) return;
    const bounds = stage.getBoundingClientRect();
    splitRatio = Math.max(.3, Math.min(.75, (event.clientX - bounds.left) / bounds.width));
    applyDockLayout(); saveState();
  });
  dockSplitter.addEventListener('pointerup', event => {
    if (!resizingDock) return;
    resizingDock = false; dockSplitter.releasePointerCapture(event.pointerId); reportSize();
  });
  dockSplitter.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    splitRatio = Math.max(.3, Math.min(.75, splitRatio + (event.key === 'ArrowRight' ? .02 : -.02)));
    applyDockLayout(); saveState(); reportSize();
  });

  function toggleContextMenu(force) {
    const shouldOpen = typeof force === 'boolean' ? force : contextMenu.classList.contains('hidden');
    contextMenu.classList.toggle('hidden', !shouldOpen);
    contextMenuToggle.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      closeMore();
      closeScreenshotMenu();
      contextMenu.style.transform = '';
      const bounds = contextMenu.getBoundingClientRect();
      const shift = bounds.left < 4 ? 4 - bounds.left : bounds.right > window.innerWidth - 4 ? window.innerWidth - 4 - bounds.right : 0;
      contextMenu.style.transform = `translateX(${shift}px)`;
    }
    if (shouldOpen) contextMenu.querySelector('button:not(:disabled)').focus();
  }

  function closeScreenshotMenu() {
    screenshotMenu.classList.add('hidden');
    screenshotMenuToggle.setAttribute('aria-expanded', 'false');
  }

  function toggleScreenshotMenu(force) {
    const shouldOpen = typeof force === 'boolean' ? force : screenshotMenu.classList.contains('hidden');
    screenshotMenu.classList.toggle('hidden', !shouldOpen);
    screenshotMenuToggle.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      toggleContextMenu(false);
      closeMore();
      screenshotMenu.querySelector('button:not(:disabled)').focus();
    }
  }

  screenshotMenu.addEventListener('keydown', event => {
    const items = [...screenshotMenu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  });

  contextMenu.addEventListener('keydown', event => {
    const items = [...contextMenu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  });

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  }

  function setStatus(text, kind) {
    statusText.textContent = text;
    statusDot.className = kind || '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  function cryptoId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  document.getElementById('address-form').addEventListener('submit', event => {
    event.preventDefault();
    post('navigate', { url: address.value });
    stage.focus();
  });
  document.getElementById('back').addEventListener('click', () => post('back'));
  document.getElementById('forward').addEventListener('click', () => post('forward'));
  document.getElementById('reload').addEventListener('click', () => post(loading ? 'stop' : 'reload'));
  addContext.addEventListener('click', () => {
    if (draft) { closeDraft(); setMode('browse'); }
    else setMode(mode !== 'browse' ? 'browse' : commentMode ? 'select' : 'element');
  });
  contextMenuToggle.addEventListener('click', event => { event.stopPropagation(); toggleContextMenu(); });
  screenshotMenuToggle.addEventListener('click', event => { event.stopPropagation(); toggleScreenshotMenu(); });
  modeButtons.element.addEventListener('click', () => { toggleContextMenu(false); closeDraft(); setMode('element'); });
  modeButtons.select.addEventListener('click', () => { toggleContextMenu(false); closeDraft(); const active = mode === 'select'; commentMode = true; setMode(active ? 'browse' : 'select'); });
  document.getElementById('console-capture').addEventListener('click', () => { toggleContextMenu(false); post('consoleCapture'); });
  document.getElementById('screenshot-capture').addEventListener('click', () => { toggleScreenshotMenu(false); post('screenshotCapture'); });
  areaCapture.addEventListener('click', () => {
    toggleScreenshotMenu(false); closeMore(); closeDraft();
    if (devtoolsActive) { areaAfterDevtools = true; toggleDevtools(false); }
    else setMode(mode === 'region' ? 'browse' : 'region');
  });
  document.getElementById('save-draft').addEventListener('click', () => commitDraft());
  annotation.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      commitDraft();
    }
  });
  draftBox.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      const add = document.getElementById('save-draft');
      if (event.shiftKey && event.target === annotation) { event.preventDefault(); add.focus(); }
      else if (!event.shiftKey && event.target === add) { event.preventDefault(); annotation.focus(); }
    }
  });
  devtoolsToggle.addEventListener('click', () => toggleDevtools());
  document.getElementById('new-tab').addEventListener('click', () => post('newTab'));
  document.getElementById('zoom-in').addEventListener('click', () => post('zoom', { action: 'in' }));
  document.getElementById('zoom-out').addEventListener('click', () => post('zoom', { action: 'out' }));
  document.getElementById('zoom-reset').addEventListener('click', () => post('zoom', { action: 'reset' }));
  document.getElementById('find-page').addEventListener('click', () => post('findInPage'));
  document.getElementById('device-emulation').addEventListener('click', () => post('deviceEmulation'));
  document.getElementById('history').addEventListener('click', () => post('history'));
  document.getElementById('favorite').addEventListener('click', () => post('favorite'));
  document.getElementById('permissions').addEventListener('click', () => post('permissions'));
  document.getElementById('clear-storage').addEventListener('click', () => post('clearStorage'));
  document.addEventListener('click', event => {
    if (!codexActions.contains(event.target)) toggleContextMenu(false);
    if (!event.target.closest('.screenshot-actions')) toggleScreenshotMenu(false);
  });
  window.addEventListener('keydown', event => {
    if (devtoolsActive) return;
    const modifier = isMac ? event.metaKey && event.altKey : event.ctrlKey && event.altKey;
    const commandKey = isMac ? event.metaKey : event.ctrlKey;
    if ((isMac ? event.metaKey : event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault(); closeDraft(); setMode('element');
    } else if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!event.repeat) { toggleContextMenu(false); toggleScreenshotMenu(false); closeMore(); post('screenshotCapture'); }
    } else if (modifier && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (!event.repeat) { toggleContextMenu(false); toggleScreenshotMenu(false); closeMore(); closeDraft(); setMode('region'); }
    } else if (commandKey && !event.altKey && event.key.toLowerCase() === 't') {
      event.preventDefault(); if (!event.repeat) post('newTab');
    } else if (commandKey && !event.altKey && (event.key === '+' || event.key === '=')) {
      event.preventDefault(); if (!event.repeat) post('zoom', { action: 'in' });
    } else if (commandKey && !event.altKey && event.key === '-') {
      event.preventDefault(); if (!event.repeat) post('zoom', { action: 'out' });
    } else if (commandKey && !event.altKey && event.key === '0') {
      event.preventDefault(); if (!event.repeat) post('zoom', { action: 'reset' });
    } else if (commandKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); if (!event.repeat) post('findInPage');
    } else if (commandKey && !event.altKey && event.key.toLowerCase() === 'y') {
      event.preventDefault(); if (!event.repeat) post('history');
    } else if (commandKey && !event.altKey && event.key.toLowerCase() === 'd') {
      event.preventDefault(); if (!event.repeat) post('favorite');
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault(); address.focus(); address.select();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault(); post('reload');
    } else if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && event.target === stage) {
      event.preventDefault(); post(event.key === 'ArrowLeft' ? 'back' : 'forward');
    } else if (event.key === 'Escape') {
      if (!moreMenu.classList.contains('hidden')) { closeMore(); moreToggle.focus(); }
      else if (!screenshotMenu.classList.contains('hidden')) { closeScreenshotMenu(); screenshotMenuToggle.focus(); }
      else if (!contextMenu.classList.contains('hidden')) { toggleContextMenu(false); contextMenuToggle.focus(); }
      else if (draft) { event.preventDefault(); closeDraft(); stage.focus(); }
      else if (mode !== 'browse') { event.preventDefault(); setMode('browse'); }
      else if (event.target === address) { address.value = frameMeta.url; stage.focus(); }
      else if (loading) post('stop');
    } else if (modifier && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      closeDraft(); const active = mode === 'select'; commentMode = true; setMode(active ? 'browse' : 'select');
    }
  });

  function clearHover() {
    clearTimeout(inspectTimer);
    hoverRequest = null;
    hoverRect = null;
    hoverElement = null;
    renderOverlay();
  }

  stage.addEventListener('contextmenu', event => { if (mode !== 'browse' || draft) event.preventDefault(); });
  stage.addEventListener('pointerdown', event => {
    if (!frame.src) return;
    if (mode !== 'browse' && event.button !== 0) { event.preventDefault(); return; }
    event.preventDefault();
    stage.focus();
    const menuOpen = !contextMenu.classList.contains('hidden') || !moreMenu.classList.contains('hidden');
    if (menuOpen) { toggleContextMenu(false); closeMore(); gesture = null; return; }
    if (pendingCapture) return;
    const point = inputPoint(event);
    focusedSurface = point.surface;
    if (mode !== 'browse' && point.surface !== 'page') return;
    gesture = { id: event.pointerId, mode, point, surface: point.surface, dismiss: !!draft };
    if (draft) return;
    if (mode === 'region') {
      drawing = { start: gesture.point, end: gesture.point };
      stage.setPointerCapture(event.pointerId);
      renderOverlay();
    }
  });

  stage.addEventListener('pointermove', event => {
    if (!frame.src || draft || pendingCapture) return;
    const point = inputPoint(event);
    if (point.surface !== 'page' && mode !== 'browse') { clearHover(); return; }
    if (mode === 'region' && drawing) {
      drawing.end = point;
      renderOverlay();
    } else if (mode === 'select' || mode === 'element') {
      clearTimeout(inspectTimer);
      hoverRequest = ++requestSequence;
      const requestId = hoverRequest;
      inspectTimer = setTimeout(() => post('inspect', { ...point, requestId }), 55);
    }
  });

  stage.addEventListener('pointerleave', () => {
    clearHover();
    if (mode !== 'region') gesture = null;
  });
  stage.addEventListener('pointercancel', () => { gesture = null; drawing = null; clearHover(); });
  window.addEventListener('blur', () => { gesture = null; drawing = null; clearHover(); });

  stage.addEventListener('pointerup', event => {
    const started = gesture;
    gesture = null;
    if (!started || started.id !== event.pointerId || started.mode !== mode) return;
    if (started.dismiss) { closeDraft(); stage.focus(); return; }
    const point = inputPoint(event);
    if (mode === 'region' && drawing) {
      const region = normalizeRegion(drawing.start, point);
      drawing = null;
      renderOverlay();
      if (region.width >= 8 && region.height >= 8) {
        setMode('browse');
        openDraft({ kind: 'region', region, url: frameMeta.url, title: frameMeta.title });
      }
      return;
    }
    if (mode !== 'region') {
      clearHover();
      const requestId = ++requestSequence;
      if (mode !== 'browse') selectionRequest = requestId;
      const dragged = Math.abs(point.x - started.point.x) >= 4 || Math.abs(point.y - started.point.y) >= 4;
      post('click', { ...point, mode, button: event.button, requestId, selectionRegion: mode !== 'browse' && dragged ? normalizeRegion(started.point, point) : undefined });
    }
  });

  stage.addEventListener('wheel', event => {
    event.preventDefault();
    if (pendingCapture || draft || drawing) return;
    clearHover();
    captures.forEach(capture => { capture.showMarker = false; });
    post('wheel', { surface: inputPoint(event).surface, dx: event.deltaX, dy: event.deltaY });
  }, { passive: false });

  stage.addEventListener('keydown', event => {
    if (devtoolsActive) {
      event.preventDefault();
      const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) post('key', { surface: focusedSurface, text: event.key });
      else post('key', { surface: focusedSurface, key: `${event.ctrlKey ? 'Control+' : ''}${event.metaKey ? 'Meta+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}` });
      return;
    }
    if (event.key === 'Escape' || draft || pendingCapture || mode !== 'browse' || event.metaKey || event.altKey) return;
    if (event.ctrlKey && ['r', 'l'].includes(event.key.toLowerCase())) return;
    const special = { Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
    if (special[event.key]) {
      event.preventDefault();
      post('key', { key: `${event.ctrlKey ? 'Control+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${special[event.key]}` });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      post('key', { text: event.key });
    }
  });

  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'browserSharing': {
        const button = shareButton;
        browserSharing = message.active;
        closeShareConfirmation();
        button.setAttribute('aria-pressed', String(message.active));
        button.title = message.active ? 'Stop Sharing Browser with Codex' : 'Share Browser with Codex';
        button.setAttribute('aria-label', button.title);
        break;
      }
      case 'pageReset':
        pendingCapture = null;
        closeDraft();
        setMode('browse');
        captures.forEach(capture => { capture.showMarker = false; });
        renderOverlay();
        break;
      case 'captureResult':
        if (!pendingCapture || message.id !== pendingCapture.id) break;
        {
          const capture = pendingCapture;
          pendingCapture = null;
          if (message.success) { captures.push(capture); saveState(); renderCaptures(); renderOverlay(); }
          else { openDraft(capture); showToast('Could not attach comment. Your text is preserved; try again.'); }
        }
        break;
      case 'frame':
        frameMeta = { width: message.width, height: message.height, url: message.url, title: message.title };
        frame.src = `data:image/jpeg;base64,${message.data}`;
        if (message.devtoolsData) {
          devtoolsFrame.src = `data:image/jpeg;base64,${message.devtoolsData}`;
          devtoolsFrame.dataset.width = String(message.devtoolsWidth);
          devtoolsFrame.dataset.height = String(message.devtoolsHeight);
          if (Number.isFinite(message.splitRatio)) splitRatio = message.splitRatio;
        }
        applyDockLayout();
        if (document.activeElement !== address) address.value = message.url || address.value;
        empty.classList.add('hidden');
        setStatus('Live', 'live');
        renderOverlay();
        break;
      case 'state':
        frameMeta.url = message.url;
        frameMeta.title = message.title;
        document.getElementById('back').disabled = !message.canGoBack;
        document.getElementById('forward').disabled = !message.canGoForward;
        if (document.activeElement !== address) address.value = message.url || address.value;
        break;
      case 'inspected':
        if (message.requestId !== hoverRequest || !['select', 'element'].includes(mode) || draft || pendingCapture) break;
        hoverElement = message.element;
        hoverRect = message.element && message.element.rect;
        renderOverlay();
        break;
      case 'selected':
        if (message.requestId !== selectionRequest || !['select', 'element'].includes(mode)) break;
        selectionRequest = null;
        if (message.element) {
          if (mode === 'element') {
            setMode('browse');
            post('sendCapture', { capture: { kind: 'element', element: message.element, snapshotId: message.snapshotId, url: frameMeta.url, title: frameMeta.title } });
            break;
          }
          clearHover();
          openDraft({ kind: 'element', element: message.element, snapshotId: message.snapshotId });
        }
        break;
      case 'loading':
        loading = message.value;
        reload.title = loading ? 'Stop Loading (Escape)' : 'Reload (Ctrl/Cmd+R)';
        reload.setAttribute('aria-label', loading ? 'Stop Loading' : 'Reload');
        reload.firstElementChild.className = `icon ${loading ? 'close' : 'refresh'}`;
        setStatus(message.value ? 'Loading…' : 'Live', message.value ? 'loading' : 'live');
        break;
      case 'ready': setStatus('Live', 'live'); reportSize(); break;
      case 'error': showToast(message.message); setStatus('Page error', 'error'); break;
      case 'fatal':
        empty.innerHTML = `<div class="fatal"><strong>Browser could not start</strong><p>${escapeHtml(message.message)}</p><code>npm install</code></div>`;
        setStatus('Setup required', 'error');
        break;
      case 'toast': showToast(message.message); break;
      case 'devtoolsVisibility':
        devtoolsActive = !!message.open;
        devtoolsToggle.setAttribute('aria-pressed', String(devtoolsActive));
        applyDockLayout();
        if (!devtoolsActive && areaAfterDevtools) { areaAfterDevtools = false; setMode('region'); }
        break;
    }
  });

  function reportSize() {
    positionSelection();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const rect = stage.getBoundingClientRect();
      post('resize', { width: Math.floor(rect.width), height: Math.floor(rect.height), splitRatio });
    }, 120);
  }
  new ResizeObserver(reportSize).observe(stage);

  setMode(mode);
  renderCaptures();
  reportSize();
}());
