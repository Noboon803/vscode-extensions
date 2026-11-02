import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { CheatContent } from './cheatLoader';
import type { CheatSettings } from './command';
import type { FavoriteStore } from './favorites';
import type { HistoryStore, SentCommand } from './history';
import { sendToTerminal } from './terminal';

type WebviewMessage =
  | { type: 'ready' }
  | ({ type: 'addFavorite'; key: string } & CheatSettings)
  | { type: 'removeFavorite'; id: string }
  | ({ type: 'sendToTerminal' } & SentCommand)
  | { type: 'removeHistory'; id: string };

export class CheatsheetViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'cheatsheet.view';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getContent: () => Promise<CheatContent>,
    private readonly favorites: FavoriteStore,
    private readonly history: HistoryStore,
    private readonly send: (text: string) => Promise<boolean> = sendToTerminal,
  ) {}

  /** パネルが閉じていたり別のタブを表示していたりすると false になる */
  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose?.(() => {
      this.view = undefined;
    });

    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri, distUri] };

    // 内容は Webview の準備完了後に送る（先に送ると受信前のメッセージが失われる）
    view.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (message.type === 'ready') {
        await this.sendCategories();
      } else if (message.type === 'addFavorite') {
        const { id } = await this.favorites.add(message.key, { fields: message.fields, techniques: message.techniques });
        await view.webview.postMessage({ type: 'favorites', favorites: this.favorites.list(), addedId: id });
      } else if (message.type === 'removeFavorite') {
        await this.favorites.remove(message.id);
        await view.webview.postMessage({ type: 'favorites', favorites: this.favorites.list() });
      } else if (message.type === 'sendToTerminal') {
        // 複数行の確認で取り消したものは履歴に残さない
        if (await this.send(message.text)) {
          const { key, title, language, text, fields, techniques } = message;
          const { id } = await this.history.record({ key, title, language, text, fields, techniques });
          await view.webview.postMessage({ type: 'history', history: this.history.list(), sentId: id });
        }
      } else if (message.type === 'removeHistory') {
        await this.history.remove(message.id);
        await view.webview.postMessage({ type: 'history', history: this.history.list() });
      }
    });

    view.webview.html = this.renderHtml(view.webview, mediaUri, distUri);
  }

  /** 開いているビューに最新の内容を送る。ビューが閉じていれば次に開くときに送られる */
  async sendCategories(): Promise<void> {
    const content = await this.getContent();
    await this.view?.webview.postMessage({
      type: 'categories',
      ...content,
      favorites: this.favorites.list(),
      history: this.history.list(),
    });
  }

  private renderHtml(webview: vscode.Webview, mediaUri: vscode.Uri, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'cheatsheet.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>チートシート</title>
</head>
<body>
  <header>
    <select id="category" aria-label="カテゴリ"></select>
    <select id="cheat" aria-label="チート"></select>
  </header>
  <main id="cheat-detail"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
