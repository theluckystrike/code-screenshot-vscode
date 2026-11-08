'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHtml, csp } = require('../src/html');

test('CSP: nothing remote, scripts and styles by nonce, no connect, frames or workers', () => {
  const c = csp('vscode-src', 'abc');
  assert.match(c, /default-src 'none'/);
  assert.match(c, /script-src 'nonce-abc'/);
  assert.match(c, /style-src vscode-src 'nonce-abc'/);
  assert.match(c, /connect-src 'none'/);
  assert.match(c, /img-src vscode-src blob: data:/);
  assert.doesNotMatch(c, /unsafe-inline|unsafe-eval|https?:/);
});

test('page: one nonce script, support footer outside the picture, no inline style attributes', () => {
  const h = buildHtml({ cspSource: 'vscode-src', scriptUri: 'vscode-src/dist/webview.js', styleUri: 'vscode-src/media/panel.css', nonce: 'n1' });
  assert.equal((h.match(/<script /g) || []).length, 1);
  assert.match(h, /<script nonce="n1" src="vscode-src\/dist\/webview.js">/);
  assert.doesNotMatch(h, / style="/);
  const footer = h.indexOf('id="zovo-support"');
  const stage = h.indexOf('id="stage"');
  assert.ok(footer > stage && stage > 0, 'footer comes after the picture area, not inside it');
  assert.match(h, /Sponsor/);
  const hidden = buildHtml({ cspSource: 'x', scriptUri: 'y', styleUri: 'z', showSupportLinks: false });
  assert.doesNotMatch(hidden, /zovo-support"/);
});
