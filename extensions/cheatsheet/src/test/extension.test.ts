import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Cheatsheet', () => {
  test('表示コマンドでチートシートを開ける', async () => {
    const extension = vscode.extensions.getExtension('noboon.cheatsheet');
    assert.ok(extension, '拡張機能が見つからない');

    await vscode.commands.executeCommand('cheatsheet.show');

    assert.strictEqual(extension.isActive, true);
  });

  test('切り替えコマンドを繰り返し実行できる', async () => {
    await vscode.commands.executeCommand('cheatsheet.show');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await vscode.commands.executeCommand('cheatsheet.toggle');
    await vscode.commands.executeCommand('cheatsheet.toggle');
  });
});
