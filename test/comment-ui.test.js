'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });
async function setup(t) {
  const page = await browser.newPage({viewport:{width:800,height:632}});
  t.after(()=>page.close());
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors, []));
  await page.addInitScript(()=>{ window.messages=[]; window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>{messages.push(m); window.hostMessage?.(m);}}); });
  let html=fs.readFileSync(path.join(root,'src/extension.js'),'utf8').split('return `<!doctype html>')[1].split('</html>`')[0];
  html='<!doctype html>'+html+'</html>';
  html=html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/,'').replace('${style}','http://test.local/media/browser.css').replace('${script}','http://test.local/media/browser.js');
  await page.route('http://test.local/**', route=>{ const name=new URL(route.request().url()).pathname; return route.fulfill({contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html',body:name==='/'?html:fs.readFileSync(path.join(root,name))}); });
  await page.goto('http://test.local/');
  await page.evaluate(()=>window.postMessage({type:'frame',width:800,height:600,url:'http://fixture.local/',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='},'*'));
  await page.locator('#add-context').click();
  return page;
}
async function pick(page,x=100,y=100) {
  await page.mouse.click(x,y);
  const request=await page.evaluate(()=>messages.filter(m=>m.type==='click').at(-1));
  assert.equal(request.mode,'select');
  await page.evaluate(request=>window.postMessage({type:'selected',requestId:request.requestId,element:{tag:'BUTTON',selector:'#target',rect:{x:90,y:60,width:120,height:30}}},'*'),request);
  await page.locator('#annotation').waitFor({state:'visible'});
  return request;
}
test('address bar shares the browser and reflects host sharing state', async t => {
  const page = await setup(t);
  await page.getByRole('button', { name: 'Share Browser with Codex', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Share this browser page with the agent?' });
  await confirmation.waitFor();
  assert.equal(await page.evaluate(() => messages.filter(m => m.type === 'shareBrowser').length), 0);
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  assert.equal(await page.evaluate(() => messages.filter(m => m.type === 'shareBrowser').length), 1);
  await page.evaluate(() => window.postMessage({ type: 'browserSharing', active: true }, '*'));
  const stop = page.getByRole('button', { name: 'Stop Sharing Browser with Codex', exact: true });
  await stop.waitFor();
  assert.equal(await stop.getAttribute('aria-pressed'), 'true');
  await stop.click();
  assert.equal(await page.evaluate(() => messages.filter(m => m.type === 'shareBrowser').length), 2);
  await page.locator('#more-toggle').click();
  await page.getByRole('menuitem', { name: 'Copy Address', exact: true }).click();
  assert.equal(await page.evaluate(() => messages.filter(m => m.type === 'copyUrl').length), 1);
});

test("share confirmation can be denied and remembers an allowed Don't ask again choice", async t => {
  const page = await setup(t);
  const share = page.getByRole('button', { name: 'Share Browser with Codex', exact: true });
  await share.click();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => messages.some(m => m.type === 'shareBrowser')), false);
  await share.click();
  await page.getByRole('checkbox', { name: "Don't ask again" }).check();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => messages.filter(m => m.type === 'shareBrowser').at(-1)), { type: 'shareBrowser', remember: true });
  await page.evaluate(() => window.postMessage({ type: 'browserSharing', active: false }, '*'));
  await share.click();
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => messages.filter(m => m.type === 'shareBrowser').at(-1)), { type: 'shareBrowser' });
});
test('outside click dismisses only the draft; next click selects another element',async t=>{
  const page=await setup(t); await pick(page); await page.locator('#annotation').fill('draft');
  const before=await page.evaluate(()=>messages.filter(m=>m.type==='click').length);
  await page.mouse.click(450,300);
  assert.equal(await page.locator('#draft').isVisible(),false);
  assert.equal(await page.locator('#stage').getAttribute('data-mode'),'select');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='click').length),before);
  await pick(page,450,300);
});
test('Escape dismisses draft first, then exits selection; never forwards Escape to page',async t=>{
  const page=await setup(t); await pick(page); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#draft').isVisible(),false);
  assert.equal(await page.locator('#stage').getAttribute('data-mode'),'select');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#stage').getAttribute('data-mode'),'browse');
  assert.equal(await page.locator('#select-mode').getAttribute('aria-checked'),'false');
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='key' && m.key==='Escape')),false);
});
test('late selection response after cancellation cannot reopen the composer',async t=>{
  const page=await setup(t); await page.mouse.click(100,100);
  const request=await page.evaluate(()=>messages.filter(m=>m.type==='click').at(-1));
  await page.keyboard.press('Escape');
  await page.evaluate(request=>window.postMessage({type:'selected',requestId:request.requestId,element:{tag:'DIV',rect:{x:10,y:10,width:50,height:30}}},'*'),request);
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#draft').isVisible(),false);
});
test('submitting keeps selection active and failure restores the comment for retry',async t=>{
  const page=await setup(t); await pick(page); await page.locator('#annotation').fill('Keep my feedback');
  await page.locator('#save-draft').click();
  assert.equal(await page.locator('#stage').getAttribute('data-mode'),'select');
  const capture=await page.evaluate(()=>messages.find(m=>m.type==='sendCapture').capture);
  await page.evaluate(id=>window.postMessage({type:'captureResult',id,success:false},'*'),capture.id);
  await page.locator('#annotation').waitFor({state:'visible'});
  assert.equal(await page.locator('#annotation').inputValue(),'Keep my feedback');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='sendCapture').length),2);
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='runCapture')),false);
  await page.evaluate(id=>window.postMessage({type:'captureResult',id,success:true},'*'),capture.id);
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#draft').isVisible(),false);
  assert.equal(await page.locator('.saved-marker, .saved-region, .marker-label').count(),0);
  await pick(page,450,300);
});
test('composer traps Tab, does not submit IME Enter, and click inside preserves draft',async t=>{
  const page=await setup(t); await pick(page); await page.locator('#annotation').fill('Text');
  await page.locator('#annotation').dispatchEvent('keydown',{key:'Enter',isComposing:true,bubbles:true});
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='sendCapture')),false);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#save-draft').evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#annotation').evaluate(e=>e===document.activeElement),true);
  await page.locator('#annotation').click(); assert.equal(await page.locator('#annotation').inputValue(),'Text');
});
test('scroll works while selecting; leaving viewport clears the hover',async t=>{
  const page=await setup(t); await page.mouse.move(100,100); await page.waitForTimeout(80);
  const req=await page.evaluate(()=>messages.filter(m=>m.type==='inspect').at(-1));
  await page.evaluate(requestId=>window.postMessage({type:'inspected',requestId,element:{tag:'DIV',rect:{x:20,y:20,width:100,height:20}}},'*'),req.requestId);
  await page.mouse.move(10,10); await page.waitForTimeout(20);
  assert.equal(await page.locator('#element-label').isVisible(),false);
  await page.mouse.move(100,100); await page.mouse.wheel(0,150);
  assert(await page.evaluate(()=>messages.some(m=>m.type==='wheel')));
});
test('navigation cancels stale drafts and responses',async t=>{
  const page=await setup(t); await pick(page); await page.locator('#annotation').fill('Old page');
  await page.evaluate(()=>window.postMessage({type:'pageReset'},'*')); await page.waitForTimeout(20);
  assert.equal(await page.locator('#draft').isVisible(),false);
});

test('area screenshot button uses a rectangle and opens an anchored comment', async t => {
  const page = await setup(t);
  await page.locator('#screenshot-menu-toggle').click();
  await page.locator('#area-capture').click();
  assert.equal(await page.locator('#area-capture').getAttribute('aria-checked'), 'true');
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(260, 220);
  assert.equal(await page.locator('#overlay .draft-region').evaluate(element => element.tagName.toLowerCase()), 'rect');
  assert.equal(await page.locator('#overlay ellipse.draft-region').count(), 0);
  await page.mouse.up();
  await page.locator('#annotation').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => messages.some(message => message.type === 'sendCapture')), false);
  await page.locator('#annotation').fill('Increase the spacing in this area');
  await page.keyboard.press('Enter');
  const capture = await page.evaluate(() => messages.find(message => message.type === 'sendCapture').capture);
  assert.equal(capture.kind, 'region');
  assert.equal(capture.annotation, 'Increase the spacing in this area');
});

test('screenshot shortcuts send the viewport or enter rectangular area mode', async t => {
  const page = await setup(t);
  assert.equal(await page.locator('#screenshot-shortcut').textContent(), 'Ctrl+Alt+S');
  assert.equal(await page.locator('#area-shortcut').textContent(), 'Ctrl+Alt+A');

  await page.keyboard.press('Control+Alt+S');
  assert.equal(await page.evaluate(() => messages.filter(message => message.type === 'screenshotCapture').length), 1);

  await page.keyboard.press('Control+Alt+A');
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'region');
  await page.mouse.move(120, 120);
  await page.mouse.down();
  await page.mouse.move(280, 230);
  assert.equal(await page.locator('#overlay rect.draft-region').count(), 1);
  await page.mouse.up();
  assert.equal(await page.locator('#annotation').isVisible(), true);
});

test('native-style browser menu and Chromium developer tools toggle are wired', async t => {
  const page = await setup(t);
  await page.locator('#context-menu-toggle').click();
  assert.deepEqual(await page.locator('#context-menu [role^="menuitem"]').allTextContents(), [
    'Add Element to ChatCtrl+Shift+C', 'Comment on ElementsCtrl+Alt+C',
    'Add Console Logs to Chat'
  ]);
  await page.locator('#more-toggle').click();
  assert.deepEqual(await page.locator('#more-menu [role="menuitem"]').allTextContents(), [
    'New TabCtrl+T', 'Zoom InCtrl++', 'Zoom OutCtrl+-', 'Reset ZoomCtrl+0', 'Find in PageCtrl+F',
    'Device Emulation', 'Open in External Browser', 'Copy Address', 'HistoryCtrl+Y', 'Add to FavoritesCtrl+D',
    'Site Permissions', 'Clear Storage (Workspace)', 'Browser Settings'
  ]);
  await page.locator('#zoom-in').click();
  assert.equal(await page.evaluate(() => messages.some(message => message.type === 'zoom' && message.action === 'in')), true);

  await page.locator('#devtools-toggle').click();
  assert.equal(await page.locator('#devtools-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => messages.some(message => message.type === 'devtools' && message.open)), true);
  assert.equal(await page.locator('#stage').evaluate(element => element.classList.contains('devtools-split')), true);
  assert.equal(await page.locator('#dock-splitter').isVisible(), true);
  await page.evaluate(() => window.postMessage({
    type: 'frame', width: 432, height: 600, devtoolsWidth: 364, devtoolsHeight: 600, splitRatio: .54,
    url: 'http://fixture.local/', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    devtoolsData: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  }, '*'));
  await page.mouse.click(700, 300);
  assert.equal(await page.evaluate(() => messages.filter(message => message.type === 'click').at(-1).surface), 'devtools');
  await page.mouse.click(200, 300);
  assert.equal(await page.evaluate(() => messages.filter(message => message.type === 'click').at(-1).surface), 'page');
  await page.evaluate(() => window.postMessage({ type: 'devtoolsVisibility', open: false }, '*'));
  await page.waitForFunction(() => document.getElementById('devtools-toggle').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.locator('#devtools-toggle').getAttribute('aria-pressed'), 'false');
});


test('rapid selections accept only the latest response and right-click never selects', async t => {
  const page=await setup(t);
  await page.mouse.click(100,100); await page.mouse.click(450,300);
  const [first,second]=await page.evaluate(()=>messages.filter(m=>m.type==='click'));
  for (const request of [second,first]) {
    await page.evaluate(request=>window.postMessage({type:'selected',requestId:request.requestId,element:{tag:'DIV',selector:String(request.x),displaySelector:String(request.x),rect:{x:10,y:10,width:20,height:20}}},'*'),request);
  }
  await page.waitForTimeout(20);
  assert.match(await page.locator('#element-label').textContent(),/450/);
  await page.keyboard.press('Escape');
  const count=await page.evaluate(()=>messages.filter(m=>m.type==='click').length);
  await page.mouse.click(200,200,{button:'right'});
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='click').length),count);
});

test('actual Chromium inspection and attachment round trip supports consecutive comments', async t => {
  const page=await setup(t);
  const target=await browser.newPage({viewport:{width:800,height:600}}); t.after(()=>target.close());
  await target.setContent('<button id="one" style="position:absolute;left:50px;top:50px;width:100px;height:30px" onclick="window.clicked=true">First</button><button id="two" style="position:absolute;left:350px;top:250px;width:100px;height:30px" onclick="window.clicked=true">Second</button>');
  const vm=require('node:vm'), {createRequire}=require('node:module');
  const filename=path.join(root,'src/extension.js'), localRequire=createRequire(filename);
  const context={require:name=>name==='vscode'?{}:localRequire(name),module:{exports:{}},Buffer};
  vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports.Panel=LiveBrowserPanel;',context);
  const panel=Object.create(context.module.exports.Panel.prototype);
  const attached=[];
  Object.assign(panel,{page:target,viewport:{width:800,height:600},selectionSnapshots:new Map(),post:message=>page.evaluate(message=>window.postMessage(message,'*'),message),sendCaptures:async captures=>{attached.push(...captures); return true;}});
  await page.exposeFunction('hostMessage', async message=>{ if (['click','inspect','sendCapture'].includes(message.type)) await panel.onMessage(message); });
  for (const [x,y,selector] of [[100,97,'#one'],[400,297,'#two']]) {
    await page.mouse.click(x,y);
    await page.locator('#annotation').waitFor({state:'visible'});
    await page.locator('#annotation').fill('Update '+selector);
    await page.locator('#save-draft').click();
    await page.waitForFunction(()=>document.getElementById('capture-count').textContent===String(window.messages.filter(m=>m.type==='sendCapture').length));
    assert.equal(attached.at(-1).element.selector,selector);
    assert(panel.selectionSnapshots.get(attached.at(-1).snapshotId).length>100);
  }
  await page.mouse.move(100,97); await page.mouse.down(); await page.mouse.move(400,297); await page.mouse.up();
  await page.locator('#annotation').waitFor({state:'visible'});
  assert.match(await page.locator('#element-label').textContent(), /body/);
  await page.keyboard.press('Escape');
  assert.equal(await target.evaluate(()=>!!window.clicked),false);
  assert.equal(await page.locator('#stage').getAttribute('data-mode'),'select');
});


test('dismissing the dropdown consumes the page click and double submit attaches only once',async t=>{
  const page=await setup(t);
  await page.locator('#context-menu-toggle').click();
  await page.mouse.click(450,300);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='click').length),0);
  await pick(page); await page.locator('#annotation').fill('Once only');
  await page.locator('#save-draft').dblclick();
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='sendCapture').length),1);
});
