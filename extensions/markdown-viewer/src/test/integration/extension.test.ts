import * as assert from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { MarkdownViewerApi } from '../../extension';

function previewTabs(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('markdownViewer.preview'))
    .map((tab) => tab.label)
    .sort();
}

/** タブの一覧は非同期で更新されるので、期待した状態になるまで待つ */
async function assertPreviewTabs(expected: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && JSON.stringify(previewTabs()) !== JSON.stringify(expected)) {
    await sleep(50);
  }
  assert.deepStrictEqual(previewTabs(), expected);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !condition()) {
    await sleep(50);
  }
  assert.ok(condition(), '条件を満たさないままタイムアウトした');
}

suite('Markdown Viewer', () => {
  let a: vscode.Uri;
  let b: vscode.Uri;
  let c: vscode.Uri;
  let d: vscode.Uri;
  let api: MarkdownViewerApi;

  suiteSetup(async () => {
    const directory = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'docs');
    await mkdir(directory, { recursive: true });
    a = vscode.Uri.file(join(directory, 'a.md'));
    b = vscode.Uri.file(join(directory, 'b.md'));
    c = vscode.Uri.file(join(directory, 'c.md'));
    d = vscode.Uri.file(join(directory, 'd.md'));
    await writeFile(a.fsPath, '# A\n\n本文\n');
    await writeFile(b.fsPath, '# B\n');
    const extension = vscode.extensions.getExtension<MarkdownViewerApi>('noboon.markdown-viewer');
    assert.ok(extension, '拡張機能が見つからない');
    api = await extension.activate();
  });

  setup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.comments.clear();
  });

  test('別のファイルのプレビューを同時に開ける', async () => {
    await vscode.commands.executeCommand('markdownViewer.open', a);
    await vscode.commands.executeCommand('markdownViewer.open', b);
    await assertPreviewTabs(['a.md', 'b.md']);
  });

  test('エディターで別のファイルへ切り替えてもプレビューは変わらない', async () => {
    await vscode.commands.executeCommand('markdownViewer.open', a);
    await assertPreviewTabs(['a.md']);
    await vscode.window.showTextDocument(b);
    await sleep(500);
    await assertPreviewTabs(['a.md']);
  });

  test('同じファイルは前面に出すだけで、もう 1 つ開くコマンドなら増える', async () => {
    await vscode.commands.executeCommand('markdownViewer.open', a);
    await vscode.commands.executeCommand('markdownViewer.open', a);
    await sleep(500);
    await assertPreviewTabs(['a.md']);
    await vscode.commands.executeCommand('markdownViewer.openToSide', a);
    await assertPreviewTabs(['a.md', 'a.md']);
  });

  test('エクスプローラーで複数選択したファイルをまとめて開ける', async () => {
    await vscode.commands.executeCommand('markdownViewer.open', a, [a, b]);
    await assertPreviewTabs(['a.md', 'b.md']);
  });

  test('コメントを箇条書きでクリップボードにコピーできる', async () => {
    await api.comments.add({ uri: a.toString(), line: 2, endLine: 3, quote: '本文', text: '直す' }, '# A\n\n本文\n');
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('markdownViewer.copyComments');
    const copied = await vscode.env.clipboard.readText();
    assert.strictEqual(copied, '- [docs/a.md:3](/docs/a.md#L3) 「本文」: 直す');
  });

  test('コピーしたリンクをプレビューから開ける', async () => {
    const preview = api.previews.open(a);
    await writeFile(b.fsPath, '# B\n');
    await preview['openLink']('/docs/b.md#L1');
    await assertPreviewTabs(['a.md', 'b.md']);
  });

  test('ワークスペースの外を指す file: のリンクも開ける', async () => {
    const preview = api.previews.open(a);
    await preview['openLink'](`${b.toString()}#L1`);
    await assertPreviewTabs(['a.md', 'b.md']);
  });

  test('エディターの選択から Markdown Viewer で開ける', async () => {
    await vscode.commands.executeCommand('vscode.openWith', a, 'markdownViewer.editor');
    const customTabs = () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'markdownViewer.editor');
    await waitUntil(() => customTabs().length === 1);
    assert.strictEqual(customTabs()[0].label, 'a.md');

    // 開いたものが同じプレビューとして扱われ、スクリプトも動く
    const preview = api.previews.open(a);
    await waitUntil(() => preview.isReady);
    await assertPreviewTabs([]);
  });

  test('本物の Webview でスクリプトが動く', async () => {
    const preview = api.previews.open(a);
    await waitUntil(() => preview.isReady);
  });

  test('エディターの未保存の編集に合わせてコメントの位置が追従する', async () => {
    const source = '# C\n\n対象の段落\n';
    await writeFile(c.fsPath, source);
    api.previews.open(c);
    const added = await api.comments.add({ uri: c.toString(), line: 2, endLine: 3, quote: '', text: 'メモ' }, source);

    const document = await vscode.workspace.openTextDocument(c);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(c, new vscode.Position(0, 0), '追加の行\n\n');
    await vscode.workspace.applyEdit(edit);
    await waitUntil(() => api.comments.get(added.id)?.line === 4);
    assert.strictEqual(api.comments.get(added.id)?.stale, false);

    await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
  });

  test('ディスク上の変更でも対象の行が消えれば stale になる', async () => {
    const source = '# D\n\n消える段落\n';
    await writeFile(d.fsPath, source);
    const preview = api.previews.open(d);
    await waitUntil(() => preview.isReady);
    const added = await api.comments.add({ uri: d.toString(), line: 2, endLine: 3, quote: '', text: 'メモ' }, source);

    await writeFile(d.fsPath, '# D\n\n書き換えた段落\n');
    await waitUntil(() => api.comments.get(added.id)?.stale === true);
  });

  test('コメントのタブを開ける', async () => {
    await vscode.commands.executeCommand('markdownViewer.comments.focus');
  });
});
