const vscode = acquireVsCodeApi();

const table = document.getElementById('table');
const rows = document.getElementById('rows');
const empty = document.getElementById('empty');
const toolbar = document.getElementById('toolbar');

const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

function cell(className, text) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text;
  return td;
}

function renderRow(comment) {
  const row = document.createElement('tr');

  const location = document.createElement('td');
  location.className = 'location';
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'link';
  link.textContent = `${comment.path}:${comment.line}`;
  link.title = 'プレビューで表示';
  link.addEventListener('click', () => vscode.postMessage({ type: 'reveal', id: comment.id }));
  location.append(link);
  if (comment.stale) {
    const stale = document.createElement('span');
    stale.className = 'stale';
    stale.textContent = '変更あり';
    stale.title = '対象の行が変更されたため、位置がずれている可能性があります';
    location.append(stale);
  }

  const actions = document.createElement('td');
  actions.className = 'actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.title = '削除';
  remove.setAttribute('aria-label', `${comment.path}:${comment.line} のコメントを削除`);
  remove.addEventListener('click', () => vscode.postMessage({ type: 'remove', id: comment.id }));
  actions.append(remove);

  row.append(
    location,
    cell('quote', comment.quote),
    cell('text', comment.text),
    cell('date', dateFormat.format(comment.createdAt)),
    actions,
  );
  return row;
}

function render(comments) {
  rows.replaceChildren(...comments.map(renderRow));
  table.hidden = comments.length === 0;
  toolbar.hidden = comments.length === 0;
  empty.hidden = comments.length > 0;
}

document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

window.addEventListener('message', ({ data }) => {
  if (data.type === 'comments') {
    render(data.comments);
  }
});

vscode.postMessage({ type: 'ready' });
