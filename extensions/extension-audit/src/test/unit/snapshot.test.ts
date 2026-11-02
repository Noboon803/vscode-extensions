import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RULESET_VERSION } from '../../scanner/rules';
import { emptySnapshot, mergeSnapshot, type Snapshot } from '../../scanner/snapshot';
import type { ExtensionScan, Finding, RuleId } from '../../scanner/types';
import { SnapshotStore } from '../../snapshotStore';

function finding(rule: RuleId, detail: string, file = 'dist/main.js'): Finding {
  return { rule, detail, file, count: 1, locations: [{ line: 1, column: 0 }] };
}

function scan(dirName: string, version: string, findings: Finding[], status: ExtensionScan['status'] = 'complete'): ExtensionScan {
  return {
    dirName,
    id: 'fake.sample',
    version,
    displayName: 'Sample',
    status,
    findings,
    uninspected: [],
    filesScanned: 1,
    bytesScanned: 1,
  };
}

const V1 = 'fake.sample-1.0.0';
const V2 = 'fake.sample-2.0.0';

function snapshotOf(...scans: ExtensionScan[]): Snapshot {
  return mergeSnapshot(
    emptySnapshot(),
    scans,
    scans.map((item) => item.dirName),
    '2026-11-01T00:00:00.000Z',
  );
}

suite('mergeSnapshot', () => {
  test('初回は比較対象がないので増加なし', () => {
    const { records } = snapshotOf(scan(V1, '1.0.0', [finding('process-exec', 'child_process')]));
    assert.deepStrictEqual(records[V1].added, []);
    assert.strictEqual(records[V1].previousVersion, undefined);
  });

  test('更新で増えた項目だけを出し、以前のバージョンは消す', () => {
    const before = snapshotOf(scan(V1, '1.0.0', [finding('url', 'old.example.test'), finding('network', 'https')]));
    const after = mergeSnapshot(
      before,
      [scan(V2, '2.0.0', [finding('network', 'https'), finding('process-exec', 'child_process'), finding('url', 'new.example.test')])],
      [V2],
      '2026-11-02T00:00:00.000Z',
    );
    assert.deepStrictEqual(Object.keys(after.records), [V2]);
    assert.strictEqual(after.records[V2].previousVersion, '1.0.0');
    assert.deepStrictEqual(
      after.records[V2].added.map((item) => item.detail),
      ['child_process', 'new.example.test'],
    );
  });

  test('減っただけなら増加なし', () => {
    const before = snapshotOf(scan(V1, '1.0.0', [finding('network', 'https'), finding('url', 'old.example.test')]));
    const after = mergeSnapshot(before, [scan(V2, '2.0.0', [finding('network', 'https')])], [V2], '2026-11-02T00:00:00.000Z');
    assert.deepStrictEqual(after.records[V2].added, []);
  });

  test('ビルドごとに変わるファイル名のハッシュは差分にしない', () => {
    const before = snapshotOf(scan(V1, '1.0.0', [finding('network', 'https', 'dist/chunk-1a2b3c4d5e.js')]));
    const after = mergeSnapshot(before, [scan(V2, '2.0.0', [finding('network', 'https', 'dist/chunk-9f8e7d6c5b.js')])], [V2], 'x');
    assert.deepStrictEqual(after.records[V2].added, []);
  });

  test('別のファイルで増えたものは差分にする', () => {
    const before = snapshotOf(scan(V1, '1.0.0', [finding('process-exec', 'child_process', 'dist/a.js')]));
    const after = mergeSnapshot(
      before,
      [
        scan(V2, '2.0.0', [
          finding('process-exec', 'child_process', 'dist/a.js'),
          finding('process-exec', 'child_process', 'node_modules/new-dep/index.js'),
        ]),
      ],
      [V2],
      'x',
    );
    assert.deepStrictEqual(
      after.records[V2].added.map((item) => item.file),
      ['node_modules/new-dep/index.js'],
    );
  });

  test('同じバージョンを再検査しても、更新時の差分を残す', () => {
    const before = snapshotOf(scan(V1, '1.0.0', []));
    const updated = mergeSnapshot(before, [scan(V2, '2.0.0', [finding('process-exec', 'child_process')])], [V2], 'a');
    const rescanned = mergeSnapshot(updated, [scan(V2, '2.0.0', [finding('process-exec', 'child_process')])], [V2], 'b');
    assert.strictEqual(rescanned.records[V2].previousVersion, '1.0.0');
    assert.deepStrictEqual(
      rescanned.records[V2].added.map((item) => item.detail),
      ['child_process'],
    );
  });

  test('前回の検査が失敗していれば比較しない', () => {
    const before = snapshotOf(scan(V1, '1.0.0', [], 'failed'));
    const after = mergeSnapshot(before, [scan(V2, '2.0.0', [finding('network', 'https')])], [V2], 'x');
    assert.deepStrictEqual(after.records[V2].added, []);
  });

  test('ルールのバージョンが違う結果とは比較しない', () => {
    const before = { ...snapshotOf(scan(V1, '1.0.0', [])), rulesetVersion: RULESET_VERSION - 1 };
    const after = mergeSnapshot(before, [scan(V2, '2.0.0', [finding('network', 'https')])], [V2], 'x');
    assert.deepStrictEqual(after.records[V2].added, []);
    assert.strictEqual(after.rulesetVersion, RULESET_VERSION);
  });

  test('除外した拡張機能は結果から消え、除外の一覧に残る', () => {
    const excluded = [{ dirName: V1, id: 'fake.sample', reason: 'publisher' as const }];
    const after = mergeSnapshot(snapshotOf(scan(V1, '1.0.0', [])), [], [], 'x', excluded);
    assert.deepStrictEqual(after.records, {});
    assert.deepStrictEqual(after.excluded, excluded);
  });

  test('検査していない拡張機能の結果を引き継ぎ、削除されたものは消す', () => {
    const other = { ...scan('fake.other-1.0.0', '1.0.0', []), id: 'fake.other' };
    const removed = { ...scan('fake.removed-1.0.0', '1.0.0', []), id: 'fake.removed' };
    const before = snapshotOf(other, removed);
    const after = mergeSnapshot(before, [], ['fake.other-1.0.0'], 'x');
    assert.deepStrictEqual(Object.keys(after.records), ['fake.other-1.0.0']);
  });
});

suite('SnapshotStore', () => {
  let root: string;
  let file: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-audit-test-'));
    file = path.join(root, 'nested', 'snapshot.json');
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('ファイルがなければ空で、エラーにしない', async () => {
    const { snapshot, error } = await new SnapshotStore(file).load();
    assert.deepStrictEqual(snapshot.records, {});
    assert.strictEqual(error, undefined);
  });

  test('保存した内容を読み込める', async () => {
    const store = new SnapshotStore(file);
    const snapshot = snapshotOf(scan(V1, '1.0.0', [finding('network', 'https')]));
    await store.save(snapshot);
    assert.deepStrictEqual((await store.load()).snapshot, snapshot);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['snapshot.json']);
  });

  test('壊れたファイルはエラーを返し、例外にしない', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ broken');
    const { snapshot, error } = await new SnapshotStore(file).load();
    assert.ok(error);
    assert.deepStrictEqual(snapshot.records, {});
  });

  test('形式の違うファイルはエラーを返す', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"records": 1}');
    assert.ok((await new SnapshotStore(file).load()).error);
  });
});
