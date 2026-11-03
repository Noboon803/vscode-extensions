import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';

type CoreRule = (state: MarkdownIt.StateCore) => void;

/** ブロックに元の行番号を付ける。コメントの位置をソースの行と結び付けるために使う */
const addSourceLines: CoreRule = (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting >= 0 && token.block && !token.hidden) {
      token.attrSet('data-line', String(token.map[0]));
      token.attrSet('data-line-end', String(token.map[1]));
    }
  }
};

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** 見出しに ID を付けて、`#見出し` のリンクで移動できるようにする */
const addHeadingIds: CoreRule = (state) => {
  const used = new Map<string, number>();
  state.tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') {
      return;
    }
    const text = (state.tokens[index + 1].children ?? [])
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join('');
    const slug = slugify(text);
    const count = used.get(slug) ?? 0;
    used.set(slug, count + 1);
    token.attrSet('id', count === 0 ? slug : `${slug}-${count}`);
  });
};

/** `- [ ] 項目` をチェックボックスにする */
const addTaskLists: CoreRule = (state) => {
  state.tokens.forEach((token, index) => {
    const first = token.children?.[0];
    if (token.type !== 'inline' || first?.type !== 'text' || state.tokens[index - 2]?.type !== 'list_item_open') {
      return;
    }
    const match = /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) {
      return;
    }
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}> `;
    token.children?.unshift(checkbox);
    state.tokens[index - 2].attrJoin('class', 'task-list-item');
  });
};

const markdown = new MarkdownIt({
  // サニタイズは Webview 側の DOMPurify が行う
  html: true,
  linkify: true,
  highlight: (code, language) => {
    if (!language || !hljs.getLanguage(language)) {
      return '';
    }
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  },
});
markdown.core.ruler.push('source_lines', addSourceLines);
markdown.core.ruler.push('heading_ids', addHeadingIds);
markdown.core.ruler.push('task_lists', addTaskLists);

/** Front Matter を行数を保ったまま空行にする（表示はしないが行番号はずらさない） */
function blankFrontMatter(source: string): string {
  return source.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/, (block) => block.replace(/[^\r\n]/g, ''));
}

export function renderMarkdown(source: string): string {
  return markdown.render(blankFrontMatter(source));
}
