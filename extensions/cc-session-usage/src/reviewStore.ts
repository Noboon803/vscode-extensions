import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionReview } from './types';

interface StoreFile {
  version: 1;
  sessions: Record<string, SessionReview>;
}

function isStoreFile(value: unknown): value is StoreFile {
  const file = value as StoreFile | null;
  return file?.version === 1 && typeof file.sessions === 'object' && file.sessions !== null;
}

/**
 * 分析結果の保存先。分析には費用がかかり、元の履歴は自動で削除されるので、消さずに残す。
 * 他のウィンドウも書き込むので、更新のたびに読み直してから書く。
 */
export class ReviewStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<Record<string, SessionReview>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
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
      // 上書きすると費用をかけた結果を失うので、壊れたファイルは残しておく
      await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      return {};
    }
    return parsed.sessions;
  }

  /** 同じウィンドウからの更新は順番に処理する */
  update(change: (sessions: Record<string, SessionReview>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const sessions = await this.read();
      change(sessions);
      await this.write({ version: 1, sessions });
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(file: StoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
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
