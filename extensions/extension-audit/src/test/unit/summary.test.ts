import * as assert from 'node:assert';
import type { AuditRecord } from '../../scanner/snapshot';
import { compareRecords, countRulesByLevel, describeRecord, hasNotableAdditions, highestLevel } from '../../scanner/summary';
import type { ExtensionScan, Finding, RuleId } from '../../scanner/types';

function finding(rule: RuleId, file = 'a.js'): Finding {
  return { rule, detail: '', file, count: 1, locations: [] };
}

function record(name: string, findings: Finding[], overrides: Partial<ExtensionScan> = {}, added: Finding[] = []): AuditRecord {
  return {
    scannedAt: 'x',
    added,
    scan: {
      dirName: name,
      id: name,
      version: '1.0.0',
      displayName: name,
      status: 'complete',
      findings,
      uninspected: [],
      filesScanned: 1,
      bytesScanned: 1,
      ...overrides,
    },
  };
}

suite('summary', () => {
  test('同じルールの大量の検出は 1 種類として数える', () => {
    const findings = [finding('executable-file', 'a.dll'), finding('executable-file', 'b.dll'), finding('network')];
    assert.deepStrictEqual(countRulesByLevel(findings), { high: 0, review: 1, info: 1 });
    assert.strictEqual(highestLevel(findings), 'review');
    assert.strictEqual(highestLevel([]), undefined);
  });

  test('何も検出しなくても「安全」とは表示しない', () => {
    const description = describeRecord(record('a', []));
    assert.strictEqual(description, 'v1.0.0 · 検出なし');
    assert.ok(!description.includes('安全'));
  });

  test('検査できなかったものを「検出なし」と表示しない', () => {
    const failed = record('a', [], { status: 'failed', uninspected: [{ file: '', reason: 'timeout' }] });
    assert.strictEqual(describeRecord(failed), 'v1.0.0 · 検査不能');
    const partial = record('b', [], { status: 'partial', uninspected: [{ file: 'x.js', reason: 'parse-error' }] });
    assert.strictEqual(describeRecord(partial), 'v1.0.0 · 検査不能 1');
  });

  test('要約にレベルごとの種類数と増加件数を出す', () => {
    const value = record('a', [finding('hidden-module'), finding('process-exec'), finding('url')], {}, [finding('url')]);
    assert.strictEqual(describeRecord(value), 'v1.0.0 · 優先確認 1 · 要確認 1 · 参考 1 · 増加 1');
  });

  test('参考の項目だけが増えても通知の対象にしない', () => {
    assert.strictEqual(hasNotableAdditions(record('a', [], {}, [finding('url')])), false);
    assert.strictEqual(hasNotableAdditions(record('a', [], {}, [finding('process-exec')])), true);
  });

  test('検査不能、更新による増加、優先確認、要確認、検出なしの順に並べる', () => {
    const none = record('none', []);
    const review = record('review', [finding('process-exec')]);
    const high = record('high', [finding('hidden-module')]);
    const added = record('added', [finding('process-exec')], {}, [finding('process-exec')]);
    const failed = record('failed', [], { status: 'failed' });
    const sorted = [none, review, high, added, failed].sort(compareRecords).map((item) => item.scan.dirName);
    assert.deepStrictEqual(sorted, ['failed', 'added', 'high', 'review', 'none']);
  });
});
