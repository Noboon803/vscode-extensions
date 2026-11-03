import DOMPurify from 'dompurify';

const vscode = acquireVsCodeApi();

const content = document.getElementById('content');
const pathLabel = document.getElementById('path');
const commentsButton = document.getElementById('show-comments');
const addButton = document.getElementById('add-comment');

const NEW_COMMENT_QUOTE_LENGTH = 200;
const HOVER_DELAY_MS = 120;
/** 子のブロックを囲むだけの要素。カーソルが直接当たるのは字下げや余白の上なので、コメントの対象にしない */
const GAP_TAGS = new Set(['UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY']);

let comments = [];
/** 開いている入力欄。再描画しても入力中の内容を失わないよう、要素ごと保持する */
let form = null;
/** 追加ボタンを押したときにコメントを付ける対象 */
let addTarget = null;
let isFirstRender = true;
let hoverTimer = 0;
const userStyles = new CSSStyleSheet();
document.adoptedStyleSheets = [userStyles];

/** 設定のスタイルを適用する。CSSOM を通すので CSP に触れず、無効な値も検出できる */
function applyStyles(rules) {
  userStyles.replaceSync('');
  const rejected = [];
  for (const { selector, declarations } of rules) {
    const index = userStyles.insertRule(`${selector} {}`, userStyles.cssRules.length);
    const { style } = userStyles.cssRules[index];
    for (const { property, value, label } of declarations) {
      style.setProperty(property, value);
      if (!style.getPropertyValue(property)) {
        rejected.push(`${label} = ${value}`);
      }
    }
  }
  vscode.postMessage({ type: 'stylesApplied', rejected });
}

function saveState(patch) {
  vscode.setState({ ...vscode.getState(), ...patch });
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** 相対パスの画像を Webview から読める URL に置き換える */
function resolveImages(baseHref) {
  for (const image of content.querySelectorAll('img[src]')) {
    const src = image.getAttribute('src');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) {
      image.src = new URL(src, baseHref).href;
    }
  }
}

function renderDocument({ html, error, baseHref }) {
  const hasFocus = form?.contains(document.activeElement);
  form?.remove();
  if (error) {
    content.replaceChildren(Object.assign(document.createElement('p'), { className: 'error', textContent: error }));
  } else {
    content.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'] });
    resolveImages(baseHref);
  }
  renderComments();
  if (hasFocus) {
    form.querySelector('textarea').focus();
  }
}

function blockForLine(line) {
  let found = null;
  for (const element of content.querySelectorAll('[data-line]')) {
    if (Number(element.dataset.line) <= line) {
      found = element;
    }
  }
  return found;
}

/** ブロックの直後にコメントを並べる入れ物を用意する。表やリストの構造を壊さない位置を選ぶ */
function groupFor(block, groups) {
  const existing = groups.get(block);
  if (existing) {
    return existing;
  }
  const group = document.createElement('div');
  group.className = 'comment-group';
  if (!block) {
    content.append(group);
  } else if (block.closest('table')) {
    block.closest('table').after(group);
  } else if (block.tagName === 'CODE') {
    block.closest('pre').after(group);
  } else if (block.tagName === 'LI') {
    block.append(group);
  } else {
    block.after(group);
  }
  groups.set(block, group);
  return group;
}

function renderCard(comment) {
  const card = document.createElement('div');
  card.className = 'comment-card';
  card.dataset.commentId = comment.id;

  if (comment.quote) {
    const quote = document.createElement('div');
    quote.className = 'comment-quote';
    quote.textContent = collapse(comment.quote);
    card.append(quote);
  }
  const text = document.createElement('div');
  text.className = 'comment-text';
  text.textContent = comment.text;
  card.append(text);

  if (comment.stale) {
    const stale = document.createElement('div');
    stale.className = 'comment-stale';
    stale.textContent = '対象の行が変更されたため、位置がずれている可能性があります';
    card.append(stale);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'comment-remove';
  remove.textContent = '×';
  remove.title = 'コメントを削除';
  remove.setAttribute('aria-label', 'コメントを削除');
  remove.addEventListener('click', () => vscode.postMessage({ type: 'removeComment', id: comment.id }));
  card.append(remove);
  return card;
}

function renderComments() {
  const hasFocus = form?.contains(document.activeElement);
  form?.remove();
  content.querySelectorAll('.comment-group').forEach((group) => group.remove());

  const groups = new Map();
  for (const comment of comments) {
    groupFor(blockForLine(comment.line), groups).append(renderCard(comment));
  }
  if (form) {
    groupFor(blockForLine(Number(form.dataset.line)), groups).append(form);
    if (hasFocus) {
      form.querySelector('textarea').focus();
    }
  }
  commentsButton.textContent = comments.length > 0 ? `コメント (${comments.length})` : 'コメント';
}

function closeForm() {
  form?.remove();
  form = null;
}

function openForm({ line, endLine, quote }) {
  closeForm();
  form = document.createElement('div');
  form.className = 'comment-form';
  form.dataset.line = String(line);

  if (quote) {
    const quoteElement = document.createElement('div');
    quoteElement.className = 'comment-quote';
    quoteElement.textContent = quote;
    form.append(quoteElement);
  }
  const textarea = document.createElement('textarea');
  textarea.rows = 3;
  textarea.placeholder = 'コメントを入力';
  textarea.setAttribute('aria-label', 'コメント');

  const actions = document.createElement('div');
  actions.className = 'comment-actions';
  const save = Object.assign(document.createElement('button'), { type: 'button', textContent: '追加' });
  save.title = 'Cmd/Ctrl + Enter';
  const cancel = Object.assign(document.createElement('button'), {
    type: 'button',
    textContent: 'キャンセル',
    className: 'secondary',
  });
  actions.append(save, cancel);
  form.append(textarea, actions);

  const submit = () => {
    const text = textarea.value.trim();
    if (text) {
      vscode.postMessage({ type: 'addComment', line, endLine, quote, text });
      closeForm();
    }
  };
  save.addEventListener('click', submit);
  cancel.addEventListener('click', closeForm);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      closeForm();
    }
  });

  renderComments();
  textarea.focus();
}

function isCommentUi(element) {
  return Boolean(element.closest('.comment-group'));
}

function hideAddButton() {
  addButton.hidden = true;
  addButton.className = '';
  addTarget = null;
}

function blockTarget(block, quote) {
  return {
    line: Number(block.dataset.line),
    endLine: Number(block.dataset.lineEnd),
    quote: quote ?? collapse(block.textContent).slice(0, NEW_COMMENT_QUOTE_LENGTH),
  };
}

function showAddButton(target, mode, top, left) {
  addTarget = target;
  addButton.hidden = false;
  addButton.className = mode;
  addButton.textContent = mode === 'selection' ? 'コメント' : '+';
  addButton.title = 'コメントを追加';
  addButton.setAttribute('aria-label', 'コメントを追加');
  addButton.style.top = `${top + window.scrollY}px`;
  addButton.style.left = `${left + window.scrollX}px`;
}

function selectedBlock(selection) {
  if (selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (!content.contains(start) || isCommentUi(start)) {
    return null;
  }
  return start.closest('[data-line]');
}

function updateSelectionButton() {
  const selection = document.getSelection();
  const block = selectedBlock(selection);
  const quote = block ? collapse(selection.toString()) : '';
  if (!quote) {
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  showAddButton(blockTarget(block, quote.slice(0, NEW_COMMENT_QUOTE_LENGTH)), 'selection', rect.bottom + 4, rect.left);
}

document.addEventListener('mouseup', (event) => {
  if (event.target !== addButton) {
    // 選択範囲は mouseup の直後に確定する
    setTimeout(updateSelectionButton);
  }
});

document.addEventListener('keyup', (event) => {
  if (event.shiftKey) {
    updateSelectionButton();
  }
});

document.addEventListener('selectionchange', () => {
  if (document.getSelection().isCollapsed && addButton.className === 'selection') {
    hideAddButton();
  }
});

// ブロックにカーソルを合わせると左に + を出す。
// + へ向かう途中で余白や別のブロックを通っても消えたり動いたりしないよう、止まってから切り替える
document.addEventListener('mouseover', (event) => {
  clearTimeout(hoverTimer);
  const element = event.target instanceof Element ? event.target : null;
  if (event.target === addButton || element === content || GAP_TAGS.has(element?.tagName)) {
    return;
  }
  const isDragging = event.buttons !== 0;
  const block = element && content.contains(element) && !isCommentUi(element) ? element.closest('[data-line]') : null;
  hoverTimer = setTimeout(() => {
    if (addButton.className === 'selection') {
      return;
    }
    if (!block || isDragging) {
      hideAddButton();
      return;
    }
    const rect = (block.tagName === 'CODE' ? block.closest('pre') : block).getBoundingClientRect();
    showAddButton(blockTarget(block), 'block', rect.top, content.getBoundingClientRect().left + 4);
  }, HOVER_DELAY_MS);
});

// 押しても選択範囲が解除されないようにする
addButton.addEventListener('mousedown', (event) => event.preventDefault());
addButton.addEventListener('click', () => {
  if (addTarget) {
    openForm(addTarget);
    document.getSelection().removeAllRanges();
    hideAddButton();
  }
});

content.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link) {
    return;
  }
  event.preventDefault();
  const href = link.getAttribute('href');
  if (href.startsWith('#')) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
  } else {
    vscode.postMessage({ type: 'openLink', href });
  }
});

document.getElementById('open-source').addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));
commentsButton.addEventListener('click', () => vscode.postMessage({ type: 'showComments' }));

let scrollFrame = 0;
window.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => saveState({ scrollTop: window.scrollY }));
});

function showComment(id) {
  // 隠れていたタブが前面に出て、レイアウトが済んでから移動する
  requestAnimationFrame(() => {
    const card = content.querySelector(`[data-comment-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: 'center' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }
  });
}

function showLine(line) {
  requestAnimationFrame(() => blockForLine(line)?.scrollIntoView({ block: 'center' }));
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'render') {
    pathLabel.textContent = data.path;
    pathLabel.title = data.path;
    // ウィンドウの再読み込み後にパネルを復元するため、URI を残す
    saveState({ uri: data.uri });
    renderDocument(data);
    if (isFirstRender) {
      isFirstRender = false;
      window.scrollTo(0, vscode.getState()?.scrollTop ?? 0);
    }
  } else if (data.type === 'comments') {
    comments = data.comments;
    renderComments();
  } else if (data.type === 'showComment') {
    showComment(data.id);
  } else if (data.type === 'styles') {
    applyStyles(data.rules);
  } else if (data.type === 'showLine') {
    showLine(data.line);
  }
});

vscode.postMessage({ type: 'ready' });
