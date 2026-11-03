import * as assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessions, scanSessions } from '../../sessionScanner';

const USER = JSON.stringify({ type: 'user', timestamp: '2026-10-05T10:00:00.000Z', message: { content: '依頼' } });
const assistant = (id: string, content: object[] = []) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-05T10:00:01.000Z',
    message: { id, model: 'claude-opus-5-5', content, usage: { output_tokens: 1_000_000 } },
  });

suite('sessionScanner', () => {
  let dir: string;

  setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'su-scan-'));
  });

  teardown(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSession(): Promise<void> {
    const project = join(dir, 'projects', '-work-app');
    await mkdir(join(project, 'abc', 'subagents'), { recursive: true });
    await mkdir(join(project, 'memory'));
    await writeFile(join(project, 'memory', 'note.jsonl'), 'ignored');
    await writeFile(join(project, 'abc.jsonl'), `${USER}\n${assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Agent' }])}\n`);
    await writeFile(join(project, 'abc.orphaned-1-x.jsonl'), 'ignored');
    await writeFile(join(project, 'abc', 'subagents', 'agent-1.jsonl'), `${assistant('s1')}\n`);
    await writeFile(join(project, 'abc', 'subagents', 'agent-1.meta.json'), JSON.stringify({ toolUseId: 't1' }));
  }

  test('履歴フォルダがなければ空を返す', async () => {
    assert.deepStrictEqual(await discoverSessions(join(dir, 'missing')), []);
  });

  test('本体とサブエージェントだけを見つけ、退避された履歴は読まない', async () => {
    await writeSession();
    const sessions = await discoverSessions(dir);
    assert.deepStrictEqual(sessions.map((session) => session.key), ['-work-app/abc']);
    assert.strictEqual(sessions[0].subagents.length, 1);
  });

  test('サブエージェントを含めて集計する', async () => {
    await writeSession();
    const { changed, failures } = await scanSessions(dir, {});
    assert.deepStrictEqual(failures, []);
    assert.strictEqual(changed[0].summary.computedCostUsd, 40);
    assert.strictEqual(changed[0].summary.turns[0].subagentCostUsd, 20);
  });

  test('変わっていないセッションは読み直さない', async () => {
    await writeSession();
    const first = await scanSessions(dir, {});
    const second = await scanSessions(dir, { [first.changed[0].key]: first.changed[0].fingerprint });
    assert.deepStrictEqual(second.changed, []);
    assert.deepStrictEqual(second.presentKeys, ['-work-app/abc']);
  });
});
