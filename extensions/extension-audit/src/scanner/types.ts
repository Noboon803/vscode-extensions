/** 検査の中核で使う型。VS Code に依存しない */

export type Level = 'high' | 'review' | 'info';

export type RuleId =
  | 'activation-all'
  | 'activation-startup'
  | 'uninstall-script'
  | 'package-script'
  | 'bundled-extension'
  | 'executable-file'
  | 'process-exec'
  | 'dynamic-code'
  | 'dynamic-import'
  | 'hidden-module'
  | 'network'
  | 'url'
  | 'ip-url'
  | 'credential-path'
  | 'persistence-path'
  | 'env-dump'
  | 'env-enumerate'
  | 'auth-session'
  | 'decode'
  | 'high-entropy'
  | 'hex-identifiers'
  | 'char-code'
  | 'invisible-chars'
  | 'combo-credential-network'
  | 'combo-env-network'
  | 'combo-decode-dynamic'
  | 'combo-obfuscated-exec';

export interface SourceLocation {
  /** 1 始まり */
  line: number;
  /** 0 始まり */
  column: number;
}

export interface Finding {
  rule: RuleId;
  /** モジュール名や通信先など、同じルールの中で区別する値 */
  detail: string;
  /** 拡張機能のフォルダからの相対パス（区切りは常に /） */
  file: string;
  /** 検出した総数。locations は先頭の数件だけ持つ */
  count: number;
  locations: SourceLocation[];
  excerpt?: string;
}

export type UninspectedReason =
  | 'manifest-error'
  | 'too-large'
  | 'parse-error'
  | 'read-error'
  | 'symlink'
  | 'timeout'
  | 'worker-error';

export interface Uninspected {
  /** 拡張機能のフォルダからの相対パス。フォルダ全体なら空文字 */
  file: string;
  reason: UninspectedReason;
  message?: string;
}

/** complete でも「検査対象の範囲で検出できなかった」だけで、安全を意味しない */
export type ScanStatus = 'complete' | 'partial' | 'failed';

export interface ExtensionScan {
  dirName: string;
  id: string;
  version: string;
  displayName: string;
  status: ScanStatus;
  findings: Finding[];
  uninspected: Uninspected[];
  filesScanned: number;
  bytesScanned: number;
}

export interface ScanTarget {
  dirName: string;
  path: string;
}

export interface ExcludedExtension {
  dirName: string;
  id: string;
  /** extension は拡張機能 ID の指定、publisher は信頼する開発元の指定による除外 */
  reason: 'extension' | 'publisher';
}

export interface ScanOptions {
  maxFileBytes: number;
}
