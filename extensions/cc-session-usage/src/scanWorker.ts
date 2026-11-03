import { parentPort } from 'node:worker_threads';
import { scanSessions } from './sessionScanner';

/** 履歴は数十 MB になることがあるので、VS Code を止めないよう別スレッドで読む */

export interface ScanRequest {
  configDir: string;
  known: Record<string, string>;
}

if (!parentPort) {
  throw new Error('ワーカースレッドとして起動してください');
}

const port = parentPort;
port.on('message', ({ configDir, known }: ScanRequest) => {
  scanSessions(configDir, known).then(
    (result) => port.postMessage({ result }),
    (error: unknown) => port.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
});
