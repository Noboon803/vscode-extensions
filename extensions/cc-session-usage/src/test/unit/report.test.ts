import * as assert from 'node:assert';
import { buildReport, REPORT_FORMAT_VERSION, REPORT_SECTIONS, type ReportInput, reportFileName } from '../../report';
import type { ReviewItem, SessionReview, SessionSummary } from '../../types';

const NOW = new Date(2026, 10, 3, 12, 0).getTime();
const at = (days: number) => NOW - days * 24 * 60 * 60 * 1000;
const TOKENS = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const day = (epochMs: number) => {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

function session(id: string, startedAt: number, prompt = '依頼', extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    projectDir: 'proj',
    cwd: '/work/proj',
    title: `セッション${id}`,
    startedAt,
    endedAt: startedAt,
    turns: [{ startedAt, prompt, requests: 1, tools: 2, tokens: TOKENS, contextTokens: 5, costUsd: 1.5, subagentCostUsd: 0, linesAdded: 3, linesRemoved: 1, filesChanged: 1 }],
    daily: [{ date: day(startedAt), model: 'claude-opus-5-5', requests: 1, tokens: TOKENS, costUsd: 1.5 }],
    computedCostUsd: 1.5,
    unpricedRequests: 0,
    unreadableLines: 0,
    ...extra,
  };
}

function item(extra: Partial<ReviewItem> = {}): ReviewItem {
  return { turn: 1, kind: 'correction', quote: '原文', summary: '要点', response: '対応', resolved: 'yes', at: at(1), ...extra };
}

function review(items: ReviewItem[]): SessionReview {
  return { analyzedTurns: 1, items, costUsd: 0.01, rejectedItems: 0 };
}

function input(extra: Partial<ReportInput> = {}): ReportInput {
  return { sessions: [], reviews: {}, pending: {}, filter: { days: null, project: null, sessionKey: null }, generatedAt: NOW, pricesAsOf: '2026-10-06', ...extra };
}

/** 文字の内容を除いた構成。セクションの見出しと表の列を順に並べる */
function skeleton(html: string): string[] {
  return [...html.matchAll(/<h2>[^<]*<\/h2>|<thead>.*?<\/thead>/g)].map((match) => match[0]);
}

suite('buildReport', () => {
  test('データがなくても、すべてのセクションを決まった順に出す', () => {
    const html = buildReport(input());
    const headings = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((match) => match[1]);
    assert.deepStrictEqual(headings, REPORT_SECTIONS.map((name, index) => `${index + 1}. ${name}`));
    assert.ok(html.includes('該当なし'));
  });

  test('データの量が違っても、見出しと表の列は同じ', () => {
    const empty = skeleton(buildReport(input()));
    const filled = skeleton(buildReport(input({ sessions: [session('a', at(1))], reviews: { 'proj/a': review([item()]) } })));
    assert.deepStrictEqual(filled, empty);
  });

  test('対象と時刻が同じなら、出力は完全に一致する', () => {
    const data = input({ sessions: [session('a', at(1)), session('b', at(1))], reviews: { 'proj/b': review([item({ kind: 'question' }), item()]) } });
    const reversed = { ...data, sessions: [...data.sessions].reverse() };
    assert.strictEqual(buildReport(data), buildReport(reversed));
  });

  test('履歴の本文を HTML として解釈させない', () => {
    const attack = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const html = buildReport(input({ sessions: [session('a', at(1), attack, { title: attack })], reviews: { 'proj/a': review([item({ quote: attack, summary: attack, response: attack })]) } }));
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('単体で開け、スクリプトと外部の読み込みを CSP で禁止する', () => {
    const html = buildReport(input({ sessions: [session('a', at(1))] }));
    assert.ok(html.includes(`default-src 'none'; style-src 'unsafe-inline'`));
    assert.ok(!/\s(src|href)=/.test(html));
  });

  test('指摘と質問を、要点、対応、原文つきで時刻順に載せる', () => {
    const html = buildReport(input({ sessions: [session('a', at(1))], reviews: { 'proj/a': review([item({ turn: 2, summary: '後の指摘', at: at(1) }), item({ kind: 'question', summary: '先の質問', response: '回答', quote: '質問の原文', at: at(2) })]) } }));
    assert.ok(html.indexOf('先の質問') < html.indexOf('後の指摘'));
    assert.ok(html.includes('回答') && html.includes('質問の原文'));
  });

  test('期間とプロジェクトで絞り込み、対象を見出しに書く', () => {
    const data = { sessions: [session('old', at(40)), session('new', at(1)), session('other', at(1), '依頼', { projectDir: 'x', cwd: '/work/x' })] };
    const html = buildReport(input({ ...data, filter: { days: 30, project: 'proj', sessionKey: null } }));
    assert.ok(html.includes('セッションnew'));
    assert.ok(!html.includes('セッションold'));
    assert.ok(!html.includes('セッションother'));
    assert.ok(html.includes('プロジェクト: proj'));
    assert.ok(html.includes('直近 30 日'));
  });

  test('セッションを指定すると、そのセッションだけを全期間で載せる', () => {
    const html = buildReport(input({ sessions: [session('old', at(40)), session('new', at(1))], filter: { days: 7, project: 'none', sessionKey: 'proj/old' } }));
    assert.ok(html.includes('セッション: セッションold'));
    assert.ok(!html.includes('セッションnew'));
  });

  test('未分析のターンの数を載せる', () => {
    const html = buildReport(input({ sessions: [session('a', at(1))], pending: { 'proj/a': 7 } }));
    assert.ok(html.includes('未分析のターン（7 件）'));
  });

  test('形式の番号とファイル名を決まった形で出す', () => {
    assert.ok(buildReport(input()).includes(`レポート形式 ${REPORT_FORMAT_VERSION}`));
    assert.strictEqual(reportFileName(NOW), 'cc-session-usage-report-2026-11-03.html');
  });
});
