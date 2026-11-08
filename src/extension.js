'use strict';
// Code Screenshot: select code, press one key, and a picture of it (your theme, font and colors) is on the clipboard.
// The extension host reads only the selected lines (plus some lines before them for the grammar state), colors them
// with VS Code's own TextMate engine and the active theme, and sends them to the panel, which draws SVG and PNG.
// No network, no account, no telemetry. The clipboard is written with local OS commands or by the panel itself.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { buildHtml } = require('./html');
const L = require('./core/layout');
const { resolveTheme } = require('./core/theme');
const { Tokenizer } = require('./core/tokenize');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const SECTION = 'codeScreenshot';
const VIEW_TYPE = 'codeScreenshot.panel';
const EXT_ID = 'zovo.zovo-code-screenshot';
const PREFS_KEY = 'codeScreenshot.prefs.v1';
const FOLDER_KEY = 'codeScreenshot.lastFolder';
let rating = { success() {}, failure() {} };
let ctx = null;

function settings(scope) {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  const int = (k, lo, hi, d) => { const n = Math.round(Number(c.get(k, d))); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  return {
    maxLines: int('maxLines', 10, 20000, 1000),
    maxLineLength: int('maxLineLength', 80, 20000, 1000),
    whenNothingSelected: c.get('whenNothingSelected', 'visible') === 'file' ? 'file' : 'visible',
    saveFolder: String(c.get('saveFolder', '') || ''),
    askWhereToSave: c.get('askWhereToSave', true) !== false,
    followSelection: c.get('followSelection', true) !== false,
    fontFamily: String(c.get('fontFamily', '') || ''),
    defaults: {
      scale: c.get('scale', 2), lineNumbers: c.get('lineNumbers', true), frame: c.get('frame', 'mac'), showTitle: c.get('showTitle', true),
      background: c.get('background', 'gradient-1'), bgColor: c.get('backgroundColor', '#6c5ce7'), padding: c.get('padding', 48), shadow: c.get('shadow', true),
      radius: c.get('cornerRadius', 10), trimIndent: c.get('removeCommonIndent', true), wrap: c.get('wrapColumn', 0),
    },
  };
}

// ---------- theme and tokenizer, cached until the theme, the settings or the extensions change ----------
let tokenizer = null;
let themeCache = null;
function readExtFile(extUri, rel) {
  return vscode.workspace.fs.readFile(vscode.Uri.joinPath(extUri, rel)).then(b => new TextDecoder('utf-8').decode(b));
}
function getTokenizer() {
  if (!tokenizer) {
    const wasm = fs.readFileSync(path.join(__dirname, 'onig.wasm'));
    tokenizer = new Tokenizer({ extensions: vscode.extensions.all, read: readExtFile, wasm });
  }
  return tokenizer;
}
async function getTheme() {
  if (themeCache) return themeCache;
  const cfg = k => { const i = k.indexOf('.'); return vscode.workspace.getConfiguration(k.slice(0, i)).get(k.slice(i + 1)); };
  themeCache = await resolveTheme({ extensions: vscode.extensions.all, read: readExtFile, cfg, apiKind: vscode.window.activeColorTheme.kind });
  return themeCache;
}

// ---------- the model the panel draws ----------
function fontOf(doc) {
  const e = vscode.workspace.getConfiguration('editor', doc);
  const own = settings(doc).fontFamily;
  const size = Math.max(6, Math.min(100, Number(e.get('fontSize', 14)) || 14));
  return {
    family: own || String(e.get('fontFamily') || 'Menlo, Monaco, "Courier New", monospace'),
    size,
    weight: String(e.get('fontWeight', 'normal') || 'normal').replace(/[^a-z0-9 ]/gi, '') || 'normal',
    lineHeight: L.lineHeightPx(e.get('lineHeight', 0), size, process.platform),
    ligatures: e.get('fontLigatures', false),
    letterSpacing: Number(e.get('letterSpacing', 0)) || 0,
  };
}

async function buildModel(editor) {
  const doc = editor.document;
  const s = settings(doc);
  const sel = editor.selections.map(x => ({ start: { line: x.start.line, character: x.start.character }, end: { line: x.end.line, character: x.end.character } }));
  const vis = editor.visibleRanges.map(r => ({ start: r.start.line, end: r.end.line }));
  const pick = L.pickLines(sel, vis, doc.lineCount, s.whenNothingSelected);
  let plan = L.rowPlan(pick.blocks);
  const notes = [];
  // line cap: draw the first maxLines lines and say how many were left out
  const codeRows = plan.filter(r => r.n).length;
  if (codeRows > s.maxLines) {
    let seen = 0, cutAt = plan.length;
    for (let i = 0; i < plan.length; i++) if (plan[i].n && ++seen > s.maxLines) { cutAt = i; break; }
    plan = plan.slice(0, cutAt);
    plan.push({ skip: codeRows - s.maxLines });
    notes.push(`The selection has ${codeRows.toLocaleString('en-US')} lines. The picture shows the first ${s.maxLines.toLocaleString('en-US')} (setting codeScreenshot.maxLines).`);
  }
  const want = plan.filter(r => r.n).map(r => r.n - 1);
  if (!want.length) return { error: 'There is no code to draw here.' };
  const first = want[0];
  const theme = await getTheme();
  const tabSize = Number(editor.options.tabSize) || 4;
  let longest = 0, cut = 0;
  const grab = i => {
    const t = doc.lineAt(i).text;
    if (t.length > longest) longest = t.length;
    if (t.length > s.maxLineLength) { cut++; return t.slice(0, s.maxLineLength); }
    return t;
  };
  const texts = want.map(grab);
  if (cut) notes.push(`${cut === 1 ? 'One line is' : cut + ' lines are'} longer than ${s.maxLineLength.toLocaleString('en-US')} characters (the longest has ${longest.toLocaleString('en-US')}), so the picture shows the start of ${cut === 1 ? 'it' : 'each'} (setting codeScreenshot.maxLineLength).`);
  // lines before the first one, for the grammar state: all of them up to 3,000, else the 1,000 just before
  const ctxStart = first <= 3000 ? 0 : first - 1000;
  const before = [];
  for (let i = ctxStart; i < first; i++) { const t = doc.lineAt(i).text; before.push(t.length > s.maxLineLength ? t.slice(0, s.maxLineLength) : t); }
  const ed = vscode.workspace.getConfiguration('editor', doc);
  const tok = await getTokenizer().tokenize(doc.languageId, before, texts, {
    theme: theme.textmate, colors: theme.colors,
    bracketColors: ed.get('bracketPairColorization.enabled', true) !== false,
    maxLineLength: Math.min(Number(ed.get('maxTokenizationLineLength', 20000)) || 20000, 20000), budgetMs: 4000,
  });
  if (tok.partial) notes.push('Coloring took too long for some lines, so they are drawn in one color.');
  const lines = [];
  let k = 0;
  for (const r of plan) {
    if (!r.n) { lines.push({ skip: r.skip, folded: !!r.folded }); continue; }
    let segs = L.expandTabs(tok.lines[k++], tabSize);
    if (texts[k - 1].length === s.maxLineLength && doc.lineAt(r.n - 1).text.length > s.maxLineLength) segs = segs.concat([[' …', theme.colors.lineNumber, 0]]);
    lines.push({ n: r.n, segs });
  }
  const last = want[want.length - 1] + 1;
  const fileName = path.basename(doc.uri.path) || 'Untitled';
  return {
    uri: doc.uri.toString(), fileName, languageId: doc.languageId, first: first + 1, last, source: pick.source,
    lines, indent: L.commonIndent(lines), font: fontOf(doc), colors: theme.colors, theme: theme.label, themeFound: theme.found, grammar: tok.grammar,
    names: { png: L.defaultFileName(fileName, first + 1, last, 'png'), svg: L.defaultFileName(fileName, first + 1, last, 'svg') },
    notes,
  };
}

// ---------- clipboard ----------
/** Put a PNG file on the OS clipboard with local commands. Resolves when the clipboard holds an image. */
function copyImageFile(file) {
  return new Promise((resolve, reject) => {
    const done = err => (err ? reject(err) : resolve());
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`, '-e', 'clipboard info'], { timeout: 10000 }, (err, out) => {
        if (err) return done(err);
        done(/PNGf/.test(String(out)) ? null : new Error('the clipboard did not take the image'));
      });
    } else if (process.platform === 'win32') {
      const f = file.replace(/'/g, "''");
      const ps = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; '
        + `$b=[IO.File]::ReadAllBytes('${f}'); $ms=New-Object IO.MemoryStream(,$b); $img=[Drawing.Image]::FromStream($ms); `
        + "$d=New-Object Windows.Forms.DataObject; $d.SetData('PNG',$false,$ms); $d.SetImage($img); [Windows.Forms.Clipboard]::SetDataObject($d,$true); "
        + 'if (-not [Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { timeout: 20000, windowsHide: true }, err => done(err && err.code === 3 ? new Error('the clipboard did not take the image') : err));
    } else {
      const wl = !!process.env.WAYLAND_DISPLAY;
      const cmd = wl ? 'wl-copy' : 'xclip';
      const args = wl ? ['--type', 'image/png'] : ['-selection', 'clipboard', '-t', 'image/png', '-i', file];
      // xclip and wl-copy leave a process behind that serves the clipboard and keeps the inherited pipes open,
      // so wait for the command itself to exit (not for its output streams to close).
      let finished = false;
      const end = err => { if (!finished) { finished = true; clearTimeout(timer); done(err); } };
      const child = spawn(cmd, args, { stdio: [wl ? 'pipe' : 'ignore', 'ignore', 'ignore'], detached: false });
      const timer = setTimeout(() => { try { child.kill(); } catch {} end(new Error(`${cmd} did not answer in 10 s`)); }, 10000);
      child.on('error', err => end(err && err.code === 'ENOENT' ? new Error(`${cmd} is not installed (${wl ? 'package wl-clipboard' : 'package xclip'})`) : err));
      child.on('exit', code => end(code ? new Error(`${cmd} ended with code ${code}`) : null));
      if (wl && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(fs.readFileSync(file)); }
    }
  });
}

/** Can this extension host reach the clipboard of the computer the user sits at? */
function osClipboardHere() {
  if (vscode.env.uiKind === vscode.UIKind.Web) return false;
  // In a remote window the extension prefers the local (UI) side; if it runs on the remote side, OS commands would
  // write the remote machine's clipboard, so the panel copies instead.
  if (vscode.env.remoteName && ctx && ctx.extension && ctx.extension.extensionKind === vscode.ExtensionKind.Workspace) return false;
  return true;
}

function pngBytes(data) {
  if (typeof data !== 'string' || data.length > 900e6) return null;
  const b = Buffer.from(data, 'base64');
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return b.length > 8 && sig.every((v, i) => b[i] === v) ? b : null;
}

// ---------- save ----------
function expandFolder(p, docUri) {
  if (!p) return null;
  let s = p.replace(/^~(?=$|[\\/])/, os.homedir());
  const wf = docUri && vscode.workspace.getWorkspaceFolder(docUri) || (vscode.workspace.workspaceFolders || [])[0];
  if (/\$\{workspaceFolder\}/.test(s)) { if (!wf || wf.uri.scheme !== 'file') return null; s = s.replace(/\$\{workspaceFolder\}/g, () => wf.uri.fsPath); }
  if (!path.isAbsolute(s)) { if (!wf || wf.uri.scheme !== 'file') return null; s = path.join(wf.uri.fsPath, s); }
  return vscode.Uri.file(s);
}

async function folderFor(docUri) {
  const s = settings();
  const set = expandFolder(s.saveFolder, docUri);
  if (set) return set;
  const last = ctx.globalState.get(FOLDER_KEY);
  if (typeof last === 'string' && last) { try { const u = vscode.Uri.parse(last); await vscode.workspace.fs.stat(u); return u; } catch {} }
  if (docUri && docUri.scheme === 'file') return vscode.Uri.file(path.dirname(docUri.fsPath));
  const wf = (vscode.workspace.workspaceFolders || [])[0];
  return wf ? wf.uri : vscode.Uri.file(os.homedir());
}

async function uniqueTarget(dir, name) {
  const ext = path.extname(name), base = name.slice(0, -ext.length);
  for (let i = 0; i < 1000; i++) {
    const u = vscode.Uri.joinPath(dir, i ? `${base}-${i + 1}${ext}` : name);
    try { await vscode.workspace.fs.stat(u); } catch { return u; }
  }
  return vscode.Uri.joinPath(dir, `${base}-${Date.now()}${ext}`);
}

async function saveBytes(bytes, name, ext, docUri) {
  const s = settings();
  const dir = await folderFor(docUri);
  let target;
  if (s.askWhereToSave) {
    target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, name), filters: ext === 'svg' ? { SVG: ['svg'] } : { PNG: ['png'] }, saveLabel: 'Save ' + ext.toUpperCase() });
    if (!target) return null;
  } else {
    try { await vscode.workspace.fs.createDirectory(dir); } catch {}
    target = await uniqueTarget(dir, name);
  }
  if (docUri && target.toString() === docUri.toString()) { vscode.window.showErrorMessage('Choose a different file; this would overwrite your code.'); return null; }
  await vscode.workspace.fs.writeFile(target, bytes);
  const folder = vscode.Uri.joinPath(target, '..');
  await ctx.globalState.update(FOLDER_KEY, folder.toString());
  return target;
}

// ---------- panel ----------
class Panel {
  constructor() {
    this.panel = null; this.ready = false; this.queue = []; this.reqId = 0; this.model = null; this.editor = null; this.waiters = new Map();
    this.followTimer = null; this.counted = new Set();
  }

  ensure(editor) {
    if (this.panel) {
      // Never cover the code: when the panel shares the editor's group, it moves to the group beside it.
      const same = editor && editor.viewColumn !== undefined && this.panel.viewColumn === editor.viewColumn;
      if (same || !this.panel.visible) this.panel.reveal(same ? vscode.ViewColumn.Beside : (this.panel.viewColumn || vscode.ViewColumn.Beside), true);
      return;
    }
    const p = vscode.window.createWebviewPanel(VIEW_TYPE, 'Code Screenshot', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, this.options());
    this.attach(p);
  }

  options() {
    const ext = ctx.extensionUri;
    return { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: false, enableCommandUris: commandUris(SECTION), localResourceRoots: [vscode.Uri.joinPath(ext, 'dist'), vscode.Uri.joinPath(ext, 'media')] };
  }

  attach(p) {
    this.panel = p; this.ready = false;
    p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel-icon.svg');
    const wv = p.webview;
    wv.options = this.options();
    wv.html = buildHtml({
      cspSource: wv.cspSource,
      scriptUri: wv.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview.js')).toString(),
      styleUri: wv.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.css')).toString(),
      showSupportLinks: showLinks(vscode, SECTION),
    });
    p.onDidDispose(() => { if (this.panel === p) { this.panel = null; this.ready = false; this.queue = []; for (const w of this.waiters.values()) w(null); this.waiters.clear(); } });
    wv.onDidReceiveMessage(m => this.onMessage(m).catch(err => vscode.window.showErrorMessage('Code Screenshot: ' + String(err && err.message || err))));
  }

  post(m) {
    if (!this.panel) return;
    if (!this.ready) { this.queue.push(m); return; }
    this.panel.webview.postMessage(m).then(undefined, () => {});
  }

  prefs() {
    const d = settings().defaults;
    const stored = ctx.globalState.get(PREFS_KEY);
    return { ...d, ...(stored && typeof stored === 'object' ? stored : {}) };
  }

  /** Draw the active editor's selection; action: null (just show), 'copyPng', 'savePng', 'saveSvg', 'copySvg'. */
  async show(editor, action) {
    let model;
    const t0 = Date.now();
    try { model = await buildModel(editor); model.hostMs = Date.now() - t0; } catch (err) {
      rating.failure();
      vscode.window.showErrorMessage('Code Screenshot could not read the code: ' + String(err && err.message || err));
      return;
    }
    if (model.error) { vscode.window.showInformationMessage('Code Screenshot: ' + model.error); return; }
    this.model = model; this.editor = editor;
    this.ensure(editor);
    const reqId = ++this.reqId;
    this.post({ type: 'render', model, action, reqId });
    return reqId;
  }

  wait(reqId, ms = 30000) {
    return new Promise(res => { const t = setTimeout(() => { this.waiters.delete(reqId); res(null); }, ms); this.waiters.set(reqId, v => { clearTimeout(t); res(v); }); });
  }
  settle(reqId, v) { const w = this.waiters.get(reqId); if (w) { this.waiters.delete(reqId); w(v); } }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        this.panel.webview.postMessage({ type: 'init', prefs: this.prefs() });
        const q = this.queue; this.queue = [];
        for (const x of q) this.panel.webview.postMessage(x);
        if (!q.length && this.model) this.panel.webview.postMessage({ type: 'render', model: this.model, action: null, reqId: ++this.reqId });
        break;
      }
      case 'prefs': if (m.prefs && typeof m.prefs === 'object') await ctx.globalState.update(PREFS_KEY, cleanPrefs(m.prefs)); break;
      case 'rendered': this.settle('r' + m.reqId, m); break;
      case 'png': await this.onPng(m); break;
      case 'svg': await this.onSvg(m); break;
      case 'copiedInPanel': vscode.window.setStatusBarMessage(`Code Screenshot: PNG copied (${Number(m.w) | 0} × ${Number(m.h) | 0} px)`, 5000); this.success(); break;
      case 'error': vscode.window.showErrorMessage(String(m.message || 'Code Screenshot failed.').slice(0, 400)); rating.failure(); this.settle(m.reqId, { ok: false }); break;
      case 'done': this.settle(m.reqId, { ok: !!m.ok }); break;
      case 'probe': this.settle('p' + m.reqId, m.info); break;
    }
  }

  success() {
    const key = this.model ? this.model.uri + '#' + this.model.first : '';
    if (!this.counted.has(key)) { this.counted.add(key); rating.success(); }
  }

  async onPng(m) {
    const bytes = pngBytes(m.data);
    if (!bytes) { vscode.window.showErrorMessage('Code Screenshot: the panel did not send a PNG.'); rating.failure(); this.settle(m.reqId, { ok: false }); return; }
    const size = `${Number(m.w) | 0} × ${Number(m.h) | 0} px`;
    const docUri = this.model ? vscode.Uri.parse(this.model.uri) : undefined;
    if (m.purpose === 'savePng') {
      const t = await saveBytes(bytes, this.model.names.png, 'png', docUri);
      if (t) { vscode.window.setStatusBarMessage(`Code Screenshot: saved ${path.basename(t.path)} (${size})`, 6000); this.post({ type: 'copied', text: `Saved ${path.basename(t.path)} (${size}).` }); this.success(); }
      this.settle(m.reqId, { ok: !!t, file: t && t.toString(), w: m.w, h: m.h });
      return;
    }
    // copy
    if (!osClipboardHere()) {
      this.post({ type: 'copyFailed', text: 'This window cannot reach your computer\'s clipboard from the extension, so the panel copies the image.', tryPanel: true });
      this.settle(m.reqId, { ok: false, panel: true });
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-screenshot-'));
    const file = path.join(dir, 'code.png');
    const tc = Date.now();
    try {
      fs.writeFileSync(file, bytes);
      await copyImageFile(file);
      this.post({ type: 'timing', clipboardMs: Date.now() - tc, hostMs: this.model && this.model.hostMs });
      const note = m.note ? ' ' + m.note : '';
      vscode.window.setStatusBarMessage(`Code Screenshot: PNG copied (${size})`, 6000);
      this.post({ type: 'copied', text: `Copied the PNG (${size}) to the clipboard.${note}` });
      this.success();
      this.settle(m.reqId, { ok: true, w: m.w, h: m.h, scale: m.scale });
    } catch (err) {
      const why = String(err && err.message || err).split('\n')[0].slice(0, 200);
      rating.failure(); // no rating ask after the main feature failed, even when the PNG is saved instead
      this.post({ type: 'copyFailed', text: `Could not put the image on the clipboard (${why}). Your clipboard was not changed.`, tryPanel: false });
      const pick = await vscode.window.showWarningMessage(`Code Screenshot could not put the image on the clipboard (${why}). Your clipboard was not changed.`, 'Save PNG');
      if (pick) await saveBytes(bytes, this.model.names.png, 'png', docUri);
      this.settle(m.reqId, { ok: false, error: why });
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  async onSvg(m) {
    if (typeof m.text !== 'string' || !/^<svg[\s>]/.test(m.text) || m.text.length > 400e6) { this.settle(m.reqId, { ok: false }); return; }
    const docUri = this.model ? vscode.Uri.parse(this.model.uri) : undefined;
    if (m.purpose === 'copySvg') {
      await vscode.env.clipboard.writeText(m.text);
      vscode.window.setStatusBarMessage('Code Screenshot: SVG code copied', 5000);
      this.post({ type: 'copied', text: 'Copied the SVG code to the clipboard.' });
      this.success();
      this.settle(m.reqId, { ok: true });
      return;
    }
    const t = await saveBytes(Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + m.text + '\n', 'utf8'), this.model.names.svg, 'svg', docUri);
    if (t) { vscode.window.setStatusBarMessage(`Code Screenshot: saved ${path.basename(t.path)}`, 6000); this.post({ type: 'copied', text: `Saved ${path.basename(t.path)}.` }); this.success(); }
    this.settle(m.reqId, { ok: !!t, file: t && t.toString() });
  }

  follow(e) {
    if (!this.panel || !this.panel.visible || !settings().followSelection) return;
    // Any code editor counts (not the Output panel and other internal views).
    if (e.textEditor !== vscode.window.activeTextEditor || /^(output|debug|vscode-terminal|comment)$/.test(e.textEditor.document.uri.scheme)) return;
    if (e.selections.every(s => s.isEmpty)) return;
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => this.show(e.textEditor, null), 350);
  }

  refresh() {
    themeCache = null;
    if (this.panel && this.editor && !this.editor.document.isClosed) this.show(this.editor, null);
  }
}

const BG = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4', 'gradient-5', 'solid', 'editor', 'transparent'];
function cleanPrefs(p) {
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return {
    scale: [1, 2, 3, 4].includes(Number(p.scale)) ? Number(p.scale) : 2,
    lineNumbers: !!p.lineNumbers, showTitle: !!p.showTitle, shadow: !!p.shadow, trimIndent: !!p.trimIndent,
    frame: ['mac', 'plain', 'none'].includes(p.frame) ? p.frame : 'mac',
    title: String(p.title || '').slice(0, 200),
    background: BG.includes(p.background) ? p.background : 'gradient-1',
    bgColor: /^#[0-9a-f]{6}$/i.test(p.bgColor || '') ? p.bgColor : '#6c5ce7',
    padding: int(p.padding, 0, 128, 48), radius: int(p.radius, 0, 24, 10), wrap: int(p.wrap, 0, 400, 0), fontSize: int(p.fontSize, 0, 72, 0),
  };
}

function activate(context) {
  ctx = context;
  const panel = new Panel();
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'Code Screenshot' });

  const withEditor = action => async () => {
    const ed = vscode.window.activeTextEditor || (panel.editor && !panel.editor.document.isClosed ? panel.editor : null);
    if (!ed) {
      if (panel.panel && panel.model && action) { panel.post({ type: 'run', action, reqId: ++panel.reqId }); return; }
      vscode.window.showInformationMessage('Code Screenshot: open a file and select some code first.');
      return;
    }
    return panel.show(ed, action);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('codeScreenshot.copy', withEditor('copyPng')),
    vscode.commands.registerCommand('codeScreenshot.open', withEditor(null)),
    vscode.commands.registerCommand('codeScreenshot.savePng', withEditor('savePng')),
    vscode.commands.registerCommand('codeScreenshot.saveSvg', withEditor('saveSvg')),
    vscode.commands.registerCommand('codeScreenshot.copySvg', withEditor('copySvg')),
    vscode.commands.registerCommand('codeScreenshot.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#codeScreenshot.start`, false)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(p) { panel.attach(p); },
    }),
    vscode.window.onDidChangeTextEditorSelection(e => panel.follow(e)),
    vscode.window.onDidChangeActiveColorTheme(() => panel.refresh()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.colorTheme') || e.affectsConfiguration('workbench.colorCustomizations') || e.affectsConfiguration('editor.tokenColorCustomizations') || e.affectsConfiguration('workbench.preferredDarkColorTheme') || e.affectsConfiguration('workbench.preferredLightColorTheme')) themeCache = null;
      if (e.affectsConfiguration('editor') || e.affectsConfiguration('workbench') || e.affectsConfiguration(SECTION)) panel.refresh();
    }),
    vscode.extensions.onDidChange(() => { tokenizer = null; themeCache = null; }),
    { dispose: () => { if (panel.panel) panel.panel.dispose(); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { cleanPrefs, pngBytes, expandFolder: (p) => p } };
