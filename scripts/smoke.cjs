// Smoke test for the *bundled* extension (dist/extension.js) outside VS Code.
// It mocks the small part of the VS Code API the extension uses, activates the extension, opens the
// workspace webview and drives it through the real message protocol using the offline demo driver.
/* eslint-disable */
const Module = require('module');
const path = require('path');
const assert = require('assert');

const commands = new Map();
const posted = [];
let receive;
const memento = new Map();
const secrets = new Map();
let confirmAnswer = 'Execute';

class Emitter {
  constructor() {
    this.l = [];
    this.event = (fn) => (this.l.push(fn), { dispose() {} });
  }
  fire(v) {
    this.l.forEach((f) => f(v));
  }
  dispose() {}
}
const Uri = { joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString: () => path.join(u.fsPath, ...p) }), file: (p) => ({ fsPath: p }) };
const vscode = {
  Uri,
  EventEmitter: Emitter,
  TreeItem: class {
    constructor(label) {
      this.label = label;
    }
  },
  ThemeIcon: class {},
  ThemeColor: class {},
  MarkdownString: class {},
  TreeItemCollapsibleState: { None: 0 },
  ViewColumn: { Active: -1, Beside: -2 },
  env: { clipboard: { writeText: async () => undefined } },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
  },
  commands: { registerCommand: (id, fn) => (commands.set(id, fn), { dispose() {} }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    showWarningMessage: async () => confirmAnswer,
    showErrorMessage: async (m) => console.error('showErrorMessage', m),
    showTextDocument: async () => undefined,
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'vscode-resource:',
        html: '',
        asWebviewUri: (u) => u,
        postMessage: async (m) => (posted.push(m), true),
        onDidReceiveMessage: (fn) => ((receive = fn), { dispose() {} }),
      },
      onDidDispose: () => ({ dispose() {} }),
      reveal() {},
      dispose() {},
    }),
  },
};

const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return vscode;
  return orig.call(this, req, ...rest);
};

const root = path.resolve(__dirname, '..');
const ext = require(path.join(root, 'dist', 'extension.js'));

let seq = 1;
async function call(payload) {
  const id = seq++;
  await receive({ kind: 'request', id, payload });
  const res = posted.find((m) => m.kind === 'response' && m.id === id);
  assert(res, `no response for ${payload.type}`);
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.result;
}

(async () => {
  const context = {
    subscriptions: [],
    extensionPath: root,
    extensionUri: { fsPath: root },
    globalState: { get: (k) => memento.get(k), update: async (k, v) => memento.set(k, v) },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) },
  };
  await ext.activate(context);
  for (const id of ['deepdive.openWorkspace', 'deepdive.addConnection', 'deepdive.addDemoConnection', 'deepdive.connect', 'deepdive.disconnect', 'deepdive.removeConnection']) {
    assert(commands.has(id), `command ${id} registered`);
  }
  commands.get('deepdive.openWorkspace')();
  const panelHtml = posted; // panel created; html is set on the mock
  assert(receive, 'webview message handler installed');

  const init = await call({ type: 'init' });
  assert.deepStrictEqual(init.connections, []);
  const [acme, lake] = await call({ type: 'addDemoConnections' });
  await call({ type: 'connect', connectionId: acme.config.id });
  await call({ type: 'connect', connectionId: lake.config.id });
  const dbs = await call({ type: 'listDatabases', connectionId: acme.config.id });
  assert.deepStrictEqual(dbs.map((d) => d.name), ['shop', 'analytics', 'hr', 'sandbox']);
  const page = await call({
    type: 'fetchTableRows',
    connectionId: acme.config.id,
    queryId: 'q1',
    query: { database: 'shop', table: 'customers', filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'status', operator: 'eq', value: 'active' }] }, limit: 10, offset: 0 },
  });
  assert.strictEqual(page.rows.length, 10);
  const big = await call({ type: 'listTables', connectionId: lake.config.id, database: 'warehouse' });
  assert.strictEqual(big.length, 1201);
  const sql = await call({ type: 'runSql', connectionId: acme.config.id, queryId: 's1', sql: 'SELECT COUNT(*) AS n FROM orders' });
  assert.strictEqual(sql.statements[0].result.rows[0][0], 2500);
  confirmAnswer = undefined;
  await assert.rejects(call({ type: 'runSql', connectionId: acme.config.id, queryId: 's2', sql: 'DELETE FROM shop.reviews' }), /Cancelled/);
  const events = posted.filter((m) => m.kind === 'event').map((m) => m.event.type);
  assert(events.includes('connectionsChanged') && events.includes('log'), 'events delivered');
  assert(!JSON.stringify(memento.get('deepdive.connections.v1')).includes('password'), 'no passwords in globalState');
  await ext.deactivate();
  console.warn(`smoke ok — ${posted.length} messages exchanged, ${commands.size} commands registered`);
  void panelHtml;
})().catch((err) => {
  console.error('SMOKE FAILED', err);
  process.exit(1);
});
