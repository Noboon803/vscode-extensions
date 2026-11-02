import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { failedScan } from './scanner/discover';
import type { ExtensionScan, ScanOptions, ScanTarget } from './scanner/types';
import type { ScanRequest } from './scanWorker';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunOptions {
  timeoutMs?: number;
  scanOptions?: ScanOptions;
  isCancelled?: () => boolean;
  onProgress?: (target: ScanTarget, completed: number, total: number) => void;
}

class TimeoutError extends Error {}

function createWorker(): Worker {
  // 巨大なファイルで止まっても、VS Code 本体ではなくこのワーカーだけが落ちるようにする
  return new Worker(path.join(__dirname, 'scanWorker.js'), {
    resourceLimits: { maxOldGenerationSizeMb: 4096, stackSizeMb: 16 },
  });
}

function scanOne(worker: Worker, request: ScanRequest, timeoutMs: number): Promise<ExtensionScan> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (scan: ExtensionScan) => {
      cleanup();
      resolve(scan);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`ワーカーが終了しました（コード ${code}）`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(`${timeoutMs} ミリ秒以内に終わりませんでした`));
    }, timeoutMs);

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(request);
  });
}

/**
 * 順番に検査する。1 つが失敗しても、その拡張機能を検査不能として残りを続ける。
 * 中止された場合は、そこまでの結果を返す
 */
export async function runScan(targets: ScanTarget[], options: RunOptions = {}): Promise<ExtensionScan[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: ExtensionScan[] = [];
  let worker: Worker | undefined;

  try {
    for (const target of targets) {
      if (options.isCancelled?.()) {
        break;
      }
      options.onProgress?.(target, results.length, targets.length);
      worker ??= createWorker();
      try {
        results.push(await scanOne(worker, { target, options: options.scanOptions }, timeoutMs));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push(failedScan(target, error instanceof TimeoutError ? 'timeout' : 'worker-error', message));
        const broken = worker;
        worker = undefined;
        await broken.terminate();
      }
    }
  } finally {
    await worker?.terminate();
  }
  return results;
}
