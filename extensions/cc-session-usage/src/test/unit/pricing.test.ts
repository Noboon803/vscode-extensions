import * as assert from 'node:assert';
import { normalizeModel, type RawUsage, requestCost } from '../../pricing';

function usage(partial: Partial<RawUsage>): RawUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...partial };
}

function closeTo(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

suite('pricing', () => {
  test('日付や [1m] の付いたモデル名をそろえる', () => {
    assert.strictEqual(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.strictEqual(normalizeModel('claude-opus-5[1m]'), 'claude-opus-5');
  });

  test('入力、出力、キャッシュをそれぞれの単価で合計する', () => {
    const cost = requestCost('claude-opus-5-5', usage({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }));
    closeTo(cost, 4 + 20 + 0.2 + 8);
  });

  test('キャッシュ書き込みは保持期間で単価が変わる', () => {
    closeTo(requestCost('claude-opus-5-5', usage({ cacheWrite: 1_000_000, cacheWrite5m: 1_000_000 })), 5);
    closeTo(requestCost('claude-opus-5-5', usage({ cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })), 8);
  });

  test('Haiku 5.5 は 10 万トークンを超えるプロンプトで単価が上がる（実測値）', () => {
    const cost = requestCost('claude-haiku-5-5', usage({ input: 2, output: 4720, cacheWrite: 157488, cacheWrite1h: 157488 }));
    assert.ok(cost !== undefined && Math.abs(cost - 0.169289) < 0.0001, String(cost));
    const short = requestCost('claude-haiku-5-5', usage({ input: 1000, output: 1000 }));
    closeTo(short, 0.0006);
  });

  test('高速モードとデータ所在地の料金を反映する', () => {
    closeTo(requestCost('claude-opus-5-5', usage({ output: 1_000_000, speed: 'fast' })), 40);
    closeTo(requestCost('claude-opus-5-5', usage({ output: 1_000_000, inferenceGeo: 'us' })), 22);
    closeTo(requestCost('claude-opus-5-5', usage({ output: 1_000_000, inferenceGeo: 'global' })), 20);
  });

  test('知らないモデルは undefined を返す', () => {
    assert.strictEqual(requestCost('claude-future-9', usage({ output: 1 })), undefined);
  });
});
