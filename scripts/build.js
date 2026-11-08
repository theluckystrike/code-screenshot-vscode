'use strict';
// Bundles the extension host (with vscode-textmate and vscode-oniguruma) and the panel script with esbuild,
// and copies Oniguruma's WebAssembly file next to the host bundle. No runtime dependencies in the package.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
(async () => {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'],
      // vscode-oniguruma can fetch its wasm from a URL; this extension passes the bytes, so the fetch path is cut out.
      define: { fetch: 'undefined' } }),
    esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
  ]);
  fs.copyFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'), path.join(root, 'dist', 'onig.wasm'));
  const kb = f => (fs.statSync(path.join(root, 'dist', f)).size / 1024).toFixed(0) + ' KB';
  console.log(`built: extension ${kb('extension.js')}, webview ${kb('webview.js')}, onig.wasm ${kb('onig.wasm')}`);
})().catch(e => { console.error(e); process.exit(1); });
