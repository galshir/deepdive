// Browser dev harness: serves the webview bundle outside VS Code and backs it with the real router,
// connection manager and drivers (demo + MySQL). Not shipped in the VSIX.
//   npm run dev:browser   → http://127.0.0.1:5178
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { DemoDriver } from '../core/drivers/demoDriver';
import { MysqlDriver } from '../core/drivers/mysqlDriver';
import { MessageRouter } from '../core/router';
import { ConnectionManager, type ConnectionStore, type SecretStore } from '../core/services/connectionManager';
import { MetadataService } from '../core/services/metadataService';
import { DEFAULT_SETTINGS } from '../core/settings';
import type { ConnectionConfig } from '../shared/model';

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT ?? 5178);
const autoConfirm = process.env.DEEPDIVE_DEV_CONFIRM === '1';

let configs: ConnectionConfig[] = [];
const store: ConnectionStore = { load: () => configs, save: async (c) => void (configs = c) };
const secretMap = new Map<string, string>();
const secrets: SecretStore = { get: async (k) => secretMap.get(k), store: async (k, v) => void secretMap.set(k, v), delete: async (k) => void secretMap.delete(k) };
const clients = new Set<ServerResponse>();

const manager = new ConnectionManager(
  store,
  secrets,
  (config, password, settings) => (config.kind === 'demo' ? new DemoDriver(config.demoDataset ?? 'acme', path.join(root, 'dist', 'sql-wasm.wasm')) : new MysqlDriver(config, password, { poolSize: settings.poolSize })),
  () => DEFAULT_SETTINGS,
);
const metadata = new MetadataService((id) => manager.driver(id));
const router = new MessageRouter(manager, metadata, {
  settings: () => DEFAULT_SETTINGS,
  emit: (event) => {
    const data = `data: ${JSON.stringify({ kind: 'event', event })}\n\n`;
    for (const c of clients) c.write(data);
  },
  confirm: async ({ title, detail }) => {
    console.warn(`[confirm] ${title}\n${detail}\n→ ${autoConfirm ? 'auto-confirmed' : 'declined (set DEEPDIVE_DEV_CONFIRM=1 to auto-confirm)'}`);
    return autoConfirm;
  },
  copyText: async (text) => console.warn(`[clipboard] ${text.slice(0, 200)}`),
  openSqlDocument: async (sql) => console.warn(`[open document]\n${sql}`),
  output: (line) => console.warn(line),
});

const shim = `
window.acquireVsCodeApi = () => ({
  postMessage(msg) {
    fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
      .then((r) => r.json()).then((res) => res && window.postMessage(res, '*'));
  },
  getState() { return undefined; },
  setState() {},
});
new EventSource('/events').onmessage = (e) => window.postMessage(JSON.parse(e.data), '*');
`;

// A few VS Code "Light+" theme variables so the light theme can be checked outside VS Code.
const LIGHT_VARS = `--vscode-editor-background:#ffffff;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-sideBar-background:#f8f8f8;
--vscode-editorWidget-background:#f3f3f3;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;--vscode-descriptionForeground:#6f6f6f;
--vscode-panel-border:#e5e5e5;--vscode-list-hoverBackground:#f0f0f0;--vscode-list-inactiveSelectionBackground:#e4e6f1;--vscode-list-activeSelectionBackground:#0060c0;
--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryHoverBackground:#d6d6d6;--vscode-button-background:#005fb8;--vscode-button-hoverBackground:#0258a8;
--vscode-titleBar-activeBackground:#f8f8f8;--vscode-editorGroupHeader-tabsBackground:#f8f8f8;--vscode-tab-activeBackground:#ffffff;--vscode-tab-inactiveBackground:#f8f8f8;
--vscode-tab-activeForeground:#3b3b3b;--vscode-tab-inactiveForeground:#868686;--vscode-textCodeBlock-background:#f3f3f3;--vscode-focusBorder:#005fb8;
--vscode-panel-background:#f8f8f8;--vscode-notifications-background:#ffffff;--vscode-editorGutter-background:#ffffff;--vscode-editorLineNumber-foreground:#6e7681;
--vscode-debugTokenExpression-name:#0000ff;--vscode-debugTokenExpression-string:#a31515;--vscode-debugTokenExpression-number:#098658;--vscode-debugTokenExpression-value:#001080;`;

// Same nonce-based policy as the real webview (plus connect-src for the harness transport), so CSP
// violations show up during browser testing.
const NONCE = 'devharnessnonce0123456789abcdef';
const CSP = `default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'self' 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'; connect-src 'self'`;

const page = (theme: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DeepDive (browser dev)</title>
<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="csp-nonce" content="${NONCE}">
<link rel="stylesheet" href="/webview.css"><script nonce="${NONCE}">${shim}
document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));</script>
<style nonce="${NONCE}">body{--vscode-font-family:-apple-system,system-ui,sans-serif;--vscode-font-size:13px;}body.vscode-light{${LIGHT_VARS}}</style></head>
<body class="${theme}"><div id="root"></div><script nonce="${NONCE}" src="/webview.js"></script></body></html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', async () => {
      const response = await router.handle(JSON.parse(body || 'null'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    });
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/webview.js' || url.pathname === '/webview.css') {
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(readFileSync(path.join(root, 'dist', url.pathname)));
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page(url.searchParams.get('theme') === 'light' ? 'vscode-light' : 'vscode-dark'));
    return;
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.warn(`DeepDive dev harness on http://127.0.0.1:${port}  (?theme=light for light mode)`));
