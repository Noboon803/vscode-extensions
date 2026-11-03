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

/** 分析に渡す 1 ターン分の会話 */
export interface ConversationTurn {
  /** 1 から数えた番号。ターン一覧の番号と同じ */
  number: number;
  at: number;
  user: string;
  /** スラッシュコマンドなど、ユーザーの発言ではないもの。分類しない */
  isCommand: boolean;
  assistant: string;
  /** メインのエージェントが呼んだツールの名前と回数 */
  tools: Record<string, number>;
}

export type ReviewKind = 'correction' | 'question';
export type ReviewResolution = 'yes' | 'partial' | 'no' | 'unknown';

export interface ReviewItem {
  turn: number;
  kind: ReviewKind;
  /** ユーザーの発言の原文。モデルの出力ではなく履歴から取る */
  quote: string;
  /** モデルによる要約 */
  summary: string;
  /** モデルによる、対応や回答の要約 */
  response: string;
  resolved: ReviewResolution;
  at: number;
}

export interface SessionReview {
  /** ここまでのターンは分析済み */
  analyzedTurns: number;
  items: ReviewItem[];
  /** 分析にかかった費用の累計 */
  costUsd: number;
  /** モデルの出力のうち、検証を通らず捨てた件数 */
  rejectedItems: number;
  model?: string;
}

/** 指摘と質問の一覧を描画するためのデータ */
export interface ReviewSnapshot {
  sessions: Record<string, SessionReview>;
  /** セッションごとの、まだ分析していないターンの数 */
  pending: Record<string, number>;
  /** 実行中の処理の説明 */
  busy?: string;
  error?: string;
}
