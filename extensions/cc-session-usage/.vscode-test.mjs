import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  launchArgs: ['--user-data-dir', mkdtempSync(join(tmpdir(), 'su-'))],
  // 実際のセッション履歴を読まないよう、空のフォルダを指定する
  env: { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'su-claude-')) },
  mocha: { ui: 'tdd', timeout: 20000 },
});
