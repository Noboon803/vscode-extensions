import * as assert from 'node:assert';
import { renderMarkdown } from '../../markdownRenderer';

suite('renderMarkdown', () => {
  test('ブロックに元の行番号を付ける', () => {
    const html = renderMarkdown('# 見出し\n\n本文\n続き\n');
    assert.match(html, /<h1 data-line="0" data-line-end="1"/);
    assert.match(html, /<p data-line="2" data-line-end="4">/);
  });

  test('リストと表とコードブロックにも行番号を付ける', () => {
    assert.match(renderMarkdown('- a\n- b\n'), /<li data-line="1" data-line-end="2">b/);
    assert.match(renderMarkdown('| a |\n| --- |\n| b |\n'), /<tr data-line="2"/);
    assert.match(renderMarkdown('```js\nconst a = 1;\n```\n'), /<code data-line="0" data-line-end="3" class="language-js">/);
  });

  test('Front Matter は表示せず、行番号もずらさない', () => {
    const html = renderMarkdown('---\ntitle: a\n---\n\n本文\n');
    assert.doesNotMatch(html, /title/);
    assert.doesNotMatch(html, /<hr/);
    assert.match(html, /<p data-line="4"/);
  });

  test('本文の途中の水平線は Front Matter として扱わない', () => {
    assert.match(renderMarkdown('本文\n\n---\n\n続き\n'), /<hr/);
  });

  test('見出しに ID を付け、重複には番号を付ける', () => {
    const html = renderMarkdown('# はじめに `code`\n\n# はじめに code\n');
    assert.match(html, /id="はじめに-code"/);
    assert.match(html, /id="はじめに-code-1"/);
  });

  test('タスクリストをチェックボックスにする', () => {
    const html = renderMarkdown('- [ ] 未完了\n- [x] 完了\n- 普通\n');
    assert.match(html, /task-list-item[^>]*><input type="checkbox" disabled> 未完了/);
    assert.match(html, /task-list-item[^>]*><input type="checkbox" disabled checked> 完了/);
    assert.match(html, /<li data-line="2" data-line-end="3">普通/);
  });

  test('コードブロックを構文ハイライトし、未知の言語はエスケープして表示する', () => {
    assert.match(renderMarkdown('```js\nconst a = 1;\n```\n'), /hljs-keyword/);
    assert.match(renderMarkdown('```unknown\n<b>\n```\n'), /&lt;b&gt;/);
  });
});
