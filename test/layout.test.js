'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/core/layout');

const sel = (a, ac, b, bc) => ({ start: { line: a, character: ac }, end: { line: b, character: bc } });
const text = segs => segs.map(s => s[0]).join('');

test('pickLines: whole lines of a selection; a selection ending at column 0 leaves that line out', () => {
  const r = L.pickLines([sel(3, 5, 7, 0)], [{ start: 0, end: 50 }], 100, 'visible');
  assert.equal(r.source, 'selection');
  assert.deepEqual(r.blocks.map(b => [b.from, b.to]), [[3, 6]]);
  const r2 = L.pickLines([sel(3, 5, 7, 2)], [{ start: 0, end: 50 }], 100, 'visible');
  assert.deepEqual(r2.blocks.map(b => [b.from, b.to]), [[3, 7]]);
});

test('pickLines: a backwards selection and several selections, merged when they touch', () => {
  const r = L.pickLines([sel(9, 4, 5, 1), sel(10, 0, 11, 3), sel(20, 0, 21, 1)], [], 100, 'visible');
  assert.deepEqual(r.blocks.map(b => [b.from, b.to]), [[5, 11], [20, 21]]);
});

test('pickLines: nothing selected takes the visible lines or the whole file', () => {
  const vis = [{ start: 10, end: 20 }, { start: 26, end: 40 }];
  const r = L.pickLines([sel(12, 3, 12, 3)], vis, 100, 'visible');
  assert.equal(r.source, 'visible');
  assert.deepEqual(r.blocks.map(b => [b.from, b.to]), [[10, 40]]);
  assert.deepEqual(r.blocks[0].hidden, [[21, 25]]);
  const f = L.pickLines([sel(12, 3, 12, 3)], vis, 100, 'file');
  assert.deepEqual(f.blocks.map(b => [b.from, b.to]), [[0, 99]]);
});

test('rowPlan: folded lines become one row, skipped lines between selections become one row', () => {
  const p = L.pickLines([sel(14, 0, 24, 3), sel(30, 0, 31, 1)], [{ start: 0, end: 15 }, { start: 21, end: 60 }], 100, 'visible');
  const rows = L.rowPlan(p.blocks);
  assert.deepEqual(rows.map(r => r.n || (r.folded ? 'F' + r.skip : 'S' + r.skip)), [15, 16, 'F5', 22, 23, 24, 25, 'S5', 31, 32]);
});

test('expandTabs: tabs go to the next tab stop, also across colored segments', () => {
  const out = L.expandTabs([['\tif', '#a', 0], ['\tx\t', '#b', 0], ['y', '#c', 0]], 4);
  assert.equal(text(out), '    if  x   y');
  assert.equal(out[1][1], '#b');
  assert.equal(text(L.expandTabs([['ab\tc', '#a', 0]], 8)), 'ab      c');
});

test('commonIndent and dropColumns: the shared indent goes, the inner indent stays, blank lines do not count', () => {
  const lines = [{ n: 1, segs: [['    get() {', '#a', 0]] }, { n: 2, segs: [['      return 1;', '#a', 0]] }, { n: 3, segs: [] }, { n: 4, segs: [['  ', '#a', 0]] }, { n: 5, segs: [['    }', '#a', 0]] }];
  assert.equal(L.commonIndent(lines), 4);
  const rows = L.layoutRows(lines, { trimIndent: true, indent: 4 });
  assert.deepEqual(rows.map(r => text(r.segs)), ['get() {', '  return 1;', '', '', '}']);
  // the indent can span segments
  assert.equal(text(L.dropColumns([['  ', '#a', 0], ['  x', '#b', 0]], 3)), ' x');
});

test('wrapLine: wraps at N columns, keeps the indent on continuation rows, rows join back to the line', () => {
  const line = [['    const message = "a long string that needs to wrap somewhere sensible";', '#a', 0]];
  const rows = L.wrapLine(line, 30);
  assert.ok(rows.length >= 3, String(rows.length));
  for (const r of rows) assert.ok(L.segsCols(r) <= 30, text(r));
  for (const r of rows.slice(1)) { assert.equal(r.pre, 4); assert.ok(text(r).startsWith('    ')); }
  const joined = text(rows[0]) + rows.slice(1).map(r => text(r).slice(r.pre)).join('');
  assert.equal(joined, line[0][0]);
  assert.deepEqual(L.wrapLine(line, 0), [line]);
});

test('wide characters count as two columns; combining marks as zero', () => {
  assert.equal(L.cols('ab'), 2);
  assert.equal(L.cols('日本'), 4);
  assert.equal(L.cols('🎉'), 2);
  assert.equal(L.cols('é'), 1);
  assert.equal(L.cols('e' + String.fromCharCode(0x301)), 1);
});

test('cutLine: long lines are cut with a marker; short ones are untouched', () => {
  const long = [['x'.repeat(50), '#a', 0], ['y'.repeat(50), '#b', 0]];
  const r = L.cutLine(long, 60, '#888');
  assert.equal(r.cut, true);
  assert.equal(text(r.segs), 'x'.repeat(50) + 'y'.repeat(10) + ' …');
  assert.equal(L.cutLine([['abc', '#a', 0]], 60, '#888').cut, false);
});

test('defaultFileName: <file>-L12-L40.png, one line, unsafe characters replaced', () => {
  assert.equal(L.defaultFileName('app.ts', 12, 40, 'png'), 'app.ts-L12-L40.png');
  assert.equal(L.defaultFileName('app.ts', 7, 7, 'svg'), 'app.ts-L7.svg');
  assert.equal(L.defaultFileName('a<b>:c?.js', 1, 2, 'png'), 'a_b__c_.js-L1-L2.png');
  assert.equal(L.defaultFileName('', 1, 2, 'png'), 'code-L1-L2.png');
});

test('lineHeightPx follows VS Code: 0 is automatic, below 8 is a multiplier, else pixels', () => {
  assert.equal(L.lineHeightPx(0, 14, 'darwin'), 21);
  assert.equal(L.lineHeightPx(0, 14, 'win32'), 19);
  assert.equal(L.lineHeightPx(1.6, 15, 'linux'), 24);
  assert.equal(L.lineHeightPx(22, 14, 'linux'), 22);
});
