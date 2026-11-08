'use strict';
// Code Screenshot panel. Draws the colored lines the extension sends as one SVG (text stays text), then makes the
// PNG by drawing that SVG on a canvas at 1x to 4x. Only DOM calls build the picture (textContent, setAttribute),
// so code with <script>, </svg> or &lt; is drawn as text. No network: the page CSP has no connect-src.
const L = require('../core/layout');

const vscode = acquireVsCodeApi();
const SVGNS = 'http://www.w3.org/2000/svg';
const XMLNS = 'http://www.w3.org/XML/1998/namespace';
const MAX_SIDE = 16384; // largest canvas side Chromium draws reliably
const MAX_AREA = 120e6; // pixels; keeps the PNG under about 500 MB of canvas memory

const $ = id => document.getElementById(id);
const GRADIENTS = {
  'gradient-1': ['#5f2c82', '#49a09d'],
  'gradient-2': ['#2b5876', '#4e4376'],
  'gradient-3': ['#ffb88c', '#de6262'],
  'gradient-4': ['#a8e6cf', '#3d84a8'],
  'gradient-5': ['#0f2027', '#2c5364'],
};
const DEFAULT_PREFS = { scale: 2, lineNumbers: true, frame: 'mac', title: '', showTitle: true, background: 'gradient-1', bgColor: '#6c5ce7', padding: 48, shadow: true, radius: 10, trimIndent: true, wrap: 0, fontSize: 0, mark: '' };

let prefs = { ...DEFAULT_PREFS };
let model = null;
let highlights = new Set();
let marks = []; // [{ n, start, len }] in the line text after the common indent is removed
let lastClicked = null;
let picture = null; // { svg, w, h, rows }
let busy = false;
let modelKey = '';
let fontNote = '';

function post(m) { vscode.postMessage(m); }

// ---------- toolbar ----------
function readPrefs(p) {
  const o = { ...DEFAULT_PREFS, ...(p || {}) };
  o.scale = [1, 2, 3, 4].includes(Number(o.scale)) ? Number(o.scale) : 2;
  o.padding = clampInt(o.padding, 0, 128, 48);
  o.radius = clampInt(o.radius, 0, 24, 10);
  o.wrap = clampInt(o.wrap, 0, 400, 0);
  o.fontSize = clampInt(o.fontSize, 0, 72, 0);
  if (!['mac', 'plain', 'none'].includes(o.frame)) o.frame = 'mac';
  if (!(o.background in GRADIENTS) && !['solid', 'editor', 'transparent'].includes(o.background)) o.background = 'gradient-1';
  if (!/^#[0-9a-f]{6}$/i.test(o.bgColor)) o.bgColor = '#6c5ce7';
  o.title = String(o.title || '').slice(0, 200);
  o.mark = String(o.mark || '').slice(0, 200);
  for (const k of ['lineNumbers', 'showTitle', 'shadow', 'trimIndent']) o[k] = !!o[k];
  return o;
}
function clampInt(v, lo, hi, d) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }

function showPrefs() {
  $('scale').value = String(prefs.scale);
  $('lineNumbers').checked = prefs.lineNumbers;
  $('frame').value = prefs.frame;
  $('title').value = prefs.title;
  $('showTitle').checked = prefs.showTitle;
  $('background').value = prefs.background;
  $('bgColor').value = prefs.bgColor;
  $('bgColor').classList.toggle('hidden', prefs.background !== 'solid');
  $('padding').value = String(prefs.padding);
  $('paddingVal').textContent = prefs.padding + ' px';
  $('shadow').checked = prefs.shadow;
  $('radius').value = String(prefs.radius);
  $('trimIndent').checked = prefs.trimIndent;
  $('wrap').value = String(prefs.wrap);
  $('fontSize').value = String(prefs.fontSize || '');
  $('fontSize').placeholder = model ? String(model.font.size) : 'editor';
  $('mark').value = prefs.mark;
}

let prefTimer = null;
function changed(save = true) {
  prefs = readPrefs(prefs);
  showPrefs();
  draw();
  if (save) { clearTimeout(prefTimer); prefTimer = setTimeout(() => post({ type: 'prefs', prefs }), 300); }
}

function wire() {
  const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
  on('copyPng', 'click', () => run('copyPng', true));
  on('savePng', 'click', () => run('savePng', true));
  on('saveSvg', 'click', () => run('saveSvg', true));
  on('copySvg', 'click', () => run('copySvg', true));
  on('scale', 'change', e => { prefs.scale = Number(e.target.value); changed(); });
  on('more', 'click', () => { const h = $('options').classList.toggle('hidden'); $('more').setAttribute('aria-expanded', String(!h)); $('more').textContent = h ? 'Options ▾' : 'Options ▴'; });
  on('lineNumbers', 'change', e => { prefs.lineNumbers = e.target.checked; changed(); });
  on('frame', 'change', e => { prefs.frame = e.target.value; changed(); });
  on('title', 'input', e => { prefs.title = e.target.value; changed(); });
  on('showTitle', 'change', e => { prefs.showTitle = e.target.checked; changed(); });
  on('background', 'change', e => { prefs.background = e.target.value; changed(); });
  on('bgColor', 'input', e => { prefs.bgColor = e.target.value; changed(); });
  on('padding', 'input', e => { prefs.padding = Number(e.target.value); changed(); });
  on('shadow', 'change', e => { prefs.shadow = e.target.checked; changed(); });
  on('radius', 'input', e => { prefs.radius = Number(e.target.value); changed(); });
  on('trimIndent', 'change', e => { prefs.trimIndent = e.target.checked; marks = []; changed(); });
  on('wrap', 'change', e => { prefs.wrap = Number(e.target.value); changed(); });
  on('fontSize', 'change', e => { prefs.fontSize = Number(e.target.value) || 0; changed(); });
  on('mark', 'input', e => { prefs.mark = e.target.value; changed(false); });
  on('clearMarks', 'click', () => { highlights = new Set(); marks = []; prefs.mark = ''; changed(false); });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && !isTextField(document.activeElement) && !String(window.getSelection() || '')) { e.preventDefault(); run('copyPng', true); }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); run('savePng', true); }
  });
}
function isTextField(el) { return !!el && (el.tagName === 'INPUT' && /^(text|number)$/.test(el.type) || el.tagName === 'TEXTAREA'); }

function notice(text, kind, actions) {
  const n = $('notice');
  n.textContent = '';
  if (!text) { n.className = 'hidden'; return; }
  n.className = 'notice ' + (kind || 'info');
  const span = document.createElement('span');
  span.textContent = text;
  n.appendChild(span);
  for (const a of actions || []) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.addEventListener('click', a.run);
    n.appendChild(b);
  }
}

// ---------- fonts ----------
function fontStack(f) { return f.family || 'monospace'; }
function firstFamily(stack) {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/.exec(stack || '');
  return m ? (m[1] || m[2] || m[3]).trim() : '';
}
const GENERIC = /^(monospace|serif|sans-serif|system-ui|ui-monospace|cursive|fantasy|-apple-system|BlinkMacSystemFont)$/i;
function fontInstalled(name) {
  if (!name || GENERIC.test(name)) return true;
  const c = document.createElement('canvas').getContext('2d');
  const probe = 'mmmmmmmmmmlli10OQ@#=>→';
  const q = `"${name.replace(/"/g, '')}"`;
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    c.font = `40px ${base}`; const a = c.measureText(probe).width;
    c.font = `40px ${q}, ${base}`; const b = c.measureText(probe).width;
    if (Math.abs(a - b) > 0.01) return true;
  }
  return false;
}
async function waitFonts(f, px) {
  const stack = fontStack(f);
  try {
    const fams = stack.split(',').map(s => s.trim()).filter(Boolean);
    await Promise.race([Promise.all(fams.map(x => document.fonts.load(`${f.weight || 'normal'} ${px}px ${x}`).catch(() => null))), new Promise(r => setTimeout(r, 1500))]);
    await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]);
  } catch {}
  const first = firstFamily(stack);
  fontNote = fontInstalled(first) ? '' : `The font "${first}" from your editor settings is not installed where this panel runs, so the picture uses the next font in the list.`;
}

function ligatureCss(lig) {
  if (lig === false || lig === undefined || lig === null || lig === 'false') return 'font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0';
  if (lig === true || lig === 'true') return 'font-feature-settings:"liga" 1,"calt" 1';
  const s = String(lig).replace(/[^a-zA-Z0-9'", ]/g, '');
  return s ? `font-feature-settings:${s}` : '';
}

// ---------- drawing ----------
function el(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  if (attrs) for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

function relLum(hex) {
  const m = /^#?([0-9a-f]{3,8})$/i.exec(hex || '');
  if (!m) return 0;
  let h = m[1];
  if (h.length <= 4) h = h.split('').map(c => c + c).join('');
  const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function solidHex(hex) { const m = /^#([0-9a-f]{6})/i.exec(hex || ''); return m ? '#' + m[1] : hex; }
function alphaOf(hex) { const m = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(hex || ''); return m ? parseInt(m[1], 16) / 255 : 1; }
function paint(node, attr, hex) {
  node.setAttribute(attr, solidHex(hex));
  const a = alphaOf(hex);
  if (a < 1) node.setAttribute(attr + '-opacity', a.toFixed(3));
}

/** Rows to draw, with each row's place in its source line (for marks). */
function buildRows() {
  const lines = model.lines;
  const rows = L.layoutRows(lines, { trimIndent: prefs.trimIndent, wrap: prefs.wrap, indent: model.indent });
  // offsets: where each row starts in the (indent-trimmed) line text
  const pos = new Map();
  for (const r of rows) {
    if (!r.segs) continue;
    const t = r.segs.map(s => s[0]).join('');
    const pre = r.cont && r.segs.pre ? r.segs.pre : 0;
    const start = pos.get(r.n) || 0;
    r.text = t; r.pre = pre; r.off = start;
    pos.set(r.n, start + t.length - pre);
  }
  return rows;
}

function lineTexts() {
  const map = new Map();
  for (const l of model.lines) if (l.segs) map.set(l.n, L.dropColumns(l.segs, prefs.trimIndent ? model.indent : 0).map(s => s[0]).join(''));
  return map;
}

function allMarks() {
  const out = marks.slice();
  const q = prefs.mark;
  if (q) {
    for (const [n, t] of lineTexts()) {
      let i = t.indexOf(q);
      let guard = 0;
      while (i >= 0 && guard++ < 1000) { out.push({ n, start: i, len: q.length }); i = t.indexOf(q, i + q.length); }
    }
  }
  return out;
}

// Every draw and export runs one after the other: a copy never reads a picture that another draw is replacing.
let chain = Promise.resolve();
function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }
let drawsQueued = 0;
function draw() {
  drawsQueued++;
  return serial(async () => { drawsQueued--; if (drawsQueued > 0) return picture; return drawNow(); });
}
const timing = {};
function mark(k, t) { timing[k] = Math.round(performance.now() - t); document.body.dataset.timing = JSON.stringify(timing); }

async function drawNow() {
  if (!model) return null;
  const tDraw = performance.now();
  const f = model.font;
  const px = prefs.fontSize || f.size;
  const lineH = Math.max(8, Math.round(f.lineHeight * px / f.size));
  await waitFonts(f, px);
  mark('fonts', tDraw);
  const rows = buildRows();
  const c = model.colors;
  const dark = relLum(solidHex(c.background)) < 0.4;
  const stage = $('stage');
  const svg = el('svg', { xmlns: SVGNS, role: 'img' });
  svg.setAttribute('aria-label', 'Code from ' + model.fileName);
  const defs = el('defs', null, svg);
  const bgLayer = el('g', null, svg);
  const win = el('g', null, svg);
  const font = el('g', { 'font-family': fontStack(f), 'font-size': px, 'font-weight': f.weight || 'normal' });
  font.setAttributeNS(XMLNS, 'xml:space', 'preserve');
  const lig = ligatureCss(f.ligatures);
  font.style.cssText = 'white-space:pre;' + lig + (f.letterSpacing ? `;letter-spacing:${Number(f.letterSpacing)}px` : '');
  // measure every row at x = 0 first
  stage.textContent = '';
  stage.appendChild(svg);
  svg.appendChild(font);
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `${f.weight || 'normal'} ${px}px ${fontStack(f)}`;
  const mt = meas.measureText('Hg│');
  const asc = mt.fontBoundingBoxAscent || px * 0.8;
  const desc = mt.fontBoundingBoxDescent || px * 0.2;
  const baseline = Math.round(((lineH - (asc + desc)) / 2 + asc) * 100) / 100;
  const digitW = meas.measureText('0').width || px * 0.6;
  const texts = [];
  let maxW = 0;
  for (const r of rows) {
    if (!r.segs) { texts.push(null); continue; }
    const t = el('text', { x: 0, y: 0 }, font);
    t.setAttributeNS(XMLNS, 'xml:space', 'preserve');
    for (const s of r.segs) {
      const sp = el('tspan', { fill: solidHex(s[1]) }, t);
      if (alphaOf(s[1]) < 1) sp.setAttribute('fill-opacity', alphaOf(s[1]).toFixed(3));
      if (s[2] & 1) sp.setAttribute('font-style', 'italic');
      if (s[2] & 2) sp.setAttribute('font-weight', 'bold');
      if (s[2] & 12) sp.setAttribute('text-decoration', [(s[2] & 4) ? 'underline' : '', (s[2] & 8) ? 'line-through' : ''].filter(Boolean).join(' '));
      sp.textContent = s[0];
    }
    texts.push(t);
    const w = r.text.length ? t.getComputedTextLength() : 0;
    if (w > maxW) maxW = w;
  }
  // geometry
  const frame = prefs.frame;
  const pad = prefs.background === 'transparent' && frame === 'none' ? Math.min(prefs.padding, 16) : prefs.padding;
  const barH = frame === 'none' ? 0 : Math.round(Math.max(28, px * 2.4));
  const inTop = frame === 'none' ? Math.round(px * 1.2) : Math.round(px * 0.3);
  const inBottom = Math.round(px * 1.2);
  const inLeft = Math.round(px * 1.4);
  const inRight = Math.round(px * 1.6);
  const maxN = rows.reduce((m, r) => (r.n > m ? r.n : m), 0);
  const gutter = prefs.lineNumbers ? Math.ceil(String(maxN).length * digitW + px * 1.3) : 0;
  const title = prefs.showTitle && frame !== 'none' ? (prefs.title || model.fileName) : '';
  meas.font = `${Math.round(px * 0.9)}px ${fontStack(f)}`;
  const titleW = title ? meas.measureText(title).width : 0;
  const winW = Math.ceil(Math.max(inLeft + gutter + maxW + inRight, title ? titleW + 140 : 0, frame === 'none' ? 0 : 220));
  const winH = Math.ceil(barH + inTop + rows.length * lineH + inBottom);
  const W = winW + pad * 2;
  const H = winH + pad * 2;
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  // background
  if (prefs.background in GRADIENTS) {
    const g = el('linearGradient', { id: 'bg', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el('stop', { offset: 0, 'stop-color': GRADIENTS[prefs.background][0] }, g);
    el('stop', { offset: 1, 'stop-color': GRADIENTS[prefs.background][1] }, g);
    el('rect', { width: W, height: H, fill: 'url(#bg)' }, bgLayer);
  } else if (prefs.background === 'solid') el('rect', { width: W, height: H, fill: prefs.bgColor }, bgLayer);
  else if (prefs.background === 'editor') paint(el('rect', { width: W, height: H }, bgLayer), 'fill', c.background);
  // window
  win.setAttribute('transform', `translate(${pad} ${pad})`);
  const radius = frame === 'none' && pad === 0 ? 0 : prefs.radius;
  if (prefs.shadow && pad > 0) {
    const fl = el('filter', { id: 'shadow', x: '-20%', y: '-20%', width: '140%', height: '150%' }, defs);
    el('feDropShadow', { dx: 0, dy: Math.round(Math.min(pad, 48) * 0.3), stdDeviation: Math.round(Math.min(pad, 48) * 0.35), 'flood-color': '#000', 'flood-opacity': 0.45 }, fl);
  }
  const body = el('rect', { width: winW, height: winH, rx: radius, ry: radius }, win);
  paint(body, 'fill', c.background);
  if (prefs.shadow && pad > 0) body.setAttribute('filter', 'url(#shadow)');
  if (frame !== 'none') {
    el('rect', { x: 0.5, y: 0.5, width: winW - 1, height: winH - 1, rx: radius, ry: radius, fill: 'none', stroke: dark ? '#ffffff' : '#000000', 'stroke-opacity': dark ? 0.12 : 0.14 }, win);
    if (frame === 'mac') {
      const cy = Math.round(barH / 2);
      ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => el('circle', { cx: 20 + i * 20, cy, r: 6, fill: col }, win));
    }
    if (title) {
      const tt = el('text', { x: Math.round(winW / 2), y: Math.round(barH / 2), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': fontStack(f), 'font-size': Math.round(px * 0.9), fill: solidHex(c.foreground), 'fill-opacity': 0.62 }, win);
      tt.textContent = title;
    }
  }
  // highlights and marks under the text
  const hl = el('g', null, win);
  const codeX = inLeft + gutter;
  const top = barH + inTop;
  rows.forEach((r, i) => {
    if (r.segs && highlights.has(r.n)) {
      const rect = el('rect', { x: 0, y: top + i * lineH, width: winW, height: lineH, fill: solidHex(c.foreground), 'fill-opacity': 0.1 }, hl);
      rect.dataset.hl = '1';
      el('rect', { x: 0, y: top + i * lineH, width: 3, height: lineH, fill: solidHex(c.brackets && c.brackets[2] || c.foreground) }, hl);
    }
  });
  win.appendChild(font);
  font.setAttribute('transform', `translate(${codeX} 0)`);
  const nums = el('g', { 'font-family': fontStack(f), 'font-size': px, 'text-anchor': 'end' }, win);
  paint(nums, 'fill', c.lineNumber);
  rows.forEach((r, i) => {
    const y = top + i * lineH + baseline;
    if (!r.segs) {
      const t = el('text', { x: 0, y }, font);
      paint(t, 'fill', c.lineNumber);
      t.textContent = r.folded ? `⋯  ${r.skip} folded line${r.skip === 1 ? '' : 's'}` : '⋯';
      return;
    }
    texts[i].setAttribute('y', y);
    if (prefs.lineNumbers && !r.cont) { const t = el('text', { x: inLeft + gutter - Math.round(px * 1.1), y }, nums); t.textContent = String(r.n); }
  });
  // marks need text positions, so they come after the text is placed
  const mk = el('g', null, win);
  win.insertBefore(mk, font);
  const ms = allMarks();
  let markCount = 0;
  rows.forEach((r, i) => {
    if (!r.segs || !texts[i]) return;
    const rowLen = r.text.length - r.pre;
    for (const m of ms) {
      if (m.n !== r.n) continue;
      const a = Math.max(m.start, r.off);
      const b = Math.min(m.start + m.len, r.off + rowLen);
      if (b <= a) continue;
      const ci = r.pre + a - r.off;
      try {
        const x0 = texts[i].getStartPositionOfChar(ci).x;
        const w = texts[i].getSubStringLength(ci, b - a);
        const rect = el('rect', { x: codeX + x0 - 1, y: top + i * lineH + 1, width: w + 2, height: lineH - 2, rx: 3, ry: 3 }, mk);
        paint(rect, 'fill', c.mark);
        rect.dataset.mark = '1';
        markCount++;
      } catch {}
    }
  });
  // hit areas for clicks (removed from exports)
  const hits = el('g', { 'data-ui': '1', fill: 'transparent' }, win);
  rows.forEach((r, i) => { if (r.segs) { const h = el('rect', { x: 0, y: top + i * lineH, width: winW, height: lineH }, hits); h.dataset.row = String(i); } });
  hits.addEventListener('mousedown', e => onRowMouse(e, rows, texts, codeX, top, lineH));
  picture = { svg, w: W, h: H, rows: rows.length, marks: markCount };
  mark('draw', tDraw);
  $('size').textContent = sizeText();
  const notes = [];
  if (model.notes && model.notes.length) notes.push(...model.notes);
  if (fontNote) notes.push(fontNote);
  if (notes.length && !busy) notice(notes.join(' '), 'warn');
  else if (!busy && !$('notice').classList.contains('keep')) notice('');
  return picture;
}

function pngScale(w, h, want) {
  let s = want;
  while (s > 1 && (w * s > MAX_SIDE || h * s > MAX_SIDE || w * h * s * s > MAX_AREA)) s--;
  if (w * s > MAX_SIDE || h * s > MAX_SIDE || w * h * s * s > MAX_AREA) s = Math.min(MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)));
  return s;
}
function sizeText() {
  if (!picture) return '';
  const s = pngScale(picture.w, picture.h, prefs.scale);
  return `${Math.round(picture.w * s).toLocaleString('en-US')} × ${Math.round(picture.h * s).toLocaleString('en-US')} px`;
}

function onRowMouse(e, rows, texts, codeX, top, lineH) {
  const i = Number(e.target.dataset.row);
  const r = rows[i];
  if (!r || !r.segs) return;
  if (e.detail === 2) {
    // double-click: undo the line toggle of the first click, mark the word under the pointer
    toggleLine(r.n, false);
    const t = texts[i];
    const pt = picture.svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(t.getScreenCTM().inverse());
    p.y = Number(t.getAttribute('y')) - 2;
    let ci = -1;
    try { ci = t.getCharNumAtPosition(p); } catch {}
    if (ci >= r.pre) {
      const text = r.text;
      const word = /[\p{L}\p{N}_$]/u;
      let a = ci, b = ci + 1;
      if (word.test(text[ci] || '')) { while (a > r.pre && word.test(text[a - 1])) a--; while (b < text.length && word.test(text[b])) b++; }
      const m = { n: r.n, start: r.off + a - r.pre, len: b - a };
      const k = marks.findIndex(x => x.n === m.n && x.start === m.start && x.len === m.len);
      if (k >= 0) marks.splice(k, 1); else marks.push(m);
    }
    draw();
    return;
  }
  if (e.detail === 1) {
    if (e.shiftKey && lastClicked !== null) {
      const [a, b] = [Math.min(lastClicked, r.n), Math.max(lastClicked, r.n)];
      for (const x of rows) if (x.n >= a && x.n <= b) highlights.add(x.n);
      draw();
    } else toggleLine(r.n, true);
    lastClicked = r.n;
  }
}
function toggleLine(n, redraw) {
  if (highlights.has(n)) highlights.delete(n); else highlights.add(n);
  if (redraw) draw();
}

/** SVG text for export: interactive parts removed, standalone attributes added. */
function svgText() {
  const clone = picture.svg.cloneNode(true);
  clone.querySelectorAll('[data-ui]').forEach(n => n.remove());
  clone.querySelectorAll('[data-hl]').forEach(n => n.removeAttribute('data-hl'));
  clone.querySelectorAll('[data-mark]').forEach(n => n.removeAttribute('data-mark'));
  clone.removeAttribute('role');
  clone.setAttribute('xmlns', SVGNS);
  return new XMLSerializer().serializeToString(clone);
}

async function pngBlob() {
  const s = pngScale(picture.w, picture.h, prefs.scale);
  const w = Math.max(1, Math.round(picture.w * s));
  const h = Math.max(1, Math.round(picture.h * s));
  const url = URL.createObjectURL(new Blob([svgText()], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('the canvas could not make a PNG'))), 'image/png'));
    cv.width = 1; cv.height = 1;
    return { blob, w, h, scale: s };
  } finally { URL.revokeObjectURL(url); }
}

function toBase64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

let lastPng = null;
function run(action, byUser, reqId) { return serial(() => runNow(action, byUser, reqId)); }
async function runNow(action, byUser, reqId) {
  if (!model) { notice('Select code in the editor first, then run Code Screenshot: Copy as Image.', 'warn'); post({ type: 'done', reqId, action, ok: false }); return; }
  try {
    busy = true;
    if (!picture) await drawNow();
    const tRun = performance.now();
    if (action === 'saveSvg' || action === 'copySvg') {
      post({ type: 'svg', purpose: action, text: svgText(), name: model.names.svg, reqId });
    } else {
      const p = await pngBlob();
      mark('png', tRun);
      lastPng = p;
      const data = toBase64(await p.blob.arrayBuffer());
      mark('base64', tRun);
      const note = p.scale !== prefs.scale ? `The picture is too large for ${prefs.scale}x, so the PNG is ${Math.round(p.scale * 100) / 100}x.` : '';
      post({ type: 'png', purpose: action, data, w: p.w, h: p.h, scale: p.scale, note, byUser: !!byUser, reqId });
    }
  } catch (err) {
    const msg = 'Code Screenshot could not make the picture: ' + String(err && err.message || err);
    notice(msg, 'error'); $('notice').classList.add('keep');
    post({ type: 'error', message: msg, reqId, action });
  } finally { busy = false; }
}

/** Clipboard from the panel itself (used when the extension cannot reach the OS clipboard, e.g. in a browser). */
async function copyInPanel() {
  try {
    const p = lastPng || await pngBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': p.blob })]);
    notice(`Copied the PNG (${p.w} × ${p.h} px) to the clipboard.`, 'ok');
    post({ type: 'copiedInPanel', w: p.w, h: p.h });
    return true;
  } catch (err) {
    notice('The panel could not copy the image either: ' + String(err && err.message || err) + '. Use Save PNG.', 'error', [{ label: 'Save PNG', primary: true, run: () => run('savePng', true) }]);
    return false;
  }
}

window.addEventListener('message', async ev => {
  const m = ev.data;
  if (!m || typeof m.type !== 'string') return;
  switch (m.type) {
    case 'init':
      prefs = readPrefs(m.prefs);
      showPrefs();
      break;
    case 'render': {
      // Newer draws without an action make older ones without an action pointless; the queue skips those.
      const mine = ++renderSeq;
      if (!m.action) pendingPlain = mine;
      serial(async () => {
        if (!m.action && pendingPlain !== mine) return;
        await handleRender(m);
      });
      break;
    }
    case 'run': run(m.action, false, m.reqId); break;
    case 'timing': timing.clipboard = m.clipboardMs; timing.host = m.hostMs; document.body.dataset.timing = JSON.stringify(timing); break;
    case 'notice': notice(m.text, m.kind); if (m.keep) $('notice').classList.add('keep'); break;
    case 'copied': notice(m.text, 'ok'); $('notice').classList.add('keep'); break;
    case 'copyFailed':
      notice(m.text, 'error', [
        { label: 'Copy from this panel', primary: true, run: () => copyInPanel() },
        { label: 'Save PNG', run: () => run('savePng', true) },
      ]);
      $('notice').classList.add('keep');
      if (m.tryPanel) copyInPanel();
      break;
    case 'clear': model = null; picture = null; $('stage').textContent = ''; break;
    case 'probe': // test hook for the real-app gate: numbers about the drawn picture, no content
      post({ type: 'probe', reqId: m.reqId, info: probe() });
      break;
  }
});

let renderSeq = 0;
let pendingPlain = 0;
async function handleRender(m) {
  const t = performance.now();
  model = m.model;
  const key = model.uri + '|' + model.first + '|' + model.last;
  if (key !== modelKey) { highlights = new Set(); marks = []; lastClicked = null; modelKey = key; }
  showPrefs();
  picture = null;
  $('notice').classList.remove('keep');
  try {
    await drawNow();
    mark('render', t);
    post({ type: 'rendered', reqId: m.reqId, w: picture.w, h: picture.h, rows: picture.rows, fontNote });
    if (m.action) await runNow(m.action, false, m.reqId);
  } catch (err) {
    const msg = 'Code Screenshot could not draw the code: ' + String(err && err.message || err);
    notice(msg, 'error'); $('notice').classList.add('keep');
    post({ type: 'error', message: msg, reqId: m.reqId });
  }
}

function probe() {
  if (!picture) return null;
  const s = picture.svg;
  return {
    w: picture.w, h: picture.h, rows: picture.rows, marks: picture.marks, highlights: highlights.size,
    texts: s.querySelectorAll('text').length, scripts: s.querySelectorAll('script').length, foreign: s.querySelectorAll('foreignObject').length,
    fonts: s.querySelector('g[font-family]') && s.querySelector('g[font-family]').getAttribute('font-family'), fontNote,
  };
}

wire();
showPrefs();
post({ type: 'ready' });
