import * as vscode from 'vscode';
import { isAutomated, pickCurrentSession, projectLabel, sessionCost, sessionKey, sessionTitle, totalTokens } from './aggregate';
import { formatCount, formatUsd } from './format';
import type { SessionSummary, TurnSummary } from './types';
import type { UsageService } from './usageService';

const MAX_LISTED_SESSIONS = 50;

class ListProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly load: () => vscode.TreeItem[]) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    return element ? [] : this.load();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function turnTooltip(turn: TurnSummary, index: number): string {
  return [
    `ターン ${index + 1}: ${turn.prompt}`,
    '',
    `コスト ${formatUsd(turn.costUsd)}（定価換算）`,
    `入力 ${formatCount(turn.tokens.input)} / 出力 ${formatCount(turn.tokens.output)}`,
    `キャッシュ読取 ${formatCount(turn.tokens.cacheRead)} / 書込 ${formatCount(turn.tokens.cacheWrite)}`,
    `コンテキスト ${formatCount(turn.contextTokens)}`,
    `リクエスト ${turn.requests} / ツール ${turn.tools} / 変更 +${turn.linesAdded} −${turn.linesRemoved}`,
  ].join('\n');
}

/** サイドバーのビュー。狭い場所でも読めるように、詳しい内容はツールチップとパネルに任せる */
export class UsageViews implements vscode.Disposable {
  private readonly currentProvider = new ListProvider(() => this.currentItems());
  private readonly sessionsProvider = new ListProvider(() => this.sessionItems());
  private readonly currentView: vscode.TreeView<vscode.TreeItem>;
  private readonly sessionsView: vscode.TreeView<vscode.TreeItem>;
  private readonly disposables: vscode.Disposable[];
  private readonly visibilityChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeVisibility = this.visibilityChanged.event;

  constructor(private readonly service: UsageService) {
    this.currentView = vscode.window.createTreeView('ccSessionUsage.currentSession', { treeDataProvider: this.currentProvider });
    this.sessionsView = vscode.window.createTreeView('ccSessionUsage.sessions', { treeDataProvider: this.sessionsProvider });
    this.disposables = [
      this.currentView,
      this.sessionsView,
      this.currentProvider,
      this.sessionsProvider,
      this.visibilityChanged,
      this.currentView.onDidChangeVisibility(() => this.visibilityChanged.fire()),
      this.sessionsView.onDidChangeVisibility(() => this.visibilityChanged.fire()),
      service.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.update()),
    ];
    this.update();
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  get visible(): boolean {
    return this.currentView.visible || this.sessionsView.visible;
  }

  private current() {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    return pickCurrentSession(this.service.current().sessions, folders);
  }

  private update(): void {
    const current = this.current();
    if (current) {
      const { session, matched } = current;
      this.currentView.description = `${projectLabel(session)} ・ ${formatUsd(sessionCost(session))}`;
      const title = sessionTitle(session);
      this.currentView.message = matched ? title : `このフォルダのセッションがないため、最も新しいセッションを表示しています: ${title}`;
    } else {
      this.currentView.description = undefined;
      this.currentView.message = undefined;
    }
    this.currentProvider.refresh();
    this.sessionsProvider.refresh();
  }

  /** 新しいターンが上に来るように並べる。番号は発言の順番のまま */
  currentItems(): vscode.TreeItem[] {
    const current = this.current();
    if (!current) {
      return [];
    }
    const { session } = current;
    const key = sessionKey(session);
    return session.turns
      .map((turn, index) => {
        const item = new vscode.TreeItem(`${index + 1}. ${turn.prompt}`);
        item.id = `${key}#${index}`;
        item.description = `${formatUsd(turn.costUsd)} ・ ${formatCount(totalTokens(turn.tokens))}`;
        item.tooltip = turnTooltip(turn, index);
        item.command = { command: 'ccSessionUsage.openSession', title: 'ターンを開く', arguments: [key, index] };
        return item;
      })
      .reverse();
  }

  sessionItems(): vscode.TreeItem[] {
    return this.service
      .current()
      .sessions.filter((session) => !isAutomated(session) && sessionCost(session) > 0)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, MAX_LISTED_SESSIONS)
      .map((session: SessionSummary) => {
        const key = sessionKey(session);
        const item = new vscode.TreeItem(sessionTitle(session));
        item.id = key;
        item.description = `${formatUsd(sessionCost(session))} ・ ${projectLabel(session)}`;
        item.tooltip = `${sessionTitle(session)}\n${session.cwd ?? session.projectDir}\n${session.turns.length} ターン`;
        item.command = { command: 'ccSessionUsage.openSession', title: 'セッションを開く', arguments: [key] };
        return item;
      });
  }
}
