import * as assert from 'node:assert';
import { SessionParser } from '../../sessionParser';

function assistant(id: string, usage: object, content: object[] = [], extra: object = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}-${Math.random()}`,
    timestamp: '2026-10-05T10:00:10.000Z',
    cwd: '/work/project',
    message: { id, model: 'claude-opus-5-5', usage, content },
    ...extra,
  });
}

function user(content: unknown, extra: object = {}): string {
  return JSON.stringify({ type: 'user', uuid: `u-${Math.random()}`, timestamp: '2026-10-05T10:00:00.000Z', message: { content }, ...extra });
}

const USAGE = { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function parse(lines: string[]) {
  const parser = new SessionParser('session', 'project');
  lines.forEach((line) => parser.addLine(line));
  return parser.finish();
}

suite('SessionParser', () => {
  test('ブロックごとに分かれた同じ応答を 1 リクエストとして数える', () => {
    const summary = parse([user('実装して'), assistant('m1', USAGE), assistant('m1', USAGE), assistant('m2', USAGE)]);
    assert.strictEqual(summary.turns.length, 1);
    assert.strictEqual(summary.turns[0].requests, 2);
    assert.strictEqual(summary.computedCostUsd, 40);
  });

  test('同じ応答の usage は出力が多いほうを採用する', () => {
    const summary = parse([user('x'), assistant('m1', { ...USAGE, output_tokens: 10 }), assistant('m1', USAGE)]);
    assert.strictEqual(summary.turns[0].tokens.output, 1_000_000);
  });

  test('ツール結果や差し込まれたメッセージはターンにしない', () => {
    const summary = parse([
      user('最初の依頼'),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      user('<task-notification>done</task-notification>'),
      user('<system-reminder>x</system-reminder>'),
      user('<bash-input>ls</bash-input>'),
      user('メタ', { isMeta: true }),
      user('要約', { isCompactSummary: true }),
      user('通知', { origin: { kind: 'task-notification' } }),
      user('人の発言', { origin: { kind: 'human' } }),
    ]);
    assert.deepStrictEqual(summary.turns.map((turn) => turn.prompt), ['最初の依頼', '人の発言']);
  });

  test('スラッシュコマンドは、モデルを呼んだときだけターンにする', () => {
    const summary = parse([
      user('<command-name>/clear</command-name><command-message>clear</command-message>'),
      user('<command-message>review</command-message><command-name>/review</command-name>'),
      assistant('m1', USAGE),
    ]);
    assert.deepStrictEqual(summary.turns.map((turn) => turn.prompt), ['/review']);
  });

  test('文中に引用したコマンドのタグは、普通の発言として扱う', () => {
    const summary = parse([user('なぜ <command-name>/clear</command-name> が出るの？')]);
    assert.strictEqual(summary.turns[0].prompt, 'なぜ <command-name>/clear</command-name> が出るの？');
    assert.strictEqual(summary.turns.length, 1);
  });

  test('編集行数を差分から、新規作成は内容から数える', () => {
    const summary = parse([
      user('編集して'),
      user([{ type: 'tool_result' }], {
        toolUseResult: { filePath: '/a.ts', structuredPatch: [{ lines: ['+a', '+b', '-c', ' d'] }] },
      }),
      // Claude Code の累計と同じく、末尾の改行の後も 1 行と数える
      user([{ type: 'tool_result' }], { toolUseResult: { type: 'create', filePath: '/b.ts', content: 'x\ny\n', structuredPatch: [] } }),
    ]);
    const [turn] = summary.turns;
    assert.strictEqual(turn.linesAdded, 5);
    assert.strictEqual(turn.linesRemoved, 1);
    assert.strictEqual(turn.filesChanged, 2);
  });

  test('サブエージェントは起動元のターンに合算する', () => {
    const parser = new SessionParser('session', 'project');
    parser.addLine(user('一番目'));
    parser.addLine(assistant('m1', USAGE, [{ type: 'tool_use', id: 'tool-1', name: 'Agent' }]));
    parser.addLine(user('二番目'));
    parser.addLine(assistant('m2', USAGE));
    parser.addLine(assistant('sub', USAGE), { isSubagent: true, toolUseId: 'tool-1' });
    const summary = parser.finish();
    assert.strictEqual(summary.turns[0].requests, 2);
    assert.strictEqual(summary.turns[0].subagentCostUsd, 20);
    assert.strictEqual(summary.turns[1].requests, 1);
  });

  test('サブエージェントはコンテキスト量に影響しない', () => {
    const parser = new SessionParser('session', 'project');
    parser.addLine(user('依頼'));
    parser.addLine(assistant('m1', { ...USAGE, cache_read_input_tokens: 500 }, [{ type: 'tool_use', id: 't', name: 'Agent' }]));
    parser.addLine(assistant('sub', { ...USAGE, cache_read_input_tokens: 9 }), { isSubagent: true, toolUseId: 't' });
    assert.strictEqual(parser.finish().turns[0].contextTokens, 500);
  });

  test('知らない種類の行は無視し、壊れた行だけを数える', () => {
    const summary = parse(['{"type":"future-record","x":1}', 'not json', '', user('x')]);
    assert.strictEqual(summary.unreadableLines, 1);
    assert.strictEqual(summary.turns.length, 1);
  });

  test('書き込み途中の最終行は、読めなかった行に数えない', () => {
    const parser = new SessionParser('session', 'project');
    parser.addLine(user('x'));
    parser.addLine('{"type":"assistant","mess');
    parser.endFile();
    assert.strictEqual(parser.finish().unreadableLines, 0);
  });

  test('起動元を記録する', () => {
    assert.strictEqual(parse([user('x', { entrypoint: 'sdk-cli' })]).entrypoint, 'sdk-cli');
  });

  test('usage のない応答を読めなかった行として数える', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', content: [] } });
    assert.strictEqual(parse([user('x'), line]).unreadableLines, 1);
  });

  test('Claude Code が作った応答は数えない', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'm', model: '<synthetic>', usage: USAGE, content: [] } });
    const summary = parse([user('x'), line]);
    assert.strictEqual(summary.turns[0].requests, 0);
    assert.strictEqual(summary.unreadableLines, 0);
  });

  test('本文がなく累計だけが残ったセッションも読める', () => {
    const line = JSON.stringify({ type: 'cost-state', totalCostUSD: 93.7, startTime: 1000 });
    const summary = parse([line, '{"type":"ai-title","aiTitle":"題名"}']);
    assert.strictEqual(summary.recordedCostUsd, 93.7);
    assert.strictEqual(summary.title, '題名');
    assert.strictEqual(summary.startedAt, 1000);
    assert.deepStrictEqual(summary.turns, []);
  });

  test('単価が分からないモデルは 0 円にせず件数を知らせる', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-future-9', usage: USAGE, content: [] } });
    const summary = parse([user('x'), line]);
    assert.strictEqual(summary.unpricedRequests, 1);
    assert.strictEqual(summary.computedCostUsd, 0);
  });

  test('発言の冒頭を切り詰める', () => {
    assert.ok(parse([user('あ'.repeat(500))]).turns[0].prompt.length <= 201);
  });
});
