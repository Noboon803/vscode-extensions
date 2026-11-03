import { randomUUID } from 'node:crypto';

export interface PreviewComment {
  id: string;
  /** 対象ファイルの URI */
  uri: string;
  /** 対象ブロックの先頭行（0 始まり） */
  line: number;
  /** 対象ブロックの終わりの次の行 */
  endLine: number;
  /** プレビュー上で選択した文字列。選択がなければブロックの冒頭 */
  quote: string;
  text: string;
  createdAt: number;
  /** コメント時点のソース。行がずれたときに位置を探し直すために使う */
  anchor: string;
  /** 対象の行が書き換えられて、位置を特定できなくなった */
  stale: boolean;
}

export type NewComment = Pick<PreviewComment, 'uri' | 'line' | 'endLine' | 'quote' | 'text'>;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** ソースが変わった後のコメントの位置を求める。同じ内容が複数あれば元の位置に最も近いものを選ぶ */
export function relocate(comment: PreviewComment, lines: string[]): Pick<PreviewComment, 'line' | 'endLine' | 'stale'> {
  const { line, endLine, anchor } = comment;
  if (!anchor) {
    return { line, endLine, stale: false };
  }
  const anchorLines = splitLines(anchor);
  let nearest: number | undefined;
  for (let i = 0; i + anchorLines.length <= lines.length; i++) {
    const isMatch = anchorLines.every((anchorLine, offset) => lines[i + offset] === anchorLine);
    if (isMatch && (nearest === undefined || Math.abs(i - line) < Math.abs(nearest - line))) {
      nearest = i;
    }
  }
  return nearest === undefined
    ? { line, endLine, stale: true }
    : { line: nearest, endLine: nearest + anchorLines.length, stale: false };
}

const QUOTE_MAX_LENGTH = 60;

function shortenQuote(quote: string): string {
  const collapsed = quote.replace(/\s+/g, ' ').trim();
  return collapsed.length > QUOTE_MAX_LENGTH ? `${collapsed.slice(0, QUOTE_MAX_LENGTH)}…` : collapsed;
}

/** Markdown のリンク先で問題になる文字だけをエスケープする。日本語はそのまま読めるように残す */
export function encodeLinkPath(path: string): string {
  return path.replace(/[\s()<>%#?\\[\]]/g, (char) => {
    const encoded = encodeURIComponent(char);
    return encoded === char ? `%${char.charCodeAt(0).toString(16).toUpperCase()}` : encoded;
  });
}

function escapeLinkLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

/**
 * クリップボードへ渡す箇条書きを作る。ファイルと行は Markdown のリンクにする。
 * コメントが複数行なら続きを字下げする
 */
export function formatBullets(
  comments: PreviewComment[],
  pathOf: (uri: string) => string,
  linkOf: (uri: string) => string,
): string {
  return comments
    .map((comment) => {
      const quote = shortenQuote(comment.quote);
      const line = comment.line + 1;
      const link = `[${escapeLinkLabel(`${pathOf(comment.uri)}:${line}`)}](${linkOf(comment.uri)}#L${line})`;
      const target = `${link}${quote ? ` 「${quote}」` : ''}`;
      const text = splitLines(comment.text.trim()).join('\n  ');
      return `- ${target}: ${text}`;
    })
    .join('\n');
}

export interface CommentMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** コメントをワークスペースごとに保存する */
export class CommentStore {
  static readonly storageKey = 'markdownViewer.comments';

  private comments: PreviewComment[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly memento: CommentMemento) {
    this.comments = memento.get<PreviewComment[]>(CommentStore.storageKey, []);
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** ファイルと行の順に返す */
  list(): PreviewComment[] {
    return [...this.comments].sort(
      (a, b) => a.uri.localeCompare(b.uri) || a.line - b.line || a.createdAt - b.createdAt,
    );
  }

  listFor(uri: string): PreviewComment[] {
    return this.list().filter((comment) => comment.uri === uri);
  }

  get(id: string): PreviewComment | undefined {
    return this.comments.find((comment) => comment.id === id);
  }

  async add(comment: NewComment, source: string): Promise<PreviewComment> {
    const added: PreviewComment = {
      ...comment,
      id: randomUUID(),
      createdAt: Date.now(),
      anchor: splitLines(source).slice(comment.line, comment.endLine).join('\n'),
      stale: false,
    };
    await this.replace([...this.comments, added]);
    return added;
  }

  async remove(id: string): Promise<void> {
    await this.replace(this.comments.filter((comment) => comment.id !== id));
  }

  async clear(): Promise<void> {
    await this.replace([]);
  }

  /** ソースの変更に合わせてコメントの位置を更新する */
  async relocateAll(uri: string, source: string): Promise<void> {
    const lines = splitLines(source);
    let changed = false;
    const next = this.comments.map((comment) => {
      if (comment.uri !== uri) {
        return comment;
      }
      const position = relocate(comment, lines);
      if (position.line === comment.line && position.endLine === comment.endLine && position.stale === comment.stale) {
        return comment;
      }
      changed = true;
      return { ...comment, ...position };
    });
    if (changed) {
      await this.replace(next);
    }
  }

  private async replace(comments: PreviewComment[]): Promise<void> {
    this.comments = comments;
    this.listeners.forEach((listener) => listener());
    await this.memento.update(CommentStore.storageKey, comments);
  }
}
