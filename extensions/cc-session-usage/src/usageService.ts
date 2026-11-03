import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScan } from './scanRunner';
import { PARSER_VERSION } from './sessionParser';
import type { UsageSnapshot } from './types';
import { UsageStore } from './usageStore';

/** 応答中は履歴が連続して書き込まれるので、読み直す間隔を空ける */
const LIVE_MIN_INTERVAL_MS = 2000;

export function resolveConfigDir(configured: string, env: string | undefined, home: string): string {
  const value = configured.trim() || env?.trim() || path.join(home, '.claude');
  if (value === '~') {
    return home;
  }
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
}

/** 履歴を読み直して蓄積を更新し、変更を画面へ知らせる */
export class UsageService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<UsageSnapshot>();
  readonly onDidChange = this.changed.event;
  private readonly store: UsageStore;
  private loaded = false;
  private running: Promise<UsageSnapshot> | undefined;
  private rerun = false;
  private snapshot: UsageSnapshot;
  private watcher: vscode.FileSystemWatcher | undefined;
  private liveTimer: NodeJS.Timeout | undefined;
  private lastRunAt = 0;

  constructor(storagePath: string) {
    this.store = new UsageStore(path.join(storagePath, 'usage.json'), PARSER_VERSION);
    this.snapshot = { sessions: [], configDir: this.configDir(), updatedAt: 0 };
  }

  dispose(): void {
    this.setWatching(false);
    this.changed.dispose();
  }

  current(): UsageSnapshot {
    return this.snapshot;
  }

  private configDir(): string {
    const configured = vscode.workspace.getConfiguration('ccSessionUsage').get<string>('claudeConfigDir', '');
    return resolveConfigDir(configured, process.env.CLAUDE_CONFIG_DIR, os.homedir());
  }

  /** 画面が見えている間だけ履歴の変更を追いかける。隠れている間は読み直さない */
  setWatching(watching: boolean): void {
    if (watching === (this.watcher !== undefined)) {
      return;
    }
    if (!watching) {
      this.watcher?.dispose();
      this.watcher = undefined;
      clearTimeout(this.liveTimer);
      this.liveTimer = undefined;
      return;
    }
    const projects = vscode.Uri.file(path.join(this.configDir(), 'projects'));
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projects, '**/*.jsonl'));
    const schedule = () => this.scheduleLiveRefresh();
    this.watcher.onDidChange(schedule);
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidDelete(schedule);
  }

  /** 読み込むフォルダの設定が変わったときに、監視先を切り替える */
  restartWatching(): void {
    if (this.watcher) {
      this.setWatching(false);
      this.setWatching(true);
    }
  }

  private scheduleLiveRefresh(): void {
    if (this.liveTimer) {
      return;
    }
    const wait = Math.max(LIVE_MIN_INTERVAL_MS - (Date.now() - this.lastRunAt), 0);
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      void this.refresh();
    }, wait);
  }

  /** 読み込み中に呼ばれたら、終わった後にもう一度だけ読み直す */
  refresh(): Promise<UsageSnapshot> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.rerun) {
        this.rerun = false;
        void this.refresh();
      }
    });
    return this.running;
  }

  private async run(): Promise<UsageSnapshot> {
    this.lastRunAt = Date.now();
    const configDir = this.configDir();
    try {
      if (!this.loaded) {
        await this.store.load();
        this.loaded = true;
      }
      const result = await runScan({ configDir, known: this.store.knownFingerprints() });
      this.store.apply(result);
      if (result.changed.length > 0) {
        await this.store.save();
      }
      const failure = result.failures[0];
      this.snapshot = {
        sessions: this.store.summaries(),
        configDir,
        updatedAt: Date.now(),
        error: failure ? `${result.failures.length} 件のセッションを読み込めませんでした: ${failure.message}` : undefined,
      };
    } catch (error) {
      // 前回の表示は残し、失敗したことだけを知らせる
      this.snapshot = { ...this.snapshot, configDir, error: error instanceof Error ? error.message : String(error) };
    }
    this.changed.fire(this.snapshot);
    return this.snapshot;
  }
}
