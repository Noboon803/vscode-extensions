import * as assert from 'node:assert';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from '../../types';
import { UsageStore } from '../../usageStore';

function summary(computedCostUsd: number, recordedCostUsd?: number): SessionSummary {
  return { id: 's', projectDir: 'p', startedAt: 1, endedAt: 1, turns: [], daily: [], computedCostUsd, recordedCostUsd, unpricedRequests: 0, unreadableLines: 0 };
}

suite('UsageStore', () => {
  let dir: string;
  let file: string;

  setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'su-store-'));
    file = join(dir, 'nested', 'usage.json');
  });

  teardown(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('保存した内容を読み直せる', async () => {
    const store = new UsageStore(file, 1);
    store.apply({ changed: [{ key: 'p/s', fingerprint: 'f', summary: summary(1) }], presentKeys: ['p/s'], failures: [] });
    await store.save();
    const loaded = new UsageStore(file, 1);
    await loaded.load();
    assert.deepStrictEqual(loaded.knownFingerprints(), { 'p/s': 'f' });
    assert.strictEqual(loaded.summaries()[0].computedCostUsd, 1);
  });

  test('元のファイルが消えても集計を残す', () => {
    const store = new UsageStore(file, 1);
    store.apply({ changed: [{ key: 'p/s', fingerprint: 'f', summary: summary(1) }], presentKeys: ['p/s'], failures: [] });
    store.apply({ changed: [], presentKeys: [], failures: [] });
    assert.strictEqual(store.summaries().length, 1);
    assert.strictEqual(store.summaries()[0].transcriptRemoved, true);
    store.apply({ changed: [], presentKeys: ['p/s'], failures: [] });
    assert.strictEqual(store.summaries()[0].transcriptRemoved, undefined);
  });

  test('本文が減った履歴で集計を上書きしない', () => {
    const store = new UsageStore(file, 1);
    store.apply({ changed: [{ key: 'p/s', fingerprint: 'a', summary: summary(10) }], presentKeys: ['p/s'], failures: [] });
    store.apply({ changed: [{ key: 'p/s', fingerprint: 'b', summary: summary(0, 12) }], presentKeys: ['p/s'], failures: [] });
    const [kept] = store.summaries();
    assert.strictEqual(kept.computedCostUsd, 10);
    assert.strictEqual(kept.recordedCostUsd, 12);
    assert.deepStrictEqual(store.knownFingerprints(), { 'p/s': 'b' });
  });

  test('集計方法が変わったら、金額が下がっても新しい値で上書きする', async () => {
    const old = new UsageStore(file, 1);
    old.apply({ changed: [{ key: 'p/s', fingerprint: 'f', summary: summary(10) }], presentKeys: ['p/s'], failures: [] });
    await old.save();
    const store = new UsageStore(file, 2);
    await store.load();
    assert.deepStrictEqual(store.knownFingerprints(), {});
    store.apply({ changed: [{ key: 'p/s', fingerprint: 'f', summary: summary(5) }], presentKeys: ['p/s'], failures: [] });
    assert.strictEqual(store.summaries()[0].computedCostUsd, 5);
  });

  test('壊れたファイルは消さずに退避する', async () => {
    const target = join(dir, 'usage.json');
    await writeFile(target, '{ broken');
    const store = new UsageStore(target, 1);
    await store.load();
    assert.deepStrictEqual(store.summaries(), []);
    const names = await readdir(dir);
    const corrupt = names.find((name) => name.startsWith('usage.json.corrupt-'));
    assert.ok(corrupt);
    assert.strictEqual(await readFile(join(dir, corrupt), 'utf8'), '{ broken');
  });
});
