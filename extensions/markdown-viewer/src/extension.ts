import * as vscode from 'vscode';
import { CommentStore } from './comments';
import { clearComments, copyComments, CommentsViewProvider } from './commentsView';
import { PreviewManager } from './previewManager';

function isMarkdown(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  return document?.languageId === 'markdown';
}

/** プレビューが前面にあるとアクティブなエディターがないので、そのときはファイルを選んでもらう */
async function pickMarkdownFile(): Promise<vscode.Uri | undefined> {
  const files = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/node_modules/**', 1000);
  if (files.length === 0) {
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Markdown: ['md', 'markdown'] },
    });
    return selected?.[0];
  }
  const items = files
    .map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'プレビューするファイルを選択' });
  return picked?.uri;
}

async function resolveTargets(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<vscode.Uri[]> {
  if (uris && uris.length > 0) {
    return uris;
  }
  if (uri) {
    return [uri];
  }
  const document = vscode.window.activeTextEditor?.document;
  const target = isMarkdown(document) ? document.uri : await pickMarkdownFile();
  return target ? [target] : [];
}

/** 統合テストから状態を確かめるために公開する */
export interface MarkdownViewerApi {
  comments: CommentStore;
  previews: PreviewManager;
}

export function activate(context: vscode.ExtensionContext): MarkdownViewerApi {
  const comments = new CommentStore(context.workspaceState);
  const previews = new PreviewManager(context.extensionUri, comments);
  const commentsView = new CommentsViewProvider(context.extensionUri, comments, previews);

  context.subscriptions.push(
    previews,
    commentsView,
    vscode.window.registerWebviewViewProvider(CommentsViewProvider.viewId, commentsView),
    vscode.commands.registerCommand('markdownViewer.open', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      (await resolveTargets(uri, uris)).forEach((target) => previews.open(target));
    }),
    vscode.commands.registerCommand('markdownViewer.openToSide', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      (await resolveTargets(uri, uris)).forEach((target) => previews.openNew(target));
    }),
    vscode.commands.registerCommand('markdownViewer.copyComments', () => copyComments(comments)),
    vscode.commands.registerCommand('markdownViewer.clearComments', () => clearComments(comments)),
  );

  return { comments, previews };
}

export function deactivate(): void {}
