'use strict';
// The tokenizer with a small grammar and theme (no VS Code needed), plus a check against VS Code's own
// TypeScript grammar and Dark Modern theme when VS Code is installed on this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Tokenizer, bracketColorer, merge } = require('../src/core/tokenize');
const { resolveTheme } = require('../src/core/theme');

const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
const grammar = {
  scopeName: 'source.demo',
  patterns: [
    { match: '\\b(if|return)\\b', name: 'keyword.control.demo' },
    { match: '//.*$', name: 'comment.line.demo' },
    { begin: '"', end: '"', name: 'string.quoted.demo' },
    { begin: '/\\*', end: '\\*/', name: 'comment.block.demo' },
    { match: '[<>]=?', name: 'keyword.operator.relational.demo' },
  ],
};
const files = {
  'demo/g.json': JSON.stringify(grammar),
  'demo/conf.json': '{ "brackets": [["{", "}"], ["(", ")"], ["<", ">"]] }',
};
const ext = { id: 'x.demo', extensionUri: 'demo', packageJSON: { contributes: {
  languages: [{ id: 'demo', configuration: './conf.json' }],
  grammars: [{ language: 'demo', scopeName: 'source.demo', path: './g.json', unbalancedBracketScopes: ['keyword.operator.relational'] }],
} } };
const read = async (u, rel) => files[u + '/' + rel.replace(/^\.\//, '')];
const theme = { name: 't', settings: [{ settings: { foreground: '#CCCCCC', background: '#111111' } }, { scope: 'keyword', settings: { foreground: '#C586C0' } }, { scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } }, { scope: 'string', settings: { foreground: '#CE9178' } }] };
const colors = { foreground: '#CCCCCC', brackets: ['#FFD700', '#DA70D6', '#179FFF'], unexpectedBracket: '#FF1212' };

test('colors come from the grammar and theme; comments keep their font style', async () => {
  const t = new Tokenizer({ extensions: [ext], read, wasm });
  const r = await t.tokenize('demo', [], ['if (a) return "x" // done'], { theme, colors, bracketColors: false });
  assert.equal(r.grammar, true);
  const segs = r.lines[0];
  assert.deepEqual(segs[0], ['if', '#C586C0', 0]);
  assert.ok(segs.some(s => s[0] === '"x"' && s[1] === '#CE9178'));
  assert.ok(segs.some(s => s[0] === '// done' && s[1] === '#6A9955' && s[2] === 1));
});

test('the grammar state from lines before the selection is used (a block comment opened earlier)', async () => {
  const t = new Tokenizer({ extensions: [ext], read, wasm });
  const r = await t.tokenize('demo', ['/* start of a comment'], ['still in the comment */ if'], { theme, colors, bracketColors: false });
  assert.equal(r.lines[0][0][1], '#6A9955');
  assert.equal(r.lines[0][r.lines[0].length - 1][1], '#C586C0');
});

test('bracket pair colors by depth, not in strings or comments, and "a > b" is not a bracket', async () => {
  const t = new Tokenizer({ extensions: [ext], read, wasm });
  const r = await t.tokenize('demo', ['{'], ['f(g(x)) "(" a > b }'], { theme, colors, bracketColors: true });
  const segs = r.lines[0];
  const col = ch => segs.filter(s => s[0] === ch).map(s => s[1]);
  // depth: "{" before is level 0, so "(" is level 1 and the inner "(" level 2
  assert.deepEqual(col('('), ['#DA70D6', '#179FFF']);
  assert.ok(segs.some(s => s[0] === '"("' && s[1] === '#CE9178'), 'bracket inside a string keeps the string color');
  const gt = segs.find(s => s[0].includes('>'));
  assert.ok(gt && ![...colors.brackets, colors.unexpectedBracket].includes(gt[1]), 'relational > is not colored as a bracket: ' + JSON.stringify(gt));
  assert.deepEqual(col('}'), ['#FFD700']);
});

test('unknown language: plain text in the foreground color', async () => {
  const t = new Tokenizer({ extensions: [ext], read, wasm });
  const r = await t.tokenize('nope', [], ['plain <text>', ''], { theme, colors, bracketColors: true });
  assert.equal(r.grammar, false);
  assert.deepEqual(r.lines, [[['plain <text>', '#CCCCCC', 0]], []]);
});

test('lines over the tokenization limit stay one color and do not stop the rest', async () => {
  const t = new Tokenizer({ extensions: [ext], read, wasm });
  const r = await t.tokenize('demo', [], ['if '.repeat(50), 'if x'], { theme, colors, bracketColors: false, maxLineLength: 100 });
  assert.deepEqual(r.lines[0], [['if '.repeat(50), '#CCCCCC', 0]]);
  assert.equal(r.lines[1][0][1], '#C586C0');
});

test('merge joins neighbours with the same color and style', () => {
  assert.deepEqual(merge([['a', '#1', 0, 0], ['b', '#1', 0, 0], ['c', '#2', 0, 0]]), [['ab', '#1', 0], ['c', '#2', 0]]);
  const b = bracketColorer([['(', ')']], { brackets: ['#A'], unexpectedBracket: '#X' });
  assert.deepEqual(b.walk([[')(', '#C', 0, 0]], true).map(s => s[1]), ['#X', '#A']);
});

const VSC = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
test('matches VS Code: TypeScript in Dark Modern', { skip: !fs.existsSync(VSC) && 'VS Code not installed here' }, async () => {
  const exts = fs.readdirSync(VSC).filter(d => fs.existsSync(path.join(VSC, d, 'package.json'))).map(d => ({ id: 'vscode.' + d, extensionUri: path.join(VSC, d), packageJSON: JSON.parse(fs.readFileSync(path.join(VSC, d, 'package.json'), 'utf8')) }));
  const rd = async (u, rel) => fs.readFileSync(path.join(u, rel), 'utf8');
  const th = await resolveTheme({ extensions: exts, read: rd, cfg: k => ({ 'workbench.colorTheme': 'Default Dark Modern' })[k], apiKind: 2 });
  assert.equal(th.found, true);
  const t = new Tokenizer({ extensions: exts, read: rd, wasm });
  const r = await t.tokenize('typescript', [], ['function greet(name: string) { return `hi ${name}`; } // c', 'if (a > b) {}'], { theme: th.textmate, colors: th.colors, bracketColors: true });
  const find = (l, txt) => r.lines[l].find(s => s[0] === txt);
  assert.equal(find(0, 'function')[1], '#569CD6');
  assert.equal(find(0, 'greet')[1], '#DCDCAA');
  assert.equal(find(0, 'string')[1], '#4EC9B0');
  assert.equal(find(0, '// c')[1], '#6A9955');
  assert.equal(find(1, '>')[1], '#D4D4D4');
});
