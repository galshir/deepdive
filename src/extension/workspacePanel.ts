import * as vscode from 'vscode';
import type { MessageRouter } from '../core/router';
import type { HostEvent, HostToWebview } from '../shared/protocol';

/** The single DeepDive workspace webview. Messages are forwarded to the (validating) router. */
export class WorkspacePanel {
  static readonly viewType = 'deepdive.workspace';
  private static current: WorkspacePanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queue: HostEvent[] = [];
  private ready = false;

  static show(extensionUri: vscode.Uri, router: MessageRouter): WorkspacePanel {
    if (WorkspacePanel.current) {
      WorkspacePanel.current.panel.reveal(vscode.ViewColumn.Active);
      return WorkspacePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(WorkspacePanel.viewType, 'DeepDive', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    WorkspacePanel.current = new WorkspacePanel(panel, extensionUri, router);
    return WorkspacePanel.current;
  }

  static get instance(): WorkspacePanel | undefined {
    return WorkspacePanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly router: MessageRouter,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'activity.svg');
    panel.webview.html = this.html(panel.webview, extensionUri);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        if (!this.ready) {
          this.ready = true;
          for (const e of this.queue.splice(0)) this.post({ kind: 'event', event: e });
        }
        const response = await this.router.handle(msg);
        if (response) this.post(response);
      }),
    );
  }

  /** Events are queued until the webview has sent its first message (i.e. its listener is installed). */
  emit(event: HostEvent): void {
    if (!this.ready) {
      this.queue.push(event);
      if (this.queue.length > 200) this.queue.shift();
      return;
    }
    this.post({ kind: 'event', event });
  }

  private post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = createNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="csp-nonce" content="${nonce}" />
  <link rel="stylesheet" href="${style.toString()}" />
  <title>DeepDive</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    WorkspacePanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
