'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

async function startBrowserShare(panel) {
  const token = crypto.randomBytes(32).toString('hex');
  let active = true;
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (!active || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return reply(403, { error: 'Browser sharing is not authorized.' });
    if (req.method !== 'POST' || req.url !== '/action') return reply(404, { error: 'Unknown endpoint.' });
    if (busy) return reply(409, { error: 'Another browser action is in progress. Retry after it completes.' });
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) throw new Error('Request too large.');
      }
      if (!active || panel.closed) throw new Error('Browser sharing has stopped.');
      const result = await browserAction(panel, JSON.parse(body));
      reply(200, result);
    } catch (error) { reply(400, { error: error.message }); }
    finally { busy = false; }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/action`, token,
    close() { active = false; server.close(); server.closeAllConnections?.(); }
  };
}

async function browserAction(panel, args) {
  const page = panel.page;
  if (!page || page.isClosed()) throw new Error('The shared page is closed.');
  const locator = () => {
    if (typeof args.selector !== 'string' || !args.selector) throw new Error('Provide a selector from inspect.');
    return page.locator(args.selector);
  };
  switch (args.action) {
    case 'inspect': return { url: page.url(), title: await page.title(), snapshot: await page.locator('body').ariaSnapshot({ timeout: 10000 }) };
    case 'screenshot': return { image: (await page.screenshot({ type: 'png', timeout: 10000 })).toString('base64') };
    case 'navigate': {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS navigation is supported.');
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 }); break;
    }
    case 'click': await locator().click({ timeout: 10000 }); break;
    case 'fill':
      if (typeof args.text !== 'string') throw new Error('Provide text to fill.');
      await locator().fill(args.text, { timeout: 10000 }); break;
    case 'press':
      if (typeof args.key !== 'string') throw new Error('Provide a key such as Enter or Tab.');
      await page.keyboard.press(args.key); break;
    case 'scroll':
      if (!Number.isFinite(args.y) || Math.abs(args.y) > 10000) throw new Error('Provide a scroll distance between -10000 and 10000.');
      await page.mouse.wheel(0, args.y); break;
    default: throw new Error('Unknown action. Use inspect, screenshot, navigate, click, fill, press, or scroll.');
  }
  await panel.postState();
  await panel.captureFrame(true);
  return { url: page.url(), success: true };
}

module.exports = { startBrowserShare, browserAction };
