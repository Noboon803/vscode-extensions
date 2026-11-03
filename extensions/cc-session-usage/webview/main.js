import { aggregate, isAutomated, projectLabel, sessionCost, sessionKey, sessionTitle, sumTurns, totalTokens, unallocatedCost } from '../src/aggregate';
import { localDay } from '../src/dates';
import { formatCount, formatUsd } from '../src/format';

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const tooltip = document.getElementById('tooltip');
const SVG_NS = 'http://www.w3.org/2000/svg';
const PERIODS = [
  { label: '7日', days: 7 },
  { label: '30日', days: 30 },
  { label: '90日', days: 90 },
  { label: '全期間', days: null },
];
const CHART_HEIGHT = 170;
const AXIS_LEFT = 52;
const AXIS_BOTTOM = 22;
const AXIS_TOP = 8;
const MAX_BAR_WIDTH = 28;
const BAR_GAP = 2;
/** 棒が多いときは、Tab キーで 1 本ずつ移動させず、下の表で読めるようにする */
const MAX_FOCUSABLE_BARS = 60;
const TOOLTIP_PROMPT_LENGTH = 60;
const MAX_REVIEW_ROWS = 500;
const REVIEW_KINDS = [
  { value: 'all', label: 'すべて' },
  { value: 'correction', label: '指摘' },
  { value: 'question', label: '質問' },
];
const KIND_LABELS = { correction: '指摘', question: '質問' };
const RESOLUTION_LABELS = { yes: '対応済み', partial: '一部のみ', no: '未対応', unknown: '不明' };

const saved = vscode.getState() ?? {};
const state = {
  snapshot: undefined,
  pricesAsOf: undefined,
  days: saved.days === undefined ? 30 : saved.days,
  project: saved.project ?? null,
  sessionKey: saved.sessionKey ?? null,
  sortKey: saved.sortKey ?? 'date',
  review: undefined,
  /** 一覧画面のタブ。usage は使用量、review は指摘と質問 */
  tab: saved.tab === 'review' ? 'review' : 'usage',
  reviewKind: saved.reviewKind ?? 'all',
  reviewSearch: '',
  loading: false,
  dailyTableOpen: false,
  highlightTurn: null,
  /** 同じ内容で描き直さないよう、前回受け取ったデータを覚えておく */
  lastData: '',
};

/** 履歴の本文はそのまま表示するので、HTML として解釈させないよう textContent だけを使う */
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onClick') {
      element.addEventListener('click', value);
    } else if (key === 'onChange') {
      element.addEventListener('change', value);
    } else if (key === 'onInput') {
      element.addEventListener('input', value);
    } else if (key === 'onToggle') {
      element.addEventListener('toggle', value);
    } else if (key === 'className') {
      element.className = value;
    } else if (value !== undefined && value !== false) {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child !== undefined && child !== null && child !== false) {
      element.append(child);
    }
  }
  return element;
}

function svg(tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function formatSignedCount(value) {
  if (value === 0) {
    return '±0';
  }
  return `${value > 0 ? '+' : '−'}${formatCount(Math.abs(value))}`;
}

/** 金額の増減。1 セント未満の差は読んでも意味がないので、変化なしとして見せる */
function formatUsdDelta(value) {
  if (Math.abs(value) < 0.01) {
    return '±$0';
  }
  return `${value > 0 ? '+' : '−'}${formatUsd(Math.abs(value))}`;
}

function formatDateTime(epochMs) {
  if (!epochMs) {
    return '不明';
  }
  return new Date(epochMs).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTime(epochMs) {
  if (!epochMs) {
    return '';
  }
  return new Date(epochMs).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function shortDay(date) {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function persist() {
  vscode.setState({ days: state.days, project: state.project, sessionKey: state.sessionKey, sortKey: state.sortKey, tab: state.tab, reviewKind: state.reviewKind });
}

function showTooltip(event, title, value) {
  tooltip.replaceChildren(h('div', { className: 'tip-title' }, title), h('div', { className: 'tip-value' }, value));
  tooltip.hidden = false;
  const anchor = event.target.getBoundingClientRect();
  const box = tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(anchor.left + anchor.width / 2 - box.width / 2, 8), window.innerWidth - box.width - 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max((event.clientY || anchor.top) - box.height - 12, 8)}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

/** 軸の目盛りが切りのよい値になるように、最大値を切り上げる */
function niceMax(value) {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = [1, 2, 2.5, 5, 10].find((candidate) => normalized <= candidate);
  return step * magnitude;
}

/** 棒グラフを描く。items は { label, title, value, text } */
function barChart(items, formatTick) {
  const container = h('div', { className: 'chart' });
  const draw = () => {
    const width = container.clientWidth;
    if (width === 0) {
      return;
    }
    const root = svg('svg', { height: CHART_HEIGHT, viewBox: `0 0 ${width} ${CHART_HEIGHT}`, role: 'img' });
    const plotWidth = width - AXIS_LEFT;
    const plotBottom = CHART_HEIGHT - AXIS_BOTTOM;
    const plotHeight = plotBottom - AXIS_TOP;
    const max = niceMax(Math.max(...items.map((item) => item.value), 0));

    for (const ratio of [0, 0.5, 1]) {
      const y = plotBottom - plotHeight * ratio;
      root.append(svg('line', { class: 'grid', x1: AXIS_LEFT, x2: width, y1: y, y2: y }));
      const tick = svg('text', { class: 'tick', x: AXIS_LEFT - 6, y: y + 4, 'text-anchor': 'end' });
      tick.textContent = formatTick(max * ratio);
      root.append(tick);
    }

    const slot = plotWidth / Math.max(items.length, 1);
    const barWidth = Math.max(Math.min(slot - BAR_GAP, MAX_BAR_WIDTH), 1);
    const labelEvery = Math.max(Math.ceil(items.length / Math.max(Math.floor(plotWidth / 56), 1)), 1);
    items.forEach((item, index) => {
      const center = AXIS_LEFT + slot * index + slot / 2;
      const group = svg('g', { class: 'column' });
      if (item.value > 0) {
        const barHeight = Math.max((item.value / max) * plotHeight, 1);
        const left = center - barWidth / 2;
        const top = plotBottom - barHeight;
        const radius = Math.min(4, barWidth / 2, barHeight);
        group.append(
          svg('path', {
            class: 'bar',
            d: `M${left} ${plotBottom}V${top + radius}Q${left} ${top} ${left + radius} ${top}H${left + barWidth - radius}Q${left + barWidth} ${top} ${left + barWidth} ${top + radius}V${plotBottom}Z`,
          }),
        );
      }
      // 棒の高さに関係なく指せるよう、列全体を当たり判定にする
      const hit = svg('rect', { class: 'hit', x: AXIS_LEFT + slot * index, y: AXIS_TOP, width: slot, height: plotHeight, 'aria-label': `${item.title} ${item.text}` });
      if (items.length <= MAX_FOCUSABLE_BARS) {
        hit.setAttribute('tabindex', '0');
      }
      const show = (event) => showTooltip(event, item.title, item.text);
      hit.addEventListener('mousemove', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', hideTooltip);
      hit.addEventListener('blur', hideTooltip);
      group.append(hit);
      root.append(group);
      if (index % labelEvery === 0) {
        const label = svg('text', { class: 'tick', x: center, y: CHART_HEIGHT - 6, 'text-anchor': 'middle' });
        label.textContent = item.label;
        root.append(label);
      }
    });
    container.replaceChildren(root);
  };
  new ResizeObserver(draw).observe(container);
  return container;
}

function tile(label, value, detail) {
  return h('div', { className: 'tile' }, h('div', { className: 'label' }, label), h('div', { className: 'value' }, value), detail ? h('div', { className: 'detail' }, detail) : null);
}

function dataTable(headers, rows, footer) {
  return h(
    'div',
    { className: 'table-scroll' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, headers.map((header) => h('th', { className: header.num ? 'num' : undefined, scope: 'col' }, header.label)))),
      h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((cell, index) => h('td', { className: headers[index].className ?? (headers[index].num ? 'num' : undefined) }, cell))))),
      footer ? h('tfoot', {}, h('tr', {}, footer.map((cell, index) => h('td', { className: headers[index].className ?? (headers[index].num ? 'num' : undefined) }, cell)))) : null,
    ),
  );
}

function meterCell(text, value, max) {
  const meter = h('div', { className: 'meter' });
  meter.style.width = `${max > 0 ? Math.max((value / max) * 100, 1) : 0}%`;
  return [text, meter];
}

function warnings(totals) {
  const messages = [];
  if (state.snapshot.error) {
    messages.push(state.snapshot.error);
  }
  if (totals?.unpricedRequests > 0) {
    messages.push(`単価が分からないモデルのリクエストが ${totals.unpricedRequests} 件あり、計算値に含めていません。`);
  }
  if (totals?.unreadableLines > 0) {
    messages.push(`解釈できない行が ${totals.unreadableLines} 行あります。Claude Code の更新で履歴の形式が変わった可能性があります。`);
  }
  return messages.map((message) => h('div', { className: 'banner', role: 'alert' }, `注意: ${message}`));
}

function refreshButton() {
  return h('button', { type: 'button', disabled: state.loading, onClick: requestRefresh }, state.loading ? '読み込み中…' : '再読み込み');
}

function requestRefresh() {
  state.loading = true;
  render();
  vscode.postMessage({ type: 'refresh' });
}

function renderTabs() {
  const tabs = [
    { value: 'usage', label: '使用量' },
    { value: 'review', label: '指摘と質問' },
  ];
  return h(
    'div',
    { className: 'segmented tabs', role: 'group', 'aria-label': '表示する内容' },
    tabs.map((tab) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(state.tab === tab.value),
          onClick: () => {
            state.tab = tab.value;
            persist();
            render();
          },
        },
        tab.label,
      ),
    ),
  );
}

function pendingTotal() {
  return Object.values(state.review?.pending ?? {}).reduce((sum, count) => sum + count, 0);
}

function reviewStatus() {
  return [
    state.review?.busy ? h('p', { className: 'banner', role: 'status' }, state.review.busy) : null,
    state.review?.error ? h('p', { className: 'banner', role: 'alert' }, `分析結果を読めませんでした: ${state.review.error}`) : null,
  ].filter(Boolean);
}

function openTurn(key, turn) {
  state.sessionKey = key;
  state.highlightTurn = turn - 1;
  persist();
  render();
  highlightedTurnRow()?.scrollIntoView({ block: 'center' });
}

function reviewItem(session, item, showSession) {
  const key = sessionKey(session);
  return h(
    'article',
    { className: `review-item ${item.kind}` },
    h('p', { className: 'review-summary' }, h('span', { className: 'kind' }, KIND_LABELS[item.kind]), item.summary),
    h('p', {}, h('span', { className: 'subtle' }, item.kind === 'correction' ? '対応: ' : '回答: '), item.response),
    h('details', {}, h('summary', { className: 'subtle' }, '発言の原文'), h('blockquote', {}, item.quote)),
    h(
      'p',
      { className: 'note' },
      `${RESOLUTION_LABELS[item.resolved] ?? item.resolved} ・ `,
      showSession ? [h('button', { type: 'button', className: 'link', onClick: () => openTurn(key, item.turn) }, `${sessionTitle(session)} のターン ${item.turn}`), ` ・ ${projectLabel(session)} ・ `] : h('button', { type: 'button', className: 'link', onClick: () => openTurn(key, item.turn) }, `ターン ${item.turn}`),
      showSession ? '' : ' ・ ',
      formatDateTime(item.at),
    ),
  );
}

function reviewRows() {
  const search = state.reviewSearch.trim().toLowerCase();
  const rows = [];
  // 履歴が消えて選択中のプロジェクトがなくなっても、理由なく空にしない
  const projectFilter = state.snapshot.sessions.some((session) => session.projectDir === state.project) ? state.project : null;
  for (const session of state.snapshot.sessions) {
    if (projectFilter && session.projectDir !== projectFilter) {
      continue;
    }
    for (const item of state.review?.sessions[sessionKey(session)]?.items ?? []) {
      if (state.reviewKind !== 'all' && item.kind !== state.reviewKind) {
        continue;
      }
      if (search && ![item.summary, item.response, item.quote].some((text) => text.toLowerCase().includes(search))) {
        continue;
      }
      rows.push({ session, item });
    }
  }
  return rows.sort((a, b) => b.item.at - a.item.at);
}

function reviewListNodes() {
  const rows = reviewRows();
  const nodes = rows.slice(0, MAX_REVIEW_ROWS).map(({ session, item }) => reviewItem(session, item, true));
  if (rows.length > MAX_REVIEW_ROWS) {
    nodes.push(h('p', { className: 'note' }, `新しい ${MAX_REVIEW_ROWS} 件を表示しています（全 ${rows.length} 件）。絞り込むと残りも確認できます。`));
  }
  if (rows.length === 0) {
    const analyzed = Object.keys(state.review?.sessions ?? {}).length > 0;
    nodes.push(h('p', { className: 'empty' }, analyzed ? '条件に合う項目はありません。' : 'まだ分析していません。「未分析のターンを分析」を押すと、費用の目安を確認したうえで、ユーザーの指摘と質問、それへの対応をここに一覧にします。'));
  }
  return nodes;
}

function renderReviewOverview() {
  const { snapshot, review } = state;
  const pending = pendingTotal();
  const all = Object.values(review?.sessions ?? {});
  const items = all.flatMap((entry) => entry.items);
  const corrections = items.filter((item) => item.kind === 'correction').length;
  const cost = all.reduce((sum, entry) => sum + entry.costUsd, 0);
  const projects = aggregate(snapshot.sessions, { days: null, project: null, today: localDay(Date.now()) }).projects.sort((a, b) => a.label.localeCompare(b.label));
  return [
    h('h1', {}, '指摘と質問'),
    h('p', { className: 'note' }, 'ターンのうち、エージェントへの指摘と質問を抽出し、それへの対応や回答と並べます。分類と要約はモデルによるもので、誤りや漏れがあります。判断するときは発言の原文を確認してください。'),
    h('p', { className: 'note' }, `指摘 ${corrections} 件 ・ 質問 ${items.length - corrections} 件 ・ 分析の費用 ${formatUsd(cost)} ・ 未分析のターン ${pending} 件`),
    ...reviewStatus(),
    h(
      'div',
      { className: 'toolbar' },
      h(
        'div',
        { className: 'segmented', role: 'group', 'aria-label': '種類' },
        REVIEW_KINDS.map((kind) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(state.reviewKind === kind.value),
              onClick: () => {
                state.reviewKind = kind.value;
                persist();
                render();
              },
            },
            kind.label,
          ),
        ),
      ),
      h(
        'select',
        {
          'aria-label': 'プロジェクト',
          onChange: (event) => {
            state.project = event.target.value || null;
            persist();
            render();
          },
        },
        h('option', { value: '', selected: !state.project }, 'すべてのプロジェクト'),
        projects.map((project) => h('option', { value: project.projectDir, selected: project.projectDir === state.project, title: project.path }, project.label)),
      ),
      h('input', {
        type: 'search',
        placeholder: '検索',
        'aria-label': '検索',
        value: state.reviewSearch,
        onInput: (event) => {
          state.reviewSearch = event.target.value;
          document.getElementById('review-list')?.replaceChildren(...reviewListNodes());
        },
      }),
      h('span', { className: 'spacer' }),
      h('button', { type: 'button', disabled: pending === 0 || Boolean(review?.busy), title: '実行前に費用の目安を確認します', onClick: () => vscode.postMessage({ type: 'analyze' }) }, pending > 0 ? `未分析のターン ${pending} 件を分析` : '未分析のターンなし'),
    ),
    h('section', { id: 'review-list' }, reviewListNodes()),
  ];
}

function renderSessionReview(session) {
  const key = sessionKey(session);
  const entry = state.review?.sessions[key];
  const pending = state.review?.pending[key] ?? 0;
  const items = [...(entry?.items ?? [])].sort((a, b) => a.turn - b.turn);
  const corrections = items.filter((item) => item.kind === 'correction').length;
  let message;
  if (entry && items.length === 0) {
    message = '分析したターンに、指摘と質問は見つかりませんでした。';
  } else if (!entry) {
    if (pending > 0) {
      message = 'まだ分析していません。分析すると、ユーザーの指摘と質問、それへの対応をここに一覧にします。';
    } else if (isAutomated(session)) {
      message = '自動実行のセッションは分析の対象外です。';
    } else if (session.transcriptRemoved) {
      message = '元の履歴が削除されているため、分析できません。';
    } else {
      message = '応答中かもしれない最後のターンは、最後の更新から 10 分たつと分析できます。';
    }
  }
  return h(
    'section',
    { id: 'session-review' },
    h(
      'div',
      { className: 'toolbar' },
      h('h2', {}, '指摘と質問'),
      h('span', { className: 'spacer' }),
      pending > 0 ? h('button', { type: 'button', disabled: Boolean(state.review?.busy), title: '実行前に費用の目安を確認します', onClick: () => vscode.postMessage({ type: 'analyze', sessionKey: key }) }, `未分析のターン ${pending} 件を分析`) : null,
    ),
    entry && items.length > 0 ? h('p', { className: 'note' }, `指摘 ${corrections} 件 ・ 質問 ${items.length - corrections} 件 ・ 分析の費用 ${formatUsd(entry.costUsd)}。分類と要約はモデルによるもので、誤りや漏れがあります。`) : null,
    entry?.rejectedItems ? h('p', { className: 'note' }, `モデルの出力のうち ${entry.rejectedItems} 件は、検証を通らなかったため除外しました。`) : null,
    ...reviewStatus(),
    message ? h('p', { className: 'note' }, message) : null,
    items.map((item) => reviewItem(session, item, false)),
  );
}

function renderOverview() {
  const { snapshot } = state;
  const today = localDay(Date.now());
  const projectFilter = snapshot.sessions.some((session) => session.projectDir === state.project) ? state.project : null;
  const totals = aggregate(snapshot.sessions, { days: state.days, project: projectFilter, today });
  const everyProject = aggregate(snapshot.sessions, { days: null, project: null, today }).projects.sort((a, b) => a.label.localeCompare(b.label));

  const children = [
    h('h1', {}, 'CC Session Usage'),
    h('p', { className: 'note' }, `Claude Code の履歴から計算した定価換算の推定です（単価は ${state.pricesAsOf} 時点）。実際の請求額ではなく、定額プランの請求とも関係ありません。`),
    h(
      'div',
      { className: 'toolbar' },
      h(
        'div',
        { className: 'segmented', role: 'group', 'aria-label': '期間' },
        PERIODS.map((period) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(state.days === period.days),
              onClick: () => {
                state.days = period.days;
                persist();
                render();
              },
            },
            period.label,
          ),
        ),
      ),
      h(
        'select',
        {
          'aria-label': 'プロジェクト',
          onChange: (event) => {
            state.project = event.target.value || null;
            persist();
            render();
          },
        },
        h('option', { value: '', selected: projectFilter === null }, 'すべてのプロジェクト'),
        everyProject.map((project) => h('option', { value: project.projectDir, selected: projectFilter === project.projectDir, title: project.path }, project.label)),
      ),
      h('span', { className: 'spacer' }),
      snapshot.updatedAt ? h('span', { className: 'subtle' }, `更新 ${formatTime(snapshot.updatedAt)}`) : null,
      refreshButton(),
    ),
    ...warnings(totals),
  ];

  if (totals.rows.length === 0) {
    children.push(
      h('p', { className: 'empty' }, state.loading ? '履歴を読み込んでいます…' : `この条件のセッションはありません。履歴フォルダ: ${snapshot.configDir}/projects`),
    );
    return children;
  }

  children.push(
    h(
      'div',
      { className: 'tiles' },
      tile('コスト（定価換算）', formatUsd(totals.costUsd), totals.unallocatedUsd > 0 ? `うち未割当 ${formatUsd(totals.unallocatedUsd)}` : undefined),
      tile('セッション', String(totals.sessions), `${totals.turns} ターン`),
      tile('出力トークン', formatCount(totals.tokens.output)),
      tile('キャッシュ読み取り', formatCount(totals.tokens.cacheRead), `書き込み ${formatCount(totals.tokens.cacheWrite)}`),
      tile('変更行数', `+${formatCount(totals.linesAdded)}`, `−${formatCount(totals.linesRemoved)} 行（Bash での編集を除く）`),
    ),
    h(
      'section',
      {},
      h('h2', {}, '日別のコスト'),
      barChart(
        totals.days.map((day) => ({ label: shortDay(day.date), title: day.date, value: day.costUsd, text: formatUsd(day.costUsd) })),
        formatUsd,
      ),
      h(
        'details',
        {
          open: state.dailyTableOpen,
          onToggle: (event) => {
            state.dailyTableOpen = event.target.open;
          },
        },
        h('summary', {}, '表で見る'),
        dataTable(
          [{ label: '日付' }, { label: 'コスト', num: true }],
          totals.days.filter((day) => day.costUsd > 0).map((day) => [day.date, formatUsd(day.costUsd)]),
        ),
      ),
    ),
    h(
      'div',
      { className: 'columns' },
      h('section', {}, h('h2', {}, 'モデル別'), modelTable(totals)),
      h('section', {}, h('h2', {}, 'プロジェクト別'), projectTable(totals)),
    ),
    h('section', {}, h('h2', {}, 'セッション'), sessionTable(totals)),
  );
  return children;
}

function modelTable(totals) {
  const max = totals.models[0]?.costUsd ?? 0;
  const rows = totals.models.map((model) => [meterCell(model.model, model.costUsd, max), formatUsd(model.costUsd), formatCount(model.requests)]);
  if (totals.unallocatedUsd > 0) {
    rows.push([h('span', { title: '裏側のリクエストなど、履歴に記録されない分です' }, '未割当'), formatUsd(totals.unallocatedUsd), '—']);
  }
  return dataTable([{ label: 'モデル', className: 'name' }, { label: 'コスト', num: true }, { label: 'リクエスト', num: true }], rows);
}

function projectTable(totals) {
  const max = totals.projects[0]?.costUsd ?? 0;
  return dataTable(
    [{ label: 'プロジェクト', className: 'name' }, { label: 'コスト', num: true }, { label: 'セッション', num: true }],
    totals.projects.map((project) => [
      meterCell(
        h(
          'button',
          {
            type: 'button',
            className: 'link',
            title: project.path,
            onClick: () => {
              state.project = project.projectDir;
              persist();
              render();
            },
          },
          project.label,
        ),
        project.costUsd,
        max,
      ),
      formatUsd(project.costUsd),
      String(project.sessions),
    ]),
  );
}

const SESSION_SORTS = {
  date: (a, b) => b.session.endedAt - a.session.endedAt,
  cost: (a, b) => b.costUsd - a.costUsd,
  turns: (a, b) => b.turns - a.turns,
};

function sortHeader(label, key) {
  return h(
    'th',
    { className: `num${state.sortKey === key ? ' sorted' : ''}`, scope: 'col', 'aria-sort': state.sortKey === key ? 'descending' : undefined },
    h(
      'button',
      {
        type: 'button',
        onClick: () => {
          state.sortKey = key;
          persist();
          render();
        },
      },
      `${label}${state.sortKey === key ? ' ↓' : ''}`,
    ),
  );
}

function sessionTable(totals) {
  const rows = [...totals.rows].sort(SESSION_SORTS[state.sortKey] ?? SESSION_SORTS.date);
  return h(
    'div',
    { className: 'table-scroll' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h('tr', {}, h('th', { scope: 'col' }, 'セッション'), h('th', { scope: 'col' }, 'プロジェクト'), sortHeader('最終活動', 'date'), sortHeader('ターン', 'turns'), sortHeader('コスト', 'cost')),
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            {},
            h(
              'td',
              { className: 'prompt' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'link clamp',
                  title: row.label,
                  onClick: () => {
                    state.sessionKey = sessionKey(row.session);
                    state.highlightTurn = null;
                    persist();
                    render();
                    window.scrollTo(0, 0);
                  },
                },
                row.label,
              ),
              isAutomated(row.session) ? h('span', { className: 'badge' }, '自動実行') : null,
              row.session.transcriptRemoved ? h('span', { className: 'badge' }, '履歴削除済み') : null,
            ),
            h('td', {}, row.projectLabel),
            h('td', { className: 'num' }, formatDateTime(row.session.endedAt)),
            h('td', { className: 'num' }, String(row.turns)),
            h('td', { className: 'num' }, formatUsd(row.costUsd)),
          ),
        ),
      ),
    ),
  );
}

function renderSession(session) {
  const total = sessionCost(session);
  const unallocated = unallocatedCost(session);
  const turns = session.turns;
  const peak = Math.max(...turns.map((turn) => turn.contextTokens), 0);
  const sums = sumTurns(turns);
  const children = [
    h(
      'div',
      { className: 'toolbar' },
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            state.sessionKey = null;
            state.highlightTurn = null;
            persist();
            render();
          },
        },
        '← 一覧へ戻る',
      ),
      h('span', { className: 'spacer' }),
      turns.length > 0
        ? h('button', { type: 'button', onClick: () => document.getElementById('session-review')?.scrollIntoView() }, `指摘と質問（${state.review?.sessions[sessionKey(session)]?.items.length ?? 0} 件）へ移動`)
        : null,
      refreshButton(),
    ),
    h('h1', {}, sessionTitle(session)),
    h(
      'p',
      { className: 'note' },
      `${projectLabel(session)} ・ ${formatDateTime(session.startedAt)} 〜 ${formatDateTime(session.endedAt)}`,
      session.transcriptRemoved ? ' ・ 元の履歴は削除済みです（蓄積した集計を表示しています）' : '',
    ),
    ...warnings(session),
    h(
      'div',
      { className: 'tiles' },
      tile('コスト（定価換算）', formatUsd(total), unallocated > 0 ? `うち未割当 ${formatUsd(unallocated)}` : undefined),
      tile('ターン', String(turns.length), `${sums.requests} リクエスト`),
      tile(
        'トークン合計',
        formatCount(totalTokens(sums.tokens)),
        `入力 ${formatCount(sums.tokens.input)} ・ 出力 ${formatCount(sums.tokens.output)} ・ キャッシュ読取 ${formatCount(sums.tokens.cacheRead)} ・ 書込 ${formatCount(sums.tokens.cacheWrite)}`,
      ),
      tile('最大コンテキスト', formatCount(peak)),
      tile('変更行数', `+${formatCount(sums.linesAdded)}`, `−${formatCount(sums.linesRemoved)} 行（Bash での編集を除く）`),
    ),
  ];

  if (turns.length === 0) {
    children.push(h('p', { className: 'empty' }, 'このセッションには会話の本文が残っていないため、ターンごとの集計はありません。'));
    return children;
  }

  const items = (select, describe) =>
    turns.map((turn, index) => ({
      label: String(index + 1),
      title: `ターン ${index + 1}: ${turn.prompt.length > TOOLTIP_PROMPT_LENGTH ? `${turn.prompt.slice(0, TOOLTIP_PROMPT_LENGTH)}…` : turn.prompt}`,
      value: select(turn),
      text: describe(turn),
    }));

  if (unallocated > 0) {
    children.push(h('p', { className: 'note' }, `未割当の ${formatUsd(unallocated)} は、裏側のリクエストなど履歴に記録されない分と考えられ、ターンには含まれません。`));
  }
  children.push(
    h('section', {}, h('h2', {}, 'ターンごとのコスト'), barChart(items((turn) => turn.costUsd, (turn) => formatUsd(turn.costUsd)), formatUsd)),
    h(
      'section',
      {},
      h('h2', {}, 'ターンごとのトークン量'),
      h('p', { className: 'note' }, '入力、出力、キャッシュの読み書きの合計です。ツールを呼ぶたびに履歴を読み直すので、キャッシュ読み取りが大半を占めます。'),
      barChart(
        items(
          (turn) => totalTokens(turn.tokens),
          (turn) => `${formatCount(totalTokens(turn.tokens))}（入力 ${formatCount(turn.tokens.input)} / 出力 ${formatCount(turn.tokens.output)} / 読取 ${formatCount(turn.tokens.cacheRead)} / 書込 ${formatCount(turn.tokens.cacheWrite)}）`,
        ),
        formatCount,
      ),
    ),
    h('section', {}, h('h2', {}, 'ターン終了時のコンテキスト量（トークン）'), barChart(items((turn) => turn.contextTokens, (turn) => formatCount(turn.contextTokens)), formatCount)),
    renderSessionReview(session),
    h('section', { id: 'turn-list' }, h('h2', {}, 'ターン一覧'), turnTable(turns, state.review?.sessions[sessionKey(session)]?.items ?? [])),
  );
  return children;
}

function turnTable(turns, reviewItems) {
  const sums = sumTurns(turns);
  return dataTable(
    [
      { label: '#', num: true },
      { label: '開始', num: true },
      { label: '発言', className: 'prompt' },
      { label: 'コスト', num: true },
      { label: '前ターン比', num: true },
      { label: '入力', num: true },
      { label: '出力', num: true },
      { label: 'キャッシュ読取', num: true },
      { label: 'キャッシュ書込', num: true },
      { label: 'コンテキスト', num: true },
      { label: '増減', num: true },
      { label: 'リクエスト', num: true },
      { label: 'ツール', num: true },
      { label: '変更行', num: true },
    ],
    turns.map((turn, index) => {
      const previous = turns[index - 1];
      return [
        String(index + 1),
        formatTime(turn.startedAt),
        [turn.prompt, ...reviewItems.filter((item) => item.turn === index + 1).map((item) => h('span', { className: 'badge' }, KIND_LABELS[item.kind])), turn.subagentCostUsd > 0 ? h('span', { className: 'badge' }, `サブエージェント ${formatUsd(turn.subagentCostUsd)}`) : null],
        formatUsd(turn.costUsd),
        previous ? formatUsdDelta(turn.costUsd - previous.costUsd) : '—',
        formatCount(turn.tokens.input),
        formatCount(turn.tokens.output),
        formatCount(turn.tokens.cacheRead),
        formatCount(turn.tokens.cacheWrite),
        formatCount(turn.contextTokens),
        previous ? formatSignedCount(turn.contextTokens - previous.contextTokens) : '—',
        String(turn.requests),
        String(turn.tools),
        turn.linesAdded + turn.linesRemoved === 0 ? '—' : h('span', { title: `${turn.filesChanged} ファイル` }, `+${turn.linesAdded} / −${turn.linesRemoved}`),
      ];
    }),
    [
      '',
      '',
      '合計（未割当を除く）',
      formatUsd(sums.costUsd),
      '',
      formatCount(sums.tokens.input),
      formatCount(sums.tokens.output),
      formatCount(sums.tokens.cacheRead),
      formatCount(sums.tokens.cacheWrite),
      '',
      '',
      String(sums.requests),
      String(sums.tools),
      `+${sums.linesAdded} / −${sums.linesRemoved}`,
    ],
  );
}

function render() {
  hideTooltip();
  if (!state.snapshot) {
    app.replaceChildren(h('p', { className: 'empty' }, '履歴を読み込んでいます…'));
    return;
  }
  const selected = state.sessionKey ? state.snapshot.sessions.find((session) => sessionKey(session) === state.sessionKey) : undefined;
  if (selected) {
    app.replaceChildren(...renderSession(selected));
  } else {
    app.replaceChildren(renderTabs(), ...(state.tab === 'review' ? renderReviewOverview() : renderOverview()));
  }
  highlightedTurnRow()?.classList.add('highlight');
}

function highlightedTurnRow() {
  return state.highlightTurn === null ? null : document.querySelectorAll('#turn-list tbody tr')[state.highlightTurn];
}

function notifyRendered() {
  vscode.postMessage({ type: 'rendered', rows: document.querySelectorAll('tbody tr').length, reviewItems: document.querySelectorAll('.review-item').length });
}

window.addEventListener('message', (event) => {
  if (event.data?.type === 'data') {
    const data = JSON.stringify([event.data.snapshot.sessions, event.data.snapshot.error, event.data.review]);
    const unchanged = data === state.lastData;
    state.lastData = data;
    state.snapshot = event.data.snapshot;
    state.pricesAsOf = event.data.pricesAsOf;
    state.review = event.data.review;
    // 自動更新のたびに描き直すと、読んでいる最中の選択やツールチップが消える
    if (!unchanged || state.loading) {
      state.loading = false;
      render();
    }
    notifyRendered();
  } else if (event.data?.type === 'show') {
    state.sessionKey = event.data.sessionKey;
    state.highlightTurn = event.data.turn ?? null;
    persist();
    render();
    const row = highlightedTurnRow();
    if (row) {
      row.scrollIntoView({ block: 'center' });
    } else {
      window.scrollTo(0, 0);
    }
    notifyRendered();
  }
});

render();
vscode.postMessage({ type: 'ready' });
