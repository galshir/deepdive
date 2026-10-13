import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/services/connectionManager';
import type { ConnectionSummary } from '../shared/model';

export class ConnectionItem extends vscode.TreeItem {
  constructor(readonly summary: ConnectionSummary) {
    super(summary.config.name, vscode.TreeItemCollapsibleState.None);
    const c = summary.config;
    this.id = c.id;
    this.description = c.kind === 'demo' ? 'demo' : `${c.user}@${c.host}:${c.port}`;
    this.contextValue = summary.status === 'connected' ? 'connection.connected' : 'connection.disconnected';
    const icon = summary.status === 'connected' ? 'database' : summary.status === 'error' ? 'error' : summary.status === 'connecting' ? 'loading~spin' : 'circle-outline';
    this.iconPath = new vscode.ThemeIcon(icon, summary.status === 'connected' ? new vscode.ThemeColor('charts.green') : undefined);
    this.tooltip = new vscode.MarkdownString(
      `**${c.name}** — ${summary.status}${summary.serverVersion ? `\n\n${summary.serverVersion}` : ''}${summary.error ? `\n\n$(error) ${summary.error}` : ''}${c.readOnly ? '\n\nRead-only' : ''}`,
      true,
    );
    this.command = { command: 'deepdive.openWorkspace', title: 'Open', arguments: [c.id] };
  }
}

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<ConnectionItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly connections: ConnectionManager) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: ConnectionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ConnectionItem[] {
    return this.connections.list().map((s) => new ConnectionItem(s));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
