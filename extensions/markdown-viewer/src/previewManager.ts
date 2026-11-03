import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { type CommentStore, type NewComment } from './comments';
import { renderMarkdown } from './markdownRenderer';
import { buildStyleRules } from './styles';

type PreviewMessage =
  | { type: 'ready' }
  | ({ type: 'addComment' } & Omit<NewComment, 'uri'>)
  | { type: 'removeComment'; id: string }
  | { type: 'openLink'; href: string }
  | { type: 'openSource' }
  | { type: 'showComments' }
  | { type: 'stylesApplied'; rejected: string[] };

const REFRESH_DELAY_MS = 200;

async function readSource(uri: vscode.Uri): Promise<string> {
  // 開いているドキュメントがあれば、未保存の編集も反映する
  const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  if (document) {
    return document.getText();
  }
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** 不正なエスケープを含むリンクでも、書かれたままのパスとして扱う */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function fileName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

/** プレビューは開いたときのファイルに固定する。アクティブなエディターにもスクロールにも追従しない */
export class PreviewManager implements vscode.Disposable {
  static readonly viewType = 'markdownViewer.preview';
  static readonly editorViewType = 'markdownViewer.editor';

  private readonly previews = new Map<string, Set<Preview>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** プレビューの数だけ同じ警告が出ないよう、知らせた内容を覚えておく */
  private readonly reportedStyleIssues = new Set<string>();
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly comments: CommentStore,
  ) {
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => this.scheduleRefresh(event.document.uri)),
      // 保存せずに閉じると内容がディスクの状態へ戻る
      vscode.workspace.onDidCloseTextDocument((document) => this.scheduleRefresh(document.uri)),
      comments.onDidChange(() => this.sendComments()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('markdownViewer.styles')) {
          this.reportedStyleIssues.clear();
          this.previews.forEach((previews) => previews.forEach((preview) => preview.sendStyles()));
        }
      }),
      // 「エディターを選択して開く」の一覧から選べるようにする
      vscode.window.registerCustomEditorProvider(
        PreviewManager.editorViewType,
        {
          resolveCustomTextEditor: (document, panel) => {
            this.attach(panel, document.uri);
          },
        },
        { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true },
      ),
      vscode.window.registerWebviewPanelSerializer(PreviewManager.viewType, {
        deserializeWebviewPanel: async (panel, state: { uri?: string } | undefined) => {
          if (state?.uri) {
            this.attach(panel, vscode.Uri.parse(state.uri));
          } else {
            panel.dispose();
          }
        },
      }),
    ];
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.disposables.forEach((disposable) => disposable.dispose());
    this.previews.forEach((previews) => previews.forEach((preview) => preview.dispose()));
  }

  /** すでに開いていれば前面に出し、なければ横に開く */
  open(uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.Beside): Preview {
    const [existing] = this.previews.get(uri.toString()) ?? [];
    if (existing) {
      existing.reveal();
      return existing;
    }
    return this.openNew(uri, column);
  }

  /** 同じファイルでも別のプレビューとして横に開く */
  openNew(uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.Beside): Preview {
    const panel = vscode.window.createWebviewPanel(PreviewManager.viewType, fileName(uri), column, {
      retainContextWhenHidden: true,
    });
    return this.attach(panel, uri);
  }

  /** コメントの位置をプレビューで表示する */
  revealComment(commentId: string): void {
    const comment = this.comments.get(commentId);
    if (comment) {
      this.open(vscode.Uri.parse(comment.uri), vscode.ViewColumn.Active).showComment(commentId);
    }
  }

  private attach(panel: vscode.WebviewPanel, uri: vscode.Uri): Preview {
    const preview = new Preview(
      panel,
      uri,
      this.extensionUri,
      this.comments,
      (target) => this.open(target),
      (issues) => this.reportStyleIssues(issues),
    );
    const key = uri.toString();
    const previews = this.previews.get(key) ?? new Set();
    this.previews.set(key, previews.add(preview));
    panel.onDidDispose(() => {
      previews.delete(preview);
      if (previews.size === 0) {
        this.previews.delete(key);
      }
    });
    return preview;
  }

  private reportStyleIssues(issues: string[]): void {
    const unreported = issues.filter((issue) => !this.reportedStyleIssues.has(issue));
    unreported.forEach((issue) => this.reportedStyleIssues.add(issue));
    if (unreported.length > 0) {
      void vscode.window.showWarningMessage(`Markdown Viewer: 無効なスタイルの値です（${unreported.join('、')}）`);
    }
  }

  private scheduleRefresh(uri: vscode.Uri): void {
    const key = uri.toString();
    if (!this.previews.has(key)) {
      return;
    }
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.previews.get(key)?.forEach((preview) => void preview.refresh());
      }, REFRESH_DELAY_MS),
    );
  }

  private sendComments(): void {
    this.previews.forEach((previews) => previews.forEach((preview) => preview.sendComments()));
  }
}

class Preview implements vscode.Disposable {
  private ready = false;
  private pendingMessage: object | undefined;
  private rejected: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly uri: vscode.Uri,
    private readonly extensionUri: vscode.Uri,
    private readonly comments: CommentStore,
    private readonly openPreview: (uri: vscode.Uri) => Preview,
    private readonly reportStyleIssues: (issues: string[]) => void,
  ) {
    const directory = vscode.Uri.joinPath(uri, '..');
    panel.title = fileName(uri);
    panel.webview.options = {
      enableScripts: true,
      // ドキュメントから相対パスで参照される画像を読めるようにする
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.joinPath(extensionUri, 'dist'),
        directory,
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
      ],
    };

    this.disposables.push(panel.webview.onDidReceiveMessage((message: PreviewMessage) => this.handleMessage(message)));
    if (uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, fileName(uri)));
      const refresh = () => void this.refresh();
      this.disposables.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
    }
    panel.onDidDispose(() => this.disposables.forEach((disposable) => disposable.dispose()));

    panel.webview.html = this.renderHtml();
  }

  dispose(): void {
    this.panel.dispose();
  }

  /** Webview のスクリプトが動き出し、最初の内容を送り終えた */
  get isReady(): boolean {
    return this.ready;
  }

  reveal(): void {
    this.panel.reveal();
  }

  showComment(commentId: string): void {
    this.postWhenReady({ type: 'showComment', id: commentId });
  }

  /** Webview が受け付けなかったスタイルの値 */
  get rejectedStyles(): string[] {
    return this.rejected;
  }

  sendStyles(): void {
    const styles = vscode.workspace.getConfiguration('markdownViewer', this.uri).get('styles');
    void this.panel.webview.postMessage({ type: 'styles', rules: buildStyleRules(styles) });
  }

  /** 0 始まりの行を表示する */
  showLine(line: number): void {
    this.postWhenReady({ type: 'showLine', line });
  }

  private postWhenReady(message: object): void {
    if (this.ready) {
      void this.panel.webview.postMessage(message);
    } else {
      this.pendingMessage = message;
    }
  }

  async refresh(): Promise<void> {
    const webview = this.panel.webview;
    const base = {
      type: 'render',
      uri: this.uri.toString(),
      path: vscode.workspace.asRelativePath(this.uri),
      baseHref: `${webview.asWebviewUri(vscode.Uri.joinPath(this.uri, '..')).toString()}/`,
    };
    try {
      const source = await readSource(this.uri);
      await this.comments.relocateAll(this.uri.toString(), source);
      await webview.postMessage({ ...base, html: renderMarkdown(source) });
    } catch (error) {
      console.warn('Markdown Viewer: ファイルを読み込めませんでした', error);
      await webview.postMessage({ ...base, error: 'ファイルを読み込めませんでした。移動または削除された可能性があります。' });
    }
    this.sendComments();
  }

  sendComments(): void {
    void this.panel.webview.postMessage({ type: 'comments', comments: this.comments.listFor(this.uri.toString()) });
  }

  private async handleMessage(message: PreviewMessage): Promise<void> {
    if (message.type === 'ready') {
      this.sendStyles();
      await this.refresh();
      this.ready = true;
      if (this.pendingMessage) {
        this.postWhenReady(this.pendingMessage);
        this.pendingMessage = undefined;
      }
    } else if (message.type === 'addComment') {
      const { line, endLine, quote, text } = message;
      await this.comments.add({ uri: this.uri.toString(), line, endLine, quote, text }, await readSource(this.uri));
    } else if (message.type === 'removeComment') {
      await this.comments.remove(message.id);
    } else if (message.type === 'openLink') {
      await this.openLink(message.href);
    } else if (message.type === 'openSource') {
      await vscode.window.showTextDocument(this.uri, { viewColumn: vscode.ViewColumn.Beside });
    } else if (message.type === 'stylesApplied') {
      this.rejected = message.rejected;
      this.reportStyleIssues(message.rejected);
    } else if (message.type === 'showComments') {
      await vscode.commands.executeCommand('markdownViewer.comments.focus');
    }
  }

  private async openLink(href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const target = this.resolveLink(href);
    if (!target) {
      return;
    }
    if (/\.(md|markdown)$/i.test(target.path)) {
      const preview = this.openPreview(target);
      const line = /#L(\d+)$/i.exec(href);
      if (line) {
        preview.showLine(Number(line[1]) - 1);
      }
    } else {
      await vscode.commands.executeCommand('vscode.open', target, vscode.ViewColumn.Beside);
    }
  }

  private resolveLink(href: string): vscode.Uri | undefined {
    if (/^file:/i.test(href)) {
      return vscode.Uri.parse(href).with({ query: '', fragment: '' });
    }
    // ほかのスキームは開かない
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      return undefined;
    }
    const path = decodePath(href.split(/[?#]/)[0]);
    if (!path) {
      return undefined;
    }
    const root = path.startsWith('/') ? vscode.workspace.getWorkspaceFolder(this.uri)?.uri : undefined;
    return vscode.Uri.joinPath(root ?? vscode.Uri.joinPath(this.uri, '..'), path);
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'preview.js'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>プレビュー</title>
</head>
<body>
  <header>
    <span id="path"></span>
    <button id="open-source" type="button">ソースを開く</button>
    <button id="show-comments" type="button">コメント</button>
  </header>
  <main id="content"></main>
  <button id="add-comment" type="button" hidden></button>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
