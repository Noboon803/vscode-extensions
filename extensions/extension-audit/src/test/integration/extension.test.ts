import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionAuditApi } from '../../extension';

const SETTING = 'extensionsPath';

async function configure(name: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('extensionAudit').update(name, value, vscode.ConfigurationTarget.Global);
}

/** 設定の変更で始まる再検査は完了を待てないので、結果が変わるまで確認する */
async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `時間内に変わらなかった: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** インストールしない架空の拡張機能を一時フォルダに作る。読むだけで実行しない */
function createFakeExtension(root: string, version: string, code: string): string {
  const dirName = `fake.sample-${version}`;
  const directory = path.join(root, dirName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ publisher: 'fake', name: 'sample', version, displayName: 'Fake Sample' }),
  );
  fs.writeFileSync(path.join(directory, 'main.js'), code);
  return dirName;
}

suite('Extension Audit', () => {
  let root: string;
  let api: ExtensionAuditApi;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<ExtensionAuditApi>('noboon.extension-audit');
    assert.ok(extension, '拡張機能が見つからない');
    api = await extension.activate();
  });

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-audit-it-'));
    await vscode.workspace.getConfiguration('extensionAudit').update(SETTING, root, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    await vscode.workspace.getConfiguration('extensionAudit').update(SETTING, undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('結果のビューを開ける', async () => {
    await vscode.commands.executeCommand('extensionAudit.results.focus');
  });

  test('検査して、更新で増えた項目を記録する', async () => {
    const v1 = createFakeExtension(root, '1.0.0', "require('https');");
    await vscode.commands.executeCommand('extensionAudit.scan');

    const first = api.getSnapshot().records[v1];
    assert.ok(first, '検査結果がない');
    assert.strictEqual(first.scan.status, 'complete');
    assert.deepStrictEqual(first.added, []);

    fs.rmSync(path.join(root, v1), { recursive: true });
    const v2 = createFakeExtension(root, '2.0.0', "require('https'); require('child_process');");
    await vscode.commands.executeCommand('extensionAudit.scan');

    const { records } = api.getSnapshot();
    assert.deepStrictEqual(Object.keys(records), [v2]);
    assert.strictEqual(records[v2].previousVersion, '1.0.0');
    assert.deepStrictEqual(
      records[v2].added.map((finding) => finding.rule),
      ['process-exec'],
    );
  });

  test('信頼する開発元の除外と解除が、結果に反映される', async () => {
    const dirName = createFakeExtension(root, '1.0.0', "require('https');");
    fs.writeFileSync(
      path.join(root, 'extensions.json'),
      JSON.stringify([{ identifier: { id: 'fake.sample' }, relativeLocation: dirName, metadata: { source: 'gallery' } }]),
    );
    await vscode.commands.executeCommand('extensionAudit.scan');
    assert.ok(api.getSnapshot().records[dirName]);

    try {
      await configure('trustedPublishers', ['fake']);
      await waitFor(() => !api.getSnapshot().records[dirName], '除外されること');
      assert.deepStrictEqual(api.getSnapshot().records, {});
      assert.deepStrictEqual(api.getSnapshot().excluded, [{ dirName, id: 'fake.sample', reason: 'publisher' }]);
    } finally {
      await configure('trustedPublishers', undefined);
    }

    await waitFor(() => Boolean(api.getSnapshot().records[dirName]), '除外の解除で再検査されること');
    assert.deepStrictEqual(api.getSnapshot().excluded, []);
  });

  test('除外の設定はユーザー設定でのみ変更でき、ワークスペースでは指定できない', () => {
    const properties = vscode.extensions.getExtension('noboon.extension-audit')?.packageJSON.contributes.configuration.properties;
    assert.strictEqual(properties['extensionAudit.trustedPublishers'].scope, 'application');
    assert.strictEqual(properties['extensionAudit.excludedExtensions'].scope, 'application');
  });

  test('検出箇所をエディターで開ける', async () => {
    const dirName = createFakeExtension(root, '1.0.0', "\neval('1');");
    await vscode.commands.executeCommand('extensionAudit.scan');
    const [finding] = api.getSnapshot().records[dirName].scan.findings;

    await vscode.commands.executeCommand('extensionAudit.openFinding', dirName, finding);

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor?.document.uri.fsPath.endsWith(path.join(dirName, 'main.js')));
    assert.strictEqual(editor?.selection.active.line, 1);
  });

  test('拡張機能のフォルダの外は開かない', async () => {
    const dirName = createFakeExtension(root, '1.0.0', '');
    const outside = path.join(root, 'outside.js');
    fs.writeFileSync(outside, '');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await vscode.commands.executeCommand('extensionAudit.openFinding', dirName, {
      rule: 'process-exec',
      detail: '',
      file: '../outside.js',
      count: 1,
      locations: [],
    });

    assert.strictEqual(vscode.window.activeTextEditor, undefined);
  });
});
