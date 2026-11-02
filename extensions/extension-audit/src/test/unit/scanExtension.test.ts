import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverExtensions, failedScan } from '../../scanner/discover';
import { scanExtension } from '../../scanner/scanExtension';
import { runScan } from '../../scanRunner';
import type { RuleId } from '../../scanner/types';

const MANIFEST = JSON.stringify({ publisher: 'Fake', name: 'sample', version: '1.0.0', displayName: 'Sample' });

/** インストールしない架空の拡張機能を一時フォルダに作る。ファイルは読むだけで実行しない */
function createFolder(root: string, name: string, files: Record<string, string | Buffer>): string {
  const directory = path.join(root, name);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(directory, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return directory;
}

suite('scanExtension', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-audit-test-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function scan(files: Record<string, string | Buffer>, maxFileBytes = 1024 * 1024) {
    const directory = createFolder(root, 'fake.sample-1.0.0', files);
    return scanExtension({ dirName: 'fake.sample-1.0.0', path: directory }, { maxFileBytes });
  }

  function rulesOf(result: ReturnType<typeof scan>): RuleId[] {
    return result.findings.map((finding) => finding.rule).sort();
  }

  test('識別情報を読み取り、node_modules の中も検査する', () => {
    const result = scan({
      'package.json': MANIFEST,
      'node_modules/dep/index.js': "require('child_process');",
    });
    assert.strictEqual(result.id, 'fake.sample');
    assert.strictEqual(result.version, '1.0.0');
    assert.strictEqual(result.displayName, 'Sample');
    assert.strictEqual(result.status, 'complete');
    assert.strictEqual(result.filesScanned, 1);
    assert.strictEqual(result.findings[0].file, 'node_modules/dep/index.js');
  });

  test('翻訳ファイルを参照する表示名は使わず、拡張機能 ID を表示する', () => {
    const result = scan({ 'package.json': JSON.stringify({ publisher: 'fake', name: 'sample', displayName: '%displayName%' }) });
    assert.strictEqual(result.displayName, 'fake.sample');
  });

  test('package.json の起動条件、アンインストール処理、同梱の拡張機能を検出する', () => {
    const result = scan({
      'package.json': JSON.stringify({
        publisher: 'fake',
        name: 'sample',
        version: '1.0.0',
        activationEvents: ['*', 'onStartupFinished', 'onLanguage:python'],
        scripts: { 'vscode:uninstall': 'node ./cleanup.js', postinstall: 'node ./setup.js', build: 'tsc' },
        extensionPack: ['fake.other'],
        extensionDependencies: ['fake.base'],
      }),
    });
    assert.deepStrictEqual(rulesOf(result), [
      'activation-all',
      'activation-startup',
      'bundled-extension',
      'bundled-extension',
      'package-script',
      'uninstall-script',
    ]);
  });

  test('実行ファイルは拡張子と先頭のバイトで検出し、普通のファイルは無視する', () => {
    const result = scan({
      'package.json': MANIFEST,
      'bin/native.node': Buffer.from([0]),
      'bin/run.sh': 'echo hello\n',
      'bin/server': Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]),
      'bin/script': '#!/bin/sh\n',
      LICENSE: 'MIT\n',
      'README.md': '# readme\n',
    });
    const details = result.findings.map((finding) => `${finding.file}=${finding.detail}`).sort();
    assert.deepStrictEqual(details, [
      'bin/native.node=.node',
      'bin/run.sh=.sh',
      'bin/script=シェバン付きスクリプト',
      'bin/server=バイナリ',
    ]);
  });

  test('壊れた package.json は検査不能で、コードは検査を続ける', () => {
    const result = scan({ 'package.json': '{ broken', 'main.js': 'eval("1");' });
    assert.strictEqual(result.status, 'partial');
    assert.strictEqual(result.uninspected[0].reason, 'manifest-error');
    assert.deepStrictEqual(rulesOf(result), ['dynamic-code']);
    assert.strictEqual(result.id, 'fake.sample');
  });

  test('package.json がなくコードもなければ検査失敗にする', () => {
    const result = scan({ 'README.md': '# readme' });
    assert.strictEqual(result.status, 'failed');
  });

  test('構文エラーのファイルは検査不能になる', () => {
    const result = scan({ 'package.json': MANIFEST, 'main.js': 'function ( {' });
    assert.strictEqual(result.status, 'partial');
    assert.strictEqual(result.uninspected[0].reason, 'parse-error');
    assert.strictEqual(result.uninspected[0].file, 'main.js');
  });

  test('上限を超えるファイルは読まずに検査不能にする', () => {
    const result = scan({ 'package.json': MANIFEST, 'big.js': `eval('1');${' '.repeat(2048)}` }, 1024);
    assert.strictEqual(result.status, 'partial');
    assert.strictEqual(result.uninspected[0].reason, 'too-large');
    assert.deepStrictEqual(result.findings, []);
    assert.strictEqual(result.filesScanned, 0);
  });

  test('シンボリックリンクは辿らず、検査不能にする', () => {
    const outside = createFolder(root, 'outside', { 'secret.js': 'eval("1");' });
    const directory = createFolder(root, 'fake.sample-1.0.0', { 'package.json': MANIFEST });
    fs.symlinkSync(outside, path.join(directory, 'linked'));
    const result = scanExtension({ dirName: 'fake.sample-1.0.0', path: directory });
    assert.strictEqual(result.status, 'partial');
    assert.deepStrictEqual(result.uninspected, [{ file: 'linked', reason: 'symlink' }]);
    assert.deepStrictEqual(result.findings, []);
  });

  test('検査対象のファイルを書き換えない', () => {
    const directory = createFolder(root, 'fake.sample-1.0.0', { 'package.json': MANIFEST, 'main.js': 'eval("1");' });
    const before = fs.readdirSync(directory).sort();
    scanExtension({ dirName: 'fake.sample-1.0.0', path: directory });
    assert.deepStrictEqual(fs.readdirSync(directory).sort(), before);
    assert.strictEqual(fs.readFileSync(path.join(directory, 'main.js'), 'utf8'), 'eval("1");');
  });

  test('検査対象のコードを実行しない', () => {
    const marker = path.join(root, 'executed');
    const code = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`;
    const directory = createFolder(root, 'fake.sample-1.0.0', { 'package.json': MANIFEST, 'main.js': code });
    scanExtension({ dirName: 'fake.sample-1.0.0', path: directory });
    assert.strictEqual(fs.existsSync(marker), false);
  });

  test('隠しファイルと .obsolete に記録されたフォルダを除いて列挙する', () => {
    createFolder(root, 'a.one-1.0.0', { 'package.json': MANIFEST });
    createFolder(root, 'b.two-1.0.0', { 'package.json': MANIFEST });
    createFolder(root, '.hidden', { 'package.json': MANIFEST });
    fs.writeFileSync(path.join(root, 'extensions.json'), '[]');
    fs.writeFileSync(path.join(root, '.obsolete'), JSON.stringify({ 'b.two-1.0.0': true }));
    assert.deepStrictEqual(
      discoverExtensions(root).map((target) => target.dirName),
      ['a.one-1.0.0'],
    );
  });

  test('失敗の結果はフォルダ名からバージョンを推定する', () => {
    const result = failedScan({ dirName: 'Fake.sample-1.2.3-darwin-arm64', path: '/x' }, 'timeout', 'm');
    assert.strictEqual(result.id, 'fake.sample');
    assert.strictEqual(result.version, '1.2.3-darwin-arm64');
    assert.strictEqual(result.status, 'failed');
  });
});

suite('runScan', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-audit-test-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('ワーカーで順番に検査し、進捗を報告する', async () => {
    const first = createFolder(root, 'a.one-1.0.0', { 'package.json': MANIFEST, 'a.js': 'eval("1");' });
    const second = createFolder(root, 'b.two-1.0.0', { 'package.json': MANIFEST });
    const progress: string[] = [];
    const results = await runScan(
      [
        { dirName: 'a.one-1.0.0', path: first },
        { dirName: 'b.two-1.0.0', path: second },
      ],
      { onProgress: (target, completed, total) => progress.push(`${target.dirName}:${completed}/${total}`) },
    );
    assert.deepStrictEqual(
      results.map((result) => result.status),
      ['complete', 'complete'],
    );
    assert.strictEqual(results[0].findings[0].rule, 'dynamic-code');
    assert.deepStrictEqual(progress, ['a.one-1.0.0:0/2', 'b.two-1.0.0:1/2']);
  });

  test('時間切れの拡張機能を検査不能にして、残りを続ける', async () => {
    const directory = createFolder(root, 'a.one-1.0.0', { 'package.json': MANIFEST });
    const targets = [
      { dirName: 'a.one-1.0.0', path: directory },
      { dirName: 'b.two-1.0.0', path: directory },
    ];
    const results = await runScan(targets, { timeoutMs: 0 });
    assert.deepStrictEqual(
      results.map((result) => [result.status, result.uninspected[0]?.reason]),
      [
        ['failed', 'timeout'],
        ['failed', 'timeout'],
      ],
    );
  });

  test('中止すると、そこまでの結果を返す', async () => {
    const directory = createFolder(root, 'a.one-1.0.0', { 'package.json': MANIFEST });
    let checks = 0;
    const results = await runScan(
      [
        { dirName: 'a.one-1.0.0', path: directory },
        { dirName: 'b.two-1.0.0', path: directory },
      ],
      { isCancelled: () => checks++ > 0 },
    );
    assert.strictEqual(results.length, 1);
  });
});
