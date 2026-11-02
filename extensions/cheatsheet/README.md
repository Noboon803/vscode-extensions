# Cheatsheet

VS Code 上にチートシートを表示する拡張機能です。インストール手順は、リポジトリのルートにある `README.md` を参照してください。

## チートシートの追加

`Cheatsheet: YAML フォルダを開く` で開くフォルダに YAML を置くと、保存時にすぐ反映されます。置き場所は設定 `cheatsheet.contentPath` で変更できます。

ファイル名（拡張子なし）がカテゴリの ID です。同梱のカテゴリと同じファイル名にするとチートを追加でき、同じ `id` のチートは上書きされます。

```yaml
name: docker            # カテゴリの表示名（省略するとファイル名）
cheats:
  - title: コンテナの一覧 # 必須
    id: list            # 省略可。省略するとタイトルと同じ。タイトルを変えてもお気に入りを保ちたいときに指定
    description: 実行中のコンテナを表示します。
    code: docker ps
    notes: 停止中も含めるには -a を付けます。
  - title: コンテナを起動
    code: docker run
    language: bash      # 構文ハイライトの言語。省略すると bash。シェル以外は送信ボタンを出さない
    options:            # 入力した値を定義順に code の末尾へ連結する
      - flag: --name    # 省略すると値だけを連結する（位置引数）
        label: 名前     # flag の横に表示する簡潔な説明。省略可
        placeholder: web
      - flag: -e
        label: 環境変数
        placeholder: KEY=value
        multiple: true  # 「オプションを追加」から増やせる（-e A=1 -e B=2）
      - flag: --rm
        type: flag      # 値を取らないオプション。チェックボックスになる
      - label: イメージ
        required: true  # 説明の後ろに * を表示する
        default: nginx
      # separator: "="  と書くと --name=web の形で連結する
```

定義したオプションは定義順にすべて表示します。`multiple` を付けたものは、一番下の「オプションを追加」に選択肢として出ます。選ぶと元の行のすぐ下に入力欄が増え、× で外せます。位置引数にも付けられます（`npm install a b`）。追加した順に関係なく、連結するのは定義順です。

入力欄の値は、記号を含むと POSIX シェルの形式（シングルクォート）でクォートします。PowerShell などでは書き換えが必要な場合があります。

「送信」はアクティブなターミナルに入力するだけで、実行はしません。複数行のコードは最終行以外がすぐに実行されるため、送信前に確認します。

1 行の POSIX シェルのコマンドでは、「組み合わせ」から stdout / stderr のリダイレクト、パイプ、バックグラウンド実行を選べます。リダイレクトは意図どおりに働く順序で連結します（`cmd > file 2>&1`、`cmd 2>&1 | grep x > file`）。`&&` や `|` を含むコマンドでは、最後のコマンドにだけ効く場合があります。

`_techniques.yaml` を置くと、「組み合わせ」の選択肢を追加できます。同じ `id` の選択肢は上書きされます。

```yaml
pipe:                       # stdout / stderr / pipe のいずれか
  - label: JSON を整形       # 必須
    id: jq                  # 省略可。省略すると label と同じ
    template: "| jq {}"     # 必須。連結する文字列。{} は入力値（クォートして挿入）に置き換わる
    argLabel: フィルタ       # {} の入力欄の説明。省略可
    defaultArg: .           # {} の既定値。省略可
stderr:
  - label: エラーをログへ追記
    template: 2>> error.log # 入力欄が不要なら {} を書かない
```

## お気に入りと送信履歴

- **お気に入り:** ☆ を押すと、今のオプションと組み合わせの設定ごと登録します。同じチートでも設定が違えば別のお気に入りになります。★ は今のコマンドと同じお気に入りがあることを示し、押すとそのお気に入りを外します。
- **送信履歴:** 送信すると、カテゴリの「↺ 履歴」に新しい順で残ります（最大 50 件。同じコマンドは 1 件にまとめます）。選ぶと送信時の設定を復元します。× で個別に削除できます。
- **選んだときの動作:** お気に入りや履歴を選ぶと、そのチートの入力中の値は選んだ設定で置き換わります。
- **保存先:** どちらも VS Code のユーザーデータに保存します。お気に入りは Settings Sync で同期しますが、履歴は同期しません。入力した値もそのまま保存されるので、機密情報を送信した履歴は × で削除してください。

## 開発

必要なもの: Node.js 22 以上、VS Code 1.144 以上

依存パッケージは、リポジトリのルートで `npm install` を実行して入れます。下の表のコマンドはこのフォルダで実行します。

ルートの `vscode-extensions.code-workspace` を開き、実行とデバッグで `Run Cheatsheet` を選んで F5 を押すと、拡張機能を読み込んだ開発用ウィンドウ（Extension Development Host）が開きます。`Cmd+Option+J`（Mac）または `Ctrl+Alt+C`（Windows / Linux）でチートシートの表示と非表示を切り替えられます。コマンドパレットの `Cheatsheet: チートシートを表示` でも開けます。

| コマンド | 内容 |
| --- | --- |
| `npm run watch` | 型チェックとビルドを監視モードで実行 |
| `npm run compile` | 型チェック、lint、ビルド |
| `npm run lint` | ESLint を実行 |
| `npm test` | VS Code 上で統合テストを実行 |
| `npm run vsix` | `.vsix` パッケージを作成 |

## 構成

- `src/extension.ts` — エントリポイント
- `src/cheatsheetViewProvider.ts` — チートシートのビュー
- `src/favorites.ts` — お気に入りの保存
- `src/history.ts` — 送信履歴の保存
- `src/cheatLoader.ts` — YAML の読み込みと監視
- `cheats/` — 同梱のチートシート（YAML）
- `src/command.ts` — オプションからのコマンド組み立て
- `src/terminal.ts` — ターミナルへの送信
- `webview/` — Webview のスクリプト（`dist/webview.js` にバンドル）
- `media/` — Webview のスタイル
- `src/test/` — 統合テスト（`*.test.ts`）
- `dist/` — esbuild のバンドル出力（拡張機能本体）
- `out/` — テスト用の tsc 出力
