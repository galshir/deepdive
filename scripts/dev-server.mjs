// Bundles and runs the browser dev harness (src/dev/devServer.ts). Run `npm run build` first.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, '.dev', 'devServer.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'src/dev/devServer.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'warning' });
// The harness resolves dist/ relative to its own folder, so it lives in <root>/.dev.
await import(pathToFileURL(out).href);
