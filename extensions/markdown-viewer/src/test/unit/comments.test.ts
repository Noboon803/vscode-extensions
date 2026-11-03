import * as assert from 'node:assert';
import { CommentStore, encodeLinkPath, formatBullets, type PreviewComment, relocate } from '../../comments';

function createMemento() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T) => (values.has(key) ? (values.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

function comment(overrides: Partial<PreviewComment>): PreviewComment {
  return {
    id: 'id',
    uri: 'file:///a.md',
    line: 0,
    endLine: 1,
    quote: '',
    text: 'コメント',
    createdAt: 0,
    anchor: '',
    stale: false,
    ...overrides,
  };
}

suite('relocate', () => {
  test('上に行が増えたら追従する', () => {
    const position = relocate(comment({ line: 1, endLine: 2, anchor: 'b' }), ['追加', 'a', 'b']);
    assert.deepStrictEqual(position, { line: 2, endLine: 3, stale: false });
  });

  test('複数行のブロックを探す', () => {
    const position = relocate(comment({ line: 0, endLine: 2, anchor: 'a\nb' }), ['a', 'x', 'a', 'b']);
    assert.deepStrictEqual(position, { line: 2, endLine: 4, stale: false });
  });

  test('同じ内容が複数あれば元の位置に最も近いものを選ぶ', () => {
    const position = relocate(comment({ line: 5, endLine: 6, anchor: 'a' }), ['a', 'x', 'x', 'x', 'x', 'x', 'a', 'x']);
    assert.strictEqual(position.line, 6);
  });

  test('対象の行が書き換えられたら位置を保って stale にする', () => {
    const position = relocate(comment({ line: 1, endLine: 2, anchor: 'b' }), ['a', 'c']);
    assert.deepStrictEqual(position, { line: 1, endLine: 2, stale: true });
  });

  test('元に戻れば stale が解除される', () => {
    const position = relocate(comment({ line: 1, endLine: 2, anchor: 'b', stale: true }), ['a', 'b']);
    assert.strictEqual(position.stale, false);
  });
});

suite('formatBullets', () => {
  const pathOf = (uri: string) => uri.replace('file:///', '');
  const linkOf = (uri: string) => `/${pathOf(uri)}`;

  test('ファイル、行、引用、コメントを箇条書きにする', () => {
    const text = formatBullets(
      [
        comment({ line: 2, quote: '対象の  文章', text: '直す' }),
        comment({ uri: 'file:///b.md', line: 0, text: '確認' }),
      ],
      pathOf,
      linkOf,
    );
    assert.strictEqual(text, '- [a.md:3](/a.md#L3) 「対象の 文章」: 直す\n- [b.md:1](/b.md#L1): 確認');
  });

  test('複数行のコメントは続きを字下げする', () => {
    assert.strictEqual(formatBullets([comment({ text: '1 行目\n2 行目\n' })], pathOf, linkOf), '- [a.md:1](/a.md#L1): 1 行目\n  2 行目');
  });

  test('リンクの表示名の角括弧をエスケープする', () => {
    const text = formatBullets([comment({})], () => 'a[1].md', linkOf);
    assert.ok(text.startsWith('- [a\\[1\\].md:1]('), text);
  });

  test('リンク先の空白や括弧をエスケープし、日本語は残す', () => {
    assert.strictEqual(encodeLinkPath('/資料/a b(1)#2.md'), '/資料/a%20b%281%29%232.md');
  });

  test('長い引用は省略する', () => {
    const text = formatBullets([comment({ quote: 'あ'.repeat(100) })], pathOf, linkOf);
    assert.ok(text.includes(`「${'あ'.repeat(60)}…」`));
  });
});

suite('CommentStore', () => {
  const newComment = { uri: 'file:///a.md', line: 1, endLine: 2, quote: '', text: 'コメント' };

  test('追加時にソースからアンカーを取り、次回の起動でも読める', async () => {
    const memento = createMemento();
    const added = await new CommentStore(memento).add(newComment, 'a\nb\nc');
    assert.strictEqual(added.anchor, 'b');
    assert.deepStrictEqual(new CommentStore(memento).list(), [added]);
  });

  test('ファイルと行の順に返す', async () => {
    const store = new CommentStore(createMemento());
    await store.add({ ...newComment, uri: 'file:///b.md', line: 0 }, '');
    await store.add({ ...newComment, line: 5 }, '');
    await store.add({ ...newComment, line: 1 }, '');
    assert.deepStrictEqual(
      store.list().map(({ uri, line }) => [uri, line]),
      [
        ['file:///a.md', 1],
        ['file:///a.md', 5],
        ['file:///b.md', 0],
      ],
    );
    assert.strictEqual(store.listFor('file:///b.md').length, 1);
  });

  test('削除と全削除で変更を通知する', async () => {
    const store = new CommentStore(createMemento());
    let changes = 0;
    store.onDidChange(() => changes++);
    const added = await store.add(newComment, 'a\nb');
    await store.add(newComment, 'a\nb');
    await store.remove(added.id);
    assert.strictEqual(store.list().length, 1);
    await store.clear();
    assert.strictEqual(store.list().length, 0);
    assert.strictEqual(changes, 4);
  });

  test('同じファイルのコメントだけ位置を更新し、変わらなければ通知しない', async () => {
    const store = new CommentStore(createMemento());
    await store.add(newComment, 'a\nb');
    await store.add({ ...newComment, uri: 'file:///b.md' }, 'a\nb');
    let changes = 0;
    store.onDidChange(() => changes++);

    await store.relocateAll('file:///a.md', 'a\nb');
    assert.strictEqual(changes, 0);

    await store.relocateAll('file:///a.md', '追加\na\nb');
    assert.strictEqual(changes, 1);
    assert.strictEqual(store.listFor('file:///a.md')[0].line, 2);
    assert.strictEqual(store.listFor('file:///b.md')[0].line, 1);
  });
});
