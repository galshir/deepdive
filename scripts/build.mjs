// Builds the extension host bundle (Node/CommonJS) and the webview bundle (browser/IIFE + CSS).
import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');

/** @type {import('esbuild').Plugin} */
const logPlugin = {
  name: 'log',
  setup(build) {
    build.onEnd((result) => {
      for (const e of result.errors) {
        console.error(`✘ [ERROR] ${e.text}`);
        if (e.location) console.error(`    ${e.location.file}:${e.location.line}:${e.location.column}:`);
      }
      if (result.errors.length === 0) console.warn(`[build] ${build.initialOptions.outfile ?? build.initialOptions.outdir} ok`);
    });
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  plugins: [logPlugin],
  absWorkingDir: root,
};

const extension = {
  ...common,
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webview = {
  ...common,
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome110',
  jsx: 'automatic',
  loader: { '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
};

async function copyAssets() {
  // Production builds start clean so stale source maps never end up in the VSIX.
  if (production) await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
  await copyFile(wasm, path.join(dist, 'sql-wasm.wasm'));
}

await copyAssets();
if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.warn('[build] watching…');
} else {
  const results = await Promise.allSettled([esbuild.build(extension), esbuild.build(webview)]);
  if (results.some((r) => r.status === 'rejected')) process.exit(1);
}
