import { aggregate, projectLabel, sessionKey, sessionTitle, totalTokens } from './aggregate';
import { addDays, localDay } from './dates';
import { formatUsd } from './format';
import type { ReviewItem, SessionReview, SessionSummary, TurnSummary } from './types';

/** レポートの構成を変えたら上げる。同じ番号のレポートは同じ構成で比べられる */
export const REPORT_FORMAT_VERSION = 1;

/** レポートの見出しと順序。データの有無にかかわらず、常にこのとおりに出力する */
export const REPORT_SECTIONS = ['概要', '指摘と質問', '日別のコスト', 'モデル別', 'プロジェクト別', 'セッション別', 'ターン別'] as const;

const KIND_LABELS: Record<ReviewItem['kind'], string> = { correction: '指摘', question: '質問' };
const RESOLUTION_LABELS: Record<ReviewItem['resolved'], string> = { yes: '対応済み', partial: '一部のみ', no: '未対応', unknown: '不明' };

export interface ReportFilter {
  /** 直近の日数。null は全期間 */
  days: number | null;
  project: string | null;
  /** 指定すると、そのセッションだけを全期間で対象にする */
  sessionKey: string | null;
}

export interface ReportInput {
  sessions: readonly SessionSummary[];
  reviews: Record<string, SessionReview>;
  pending: Record<string, number>;
  filter: ReportFilter;
  generatedAt: number;
  pricesAsOf: string;
}

/** 本文には履歴の内容が入る。そのまま書くと HTML として解釈されるので、必ず通す */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** 環境の言語設定で書式が変わらないよう、固定の形式で書く */
function formatDateTime(epochMs: number): string {
  if (!epochMs) {
    return '不明';
  }
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${localDay(epochMs)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface Column {
  label: string;
  num?: boolean;
  /** 短い値が折り返して読みにくくならないようにする */
  short?: boolean;
}

/** 表も、行がないときに見出しごと消さず、列の構成を保つ */
function table(columns: readonly Column[], rows: readonly (readonly string[])[], foot?: readonly string[]): string {
  const cell = (tag: string, html: string, column: Column) => `<${tag}${column.num ? ' class="num"' : column.short ? ' class="short"' : ''}>${html}</${tag}>`;
  const body = rows.length > 0 ? rows.map((row) => `<tr>${row.map((html, index) => cell('td', html, columns[index])).join('')}</tr>`).join('\n') : `<tr><td class="none" colspan="${columns.length}">該当なし</td></tr>`;
  const footer = foot && rows.length > 0 ? `<tfoot><tr>${foot.map((html, index) => cell('td', html, columns[index])).join('')}</tr></tfoot>` : '';
  return `<div class="scroll"><table>
<thead><tr>${columns.map((column) => cell('th', esc(column.label), column)).join('')}</tr></thead>
<tbody>
${body}
</tbody>${footer}
</table></div>`;
}

function section(index: number, html: string): string {
  return `<section>\n<h2>${index + 1}. ${esc(REPORT_SECTIONS[index])}</h2>\n${html}\n</section>`;
}

function scopeLabel(input: ReportInput, target: SessionSummary | undefined): { scope: string; period: string } {
  if (target) {
    return { scope: `セッション: ${sessionTitle(target)}（${projectLabel(target)}）`, period: `全期間（${formatDateTime(target.startedAt)} 〜 ${formatDateTime(target.endedAt)}）` };
  }
  const project = input.filter.project === null ? undefined : input.sessions.find((session) => session.projectDir === input.filter.project);
  return {
    scope: project ? `プロジェクト: ${projectLabel(project)}` : 'すべてのプロジェクト',
    period: input.filter.days === null ? '全期間' : `直近 ${input.filter.days} 日（${addDays(localDay(input.generatedAt), -(input.filter.days - 1))} 〜 ${localDay(input.generatedAt)}）`,
  };
}

const STYLE = `:root { color-scheme: light dark; --ink: #1f2328; --muted: #59636e; --line: #d1d9e0; --surface: #ffffff; --raised: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --ink: #d1d7e0; --muted: #9198a1; --line: #3d444d; --surface: #15191f; --raised: #1f242b; } }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--surface); font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 8px; font-size: 24px; }
h2 { margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); font-size: 18px; }
h3 { margin: 16px 0 4px; font-size: 14px; }
p { margin: 4px 0; }
.note, .none { color: var(--muted); }
.note { font-size: 13px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 8px 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tfoot td { font-weight: 600; }
.short { white-space: nowrap; }
details { margin: 8px 0; }
summary { cursor: pointer; }
blockquote { min-width: 280px; max-width: 480px; margin: 4px 0 0; padding: 4px 12px; border-left: 3px solid var(--line); background: var(--raised); white-space: pre-wrap; overflow-wrap: anywhere; }
footer { margin-top: 32px; color: var(--muted); font-size: 12px; }
@media print { .scroll { overflow: visible; } }`;

function overviewSection(input: ReportInput, totals: ReturnType<typeof aggregate>, items: readonly ReviewItem[], pendingCount: number): string {
  const corrections = items.filter((item) => item.kind === 'correction');
  const open = corrections.filter((item) => item.resolved !== 'yes').length;
  const reviewCost = totals.rows.reduce((sum, row) => sum + (input.reviews[sessionKey(row.session)]?.costUsd ?? 0), 0);
  return table(
    [{ label: '項目' }, { label: '値', num: true }],
    [
      ['コスト（定価換算の推定）', formatUsd(totals.costUsd)],
      ['うち未割当', formatUsd(totals.unallocatedUsd)],
      ['セッション数', formatNumber(totals.sessions)],
      ['ターン数', formatNumber(totals.turns)],
      ['入力トークン', formatNumber(totals.tokens.input)],
      ['出力トークン', formatNumber(totals.tokens.output)],
      ['キャッシュ読み取りトークン', formatNumber(totals.tokens.cacheRead)],
      ['キャッシュ書き込みトークン', formatNumber(totals.tokens.cacheWrite)],
      ['変更行数（Bash での編集を除く）', `+${formatNumber(totals.linesAdded)} / −${formatNumber(totals.linesRemoved)}`],
      ['指摘', formatNumber(corrections.length)],
      ['うち対応済み以外', formatNumber(open)],
      ['質問', formatNumber(items.length - corrections.length)],
      ['未分析のターン', formatNumber(pendingCount)],
      ['分析にかかった費用', formatUsd(reviewCost)],
      ['単価が不明なリクエスト', formatNumber(totals.unpricedRequests)],
      ['解釈できなかった履歴の行', formatNumber(totals.unreadableLines)],
    ],
  );
}

function reviewSection(rows: readonly { session: SessionSummary; item: ReviewItem }[], pendingCount: number): string {
  const body = rows.map(({ session, item }) => [
    formatDateTime(item.at),
    esc(KIND_LABELS[item.kind]),
    esc(item.summary),
    esc(item.response),
    esc(RESOLUTION_LABELS[item.resolved]),
    esc(sessionTitle(session)),
    String(item.turn),
    `<details><summary>表示</summary><blockquote>${esc(item.quote)}</blockquote></details>`,
  ]);
  return `<p class="note">分類と要約はモデルによるもので、誤りや漏れがあります。発言の原文は履歴から取っています。未分析のターン（${formatNumber(pendingCount)} 件）は含みません。</p>
${table([{ label: '日時', num: true }, { label: '種類', short: true }, { label: '発言の要点' }, { label: '対応・回答' }, { label: '状況', short: true }, { label: 'セッション' }, { label: 'ターン', num: true }, { label: '原文', short: true }], body)}`;
}

function turnsTable(turns: readonly { turn: TurnSummary; number: number }[], items: readonly ReviewItem[]): string {
  return table(
    [{ label: '#', num: true }, { label: '開始', num: true }, { label: '発言' }, { label: '指摘・質問' }, { label: 'コスト', num: true }, { label: '入力', num: true }, { label: '出力', num: true }, { label: 'キャッシュ読取', num: true }, { label: 'キャッシュ書込', num: true }, { label: 'コンテキスト', num: true }, { label: 'リクエスト', num: true }, { label: 'ツール', num: true }, { label: '変更行', num: true }],
    turns.map(({ turn, number }) => [
      String(number),
      formatDateTime(turn.startedAt),
      esc(turn.prompt),
      esc(
        items
          .filter((item) => item.turn === number)
          .map((item) => KIND_LABELS[item.kind])
          .join('、'),
      ),
      formatUsd(turn.costUsd),
      formatNumber(turn.tokens.input),
      formatNumber(turn.tokens.output),
      formatNumber(turn.tokens.cacheRead),
      formatNumber(turn.tokens.cacheWrite),
      formatNumber(turn.contextTokens),
      formatNumber(turn.requests),
      formatNumber(turn.tools),
      `+${formatNumber(turn.linesAdded)} / −${formatNumber(turn.linesRemoved)}`,
    ]),
  );
}

/**
 * レポートの HTML を作る。毎回同じ形式になるよう、モデルは使わず、コードの決まった手順だけで組み立てる。
 * 入力が同じなら出力は完全に一致する。スクリプトも外部のファイルも読み込まず、単体で開ける。
 */
export function buildReport(input: ReportInput): string {
  const { filter } = input;
  const today = localDay(input.generatedAt);
  const target = filter.sessionKey === null ? undefined : input.sessions.find((session) => sessionKey(session) === filter.sessionKey);
  const days = target || filter.sessionKey !== null ? null : filter.days;
  const scoped = filter.sessionKey !== null ? (target ? [target] : []) : input.sessions;
  const totals = aggregate(scoped, { days, project: filter.sessionKey !== null ? null : filter.project, today });
  const start = days === null ? undefined : addDays(today, -(days - 1));
  const inWindow = (epochMs: number) => start === undefined || localDay(epochMs) >= start;
  // 最後の活動が新しい順。同時刻でも順序が変わらないよう、キーでも並べる
  const sessions = totals.rows.map((row) => row.session).sort((a, b) => b.endedAt - a.endedAt || sessionKey(a).localeCompare(sessionKey(b)));

  const reviewRows = sessions
    .flatMap((session) => (input.reviews[sessionKey(session)]?.items ?? []).filter((item) => inWindow(item.at)).map((item) => ({ session, item })))
    .sort((a, b) => a.item.at - b.item.at || sessionKey(a.session).localeCompare(sessionKey(b.session)) || a.item.turn - b.item.turn || a.item.kind.localeCompare(b.item.kind));
  const pendingCount = sessions.reduce((sum, session) => sum + (input.pending[sessionKey(session)] ?? 0), 0);
  const { scope, period } = scopeLabel(input, target);

  const turnBlocks = sessions
    .map((session) => {
      const turns = session.turns.map((turn, index) => ({ turn, number: index + 1 })).filter(({ turn }) => inWindow(turn.startedAt || session.startedAt));
      return `<h3>${esc(sessionTitle(session))}（${esc(projectLabel(session))}）</h3>\n${turnsTable(turns, input.reviews[sessionKey(session)]?.items ?? [])}`;
    })
    .join('\n');

  const sections = [
    overviewSection(input, totals, reviewRows.map((row) => row.item), pendingCount),
    reviewSection(reviewRows, pendingCount),
    table([{ label: '日付', short: true }, { label: 'コスト', num: true }], totals.days.map((day) => [day.date, formatUsd(day.costUsd)])),
    table(
      [{ label: 'モデル' }, { label: 'コスト', num: true }, { label: 'リクエスト', num: true }, { label: 'トークン', num: true }],
      [...totals.models].sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model)).map((model) => [esc(model.model), formatUsd(model.costUsd), formatNumber(model.requests), formatNumber(totalTokens(model.tokens))]),
    ),
    table(
      [{ label: 'プロジェクト' }, { label: 'パス' }, { label: 'コスト', num: true }, { label: 'セッション', num: true }],
      [...totals.projects].sort((a, b) => b.costUsd - a.costUsd || a.projectDir.localeCompare(b.projectDir)).map((project) => [esc(project.label), esc(project.path), formatUsd(project.costUsd), formatNumber(project.sessions)]),
    ),
    table(
      [{ label: 'セッション' }, { label: 'プロジェクト' }, { label: '最後の活動', num: true }, { label: 'ターン', num: true }, { label: 'コスト', num: true }, { label: '指摘', num: true }, { label: '質問', num: true }, { label: '未分析', num: true }],
      sessions.map((session) => {
        const row = totals.rows.find((candidate) => candidate.session === session);
        const items = input.reviews[sessionKey(session)]?.items ?? [];
        const corrections = items.filter((item) => item.kind === 'correction').length;
        return [esc(sessionTitle(session)), esc(projectLabel(session)), formatDateTime(session.endedAt), formatNumber(row?.turns ?? 0), formatUsd(row?.costUsd ?? 0), formatNumber(corrections), formatNumber(items.length - corrections), formatNumber(input.pending[sessionKey(session)] ?? 0)];
      }),
    ),
    turnBlocks || turnsTable([], []),
  ];

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>CC Session Usage レポート</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<h1>CC Session Usage レポート</h1>
<dl>
<dt>対象</dt><dd>${esc(scope)}</dd>
<dt>期間</dt><dd>${esc(period)}</dd>
<dt>作成日時</dt><dd>${formatDateTime(input.generatedAt)}</dd>
<dt>単価の基準日</dt><dd>${esc(input.pricesAsOf)}</dd>
</dl>
<p class="note">金額は Claude Code の履歴から計算した定価換算の推定で、実際の請求額ではありません。発言の内容を含むので、共有するときは内容を確認してください。</p>
${sections.map((html, index) => section(index, html)).join('\n')}
<footer>CC Session Usage ・ レポート形式 ${REPORT_FORMAT_VERSION}</footer>
</main>
</body>
</html>
`;
}

export function reportFileName(generatedAt: number): string {
  return `cc-session-usage-report-${localDay(generatedAt)}.html`;
}
