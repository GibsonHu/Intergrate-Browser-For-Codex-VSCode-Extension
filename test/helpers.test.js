'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAddress, clamp, describeCapture, expandExecutablePath, chromeCandidates } = require('../src/helpers');

test('normalizeAddress handles local and search input', () => {
  assert.equal(normalizeAddress('localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(normalizeAddress('example.com'), 'https://example.com');
  assert.match(normalizeAddress('browser annotation workflow'), /^https:\/\/www\.google\.com\/search\?q=/);
});

test('clamp keeps viewport values in range', () => {
  assert.equal(clamp(5, 10, 20), 10);
  assert.equal(clamp(15, 10, 20), 15);
  assert.equal(clamp(25, 10, 20), 20);
});

test('describeCapture includes the annotation and selector', () => {
  const markdown = describeCapture({
    kind: 'element',
    url: 'http://localhost:3000',
    title: 'Demo',
    annotation: 'Increase the spacing',
    element: { tag: 'BUTTON', selector: '#save', accessibleName: 'Save', text: 'Save', html: '<button id="save">Save</button>' }
  }, 'capture.png');
  assert.match(markdown, /#save/);
  assert.match(markdown, /Increase the spacing/);
  assert.match(markdown, /## My request/);
  assert.match(markdown, /^# Browser change request/);
  assert.match(markdown, /Treat the task above as the user request/);
  assert.match(markdown, /capture\.png/);
});

test('browser discovery uses native Windows paths for common Chromium browsers', () => {
  const candidates = chromeCandidates('win32', {
    LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)'
  }, 'C:\\Users\\Ada');
  assert(candidates.includes('C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
  assert(candidates.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert(candidates.includes('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'));
});

test('browser discovery covers system and user applications on macOS', () => {
  const candidates = chromeCandidates('darwin', {}, '/Users/ada');
  assert(candidates.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert(candidates.includes('/Applications/Chromium.app/Contents/MacOS/Chromium'));
  assert(candidates.includes('/Users/ada/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'));
});

test('browser discovery covers Linux packages and environment overrides', () => {
  const candidates = chromeCandidates('linux', { CHROME_PATH: '/custom/chrome' }, '/home/ada');
  assert.equal(candidates[0], '/custom/chrome');
  assert(candidates.includes('/usr/bin/google-chrome'));
  assert(candidates.includes('/usr/bin/microsoft-edge-stable'));
  assert(candidates.includes('/snap/bin/chromium'));
});

test('configured browser paths expand home and environment variables per platform', () => {
  assert.equal(expandExecutablePath('~/bin/chrome', 'linux', {}, '/home/ada'), '/home/ada/bin/chrome');
  assert.equal(expandExecutablePath('${env:LOCALAPPDATA}\\Chromium\\chrome.exe', 'win32', {
    LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local'
  }, 'C:\\Users\\Ada'), 'C:\\Users\\Ada\\AppData\\Local\\Chromium\\chrome.exe');
  assert.equal(expandExecutablePath('%PROGRAMFILES%\\Google\\Chrome\\chrome.exe', 'win32', {
    PROGRAMFILES: 'C:\\Program Files'
  }, 'C:\\Users\\Ada'), 'C:\\Program Files\\Google\\Chrome\\chrome.exe');
});
