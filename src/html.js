'use strict';
// The panel page. Strict CSP: no remote source of any kind, scripts and the style element only by nonce, no
// connect, no frames, no workers. The picture is built with DOM calls (textContent), never from HTML strings, so
// code that contains <script> or </svg> stays text.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function csp(cspSource, nonce) {
  return [
    "default-src 'none'",
    `img-src ${cspSource} blob: data:`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const BACKGROUNDS = [
  ['gradient-1', 'Gradient: dusk'], ['gradient-2', 'Gradient: sea'], ['gradient-3', 'Gradient: peach'], ['gradient-4', 'Gradient: mint'],
  ['gradient-5', 'Gradient: night'], ['solid', 'Solid color'], ['editor', 'Editor color'], ['transparent', 'Transparent'],
];
const FRAMES = [['mac', 'Window with dots'], ['plain', 'Window, no dots'], ['none', 'No window']];
const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');

/** o: { cspSource, scriptUri, styleUri, showSupportLinks, nonce? } */
function buildHtml(o) {
  const nonce = o.nonce || crypto.randomBytes(16).toString('base64');
  const footer = footerHtml('codeScreenshot', o.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp(o.cspSource, nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${esc(o.styleUri)}">
${footer ? `<style nonce="${esc(nonce)}">${FOOTER_CSS}</style>` : ''}
<title>Code Screenshot</title>
</head>
<body>
<div id="app">
  <div id="toolbar" role="toolbar" aria-label="Code Screenshot">
    <div class="row main">
      <button id="copyPng" class="primary" title="Copy the picture to the clipboard as PNG">Copy PNG</button>
      <button id="savePng" title="Save as PNG">Save PNG</button>
      <button id="saveSvg" title="Save as SVG (text stays text)">Save SVG</button>
      <button id="copySvg" title="Copy the SVG code as text">Copy SVG</button>
      <label class="grp" title="PNG pixels per point">Scale
        <select id="scale" aria-label="PNG scale"><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option><option value="4">4x</option></select></label>
      <span id="size" class="muted" aria-live="polite"></span>
      <button id="more" class="ghost" aria-expanded="false" aria-controls="options" title="Frame, background, lines and font">Options ▾</button>
    </div>
    <div id="options" class="hidden">
      <div class="row">
        <label class="grp"><input type="checkbox" id="lineNumbers"> Line numbers</label>
        <label class="grp">Frame <select id="frame" aria-label="Window frame">${opts(FRAMES, 'mac')}</select></label>
        <label class="grp">Title <input id="title" type="text" maxlength="200" placeholder="file name" aria-label="Window title"></label>
        <label class="grp"><input type="checkbox" id="showTitle"> Show title</label>
      </div>
      <div class="row">
        <label class="grp">Background <select id="background" aria-label="Background">${opts(BACKGROUNDS, 'gradient-1')}</select></label>
        <input id="bgColor" type="color" value="#6c5ce7" aria-label="Solid background color">
        <label class="grp">Padding <input id="padding" type="range" min="0" max="128" step="4" aria-label="Padding"><span id="paddingVal" class="muted"></span></label>
        <label class="grp"><input type="checkbox" id="shadow"> Shadow</label>
        <label class="grp">Corners <input id="radius" type="range" min="0" max="24" step="1" aria-label="Corner radius"></label>
      </div>
      <div class="row">
        <label class="grp"><input type="checkbox" id="trimIndent"> Remove common indent</label>
        <label class="grp">Wrap at <input id="wrap" type="number" min="0" max="400" step="1" aria-label="Wrap at columns (0 is off)"> columns</label>
        <label class="grp">Font size <input id="fontSize" type="number" min="0" max="72" step="1" aria-label="Font size (0 uses the editor size)"></label>
        <label class="grp">Mark text <input id="mark" type="text" maxlength="200" placeholder="word to mark" aria-label="Mark every match of this text"></label>
        <button id="clearMarks" class="ghost" title="Remove line highlights and marks">Clear highlights</button>
      </div>
      <div class="row muted hint">Click a line to highlight it. Double-click a word to mark it.</div>
    </div>
  </div>
  <div id="notice" class="hidden" role="status"></div>
  <div id="stage" aria-label="Picture of the code"><div id="empty">Select code in the editor, then run Code Screenshot: Copy as Image.</div></div>
  ${footer}
</div>
<script nonce="${nonce}" src="${esc(o.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, csp, esc, BACKGROUNDS, FRAMES };
