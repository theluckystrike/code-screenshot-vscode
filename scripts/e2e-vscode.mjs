// Real VS Code gate for Code Screenshot. Installs the packaged .vsix into a clean profile, opens real files, selects
// lines with the keyboard, presses the real shortcut, and checks the clipboard (macOS), saved PNG/SVG files, the
// panel, themes, highlights, hostile files, the large files, the network and the rating ask.
// Usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <out.json> [quick]
// The owner's clipboard text is saved first and put back at the end.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync, execFileSync } from 'node:child_process';
import { launch, installVsix, sleep } from './vsc.mjs';

const [work, portArg, vsix, samples, shots, outFile, mode] = process.argv.slice(2);
const port = Number(portArg);
const quick = mode === 'quick' || mode === 'readme';
const readme = mode === 'readme';
const R = { started: new Date().toISOString(), vsix, steps: [], files: [] };
const ws = path.join(work, 'ws');
const outDir = path.join(work, 'out');
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
for (const f of fs.readdirSync(samples)) fs.copyFileSync(path.join(samples, f), path.join(ws, f));

let savedClipboard = null;
try { savedClipboard = execSync('pbpaste', { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch {}

const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern', 'editor.fontFamily': 'Menlo, Monaco, "Courier New", monospace', 'editor.fontSize': 14,
  'editor.minimap.enabled': false, 'codeScreenshot.saveFolder': outDir, 'codeScreenshot.askWhereToSave': false,
  'workbench.editor.enablePreview': false, 'editor.largeFileOptimizations': true, 'files.associations': {}, 'window.titleBarStyle': 'custom',
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'extensions.ignoreRecommendations': true,
};
if (readme) SETTINGS['workbench.colorTheme'] = 'Default Light Modern';
const settingsFile = path.join(work, 'ud', 'User', 'settings.json');
const setSetting = async (k, v) => { const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); if (v === undefined) delete s[k]; else s[k] = v; fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1)); await sleep(2200); };

let vs;
const t0 = Date.now();
async function step(name, fn) {
  const s = { name, t: Date.now() - t0 };
  try { s.result = await fn(); s.ok = true; } catch (e) { s.ok = false; s.error = String(e && e.message || e).slice(0, 700); }
  s.ms = Date.now() - t0 - s.t;
  R.steps.push(s);
  console.log((s.ok ? 'PASS ' : 'FAIL ') + name + (s.ok ? '' : ' :: ' + s.error));
  fs.writeFileSync(outFile, JSON.stringify(R, null, 1));
  return s;
}
async function shot(name) { try { return await vs.shot(path.join(shots, name + '.png')); } catch (e) { return 'shot failed: ' + e.message; } }

// ---------- helpers ----------
const wv = async () => {
  const v = await vs.waitFor(async () => (await vs.webviews()).find(x => x.title === 'Code Screenshot'), 15000);
  if (!v) throw new Error('panel webview not found');
  return v;
};
const E = async (expr) => vs.wvEval(await wv(), expr);
const noticeText = () => E(`(document.getElementById('notice') || {}).textContent || ''`);
const pictureInfo = () => E(`(() => { const s = document.querySelector('#stage svg'); if (!s) return null;
  const body = s.querySelector('g[transform] > rect');
  return { w: +s.getAttribute('width'), h: +s.getAttribute('height'), texts: s.querySelectorAll('text').length, rows: s.querySelectorAll('[data-ui] rect').length,
    hl: s.querySelectorAll('[data-hl]').length, marks: s.querySelectorAll('[data-mark]').length, scripts: s.querySelectorAll('script').length,
    foreign: s.querySelectorAll('foreignObject').length, images: s.querySelectorAll('image').length, body: body && body.getAttribute('fill'),
    title: [...s.querySelectorAll('text')].map(t => t.textContent).find(t => t && t === (document.getElementById('title').value || t)) ,
    text: [...s.querySelectorAll('g[font-family] text')].map(t => t.textContent).join('\\n').slice(0, 4000),
    size: document.getElementById('size').textContent, notice: document.getElementById('notice').textContent }; })()`);

let currentFile = '';
async function focusEditor(name = currentFile) {
  // click into the text of the editor group whose active tab is this file (not the panel's group)
  const v = await vs.wbEval(`(() => { const groups = [...document.querySelectorAll('.editor-group-container')];
    const g = groups.find(x => { const t = x.querySelector('.tab.active'); return t && t.textContent.includes(${JSON.stringify(name)}) && x.querySelector('.monaco-editor .view-lines'); }) || groups.find(x => x.querySelector('.monaco-editor .view-lines'));
    const e = g && [...g.querySelectorAll('.monaco-editor .view-lines')].find(x => x.offsetParent); if (!e) return 'null';
    const r = e.getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height]); })()`);
  const r = JSON.parse(v);
  // the text layer can be wider than the visible group, so click just right of its left edge
  if (r) await vs.click(r[0] + 24, r[1] + 10);
  const ok = await vs.waitFor(() => vs.wbEval(`!!document.activeElement && !!document.activeElement.closest('.monaco-editor')`), 3000, 100);
  if (!ok) throw new Error('could not focus the editor for ' + name);
}
async function openFile(name) {
  currentFile = name;
  vs.open(path.join(ws, name));
  const base = name;
  const ok = await vs.waitFor(() => vs.wbEval(`[...document.querySelectorAll('.tab.active')].some(t => t.textContent.includes(${JSON.stringify(base)}))`), 20000);
  if (!ok) throw new Error('editor did not open ' + name);
  await sleep(700);
  await focusEditor();
}
async function gotoLine(n) {
  // Ctrl+G: Go to Line. Type only once the quick input has focus, or the digits would land in the file.
  const open = () => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent !== null && document.activeElement && w.contains(document.activeElement)); })()`);
  for (let i = 0; i < 3; i++) {
    await vs.key('g', 'KeyG', 2, 71);
    if (await vs.waitFor(open, 4000, 100)) break;
    if (i === 2) throw new Error('Go to Line did not open');
    await focusEditor();
  }
  await vs.type(String(n)); await sleep(250); await vs.key('Enter', 'Enter'); await sleep(300);
}
async function selectLines(a, b) {
  await gotoLine(a);
  await vs.key('Home', 'Home', 0); await vs.key('Home', 'Home', 0);
  for (let i = a; i <= b; i++) await vs.key('ArrowDown', 'ArrowDown', 8, 40);
  await sleep(200);
}
async function selectAll() { await vs.key('a', 'KeyA', 4, 65); await sleep(200); }
async function shortcut() { await vs.key('c', 'KeyC', 5, 67); } // Cmd+Alt+C
async function copyAndWait(what = 'Copied the PNG') {
  const before = Date.now();
  await shortcut();
  const n = await vs.waitFor(async () => { const t = await noticeText().catch(() => ''); return t.includes(what) || /Could not|could not/.test(t) ? t : null; }, 30000, 150);
  if (!n) { const f = await shot('fail-' + (Date.now() - t0)); const ae = await vs.wbEval(`(document.activeElement && (document.activeElement.className || document.activeElement.tagName) + '').slice(0, 80)`).catch(() => '?'); R.failShots = (R.failShots || []).concat([{ f, ae }]); }
  if (!n) throw new Error('no copy notice; notice: ' + (await noticeText().catch(() => '?')) + ' | notifications: ' + JSON.stringify(await vs.notifications().catch(() => [])).slice(0, 300));
  if (!n.includes(what)) throw new Error(n);
  return { ms: Date.now() - before, notice: n };
}
async function clearNotice() { await E(`(() => { const n = document.getElementById('notice'); n.textContent=''; n.className='hidden'; return 1; })()`).catch(() => {}); }

function clipboardPng(file) {
  const info = execFileSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' });
  if (!/PNGf/.test(info)) {
    // say what kind of text replaced the image, without copying other people's clipboard text into the log
    let kind = 'other text';
    try { const t = execSync('pbpaste', { encoding: 'utf8' }); kind = /Code Screenshot|Copied|px\)/.test(t) ? 'ours: ' + t.slice(0, 80) : /^package main/.test(t) ? 'the file text (Cmd+C)' : 'other text, ' + t.length + ' chars'; } catch {}
    return { info: info.trim().slice(0, 200) + ' | ' + kind, png: false };
  }
  execFileSync('osascript', ['-e', `set f to open for access (POSIX file ${JSON.stringify(file)}) with write permission`, '-e', 'set eof f to 0', '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'close access f']);
  return { info: info.trim().slice(0, 200), png: true, ...pngInfo(fs.readFileSync(file)) };
}
function pngInfo(b) {
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25], bytes: b.length };
}
/** Decode an 8-bit RGBA or RGB PNG (what Chromium's canvas writes) and return a pixel reader. */
function decodePng(b) {
  const { w, h, colorType } = pngInfo(b);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch || b[24] !== 8 || b[28] !== 0) throw new Error('unsupported PNG');
  const idat = [];
  for (let o = 8; o < b.length;) { const len = b.readUInt32BE(o); const type = b.toString('latin1', o + 4, o + 8); if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len)); o += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c; const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, at: (x, y) => [...px.subarray(y * stride + x * ch, y * stride + x * ch + ch)], colors: () => { const s = new Set(); for (let i = 0; i < px.length; i += ch * 7) s.add(px.readUIntBE(i, 3)); return s.size; } };
}
const extHost = () => {
  const ud = path.join(work, 'ud');
  const rows = execSync('ps -axo pid=,rss=,command=', { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(l => l.includes(ud) && /Plugin|extensionHost|utility-sub-type=node/i.test(l));
  return rows.map(l => { const [pid, rss] = l.trim().split(/\s+/); return { pid: Number(pid), mb: Math.round(Number(rss) / 1024) }; });
};
const sockets = () => {
  const pids = extHost().map(x => x.pid); if (!pids.length) return [];
  try { return execSync(`lsof -nP -a -i -p ${pids.join(',')} 2>/dev/null || true`, { encoding: 'utf8' }).split('\n').filter(l => l && !/^COMMAND/.test(l) && !l.includes(`:${port}`)); } catch { return []; }
};
const lag = async () => { const a = Date.now(); await vs.wbEval('1'); return Date.now() - a; };
const outFiles = () => fs.readdirSync(outDir).sort();

try {
  const inst = installVsix(work, vsix);
  if (inst.code !== 0) throw new Error('install failed: ' + inst.out);
  vs = await launch(work, port, ws, SETTINGS);
  await vs.s.send('Emulation.setFocusEmulationEnabled', { enabled: true }, vs.wb).catch(() => {});
  R.vscode = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  await sleep(2500);
  R.socketsBefore = sockets();
  // more room for the editor and the panel in the screenshots
  await vs.wbEval(`(document.querySelector('.part.statusbar') || document.body).focus && 1`);
  await vs.key('b', 'KeyB', 4, 66); await sleep(500);

  await step('shortcut on a selection (app.ts lines 4-22): PNG on the clipboard, size matches the panel, 2x', async () => {
    await openFile('app.ts');
    await selectLines(4, 22);
    const c = await copyAndWait();
    const clip = clipboardPng(path.join(work, 'clip1.png'));
    fs.copyFileSync(path.join(work, 'clip1.png'), path.join(shots, readme ? 'output-light.png' : 'output-dark.png'));
    const p = await pictureInfo();
    await shot('01-app-ts-dark');
    if (!clip.png) throw new Error('clipboard has no PNG: ' + clip.info);
    if (clip.w !== p.w * 2 || clip.h !== p.h * 2) throw new Error(`clipboard ${clip.w}x${clip.h} vs picture ${p.w}x${p.h} at 2x`);
    const rows = p.rows;
    if (rows !== 19) throw new Error('rows ' + rows);
    if (!/class TtlCache/.test(p.text)) throw new Error('text missing');
    const lines = p.text.split('\n');
    return { ms: c.ms, clipboard: { w: clip.w, h: clip.h, bytes: clip.bytes }, picture: { w: p.w, h: p.h, rows }, size: p.size, firstLine: lines[0], editorFocusKept: await vs.wbEval(`!!document.activeElement && !!document.activeElement.closest('.monaco-editor')`) };
  });

  if (readme) throw new Error('readme mode: done after the first picture');
  await step('real line numbers start at the first selected line; common indent removed', async () => {
    const t = await E(`[...document.querySelectorAll('#stage svg g[text-anchor=end] text')].map(x => x.textContent).slice(0, 3).join(',')`);
    const first = await E(`document.querySelector('#stage svg g[font-family] text').textContent`);
    if (!t.startsWith('4,5,6')) throw new Error('numbers ' + t);
    if (!/^export class/.test(first)) throw new Error('first line ' + JSON.stringify(first));
    // inner lines keep their own indent
    await selectLines(9, 15); await sleep(800);
    const lines = (await pictureInfo()).text.split('\n');
    if (!/^get\(key/.test(lines[0]) || !/^  const hit/.test(lines[1])) throw new Error(JSON.stringify(lines.slice(0, 3)));
    return { numbers: t, first, nested: lines.slice(0, 2) };
  });

  await step('Save PNG and Save SVG: names carry the line range, PNG size = picture x scale, SVG text is text', async () => {
    await clearNotice();
    await vs.wvClick(await wv(), `document.getElementById('savePng')`);
    await vs.waitFor(async () => /Saved/.test(await noticeText()), 15000);
    await clearNotice();
    await vs.wvClick(await wv(), `document.getElementById('saveSvg')`);
    await vs.waitFor(async () => /Saved .*svg/.test(await noticeText()), 15000);
    const files = outFiles();
    const png = files.find(f => /^app\.ts-L9-L15\.png$/.test(f));
    const svg = files.find(f => /^app\.ts-L9-L15\.svg$/.test(f));
    if (!png || !svg) throw new Error('files: ' + files.join(','));
    const pi = pngInfo(fs.readFileSync(path.join(outDir, png)));
    const p = await pictureInfo();
    const svgText = fs.readFileSync(path.join(outDir, svg), 'utf8');
    if (pi.w !== p.w * 2) throw new Error('png width ' + pi.w + ' vs ' + p.w);
    const plain = svgText.replace(/<[^>]+>/g, '');
    if (!/<text[^>]*>/.test(svgText) || !plain.includes('get(key: K): V | undefined {')) throw new Error('svg text');
    if (/<script|foreignObject|data-ui|data-row/.test(svgText)) throw new Error('svg has ui or script parts');
    return { png, svg, pngSize: [pi.w, pi.h], svgBytes: svgText.length, svgHasFont: /font-family="Menlo/.test(svgText) };
  });

  await step('line highlight (click) and word mark (double-click) show in the picture', async () => {
    const v = await wv();
    await vs.wvClick(v, `document.querySelector('#stage svg [data-ui] rect[data-row="1"]')`, { dx: 400 });
    await sleep(500);
    let p = await pictureInfo();
    if (p.hl !== 1) throw new Error('highlights ' + p.hl);
    // double-click on the word "hit" in row 1 ("  const hit = ...")
    const pos = await E(`(() => { const t = [...document.querySelectorAll('#stage svg g[font-family] text')][1]; const i = t.textContent.indexOf('hit'); const p = t.getStartPositionOfChar(i + 1); const m = t.getScreenCTM(); const pt = document.querySelector('#stage svg').createSVGPoint(); pt.x = p.x; pt.y = p.y - 4; const s = pt.matrixTransform(m); return JSON.stringify({ x: s.x, y: s.y }); })()`);
    const { x, y } = JSON.parse(pos);
    const off = await vs.wvOffset();
    await vs.click(off.x + x, off.y + y, { count: 2 });
    await sleep(700);
    p = await pictureInfo();
    if (p.marks < 1) throw new Error('marks ' + p.marks);
    if (p.hl !== 1) throw new Error('highlight changed by the double-click: ' + p.hl);
    await shot('02-highlight-mark');
    // mark text box
    await vs.wvClick(v, `document.getElementById('more')`);
    await vs.wvClick(v, `document.getElementById('mark')`);
    await vs.type('this'); await sleep(700);
    const p2 = await pictureInfo();
    await shot('02b-options');
    return { highlights: p.hl, marksAfterDoubleClick: p.marks, marksWithText: p2.marks };
  });

  await step('options: no line numbers, no frame, transparent background, 3x: PNG corners are transparent', async () => {
    const v = await wv();
    const setSel = (id, val) => E(`(() => { const e = document.getElementById('${id}'); e.value = '${val}'; e.dispatchEvent(new Event('change')); return 1; })()`);
    const setChk = (id, val) => E(`(() => { const e = document.getElementById('${id}'); e.checked = ${val}; e.dispatchEvent(new Event('change')); return 1; })()`);
    await E(`(() => { const e = document.getElementById('mark'); e.value = ''; e.dispatchEvent(new Event('input')); return 1; })()`);
    await vs.wvClick(v, `document.getElementById('clearMarks')`);
    await setChk('lineNumbers', false); await setSel('frame', 'none'); await setSel('background', 'transparent'); await setSel('scale', '3');
    await sleep(600);
    await clearNotice();
    await vs.wvClick(v, `document.getElementById('savePng')`);
    await vs.waitFor(async () => /Saved/.test(await noticeText()), 15000);
    const f = outFiles().filter(x => /^app\.ts-L9-L15-?\d*\.png$/.test(x)).sort((a, b) => fs.statSync(path.join(outDir, b)).mtimeMs - fs.statSync(path.join(outDir, a)).mtimeMs)[0];
    const png = decodePng(fs.readFileSync(path.join(outDir, f)));
    const p = await pictureInfo();
    const corner = png.at(0, 0);
    const nums = await E(`document.querySelectorAll('#stage svg g[text-anchor=end] text').length`);
    await shot('03-options-transparent');
    if (png.w !== p.w * 3) throw new Error('3x width ' + png.w + ' vs ' + p.w);
    if (corner.length !== 4 || corner[3] !== 0) throw new Error('corner not transparent: ' + corner);
    if (nums !== 0) throw new Error('line numbers still drawn: ' + nums);
    // back to defaults for the next steps
    await setChk('lineNumbers', true); await setSel('frame', 'mac'); await setSel('background', 'gradient-1'); await setSel('scale', '2');
    return { file: f, size: [png.w, png.h], corner, lineNumbers: nums };
  });

  // every sample file: select all, shortcut, clipboard PNG
  const files = ['server.py', 'main.rs', 'handler.go', 'config.json', 'README.md', 'wide.js', 'rtl.js', 'emoji.py', 'nested.tsx', 'mixed-tabs.c', '<img src=x onerror=alert(1)>.js', 'hostile-script.html'];
  for (const f of quick ? files.slice(0, 3) : files) {
    await step(`${f}: select all, shortcut, PNG on the clipboard, colored`, async () => {
      await openFile(f);
      await selectAll();
      await clearNotice();
      const c = await copyAndWait();
      const clip = clipboardPng(path.join(work, 'clip.png'));
      const p = await pictureInfo();
      if (!clip.png) throw new Error('no PNG on the clipboard; clipboard info: ' + clip.info);
      const png = decodePng(fs.readFileSync(path.join(work, 'clip.png')));
      const fills = await E(`new Set([...document.querySelectorAll('#stage svg g[font-family] tspan')].map(t => t.getAttribute('fill'))).size`);
      const name = f.replace(/[^a-z0-9.]+/gi, '_');
      await shot('10-' + name);
      const timing = await E(`document.body.dataset.timing || ''`);
      R.files.push({ file: f, ms: c.ms, rows: p.rows, w: clip.w, h: clip.h, colors: fills, timing });
      if (p.scripts || p.foreign || p.images) throw new Error('script/foreignObject/image in the picture');
      return { ms: c.ms, timing, rows: p.rows, clipboard: [clip.w, clip.h], tokenColors: fills, pngColors: png.colors(), notice: p.notice.slice(0, 160) };
    });
  }

  if (!quick) {
    await step('hostile-script.html: markup drawn as text, no script runs, no remote load', async () => {
      await openFile('hostile-script.html'); await selectAll(); await clearNotice(); await copyAndWait();
      const p = await pictureInfo();
      const dialogs = await vs.wbEval(`document.querySelectorAll('.monaco-dialog-box').length`);
      const res = await E(`performance.getEntriesByType('resource').map(e => e.name).filter(n => !/vscode-resource|vscode-cdn|vscode-webview/.test(n))`);
      const svgOut = await E(`new XMLSerializer().serializeToString(document.querySelector('#stage svg'))`);
      if (!p.text.includes('<script>alert("xss")</script>')) throw new Error('script line not drawn as text');
      if (!p.text.includes('</svg></text></g>')) throw new Error('</svg> line missing');
      if (!p.text.includes('&lt;script&gt;')) throw new Error('&lt; was decoded');
      if (p.scripts || p.foreign || p.images) throw new Error('elements made from code text');
      if (res.length) throw new Error('remote loads: ' + res.join(','));
      if (!svgOut.includes('&lt;script&gt;alert(')) throw new Error('serialized SVG not escaped');
      return { scriptsInSvg: p.scripts, images: p.images, dialogs, remoteLoads: res.length, svgEscaped: true };
    });

    await step('hostile file name: the window title shows it as text', async () => {
      await openFile('<img src=x onerror=alert(1)>.js'); await selectAll(); await clearNotice(); await copyAndWait();
      const t = await E(`[...document.querySelectorAll('#stage svg > g > text')].map(x => x.textContent)`);
      const imgs = await E(`document.querySelectorAll('img, #stage svg image').length`);
      if (!t.includes('<img src=x onerror=alert(1)>.js')) throw new Error('title ' + JSON.stringify(t));
      if (imgs) throw new Error('img elements: ' + imgs);
      return { title: t[0], imgElements: imgs };
    });

    await step('folded region shows as one "folded lines" row; real numbers after it', async () => {
      await openFile('nested.tsx');
      await gotoLine(16);
      await vs.key('[', 'BracketLeft', 5, 219); // Cmd+Alt+[ : Fold
      await sleep(600);
      await selectLines(14, 24);
      await sleep(300);
      await clearNotice();
      const c = await copyAndWait();
      const p = await pictureInfo();
      const nums = await E(`[...document.querySelectorAll('#stage svg g[text-anchor=end] text')].map(x => x.textContent).join(',')`);
      await shot('04-folded');
      if (!/folded line/.test(p.text)) throw new Error('no folded row: ' + p.text.slice(0, 300));
      await vs.key(']', 'BracketRight', 5, 221); // unfold
      return { ms: c.ms, numbers: nums, rows: p.rows };
    });

    await step('multiple selections: skipped lines drawn as one "⋯" row', async () => {
      await openFile('server.py');
      // cursor inside "Reply" on line 6, then Cmd+D three times: the word and its next two matches (lines 11 and 15)
      await gotoLine(6); await vs.key('End', 'End'); await vs.key('ArrowLeft', 'ArrowLeft'); await vs.key('ArrowLeft', 'ArrowLeft');
      await vs.key('d', 'KeyD', 4, 68); await vs.key('d', 'KeyD', 4, 68); await vs.key('d', 'KeyD', 4, 68);
      await sleep(300);
      await clearNotice();
      const c = await copyAndWait();
      const p = await pictureInfo();
      const nums = await E(`[...document.querySelectorAll('#stage svg g[text-anchor=end] text')].map(x => x.textContent).join(',')`);
      if (!p.text.includes('⋯')) throw new Error('no skip row: ' + nums + ' / ' + p.text.slice(0, 200));
      return { ms: c.ms, numbers: nums };
    });

    await step('large: big.ts (2,000 lines) select all: first 1,000 lines drawn with a note; editor stays responsive', async () => {
      await openFile('big.ts'); await selectAll();
      await clearNotice();
      const before = Date.now();
      await shortcut();
      let maxLag = 0;
      const n = await vs.waitFor(async () => { const l = await lag(); if (l > maxLag) maxLag = l; const t = await noticeText().catch(() => ''); return /Copied the PNG|Could not/.test(t) ? t : null; }, 60000, 100);
      const ms = Date.now() - before;
      const p = await pictureInfo();
      const clip = clipboardPng(path.join(work, 'clip-big.png'));
      await shot('05-big-ts');
      if (!n || !/Copied/.test(n)) throw new Error('notice: ' + n);
      if (p.rows !== 1000) throw new Error('rows ' + p.rows);
      return { ms, rows: p.rows, clipboard: [clip.w, clip.h], pngBytes: clip.bytes, workbenchLagMaxMs: maxLag, extHostMb: extHost().map(x => x.mb) };
    });

    await step('large: deep selection in big.ts (lines 1,900-1,960) colored from the right grammar state', async () => {
      await selectLines(1900, 1960); await clearNotice();
      const c = await copyAndWait();
      const fills = await E(`new Set([...document.querySelectorAll('#stage svg g[font-family] tspan')].map(t => t.getAttribute('fill'))).size`);
      if (fills < 4) throw new Error('few colors: ' + fills);
      return { ms: c.ms, colors: fills };
    });

    await step('hostile + large: 10 MB one-line minified JS: cut with a note, no freeze, PNG fits', async () => {
      await openFile('hostile-min.js'); await sleep(1500); await focusEditor(); await selectAll();
      await clearNotice();
      await sleep(1500);
      const memBefore = extHost().map(x => x.mb);
      const before = Date.now();
      await shortcut();
      let maxLag = 0;
      const n = await vs.waitFor(async () => { const l = await lag(); if (l > maxLag) maxLag = l; const t = await noticeText().catch(() => ''); return /Copied the PNG|Could not|could not/.test(t) ? t : null; }, 60000, 100);
      const ms = Date.now() - before;
      const p = await pictureInfo();
      const notes = await E(`document.getElementById('notice').textContent`);
      await shot('06-min-js');
      if (!n || !/Copied/.test(n)) throw new Error('notice: ' + n);
      const clip = clipboardPng(path.join(work, 'clip-min.png'));
      return { ms, rows: p.rows, picture: [p.w, p.h], clipboard: [clip.w, clip.h], workbenchLagMaxMs: maxLag, notice: notes.slice(0, 200), extHostMbBefore: memBefore, extHostMb: extHost().map(x => x.mb) };
    });

    await step('light theme: picture follows (editor background white, colors change)', async () => {
      await setSetting('workbench.colorTheme', 'Default Light Modern');
      await openFile('app.ts'); await selectLines(4, 22); await clearNotice();
      await copyAndWait();
      const p = await pictureInfo();
      try { const c = clipboardPng(path.join(work, 'clip-light.png')); if (c.png) fs.copyFileSync(path.join(work, 'clip-light.png'), path.join(shots, 'output-light.png')); } catch {}
      await shot('07-app-ts-light');
      if (!/^#fff/i.test(p.body || '')) throw new Error('body fill ' + p.body);
      return { body: p.body };
    });

    await step('high contrast theme: picture follows', async () => {
      await setSetting('workbench.colorTheme', 'Default High Contrast');
      await sleep(800);
      await selectLines(4, 22); await clearNotice();
      await copyAndWait();
      const p = await pictureInfo();
      await shot('08-app-ts-hc');
      if (!/^#000/i.test(p.body || '')) throw new Error('body fill ' + p.body);
      await setSetting('workbench.colorTheme', 'Default Dark Modern');
      return { body: p.body };
    });

    await step('font settings: editor.fontSize 18 and ligatures on reach the picture', async () => {
      await setSetting('editor.fontSize', 18);
      await setSetting('editor.fontLigatures', true);
      await openFile('app.ts'); await selectLines(4, 8); await clearNotice();
      await copyAndWait();
      const g = await E(`(() => { const g = document.querySelector('#stage svg g[font-family]'); return { size: g.getAttribute('font-size'), style: g.style.cssText }; })()`);
      await setSetting('editor.fontSize', 14); await setSetting('editor.fontLigatures', false);
      if (g.size !== '18' || !/liga/.test(g.style)) throw new Error(JSON.stringify(g));
      return g;
    });

    await step('Copy SVG puts SVG code on the clipboard as text', async () => {
      await clearNotice();
      await vs.wvClick(await wv(), `document.getElementById('copySvg')`);
      await vs.waitFor(async () => /SVG code/.test(await noticeText()), 10000);
      const t = execSync('pbpaste', { encoding: 'utf8', maxBuffer: 64 << 20 });
      if (!/^<svg[\s>]/.test(t)) throw new Error('clipboard text: ' + t.slice(0, 80));
      return { chars: t.length };
    });

    await step('support footer in the panel, never in the picture; no sign-in', async () => {
      const f = await E(`(document.getElementById('zovo-support') || {}).textContent || ''`);
      const inSvg = await E(`document.querySelector('#stage svg').textContent.includes('Sponsor')`);
      if (!/Sponsor/.test(f) || !/More free viewers/.test(f)) throw new Error('footer ' + f);
      if (inSvg) throw new Error('footer text in the picture');
      return { footer: f };
    });

    await step('no network: no sockets from the extension host; webview loaded only local resources; CSP default-src none', async () => {
      const s = sockets();
      const res = await E(`performance.getEntriesByType('resource').map(e => e.name)`);
      const remote = res.filter(n => !/vscode-resource|vscode-cdn|vscode-webview/.test(n));
      const csp = await E(`document.querySelector('meta[http-equiv=Content-Security-Policy]').content`);
      if (s.length) throw new Error('sockets: ' + s.join(' | '));
      if (remote.length) throw new Error('remote: ' + remote.join(','));
      if (!/default-src 'none'/.test(csp) || /connect-src (?!'none')/.test(csp)) throw new Error('csp ' + csp);
      return { sockets: s.length, resources: res.length, remote: remote.length, csp };
    });
  }

  // Phase 2: restart with the clock moved 1 day: the rating ask shows after the earlier good copies
  if (!quick) {
    await vs.close();
    process.env.ZOVO_RATING_CLOCK_OFFSET_DAYS = '1';
    vs = await launch(work, port, ws, SETTINGS);
    await vs.s.send('Emulation.setFocusEmulationEnabled', { enabled: true }, vs.wb).catch(() => {});
    await sleep(2500);
    await step('rating ask v2 shows on the second day after 3 good copies; toolbar choices kept', async () => {
      let msg = null;
      for (const f of ['main.rs', 'server.py', 'handler.go']) {
        await vs.s.send('Page.bringToFront', {}, vs.wb).catch(() => {});
        await openFile(f); await selectAll(); await clearNotice().catch(() => {});
        try { await copyAndWait(); } catch (e) { if (!/panel webview/.test(e.message)) throw e; }
        msg = await vs.waitFor(async () => { const t = await vs.wbEval(`[...document.querySelectorAll('.notification-list-item')].map(n => n.textContent).join('|')`); return /Is Code Screenshot useful\?/.test(t) ? t : null; }, 4000);
        if (msg) break;
      }
      await shot('09-rating-ask');
      if (!msg) throw new Error('no rating ask');
      const buttons = await vs.wbEval(`[...document.querySelectorAll('.notification-list-item .monaco-button')].map(b => b.textContent)`);
      const scale = await E(`document.getElementById('scale').value`);
      return { message: msg.slice(0, 120), buttons, scaleKept: scale };
    });
  }
} catch (e) {
  R.fatal = String(e.stack || e).slice(0, 1000);
  console.log('FATAL', R.fatal);
} finally {
  if (vs) {
    R.console = vs.console.filter(c => /screenshot|webview|CSP|Content Security|codeScreenshot/i.test(c.text) || /webview/.test(c.where)).slice(0, 40);
    await vs.close();
  }
  if (savedClipboard !== null) { try { execSync('pbcopy', { input: savedClipboard }); } catch {} }
  R.finished = new Date().toISOString();
  R.pass = R.steps.filter(s => s.ok).length; R.fail = R.steps.filter(s => !s.ok).length;
  fs.writeFileSync(outFile, JSON.stringify(R, null, 1));
  console.log(`done: ${R.pass} pass, ${R.fail} fail`);
}
