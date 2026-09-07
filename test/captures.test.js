'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness(availableCommands = ['chatgpt.addFileToThread']) {
  const writes = new Map(), commands = [], clips = [], posts = [];
  const vscode = {
    env: { clipboard: { writeText: async text => commands.push(['clipboard.writeText', text]) } },
    Uri: { file: value => value, joinPath: (base, ...parts) => path.join(base, ...parts) },
    workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/workspace', toString: () => '/workspace' } }], fs: {
      createDirectory: async () => {}, writeFile: async (uri, bytes) => writes.set(uri, bytes)
    } },
    commands: { getCommands: async () => availableCommands, executeCommand: async (...args) => commands.push(args) },
    window: { showInformationMessage() {} }
  };
  vscode.Uri.joinPath = (base, ...parts) => path.join(String(base), ...parts);
  const filename = path.resolve(__dirname, '../src/extension.js');
  const localRequire = createRequire(filename);
  const context = { require: name => name === 'vscode' ? vscode : localRequire(name), module: { exports: {} }, Buffer, setTimeout };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.Panel = LiveBrowserPanel;', context, { filename });
  const panel = Object.create(context.module.exports.Panel.prototype);
  Object.assign(panel, { viewport: { width: 800, height: 600 }, post(message) { posts.push(message); }, page: {
    url: () => 'http://localhost:2333/', title: async () => 'Demo', screenshot: async options => { clips.push(options.clip); return Buffer.from('png'); }
  } });
  return { panel, writes, commands, clips, posts, vscode };
}

test('comment is pasted verbatim after attachments and focus without starting a chat', async () => {
  const { panel, commands } = harness();
  await panel.sendCaptures([{ kind: 'element', annotation: 'what is this?\nExplain it.', element: { tag: 'DIV', rect: { x: 0, y: 0, width: 10, height: 10 } } }]);
  const names = commands.map(([name]) => name);
  assert.deepEqual(names, ['chatgpt.openSidebar', 'chatgpt.addFileToThread',
    'clipboard.writeText', 'chatgpt.openSidebar', 'editor.action.clipboardPasteAction']);
  assert.equal(commands[2][1], 'what is this?\nExplain it.');
});

test('paste failure retries three times before showing the fallback message', async () => {
  const { panel, commands, posts, vscode } = harness();
  vscode.commands.executeCommand = async (...args) => {
    commands.push(args);
    if (args[0] === 'editor.action.clipboardPasteAction') throw new Error('Paste unavailable');
  };
  await panel.onMessage({ type: 'sendCapture', capture: { id: 'paste-failure', kind: 'screenshot', annotation: 'Explain this' } });
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 1);
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

test('viewport screenshot is image-only, while annotated element attaches only Markdown', async () => {
  const { panel, writes, commands, clips } = harness();
  await panel.onMessage({ type: 'screenshotCapture' });
  assert.equal(clips[0].width, 800);
  assert.equal(clips[0].height, 600);
  assert.equal(writes.size, 1);
  assert([...writes.keys()].every(name => name.startsWith(os.tmpdir())));
  assert([...writes.keys()].every(name => name.endsWith('.png')));
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
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 2);
});

test('area screenshot attaches only its PNG and pastes the area comment', async () => {
  const { panel, writes, commands } = harness();
  await panel.onMessage({ type: 'sendCapture', capture: {
    kind: 'region', annotation: 'Make this panel more compact', region: { x: 8, y: 12, width: 160, height: 90 }
  } });
  assert.equal(writes.size, 1);
  assert([...writes.keys()].every(name => name.endsWith('.png')));
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 1);
  assert.equal(commands.find(([name]) => name === 'clipboard.writeText')[1], 'Make this panel more compact');
});

test('drawing capture attaches the supplied full-screen markup PNG and pastes its comment', async () => {
  const { panel, writes, commands, clips } = harness();
  const markedImage = Buffer.from('full marked-up browser image');
  await panel.onMessage({ type: 'sendCapture', capture: {
    kind: 'drawing', annotation: 'Use this marked area', imageData: markedImage.toString('base64'),
    path: [{ x: 10, y: 10 }, { x: 50, y: 50 }], region: { x: 3, y: 3, width: 54, height: 54 }
  } });
  assert.equal(writes.size, 1);
  assert.deepEqual([...writes.values()][0], markedImage);
  assert.equal(clips.length, 0);
  assert.equal(commands.find(([name]) => name === 'clipboard.writeText')[1], 'Use this marked area');
});

test('full screenshot attaches only its PNG and adds a brief URL prompt', async () => {
  const { panel, writes, commands } = harness();
  await panel.onMessage({ type: 'screenshotCapture' });
  assert.equal(writes.size, 1);
  assert([...writes.keys()].every(name => name.endsWith('.png')));
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 1);
  assert.equal(commands.find(([name]) => name === 'clipboard.writeText')[1], 'Browser screenshot: http://localhost:2333/');
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
  const storagePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'integrated-browser-for-codex-test-'));
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

test('comment capture never invokes the Codex TODO workflow', async () => {
  const { panel, writes, commands, posts } = harness(['chatgpt.addFileToThread', 'chatgpt.implementTodo']);
  await panel.onMessage({ type: 'sendCapture', capture: {
    id: 'attach-me', kind: 'element', annotation: 'Make this button blue',
    element: { tag: 'BUTTON', selector: '#save', rect: { x: 20, y: 20, width: 80, height: 30 } }
  } });
  assert.equal(writes.size, 1);
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 1);
  assert.equal(commands.some(([name]) => name === 'chatgpt.implementTodo'), false);
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
