import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // 前回の検査結果が残っていると、起動時に実際の拡張機能を検査してテストと競合する
  launchArgs: ['--user-data-dir', mkdtempSync(join(tmpdir(), 'ea-'))],
  mocha: { ui: 'tdd', timeout: 20000 },
});
