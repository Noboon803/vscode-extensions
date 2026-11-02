import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type CheatContent, loadContent, watchContentFolder } from './cheatLoader';
import { CheatsheetViewProvider } from './cheatsheetViewProvider';
import { FavoriteStore } from './favorites';
import { HistoryStore } from './history';

const TERMINAL_CONTAINER_ID = 'terminal';
const PLACED_KEY = 'cheatsheet.placedBesideTerminal';
const CONTENT_PATH_SETTING = 'cheatsheet.contentPath';

const CONTENT_README = `# Cheatsheet のチートシート

このフォルダに置いた YAML ファイルがチートシートに表示されます。保存するとすぐに反映されます。

ファイル名（拡張子なし）がカテゴリの ID です。同梱のカテゴリと同じファイル名にすると、チートを追加できます。

\`\`\`yaml
name: docker            # カテゴリの表示名（省略するとファイル名）
cheats:
  - title: コンテナの一覧 # 必須
    id: list            # 省略可。省略するとタイトルと同じ。同じ ID のチートは上書きされる
    description: 実行中のコンテナを表示します。
    code: docker ps
    notes: 停止中も含めるには -a を付けます。
  - title: コンテナを起動
    code: docker run
    language: bash      # 構文ハイライトの言語。省略すると bash。シェル以外は送信ボタンを出さない
    options:            # 入力欄。入力した値を定義順に code の末尾へ連結する
      - flag: --name    # 省略すると値だけを連結する（位置引数）
        label: 名前     # flag の横に表示する簡潔な説明。省略可
        placeholder: web
      - flag: --rm
        type: flag      # 値を取らないオプション。チェックボックスになる
      - label: イメージ
        required: true  # 説明の後ろに * を表示する
        default: nginx
      # separator: "="  と書くと --name=web の形で連結する
\`\`\`

\`_techniques.yaml\` を置くと、「組み合わせ」の選択肢を追加できます。同じ \`id\` の選択肢は上書きされます。

\`\`\`yaml
pipe:                       # stdout / stderr / pipe のいずれか
  - label: JSON を整形       # 必須
    id: jq                  # 省略可。省略すると label と同じ
    template: "| jq {}"     # 必須。連結する文字列。{} は入力値（クォートして挿入）に置き換わる
    argLabel: フィルタ       # {} の入力欄の説明。省略可
    defaultArg: .           # {} の既定値。省略可
stderr:
  - label: エラーをログへ追記
    template: 2>> error.log # 入力欄が不要なら {} を書かない
\`\`\`
`;

/** 設定があればそのフォルダ、なければ拡張機能のユーザー領域を返す */
function resolveContentFolder(context: vscode.ExtensionContext): { uri: vscode.Uri; isDefault: boolean } {
  const configured = vscode.workspace.getConfiguration().get<string>(CONTENT_PATH_SETTING, '').trim();
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[/\\])/, homedir());
    return { uri: vscode.Uri.file(path.resolve(homedir(), expanded)), isDefault: false };
  }
  return { uri: vscode.Uri.joinPath(context.globalStorageUri, 'cheats'), isDefault: true };
}

async function openContentFolder(context: vscode.ExtensionContext): Promise<void> {
  const { uri, isDefault } = resolveContentFolder(context);
  await vscode.workspace.fs.createDirectory(uri);
  if (isDefault) {
    const readme = vscode.Uri.joinPath(uri, 'README.md');
    try {
      await vscode.workspace.fs.stat(readme);
    } catch {
      await vscode.workspace.fs.writeFile(readme, new TextEncoder().encode(CONTENT_README));
    }
  }
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

/**
 * 初回だけビューをターミナルと同じコンテナへ移し、横に並べる。
 * moveViews は先頭に挿入するため、ビューはターミナルの左に並ぶ。
 * 2 回目以降は動かさず、ユーザーが変更した配置を尊重する。
 * vscode.moveViews は非公開コマンドのため、失敗時はパネルのタブ表示のままにする。
 */
async function placeBesideTerminalOnce(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(PLACED_KEY)) {
    return;
  }
  try {
    await vscode.commands.executeCommand('vscode.moveViews', {
      viewIds: [CheatsheetViewProvider.viewId],
      destinationId: TERMINAL_CONTAINER_ID,
    });
    await context.globalState.update(PLACED_KEY, true);
  } catch (error) {
    console.warn('Cheatsheet: ターミナルの隣へ移動できませんでした', error);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Settings Sync を使っていれば、お気に入りを他のマシンにも同期する
  context.globalState.setKeysForSync([FavoriteStore.storageKey]);

  const output = vscode.window.createOutputChannel('Cheatsheet');
  context.subscriptions.push(output);

  // Webview は隠すたびに作り直されるので、読み込み結果を変更があるまで使い回す
  let loading: Promise<CheatContent> | undefined;
  const getContent = () => (loading ??= load());

  async function load(): Promise<CheatContent> {
    const { uri, isDefault } = resolveContentFolder(context);
    if (isDefault) {
      await vscode.workspace.fs.createDirectory(uri);
    }
    const bundled = vscode.Uri.joinPath(context.extensionUri, 'cheats');
    const { errors, ...content } = await loadContent([bundled, uri]);
    if (errors.length > 0) {
      errors.forEach((error) => output.appendLine(error));
      void vscode.window
        .showWarningMessage(`Cheatsheet: YAML の読み込みで ${errors.length} 件の問題がありました。`, '詳細を表示')
        .then((action) => {
          if (action) {
            output.show();
          }
        });
    }
    return content;
  }

  const provider = new CheatsheetViewProvider(
    context.extensionUri,
    getContent,
    new FavoriteStore(context.globalState),
    new HistoryStore(context.globalState),
  );

  const show = async () => {
    await placeBesideTerminalOnce(context);
    await vscode.commands.executeCommand(`${CheatsheetViewProvider.viewId}.focus`);
  };

  const reload = () => {
    loading = undefined;
    void provider.sendCategories();
  };

  let watcher: vscode.Disposable | undefined;
  const watch = async () => {
    watcher?.dispose();
    const { uri, isDefault } = resolveContentFolder(context);
    if (isDefault) {
      await vscode.workspace.fs.createDirectory(uri);
    }
    watcher = watchContentFolder(uri, reload);
  };
  await watch();

  context.subscriptions.push(
    new vscode.Disposable(() => watcher?.dispose()),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(CONTENT_PATH_SETTING)) {
        await watch();
        reload();
      }
    }),
    vscode.window.registerWebviewViewProvider(CheatsheetViewProvider.viewId, provider),
    vscode.commands.registerCommand('cheatsheet.show', show),
    vscode.commands.registerCommand('cheatsheet.toggle', async () => {
      if (provider.isVisible) {
        // パネルごと閉じると隣のターミナルも消えるので、チートシートだけを隠す
        await vscode.commands.executeCommand(`${CheatsheetViewProvider.viewId}.toggleVisibility`);
      } else {
        await show();
      }
    }),
    vscode.commands.registerCommand('cheatsheet.openContentFolder', () => openContentFolder(context)),
  );
}

export function deactivate(): void {}
