'use strict';
// Pure text layout shared by the extension host and the webview: which lines go into the picture, tabs to spaces,
// the common indent, long lines, and wrapping at N columns. No DOM and no VS Code here, so it is unit tested.

/**
 * Lines to draw from the editor state.
 * selections: [{ start: {line, character}, end: {line, character}, isEmpty }]
 * visible: [{ start: line, end: line }] (editor.visibleRanges; a gap between two ranges is a folded region)
 * lineCount: lines in the document; whenEmpty: 'visible' | 'file'
 * Returns blocks: [{ from, to, hidden: [[a, b], ...] }] (0-based, inclusive) and the reason.
 */
function pickLines(selections, visible, lineCount, whenEmpty) {
  const nonEmpty = selections.filter(s => !(s.start.line === s.end.line && s.start.character === s.end.character));
  let ranges;
  let source;
  if (nonEmpty.length) {
    source = 'selection';
    ranges = nonEmpty.map(s => {
      const a = Math.min(s.start.line, s.end.line);
      let b = Math.max(s.start.line, s.end.line);
      const endPos = s.end.line >= s.start.line ? s.end : s.start;
      // A selection that ends at the start of a line does not include that line.
      if (b > a && endPos.line === b && endPos.character === 0) b--;
      return [a, b];
    });
  } else if (whenEmpty === 'file') {
    source = 'file';
    ranges = [[0, Math.max(0, lineCount - 1)]];
  } else {
    source = 'visible';
    const v = visible.filter(r => r && r.end >= r.start);
    ranges = v.length ? [[v[0].start, v[v.length - 1].end]] : [[0, Math.min(lineCount - 1, 39)]];
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of ranges) {
    const p = merged[merged.length - 1];
    if (p && r[0] <= p[1] + 1) p[1] = Math.max(p[1], r[1]);
    else merged.push(r.slice());
  }
  const folds = foldedGaps(visible);
  return {
    source,
    blocks: merged.map(([from, to]) => ({ from, to: Math.min(to, lineCount - 1), hidden: folds.filter(([a, b]) => b >= from && a <= to).map(([a, b]) => [Math.max(a, from), Math.min(b, to)]) })),
  };
}

/** Folded lines: the gaps between visible ranges. */
function foldedGaps(visible) {
  const v = visible.filter(r => r && r.end >= r.start).slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 1; i < v.length; i++) if (v[i].start > v[i - 1].end + 1) out.push([v[i - 1].end + 1, v[i].start - 1]);
  return out;
}

/**
 * Rows of the picture before tokenizing: [{ n (1-based line number) }] or [{ skip: count }].
 * blocks from pickLines.
 */
function rowPlan(blocks) {
  const rows = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (k > 0) {
      const prev = blocks[k - 1];
      rows.push({ skip: b.from - prev.to - 1 });
    }
    let i = b.from;
    while (i <= b.to) {
      const h = b.hidden.find(([a, z]) => i >= a && i <= z);
      if (h) {
        // VS Code keeps the first line of a fold visible; the gap starts after it, so the "..." row stands for the gap.
        rows.push({ skip: h[1] - i + 1, folded: true });
        i = h[1] + 1;
        continue;
      }
      rows.push({ n: i + 1 });
      i++;
    }
  }
  return rows;
}

/** Tabs to spaces by column, inside colored segments. segs: [[text, color, style]] */
function expandTabs(segs, tabSize) {
  const ts = Math.max(1, Math.min(16, tabSize | 0 || 4));
  let col = 0;
  const out = [];
  for (const s of segs) {
    const t = s[0];
    if (t.indexOf('\t') < 0) { col += cols(t); out.push(s); continue; }
    let r = '';
    for (const ch of t) {
      if (ch === '\t') { const n = ts - (col % ts); r += ' '.repeat(n); col += n; } else { r += ch; col += charCols(ch); }
    }
    out.push([r, s[1], s[2]]);
  }
  return out;
}

function leadingSpaces(segs) {
  let n = 0;
  for (const s of segs) {
    const m = /^ */.exec(s[0])[0].length;
    n += m;
    if (m < s[0].length) return n;
  }
  return -1; // blank line
}

/** The indent every non-blank line shares (in columns, after tabs became spaces). */
function commonIndent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (!l.segs) continue;
    const n = leadingSpaces(l.segs);
    if (n >= 0 && n < min) min = n;
  }
  return min === Infinity ? 0 : min;
}

/** Drop the first n columns (spaces only). */
function dropColumns(segs, n) {
  if (n <= 0) return segs;
  let left = n;
  const out = [];
  for (const s of segs) {
    if (left > 0) {
      const sp = /^ */.exec(s[0])[0].length;
      const k = Math.min(sp, left);
      left -= k;
      if (k < s[0].length) out.push(k ? [s[0].slice(k), s[1], s[2]] : s);
      if (k < sp || k < s[0].length) left = 0;
    } else out.push(s);
  }
  return out;
}

// Wide characters (CJK, fullwidth forms, most emoji) take two columns in a monospace editor.
// Ranges as numbers, so the source stays plain ASCII.
const range = pairs => '[' + pairs.map(([a, b]) => esc(a) + '-' + esc(b)).join('') + ']';
function esc(cp) { return '\\u{' + cp.toString(16) + '}'; }
const WIDE = new RegExp(range([[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]]), 'u');
const ZERO = new RegExp(range([[0x300, 0x36f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfe00, 0xfe0f]]), 'u');
function charCols(ch) { return ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1; }
function cols(t) {
  let n = 0;
  for (const ch of t) n += charCols(ch);
  return n;
}
function segsCols(segs) { let n = 0; for (const s of segs) n += cols(s[0]); return n; }
function segsLength(segs) { let n = 0; for (const s of segs) n += s[0].length; return n; }

/** Cut a line at max characters and add a marker. Returns { segs, cut } */
function cutLine(segs, max, markColor) {
  if (segsLength(segs) <= max) return { segs, cut: false };
  const out = [];
  let left = max;
  for (const s of segs) {
    if (left <= 0) break;
    if (s[0].length <= left) { out.push(s); left -= s[0].length; } else {
      let t = s[0].slice(0, left);
      if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
      out.push([t, s[1], s[2]]);
      left = 0;
    }
  }
  out.push([' …', markColor, 0]);
  return { segs: out, cut: true };
}

/**
 * Wrap one line at width columns. Continuation rows keep the line's indent (up to half the width).
 * Returns an array of rows, each an array of segments.
 */
function wrapLine(segs, width) {
  if (!width || width < 8 || segsCols(segs) <= width) return [segs];
  const indent = Math.max(0, Math.min(leadingSpaces(segs), Math.floor(width / 2)));
  const rows = [];
  let row = [];
  let col = 0;
  let limit = width;
  const pushChar = (ch, s) => {
    const p = row[row.length - 1];
    if (p && p[1] === s[1] && p[2] === s[2]) p[0] += ch; else row.push([ch, s[1], s[2]]);
  };
  // Break at the last space before the limit when there is one in the second half of the row.
  for (const s of segs) {
    for (const ch of s[0]) {
      const w = charCols(ch);
      if (col + w > limit) {
        let carry = [];
        const flat = row.map(x => x[0]).join('');
        const sp = flat.lastIndexOf(' ');
        const minBreak = (rows.length ? indent : 0) + Math.floor((limit - (rows.length ? indent : 0)) / 2);
        if (ch !== ' ' && sp > minBreak && sp < flat.length - 1) {
          // move the text after the space to the next row
          let pos = 0;
          const keep = [];
          for (const x of row) {
            const end = pos + x[0].length;
            if (end <= sp + 1) keep.push(x);
            else if (pos >= sp + 1) carry.push(x);
            else { keep.push([x[0].slice(0, sp + 1 - pos), x[1], x[2]]); carry.push([x[0].slice(sp + 1 - pos), x[1], x[2]]); }
            pos = end;
          }
          row = keep;
        }
        if (ch === ' ' && !carry.length) {
          // the space at the break stays at the end of this row, so the rows join back to the line text
          const p = row[row.length - 1];
          if (p && p[1] === s[1] && p[2] === s[2]) p[0] += ch; else row.push([ch, s[1], s[2]]);
          rows.push(row);
          row = indent ? [[' '.repeat(indent), s[1], 0]] : [];
          if (indent) row.pre = indent;
          col = indent;
          continue;
        }
        rows.push(row);
        row = indent ? [[' '.repeat(indent), s[1], 0]] : [];
        if (indent) row.pre = indent;
        col = indent;
        limit = width;
        for (const x of carry) { row.push(x); col += cols(x[0]); }
      }
      pushChar(ch, s);
      col += w;
    }
  }
  const rowLen = row.reduce((n, x) => n + x[0].length, 0);
  if (rowLen > (row.pre || 0) || !rows.length) rows.push(row);
  return rows;
}

/**
 * Final rows for drawing. lines: [{ n, segs } | { skip, folded }]; o: { trimIndent, wrap, indent (common indent) }
 * Returns [{ n, segs, cont } | { skip, folded }]
 */
function layoutRows(lines, o) {
  const out = [];
  const indent = o.trimIndent ? (o.indent || 0) : 0;
  for (const l of lines) {
    if (!l.segs) { out.push({ skip: l.skip, folded: !!l.folded }); continue; }
    const segs = dropColumns(l.segs, indent);
    const rows = wrapLine(segs, o.wrap || 0);
    rows.forEach((r, i) => out.push({ n: l.n, segs: r, cont: i > 0 }));
  }
  return out;
}

/** Default file name: <file>-L12-L40.png (one line: <file>-L12.png). */
function defaultFileName(fileName, first, last, ext) {
  const base = String(fileName || 'code').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'code';
  const range = first === last ? `L${first}` : `L${first}-L${last}`;
  return `${base}-${range}.${ext}`;
}

/** VS Code's line height: 0 means about 1.5 x font size on macOS and 1.35 x elsewhere; below 8 it is a multiplier. */
function lineHeightPx(lineHeight, fontSize, platform) {
  const fs = Number(fontSize) > 0 ? Number(fontSize) : 14;
  const lh = Number(lineHeight) || 0;
  if (lh <= 0) return Math.round((platform === 'darwin' ? 1.5 : 1.35) * fs);
  if (lh < 8) return Math.round(lh * fs);
  return Math.round(lh);
}

module.exports = { pickLines, foldedGaps, rowPlan, expandTabs, commonIndent, dropColumns, cutLine, wrapLine, layoutRows, defaultFileName, lineHeightPx, cols, charCols, segsCols, segsLength, leadingSpaces };
