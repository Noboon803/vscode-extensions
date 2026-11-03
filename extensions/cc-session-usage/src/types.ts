export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TurnSummary {
  /** 発言の時刻（エポックミリ秒）。不明なら 0 */
  startedAt: number;
  /** 発言の冒頭。一覧で見分けるためだけに使うので短く切り詰める */
  prompt: string;
  requests: number;
  tools: number;
  tokens: TokenCounts;
  /** ターンの最後のリクエストが読んだトークン数。ターンをまたいだコンテキストの伸びを見るために使う */
  contextTokens: number;
  costUsd: number;
  subagentCostUsd: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

/** 日付とモデルの組み合わせごとの集計。期間で絞り込むときの単位 */
export interface DailyUsage {
  /** ローカル時刻の YYYY-MM-DD */
  date: string;
  model: string;
  requests: number;
  tokens: TokenCounts;
  costUsd: number;
}

export interface SessionSummary {
  id: string;
  /** projects/ の直下のフォルダ名。プロジェクトを区別するキー */
  projectDir: string;
  cwd?: string;
  title?: string;
  /** 起動元。`sdk-cli` は対話ではなく、要約などのために自動で実行されたもの */
  entrypoint?: string;
  startedAt: number;
  endedAt: number;
  turns: TurnSummary[];
  daily: DailyUsage[];
  /** 記録された各リクエストの usage から計算した金額 */
  computedCostUsd: number;
  /** Claude Code が記録したセッションの累計。ないセッションもある */
  recordedCostUsd?: number;
  /** 単価が分からず、金額に含められなかったリクエストの数 */
  unpricedRequests: number;
  /** 解釈できなかった行の数。履歴の形式が変わると増える */
  unreadableLines: number;
  /** 元の履歴ファイルが削除され、蓄積した集計だけが残っている */
  transcriptRemoved?: boolean;
}

export interface UsageSnapshot {
  sessions: SessionSummary[];
  configDir: string;
  updatedAt: number;
  error?: string;
}
