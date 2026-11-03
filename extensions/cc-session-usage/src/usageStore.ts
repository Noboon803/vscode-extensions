import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ScanResult } from './sessionScanner';
import type { SessionSummary } from './types';

interface StoredSession {
  fingerprint: string;
  summary: SessionSummary;
}

interface StoreFile {
  parserVersion: number;
  sessions: Record<string, StoredSession>;
}

function isStoreFile(value: unknown): value is StoreFile {
  const file = value as StoreFile | null;
  return typeof file?.parserVersion === 'number' && typeof file.sessions === 'object' && file.sessions !== null;
}

/**
 * 集計結果の蓄積。Claude Code は古い履歴を自動で削除するので、
 * 元のファイルがなくなったセッションも消さずに残す。
 */
export class UsageStore {
  private sessions: Record<string, StoredSession> = {};
  /** 集計方法が変わった後は、ファイルが同じでも読み直す */
  private stale = false;

  constructor(
    private readonly filePath: string,
    private readonly parserVersion: number,
  ) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isStoreFile(parsed)) {
      // 上書きすると蓄積を失うので、壊れたファイルは残しておく
      await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      return;
    }
    this.sessions = parsed.sessions;
    this.stale = parsed.parserVersion !== this.parserVersion;
  }

  knownFingerprints(): Record<string, string> {
    if (this.stale) {
      return {};
    }
    return Object.fromEntries(Object.entries(this.sessions).map(([key, stored]) => [key, stored.fingerprint]));
  }

  apply(result: ScanResult): void {
    for (const { key, fingerprint, summary } of result.changed) {
      const previous = this.sessions[key]?.summary;
      // 履歴の本文が後から失われることがある。少ない内容で上書きせず、多いほうを残す
      if (!this.stale && previous && previous.computedCostUsd > summary.computedCostUsd) {
        this.sessions[key] = {
          fingerprint,
          summary: { ...previous, recordedCostUsd: summary.recordedCostUsd ?? previous.recordedCostUsd },
        };
      } else {
        this.sessions[key] = { fingerprint, summary };
      }
    }
    const present = new Set(result.presentKeys);
    for (const [key, stored] of Object.entries(this.sessions)) {
      if (present.has(key)) {
        delete stored.summary.transcriptRemoved;
      } else {
        stored.summary.transcriptRemoved = true;
      }
    }
    this.stale = false;
  }

  summaries(): SessionSummary[] {
    return Object.values(this.sessions).map((stored) => stored.summary);
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const file: StoreFile = { parserVersion: this.parserVersion, sessions: this.sessions };
    // 複数のウィンドウが同時に書いても壊れないよう、書き終えてから置き換える
    const temp = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(file));
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
