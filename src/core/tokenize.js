'use strict';
// Colors code the way the editor does: the TextMate grammars VS Code and the user's extensions ship, the
// vscode-textmate engine VS Code itself uses (Oniguruma regex in WebAssembly), the active color theme, and
// bracket pair colors. Nothing is fetched: grammars are read from the installed extensions.
const vsctm = require('vscode-textmate');
const onig = require('vscode-oniguruma');
const { parseJsonc } = require('./theme');

let onigReady = null;
function loadOnig(wasmBytes) {
  if (!onigReady) {
    onigReady = onig.loadWASM(wasmBytes).then(() => ({
      createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
      createOnigString: (s) => new onig.OnigString(s),
    }));
  }
  return onigReady;
}

// Bits of the encoded token metadata (vscode-textmate EncodedTokenAttributes).
const TOKEN_TYPE_MASK = 0x300, TOKEN_TYPE_OFFSET = 8;
const FONT_STYLE_MASK = 0x7800, FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0xff8000, FOREGROUND_OFFSET = 15;
const BALANCED_BRACKETS_MASK = 0x400;
// token types: 0 other, 1 comment, 2 string, 3 regex

/** Index of grammar and language contributions from all extensions. */
function grammarIndex(extensions) {
  const byScope = new Map();
  const byLanguage = new Map();
  const injections = new Map(); // target scope -> [scopeName]
  const languages = new Map(); // id -> { extUri, configuration }
  for (const e of extensions) {
    const c = e.packageJSON && e.packageJSON.contributes;
    if (!c) continue;
    if (Array.isArray(c.languages)) {
      for (const l of c.languages) {
        if (!l || typeof l.id !== 'string') continue;
        const cur = languages.get(l.id) || {};
        if (typeof l.configuration === 'string' && !cur.configuration) languages.set(l.id, { extUri: e.extensionUri, configuration: l.configuration });
        else if (!languages.has(l.id)) languages.set(l.id, cur);
      }
    }
    if (!Array.isArray(c.grammars)) continue;
    for (const g of c.grammars) {
      if (!g || typeof g.scopeName !== 'string' || typeof g.path !== 'string') continue;
      const entry = { scopeName: g.scopeName, path: g.path, extUri: e.extensionUri, language: g.language, embeddedLanguages: g.embeddedLanguages, tokenTypes: g.tokenTypes, injectTo: g.injectTo, balanced: g.balancedBracketScopes, unbalanced: g.unbalancedBracketScopes };
      if (!byScope.has(g.scopeName)) byScope.set(g.scopeName, entry);
      if (typeof g.language === 'string' && !byLanguage.has(g.language)) byLanguage.set(g.language, entry);
      if (Array.isArray(g.injectTo)) for (const t of g.injectTo) { if (!injections.has(t)) injections.set(t, []); injections.get(t).push(g.scopeName); }
    }
  }
  return { byScope, byLanguage, injections, languages };
}

const TT = { other: 0, comment: 1, string: 2, regex: 3 };
const STANDARD = { string: vsctm.StandardTokenType ? vsctm.StandardTokenType.String : 2, comment: 1, other: 0, regex: 3 };

class Tokenizer {
  /** opts: { extensions, read(extUri, relPath) -> Promise<string>, wasm: Uint8Array } */
  constructor(opts) {
    this.opts = opts;
    this.index = grammarIndex(opts.extensions);
    this.langIds = new Map();
    this.registry = null;
    this.themeKey = '';
    this.bracketCache = new Map();
  }

  langNum(id) { if (!this.langIds.has(id)) this.langIds.set(id, this.langIds.size + 1); return this.langIds.get(id); }

  async ensureRegistry(theme) {
    if (!this.registry) {
      const onigLib = loadOnig(this.opts.wasm);
      this.registry = new vsctm.Registry({
        onigLib,
        loadGrammar: async (scopeName) => {
          const g = this.index.byScope.get(scopeName);
          if (!g) return null;
          try {
            const text = await this.opts.read(g.extUri, g.path);
            return vsctm.parseRawGrammar(text, g.path);
          } catch { return null; }
        },
        getInjections: (scopeName) => this.index.injections.get(scopeName) || [],
      });
    }
    const key = JSON.stringify(theme);
    if (key !== this.themeKey) { this.registry.setTheme(theme); this.themeKey = key; }
    return this.registry;
  }

  async grammar(languageId, theme) {
    const g = this.index.byLanguage.get(languageId);
    if (!g) return null;
    const reg = await this.ensureRegistry(theme);
    const embedded = {};
    if (g.embeddedLanguages && typeof g.embeddedLanguages === 'object') for (const [scope, lang] of Object.entries(g.embeddedLanguages)) if (typeof lang === 'string') embedded[scope] = this.langNum(lang);
    const tokenTypes = {};
    if (g.tokenTypes && typeof g.tokenTypes === 'object') for (const [scope, t] of Object.entries(g.tokenTypes)) tokenTypes[scope] = t === 'string' ? TT.string : t === 'comment' ? TT.comment : t === 'regex' ? TT.regex : TT.other;
    try {
      // Same bracket rules as the editor: a grammar can say which scopes hold real brackets (so "a > b" is not one).
      const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : null);
      return await reg.loadGrammarWithConfiguration(g.scopeName, this.langNum(languageId), {
        embeddedLanguages: embedded, tokenTypes,
        balancedBracketSelectors: strs(g.balanced) || ['*'], unbalancedBracketSelectors: strs(g.unbalanced) || [],
      });
    } catch { return null; }
  }

  /** Bracket pairs for bracket pair colors, from the language configuration (colorizedBracketPairs or brackets). */
  async brackets(languageId) {
    if (this.bracketCache.has(languageId)) return this.bracketCache.get(languageId);
    let pairs = [];
    const l = this.index.languages.get(languageId);
    if (l && l.configuration) {
      try {
        const conf = parseJsonc(await this.opts.read(l.extUri, l.configuration.replace(/^\.\//, '')));
        const list = Array.isArray(conf.colorizedBracketPairs) ? conf.colorizedBracketPairs : Array.isArray(conf.brackets) ? conf.brackets : [];
        pairs = list.filter(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' && p[0].length === 1 && p[1].length === 1);
      } catch { pairs = []; }
    }
    this.bracketCache.set(languageId, pairs);
    return pairs;
  }

  /**
   * Tokenize lines. before: lines before the first one (only to get the grammar state and bracket depth right).
   * opts: { theme (textmate theme), colors (editorColors), bracketColors: bool, maxLineLength (no colors above it),
   *         budgetMs (whole call), lineLimitMs }
   * Returns { lines: [[ [text, fg, fontStyle], ... ], ...], grammar: bool, partial: bool }
   */
  async tokenize(languageId, before, lines, opts) {
    const fg = opts.colors.foreground;
    const plain = lines.map(t => (t.length ? [[t, fg, 0, 0]] : []));
    const grammar = await this.grammar(languageId, opts.theme).catch(() => null);
    if (!grammar) return { lines: plain.map(l => l.map(s => s.slice(0, 3))), grammar: false, partial: false };
    const colorMap = this.registry.getColorMap();
    const pairs = opts.bracketColors ? await this.brackets(languageId) : [];
    const bc = bracketColorer(pairs, opts.colors);
    const t0 = Date.now();
    const budget = opts.budgetMs || 4000;
    const maxLen = opts.maxLineLength || 20000;
    let state = vsctm.INITIAL;
    let partial = false;
    const run = (text) => {
      if (text.length > maxLen) return { segs: text.length ? [[text, fg, 0, 0]] : [], stopped: false };
      const r = grammar.tokenizeLine2(text, state, opts.lineLimitMs || 500);
      state = r.ruleStack;
      const toks = r.tokens;
      const segs = [];
      for (let i = 0; i < toks.length; i += 2) {
        const start = toks[i];
        const end = i + 2 < toks.length ? toks[i + 2] : text.length;
        if (end <= start) continue;
        const meta = toks[i + 1];
        const color = colorMap[(meta & FOREGROUND_MASK) >>> FOREGROUND_OFFSET] || fg;
        const fs = (meta & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
        const tt = (meta & TOKEN_TYPE_MASK) >>> TOKEN_TYPE_OFFSET;
        segs.push([text.slice(start, end), color, fs, tt, (meta & BALANCED_BRACKETS_MASK) !== 0]);
      }
      return { segs, stopped: r.stoppedEarly };
    };
    for (const t of before) {
      if (Date.now() - t0 > budget / 2) { partial = true; break; }
      const r = run(t);
      bc.walk(r.segs, false);
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (Date.now() - t0 > budget) { partial = true; out.push(plain[i].map(s => s.slice(0, 3))); continue; }
      const r = run(lines[i]);
      if (r.stopped) partial = true;
      out.push(merge(bc.walk(r.segs, true)));
    }
    return { lines: out, grammar: true, partial };
  }
}

/** Colors brackets by depth like editor.bracketPairColorization (one color pool, cycling). */
function bracketColorer(pairs, colors) {
  const open = new Map(pairs.map(p => [p[0], p[1]]));
  const close = new Map(pairs.map(p => [p[1], p[0]]));
  const pool = colors.brackets && colors.brackets.length ? colors.brackets : null;
  const stack = [];
  return {
    walk(segs, emit) {
      if (!pool || !open.size) return emit ? segs : null;
      const out = [];
      for (const s of segs) {
        const [text, color, fs, tt, balanced] = s;
        if (tt !== 0 || balanced === false) { out.push(s); continue; }
        let last = 0;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          let c = null;
          if (open.has(ch)) { c = pool[stack.length % pool.length]; stack.push(ch); }
          else if (close.has(ch)) {
            if (stack.length && stack[stack.length - 1] === close.get(ch)) { stack.pop(); c = pool[stack.length % pool.length]; }
            else c = colors.unexpectedBracket || color;
          }
          if (c && emit) {
            if (i > last) out.push([text.slice(last, i), color, fs, tt, balanced]);
            out.push([ch, c, fs, tt, balanced]);
            last = i + 1;
          }
        }
        if (emit && last < text.length) out.push(last === 0 ? s : [text.slice(last), color, fs, tt, balanced]);
      }
      return emit ? out : null;
    },
  };
}

/** Join neighbours with the same color and style; drop the token type. */
function merge(segs) {
  const out = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p[1] === s[1] && p[2] === s[2]) p[0] += s[0];
    else out.push([s[0], s[1], s[2]]);
  }
  return out;
}

module.exports = { Tokenizer, grammarIndex, bracketColorer, merge };
