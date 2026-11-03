import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AuditTreeProvider, OPEN_FINDING_COMMAND } from './auditTree';
import { RULESET_VERSION } from './scanner/rules';
import { discoverExtensions } from './scanner/discover';
import { classifyTargets, type ClassifiedTargets, type ExclusionSettings } from './scanner/exclusion';
import { emptySnapshot, mergeSnapshot, type Snapshot } from './scanner/snapshot';
import { countRulesByLevel, hasNotableAdditions } from './scanner/summary';
import type { ExtensionScan, Finding, ScanTarget } from './scanner/types';
import { runScan } from './scanRunner';
import { SnapshotStore } from './snapshotStore';

const SCAN_COMMAND = 'extensionAudit.scan';
const VIEW_ID = 'extensionAudit.results';
const VIEW_DISCLAIMER = '検出がなくても、安全であることの証明ではありません。';

export interface ExtensionAuditApi {
  getSnapshot(): Snapshot;
}

function extensionsRoot(): string {
  const configured = vscode.workspace.getConfiguration('extensionAudit').get<string>('extensionsPath', '').trim();
  if (!configured) {
    return path.join(homedir(), '.vscode', 'extensions');
  }
  return configured === '~' || configured.startsWith('~/') ? path.join(homedir(), configured.slice(1)) : configured;
}

function exclusionSettings(): ExclusionSettings {
  const configuration = vscode.workspace.getConfiguration('extensionAudit');
  return {
    trustedPublishers: configuration.get<string[]>('trustedPublishers', []),
    excludedExtensions: configuration.get<string[]>('excludedExtensions', []),
  };
}

class AuditController {
  private snapshot: Snapshot = emptySnapshot();
  private explicitScanRunning = false;
  /** 同じ結果を同時に更新しないよう、検査を 1 つずつ実行する */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SnapshotStore,
    private readonly tree: AuditTreeProvider,
    private readonly view: vscode.TreeView<unknown>,
  ) {}

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  /** 前回の結果を表示してから、変化があったものを検査する */
  async start(): Promise<void> {
    const { snapshot, error } = await this.store.load();
    this.setSnapshot(snapshot);
    if (error) {
      void vscode.window.showWarningMessage(`以前の検査結果を読めませんでした。再検査すると作り直します: ${error}`);
    }
    await this.refresh();
  }

  /** 新しく入ったものや、除外を解除されたものだけを検査し、除外したものは結果から外す */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      const { snapshot } = this;
      // 一度も検査していなければ、ユーザーが始めるまで何も読まない
      if (Object.keys(snapshot.records).length === 0 && (snapshot.excluded ?? []).length === 0) {
        return;
      }
      const classified = this.discover();
      if (!classified) {
        return;
      }
      const { targets, excluded } = classified;
      const stale = snapshot.rulesetVersion !== RULESET_VERSION;
      const changed = stale ? targets : targets.filter((target) => !snapshot.records[target.dirName]);
      const removed = Object.keys(snapshot.records).some((dirName) => !targets.some((target) => target.dirName === dirName));
      const excludedChanged = JSON.stringify(snapshot.excluded ?? []) !== JSON.stringify(excluded);
      if (changed.length > 0 || removed || excludedChanged) {
        await this.scan(changed, classified, vscode.ProgressLocation.Window);
      }
    });
  }

  async scanAll(): Promise<void> {
    if (this.explicitScanRunning) {
      void vscode.window.showInformationMessage('検査を実行中です。');
      return;
    }
    this.explicitScanRunning = true;
    try {
      await this.enqueue(async () => {
        const classified = this.discover();
        if (classified) {
          await this.scan(classified.targets, classified, vscode.ProgressLocation.Notification);
        }
      });
    } finally {
      this.explicitScanRunning = false;
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async openFinding(dirName: string, finding: Finding): Promise<void> {
    const root = extensionsRoot();
    const absolute = path.resolve(root, dirName, finding.file);
    const relative = path.relative(path.resolve(root, dirName), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      void vscode.window.showErrorMessage(`拡張機能のフォルダの外は開きません: ${finding.file}`);
      return;
    }
    const uri = vscode.Uri.file(absolute);
    if (finding.rule === 'executable-file') {
      // 実行ファイルはエディターで開いても読めないので、Finder などで場所だけを示す
      await vscode.commands.executeCommand('revealFileInOS', uri);
      return;
    }
    const location = finding.locations[0];
    const position = location ? new vscode.Position(location.line - 1, location.column) : undefined;
    try {
      await vscode.window.showTextDocument(uri, {
        preview: true,
        selection: position ? new vscode.Range(position, position) : undefined,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`ファイルを開けませんでした: ${String(error)}`);
    }
  }

  private discover(): ClassifiedTargets | undefined {
    const root = extensionsRoot();
    try {
      return classifyTargets(root, discoverExtensions(root), exclusionSettings());
    } catch (error) {
      void vscode.window.showErrorMessage(`拡張機能のフォルダを読めませんでした（${root}）: ${String(error)}`);
      return undefined;
    }
  }

  private async scan(
    targets: ScanTarget[],
    classified: ClassifiedTargets,
    location: vscode.ProgressLocation.Notification | vscode.ProgressLocation.Window,
  ): Promise<void> {
    const results = await vscode.window.withProgress(
      { location, title: '拡張機能を検査中', cancellable: location === vscode.ProgressLocation.Notification },
      (progress, token) =>
        runScan(targets, {
          isCancelled: () => token.isCancellationRequested,
          onProgress: (target, completed, total) => {
            progress.report({ message: `${completed + 1}/${total} ${target.dirName}`, increment: 100 / total });
          },
        }),
    );

    this.setSnapshot(
      mergeSnapshot(
        this.snapshot,
        results,
        classified.targets.map((target) => target.dirName),
        new Date().toISOString(),
        classified.excluded,
      ),
    );
    try {
      await this.store.save(this.snapshot);
    } catch (error) {
      void vscode.window.showErrorMessage(`検査結果を保存できませんでした: ${String(error)}`);
    }
    this.report(results, targets.length, location === vscode.ProgressLocation.Notification);
  }

  private report(results: ExtensionScan[], total: number, explicit: boolean): void {
    const completed = results.length;
    const records = Object.values(this.snapshot.records);
    // 今回検査したものだけを通知し、以前に通知した更新を繰り返さない
    const notable = results.filter((scan) => hasNotableAdditions(this.snapshot.records[scan.dirName])).length;
    if (notable > 0) {
      void vscode.window
        .showWarningMessage(`${notable} 個の拡張機能で、更新により確認すべき項目が増えています。`, '結果を見る')
        .then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
          }
        });
    }
    if (!explicit) {
      return;
    }
    const high = records.filter((record) => countRulesByLevel(record.scan.findings).high > 0).length;
    const incomplete = records.filter((record) => record.scan.status !== 'complete').length;
    const prefix = completed < total ? `中止しました（${completed}/${total} 個を検査）。` : `${total} 個を検査しました。`;
    const excluded = (this.snapshot.excluded ?? []).length;
    void vscode.window.showInformationMessage(
      `${prefix}優先確認 ${high} 個、検査不能あり ${incomplete} 個、設定による除外 ${excluded} 個。`,
    );
  }

  private setSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.tree.setSnapshot(snapshot);
    const times = Object.values(snapshot.records).map((record) => record.scannedAt);
    this.view.message =
      times.length > 0
        ? `最終検査: ${new Date(times.reduce((a, b) => (a > b ? a : b))).toLocaleString()}。${VIEW_DISCLAIMER}`
        : undefined;
  }
}

export function activate(context: vscode.ExtensionContext): ExtensionAuditApi {
  const tree = new AuditTreeProvider();
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: tree, showCollapseAll: true });
  const store = new SnapshotStore(path.join(context.globalStorageUri.fsPath, 'snapshot.json'));
  const controller = new AuditController(store, tree, view as vscode.TreeView<unknown>);

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand(SCAN_COMMAND, () => controller.scanAll()),
    vscode.commands.registerCommand(OPEN_FINDING_COMMAND, (dirName: string, finding: Finding) =>
      controller.openFinding(dirName, finding),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('extensionAudit.trustedPublishers') ||
        event.affectsConfiguration('extensionAudit.excludedExtensions')
      ) {
        void controller.refresh();
      }
    }),
  );

  void controller.start().catch((error: unknown) => {
    void vscode.window.showErrorMessage(`Extension Audit を開始できませんでした: ${String(error)}`);
  });

  return { getSnapshot: () => controller.getSnapshot() };
}

export function deactivate(): void {}
