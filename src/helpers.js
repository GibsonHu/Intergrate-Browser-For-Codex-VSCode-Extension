'use strict';

const path = require('node:path');

function expandExecutablePath(value, platform, environment, homeDirectory) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let result = String(value || '').trim();
  result = result.replace(/\$\{env:([^}]+)\}/g, (match, name) => environment[name] || match);
  if (platform === 'win32') result = result.replace(/%([^%]+)%/g, (match, name) => environment[name] || match);
  if (result === '~') return homeDirectory;
  if (/^~[\\/]/.test(result)) return pathApi.join(homeDirectory, result.slice(2));
  return result;
}

function chromeCandidates(platform, environment, homeDirectory) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const under = (root, ...parts) => root ? pathApi.join(root, ...parts) : '';
  let candidates;
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA;
    const programFiles = environment.PROGRAMFILES;
    const programFilesX86 = environment['PROGRAMFILES(X86)'];
    candidates = [
      under(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      under(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      under(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      under(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      under(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      under(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      under(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      under(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      under(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      under(local, 'Chromium', 'Application', 'chrome.exe')
    ];
  } else if (platform === 'darwin') {
    const applications = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
    candidates = [...applications, ...applications.map(candidate => under(homeDirectory, candidate.slice(1)))];
  } else {
    candidates = [
      environment.CHROME_PATH,
      environment.CHROMIUM_PATH,
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser',
      '/opt/google/chrome/chrome',
      '/snap/bin/chromium'
    ];
  }
  return [...new Set(candidates.filter(Boolean))];
}

function normalizeAddress(value) {
  const input = String(value || '').trim();
  if (!input) return 'about:blank';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) || input === 'about:blank') return input;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)) {
    return `http://${input}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(input)) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function escapeMarkdown(value) {
  return String(value == null ? '' : value).replace(/([\\`*_[\]<>])/g, '\\$1');
}

function describeCapture(capture, imageName) {
  const annotation = String(capture.annotation || '').trim();
  const lines = [
    annotation ? '# Browser change request' : '# Browser context',
    '',
    ...(annotation ? [
      '## Task',
      '',
      annotation,
      '',
      'Implement this change in the current workspace. Use the target details and screenshot below to locate the relevant UI, make the requested change, and verify the result.',
      ''
    ] : []),
    '## Page context',
    '',
    `- URL: ${capture.url}`,
    `- Page title: ${escapeMarkdown(capture.title || '')}`,
    `- Captured: ${new Date().toISOString()}`,
    `- Kind: ${capture.kind}`
  ];

  if (capture.kind === 'element') {
    const element = capture.element || {};
    lines.push(
      `- Element: \`${String(element.tag || 'unknown').toLowerCase()}\``,
      `- Selector: \`${String(element.selector || '').replace(/`/g, '\\`')}\``,
      `- Accessible name: ${escapeMarkdown(element.accessibleName || '')}`,
      `- Text: ${escapeMarkdown(element.text || '')}`,
      '',
      '## Element HTML',
      '',
      '```html',
      String(element.html || ''),
      '```'
    );
  } else if (capture.kind === 'console') {
    lines.push('', '## Console logs', '', 'Up to 500 most recent entries from this browser session.', '');
    const logs = capture.logs || [];
    if (!logs.length) lines.push('_No console logs recorded._');
    for (const entry of logs) {
      lines.push(`- ${escapeMarkdown(entry.time)} [${escapeMarkdown(entry.level)}] ${escapeMarkdown(entry.url)}`, ...String(entry.text).split('\n').map(line => `    ${line}`));
    }
  } else {
    const r = capture.region || {};
    lines.push(`- Viewport region: x=${Math.round(r.x || 0)}, y=${Math.round(r.y || 0)}, width=${Math.round(r.width || 0)}, height=${Math.round(r.height || 0)}`);
  }

  if (!annotation) lines.push('', '## Annotation', '', '_No annotation supplied._');
  if (imageName) lines.push('', '## Screenshot', '', `![Captured browser context](./${imageName})`);
  lines.push('', annotation
    ? 'Treat the task above as the user request. Inspect the workspace, implement it, and test the result.'
    : 'Use this browser context to understand the referenced UI. Ask before making assumptions that are not visible in the capture.');
  return lines.join('\n');
}

module.exports = { normalizeAddress, clamp, escapeMarkdown, describeCapture, expandExecutablePath, chromeCandidates };
