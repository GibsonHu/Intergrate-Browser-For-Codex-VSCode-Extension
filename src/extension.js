'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalizeAddress, clamp, describeCapture, expandExecutablePath, chromeCandidates } = require('./helpers');

let currentPanel;
const browserPanels = new Set();
const temporaryCaptureDirectories = new Set();

function launcherItems(context, activePanel) {
  const configuredHomepage = vscode.workspace.getConfiguration('browser-annotator-for-codex').get('homepage', 'http://localhost:3000');
  const stored = context.globalState.get('recentPages', []);
  const recents = (Array.isArray(stored) ? stored : []).slice(0, 8);
  if (recents.length === 0 && configuredHomepage) recents.push({ title: 'Home', url: configuredHomepage });
  const openTabs = [...browserPanels]
    .filter(panel => panel !== activePanel && panel.page && !panel.closed && !panel.onStartPage)
    .map(panel => ({ id: panel.id, title: panel.pageTitle || panel.page.url(), url: panel.page.url() }))
    .filter(item => /^https?:/i.test(item.url));
  return { recents, openTabs };
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('browser-annotator-for-codex.open', async () => {
    if (currentPanel) {
      currentPanel.reveal();
      return;
    }
    await openBrowserPanel(context);
  }));
}

async function openBrowserPanel(context, forceNew = false) {
  if (currentPanel && !forceNew) {
    currentPanel.reveal();
    return currentPanel;
  }
  let panel;
  panel = new LiveBrowserPanel(context, () => {
    browserPanels.delete(panel);
    if (currentPanel === panel) currentPanel = [...browserPanels].at(-1);
  });
  browserPanels.add(panel);
  currentPanel = panel;
  await panel.start();
  return panel;
}

class LiveBrowserPanel {
  constructor(context, onDispose) {
    this.context = context;
    this.onDispose = onDispose;
    this.disposables = [];
    this.page = undefined;
    this.browser = undefined;
    this.timer = undefined;
    this.lastFrameHash = '';
    this.frameBusy = false;
    this.framePending = false;
    this.framePendingForce = false;
    this.capturePromise = undefined;
    this.pendingResize = undefined;
    this.resizePromise = undefined;
    this.closed = false;
    this.zoomPercent = 100;
    this.findQuery = '';
    this.emulatedViewport = undefined;
    this.viewport = { width: 1280, height: 760 };
    this.lastRequestedViewport = { ...this.viewport };
    this.displayScale = 1;
    this.appliedScale = 0;
    this.id = crypto.randomUUID();
    this.onStartPage = true;
    this.pageTitle = '';

    this.panel = vscode.window.createWebviewPanel(
      'browser-annotator-for-codex',
      'Browser',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', 'codex-browser.png');
    this.panel.webview.html = this.webviewHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(message => this.onMessage(message))
    );
  }

  reveal() {
    this.panel.reveal(vscode.ViewColumn.One);
  }

  async start() {
    try {
      const { chromium } = require('playwright-core');
      const configured = expandExecutablePath(
        vscode.workspace.getConfiguration('browser-annotator-for-codex').get('chromeExecutable', ''),
        process.platform,
        process.env,
        os.homedir()
      );
      const executablePath = configured || await findChrome();
      if (!executablePath) {
        throw new Error('Chrome/Chromium was not found. Set browser-annotator-for-codex.chromeExecutable in Settings.');
      }
      this.browser = await chromium.launch({
        headless: true,
        executablePath,
        args: process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []
      });
      const configuredScale = Number(vscode.workspace.getConfiguration('browser-annotator-for-codex').get('renderScale', 0));
      this.configuredScale = configuredScale > 0 ? clamp(configuredScale, 1, 4) : 0;
      const browserContext = await this.browser.newContext({
        viewport: this.viewport,
        deviceScaleFactor: this.configuredScale || this.displayScale,
        ignoreHTTPSErrors: vscode.workspace.getConfiguration('browser-annotator-for-codex').get('ignoreHttpsErrors', true)
      });
      this.browserContext = browserContext;
      this.page = await browserContext.newPage();
      this.cdp = await browserContext.newCDPSession(this.page);
      this.appliedScale = this.configuredScale || this.displayScale;
      this.page.on('framenavigated', frame => {
        if (frame === this.page.mainFrame()) { this.post({ type: 'pageReset' }); this.postState(); }
      });
      this.page.on('load', async () => {
        await this.applyZoom();
        await this.captureFrame(true);
      });
      this.page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      this.page.on('popup', popup => {
        popup.url() && this.navigate(popup.url());
        popup.close().catch(() => {});
      });
      this.page.on('crash', () => this.post({ type: 'error', message: 'The browser page crashed. Reload it to continue.' }));

      const interval = clamp(vscode.workspace.getConfiguration('browser-annotator-for-codex').get('refreshInterval', 1000), 500, 5000);
      this.timer = setInterval(() => this.captureFrame(false), interval);
      this.post({ type: 'startPage', ...launcherItems(this.context, this) });
      this.post({ type: 'ready' });
    } catch (error) {
      const detail = String(error && error.message || error);
      this.post({ type: 'fatal', message: detail });
    }
  }

  async navigate(address) {
    if (!this.page) return;
    const url = normalizeAddress(address);
    this.onStartPage = false;
    this.post({ type: 'pageReset' });
    this.post({ type: 'loading', value: true });
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      if (!String(error.message).includes('net::ERR_ABORTED')) {
        this.post({ type: 'error', message: String(error.message || error) });
      }
    } finally {
      await this.postState();
      await this.captureFrame(true);
      this.post({ type: 'loading', value: false });
    }
  }

  async onMessage(message) {
    if (!message || this.closed) return;
    try {
      switch (message.type) {
        case 'navigate': await this.navigate(message.url); break;
        case 'getLauncherData': this.post({ type: 'launcherData', ...launcherItems(this.context, this) }); break;
        case 'openTab': {
          const target = [...browserPanels].find(panel => panel.id === message.id && !panel.closed);
          if (target) target.reveal();
          break;
        }
        case 'back': case 'forward': case 'reload':
          if (this.page) {
            this.post({ type: 'pageReset' });
            this.post({ type: 'loading', value: true });
            try {
              const method = { back: 'goBack', forward: 'goForward', reload: 'reload' }[message.type];
              await this.page[method]({ waitUntil: 'domcontentloaded', timeout: 30000 });
            } finally {
              await this.postState();
              await this.captureFrame(true);
              this.post({ type: 'loading', value: false });
            }
          }
          break;
        case 'stop': if (this.cdp) await this.cdp.send('Page.stopLoading'); break;
        case 'copyUrl': if (this.page) { await vscode.env.clipboard.writeText(this.page.url()); this.post({ type: 'toast', message: 'Address copied' }); } break;
        case 'external': if (this.page && /^https?:/.test(this.page.url())) await vscode.env.openExternal(vscode.Uri.parse(this.page.url())); break;
        case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'browser-annotator-for-codex'); break;
        case 'newTab': await openBrowserPanel(this.context, true); break;
        case 'zoom': await this.setZoom(message.action); break;
        case 'findInPage': await this.findInPage(); break;
        case 'deviceEmulation': await this.chooseDeviceEmulation(); break;
        case 'history': await this.showHistory(); break;
        case 'favorite': await this.addFavorite(); break;
        case 'permissions': await this.managePermissions(); break;
        case 'clearStorage': await this.clearStorage(); break;
        case 'resize': await this.resize(message.width, message.height, message.pixelRatio); break;
        case 'click': await this.click(message); break;
        case 'inspect': await this.inspect(message.x, message.y, false, message.requestId); break;
        case 'wheel': {
          await this.page.mouse.wheel(message.dx || 0, message.dy || 0);
          await this.captureFrame(true);
          break;
        }
        case 'key': await this.key(message); break;
        case 'screenshotCapture': await this.sendCaptures([{ kind: 'screenshot', region: { x: 0, y: 0, ...this.viewport } }]); break;
        case 'sendCapture': {
          const success = await this.sendCaptures([message.capture]);
          this.post({ type: 'captureResult', id: message.capture?.id, success: success === true });
          break;
        }
        case 'sendAll': await this.sendCaptures(Array.isArray(message.captures) ? message.captures : []); break;
        case 'copyCapture': await vscode.env.clipboard.writeText(describeCapture(message.capture, '')); this.post({ type: 'toast', message: 'Context copied to clipboard' }); break;
      }
    } catch (error) {
      if (message.type === 'sendCapture') this.post({ type: 'captureResult', id: message.capture?.id, success: false });
      this.post({ type: 'error', message: String(error && error.message || error) });
    }
  }

  async resize(width, height, pixelRatio) {
    if (Number.isFinite(pixelRatio)) this.displayScale = clamp(pixelRatio, 1, 4);
    this.pendingResize = {
      width: Math.round(clamp(width, 1, 3840)),
      height: Math.round(clamp(height, 1, 2160))
    };
    if (!this.page) {
      this.lastRequestedViewport = this.pendingResize;
      this.viewport = { ...this.pendingResize };
      this.pendingResize = undefined;
      return;
    }
    if (!this.resizePromise) {
      this.resizePromise = this.flushResize().finally(() => { this.resizePromise = undefined; });
    }
    await this.resizePromise;
  }

  async flushResize() {
    do {
      while (this.pendingResize) {
        this.lastRequestedViewport = this.pendingResize;
        this.pendingResize = undefined;
        await this.applyViewportLayout();
      }
      await this.captureFrame(true);
    } while (this.pendingResize);
  }

  async applyViewportLayout() {
    const next = this.emulatedViewport || this.lastRequestedViewport;
    const scale = this.configuredScale || this.displayScale;
    if (next.width !== this.viewport.width || next.height !== this.viewport.height || scale !== this.appliedScale) {
      this.viewport = { ...next };
      this.appliedScale = scale;
      await this.page.setViewportSize(next);
      if (this.cdp) {
        await this.cdp.send('Emulation.setDeviceMetricsOverride', {
          width: next.width,
          height: next.height,
          deviceScaleFactor: scale,
          mobile: false
        });
      }
    }
  }

  async setZoom(action) {
    if (!this.page) return;
    const next = action === 'reset' ? 100 : clamp(this.zoomPercent + (action === 'in' ? 10 : -10), 25, 500);
    this.zoomPercent = next;
    await this.applyZoom();
    this.post({ type: 'toast', message: `Zoom ${next}%` });
    await this.captureFrame(true);
  }

  async applyZoom() {
    if (!this.page) return;
    await this.page.evaluate(percent => { document.documentElement.style.zoom = percent === 100 ? '' : `${percent}%`; }, this.zoomPercent).catch(() => {});
  }

  async findInPage() {
    if (!this.page) return;
    const query = await vscode.window.showInputBox({ title: 'Find in Page', prompt: 'Text to find', value: this.findQuery, ignoreFocusOut: true });
    if (query === undefined) return;
    this.findQuery = query;
    const found = query && await this.page.evaluate(text => typeof window.find === 'function' && window.find(text, false, false, true, false, true, false), query);
    this.post({ type: 'toast', message: found ? `Found “${query}”` : `No matches for “${query}”` });
    await this.captureFrame(true);
  }

  async chooseDeviceEmulation() {
    if (!this.page) return;
    const choices = [
      { label: 'Responsive', description: 'Use the available browser panel size' },
      { label: 'iPhone 14', description: '390 × 844', viewport: { width: 390, height: 844 } },
      { label: 'Pixel 7', description: '412 × 915', viewport: { width: 412, height: 915 } },
      { label: 'iPad Mini', description: '768 × 1024', viewport: { width: 768, height: 1024 } },
      { label: 'Desktop 1440p', description: '1440 × 900', viewport: { width: 1440, height: 900 } }
    ];
    const choice = await vscode.window.showQuickPick(choices, { title: 'Device Emulation', placeHolder: 'Choose a viewport' });
    if (!choice) return;
    this.emulatedViewport = choice.viewport;
    await this.applyViewportLayout();
    this.post({ type: 'toast', message: choice.viewport ? choice.label : 'Responsive viewport' });
    await this.captureFrame(true);
  }

  async showHistory() {
    if (!this.page || !this.cdp) return;
    const history = await this.cdp.send('Page.getNavigationHistory');
    const choices = history.entries.slice().reverse().map(entry => ({
      label: entry.title || entry.url,
      description: entry.url,
      entryId: entry.id
    }));
    const choice = await vscode.window.showQuickPick(choices, { title: 'History', placeHolder: 'Open a previously visited page' });
    if (!choice) return;
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: choice.entryId });
    await this.postState();
    await this.captureFrame(true);
  }

  async addFavorite() {
    if (!this.page) return;
    const url = this.page.url();
    const title = await this.page.title().catch(() => url);
    const favorites = this.context.globalState.get('favorites', []).filter(item => item.url !== url);
    favorites.unshift({ url, title, addedAt: new Date().toISOString() });
    await this.context.globalState.update('favorites', favorites.slice(0, 100));
    this.post({ type: 'toast', message: 'Added to favorites' });
  }

  async managePermissions() {
    if (!this.page || !this.browserContext) return;
    let origin;
    try { origin = new URL(this.page.url()).origin; } catch { return; }
    const choices = [
      { label: 'Reset permissions', reset: true },
      { label: 'Allow clipboard access', permissions: ['clipboard-read', 'clipboard-write'] },
      { label: 'Allow camera and microphone', permissions: ['camera', 'microphone'] },
      { label: 'Allow notifications', permissions: ['notifications'] },
      { label: 'Allow geolocation', permissions: ['geolocation'] }
    ];
    const choice = await vscode.window.showQuickPick(choices, { title: `Site Permissions — ${origin}`, placeHolder: 'Choose a permission action' });
    if (!choice) return;
    if (choice.reset) await this.browserContext.clearPermissions();
    else await this.browserContext.grantPermissions(choice.permissions, { origin });
    this.post({ type: 'toast', message: choice.reset ? 'Permissions reset' : `${choice.label} for ${origin}` });
  }

  async clearStorage() {
    if (!this.page || !this.browserContext) return;
    await this.browserContext.clearCookies();
    await this.page.evaluate(async () => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try { if (globalThis.caches) for (const key of await caches.keys()) await caches.delete(key); } catch {}
      try {
        if (globalThis.indexedDB && indexedDB.databases) {
          for (const database of await indexedDB.databases()) if (database.name) indexedDB.deleteDatabase(database.name);
        }
      } catch {}
      try { if (navigator.serviceWorker) for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); } catch {}
    });
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    this.post({ type: 'toast', message: 'Site storage cleared' });
    await this.captureFrame(true);
  }

  async click(message) {
    if (!this.page) return;
    if (message.mode === 'select' || message.mode === 'element') {
      await this.inspect(message.x, message.y, true, message.requestId, message.selectionRegion);
      return;
    }
    await this.page.mouse.click(message.x, message.y, { button: message.button === 2 ? 'right' : 'left' });
    await this.captureFrame(true);
    await this.postState();
  }

  async key(message) {
    if (!this.page) return;
    if (message.text) await this.page.keyboard.insertText(String(message.text));
    else if (message.key) await this.page.keyboard.press(String(message.key));
    await this.captureFrame(true);
  }

  async inspect(x, y, selected, requestId, selectionRegion) {
    if (!this.page) return;
    const result = await this.page.evaluate(({ x, y, selectionRegion }) => {
      let node = document.elementFromPoint(x, y);
      if (selectionRegion) {
        const r = selectionRegion;
        const points = [[r.x, r.y], [r.x + r.width - 1, r.y], [r.x, r.y + r.height - 1], [r.x + r.width - 1, r.y + r.height - 1]];
        const elements = points.map(([px, py]) => document.elementFromPoint(px, py)).filter(Boolean);
        node = elements[0];
        while (node && !elements.every(element => node.contains(element))) node = node.parentElement;
      }
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const cssEscape = value => {
        if (globalThis.CSS && CSS.escape) return CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
      };
      const selectorFor = element => {
        if (element.id) return `#${cssEscape(element.id)}`;
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 6) {
          let part = current.tagName.toLowerCase();
          const stable = ['data-testid', 'data-test', 'name', 'aria-label'].find(name => current.hasAttribute(name));
          if (stable) {
            const value = String(current.getAttribute(stable)).replace(/"/g, '\\"');
            part += `[${stable}="${value}"]`;
            parts.unshift(part);
            break;
          }
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(item => item.tagName === current.tagName) : [];
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const labelledBy = node.getAttribute('aria-labelledby');
      const labelledText = labelledBy ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() : '';
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
      return {
        tag: node.tagName,
        displaySelector: node.tagName.toLowerCase() + (node.id ? `#${node.id}` : Array.from(node.classList).slice(0, 2).map(name => `.${name}`).join('')),
        selector: selectorFor(node),
        text,
        accessibleName: node.getAttribute('aria-label') || labelledText || node.getAttribute('alt') || node.getAttribute('title') || text.slice(0, 160),
        role: node.getAttribute('role') || '',
        html: node.outerHTML.slice(0, 6000),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    }, { x, y, selectionRegion });
    this.post({ type: selected ? 'selected' : 'inspected', element: result, requestId });
  }

  async captureFrame(force) {
    if (!this.page || this.closed || this.onStartPage || !this.panel.visible) return;
    if (this.frameBusy) {
      this.framePending = true;
      this.framePendingForce ||= force;
      return this.capturePromise;
    }
    this.frameBusy = true;
    this.capturePromise = (async () => {
      let shouldForce = force;
      do {
        this.framePending = false;
        shouldForce ||= this.framePendingForce;
        this.framePendingForce = false;
        await this.captureFrameOnce(shouldForce);
        shouldForce = false;
      } while (this.framePending && !this.closed && this.panel.visible);
    })();
    try {
      await this.capturePromise;
    } finally {
      this.frameBusy = false;
      this.capturePromise = undefined;
    }
  }

  async captureFrameOnce(force) {
    const viewport = { ...this.viewport };
    try {
      const buffer = await this.page.screenshot({ type: 'jpeg', quality: 86, scale: 'device', animations: 'allow' });
      const hash = crypto.createHash('sha1').update(buffer).digest('hex');
      if (force || hash !== this.lastFrameHash) {
        this.lastFrameHash = hash;
        this.post({
          type: 'frame',
          data: buffer.toString('base64'),
          width: viewport.width,
          height: viewport.height,
          url: this.page.url(),
          title: await this.page.title().catch(() => '')
        });
      }
    } catch (error) {
      if (!this.closed) this.post({ type: 'error', message: String(error.message || error) });
    }
  }

  async postState() {
    if (!this.page) return;
    const title = await this.page.title().catch(() => '');
    this.pageTitle = title;
    this.panel.title = title ? title.slice(0, 52) : 'Browser';
    const history = this.cdp ? await this.cdp.send('Page.getNavigationHistory').catch(() => null) : null;
    this.post({ type: 'state', url: this.page.url(), title, canGoBack: !!history && history.currentIndex > 0, canGoForward: !!history && history.currentIndex < history.entries.length - 1 });
    const url = this.page.url();
    if (/^https?:/i.test(url)) {
      const stored = this.context.globalState.get('recentPages', []);
      const recents = (Array.isArray(stored) ? stored : []).filter(item => item && item.url !== url);
      recents.unshift({ url, title: title || url, visitedAt: new Date().toISOString() });
      await this.context.globalState.update('recentPages', recents.slice(0, 20));
    }
  }

  async sendCaptures(captures) {
    if (!this.page || captures.length === 0) return;
    const commands = await vscode.commands.getCommands(true);
    const canAttach = commands.includes('chatgpt.addFileToThread');
    const workspaceFolder = (vscode.workspace.workspaceFolders || []).find(folder => folder.uri.scheme === 'file');
    if (!workspaceFolder) {
      const combined = captures.map(capture => fallbackCaptureText(capture)).join('\n\n---\n\n');
      await vscode.env.clipboard.writeText(combined);
      this.post({ type: 'toast', message: 'Open a folder first; context copied to clipboard' });
      vscode.window.showWarningMessage('Codex can only resolve generated browser captures from an open workspace folder. Context was copied to the clipboard.');
      return;
    }

    if (!this.captureStoragePath) {
      this.captureStoragePath = path.join(
        os.tmpdir(),
        `integrated-browser-for-codex-${crypto.randomBytes(8).toString('hex')}`
      );
      temporaryCaptureDirectories.add(this.captureStoragePath);
    }
    const storage = vscode.Uri.file(this.captureStoragePath);
    await vscode.workspace.fs.createDirectory(storage);
    const created = [];

    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      if (!capture) continue;
      capture.url = capture.url || this.page.url();
      capture.title = capture.title || await this.page.title().catch(() => '');
      const stamp = `${Date.now()}-${index + 1}`;
      const baseName = capture.annotation ? `browser-change-${stamp}` : `browser-${stamp}`;
      const imageName = ['screenshot', 'region', 'drawing'].includes(capture.kind) ? `${baseName}.png` : '';
      const imageUri = vscode.Uri.joinPath(storage, imageName);
      if (imageName) {
        const image = capture.kind === 'drawing' && capture.imageData
          ? Buffer.from(capture.imageData, 'base64')
          : await this.page.screenshot({ type: 'png', clip: clipForCapture(capture, this.viewport), animations: 'disabled' });
        await vscode.workspace.fs.writeFile(imageUri, image);
      }
      // Element captures are readable Markdown context. Area and
      // viewport captures are intentionally image-only.
      if (capture.kind === 'element') {
        const markdownUri = vscode.Uri.joinPath(storage, `${baseName}.md`);
        await vscode.workspace.fs.writeFile(markdownUri, Buffer.from(describeCapture(capture, imageName), 'utf8'));
        created.push(markdownUri);
      }
      if (imageName) created.push(imageUri);
    }

    if (canAttach) {
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      for (const uri of created) await vscode.commands.executeCommand('chatgpt.addFileToThread', uri);
      const prompt = captures.map(capture => capturePrompt(capture)).filter(Boolean).join('\n\n');
      if (prompt) {
        await vscode.env.clipboard.writeText(prompt);
        let pasted = false;
        for (let attempt = 0; attempt < 3 && !pasted; attempt += 1) {
          try {
            await vscode.commands.executeCommand('chatgpt.openSidebar');
            // Webview focus and Codex's composer autofocus happen asynchronously.
            await new Promise(resolve => setTimeout(resolve, 350));
            if (this.closed || vscode.window.state?.focused === false) throw new Error('Window lost focus');
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            pasted = true;
          } catch {
            // Focus can race with the Codex webview. Retry without reattaching files.
          }
        }
        if (!pasted) {
          // Attachments already succeeded. Do not restore the draft and duplicate them.
          this.post({ type: 'toast', message: 'Files attached; automatic paste failed. Your comment is on the clipboard if copying succeeded.' });
          return true;
        }
        return true;
      }
      this.post({
        type: 'toast',
        message: `Added ${captures.length} capture${captures.length === 1 ? '' : 's'} to Codex`
      });
      return true;
    } else {
      const combined = captures.map(capture => fallbackCaptureText(capture)).join('\n\n---\n\n');
      await vscode.env.clipboard.writeText(combined);
      this.post({ type: 'toast', message: 'Codex is unavailable; context copied to clipboard' });
      vscode.window.showWarningMessage('Install/enable the OpenAI Codex extension to attach browser context. The context was copied instead.');
    }
  }

  post(message) {
    if (!this.closed) this.panel.webview.postMessage(message);
  }

  webviewHtml() {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'browser.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'browser.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>Browser Annotator for Codex</title>
</head>
<body>
  <header class="toolbar">
    <div class="nav-group">
      <button id="back" class="icon-button" title="Back (Alt+Left)" aria-label="Back" disabled><span class="icon arrow-left" aria-hidden="true"></span></button>
      <button id="forward" class="icon-button" title="Forward (Alt+Right)" aria-label="Forward" disabled><span class="icon arrow-right" aria-hidden="true"></span></button>
      <button id="reload" class="icon-button" title="Reload" aria-label="Reload"><span class="icon refresh" aria-hidden="true"></span></button>
    </div>
    <form id="address-form"><input id="address" autocomplete="off" spellcheck="false" aria-label="Address" aria-autocomplete="list" aria-controls="address-suggestions" aria-expanded="false" placeholder="Search or enter URL"></form>
    <div id="codex-actions" class="codex-actions" role="group" aria-label="Add browser context to Codex">
      <button id="add-context" title="Comment on Element" aria-label="Comment on Element" aria-pressed="false"><span class="icon comment" aria-hidden="true"></span></button>
    </div>
    <div class="screenshot-actions">
      <button id="screenshot-primary" class="icon-button" title="Comment on Screenshot Area" aria-label="Comment on Screenshot Area" aria-pressed="false"><span class="icon screenshot-area" aria-hidden="true"></span></button>
      <button id="draw-primary" class="icon-button" title="Draw on Browser Screenshot (left-drag to draw, right-click to comment)" aria-label="Draw on Browser Screenshot" aria-pressed="false"><span class="icon pencil" aria-hidden="true"></span></button>
    </div>
    <div class="browser-more">
      <button id="more-toggle" class="icon-button" title="More Actions" aria-label="More Actions" aria-haspopup="menu" aria-expanded="false"><span class="icon ellipsis" aria-hidden="true"></span></button>
      <div id="more-menu" class="context-menu hidden" role="menu">
        <button id="new-tab" role="menuitem"><span>New Tab</span><span id="new-tab-shortcut" class="shortcut">Ctrl+T</span></button>
        <div class="menu-separator" role="separator"></div>
        <button id="zoom-in" role="menuitem"><span>Zoom In</span><span id="zoom-in-shortcut" class="shortcut">Ctrl++</span></button>
        <button id="zoom-out" role="menuitem"><span>Zoom Out</span><span id="zoom-out-shortcut" class="shortcut">Ctrl+-</span></button>
        <button id="zoom-reset" role="menuitem"><span>Reset Zoom</span><span id="zoom-reset-shortcut" class="shortcut">Ctrl+0</span></button>
        <div class="menu-separator" role="separator"></div>
        <button id="find-page" role="menuitem"><span>Find in Page</span><span id="find-shortcut" class="shortcut">Ctrl+F</span></button>
        <button id="device-emulation" role="menuitem">Device Emulation</button>
        <button id="external" role="menuitem">Open in External Browser</button>
        <button id="copy-url" role="menuitem">Copy Address</button>
        <div class="menu-separator" role="separator"></div>
        <button id="history" role="menuitem"><span>History</span><span id="history-shortcut" class="shortcut">Ctrl+Y</span></button>
        <button id="favorite" role="menuitem"><span>Add to Favorites</span><span id="favorite-shortcut" class="shortcut">Ctrl+D</span></button>
        <button id="permissions" role="menuitem">Site Permissions</button>
        <button id="clear-storage" role="menuitem">Clear Storage (Workspace)</button>
        <div class="menu-separator" role="separator"></div>
        <button id="settings" role="menuitem">Browser Settings</button>
      </div>
    </div>
  </header>
  <div id="address-suggestions" class="address-suggestions hidden" role="listbox" aria-label="Address suggestions"></div>
  <main>
    <section id="stage" tabindex="0" aria-label="Live browser viewport">
      <img id="frame" alt="Live browser page">
      <svg id="overlay" aria-hidden="true"></svg>
      <div id="empty"><div class="spinner"></div><p>Starting Chromium…</p></div>
    </section>
    <div id="draft" class="draft hidden" role="group" aria-label="Add a comment to selected element">
      <textarea id="annotation" rows="1" aria-label="Add a comment" placeholder="Add a comment" title="Enter to add to the current Codex composer; Shift+Enter for a new line; Escape to cancel"></textarea>
      <button id="save-draft" class="icon-button" title="Add to Current Codex Composer" aria-label="Add to Current Codex Composer"><span class="icon add" aria-hidden="true"></span></button>
    </div>
  </main>
  <span id="capture-count" class="hidden">0</span>
  <div id="status" role="status"><span id="status-dot"></span><span id="status-text">Launching browser</span></div>
  <div id="toast" role="status"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.captureStoragePath) {
      const storagePath = this.captureStoragePath;
      this.captureStoragePath = undefined;
      temporaryCaptureDirectories.delete(storagePath);
      await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});
    }
    this.onDispose();
  }
}

function clipForCapture(capture, viewport) {
  const source = capture.kind === 'element' ? capture.element && capture.element.rect : capture.region;
  const padding = capture.kind === 'element' ? 18 : 0;
  const x = clamp((source && source.x || 0) - padding, 0, viewport.width - 1);
  const y = clamp((source && source.y || 0) - padding, 0, viewport.height - 1);
  const width = clamp((source && source.width || 1) + padding * 2, 1, viewport.width - x);
  const height = clamp((source && source.height || 1) + padding * 2, 1, viewport.height - y);
  return { x, y, width, height };
}

function capturePrompt(capture) {
  const annotation = String(capture.annotation || '').trim();
  if (annotation) return annotation;
  if (capture.kind === 'screenshot') return `Browser screenshot: ${capture.url || ''}`.trim();
  return '';
}

function fallbackCaptureText(capture) {
  if (capture.kind === 'element' || capture.kind === 'console') return describeCapture(capture, '');
  return capturePrompt(capture) || `Browser screenshot: ${capture.url || ''}`.trim();
}

async function findChrome() {
  for (const candidate of chromeCandidates(process.platform, process.env, os.homedir())) {
    try { await fs.access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return '';
}

async function deactivate() {
  await Promise.all([...browserPanels].map(panel => panel.dispose()));
  await Promise.all([...temporaryCaptureDirectories].map(async storagePath => {
    await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});
    temporaryCaptureDirectories.delete(storagePath);
  }));
}

module.exports = { activate, deactivate, clipForCapture };
