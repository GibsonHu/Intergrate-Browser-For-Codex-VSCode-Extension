'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness(availableCommands = ['claude-vscode.focus']) {
  const writes = new Map(), commands = [], clips = [], posts = [], mouseMoves = [], mouseWheels = [], shownDocuments = [], hiddenDocuments = [];
  const vscode = {
    env: { clipboard: { writeText: async text => commands.push(['clipboard.writeText', text]) } },
    Uri: { file: value => value, joinPath: (base, ...parts) => path.join(base, ...parts) },
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/workspace', toString: () => '/workspace' } }],
      asRelativePath: uri => path.relative('/workspace', String(uri)),
      openTextDocument: async uri => ({ uri }),
      fs: { createDirectory: async () => {}, writeFile: async (uri, bytes) => writes.set(uri, bytes) }
    },
    commands: { getCommands: async () => availableCommands, executeCommand: async (...args) => commands.push(args) },
    window: {
      state: { focused: true },
      showInformationMessage() {},
      showWarningMessage() {},
      showTextDocument: async document => {
        shownDocuments.push(document.uri);
        return { hide: () => hiddenDocuments.push(document.uri) };
      }
    }
  };
  vscode.Uri.joinPath = (base, ...parts) => path.join(String(base), ...parts);
  const filename = path.resolve(__dirname, '../src/extension.js');
  const localRequire = createRequire(filename);
  const context = { require: name => name === 'vscode' ? vscode : localRequire(name), module: { exports: {} }, Buffer, setTimeout };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.Panel = LiveBrowserPanel;', context, { filename });
  const panel = Object.create(context.module.exports.Panel.prototype);
  Object.assign(panel, { viewport: { width: 800, height: 600 }, post(message) { posts.push(message); }, page: {
    url: () => 'http://localhost:2333/', title: async () => 'Demo', screenshot: async options => { clips.push(options.clip); return Buffer.from('png'); },
    mouse: {
      move: async (x, y) => mouseMoves.push([x, y]),
      wheel: async (dx, dy) => mouseWheels.push([dx, dy])
    }
  } });
  return { panel, writes, commands, clips, posts, mouseMoves, mouseWheels, shownDocuments, hiddenDocuments, vscode };
}

test('wheel input moves Chromium cursor to the hovered point before scrolling', async () => {
  const { panel, mouseMoves, mouseWheels } = harness();
  panel.captureFrame = async () => {};
  await panel.onMessage({ type: 'wheel', x: 240, y: 360, dx: 5, dy: 180 });
  assert.deepEqual(mouseMoves, [[240, 360]]);
  assert.deepEqual(mouseWheels, [[5, 180]]);
});

test('scrollbar input sets the document scroll position and refreshes the frame', async () => {
  const { panel } = harness();
  let evaluatedTop;
  let captures = 0;
  panel.page.evaluate = async (_callback, top) => { evaluatedTop = top; };
  panel.captureFrame = async force => { if (force) captures++; };
  await panel.onMessage({ type: 'scrollTo', top: 975 });
  assert.equal(evaluatedTop, 975);
  assert.equal(captures, 1);
});

test('comment and capture references are pasted after Claude focus without opening editors', async () => {
  const { panel, commands, shownDocuments, hiddenDocuments } = harness();
  await panel.sendCaptures([{ kind: 'element', annotation: 'what is this?\nExplain it.', element: { tag: 'DIV', rect: { x: 0, y: 0, width: 10, height: 10 } } }]);
  const names = commands.map(([name]) => name);
  assert.deepEqual(names, ['claude-vscode.focus', 'clipboard.writeText',
    'claude-vscode.focus', 'editor.action.clipboardPasteAction']);
  assert.equal(shownDocuments.length, 0);
  assert.deepEqual(hiddenDocuments, shownDocuments);
  assert.match(commands[1][1], /^what is this\?\nExplain it\./);
  assert.match(commands[1][1], /@\.claude-browser-captures\/.+\.md/);
});

test('paste failure retries three times before showing the fallback message', async () => {
  const { panel, commands, posts, vscode } = harness();
  vscode.commands.executeCommand = async (...args) => {
    commands.push(args);
    if (args[0] === 'editor.action.clipboardPasteAction') throw new Error('Paste unavailable');
  };
  await panel.onMessage({ type: 'sendCapture', capture: { id: 'paste-failure', kind: 'screenshot', annotation: 'Explain this' } });
  assert.equal(commands.filter(([name]) => name === 'claude-vscode.insertAtMention').length, 0);
  assert.equal(commands.filter(([name]) => name === 'editor.action.clipboardPasteAction').length, 3);
  assert(posts.some(post => post.type === 'captureResult' && post.success));
  assert(posts.some(post => /automatic paste failed/.test(post.message || '')));
});

test('a successful paste retry does not show a popup', async () => {
  const { panel, commands, posts, vscode } = harness();
  let pasteAttempts = 0;
  vscode.commands.executeCommand = async (...args) => {
    commands.push(args);
    if (args[0] === 'editor.action.clipboardPasteAction' && ++pasteAttempts < 3) throw new Error('Paste unavailable');
  };
  await panel.onMessage({ type: 'sendCapture', capture: { id: 'paste-retry', kind: 'screenshot', annotation: 'Explain this' } });
  assert.equal(pasteAttempts, 3);
  assert.equal(posts.some(post => post.type === 'toast'), false);
  assert(posts.some(post => post.type === 'captureResult' && post.success));
});

test('viewport screenshot includes PNG and Markdown, while annotated element attaches only Markdown', async () => {
  const { panel, writes, commands, clips } = harness();
  await panel.onMessage({ type: 'screenshotCapture' });
  assert.equal(clips[0].width, 800);
  assert.equal(clips[0].height, 600);
  assert.equal(writes.size, 2);
  assert([...writes.keys()].every(name => name.startsWith('/workspace/.claude-browser-captures/')));
  assert([...writes.keys()].some(name => name.endsWith('.png')));
  assert([...writes.keys()].some(name => name.endsWith('.md')));
  writes.clear();
  await panel.onMessage({ type: 'sendCapture', capture: { kind: 'element', annotation: 'Remove this', element: {
    tag: 'DIV', selector: '.badge', rect: { x: 24, y: 40, width: 100, height: 27 }
  } } });
  assert.equal(writes.size, 1);
  assert.equal(clips.length, 1);
  assert([...writes.keys()].every(name => name.endsWith('.md')));
  const markdown = [...writes.entries()].find(([name]) => name.endsWith('.md'))[1].toString();
  assert.match(markdown, /Remove this/);
  assert.match(markdown, /\.badge/);
  assert.equal(commands.filter(([name]) => name === 'claude-vscode.insertAtMention').length, 0);
});

test('area screenshot includes PNG and Markdown references after the exact comment', async () => {
  const { panel, writes, commands } = harness();
  await panel.onMessage({ type: 'sendCapture', capture: {
    kind: 'region', annotation: 'Make this panel more compact', region: { x: 8, y: 12, width: 160, height: 90 }
  } });
  assert.equal(writes.size, 2);
  assert([...writes.keys()].some(name => name.endsWith('.png')));
  const markdown = [...writes.entries()].find(([name]) => name.endsWith('.md'))[1].toString();
  assert.match(markdown, /Make this panel more compact/);
  assert.match(markdown, /Viewport region: x=8, y=12, width=160, height=90/);
  assert.match(markdown, /!\[Captured browser context\]\(.+\.png\)/);
  assert.match(markdown, /implement it, and test the result/);
  assert.equal(commands.filter(([name]) => name === 'claude-vscode.insertAtMention').length, 0);
  const pasted = commands.find(([name]) => name === 'clipboard.writeText')[1];
  assert.match(pasted, /^Make this panel more compact/);
  assert.match(pasted, /@\.claude-browser-captures\/.+\.md/);
  assert.match(pasted, /@\.claude-browser-captures\/.+\.png/);
});

test('drawing capture attaches the supplied markup PNG and Markdown context', async () => {
  const { panel, writes, commands, clips } = harness();
  const markedImage = Buffer.from('full marked-up browser image');
  await panel.onMessage({ type: 'sendCapture', capture: {
    kind: 'drawing', annotation: 'Use this marked area', imageData: markedImage.toString('base64'),
    path: [{ x: 10, y: 10 }, { x: 50, y: 50 }], region: { x: 3, y: 3, width: 54, height: 54 }
  } });
  assert.equal(writes.size, 2);
  assert.deepEqual([...writes.entries()].find(([name]) => name.endsWith('.png'))[1], markedImage);
  const markdown = [...writes.entries()].find(([name]) => name.endsWith('.md'))[1].toString();
  assert.match(markdown, /Use this marked area/);
  assert.match(markdown, /Kind: drawing/);
  assert.match(markdown, /!\[Captured browser context\]\(.+\.png\)/);
  assert.equal(clips.length, 0);
  assert.match(commands.find(([name]) => name === 'clipboard.writeText')[1], /^Use this marked area/);
});

test('full screenshot attaches PNG and Markdown and adds a brief URL prompt', async () => {
  const { panel, writes, commands } = harness();
  await panel.onMessage({ type: 'screenshotCapture' });
  assert.equal(writes.size, 2);
  assert([...writes.keys()].some(name => name.endsWith('.png')));
  assert([...writes.keys()].some(name => name.endsWith('.md')));
  assert.equal(commands.filter(([name]) => name === 'claude-vscode.insertAtMention').length, 0);
  assert.match(commands.find(([name]) => name === 'clipboard.writeText')[1], /^Browser screenshot: http:\/\/localhost:2333\//);
});


test('element comment attaches Markdown without taking a screenshot and acknowledges success', async () => {
  const { panel, writes, clips, posts } = harness();
  await panel.onMessage({type: 'sendCapture', capture: { id: 'comment-1', kind: 'element', annotation: 'Change', element: { tag: 'DIV', rect: {x:0,y:0,width:10,height:10} } }});
  assert.equal(clips.length, 0);
  assert.equal(writes.size, 1);
  assert([...writes.keys()].every(name => name.endsWith('.md')));
  assert(posts.some(message=>message.type==='captureResult' && message.id==='comment-1' && message.success));
});

test('closing a browser panel removes its temporary capture directory', async () => {
  const { panel } = harness();
  const storagePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-browser-test-'));
  await fs.promises.writeFile(path.join(storagePath, 'capture.md'), 'temporary');
  Object.assign(panel, {
    captureStoragePath: storagePath,
    closed: false,
    disposables: [],
    browser: undefined,
    onDispose() {}
  });
  await panel.dispose();
  await assert.rejects(fs.promises.access(storagePath));
});

test('attachment exceptions are acknowledged so the UI can restore the draft', async () => {
  const { panel, posts } = harness();
  panel.sendCaptures = async () => { throw new Error('attachment failed'); };
  await panel.onMessage({type:'sendCapture',capture:{id:'retry-me'}});
  assert(posts.some(message=>message.type==='captureResult' && message.id==='retry-me' && message.success===false));
});

test('comment capture never starts a new Claude conversation', async () => {
  const { panel, writes, commands, posts } = harness(['claude-vscode.focus', 'claude-vscode.newConversation']);
  await panel.onMessage({ type: 'sendCapture', capture: {
    id: 'attach-me', kind: 'element', annotation: 'Make this button blue',
    element: { tag: 'BUTTON', selector: '#save', rect: { x: 20, y: 20, width: 80, height: 30 } }
  } });
  assert.equal(writes.size, 1);
  assert.equal(commands.filter(([name]) => name === 'claude-vscode.insertAtMention').length, 0);
  assert.equal(commands.some(([name]) => name === 'claude-vscode.newConversation'), false);
  assert(posts.some(message => message.type === 'captureResult' && message.id === 'attach-me' && message.success));
});

test('visible browser publishes a new frame whenever the rendered page changes', async () => {
  const { panel, posts } = harness();
  let pixels = 'first frame';
  Object.assign(panel, {
    panel: { visible: true },
    frameBusy: false,
    closed: false,
    lastFrameHash: '',
    page: {
      url: () => 'http://localhost:2333/',
      title: async () => 'Demo',
      screenshot: async () => Buffer.from(pixels)
    }
  });
  await panel.captureFrame(false);
  await panel.captureFrame(false);
  pixels = 'changed frame';
  await panel.captureFrame(false);
  assert.equal(posts.filter(message => message.type === 'frame').length, 2);
});

test('published frames include the document scroll position and extent', async () => {
  const { panel, posts } = harness();
  Object.assign(panel, {
    panel: { visible: true },
    frameBusy: false,
    closed: false,
    lastFrameHash: '',
    page: {
      url: () => 'http://localhost:2333/',
      title: async () => 'Long page',
      screenshot: async () => Buffer.from('scroll frame'),
      evaluate: async () => ({ top: 420, viewport: 600, total: 2400 })
    }
  });
  await panel.captureFrame(true);
  assert.deepEqual(posts.find(message => message.type === 'frame').scroll, { top: 420, viewport: 600, total: 2400 });
});

test('a forced frame requested during capture is queued instead of dropped', async () => {
  const { panel, posts } = harness();
  let releaseFirst;
  let screenshots = 0;
  Object.assign(panel, {
    panel: { visible: true }, frameBusy: false, framePending: false, framePendingForce: false,
    closed: false, lastFrameHash: '',
    page: {
      url: () => 'http://localhost:2333/', title: async () => 'Demo',
      screenshot: async () => {
        screenshots++;
        if (screenshots === 1) await new Promise(resolve => { releaseFirst = resolve; });
        return Buffer.from(`frame ${screenshots}`);
      }
    }
  });
  const first = panel.captureFrame(false);
  while (!releaseFirst) await new Promise(resolve => setTimeout(resolve, 0));
  const queued = panel.captureFrame(true);
  releaseFirst();
  await Promise.all([first, queued]);
  assert.equal(screenshots, 2);
  assert.equal(posts.filter(message => message.type === 'frame').length, 2);
});

test('responsive resize applies the current display pixel ratio', async () => {
  const { panel } = harness();
  const metrics = [];
  const viewportSizes = [];
  Object.assign(panel, {
    configuredScale: 0,
    displayScale: 1,
    appliedScale: 1,
    lastRequestedViewport: { width: 800, height: 600 },
    page: {
      setViewportSize: async value => viewportSizes.push(value),
      screenshot: async () => Buffer.from('frame'),
      url: () => 'http://localhost:2333/',
      title: async () => 'Demo'
    },
    cdp: { send: async (method, value) => metrics.push([method, value]) },
    captureFrame: async () => {}
  });
  await panel.resize(900, 700, 2);
  assert.equal(panel.viewport.width, 900);
  assert.equal(panel.viewport.height, 700);
  assert.equal(panel.appliedScale, 2);
  assert.equal(viewportSizes[0].width, 900);
  assert.equal(viewportSizes[0].height, 700);
  assert.equal(metrics[0][0], 'Emulation.setDeviceMetricsOverride');
  assert.equal(metrics[0][1].width, 900);
  assert.equal(metrics[0][1].height, 700);
  assert.equal(metrics[0][1].deviceScaleFactor, 2);
  assert.equal(metrics[0][1].mobile, false);
});
