'use strict';
// VER11 red-team fixes: XML-safe picture text, Marketplace name, restricted-mode settings, clipboard and rating paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('picture text is XML-safe: control characters show as symbols, lone surrogates as U+FFFD', () => {
  const src = read('src/webview/main.js');
  const fn = src.match(/function xmlSafe[\s\S]*?\n}\n/)[0];
  const xmlSafe = new Function(fn + ';return xmlSafe')();
  assert.equal(xmlSafe('a\fb'), 'a␌b');
  assert.equal(xmlSafe('\x1b[0m\x00'), '␛[0m␀');
  assert.equal(xmlSafe('\x7f'), '␡');
  assert.equal(xmlSafe('tab\tlf\ncr\r'), 'tab\tlf\ncr\r');
  assert.equal(xmlSafe('😀 表 é'), '😀 表 é');
  assert.equal(xmlSafe('a\ud800b\udc00c'), 'a�b�c');
  assert.equal(xmlSafe('￾'), '�');
  // every character of the result is allowed in XML 1.0
  const all = Array.from({ length: 0x80 }, (_, i) => String.fromCharCode(i)).join('');
  assert.doesNotMatch(xmlSafe(all), /[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  for (const w of ['sp.textContent = xmlSafe(s[0])', 'tt.textContent = xmlSafe(title)', "xmlSafe('Code from ' + model.fileName)"]) assert.ok(src.includes(w), w);
});

test('Marketplace name zovo-code-screenshot (code-screenshot belongs to another publisher) and ids match', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'zovo-code-screenshot');
  assert.match(read('src/extension.js'), /const EXT_ID = 'zovo\.zovo-code-screenshot';/);
  assert.match(read('src/support.js'), /const SELF_ID = "zovo\.zovo-code-screenshot";/);
  assert.doesNotMatch(read('src/extension.js') + read('src/support.js'), /zovo\.code-screenshot\b/);
});

test('a workspace cannot set the save folder in Restricted Mode', () => {
  const t = JSON.parse(read('package.json')).capabilities.untrustedWorkspaces;
  assert.equal(t.supported, 'limited');
  assert.deepEqual(t.restrictedConfigurations.sort(), ['codeScreenshot.askWhereToSave', 'codeScreenshot.saveFolder']);
});

test('a failed copy records a rating failure and the fallback save does not count as a success', () => {
  const src = read('src/extension.js');
  const c = src.slice(src.indexOf('} catch (err) {', src.indexOf('await copyImageFile(file)')), src.indexOf('} finally {', src.indexOf('await copyImageFile(file)')));
  assert.match(c, /rating\.failure\(\)/);
  assert.doesNotMatch(c, /this\.success\(\)/);
  assert.match(src, /the panel did not send a PNG\.'\); rating\.failure\(\)/);
});

test('xclip / wl-copy: the copy waits for the command to exit, not for its pipes (they stay open in the clipboard owner)', () => {
  const src = read('src/extension.js');
  assert.match(src, /spawn\(cmd, args, \{ stdio: \[wl \? 'pipe' : 'ignore', 'ignore', 'ignore'\]/);
  assert.match(src, /child\.on\('exit'/);
  assert.ok(src.includes('/g, () => wf.uri.fsPath);'), '${workspaceFolder} replaced with a function');
});
