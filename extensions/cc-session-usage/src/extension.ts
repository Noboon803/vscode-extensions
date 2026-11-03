import * as vscode from 'vscode';
import type { UsageSnapshot } from './types';
import { UsagePanel } from './usagePanel';
import { UsageService } from './usageService';
import { UsageViews } from './usageViews';

export interface SessionUsageApi {
  refresh(): Promise<UsageSnapshot>;
  onDidRender: vscode.Event<number>;
  onDidChange: vscode.Event<UsageSnapshot>;
  currentTurnLabels(): string[];
}

export function activate(context: vscode.ExtensionContext): SessionUsageApi {
  const service = new UsageService(context.globalStorageUri.fsPath);
  const panel = new UsagePanel(context.extensionUri, service);
  const views = new UsageViews(service);
  const updateWatching = () => service.setWatching(views.visible || panel.visible);
  context.subscriptions.push(
    service,
    panel,
    views,
    vscode.commands.registerCommand('ccSessionUsage.open', () => panel.open()),
    vscode.commands.registerCommand('ccSessionUsage.refresh', () => service.refresh()),
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
  };
}

export function deactivate(): void {}
