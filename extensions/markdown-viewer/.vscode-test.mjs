import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // コピーするリンクはワークスペースからのパスになるので、ワークスペースを開いて試す
  workspaceFolder: mkdtempSync(join(tmpdir(), 'mv-workspace-')),
  // 前回のコメントやプレビューの復元がテストと競合しないよう、毎回新しい環境で起動する
  launchArgs: ['--user-data-dir', mkdtempSync(join(tmpdir(), 'mv-'))],
  mocha: { ui: 'tdd', timeout: 20000 },
});
