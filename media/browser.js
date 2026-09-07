(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const stage = document.getElementById('stage');
  const overlay = document.getElementById('overlay');
  const address = document.getElementById('address');
  const empty = document.getElementById('empty');
  const draftBox = document.getElementById('draft');
  const annotation = document.getElementById('annotation');
  const codexActions = document.getElementById('codex-actions');
  const addContext = document.getElementById('add-context');
  const toast = document.getElementById('toast');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const screenshotPrimary = document.getElementById('screenshot-primary');
  const drawPrimary = document.getElementById('draw-primary');
  const addressSuggestions = document.getElementById('address-suggestions');

  const previous = vscode.getState() || {};
  let mode = previous.mode || 'browse';
  let captures = Array.isArray(previous.captures) ? previous.captures : [];
  let draft = null;
  let frameMeta = { width: 1280, height: 760, url: '', title: '' };
  let drawing = null;
  let inkPath = null;
  let inkPaths = [];
  let hoverRect = null;
  let inspectTimer = null;
  let resizeTimer = null;
  let lastReportedSize = '';
  let toastTimer = null;
  let loading = false;
  let requestSequence = 0;
  let hoverRequest = null;
  let selectionRequest = null;
  let gesture = null;
  let pendingCapture = null;
  let hasFrame = false;
  let startPage = false;
  let launcherData = { recents: [], openTabs: [] };
  let activeSuggestion = -1;
  const reload = document.getElementById("reload");
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
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
  address.addEventListener('focus', () => {
    address.select();
    post('getLauncherData');
    if (startPage || launcherData.recents.length || launcherData.openTabs.length) showAddressSuggestions();
  });
  document.getElementById("external").addEventListener("click", () => post("external"));
  document.getElementById("settings").addEventListener("click", () => post("settings"));
  document.getElementById('copy-url').addEventListener('click', () => post('copyUrl'));
  const moreMenu = document.getElementById('more-menu');
  const moreToggle = document.getElementById('more-toggle');
  function closeMore() { moreMenu.classList.add('hidden'); moreToggle.setAttribute('aria-expanded', 'false'); }
  moreToggle.addEventListener('click', () => {
    const open = moreMenu.classList.contains('hidden');
    moreMenu.classList.toggle('hidden', !open); moreToggle.setAttribute('aria-expanded', String(open));
    if (open) moreMenu.querySelector('button').focus();
  });
  document.addEventListener('click', event => { if (!event.target.closest('.browser-more') || event.target.closest('[role=menuitem]')) closeMore(); });
  moreMenu.addEventListener('keydown', event => {
    if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...moreMenu.querySelectorAll('button:not(:disabled)')]; items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  });

  function post(type, rest) {
    vscode.postMessage(Object.assign({ type }, rest || {}));
  }

  function saveState() {
    vscode.setState({ mode, captures });
  }

  function setMode(next) {
    clearTimeout(inspectTimer);
    hoverRequest = null;
    selectionRequest = null;
    gesture = null;
    mode = next;
    const commentActive = ['select', 'element'].includes(mode) || draft?.kind === 'element';
    codexActions.classList.toggle('selection-active', commentActive);
    addContext.setAttribute('aria-pressed', String(commentActive));
    screenshotPrimary.setAttribute('aria-pressed', String(mode === 'region' || draft?.kind === 'region'));
    drawPrimary.setAttribute('aria-pressed', String(mode === 'draw' || draft?.kind === 'drawing'));
    stage.dataset.mode = mode;
    hoverRect = null;
    drawing = null;
    inkPath = null;
    inkPaths = [];
    renderOverlay();
    saveState();
    stage.focus();
  }

  function pagePoint(event) {
    const rect = frame.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(frameMeta.width, (event.clientX - rect.left) * frameMeta.width / rect.width)),
      y: Math.max(0, Math.min(frameMeta.height, (event.clientY - rect.top) * frameMeta.height / rect.height))
    };
  }

  function svgRect(rect, className) {
    if (!rect) return '';
    return `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="0" class="${className}"/>`;
  }

  function svgPath(points, className) {
    if (!Array.isArray(points) || points.length < 2) return '';
    const data = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
    return `<path d="${data}" class="${className}"/>`;
  }

  function renderOverlay() {
    overlay.setAttribute('viewBox', `0 0 ${frameMeta.width} ${frameMeta.height}`);
    const items = [];
    if (['select', 'element'].includes(mode) && hoverRect && !draft) items.push(svgRect(hoverRect, 'hover-marker'));
    if (draft?.kind === 'drawing') {
      for (const path of draft.paths || [draft.path]) items.push(svgPath(path, 'ink-path'));
    }
    else if (draft) items.push(svgRect(draft.kind === 'element' ? draft.element.rect : draft.region, 'hover-marker'));
    if (drawing) {
      const r = normalizeRegion(drawing.start, drawing.end);
      items.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" class="draft-region"/>`);
    }
    for (const path of inkPaths) items.push(svgPath(path, 'ink-path'));
    if (inkPath) items.push(svgPath(inkPath, 'ink-path'));
    overlay.innerHTML = items.join('');
    positionSelection();
  }

  function positionSelection() {
    const rect = draft ? (draft.kind === 'element' ? draft.element.rect : draft.region) : ['select', 'element'].includes(mode) ? hoverRect : null;
    const commentActive = ['select', 'element'].includes(mode) || draft?.kind === 'element';
    screenshotPrimary.setAttribute('aria-pressed', String(mode === 'region' || draft?.kind === 'region'));
    drawPrimary.setAttribute('aria-pressed', String(mode === 'draw' || draft?.kind === 'drawing'));
    stage.classList.toggle('inspecting', !!draft);
    codexActions.classList.toggle('selection-active', commentActive);
    addContext.setAttribute('aria-pressed', String(commentActive));
    if (!rect) return;
    const pageBounds = frame.getBoundingClientRect();
    const sx = pageBounds.width / frameMeta.width;
    const sy = pageBounds.height / frameMeta.height;
    const x = rect.x * sx, y = rect.y * sy, bottom = (rect.y + rect.height) * sy;
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
    inkPath = null;
    inkPaths = [];
    renderOverlay();
  }

  function finishDrawing() {
    if (mode !== 'draw' || !inkPaths.length) return;
    const paths = inkPaths.map(path => path.slice());
    const points = paths.flat();
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const left = Math.max(0, Math.min(...xs) - 7);
    const top = Math.max(0, Math.min(...ys) - 7);
    const region = {
      x: left,
      y: top,
      width: Math.min(frameMeta.width, Math.max(...xs) + 7) - left,
      height: Math.min(frameMeta.height, Math.max(...ys) + 7) - top
    };
    setMode('browse');
    openDraft({ kind: 'drawing', paths, region });
  }

  async function drawingScreenshot(capture) {
    if (!frame.complete || !frame.naturalWidth) throw new Error('The browser image is not ready');
    const canvas = document.createElement('canvas');
    canvas.width = frameMeta.width;
    canvas.height = frameMeta.height;
    const context = canvas.getContext('2d');
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    context.beginPath();
    context.strokeStyle = '#f14c4c';
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const path of capture.paths || [capture.path]) {
      context.beginPath();
      path.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.stroke();
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }

  async function commitDraft() {
    if (!draft || pendingCapture) return;
    draft.annotation = annotation.value.trim();
    if (!draft.annotation) { annotation.focus(); return; }
    pendingCapture = draft;
    if (draft.kind === 'drawing') {
      try { pendingCapture.imageData = await drawingScreenshot(pendingCapture); }
      catch (error) {
        pendingCapture = null;
        showToast(error.message || 'Could not create the marked-up screenshot');
        return;
      }
    }
    post('sendCapture', { capture: draft });
    closeDraft();
    stage.focus();
  }

  function renderCaptures() {
    document.getElementById('capture-count').textContent = String(captures.length);
  }

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

  function suggestionItems() {
    const query = address.value.trim().toLowerCase();
    const matches = item => !query || `${item.title || ''} ${item.url || ''}`.toLowerCase().includes(query);
    return {
      recents: launcherData.recents.filter(matches),
      openTabs: launcherData.openTabs.filter(matches)
    };
  }

  function siteMark(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host === 'localhost' || /^\d+(\.\d+){3}$/.test(host)) return '&#9678;';
      return escapeHtml(host.charAt(0).toUpperCase() || '?');
    } catch { return '&#9678;'; }
  }

  function renderSuggestionSection(title, hint, items, kind) {
    if (!items.length) return '';
    return `<div class="suggestion-heading"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(hint)}</span></div>${items.map((item, index) => `
      <button type="button" class="suggestion-row" role="option" data-kind="${kind}" data-index="${index}">
        <span class="site-mark" aria-hidden="true">${siteMark(item.url)}</span>
        <span class="suggestion-title">${escapeHtml(item.title || item.url)}</span>
        <span class="suggestion-url">${escapeHtml(item.url)}</span>
      </button>`).join('')}`;
  }

  function renderAddressSuggestions() {
    const filtered = suggestionItems();
    addressSuggestions.innerHTML =
      renderSuggestionSection('Recents', 'Recently visited', filtered.recents, 'recent') +
      renderSuggestionSection('Open Tabs', 'Select a tab to switch', filtered.openTabs, 'tab') ||
      '<div class="suggestion-empty">Type a URL or search term, then press Enter</div>';
    const rows = [...addressSuggestions.querySelectorAll('.suggestion-row')];
    activeSuggestion = Math.min(activeSuggestion, rows.length - 1);
    rows.forEach((row, index) => row.classList.toggle('active', index === activeSuggestion));
  }

  function showAddressSuggestions() {
    renderAddressSuggestions();
    addressSuggestions.classList.remove('hidden');
    address.setAttribute('aria-expanded', 'true');
  }

  function closeAddressSuggestions() {
    activeSuggestion = -1;
    addressSuggestions.classList.add('hidden');
    address.setAttribute('aria-expanded', 'false');
  }

  function chooseSuggestion(row) {
    if (!row) return;
    const filtered = suggestionItems();
    const list = row.dataset.kind === 'tab' ? filtered.openTabs : filtered.recents;
    const item = list[Number(row.dataset.index)];
    if (!item) return;
    closeAddressSuggestions();
    if (row.dataset.kind === 'tab') post('openTab', { id: item.id });
    else post('navigate', { url: item.url });
  }

  address.addEventListener('input', () => { activeSuggestion = -1; showAddressSuggestions(); });
  address.addEventListener('keydown', event => {
    const rows = [...addressSuggestions.querySelectorAll('.suggestion-row')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (addressSuggestions.classList.contains('hidden')) showAddressSuggestions();
      const count = rows.length || addressSuggestions.querySelectorAll('.suggestion-row').length;
      if (!count) return;
      activeSuggestion = (activeSuggestion + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      renderAddressSuggestions();
    } else if (event.key === 'Enter' && activeSuggestion >= 0 && !addressSuggestions.classList.contains('hidden')) {
      event.preventDefault();
      chooseSuggestion(addressSuggestions.querySelectorAll('.suggestion-row')[activeSuggestion]);
    } else if (event.key === 'Escape' && !addressSuggestions.classList.contains('hidden')) {
      event.preventDefault(); event.stopPropagation(); closeAddressSuggestions();
    }
  });
  addressSuggestions.addEventListener('mousedown', event => event.preventDefault());
  addressSuggestions.addEventListener('click', event => chooseSuggestion(event.target.closest('.suggestion-row')));
  document.addEventListener('mousedown', event => {
    if (!event.target.closest('#address-form, #address-suggestions')) closeAddressSuggestions();
  });

  function cryptoId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  document.getElementById('address-form').addEventListener('submit', event => {
    event.preventDefault();
    closeAddressSuggestions();
    post('navigate', { url: address.value });
    stage.focus();
  });
  document.getElementById('back').addEventListener('click', () => post('back'));
  document.getElementById('forward').addEventListener('click', () => post('forward'));
  document.getElementById('reload').addEventListener('click', () => post(loading ? 'stop' : 'reload'));
  addContext.addEventListener('click', () => {
    if (draft) { closeDraft(); setMode('browse'); }
    else setMode(['select', 'element'].includes(mode) ? 'browse' : 'select');
  });
  screenshotPrimary.addEventListener('click', () => {
    closeMore(); closeDraft();
    setMode(mode === 'region' ? 'browse' : 'region');
  });
  drawPrimary.addEventListener('click', () => {
    closeMore(); closeDraft();
    setMode(mode === 'draw' ? 'browse' : 'draw');
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
  window.addEventListener('keydown', event => {
    const modifier = isMac ? event.metaKey && event.altKey : event.ctrlKey && event.altKey;
    const commandKey = isMac ? event.metaKey : event.ctrlKey;
    if ((isMac ? event.metaKey : event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault(); closeDraft(); setMode('element');
    } else if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!event.repeat) { closeMore(); post('screenshotCapture'); }
    } else if (modifier && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (!event.repeat) { closeMore(); closeDraft(); setMode('region'); }
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
      else if (draft) { event.preventDefault(); closeDraft(); stage.focus(); }
      else if (mode !== 'browse') { event.preventDefault(); setMode('browse'); }
      else if (event.target === address) { address.value = frameMeta.url; stage.focus(); }
      else if (loading) post('stop');
    } else if (modifier && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      closeDraft(); const active = mode === 'select'; setMode(active ? 'browse' : 'select');
    }
  });

  function clearHover() {
    clearTimeout(inspectTimer);
    hoverRequest = null;
    hoverRect = null;
    renderOverlay();
  }

  stage.addEventListener('contextmenu', event => {
    if (mode !== 'browse' || draft) event.preventDefault();
    if (mode === 'draw' && !draft && !pendingCapture) finishDrawing();
  });
  stage.addEventListener('pointerdown', event => {
    if (!frame.src) return;
    if (mode !== 'browse' && event.button !== 0) { event.preventDefault(); return; }
    event.preventDefault();
    stage.focus();
    if (!moreMenu.classList.contains('hidden')) { closeMore(); gesture = null; return; }
    if (pendingCapture) return;
    const point = pagePoint(event);
    gesture = { id: event.pointerId, mode, point, dismiss: !!draft };
    if (draft) return;
    if (mode === 'region') {
      drawing = { start: gesture.point, end: gesture.point };
      stage.setPointerCapture(event.pointerId);
      renderOverlay();
    } else if (mode === 'draw') {
      inkPath = [gesture.point];
      stage.setPointerCapture(event.pointerId);
      renderOverlay();
    }
  });

  stage.addEventListener('pointermove', event => {
    if (!frame.src || draft || pendingCapture) return;
    const point = pagePoint(event);
    if (mode === 'region' && drawing) {
      drawing.end = point;
      renderOverlay();
    } else if (mode === 'draw' && inkPath) {
      const previousPoint = inkPath[inkPath.length - 1];
      if (Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y) >= 2) {
        inkPath.push(point);
        renderOverlay();
      }
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
  stage.addEventListener('pointercancel', () => { gesture = null; drawing = null; inkPath = null; clearHover(); });
  window.addEventListener('blur', () => { gesture = null; drawing = null; inkPath = null; clearHover(); });

  stage.addEventListener('pointerup', event => {
    const started = gesture;
    gesture = null;
    if (!started || started.id !== event.pointerId || started.mode !== mode) return;
    if (started.dismiss) { closeDraft(); stage.focus(); return; }
    const point = pagePoint(event);
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
    if (mode === 'draw' && inkPath) {
      inkPath.push(point);
      const path = inkPath;
      inkPath = null;
      if (path.length >= 2) {
        inkPaths.push(path);
      }
      renderOverlay();
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
    post('wheel', { dx: event.deltaX, dy: event.deltaY });
  }, { passive: false });

  stage.addEventListener('keydown', event => {
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
      case 'pageReset':
        pendingCapture = null;
        closeDraft();
        setMode('browse');
        renderOverlay();
        break;
      case 'captureResult':
        if (!pendingCapture || message.id !== pendingCapture.id) break;
        {
          const capture = pendingCapture;
          pendingCapture = null;
          if (message.success) { delete capture.imageData; captures.push(capture); saveState(); renderCaptures(); renderOverlay(); }
          else { openDraft(capture); showToast('Could not attach comment. Your text is preserved; try again.'); }
        }
        break;
      case 'frame':
        startPage = false;
        closeAddressSuggestions();
        hasFrame = true;
        frameMeta = { width: message.width, height: message.height, url: message.url, title: message.title };
        frame.src = `data:image/jpeg;base64,${message.data}`;
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
      case 'startPage':
        startPage = true;
        launcherData = {
          recents: Array.isArray(message.recents) ? message.recents : [],
          openTabs: Array.isArray(message.openTabs) ? message.openTabs : []
        };
        address.value = '';
        empty.innerHTML = '';
        empty.classList.add('hidden');
        showAddressSuggestions();
        setTimeout(() => address.focus(), 0);
        break;
      case 'launcherData':
        launcherData = {
          recents: Array.isArray(message.recents) ? message.recents : [],
          openTabs: Array.isArray(message.openTabs) ? message.openTabs : []
        };
        if (document.activeElement === address) showAddressSuggestions();
        break;
      case 'inspected':
        if (message.requestId !== hoverRequest || !['select', 'element'].includes(mode) || draft || pendingCapture) break;
        hoverRect = message.element && message.element.rect;
        renderOverlay();
        break;
      case 'selected':
        if (message.requestId !== selectionRequest || !['select', 'element'].includes(mode)) break;
        selectionRequest = null;
        if (message.element) {
          if (mode === 'element') {
            setMode('browse');
            post('sendCapture', { capture: { kind: 'element', element: message.element, url: frameMeta.url, title: frameMeta.title } });
            break;
          }
          clearHover();
          openDraft({ kind: 'element', element: message.element });
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
      case 'error':
        setStatus('Page error', 'error');
        if (!hasFrame) {
          empty.innerHTML = `<div class="fatal"><strong>Page could not load</strong><p>${escapeHtml(message.message)}</p></div>`;
          empty.classList.remove('hidden');
        }
        break;
      case 'fatal':
        empty.innerHTML = `<div class="fatal"><strong>Browser could not start</strong><p>${escapeHtml(message.message)}</p><code>npm install</code></div>`;
        setStatus('Setup required', 'error');
        break;
      case 'toast': showToast(message.message); break;
    }
  });

  function reportSize() {
    positionSelection();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const rect = stage.getBoundingClientRect();
      const width = Math.floor(rect.width), height = Math.floor(rect.height);
      const pixelRatio = Math.max(1, Math.min(4, Number(window.devicePixelRatio) || 1));
      const signature = `${width}:${height}:${pixelRatio}`;
      if (signature === lastReportedSize) return;
      lastReportedSize = signature;
      post('resize', { width, height, pixelRatio });
    }, 80);
  }
  new ResizeObserver(reportSize).observe(stage);
  window.addEventListener('resize', reportSize);

  setMode(mode);
  renderCaptures();
  reportSize();
}());
