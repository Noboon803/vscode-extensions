import * as assert from 'node:assert';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SessionUsageApi } from '../../extension';

suite('CC Session Usage', () => {
  test('履歴を集計して、画面を開ける', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    assert.ok(configDir, 'テスト用の設定フォルダが指定されていません');
    const project = join(configDir, 'projects', '-work-app');
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, 'integration.jsonl'),
      [
        JSON.stringify({ type: 'user', timestamp: '2026-10-05T10:00:00.000Z', cwd: '/work/app', message: { content: '依頼' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-10-05T10:00:01.000Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [], usage: { output_tokens: 1_000_000 } } }),
      ].join('\n'),
    );

    const extension = vscode.extensions.getExtension<SessionUsageApi>('noboon.cc-session-usage');
    assert.ok(extension);
    const api = await extension.activate();
    const snapshot = await api.refresh();
    // 起動時の読み込みと重なると、書き込む前の結果が返ることがあるので読み直す
    const latest = snapshot.sessions.length > 0 ? snapshot : await api.refresh();
    assert.strictEqual(latest.error, undefined);
    assert.deepStrictEqual(latest.sessions.map((session) => session.computedCostUsd), [20]);

    // 実際の CSP のもとで Webview のスクリプトが動き、データを描画できたことを確かめる
    const rendered = new Promise<number>((resolve) => {
      const subscription = api.onDidRender((rows) => {
        if (rows > 0) {
          subscription.dispose();
          resolve(rows);
        }
      });
    });
    await vscode.commands.executeCommand('ccSessionUsage.open');
    assert.ok((await rendered) > 0);
    // タブの一覧は非同期で更新されるので、開くまで待つ
    const hasTab = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.label === 'CC Session Usage');
    const deadline = Date.now() + 5000;
    while (!hasTab() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(hasTab());
  });

  test('サイドバーの表示中は、履歴への追記を自動で反映する', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    assert.ok(configDir);
    const file = join(configDir, 'projects', '-work-app', 'live.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', timestamp: '2026-10-06T10:00:00.000Z', cwd: '/work/app', entrypoint: 'cli', message: { content: '最初の発言' } })}\n`);

    const extension = vscode.extensions.getExtension<SessionUsageApi>('noboon.cc-session-usage');
    assert.ok(extension);
    const api = await extension.activate();
    await vscode.commands.executeCommand('ccSessionUsage.currentSession.focus');
    await api.refresh();
    assert.deepStrictEqual(api.currentTurnLabels(), ['1. 最初の発言']);

    // 監視が始まるのを待ってから追記する
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await appendFile(file, `${JSON.stringify({ type: 'user', timestamp: '2026-10-06T10:01:00.000Z', message: { content: '次の発言' } })}\n`);

    const deadline = Date.now() + 15000;
    while (api.currentTurnLabels().length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 新しいターンが上に来る
    assert.deepStrictEqual(api.currentTurnLabels(), ['2. 次の発言', '1. 最初の発言']);
  });
});
