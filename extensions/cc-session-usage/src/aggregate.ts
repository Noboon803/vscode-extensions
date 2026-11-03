import { addDays, localDay } from './dates';
import type { SessionReview, SessionSummary, TokenCounts, TurnSummary } from './types';

export interface UsageFilter {
  /** 今日を含む直近の日数。null は全期間 */
  days: number | null;
  /** projectDir。null はすべてのプロジェクト */
  project: string | null;
  /** YYYY-MM-DD */
  today: string;
}

export interface DayTotal {
  date: string;
  costUsd: number;
}

export interface ModelTotal {
  model: string;
  requests: number;
  tokens: TokenCounts;
  costUsd: number;
}

export interface ProjectTotal {
  projectDir: string;
  label: string;
  path: string;
  sessions: number;
  costUsd: number;
}

export interface SessionRow {
  session: SessionSummary;
  label: string;
  projectLabel: string;
  costUsd: number;
  turns: number;
}

export interface UsageTotals {
  costUsd: number;
  /** 記録された累計のうち、どのリクエストにも割り当てられない金額 */
  unallocatedUsd: number;
  tokens: TokenCounts;
  sessions: number;
  turns: number;
  linesAdded: number;
  linesRemoved: number;
  unpricedRequests: number;
  unreadableLines: number;
  days: DayTotal[];
  models: ModelTotal[];
  projects: ProjectTotal[];
  rows: SessionRow[];
}

/** リクエストの記録は一部が欠けるので、累計のほうが多ければ累計を採用する */
export function sessionCost(session: SessionSummary): number {
  return Math.max(session.computedCostUsd, session.recordedCostUsd ?? 0);
}

export function unallocatedCost(session: SessionSummary): number {
  return Math.max((session.recordedCostUsd ?? 0) - session.computedCostUsd, 0);
}

export function sessionKey(session: SessionSummary): string {
  return `${session.projectDir}/${session.id}`;
}

export function sessionTitle(session: SessionSummary): string {
  return session.title ?? session.turns[0]?.prompt ?? session.id;
}

/** 要約などのために Claude Code が自動で実行したセッション */
export function isAutomated(session: SessionSummary): boolean {
  return session.entrypoint === 'sdk-cli';
}

function isInside(child: string, parent: string): boolean {
  const base = parent.replace(/[\\/]+$/, '');
  return child === base || child.startsWith(`${base}/`) || child.startsWith(`${base}\\`);
}

export interface CurrentSession {
  session: SessionSummary;
  /** 開いているフォルダのセッションかどうか。false なら他に候補がなかった */
  matched: boolean;
}

/**
 * 今のウィンドウで作業中とみなすセッションを選ぶ。
 * 開いているフォルダ、その中、そのフォルダを含む親の順に探し、同じ順位なら最後に活動したものを選ぶ。
 */
export function pickCurrentSession(sessions: readonly SessionSummary[], folders: readonly string[]): CurrentSession | undefined {
  const candidates = sessions
    .filter((session) => !isAutomated(session) && session.turns.length > 0)
    .sort((a, b) => b.endedAt - a.endedAt);
  const matchers = [
    (cwd: string) => folders.some((folder) => isInside(cwd, folder)),
    (cwd: string) => folders.some((folder) => isInside(folder, cwd)),
  ];
  for (const matches of matchers) {
    const session = candidates.find((candidate) => candidate.cwd !== undefined && matches(candidate.cwd));
    if (session) {
      return { session, matched: true };
    }
  }
  return candidates[0] && { session: candidates[0], matched: false };
}

export function projectLabel(session: SessionSummary): string {
  if (session.cwd) {
    return session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? session.cwd;
  }
  return session.projectDir;
}

/** 入力、出力、キャッシュの読み書きをすべて足したトークン数 */
export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

export interface TurnTotals {
  tokens: TokenCounts;
  costUsd: number;
  requests: number;
  tools: number;
  linesAdded: number;
  linesRemoved: number;
}

export function sumTurns(turns: readonly TurnSummary[]): TurnTotals {
  const totals: TurnTotals = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    requests: 0,
    tools: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };
  for (const turn of turns) {
    totals.tokens.input += turn.tokens.input;
    totals.tokens.output += turn.tokens.output;
    totals.tokens.cacheRead += turn.tokens.cacheRead;
    totals.tokens.cacheWrite += turn.tokens.cacheWrite;
    totals.costUsd += turn.costUsd;
    totals.requests += turn.requests;
    totals.tools += turn.tools;
    totals.linesAdded += turn.linesAdded;
    totals.linesRemoved += turn.linesRemoved;
  }
  return totals;
}

export function aggregate(sessions: readonly SessionSummary[], filter: UsageFilter): UsageTotals {
  const start = filter.days === null ? undefined : addDays(filter.today, -(filter.days - 1));
  const inWindow = (date: string) => (start === undefined || date >= start) && date <= filter.today;

  const totals: UsageTotals = {
    costUsd: 0,
    unallocatedUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    sessions: 0,
    turns: 0,
    linesAdded: 0,
    linesRemoved: 0,
    unpricedRequests: 0,
    unreadableLines: 0,
    days: [],
    models: [],
    projects: [],
    rows: [],
  };
  const days = new Map<string, number>();
  const models = new Map<string, ModelTotal>();
  const projects = new Map<string, ProjectTotal>();

  for (const session of sessions) {
    if (filter.project !== null && session.projectDir !== filter.project) {
      continue;
    }
    let cost = 0;
    for (const row of session.daily) {
      if (!inWindow(row.date)) {
        continue;
      }
      cost += row.costUsd;
      days.set(row.date, (days.get(row.date) ?? 0) + row.costUsd);
      const model = models.get(row.model) ?? {
        model: row.model,
        requests: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
      };
      model.requests += row.requests;
      model.tokens.input += row.tokens.input;
      model.tokens.output += row.tokens.output;
      model.tokens.cacheRead += row.tokens.cacheRead;
      model.tokens.cacheWrite += row.tokens.cacheWrite;
      model.costUsd += row.costUsd;
      models.set(row.model, model);
      totals.tokens.input += row.tokens.input;
      totals.tokens.output += row.tokens.output;
      totals.tokens.cacheRead += row.tokens.cacheRead;
      totals.tokens.cacheWrite += row.tokens.cacheWrite;
    }

    // 割り当てられない金額は、日付が分からないので最後の活動日に計上する
    const lastDay = localDay(session.endedAt);
    const unallocated = inWindow(lastDay) ? unallocatedCost(session) : 0;
    if (unallocated > 0) {
      cost += unallocated;
      totals.unallocatedUsd += unallocated;
      days.set(lastDay, (days.get(lastDay) ?? 0) + unallocated);
    }

    const turns = session.turns.filter((turn) => inWindow(localDay(turn.startedAt || session.startedAt)));
    if (cost <= 0 && turns.length === 0) {
      continue;
    }

    totals.costUsd += cost;
    totals.sessions++;
    totals.turns += turns.length;
    totals.unpricedRequests += session.unpricedRequests;
    totals.unreadableLines += session.unreadableLines;
    for (const turn of turns) {
      totals.linesAdded += turn.linesAdded;
      totals.linesRemoved += turn.linesRemoved;
    }

    const label = projectLabel(session);
    const project = projects.get(session.projectDir) ?? {
      projectDir: session.projectDir,
      label,
      path: session.cwd ?? session.projectDir,
      sessions: 0,
      costUsd: 0,
    };
    project.sessions++;
    project.costUsd += cost;
    projects.set(session.projectDir, project);

    totals.rows.push({
      session,
      label: sessionTitle(session),
      projectLabel: label,
      costUsd: cost,
      turns: turns.length,
    });
  }

  totals.models = [...models.values()].sort((a, b) => b.costUsd - a.costUsd);
  totals.projects = [...projects.values()].sort((a, b) => b.costUsd - a.costUsd);
  totals.rows.sort((a, b) => b.session.endedAt - a.session.endedAt);

  // 活動のない日も棒の間隔に含める。詰めると時間の感覚がずれる
  const known = [...days.keys()].sort();
  const firstDay = start ?? known[0];
  if (firstDay) {
    for (let date = firstDay; date <= filter.today; date = addDays(date, 1)) {
      totals.days.push({ date, costUsd: days.get(date) ?? 0 });
    }
  }
  return totals;
}

/** 最近更新された履歴の最後のターンは、応答の途中かもしれないので分析しない */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** 分析できる最後のターン */
export function settledTurn(session: Pick<SessionSummary, 'turns' | 'endedAt'>, now: number): number {
  const total = session.turns.length;
  return now - session.endedAt < ACTIVE_WINDOW_MS ? Math.max(total - 1, 0) : total;
}

/** セッションごとの未分析のターン数。自動実行と、元の履歴が消えたセッションは分析できない */
export function pendingTurns(sessions: SessionSummary[], reviews: Record<string, SessionReview>, now: number): Record<string, number> {
  const pending: Record<string, number> = {};
  for (const session of sessions) {
    if (isAutomated(session) || session.transcriptRemoved) {
      continue;
    }
    const key = sessionKey(session);
    const count = settledTurn(session, now) - (reviews[key]?.analyzedTurns ?? 0);
    if (count > 0) {
      pending[key] = count;
    }
  }
  return pending;
}
