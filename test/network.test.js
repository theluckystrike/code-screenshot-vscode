'use strict';
// No network: the bundles must not contain a network client, and the only URLs are links the user clicks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

test('host and panel bundles have no network modules or calls', () => {
  for (const f of ['dist/extension.js', 'dist/webview.js']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    for (const bad of [/require\(["'](https?|net|tls|dgram|http2|dns)["']\)/, /\bfetch\(/, /XMLHttpRequest/, /new WebSocket/, /navigator\.sendBeacon/, /EventSource/]) assert.doesNotMatch(s, bad, `${f}: ${bad}`);
  }
});

test('the only URLs in the bundles are GitHub, Marketplace and spec namespaces', () => {
  const ok = /^https?:\/\/(github\.com\/(sponsors\/)?theluckystrike|marketplace\.visualstudio\.com|www\.w3\.org\/(2000\/svg|XML\/1998\/namespace|1999\/xlink))/;
  for (const f of ['dist/extension.js', 'dist/webview.js']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    const urls = [...new Set(s.match(/https?:\/\/[A-Za-z0-9./_%-]+/g) || [])].filter(u => !ok.test(u) && !/^https?:\/\/(github\.com\/(microsoft|kkos)|aka\.ms)/.test(u));
    assert.deepEqual(urls, [], f);
  }
});

test('the host never reads a whole document: it reads lines', () => {
  const s = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8');
  assert.doesNotMatch(s, /\.getText\(\)/);
  assert.match(s, /lineAt\(/);
});
