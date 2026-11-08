'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/core/theme');

const files = {
  'ext-a/themes/base.json': '{ // base\n "colors": { "editor.background": "#101010", "editor.foreground": "#eeeeee", }, "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#00ff00", "fontStyle": "italic" } } ] }',
  'ext-a/themes/top.json': '{ "include": "./base.json", "colors": { "editor.background": "#202020" }, "tokenColors": [ { "scope": ["string", "string.quoted"], "settings": { "foreground": "#ffaa00" } } ] }',
  'ext-a/package.nls.json': '{ "topLabel": "Top Theme" }',
  'ext-b/old.tmTheme': '<?xml version="1.0"?><plist><dict><key>settings</key><array><dict><key>settings</key><dict><key>foreground</key><string>#cccccc</string></dict></dict><dict><key>scope</key><string>keyword</string><key>settings</key><dict><key>foreground</key><string>#ff0000</string><key>fontStyle</key><string>bold</string></dict></dict></array></dict></plist>',
};
const read = async (ext, rel) => { const k = ext + '/' + rel.replace(/^\.\//, ''); if (!(k in files)) throw new Error('missing ' + k); return files[k]; };
const exts = [
  { id: 'a.themes', extensionUri: 'ext-a', packageJSON: { contributes: { themes: [{ id: 'Top', label: '%topLabel%', uiTheme: 'vs-dark', path: './themes/top.json' }] } } },
  { id: 'b.old', extensionUri: 'ext-b', packageJSON: { contributes: { themes: [{ label: 'Old One', uiTheme: 'vs', path: './old.tmTheme' }] } } },
];

test('parseJsonc: comments and trailing commas; slashes inside strings are kept', () => {
  assert.deepEqual(T.parseJsonc('{ "a": "http://x//y", /* c */ "b": [1, 2,], // end\n }'), { a: 'http://x//y', b: [1, 2] });
});

test('parsePlist reads a .tmTheme', () => {
  const p = T.parsePlist(files['ext-b/old.tmTheme']);
  assert.equal(p.settings.length, 2);
  assert.equal(p.settings[1].scope, 'keyword');
  assert.equal(p.settings[1].settings.fontStyle, 'bold');
});

test('resolveTheme: includes merge (colors override, token rules add up) and the label comes from package.nls.json', async () => {
  const cfg = k => ({ 'workbench.colorTheme': 'Top Theme' })[k];
  const t = await T.resolveTheme({ extensions: exts, read, cfg, apiKind: 2 });
  assert.equal(t.found, true);
  assert.equal(t.label, 'Top Theme');
  assert.equal(t.colors.background, '#202020');
  assert.equal(t.colors.foreground, '#eeeeee');
  const scopes = t.textmate.settings.map(s => s.scope);
  assert.deepEqual(scopes, [undefined, 'comment', ['string', 'string.quoted']]);
  assert.equal(t.textmate.settings[0].settings.background, '#202020');
});

test('resolveTheme: the theme id works too, and user customizations (global and per theme) apply', async () => {
  const cfg = k => ({
    'workbench.colorTheme': 'Top',
    'editor.tokenColorCustomizations': { comments: '#123456', '[Top Theme]': { textMateRules: [{ scope: 'keyword', settings: { foreground: '#abcdef' } }] }, '[Other]': { strings: '#000000' } },
    'workbench.colorCustomizations': { 'editor.background': '#000011', '[Top Theme]': { 'editorLineNumber.foreground': '#999999' } },
  })[k];
  const t = await T.resolveTheme({ extensions: exts, read, cfg, apiKind: 2 });
  assert.equal(t.colors.background, '#000011');
  assert.equal(t.colors.lineNumber, '#999999');
  const last = t.textmate.settings.slice(-2);
  assert.deepEqual(last[0].scope, ['comment', 'punctuation.definition.comment']);
  assert.equal(last[0].settings.foreground, '#123456');
  assert.equal(last[1].settings.foreground, '#abcdef');
  assert.ok(!t.textmate.settings.some(s => s.settings.foreground === '#000000'));
});

test('resolveTheme: .tmTheme files and light defaults', async () => {
  const t = await T.resolveTheme({ extensions: exts, read, cfg: k => ({ 'workbench.colorTheme': 'Old One' })[k], apiKind: 1 });
  assert.equal(t.kind, 'light');
  assert.equal(t.colors.background, '#FFFFFF');
  assert.equal(t.colors.brackets[0], '#0431FA');
  assert.ok(t.textmate.settings.some(s => s.scope === 'keyword' && s.settings.fontStyle === 'bold'));
});

test('activeThemeName: auto-detect picks the preferred theme for the current kind', () => {
  const cfg = k => ({ 'window.autoDetectColorScheme': true, 'workbench.preferredLightColorTheme': 'L', 'workbench.preferredDarkColorTheme': 'D', 'workbench.colorTheme': 'X' })[k];
  assert.equal(T.activeThemeName(cfg, 1).name, 'L');
  assert.equal(T.activeThemeName(cfg, 2).name, 'D');
  assert.equal(T.activeThemeName(k => ({ 'workbench.colorTheme': 'X' })[k], 2).name, 'X');
});

test('built-in themes are found by their settings name ("Default " + id)', () => {
  const c = [{ id: 'Dark Modern', label: 'Dark Modern', uiTheme: 'vs-dark', extId: 'vscode.theme-defaults' }];
  assert.ok(T.findTheme(c, 'Default Dark Modern', 'dark'));
  assert.equal(T.findTheme(c, 'Nope', 'dark'), null);
});

test('editorColors: transparent bracket colors are skipped; bad colors fall back to defaults', () => {
  const c = T.editorColors({ 'editor.background': 'red', 'editorBracketHighlight.foreground1': '#11111100', 'editorBracketHighlight.foreground2': '#222222' }, 'dark');
  assert.equal(c.background, '#1E1E1E');
  assert.deepEqual(c.brackets, ['#222222', '#179FFF']);
});
