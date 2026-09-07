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
  Object.assign(panel, { consoleLogs: [], selectionSnapshots: new Map(), viewport: { width: 800, height: 600 }, post(message) { posts.push(message); }, page: {
    url: () => 'http://localhost:2333/', title: async () => 'Demo', screenshot: async options => { clips.push(options.clip); return Buffer.from('png'); }
  } });
  return { panel, writes, commands, clips, posts, vscode };
}

test('comment is pasted verbatim after attachments and focus without starting a chat', async () => {
  const { panel, commands } = harness();
  await panel.sendCaptures([{ kind: 'element', annotation: 'what is this?\nExplain it.', element: { tag: 'DIV', rect: { x: 0, y: 0, width: 10, height: 10 } } }]);
  const names = commands.map(([name]) => name);
  assert.deepEqual(names, ['chatgpt.openSidebar', 'chatgpt.addFileToThread', 'chatgpt.addFileToThread',
    'clipboard.writeText', 'chatgpt.openSidebar', 'editor.action.clipboardPasteAction']);
  assert.equal(commands[3][1], 'what is this?\nExplain it.');
});

test('paste failure keeps successful attachments acknowledged without retrying', async () => {
  const { panel, commands, posts, vscode } = harness();
  vscode.commands.executeCommand = async (...args) => {
    commands.push(args);
    if (args[0] === 'editor.action.clipboardPasteAction') throw new Error('Paste unavailable');
  };
  await panel.onMessage({ type: 'sendCapture', capture: { id: 'paste-failure', kind: 'screenshot', annotation: 'Explain this' } });
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 1);
  assert(posts.some(post => post.type === 'captureResult' && post.success));
  assert(posts.some(post => /automatic paste failed/.test(post.message || '')));
});

test('console attachment records bounded logs and attaches Markdown without a screenshot', async () => {
  const { panel, writes, commands, clips } = harness();
  for (let i = 0; i < 502; i++) panel.recordConsole('error', `Failure ${i}`);
  assert.equal(panel.consoleLogs.length, 500);
  assert.equal(panel.consoleLogs[0].text, 'Failure 2');
  await panel.onMessage({ type: 'consoleCapture' });
  assert.equal(writes.size, 1);
  assert.match([...writes.values()][0].toString(), /Failure 501/);
  assert.equal(clips.length, 0);
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 1);
  assert([...writes.keys()].every(uri => uri.startsWith(path.join(os.homedir(), '.intergrate-browser-for-codex', 'captures'))));
});

test('viewport screenshot is image-only, while annotated element attaches image and Markdown', async () => {
  const { panel, writes, commands, clips } = harness();
  await panel.onMessage({ type: 'screenshotCapture' });
  assert.equal(clips[0].width, 800);
  assert.equal(clips[0].height, 600);
  assert.equal(writes.size, 1);
  assert([...writes.keys()].every(name => name.endsWith('.png')));
  writes.clear();
  await panel.onMessage({ type: 'sendCapture', capture: { kind: 'element', annotation: 'Remove this', element: {
    tag: 'DIV', selector: '.badge', rect: { x: 24, y: 40, width: 100, height: 27 }
  } } });
  assert.equal(writes.size, 2);
  const markdown = [...writes.entries()].find(([name]) => name.endsWith('.md'))[1].toString();
  assert.match(markdown, /Remove this/);
  assert.match(markdown, /\.badge/);
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 3);
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

test('full screenshot attaches only its PNG and adds a brief URL prompt', async () => {
  const { panel, writes, commands } = harness();
  await panel.onMessage({ type: 'screenshotCapture' });
  assert.equal(writes.size, 1);
  assert([...writes.keys()].every(name => name.endsWith('.png')));
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 1);
  assert.equal(commands.find(([name]) => name === 'clipboard.writeText')[1], 'Browser screenshot: http://localhost:2333/');
});


test('attachment uses selection-time screenshot and acknowledges success', async () => {
  const { panel, writes, clips, posts } = harness();
  panel.selectionSnapshots.set('snapshot', Buffer.from('selected pixels'));
  await panel.onMessage({type: 'sendCapture', capture: { id: 'comment-1', kind: 'element', snapshotId: 'snapshot', annotation: 'Change', element: { tag: 'DIV', rect: {x:0,y:0,width:10,height:10} } }});
  assert.equal(clips.length, 0);
  assert.equal([...writes.entries()].find(([name])=>name.endsWith('.png'))[1].toString(), 'selected pixels');
  assert(posts.some(message=>message.type==='captureResult' && message.id==='comment-1' && message.success));
});

test('attachment exceptions are acknowledged so the UI can restore the draft', async () => {
  const { panel, posts } = harness();
  panel.sendCaptures = async () => { throw new Error('attachment failed'); };
  await panel.onMessage({type:'sendCapture',capture:{id:'retry-me'}});
  assert(posts.some(message=>message.type==='captureResult' && message.id==='retry-me' && message.success===false));
});

test('comment capture never invokes the Codex TODO workflow', async () => {
  const { panel, writes, commands, posts } = harness(['chatgpt.addFileToThread', 'chatgpt.implementTodo']);
  panel.selectionSnapshots.set('snapshot', Buffer.from('selected pixels'));
  await panel.onMessage({ type: 'sendCapture', capture: {
    id: 'attach-me', kind: 'element', snapshotId: 'snapshot', annotation: 'Make this button blue',
    element: { tag: 'BUTTON', selector: '#save', rect: { x: 20, y: 20, width: 80, height: 30 } }
  } });
  assert.equal(writes.size, 2);
  assert.equal(commands.filter(([name]) => name === 'chatgpt.addFileToThread').length, 2);
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

test('docked developer tools publishes page and Chromium frames together', async () => {
  const { panel, posts } = harness();
  Object.assign(panel, {
    panel: { visible: true }, frameBusy: false, closed: false, lastFrameHash: '', devtoolsOpen: true,
    viewport: { width: 432, height: 600 }, lastRequestedViewport: { width: 800, height: 600 }, devtoolsSplitRatio: .54,
    page: { url: () => 'http://localhost:2333/', title: async () => 'Demo', screenshot: async () => Buffer.from('page pixels') },
    devtoolsPage: { isClosed: () => false, screenshot: async () => Buffer.from('devtools pixels') }
  });
  await panel.captureFrame(true);
  const frame = posts.find(message => message.type === 'frame');
  assert.equal(Buffer.from(frame.data, 'base64').toString(), 'page pixels');
  assert.equal(Buffer.from(frame.devtoolsData, 'base64').toString(), 'devtools pixels');
  assert.equal(frame.width, 432);
  assert.equal(frame.devtoolsWidth, 364);
});
