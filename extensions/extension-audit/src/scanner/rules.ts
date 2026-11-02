import type { Level, RuleId } from './types';

/**
 * ルールや判定を変えたら上げる。
 * 古い結果と比べると、拡張機能が変わっていなくても「増えた」と表示されてしまうため
 */
export const RULESET_VERSION = 1;

export interface Rule {
  level: Level;
  title: string;
  explanation: string;
}

export const RULES: Record<RuleId, Rule> = {
  'activation-all': {
    level: 'review',
    title: 'あらゆる場面で起動する',
    explanation: 'activationEvents に * があり、VS Code の起動時から常に動作します。',
  },
  'activation-startup': {
    level: 'info',
    title: '起動完了後に自動で起動する',
    explanation: 'activationEvents に onStartupFinished があり、操作しなくても動作します。',
  },
  'uninstall-script': {
    level: 'review',
    title: 'アンインストール時に実行するスクリプト',
    explanation: 'vscode:uninstall は、アンインストール時に VS Code が実行します。',
  },
  'package-script': {
    level: 'info',
    title: 'npm のライフサイクルスクリプト',
    explanation: 'VS Code は実行しませんが、開発時の処理の手がかりになります。',
  },
  'bundled-extension': {
    level: 'info',
    title: '一緒に入る拡張機能',
    explanation: 'extensionPack や extensionDependencies によって、別の拡張機能も入ります。',
  },
  'executable-file': {
    level: 'review',
    title: '実行ファイルやネイティブコード',
    explanation: 'バイナリやシェルスクリプトの中身は、このツールでは検査できません。',
  },
  'process-exec': {
    level: 'review',
    title: '外部コマンドの実行',
    explanation: 'child_process を使っています。言語サーバーなどを起動する拡張機能では普通に使われます。',
  },
  'dynamic-code': {
    level: 'review',
    title: '文字列をコードとして実行',
    explanation: 'eval、new Function、vm を使っています。実行する内容はコードを読むだけでは分からない場合があります。',
  },
  'dynamic-import': {
    level: 'info',
    title: '読み込むモジュールを実行時に決定',
    explanation: 'require や import の引数が固定の文字列ではありません。バンドラーの出力にも多く見られます。',
  },
  'hidden-module': {
    level: 'high',
    title: '文字列を組み立てた機能の呼び出し',
    explanation: "'child' + '_process' のように、名前を分割して機能を呼び出しています。検出を避ける書き方です。",
  },
  network: {
    level: 'info',
    title: '通信機能',
    explanation: '通信用のモジュールや API を使っています。',
  },
  url: {
    level: 'info',
    title: 'コード内の URL',
    explanation: 'URL の接続先です。実際に通信するとは限りません。',
  },
  'ip-url': {
    level: 'review',
    title: 'グローバル IP アドレス宛ての URL',
    explanation: 'ドメイン名ではなく IP アドレスを直接指定しています。',
  },
  'credential-path': {
    level: 'review',
    title: '認証情報のパス',
    explanation: 'SSH 鍵やクラウドの認証情報などの保存場所を文字列として持っています。',
  },
  'persistence-path': {
    level: 'review',
    title: '自動実行に使われるパス',
    explanation: 'シェルの設定ファイルや LaunchAgents など、常駐に使われる場所を文字列として持っています。',
  },
  'env-dump': {
    level: 'review',
    title: '環境変数をまとめて取得',
    explanation: 'process.env 全体を JSON にしています。環境変数には秘密情報が入っている場合があります。',
  },
  'env-enumerate': {
    level: 'info',
    title: '環境変数の列挙やコピー',
    explanation: '子プロセスに渡す環境変数を作る処理などでよく使われます。',
  },
  'auth-session': {
    level: 'info',
    title: 'VS Code の認証セッションの取得',
    explanation: 'GitHub などのアカウントの認証情報を要求します。',
  },
  decode: {
    level: 'info',
    title: 'Base64 や 16 進数のデコード',
    explanation: '画像やバイナリの処理にも使われます。',
  },
  'high-entropy': {
    level: 'info',
    title: 'ランダムに見える長い文字列',
    explanation: '暗号化されたコードの可能性がありますが、埋め込みデータでもよく見られます。',
  },
  'hex-identifiers': {
    level: 'review',
    title: '難読化ツールに特有の変数名',
    explanation: '_0x1a2b のような変数名が大量にあります。',
  },
  'char-code': {
    level: 'review',
    title: '文字コードからの文字列の組み立て',
    explanation: 'String.fromCharCode に多数の数値を渡しており、文字列を隠している可能性があります。',
  },
  'invisible-chars': {
    level: 'high',
    title: '目に見えない文字の連続',
    explanation: '画面に表示されない Unicode 文字が連続しています。コードを隠す手口に使われます。',
  },
  'combo-credential-network': {
    level: 'high',
    title: '認証情報のパス + 通信',
    explanation: '同じファイルに両方あります。実際に送信しているかどうかは、コードを読んで確認してください。',
  },
  'combo-env-network': {
    level: 'high',
    title: '環境変数の一括取得 + 通信',
    explanation: '同じファイルに両方あります。実際に送信しているかどうかは、コードを読んで確認してください。',
  },
  'combo-decode-dynamic': {
    level: 'high',
    title: 'デコード直後のコードの動的実行',
    explanation: 'デコードと動的実行がコード上の近い位置にあります。隠したコードを実行する典型的な形です。',
  },
  'combo-obfuscated-exec': {
    level: 'high',
    title: '難読化 + コマンドやコードの実行',
    explanation: '同じファイルに両方あります。',
  },
};

export const LEVEL_ORDER: Record<Level, number> = { high: 0, review: 1, info: 2 };

export const LEVEL_LABELS: Record<Level, string> = {
  high: '優先確認',
  review: '要確認',
  info: '参考',
};
