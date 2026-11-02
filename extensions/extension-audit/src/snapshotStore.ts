import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { emptySnapshot, type Snapshot } from './scanner/snapshot';

export interface LoadedSnapshot {
  snapshot: Snapshot;
  /** ファイルが壊れていて読めなかった場合のメッセージ */
  error?: string;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { rulesetVersion, records } = value as Partial<Snapshot>;
  return typeof rulesetVersion === 'number' && typeof records === 'object' && records !== null;
}

/** 検査結果を拡張機能のストレージ領域に JSON で保存する */
export class SnapshotStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<LoadedSnapshot> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { snapshot: emptySnapshot() };
      }
      return { snapshot: emptySnapshot(), error: String(error) };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isSnapshot(parsed)) {
        return { snapshot: parsed };
      }
      return { snapshot: emptySnapshot(), error: '検査結果の形式が正しくありません' };
    } catch (error) {
      return { snapshot: emptySnapshot(), error: String(error) };
    }
  }

  /** 途中で止まっても前回の結果が壊れないよう、書き終えてから置き換える */
  async save(snapshot: Snapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(snapshot));
    await fs.rename(temporary, this.filePath);
  }
}
