import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pendingTurns, sessionKey, settledTurn } from './aggregate';
import { ClaudeError, runClaude } from './claudeRunner';
import { analyzeTurns, type ModelCall } from './reviewExtractor';
import { buildChunks, estimateCostUsd } from './reviewPrompt';
import { ReviewStore } from './reviewStore';
import { discoverSessions, readConversation, type SessionFiles } from './sessionScanner';
import type { ConversationTurn, ReviewSnapshot, SessionReview } from './types';
import type { UsageService } from './usageService';

const CONCURRENCY = 3;

export interface RunReport {
  completed: number;
  failed: { key: string; message: string }[];
  skipped: number;
  costUsd: number;
  cancelled: boolean;
}

interface Target {
  key: string;
  files: SessionFiles;
  turns: ConversationTurn[];
  from: number;
  until: number;
}

function emptyReview(): SessionReview {
  return { analyzedTurns: 0, items: [], costUsd: 0, rejectedItems: 0 };
}

/** 指摘と質問の分析。費用がかかるので、呼び出し側が確認してから実行する */
export class ReviewService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly store: ReviewStore;
  private readonly subscription: vscode.Disposable;
  private reviews: Record<string, SessionReview> = {};
  private busy: string | undefined;
  private error: string | undefined;

  constructor(
    private readonly storagePath: string,
    private readonly usage: UsageService,
  ) {
    this.store = new ReviewStore(path.join(storagePath, 'review.json'));
    // ターンが増えると未分析の数が変わる
    this.subscription = usage.onDidChange(() => this.changed.fire());
    void this.reload();
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  current(): ReviewSnapshot {
    return { sessions: this.reviews, pending: pendingTurns(this.usage.current().sessions, this.reviews, Date.now()), busy: this.busy, error: this.error };
  }

  /** 他のウィンドウの結果も取り込む */
  async reload(): Promise<void> {
    try {
      this.reviews = await this.store.read();
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.changed.fire();
  }

  private setBusy(label: string | undefined): void {
    this.busy = label;
    this.changed.fire();
  }

  private settings() {
    return vscode.workspace.getConfiguration('ccSessionUsage');
  }

  model(): string {
    return this.settings().get<string>('reviewModel', 'claude-haiku-5-5');
  }

  private async targets(keys: string[] | undefined): Promise<Target[]> {
    const usage = this.usage.current();
    const pending = pendingTurns(usage.sessions, this.reviews, Date.now());
    const wanted = Object.keys(pending).filter((key) => !keys || keys.includes(key));
    if (wanted.length === 0) {
      return [];
    }
    const files = new Map((await discoverSessions(usage.configDir)).map((file) => [file.key, file]));
    const now = Date.now();
    const targets: Target[] = [];
    for (const key of wanted) {
      const session = usage.sessions.find((candidate) => sessionKey(candidate) === key);
      const file = files.get(key);
      if (session && file) {
        targets.push({ key, files: file, turns: await readConversation(file), from: this.reviews[key]?.analyzedTurns ?? 0, until: settledTurn(session, now) });
      }
    }
    return targets;
  }

  /** 実行前に見せる見積もり */
  async plan(keys: string[] | undefined): Promise<{ sessions: number; turns: number; estimateUsd: number | undefined; model: string }> {
    const targets = await this.targets(keys);
    const model = this.model();
    const chunks = targets.flatMap((target) => buildChunks(target.turns, target.from, target.until));
    const turns = targets.reduce((sum, target) => sum + target.until - target.from, 0);
    return { sessions: targets.length, turns, estimateUsd: estimateCostUsd(model, chunks, turns), model };
  }

  async analyze(keys: string[] | undefined, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<RunReport> {
    if (this.busy) {
      throw new Error('別の分析を実行中です');
    }
    const report: RunReport = { completed: 0, failed: [], skipped: 0, costUsd: 0, cancelled: false };
    this.setBusy('分析の準備中');
    let total = 0;
    let next = 0;
    try {
      await this.reload();
      const targets = await this.targets(keys);
      total = targets.length;
      const call = this.modelCall(signal);
      let done = 0;
      let stop = false;
      this.setBusy(`分析中（0/${total} セッション）`);
      const worker = async () => {
        while (next < targets.length && !stop && !signal?.aborted) {
          const target = targets[next++];
          try {
            report.costUsd += await this.analyzeOne(target, call);
            report.completed++;
          } catch (error) {
            report.costUsd += error instanceof ClaudeError ? error.costUsd : 0;
            if (!signal?.aborted) {
              report.failed.push({ key: target.key, message: error instanceof Error ? error.message : String(error) });
              // 認証切れや上限など、次も同じ理由で失敗しやすいので、新しいセッションを始めない
              stop = true;
            }
          }
          done++;
          await this.reload();
          this.setBusy(`分析中（${done}/${total} セッション）`);
          onProgress?.(done, total);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    } finally {
      this.busy = undefined;
      await this.reload();
    }
    report.cancelled = signal?.aborted === true;
    report.skipped = total - next;
    return report;
  }

  private modelCall(signal: AbortSignal | undefined): ModelCall {
    const claudePath = this.settings().get<string>('claudePath', 'claude').trim() || 'claude';
    const model = this.model();
    return async (request) => {
      await mkdir(this.storagePath, { recursive: true });
      // 作業フォルダの CLAUDE.md などを読まないよう、拡張機能の保存領域で実行する
      return runClaude({ ...request, claudePath, model, cwd: this.storagePath, signal });
    };
  }

  /** かかった費用を返す。チャンクごとに保存し、途中で失敗しても進んだ分を残す */
  private async analyzeOne(target: Target, call: ModelCall): Promise<number> {
    const model = this.model();
    let cost = 0;
    let savedCost = 0;
    const counting: ModelCall = async (request) => {
      try {
        const result = await call(request);
        cost += result.costUsd;
        return result;
      } catch (error) {
        if (error instanceof ClaudeError) {
          cost += error.costUsd;
        }
        throw error;
      }
    };
    const save = (change: (review: SessionReview) => void) =>
      this.store.update((sessions) => {
        const review = sessions[target.key] ?? emptyReview();
        change(review);
        sessions[target.key] = review;
      });
    try {
      await analyzeTurns(target.turns, target.from, target.until, counting, async (outcome) => {
        savedCost += outcome.costUsd;
        await save((review) => {
          // 他のウィンドウが先に処理していたら、同じターンを重ねて記録しない
          review.items.push(...outcome.items.filter((item) => item.turn > review.analyzedTurns));
          review.analyzedTurns = Math.max(review.analyzedTurns, outcome.throughTurn);
          review.costUsd += outcome.costUsd;
          review.rejectedItems += outcome.rejected;
          review.model = model;
        });
      });
    } catch (error) {
      // 結果がなくても費用はかかっているので、累計には残す
      if (cost > savedCost) {
        const unsaved = cost - savedCost;
        await save((review) => {
          review.costUsd += unsaved;
        });
      }
      throw new ClaudeError(error instanceof Error ? error.message : String(error), cost);
    }
    return cost;
  }
}
