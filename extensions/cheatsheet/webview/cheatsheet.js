import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import {
  applyTechniques,
  composeCommand,
  isShellLanguage,
  restoreFields,
  snapshotFields,
  supportsTechniques,
  visibleRows,
  withAddedRow,
  withoutRow,
} from '../src/command';

Object.entries({ bash, css, dockerfile, dos, go, javascript, json, powershell, python, rust, sql, typescript, xml, yaml }).forEach(
  ([name, language]) => hljs.registerLanguage(name, language),
);
hljs.registerAliases(['shell', 'console', 'fish'], { languageName: 'bash' });

const FAVORITES_ID = '__favorites__';
const HISTORY_ID = '__history__';
const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_MARGIN_PX = 4;

const vscode = acquireVsCodeApi();
const categorySelect = document.getElementById('category');
const cheatSelect = document.getElementById('cheat');
const container = document.getElementById('cheat-detail');
let categories = [];
let techniqueGroups = [];
let favorites = [];
let history = [];
/** ドロップダウンの選択肢。並びは option の value（添字）と対応する */
let entries = [];
/** チートごとのオプションの入力値。カードを描き直しても、ビューを隠しても保つ */
let fieldValues = vscode.getState()?.fieldValues ?? {};
/** チートごとの組み合わせの選択。他のチートへは引き継がない */
let techniqueValues = vscode.getState()?.techniqueValues ?? {};
let techniquesOpen = vscode.getState()?.techniquesOpen ?? false;
/** 表示中のドロップダウンの項目。お気に入りや履歴の設定は、項目が変わったときだけ読み込む */
let selectedEntryId = vscode.getState()?.cheatKey;

/** 文字列はすべて textContent で挿入し、内容を HTML として解釈させない */
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text) {
    el.textContent = text;
  }
  return el;
}

const tooltip = element('div', 'tooltip');
tooltip.hidden = true;
// 同じ文字列をラベルが持っているので、読み上げでは重複させない
tooltip.setAttribute('aria-hidden', 'true');
document.body.append(tooltip);
let tooltipTimer;

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltip.hidden = true;
}

/** 対象の下に出す。下に収まらなければ上に出し、横は画面内に収める */
function showTooltip(target, text) {
  tooltip.textContent = text;
  tooltip.hidden = false;
  // 前回の位置が残っていると、折り返しが変わって大きさを正しく測れない
  tooltip.style.left = '0';
  tooltip.style.top = '0';
  const anchor = target.getBoundingClientRect();
  const { width, height } = tooltip.getBoundingClientRect();
  const below = anchor.bottom + TOOLTIP_MARGIN_PX;
  const fitsBelow = below + height + TOOLTIP_MARGIN_PX <= window.innerHeight;
  const top = fitsBelow ? below : Math.max(TOOLTIP_MARGIN_PX, anchor.top - height - TOOLTIP_MARGIN_PX);
  const left = Math.max(TOOLTIP_MARGIN_PX, Math.min(anchor.left, window.innerWidth - width - TOOLTIP_MARGIN_PX));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

/** VS Code の Webview では標準の title が表示されないので、自前で表示する。文字列は表示のたびに取得する */
function addTooltip(target, getText) {
  target.addEventListener('mouseenter', () => {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => showTooltip(target, getText()), TOOLTIP_DELAY_MS);
  });
  target.addEventListener('mouseleave', hideTooltip);
}

window.addEventListener('scroll', hideTooltip, true);
window.addEventListener('pointerdown', hideTooltip);
window.addEventListener('resize', hideTooltip);

function option(value, text) {
  const el = element('option', '', text);
  el.value = value;
  return el;
}

function cheatKey(category, cheat) {
  return `${category.id}/${cheat.id}`;
}

function usesTechniques(cheat) {
  return !cheat.isSnapshot && supportsTechniques(cheat.language, cheat.code);
}

/** 入力値と組み合わせを反映したコマンド。コードのないチートは undefined */
function commandFor(cheat, fields, techniques) {
  if (!cheat.code) {
    return undefined;
  }
  const command = cheat.options ? composeCommand(cheat.code, cheat.options, fields) : cheat.code;
  return usesTechniques(cheat) ? applyTechniques(command, techniques, techniqueGroups) : command;
}

function savedCommandFor(cheat, settings) {
  return commandFor(cheat, restoreFields(cheat.options ?? [], settings.fields), settings.techniques);
}

function findCheat(key) {
  for (const category of categories) {
    const cheat = category.cheats.find((c) => cheatKey(category, c) === key);
    if (cheat) {
      return cheat;
    }
  }
  return undefined;
}

/** 同じチートのお気に入りを見分けられるよう、既定と異なるときはコマンドも添える */
function favoriteEntry(category, cheat, favorite) {
  const command = savedCommandFor(cheat, favorite);
  const name = `${category.name} / ${cheat.title}`;
  return {
    id: `favorite:${favorite.id}`,
    key: favorite.key,
    label: command === commandFor(cheat, [], {}) ? name : `${name}: ${command}`,
    cheat,
    settings: favorite,
  };
}

function formatSentAt(sentAt) {
  const date = new Date(sentAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** チートが YAML から消えていても、送信したコマンドをそのまま表示して送り直せるようにする */
function historyEntry(item) {
  return {
    id: `history:${item.id}`,
    key: item.key,
    label: `${formatSentAt(item.sentAt)} ${item.text.replace(/\s*\n\s*/g, ' ⏎ ')}`,
    cheat: findCheat(item.key) ?? { title: item.title, code: item.text, language: item.language, isSnapshot: true },
    settings: item,
    historyId: item.id,
  };
}

function entriesFor(categoryId) {
  if (categoryId === FAVORITES_ID) {
    return categories.flatMap((category) =>
      category.cheats.flatMap((cheat) =>
        favorites
          .filter((favorite) => favorite.key === cheatKey(category, cheat))
          .map((favorite) => favoriteEntry(category, cheat, favorite)),
      ),
    );
  }
  if (categoryId === HISTORY_ID) {
    return history.map(historyEntry);
  }
  const category = categories.find((c) => c.id === categoryId);
  return (category?.cheats ?? []).map((cheat) => ({
    id: cheatKey(category, cheat),
    key: cheatKey(category, cheat),
    label: cheat.title,
    cheat,
  }));
}

function saveState() {
  const entry = entries[Number(cheatSelect.value)];
  vscode.setState({ categoryId: categorySelect.value, cheatKey: entry?.id, fieldValues, techniqueValues, techniquesOpen });
}

function currentCommand({ cheat, key }) {
  return commandFor(cheat, fieldValues[key] ?? [], techniqueValues[key] ?? {});
}

function currentSettings({ cheat, key }) {
  return {
    fields: snapshotFields(cheat.options ?? [], fieldValues[key] ?? []),
    techniques: { ...techniqueValues[key] },
  };
}

/** 今の設定と同じコマンドになるお気に入りがあれば ★ にする。入力に合わせて sync で更新する */
function favoriteButton(entry) {
  const matching = () => {
    const command = currentCommand(entry);
    return favorites.find((favorite) => favorite.key === entry.key && savedCommandFor(entry.cheat, favorite) === command);
  };
  const tooltipText = () => (matching() ? 'この設定をお気に入りから外す' : 'この設定をお気に入りに追加');
  const button = element('button', 'favorite icon-button');
  button.type = 'button';
  addTooltip(button, tooltipText);
  const sync = () => {
    const isFavorite = Boolean(matching());
    button.textContent = isFavorite ? '★' : '☆';
    button.setAttribute('aria-label', tooltipText());
    button.setAttribute('aria-pressed', String(isFavorite));
  };
  sync();
  button.addEventListener('click', () => {
    const favorite = matching();
    vscode.postMessage(
      favorite
        ? { type: 'removeFavorite', id: favorite.id }
        : { type: 'addFavorite', key: entry.key, ...currentSettings(entry) },
    );
  });
  return { button, sync };
}

function removeHistoryButton(id) {
  const label = '履歴から削除';
  const button = element('button', 'remove-history icon-button', '×');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  addTooltip(button, () => label);
  button.addEventListener('click', () => {
    vscode.postMessage({ type: 'removeHistory', id });
  });
  return button;
}

function renderHighlighted(codeElement, text, language) {
  const name = (language ?? 'bash').toLowerCase();
  if (hljs.getLanguage(name)) {
    // highlight.js が入力をエスケープするので、この HTML は安全に挿入できる
    codeElement.innerHTML = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
  } else {
    codeElement.textContent = text;
  }
}

/** 長い名前は CSS で省略するので、全文はツールチップで読めるようにする。必須の * は省略の範囲に入れない */
function optionLabel(id, { flag, text, required }) {
  const label = element('label', 'option-label');
  label.htmlFor = id;
  const tooltipText = [flag, text].filter(Boolean).join(' ') + (required ? '（必須）' : '');
  addTooltip(label, () => tooltipText);
  const name = element('span', 'option-name');
  if (flag) {
    name.append(element('code', 'option-flag', flag));
  }
  if (text) {
    name.append(element('span', 'option-text', text));
  }
  label.append(name);
  if (required) {
    label.append(element('span', 'option-required', '*'));
  }
  return label;
}

/** label を省略すると flag と同じ値になるので、同じ文字を 2 回並べない */
function optionText(definition) {
  return definition.label !== definition.flag ? definition.label : undefined;
}

const OPTION_PICKER_ID = 'option-picker';

/** YAML で multiple を付けたオプションを増やす選択肢。行の位置が変わらないよう、選ぶと先頭の「選択...」に戻る */
function renderOptionPicker(fields, cheat, onPick) {
  const addable = cheat.options.flatMap((definition, index) => (definition.multiple ? [{ definition, index }] : []));
  if (addable.length === 0) {
    return;
  }
  const select = element('select', 'option-picker');
  select.id = OPTION_PICKER_ID;
  select.append(
    option('', '選択...'),
    ...addable.map(({ definition, index }) =>
      option(String(index), [definition.flag, optionText(definition)].filter(Boolean).join(' ')),
    ),
  );
  select.addEventListener('change', () => onPick(Number(select.value)));
  fields.append(optionLabel(OPTION_PICKER_ID, { text: 'オプションを追加' }), select);
}

function removeRowButton(definition, onClick) {
  const label = `${[definition.flag, optionText(definition)].filter(Boolean).join(' ')} を外す`;
  const button = element('button', 'remove-option icon-button', '×');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  addTooltip(button, () => label);
  button.addEventListener('click', onClick);
  return button;
}

function fieldLabel(id, definition) {
  return optionLabel(id, { flag: definition.flag, text: optionText(definition), required: definition.required });
}

function renderFlagField(fields, definition, index, values, { onChange }) {
  const id = `option-${index}-0`;
  const input = element('input', 'option-input');
  input.id = id;
  input.type = 'checkbox';
  if (definition.required) {
    input.setAttribute('aria-required', 'true');
  }
  input.checked = (values[index] ?? definition.default) === true;
  input.addEventListener('change', () => {
    values[index] = input.checked;
    onChange();
  });
  fields.append(fieldLabel(id, definition), input);
}

function renderTextField(fields, definition, index, values, { onChange, onRemove }) {
  visibleRows(definition, values[index]).forEach((value, row, rows) => {
    const id = `option-${index}-${row}`;
    const input = element('input', 'option-input');
    input.id = id;
    input.type = 'text';
    input.spellcheck = false;
    input.value = value;
    input.placeholder = definition.placeholder ?? '';
    if (definition.required) {
      input.setAttribute('aria-required', 'true');
    }
    input.addEventListener('input', () => {
      // お気に入りの設定と配列を共有していることがあるので、書き換えずに作り直す
      const next = [...visibleRows(definition, values[index])];
      next[row] = input.value;
      values[index] = next;
      onChange();
    });
    const control = element('div', 'option-control');
    control.append(input);
    // 最後の 1 行は外せない。空にすれば連結されない
    if (rows.length > 1) {
      control.append(removeRowButton(definition, () => onRemove(index, row)));
    }
    fields.append(fieldLabel(id, definition), control);
  });
}

function renderFields(key, cheat, onChange) {
  const values = (fieldValues[key] ??= []);
  const fields = element('div', 'options');
  const update = (focusId) => {
    hideTooltip();
    build();
    onChange();
    document.getElementById(focusId)?.focus();
  };
  const handlers = {
    onChange,
    onRemove(index, row) {
      values[index] = withoutRow(cheat.options[index], values[index], row);
      update(OPTION_PICKER_ID);
    },
  };
  function build() {
    fields.replaceChildren();
    cheat.options.forEach((definition, index) => {
      const render = definition.type === 'flag' ? renderFlagField : renderTextField;
      render(fields, definition, index, values, handlers);
    });
    renderOptionPicker(fields, cheat, (index) => {
      values[index] = withAddedRow(cheat.options[index], values[index]);
      update(`option-${index}-${values[index].length - 1}`);
    });
  }
  build();
  return fields;
}

/** 組み合わせの 1 行。選択肢が入力値を必要とするときだけ入力欄を出す */
function renderTechniqueGroup(fields, group, values, onChange) {
  const id = `technique-${group.id}`;
  const label = optionLabel(id, { text: group.label });

  const select = element('select', 'technique-select');
  select.id = id;
  select.append(
    ...group.choices.map((choice) =>
      option(choice.id, choice.template ? `${choice.label}（${choice.template.replace('{}', choice.argLabel)}）` : choice.label),
    ),
  );
  // YAML から消された選択肢が保存されていれば、先頭に戻す
  const selected = values[group.id];
  select.value = group.choices.some((c) => c.id === selected) ? selected : group.choices[0].id;

  const argument = element('input', 'option-input technique-argument');
  argument.type = 'text';
  argument.spellcheck = false;
  const syncArgument = () => {
    const choice = group.choices.find((c) => c.id === select.value);
    argument.hidden = !choice?.argLabel;
    argument.placeholder = choice?.argLabel ?? '';
    argument.setAttribute('aria-label', choice?.argLabel ?? '');
    argument.value = String(values[`${group.id}Arg`] ?? choice?.defaultArg ?? '');
  };
  syncArgument();

  select.addEventListener('change', () => {
    values[group.id] = select.value;
    // ファイル名と行数のように意味が変わるので、前の入力値は引き継がない
    delete values[`${group.id}Arg`];
    syncArgument();
    onChange();
  });
  argument.addEventListener('input', () => {
    values[`${group.id}Arg`] = argument.value;
    onChange();
  });

  const control = element('div', 'technique-control');
  control.append(select, argument);
  fields.append(label, control);
}

function renderTechniques(values, onChange) {
  const details = element('details', 'techniques');
  details.open = techniquesOpen;
  details.append(element('summary', '', '組み合わせ（出力の省略・パイプなど）'));
  details.addEventListener('toggle', () => {
    techniquesOpen = details.open;
    saveState();
  });

  const fields = element('div', 'options');
  techniqueGroups.forEach((group) => renderTechniqueGroup(fields, group, values, onChange));

  const label = optionLabel('technique-background', { text: 'バックグラウンド（&）' });
  const background = element('input', 'option-input');
  background.id = 'technique-background';
  background.type = 'checkbox';
  background.checked = values.background === true;
  background.addEventListener('change', () => {
    values.background = background.checked;
    onChange();
  });
  fields.append(label, background);

  details.append(fields);
  return details;
}

function renderCode(card, entry, onChange) {
  const { cheat, key } = entry;
  const currentCode = () => currentCommand(entry);
  const pre = element('pre', 'cheat-code');
  const code = element('code');
  pre.append(code);
  const refresh = () => {
    renderHighlighted(code, currentCode(), cheat.language);
    onChange();
    saveState();
  };

  const row = element('div', 'command-row');
  row.append(pre);
  if (isShellLanguage(cheat.language)) {
    const send = element('button', 'send', '送信');
    send.type = 'button';
    const sendHint = 'アクティブなターミナルに入力します（実行はしません）';
    send.setAttribute('aria-description', sendHint);
    addTooltip(send, () => sendHint);
    send.addEventListener('click', () => {
      vscode.postMessage({
        type: 'sendToTerminal',
        text: currentCode(),
        key,
        title: cheat.title,
        language: cheat.language,
        ...currentSettings(entry),
      });
    });
    row.append(send);
  }
  card.append(row);
  renderHighlighted(code, currentCode(), cheat.language);

  if (cheat.options) {
    card.append(renderFields(key, cheat, refresh));
  }
  if (usesTechniques(cheat)) {
    card.append(
      renderTechniques((techniqueValues[key] ??= {}), refresh),
    );
  }
}

function renderEntry(entry) {
  // 対象のラベルが消えると mouseleave が届かないので、ここで閉じる
  hideTooltip();
  container.replaceChildren();
  if (!entry) {
    if (categorySelect.value === FAVORITES_ID) {
      container.append(
        element('p', 'empty', 'お気に入りはまだありません。チートの ☆ を押すと、今の設定ごと追加できます。'),
      );
    } else if (categorySelect.value === HISTORY_ID) {
      container.append(element('p', 'empty', '送信履歴はまだありません。送信すると、そのときの設定ごと残ります。'));
    }
    return;
  }
  const { cheat } = entry;
  const card = element('article', 'cheat');
  const header = element('div', 'cheat-header');
  const actions = element('div', 'cheat-actions');
  // YAML から消えたチートは、お気に入りにしても一覧に出せない
  const favorite = cheat.isSnapshot ? undefined : favoriteButton(entry);
  if (favorite) {
    actions.append(favorite.button);
  }
  if (entry.historyId) {
    actions.append(removeHistoryButton(entry.historyId));
  }
  header.append(element('h2', 'cheat-title', cheat.title), actions);
  card.append(header);
  if (cheat.description) {
    card.append(element('p', 'cheat-description', cheat.description));
  }
  if (cheat.code) {
    renderCode(card, entry, () => favorite?.sync());
  }
  if (cheat.notes) {
    card.append(element('p', 'cheat-notes', cheat.notes));
  }
  container.append(card);
}

function selectEntry(index) {
  cheatSelect.value = String(index);
  const entry = entries[index];
  // 再描画のたびに読み込むと、お気に入りや履歴を開いたまま編集した内容が消える
  if (entry?.settings && entry.id !== selectedEntryId) {
    fieldValues[entry.key] = restoreFields(entry.cheat.options ?? [], entry.settings.fields);
    techniqueValues[entry.key] = { ...entry.settings.techniques };
  }
  selectedEntryId = entry?.id;
  saveState();
  renderEntry(entry);
}

/** 希望のチートがなければ、同じ位置（末尾を超えるなら最後）のチートを選ぶ */
function showCategory(categoryId, preferredId, fallbackIndex = 0) {
  categorySelect.value = categoryId;
  entries = entriesFor(categoryId);
  cheatSelect.replaceChildren(...entries.map((entry, index) => option(String(index), entry.label)));
  cheatSelect.disabled = entries.length === 0;
  const found = entries.findIndex((entry) => entry.id === preferredId);
  selectEntry(found >= 0 ? found : Math.min(fallbackIndex, Math.max(entries.length - 1, 0)));
}

categorySelect.addEventListener('change', () => showCategory(categorySelect.value));
cheatSelect.addEventListener('change', () => selectEntry(Number(cheatSelect.value)));

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'categories') {
    categories = message.categories;
    techniqueGroups = message.techniqueGroups;
    favorites = message.favorites;
    history = message.history;
    categorySelect.replaceChildren(
      option(FAVORITES_ID, '★ お気に入り'),
      option(HISTORY_ID, '↺ 履歴'),
      ...categories.map((c) => option(c.id, c.name)),
    );
    // ビューを隠すと Webview は破棄されるので、選択中の内容を復元する
    const saved = vscode.getState();
    const known = [FAVORITES_ID, HISTORY_ID].includes(saved?.categoryId) || categories.some((c) => c.id === saved?.categoryId);
    showCategory(known ? saved.categoryId : categories[0]?.id ?? FAVORITES_ID, saved?.cheatKey);
  } else if (message.type === 'favorites') {
    favorites = message.favorites;
    const index = Number(cheatSelect.value);
    // お気に入りの一覧で設定を変えて追加したら、追加したものを選ぶ
    const added = categorySelect.value === FAVORITES_ID && message.addedId;
    showCategory(categorySelect.value, added ? `favorite:${added}` : entries[index]?.id, index);
  } else if (message.type === 'history') {
    history = message.history;
    // 他のカテゴリでは一覧に影響しないので、入力中の欄を作り直さない
    if (categorySelect.value === HISTORY_ID) {
      const index = Number(cheatSelect.value);
      showCategory(HISTORY_ID, message.sentId ? `history:${message.sentId}` : entries[index]?.id, index);
    }
  }
});

vscode.postMessage({ type: 'ready' });
