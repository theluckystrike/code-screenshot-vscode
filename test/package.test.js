'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const root = path.join(__dirname, '..');

test('display name holds every word of the target phrases; no rival brand names', () => {
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['code screenshot', 'code snapshot', 'code image', 'copy code as image', 'png', 'svg']) {
    for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${w} (${phrase}) missing from the name`);
  }
  const all = JSON.stringify([pkg.displayName, pkg.description, pkg.keywords]).toLowerCase();
  for (const brand of ['codesnap', 'polacode', 'carbon', 'ray.so']) assert.ok(!all.includes(brand), brand);
  assert.match(pkg.description, /Free, no sign-in, works offline\.$/);
});

test('engine floor from OVX1 (^1.90.0), UI-side first for remote windows, explicit activation', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.deepEqual(pkg.extensionKind, ['ui', 'workspace']);
  assert.ok(pkg.activationEvents.includes('onCommand:codeScreenshot.copy'));
  assert.ok(!pkg.devDependencies['@types/vscode'] || pkg.devDependencies['@types/vscode'] === '~1.90.0');
});

test('every contributed command is registered in the code; keybindings and menus point at real commands', () => {
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8') + fs.readFileSync(path.join(root, 'src/support.js'), 'utf8');
  const ids = pkg.contributes.commands.map(c => c.command);
  for (const id of ids) {
    const short = id.split('.')[1];
    assert.ok(src.includes(`'${id}'`) || src.includes(`.${short}\``), id + ' not registered');
  }
  for (const k of pkg.contributes.keybindings) assert.ok(ids.includes(k.command));
  for (const list of Object.values(pkg.contributes.menus)) for (const m of list) assert.ok(ids.includes(m.command), m.command);
  const kb = pkg.contributes.keybindings.find(k => k.command === 'codeScreenshot.copy');
  assert.equal(kb.mac, 'cmd+alt+c');
  assert.doesNotMatch(kb.key, /ctrl\+alt/, 'Ctrl+Alt is AltGr on many Windows keyboards');
});

test('every setting the code reads is declared, with a description', () => {
  const props = pkg.contributes.configuration.properties;
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8');
  const used = [...src.matchAll(/c\.get\('([A-Za-z]+)'|int\('([A-Za-z]+)'/g)].map(m => m[1] || m[2]);
  for (const k of new Set(used)) assert.ok(props['codeScreenshot.' + k], 'codeScreenshot.' + k + ' not declared');
  for (const [k, v] of Object.entries(props)) assert.ok(v.description && v.description.length > 20, k);
  for (const s of pkg.contributes.walkthroughs[0].steps) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);
});

test('the package ships the bundles, the wasm and the icon, not the sources or tests', () => {
  const ign = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  for (const p of ['src/**', 'test/**', 'scripts/**', 'node_modules/**', 'images/**']) assert.ok(ign.includes(p), p);
  assert.ok(!/^dist\/\*\*/m.test(ign));
  assert.ok(fs.existsSync(path.join(root, 'icon.png')));
});
