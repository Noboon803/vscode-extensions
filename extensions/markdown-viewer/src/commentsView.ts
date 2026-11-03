import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { type CommentStore, encodeLinkPath, formatBullets } from './comments';
import { type PreviewManager } from './previewManager';

type ViewMessage =
  | { type: 'ready' }
  | { type: 'remove'; id: string }
  | { type: 'reveal'; id: string }
  | { type: 'copy' }
  | { type: 'clear' };

function displayPath(uri: string): string {
  return vscode.workspace.asRelativePath(vscode.Uri.parse(uri));
}

/**
 * 貼り付け先の場所によらず開けるよう、ワークスペースのルートからのパスにする。
 * ワークスペースの外のファイルは file: の URI にする
 */
function linkTarget(uri: string): string {
  const parsed = vscode.Uri.parse(uri);
  const folder = vscode.workspace.getWorkspaceFolder(parsed);
  return folder ? encodeLinkPath(parsed.path.slice(folder.uri.path.replace(/\/$/, '').length)) : parsed.toString();
}

export async function copyComments(comments: CommentStore): Promise<void> {
  const list = comments.list();
  if (list.length === 0) {
    void vscode.window.showInformationMessage('コピーするコメントがありません。');
    return;
  }
  await vscode.env.clipboard.writeText(formatBullets(list, displayPath, linkTarget));
  vscode.window.setStatusBarMessage(`コメント ${list.length} 件をコピーしました`, 3000);
}

export async function clearComments(comments: CommentStore): Promise<void> {
  const count = comments.list().length;
  if (count === 0) {
    return;
  }
  const action = await vscode.window.showWarningMessage(`コメント ${count} 件をすべて削除しますか？`, { modal: true }, '削除');
  if (action) {
    await comments.clear();
  }
}

/** パネルの「コメント」タブに、すべてのコメントを表で表示する */
export class CommentsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'markdownViewer.comments';

  private view: vscode.WebviewView | undefined;
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly comments: CommentStore,
    private readonly previews: PreviewManager,
  ) {
    this.subscription = comments.onDidChange(() => this.send());
  }

  dispose(): void {
    this.subscription.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose(() => {
      this.view = undefined;
    });

    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri, distUri] };

    view.webview.onDidReceiveMessage(async (message: ViewMessage) => {
      if (message.type === 'ready') {
        this.send();
      } else if (message.type === 'remove') {
        await this.comments.remove(message.id);
      } else if (message.type === 'reveal') {
        this.previews.revealComment(message.id);
      } else if (message.type === 'copy') {
        await copyComments(this.comments);
      } else if (message.type === 'clear') {
        await clearComments(this.comments);
      }
    });

    view.webview.html = this.renderHtml(view.webview, mediaUri, distUri);
  }

  private send(): void {
    const list = this.comments.list();
    if (this.view) {
      this.view.badge = list.length > 0 ? { value: list.length, tooltip: `コメント ${list.length} 件` } : undefined;
    }
    void this.view?.webview.postMessage({
      type: 'comments',
      comments: list.map(({ id, uri, line, quote, text, createdAt, stale }) => ({
        id,
        path: displayPath(uri),
        line: line + 1,
        quote,
        text,
        createdAt,
        stale,
      })),
    });
  }

  private renderHtml(webview: vscode.Webview, mediaUri: vscode.Uri, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'comments.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview', 'comments.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>コメント</title>
</head>
<body>
  <div id="toolbar">
    <button id="copy" type="button">箇条書きでコピー</button>
    <button id="clear" type="button" class="secondary">すべて削除</button>
  </div>
  <p id="empty" hidden>コメントはありません。プレビューで文章を選択するか、行の左の + を押すと書き込めます。</p>
  <table id="table" hidden>
    <thead>
      <tr><th>ファイル</th><th>対象</th><th>コメント</th><th>日時</th><th><span class="visually-hidden">削除</span></th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
