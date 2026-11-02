import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import type { CheatSettings } from './command';

const MAX_ENTRIES = 50;

/** チートが YAML から消えても送信したコマンドを見られるよう、表示に必要な値も持つ */
export interface SentCommand extends CheatSettings {
  key: string;
  title: string;
  language?: string;
  text: string;
}

export interface HistoryEntry extends SentCommand {
  id: string;
  /** エポックからのミリ秒 */
  sentAt: number;
}

/** 送信履歴を新しい順に保存する。入力値に機密が混ざりうるので Settings Sync の対象にしない */
export class HistoryStore {
  static readonly storageKey = 'cheatsheet.history';

  constructor(
    private readonly memento: vscode.Memento,
    private readonly now: () => number = Date.now,
  ) {}

  list(): HistoryEntry[] {
    return this.memento.get<HistoryEntry[]>(HistoryStore.storageKey, []);
  }

  /** 同じチートの同じコマンドは 1 件にまとめ、先頭へ移す */
  async record(sent: SentCommand): Promise<HistoryEntry> {
    const current = this.list();
    const same = current.find((entry) => entry.key === sent.key && entry.text === sent.text);
    const entry: HistoryEntry = { ...sent, id: same?.id ?? randomUUID(), sentAt: this.now() };
    const next = [entry, ...current.filter((item) => item !== same)].slice(0, MAX_ENTRIES);
    await this.memento.update(HistoryStore.storageKey, next);
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(HistoryStore.storageKey, this.list().filter((entry) => entry.id !== id));
  }
}
