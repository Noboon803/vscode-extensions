import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { PRICES_AS_OF } from './pricing';
import type { ReportFilter } from './report';
import type { ReviewService } from './reviewService';
import type { UsageService } from './usageService';

type PanelMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'rendered'; rows: number; reviewItems: number }
  | { type: 'analyze'; sessionKey?: string }
  | { type: 'exportReport'; days?: unknown; project?: unknown; sessionKey?: unknown };

export interface PanelTarget {
  sessionKey: string;
  turn?: number;
}

/** 画面は 1 つだけ開く。データの計算は Webview 側で行い、ここでは履歴の読み込みと受け渡しだけを担当する */
export class UsagePanel implements vscode.Disposable {
  static readonly viewType = 'ccSessionUsage.panel';

  private panel: vscode.WebviewPanel | undefined;
  /** Webview の準備が整う前に指定された表示先 */
  private pendingTarget: PanelTarget | undefined;
  private ready = false;
  private readonly disposables: vscode.Disposable[];
  private readonly rendered = new vscode.EventEmitter<number>();
  /** Webview が受け取ったデータを描画したときに、表の行数を知らせる */
  readonly onDidRender = this.rendered.event;
  private readonly renderedReview = new vscode.EventEmitter<number>();
  /** Webview が描画した、指摘と質問の項目の数を知らせる */
  readonly onDidRenderReview = this.renderedReview.event;
  private readonly visibilityChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeVisibility = this.visibilityChanged.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: UsageService,
    private readonly review: ReviewService,
    private readonly analyze: (sessionKey: string | undefined) => void,
    private readonly exportReport: (filter: ReportFilter) => void,
  ) {
    this.disposables = [
      service.onDidChange(() => this.send()),
      review.onDidChange(() => this.send()),
      vscode.window.registerWebviewPanelSerializer(UsagePanel.viewType, {
        deserializeWebviewPanel: async (panel) => this.attach(panel),
      }),
    ];
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.rendered.dispose();
    this.renderedReview.dispose();
    this.visibilityChanged.dispose();
    this.panel?.dispose();
  }

  get visible(): boolean {
    return this.panel?.visible === true;
  }

  open(target?: PanelTarget): void {
    this.pendingTarget = target;
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.attach(
        vscode.window.createWebviewPanel(UsagePanel.viewType, 'CC Session Usage', vscode.ViewColumn.Active, {
          retainContextWhenHidden: true,
        }),
      );
    }
    if (this.ready) {
      this.showPendingTarget();
    }
  }

  private showPendingTarget(): void {
    if (this.pendingTarget) {
      void this.panel?.webview.postMessage({ type: 'show', ...this.pendingTarget });
      this.pendingTarget = undefined;
    }
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.ready = false;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    panel.webview.html = this.renderHtml(panel.webview);
    const subscriptions = [
      panel.webview.onDidReceiveMessage((message: PanelMessage) => {
        if (message.type === 'ready') {
          this.ready = true;
          this.send();
          this.showPendingTarget();
          void this.service.refresh();
        } else if (message.type === 'refresh') {
          void this.service.refresh();
        } else if (message.type === 'rendered') {
          this.rendered.fire(message.rows);
          this.renderedReview.fire(message.reviewItems);
        } else if (message.type === 'analyze') {
          this.analyze(typeof message.sessionKey === 'string' ? message.sessionKey : undefined);
        } else if (message.type === 'exportReport') {
          this.exportReport({
            days: typeof message.days === 'number' ? message.days : null,
            project: typeof message.project === 'string' ? message.project : null,
            sessionKey: typeof message.sessionKey === 'string' ? message.sessionKey : null,
          });
        }
      }),
      // 実行中のセッションは増え続けるので、画面に戻ったら読み直す
      panel.onDidChangeViewState(() => {
        this.visibilityChanged.fire();
        if (panel.visible) {
          void this.service.refresh();
        }
      }),
    ];
    panel.onDidDispose(() => {
      subscriptions.forEach((subscription) => subscription.dispose());
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
        this.visibilityChanged.fire();
      }
    });
    this.visibilityChanged.fire();
  }

  private send(): void {
    void this.panel?.webview.postMessage({ type: 'data', snapshot: this.service.current(), review: this.review.current(), pricesAsOf: PRICES_AS_OF });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'usage.css'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>CC Session Usage</title>
</head>
<body>
  <main id="app"></main>
  <div id="tooltip" role="status" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
