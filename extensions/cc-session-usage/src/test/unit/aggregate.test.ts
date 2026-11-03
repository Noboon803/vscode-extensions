import * as assert from 'node:assert';
import { aggregate, pickCurrentSession, projectLabel, sessionCost, sumTurns, totalTokens, unallocatedCost } from '../../aggregate';
import { addDays, localDay } from '../../dates';
import type { SessionSummary } from '../../types';

const TODAY = '2026-11-03';
const at = (date: string) => new Date(`${date}T12:00:00`).getTime();
const TOKENS = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

function session(partial: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's',
    projectDir: 'p',
    startedAt: at(TODAY),
    endedAt: at(TODAY),
    turns: [],
    daily: [],
    computedCostUsd: 0,
    unpricedRequests: 0,
    unreadableLines: 0,
    ...partial,
  };
}

function turn(date: string, linesAdded = 0) {
  return { startedAt: at(date), prompt: 'x', requests: 1, tools: 0, tokens: TOKENS, contextTokens: 0, costUsd: 1, subagentCostUsd: 0, linesAdded, linesRemoved: 0, filesChanged: 0 };
}

suite('aggregate', () => {
  test('累計が計算値より多ければ差を未割当にする', () => {
    const s = session({ computedCostUsd: 9, recordedCostUsd: 10 });
    assert.strictEqual(sessionCost(s), 10);
    assert.strictEqual(unallocatedCost(s), 1);
  });

  test('計算値のほうが多ければ計算値を使う', () => {
    const s = session({ computedCostUsd: 9, recordedCostUsd: 5 });
    assert.strictEqual(sessionCost(s), 9);
    assert.strictEqual(unallocatedCost(s), 0);
  });

  test('期間の境界を含めて絞り込む', () => {
    const totals = aggregate(
      [
        session({
          daily: [
            { date: '2026-10-28', model: 'm', requests: 1, tokens: TOKENS, costUsd: 1 },
            { date: '2026-10-27', model: 'm', requests: 1, tokens: TOKENS, costUsd: 100 },
          ],
          turns: [turn('2026-10-28', 5), turn('2026-10-27', 50)],
        }),
      ],
      { days: 7, project: null, today: TODAY },
    );
    assert.strictEqual(totals.costUsd, 1);
    assert.strictEqual(totals.turns, 1);
    assert.strictEqual(totals.linesAdded, 5);
    assert.strictEqual(totals.days.length, 7);
    assert.strictEqual(totals.days[0].date, '2026-10-28');
  });

  test('活動のない日も日別の一覧に含める', () => {
    const totals = aggregate([session({ daily: [{ date: '2026-11-01', model: 'm', requests: 1, tokens: TOKENS, costUsd: 2 }] })], {
      days: null,
      project: null,
      today: TODAY,
    });
    assert.deepStrictEqual(totals.days.map((day) => day.costUsd), [2, 0, 0]);
  });

  test('本文のないセッションの累計を最後の活動日に計上する', () => {
    const totals = aggregate([session({ recordedCostUsd: 93.7, endedAt: at('2026-11-02'), startedAt: at('2026-11-02') })], {
      days: 7,
      project: null,
      today: TODAY,
    });
    assert.strictEqual(totals.costUsd, 93.7);
    assert.strictEqual(totals.unallocatedUsd, 93.7);
    assert.strictEqual(totals.days.find((day) => day.date === '2026-11-02')?.costUsd, 93.7);
    assert.strictEqual(totals.rows.length, 1);
  });

  test('モデルとプロジェクトをコストの降順にまとめる', () => {
    const totals = aggregate(
      [
        session({ id: 'a', projectDir: 'p1', cwd: '/x/one', daily: [{ date: TODAY, model: 'cheap', requests: 1, tokens: TOKENS, costUsd: 1 }] }),
        session({ id: 'b', projectDir: 'p2', cwd: '/x/two', daily: [{ date: TODAY, model: 'big', requests: 1, tokens: TOKENS, costUsd: 5 }] }),
        session({ id: 'c', projectDir: 'p1', cwd: '/x/one', daily: [{ date: TODAY, model: 'cheap', requests: 2, tokens: TOKENS, costUsd: 1 }] }),
      ],
      { days: 7, project: null, today: TODAY },
    );
    assert.deepStrictEqual(totals.models.map((model) => [model.model, model.requests]), [['big', 1], ['cheap', 3]]);
    assert.deepStrictEqual(totals.projects.map((project) => [project.label, project.sessions]), [['two', 1], ['one', 2]]);
    assert.strictEqual(totals.tokens.output, 6);
  });

  test('プロジェクトで絞り込む', () => {
    const totals = aggregate(
      [
        session({ id: 'a', projectDir: 'p1', daily: [{ date: TODAY, model: 'm', requests: 1, tokens: TOKENS, costUsd: 1 }] }),
        session({ id: 'b', projectDir: 'p2', daily: [{ date: TODAY, model: 'm', requests: 1, tokens: TOKENS, costUsd: 5 }] }),
      ],
      { days: null, project: 'p2', today: TODAY },
    );
    assert.strictEqual(totals.costUsd, 5);
  });

  test('費用もターンもないセッションは一覧に出さない', () => {
    assert.strictEqual(aggregate([session({})], { days: null, project: null, today: TODAY }).rows.length, 0);
  });

  test('作業フォルダの名前をプロジェクト名にする', () => {
    assert.strictEqual(projectLabel(session({ cwd: '/Users/a/Projects/app/' })), 'app');
    assert.strictEqual(projectLabel(session({ projectDir: '-Users-a-app' })), '-Users-a-app');
  });

  test('ターンのトークンとコストを合計する', () => {
    const totals = sumTurns([turn(TODAY, 2), turn(TODAY, 3)]);
    assert.deepStrictEqual(totals.tokens, { input: 2, output: 4, cacheRead: 6, cacheWrite: 8 });
    assert.strictEqual(totals.costUsd, 2);
    assert.strictEqual(totals.requests, 2);
    assert.strictEqual(totals.linesAdded, 5);
    assert.strictEqual(totalTokens(totals.tokens), 20);
  });

  suite('pickCurrentSession', () => {
    const live = (id: string, cwd: string, endedAt: number, entrypoint = 'cli') => session({ id, cwd, endedAt, entrypoint, turns: [turn(TODAY)] });

    test('開いているフォルダの中で最も新しいセッションを選ぶ', () => {
      const picked = pickCurrentSession([live('old', '/work/app', 1), live('new', '/work/app/sub', 2), live('other', '/work/other', 3)], ['/work/app']);
      assert.strictEqual(picked?.session.id, 'new');
      assert.strictEqual(picked?.matched, true);
    });

    test('似た名前のフォルダと取り違えない', () => {
      const picked = pickCurrentSession([live('other', '/work/app-two', 2)], ['/work/app']);
      assert.strictEqual(picked?.matched, false);
    });

    test('フォルダの中のセッションを、親で開始したセッションより優先する', () => {
      const picked = pickCurrentSession([live('parent', '/work', 9), live('inside', '/work/app', 1)], ['/work/app']);
      assert.strictEqual(picked?.session.id, 'inside');
    });

    test('親フォルダで開始したセッションも候補にする', () => {
      const picked = pickCurrentSession([live('parent', '/work', 1)], ['/work/app']);
      assert.strictEqual(picked?.session.id, 'parent');
      assert.strictEqual(picked?.matched, true);
    });

    test('自動実行のセッションは選ばない', () => {
      const picked = pickCurrentSession([live('human', '/work/app', 1), live('auto', '/work/app', 2, 'sdk-cli')], ['/work/app']);
      assert.strictEqual(picked?.session.id, 'human');
    });

    test('VS Code 拡張から始めたセッションも選ぶ', () => {
      assert.strictEqual(pickCurrentSession([live('vs', '/work/app', 1, 'claude-vscode')], ['/work/app'])?.session.id, 'vs');
    });

    test('候補がなければ最も新しいセッションを、一致なしとして返す', () => {
      const picked = pickCurrentSession([live('a', '/x', 1), live('b', '/y', 2)], ['/work/app']);
      assert.strictEqual(picked?.session.id, 'b');
      assert.strictEqual(picked?.matched, false);
    });

    test('ターンのないセッションしかなければ何も返さない', () => {
      assert.strictEqual(pickCurrentSession([session({ cwd: '/work/app' })], ['/work/app']), undefined);
    });
  });

  test('日付の計算は月をまたげる', () => {
    assert.strictEqual(addDays('2026-11-01', -1), '2026-10-31');
    assert.strictEqual(localDay(at('2026-11-01')), '2026-11-01');
  });
});
