import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CheatsheetViewProvider } from '../cheatsheetViewProvider';
import { FavoriteStore } from '../favorites';
import { HistoryStore } from '../history';

function fakeMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => (values.has(key) ? (values.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as vscode.Memento;
}

suite('FavoriteStore', () => {
  const none = { fields: {}, techniques: {} };

  test('同じチートも設定違いで複数登録でき、解除しても他は残る', async () => {
    const store = new FavoriteStore(fakeMemento());
    assert.deepStrictEqual(store.list(), []);

    const a = await store.add('git/a', { fields: { '-n': '5' }, techniques: { pipe: 'grep' } });
    const b = await store.add('git/a', none);
    assert.notStrictEqual(a.id, b.id);
    assert.deepStrictEqual(store.list(), [a, b]);
    assert.deepStrictEqual(a.fields, { '-n': '5' });

    await store.remove(a.id);
    assert.deepStrictEqual(store.list(), [b]);
  });

  test('文字列で保存された以前のお気に入りを既定の設定として読み、解除もできる', async () => {
    const memento = fakeMemento();
    await memento.update(FavoriteStore.storageKey, ['git/a', 'bash/b']);
    const store = new FavoriteStore(memento);
    assert.deepStrictEqual(store.list(), [
      { id: 'git/a', key: 'git/a', ...none },
      { id: 'bash/b', key: 'bash/b', ...none },
    ]);

    const added = await store.add('git/c', none);
    await store.remove('git/a');
    assert.deepStrictEqual(store.list(), [{ id: 'bash/b', key: 'bash/b', ...none }, added]);
  });
});

suite('HistoryStore', () => {
  const sent = (text: string, key = 'git/a') => ({ key, title: 't', text, fields: {}, techniques: {} });

  test('新しい順に保存し、同じコマンドは 1 件にまとめて先頭へ移す', async () => {
    let now = 1;
    const store = new HistoryStore(fakeMemento(), () => now++);
    const first = await store.record(sent('a'));
    await store.record(sent('b'));
    await store.record(sent('a', 'bash/z'));
    const again = await store.record({ ...sent('a'), fields: { '-n': '1' } });

    assert.deepStrictEqual(store.list().map((e) => [e.key, e.text]), [['git/a', 'a'], ['bash/z', 'a'], ['git/a', 'b']]);
    assert.strictEqual(again.id, first.id);
    assert.strictEqual(again.sentAt, 4);
    assert.deepStrictEqual(store.list()[0].fields, { '-n': '1' });
  });

  test('上限を超えると古いものから消え、個別に削除できる', async () => {
    const store = new HistoryStore(fakeMemento());
    for (let i = 0; i < 55; i++) {
      await store.record(sent(String(i)));
    }
    assert.strictEqual(store.list().length, 50);
    assert.strictEqual(store.list()[0].text, '54');
    assert.strictEqual(store.list()[49].text, '5');

    await store.remove(store.list()[0].id);
    assert.strictEqual(store.list()[0].text, '53');
    assert.strictEqual(store.list().length, 49);
  });
});

suite('CheatsheetViewProvider', () => {
  test('お気に入りの追加と解除、送信の記録をして最新の一覧を送る', async () => {
    const posted: unknown[] = [];
    let receive: (message: unknown) => Promise<void> = async () => {};
    const view = {
      webview: {
        cspSource: 'test',
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          receive = handler;
          return { dispose() {} };
        },
        postMessage: async (message: unknown) => {
          posted.push(message);
          return true;
        },
      },
    } as unknown as vscode.WebviewView;
    const categories = [{ id: 'git', name: 'git', cheats: [{ id: 'a', title: 'a' }] }];
    const store = new FavoriteStore(fakeMemento());
    const history = new HistoryStore(fakeMemento());
    const sent: string[] = [];
    let accepted = true;
    const send = async (text: string) => {
      sent.push(text);
      return accepted;
    };
    new CheatsheetViewProvider(vscode.Uri.file('/ext'), async () => ({ categories, techniqueGroups: [] }), store, history, send).resolveWebviewView(view);
    const settings = { fields: { '-n': '5' }, techniques: { pipe: 'grep' } };
    const sentCommand = { key: 'git/a', title: 'a', text: 'git status', ...settings };

    await receive({ type: 'ready' });
    await receive({ type: 'addFavorite', key: 'git/a', ...settings });
    const [favorite] = store.list();
    await receive({ type: 'removeFavorite', id: favorite.id });
    await receive({ type: 'sendToTerminal', ...sentCommand });
    const [entry] = history.list();
    // 複数行の確認で取り消すと履歴に残らない
    accepted = false;
    await receive({ type: 'sendToTerminal', ...sentCommand, text: 'x\ny' });
    await receive({ type: 'removeHistory', id: entry.id });

    assert.deepStrictEqual(posted, [
      { type: 'categories', categories, techniqueGroups: [], favorites: [], history: [] },
      { type: 'favorites', favorites: [favorite], addedId: favorite.id },
      { type: 'favorites', favorites: [] },
      { type: 'history', history: [entry], sentId: entry.id },
      { type: 'history', history: [] },
    ]);
    assert.deepStrictEqual(favorite.fields, settings.fields);
    assert.strictEqual(entry.text, 'git status');
    assert.deepStrictEqual(entry.techniques, settings.techniques);
    assert.strictEqual('type' in entry, false);
    assert.deepStrictEqual(sent, ['git status', 'x\ny']);
  });
});
