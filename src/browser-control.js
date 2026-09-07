'use strict';
// Dependency-free CLI, usable by Codex's terminal tool in the extension host.
const fs = require('fs');
const http = require('http');

async function main() {
  const [sessionFile, action, value, extra] = process.argv.slice(2);
  if (!sessionFile || !action) throw new Error('Usage: node browser-control.js SESSION inspect|screenshot FILE|navigate URL|click SELECTOR|fill SELECTOR TEXT|press KEY|scroll Y');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const endpoint = new URL(session.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/action') throw new Error('Invalid local browser endpoint.');
  const args = { action };
  if (action === 'navigate') args.url = value;
  if (action === 'click' || action === 'fill') args.selector = value;
  if (action === 'fill') args.text = extra;
  if (action === 'press') args.key = value;
  if (action === 'scroll') args.y = Number(value);
  if (action === 'screenshot' && !value) throw new Error('Specify a new screenshot output filename.');
  const result = await new Promise((resolve, reject) => {
    const request = http.request(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { const data = JSON.parse(body); if (response.statusCode !== 200) reject(new Error(data.error)); else resolve(data); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(new Error('Browser action timed out.')));
    request.on('error', reject);
    request.end(JSON.stringify(args));
  });
  if (result.image) {
    fs.writeFileSync(value, Buffer.from(result.image, 'base64'), { flag: 'wx' });
    console.log(JSON.stringify({ screenshot: require('path').resolve(value) }));
  } else console.log(JSON.stringify(result));
}
main().catch(error => { console.error(`Browser control: ${error.message}`); process.exitCode = 1; });
