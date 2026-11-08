'use strict';
// Finds the color theme VS Code is using and turns it into what the tokenizer and the picture need:
// editor colors and a TextMate theme (token colors), with the user's color customizations applied.
// Pure functions: the caller passes the extension list and a file reader, so tests need no VS Code.

/** JSON with comments and trailing commas (theme files are JSONC). Strings are kept as they are. */
function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

/** Minimal property-list reader for .tmTheme files (dict, array, string, integer, true/false). */
function parsePlist(xml) {
  const re = /<(\/?)(dict|array|key|string|integer|real|true|false|date|data)(\s*\/)?>|([^<]+)/g;
  const stack = [];
  let root;
  let key = null;
  let textTag = null;
  let text = '';
  const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const put = v => {
    const top = stack[stack.length - 1];
    if (!top) { root = v; return; }
    if (Array.isArray(top)) top.push(v);
    else if (key !== null) { top[key] = v; key = null; }
  };
  let m;
  while ((m = re.exec(xml))) {
    if (m[4] !== undefined) { if (textTag) text += m[4]; continue; }
    const close = m[1] === '/';
    const tag = m[2];
    const selfClose = !!m[3];
    if (tag === 'dict' || tag === 'array') {
      if (selfClose) { put(tag === 'dict' ? {} : []); continue; }
      if (!close) { const v = tag === 'dict' ? {} : []; put(v); stack.push(v); } else stack.pop();
      continue;
    }
    if (tag === 'true' || tag === 'false') { put(tag === 'true'); continue; }
    if (selfClose) { if (tag === 'key') key = ''; else put(''); continue; }
    if (!close) { textTag = tag; text = ''; continue; }
    const v = unxml(text);
    textTag = null;
    if (tag === 'key') key = v;
    else if (tag === 'integer' || tag === 'real') put(Number(v));
    else put(v);
  }
  return root;
}

const DEFAULTS = {
  dark: { 'editor.background': '#1E1E1E', 'editor.foreground': '#D4D4D4', 'editorLineNumber.foreground': '#858585',
    'editorBracketHighlight.foreground1': '#FFD700', 'editorBracketHighlight.foreground2': '#DA70D6', 'editorBracketHighlight.foreground3': '#179FFF',
    'editorBracketHighlight.unexpectedBracket.foreground': '#FF1212CC', 'editor.lineHighlightBackground': '#FFFFFF1A', 'editor.wordHighlightStrongBackground': '#004972B8' },
  light: { 'editor.background': '#FFFFFF', 'editor.foreground': '#000000', 'editorLineNumber.foreground': '#237893',
    'editorBracketHighlight.foreground1': '#0431FA', 'editorBracketHighlight.foreground2': '#319331', 'editorBracketHighlight.foreground3': '#7B3814',
    'editorBracketHighlight.unexpectedBracket.foreground': '#FF1212CC', 'editor.lineHighlightBackground': '#0000001A', 'editor.wordHighlightStrongBackground': '#0E639C40' },
  hc: { 'editor.background': '#000000', 'editor.foreground': '#FFFFFF', 'editorLineNumber.foreground': '#FFFFFF',
    'editorBracketHighlight.foreground1': '#FFD700', 'editorBracketHighlight.foreground2': '#DA70D6', 'editorBracketHighlight.foreground3': '#87CEFA',
    'editorBracketHighlight.unexpectedBracket.foreground': '#FF3232', 'editor.lineHighlightBackground': '#FFFFFF26', 'editor.wordHighlightStrongBackground': '#FFFFFF40' },
  hcLight: { 'editor.background': '#FFFFFF', 'editor.foreground': '#292929', 'editorLineNumber.foreground': '#292929',
    'editorBracketHighlight.foreground1': '#0431FA', 'editorBracketHighlight.foreground2': '#319331', 'editorBracketHighlight.foreground3': '#7B3814',
    'editorBracketHighlight.unexpectedBracket.foreground': '#B5200D', 'editor.lineHighlightBackground': '#0000001F', 'editor.wordHighlightStrongBackground': '#0F4A8540' },
};

/** uiTheme of a theme contribution -> our kind. */
function kindOf(uiTheme) {
  if (uiTheme === 'vs') return 'light';
  if (uiTheme === 'hc-black') return 'hc';
  if (uiTheme === 'hc-light') return 'hcLight';
  return 'dark';
}

/** VS Code ColorThemeKind (1 light, 2 dark, 3 high contrast, 4 high contrast light) -> our kind. */
function kindFromApi(k) { return k === 1 ? 'light' : k === 3 ? 'hc' : k === 4 ? 'hcLight' : 'dark'; }

/**
 * Which theme name VS Code shows, from the settings it reads (same order as the workbench).
 * cfg: getter for 'workbench.*' and 'window.*' keys; apiKind: vscode.window.activeColorTheme.kind.
 */
function activeThemeName(cfg, apiKind) {
  const kind = kindFromApi(apiKind);
  if ((kind === 'hc' || kind === 'hcLight') && cfg('window.autoDetectHighContrast') !== false) {
    const hc = kind === 'hc' ? cfg('workbench.preferredHighContrastColorTheme') : cfg('workbench.preferredHighContrastLightColorTheme');
    const cur = cfg('workbench.colorTheme');
    // When the chosen theme is not a high contrast one but VS Code shows high contrast, it uses the preferred one.
    return { name: cur, fallback: hc || (kind === 'hc' ? 'Default High Contrast' : 'Default High Contrast Light'), kind };
  }
  if (cfg('window.autoDetectColorScheme')) {
    const n = kind === 'light' ? cfg('workbench.preferredLightColorTheme') : cfg('workbench.preferredDarkColorTheme');
    if (n) return { name: n, fallback: cfg('workbench.colorTheme'), kind };
  }
  return { name: cfg('workbench.colorTheme') || (kind === 'light' ? 'Default Light Modern' : 'Default Dark Modern'), fallback: null, kind };
}

/** All theme contributions: [{ id, label, uiTheme, extUri, path, extId }] */
function themeContributions(extensions) {
  const out = [];
  for (const e of extensions) {
    const list = e.packageJSON && e.packageJSON.contributes && e.packageJSON.contributes.themes;
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!t || typeof t.path !== 'string') continue;
      out.push({ id: t.id || t.label, label: t.label || t.id, uiTheme: t.uiTheme || 'vs-dark', extUri: e.extensionUri, path: t.path, extId: e.id });
    }
  }
  return out;
}

function findTheme(contribs, name, kind) {
  if (!name) return null;
  const want = String(name);
  const k = t => kindOf(t.uiTheme);
  // Built-in themes are stored as "Default " + id in settings (for example "Default Dark Modern" for id "Dark Modern").
  const cands = contribs.filter(t => t.id === want || t.label === want || 'Default ' + t.id === want || (t.extId === 'vscode.theme-defaults' && want === 'Default ' + t.label));
  if (!cands.length) return null;
  return cands.find(t => k(t) === kind) || cands[0];
}

function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
function joinPath(base, rel) {
  const parts = (dirOf(base) + rel).replace(/\\/g, '/').split('/');
  const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
  return out.join('/');
}

/**
 * Read a theme file and its includes. read(extUri, relPath) -> Promise<string>.
 * Returns { colors, tokenColors, semanticHighlighting, semanticTokenColors }.
 */
async function loadThemeFile(read, extUri, relPath, depth = 0) {
  if (depth > 8) throw new Error('theme include loop');
  const text = await read(extUri, relPath);
  let data;
  if (/\.tmTheme$/i.test(relPath) || /^\s*<\?xml|^\s*<plist/.test(text)) {
    const pl = parsePlist(text) || {};
    return { colors: {}, tokenColors: Array.isArray(pl.settings) ? pl.settings : [], semanticHighlighting: false };
  }
  data = parseJsonc(text);
  let base = { colors: {}, tokenColors: [], semanticHighlighting: undefined, semanticTokenColors: {} };
  if (typeof data.include === 'string') base = await loadThemeFile(read, extUri, joinPath(relPath, data.include), depth + 1);
  const colors = { ...base.colors, ...(data.colors && typeof data.colors === 'object' ? data.colors : {}) };
  let tokenColors = base.tokenColors.slice();
  if (Array.isArray(data.tokenColors)) tokenColors = tokenColors.concat(data.tokenColors);
  else if (typeof data.tokenColors === 'string') {
    const sub = await loadThemeFile(read, extUri, joinPath(relPath, data.tokenColors), depth + 1);
    tokenColors = tokenColors.concat(sub.tokenColors);
  }
  return {
    colors, tokenColors,
    semanticHighlighting: data.semanticHighlighting !== undefined ? !!data.semanticHighlighting : base.semanticHighlighting,
    semanticTokenColors: { ...base.semanticTokenColors, ...(data.semanticTokenColors || {}) },
  };
}

// editor.tokenColorCustomizations short keys -> scopes (the same groups VS Code uses).
const GROUPS = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

function customRules(c) {
  if (!c || typeof c !== 'object') return [];
  const out = [];
  for (const [k, scopes] of Object.entries(GROUPS)) {
    const v = c[k];
    if (typeof v === 'string') out.push({ scope: scopes, settings: { foreground: v } });
    else if (v && typeof v === 'object') out.push({ scope: scopes, settings: { foreground: v.foreground, fontStyle: v.fontStyle } });
  }
  if (Array.isArray(c.textMateRules)) for (const r of c.textMateRules) if (r && r.settings) out.push(r);
  return out;
}

/** Apply editor.tokenColorCustomizations and workbench.colorCustomizations (global and "[Theme Name]" parts). */
function applyCustomizations(theme, themeLabel, tokenCust, colorCust) {
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return [];
    const scoped = [];
    for (const [k, v] of Object.entries(obj)) {
      const m = /^\[(.+)\]$/.exec(k);
      if (m && m[1].split(/\]\s*\[/).some(n => n === themeLabel || (n.endsWith('*') && themeLabel.startsWith(n.slice(0, -1))))) scoped.push(v);
    }
    return [obj, ...scoped];
  };
  let tokenColors = theme.tokenColors.slice();
  for (const part of pick(tokenCust)) tokenColors = tokenColors.concat(customRules(part));
  const colors = { ...theme.colors };
  for (const part of pick(colorCust)) for (const [k, v] of Object.entries(part)) if (!/^\[/.test(k) && typeof v === 'string') colors[k] = v;
  return { ...theme, tokenColors, colors };
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function cleanColor(v) { return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : null; }

/** Editor colors the picture uses, with VS Code's defaults for the theme kind. */
function editorColors(colors, kind) {
  const d = DEFAULTS[kind] || DEFAULTS.dark;
  const get = k => cleanColor(colors[k]) || d[k] || null;
  const brackets = [];
  for (let i = 1; i <= 6; i++) {
    const c = cleanColor(colors['editorBracketHighlight.foreground' + i]) || d['editorBracketHighlight.foreground' + i];
    if (c && !isTransparent(c)) brackets.push(c);
  }
  return {
    background: get('editor.background'),
    foreground: get('editor.foreground'),
    lineNumber: get('editorLineNumber.foreground'),
    lineHighlight: get('editor.lineHighlightBackground'),
    mark: cleanColor(colors['editor.findMatchHighlightBackground']) || get('editor.wordHighlightStrongBackground'),
    brackets,
    unexpectedBracket: get('editorBracketHighlight.unexpectedBracket.foreground'),
  };
}

function isTransparent(c) { return /^#[0-9a-f]{6}00$/i.test(c) || /^#[0-9a-f]{3}0$/i.test(c); }

/** The TextMate theme for vscode-textmate: defaults first (editor foreground and background), then the rules. */
function textmateTheme(name, tokenColors, ec) {
  const settings = [{ settings: { foreground: ec.foreground, background: ec.background } }];
  for (const r of tokenColors) {
    if (!r || typeof r !== 'object' || !r.settings || typeof r.settings !== 'object') continue;
    const s = {};
    if (cleanColor(r.settings.foreground)) s.foreground = r.settings.foreground.trim();
    if (typeof r.settings.fontStyle === 'string') s.fontStyle = r.settings.fontStyle;
    if (!s.foreground && s.fontStyle === undefined) continue;
    if (r.scope === undefined || r.scope === null || r.scope === '') {
      // a rule without scope changes the defaults (old .tmTheme style)
      if (s.foreground && settings[0].settings.foreground === undefined) settings[0].settings.foreground = s.foreground;
      continue;
    }
    const scope = Array.isArray(r.scope) ? r.scope.filter(x => typeof x === 'string') : typeof r.scope === 'string' ? r.scope : null;
    if (!scope || (Array.isArray(scope) && !scope.length)) continue;
    settings.push({ scope, settings: s });
  }
  return { name, settings };
}

/**
 * Resolve everything. opts: { extensions, read, cfg, apiKind }
 * Returns { label, kind, colors (editorColors), textmate (theme for vscode-textmate), found }.
 */
/** Labels like "%darkModernThemeLabel%" come from the extension's package.nls.json. */
async function localizeLabels(contribs, read) {
  const cache = new Map();
  for (const t of contribs) {
    const m = /^%(.+)%$/.exec(t.label || '');
    if (!m) continue;
    const key = String(t.extUri);
    if (!cache.has(key)) cache.set(key, read(t.extUri, 'package.nls.json').then(x => parseJsonc(x)).catch(() => ({})));
    const nls = await cache.get(key);
    const v = nls[m[1]];
    t.label = typeof v === 'string' ? v : typeof (v && v.message) === 'string' ? v.message : t.id;
  }
  return contribs;
}

async function resolveTheme(opts) {
  const sel = activeThemeName(opts.cfg, opts.apiKind);
  const contribs = await localizeLabels(themeContributions(opts.extensions), opts.read);
  let t = findTheme(contribs, sel.name, sel.kind);
  if (t && sel.fallback && (sel.kind === 'hc' || sel.kind === 'hcLight') && kindOf(t.uiTheme) !== sel.kind) t = findTheme(contribs, sel.fallback, sel.kind) || t;
  if (!t && sel.fallback) t = findTheme(contribs, sel.fallback, sel.kind);
  if (!t) {
    const builtIn = { dark: 'Default Dark Modern', light: 'Default Light Modern', hc: 'Default High Contrast', hcLight: 'Default High Contrast Light' }[sel.kind];
    t = findTheme(contribs, builtIn, sel.kind) || findTheme(contribs, 'Default Dark+', 'dark');
  }
  let raw = { colors: {}, tokenColors: [] };
  let found = false;
  let error = '';
  if (t) {
    try { raw = await loadThemeFile(opts.read, t.extUri, t.path); found = true; } catch (e) { error = String(e && e.message || e); }
  }
  const label = t ? t.label : String(sel.name || '');
  const kind = t ? kindOf(t.uiTheme) : sel.kind;
  const cust = applyCustomizations(raw, label, opts.cfg('editor.tokenColorCustomizations'), opts.cfg('workbench.colorCustomizations'));
  const colors = editorColors(cust.colors, kind);
  return { label, kind, colors, textmate: textmateTheme(label, cust.tokenColors, colors), found, error, wanted: sel.name };
}

module.exports = { localizeLabels, parseJsonc, parsePlist, activeThemeName, themeContributions, findTheme, loadThemeFile, applyCustomizations, editorColors, textmateTheme, resolveTheme, kindOf, kindFromApi, joinPath, cleanColor, DEFAULTS };
