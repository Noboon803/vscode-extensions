import * as os from 'node:os';
import * as vscode from 'vscode';
import { PRICES_AS_OF } from './pricing';
import { buildReport, type ReportFilter, reportFileName } from './report';
import { ReviewService, type RunReport } from './reviewService';
import type { ReviewSnapshot, UsageSnapshot } from './types';
import { UsagePanel } from './usagePanel';
import { UsageService } from './usageService';
import { UsageViews } from './usageViews';

export interface SessionUsageApi {
  refresh(): Promise<UsageSnapshot>;
  onDidRender: vscode.Event<number>;
  onDidChange: vscode.Event<UsageSnapshot>;
  currentTurnLabels(): string[];
  /** 保存先を尋ねずにレポートを書き出す。テスト用 */
  writeReport(target: vscode.Uri, filter: ReportFilter): Promise<void>;
  /** 確認の画面を出さずに分析する。テスト用 */
  analyze(): Promise<RunReport>;
  review(): ReviewSnapshot;
  onDidRenderReview: vscode.Event<number>;
}

function formatEstimate(usd: number | undefined): string {
  if (usd === undefined) {
    return '不明';
  }
  return usd < 0.01 ? '$0.01 未満' : `約 $${usd.toFixed(2)}`;
}

/** 費用がかかり、会話の本文を送信するので、必ず見積もりを見せて確認してから実行する */
async function runAnalysis(review: ReviewService, usage: UsageService, keys: string[] | undefined): Promise<void> {
  await usage.refresh();
  const plan = await review.plan(keys);
  if (plan.sessions === 0) {
    void vscode.window.showInformationMessage('分析するターンはありません。応答中かもしれない最後のターンは、10 分後に対象になります。');
    return;
  }
  const detail = `${plan.sessions} セッション、${plan.turns} ターン、モデル ${plan.model}、費用の目安 ${formatEstimate(plan.estimateUsd)}\n\nあなたの発言とエージェントの応答の本文を、claude コマンドの接続先へ送信します。ツールの入力と実行結果は送りません。`;
  const answer = await vscode.window.showWarningMessage('会話から指摘と質問を分析しますか？', { modal: true, detail }, '分析する');
  if (answer !== '分析する') {
    return;
  }
  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'CC Session Usage: 指摘と質問を分析中', cancellable: true }, (progress, token) => {
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());
    let last = 0;
    return review.analyze(keys, abort.signal, (done, total) => {
      progress.report({ message: `${done}/${total} セッション`, increment: ((done - last) / total) * 100 });
      last = done;
    });
  });
  const summary = `${report.completed} セッションを分析しました（費用 $${report.costUsd.toFixed(4)}）`;
  if (report.failed.length > 0) {
    const rest = report.skipped > 0 ? `残り ${report.skipped} セッションは実行していません。` : '';
    void vscode.window.showErrorMessage(`${summary}。失敗: ${report.failed[0].message} ${rest}`);
  } else {
    void vscode.window.showInformationMessage(report.cancelled ? `取り消しました。${summary}` : summary);
  }
}

async function writeReport(review: ReviewService, usage: UsageService, target: vscode.Uri, filter: ReportFilter): Promise<void> {
  const { sessions } = await usage.refresh();
  await review.reload();
  const current = review.current();
  const html = buildReport({ sessions, reviews: current.sessions, pending: current.pending, filter, generatedAt: Date.now(), pricesAsOf: PRICES_AS_OF });
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
}

/** 保存先を尋ねて書き出す。ブラウザは利用者が選んだときだけ開く */
async function exportReport(review: ReviewService, usage: UsageService, filter: ReportFilter): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), reportFileName(Date.now())),
    filters: { HTML: ['html'] },
    title: 'HTML レポートの保存先（発言の内容を含みます）',
  });
  if (!target) {
    return;
  }
  await writeReport(review, usage, target, filter);
  const open = 'ブラウザで開く';
  const answer = await vscode.window.showInformationMessage(`レポートを保存しました: ${target.fsPath}`, open);
  if (answer === open) {
    await vscode.env.openExternal(target);
  }
}

export function activate(context: vscode.ExtensionContext): SessionUsageApi {
  const service = new UsageService(context.globalStorageUri.fsPath);
  const review = new ReviewService(context.globalStorageUri.fsPath, service);
  const startAnalysis = (keys: string[] | undefined) => {
    runAnalysis(review, service, keys).catch((error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    });
  };
  const startExport = (filter: ReportFilter) => {
    exportReport(review, service, filter).catch((error: unknown) => {
      void vscode.window.showErrorMessage(`レポートを保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const panel = new UsagePanel(context.extensionUri, service, review, (key) => startAnalysis(key ? [key] : undefined), startExport);
  const views = new UsageViews(service);
  const updateWatching = () => service.setWatching(views.visible || panel.visible);
  context.subscriptions.push(
    service,
    review,
    panel,
    views,
    vscode.commands.registerCommand('ccSessionUsage.open', () => panel.open()),
    vscode.commands.registerCommand('ccSessionUsage.refresh', () => service.refresh()),
    vscode.commands.registerCommand('ccSessionUsage.analyzeAll', () => startAnalysis(undefined)),
    vscode.commands.registerCommand('ccSessionUsage.exportReport', () => startExport({ days: null, project: null, sessionKey: null })),
    vscode.commands.registerCommand('ccSessionUsage.openSession', (sessionKey: string, turn?: number) => panel.open({ sessionKey, turn })),
    panel.onDidChangeVisibility(updateWatching),
    views.onDidChangeVisibility(() => {
      updateWatching();
      if (views.visible) {
        void service.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('ccSessionUsage.claudeConfigDir')) {
        service.restartWatching();
        void service.refresh();
      }
    }),
  );
  updateWatching();
  // 履歴は既定で 30 日後に削除されるので、画面を開かなくても起動のたびに蓄積する
  void service.refresh();
  return {
    refresh: () => service.refresh(),
    onDidRender: panel.onDidRender,
    onDidChange: service.onDidChange,
    currentTurnLabels: () => views.currentItems().map((item) => String(item.label)),
    writeReport: (target, filter) => writeReport(review, service, target, filter),
    analyze: () => review.analyze(undefined),
    review: () => review.current(),
    onDidRenderReview: panel.onDidRenderReview,
  };
}

export function deactivate(): void {}
