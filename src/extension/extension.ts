import * as path from 'node:path';
import * as vscode from 'vscode';
import { DemoDriver } from '../core/drivers/demoDriver';
import { MysqlDriver } from '../core/drivers/mysqlDriver';
import { MessageRouter, type HostBridge } from '../core/router';
import { ConnectionManager } from '../core/services/connectionManager';
import { MetadataService } from '../core/services/metadataService';
import { QueryLibrary } from '../core/services/queryLibrary';
import { toUiSettings } from '../core/settings';
import { GlobalStateConnectionStore, MementoKeyValueStore, readSettings, VscodeSecretStore } from './adapters';
import { ConnectionItem, ConnectionsTreeProvider } from './connectionsTree';
import { WorkspacePanel } from './workspacePanel';

let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('DeepDive');
  const wasmPath = path.join(context.extensionPath, 'dist', 'sql-wasm.wasm');

  const connections = new ConnectionManager(
    new GlobalStateConnectionStore(context.globalState),
    new VscodeSecretStore(context.secrets),
    (config, password, settings) =>
      config.kind === 'demo' ? new DemoDriver(config.demoDataset ?? 'acme', wasmPath) : new MysqlDriver(config, password, { poolSize: settings.poolSize }),
    readSettings,
  );
  await connections.init();
  const metadata = new MetadataService((id) => connections.driver(id));

  const bridge: HostBridge = {
    settings: readSettings,
    emit: (event) => WorkspacePanel.instance?.emit(event),
    confirm: async ({ title, detail, confirmLabel }) => {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, confirmLabel);
      return choice === confirmLabel;
    },
    confirmTyped: async ({ title, prompt, expected }) => {
      const value = await vscode.window.showInputBox({
        title,
        prompt,
        ignoreFocusOut: true,
        validateInput: (v) => (v === expected ? undefined : `Type ${expected} to confirm, or press Escape to cancel`),
      });
      return value === expected;
    },
    copyText: async (text) => {
      await vscode.env.clipboard.writeText(text);
    },
    openSqlDocument: async (sql) => {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    },
    output: (line) => output.appendLine(`${new Date().toISOString()} ${line}`),
  };
  const router = new MessageRouter(connections, metadata, bridge, new QueryLibrary(new MementoKeyValueStore(context.globalState)));

  const tree = new ConnectionsTreeProvider(connections);
  const openWorkspace = (connectionId?: string) => {
    const panel = WorkspacePanel.show(context.extensionUri, router);
    if (typeof connectionId === 'string') panel.emit({ type: 'focusConnection', connectionId });
    return panel;
  };
  const idOf = (arg: unknown): string | undefined => (arg instanceof ConnectionItem ? arg.summary.config.id : typeof arg === 'string' ? arg : undefined);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(`DeepDive: ${connections.redact(err)}`);
    }
  };

  context.subscriptions.push(
    output,
    tree,
    vscode.window.registerTreeDataProvider('deepdive.connections', tree),
    { dispose: connections.onDidChange(() => tree.refresh()) },
    vscode.commands.registerCommand('deepdive.openWorkspace', (arg?: unknown) => openWorkspace(idOf(arg))),
    vscode.commands.registerCommand('deepdive.addConnection', () => {
      openWorkspace().emit({ type: 'openConnectionForm' });
    }),
    vscode.commands.registerCommand('deepdive.addDemoConnection', () =>
      run(async () => {
        const res = await router.handle({ kind: 'request', id: 0, payload: { type: 'addDemoConnections' } });
        if (res && res.kind === 'response' && !res.ok) throw new Error(res.error.message);
        openWorkspace();
      }),
    ),
    vscode.commands.registerCommand('deepdive.refreshConnections', () => tree.refresh()),
    vscode.commands.registerCommand('deepdive.connect', (arg: unknown) =>
      run(async () => {
        const id = idOf(arg);
        if (id) await connections.connect(id);
      }),
    ),
    vscode.commands.registerCommand('deepdive.disconnect', (arg: unknown) =>
      run(async () => {
        const id = idOf(arg);
        if (!id) return;
        router.queries.cancelConnection(id);
        metadata.invalidate(id);
        await connections.disconnect(id);
      }),
    ),
    vscode.commands.registerCommand('deepdive.removeConnection', (arg: unknown) =>
      run(async () => {
        const id = idOf(arg);
        if (!id) return;
        const res = await router.handle({ kind: 'request', id: 0, payload: { type: 'deleteConnection', connectionId: id } });
        if (res && res.kind === 'response' && !res.ok) throw new Error(res.error.message);
      }),
    ),
    vscode.commands.registerCommand('deepdive.runSelectionInWorkspace', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      openWorkspace().emit({ type: 'openSql', sql });
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deepdive')) WorkspacePanel.instance?.emit({ type: 'settingsChanged', settings: toUiSettings(readSettings()) });
    }),
  );

  shutdown = async () => {
    router.dispose();
    WorkspacePanel.instance?.dispose();
    await connections.disconnectAll();
  };
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
