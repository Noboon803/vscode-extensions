import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ScanRequest } from './scanWorker';
import type { ScanResult } from './sessionScanner';

const TIMEOUT_MS = 5 * 60 * 1000;

export function runScan(request: ScanRequest): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'scanWorker.js'));
    const timer = setTimeout(() => finish(() => reject(new Error('履歴の読み込みがタイムアウトしました'))), TIMEOUT_MS);
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    worker.once('message', (message: { result?: ScanResult; error?: string }) => {
      finish(() => (message.result ? resolve(message.result) : reject(new Error(message.error ?? '履歴を読み込めませんでした'))));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', () => finish(() => reject(new Error('履歴を読み込む処理が終了しました'))));
    worker.postMessage(request);
  });
}
