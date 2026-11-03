import { parentPort } from 'node:worker_threads';
import { scanExtension } from './scanner/scanExtension';
import type { ScanOptions, ScanTarget } from './scanner/types';

/** 構文解析は同期処理なので、他の拡張機能を止めないよう別スレッドで動かす */

export interface ScanRequest {
  target: ScanTarget;
  options?: ScanOptions;
}

if (!parentPort) {
  throw new Error('ワーカースレッドとして起動してください');
}

const port = parentPort;
port.on('message', ({ target, options }: ScanRequest) => {
  port.postMessage(scanExtension(target, options));
});
