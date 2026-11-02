# VS Code 拡張機能ワークスペース

VS Code 拡張機能を開発するためのモノレポです。npm workspaces で管理しています。

| 拡張機能 | 内容 |
| --- | --- |
| [Cheatsheet](extensions/cheatsheet/README.md) | VS Code 上にチートシートを表示する |

## インストール

GitHub からプロジェクトを取得し、使いたい拡張機能のパッケージ（`.vsix`）を作ってインストールします。上の表から拡張機能を選び、以下の `cheatsheet` をその名前に読み替えてください。

必要なもの: Node.js 22 以上、VS Code（Cheatsheet は 1.144 以上）

1. プロジェクトを取得します。次のどちらかの方法で、`git` がなければ ZIP を使います。

   ```sh
   git clone https://github.com/Noboon803/vscode-extensions.git
   cd vscode-extensions
   ```

   ZIP の場合は、GitHub の `Code` > `Download ZIP` でダウンロードして展開し、展開したフォルダへ移動します。

2. 依存パッケージを入れて、`.vsix` を作ります。ファイルは `extensions/cheatsheet/cheatsheet-<バージョン>.vsix` にできます。

   ```sh
   npm install
   npm run vsix -w cheatsheet
   ```

3. VS Code にインストールします。

   ```sh
   code --install-extension extensions/cheatsheet/cheatsheet-0.0.1.vsix
   ```

   `code` コマンドがない場合は、VS Code の拡張機能ビューの `…` メニューから `VSIX からのインストール...` を選び、作った `.vsix` を指定します。

4. 開いている VS Code のウィンドウを再読み込みします（コマンドパレットの `Developer: Reload Window`）。

更新するときは、新しいプロジェクトを取得して 2 と 3 をやり直します。アンインストールは拡張機能ビューから行います。

## 開発

必要なもの: Node.js 22 以上

```sh
npm install
code vscode-extensions.code-workspace
```

拡張機能を起動するには、実行とデバッグで `Run <拡張機能名>` を選んで F5 を押します。

ルートで実行すると、すべての拡張機能が対象になります。

| コマンド | 内容 |
| --- | --- |
| `npm run compile` | 型チェック、lint、ビルド |
| `npm run lint` | ESLint を実行 |
| `npm test` | VS Code 上で統合テストを実行 |

1 つだけを対象にするときは `-w` を付けます（例: `npm test -w cheatsheet`）。`.vsix` の作成なども同じです（例: `npm run vsix -w cheatsheet`）。

## 構成

- `extensions/<名前>/` — 各拡張機能。`.vscode/` のデバッグ設定、`package.json`、`.vsix` の設定を自分で持つ
- `package.json` — ワークスペースの定義と、共通の開発ツール
- `tsconfig.base.json` — 共通の TypeScript 設定。各拡張機能の `tsconfig.json` が `extends` する
- `eslint.config.mjs` — 共通の ESLint 設定

依存関係の置き場所は次のとおりです。

- **ルートの `devDependencies`:** TypeScript、ESLint、esbuild、テストツールなどの共通ツール
- **各拡張機能の `package.json`:** 実行時の依存パッケージと、`engines.vscode` に合わせる `@types/vscode`

## 拡張機能の追加

1. `extensions/cheatsheet/` を参考に `extensions/<名前>/` を作ります。`.vscode/`、`.vscode-test.mjs`、`.vscodeignore`、`esbuild.mjs`、`tsconfig.json` はそのまま流用できます。`package.json` には `vsix` スクリプトも用意します。
2. `.vscode/launch.json` の構成名を `Run <名前>` にします。
3. `vscode-extensions.code-workspace` の `folders` に追加し、上の表にも追記します。
4. ルートで `npm install` を実行します。

統合テストが使う VS Code 本体（約 950 MB）は、拡張機能ごとの `.vscode-test/` にダウンロードされます。
