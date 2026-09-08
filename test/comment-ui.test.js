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
async function setup(t, { sendFrame = true } = {}) {
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
  if (sendFrame) await page.evaluate(()=>window.postMessage({type:'frame',width:800,height:600,url:'http://fixture.local/',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='},'*'));
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
test('address bar has no browser sharing control and Copy Address remains available', async t => {
  const page = await setup(t);
  assert.equal(await page.locator('#share-browser, #share-confirmation').count(), 0);
  await page.locator('#more-toggle').click();
  await page.getByRole('menuitem', { name: 'Copy Address', exact: true }).click();
  assert.equal(await page.evaluate(() => messages.filter(m => m.type === 'copyUrl').length), 1);
});
test('browser fills the webview and shows page scroll position', async t => {
  const page = await setup(t);
  assert.deepEqual(await page.locator('body').evaluate(element => {
    const style = getComputedStyle(element);
    return { margin: style.margin, padding: style.padding };
  }), { margin: '0px', padding: '0px' });
  await page.evaluate(() => window.postMessage({
    type: 'frame', width: 800, height: 600, url: 'http://fixture.local/',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    scroll: { top: 600, viewport: 600, total: 2400 }
  }, '*'));
  const scrollbar = page.locator('#page-scrollbar');
  assert.equal(await scrollbar.evaluate(element => element.classList.contains('visible')), true);
  assert.equal(await scrollbar.evaluate(element => getComputedStyle(element).opacity), '0');
  await scrollbar.hover();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('page-scrollbar')).opacity === '1');
  const thumb = await page.locator('#page-scrollbar-thumb').boundingBox();
  assert(thumb.height >= 24);
  assert(thumb.y > 100);
});
test('page scrollbar supports track clicks, thumb dragging, and keyboard scrolling', async t => {
  const page = await setup(t);
  await page.mouse.move(400, 300);
  await page.evaluate(() => window.postMessage({
    type: 'frame', width: 800, height: 600, url: 'http://fixture.local/',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    scroll: { top: 0, viewport: 600, total: 2400 }
  }, '*'));
  const track = await page.locator('#page-scrollbar').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + track.height * .75);
  let request = await page.evaluate(() => messages.filter(message => message.type === 'scrollTo').at(-1));
  assert(request.top > 1200);

  const thumb = await page.locator('#page-scrollbar-thumb').boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, track.y + 20);
  await page.mouse.up();
  request = await page.evaluate(() => messages.filter(message => message.type === 'scrollTo').at(-1));
  assert(request.top < 100);

  await page.locator('#page-scrollbar').press('End');
  request = await page.evaluate(() => messages.filter(message => message.type === 'scrollTo').at(-1));
  assert.equal(request.top, 1800);
});
test('new browser shows recent pages and open tabs in the address dropdown', async t => {
  const page = await setup(t);
  await page.evaluate(() => window.postMessage({
    type: 'startPage',
    recents: [{ title: 'Google', url: 'https://www.google.com/' }, { title: 'ARDY Streaming Control', url: 'http://localhost:2333/' }],
    openTabs: [{ id: 'tab-1', title: 'Azure DevOps Services', url: 'https://dev.azure.com/' }]
  }, '*'));
  await page.locator('#address-suggestions').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.suggestion-heading strong').allTextContents(), ['Recents', 'Open Tabs']);
  assert.deepEqual(await page.locator('.suggestion-title').allTextContents(), ['Google', 'ARDY Streaming Control', 'Azure DevOps Services']);
  assert.equal(await page.locator('#address').getAttribute('aria-expanded'), 'true');

  await page.getByRole('option', { name: /Google/ }).click();
  assert.equal(await page.evaluate(() => messages.some(message => message.type === 'navigate' && message.url === 'https://www.google.com/')), true);
  assert.equal(await page.locator('#address-suggestions').isVisible(), false);
});

test('address dropdown filters, supports keyboard selection, and switches open tabs', async t => {
  const page = await setup(t);
  await page.evaluate(() => window.postMessage({
    type: 'startPage',
    recents: [{ title: 'Google', url: 'https://www.google.com/' }],
    openTabs: [{ id: 'tab-azure', title: 'Azure DevOps Services', url: 'https://dev.azure.com/' }]
  }, '*'));
  await page.locator('#address-suggestions').waitFor({ state: 'visible' });
  await page.locator('#address').fill('azure');
  assert.equal(await page.locator('#address').inputValue(), 'azure');
  assert.deepEqual(await page.locator('.suggestion-title').allTextContents(), ['Azure DevOps Services']);
  await page.locator('#address').press('ArrowDown');
  await page.locator('#address').press('Enter');
  assert.equal(await page.evaluate(() => messages.some(message => message.type === 'openTab' && message.id === 'tab-azure')), true);
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
  assert.equal(await page.locator('#add-context').getAttribute('aria-pressed'),'false');
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
  assert.equal(await page.locator('#toast').evaluate(element=>element.classList.contains('visible')),false);
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
test('an initial page error is shown in the browser instead of as a popup',async t=>{
  const page=await setup(t,{sendFrame:false});
  await page.evaluate(()=>window.postMessage({type:'error',message:'net::ERR_CONNECTION_REFUSED'},'*'));
  await page.locator('#empty .fatal').waitFor({state:'visible'});
  assert.equal(await page.locator('#empty strong').textContent(),'Page could not load');
  assert.equal(await page.locator('#toast').evaluate(element=>element.classList.contains('visible')),false);
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
  assert.equal(await page.locator('#element-label').count(), 0);
  await page.mouse.move(100,100); await page.mouse.wheel(0,150);
  const wheel = await page.evaluate(()=>messages.findLast(m=>m.type==='wheel'));
  assert.equal(wheel.x, 100);
  assert.equal(wheel.dy, 150);
});
test('navigation cancels stale drafts and responses',async t=>{
  const page=await setup(t); await pick(page); await page.locator('#annotation').fill('Old page');
  await page.evaluate(()=>window.postMessage({type:'pageReset'},'*')); await page.waitForTimeout(20);
  assert.equal(await page.locator('#draft').isVisible(),false);
});

test('area screenshot button uses a rectangle and opens an anchored comment', async t => {
  const page = await setup(t);
  await page.locator('#screenshot-primary').click();
  assert.equal(await page.locator('#screenshot-primary').getAttribute('aria-pressed'), 'true');
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

test('pencil supports multiple left-button strokes and opens its comment on right-click', async t => {
  const page = await setup(t);
  await page.waitForFunction(() => document.getElementById('frame').naturalWidth > 0);
  await page.locator('#draw-primary').click();
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'draw');
  assert.equal(await page.locator('#draw-primary').getAttribute('aria-pressed'), 'true');

  await page.mouse.move(120, 120);
  await page.mouse.down();
  await page.mouse.move(180, 155);
  await page.mouse.move(250, 130);
  await page.mouse.up();

  assert.equal(await page.locator('#annotation').isVisible(), false);
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'draw');
  assert.equal(await page.locator('#overlay path.ink-path').count(), 1);

  await page.mouse.move(300, 180);
  await page.mouse.down();
  await page.mouse.move(360, 220);
  await page.mouse.up();

  assert.equal(await page.locator('#annotation').isVisible(), false);
  assert.equal(await page.locator('#overlay path.ink-path').count(), 2);
  await page.mouse.click(380, 240, { button: 'right' });

  await page.locator('#annotation').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'browse');
  assert.equal(await page.locator('#overlay path.ink-path').count(), 2);
  await page.locator('#annotation').fill('Move this content lower');
  await page.keyboard.press('Enter');
  const capture = await page.evaluate(() => messages.find(message => message.type === 'sendCapture' && message.capture.kind === 'drawing').capture);
  assert.equal(capture.annotation, 'Move this content lower');
  assert.match(capture.imageData, /^iVBOR/);
  assert.equal(capture.paths.length, 2);
  assert(capture.paths.every(path => path.length >= 2));
});

test('screenshot area and comment element controls switch modes visibly', async t => {
  const page = await setup(t);
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'select');
  assert.equal(await page.locator('#add-context').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#screenshot-primary').getAttribute('aria-pressed'), 'false');

  await page.locator('#screenshot-primary').click();
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'region');
  assert.equal(await page.locator('#add-context').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#screenshot-primary').getAttribute('aria-pressed'), 'true');

  await page.locator('#add-context').click();
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'select');
  assert.equal(await page.locator('#add-context').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#screenshot-primary').getAttribute('aria-pressed'), 'false');
});

test('screenshot shortcuts send the viewport or enter rectangular area mode', async t => {
  const page = await setup(t);
  assert.equal(await page.locator('#context-menu-toggle, #context-menu, #screenshot-menu-toggle, #screenshot-menu').count(), 0);
  await page.locator('#screenshot-primary').click();
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'region');
  assert.equal(await page.evaluate(() => messages.filter(message => message.type === 'screenshotCapture').length), 0);
  await page.locator('#screenshot-primary').click();
  assert.equal(await page.locator('#stage').getAttribute('data-mode'), 'browse');

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

test('overflow menu remains while icon dropdown menus, developer tools, and sharing are absent', async t => {
  const page = await setup(t);
  assert.equal(await page.locator('#context-menu-toggle, #context-menu, #screenshot-menu-toggle, #screenshot-menu').count(), 0);
  await page.locator('#more-toggle').click();
  assert.deepEqual(await page.locator('#more-menu [role="menuitem"]').allTextContents(), [
    'New TabCtrl+T', 'Zoom InCtrl++', 'Zoom OutCtrl+-', 'Reset ZoomCtrl+0', 'Find in PageCtrl+F',
    'Device Emulation', 'Open in External Browser', 'Copy Address', 'HistoryCtrl+Y', 'Add to FavoritesCtrl+D',
    'Site Permissions', 'Clear Storage (Workspace)', 'Browser Settings'
  ]);
  await page.locator('#zoom-in').click();
  assert.equal(await page.evaluate(() => messages.some(message => message.type === 'zoom' && message.action === 'in')), true);

  assert.equal(await page.locator('#devtools-toggle, #devtools-frame, #dock-splitter, #share-browser').count(), 0);
  assert.equal(await page.evaluate(() => messages.some(message => ['devtools', 'shareBrowser'].includes(message.type))), false);
});


test('rapid selections accept only the latest response and right-click never selects', async t => {
  const page=await setup(t);
  await page.mouse.click(100,100); await page.mouse.click(450,300);
  const [first,second]=await page.evaluate(()=>messages.filter(m=>m.type==='click'));
  for (const request of [second,first]) {
    await page.evaluate(request=>window.postMessage({type:'selected',requestId:request.requestId,element:{tag:'DIV',selector:String(request.x),displaySelector:String(request.x),rect:{x:10,y:10,width:20,height:20}}},'*'),request);
  }
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#element-label').count(), 0);
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
  Object.assign(panel,{page:target,viewport:{width:800,height:600},post:message=>page.evaluate(message=>window.postMessage(message,'*'),message),sendCaptures:async captures=>{attached.push(...captures); return true;}});
  await page.exposeFunction('hostMessage', async message=>{ if (['click','inspect','sendCapture'].includes(message.type)) await panel.onMessage(message); });
  for (const [x,y,selector] of [[100,97,'#one'],[400,297,'#two']]) {
    await page.mouse.click(x,y);
    await page.locator('#annotation').waitFor({state:'visible'});
    await page.locator('#annotation').fill('Update '+selector);
    await page.locator('#save-draft').click();
    await page.waitForFunction(()=>document.getElementById('capture-count').textContent===String(window.messages.filter(m=>m.type==='sendCapture').length));
    assert.equal(attached.at(-1).element.selector,selector);
    assert.equal(attached.at(-1).snapshotId, undefined);
  }
  await page.mouse.move(100,97); await page.mouse.down(); await page.mouse.move(400,297); await page.mouse.up();
  await page.locator('#annotation').waitFor({state:'visible'});
  assert.equal(await page.locator('#element-label').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await target.evaluate(()=>!!window.clicked),false);
  assert.equal(await page.locator('#stage').getAttribute('data-mode'),'select');
});


test('dismissing the overflow menu consumes the page click and double submit attaches only once',async t=>{
  const page=await setup(t);
  await page.locator('#more-toggle').click();
  await page.mouse.click(450,300);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='click').length),0);
  await pick(page); await page.locator('#annotation').fill('Once only');
  await page.locator('#save-draft').dblclick();
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='sendCapture').length),1);
});
